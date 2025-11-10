const Stripe = require('stripe');
const { stripeSecretKey } = require('./config');

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2023-10-16',
});

module.exports = stripe;

