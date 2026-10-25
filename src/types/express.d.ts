import type { User, PlayerProfile } from '@prisma/client';

export interface AuthContext {
  user: User;
  profile: PlayerProfile | null;
  session: {
    id: string;
    csrfToken: string;
    expiresAt: Date;
  };
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
      validatedQuery?: unknown;
      validatedParams?: unknown;
    }
  }
}

export {};
