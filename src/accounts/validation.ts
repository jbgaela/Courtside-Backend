import { SKILL_MAX, SKILL_MIN } from '@picklequeue/contracts';
import { AppError } from '../http/errors.js';

export function assertSkillValue(value: number): void {
  if (!Number.isFinite(value) || value < SKILL_MIN || value > SKILL_MAX) {
    throw AppError.unprocessable(`Skill must be between ${SKILL_MIN} and ${SKILL_MAX}`);
  }
}
