import type { Prisma } from '@prisma/client';
import type { DbClient } from '../infrastructure/prisma.js';

export interface AuditInput {
  clubId?: string | null;
  sessionId?: string | null;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  metadata?: Prisma.InputJsonValue;
  ip?: string | null;
  userAgent?: string | null;
}

export async function writeAudit(db: DbClient, input: AuditInput): Promise<void> {
  await db.auditEvent.create({
    data: {
      clubId: input.clubId ?? null,
      sessionId: input.sessionId ?? null,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      summary: input.summary,
      metadata: input.metadata ?? undefined,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}
