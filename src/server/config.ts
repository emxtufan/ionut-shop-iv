// ==============================================================================
// IV Concept VOD - Configuration
// The ONLY place that reads environment variables.
// Source: the .env file in the project root (loaded by dotenv) or variables set
// on the server itself. Variables already set on the server take priority over .env.
// See .env.example for the full list.
// ==============================================================================

import 'dotenv/config';
import path from 'path';

const missing: string[] = [];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) missing.push(name);
  return value || '';
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

const smtpPort = Number(optional('SMTP_PORT', '587'));

// COMPANY_EMAIL is optional: fall back to the bare address inside SMTP_FROM
// ("Firma <noreply@domeniu.ro>" -> "noreply@domeniu.ro"; a bare address stays as it is)
const smtpFromRaw = (process.env.SMTP_FROM || '').trim();
const smtpFromEmail = (smtpFromRaw.match(/<([^<>]+)>/)?.[1] || smtpFromRaw).trim();

export const config = {
  isProduction: process.env.NODE_ENV === 'production',
  port: Number(optional('PORT', '3000')),
  // Number of reverse proxies in front of the app (nginx, Cloudflare...). Used to read the real client IP.
  trustProxyHops: Number(optional('TRUST_PROXY_HOPS', '0')),
  appUrl: required('APP_URL').replace(/\/$/, ''),
  uploadDir: path.resolve(optional('UPLOAD_DIR', './storage')),
  maxConcurrentStreams: Number(optional('MAX_CONCURRENT_STREAMS', '1')),

  // Bunny Stream (videos are stored, transcoded and DRM-protected by Bunny)
  bunny: {
    libraryId: required('BUNNY_STREAM_LIBRARY_ID'),
    apiKey: required('BUNNY_STREAM_API_KEY'),
    tokenKey: required('BUNNY_STREAM_TOKEN_KEY'),
  },
  sessionDurationDays: 30,
  // A playback session without a heartbeat for this long is considered dead
  // (browsers throttle timers in background tabs to ~1/min, so keep this above 60s)
  heartbeatTimeoutMs: 120_000,

  stripe: {
    secretKey: required('STRIPE_SECRET_KEY'),
    webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
    currency: optional('STRIPE_CURRENCY', 'RON').toUpperCase(),
  },

  smtp: {
    host: required('SMTP_HOST'),
    port: smtpPort,
    secure: process.env.SMTP_SECURE === 'true' || smtpPort === 465,
    user: required('SMTP_USER'),
    pass: required('SMTP_PASS'),
    from: required('SMTP_FROM'),
  },

  // Seller details printed on fiscal invoices and on the legal pages (Terms / Privacy / Cookies)
  company: {
    name: required('COMPANY_NAME'),
    cif: required('COMPANY_CIF'),
    address: required('COMPANY_ADDRESS'),
    // Optional: defaults to the address emails are sent from (SMTP_FROM)
    email: optional('COMPANY_EMAIL', smtpFromEmail),
    vatRate: Number(optional('VAT_RATE', '0.21')),
    invoiceSeries: optional('INVOICE_SERIES', 'CNV'),
  },

  // Used once, on startup, to create the first SUPER_ADMIN if no admin exists
  admin: {
    email: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
    password: process.env.ADMIN_PASSWORD || '',
  },
};

required('DATABASE_URL'); // read directly by Prisma, checked here so startup fails early

if (missing.length) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}. See .env.example.`);
}
if (!/^sk_(live|test)_/.test(config.stripe.secretKey)) {
  throw new Error('STRIPE_SECRET_KEY must be a Stripe secret key (sk_live_... or sk_test_...).');
}
if (!config.stripe.webhookSecret.startsWith('whsec_')) {
  throw new Error('STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret (whsec_...).');
}
