import { describe, expect, it } from 'vitest';
import { createGuestSchema, updateGuestSchema } from '../../src/sessions/schemas.js';

describe('guest validation', () => {
  it('accepts and trims a complete guest profile', () => {
    const parsed = createGuestSchema.parse({
      displayName: '  José Álvarez  ',
      gender: 'MALE',
      skillRating: 3.25,
      addToQueue: true,
    });
    expect(parsed.displayName).toBe('José Álvarez');
    expect(parsed.gender).toBe('MALE');
    expect(parsed.skillRating).toBe(3.25);
    expect(parsed.addToQueue).toBe(true);
  });

  it('defaults addToQueue to false', () => {
    const parsed = createGuestSchema.parse({
      displayName: 'Guest One',
      gender: 'PREFER_NOT_TO_SAY',
      skillRating: 3,
    });
    expect(parsed.addToQueue).toBe(false);
  });

  it('rejects a missing name, gender or out-of-range skill', () => {
    expect(
      createGuestSchema.safeParse({ displayName: '   ', gender: 'MALE', skillRating: 3 }).success,
    ).toBe(false);
    expect(
      createGuestSchema.safeParse({ displayName: 'Guest', gender: '', skillRating: 3 }).success,
    ).toBe(false);
    expect(
      createGuestSchema.safeParse({ displayName: 'Guest', gender: 'MALE', skillRating: 8 }).success,
    ).toBe(false);
    expect(
      createGuestSchema.safeParse({ displayName: 'Guest', gender: 'MALE', skillRating: 3.1 })
        .success,
    ).toBe(false);
  });

  it('rejects control characters and overlong names', () => {
    expect(
      createGuestSchema.safeParse({
        displayName: 'Guest\u0000Name',
        gender: 'FEMALE',
        skillRating: 3,
      }).success,
    ).toBe(false);
    expect(
      createGuestSchema.safeParse({
        displayName: 'x'.repeat(81),
        gender: 'FEMALE',
        skillRating: 3,
      }).success,
    ).toBe(false);
  });

  it('requires at least one editable field and validates the version guard', () => {
    expect(updateGuestSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(updateGuestSchema.safeParse({ displayName: 'Updated' }).success).toBe(true);
    expect(updateGuestSchema.safeParse({ skillRating: 3.25, expectedVersion: 2 }).success).toBe(
      true,
    );
    expect(updateGuestSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
  });
});
