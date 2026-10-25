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

let io: Server | null = null;

function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey) continue;
    result[rawKey] = decodeURIComponent(rawValue.join('='));
  }
  return result;
}

async function resolveSocketUser(socket: Socket): Promise<string | null> {
  const cookies = parseCookieHeader(socket.handshake.headers.cookie);
  const token = cookies[env.COOKIE_NAME];
  if (!token) return null;
  const session = await prisma.authSession.findUnique({
    where: { tokenHash: sha256(token) },
    select: { userId: true, revokedAt: true, expiresAt: true, id: true },
  });
  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
  socket.data.userId = session.userId;
  socket.data.sessionId = session.id;
  return session.userId;
}

async function authorizeSessionRoom(userId: string, sessionId: string): Promise<boolean> {
  const session = await prisma.playSession.findUnique({
    where: { id: sessionId },
    select: { clubId: true },
  });
  if (!session) return false;
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
    select: { id: true, published: true, version: true },
  });
  if (!session || !session.published) return null;
  return { sessionId: session.id, version: session.version };
}

export function initRealtime(server: HttpServer): Server {
  io = new Server(server, {
    cors: {
      origin: frontendOrigins,
      credentials: true,
    },
    maxHttpBufferSize: 64 * 1024,
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
    logger.debug({ socketId: socket.id, userId: data.userId ?? null }, 'Socket connected');

    socket.on(
      'subscribe',
      async (payload: SubscriptionPayload, ack?: (result: unknown) => void) => {
        try {
          if (payload?.sessionId && typeof payload.sessionId === 'string') {
            if (!data.userId || !(await authorizeSessionRoom(data.userId, payload.sessionId))) {
              ack?.({ ok: false, error: 'FORBIDDEN' });
              return;
            }
            await socket.join(`session:${payload.sessionId}`);
            const session = await prisma.playSession.findUnique({
              where: { id: payload.sessionId },
              select: { version: true, publicId: true },
            });
            ack?.({ ok: true, version: session?.version ?? 0, sessionId: payload.sessionId });
            return;
          }

          if (payload?.publicId && typeof payload.publicId === 'string') {
            const publicRoom = await authorizePublicRoom(payload.publicId);
            if (!publicRoom) {
              ack?.({ ok: false, error: 'NOT_FOUND' });
              return;
            }
            await socket.join(`public:${payload.publicId}`);
            ack?.({
              ok: true,
              version: publicRoom.version,
              sessionId: publicRoom.sessionId,
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
      if (payload?.sessionId) void socket.leave(`session:${payload.sessionId}`);
      if (payload?.publicId) void socket.leave(`public:${payload.publicId}`);
    });

    socket.on('disconnect', (reason) => {
      logger.debug({ socketId: socket.id, reason }, 'Socket disconnected');
    });
  });

  return io;
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
