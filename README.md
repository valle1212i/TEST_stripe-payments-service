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
   - `PAYMENTS_SHARED_SECRET`: Shared secret used by upstream callers in the `X-Internal-Auth` header.
   - `PORT`: Port for the HTTP server (default `3000`).
   - `CACHE_TTL_SECONDS`: In-memory cache TTL for payout listings.
   - `TENANT_RATE_LIMIT_WINDOW_MS`: Rate limit window in milliseconds (per tenant).
   - `TENANT_RATE_LIMIT_MAX`: Max requests allowed per tenant within the window.
   - `ALLOWED_ORIGINS`: Comma-delimited list of origins permitted via CORS.
4. Start the service:
   ```bash
   npm start
   ```

The service listens on `http://localhost:<PORT>` and logs startup information to the console.

## Authentication Model

All endpoints under `/api` require:

- `X-Internal-Auth`: Must match `PAYMENTS_SHARED_SECRET`.
- `X-Tenant`: Unique tenant identifier. Used for authorization checks and rate limiting.

Requests missing these headers receive appropriate error responses (`401`, `403`, or `400`).

## API Reference

| Method | Path                           | Description                                          |
| ------ | ------------------------------ | ---------------------------------------------------- |
| GET    | `/api/health`                  | Health check and diagnostics.                        |
| GET    | `/api/payouts`                 | Lists payouts. Supports optional `tenantId` filter.  |
| GET    | `/api/payouts/:id`             | Retrieves a single payout by Stripe payout ID.       |
| GET    | `/api/payouts/:id/transactions`| Lists transactions associated with a payout.         |

### Headers

- `X-Internal-Auth`: Shared secret.
- `X-Tenant`: Tenant identifier. Required for cache keying and rate limiting.

### Query Parameters

- `tenantId`: Optional. Filters payouts by metadata (`tenantId` or `tenant`).
- `limit`: Optional (`1-100`, default `100`). Controls page size for Stripe listings.

### Responses

Successful responses return the underlying Stripe objects. Errors follow this shape:

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

