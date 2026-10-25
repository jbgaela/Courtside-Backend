import type { CookieOptions, Response } from 'express';
import { env, isProduction } from '../config/env.js';

export const REGISTRATION_COOKIE_NAME = 'pq_registration';
export const MFA_COOKIE_NAME = 'pq_mfa';

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction ? true : env.COOKIE_SECURE,
    path: '/',
    maxAge: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}

function registrationCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction ? true : env.COOKIE_SECURE,
    path: '/',
    maxAge: env.REGISTRATION_TTL_MINUTES * 60 * 1000,
  };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(env.COOKIE_NAME, token, cookieOptions());
}

export function clearSessionCookie(res: Response): void {
  const { maxAge: _maxAge, ...options } = cookieOptions();
  res.clearCookie(env.COOKIE_NAME, options);
}

export function readSessionCookie(cookies: Record<string, string | undefined>): string | null {
  return cookies[env.COOKIE_NAME] ?? null;
}

export function setRegistrationCookie(res: Response, token: string): void {
  res.cookie(REGISTRATION_COOKIE_NAME, token, registrationCookieOptions());
}

export function clearRegistrationCookie(res: Response): void {
  const { maxAge: _maxAge, ...options } = registrationCookieOptions();
  res.clearCookie(REGISTRATION_COOKIE_NAME, options);
}

export function readRegistrationCookie(
  cookies: Record<string, string | undefined>,
): string | null {
  return cookies[REGISTRATION_COOKIE_NAME] ?? null;
}

function mfaCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction ? true : env.COOKIE_SECURE,
    path: '/',
    maxAge: env.MFA_CHALLENGE_TTL_MINUTES * 60 * 1000,
  };
}

export function setMfaCookie(res: Response, token: string): void {
  res.cookie(MFA_COOKIE_NAME, token, mfaCookieOptions());
}

export function clearMfaCookie(res: Response): void {
  const { maxAge: _maxAge, ...options } = mfaCookieOptions();
  res.clearCookie(MFA_COOKIE_NAME, options);
}

export function readMfaCookie(cookies: Record<string, string | undefined>): string | null {
  return cookies[MFA_COOKIE_NAME] ?? null;
}
