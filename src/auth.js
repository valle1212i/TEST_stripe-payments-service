const { sharedSecret } = require('./config');

const headerNames = {
  auth: 'x-internal-auth',
  tenant: 'x-tenant',
};

const requireInternalHeaders = (req, res, next) => {
  // Skip auth for health check
  if (req.path === '/api/health' || req.path === '/health') {
    return next();
  }

  const providedSecret = req.headers[headerNames.auth];
  const tenantId = req.headers[headerNames.tenant];

  if (!providedSecret) {
    return res.status(401).json({ error: 'Missing X-Internal-Auth header' });
  }

  if (providedSecret !== sharedSecret) {
    return res.status(403).json({ error: 'Invalid internal secret' });
  }

  if (!tenantId) {
    return res.status(400).json({ error: 'Missing X-Tenant header' });
  }

  req.tenantId = tenantId;
  return next();
};

module.exports = {
  headerNames,
  requireInternalHeaders,
};

