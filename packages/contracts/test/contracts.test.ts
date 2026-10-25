import { describe, expect, it } from 'vitest';
import {
  MATCHMAKING_DEFAULTS,
  SCORING_DEFAULTS,
  SESSION_TRANSITIONS,
  matchmakingConfigSchema,
  scoringConfigSchema,
  toPublicDisplayName,
} from '../src/index.js';

describe('shared contracts', () => {
  it('provides valid documented defaults', () => {
    expect(matchmakingConfigSchema.parse({})).toEqual(MATCHMAKING_DEFAULTS);
    expect(scoringConfigSchema.parse({})).toEqual(SCORING_DEFAULTS);
    expect(MATCHMAKING_DEFAULTS.strategy).toBe('HYBRID');
    expect(SCORING_DEFAULTS.mode).toBe('RALLY');
  });

  it('rejects a preferred spread above the maximum', () => {
    const result = matchmakingConfigSchema.safeParse({
      preferredSkillSpread: 2,
      maxSkillSpread: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an impossible point cap', () => {
    expect(
      scoringConfigSchema.safeParse({ targetScore: 15, pointCap: 12, winByTwo: true }).success,
    ).toBe(false);
  });

  it('does not permit side-out scoring in this release', () => {
    expect(scoringConfigSchema.safeParse({ mode: 'SIDE_OUT' }).success).toBe(false);
  });

  it('encodes explicit session transitions', () => {
    expect(SESSION_TRANSITIONS.DRAFT).toContain('SCHEDULED');
    expect(SESSION_TRANSITIONS.SCHEDULED).toContain('CHECK_IN_OPEN');
    expect(SESSION_TRANSITIONS.CHECK_IN_OPEN).toContain('LIVE');
    expect(SESSION_TRANSITIONS.LIVE).toContain('COMPLETED');
    expect(SESSION_TRANSITIONS.COMPLETED).toEqual([]);
    expect(SESSION_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it('shortens public display names', () => {
    expect(toPublicDisplayName('Alex Reyes')).toBe('Alex R.');
    expect(toPublicDisplayName('Morgan')).toBe('Morgan');
    expect(toPublicDisplayName('  Alex   van der Berg ')).toBe('Alex B.');
    expect(toPublicDisplayName('')).toBe('Player');
  });
});
