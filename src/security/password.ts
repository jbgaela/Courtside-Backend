import bcrypt from 'bcryptjs';
import { AppError } from '../http/errors.js';

const BCRYPT_COST = 12;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < PASSWORD_MIN) {
    throw AppError.unprocessable(`Password must be at least ${PASSWORD_MIN} characters`, [
      { path: 'password', message: `Minimum ${PASSWORD_MIN} characters` },
    ]);
  }
  if (password.length > PASSWORD_MAX) {
    throw AppError.unprocessable('Password is too long', [
      { path: 'password', message: `Maximum ${PASSWORD_MAX} characters` },
    ]);
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw AppError.unprocessable('Password must contain at least one letter and one number', [
      { path: 'password', message: 'Include at least one letter and one number' },
    ]);
  }
}
