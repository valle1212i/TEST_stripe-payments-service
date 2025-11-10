const Stripe = require('stripe');
const config = require('./config');

const stripe = new Stripe(config.stripeSecretKey, {
  apiVersion: '2023-10-16',
  timeout: config.stripeTimeoutMs,
  maxNetworkRetries: config.stripeMaxNetworkRetries,
});

module.exports = stripe;

