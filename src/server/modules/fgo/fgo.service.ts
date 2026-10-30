// ==============================================================================
// IV Concept VOD - FGO invoicing client (facturi fiscale emise prin API-ul FGO)
// Docs: https://api.fgo.ro - contul FGO -> Setări eCommerce -> API
// An invoice goes through a fixed list of steps. Every step is idempotent and saves
// its result immediately, so a retry continues from the first unfinished step.
// The API key is only ever put in the Authorization header: never logged, never stored.
// ==============================================================================

import crypto from 'crypto';
import type { Invoice, Prisma } from '@prisma/client';
import { config } from '../../config.ts';
import { db } from '../../db/index.ts';
import { AuditService } from '../audit/audit.service.ts';
import { EmailService } from '../email/email.service.ts';
import { SettingsService } from '../settings/settings.service.ts';

/** FGO accepts roughly one request per second: keep a hard minimum between two calls. */
const MIN_CALL_INTERVAL_MS = 1100;
const REQUEST_TIMEOUT_MS = 20_000;
const PDF_TIMEOUT_MS = 30_000;
const PDF_MAX_BYTES = 10 * 1024 * 1024;
/** Retry ladder in minutes; the last value repeats. */
const RETRY_DELAYS_MINUTES = [1, 5, 15, 60, 180, 360, 720];
const MAX_ATTEMPTS = 12;
/** Rights of the API key; the first three are mandatory for the whole flow. */
const FGO_RIGHTS = ['facturi:emitere', 'facturi:citire', 'facturi:anulare', 'facturi:incasare', 'facturi:spv'];
const BLOCKING_RIGHTS = ['facturi:emitere', 'facturi:citire', 'facturi:anulare'];

export interface FgoErrorDetails {
  message: string;
  /** HTTP status, or 0 when the request never reached FGO (network / timeout). */
  status: number;
  /** `motiv.cod` from the problem+json answer (e.g. factura_duplicata). */
  code?: string | null;
  /** `motiv.args` from the problem+json answer (e.g. the existing serie and numar). */
  args?: Record<string, any> | null;
  retryable: boolean;
  /** From the Retry-After header, on 429 answers. */
  retryAfterMs?: number;
}

/**
 * Error returned by the FGO API. `retryable` tells the queue whether the same request
 * may be repeated later (network, timeout, 5xx, 429) or will fail the same way forever.
 */
export class FgoError extends Error {
  public status: number;
  public code: string | null;
  public args: Record<string, any> | null;
  public retryable: boolean;
  public retryAfterMs: number;

  constructor(details: FgoErrorDetails) {
    super(details.message);
    this.name = 'FgoError';
    this.status = details.status;
    this.code = details.code ?? null;
    this.args = details.args ?? null;
    this.retryable = details.retryable;
    this.retryAfterMs = details.retryAfterMs ?? 0;
  }
}

/** Timestamp of the last API call; the requests are serialized through it. */
let lastCall = 0;

function isDigits(value: string): boolean {
  return /^\d+$/.test(value);
}

/** Today (or the given moment) in Romania, in the YYYY-MM-DD form FGO expects. */
function bucharestDate(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bucharest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** lastNumber + 1, keeping the width (000123 -> 000124). */
function nextNumber(lastNumber: string): string {
  return (BigInt(lastNumber) + BigInt(1)).toString().padStart(lastNumber.length, '0');
}

/** FGO takes at most 36 characters; longer ids are replaced by a stable sha1 prefix. */
function externalId(id: string): string {
  if (id.length <= 36) return id;
  return crypto.createHash('sha1').update(id).digest('hex').slice(0, 36);
}

/** Drops the null / undefined keys: FGO rejects them instead of ignoring them. */
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

/** Product name for the single FGO line, from the invoice items (FGO accepts at most 2000 characters). */
function itemName(invoice: Invoice): string {
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const names = items
    .map(item => (item && typeof item === 'object' ? String((item as any).description ?? '').trim() : ''))
    .filter(Boolean);
  return (names.length ? names.join(', ') : 'Licență digitală streaming video').slice(0, 2000);
}

function apiHostname(): string {
  try {
    return new URL(config.fgo.apiUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Only https links on fgo.ro / *.fgo.ro are accepted, plus the API host itself
 * (the FGO mock used in tests answers on the same host as apiUrl).
 */
function safeFgoUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol === 'https:' && (host === 'fgo.ro' || host.endsWith('.fgo.ro'))) return url.toString();
    if (host && host === apiHostname()) return url.toString();
    return null;
  } catch {
    return null;
  }
}

/** Retry-After, either in seconds or as an HTTP date. */
function retryAfterMs(response: Response): number {
  const raw = response.headers.get('retry-after');
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function fgoUrl(path: string): string {
  return `${config.fgo.apiUrl.replace(/\/$/, '')}${path}`;
}

function invoicePath(serie: string, numar: string): string {
  return `/v2/facturi/${encodeURIComponent(serie)}/${encodeURIComponent(numar)}`;
}

/**
 * One FGO call, serialized with the others and mapped to FgoError.
 * Success answers wrap the payload in `data`.
 */
async function request(method: string, path: string, body?: Record<string, any>): Promise<any> {
  if (!config.fgo.apiKey || !config.fgo.codUnic) {
    throw new FgoError({
      status: 0,
      retryable: false,
      message: 'FGO nu este configurat: lipsește cheia API sau codul unic al firmei.',
    });
  }

  const wait = MIN_CALL_INTERVAL_MS - (Date.now() - lastCall);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastCall = Date.now();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.fgo.apiKey}`,
    'Fgo-Cod-Unic': config.fgo.codUnic,
    'Content-Type': 'application/json',
  };
  // FGO checks the platform address on every write, not on reads
  if (method !== 'GET') headers['Fgo-Url-Platforma'] = config.fgo.platformUrl;

  let response: Response;
  try {
    response = await fetch(fgoUrl(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    // Network failure or timeout: the very same request may be repeated later
    throw new FgoError({
      status: 0,
      retryable: true,
      message: `FGO nu a putut fi contactat: ${err?.message || 'eroare de rețea'}`,
    });
  }

  const raw = await response.text();
  let payload: any = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    // application/problem+json: detail / title plus the per-field validation issues
    const problem: any = payload && typeof payload === 'object' ? payload : {};
    const issueMessages: string[] = [];
    for (const validationError of Array.isArray(problem.validation_errors) ? problem.validation_errors : []) {
      for (const issue of Array.isArray(validationError?.issues) ? validationError.issues : []) {
        if (issue?.message) issueMessages.push(String(issue.message));
      }
    }

    const detail = problem.detail || problem.title || `FGO a răspuns cu eroarea HTTP ${response.status}.`;
    throw new FgoError({
      status: response.status,
      code: problem.motiv?.cod ?? null,
      args: problem.motiv?.args ?? null,
      retryable: response.status >= 500 || response.status === 429,
      retryAfterMs: response.status === 429 ? retryAfterMs(response) : 0,
      message: [String(detail), ...issueMessages].join(' '),
    });
  }

  return payload?.data ?? null;
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

/**
 * Moves the local invoice counter forward and writes it in the same transaction as the invoice.
 * Returns true when the counter should move; the caller applies it to `config` after the commit.
 */
async function bumpLast(tx: Prisma.TransactionClient, serie: string, numar: string): Promise<boolean> {
  const lastNumber = config.fgo.lastNumber;
  if (!lastNumber || !isDigits(lastNumber)) return false;
  if (serie !== config.fgo.series) return false;
  if (!isDigits(numar) || BigInt(numar) <= BigInt(lastNumber)) return false;

  await SettingsService.storeInternal('FGO_LAST_NUMBER', numar, tx);
  return true;
}

/**
 * Downloads the invoice PDF for the email attachment. Any problem (wrong host, too big,
 * not a PDF) returns null: the email is then sent with the download link only.
 */
async function fetchPdf(url: string | null): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PDF_TIMEOUT_MS) });
    if (!response.ok) return null;
    // fetch follows redirects, so the final address is the one that has to be checked
    if (!safeFgoUrl(response.url)) return null;
    if (Number(response.headers.get('content-length') || 0) > PDF_MAX_BYTES) return null;

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > PDF_MAX_BYTES) return null;
    if (bytes.subarray(0, 4).toString('latin1') !== '%PDF') return null;
    return bytes;
  } catch (err: any) {
    console.error('[FgoService] Could not download the invoice PDF:', err?.message);
    return null;
  }
}

/** 1, 5, 15, 60, 180, 360, 720 minutes; a 429 answer can push the next attempt further. */
function retryDelayMs(attempts: number, err: any): number {
  const index = Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MINUTES.length - 1);
  const base = RETRY_DELAYS_MINUTES[index] * 60_000;
  const retryAfter = err instanceof FgoError && err.status === 429 ? err.retryAfterMs : 0;
  return Math.max(base, retryAfter || 0);
}

export class FgoService {
  /** True while the queue is being processed (a single worker, see kick). */
  private static running = false;
  /** A kick that arrived during a run must not be lost. */
  private static rerun = false;

  /**
   * Runs the due invoices once: FGO enabled, one worker at a time, oldest invoice first.
   */
  // ponytail: un singur proces, coadă în memorie; lock în DB dacă rulezi mai multe instanțe.
  public static async processDue(): Promise<void> {
    if (!config.fgo.enabled) return;

    if (FgoService.running) {
      FgoService.rerun = true;
      return;
    }
    FgoService.running = true;

    try {
      do {
        FgoService.rerun = false;
        await FgoService.runQueue();
      } while (FgoService.rerun);
    } finally {
      FgoService.running = false;
    }
  }

  /** Fire-and-forget start, used by the timer and by the admin actions. */
  public static kick(): void {
    FgoService.processDue().catch(err => console.error('[FgoService] processDue failed:', err));
  }

  /**
   * Waits for the running queue pass to finish, so a shutdown never cuts an invoice in half.
   * Gives up after 10s: the database connection is closed right after this returns.
   */
  public static async waitIdle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (FgoService.running && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Sends one invoice through the whole FGO flow. Calling it again after a failure
   * skips every step that is already done.
   */
  public static async process(invoice: Invoice): Promise<void> {
    // 1. Issue the fiscal invoice ------------------------------------------------
    if (!invoice.fgoSerie) {
      const lastNumber = config.fgo.lastNumber;
      const body = withoutEmpty({
        serie: config.fgo.series,
        numar: isDigits(lastNumber) ? nextNumber(lastNumber) : null,
        valuta: invoice.currency.toUpperCase(),
        tip_factura: config.fgo.invoiceType,
        data_emitere: bucharestDate(),
        id_extern: externalId(invoice.id),
        verificare_duplicat: true,
        client: withoutEmpty({
          tip: invoice.buyerType || 'PF',
          denumire: invoice.buyerName,
          cod_unic: invoice.buyerCui,
          nr_reg_com: invoice.buyerRegCom,
          email: invoice.buyerEmail,
          telefon: invoice.buyerPhone,
          tara: invoice.buyerCountry,
          cod_judet: invoice.buyerCounty,
          localitate: invoice.buyerCity,
          adresa: invoice.buyerAddress,
        }),
        articole: [
          {
            denumire: itemName(invoice),
            nr_produse: 1,
            pret_total: totalAmount(invoice),
            cota_tva: Number(invoice.taxRate),
            um: config.fgo.um,
          },
        ],
      });

      let issued: any;
      try {
        issued = await request('POST', '/v2/facturi', body);
      } catch (err: any) {
        // The invoice exists already in FGO: its number from the answer is the real one
        const duplicate = err instanceof FgoError && err.code === 'factura_duplicata';
        if (!duplicate || !err.args?.serie || !err.args?.numar) throw err;
        issued = { serie: err.args.serie, numar: err.args.numar };
      }

      const serie = String(issued?.serie ?? '');
      const numar = String(issued?.numar ?? '');
      if (!serie || !numar) {
        throw new FgoError({
          status: 0,
          retryable: true,
          message: 'FGO nu a returnat seria și numărul facturii emise.',
        });
      }

      // The invoice and the counter row are written together, or not at all
      const moved = await db.$transaction(async tx => {
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { fgoSerie: serie, fgoNumar: numar, invoiceNumber: `${serie}-${numar}` },
        });
        return bumpLast(tx, serie, numar);
      });

      Object.assign(invoice, { fgoSerie: serie, fgoNumar: numar, invoiceNumber: `${serie}-${numar}` });
      // The counter in memory moves only after the commit above
      if (moved) SettingsService.applyInternal('FGO_LAST_NUMBER', numar);
    }

    // Every following step needs the document number FGO gave us
    if (!invoice.fgoSerie || !invoice.fgoNumar) {
      throw new FgoError({
        status: 0,
        retryable: true,
        message: 'Factura nu are serie și număr FGO.',
      });
    }

    const documentPath = invoicePath(invoice.fgoSerie, invoice.fgoNumar);
    const total = totalAmount(invoice);

    // 2. Register the payment ----------------------------------------------------
    if (!invoice.fgoPaidAt) {
      try {
        const payment = await request('GET', `${documentPath}?fields=valoare_achitata`);
        const alreadyPaid = Number(payment?.valoare_achitata ?? 0) >= total;

        if (!alreadyPaid) {
          await request('POST', `${documentPath}/incasari`, {
            suma_incasata: total,
            data_incasare: bucharestDate(invoice.issuedAt),
            tip_incasare: config.fgo.paymentType,
          });
        }
        await save(invoice, { fgoPaidAt: new Date() });
      } catch (err: any) {
        // A payment FGO refuses must not block the PDF and the email
        if (err instanceof FgoError && !err.retryable) {
          await addWarning(invoice, `Încasarea nu a putut fi înregistrată: ${err.message}`);
        } else {
          throw err;
        }
      }
    }

    // 3. Download link for the PDF -----------------------------------------------
    if (!invoice.fgoPdfUrl) {
      const download = await request('POST', `${documentPath}/genereaza-link-de-descarcare`);
      const url = safeFgoUrl(download?.link);
      if (!url) {
        throw new FgoError({
          status: 0,
          retryable: true,
          message: 'FGO a returnat un link de descărcare neașteptat.',
        });
      }
      await save(invoice, { fgoPdfUrl: url });
    }

    // 4. Send the invoice to SPV (ANAF) ------------------------------------------
    if (config.fgo.sendSpv && !invoice.fgoSpvAt) {
      try {
        await request('POST', `${documentPath}/trimite-in-spv`);
        await save(invoice, { fgoSpvAt: new Date() });
      } catch (err: any) {
        const alreadySent =
          err instanceof FgoError && err.status === 400 && err.message.toLowerCase().includes('trimisa deja');

        if (alreadySent) {
          await save(invoice, { fgoSpvAt: new Date() });
        } else if (err instanceof FgoError && !err.retryable) {
          await addWarning(invoice, `Factura nu a putut fi trimisă în SPV: ${err.message}`);
        } else {
          throw err;
        }
      }
    }

    // 5. Email the PDF to the buyer ----------------------------------------------
    if (!invoice.invoiceEmailedAt) {
      const pdf = await fetchPdf(invoice.fgoPdfUrl);
      const sent = await EmailService.sendFgoInvoiceEmail(invoice, pdf, false);
      if (!sent) {
        throw new FgoError({
          status: 0,
          retryable: true,
          message: 'Emailul cu factura nu a putut fi trimis.',
        });
      }
      await save(invoice, { invoiceEmailedAt: new Date() });
    }

    // 6. Storno (at the admin's request) -----------------------------------------
    if (invoice.fgoStornoWanted) {
      if (!invoice.fgoStornoDoneAt) {
        // numar_storno only belongs to the counter series, and only when the counter is known
        const sameSeries = Boolean(config.fgo.stornoSeries) && config.fgo.stornoSeries === config.fgo.series;
        const stornoNumar =
          sameSeries && config.fgo.lastNumber && isDigits(config.fgo.lastNumber)
            ? nextNumber(config.fgo.lastNumber)
            : null;

        const stornoBody = withoutEmpty({
          serie_storno: config.fgo.stornoSeries || null,
          numar_storno: stornoNumar,
          data_emitere: bucharestDate(),
        });

        let storno: any = null;
        try {
          storno = await request('POST', `${documentPath}/storneaza`, stornoBody);
        } catch (err: any) {
          const alreadyStorno = err instanceof FgoError && err.status === 400 && err.code === 'stare_nepermisa';
          if (!alreadyStorno) throw err;

          // FGO says the invoice is storno'd or cancelled already: nothing left to issue
          await save(invoice, { fgoStornoDoneAt: new Date() });
          await addWarning(invoice, 'Factura era deja stornată sau anulată în FGO');
        }

        if (storno) {
          const stornoSerie = String(storno.serie ?? '');
          const stornoSavedNumar = String(storno.numar ?? '');
          const stornoDoneAt = new Date();

          const moved = await db.$transaction(async tx => {
            await tx.invoice.update({
              where: { id: invoice.id },
              data: {
                fgoStornoSerie: stornoSerie || null,
                fgoStornoNumar: stornoSavedNumar || null,
                fgoStornoDoneAt: stornoDoneAt,
              },
            });
            if (!stornoSerie || !stornoSavedNumar) return false;
            return bumpLast(tx, stornoSerie, stornoSavedNumar);
          });

          Object.assign(invoice, {
            fgoStornoSerie: stornoSerie || null,
            fgoStornoNumar: stornoSavedNumar || null,
            fgoStornoDoneAt: stornoDoneAt,
          });
          if (moved) SettingsService.applyInternal('FGO_LAST_NUMBER', stornoSavedNumar);
        }
      }

      // The storno document needs its own download link
      if (invoice.fgoStornoSerie && invoice.fgoStornoNumar && !invoice.fgoStornoPdfUrl) {
        const download = await request(
          'POST',
          `${invoicePath(invoice.fgoStornoSerie, invoice.fgoStornoNumar)}/genereaza-link-de-descarcare`
        );
        const url = safeFgoUrl(download?.link);
        if (!url) {
          throw new FgoError({
            status: 0,
            retryable: true,
            message: 'FGO a returnat un link de descărcare neașteptat pentru storno.',
          });
        }
        await save(invoice, { fgoStornoPdfUrl: url });
      }

      if (invoice.fgoStornoSerie && !invoice.stornoEmailedAt) {
        const pdf = await fetchPdf(invoice.fgoStornoPdfUrl);
        const sent = await EmailService.sendFgoInvoiceEmail(invoice, pdf, true);
        if (!sent) {
          throw new FgoError({
            status: 0,
            retryable: true,
            message: 'Emailul cu factura storno nu a putut fi trimis.',
          });
        }
        await save(invoice, { stornoEmailedAt: new Date() });
      }
    }

    await save(invoice, { fgoStatus: 'DONE', fgoError: null, fgoNextAttemptAt: null });
  }

  /** Puts a failed invoice back at the head of the queue. */
  public static async retry(id: string): Promise<void> {
    await db.invoice.update({
      where: { id },
      data: { fgoStatus: 'PENDING', fgoAttempts: 0, fgoNextAttemptAt: null, fgoError: null },
    });
    FgoService.kick();
  }

  /** Asks for a storno; the queue issues it on the next run. */
  public static async requestStorno(id: string): Promise<void> {
    const invoice = await db.invoice.findUnique({ where: { id }, select: { id: true, fgoStatus: true } });
    if (!invoice) throw new Error('Factura nu există.');
    if (!invoice.fgoStatus) {
      throw new Error('Factura nu a fost emisă prin FGO, deci nu poate fi stornată.');
    }

    await db.invoice.update({ where: { id }, data: { fgoStornoWanted: true, fgoStatus: 'PENDING' } });
    FgoService.kick();
  }

  /** Sends the invoice email again, with the PDF when it can still be downloaded. */
  public static async resendEmail(id: string): Promise<boolean> {
    const invoice = await db.invoice.findUnique({ where: { id } });
    if (!invoice) throw new Error('Factura nu există.');
    if (!invoice.fgoPdfUrl) throw new Error('Factura nu are încă un PDF emis de FGO.');

    const pdf = await fetchPdf(invoice.fgoPdfUrl);
    return EmailService.sendFgoInvoiceEmail(invoice, pdf, false);
  }

  /**
   * Reads the FGO identity: the company the key belongs to and its rights.
   * The invoice cannot be issued without emitere / citire / anulare.
   */
  public static async testConnection(): Promise<{
    ok: boolean;
    message: string;
    details?: { drepturi: string[]; lipsa: string[] };
  }> {
    if (!config.fgo.apiKey || !config.fgo.codUnic) {
      return { ok: false, message: 'FGO nu este configurat: completează cheia API și codul unic al firmei.' };
    }

    try {
      const identity = await request('GET', '/v2/identitate');
      const drepturi = (Array.isArray(identity?.drepturi) ? identity.drepturi : []).map(String);
      const lipsa = FGO_RIGHTS.filter(right => !drepturi.includes(right));
      const details = { drepturi, lipsa };

      const blocante = BLOCKING_RIGHTS.filter(right => lipsa.includes(right));
      if (blocante.length) {
        return {
          ok: false,
          message: `Cheia API nu are drepturile necesare: ${blocante.join(', ')}.`,
          details,
        };
      }

      return {
        ok: true,
        message: lipsa.length
          ? `Conexiune reușită, dar lipsesc drepturile: ${lipsa.join(', ')}.`
          : 'Conexiune FGO reușită, cu toate drepturile necesare.',
        details,
      };
    } catch (err: any) {
      return { ok: false, message: `FGO nu a putut fi contactat: ${err?.message || 'eroare necunoscută'}` };
    }
  }

  /** Reads the due invoices and processes them one by one, so one failure never stops the rest. */
  private static async runQueue(): Promise<void> {
    const due = await db.invoice.findMany({
      where: {
        fgoStatus: 'PENDING',
        OR: [{ fgoNextAttemptAt: null }, { fgoNextAttemptAt: { lte: new Date() } }],
      },
      orderBy: { seq: 'asc' },
      take: 20,
    });

    for (const invoice of due) {
      try {
        await FgoService.process(invoice);
      } catch (err: any) {
        await FgoService.recordFailure(invoice, err);
      }
    }
  }

  /** Counts the failure, schedules the next attempt, or marks the invoice as failed for good. */
  private static async recordFailure(invoice: Invoice, err: any): Promise<void> {
    const fgoError = err?.message || 'Eroare necunoscută la facturarea FGO.';
    const attempts = invoice.fgoAttempts + 1;
    // Anything that is not an explicit non-retryable FgoError is treated as temporary
    const retryable = !(err instanceof FgoError) || err.retryable;

    if (!retryable || attempts >= MAX_ATTEMPTS) {
      await db.invoice.update({
        where: { id: invoice.id },
        data: { fgoStatus: 'FAILED', fgoError, fgoAttempts: attempts, fgoNextAttemptAt: null },
      });
      console.error(`[FgoService] Invoice ${invoice.id} failed permanently:`, fgoError);

      AuditService.logEvent({
        eventType: 'FGO_INVOICE_FAILED',
        severity: 'CRITICAL',
        userId: invoice.userId,
        purchaseId: invoice.purchaseId,
        ip: 'system',
        userAgent: 'FGO Invoice Service',
        metadata: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, attempts, error: fgoError },
      });
      return;
    }

    const delay = retryDelayMs(attempts, err);
    await db.invoice.update({
      where: { id: invoice.id },
      data: { fgoAttempts: attempts, fgoNextAttemptAt: new Date(Date.now() + delay), fgoError },
    });
    console.error(`[FgoService] Invoice ${invoice.id} will be retried in ${Math.round(delay / 60_000)} min:`, fgoError);
  }
}
