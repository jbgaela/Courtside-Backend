import { Prisma } from '@prisma/client';
import { AppError } from './errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { sha256 } from '../security/tokens.js';

interface IdempotencyInput<T> {
  userId: string;
  key: string | null | undefined;
  endpoint: string;
  request: unknown;
  action: () => Promise<{ data: T; statusCode?: number }>;
}

export interface IdempotentResult<T> {
  data: T;
  statusCode: number;
  replayed: boolean;
}

const STALE_PROCESSING_MS = 2 * 60 * 1000;

/**
 * Reserves an idempotency key before running the action, so two concurrent
 * retries cannot both award a point or complete a match.
 */
export async function withIdempotency<T>({
  userId,
  key,
  endpoint,
  request,
  action,
}: IdempotencyInput<T>): Promise<IdempotentResult<T>> {
  if (!key) {
    const result = await action();
    return { data: result.data, statusCode: result.statusCode ?? 200, replayed: false };
  }
  if (key.length < 8 || key.length > 100) {
    throw AppError.badRequest('Idempotency-Key must be between 8 and 100 characters');
  }

  const requestHash = sha256(JSON.stringify(request));
  const findExisting = () =>
    prisma.idempotencyRecord.findUnique({ where: { key_userId: { key, userId } } });

  const existing = await findExisting();
  if (existing) {
    if (existing.endpoint !== endpoint || existing.requestHash !== requestHash) {
      throw AppError.conflict('This idempotency key was used for a different request');
    }
    if (existing.status === 'COMPLETED') {
      return {
        data: existing.response as T,
        statusCode: existing.statusCode ?? 200,
        replayed: true,
      };
    }
    if (existing.createdAt.getTime() > Date.now() - STALE_PROCESSING_MS) {
      throw AppError.conflict('A request with this idempotency key is already in progress');
    }
    await prisma.idempotencyRecord.delete({ where: { id: existing.id } }).catch(() => undefined);
  }

  try {
    await prisma.idempotencyRecord.create({
      data: {
        key,
        userId,
        endpoint,
        requestHash,
        status: 'PROCESSING',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw AppError.conflict('A request with this idempotency key is already in progress');
    }
    throw error;
  }

  try {
    const result = await action();
    const statusCode = result.statusCode ?? 200;
    await prisma.idempotencyRecord.update({
      where: { key_userId: { key, userId } },
      data: {
        status: 'COMPLETED',
        statusCode,
        response: result.data as unknown as Prisma.InputJsonValue,
      },
    });
    return { data: result.data, statusCode, replayed: false };
  } catch (error) {
    await prisma.idempotencyRecord
      .delete({ where: { key_userId: { key, userId } } })
      .catch(() => undefined);
    throw error;
  }
}
