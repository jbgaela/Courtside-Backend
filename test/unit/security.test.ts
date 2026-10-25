import { describe, expect, it } from 'vitest';
import { productionSafetyFailures } from '../../src/config/env.js';
import { AppError } from '../../src/http/errors.js';
import { assertPasswordPolicy } from '../../src/security/password.js';
import { generatePublicId, safeEqual, sha256, slugify } from '../../src/security/tokens.js';

describe('security utilities', () => {
  it('hashes tokens deterministically without exposing the input', () => {
    const token = 'a-secret-session-token';
    const hash = sha256(token);
    expect(hash).toBe(sha256(token));
    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64);
  });

  it('compares strings safely', () => {
    expect(safeEqual('same-value', 'same-value')).toBe(true);
    expect(safeEqual('same-value', 'other-value')).toBe(false);
    expect(safeEqual('short', 'longer-value')).toBe(false);
  });

  it('creates URL-safe public identifiers', () => {
    const first = generatePublicId('s');
    const second = generatePublicId('s');
    expect(first).toMatch(/^s_[A-Za-z0-9]{12}$/);
    expect(second).not.toBe(first);
  });

  it('normalizes club slugs', () => {
    expect(slugify('  Riverside Pickleball Club! ')).toBe('riverside-pickleball-club');
    expect(slugify('Café Société')).toBe('cafe-societe');
    expect(slugify('***')).toBe('');
  });

  it('enforces password policy', () => {
    expect(() => assertPasswordPolicy('short')).toThrow(AppError);
    expect(() => assertPasswordPolicy('nodigitshere')).toThrow(AppError);
    expect(() => assertPasswordPolicy('password123')).not.toThrow();
  });

  it('uses stable application error envelopes', () => {
    const error = AppError.conflict('Conflict');
    expect(error.status).toBe(409);
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toBe('Conflict');
  });

  it('rejects unsafe production configuration values', () => {
    const failures = productionSafetyFailures({
      exposeDevTokens: true,
      rateLimitDisabled: true,
      cookieSecure: false,
      apiPublicOrigin: 'http://api.example.test',
      frontendOrigins: ['http://app.example.test'],
    });
    expect(failures).toHaveLength(5);

    const safe = productionSafetyFailures({
      exposeDevTokens: false,
      rateLimitDisabled: false,
      cookieSecure: true,
      apiPublicOrigin: 'https://api.example.test',
      frontendOrigins: ['https://app.example.test'],
    });
    expect(safe).toEqual([]);
  });
});
