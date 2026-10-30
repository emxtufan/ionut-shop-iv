// ==============================================================================
// IV Concept VOD - Admin settings API (SUPER_ADMIN only)
// Exposes the admin-editable settings and the "test connection" actions for the
// external services. Secret values are never returned: only the masked preview
// computed by SettingsService. Every test answers 200 with {ok:false, message}
// instead of leaking a stack trace or a key.
// ==============================================================================

import type { Request, Response } from 'express';
import Stripe from 'stripe';
import { config } from '../../config.ts';
import { AuditService } from '../audit/audit.service.ts';
import { EmailService } from '../email/email.service.ts';
import { PaymentsService } from '../payments/payments.service.ts';
import { SettingsService } from './settings.service.ts';

const BUNNY_API_BASE = 'https://video.bunnycdn.com/library';
const BUNNY_TEST_MESSAGE = 'ID-ul bibliotecii sau cheia API e greșită.';
const STRIPE_WEBHOOK_EXISTS_MESSAGE =
  'Webhook-ul există deja. Dacă ai pierdut secretul, șterge-l din Stripe și creează-l din nou.';
const APP_URL_HTTPS_MESSAGE =
  'Adresa site-ului trebuie să înceapă cu https:// pentru ca Stripe să accepte webhook-ul. Setează adresa corectă în câmpul „Adresa site-ului” și salvează.';

// Exactly the events handled by PaymentsService.processPaymentWebhook
const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'invoice.paid',
  'charge.refunded',
  'charge.dispute.created',
] as const;

function auditContext(req: Request) {
  return {
    adminId: (req as any).user.id as string,
    ip: req.ip || 'unknown',
    userAgent: req.headers['user-agent'] || '',
  };
}

/** Error text safe to show in the admin panel: no stack, no key fragment. */
function safeErrorMessage(err: any): string {
  const raw = typeof err?.message === 'string' ? err.message.split('\n')[0] : '';
  const cleaned = raw.replace(/\b(sk|pk|rk|whsec)_[A-Za-z0-9_]+/g, '***').trim();
  return cleaned || 'Testul a eșuat.';
}

function stripeClient(): Stripe {
  const key = config.stripe.secretKey;
  if (!key) throw new Error('Cheia secretă Stripe nu este configurată.');
  return new Stripe(key);
}

export class SettingsController {
  /**
   * Every setting with its state (secrets masked) plus the non-configurable infrastructure values
   */
  public static async getSettings(req: Request, res: Response) {
    return res.json({
      settings: await SettingsService.list(),
      infrastructure: {
        nodeEnv: process.env.NODE_ENV || 'development',
        port: config.port,
        trustProxyHops: config.trustProxyHops,
        uploadDir: config.uploadDir,
      },
    });
  }

  /**
   * Saves overrides; `null` removes one and falls back to the environment value
   */
  public static async updateSettings(req: Request, res: Response) {
    const values = req.body?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return res.status(400).json({
        error: 'MISSING_FIELDS',
        message: 'Lipsește obiectul `values` cu setările de salvat.',
      });
    }

    try {
      await SettingsService.update(values, (req as any).user.id);
    } catch (err: any) {
      // Unknown key or failed validation: SettingsService tags the error with the key
      if (err?.key) {
        return res.status(400).json({ error: 'INVALID_SETTING', key: err.key, message: err.message });
      }
      throw err;
    }

    // Only the names of the changed keys are recorded, never the values
    AuditService.logEvent({
      eventType: 'ADMIN_UPDATED_SETTINGS',
      ...auditContext(req),
      metadata: { keys: Object.keys(values) },
    });

    return res.json({ settings: await SettingsService.list() });
  }

  /**
   * Reads one page (1 video) from the Bunny Stream library with the stored library id + API key
   */
  public static async testBunny(req: Request, res: Response) {
    const { libraryId, apiKey } = config.bunny;
    if (!libraryId || !apiKey) {
      return res.json({
        ok: false,
        message: 'Bunny Stream nu este configurat: completează ID-ul bibliotecii și cheia API.',
      });
    }

    try {
      const response = await fetch(`${BUNNY_API_BASE}/${encodeURIComponent(libraryId)}/videos?page=1&itemsPerPage=1`, {
        headers: { AccessKey: apiKey, accept: 'application/json' },
      });

      if (response.status === 401) {
        return res.json({ ok: false, message: BUNNY_TEST_MESSAGE });
      }
      if (!response.ok) {
        return res.json({ ok: false, message: `Bunny Stream a răspuns cu eroarea HTTP ${response.status}.` });
      }

      const data = await response.json();
      const videos = Number(data?.totalItems || 0);
      return res.json({
        ok: true,
        message: `Conexiune reușită. Biblioteca conține ${videos} videoclipuri.`,
        details: { videos },
      });
    } catch (err: any) {
      return res.json({ ok: false, message: `Bunny Stream nu a putut fi contactat: ${safeErrorMessage(err)}` });
    }
  }

  /**
   * Checks the Stripe key (account + payout status) and whether our webhook endpoint exists
   */
  public static async testStripe(req: Request, res: Response) {
    const webhookUrl = `${config.appUrl}/api/payments/webhook`;

    try {
      const stripe = stripeClient();
      const [account, endpoints] = await Promise.all([
        stripe.accounts.retrieveCurrent(),
        stripe.webhookEndpoints.list({ limit: 100 }),
      ]);

      const mode = PaymentsService.getPaymentConfig().mode;
      const webhookConfigured = endpoints.data.some(endpoint => endpoint.url === webhookUrl);
      const webhookSecretSet = Boolean(config.stripe.webhookSecret);

      const parts = [
        `Cheia Stripe (${mode === 'live' ? 'mod live, bani reali' : 'mod test'}) este validă`,
        account.charges_enabled ? 'plățile sunt active' : 'plățile nu sunt încă activate pe acest cont',
        webhookConfigured ? 'webhook-ul există' : 'webhook-ul nu există încă',
        webhookSecretSet ? 'secretul este salvat' : 'secretul webhook-ului lipsește',
      ];

      return res.json({
        ok: true,
        message: `${parts.join(', ')}.`,
        details: {
          mode,
          chargesEnabled: Boolean(account.charges_enabled),
          payoutsEnabled: Boolean(account.payouts_enabled),
          webhookUrl,
          webhookConfigured,
          webhookSecretSet,
        },
      });
    } catch (err: any) {
      return res.json({ ok: false, message: `Stripe a răspuns cu eroare: ${safeErrorMessage(err)}` });
    }
  }

  /**
   * Verifies the SMTP handshake with the settings currently in effect
   */
  public static async testSmtp(req: Request, res: Response) {
    try {
      return res.json(await EmailService.verifySmtp());
    } catch (err: any) {
      return res.json({ ok: false, message: `Emailul nu a putut fi verificat: ${safeErrorMessage(err)}` });
    }
  }

  /**
   * Creates the Stripe webhook endpoint for ${APP_URL}/api/payments/webhook and stores its secret
   */
  public static async createStripeWebhook(req: Request, res: Response) {
    const appUrl = config.appUrl.replace(/\/$/, '');
    if (!/^https:\/\//i.test(appUrl)) {
      return res.status(400).json({ error: 'APP_URL_NOT_HTTPS', message: APP_URL_HTTPS_MESSAGE });
    }

    const webhookUrl = `${appUrl}/api/payments/webhook`;

    try {
      const stripe = stripeClient();

      const existing = await stripe.webhookEndpoints.list({ limit: 100 });
      if (existing.data.some(endpoint => endpoint.url === webhookUrl)) {
        return res.status(409).json({ error: 'WEBHOOK_ALREADY_EXISTS', message: STRIPE_WEBHOOK_EXISTS_MESSAGE });
      }

      const endpoint = await stripe.webhookEndpoints.create({
        url: webhookUrl,
        enabled_events: [...WEBHOOK_EVENTS],
        description: 'IV Concept - plăți',
      });

      // The secret is stored encrypted and never sent back to the browser
      if (!endpoint.secret) throw new Error('Stripe nu a returnat secretul webhook-ului.');
      await SettingsService.update({ STRIPE_WEBHOOK_SECRET: endpoint.secret }, (req as any).user.id);

      AuditService.logEvent({
        eventType: 'ADMIN_CREATED_STRIPE_WEBHOOK',
        ...auditContext(req),
        metadata: { webhookUrl, webhookEndpointId: endpoint.id, events: [...WEBHOOK_EVENTS] },
      });

      return res.json({
        ok: true,
        message: 'Webhook-ul a fost creat în Stripe, iar secretul lui a fost salvat în setări.',
        details: { webhookUrl, webhookEndpointId: endpoint.id, events: [...WEBHOOK_EVENTS] },
      });
    } catch (err: any) {
      return res.json({ ok: false, message: `Webhook-ul nu a putut fi creat: ${safeErrorMessage(err)}` });
    }
  }
}
