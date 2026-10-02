import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL', 'postgres://forge:forge@localhost:5432/forge_crm'),
  jwtSecret: required('JWT_SECRET', isProd ? undefined : 'dev-only-secret-do-not-use-in-production'),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? '15m',
  refreshTokenDays: Number(process.env.REFRESH_TOKEN_DAYS ?? 30),
  uploadDir: process.env.UPLOAD_DIR ?? new URL('../uploads/', import.meta.url).pathname,
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
};
