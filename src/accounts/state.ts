import {
  ACCOUNT_STATUSES,
  ACCOUNT_STATUS_TRANSITIONS,
  PLATFORM_ROLES,
  REGISTRATION_REVIEW_STATUSES,
  type AccountStatus,
  type PlatformRole,
  type RegistrationReviewStatus,
} from '@picklequeue/contracts';
import type { RegistrationReview, User } from '@prisma/client';

export function platformRoleOf(
  user: Pick<User, 'platformRole'> | null | undefined,
): PlatformRole {
  return user?.platformRole === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'USER';
}

export function accountStatusOf(
  user: Pick<User, 'accountStatus'> | null | undefined,
): AccountStatus {
  const status = user?.accountStatus;
  return ACCOUNT_STATUSES.includes(status as AccountStatus) ? (status as AccountStatus) : 'ACTIVE';
}

export function registrationStatusOf(
  review: Pick<RegistrationReview, 'status'> | null | undefined,
): RegistrationReviewStatus | null {
  const status = review?.status;
  return REGISTRATION_REVIEW_STATUSES.includes(status as RegistrationReviewStatus)
    ? (status as RegistrationReviewStatus)
    : null;
}

export function isActiveAccount(user: Pick<User, 'accountStatus'> | null | undefined): boolean {
  return accountStatusOf(user) === 'ACTIVE';
}

export function isSuperAdmin(user: Pick<User, 'platformRole' | 'accountStatus'> | null | undefined) {
  return platformRoleOf(user) === 'SUPER_ADMIN' && isActiveAccount(user);
}

export function isPlatformRole(value: unknown): value is PlatformRole {
  return PLATFORM_ROLES.includes(value as PlatformRole);
}

export function canTransitionAccount(from: AccountStatus, to: AccountStatus): boolean {
  return ACCOUNT_STATUS_TRANSITIONS[from].includes(to);
}

export type RestrictedLoginState =
  | 'PENDING_APPROVAL'
  | 'APPROVED_PENDING_ACTIVATION'
  | 'REJECTED';

/**
 * Determines whether a password-authenticated account may receive a normal
 * application session, a restricted registration-status session, or no session.
 */
export function loginStateFor(
  user: Pick<User, 'accountStatus'>,
  review: Pick<RegistrationReview, 'status'> | null,
): { kind: 'ACTIVE' } | { kind: 'RESTRICTED'; status: RestrictedLoginState } | { kind: 'DENIED' } {
  const registrationStatus = registrationStatusOf(review);
  if (registrationStatus === 'REJECTED') {
    return { kind: 'RESTRICTED', status: 'REJECTED' };
  }
  const accountStatus = accountStatusOf(user);
  if (accountStatus === 'ACTIVE') return { kind: 'ACTIVE' };
  if (
    accountStatus === 'PENDING_APPROVAL' ||
    accountStatus === 'APPROVED_PENDING_ACTIVATION'
  ) {
    if (registrationStatus === 'APPROVED') {
      return { kind: 'RESTRICTED', status: 'APPROVED_PENDING_ACTIVATION' };
    }
    return { kind: 'RESTRICTED', status: 'PENDING_APPROVAL' };
  }
  return { kind: 'DENIED' };
}
