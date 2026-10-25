import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../infrastructure/prisma.js';
import { requestMetadata } from '../http/middleware/request-id.js';
import type { Request } from 'express';

export interface AdminAuditInput {
  actorId: string;
  targetUserId?: string | null;
  action: string;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILED';
  entityType?: string;
  entityId?: string | null;
  summary: string;
  metadata?: Prisma.InputJsonValue;
  req: Request;
}

export async function writeAdminAudit(
  input: AdminAuditInput,
  db: Prisma.TransactionClient | PrismaClient = prisma,
): Promise<void> {
  const meta = requestMetadata(input.req);
  await db.administrativeAuditEvent.create({
    data: {
      actorId: input.actorId,
      targetUserId: input.targetUserId ?? null,
      action: input.action,
      outcome: input.outcome ?? 'SUCCESS',
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      summary: input.summary,
      metadata: input.metadata,
      requestId: input.req.requestId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    },
  });
}
