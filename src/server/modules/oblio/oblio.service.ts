// ==============================================================================
// IV Concept VOD - Oblio invoicing client (proforme la checkout, facturi fiscale
// după plată, prin API-ul Oblio)
// Docs: https://www.oblio.eu/api - contul Oblio -> Setări -> Integrări -> API
// The proforma is issued while the buyer is still on Stripe; the fiscal invoice is
// issued after the payment, from the FGO queue. Every step saves its result
// immediately, so a retry continues from the first unfinished step.
// The email and the secret are only ever put in the token request: never logged.
// ==============================================================================

import type { Invoice, Payment, Prisma } from '@prisma/client';
import { config } from '../../config.ts';
import { db } from '../../db/index.ts';
import { COUNTRIES, RO_COUNTIES } from '../../../types/billing.ts';
import type { BillingDetails } from '../../../types/billing.ts';
import { AuditService } from '../audit/audit.service.ts';
import { EmailService } from '../email/email.service.ts';

const BASE_URL = 'https://www.oblio.eu/api';
/** Oblio accepts roughly one request per second: keep a hard minimum between two calls. */
const MIN_CALL_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const PDF_TIMEOUT_MS = 30_000;
const PDF_MAX_BYTES = 10 * 1024 * 1024;
/** A proforma still attached to an unpaid payment after this long is abandoned. */
const PROFORMA_ABANDON_MS = 25 * 60 * 60 * 1000;
/** The abandoned proformas are cancelled in small batches, one pass per timer tick. */
const CANCEL_BATCH = 20;
const UNIT = 'buc';

export interface OblioErrorDetails {
  message: string;
  /** HTTP status, or 0 when the request never reached Oblio (network / timeout). */
  status: number;
  retryable: boolean;
}

/**
 * Error returned by the Oblio API. `retryable` tells the queue whether the same request
 * may be repeated later (network, timeout, 5xx, 429) or will fail the same way forever.
 */
export class OblioError extends Error {
  public status: number;
  public retryable: boolean;

  constructor(details: OblioErrorDetails) {
    super(details.message);
    this.name = 'OblioError';
    this.status = details.status;
    this.retryable = details.retryable;
  }
}

/** Timestamp of the last API call; the requests are serialized through it. */
let lastCall = 0;
/** Access token kept in memory until 60s before it expires. */
let cachedToken: { value: string; expiresAt: number } | null = null;

/** The body of a call: either JSON or form-urlencoded, never both. */
type RequestBody = { json?: Record<string, any>; form?: Record<string, string> };

/** Drops the null / undefined keys: Oblio rejects them instead of ignoring them. */
function withoutEmpty(value: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    out[key] = item;
  }
  return out;
}

/** Invoice total, VAT included, as a number with two decimals. */
function totalAmount(invoice: Invoice): number {
  return Number(invoice.totalAmount.toFixed(2));
}

/** 0.21 -> 21, the percentage Oblio expects on every product line. */
function vatPercent(rate: number): number {
  return Number((rate * 100).toFixed(2));
}

/** Product name for the single line, from the invoice items. */
function itemName(invoice: Invoice): string {
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const names = items
    .map(item => (item && typeof item === 'object' ? String((item as any).description ?? '').trim() : ''))
    .filter(Boolean);
  return (names.length ? names.join(', ') : 'Licență digitală streaming video').slice(0, 2000);
}

/** Oblio refuses the diacritics in the country / state names: "România" is sent as "Romania". */
function withoutDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Oblio takes the country name; the checkout stores the ISO code (RO -> Romania). */
function countryName(code: string | null | undefined): string | null {
  const value = String(code ?? '').trim();
  if (!value) return null;
  return withoutDiacritics(COUNTRIES.find(item => item.code === value.toUpperCase())?.name ?? value);
}

/** Oblio takes the county name in the `state` field; the checkout stores the code (CJ -> Cluj). */
function stateName(code: string | null | undefined): string | null {
  const value = String(code ?? '').trim();
  if (!value) return null;
  return withoutDiacritics(RO_COUNTIES.find(item => item.code === value.toUpperCase())?.name ?? value);
}

/** Oblio takes vatPayer = 1 only for a company whose CUI carries the RO prefix, otherwise 0. */
function vatPayerFlag(cif: string | null | undefined): number {
  const value = String(cif ?? '').replace(/\s+/g, '').toUpperCase();
  return value.startsWith('RO') ? 1 : 0;
}

/** Billing details are validated before being saved; anything malformed is ignored here. */
function readBilling(value: Prisma.JsonValue | null | undefined): BillingDetails | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as unknown as BillingDetails;
}

/** Same rule as blocksRealInvoice in the FGO client: a test payment never reaches SPV (ANAF). */
function stripeTestMode(): boolean {
  return config.stripe.secretKey.startsWith('sk_test_');
}

/** Buyer data, already validated and copied to the invoice by the checkout. */
function invoiceClient(invoice: Invoice): Record<string, any> {
  return withoutEmpty({
    name: invoice.buyerName,
    cif: invoice.buyerCui,
    rc: invoice.buyerRegCom,
    email: invoice.buyerEmail,
    phone: invoice.buyerPhone,
    address: invoice.buyerAddress,
    city: invoice.buyerCity,
    state: stateName(invoice.buyerCounty),
    country: countryName(invoice.buyerCountry),
    vatPayer: vatPayerFlag(invoice.buyerCui),
    save: 0,
  });
}

/** Buyer data from the checkout billing details: the proforma is issued before any invoice exists. */
function paymentClient(payment: Payment, email: string, fallbackName: string): Record<string, any> {
  const billing = readBilling(payment.billing);
  return withoutEmpty({
    name: billing?.name || fallbackName,
    cif: billing?.cui || null,
    rc: billing?.regCom || null,
    email: email || null,
    phone: billing?.phone || null,
    address: billing?.address || null,
    city: billing?.city || null,
    state: stateName(billing?.county),
    country: countryName(billing?.country),
    vatPayer: vatPayerFlag(billing?.cui),
    save: 0,
  });
}

/** One accounting line for the invoice, VAT excluded, price taken from the stored amounts. */
function invoiceProducts(invoice: Invoice): Record<string, any>[] {
  return [
    withoutEmpty({
      name: itemName(invoice),
      price: Number(invoice.subtotal.toFixed(2)),
      quantity: 1,
      measuringUnit: UNIT,
      currency: invoice.currency,
      vatName: config.oblio.vatName || null,
      vatPercentage: vatPercent(Number(invoice.taxRate)),
      vatIncluded: false,
      save: 0,
    }),
  ];
}

/** One accounting line for the proforma, VAT excluded: the consumer price includes the VAT. */
function paymentProducts(payment: Payment, videoTitle: string): Record<string, any>[] {
  const rate = config.company.vatRate;
  const total = Number(payment.amount.toFixed(2));
  const subtotal = Math.round((total / (1 + rate)) * 100) / 100;

  return [
    withoutEmpty({
      name: `Licență digitală streaming video - ${videoTitle}`.trim().slice(0, 2000),
      price: subtotal,
      quantity: 1,
      measuringUnit: UNIT,
      currency: payment.currency,
      vatName: config.oblio.vatName || null,
      vatPercentage: vatPercent(rate),
      vatIncluded: false,
      save: 0,
    }),
  ];
}

/** The payment of the invoice, through the purchase created at fulfillment. */
async function paymentForInvoice(invoice: Invoice): Promise<Payment | null> {
  const purchase = await db.purchase.findUnique({
    where: { id: invoice.purchaseId },
    select: { paymentId: true },
  });
  if (!purchase?.paymentId) return null;
  return db.payment.findUnique({ where: { id: purchase.paymentId } });
}

/**
 * Downloads the invoice PDF for the email attachment. Anything that is not a PDF
 * (wrong content type, too big, network error) returns null: the email is then sent
 * with the download link only.
 */
async function fetchPdf(url: string | null): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PDF_TIMEOUT_MS) });
    if (!response.ok) return null;
    if (!String(response.headers.get('content-type') || '').toLowerCase().includes('pdf')) return null;
    if (Number(response.headers.get('content-length') || 0) > PDF_MAX_BYTES) return null;

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > PDF_MAX_BYTES) return null;
    return bytes;
  } catch (err: any) {
    console.error('[OblioService] Could not download the invoice PDF:', err?.message);
    return null;
  }
}

/** Saves the step result and keeps the in-memory row in sync. */
async function save(invoice: Invoice, data: Prisma.InvoiceUpdateInput): Promise<void> {
  await db.invoice.update({ where: { id: invoice.id }, data });
  Object.assign(invoice, data);
}

/** A refused-but-not-blocking step: the flow continues, the admin reads the text in the panel. */
async function addWarning(invoice: Invoice, message: string): Promise<void> {
  await save(invoice, { fgoWarning: [invoice.fgoWarning, message].filter(Boolean).join(' ') });
}

function oblioUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

/**
 * One HTTP call, serialized with the others. No error is thrown here: the caller reads
 * the HTTP status and the parsed payload, so a 401 can still trigger a token refresh.
 */
async function send(
  method: string,
  path: string,
  body: RequestBody,
  token?: string
): Promise<{ status: number; payload: any }> {
  const wait = MIN_CALL_INTERVAL_MS - (Date.now() - lastCall);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastCall = Date.now();

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let bodyText: string | undefined;
  if (body.json) {
    headers['Content-Type'] = 'application/json';
    bodyText = JSON.stringify(body.json);
  } else if (body.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    bodyText = new URLSearchParams(body.form).toString();
  }

  let response: Response;
  try {
    response = await fetch(oblioUrl(path), {
      method,
      headers,
      body: bodyText,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    // Network failure or timeout: the very same request may be repeated later
    throw new OblioError({
      status: 0,
      retryable: true,
      message: `Oblio nu a putut fi contactat: ${err?.message || 'eroare de rețea'}`,
    });
  }

  const raw = await response.text();
  let payload: any = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  return { status: response.status, payload };
}

/** Maps an answer to OblioError: network / 5xx / 429 are retryable, a 400 is not. */
function assertOk(status: number, payload: any): void {
  const apiStatus = Number(payload?.status);
  const httpOk = status >= 200 && status < 300;
  if (httpOk && !(Number.isFinite(apiStatus) && apiStatus >= 400)) return;

  const effective = httpOk && Number.isFinite(apiStatus) ? apiStatus : status;
  throw new OblioError({
    status: effective,
    retryable: effective === 0 || effective >= 500 || effective === 429,
    message: String(payload?.statusMessage || payload?.message || `Oblio a răspuns cu eroarea HTTP ${status}.`),
  });
}

/** Reads the access token, cached in memory until 60s before it expires. */
async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

  const answer = await send('POST', '/authorize/token', {
    form: { client_id: config.oblio.email, client_secret: config.oblio.secret },
  });
  const data = answer.payload?.data ?? answer.payload;
  const value = typeof data?.access_token === 'string' ? data.access_token : '';
  if (!value) {
    throw new OblioError({
      status: answer.status || 0,
      retryable: answer.status === 0 || answer.status >= 500 || answer.status === 429,
      message: String(answer.payload?.statusMessage || 'Oblio nu a returnat un token de acces.'),
    });
  }

  // expires_in comes as a string, in seconds; the token is dropped 60s early
  const expiresInSeconds = Number(data?.expires_in ?? 0);
  cachedToken = {
    value,
    expiresAt: Date.now() + Math.max(expiresInSeconds * 1000 - 60_000, 0),
  };
  return value;
}

/**
 * One authenticated Oblio call. A 401 empties the token cache and the request is
 * repeated exactly once; success answers wrap the payload in `data`.
 */
async function request(method: string, path: string, body: RequestBody = {}): Promise<any> {
  if (!config.oblio.email || !config.oblio.secret) {
    throw new OblioError({
      status: 0,
      retryable: false,
      message: 'Oblio nu este configurat: lipsește emailul sau secretul din cont.',
    });
  }

  let answer = await send(method, path, body, await accessToken());
  if (answer.status === 401 || Number(answer.payload?.status) === 401) {
    cachedToken = null;
    answer = await send(method, path, body, await accessToken());
  }

  assertOk(answer.status, answer.payload);
  return answer.payload?.data ?? null;
}

/** A series of the given type (Factura / Proforma) exists in the Oblio nomenclature. */
function seriesExists(list: any[], serie: string, type: string): boolean {
  const name = serie.trim().toLowerCase();
  const wantedType = type.toLowerCase();

  return list.some(item => {
    const itemName = String(item?.name ?? item?.seriesName ?? '').trim().toLowerCase();
    const itemType = String(item?.type ?? '').trim().toLowerCase();
    return itemName === name && (!itemType || itemType === wantedType);
  });
}

export class OblioService {
  /**
   * Issues the proforma for a checkout that was just started. It never throws: a proforma
   * that Oblio refuses must not block the payment.
   */
  public static async createProforma(paymentId: string): Promise<void> {
    if (!config.oblio.enabled || !config.oblio.proformaSeries) return;

    try {
      const payment = await db.payment.findUnique({ where: { id: paymentId } });
      if (!payment || payment.proformaSerie) return;

      const [video, user] = await Promise.all([
        db.video.findUnique({ where: { id: payment.videoId }, select: { title: true } }),
        db.user.findUnique({ where: { id: payment.userId }, select: { email: true, username: true } }),
      ]);

      const body = {
        cif: config.oblio.cif,
        seriesName: config.oblio.proformaSeries,
        client: paymentClient(payment, user?.email ?? '', user?.username ?? 'Client'),
        products: paymentProducts(payment, video?.title ?? ''),
        currency: payment.currency,
        language: 'RO',
        precision: 2,
        mentions: `Comanda ${payment.id}`,
        // ponytail: semantica nu e documentată de Oblio, de verificat la primul test
        idempotencyKey: `pf-${payment.id}`,
      };

      const data = await request('POST', '/docs/proforma', { json: body });
      const serie = String(data?.seriesName || config.oblio.proformaSeries);
      const numar = String(data?.number ?? '');
      if (!serie || !numar) {
        // Without serie and number the invoice could not reference the proforma later
        throw new OblioError({
          status: 0,
          retryable: true,
          message: 'Oblio nu a returnat seria și numărul proformei emise.',
        });
      }

      const pdfUrl = typeof data?.link === 'string' && data.link ? data.link : null;

      await db.payment.update({
        where: { id: payment.id },
        data: { proformaSerie: serie, proformaNumar: numar || null, proformaPdfUrl: pdfUrl },
      });

      AuditService.logEvent({
        eventType: 'OBLIO_PROFORMA_ISSUED',
        userId: payment.userId,
        ip: 'system',
        userAgent: 'Oblio Invoice Service',
        metadata: { paymentId: payment.id, proformaSerie: serie, proformaNumar: numar },
      });
    } catch (err: any) {
      console.warn(`[OblioService] Proforma for payment ${paymentId} was not issued:`, err?.message);
    }
  }

  /**
   * Cancels the proformas left behind by checkouts that never got paid (25h old, still
   * PENDING). A proforma Oblio refuses with 400 is never retried; a temporary failure
   * waits for the next pass.
   */
  public static async cancelAbandonedProformas(): Promise<void> {
    if (!config.oblio.enabled) return;

    const cutoff = new Date(Date.now() - PROFORMA_ABANDON_MS);
    const abandoned = await db.payment.findMany({
      where: {
        status: 'PENDING',
        proformaSerie: { not: null },
        proformaCanceledAt: null,
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
      take: CANCEL_BATCH,
    });

    for (const payment of abandoned) {
      if (!payment.proformaSerie || !payment.proformaNumar) {
        // Without serie and number there is nothing to cancel in Oblio
        console.warn(`[OblioService] Payment ${payment.id} has no proforma number: it cannot be cancelled.`);
        continue;
      }

      try {
        await request('PUT', '/docs/proforma/cancel', {
          form: { cif: config.oblio.cif, seriesName: payment.proformaSerie, number: payment.proformaNumar },
        });
      } catch (err: any) {
        const refused = err instanceof OblioError && err.status === 400;
        if (!refused) {
          // Network / 5xx / 429: the same proforma is tried again on the next pass
          console.warn(
            `[OblioService] Proforma ${payment.proformaSerie}-${payment.proformaNumar} will be cancelled later:`,
            err?.message
          );
          continue;
        }
        // Oblio says the proforma cannot be cancelled any more: it is not tried again
        console.warn(
          `[OblioService] Proforma ${payment.proformaSerie}-${payment.proformaNumar} could not be cancelled:`,
          err?.message
        );
      }

      await db.payment.update({ where: { id: payment.id }, data: { proformaCanceledAt: new Date() } });

      AuditService.logEvent({
        eventType: 'OBLIO_PROFORMA_CANCELED',
        userId: payment.userId,
        ip: 'system',
        userAgent: 'Oblio Invoice Service',
        metadata: {
          paymentId: payment.id,
          proformaSerie: payment.proformaSerie,
          proformaNumar: payment.proformaNumar,
        },
      });
    }
  }

  /**
   * Sends one invoice through the whole Oblio flow. Calling it again after a failure
   * skips every step that is already done. Errors are thrown: the FGO queue records them.
   */
  public static async process(invoice: Invoice): Promise<void> {
    const payment = await paymentForInvoice(invoice);

    // a) Issue the fiscal invoice ------------------------------------------------
    if (!invoice.fgoSerie) {
      if (!payment) {
        throw new OblioError({
          status: 0,
          retryable: false,
          message: 'Factura nu are o plată asociată: nu poate fi emisă prin Oblio.',
        });
      }

      const body: Record<string, any> = withoutEmpty({
        cif: config.oblio.cif,
        seriesName: config.oblio.series,
        collect: {
          type: config.oblio.collectType,
          documentNumber: invoice.stripePaymentIntentId || payment.id,
          value: totalAmount(invoice),
        },
        mentions: `Comanda ${payment.id}`,
        // ponytail: semantica nu e documentată de Oblio, de verificat la primul test
        idempotencyKey: `inv-${invoice.id}`,
      });

      if (payment.proformaSerie && !payment.proformaCanceledAt) {
        // Oblio takes the client and the products from the proforma issued at checkout
        body.referenceDocument = withoutEmpty({
          type: 'Proforma',
          seriesName: payment.proformaSerie,
          number: payment.proformaNumar,
        });
      } else {
        body.client = invoiceClient(invoice);
        body.products = invoiceProducts(invoice);
        body.currency = invoice.currency;
        body.language = 'RO';
        body.precision = 2;
      }

      const issued = await request('POST', '/docs/invoice', { json: body });
      const serie = String(issued?.seriesName ?? '');
      const numar = String(issued?.number ?? '');
      if (!serie || !numar) {
        throw new OblioError({
          status: 0,
          retryable: true,
          message: 'Oblio nu a returnat seria și numărul facturii emise.',
        });
      }

      await save(invoice, {
        fgoSerie: serie,
        fgoNumar: numar,
        fgoPdfUrl: typeof issued?.link === 'string' && issued.link ? issued.link : null,
        invoiceNumber: `${serie}-${numar}`,
        // The payment is collected in this very request, so the invoice is paid already
        fgoPaidAt: new Date(),
      });
    }

    // Every following step needs the document number Oblio gave us
    if (!invoice.fgoSerie || !invoice.fgoNumar) {
      throw new OblioError({
        status: 0,
        retryable: true,
        message: 'Factura nu are serie și număr Oblio.',
      });
    }

    // b) Send the invoice to SPV (ANAF) ------------------------------------------
    if (config.oblio.sendSpv && !invoice.fgoSpvAt) {
      if (stripeTestMode()) {
        await addWarning(invoice, 'Mod test Stripe: nu se trimite în SPV');
      } else {
        const spv = await request('POST', '/docs/einvoice', {
          form: { cif: config.oblio.cif, seriesName: invoice.fgoSerie, number: invoice.fgoNumar },
        });
        const code = Number(spv?.code);

        if (code === 0 || code === 1) {
          await save(invoice, { fgoSpvAt: new Date() });
        } else if (code === 2) {
          await addWarning(invoice, `Factura nu a putut fi trimisă în SPV: ${String(spv?.text ?? 'eroare Oblio')}`);
        } else if (code === -1) {
          throw new OblioError({
            status: 0,
            retryable: true,
            message: 'Oblio nu a putut trimite factura în SPV: se reîncearcă.',
          });
        } else {
          throw new OblioError({
            status: 0,
            retryable: true,
            message: `Oblio a returnat un cod SPV necunoscut: ${String(spv?.code)}.`,
          });
        }
      }
    }

    // c) Email the PDF to the buyer ----------------------------------------------
    if (!invoice.invoiceEmailedAt) {
      const pdf = await fetchPdf(invoice.fgoPdfUrl);
      const sent = await EmailService.sendFgoInvoiceEmail(invoice, pdf, false);
      if (!sent) {
        throw new OblioError({
          status: 0,
          retryable: true,
          message: 'Emailul cu factura nu a putut fi trimis.',
        });
      }
      await save(invoice, { invoiceEmailedAt: new Date() });
    }

    // d) Storno (at the admin's request) -----------------------------------------
    if (invoice.fgoStornoWanted) {
      if (!invoice.fgoStornoDoneAt) {
        const storno = await request('POST', '/docs/invoice', {
          json: withoutEmpty({
            cif: config.oblio.cif,
            seriesName: config.oblio.stornoSeries || config.oblio.series,
            referenceDocument: {
              type: 'Factura',
              refund: 1,
              seriesName: invoice.fgoSerie,
              number: invoice.fgoNumar,
            },
            // ponytail: semantica nu e documentată de Oblio, de verificat la primul test
            idempotencyKey: `st-${invoice.id}`,
          }),
        });

        const stornoSerie = String(storno?.seriesName || config.oblio.stornoSeries || config.oblio.series || '');
        const stornoNumar = String(storno?.number ?? '');

        await save(invoice, {
          fgoStornoSerie: stornoSerie || null,
          fgoStornoNumar: stornoNumar || null,
          fgoStornoPdfUrl: typeof storno?.link === 'string' && storno.link ? storno.link : null,
          fgoStornoDoneAt: new Date(),
        });

        // The storno goes to SPV as well, with the same rules as the invoice
        if (config.oblio.sendSpv) {
          if (stripeTestMode()) {
            await addWarning(invoice, 'Mod test Stripe: storno nu se trimite în SPV');
          } else if (invoice.fgoStornoSerie && invoice.fgoStornoNumar) {
            try {
              const spv = await request('POST', '/docs/einvoice', {
                form: { cif: config.oblio.cif, seriesName: invoice.fgoStornoSerie, number: invoice.fgoStornoNumar },
              });
              const code = Number(spv?.code);
              if (code === 2) {
                await addWarning(invoice, `Storno nu a putut fi trimis în SPV: ${String(spv?.text ?? 'eroare Oblio')}`);
              } else if (code !== 0 && code !== 1) {
                await addWarning(invoice, `Storno nu a putut fi trimis în SPV: cod ${String(spv?.code)}.`);
              }
            } catch (err: any) {
              // There is no column to checkpoint the storno SPV, so a failure is only reported
              await addWarning(invoice, `Storno nu a putut fi trimis în SPV: ${err?.message || 'eroare necunoscută'}`);
            }
          }
        }
      }

      if (invoice.fgoStornoSerie && !invoice.stornoEmailedAt) {
        const pdf = await fetchPdf(invoice.fgoStornoPdfUrl);
        const sent = await EmailService.sendFgoInvoiceEmail(invoice, pdf, true);
        if (!sent) {
          throw new OblioError({
            status: 0,
            retryable: true,
            message: 'Emailul cu factura storno nu a putut fi trimis.',
          });
        }
        await save(invoice, { stornoEmailedAt: new Date() });
      }
    }

    // e) The invoice is completely handled ---------------------------------------
    await save(invoice, { fgoStatus: 'DONE', fgoError: null, fgoNextAttemptAt: null });
  }

  /** Reads the token and the series nomenclature, then checks the series used by the flow. */
  public static async testConnection(): Promise<{ ok: boolean; message: string }> {
    if (!config.oblio.email || !config.oblio.secret || !config.oblio.cif) {
      return {
        ok: false,
        message: 'Oblio nu este configurat: completează emailul, secretul și CIF-ul firmei.',
      };
    }

    try {
      const series = await request(
        'GET',
        `/nomenclature/series?cif=${encodeURIComponent(config.oblio.cif)}`
      );
      const list: any[] = Array.isArray(series) ? series : [];

      const checks: { label: string; serie: string; type: string }[] = [
        { label: 'seria de factură', serie: config.oblio.series, type: 'Factura' },
      ];
      if (config.oblio.proformaSeries) {
        checks.push({ label: 'seria de proformă', serie: config.oblio.proformaSeries, type: 'Proforma' });
      }
      if (config.oblio.stornoSeries) {
        checks.push({ label: 'seria de storno', serie: config.oblio.stornoSeries, type: 'Factura' });
      }

      const missing = checks
        .filter(item => !item.serie || !seriesExists(list, item.serie, item.type))
        .map(item => (item.serie ? `${item.label} "${item.serie}"` : `${item.label} (neconfigurată)`));

      if (missing.length) {
        return { ok: false, message: `Conexiune Oblio reușită, dar lipsește ${missing.join(', ')}.` };
      }

      return { ok: true, message: 'Conexiune Oblio reușită, cu toate seriile necesare.' };
    } catch (err: any) {
      return {
        ok: false,
        message: `Oblio nu a putut fi contactat: ${err?.message || 'eroare necunoscută'}`,
      };
    }
  }
}
