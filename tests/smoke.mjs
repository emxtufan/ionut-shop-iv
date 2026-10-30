// ==============================================================================
// IV Concept VOD - End-to-end API smoke test
// Node stdlib + @prisma/client + stripe + dotenv only. No test framework.
// ------------------------------------------------------------------------------
// The API server is NEVER started from here; it must already be running:
//   PORT=3999 npm run dev
//   node tests/smoke.mjs                              (BASE_URL=http://localhost:3999)
//   BASE_URL=http://localhost:3000 node tests/smoke.mjs
//
// Everything this script creates is prefixed with `smoke-<rand>` and removed in
// the `finally` block (FK order), together with expiring the Stripe test sessions.
// ==============================================================================

import assert from 'node:assert';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import 'dotenv/config';
import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';

// ------------------------------------------------------------------------------
// Safety guards: this script writes to the database and calls Stripe
// ------------------------------------------------------------------------------
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3999').replace(/\/+$/, '');
const DATABASE_URL = String(process.env.DATABASE_URL || '');
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || '');
const STRIPE_WEBHOOK_SECRET = String(process.env.STRIPE_WEBHOOK_SECRET || '');

if (!DATABASE_URL.includes('test')) {
  console.error('ABORT: DATABASE_URL nu conține "test"; testul refuză să ruleze pe o bază care pare de producție.');
  process.exit(1);
}
if (!STRIPE_SECRET_KEY.startsWith('sk_test_')) {
  console.error('ABORT: STRIPE_SECRET_KEY nu începe cu "sk_test_".');
  process.exit(1);
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.error('ABORT: STRIPE_WEBHOOK_SECRET lipsește; webhook-urile nu pot fi semnate.');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);
const prisma = new PrismaClient();

// ------------------------------------------------------------------------------
// Run identity: every row carries this prefix, every request this client IP
// ------------------------------------------------------------------------------
const RAND = crypto.randomBytes(4).toString('hex');
const PREFIX = `smoke-${RAND}`;
const USER_AGENT = `cinevault-smoke/${PREFIX}`;
// Unique per run so the in-memory rate limiter (bucket per action + IP) starts empty
const CLIENT_IP = `10.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}`;
const SESSION_COOKIE = 'cinevault_session';
// Case L (admin settings + password change) uses its own client IP, so the per-IP rate
// limiter buckets it touches (api_general, auth_attempt) start empty and stay isolated
const SETTINGS_CLIENT_IP = `172.16.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}`;
// Case M (FGO invoicing) talks to its own server process; this IP only reaches that process,
// so the per-IP rate limiter buckets it touches start empty as well
const FGO_CLIENT_IP = `172.20.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}`;

const BUYER_EMAIL = `${PREFIX}-buyer@example.com`;
const BUYER_USERNAME = `${PREFIX}-buyer`;
const BUYER_PASSWORD = 'ParolaSmoke123!';
const NEW_PASSWORD = 'ParolaNoua456!';
const ADMIN_PASSWORD = 'AdminSmoke123!';
const SUPER_PASSWORD = 'SuperSmoke123!';
const OTHER_PASSWORD = 'OtherSmoke123!';

const RESET_TOKEN = `${PREFIX}-reset-token`;
const RESET_TOKEN_EXPIRED = `${PREFIX}-reset-token-expirat`;
const RESET_TOKEN_SHORT = `${PREFIX}-reset-token-scurt`;

const PI_INTENT = `pi_smoke_${RAND}`;
const PI_INTENT_G1 = `pi_smoke_${RAND}_g1`;
const PI_INTENT_G2 = `pi_smoke_${RAND}_g2`;

// The server validates the billing details before the consent, so every checkout call
// that wants a different failure reason still has to send valid billing data.
const CHECKOUT_BILLING = {
  type: 'PF',
  name: `${PREFIX} Cumparator PF`,
  country: 'RO',
  county: 'B',
  city: 'București',
  address: 'Str. Testului nr. 1, sector 1',
};

const state = {
  ids: {},
  tokens: {},
  userIds: [],
  videoIds: [],
  categoryIds: [],
  stripeSessionIds: [],
  emails: [],
  // Setting keys written by case L, removed again through the API in the `finally`
  settingsTouched: [],
  // Handles of the case M harness (mock FGO, mock SMTP, server process), closed in the `finally`
  fgo: null,
};

let failures = 0;
const failedCases = [];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(probe, { timeoutMs = 5000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}

// ------------------------------------------------------------------------------
// Tiny case harness: ✓/✗ per case, keeps running after a failure
// ------------------------------------------------------------------------------
async function runCase(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    failedCases.push(name);
    console.log(`✗ ${name}`);
    console.log(`   → ${err?.message || err}`);
  }
}

// ------------------------------------------------------------------------------
// HTTP helpers
// ------------------------------------------------------------------------------
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function api(method, path, options = {}) {
  const { token, body, rawBody, headers = {} } = options;

  const requestHeaders = {
    'user-agent': USER_AGENT,
    'x-forwarded-for': CLIENT_IP,
  };

  let payload;
  if (rawBody !== undefined) {
    payload = rawBody;
    requestHeaders['content-type'] = 'application/json';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    requestHeaders['content-type'] = 'application/json';
  }
  // Cookie is always sent manually: no cookie jar, no automatic credentials
  if (token) requestHeaders.cookie = `${SESSION_COOKIE}=${token}`;
  Object.assign(requestHeaders, headers);

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: requestHeaders,
    body: payload,
    redirect: 'manual',
  });

  const text = await res.text();
  const setCookie =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);

  return { status: res.status, headers: res.headers, text, json: parseJson(text), setCookie };
}

// Same HTTP helper, but tagged with the case-L client IP (see SETTINGS_CLIENT_IP)
function settingsApi(method, path, options = {}) {
  return api(method, path, {
    ...options,
    headers: { 'x-forwarded-for': SETTINGS_CLIENT_IP, ...(options.headers || {}) },
  });
}

// Saves settings and remembers every key the server accepted, so the `finally` block can
// strip those overrides through the same API (PUT <key>: null) before the DB cleanup
async function putSettings(values, token = state.tokens.super) {
  const response = await settingsApi('PUT', '/api/admin/settings', { token, body: { values } });

  if (response.status === 200) {
    for (const key of Object.keys(values)) {
      if (!state.settingsTouched.includes(key)) state.settingsTouched.push(key);
    }
  }

  return response;
}

function cookieValue(response, name) {
  for (const raw of response.setCookie) {
    if (String(raw).startsWith(`${name}=`)) return String(raw).slice(name.length + 1).split(';')[0];
  }
  return null;
}

function expectStatus(response, expected, label) {
  assert.equal(
    response.status,
    expected,
    `${label}: status ${response.status} (așteptat ${expected}) — body: ${response.text.slice(0, 300)}`
  );
  return response;
}

function eventOf(type, object, suffix) {
  return {
    id: `${PREFIX}-evt-${suffix}`,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
}

function signedWebhook(event) {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_WEBHOOK_SECRET });
  return api('POST', '/api/payments/webhook', { rawBody: payload, headers: { 'stripe-signature': signature } });
}

// The checkout idempotency key is bucketed per minute: never start the two
// concurrent checkout calls right before a minute boundary.
async function avoidMinuteBoundary() {
  const msLeft = 60000 - (Date.now() % 60000);
  if (msLeft < 5000) await sleep(msLeft + 250);
}

// ------------------------------------------------------------------------------
// Password hashing: the application's own hashPassword, with an identical
// local fallback (same `scrypt$salt:hash` format) if the .ts module can't load
// ------------------------------------------------------------------------------
async function loadHashPassword() {
  try {
    const moduleUrl = new URL('../src/server/db/index.ts', import.meta.url).href;
    const mod = await import(moduleUrl);
    if (typeof mod.hashPassword === 'function') return mod.hashPassword;
  } catch (err) {
    console.warn(`! hashPassword din src/server/db/index.ts nu a putut fi importat (${err.message}); folosesc copia locală identică.`);
  }
  return (password) => {
    const salt = crypto.randomBytes(16).toString('hex');
    return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
  };
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Sessions are persisted only as their sha256 digest (same as AuthService): the raw token
// goes to the client as a cookie and is never written to the database.
async function createPrismaSession(userId) {
  const token = `sess_${RAND}_${crypto.randomBytes(12).toString('hex')}`;
  await prisma.session.create({
    data: {
      userId,
      token: sha256(token),
      ip: CLIENT_IP,
      userAgent: USER_AGENT,
      deviceType: 'CLI',
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return token;
}

// ------------------------------------------------------------------------------
// Seed: category + READY video (10), empty category, ADMIN, SUPER_ADMIN, others
// ------------------------------------------------------------------------------
async function seed() {
  await prisma.$connect();
  const hashPassword = await loadHashPassword();

  const admin = await prisma.user.create({
    data: {
      email: `${PREFIX}-admin@example.com`,
      username: `${PREFIX}-admin`,
      passwordHash: hashPassword(ADMIN_PASSWORD),
      role: 'ADMIN',
    },
  });
  const superAdmin = await prisma.user.create({
    data: {
      email: `${PREFIX}-root@example.com`,
      username: `${PREFIX}-root`,
      passwordHash: hashPassword(SUPER_PASSWORD),
      role: 'SUPER_ADMIN',
    },
  });
  const other = await prisma.user.create({
    data: {
      email: `${PREFIX}-other@example.com`,
      username: `${PREFIX}-other`,
      passwordHash: hashPassword(OTHER_PASSWORD),
      role: 'USER',
    },
  });

  state.ids.admin = admin.id;
  state.ids.super = superAdmin.id;
  state.ids.other = other.id;
  state.userIds.push(admin.id, superAdmin.id, other.id);
  state.emails.push(admin.email, superAdmin.email, other.email);

  state.tokens.admin = await createPrismaSession(admin.id);
  state.tokens.super = await createPrismaSession(superAdmin.id);
  state.tokens.other = await createPrismaSession(other.id);

  const catMain = await prisma.category.create({
    data: { name: `${PREFIX} principal`, slug: `${PREFIX}-principal`, description: 'smoke test' },
  });
  const catEmpty = await prisma.category.create({
    data: { name: `${PREFIX} goala`, slug: `${PREFIX}-goala` },
  });
  state.ids.catMain = catMain.id;
  state.ids.catMainName = catMain.name;
  state.ids.catEmpty = catEmpty.id;
  state.categoryIds.push(catMain.id, catEmpty.id);

  // EUR keeps 10 units above Stripe's minimum charge (RON's minimum is far higher)
  const video = await prisma.video.create({
    data: {
      title: `${PREFIX} film principal`,
      slug: `${PREFIX}-film`,
      description: 'Film de test pentru smoke test.',
      categoryId: catMain.id,
      tags: ['smoke', RAND],
      priceAmount: 10,
      currency: 'EUR',
      durationSeconds: 120,
      status: 'READY',
      isPublished: true,
      publishedAt: new Date(),
      bunnyVideoId: `${PREFIX}-bunny-main`,
    },
  });
  const video2 = await prisma.video.create({
    data: {
      title: `${PREFIX} film secundar`,
      slug: `${PREFIX}-film-2`,
      description: 'Al doilea film de test.',
      categoryId: catMain.id,
      tags: ['smoke', RAND],
      priceAmount: 10,
      currency: 'EUR',
      durationSeconds: 60,
      status: 'READY',
      isPublished: true,
      publishedAt: new Date(),
      bunnyVideoId: `${PREFIX}-bunny-2`,
    },
  });
  state.ids.video = video.id;
  state.ids.video2 = video2.id;
  state.videoIds.push(video.id, video2.id);

  // Two PAID purchases for `other`, the entitlement sits on the first one (case G)
  const payment1 = await prisma.payment.create({
    data: {
      checkoutSessionId: `cs_${PREFIX}_g1`,
      paymentIntentId: PI_INTENT_G1,
      userId: other.id,
      videoId: video2.id,
      amount: 10,
      currency: 'EUR',
      status: 'PAID',
    },
  });
  const purchase1 = await prisma.purchase.create({
    data: {
      userId: other.id,
      videoId: video2.id,
      paymentId: payment1.id,
      amount: 10,
      currency: 'EUR',
      status: 'PAID',
      withdrawalWaiverAt: new Date(),
    },
  });
  await sleep(20); // distinct createdAt, so the fallback (orderBy createdAt desc) is deterministic
  const payment2 = await prisma.payment.create({
    data: {
      checkoutSessionId: `cs_${PREFIX}_g2`,
      paymentIntentId: PI_INTENT_G2,
      userId: other.id,
      videoId: video2.id,
      amount: 10,
      currency: 'EUR',
      status: 'PAID',
    },
  });
  const purchase2 = await prisma.purchase.create({
    data: {
      userId: other.id,
      videoId: video2.id,
      paymentId: payment2.id,
      amount: 10,
      currency: 'EUR',
      status: 'PAID',
      withdrawalWaiverAt: new Date(),
    },
  });
  await prisma.entitlement.create({
    data: { userId: other.id, videoId: video2.id, purchaseId: purchase1.id, status: 'ACTIVE' },
  });
  state.ids.purchaseG2 = purchase2.id;

  // The buyer always registers through the public API
  const registration = await api('POST', '/api/auth/register', {
    body: { email: BUYER_EMAIL, username: BUYER_USERNAME, password: BUYER_PASSWORD },
  });
  expectStatus(registration, 201, 'seed: register buyer');
  const buyerId = registration.json?.user?.id;
  assert.ok(buyerId, 'seed: răspunsul de înregistrare nu conține user.id');
  state.ids.buyer = buyerId;
  state.userIds.push(buyerId);
  state.emails.push(BUYER_EMAIL);
  const buyerToken = cookieValue(registration, SESSION_COOKIE);
  assert.ok(buyerToken, 'seed: răspunsul de înregistrare nu setează cookie-ul de sesiune');
  state.tokens.buyer = buyerToken;

  // The session row keeps only the digest: the raw cookie must never be readable from the DB
  const storedSession = await prisma.session.findUnique({ where: { token: sha256(buyerToken) } });
  assert.ok(storedSession, 'seed: sesiunea cumpărătorului nu e stocată ca sha256(cookie)');
  assert.equal(storedSession.userId, buyerId, 'seed: sesiunea găsită prin sha256(cookie) e a altui utilizator');
  const rawSessionRow = await prisma.session.findUnique({ where: { token: buyerToken } });
  assert.equal(rawSessionRow, null, 'seed: cookie-ul brut apare ca token de sesiune în DB');
}

// ------------------------------------------------------------------------------
// Cleanup: FK order first, then the Stripe test sessions
// ------------------------------------------------------------------------------
async function cleanup() {
  console.log('\n— cleanup —');

  for (const sessionId of state.stripeSessionIds) {
    try {
      await stripe.checkout.sessions.expire(sessionId);
    } catch (err) {
      console.warn(`! sesiunea Stripe ${sessionId} nu a putut fi expirată: ${err.message}`);
    }
  }

  const userIds = state.userIds;
  const steps = [
    ['playbackSession', () => prisma.playbackSession.deleteMany({ where: { userId: { in: userIds } } })],
    ['entitlement', () => prisma.entitlement.deleteMany({ where: { userId: { in: userIds } } })],
    ['invoice', () => prisma.invoice.deleteMany({ where: { userId: { in: userIds } } })],
    ['purchase', () => prisma.purchase.deleteMany({ where: { userId: { in: userIds } } })],
    ['payment', () => prisma.payment.deleteMany({ where: { userId: { in: userIds } } })],
    ['session', () => prisma.session.deleteMany({ where: { userId: { in: userIds } } })],
    ['emailLog', () => prisma.emailLog.deleteMany({ where: { to: { in: state.emails } } })],
    [
      'auditLog',
      () =>
        prisma.auditLog.deleteMany({
          where: {
            OR: [{ userId: { in: userIds } }, { adminId: { in: userIds } }, { userAgent: USER_AGENT }, { ip: CLIENT_IP }],
          },
        }),
    ],
    ['user', () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
    ['video', () => prisma.video.deleteMany({ where: { id: { in: state.videoIds } } })],
    ['category', () => prisma.category.deleteMany({ where: { id: { in: state.categoryIds } } })],
  ];

  for (const [name, run] of steps) {
    try {
      const result = await run();
      if (result?.count) console.log(`  șters ${result.count} × ${name}`);
    } catch (err) {
      console.warn(`! cleanup ${name}: ${err.message}`);
    }
  }

  await prisma.$disconnect().catch(() => {});
}

// ------------------------------------------------------------------------------
// Settings written by case L are removed through the API (PUT <key>: null), so the
// running server drops the overrides and falls back to the environment values. This
// has to happen before the database cleanup: deleting the rows by hand would leave
// the test values loaded in the live `config` object of the server.
// ------------------------------------------------------------------------------
async function restoreSettings() {
  if (!state.settingsTouched.length) return;

  console.log('\n— cleanup setări —');

  if (!state.tokens.super) {
    console.warn('! lipsește sesiunea SUPER_ADMIN; setările scrise nu au putut fi scoase prin API');
    return;
  }

  const values = Object.fromEntries(state.settingsTouched.map(key => [key, null]));

  try {
    const response = await putSettings(values);
    if (response.status !== 200) {
      console.warn(`! setările nu au putut fi scoase (status ${response.status}): ${response.text.slice(0, 200)}`);
      return;
    }
    console.log(`  setări readuse la valorile din env: ${state.settingsTouched.join(', ')}`);
  } catch (err) {
    console.warn(`! cleanup setări: ${err.message}`);
  }
}

// ------------------------------------------------------------------------------
// Case M harness: a local FGO API mock, a local SMTP sink and a second server process
// started with its own environment (FGO enabled and pointed at the mock, SMTP pointed at
// the sink). Everything is closed again by `stopFgoHarness()` in the `finally` block.
// ------------------------------------------------------------------------------
const FGO_API_KEY = 'fgo_api_v1.test';
const FGO_COD_UNIC = '12345678';
const FGO_SERIES = 'TST';
const FGO_LAST_NUMBER = '000123';
const FGO_STORNO_SERIES = 'STR';
// What FGO answers when the invoice already exists there
const FGO_DUPLICATE = { serie: 'DUP', numar: '000900' };
const FGO_VALIDATION_MESSAGE = 'Codul unic al clientului nu este valid.';
const FGO_VALID_CUI = '18547290';
// Same CUI with the control digit broken
const FGO_INVALID_CUI = '18547291';
const FGO_BUYER_EMAIL = `${PREFIX}-fgo@example.com`;
const FGO_BUYER_USERNAME = `${PREFIX}-fgo`;
const FGO_BUYER_PASSWORD = 'ParolaFgo123!';
const FGO_BILLING = {
  type: 'PJ',
  name: `${PREFIX} Firma FGO S.R.L.`,
  cui: FGO_VALID_CUI,
  regCom: `J40/${RAND}`,
  country: 'RO',
  county: 'B',
  city: 'București',
  address: 'Str. Testului nr. 1, sector 1',
  phone: '+40712345678',
};

// Sockets are tracked so a hanging client (SMTP keeps the connection a moment) never blocks close
function trackSockets(server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return sockets;
}

function listenOnEphemeralPort(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server, sockets) {
  return new Promise(resolve => {
    if (!server || !server.listening) return resolve();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    for (const socket of sockets || []) socket.destroy();
    server.close(() => resolve());
  });
}

async function freeTcpPort() {
  const probe = net.createServer();
  try {
    return await listenOnEphemeralPort(probe);
  } finally {
    await closeServer(probe);
  }
}

// Mock of the FGO API: answers every route of the invoice flow and records every request
async function startFgoMock() {
  const mock = {
    url: '',
    // Switched per step: 'ok' | 'error500' | 'validation' | 'duplicate'
    mode: 'ok',
    requests: [],
  };

  mock.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }

      const path = String(req.url || '').split('?')[0];
      mock.requests.push({ method: req.method, path, headers: req.headers, body });

      const send = (status, payload, contentType = 'application/json') => {
        res.writeHead(status, { 'content-type': contentType });
        res.end(JSON.stringify(payload));
      };

      // The failures are switched on the emission call only: the rest of the flow keeps answering
      if (req.method === 'POST' && path === '/v2/facturi') {
        if (mock.mode === 'error500') {
          return send(500, { title: 'Eroare internă FGO', detail: 'Eroare internă FGO.' });
        }
        if (mock.mode === 'validation') {
          return send(
            400,
            {
              type: 'about:blank',
              title: 'Cerere invalidă',
              detail: 'Factura nu a trecut validarea.',
              validation_errors: [{ loc: ['body', 'client'], issues: [{ message: FGO_VALIDATION_MESSAGE }] }],
            },
            'application/problem+json'
          );
        }
        if (mock.mode === 'duplicate') {
          return send(
            400,
            {
              type: 'about:blank',
              title: 'Factura există deja',
              detail: 'Factura a fost emisă deja pentru acest id extern.',
              motiv: { cod: 'factura_duplicata', args: FGO_DUPLICATE },
            },
            'application/problem+json'
          );
        }
        return send(200, { data: { serie: body?.serie ?? null, numar: body?.numar ?? null, stocuri: [] }, meta: {} });
      }

      if (req.method === 'GET' && path === '/v2/identitate') {
        return send(200, {
          data: { drepturi: ['facturi:emitere', 'facturi:citire', 'facturi:anulare', 'facturi:incasare', 'facturi:spv'] },
          meta: {},
        });
      }
      if (req.method === 'GET' && /^\/v2\/facturi\/[^/]+\/[^/]+$/.test(path)) {
        return send(200, { data: { valoare_achitata: 0 }, meta: {} });
      }
      if (req.method === 'POST' && path.endsWith('/incasari')) {
        return send(200, { data: { success: true }, meta: {} });
      }
      if (req.method === 'POST' && path.endsWith('/genereaza-link-de-descarcare')) {
        return send(200, { data: { link: `${mock.url}/pdf/x` }, meta: {} });
      }
      if (req.method === 'POST' && path.endsWith('/trimite-in-spv')) {
        return send(200, { data: null, meta: {} });
      }
      if (req.method === 'POST' && path.endsWith('/storneaza')) {
        return send(200, {
          data: { serie: body?.serie_storno || FGO_STORNO_SERIES, numar: body?.numar_storno || '000001' },
          meta: {},
        });
      }
      if (req.method === 'GET' && path === '/pdf/x') {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        return res.end('%PDF-1.4 test');
      }

      return send(404, { title: 'NOT_FOUND' });
    });
  });

  mock.sockets = trackSockets(mock.server);
  const port = await listenOnEphemeralPort(mock.server);
  mock.url = `http://127.0.0.1:${port}`;
  return mock;
}

// Minimal SMTP sink: just enough of the dialogue for nodemailer, and the DATA bodies are kept
async function startSmtpSink() {
  const sink = { port: 0, messages: [], server: null };

  sink.server = net.createServer(socket => {
    let buffer = '';
    let payload = '';
    let inData = false;
    let authStep = null;

    socket.on('error', () => {});
    socket.write('220 smoke-smtp ESMTP ready\r\n');

    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');

      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          payload += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          sink.messages.push(payload);
          payload = '';
          socket.write('250 2.0.0 Ok: queued as smoke\r\n');
          continue;
        }

        const newline = buffer.indexOf('\r\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const command = line.toUpperCase();

        // AUTH LOGIN sends the user and the password as two bare base64 lines
        if (authStep === 'user') {
          authStep = 'pass';
          socket.write('334 UGFzc3dvcmQ6\r\n');
          continue;
        }
        if (authStep === 'pass') {
          authStep = null;
          socket.write('235 2.7.0 Authentication successful\r\n');
          continue;
        }

        if (command.startsWith('EHLO')) {
          socket.write('250-smoke-smtp\r\n250-8BITMIME\r\n250 SIZE 10485760\r\n');
        } else if (command.startsWith('HELO')) {
          socket.write('250 smoke-smtp\r\n');
        } else if (command.startsWith('AUTH LOGIN')) {
          authStep = 'user';
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (command.startsWith('AUTH')) {
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (command === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (command === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
          return;
        } else {
          socket.write('250 2.0.0 Ok\r\n');
        }
      }
    });
  });

  sink.sockets = trackSockets(sink.server);
  sink.port = await listenOnEphemeralPort(sink.server);
  return sink;
}

// Second server process: same sources and database, its own FGO / SMTP environment
async function startFgoServer(harness) {
  const port = await freeTcpPort();
  harness.baseUrl = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      TRUST_PROXY_HOPS: '1',
      APP_URL: harness.baseUrl,
      FGO_ENABLED: 'true',
      FGO_API_URL: harness.mock.url,
      FGO_API_KEY,
      FGO_COD_UNIC,
      FGO_PLATFORM_URL: harness.baseUrl,
      FGO_SERIES,
      FGO_STORNO_SERIES: '',
      FGO_LAST_NUMBER,
      FGO_INVOICE_TYPE: 'F',
      FGO_PAYMENT_TYPE: 'Banca',
      FGO_UM: 'buc',
      FGO_SEND_SPV: 'true',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(harness.smtp.port),
      SMTP_SECURE: 'false',
      SMTP_USER: '',
      SMTP_PASS: '',
      SMTP_FROM: 'Smoke Test <smoke@example.com>',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  harness.child = child;

  const remember = chunk => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      harness.output.push(line.trimEnd());
      if (harness.output.length > 40) harness.output.shift();
    }
  };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  child.on('exit', (code, signal) => {
    harness.exit = { code, signal };
  });

  const ready = await waitFor(
    async () => {
      if (harness.exit) {
        throw new Error(`serverul FGO a ieșit (cod ${harness.exit.code}): ${harness.output.slice(-8).join(' | ')}`);
      }
      try {
        const response = await fetch(`${harness.baseUrl}/api/health`);
        return response.ok ? response.status : null;
      } catch {
        return null;
      }
    },
    { timeoutMs: 90_000, intervalMs: 250 }
  );

  assert.ok(ready, `M: serverul FGO nu a pornit în 90s: ${harness.output.slice(-8).join(' | ')}`);
}

async function startFgoHarness() {
  const harness = {
    mock: null,
    smtp: null,
    child: null,
    baseUrl: null,
    exit: null,
    output: [],
    // The invoice counter row FgoService writes; it is put back exactly as it was in the `finally`
    lastNumberRowBefore: await prisma.setting.findUnique({ where: { key: 'FGO_LAST_NUMBER' } }),
  };
  state.fgo = harness;

  // Every run has to start from the env counter (000123), never from the value a previous run left
  await prisma.setting.deleteMany({ where: { key: 'FGO_LAST_NUMBER' } });

  harness.mock = await startFgoMock();
  harness.smtp = await startSmtpSink();
  await startFgoServer(harness);

  return harness;
}

async function restoreFgoLastNumber(harness) {
  try {
    const row = harness.lastNumberRowBefore;
    if (!row) {
      await prisma.setting.deleteMany({ where: { key: 'FGO_LAST_NUMBER' } });
      return;
    }
    await prisma.setting.upsert({
      where: { key: row.key },
      create: { key: row.key, value: row.value, isSecret: row.isSecret, updatedBy: row.updatedBy },
      update: { value: row.value, isSecret: row.isSecret, updatedBy: row.updatedBy },
    });
  } catch (err) {
    console.warn(`! cleanup FGO_LAST_NUMBER: ${err.message}`);
  }
}

async function stopFgoHarness() {
  const harness = state.fgo;
  if (!harness) return;
  state.fgo = null;

  console.log('\n— cleanup FGO —');

  if (harness.child && !harness.exit) {
    harness.child.kill('SIGTERM');
    const stopped = await waitFor(() => harness.exit, { timeoutMs: 10_000, intervalMs: 100 });
    if (!stopped) harness.child.kill('SIGKILL');
  }

  await closeServer(harness.mock?.server, harness.mock?.sockets);
  await closeServer(harness.smtp?.server, harness.smtp?.sockets);
  await restoreFgoLastNumber(harness);

  console.log('  serverul FGO + mock-urile au fost oprite');
}

// Same HTTP helper as `api`, aimed at the case M server and its own client IP
async function fgoApi(method, path, options = {}) {
  const { token, body, rawBody, headers = {} } = options;

  const requestHeaders = {
    'user-agent': USER_AGENT,
    'x-forwarded-for': FGO_CLIENT_IP,
  };

  let payload;
  if (rawBody !== undefined) {
    payload = rawBody;
    requestHeaders['content-type'] = 'application/json';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    requestHeaders['content-type'] = 'application/json';
  }
  if (token) requestHeaders.cookie = `${SESSION_COOKIE}=${token}`;
  Object.assign(requestHeaders, headers);

  const response = await fetch(`${state.fgo.baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: payload,
    redirect: 'manual',
  });

  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: parseJson(text) };
}

// Same signed Stripe webhook as `signedWebhook`, delivered to the case M server
function signedWebhookTo(event) {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_WEBHOOK_SECRET });
  return fgoApi('POST', '/api/payments/webhook', { rawBody: payload, headers: { 'stripe-signature': signature } });
}

// ==============================================================================
// Cases
// ==============================================================================
try {
  console.log(`▶ smoke test pe ${BASE_URL} (prefix ${PREFIX}, client IP ${CLIENT_IP})\n`);

  await runCase('SETUP) seed Prisma + înregistrare cumpărător prin API', seed);

  await runCase('A) health, 404 JSON, headere, CSP, company, /?page=terms', async () => {
    const health = await api('GET', '/api/health');
    expectStatus(health, 200, 'A health');
    assert.equal(health.json?.status, 'healthy', 'A: /api/health nu raportează status healthy');

    const missing = await api('GET', '/api/nu-exista');
    expectStatus(missing, 404, 'A 404');
    assert.ok(
      String(missing.headers.get('content-type') || '').includes('application/json'),
      'A: 404 fără content-type JSON'
    );
    assert.equal(missing.json?.message, 'NOT_FOUND', 'A: 404 fără body JSON {message:"NOT_FOUND"}');

    assert.equal(health.headers.get('x-powered-by'), null, 'A: răspunsul expune X-Powered-By');

    // Dev mode appends 'unsafe-inline'/'unsafe-eval' for Vite HMR; production is exactly "script-src 'self'"
    const csp = String(health.headers.get('content-security-policy') || '');
    assert.ok(csp.includes("script-src 'self'"), `A: CSP nu conține "script-src 'self'" (${csp})`);

    const company = await api('GET', '/api/public/company');
    expectStatus(company, 200, 'A company');
    assert.ok(company.json?.name, 'A: /api/public/company fără name');
    assert.ok(company.json?.cif, 'A: /api/public/company fără cif');

    const terms = await api('GET', '/?page=terms');
    expectStatus(terms, 200, 'A /?page=terms');
  });

  await runCase('B) register: username periculos → 400, email invalid → 400', async () => {
    const badUsername = await api('POST', '/api/auth/register', {
      body: { email: `${PREFIX}-x@example.com`, username: '<img src=x>', password: 'ParolaSmoke123!' },
    });
    expectStatus(badUsername, 400, 'B username <img src=x>');
    assert.equal(badUsername.json?.error, 'USERNAME_INVALID', 'B: motiv greșit pentru username invalid');

    const badEmail = await api('POST', '/api/auth/register', {
      body: { email: 'nu-e-un-email', username: `${PREFIX}-bad`, password: 'ParolaSmoke123!' },
    });
    expectStatus(badEmail, 400, 'B email invalid');
    assert.equal(badEmail.json?.error, 'EMAIL_INVALID', 'B: motiv greșit pentru email invalid');
  });

  await runCase('C) checkout: termeni, 2×POST simultan, Payment unic, reutilizare', async () => {
    const videoId = state.ids.video;
    assert.ok(videoId, 'C: lipsește videoclipul din seed');

    const noTerms = await api('POST', `/api/payments/checkout/${videoId}`, {
      token: state.tokens.buyer,
      body: { billing: CHECKOUT_BILLING },
    });
    expectStatus(noTerms, 400, 'C checkout fără acceptedTerms');
    assert.equal(noTerms.json?.error, 'TERMS_NOT_ACCEPTED', 'C: motiv greșit pentru lipsa termenilor');

    await avoidMinuteBoundary();

    const [first, second] = await Promise.all([
      api('POST', `/api/payments/checkout/${videoId}`, {
        token: state.tokens.buyer,
        body: { acceptedTerms: true, billing: CHECKOUT_BILLING },
      }),
      api('POST', `/api/payments/checkout/${videoId}`, {
        token: state.tokens.buyer,
        body: { acceptedTerms: true, billing: CHECKOUT_BILLING },
      }),
    ]);
    expectStatus(first, 200, 'C checkout #1');
    expectStatus(second, 200, 'C checkout #2');
    assert.ok(String(first.json?.checkoutUrl || '').startsWith('https://'), 'C: checkoutUrl invalid');
    assert.equal(second.json?.checkoutUrl, first.json?.checkoutUrl, 'C: cele două POST-uri simultane nu au aceeași url');

    const payments = await prisma.payment.findMany({ where: { userId: state.ids.buyer, videoId } });
    assert.equal(payments.length, 1, `C: ${payments.length} rânduri Payment pentru user+video (așteptat 1)`);
    assert.equal(payments[0].status, 'PENDING', 'C: Payment-ul creat nu e PENDING');

    state.ids.payment = payments[0].id;
    state.ids.checkoutSession = payments[0].checkoutSessionId;
    state.stripeSessionIds.push(payments[0].checkoutSessionId);

    const third = await api('POST', `/api/payments/checkout/${videoId}`, {
      token: state.tokens.buyer,
      body: { acceptedTerms: true, billing: CHECKOUT_BILLING },
    });
    expectStatus(third, 200, 'C checkout #3');
    assert.equal(third.json?.checkoutUrl, first.json?.checkoutUrl, 'C: al treilea POST a creat altă sesiune');
    assert.equal(
      await prisma.payment.count({ where: { userId: state.ids.buyer, videoId } }),
      1,
      'C: al treilea POST a creat încă un Payment'
    );
  });

  await runCase('D) webhook: semnătură, fulfillment, idempotență, ALREADY_PURCHASED', async () => {
    const badSignature = await api('POST', '/api/payments/webhook', {
      rawBody: JSON.stringify({ id: `${PREFIX}-evt-bad`, object: 'event', type: 'checkout.session.completed' }),
      headers: { 'stripe-signature': 't=1,v1=deadbeef' },
    });
    expectStatus(badSignature, 400, 'D webhook semnătură greșită');

    const checkoutSessionId = state.ids.checkoutSession;
    assert.ok(checkoutSessionId, 'D: lipsește sesiunea de checkout din cazul C');

    const sessionObject = {
      id: checkoutSessionId,
      object: 'checkout.session',
      mode: 'payment',
      payment_status: 'paid',
      payment_intent: PI_INTENT,
      invoice: null,
      amount_total: 1000,
      currency: 'eur',
      created: Math.floor(Date.now() / 1000),
      metadata: { userId: state.ids.buyer, videoId: state.ids.video },
    };

    const completed = await signedWebhook(eventOf('checkout.session.completed', sessionObject, 'completed-1'));
    expectStatus(completed, 200, 'D webhook completed');
    assert.equal(completed.json?.status, 'SUCCESS', `D: webhook-ul a răspuns ${completed.json?.status}`);

    const entitlement = await prisma.entitlement.findUnique({
      where: { userId_videoId: { userId: state.ids.buyer, videoId: state.ids.video } },
    });
    assert.equal(entitlement?.status, 'ACTIVE', 'D: entitlement nu e ACTIVE după plată');

    const purchase = await prisma.purchase.findFirst({ where: { userId: state.ids.buyer, videoId: state.ids.video } });
    assert.ok(purchase, 'D: nu s-a creat Purchase');
    assert.equal(purchase.status, 'PAID', 'D: Purchase nu e PAID');
    assert.ok(purchase.withdrawalWaiverAt, 'D: withdrawalWaiverAt nu e setat pe Purchase');

    const invoice = await prisma.invoice.findFirst({ where: { purchaseId: purchase.id } });
    assert.ok(invoice, 'D: nu s-a creat Invoice');
    state.ids.invoice = invoice.id;
    state.ids.purchase = purchase.id;
    state.ids.paymentIntent = PI_INTENT;

    // SMTP is off in tests: fulfillment must succeed anyway, the email is only logged
    const emailLog = await waitFor(() =>
      prisma.emailLog.findFirst({ where: { to: BUYER_EMAIL, type: 'PURCHASE_CONFIRMATION' }, orderBy: { sentAt: 'desc' } })
    );
    assert.ok(emailLog, 'D: lipsește EmailLog-ul de confirmare a plății');
    assert.ok(['SENT', 'FAILED'].includes(emailLog.status), `D: EmailLog are status necunoscut (${emailLog.status})`);

    const replay = await signedWebhook(eventOf('checkout.session.completed', sessionObject, 'completed-1'));
    expectStatus(replay, 200, 'D webhook reluat');
    assert.equal(replay.json?.status, 'ALREADY_FULFILLED', `D: reluarea a produs ${replay.json?.status}`);
    assert.equal(
      await prisma.purchase.count({ where: { userId: state.ids.buyer, videoId: state.ids.video } }),
      1,
      'D: evenimentul reluat a dublat Purchase'
    );
    assert.equal(
      await prisma.invoice.count({ where: { purchaseId: purchase.id } }),
      1,
      'D: evenimentul reluat a dublat Invoice'
    );

    const reCheckout = await api('POST', `/api/payments/checkout/${state.ids.video}`, {
      token: state.tokens.buyer,
      body: { acceptedTerms: true, billing: CHECKOUT_BILLING },
    });
    expectStatus(reCheckout, 400, 'D re-checkout');
    assert.equal(reCheckout.json?.error, 'ALREADY_PURCHASED', 'D: re-checkout nu a fost refuzat cu ALREADY_PURCHASED');
  });

  await runCase('E) factură print: escapare HTML + acces interzis altui user', async () => {
    assert.ok(state.ids.invoice, 'E: lipsește factura creată în cazul D');
    await prisma.invoice.update({
      where: { id: state.ids.invoice },
      data: { buyerName: '<img src=x onerror=1>' },
    });

    const print = await api('GET', `/api/account/invoices/${state.ids.invoice}/print`, { token: state.tokens.admin });
    expectStatus(print, 200, 'E print ca admin');
    assert.ok(print.text.includes('&lt;img'), 'E: HTML-ul facturii nu conține &lt;img');
    assert.ok(!print.text.includes('<img src=x'), 'E: HTML-ul facturii conține marcaj nedetectat/neescapat');

    const forbidden = await api('GET', `/api/account/invoices/${state.ids.invoice}/print`, { token: state.tokens.other });
    expectStatus(forbidden, 403, 'E print ca alt utilizator');
  });

  await runCase('F) playback: watermark, embedUrl, heartbeat activ', async () => {
    const tokenResponse = await api('POST', `/api/playback/${state.ids.video}/token`, { token: state.tokens.buyer });
    expectStatus(tokenResponse, 200, 'F playback token');
    assert.equal(tokenResponse.json?.watermark?.text, 'ivconcept.ro', 'F: watermark.text greșit');
    assert.equal(tokenResponse.json?.watermark?.refreshIntervalSeconds, 5, 'F: refreshIntervalSeconds greșit');
    assert.ok(
      String(tokenResponse.json?.embedUrl || '').includes('showSpeed=true'),
      'F: embedUrl nu conține showSpeed=true'
    );
    const jti = tokenResponse.json?.jti;
    assert.ok(jti, 'F: răspunsul nu conține jti');
    state.ids.jtiVideo = jti;

    const heartbeat = await api('POST', `/api/playback/${state.ids.video}/heartbeat`, {
      token: state.tokens.buyer,
      body: { jti },
    });
    expectStatus(heartbeat, 200, 'F heartbeat');
    assert.equal(heartbeat.json?.active, true, 'F: heartbeat nu raportează active:true');
  });

  await runCase('G) refund: entitlement REVOKED, heartbeat oprit, fallback pe a doua achiziție', async () => {
    const refund = await signedWebhook(
      eventOf(
        'charge.refunded',
        {
          id: `${PREFIX}-charge-1`,
          object: 'charge',
          refunded: true,
          amount: 1000,
          currency: 'eur',
          payment_intent: state.ids.paymentIntent,
        },
        'refund-1'
      )
    );
    expectStatus(refund, 200, 'G webhook charge.refunded');
    assert.equal(refund.json?.status, 'REVOKED', `G: webhook-ul a răspuns ${refund.json?.status}`);

    const entitlement = await prisma.entitlement.findUnique({
      where: { userId_videoId: { userId: state.ids.buyer, videoId: state.ids.video } },
    });
    assert.equal(entitlement?.status, 'REVOKED', 'G: entitlement nu e REVOKED după refund');
    assert.ok(entitlement?.revokedAt, 'G: revokedAt nu e setat');

    const heartbeat = await api('POST', `/api/playback/${state.ids.video}/heartbeat`, {
      token: state.tokens.buyer,
      body: { jti: state.ids.jtiVideo },
    });
    expectStatus(heartbeat, 200, 'G heartbeat');
    assert.equal(heartbeat.json?.active, false, 'G: heartbeat încă activ după refund');

    const payment = await prisma.payment.findUnique({ where: { paymentIntentId: state.ids.paymentIntent } });
    assert.equal(payment?.status, 'REFUNDED', 'G: Payment nu e REFUNDED');

    // Second scenario: two PAID purchases, the entitlement rides on the refunded one
    const refundSecond = await signedWebhook(
      eventOf(
        'charge.refunded',
        {
          id: `${PREFIX}-charge-2`,
          object: 'charge',
          refunded: true,
          payment_intent: PI_INTENT_G1,
        },
        'refund-2'
      )
    );
    expectStatus(refundSecond, 200, 'G webhook charge.refunded #2');

    const fallback = await prisma.entitlement.findUnique({
      where: { userId_videoId: { userId: state.ids.other, videoId: state.ids.video2 } },
    });
    assert.equal(fallback?.status, 'ACTIVE', 'G: entitlement nu a rămas ACTIVE pe cealaltă achiziție');
    assert.equal(fallback?.purchaseId, state.ids.purchaseG2, 'G: entitlement nu a fost mutat pe a doua achiziție PAID');
  });

  await runCase('H) admin: RBAC, listă fără hash-uri, PATCH, grant/revoke, suspendare, logout-all', async () => {
    const buyerId = state.ids.buyer;
    assert.ok(buyerId, 'H: lipsește cumpărătorul din seed');

    const forbidden = await api('GET', '/api/admin/users', { token: state.tokens.buyer });
    expectStatus(forbidden, 403, 'H user normal pe /api/admin/users');

    const unauthenticated = await api('GET', '/api/admin/users');
    expectStatus(unauthenticated, 401, 'H /api/admin/users fără cookie');

    const list = await api('GET', '/api/admin/users', { token: state.tokens.admin });
    expectStatus(list, 200, 'H listă ca ADMIN');
    assert.ok(Array.isArray(list.json?.items), 'H: răspunsul nu conține items[]');
    assert.ok(!list.text.includes('passwordHash'), 'H: lista conține passwordHash');
    assert.ok(!list.text.includes('passwordResetTokenHash'), 'H: lista conține passwordResetTokenHash');

    const selfPatch = await api('PATCH', `/api/admin/users/${state.ids.admin}`, {
      token: state.tokens.admin,
      body: { isSuspended: true },
    });
    expectStatus(selfPatch, 400, 'H ADMIN PATCH pe sine');

    const superPatch = await api('PATCH', `/api/admin/users/${state.ids.super}`, {
      token: state.tokens.admin,
      body: { isSuspended: true },
    });
    expectStatus(superPatch, 403, 'H ADMIN PATCH pe SUPER_ADMIN');

    const roleByAdmin = await api('PATCH', `/api/admin/users/${buyerId}`, {
      token: state.tokens.admin,
      body: { role: 'ADMIN' },
    });
    expectStatus(roleByAdmin, 403, 'H ADMIN schimbă rol');

    const roleBySuper = await api('PATCH', `/api/admin/users/${buyerId}`, {
      token: state.tokens.super,
      body: { role: 'ADMIN' },
    });
    expectStatus(roleBySuper, 200, 'H SUPER_ADMIN schimbă rol');
    assert.equal(roleBySuper.json?.user?.role, 'ADMIN', 'H: rolul nu a devenit ADMIN');

    const roleSuperAdmin = await api('PATCH', `/api/admin/users/${buyerId}`, {
      token: state.tokens.super,
      body: { role: 'SUPER_ADMIN' },
    });
    expectStatus(roleSuperAdmin, 400, 'H SUPER_ADMIN ca rol țintă');

    const roleRevert = await api('PATCH', `/api/admin/users/${buyerId}`, {
      token: state.tokens.super,
      body: { role: 'USER' },
    });
    expectStatus(roleRevert, 200, 'H revenire la rolul USER');

    const grant = await api('POST', `/api/admin/users/${buyerId}/entitlements`, {
      token: state.tokens.admin,
      body: { videoId: state.ids.video2 },
    });
    expectStatus(grant, 200, 'H grant manual');

    const libraryAfterGrant = await api('GET', '/api/library', { token: state.tokens.buyer });
    expectStatus(libraryAfterGrant, 200, 'H library după grant');
    assert.ok(
      (libraryAfterGrant.json?.library || []).some(v => v.id === state.ids.video2),
      'H: /api/library nu conține videoclipul acordat manual'
    );

    const grantToken = await api('POST', `/api/playback/${state.ids.video2}/token`, { token: state.tokens.buyer });
    expectStatus(grantToken, 200, 'H playback token după grant');
    assert.ok(grantToken.json?.embedUrl, 'H: playback token fără embedUrl');

    const revoke = await api('DELETE', `/api/admin/users/${buyerId}/entitlements/${state.ids.video2}`, {
      token: state.tokens.admin,
    });
    expectStatus(revoke, 200, 'H revoke manual');

    const libraryAfterRevoke = await api('GET', '/api/library', { token: state.tokens.buyer });
    expectStatus(libraryAfterRevoke, 200, 'H library după revoke');
    assert.ok(
      !(libraryAfterRevoke.json?.library || []).some(v => v.id === state.ids.video2),
      'H: /api/library conține încă videoclipul revocat'
    );

    const suspend = await api('PATCH', `/api/admin/users/${buyerId}`, {
      token: state.tokens.admin,
      body: { isSuspended: true },
    });
    expectStatus(suspend, 200, 'H suspendare');

    const oldSession = await api('GET', '/api/auth/me', { token: state.tokens.buyer });
    expectStatus(oldSession, 401, 'H sesiunea veche după suspendare');

    const loginSuspended = await api('POST', '/api/auth/login', {
      body: { identifier: BUYER_EMAIL, password: BUYER_PASSWORD },
    });
    expectStatus(loginSuspended, 401, 'H login refuzat cât timp contul e suspendat');

    const reactivate = await api('PATCH', `/api/admin/users/${buyerId}`, {
      token: state.tokens.admin,
      body: { isSuspended: false },
    });
    expectStatus(reactivate, 200, 'H reactivare');

    const loginBack = await api('POST', '/api/auth/login', {
      body: { identifier: BUYER_EMAIL, password: BUYER_PASSWORD },
    });
    expectStatus(loginBack, 200, 'H login după reactivare');
    const reactivatedToken = cookieValue(loginBack, SESSION_COOKIE);
    assert.ok(reactivatedToken, 'H: login reușit fără cookie de sesiune');
    state.tokens.buyer = reactivatedToken;

    const logoutAll = await api('POST', `/api/admin/users/${buyerId}/logout-all`, { token: state.tokens.admin });
    expectStatus(logoutAll, 200, 'H logout-all');

    const afterLogoutAll = await api('GET', '/api/auth/me', { token: reactivatedToken });
    expectStatus(afterLogoutAll, 401, 'H sesiunea după logout-all');
    state.tokens.buyer = null;
  });

  await runCase('I) categorii: DELETE plină → 409, PATCH nume, duplicat → 409, DELETE goală', async () => {
    const notEmpty = await api('DELETE', `/api/admin/categories/${state.ids.catMain}`, { token: state.tokens.admin });
    expectStatus(notEmpty, 409, 'I DELETE categorie cu filme');

    const renamed = `${PREFIX} goala redenumita`;
    const rename = await api('PATCH', `/api/admin/categories/${state.ids.catEmpty}`, {
      token: state.tokens.admin,
      body: { name: renamed },
    });
    expectStatus(rename, 200, 'I PATCH nume categorie');
    assert.equal(rename.json?.category?.name, renamed, 'I: numele categoriei nu s-a schimbat');

    const duplicate = await api('PATCH', `/api/admin/categories/${state.ids.catEmpty}`, {
      token: state.tokens.admin,
      body: { name: state.ids.catMainName },
    });
    expectStatus(duplicate, 409, 'I PATCH nume duplicat');

    const deleted = await api('DELETE', `/api/admin/categories/${state.ids.catEmpty}`, { token: state.tokens.admin });
    expectStatus(deleted, 200, 'I DELETE categorie goală');
  });

  await runCase('J) resetare parolă: anti-enumerare, EmailLog, token, expirare, parolă scurtă', async () => {
    const buyerId = state.ids.buyer;
    const unknownEmail = `${PREFIX}-nimeni@example.com`;

    const forgotUnknown = await api('POST', '/api/auth/forgot-password', { body: { email: unknownEmail } });
    expectStatus(forgotUnknown, 200, 'J forgot email inexistent');
    const forgotKnown = await api('POST', '/api/auth/forgot-password', { body: { email: BUYER_EMAIL } });
    expectStatus(forgotKnown, 200, 'J forgot email existent');
    assert.equal(forgotKnown.status, forgotUnknown.status, 'J: status diferit între email existent și inexistent');
    assert.equal(forgotKnown.text, forgotUnknown.text, 'J: body diferit între email existent și inexistent');

    const withToken = await waitFor(async () => {
      const user = await prisma.user.findUnique({ where: { id: buyerId } });
      return user?.passwordResetTokenHash && user?.passwordResetExpiresAt ? user : null;
    });
    assert.ok(withToken, 'J: DB nu are passwordResetTokenHash + passwordResetExpiresAt după forgot-password');
    assert.ok(withToken.passwordResetExpiresAt.getTime() > Date.now(), 'J: expirarea tokenului nu e în viitor');

    const resetEmail = await waitFor(() =>
      prisma.emailLog.findFirst({ where: { to: BUYER_EMAIL, type: 'PASSWORD_RESET' }, orderBy: { sentAt: 'desc' } })
    );
    assert.ok(resetEmail, 'J: lipsește EmailLog-ul PASSWORD_RESET (poll 5s)');
    assert.equal(
      resetEmail.html,
      '[conținut omis: link de resetare]',
      'J: EmailLog-ul de resetare nu are conținutul omis'
    );

    // Known token, set through Prisma exactly as the service stores it
    await prisma.user.update({
      where: { id: buyerId },
      data: { passwordResetTokenHash: sha256(RESET_TOKEN), passwordResetExpiresAt: new Date(Date.now() + 3600_000) },
    });
    const oldSessionToken = await createPrismaSession(buyerId);

    const reset = await api('POST', '/api/auth/reset-password', {
      body: { token: RESET_TOKEN, password: NEW_PASSWORD },
    });
    expectStatus(reset, 200, 'J reset cu token cunoscut');

    const oldSession = await api('GET', '/api/auth/me', { token: oldSessionToken });
    expectStatus(oldSession, 401, 'J sesiunea veche după reset');

    const loginNewPassword = await api('POST', '/api/auth/login', {
      body: { identifier: BUYER_EMAIL, password: NEW_PASSWORD },
    });
    expectStatus(loginNewPassword, 200, 'J login cu noua parolă');
    const newToken = cookieValue(loginNewPassword, SESSION_COOKIE);
    assert.ok(newToken, 'J: login fără cookie de sesiune');
    state.tokens.buyer = newToken;

    const reuse = await api('POST', '/api/auth/reset-password', {
      body: { token: RESET_TOKEN, password: 'AltaParola789!' },
    });
    expectStatus(reuse, 400, 'J refolosire token');

    await prisma.user.update({
      where: { id: buyerId },
      data: {
        passwordResetTokenHash: sha256(RESET_TOKEN_EXPIRED),
        passwordResetExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    const expired = await api('POST', '/api/auth/reset-password', {
      body: { token: RESET_TOKEN_EXPIRED, password: 'AltaParola789!' },
    });
    expectStatus(expired, 400, 'J token expirat');

    await prisma.user.update({
      where: { id: buyerId },
      data: { passwordResetTokenHash: sha256(RESET_TOKEN_SHORT), passwordResetExpiresAt: new Date(Date.now() + 3600_000) },
    });
    const shortPassword = await api('POST', '/api/auth/reset-password', {
      body: { token: RESET_TOKEN_SHORT, password: 'Scurta1' },
    });
    expectStatus(shortPassword, 400, 'J parolă de 7 caractere');
    assert.equal(shortPassword.json?.error, 'PASSWORD_TOO_SHORT', 'J: motiv greșit pentru parola prea scurtă');
  });

  await runCase('K) GDPR: export fără secrete, ștergere cont', async () => {
    const buyerId = state.ids.buyer;
    const buyerToken = state.tokens.buyer;
    assert.ok(buyerToken, 'K: lipsește sesiunea cumpărătorului (cazul J)');

    const exportResponse = await api('GET', '/api/account/export', { token: buyerToken });
    expectStatus(exportResponse, 200, 'K export');
    assert.ok(
      String(exportResponse.headers.get('content-disposition') || '').includes('attachment'),
      'K: exportul nu are Content-Disposition attachment'
    );
    for (const secret of ['passwordHash', 'passwordResetTokenHash', '"html"', buyerToken]) {
      assert.ok(!exportResponse.text.includes(secret), `K: exportul conține date interzise (${secret})`);
    }

    const wrongPassword = await api('DELETE', '/api/account', {
      token: buyerToken,
      body: { password: 'ParolaGresita123!' },
    });
    expectStatus(wrongPassword, 400, 'K DELETE cu parolă greșită');

    const adminAttempt = await api('DELETE', '/api/account', {
      token: state.tokens.admin,
      body: { password: ADMIN_PASSWORD },
    });
    expectStatus(adminAttempt, 403, 'K DELETE ca admin');

    const deleted = await api('DELETE', '/api/account', { token: buyerToken, body: { password: NEW_PASSWORD } });
    expectStatus(deleted, 200, 'K DELETE cu parolă corectă');

    const afterDelete = await api('GET', '/api/auth/me', { token: buyerToken });
    expectStatus(afterDelete, 401, 'K sesiunea după ștergere');

    const loginAfterDelete = await api('POST', '/api/auth/login', {
      body: { identifier: BUYER_EMAIL, password: NEW_PASSWORD },
    });
    expectStatus(loginAfterDelete, 401, 'K login după ștergere');

    const user = await prisma.user.findUnique({ where: { id: buyerId } });
    assert.ok(user?.email.endsWith('@deleted.invalid'), `K: emailul nu s-a anonimizat (${user?.email})`);

    const invoice = await prisma.invoice.findUnique({ where: { id: state.ids.invoice } });
    assert.equal(invoice?.buyerEmail, BUYER_EMAIL, 'K: Invoice.buyerEmail a fost modificat');

    const purchase = await prisma.purchase.findFirst({ where: { userId: buyerId, videoId: state.ids.video } });
    assert.ok(purchase, 'K: Purchase nu mai există după ștergerea contului');

    const entitlement = await prisma.entitlement.findUnique({
      where: { userId_videoId: { userId: buyerId, videoId: state.ids.video } },
    });
    assert.equal(entitlement?.status, 'REVOKED', 'K: entitlement nu e REVOKED după ștergerea contului');
  });

  // Case L runs on its own client IP (SETTINGS_CLIENT_IP) and every setting it writes is
  // removed again with `PUT <key>: null` (see `state.settingsTouched` and restoreSettings).
  await runCase('L) setări: RBAC, secrete mascate, validare, aplicare imediată, change-password', async () => {
    const caseStart = new Date();
    const superToken = state.tokens.super;
    assert.ok(superToken, 'L: lipsește sesiunea SUPER_ADMIN din seed');

    const unknownKey = 'SMOKE_SETTING_NECUNOSCUT';
    const smtpSecret = `smoke-secret-${RAND}-9999`;

    // --- RBAC ---------------------------------------------------------------
    const noCookie = await settingsApi('GET', '/api/admin/settings');
    expectStatus(noCookie, 401, 'L GET setări fără cookie');

    const asUser = await settingsApi('GET', '/api/admin/settings', { token: state.tokens.other });
    expectStatus(asUser, 403, 'L GET setări ca utilizator normal');

    const asAdminGet = await settingsApi('GET', '/api/admin/settings', { token: state.tokens.admin });
    expectStatus(asAdminGet, 403, 'L GET setări ca ADMIN');

    const asAdminPut = await putSettings({ COMPANY_NAME: `${PREFIX} interzis` }, state.tokens.admin);
    expectStatus(asAdminPut, 403, 'L PUT setări ca ADMIN');

    const asAdminStripeTest = await settingsApi('POST', '/api/admin/settings/test/stripe', {
      token: state.tokens.admin,
    });
    expectStatus(asAdminStripeTest, 403, 'L POST test/stripe ca ADMIN');

    const settingsResponse = await settingsApi('GET', '/api/admin/settings', { token: superToken });
    expectStatus(settingsResponse, 200, 'L GET setări ca SUPER_ADMIN');
    assert.ok(Array.isArray(settingsResponse.json?.settings), 'L: răspunsul nu conține settings[]');

    // The real secret values (env or saved) must never travel back to the browser
    const envSecrets = {
      STRIPE_SECRET_KEY: String(process.env.STRIPE_SECRET_KEY || ''),
      SMTP_PASS: String(process.env.SMTP_PASS || ''),
      BUNNY_STREAM_API_KEY: String(process.env.BUNNY_STREAM_API_KEY || ''),
      DATABASE_URL: String(process.env.DATABASE_URL || ''),
    };
    const presentSecrets = Object.entries(envSecrets).filter(([, value]) => value.length >= 6);
    for (const [name, value] of presentSecrets) {
      assert.ok(!settingsResponse.text.includes(value), `L: GET setări conține valoarea din env a ${name}`);
    }
    for (const name of Object.keys(envSecrets)) {
      if (!presentSecrets.some(([present]) => present === name)) {
        console.log(`   (${name} lipsește din env sau e prea scurt; verificarea lui e sărită)`);
      }
    }

    // --- Validation: nothing is written when any value is rejected -----------
    const badStripeKey = await putSettings({ STRIPE_SECRET_KEY: 'abc' });
    expectStatus(badStripeKey, 400, 'L PUT STRIPE_SECRET_KEY "abc"');
    assert.equal(badStripeKey.json?.key, 'STRIPE_SECRET_KEY', 'L: răspunsul 400 nu indică cheia STRIPE_SECRET_KEY');

    const badVat = await putSettings({ VAT_RATE: '2' });
    expectStatus(badVat, 400, 'L PUT VAT_RATE "2"');

    const unknown = await putSettings({ [unknownKey]: 'x' });
    expectStatus(unknown, 400, 'L PUT cheie necunoscută');
    assert.equal(unknown.json?.key, unknownKey, 'L: răspunsul 400 nu indică cheia necunoscută');

    const companyBefore = await settingsApi('GET', '/api/public/company');
    expectStatus(companyBefore, 200, 'L GET company înainte de modificări');
    const companyNameBefore = companyBefore.json?.name;

    const partiallyInvalid = await putSettings({ COMPANY_NAME: 'x', VAT_RATE: '2' });
    expectStatus(partiallyInvalid, 400, 'L PUT COMPANY_NAME + VAT_RATE invalid');

    const companyAfterPartial = await settingsApi('GET', '/api/public/company');
    expectStatus(companyAfterPartial, 200, 'L GET company după PUT respins');
    assert.equal(
      companyAfterPartial.json?.name,
      companyNameBefore,
      'L: COMPANY_NAME s-a schimbat deși PUT-ul a fost respins cu 400'
    );

    // --- COMPANY_NAME: applied immediately, restored by null -----------------
    const setCompany = await putSettings({ COMPANY_NAME: PREFIX });
    expectStatus(setCompany, 200, 'L PUT COMPANY_NAME');

    const companyLive = await settingsApi('GET', '/api/public/company');
    expectStatus(companyLive, 200, 'L GET company după PUT COMPANY_NAME');
    assert.equal(companyLive.json?.name, PREFIX, 'L: /api/public/company nu arată imediat numele salvat');

    const clearCompany = await putSettings({ COMPANY_NAME: null });
    expectStatus(clearCompany, 200, 'L PUT COMPANY_NAME null');

    const companyRestored = await settingsApi('GET', '/api/public/company');
    expectStatus(companyRestored, 200, 'L GET company după null');
    assert.equal(
      companyRestored.json?.name,
      companyNameBefore,
      'L: COMPANY_NAME nu a revenit la valoarea inițială după null'
    );

    // --- SMTP_PASS: encrypted at rest, masked everywhere --------------------
    const settingsBefore = (settingsResponse.json?.settings || []).find(view => view.key === 'SMTP_PASS') || {};
    const smtpSourceBefore = settingsBefore.source;

    const setSmtp = await putSettings({ SMTP_PASS: smtpSecret });
    expectStatus(setSmtp, 200, 'L PUT SMTP_PASS');

    const smtpRow = await prisma.setting.findUnique({ where: { key: 'SMTP_PASS' } });
    assert.ok(smtpRow, 'L: lipsește rândul Setting pentru SMTP_PASS după salvare');
    assert.equal(smtpRow.isSecret, true, 'L: rândul Setting SMTP_PASS nu are isSecret true');
    assert.ok(!smtpRow.value.includes(smtpSecret), 'L: rândul Setting păstrează secretul în clar');

    const settingsAfterSecret = await settingsApi('GET', '/api/admin/settings', { token: superToken });
    expectStatus(settingsAfterSecret, 200, 'L GET setări după PUT SMTP_PASS');
    assert.ok(!settingsAfterSecret.text.includes(smtpSecret), 'L: GET setări întoarce secretul SMTP_PASS');

    const smtpView = (settingsAfterSecret.json?.settings || []).find(view => view.key === 'SMTP_PASS') || {};
    assert.equal(smtpView.source, 'admin', `L: SMTP_PASS nu are source "admin" (${smtpView.source})`);
    assert.equal(smtpView.value, null, 'L: GET setări întoarce valoarea secretă a SMTP_PASS');
    assert.ok(
      String(smtpView.preview || '').endsWith('9999'),
      `L: preview-ul SMTP_PASS nu se termină în 9999 (${smtpView.preview})`
    );

    // The audit trail records the key names only, never the values
    const auditEntry = await waitFor(async () => {
      const rows = await prisma.auditLog.findMany({
        where: { eventType: 'ADMIN_UPDATED_SETTINGS', createdAt: { gte: caseStart } },
      });
      return rows.find(row => JSON.stringify(row.metadata || {}).includes('SMTP_PASS')) || null;
    });
    assert.ok(auditEntry, 'L: lipsește AuditLog-ul ADMIN_UPDATED_SETTINGS pentru SMTP_PASS');

    const recentAudit = await prisma.auditLog.findMany({ where: { createdAt: { gte: caseStart } } });
    for (const row of recentAudit) {
      assert.ok(!JSON.stringify(row).includes(smtpSecret), `L: AuditLog ${row.eventType} conține secretul SMTP_PASS`);
    }

    const clearSmtp = await putSettings({ SMTP_PASS: null });
    expectStatus(clearSmtp, 200, 'L PUT SMTP_PASS null');
    assert.equal(await prisma.setting.findUnique({ where: { key: 'SMTP_PASS' } }), null, 'L: rândul Setting SMTP_PASS nu a fost șters');

    const settingsAfterSmtp = await settingsApi('GET', '/api/admin/settings', { token: superToken });
    expectStatus(settingsAfterSmtp, 200, 'L GET setări după null SMTP_PASS');
    const smtpViewAfter = (settingsAfterSmtp.json?.settings || []).find(view => view.key === 'SMTP_PASS') || {};
    assert.equal(
      smtpViewAfter.source,
      smtpSourceBefore,
      `L: source SMTP_PASS nu a revenit la "${smtpSourceBefore}" (${smtpViewAfter.source})`
    );

    // --- Watermark: reaches the playback token, then back to defaults -------
    const setWatermark = await putSettings({ WATERMARK_TEXT: 'smoke-wm', WATERMARK_INTERVAL_SECONDS: '7' });
    expectStatus(setWatermark, 200, 'L PUT watermark');

    const playback = await settingsApi('POST', `/api/playback/${state.ids.video}/token`, { token: superToken });
    expectStatus(playback, 200, 'L playback token ca SUPER_ADMIN');
    assert.equal(playback.json?.watermark?.text, 'smoke-wm', 'L: playback token nu întoarce watermark.text salvat');
    assert.equal(playback.json?.watermark?.refreshIntervalSeconds, 7, 'L: refreshIntervalSeconds nu e 7');

    const clearWatermark = await putSettings({ WATERMARK_TEXT: null, WATERMARK_INTERVAL_SECONDS: null });
    expectStatus(clearWatermark, 200, 'L PUT watermark null');

    // --- Connection tests: booleans, never the keys -------------------------
    const stripeTest = await settingsApi('POST', '/api/admin/settings/test/stripe', { token: superToken });
    expectStatus(stripeTest, 200, 'L POST test/stripe ca SUPER_ADMIN');
    assert.equal(stripeTest.json?.ok, true, `L: testul Stripe a răspuns ok:${stripeTest.json?.ok} (${stripeTest.json?.message})`);
    assert.equal(stripeTest.json?.details?.mode, 'test', 'L: testul Stripe nu raportează mode "test"');

    for (const service of ['bunny', 'smtp']) {
      const test = await settingsApi('POST', `/api/admin/settings/test/${service}`, { token: superToken });
      expectStatus(test, 200, `L POST test/${service}`);
      assert.equal(typeof test.json?.ok, 'boolean', `L: testul ${service} nu întoarce un ok boolean`);
      for (const [name, value] of presentSecrets) {
        assert.ok(!test.text.includes(value), `L: testul ${service} întoarce valoarea din env a ${name}`);
      }
    }

    // --- stripe-webhook without an https APP_URL: 400, no real endpoint -----
    const appUrlValue = String(
      (settingsResponse.json?.settings || []).find(view => view.key === 'APP_URL')?.value || ''
    );
    if (/^https:\/\//i.test(appUrlValue)) {
      console.log(`   (stripe-webhook: APP_URL e https (${appUrlValue}), cazul e sărit ca să nu creeze un endpoint real)`);
    } else {
      const webhookCreate = await settingsApi('POST', '/api/admin/settings/stripe-webhook', { token: superToken });
      expectStatus(webhookCreate, 400, 'L POST stripe-webhook cu APP_URL ne-https');
      assert.equal(webhookCreate.json?.error, 'APP_URL_NOT_HTTPS', 'L: motiv greșit pentru APP_URL ne-https');
    }

    // --- change-password on a dedicated user --------------------------------
    const oldPassword = 'ParolaInitiala123!';
    const nextPassword = 'ParolaSchimbata456!';
    const passwordEmail = `${PREFIX}-parola@example.com`;
    const hashPassword = await loadHashPassword();

    const passwordUser = await prisma.user.create({
      data: {
        email: passwordEmail,
        username: `${PREFIX}-parola`,
        passwordHash: hashPassword(oldPassword),
        role: 'USER',
      },
    });
    state.userIds.push(passwordUser.id);
    state.emails.push(passwordEmail);

    const currentToken = await createPrismaSession(passwordUser.id);
    const otherToken = await createPrismaSession(passwordUser.id);

    const wrongCurrent = await settingsApi('POST', '/api/account/change-password', {
      token: currentToken,
      body: { currentPassword: 'ParolaGresita123!', newPassword: nextPassword },
    });
    expectStatus(wrongCurrent, 400, 'L change-password cu parolă actuală greșită');
    assert.equal(wrongCurrent.json?.error, 'INVALID_PASSWORD', 'L: motiv greșit pentru parola actuală greșită');

    const changed = await settingsApi('POST', '/api/account/change-password', {
      token: currentToken,
      body: { currentPassword: oldPassword, newPassword: nextPassword },
    });
    expectStatus(changed, 200, 'L change-password cu parolă actuală corectă');

    const otherSession = await settingsApi('GET', '/api/auth/me', { token: otherToken });
    expectStatus(otherSession, 401, 'L cealaltă sesiune după schimbarea parolei');

    const currentSession = await settingsApi('GET', '/api/auth/me', { token: currentToken });
    expectStatus(currentSession, 200, 'L sesiunea curentă după schimbarea parolei');

    const loginNewPassword = await settingsApi('POST', '/api/auth/login', {
      body: { identifier: passwordEmail, password: nextPassword },
    });
    expectStatus(loginNewPassword, 200, 'L login cu noua parolă');
    assert.ok(cookieValue(loginNewPassword, SESSION_COOKIE), 'L: login reușit fără cookie de sesiune');
  });

  // Case M runs against its own server process (own env: FGO + SMTP point at the local mocks),
  // its own client IP (FGO_CLIENT_IP) and its own buyer. The harness is closed by
  // `stopFgoHarness()` in the `finally` block.
  await runCase('M) FGO: emitere, duplicat, erori, storno, SPV, email, confidențialitate', async () => {
    const { mock, smtp, baseUrl } = await startFgoHarness();

    // --- Fixtures: FGO buyer, one video per flow -----------------------------
    const hashPassword = await loadHashPassword();
    const buyer = await prisma.user.create({
      data: {
        email: FGO_BUYER_EMAIL,
        username: FGO_BUYER_USERNAME,
        passwordHash: hashPassword(FGO_BUYER_PASSWORD),
        role: 'USER',
      },
    });
    state.userIds.push(buyer.id);
    state.emails.push(buyer.email);
    const buyerToken = await createPrismaSession(buyer.id);

    const makeVideo = async suffix => {
      const video = await prisma.video.create({
        data: {
          title: `${PREFIX} fgo ${suffix}`,
          slug: `${PREFIX}-fgo-${suffix}`,
          description: 'Film de test pentru facturarea FGO.',
          categoryId: state.ids.catMain,
          tags: ['smoke', RAND],
          priceAmount: 10,
          currency: 'EUR',
          durationSeconds: 60,
          status: 'READY',
          isPublished: true,
          publishedAt: new Date(),
          bunnyVideoId: `${PREFIX}-bunny-fgo-${suffix}`,
        },
      });
      state.videoIds.push(video.id);
      return video;
    };

    const videoMain = await makeVideo('principal');
    const videoSecond = await makeVideo('doi');
    const videoDouble = await makeVideo('dublu');
    const videoError = await makeVideo('eroare');
    const videoValidation = await makeVideo('validare');

    // Checkout and signed webhook, exactly like cases C/D (real Stripe test session)
    const checkout = async (videoId, label) => {
      await avoidMinuteBoundary();
      const response = await fgoApi('POST', `/api/payments/checkout/${videoId}`, {
        token: buyerToken,
        body: { acceptedTerms: true, billing: FGO_BILLING },
      });
      expectStatus(response, 200, `M checkout ${label}`);
      const payment = await prisma.payment.findFirst({
        where: { userId: buyer.id, videoId },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(payment, `M: lipsește rândul Payment după checkout (${label})`);
      state.stripeSessionIds.push(payment.checkoutSessionId);
      return payment;
    };

    const completedEvent = (payment, paymentIntentId, suffix) =>
      eventOf(
        'checkout.session.completed',
        {
          id: payment.checkoutSessionId,
          object: 'checkout.session',
          mode: 'payment',
          payment_status: 'paid',
          payment_intent: paymentIntentId,
          invoice: null,
          amount_total: 1000,
          currency: 'eur',
          created: Math.floor(Date.now() / 1000),
          metadata: { userId: buyer.id, videoId: payment.videoId },
        },
        suffix
      );

    const payAndWait = async (videoId, paymentIntentId, suffix, label) => {
      const payment = await checkout(videoId, label);
      const delivered = await signedWebhookTo(completedEvent(payment, paymentIntentId, suffix));
      expectStatus(delivered, 200, `M webhook ${label}`);
      const purchase = await waitFor(() => prisma.purchase.findFirst({ where: { userId: buyer.id, videoId } }));
      assert.ok(purchase, `M: nu s-a creat Purchase (${label})`);
      const invoice = await waitFor(() => prisma.invoice.findFirst({ where: { purchaseId: purchase.id } }));
      assert.ok(invoice, `M: nu s-a creat Invoice (${label})`);
      return { payment, purchase, invoice };
    };

    const waitInvoice = async (id, check, label) => {
      const invoice = await waitFor(
        async () => {
          const row = await prisma.invoice.findUnique({ where: { id } });
          return row && check(row) ? row : null;
        },
        { timeoutMs: 45_000, intervalMs: 250 }
      );
      assert.ok(invoice, `M: ${label}`);
      return invoice;
    };

    const emissionRequests = invoiceId =>
      mock.requests.filter(
        request => request.method === 'POST' && request.path === '/v2/facturi' && request.body?.id_extern === invoiceId
      );

    // --- 1. Billing is mandatory and the RO CUI must pass the control digit ---
    const noBilling = await fgoApi('POST', `/api/payments/checkout/${videoMain.id}`, {
      token: buyerToken,
      body: { acceptedTerms: true },
    });
    expectStatus(noBilling, 400, 'M checkout fără billing');
    assert.equal(noBilling.json?.error, 'INVALID_BILLING', 'M: checkout fără billing nu a răspuns INVALID_BILLING');

    const invalidCui = await fgoApi('POST', `/api/payments/checkout/${videoMain.id}`, {
      token: buyerToken,
      body: { acceptedTerms: true, billing: { ...FGO_BILLING, cui: FGO_INVALID_CUI } },
    });
    expectStatus(invalidCui, 400, 'M checkout PJ cu CUI invalid');
    assert.equal(invalidCui.json?.error, 'INVALID_BILLING', 'M: CUI invalid nu a fost respins cu INVALID_BILLING');
    assert.ok(String(invalidCui.json?.message || '').includes('CUI'), 'M: mesajul pentru CUI invalid nu conține "CUI"');

    // --- 2. First payment: the whole FGO flow, PDF, SPV, email, counter -------
    const first = await payAndWait(videoMain.id, `${PI_INTENT}_fgo1`, 'fgo-completed-1', 'plata 1');

    const emission = await waitFor(() => emissionRequests(first.invoice.id)[0] || null, { timeoutMs: 45_000, intervalMs: 250 });
    assert.ok(emission, 'M: nu a fost trimisă nicio cerere POST /v2/facturi pentru prima factură');

    assert.equal(emission.headers.authorization, `Bearer ${FGO_API_KEY}`, 'M: Authorization greșit pe POST /v2/facturi');
    assert.equal(emission.headers['fgo-cod-unic'], FGO_COD_UNIC, 'M: Fgo-Cod-Unic greșit pe POST /v2/facturi');
    assert.equal(emission.headers['fgo-url-platforma'], baseUrl, 'M: Fgo-Url-Platforma lipsește sau e greșit');

    const emitted = emission.body || {};
    assert.equal(emitted.serie, FGO_SERIES, 'M: body.serie greșit');
    assert.equal(emitted.numar, '000124', `M: body.numar nu continuă FGO_LAST_NUMBER (${emitted.numar})`);
    assert.equal(emitted.verificare_duplicat, true, 'M: body.verificare_duplicat nu e true');
    assert.equal(emitted.id_extern, first.invoice.id, 'M: body.id_extern nu e id-ul facturii locale');

    const article = (emitted.articole || [])[0] || {};
    assert.ok(
      Math.abs(Number(article.pret_total) - first.invoice.totalAmount.toNumber()) < 0.001,
      `M: articole[0].pret_total (${article.pret_total}) nu egalează totalul facturii (${first.invoice.totalAmount})`
    );
    assert.equal(Number(article.cota_tva), first.invoice.taxRate.toNumber(), 'M: articole[0].cota_tva greșit');

    const emittedClient = emitted.client || {};
    assert.equal(emittedClient.tip, 'PJ', `M: client.tip e ${emittedClient.tip}`);
    assert.equal(emittedClient.denumire, FGO_BILLING.name, 'M: client.denumire greșit');
    assert.equal(emittedClient.cod_judet, FGO_BILLING.county, 'M: client.cod_judet greșit');
    assert.equal(emittedClient.localitate, FGO_BILLING.city, 'M: client.localitate greșit');
    assert.equal(emittedClient.adresa, FGO_BILLING.address, 'M: client.adresa greșită');
    assert.equal(emittedClient.tara, FGO_BILLING.country, 'M: client.tara greșită');

    const firstDone = await waitInvoice(
      first.invoice.id,
      invoice => invoice.fgoStatus === 'DONE',
      'prima factură nu ajunge DONE'
    );
    assert.equal(firstDone.invoiceNumber, 'TST-000124', `M: invoiceNumber greșit (${firstDone.invoiceNumber})`);
    assert.equal(firstDone.fgoPdfUrl, `${mock.url}/pdf/x`, 'M: fgoPdfUrl nu e linkul dat de mock');
    assert.ok(firstDone.fgoPaidAt, 'M: încasarea nu a fost înregistrată (fgoPaidAt gol)');
    assert.ok(firstDone.fgoSpvAt, 'M: factura nu a fost trimisă în SPV (fgoSpvAt gol)');
    assert.ok(
      mock.requests.some(request => request.method === 'POST' && request.path === '/v2/facturi/TST/000124/incasari'),
      'M: POST .../incasari nu a fost apelat'
    );
    assert.ok(
      mock.requests.some(request => request.method === 'POST' && request.path === '/v2/facturi/TST/000124/trimite-in-spv'),
      'M: POST .../trimite-in-spv nu a fost apelat'
    );

    assert.ok(
      mock.requests.some(request => request.method === 'GET' && request.path === '/pdf/x'),
      'M: PDF-ul facturii nu a fost descărcat de la mock'
    );
    const invoiceMail = await waitFor(() => smtp.messages.find(message => message.includes('application/pdf')) || null, {
      timeoutMs: 15_000,
      intervalMs: 250,
    });
    assert.ok(invoiceMail, 'M: emailul trimis pe SMTP nu conține un atașament application/pdf');
    assert.ok(invoiceMail.includes('Factura-TST-000124.pdf'), 'M: emailul nu are atașată factura TST-000124');

    const settingsAfterFirst = await fgoApi('GET', '/api/admin/settings', { token: state.tokens.super });
    expectStatus(settingsAfterFirst, 200, 'M GET setări după prima factură');
    const lastNumberView = (settingsAfterFirst.json?.settings || []).find(view => view.key === 'FGO_LAST_NUMBER') || {};
    assert.equal(lastNumberView.value, '000124', `M: FGO_LAST_NUMBER nu a avansat (${lastNumberView.value})`);

    // --- A second payment continues the series ------------------------------
    const second = await payAndWait(videoSecond.id, `${PI_INTENT}_fgo2`, 'fgo-completed-2', 'plata 2');
    const secondEmission = await waitFor(() => emissionRequests(second.invoice.id)[0] || null, {
      timeoutMs: 45_000,
      intervalMs: 250,
    });
    assert.ok(secondEmission, 'M: a doua plată nu a produs o cerere de emitere');
    assert.equal(secondEmission.body?.numar, '000125', `M: a doua factură a primit ${secondEmission.body?.numar}`);
    const secondDone = await waitInvoice(
      second.invoice.id,
      invoice => invoice.fgoStatus === 'DONE',
      'a doua factură nu ajunge DONE'
    );
    assert.equal(secondDone.invoiceNumber, 'TST-000125', `M: invoiceNumber greșit la a doua factură (${secondDone.invoiceNumber})`);

    // --- 3. The same webhook delivered twice issues one invoice --------------
    const paymentDouble = await checkout(videoDouble.id, 'livrare dublă');
    const doubleEvent = completedEvent(paymentDouble, `${PI_INTENT}_fgo3`, 'fgo-completed-3');
    const [deliveryOne, deliveryTwo] = await Promise.all([signedWebhookTo(doubleEvent), signedWebhookTo(doubleEvent)]);
    expectStatus(deliveryOne, 200, 'M webhook livrare dublă #1');
    expectStatus(deliveryTwo, 200, 'M webhook livrare dublă #2');
    const deliveryStatuses = [deliveryOne.json?.status, deliveryTwo.json?.status];
    assert.equal(
      deliveryStatuses.filter(status => status === 'SUCCESS').length,
      1,
      `M: livrarea dublă a produs ${deliveryStatuses.join(' + ')}`
    );

    const doublePurchase = await waitFor(() =>
      prisma.purchase.findFirst({ where: { userId: buyer.id, videoId: videoDouble.id } })
    );
    assert.ok(doublePurchase, 'M: livrarea dublă nu a creat Purchase');
    const doubleInvoice = await prisma.invoice.findFirst({ where: { purchaseId: doublePurchase.id } });
    assert.ok(doubleInvoice, 'M: livrarea dublă nu a creat Invoice');
    await waitInvoice(doubleInvoice.id, invoice => invoice.fgoStatus === 'DONE', 'factura livrării duble nu ajunge DONE');
    assert.equal(
      emissionRequests(doubleInvoice.id).length,
      1,
      `M: livrarea dublă a produs ${emissionRequests(doubleInvoice.id).length} cereri de emitere`
    );

    // --- 4. 500 → PENDING with the error, then retry adopts the FGO number ----
    mock.mode = 'error500';
    const errorRun = await payAndWait(videoError.id, `${PI_INTENT}_fgo4`, 'fgo-completed-4', 'plata cu 500');
    const stillPending = await waitInvoice(
      errorRun.invoice.id,
      invoice => invoice.fgoAttempts >= 1,
      'factura cu 500 nu a înregistrat nicio încercare'
    );
    assert.equal(stillPending.fgoStatus, 'PENDING', `M: după 500 factura are fgoStatus ${stillPending.fgoStatus}`);
    assert.equal(stillPending.fgoAttempts, 1, `M: fgoAttempts e ${stillPending.fgoAttempts} după 500`);
    assert.ok(stillPending.fgoError, 'M: fgoError lipsește după 500');
    assert.ok(stillPending.fgoNextAttemptAt, 'M: fgoNextAttemptAt lipsește după 500');

    mock.mode = 'duplicate';
    const errorRetry = await fgoApi('POST', `/api/admin/invoices/${errorRun.invoice.id}/retry`, {
      token: state.tokens.admin,
    });
    expectStatus(errorRetry, 200, 'M retry după 500');
    const adopted = await waitInvoice(
      errorRun.invoice.id,
      invoice => invoice.fgoStatus === 'DONE',
      'factura nu ajunge DONE după factura_duplicata'
    );
    assert.equal(adopted.fgoSerie, FGO_DUPLICATE.serie, `M: seria adoptată e ${adopted.fgoSerie}`);
    assert.equal(adopted.fgoNumar, FGO_DUPLICATE.numar, `M: numărul adoptat e ${adopted.fgoNumar}`);
    assert.equal(
      adopted.invoiceNumber,
      `${FGO_DUPLICATE.serie}-${FGO_DUPLICATE.numar}`,
      'M: invoiceNumber nu a preluat seria și numărul din factura_duplicata'
    );

    // --- 5. Validation error → FAILED, visible in the admin list, retry fixes it
    mock.mode = 'validation';
    const invalid = await payAndWait(videoValidation.id, `${PI_INTENT}_fgo5`, 'fgo-completed-5', 'plata cu validare');
    const failed = await waitInvoice(
      invalid.invoice.id,
      invoice => invoice.fgoStatus === 'FAILED',
      'factura respinsă la validare nu ajunge FAILED'
    );
    assert.ok(
      String(failed.fgoError || '').includes(FGO_VALIDATION_MESSAGE),
      `M: fgoError nu conține mesajul de validare (${failed.fgoError})`
    );

    const invoicesList = await fgoApi('GET', '/api/admin/invoices', { token: state.tokens.admin });
    expectStatus(invoicesList, 200, 'M GET /api/admin/invoices');
    assert.ok(Number(invoicesList.json?.failedCount) >= 1, `M: failedCount e ${invoicesList.json?.failedCount}`);
    assert.ok(
      (invoicesList.json?.items || []).some(item => item.id === invalid.invoice.id && item.fgoStatus === 'FAILED'),
      'M: factura FAILED nu apare în GET /api/admin/invoices'
    );

    mock.mode = 'ok';
    const repairRetry = await fgoApi('POST', `/api/admin/invoices/${invalid.invoice.id}/retry`, {
      token: state.tokens.admin,
    });
    expectStatus(repairRetry, 200, 'M retry după validare');
    const repaired = await waitInvoice(
      invalid.invoice.id,
      invoice => invoice.fgoStatus === 'DONE',
      'factura nu ajunge DONE după reparare'
    );
    assert.ok(
      String(repaired.invoiceNumber || '').startsWith(`${FGO_SERIES}-`),
      `M: invoiceNumber greșit după reparare (${repaired.invoiceNumber})`
    );

    // --- 6. Full refund → storno once; a dispute never asks for a storno ------
    const refund = await signedWebhookTo(
      eventOf(
        'charge.refunded',
        {
          id: `${PREFIX}-charge-fgo-1`,
          object: 'charge',
          refunded: true,
          amount: 1000,
          currency: 'eur',
          payment_intent: `${PI_INTENT}_fgo1`,
        },
        'fgo-refund-1'
      )
    );
    expectStatus(refund, 200, 'M webhook charge.refunded');
    assert.equal(refund.json?.status, 'REVOKED', `M: refund a răspuns ${refund.json?.status}`);

    const stornoDone = await waitInvoice(
      first.invoice.id,
      invoice => Boolean(invoice.fgoStornoDoneAt) && invoice.fgoStatus === 'DONE',
      'stornarea primei facturi nu a fost emisă'
    );
    assert.equal(stornoDone.fgoStornoSerie, FGO_STORNO_SERIES, `M: seria storno e ${stornoDone.fgoStornoSerie}`);
    assert.equal(
      mock.requests.filter(request => request.method === 'POST' && request.path === '/v2/facturi/TST/000124/storneaza')
        .length,
      1,
      'M: POST .../storneaza nu a fost apelat exact o dată'
    );

    const stornoEmail = await waitFor(() =>
      prisma.emailLog.findFirst({ where: { to: FGO_BUYER_EMAIL, type: 'FGO_STORNO' }, orderBy: { sentAt: 'desc' } })
    );
    assert.ok(stornoEmail, 'M: lipsește EmailLog-ul FGO_STORNO');
    assert.equal(stornoEmail.status, 'SENT', `M: emailul storno are status ${stornoEmail.status}`);

    const dispute = await signedWebhookTo(
      eventOf(
        'charge.dispute.created',
        {
          id: `${PREFIX}-dispute-fgo-1`,
          object: 'dispute',
          status: 'needs_response',
          payment_intent: `${PI_INTENT}_fgo2`,
        },
        'fgo-dispute-1'
      )
    );
    expectStatus(dispute, 200, 'M webhook charge.dispute.created');
    assert.equal(dispute.json?.status, 'REVOKED', `M: disputa a răspuns ${dispute.json?.status}`);

    const disputed = await waitFor(async () => {
      const row = await prisma.invoice.findUnique({ where: { id: second.invoice.id } });
      return row && row.status === 'REFUNDED' ? row : null;
    });
    assert.ok(disputed, 'M: factura celei de-a doua plăți nu a fost marcată REFUNDED după dispută');
    assert.equal(disputed.fgoStornoWanted, false, 'M: disputa a cerut storno (fgoStornoWanted true)');
    assert.ok(
      !mock.requests.some(request => request.method === 'POST' && request.path === '/v2/facturi/TST/000125/storneaza'),
      'M: storneaza a fost apelat pentru o plată cu dispută'
    );

    // --- 7. The FGO errors stay on the server side ---------------------------
    const purchases = await fgoApi('GET', '/api/account/purchases', { token: buyerToken });
    expectStatus(purchases, 200, 'M GET /api/account/purchases');
    assert.ok(!purchases.text.includes('fgoError'), 'M: /api/account/purchases conține fgoError');
    assert.ok(!purchases.text.includes('fgoWarning'), 'M: /api/account/purchases conține fgoWarning');

    const settingsResponse = await fgoApi('GET', '/api/admin/settings', { token: state.tokens.super });
    expectStatus(settingsResponse, 200, 'M GET /api/admin/settings');
    assert.ok(!settingsResponse.text.includes(FGO_API_KEY), 'M: GET /api/admin/settings întoarce cheia FGO în clar');
    const apiKeyView = (settingsResponse.json?.settings || []).find(view => view.key === 'FGO_API_KEY') || {};
    assert.equal(apiKeyView.value, null, 'M: GET /api/admin/settings întoarce valoarea cheii FGO');

    // --- 8. isValidRoCui, checked against the algorithm itself --------------
    const cuiControlKey = '753217532';
    const cuiValid = candidate => {
      const digits = String(candidate);
      if (!/^\d{2,10}$/.test(digits)) return false;
      const body = digits.slice(0, -1);
      let sum = 0;
      for (let i = 0; i < body.length; i++) {
        sum += Number(body[i]) * Number(cuiControlKey[cuiControlKey.length - body.length + i]);
      }
      const control = (sum * 10) % 11;
      return (control === 10 ? 0 : control) === Number(digits.slice(-1));
    };

    const billingModule = await import(new URL('../src/types/billing.ts', import.meta.url).href);
    assert.equal(typeof billingModule.isValidRoCui, 'function', 'M: src/types/billing.ts nu exportă isValidRoCui');

    assert.equal(
      billingModule.isValidRoCui(FGO_VALID_CUI),
      cuiValid(FGO_VALID_CUI),
      `M: isValidRoCui(${FGO_VALID_CUI}) diferă de algoritmul de control`
    );
    assert.equal(
      billingModule.isValidRoCui(FGO_VALID_CUI),
      true,
      `M: ${FGO_VALID_CUI} ar trebui să fie un CUI valid`
    );
    assert.equal(billingModule.isValidRoCui(FGO_INVALID_CUI), false, `M: ${FGO_INVALID_CUI} e acceptat ca CUI valid`);

    // A CUI computed here with the same algorithm, so the check does not only rest on the sample above
    const computedBody = '2468135';
    let computedSum = 0;
    for (let i = 0; i < computedBody.length; i++) {
      computedSum += Number(computedBody[i]) * Number(cuiControlKey[cuiControlKey.length - computedBody.length + i]);
    }
    const computedControl = (computedSum * 10) % 11;
    const computedCui = `${computedBody}${computedControl === 10 ? 0 : computedControl}`;
    assert.equal(cuiValid(computedCui), true, 'M: CUI-ul calculat în test nu trece algoritmul local');
    assert.equal(billingModule.isValidRoCui(computedCui), true, `M: isValidRoCui(${computedCui}) respinge un CUI valid`);
    const brokenCui = `${computedCui.slice(0, -1)}${(Number(computedCui.slice(-1)) + 1) % 10}`;
    assert.equal(billingModule.isValidRoCui(brokenCui), false, `M: isValidRoCui(${brokenCui}) acceptă altă cifră de control`);

    // --- 8b. Stripe test + FGO producție: nicio factură fiscală reală ---------
    const fgoModule = await import(new URL('../src/server/modules/fgo/fgo.service.ts', import.meta.url).href);
    assert.equal(typeof fgoModule.blocksRealInvoice, 'function', 'M: fgo.service.ts nu exportă blocksRealInvoice');
    assert.equal(
      fgoModule.blocksRealInvoice('https://api.fgo.ro', 'sk_test_x'),
      true,
      'M: blocksRealInvoice lasă o plată Stripe de test să emită factură pe FGO producție'
    );
    assert.equal(
      fgoModule.blocksRealInvoice('https://api-testuat.fgo.ro', 'sk_test_x'),
      false,
      'M: blocksRealInvoice blochează emiterea pe FGO test cu cheie Stripe de test'
    );
    assert.equal(
      fgoModule.blocksRealInvoice('https://api.fgo.ro', 'sk_live_x'),
      false,
      'M: blocksRealInvoice blochează emiterea reală pe FGO producție cu cheie Stripe live'
    );
    assert.equal(
      fgoModule.blocksRealInvoice('nu-e-un-url', 'sk_test_x'),
      false,
      'M: blocksRealInvoice nu tratează un URL invalid ca producție'
    );

    // --- 9. Portul 465 e mereu TLS, chiar cu SMTP_SECURE=false --------------
    // Nimic nu ascultă pe 465 aici, deci verificarea nu are nevoie de rețea reală: un client în clar
    // care așteaptă salutul pe un port implicit-TLS raportează exact "Greeting never received".
    try {
      // Doar portul, ca la o salvare din admin: secure trebuie recalculat
      const portOnly = await fgoApi('PUT', '/api/admin/settings', {
        token: state.tokens.super,
        body: { values: { SMTP_PORT: '465' } },
      });
      expectStatus(portOnly, 200, 'M PUT SMTP_PORT 465');

      const onImplicitTls = await fgoApi('GET', '/api/admin/smtp', { token: state.tokens.admin });
      expectStatus(onImplicitTls, 200, 'M GET /api/admin/smtp pe portul 465');
      assert.equal(
        onImplicitTls.json?.config?.port,
        465,
        `M: portul SMTP nu a devenit 465 (${onImplicitTls.json?.config?.port})`
      );
      assert.equal(
        onImplicitTls.json?.config?.secure,
        true,
        'M: secure nu a fost recalculat după ce portul a fost schimbat în 465'
      );

      // "false" salvat (ca în .env) nu are voie să dezactiveze TLS pe 465
      const secureFalse = await fgoApi('PUT', '/api/admin/settings', {
        token: state.tokens.super,
        body: { values: { SMTP_SECURE: 'false' } },
      });
      expectStatus(secureFalse, 200, 'M PUT SMTP_SECURE false');

      const afterFalse = await fgoApi('GET', '/api/admin/smtp', { token: state.tokens.admin });
      expectStatus(afterFalse, 200, 'M GET /api/admin/smtp după SMTP_SECURE false');
      assert.equal(afterFalse.json?.config?.secure, true, 'M: SMTP_SECURE=false a dezactivat TLS pe portul 465');

      const smtpTest = await fgoApi('POST', '/api/admin/settings/test/smtp', { token: state.tokens.super });
      expectStatus(smtpTest, 200, 'M POST test/smtp pe portul 465');
      assert.ok(
        !String(smtpTest.json?.message || '').toLowerCase().includes('greeting never received'),
        `M: testul SMTP pe 465 raportează "Greeting never received" (${smtpTest.json?.message})`
      );
    } finally {
      // Valoarea salvată aici nu are voie să rămână: următorul start al aplicației ar aplica-o
      try {
        const cleared = await fgoApi('PUT', '/api/admin/settings', {
          token: state.tokens.super,
          body: { values: { SMTP_PORT: null, SMTP_SECURE: null } },
        });
        if (cleared.status !== 200) {
          console.warn(`! M: setările SMTP nu au putut fi scoase (status ${cleared.status}): ${cleared.text.slice(0, 200)}`);
        }
      } catch (err) {
        console.warn(`! M: cleanup setări SMTP: ${err.message}`);
      }
    }
  });
} finally {
  // The case M server process and its mocks first, then the settings (through the API, so the
  // main server reloads the env values), then the DB rows
  await stopFgoHarness();
  await restoreSettings();
  await cleanup();

  console.log('');
  if (failures > 0) {
    console.error(`✗ ${failures} caz(uri) au eșuat: ${failedCases.join(' | ')}`);
    process.exitCode = 1;
  } else {
    console.log('✓ toate cazurile au trecut');
  }
}
