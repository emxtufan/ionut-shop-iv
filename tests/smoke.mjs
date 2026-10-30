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

const state = {
  ids: {},
  tokens: {},
  userIds: [],
  videoIds: [],
  categoryIds: [],
  stripeSessionIds: [],
  emails: [],
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

async function createPrismaSession(userId) {
  const token = `sess_${RAND}_${crypto.randomBytes(12).toString('hex')}`;
  await prisma.session.create({
    data: {
      userId,
      token,
      ip: CLIENT_IP,
      userAgent: USER_AGENT,
      deviceType: 'CLI',
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return token;
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

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

    const noTerms = await api('POST', `/api/payments/checkout/${videoId}`, { token: state.tokens.buyer, body: {} });
    expectStatus(noTerms, 400, 'C checkout fără acceptedTerms');
    assert.equal(noTerms.json?.error, 'TERMS_NOT_ACCEPTED', 'C: motiv greșit pentru lipsa termenilor');

    await avoidMinuteBoundary();

    const [first, second] = await Promise.all([
      api('POST', `/api/payments/checkout/${videoId}`, { token: state.tokens.buyer, body: { acceptedTerms: true } }),
      api('POST', `/api/payments/checkout/${videoId}`, { token: state.tokens.buyer, body: { acceptedTerms: true } }),
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

    const third = await api('POST', `/api/payments/checkout/${videoId}`, { token: state.tokens.buyer, body: { acceptedTerms: true } });
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
      body: { acceptedTerms: true },
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
} finally {
  await cleanup();

  console.log('');
  if (failures > 0) {
    console.error(`✗ ${failures} caz(uri) au eșuat: ${failedCases.join(' | ')}`);
    process.exitCode = 1;
  } else {
    console.log('✓ toate cazurile au trecut');
  }
}
