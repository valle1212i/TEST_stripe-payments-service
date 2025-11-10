# Stripe Payments Service

Internal microservice that exposes secure endpoints for Stripe payout data, intended for customer portal integrations.

## Prerequisites

- Node.js 18+
- Stripe account with access to payouts
- Internal shared secret for service authentication

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the example environment file and update values:
   ```bash
   cp .env.example .env
   ```
3. Populate `.env` with valid credentials:
   - `STRIPE_SECRET_KEY`: Stripe secret key with payouts scope.
   - `PAYMENTS_SHARED_SECRET` **or** `X_PAYMENTS_SECRET`: Shared secret used by upstream callers in the `X-Internal-Auth` header.
   - `PORT`: Port for the HTTP server (default `3000`).
   - `CACHE_TTL_SECONDS`: In-memory cache TTL for payout listings.
   - `TENANT_RATE_LIMIT_WINDOW_MS`: Rate limit window in milliseconds (per tenant).
   - `TENANT_RATE_LIMIT_MAX`: Max requests allowed per tenant within the window.
   - `ALLOW_UNATTRIBUTED_PAYOUTS`: When `true` (default), payouts without tenant metadata are returned to any authenticated tenant.
   - `STRIPE_TIMEOUT_MS`: Maximum time (ms) to wait for Stripe responses (default `15000`).
   - `STRIPE_MAX_NETWORK_RETRIES`: Automatic retry attempts for transient Stripe errors (default `2`).
   - `ALLOWED_ORIGINS`: Comma-delimited list of origins permitted via CORS.
4. Start the service:
   ```bash
   npm start
   ```

The service listens on `http://localhost:<PORT>` and logs startup information to the console.

## Authentication Model

All endpoints under `/api` require:

- `X-Internal-Auth`: Must match `PAYMENTS_SHARED_SECRET` (or legacy `X_PAYMENTS_SECRET`).
- `X-Tenant`: Unique tenant identifier. Used for authorization checks and rate limiting.

Requests missing these headers receive appropriate error responses (`401`, `403`, or `400`). Each response emits an `X-Request-Id` header to aid log correlation.

## API Reference

| Method | Path                           | Description                                          |
| ------ | ------------------------------ | ---------------------------------------------------- |
| GET    | `/api/health`                  | Health check and diagnostics.                        |
| GET    | `/api/payouts`                 | Lists payouts (filters, cursors, caching supported). |
| GET    | `/api/payouts/:id`             | Retrieves a single payout by Stripe payout ID.       |
| GET    | `/api/payouts/:id/transactions`| Lists transactions associated with a payout.         |

### `GET /api/payouts`

**Headers**

- `X-Internal-Auth`: Shared secret.
- `X-Tenant`: Tenant identifier. Required for cache keying and rate limiting.

**Query Parameters**

- `limit` (default `100`, max `100`)
- `offset` (ignored when cursors are supplied)
- `starting_after`, `ending_before`
- `search`
- `from_date`, `to_date`
- `status`, `type`
- `tenantId` (overrides header for filtering)
- `refresh` (`true` bypasses cache)
- `ALLOW_UNATTRIBUTED_PAYOUTS` (env): determines whether payouts missing tenant metadata are included.

**Response**

```json
{
  "success": true,
  "data": [
    {
      "id": "po_123",
      "amount": 1000,
      "status": "paid",
      "created": 1728798752,
      "arrival_date": 1728885152,
      "transaction_count": 14
      // ...remaining Stripe payout fields
    }
  ],
  "total_count": 1,
  "has_more": false,
  "cached": false,
  "stale": false
}
```

When Stripe is slow or unreachable, the service returns the last cached payload (with `"stale": true` and `"error": "stripe_timeout"`) or an empty result set, avoiding request timeouts.

### `GET /api/payouts/:id`

```json
{ "payout": { /* Stripe payout object */ } }
```

### `GET /api/payouts/:id/transactions`

Query parameters: `limit`, `starting_after`, `ending_before`.

```json
{ "data": [ /* balance transactions */ ], "has_more": false }
```

### Error Shape

```json
{
  "error": "Message",
  "requestId": "uuid"
}
```

## Caching

`GET /api/payouts` uses an in-memory cache keyed by tenant and query parameters. Cache entries respect `CACHE_TTL_SECONDS`. Include `?refresh=true` to bypass the cache for a single request.

## Rate Limiting

Per-tenant limits are enforced using `express-rate-limit`. Adjust the window duration and request cap via environment variables. Limits apply to all `/api` routes after authentication.

## Deployment on Render

1. Create a new **Web Service** in Render and connect the repository.
2. Set the build command to:
   ```bash
   npm install
   ```
3. Set the start command to:
   ```bash
   npm start
   ```
4. Configure environment variables in Render's dashboard matching `.env.example`.
5. Ensure the service is configured to run on the same region as your dependent services for reduced latency.
6. Trigger a deploy; Render automatically rebuilds on new pushes to the default branch.

## Development Notes

- Logs include a per-request `X-Request-Id` for easier tracing.
- Extend the caching layer (`src/cache.js`) or replace with Redis/Memcached for production usage if needed.
- Add integration tests using your preferred test runner before production go-live.

