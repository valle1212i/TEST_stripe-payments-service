const dotenv = require('dotenv');

dotenv.config();

const requiredEnvVars = ['STRIPE_SECRET_KEY', 'PAYMENTS_SHARED_SECRET'];
const missing = requiredEnvVars.filter((name) => !process.env[name]);

if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

const parseInteger = (value, fallback) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return parsed;
};

const parseStringArray = (value) => {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInteger(process.env.PORT, 3000),
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  sharedSecret: process.env.PAYMENTS_SHARED_SECRET,
  cacheTtlSeconds: parseInteger(process.env.CACHE_TTL_SECONDS, 60),
  rateLimitWindowMs: parseInteger(process.env.TENANT_RATE_LIMIT_WINDOW_MS, 60_000),
  rateLimitMax: parseInteger(process.env.TENANT_RATE_LIMIT_MAX, 100),
  allowedOrigins: parseStringArray(process.env.ALLOWED_ORIGINS),
};

module.exports = config;

