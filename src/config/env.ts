import 'dotenv/config';
import { z } from 'zod';

const booleanString = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
  COOKIE_NAME: z.string().min(1).default('pq_session'),
  COOKIE_SECURE: booleanString('false'),
  EXPOSE_DEV_TOKENS: booleanString('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RATE_LIMIT_DISABLED: booleanString('false'),
  TRUST_PROXY: booleanString('false'),
  PREVIEW_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(300),
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
export const frontendOrigins = env.FRONTEND_ORIGIN.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
