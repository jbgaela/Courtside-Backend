import { Prisma } from '@prisma/client';
import { AppError } from './errors.js';

const WRITE_CONFLICT_RETRY_LIMIT = 6;

function isWriteConflict(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') ||
    (error instanceof Error && /write conflict|deadlock/i.test(error.message))
  );
}

/**
 * MongoDB aborts one of two transactions that write the same session
 * document. Complete and correction operations legitimately update the session
 * version, so a bounded retry prevents a second court from receiving a
 * spurious conflict while the first result is being recorded.
 */
export async function withWriteConflictRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < WRITE_CONFLICT_RETRY_LIMIT; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (isWriteConflict(error) && attempt < WRITE_CONFLICT_RETRY_LIMIT - 1) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? AppError.conflict('A concurrent operation won. Refresh and try again.');
}
