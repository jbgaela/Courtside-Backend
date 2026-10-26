import { Prisma } from '@prisma/client';
import type { Role } from '@prisma/client';
import {
  BUILTIN_ROLE_DEFINITIONS,
  CLUB_PERMISSION_DEFINITIONS,
  CLUB_PERMISSION_KEYS,
  PLATFORM_PERMISSION_DEFINITIONS,
  PREVIEW_ROLE_DEFINITIONS,
  type ClubPermissionDefinition,
} from '@picklequeue/contracts';
import type { Request } from 'express';
import { AppError } from '../http/errors.js';
import { prisma } from '../infrastructure/prisma.js';
import { isActiveAccount } from '../accounts/state.js';
import { writeAdminAudit } from './audit.js';

const ROLE_KEY_PREFIX = 'CUSTOM_';
const MAX_ROLE_NAME = 80;
const MAX_ROLE_DESCRIPTION = 300;
const MAX_PERMISSIONS = CLUB_PERMISSION_KEYS.length;

type RoleRecord = Role;

export interface RoleSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  scope: string;
  permissions: string[];
  isSystem: boolean;
  isProtected: boolean;
  version: number;
  userCount: number;
  createdAt: string;
  updatedAt: string;
}

function permissionSet(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))];
}

function assertClubPermissions(value: string[]): string[] {
  const unique = permissionSet(value);
  if (unique.length > MAX_PERMISSIONS) {
    throw AppError.unprocessable('Too many permissions were supplied');
  }
  const allowed = new Set(CLUB_PERMISSION_KEYS);
  const invalid = unique.filter((key) => !allowed.has(key));
  if (invalid.length > 0) {
    throw AppError.unprocessable(`Unknown permission: ${invalid[0]}`);
  }
  if (!unique.includes('club.view')) {
    throw AppError.unprocessable('A club role must include View club');
  }
  return unique;
}

function assertRoleName(value: string): string {
  const name = value.trim();
  if (name.length < 2 || name.length > MAX_ROLE_NAME) {
    throw AppError.unprocessable(`Role name must be between 2 and ${MAX_ROLE_NAME} characters`);
  }
  return name;
}

function assertRoleDescription(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const description = value.trim();
  if (description.length > MAX_ROLE_DESCRIPTION) {
    throw AppError.unprocessable(
      `Role description must be ${MAX_ROLE_DESCRIPTION} characters or fewer`,
    );
  }
  return description || null;
}

function slugKey(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
    .slice(0, 36);
  return `${ROLE_KEY_PREFIX}${slug || 'ROLE'}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

async function userCountFor(role: RoleRecord): Promise<number> {
  if (role.scope === 'PLATFORM') {
    return prisma.user.count({
      where: {
        platformRole: 'SUPER_ADMIN',
        accountStatus: 'ACTIVE',
        OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
      },
    });
  }
  const rows = await prisma.clubMembership.groupBy({
    by: ['userId'],
    where: {
      role: role.key,
      status: 'ACTIVE',
      club: { archivedAt: { isSet: false } },
    },
  });
  return rows.length;
}

const BUILTIN_ROLE_ORDER = [
  'SUPER_ADMIN',
  'OWNER',
  'QUEUE_MASTER',
  'PLAYER',
  'CLUB_MANAGER',
  'VIEWER',
];

function sortRoles(roles: RoleSummary[]): RoleSummary[] {
  return [...roles].sort((left, right) => {
    const leftRank = BUILTIN_ROLE_ORDER.indexOf(left.key);
    const rightRank = BUILTIN_ROLE_ORDER.indexOf(right.key);
    if (leftRank !== -1 || rightRank !== -1) {
      if (leftRank === -1) return 1;
      if (rightRank === -1) return -1;
      return leftRank - rightRank;
    }
    return left.name.localeCompare(right.name);
  });
}

function toSummary(role: RoleRecord, userCount: number): RoleSummary {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    scope: role.scope,
    permissions: role.permissions,
    isSystem: role.isSystem,
    isProtected: role.isProtected,
    version: role.version,
    userCount,
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
  };
}

/**
 * Idempotently create the protected built-in roles. Protected permissions are
 * reset to the canonical definition so an out-of-band database edit cannot
 * silently remove the ability to operate a club or administer the platform.
 */
export async function ensureBuiltinRoles(): Promise<void> {
  for (const definition of BUILTIN_ROLE_DEFINITIONS) {
    const data = {
      name: definition.name,
      description: definition.description,
      scope: definition.scope,
      permissions: [...definition.permissions],
      isSystem: definition.isSystem,
      isProtected: definition.isProtected,
    };
    await prisma.role.upsert({
      where: { key: definition.key },
      create: { key: definition.key, ...data },
      update: definition.isProtected ? data : {},
    });
  }
}

/** Seed the optional demo presets only in the deterministic demo seed. */
export async function seedPreviewRoles(): Promise<void> {
  for (const definition of PREVIEW_ROLE_DEFINITIONS) {
    await prisma.role.upsert({
      where: { key: definition.key },
      create: {
        key: definition.key,
        name: definition.name,
        description: definition.description,
        scope: definition.scope,
        permissions: [...definition.permissions],
        isSystem: definition.isSystem,
        isProtected: definition.isProtected,
      },
      update: {},
    });
  }
}

export async function listRoles(input: { q?: string; scope?: string }) {
  const roleQuery: Prisma.RoleWhereInput = {
    archivedAt: { isSet: false },
  };
  if (input.scope && ['PLATFORM', 'CLUB'].includes(input.scope)) {
    roleQuery.scope = input.scope;
  }
  const roles = await prisma.role.findMany({
    where: roleQuery,
    orderBy: [{ scope: 'asc' }, { isProtected: 'desc' }, { name: 'asc' }],
  });
  const term = input.q?.trim().toLowerCase();
  const filtered = term
    ? roles.filter((role) =>
        `${role.name} ${role.key} ${role.description ?? ''}`.toLowerCase().includes(term),
      )
    : roles;
  const items = await Promise.all(
    filtered.map(async (role) => toSummary(role, await userCountFor(role))),
  );
  return { items: sortRoles(items) };
}

export async function getPermissionCatalog() {
  return {
    groups: CLUB_PERMISSION_DEFINITIONS.reduce<
      Array<{ name: string; permissions: ClubPermissionDefinition[] }>
    >((groups, permission) => {
      let group = groups.find((entry) => entry.name === permission.group);
      if (!group) {
        group = { name: permission.group, permissions: [] };
        groups.push(group);
      }
      group.permissions.push(permission);
      return groups;
    }, []),
    platform: PLATFORM_PERMISSION_DEFINITIONS,
    protectedKeys: BUILTIN_ROLE_DEFINITIONS.filter((role) => role.isProtected).map(
      (role) => role.key,
    ),
    assignableKeys: CLUB_PERMISSION_KEYS,
  };
}

export async function getPermissionMatrix() {
  const roles = await prisma.role.findMany({
    where: { archivedAt: { isSet: false } },
    orderBy: [{ scope: 'asc' }, { name: 'asc' }],
  });
  return {
    permissions: CLUB_PERMISSION_DEFINITIONS,
    roles: sortRoles(
      await Promise.all(roles.map(async (role) => toSummary(role, await userCountFor(role)))),
    ),
  };
}

export async function getRoleDetail(id: string) {
  const role = await prisma.role.findUnique({ where: { id } });
  if (!role || role.archivedAt) throw AppError.notFound('Role not found');
  const userCount = await userCountFor(role);
  const memberships =
    role.scope === 'PLATFORM'
      ? []
      : await prisma.clubMembership.findMany({
          where: { role: role.key, status: 'ACTIVE' },
          include: {
            user: { select: { id: true, name: true, email: true, accountStatus: true } },
            club: { select: { id: true, name: true, slug: true } },
          },
          orderBy: [{ club: { name: 'asc' } }, { user: { name: 'asc' } }],
          take: 500,
        });
  return {
    ...toSummary(role, userCount),
    memberships: memberships.map((membership) => ({
      id: membership.id,
      userId: membership.user.id,
      userName: membership.user.name,
      userEmail: membership.user.email,
      accountStatus: membership.user.accountStatus,
      clubId: membership.club.id,
      clubName: membership.club.name,
      clubSlug: membership.club.slug,
    })),
  };
}

async function assertNameAvailable(name: string, exceptId?: string) {
  const existing = await prisma.role.findMany({ select: { id: true, name: true } });
  const normalized = name.toLowerCase();
  if (existing.some((role) => role.id !== exceptId && role.name.toLowerCase() === normalized)) {
    throw AppError.conflict('A role with that name already exists');
  }
}

export async function createRole(
  input: { name: string; description?: string | null; permissions: string[] },
  actorId: string,
  req: Request,
) {
  const name = assertRoleName(input.name);
  const permissions = assertClubPermissions(input.permissions);
  await assertNameAvailable(name);
  const role = await prisma.role.create({
    data: {
      key: slugKey(name),
      name,
      description: assertRoleDescription(input.description),
      scope: 'CLUB',
      permissions,
      isSystem: false,
      isProtected: false,
      version: 1,
    },
  });
  await writeAdminAudit(
    {
      actorId,
      action: 'role.created',
      entityType: 'Role',
      entityId: role.id,
      summary: `Created role ${role.name}`,
      metadata: { roleKey: role.key, permissions: role.permissions },
      req,
    },
    prisma,
  );
  return toSummary(role, 0);
}

export async function updateRole(
  id: string,
  input: {
    name?: string;
    description?: string | null;
    permissions?: string[];
    expectedVersion?: number;
  },
  actorId: string,
  req: Request,
) {
  const role = await prisma.role.findUnique({ where: { id } });
  if (!role || role.archivedAt) throw AppError.notFound('Role not found');
  if (role.isProtected) {
    throw AppError.forbidden(
      'This system role is protected. Duplicate it to create a customizable role.',
    );
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== role.version) {
    throw AppError.conflict('This role changed since you opened it. Refresh and try again.');
  }
  const name = input.name !== undefined ? assertRoleName(input.name) : role.name;
  if (name !== role.name) await assertNameAvailable(name, role.id);
  const permissions =
    input.permissions !== undefined ? assertClubPermissions(input.permissions) : role.permissions;
  const description =
    input.description !== undefined ? assertRoleDescription(input.description) : role.description;

  const updated = await prisma.role.update({
    where: { id: role.id },
    data: {
      name,
      description,
      permissions,
      version: { increment: 1 },
    },
  });
  const before = role.permissions.filter((key) => !permissions.includes(key));
  const after = permissions.filter((key) => !role.permissions.includes(key));
  await writeAdminAudit(
    {
      actorId,
      action: 'role.updated',
      entityType: 'Role',
      entityId: role.id,
      summary: `Updated role ${updated.name}`,
      metadata: {
        roleKey: role.key,
        permissionsAdded: after,
        permissionsRemoved: before,
        beforeName: role.name,
        afterName: updated.name,
      },
      req,
    },
    prisma,
  );
  return toSummary(updated, await userCountFor(updated));
}

export async function duplicateRole(id: string, actorId: string, req: Request) {
  const source = await prisma.role.findUnique({ where: { id } });
  if (!source || source.archivedAt) throw AppError.notFound('Role not found');
  if (source.scope !== 'CLUB') {
    throw AppError.unprocessable('Platform roles cannot be duplicated');
  }
  let name = `${source.name} copy`;
  let suffix = 2;
  while (await prisma.role.findFirst({ where: { name } })) {
    name = `${source.name} copy ${suffix}`;
    suffix += 1;
  }
  const role = await prisma.role.create({
    data: {
      key: slugKey(name),
      name,
      description: source.description,
      scope: 'CLUB',
      permissions: source.permissions,
      isSystem: false,
      isProtected: false,
      version: 1,
    },
  });
  await writeAdminAudit(
    {
      actorId,
      action: 'role.duplicated',
      entityType: 'Role',
      entityId: role.id,
      summary: `Duplicated role ${source.name} as ${role.name}`,
      metadata: { sourceRoleKey: source.key, roleKey: role.key },
      req,
    },
    prisma,
  );
  return toSummary(role, 0);
}

export async function archiveRole(id: string, actorId: string, req: Request) {
  const role = await prisma.role.findUnique({ where: { id } });
  if (!role || role.archivedAt) throw AppError.notFound('Role not found');
  if (role.isSystem || role.isProtected) {
    throw AppError.conflict('System roles cannot be deleted. Duplicate the role to customize it.');
  }
  if (role.scope === 'PLATFORM') {
    throw AppError.conflict('Platform roles cannot be deleted');
  }
  const count = await userCountFor(role);
  if (count > 0) {
    throw AppError.conflict(
      `${count} active member${count === 1 ? '' : 's'} still use this role. Reassign them before deleting it.`,
    );
  }
  const pendingInvitations = await prisma.clubInvitation.count({
    where: { role: role.key, status: 'PENDING' },
  });
  if (pendingInvitations > 0) {
    throw AppError.conflict(
      `${pendingInvitations} pending invitation${pendingInvitations === 1 ? '' : 's'} use this role. Revoke or reassign them first.`,
    );
  }
  const archived = await prisma.role.update({
    where: { id: role.id },
    data: { archivedAt: new Date(), version: { increment: 1 } },
  });
  await writeAdminAudit(
    {
      actorId,
      action: 'role.deleted',
      entityType: 'Role',
      entityId: role.id,
      summary: `Deleted role ${role.name}`,
      metadata: { roleKey: role.key, permissions: role.permissions },
      req,
    },
    prisma,
  );
  return { id: archived.id, deleted: true };
}

export async function assignRole(
  input: { userId: string; clubId: string; roleKey: string },
  actorId: string,
  req: Request,
) {
  const role = await prisma.role.findUnique({ where: { key: input.roleKey } });
  if (!role || role.archivedAt || role.scope !== 'CLUB') {
    throw AppError.unprocessable('Choose an active club role');
  }
  if (role.key === 'OWNER') {
    throw AppError.conflict('Use the club ownership transfer workflow to assign an owner');
  }
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw AppError.notFound('User not found');
  if (!isActiveAccount(user)) {
    throw AppError.conflict('Only active accounts can receive a club role');
  }
  const club = await prisma.club.findUnique({ where: { id: input.clubId } });
  if (!club || club.archivedAt) throw AppError.notFound('Club not found');
  if (club.ownerId === user.id && role.key !== 'OWNER') {
    throw AppError.conflict('Transfer club ownership before changing the owner role');
  }
  const existing = await prisma.clubMembership.findUnique({
    where: { clubId_userId: { clubId: club.id, userId: user.id } },
  });
  if (existing?.role === 'OWNER' && role.key !== 'OWNER') {
    throw AppError.conflict('Transfer club ownership before changing the owner role');
  }
  const membership = await prisma.clubMembership.upsert({
    where: { clubId_userId: { clubId: club.id, userId: user.id } },
    create: {
      clubId: club.id,
      userId: user.id,
      role: role.key,
      status: 'ACTIVE',
      joinedAt: new Date(),
      invitedById: actorId,
    },
    update: {
      role: role.key,
      status: 'ACTIVE',
      joinedAt: existing?.joinedAt ?? new Date(),
    },
  });
  await writeAdminAudit(
    {
      actorId,
      targetUserId: user.id,
      action: existing ? 'role.assignment_changed' : 'role.assigned',
      entityType: 'ClubMembership',
      entityId: membership.id,
      summary: `${existing ? 'Changed' : 'Assigned'} ${role.name} at ${club.name}`,
      metadata: {
        clubId: club.id,
        roleKey: role.key,
        beforeRoleKey: existing?.role ?? null,
        membershipStatus: membership.status,
      },
      req,
    },
    prisma,
  );
  return {
    id: membership.id,
    userId: user.id,
    clubId: club.id,
    role: role.key,
    roleName: role.name,
    status: membership.status,
  };
}

export async function removeRoleAssignment(
  membershipId: string,
  actorId: string,
  req: Request,
) {
  const membership = await prisma.clubMembership.findUnique({
    where: { id: membershipId },
    include: { user: { select: { id: true, name: true } }, club: true },
  });
  if (!membership) throw AppError.notFound('Club membership not found');
  if (membership.role === 'OWNER' || membership.club.ownerId === membership.userId) {
    throw AppError.conflict('Transfer club ownership before removing the owner');
  }
  const removed = await prisma.clubMembership.update({
    where: { id: membership.id },
    data: { status: 'LEFT', role: 'PLAYER', updatedAt: new Date() },
  });
  await writeAdminAudit(
    {
      actorId,
      targetUserId: membership.userId,
      action: 'role.assignment_removed',
      entityType: 'ClubMembership',
      entityId: membership.id,
      summary: `Removed ${membership.user.name} from ${membership.club.name}`,
      metadata: { clubId: membership.clubId, roleKey: membership.role },
      req,
    },
    prisma,
  );
  return { id: removed.id, removed: true };
}

export async function getRolesForUser(userId: string) {
  const memberships = await prisma.clubMembership.findMany({
    where: { userId, status: { not: 'LEFT' } },
    include: {
      club: { select: { id: true, name: true, slug: true, archivedAt: true } },
      roleRef: { select: { key: true, name: true, permissions: true } },
    },
    orderBy: { club: { name: 'asc' } },
  });
  return memberships.map((membership) => ({
    id: membership.id,
    clubId: membership.club.id,
    clubName: membership.club.name,
    clubSlug: membership.club.slug,
    clubArchived: Boolean(membership.club.archivedAt),
    role: membership.role,
    roleName: membership.roleRef?.name ?? membership.role,
    status: membership.status,
    permissions: membership.roleRef?.permissions ?? [],
  }));
}

/** Resolve the permissions a role key grants. Unknown or archived roles grant none. */
export async function permissionsForRoleKey(roleKey: string): Promise<string[]> {
  const role = await prisma.role.findUnique({ where: { key: roleKey } });
  if (!role || role.archivedAt) return [];
  return role.permissions;
}
