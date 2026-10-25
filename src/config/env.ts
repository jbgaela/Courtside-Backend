import 'dotenv/config';
import { z } from 'zod';

const booleanString = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((value) => value === 'true');

const envSchema = z.object({
  // Requiring an explicit environment prevents a production deployment from
  // silently falling back to development-only token and cookie behavior.
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_PUBLIC_URL: z.string().min(1).default('http://localhost:4000'),
  FRONTEND_ORIGIN: z.string().min(1).default('http://localhost:3000'),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'), {
      message: 'DATABASE_URL must be a MongoDB connection string',
    }),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  SESSION_IDLE_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  COOKIE_NAME: z.string().min(1).default('pq_session'),
  COOKIE_SECURE: booleanString('false'),
  EXPOSE_DEV_TOKENS: booleanString('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RATE_LIMIT_DISABLED: booleanString('false'),
  TRUST_PROXY: booleanString('false'),
  PREVIEW_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(300),
  SOCKET_SESSION_CHECK_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  SOCKET_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().min(1).max(1_000).default(50),
  SEED_PASSWORD: z.string().min(8).default('PickleQueue123!'),
});

export type AppEnv = z.infer<typeof envSchema>;

function loadEnv(): AppEnv {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || 'env'}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

export const env = loadEnv();
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

function normalizeOrigin(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Origins must not contain credentials, query strings or fragments');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('Origins must not contain a path');
  }
  return parsed.origin;
}

export const frontendOrigins = env.FRONTEND_ORIGIN.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
  .map((origin) => normalizeOrigin(origin));

const apiPublicOrigin = normalizeOrigin(env.API_PUBLIC_URL);

export function productionSafetyFailures(input: {
  exposeDevTokens: boolean;
  rateLimitDisabled: boolean;
  cookieSecure: boolean;
  apiPublicOrigin: string;
  frontendOrigins: string[];
}): string[] {
  const failures: string[] = [];
  if (input.exposeDevTokens) failures.push('EXPOSE_DEV_TOKENS must be false in production');
  if (input.rateLimitDisabled) failures.push('RATE_LIMIT_DISABLED must be false in production');
  if (!input.cookieSecure) failures.push('COOKIE_SECURE must be true in production');
  if (input.apiPublicOrigin.startsWith('http://')) {
    failures.push('API_PUBLIC_URL must use HTTPS in production');
  }
  if (input.frontendOrigins.length === 0) {
    failures.push('FRONTEND_ORIGIN must contain at least one production origin');
  }
  for (const origin of input.frontendOrigins) {
    if (origin.startsWith('http://')) {
      failures.push(`FRONTEND_ORIGIN must use HTTPS in production: ${origin}`);
    }
  }
  return failures;
}

if (isProduction) {
  const failures = productionSafetyFailures({
    exposeDevTokens: env.EXPOSE_DEV_TOKENS,
    rateLimitDisabled: env.RATE_LIMIT_DISABLED,
    cookieSecure: env.COOKIE_SECURE,
    apiPublicOrigin,
    frontendOrigins,
  });
  if (failures.length > 0) {
    throw new Error(
      `Unsafe production configuration:\n${failures.map((line) => `  - ${line}`).join('\n')}`,
    );
  }
}
