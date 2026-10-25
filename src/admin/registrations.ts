import { Prisma } from '@prisma/client';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { writeAdminAudit } from './audit.js';
import { adminRegistrationDetail, adminRegistrationSummary } from './serializers.js';
import type { Request } from 'express';

const includeReview = {
  user: { include: { profile: true } },
  reviewedBy: { select: { id: true, name: true } },
} satisfies Prisma.RegistrationReviewInclude;

function pageMeta(total: number, page: number, limit: number) {
  return { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

export async function listRegistrations(query: {
  page: number;
  limit: number;
  status?: string;
  q?: string;
  from?: string;
  to?: string;
}) {
  const where: Prisma.RegistrationReviewWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.from || query.to
      ? {
          submittedAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        }
      : {}),
    ...(query.q
      ? {
          user: {
            OR: [
              { name: { contains: query.q } },
              { email: { contains: query.q } },
              { profile: { is: { displayName: { contains: query.q } } } },
            ],
          },
        }
      : {}),
  };
  const [items, total, pending, approved, rejected] = await Promise.all([
    prisma.registrationReview.findMany({
      where,
      include: includeReview,
      orderBy: { submittedAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.registrationReview.count({ where }),
    prisma.registrationReview.count({ where: { status: 'PENDING' } }),
    prisma.registrationReview.count({ where: { status: 'APPROVED' } }),
    prisma.registrationReview.count({ where: { status: 'REJECTED' } }),
  ]);
  return {
    items: items.map(adminRegistrationSummary),
    meta: {
      ...pageMeta(total, query.page, query.limit),
      counts: { pending, approved, rejected },
    },
  };
}

export async function getRegistration(registrationId: string) {
  const review = await prisma.registrationReview.findUnique({
    where: { id: registrationId },
    include: includeReview,
  });
  if (!review) throw AppError.notFound('Registration not found');
  return adminRegistrationDetail(review);
}

export async function approveRegistration(
  actorId: string,
  registrationId: string,
  expectedVersion: number,
  note: string | undefined,
  req: Request,
) {
  const review = await prisma.registrationReview.findUnique({
    where: { id: registrationId },
    include: { user: true },
  });
  if (!review) throw AppError.notFound('Registration not found');
  if (review.status !== 'PENDING') {
    throw AppError.conflict(`Registration has already been ${review.status.toLowerCase()}`);
  }
  if (review.user.deletedAt || review.user.accountStatus === 'DELETED') {
    throw AppError.conflict('Deleted accounts cannot be approved');
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const decision = await tx.registrationReview.updateMany({
      where: { id: registrationId, status: 'PENDING', version: expectedVersion },
      data: {
        status: 'APPROVED',
        version: { increment: 1 },
        reviewedAt: now,
        reviewedById: actorId,
        internalReason: note ?? null,
        publicReason: null,
      },
    });
    if (decision.count === 0) {
      throw AppError.conflict('Registration changed while you were reviewing it');
    }
    const activated = await tx.user.updateMany({
      where: {
        id: review.userId,
        accountStatus: 'PENDING_APPROVAL',
      },
      data: { accountStatus: 'APPROVED_PENDING_ACTIVATION' },
    });
    if (activated.count === 0) {
      throw AppError.conflict('Account is no longer eligible for approval');
    }
    await writeAdminAudit(
      {
        actorId,
        targetUserId: review.userId,
        action: 'registration.approved',
        summary: 'Registration approved',
        entityType: 'RegistrationReview',
        entityId: registrationId,
        metadata: { note: note ?? null },
        req,
      },
      tx,
    );
  });
  return getRegistration(registrationId);
}

export async function rejectRegistration(
  actorId: string,
  registrationId: string,
  expectedVersion: number,
  input: { internalReason?: string; publicReason?: string },
  req: Request,
) {
  const review = await prisma.registrationReview.findUnique({
    where: { id: registrationId },
    include: { user: true },
  });
  if (!review) throw AppError.notFound('Registration not found');
  if (review.status !== 'PENDING') {
    throw AppError.conflict(`Registration has already been ${review.status.toLowerCase()}`);
  }
  if (review.user.deletedAt || review.user.accountStatus === 'DELETED') {
    throw AppError.conflict('Deleted applications cannot be rejected through this workflow');
  }
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const decision = await tx.registrationReview.updateMany({
      where: { id: registrationId, status: 'PENDING', version: expectedVersion },
      data: {
        status: 'REJECTED',
        version: { increment: 1 },
        reviewedAt: now,
        reviewedById: actorId,
        internalReason: input.internalReason ?? null,
        publicReason: input.publicReason ?? null,
      },
    });
    if (decision.count === 0) {
      throw AppError.conflict('Registration changed while you were reviewing it');
    }
    await writeAdminAudit(
      {
        actorId,
        targetUserId: review.userId,
        action: 'registration.rejected',
        summary: 'Registration rejected',
        entityType: 'RegistrationReview',
        entityId: registrationId,
        metadata: {
          internalReason: input.internalReason ?? null,
          publicReason: input.publicReason ?? null,
        },
        req,
      },
      tx,
    );
  });
  return getRegistration(registrationId);
}

export async function reopenRegistration(
  actorId: string,
  registrationId: string,
  expectedVersion: number,
  note: string | undefined,
  req: Request,
) {
  const review = await prisma.registrationReview.findUnique({
    where: { id: registrationId },
    include: { user: true },
  });
  if (!review) throw AppError.notFound('Registration not found');
  if (review.status !== 'REJECTED') {
    throw AppError.conflict('Only rejected registrations can be reopened');
  }
  if (review.user.deletedAt || review.user.accountStatus === 'DELETED') {
    throw AppError.conflict('Deleted accounts cannot be reopened');
  }
  if (review.user.accountStatus === 'SUSPENDED') {
    throw AppError.conflict('Reactivate the account before reopening its registration');
  }
  await prisma.$transaction(async (tx) => {
    const decision = await tx.registrationReview.updateMany({
      where: { id: registrationId, status: 'REJECTED', version: expectedVersion },
      data: {
        status: 'PENDING',
        version: { increment: 1 },
        reviewedAt: null,
        reviewedById: null,
        internalReason: null,
        publicReason: null,
      },
    });
    if (decision.count === 0) {
      throw AppError.conflict('Registration changed while you were reviewing it');
    }
    await tx.user.update({
      where: { id: review.userId },
      data: { accountStatus: 'PENDING_APPROVAL' },
    });
    await writeAdminAudit(
      {
        actorId,
        targetUserId: review.userId,
        action: 'registration.reopened',
        summary: 'Rejected registration reopened for review',
        entityType: 'RegistrationReview',
        entityId: registrationId,
        metadata: { note: note ?? null },
        req,
      },
      tx,
    );
  });
  return getRegistration(registrationId);
}

export async function registrationCounts() {
  const [pending, approved, rejected] = await Promise.all([
    prisma.registrationReview.count({ where: { status: 'PENDING' } }),
    prisma.registrationReview.count({ where: { status: 'APPROVED' } }),
    prisma.registrationReview.count({ where: { status: 'REJECTED' } }),
  ]);
  return { pending, approved, rejected };
}
