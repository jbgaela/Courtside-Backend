import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  decryptMfaSecret,
  encryptMfaSecret,
  generateTotpSecret,
  totpCode,
  verifyTotp,
} from '../../src/security/mfa.js';

describe('MFA primitives', () => {
  it('round-trips base32 secrets', () => {
    const raw = Buffer.from('picklequeue-mfa-test');
    const encoded = base32Encode(raw);
    expect(base32Decode(encoded).toString()).toBe(raw.toString());
  });

  it('generates and verifies time-based codes with a small clock window', () => {
    const secret = generateTotpSecret();
    const now = 1_800_000_000_000;
    const code = totpCode(secret, now);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(secret, code, now)).toBe(true);
    expect(verifyTotp(secret, code, now + 30_000)).toBe(true);
    expect(verifyTotp(secret, code, now + 90_000)).toBe(false);
    expect(verifyTotp(secret, '000000', now)).toBe(false);
  });

  it('encrypts stored MFA secrets with authenticated encryption', () => {
    const secret = generateTotpSecret();
    const encrypted = encryptMfaSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptMfaSecret(encrypted)).toBe(secret);
    const tampered = `${encrypted.slice(0, -1)}A`;
    expect(() => decryptMfaSecret(tampered)).toThrow();
  });
});
