const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { v4: uuid } = require('uuid');
const stripe = require('./stripeClient');
const cache = require('./cache');
const config = require('./config');
const { requireInternalHeaders, headerNames } = require('./auth');

const app = express();

const parseLimit = (value, fallback = 100) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, 1), 100);
};

app.use(helmet());
app.use(express.json());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || config.allowedOrigins.length === 0) {
        return callback(null, true);
      }

      if (config.allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error('Origin not allowed by CORS policy'), false);
    },
    credentials: true,
  })
);

app.use((req, res, next) => {
  req.requestId = uuid();
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

const tenantRateLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers[headerNames.tenant] || req.ip,
});

app.use('/api', requireInternalHeaders, tenantRateLimiter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/payouts', async (req, res, next) => {
  const tenantIdHeader = req.tenantId;
  const tenantFilter = req.query.tenantId || tenantIdHeader;
  const refresh = req.query.refresh === 'true';

  const cacheKey = `payouts:${tenantIdHeader}:${tenantFilter || 'all'}`;
  const cached = refresh ? null : cache.get(cacheKey);

  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const payouts = await stripe.payouts.list({ limit: parseLimit(req.query.limit) });

    const filtered = payouts.data.filter((payout) => {
      if (!tenantFilter) {
        return true;
      }

      return (
        (payout.metadata && payout.metadata.tenantId === tenantFilter) ||
        payout.metadata?.tenant === tenantFilter
      );
    });

    const payload = {
      has_more: payouts.has_more,
      data: filtered,
      tenant: tenantIdHeader,
      cached: false,
    };

    cache.set(cacheKey, payload, config.cacheTtlSeconds);
    return res.json(payload);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/payouts/:id', async (req, res, next) => {
  const { id } = req.params;
  const tenantId = req.tenantId;

  try {
    const payout = await stripe.payouts.retrieve(id);

    const payoutTenant =
      payout.metadata?.tenantId || payout.metadata?.tenant || null;

    if (payoutTenant && payoutTenant !== tenantId) {
      return res.status(404).json({ error: 'Payout not found for tenant' });
    }

    return res.json(payout);
  } catch (error) {
    if (error && error.statusCode === 404) {
      return res.status(404).json({ error: 'Payout not found' });
    }

    return next(error);
  }
});

app.get('/api/payouts/:id/transactions', async (req, res, next) => {
  const { id } = req.params;
  const tenantId = req.tenantId;

  try {
    const payout = await stripe.payouts.retrieve(id);
    const payoutTenant =
      payout.metadata?.tenantId || payout.metadata?.tenant || null;

    if (payoutTenant && payoutTenant !== tenantId) {
      return res.status(404).json({ error: 'Payout transactions not found' });
    }

    const transactions = await stripe.payouts.listTransactions(id, {
      limit: parseLimit(req.query.limit),
    });

    return res.json(transactions);
  } catch (error) {
    if (error && error.statusCode === 404) {
      return res.status(404).json({ error: 'Payout or transactions not found' });
    }

    return next(error);
  }
});

app.use((err, req, res, next) => {
  // eslint-disable-line no-unused-vars
  console.error(`[${req.requestId}]`, err);
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
    requestId: req.requestId,
  });
});

app.listen(config.port, () => {
  console.log(`Stripe payments service listening on port ${config.port}`);
});

