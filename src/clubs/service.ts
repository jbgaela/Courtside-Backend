import { Prisma } from '@prisma/client';
import type { ClubMembership } from '@prisma/client';
import { env } from '../config/env.js';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { randomToken, sha256, slugify } from '../security/tokens.js';
import { writeAudit } from '../audit/audit.js';
import { getClubAccess, getClubForAdmin, getClubForOwner } from './access.js';
import { clubDto, courtDto, invitationDto, membershipDto } from './serializers.js';

interface AuditMeta {
  ip?: string;
  userAgent?: string;
}

const OBJECT_ID = /^[a-f0-9]{24}$/i;

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name) || 'club';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${randomToken(3).toLowerCase().slice(0, 4)}`;
    const existing = await prisma.club.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  return `${base}-${randomToken(4).toLowerCase().slice(0, 6)}`;
}

export async function createClub(
  userId: string,
  input: { name: string; description?: string; location?: string; joinPolicy: string },
  meta: AuditMeta,
) {
  const slug = await uniqueSlug(input.name);
  const club = await prisma.$transaction(async (tx) => {
    const created = await tx.club.create({
      data: {
        name: input.name,
        slug,
        description: input.description ?? null,
        location: input.location ?? null,
        joinPolicy: input.joinPolicy,
        ownerId: userId,
        memberships: {
          create: {
            userId,
            role: 'OWNER',
            status: 'ACTIVE',
            joinedAt: new Date(),
          },
        },
      },
    });
    await writeAudit(tx, {
      clubId: created.id,
      actorId: userId,
      action: 'club.created',
      entityType: 'Club',
      entityId: created.id,
      summary: `Club “${created.name}” created`,
      metadata: { slug: created.slug },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return created;
  });
  return clubDto(club, { viewerRole: 'OWNER', memberCount: 1 });
}

export async function listClubs(query: { q?: string; limit: number }, userId?: string) {
  const where: Prisma.ClubWhereInput = {
    AND: [
      { OR: [{ archivedAt: null }, { archivedAt: { isSet: false } }] },
      ...(query.q
        ? [
            {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' as const } },
                { location: { contains: query.q, mode: 'insensitive' as const } },
              ],
            },
          ]
        : []),
    ],
  };
  const clubs = await prisma.club.findMany({
    where,
    orderBy: { name: 'asc' },
    take: query.limit,
  });
  const clubIds = clubs.map((club) => club.id);
  const activeCounts = clubIds.length
    ? await prisma.clubMembership.groupBy({
        by: ['clubId'],
        where: { clubId: { in: clubIds }, status: 'ACTIVE' },
        _count: { _all: true },
      })
    : [];
  const countMap = new Map(activeCounts.map((row) => [row.clubId, row._count._all]));
  const roles =
    userId && clubIds.length
      ? await prisma.clubMembership.findMany({
          where: { userId, clubId: { in: clubIds }, status: 'ACTIVE' },
          select: { clubId: true, role: true },
        })
      : [];
  const roleMap = new Map(roles.map((row) => [row.clubId, row.role]));
  return clubs.map((club) =>
    clubDto(club, {
      viewerRole: roleMap.get(club.id) ?? null,
      memberCount: countMap.get(club.id) ?? 0,
    }),
  );
}

export async function getClub(identifier: string, userId?: string) {
  const where: Prisma.ClubWhereInput = OBJECT_ID.test(identifier)
    ? { OR: [{ id: identifier }, { slug: identifier }] }
    : { slug: identifier };
  const club = await prisma.club.findFirst({ where });
  if (!club) throw AppError.notFound('Club not found');

  let membership: ClubMembership | null = null;
  if (userId) {
    membership = await prisma.clubMembership.findUnique({
      where: { clubId_userId: { clubId: club.id, userId } },
    });
  }
  if (club.archivedAt && membership?.role !== 'OWNER') {
    throw AppError.notFound('Club not found');
  }
  const memberCount = await prisma.clubMembership.count({
    where: { clubId: club.id, status: 'ACTIVE' },
  });
  const upcomingSessions = await prisma.playSession.count({
    where: {
      clubId: club.id,
      published: true,
      status: { in: ['SCHEDULED', 'CHECK_IN_OPEN', 'LIVE'] },
    },
  });
  return clubDto(club, {
    viewerRole: membership?.status === 'ACTIVE' ? membership.role : null,
    membershipStatus: membership?.status ?? null,
    memberCount,
    upcomingSessions,
  });
}

export async function updateClub(
  clubId: string,
  userId: string,
  input: {
    name?: string;
    description?: string | null;
    location?: string | null;
    joinPolicy?: string;
    expectedVersion: number;
  },
  meta: AuditMeta,
) {
  const access = await getClubForAdmin(clubId, userId);
  if (input.joinPolicy && access.membership.role !== 'OWNER') {
    throw AppError.forbidden('Only the club owner can change the join policy');
  }
  const updated = await prisma.club.updateMany({
    where: { id: clubId, version: input.expectedVersion },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.joinPolicy !== undefined ? { joinPolicy: input.joinPolicy } : {}),
      version: { increment: 1 },
    },
  });
  if (updated.count === 0) {
    throw AppError.conflict('This club was changed by someone else. Refresh and try again.');
  }
  await writeAudit(prisma, {
    clubId,
    actorId: userId,
    action: 'club.updated',
    entityType: 'Club',
    entityId: clubId,
    summary: 'Club details updated',
    metadata: input as unknown as Prisma.InputJsonValue,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return getClub(clubId, userId);
}

export async function listMembers(clubId: string, userId: string) {
  const access = await getClubAccess(clubId, userId);
  const includeEmail =
    access.membership.role === 'OWNER' || access.membership.role === 'QUEUE_MASTER';
  const memberships = await prisma.clubMembership.findMany({
    where: { clubId, status: { in: ['ACTIVE', 'PENDING', 'SUSPENDED'] } },
    include: { user: { include: { profile: true } } },
    orderBy: [{ status: 'asc' }, { role: 'asc' }, { createdAt: 'asc' }],
  });
  return memberships.map((membership) => membershipDto(membership, { includeEmail }));
}

export async function requestMembership(clubId: string, userId: string, meta: AuditMeta) {
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) throw AppError.notFound('Club not found');
  if (club.archivedAt) throw AppError.gone('This club has been archived');

  const existing = await prisma.clubMembership.findUnique({
    where: { clubId_userId: { clubId, userId } },
  });
  if (existing?.status === 'ACTIVE') {
    throw AppError.conflict('You are already a member of this club');
  }
  if (existing?.status === 'SUSPENDED') {
    throw AppError.forbidden('Your membership is suspended. Contact the club owner.');
  }
  if (club.joinPolicy === 'INVITE_ONLY') {
    throw AppError.forbidden('This club is invite-only');
  }
  const status = club.joinPolicy === 'OPEN' ? 'ACTIVE' : 'PENDING';
  const membership = existing
    ? await prisma.clubMembership.update({
        where: { id: existing.id },
        data: {
          status,
          role: 'PLAYER',
          joinedAt: status === 'ACTIVE' ? new Date() : null,
        },
      })
    : await prisma.clubMembership.create({
        data: {
          clubId,
          userId,
          status,
          role: 'PLAYER',
          joinedAt: status === 'ACTIVE' ? new Date() : null,
        },
      });
  await writeAudit(prisma, {
    clubId,
    actorId: userId,
    action: status === 'ACTIVE' ? 'club.member_joined' : 'club.membership_requested',
    entityType: 'ClubMembership',
    entityId: membership.id,
    summary: status === 'ACTIVE' ? 'Joined the club' : 'Requested club membership',
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { membership: { id: membership.id, status: membership.status, role: membership.role } };
}

export async function updateMember(
  clubId: string,
  actorId: string,
  membershipId: string,
  input: { role?: string; status?: string },
  meta: AuditMeta,
) {
  await getClubForOwner(clubId, actorId);
  const target = await prisma.clubMembership.findFirst({ where: { id: membershipId, clubId } });
  if (!target) throw AppError.notFound('Membership not found');
  if (target.role === 'OWNER') {
    throw AppError.forbidden('Transfer ownership instead of changing the owner role');
  }
  if (target.userId === actorId) {
    throw AppError.badRequest('You cannot change your own membership this way');
  }
  if (input.role === 'OWNER') {
    throw AppError.badRequest('Use the ownership transfer workflow');
  }
  const membership = await prisma.clubMembership.update({
    where: { id: target.id },
    data: {
      ...(input.role ? { role: input.role } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.status === 'ACTIVE' && !target.joinedAt ? { joinedAt: new Date() } : {}),
    },
    include: { user: { include: { profile: true } } },
  });
  await writeAudit(prisma, {
    clubId,
    actorId,
    action: 'club.member_updated',
    entityType: 'ClubMembership',
    entityId: target.id,
    summary: `Membership updated for user ${target.userId}`,
    metadata: input as unknown as Prisma.InputJsonValue,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return membershipDto(membership, { includeEmail: true });
}

export async function removeMember(
  clubId: string,
  actorId: string,
  membershipId: string,
  meta: AuditMeta,
) {
  await getClubForOwner(clubId, actorId);
  const target = await prisma.clubMembership.findFirst({ where: { id: membershipId, clubId } });
  if (!target) throw AppError.notFound('Membership not found');
  if (target.role === 'OWNER') throw AppError.forbidden('The owner cannot be removed');
  const membership = await prisma.clubMembership.update({
    where: { id: target.id },
    data: { status: 'LEFT', role: 'PLAYER', updatedAt: new Date() },
  });
  await writeAudit(prisma, {
    clubId,
    actorId,
    action: 'club.member_removed',
    entityType: 'ClubMembership',
    entityId: target.id,
    summary: `Member ${target.userId} removed`,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { id: membership.id, status: membership.status };
}

export async function leaveClub(clubId: string, userId: string, meta: AuditMeta) {
  const access = await getClubAccess(clubId, userId);
  if (access.membership.role === 'OWNER') {
    throw AppError.conflict('Transfer ownership before leaving the club');
  }
  await prisma.clubMembership.update({
    where: { id: access.membership.id },
    data: { status: 'LEFT', role: 'PLAYER', updatedAt: new Date() },
  });
  await writeAudit(prisma, {
    clubId,
    actorId: userId,
    action: 'club.member_left',
    entityType: 'ClubMembership',
    entityId: access.membership.id,
    summary: 'Left the club',
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { left: true };
}

export async function transferOwnership(
  clubId: string,
  actorId: string,
  targetUserId: string,
  meta: AuditMeta,
) {
  const access = await getClubForOwner(clubId, actorId);
  if (targetUserId === actorId) throw AppError.badRequest('You already own this club');
  const target = await prisma.clubMembership.findUnique({
    where: { clubId_userId: { clubId, userId: targetUserId } },
  });
  if (!target || target.status !== 'ACTIVE') {
    throw AppError.badRequest('The new owner must be an active club member');
  }
  await prisma.$transaction(async (tx) => {
    await tx.club.update({
      where: { id: clubId },
      data: { ownerId: targetUserId, version: { increment: 1 } },
    });
    await tx.clubMembership.update({
      where: { id: access.membership.id },
      data: { role: 'QUEUE_MASTER' },
    });
    await tx.clubMembership.update({
      where: { id: target.id },
      data: { role: 'OWNER' },
    });
    await writeAudit(tx, {
      clubId,
      actorId,
      action: 'club.ownership_transferred',
      entityType: 'Club',
      entityId: clubId,
      summary: 'Club ownership transferred',
      metadata: { previousOwnerId: actorId, newOwnerId: targetUserId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return getClub(clubId, targetUserId);
}

export async function archiveClub(clubId: string, actorId: string, meta: AuditMeta) {
  await getClubForOwner(clubId, actorId);
  const live = await prisma.playSession.count({ where: { clubId, status: 'LIVE' } });
  if (live > 0) throw AppError.conflict('Complete or cancel live sessions before archiving');
  await prisma.$transaction(async (tx) => {
    await tx.club.update({ where: { id: clubId }, data: { archivedAt: new Date() } });
    await tx.playSession.updateMany({
      where: { clubId, status: { in: ['DRAFT', 'SCHEDULED', 'CHECK_IN_OPEN'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'Club archived' },
    });
    await writeAudit(tx, {
      clubId,
      actorId,
      action: 'club.archived',
      entityType: 'Club',
      entityId: clubId,
      summary: 'Club archived',
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return { archived: true };
}

export async function createInvitation(
  clubId: string,
  actorId: string,
  input: { email: string; role: string },
  meta: AuditMeta,
) {
  const access = await getClubForAdmin(clubId, actorId);
  if (input.role === 'OWNER') throw AppError.badRequest('Ownership cannot be invited');
  if (input.role === 'QUEUE_MASTER' && access.membership.role !== 'OWNER') {
    throw AppError.forbidden('Only the club owner can invite Queue Masters');
  }
  const existingUser = await prisma.user.findUnique({ where: { email: input.email } });
  if (existingUser) {
    const existingMembership = await prisma.clubMembership.findUnique({
      where: { clubId_userId: { clubId, userId: existingUser.id } },
    });
    if (existingMembership?.status === 'ACTIVE') {
      throw AppError.conflict('This person is already an active member');
    }
  }
  await prisma.clubInvitation.updateMany({
    where: { clubId, email: input.email, status: 'PENDING' },
    data: { status: 'REVOKED' },
  });
  const token = randomToken(32);
  const invitation = await prisma.clubInvitation.create({
    data: {
      clubId,
      email: input.email,
      role: input.role,
      tokenHash: sha256(token),
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedById: actorId,
    },
  });
  await writeAudit(prisma, {
    clubId,
    actorId,
    action: 'club.invitation_sent',
    entityType: 'ClubInvitation',
    entityId: invitation.id,
    summary: `Invitation sent to ${input.email}`,
    metadata: { role: input.role },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return {
    invitation: invitationDto(invitation),
    devInvitationToken: env.EXPOSE_DEV_TOKENS ? token : null,
  };
}

export async function listInvitations(clubId: string, actorId: string) {
  await getClubForAdmin(clubId, actorId);
  const invitations = await prisma.clubInvitation.findMany({
    where: { clubId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return invitations.map(invitationDto);
}

export async function revokeInvitation(clubId: string, actorId: string, invitationId: string) {
  await getClubForAdmin(clubId, actorId);
  const invitation = await prisma.clubInvitation.findFirst({
    where: { id: invitationId, clubId },
  });
  if (!invitation) throw AppError.notFound('Invitation not found');
  if (invitation.status !== 'PENDING') throw AppError.conflict('Invitation is no longer pending');
  await prisma.clubInvitation.update({
    where: { id: invitation.id },
    data: { status: 'REVOKED' },
  });
  return { revoked: true };
}

export async function acceptInvitation(
  userId: string,
  userEmail: string,
  token: string,
  meta: AuditMeta,
) {
  const invitation = await prisma.clubInvitation.findUnique({
    where: { tokenHash: sha256(token) },
    include: { club: true },
  });
  if (
    !invitation ||
    invitation.status !== 'PENDING' ||
    invitation.expiresAt < new Date() ||
    invitation.email !== userEmail.toLowerCase()
  ) {
    throw AppError.badRequest('This invitation is invalid, expired, or belongs to another email');
  }
  if (invitation.club.archivedAt) throw AppError.gone('This club has been archived');

  const membership = await prisma.$transaction(async (tx) => {
    const current = await tx.clubMembership.findUnique({
      where: { clubId_userId: { clubId: invitation.clubId, userId } },
    });
    const saved = current
      ? await tx.clubMembership.update({
          where: { id: current.id },
          data: {
            role: invitation.role,
            status: 'ACTIVE',
            joinedAt: new Date(),
            invitedById: invitation.invitedById,
          },
        })
      : await tx.clubMembership.create({
          data: {
            clubId: invitation.clubId,
            userId,
            role: invitation.role,
            status: 'ACTIVE',
            joinedAt: new Date(),
            invitedById: invitation.invitedById,
          },
        });
    await tx.clubInvitation.update({
      where: { id: invitation.id },
      data: { status: 'ACCEPTED', acceptedById: userId, acceptedAt: new Date() },
    });
    await writeAudit(tx, {
      clubId: invitation.clubId,
      actorId: userId,
      action: 'club.invitation_accepted',
      entityType: 'ClubMembership',
      entityId: saved.id,
      summary: 'Invitation accepted',
      metadata: { role: invitation.role },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return saved;
  });
  return { membershipId: membership.id, clubId: membership.clubId, role: membership.role };
}

export async function listAudit(clubId: string, actorId: string, limit = 100) {
  await getClubForAdmin(clubId, actorId);
  const events = await prisma.auditEvent.findMany({
    where: { clubId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return events.map((event) => ({
    id: event.id,
    actorId: event.actorId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    summary: event.summary,
    metadata: event.metadata,
    createdAt: event.createdAt.toISOString(),
  }));
}

export async function listCourts(clubId: string, userId: string) {
  await getClubAccess(clubId, userId);
  const courts = await prisma.court.findMany({
    where: { clubId },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return courts.map(courtDto);
}

export async function createCourt(
  clubId: string,
  actorId: string,
  input: { name: string; sortOrder: number },
  meta: AuditMeta,
) {
  await getClubForAdmin(clubId, actorId);
  try {
    const court = await prisma.court.create({
      data: {
        clubId,
        name: input.name,
        sortOrder: input.sortOrder,
        status: 'AVAILABLE',
      },
    });
    await writeAudit(prisma, {
      clubId,
      actorId,
      action: 'court.created',
      entityType: 'Court',
      entityId: court.id,
      summary: `Court “${court.name}” created`,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return courtDto(court);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw AppError.conflict('A court with that name already exists');
    }
    throw error;
  }
}

export async function updateCourt(
  clubId: string,
  courtId: string,
  actorId: string,
  input: { name?: string; status?: string; sortOrder?: number },
  meta: AuditMeta,
) {
  await getClubForAdmin(clubId, actorId);
  const existing = await prisma.court.findFirst({ where: { id: courtId, clubId } });
  if (!existing) throw AppError.notFound('Court not found');
  try {
    const court = await prisma.court.update({
      where: { id: courtId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
    });
    if (input.status === 'INACTIVE') {
      await prisma.sessionCourt.updateMany({
        where: {
          courtId,
          session: { status: { in: ['DRAFT', 'SCHEDULED', 'CHECK_IN_OPEN', 'LIVE'] } },
        },
        data: { active: false },
      });
    }
    await writeAudit(prisma, {
      clubId,
      actorId,
      action: 'court.updated',
      entityType: 'Court',
      entityId: court.id,
      summary: `Court “${court.name}” updated`,
      metadata: input as unknown as Prisma.InputJsonValue,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return courtDto(court);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw AppError.conflict('A court with that name already exists');
    }
    throw error;
  }
}

export async function deactivateCourt(
  clubId: string,
  courtId: string,
  actorId: string,
  meta: AuditMeta,
) {
  await getClubForAdmin(clubId, actorId);
  const existing = await prisma.court.findFirst({ where: { id: courtId, clubId } });
  if (!existing) throw AppError.notFound('Court not found');
  await prisma.$transaction([
    prisma.court.update({ where: { id: courtId }, data: { status: 'INACTIVE' } }),
    prisma.sessionCourt.updateMany({
      where: {
        courtId,
        session: { status: { in: ['DRAFT', 'SCHEDULED', 'CHECK_IN_OPEN', 'LIVE'] } },
      },
      data: { active: false },
    }),
  ]);
  await writeAudit(prisma, {
    clubId,
    actorId,
    action: 'court.deactivated',
    entityType: 'Court',
    entityId: courtId,
    summary: `Court “${existing.name}” deactivated`,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { deactivated: true };
}
