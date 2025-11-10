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

const parseOffset = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
};

const toUnixTimestamp = (value) => {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return Math.floor(date.getTime() / 1000);
};

const buildCacheKey = (tenantId, path, params) =>
  [tenantId, path, JSON.stringify(params || {})].join(':');

const shapePayoutForResponse = (payout) => {
  const transactionCount =
    payout.metadata?.transaction_count ||
    payout.metadata?.transactionCount ||
    payout.metadata?.transactions ||
    null;

  return {
    ...payout,
    transaction_count:
      transactionCount !== null && transactionCount !== undefined
        ? Number.parseInt(transactionCount, 10) || 0
        : 0,
  };
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

  const queryKey = buildCacheKey(tenantIdHeader, req.path, req.query);
  const cached = refresh ? null : cache.get(queryKey);

  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);
    const startingAfter = req.query.starting_after;
    const endingBefore = req.query.ending_before;
    const search = req.query.search?.toLowerCase();
    const status = req.query.status;
    const type = req.query.type;
    const fromDate = toUnixTimestamp(req.query.from_date);
    const toDate = toUnixTimestamp(req.query.to_date);

    const listParams = {
      limit: Math.min(
        startingAfter || endingBefore ? limit : Math.min(limit + offset, 100),
        100
      ),
    };

    if (startingAfter) {
      listParams.starting_after = startingAfter;
    }
    if (endingBefore) {
      listParams.ending_before = endingBefore;
    }
    if (status) {
      listParams.status = status;
    }

    const created = {};
    if (fromDate) {
      created.gte = fromDate;
    }
    if (toDate) {
      created.lte = toDate;
    }
    if (Object.keys(created).length > 0) {
      listParams.created = created;
    }

    const payouts = await stripe.payouts.list(listParams);

    let data = payouts.data;

    if (!startingAfter && !endingBefore && offset > 0) {
      data = data.slice(offset);
    }

    data = data.filter((payout) => {
      if (tenantFilter) {
        const tenantMatches =
          payout.metadata?.tenantId === tenantFilter ||
          payout.metadata?.tenant === tenantFilter;
        if (!tenantMatches) {
          return false;
        }
      }

      if (type && payout.type !== type) {
        return false;
      }

      if (search) {
        const haystack = [
          payout.id,
          payout.description,
          payout.metadata?.tenantId,
          payout.metadata?.tenant,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        if (!haystack.includes(search)) {
          return false;
        }
      }

      return true;
    });

    const shaped = data.slice(0, limit).map(shapePayoutForResponse);

    const payload = {
      success: true,
      data: shaped,
      total_count: shaped.length,
      has_more: payouts.has_more,
    };

    cache.set(queryKey, payload, config.cacheTtlSeconds);
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

    return res.json({ payout });
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

    const listParams = {
      limit: parseLimit(req.query.limit),
    };

    if (req.query.starting_after) {
      listParams.starting_after = req.query.starting_after;
    }
    if (req.query.ending_before) {
      listParams.ending_before = req.query.ending_before;
    }

    const transactions = await stripe.payouts.listTransactions(id, listParams);

    return res.json({
      data: transactions.data,
      has_more: transactions.has_more,
    });
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

