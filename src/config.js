const dotenv = require('dotenv');

dotenv.config();

const discoverSharedSecret = () =>
  process.env.PAYMENTS_SHARED_SECRET || process.env.X_PAYMENTS_SECRET || null;

const missing = [];
if (!process.env.STRIPE_SECRET_KEY) {
  missing.push('STRIPE_SECRET_KEY');
}

const sharedSecretValue = discoverSharedSecret();
if (!sharedSecretValue) {
  missing.push('PAYMENTS_SHARED_SECRET (or X_PAYMENTS_SECRET)');
}

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

const parseBoolean = (value, fallback) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
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
  sharedSecret: sharedSecretValue,
  cacheTtlSeconds: parseInteger(process.env.CACHE_TTL_SECONDS, 60),
  rateLimitWindowMs: parseInteger(process.env.TENANT_RATE_LIMIT_WINDOW_MS, 60_000),
  rateLimitMax: parseInteger(process.env.TENANT_RATE_LIMIT_MAX, 100),
  allowedOrigins: parseStringArray(process.env.ALLOWED_ORIGINS),
  allowUnattributedPayouts: parseBoolean(process.env.ALLOW_UNATTRIBUTED_PAYOUTS, true),
};

module.exports = config;

