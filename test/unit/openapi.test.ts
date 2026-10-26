import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

describe('OpenAPI contract', () => {
  const document = parse(readFileSync(resolve(process.cwd(), 'openapi.yaml'), 'utf8')) as {
    openapi: string;
    paths: Record<string, unknown>;
    components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
  };

  it('is a valid OpenAPI 3.1 document with the critical paths', () => {
    expect(document.openapi).toBe('3.1.0');
    for (const path of [
      '/auth/login',
      '/clubs/{clubId}/sessions',
      '/sessions/{sessionId}/guests',
      '/sessions/{sessionId}/guests/{guestId}',
      '/sessions/{sessionId}/rotations/preview',
      '/sessions/{sessionId}/rotations/commit',
      '/matches/{matchId}/score-events',
      '/matches/{matchId}/complete',
      '/public/sessions/{publicId}',
      '/public/checkins/{token}',
      '/public/checkins/{token}/guests',
      '/public/checkins/{token}/guest',
      '/public/checkins/{token}/guest/leave',
      '/clubs/{clubId}/roles',
      '/sessions/{sessionId}/guest-policy',
      '/admin/roles',
      '/admin/roles/{roleId}',
      '/admin/roles/assign',
      '/admin/users/{userId}/club-roles',
    ]) {
      expect(document.paths[path], `missing ${path}`).toBeTruthy();
    }
  });

  it('documents the role and permission contract', () => {
    expect(document.components.schemas.Role).toBeTruthy();
    expect(document.components.schemas.RoleMembership).toBeTruthy();
    expect(document.components.schemas.ClubRoleAssignment).toBeTruthy();
  });

  it('documents the guest QR joining contract', () => {
    expect(document.components.schemas.GuestJoinRequest).toBeTruthy();
    expect(document.components.schemas.GuestStatus).toBeTruthy();
  });

  it('documents session cookies and CSRF', () => {
    expect(document.components.securitySchemes.sessionCookie).toBeTruthy();
    expect(document.components.securitySchemes.csrfToken).toBeTruthy();
  });

  it('documents the guest participant contract', () => {
    expect(document.components.schemas.GuestPlayer).toBeTruthy();
    expect(document.components.schemas.CreateGuestRequest).toBeTruthy();
    expect(document.components.schemas.UpdateGuestRequest).toBeTruthy();
  });
});
