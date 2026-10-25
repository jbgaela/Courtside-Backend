import type { CookieOptions, Response } from 'express';
import { env, isProduction } from '../config/env.js';

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction ? true : env.COOKIE_SECURE,
    path: '/',
    maxAge: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
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
