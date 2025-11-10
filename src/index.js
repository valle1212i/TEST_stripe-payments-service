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

const normalizeTenant = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : null;
};

const parseOffset = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
};

const withStripeTimeout = (promise) => {
  if (!config.stripeTimeoutMs || config.stripeTimeoutMs <= 0) {
    return promise;
  }

  let timeoutId;
  return Promise.race([
    promise.finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }),
    new Promise((_, reject) => {
      const timeoutError = new Error('Stripe request timed out');
      timeoutError.code = 'STRIPE_TIMEOUT';
      timeoutId = setTimeout(() => reject(timeoutError), config.stripeTimeoutMs);
    }),
  ]);
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
  const normalizedTenantFilter = normalizeTenant(tenantFilter);
  const refresh = req.query.refresh === 'true';

  const queryKey = buildCacheKey(tenantIdHeader, req.path, req.query);
  const cachedPayload = refresh ? null : cache.get(queryKey);

  if (cachedPayload) {
    console.info(
      `[${req.requestId}] Serving cached payouts for tenant ${tenantIdHeader}`
    );
    return res.json({ ...cachedPayload, cached: true });
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

    console.info(
      `[${req.requestId}] Fetching payouts from Stripe for tenant ${tenantIdHeader}`,
      {
        limit,
        offset,
        startingAfter,
        endingBefore,
      }
    );

    const payouts = await withStripeTimeout(stripe.payouts.list(listParams));

    let data = payouts.data;

    if (!startingAfter && !endingBefore && offset > 0) {
      data = data.slice(offset);
    }

    data = data.filter((payout) => {
      if (normalizedTenantFilter) {
        const metadataTenant =
          normalizeTenant(payout.metadata?.tenantId) ||
          normalizeTenant(payout.metadata?.tenant);

        if (metadataTenant) {
          if (metadataTenant !== normalizedTenantFilter) {
            return false;
          }
        } else if (!config.allowUnattributedPayouts) {
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
    console.info(
      `[${req.requestId}] Cached payouts for tenant ${tenantIdHeader} (ttl=${config.cacheTtlSeconds}s)`
    );
    return res.json(payload);
  } catch (error) {
    console.warn(
      `[${req.requestId}] Failed to list payouts for tenant ${tenantIdHeader}`,
      {
        code: error?.code,
        message: error?.message,
        causeName: error?.cause?.name,
        causeCode: error?.cause?.code,
        cachedAvailable: Boolean(cachedPayload),
      }
    );

    const causeName = error?.cause?.name || '';
    const causeCode = error?.cause?.code || '';
    const code = error?.code || '';
    const message = String(error?.message || '');
    const normalizedMessage = message.toLowerCase();
    const isTimeoutError =
      code === 'ETIMEDOUT' ||
      code === 'ECONNRESET' ||
      code === 'FETCH_FAILED' ||
      code === 'STRIPE_TIMEOUT' ||
      causeCode === 'UND_ERR_HEADERS_TIMEOUT' ||
      causeName === 'HeadersTimeoutError' ||
      normalizedMessage.includes('headers timeout') ||
      normalizedMessage.includes('fetch failed');

    if (isTimeoutError && cachedPayload) {
      console.info(
        `[${req.requestId}] Returning stale cached payouts after Stripe timeout for tenant ${tenantIdHeader}`
      );
      return res.json({
        ...cachedPayload,
        cached: true,
        stale: true,
        error: 'stripe_timeout',
      });
    }

    if (isTimeoutError) {
      console.warn(
        `[${req.requestId}] Returning empty payouts after Stripe timeout for tenant ${tenantIdHeader}`
      );
      return res.json({
        success: true,
        data: [],
        total_count: 0,
        has_more: false,
        cached: false,
        stale: true,
        error: 'stripe_timeout',
      });
    }

    return next(error);
  }
});

app.get('/api/payouts/:id', async (req, res, next) => {
  const { id } = req.params;
  const tenantId = req.tenantId;
  const normalizedTenantId = normalizeTenant(tenantId);

  try {
    const payout = await withStripeTimeout(stripe.payouts.retrieve(id));

    const payoutTenant =
      normalizeTenant(payout.metadata?.tenantId) ||
      normalizeTenant(payout.metadata?.tenant) ||
      null;

    if (normalizedTenantId && payoutTenant) {
      if (payoutTenant !== normalizedTenantId) {
        return res.status(404).json({ error: 'Payout not found for tenant' });
      }
    } else if (normalizedTenantId && !config.allowUnattributedPayouts) {
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
  const normalizedTenantId = normalizeTenant(tenantId);

  try {
    const payout = await withStripeTimeout(stripe.payouts.retrieve(id));
    const payoutTenant =
      normalizeTenant(payout.metadata?.tenantId) ||
      normalizeTenant(payout.metadata?.tenant) ||
      null;

    if (normalizedTenantId && payoutTenant) {
      if (payoutTenant !== normalizedTenantId) {
        return res.status(404).json({ error: 'Payout transactions not found' });
      }
    } else if (normalizedTenantId && !config.allowUnattributedPayouts) {
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

    const transactions = await withStripeTimeout(
      stripe.balanceTransactions.list({
        payout: id,
        ...listParams,
      })
    );

    return res.json({
      data: transactions.data || [],
      has_more: transactions.has_more || false,
    });
  } catch (error) {
    if (error && error.statusCode === 404) {
      return res.status(404).json({ error: 'Payout or transactions not found' });
    }

    const message = String(error?.message || '').toLowerCase();
    const code = error?.code;
    const isManualPayoutError =
      code === 'balance_transactions_manual_filtering_not_allowed' ||
      message.includes('only be filtered on automatic transfers');

    if (isManualPayoutError) {
      return res.json({ data: [], has_more: false });
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

