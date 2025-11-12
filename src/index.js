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

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      const timeoutError = new Error('Stripe request timed out');
      timeoutError.code = 'STRIPE_TIMEOUT';
      reject(timeoutError);
    }, config.stripeTimeoutMs);

    promise
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
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

// Public health check (before auth)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root route for browser access
app.get('/', (req, res) => {
  res.json({
    service: 'Stripe Payments Service',
    status: 'running',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      payouts: '/api/payouts (requires auth)',
    },
  });
});

const tenantRateLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers[headerNames.tenant] || req.ip,
});

app.use('/api', requireInternalHeaders, tenantRateLimiter);

app.get('/api/payouts', async (req, res, next) => {
  const tenantIdHeader = req.tenantId;
  const tenantFilter = req.query.tenantId || tenantIdHeader;
  const normalizedTenantFilter = normalizeTenant(tenantFilter);
  const refresh = req.query.refresh === 'true';
  const startTime = process.hrtime.bigint();
  const elapsedMs = () =>
    Number((process.hrtime.bigint() - startTime) / BigInt(1e6));

  const queryKey = buildCacheKey(tenantIdHeader, req.path, req.query);
  const cachedPayload = refresh ? null : cache.get(queryKey);

  if (cachedPayload) {
    console.info(
      `[${req.requestId}] Serving cached payouts for tenant ${tenantIdHeader} (duration=${elapsedMs()}ms)`
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
      `[${req.requestId}] Cached payouts for tenant ${tenantIdHeader} (ttl=${config.cacheTtlSeconds}s, duration=${elapsedMs()}ms, count=${shaped.length})`
    );
    return res.json(payload);
  } catch (error) {
    const duration = elapsedMs();
    console.warn(
      `[${req.requestId}] Failed to list payouts for tenant ${tenantIdHeader} (duration=${duration}ms)`,
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

    const fallbackPayload = cachedPayload
      ? {
          ...cachedPayload,
          cached: true,
          stale: true,
          error: 'stripe_error',
        }
      : {
          success: true,
          data: [],
          total_count: 0,
          has_more: false,
          cached: false,
          stale: true,
          error: 'stripe_error',
        };

    console.error(
      `[${req.requestId}] Returning fallback payouts after Stripe error for tenant ${tenantIdHeader}`,
      {
        code,
        causeName,
        causeCode,
      }
    );

    return res.json(fallbackPayload);
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
  const startTime = process.hrtime.bigint();
  const elapsedMs = () =>
    Number((process.hrtime.bigint() - startTime) / BigInt(1e6));

  try {
    console.info(
      `[${req.requestId}] Fetching transactions for payout ${id} (tenant=${tenantId})`
    );

    const payout = await withStripeTimeout(stripe.payouts.retrieve(id));

    console.info(`[${req.requestId}] Retrieved payout:`, {
      id: payout.id,
      type: payout.type,
      amount: payout.amount,
      currency: payout.currency,
      status: payout.status,
      arrival_date: payout.arrival_date,
      created: payout.created,
      automatic: payout.automatic,
    });

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
      limit: parseLimit(req.query.limit) || 100,
    };

    if (req.query.starting_after) {
      listParams.starting_after = req.query.starting_after;
    }
    if (req.query.ending_before) {
      listParams.ending_before = req.query.ending_before;
    }

    // Fetch balance transactions for the payout
    // For automatic payouts, we can filter directly by payout ID
    // For manual payouts, Stripe doesn't allow filtering by payout ID
    let transactions;
    const isManualPayout = payout.type === 'manual' || !payout.automatic;

    console.info(
      `[${req.requestId}] Fetching balance transactions for payout ${id} (manual=${isManualPayout}, automatic=${payout.automatic})`
    );

    try {
      if (isManualPayout) {
        // Manual payouts: fetch by date range and filter
        console.info(
          `[${req.requestId}] Manual payout detected - fetching transactions by date range`
        );

        const payoutDate = payout.created;
        const dayInSeconds = 86400;
        // Use a wider date range for manual payouts
        const dateRange = {
          created: {
            gte: payoutDate - dayInSeconds * 30, // 30 days before
            lte: payoutDate + dayInSeconds * 1, // 1 day after
          },
        };

        const allTransactions = await withStripeTimeout(
          stripe.balanceTransactions.list({
            ...dateRange,
            limit: 100, // Fetch more to find matches
          })
        );

        // Filter to transactions that reference this payout
        if (allTransactions.data) {
          const filtered = allTransactions.data.filter((tx) => {
            // Match transactions that are linked to this payout
            return tx.payout === id;
          });

          transactions = {
            data: filtered,
            has_more: false,
          };

          console.info(
            `[${req.requestId}] Manual payout: found ${filtered.length} transactions via date range filtering (searched ${allTransactions.data.length} transactions)`
          );
        } else {
          transactions = { data: [], has_more: false };
        }
      } else {
        // Automatic payouts: filter directly by payout ID
        console.info(
          `[${req.requestId}] Automatic payout - fetching transactions with payout filter`
        );

        transactions = await withStripeTimeout(
          stripe.balanceTransactions.list({
            payout: id,
            ...listParams,
          })
        );

        console.info(
          `[${req.requestId}] Automatic payout: fetched ${transactions.data?.length || 0} transactions directly`
        );

        // If no transactions found, try alternative approach:
        // Fetch all balance transactions and filter by payout ID in response
        if (!transactions.data || transactions.data.length === 0) {
          console.warn(
            `[${req.requestId}] No transactions found with payout filter for automatic payout, trying alternative method`
          );

          // Try fetching transactions that were created around the payout date
          // and check if they reference this payout
          if (payout.created) {
            const dayInSeconds = 86400;
            const dateRange = {
              created: {
                gte: payout.created - dayInSeconds * 7,
                lte: payout.created + dayInSeconds * 7,
              },
            };

            try {
              const fallbackTransactions = await withStripeTimeout(
                stripe.balanceTransactions.list({
                  ...dateRange,
                  limit: 100,
                })
              );

              if (fallbackTransactions.data) {
                // Filter to transactions that reference this payout
                const filtered = fallbackTransactions.data.filter(
                  (tx) => tx.payout === id
                );

                if (filtered.length > 0) {
                  transactions.data = filtered;
                  transactions.has_more = false;
                  console.info(
                    `[${req.requestId}] Found ${filtered.length} transactions via date range fallback`
                  );
                } else {
                  console.warn(
                    `[${req.requestId}] No transactions found in date range that reference payout ${id}`
                  );
                  // Log sample transaction IDs to help debug
                  if (fallbackTransactions.data.length > 0) {
                    console.info(
                      `[${req.requestId}] Sample transaction payout IDs:`,
                      fallbackTransactions.data
                        .slice(0, 5)
                        .map((tx) => ({
                          id: tx.id,
                          type: tx.type,
                          payout: tx.payout,
                          created: tx.created,
                        }))
                    );
                  }
                }
              }
            } catch (fallbackError) {
              console.warn(
                `[${req.requestId}] Fallback fetch failed:`,
                fallbackError.message
              );
            }
          }
        }
      }
    } catch (error) {
      const message = String(error?.message || '').toLowerCase();
      const code = error?.code;

      const isManualPayoutError =
        code === 'balance_transactions_manual_filtering_not_allowed' ||
        message.includes('only be filtered on automatic transfers') ||
        message.includes('cannot filter balance transaction history');

      if (isManualPayoutError && !isManualPayout) {
        // Treated as manual payout even though it's marked as automatic
        console.warn(
          `[${req.requestId}] Payout ${id} treated as manual due to API error, trying date range method`
        );

        try {
          const payoutDate = payout.created;
          const dayInSeconds = 86400;
          const dateRange = {
            created: {
              gte: payoutDate - dayInSeconds * 30,
              lte: payoutDate + dayInSeconds * 1,
            },
          };

          const allTransactions = await withStripeTimeout(
            stripe.balanceTransactions.list({
              ...dateRange,
              limit: 100,
            })
          );

          if (allTransactions.data) {
            const filtered = allTransactions.data.filter(
              (tx) => tx.payout === id
            );
            transactions = {
              data: filtered,
              has_more: false,
            };
            console.info(
              `[${req.requestId}] Found ${filtered.length} transactions via date range after API error`
            );
          } else {
            transactions = { data: [], has_more: false };
          }
        } catch (fallbackError) {
          console.error(
            `[${req.requestId}] Fallback after manual payout error failed:`,
            fallbackError.message
          );
          transactions = { data: [], has_more: false };
        }
      } else if (isManualPayoutError) {
        console.info(
          `[${req.requestId}] Manual payout confirmed via API error, returning empty result`
        );
        return res.json({ data: [], has_more: false });
      } else {
        throw error;
      }
    }

    // Ensure transactions is initialized
    if (!transactions) {
      console.warn(
        `[${req.requestId}] Transactions not initialized for payout ${id}, returning empty result`
      );
      transactions = { data: [], has_more: false };
    }

    console.info(
      `[${req.requestId}] Returning ${transactions.data?.length || 0} transactions for payout ${id} (duration=${elapsedMs()}ms)`
    );

    // Log transaction details for debugging
    if (transactions.data && transactions.data.length > 0) {
      console.info(
        `[${req.requestId}] Transaction types for payout ${id}:`,
        transactions.data.map((tx) => ({
          id: tx.id,
          type: tx.type,
          amount: tx.amount,
          net: tx.net,
        }))
      );
    } else {
      console.warn(
        `[${req.requestId}] No transactions found for payout ${id}. Payout details:`,
        {
          id: payout.id,
          type: payout.type,
          automatic: payout.automatic,
          amount: payout.amount,
          status: payout.status,
          created: payout.created,
        }
      );
    }

    return res.json({
      data: transactions.data || [],
      has_more: transactions.has_more || false,
    });
  } catch (error) {
    console.error(
      `[${req.requestId}] Error fetching transactions for payout ${id}:`,
      {
        code: error?.code,
        message: error?.message,
        statusCode: error?.statusCode,
        type: error?.type,
        duration: elapsedMs(),
      }
    );

    if (error && error.statusCode === 404) {
      return res.status(404).json({ error: 'Payout or transactions not found' });
    }

    const message = String(error?.message || '').toLowerCase();
    const code = error?.code;
    const isManualPayoutError =
      code === 'balance_transactions_manual_filtering_not_allowed' ||
      message.includes('only be filtered on automatic transfers');

    if (isManualPayoutError) {
      console.info(
        `[${req.requestId}] Manual payout detected via error, returning empty result`
      );
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

// Handle uncaught errors and rejections
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

const server = app.listen(config.port, () => {
  console.log(`Stripe payments service listening on port ${config.port}`);
  console.log(`Environment: ${config.env}`);
  console.log(`Health check: http://localhost:${config.port}/api/health`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use`);
  } else {
    console.error('Server error:', error);
  }
  process.exit(1);
});

