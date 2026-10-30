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

const appUrl = optional('APP_URL', '').replace(/\/$/, '');

// COMPANY_EMAIL is optional: fall back to the bare address inside SMTP_FROM
// ("Firma <noreply@domeniu.ro>" -> "noreply@domeniu.ro"; a bare address stays as it is)
const smtpFromRaw = (process.env.SMTP_FROM || '').trim();
const smtpFromEmail = (smtpFromRaw.match(/<([^<>]+)>/)?.[1] || smtpFromRaw).trim();

// The object is intentionally mutable: values coming from the environment are only the
// starting point, the admin panel overrides them at runtime and writes into these very
// objects in place (see modules/settings/settings.service.ts). No Object.freeze / as const.
export const config = {
  isProduction: process.env.NODE_ENV === 'production',
  port: Number(optional('PORT', '3000')),
  // Number of reverse proxies in front of the app (nginx, Cloudflare...). Used to read the real client IP.
  trustProxyHops: Number(optional('TRUST_PROXY_HOPS', '0')),
  appUrl,
  uploadDir: path.resolve(optional('UPLOAD_DIR', './storage')),
  maxConcurrentStreams: Number(optional('MAX_CONCURRENT_STREAMS', '1')),

  // Overlay burned into the player by the client
  watermark: {
    text: optional('WATERMARK_TEXT', 'ivconcept.ro'),
    intervalSeconds: Number(optional('WATERMARK_INTERVAL_SECONDS', '5')),
  },

  // Bunny Stream (videos are stored, transcoded and DRM-protected by Bunny)
  bunny: {
    libraryId: optional('BUNNY_STREAM_LIBRARY_ID', ''),
    apiKey: optional('BUNNY_STREAM_API_KEY', ''),
    tokenKey: optional('BUNNY_STREAM_TOKEN_KEY', ''),
  },
  sessionDurationDays: 30,
  // A playback session without a heartbeat for this long is considered dead
  // (browsers throttle timers in background tabs to ~1/min, so keep this above 60s)
  heartbeatTimeoutMs: 120_000,

  stripe: {
    secretKey: optional('STRIPE_SECRET_KEY', ''),
    webhookSecret: optional('STRIPE_WEBHOOK_SECRET', ''),
    currency: optional('STRIPE_CURRENCY', 'RON').toUpperCase(),
  },

  smtp: {
    host: optional('SMTP_HOST', ''),
    port: smtpPort,
    secure: process.env.SMTP_SECURE === 'true' || smtpPort === 465,
    user: optional('SMTP_USER', ''),
    pass: optional('SMTP_PASS', ''),
    from: optional('SMTP_FROM', ''),
  },

  // Seller details printed on fiscal invoices and on the legal pages (Terms / Privacy / Cookies)
  company: {
    name: optional('COMPANY_NAME', ''),
    cif: optional('COMPANY_CIF', ''),
    address: optional('COMPANY_ADDRESS', ''),
    // Optional: defaults to the address emails are sent from (SMTP_FROM)
    email: optional('COMPANY_EMAIL', smtpFromEmail),
    vatRate: Number(optional('VAT_RATE', '0.21')),
    invoiceSeries: optional('INVOICE_SERIES', 'CNV'),
  },

  // Facturare FGO (facturile fiscale se emit prin API-ul FGO)
  fgo: {
    enabled: optional('FGO_ENABLED', 'false').toLowerCase() === 'true',
    apiUrl: optional('FGO_API_URL', 'https://api.fgo.ro'),
    apiKey: optional('FGO_API_KEY', ''),
    // Codul unic al firmei din FGO, doar cifre (fără prefixul RO)
    codUnic: optional('FGO_COD_UNIC', ''),
    // Adresa platformei, așa cum este înregistrată în FGO (Setări eCommerce -> API)
    platformUrl: optional('FGO_PLATFORM_URL', appUrl),
    series: optional('FGO_SERIES', ''),
    stornoSeries: optional('FGO_STORNO_SERIES', ''),
    // Ultimul număr de factură emis; gol = FGO alocă numărul din registrul lui
    lastNumber: optional('FGO_LAST_NUMBER', ''),
    invoiceType: optional('FGO_INVOICE_TYPE', 'F'),
    paymentType: optional('FGO_PAYMENT_TYPE', 'Banca'),
    um: optional('FGO_UM', 'buc'),
    sendSpv: optional('FGO_SEND_SPV', 'true').toLowerCase() !== 'false',
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
// Stripe keys / webhook secret and the rest of the optional settings are validated when they
// are saved from the admin panel (modules/settings/settings.service.ts), not at startup.
