// ==============================================================================
// IV Concept VOD - Payments, Entitlements & Stripe Checkout Service
// ==============================================================================

import Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { db } from '../../db/index.ts';
import { config } from '../../config.ts';
import { AuditService } from '../audit/audit.service.ts';
import { EmailService } from '../email/email.service.ts';
import { toPublicUser } from '../auth/auth.service.ts';

// Stripe client is built lazily and cached per secret key, so a key saved from the
// admin panel takes effect without a restart.
let cachedStripe: { key: string; client: Stripe } | null = null;

function getStripe(): Stripe {
  const key = config.stripe.secretKey;
  if (!key) throw new Error('PAYMENTS_NOT_CONFIGURED');
  if (!cachedStripe || cachedStripe.key !== key) {
    cachedStripe = { key, client: new Stripe(key) };
  }
  return cachedStripe.client;
}

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

export class PaymentsService {
  /**
   * Returns current payment gateway mode for the client UI
   */
  public static getPaymentConfig() {
    return {
      mode: config.stripe.secretKey.startsWith('sk_live_') ? 'live' : 'test',
      currency: config.stripe.currency,
    };
  }

  /**
   * Creates a Stripe Checkout session for a video. Price always comes from the database.
   * Anti double-charge: an open session for the same user + video at the current price is reused,
   * and Stripe's idempotency key collapses concurrent clicks inside the same minute into one session.
   */
  public static async createCheckoutSession(params: {
    userId: string;
    videoId: string;
    ip: string;
    userAgent: string;
    acceptedTerms: boolean;
  }): Promise<{ checkoutUrl: string }> {
    if (params.acceptedTerms !== true) throw new Error('TERMS_NOT_ACCEPTED');
    if (!config.stripe.secretKey) throw new Error('PAYMENTS_NOT_CONFIGURED');

    const user = await db.user.findUnique({ where: { id: params.userId } });
    if (!user) throw new Error('USER_NOT_FOUND');

    const video = await db.video.findUnique({ where: { id: params.videoId } });
    if (!video || !video.isPublished || video.status !== 'READY') throw new Error('VIDEO_NOT_FOUND');

    const existing = await db.entitlement.findUnique({
      where: { userId_videoId: { userId: user.id, videoId: video.id } },
    });
    if (existing?.status === 'ACTIVE') throw new Error('ALREADY_PURCHASED');

    const amountInSubunits = Math.round(video.priceAmount.toNumber() * 100); // Stripe expects bani/cents
    const acceptedAt = new Date();

    // 1. Reuse the newest PENDING session if Stripe still has it open at the current price
    const pendingPayment = await db.payment.findFirst({
      where: { userId: user.id, videoId: video.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });

    if (pendingPayment) {
      try {
        const openSession = await getStripe().checkout.sessions.retrieve(pendingPayment.checkoutSessionId);
        if (openSession.status === 'open' && openSession.amount_total === amountInSubunits && openSession.url) {
          // Consent was given again on this request; a Purchase row only exists after a payment
          await db.purchase.updateMany({
            where: { paymentId: pendingPayment.id },
            data: { withdrawalWaiverAt: acceptedAt },
          });

          AuditService.logEvent({
            eventType: 'PURCHASE_STARTED',
            userId: user.id,
            videoId: video.id,
            ip: params.ip,
            userAgent: params.userAgent,
            metadata: {
              amount: video.priceAmount.toNumber(),
              currency: video.currency,
              checkoutSessionId: openSession.id,
              reusedSession: true,
            },
          });

          return { checkoutUrl: openSession.url };
        }
      } catch (err) {
        // Session expired or unknown on Stripe's side: fall through and create a fresh one
        console.error('[PaymentsService] Could not retrieve pending checkout session', pendingPayment.checkoutSessionId, err);
      }
    }

    const thumbnail = video.thumbnailUrl.startsWith('/') ? `${config.appUrl}${video.thumbnailUrl}` : video.thumbnailUrl;

    // 2. Identical parameters for every request inside the same minute, plus a per-minute idempotency key
    const bucket = Math.floor(Date.now() / 60000);
    const session = await getStripe().checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: video.currency.toLowerCase(),
              product_data: {
                name: video.title,
                description: video.description ? video.description.slice(0, 200) : undefined,
                images: thumbnail.startsWith('https://') ? [thumbnail] : undefined,
              },
              unit_amount: amountInSubunits,
            },
            quantity: 1,
          },
        ],
        customer_email: user.email,
        invoice_creation: { enabled: true },
        expires_at: (bucket + 1) * 60 + 1800,
        success_url: `${config.appUrl}/?session_id={CHECKOUT_SESSION_ID}&stripe_payment=success&video_id=${video.id}`,
        cancel_url: `${config.appUrl}/?stripe_payment=cancelled`,
        metadata: { userId: user.id, videoId: video.id },
      },
      { idempotencyKey: `checkout:${user.id}:${video.id}:${bucket}` }
    );

    // 3. Idempotent write keyed on the Stripe session id: concurrent requests share one row, no error
    await db.payment.createMany({
      data: [
        {
          checkoutSessionId: session.id,
          userId: user.id,
          videoId: video.id,
          amount: video.priceAmount,
          currency: video.currency,
        },
      ],
      skipDuplicates: true,
    });
    const payment = await db.payment.findUniqueOrThrow({ where: { checkoutSessionId: session.id } });
    await db.purchase.updateMany({ where: { paymentId: payment.id }, data: { withdrawalWaiverAt: acceptedAt } });

    AuditService.logEvent({
      eventType: 'PURCHASE_STARTED',
      userId: user.id,
      videoId: video.id,
      ip: params.ip,
      userAgent: params.userAgent,
      metadata: { amount: video.priceAmount.toNumber(), currency: video.currency, checkoutSessionId: session.id },
    });

    if (!session.url) throw new Error('STRIPE_CHECKOUT_URL_MISSING');
    return { checkoutUrl: session.url };
  }

  /**
   * Verifies a completed Stripe Checkout session when the customer returns from Stripe.
   * The webhook fulfills the same session; whichever arrives first wins, the other is a no-op.
   */
  public static async verifyAndFulfillStripeSession(
    sessionId: string,
    currentUserId: string,
    ip: string
  ): Promise<{ success: boolean; videoId?: string; message?: string }> {
    if (!config.stripe.secretKey) throw new Error('PAYMENTS_NOT_CONFIGURED');
    const session = await getStripe().checkout.sessions.retrieve(sessionId);

    if (session.metadata?.userId !== currentUserId) {
      return { success: false, message: 'Sesiunea de plată nu aparține contului curent.' };
    }
    if (session.payment_status !== 'paid') {
      return { success: false, message: 'Plata nu a fost confirmată încă de către Stripe.' };
    }

    await this.fulfillCheckoutSession(session, ip);
    return { success: true, videoId: session.metadata.videoId };
  }

  /**
   * Atomically marks the payment PAID, creates the purchase, grants the entitlement and issues the invoice.
   * Idempotent: only the first caller for a given checkout session does any work.
   */
  public static async fulfillCheckoutSession(session: Stripe.Checkout.Session, ip: string): Promise<{ status: string }> {
    const userId = session.metadata?.userId;
    const videoId = session.metadata?.videoId;
    if (!userId || !videoId) throw new Error('MISSING_SESSION_METADATA');

    const paymentIntentId = idOf(session.payment_intent);
    const stripeInvoiceId = idOf(session.invoice);
    const amount = new Prisma.Decimal((session.amount_total ?? 0) / 100);
    const currency = (session.currency || config.stripe.currency).toUpperCase();

    let stripeHostedInvoiceUrl: string | null = null;
    if (stripeInvoiceId) {
      try {
        stripeHostedInvoiceUrl = (await getStripe().invoices.retrieve(stripeInvoiceId)).hosted_invoice_url ?? null;
      } catch (err) {
        console.error('[PaymentsService] Could not load Stripe invoice', stripeInvoiceId, err);
      }
    }

    // Normally created at checkout start; INSERT ... ON CONFLICT DO NOTHING covers the rare case it is missing
    await db.payment.createMany({
      data: [{ checkoutSessionId: session.id, userId, videoId, amount, currency }],
      skipDuplicates: true,
    });

    // Any error here propagates so Stripe retries the webhook
    const result = await db.$transaction(async tx => {
      const payment = await tx.payment.findUniqueOrThrow({ where: { checkoutSessionId: session.id } });

      // Row-level guard: a concurrent fulfillment of the same session waits here, then updates 0 rows
      const { count } = await tx.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'PAID', paymentIntentId, amount, currency },
      });
      if (count === 0) return null;

      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      const video = await tx.video.findUniqueOrThrow({ where: { id: videoId } });

      // The withdrawal waiver was accepted when this checkout session was created
      const purchase = await tx.purchase.create({
        data: {
          userId,
          videoId,
          paymentId: payment.id,
          amount,
          currency,
          status: 'PAID',
          withdrawalWaiverAt: new Date(session.created * 1000),
        },
      });

      await tx.entitlement.upsert({
        where: { userId_videoId: { userId, videoId } },
        update: { status: 'ACTIVE', purchaseId: purchase.id, grantedAt: new Date(), revokedAt: null, revokedReason: null },
        create: { userId, videoId, purchaseId: purchase.id },
      });

      // VAT is included in the consumer price
      const vatRate = config.company.vatRate;
      const total = amount.toNumber();
      const subtotal = Math.round((total / (1 + vatRate)) * 100) / 100;
      const taxAmount = Math.round((total - subtotal) * 100) / 100;

      const draft = await tx.invoice.create({
        data: {
          purchaseId: purchase.id,
          userId,
          buyerName: user.username,
          buyerEmail: user.email,
          sellerName: config.company.name,
          sellerCif: config.company.cif,
          sellerAddress: config.company.address,
          items: [
            { description: `Licență digitală streaming video - ${video.title}`, quantity: 1, unitPrice: subtotal, total: subtotal },
          ],
          subtotal,
          taxRate: vatRate,
          taxAmount,
          totalAmount: total,
          currency,
          stripePaymentIntentId: paymentIntentId,
          stripeInvoiceId,
          stripeHostedInvoiceUrl,
        },
      });
      const invoice = await tx.invoice.update({
        where: { id: draft.id },
        data: {
          invoiceNumber: `${config.company.invoiceSeries}-${draft.issuedAt.getFullYear()}-${String(draft.seq).padStart(6, '0')}`,
        },
      });

      return { user, video, purchase, invoice };
    });

    if (!result) return { status: 'ALREADY_FULFILLED' };

    const { user, video, purchase, invoice } = result;
    const publicUser = toPublicUser(user);

    EmailService.sendPurchaseConfirmationEmail({ user: publicUser, video, purchase, invoice }).catch(err => {
      console.error('[PaymentsService] Error sending purchase confirmation email:', err);
    });
    EmailService.sendInvoiceEmail({ user: publicUser, video, invoice }).catch(err => {
      console.error('[PaymentsService] Error sending invoice email:', err);
    });

    AuditService.logEvent({
      eventType: 'PURCHASE_COMPLETED',
      userId,
      videoId,
      purchaseId: purchase.id,
      ip,
      userAgent: 'Stripe Payment Processor',
      metadata: { amount: amount.toNumber(), currency, paymentIntentId, invoiceNumber: invoice.invoiceNumber },
    });

    return { status: 'SUCCESS' };
  }

  /**
   * Handles a signed Stripe webhook
   */
  public static async processPaymentWebhook(rawBody: Buffer, signature: string, ip: string): Promise<{ status: string }> {
    const webhookSecret = config.stripe.webhookSecret;
    if (!webhookSecret) throw new Error('PAYMENTS_NOT_CONFIGURED');

    let event: Stripe.Event;
    try {
      event = getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err: any) {
      AuditService.logEvent({
        eventType: 'SUSPICIOUS_WEBHOOK_REJECTED',
        severity: 'CRITICAL',
        ip,
        userAgent: 'Webhook Service',
        metadata: { reason: 'INVALID_SIGNATURE', error: err.message },
      });
      throw new Error('INVALID_WEBHOOK_SIGNATURE');
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.payment_status !== 'paid') return { status: 'SESSION_NOT_PAID' };
        return this.fulfillCheckoutSession(session, ip);
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        if (invoice.id && invoice.hosted_invoice_url) {
          await db.invoice.updateMany({
            where: { stripeInvoiceId: invoice.id },
            data: { stripeHostedInvoiceUrl: invoice.hosted_invoice_url },
          });
        }
        return { status: 'STRIPE_INVOICE_RECORDED' };
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        if (!charge.refunded) return { status: 'PARTIAL_REFUND_IGNORED' };
        return this.revokePayment(idOf(charge.payment_intent), 'REFUNDED', 'REFUNDED_BY_CUSTOMER', ip);
      }

      case 'charge.dispute.created': {
        const dispute = event.data.object;
        return this.revokePayment(idOf(dispute.payment_intent), 'CHARGEBACK', 'CHARGEBACK_DISPUTE', ip);
      }

      default:
        return { status: 'UNHANDLED_EVENT' };
    }
  }

  /**
   * Marks a payment refunded / disputed and revokes the access it granted
   */
  private static async revokePayment(
    paymentIntentId: string | null,
    status: 'REFUNDED' | 'CHARGEBACK',
    reason: string,
    ip: string
  ): Promise<{ status: string }> {
    if (!paymentIntentId) return { status: 'PAYMENT_NOT_FOUND' };

    const purchase = await db.$transaction(async tx => {
      const payment = await tx.payment.findUnique({ where: { paymentIntentId }, include: { purchase: true } });
      if (!payment) return null;

      await tx.payment.update({ where: { id: payment.id }, data: { status } });
      if (!payment.purchase) return null;

      await tx.purchase.update({ where: { id: payment.purchase.id }, data: { status } });
      await tx.invoice.updateMany({ where: { purchaseId: payment.purchase.id }, data: { status: 'REFUNDED' } });

      // Another paid, non-refunded purchase of the same user + video can carry the access forward
      const fallback = await tx.purchase.findFirst({
        where: {
          userId: payment.purchase.userId,
          videoId: payment.purchase.videoId,
          id: { not: payment.purchase.id },
          status: 'PAID',
        },
        orderBy: { createdAt: 'desc' },
      });

      // Only the entitlement granted by this very purchase is touched
      const entitlement = await tx.entitlement.findUnique({ where: { purchaseId: payment.purchase.id } });
      if (!entitlement) return payment.purchase;

      if (fallback) {
        await tx.entitlement.update({
          where: { id: entitlement.id },
          data: { purchaseId: fallback.id, status: 'ACTIVE', revokedAt: null, revokedReason: null },
        });
        return payment.purchase;
      }

      await tx.entitlement.update({
        where: { id: entitlement.id },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: reason },
      });
      // Ends the streams like POST /playback/:videoId/end does, so the heartbeat returns { active: false }
      await tx.playbackSession.updateMany({
        where: { userId: payment.purchase.userId, videoId: payment.purchase.videoId, status: 'ACTIVE' },
        data: { status: 'ENDED', endedAt: new Date() },
      });
      return payment.purchase;
    });

    if (!purchase) return { status: 'PAYMENT_NOT_FOUND' };

    AuditService.logEvent({
      eventType: 'REFUND_CREATED',
      severity: 'WARNING',
      userId: purchase.userId,
      videoId: purchase.videoId,
      purchaseId: purchase.id,
      ip,
      userAgent: 'Payment Webhook',
      metadata: { status, paymentIntentId },
    });

    return { status: 'REVOKED' };
  }
}
