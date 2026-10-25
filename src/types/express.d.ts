import type { User, PlayerProfile } from '@prisma/client';
import type { RegistrationContext } from '../auth/registration-session.js';
import type { MfaContext } from '../auth/mfa.js';

export interface AuthContext {
  user: User;
  profile: PlayerProfile | null;
  session: {
    id: string;
    csrfToken: string;
    expiresAt: Date;
    reauthenticatedAt: Date | null;
  };
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
      registration?: RegistrationContext;
      mfa?: MfaContext;
      validatedQuery?: unknown;
      validatedParams?: unknown;
    }
  }
}

export {};
