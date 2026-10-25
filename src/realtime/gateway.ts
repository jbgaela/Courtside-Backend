import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { env, frontendOrigins } from '../config/env.js';
import { logger } from '../infrastructure/logger.js';
import { prisma } from '../infrastructure/prisma.js';
import { sha256 } from '../security/tokens.js';

interface SessionEvent {
  eventId: string;
  type: string;
  sessionId: string;
  version: number;
  occurredAt: string;
  payload?: Record<string, unknown>;
}

interface SubscriptionPayload {
  sessionId?: string;
  publicId?: string;
}

interface SocketData {
  userId?: string;
  sessionId?: string;
}

const SUBSCRIBE_WINDOW_MS = 10_000;
const MAX_SUBSCRIBES_PER_WINDOW = 20;
const connectionsByIp = new Map<string, number>();

let io: Server | null = null;

function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey) continue;
    try {
      result[rawKey] = decodeURIComponent(rawValue.join('='));
    } catch {
      // Ignore malformed cookie values rather than failing the handshake.
    }
  }
  return result;
}

function socketClientIp(request: {
  socket?: { remoteAddress?: string | null };
  headers: { [key: string]: string | string[] | undefined };
}): string {
  if (env.TRUST_PROXY) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof first === 'string' && first.length > 0) {
      return first.split(',')[0]?.trim() || 'unknown';
    }
  }
  return request.socket?.remoteAddress ?? 'unknown';
}

async function resolveSocketUser(socket: Socket): Promise<string | null> {
  const cookies = parseCookieHeader(socket.handshake.headers.cookie);
  const token = cookies[env.COOKIE_NAME];
  if (!token) return null;
  const session = await prisma.authSession.findUnique({
    where: { tokenHash: sha256(token) },
    select: { userId: true, revokedAt: true, expiresAt: true, lastUsedAt: true, id: true },
  });
  const idleMs = env.SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000;
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt.getTime() <= Date.now() ||
    Date.now() - session.lastUsedAt.getTime() > idleMs
  ) {
    return null;
  }
  socket.data.userId = session.userId;
  socket.data.sessionId = session.id;
  return session.userId;
}

async function authorizeSessionRoom(userId: string, sessionId: string): Promise<boolean> {
  const session = await prisma.playSession.findUnique({
    where: { id: sessionId },
    select: { clubId: true, club: { select: { archivedAt: true } } },
  });
  if (!session || session.club.archivedAt) return false;
  const membership = await prisma.clubMembership.findUnique({
    where: { clubId_userId: { clubId: session.clubId, userId } },
    select: { status: true },
  });
  return membership?.status === 'ACTIVE';
}

async function authorizePublicRoom(
  publicId: string,
): Promise<{ sessionId: string; version: number } | null> {
  const session = await prisma.playSession.findUnique({
    where: { publicId },
    select: {
      id: true,
      published: true,
      status: true,
      version: true,
      club: { select: { archivedAt: true } },
    },
  });
  if (
    !session ||
    !session.published ||
    session.club.archivedAt ||
    session.status === 'DRAFT' ||
    session.status === 'CANCELLED'
  ) {
    return null;
  }
  return { sessionId: session.id, version: session.version };
}

function roomNameForSession(sessionId: string): string {
  return `session:${sessionId}`;
}

function roomNameForPublic(publicId: string): string {
  return `public:${publicId}`;
}

function isValidOpaqueId(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength;
}

export function initRealtime(server: HttpServer): Server {
  io = new Server(server, {
    cors: {
      origin: frontendOrigins,
      credentials: true,
    },
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectTimeout: 20_000,
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      if (!origin || !frontendOrigins.includes(origin)) {
        callback('Origin is not allowed', false);
        return;
      }
      const ip = socketClientIp(request);
      if ((connectionsByIp.get(ip) ?? 0) >= env.SOCKET_MAX_CONNECTIONS_PER_IP) {
        callback('Connection limit exceeded', false);
        return;
      }
      callback(null, true);
    },
  });

  io.use(async (socket, next) => {
    try {
      await resolveSocketUser(socket);
      next();
    } catch (error) {
      logger.warn({ err: error }, 'Socket handshake authentication failed');
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    const data = socket.data as SocketData;
    const ip = socketClientIp({
      headers: socket.handshake.headers,
      socket: { remoteAddress: socket.handshake.address },
    });
    const subscribed = new Set<string>();
    let subscribeWindowStart = Date.now();
    let subscribeCount = 0;
    let checking = false;

    connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1);
    if (data.sessionId) void socket.join(`auth:${data.sessionId}`);

    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void (async () => {
        try {
          if (data.sessionId) {
            const session = await prisma.authSession.findUnique({
              where: { id: data.sessionId },
              select: { revokedAt: true, expiresAt: true, lastUsedAt: true },
            });
            const idleMs = env.SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000;
            if (
              !session ||
              session.revokedAt ||
              session.expiresAt.getTime() <= Date.now() ||
              Date.now() - session.lastUsedAt.getTime() > idleMs
            ) {
              socket.disconnect(true);
              return;
            }
          }
          if (data.userId) {
            for (const room of [...subscribed]) {
              if (!room.startsWith('session:')) continue;
              const sessionId = room.slice('session:'.length);
              if (!(await authorizeSessionRoom(data.userId, sessionId))) {
                await socket.leave(room);
                subscribed.delete(room);
              }
            }
          }
        } catch (error) {
          logger.warn({ err: error, socketId: socket.id }, 'Socket authorization refresh failed');
        } finally {
          checking = false;
        }
      })();
    }, env.SOCKET_SESSION_CHECK_INTERVAL_MS);
    timer.unref();

    logger.debug({ socketId: socket.id, userId: data.userId ?? null }, 'Socket connected');

    socket.on(
      'subscribe',
      async (payload: SubscriptionPayload, ack?: (result: unknown) => void) => {
        try {
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            ack?.({ ok: false, error: 'INVALID_SUBSCRIPTION' });
            return;
          }
          const now = Date.now();
          if (now - subscribeWindowStart >= SUBSCRIBE_WINDOW_MS) {
            subscribeWindowStart = now;
            subscribeCount = 0;
          }
          subscribeCount += 1;
          if (subscribeCount > MAX_SUBSCRIBES_PER_WINDOW) {
            ack?.({ ok: false, error: 'RATE_LIMITED' });
            return;
          }

          if (payload.sessionId !== undefined) {
            if (!isValidOpaqueId(payload.sessionId, 40)) {
              ack?.({ ok: false, error: 'INVALID_SUBSCRIPTION' });
              return;
            }
            if (!data.userId || !(await authorizeSessionRoom(data.userId, payload.sessionId))) {
              ack?.({ ok: false, error: 'FORBIDDEN' });
              return;
            }
            const room = roomNameForSession(payload.sessionId);
            await socket.join(room);
            subscribed.add(room);
            const session = await prisma.playSession.findUnique({
              where: { id: payload.sessionId },
              select: { version: true },
            });
            ack?.({ ok: true, version: session?.version ?? 0, sessionId: payload.sessionId });
            return;
          }

          if (payload.publicId !== undefined) {
            if (!isValidOpaqueId(payload.publicId, 80)) {
              ack?.({ ok: false, error: 'INVALID_SUBSCRIPTION' });
              return;
            }
            const publicRoom = await authorizePublicRoom(payload.publicId);
            if (!publicRoom) {
              ack?.({ ok: false, error: 'NOT_FOUND' });
              return;
            }
            const room = roomNameForPublic(payload.publicId);
            await socket.join(room);
            subscribed.add(room);
            ack?.({
              ok: true,
              version: publicRoom.version,
              publicId: payload.publicId,
            });
            return;
          }

          ack?.({ ok: false, error: 'INVALID_SUBSCRIPTION' });
        } catch (error) {
          logger.error({ err: error }, 'Socket subscribe failed');
          ack?.({ ok: false, error: 'INTERNAL_ERROR' });
        }
      },
    );

    socket.on('unsubscribe', (payload: SubscriptionPayload) => {
      if (!payload || typeof payload !== 'object') return;
      if (isValidOpaqueId(payload.sessionId, 40)) {
        const room = roomNameForSession(payload.sessionId);
        void socket.leave(room);
        subscribed.delete(room);
      }
      if (isValidOpaqueId(payload.publicId, 80)) {
        const room = roomNameForPublic(payload.publicId);
        void socket.leave(room);
        subscribed.delete(room);
      }
    });

    socket.on('disconnect', (reason) => {
      clearInterval(timer);
      const current = connectionsByIp.get(ip) ?? 0;
      if (current <= 1) connectionsByIp.delete(ip);
      else connectionsByIp.set(ip, current - 1);
      logger.debug({ socketId: socket.id, reason }, 'Socket disconnected');
    });
  });

  return io;
}

export function revokePublicRoom(publicId: string): void {
  if (!io) return;
  io.in(roomNameForPublic(publicId)).disconnectSockets(true);
}

export function revokeSocketSession(sessionId: string): void {
  if (!io) return;
  io.in(`auth:${sessionId}`).disconnectSockets(true);
}

export function publishSessionEvent(input: {
  sessionId: string;
  publicId: string;
  type: string;
  version: number;
  payload?: Record<string, unknown>;
  publicPayload?: Record<string, unknown>;
}): void {
  if (!io) return;
  const event: SessionEvent = {
    eventId: randomUUID(),
    type: input.type,
    sessionId: input.sessionId,
    version: input.version,
    occurredAt: new Date().toISOString(),
    ...(input.payload ? { payload: input.payload } : {}),
  };
  io.to(`session:${input.sessionId}`).emit('session:event', event);

  const publicEvent = {
    eventId: randomUUID(),
    type: input.type,
    publicId: input.publicId,
    version: input.version,
    occurredAt: event.occurredAt,
    ...(input.publicPayload ? { payload: input.publicPayload } : {}),
  };
  io.to(`public:${input.publicId}`).emit('public:event', publicEvent);
}

export function closeRealtime(): void {
  if (io) {
    void io.close();
    io = null;
  }
}
