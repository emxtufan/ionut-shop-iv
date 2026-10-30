// ==============================================================================
// IV Concept VOD - SMTP Email Service
// ==============================================================================

import nodemailer from 'nodemailer';
import type { EmailLog, Invoice, Purchase, Video } from '@prisma/client';
import { db } from '../../db/index.ts';
import { config } from '../../config.ts';
import type { EmailType } from '../../../types/index.ts';
import type { PublicUser } from '../auth/auth.service.ts';
import {
  generateWelcomeEmail,
  generatePurchaseEmail,
  generateStripeInvoiceEmail,
  generatePasswordResetEmail,
  escapeHtml,
} from './email-templates.ts';
import { AuditService } from '../audit/audit.service.ts';
import { SettingsService } from '../settings/settings.service.ts';

// The transporter is rebuilt on demand from the current config, so SMTP changes made in the
// admin panel work without a restart (SettingsService.onChange below drops the cached one).
let transporter: nodemailer.Transporter | null = null;
let transporterSignature = '';

function getTransporter(): nodemailer.Transporter {
  const signature = [config.smtp.host, config.smtp.port, config.smtp.secure, config.smtp.user, config.smtp.pass].join('|');
  if (!transporter || signature !== transporterSignature) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
    transporterSignature = signature;
  }
  return transporter;
}

SettingsService.onChange(() => {
  transporter = null;
  transporterSignature = '';
});

function formatDateRo(date: Date): string {
  return date.toLocaleDateString('ro-RO', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export class EmailService {
  /**
   * Safe public configuration inspection (no password)
   */
  public static getSmtpConfig() {
    return {
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      user: config.smtp.user.replace(/(.{3}).*(@.*)/, '$1***$2'),
      from: config.smtp.from,
    };
  }

  /**
   * Test current SMTP configuration and verify handshake
   */
  public static async verifySmtp(): Promise<{ ok: boolean; message: string }> {
    if (!config.smtp.host) return { ok: false, message: 'SMTP nu este configurat.' };
    try {
      await getTransporter().verify();
      return { ok: true, message: `Conexiune SMTP stabilită cu succes către ${config.smtp.host}:${config.smtp.port}.` };
    } catch (err: any) {
      return { ok: false, message: `Eroare conexiune SMTP: ${err.message}` };
    }
  }

  /**
   * Sends an email and records the outcome (SENT / FAILED) in the database
   */
  public static async sendEmail(params: {
    to: string;
    subject: string;
    html: string;
    text: string;
    type: EmailType;
    metadata?: Record<string, any>;
    logHtml?: string; // replaces the body stored in EmailLog (for emails carrying secrets)
  }): Promise<EmailLog> {
    let status: 'SENT' | 'FAILED' = 'SENT';
    let error: string | null = null;
    let metadata = params.metadata || {};

    try {
      // Unconfigured SMTP must not break signup/purchase flows: the email is logged as FAILED
      if (!config.smtp.host) throw new Error('SMTP nu este configurat.');
      const info = await getTransporter().sendMail({
        from: config.smtp.from,
        to: params.to,
        subject: params.subject,
        text: params.text,
        html: params.html,
      });
      metadata = { ...metadata, messageId: info.messageId };
    } catch (err: any) {
      console.error(`[EmailService] SMTP error sending to ${params.to}:`, err.message);
      status = 'FAILED';
      error = err.message;
    }

    return db.emailLog.create({
      data: {
        to: params.to,
        subject: params.subject,
        type: params.type,
        status,
        error,
        html: params.logHtml ?? params.html,
        metadata,
      },
    });
  }

  /**
   * 1. Welcome & Registration Email
   */
  public static async sendWelcomeEmail(user: PublicUser, ip?: string, userAgent?: string) {
    const template = generateWelcomeEmail({
      username: user.username,
      email: user.email,
      appUrl: config.appUrl,
      ip,
      registrationDate: new Date().toLocaleDateString('ro-RO', { year: 'numeric', month: 'long', day: 'numeric' }),
    });

    const log = await this.sendEmail({
      to: user.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
      type: 'WELCOME',
      metadata: { userId: user.id },
    });

    AuditService.logEvent({
      eventType: 'EMAIL_SENT',
      userId: user.id,
      ip: ip || 'system',
      userAgent: userAgent || 'System',
      metadata: { emailType: 'WELCOME', recipient: user.email, status: log.status },
    });
  }

  /**
   * 2. Purchase Confirmation Email
   */
  public static async sendPurchaseConfirmationEmail(params: {
    user: PublicUser;
    video: Video;
    purchase: Purchase;
    invoice: Invoice;
  }) {
    const template = generatePurchaseEmail({
      username: params.user.username,
      email: params.user.email,
      videoTitle: params.video.title,
      amount: params.purchase.amount.toNumber(),
      currency: params.purchase.currency,
      invoiceNumber: params.invoice.invoiceNumber || '',
      purchaseId: params.purchase.id,
      videoId: params.video.id,
      appUrl: config.appUrl,
      thumbnailUrl: params.video.thumbnailUrl,
    });

    const log = await this.sendEmail({
      to: params.user.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
      type: 'PURCHASE_CONFIRMATION',
      metadata: { userId: params.user.id, videoId: params.video.id, purchaseId: params.purchase.id },
    });

    AuditService.logEvent({
      eventType: 'EMAIL_SENT',
      userId: params.user.id,
      videoId: params.video.id,
      purchaseId: params.purchase.id,
      ip: 'system',
      userAgent: 'Stripe Fulfillment Service',
      metadata: { emailType: 'PURCHASE_CONFIRMATION', status: log.status },
    });
  }

  /**
   * 3. Password Reset Email (one-time token, valid 1 hour)
   */
  public static async sendPasswordResetEmail(params: {
    user: PublicUser;
    token: string;
    ip?: string;
    userAgent?: string;
  }) {
    const template = generatePasswordResetEmail({
      username: params.user.username,
      email: params.user.email,
      resetToken: params.token,
      appUrl: config.appUrl,
      expiresInMinutes: 60,
    });

    const log = await this.sendEmail({
      to: params.user.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
      type: 'PASSWORD_RESET',
      // The body embeds the reset token: never store it in EmailLog
      logHtml: '[conținut omis: link de resetare]',
      metadata: { userId: params.user.id },
    });

    AuditService.logEvent({
      eventType: 'EMAIL_SENT',
      userId: params.user.id,
      ip: params.ip || 'system',
      userAgent: params.userAgent || 'System',
      metadata: { emailType: 'PASSWORD_RESET', recipient: params.user.email, status: log.status },
    });
  }

  /**
   * 4. Fiscal Invoice Email
   */
  public static async sendInvoiceEmail(params: { user: PublicUser; video: Video; invoice: Invoice }) {
    const { invoice } = params;
    const template = generateStripeInvoiceEmail({
      invoiceNumber: invoice.invoiceNumber || '',
      userName: invoice.buyerName,
      userEmail: invoice.buyerEmail,
      videoTitle: params.video.title,
      amount: invoice.totalAmount.toNumber(),
      subtotal: invoice.subtotal.toNumber(),
      taxAmount: invoice.taxAmount.toNumber(),
      taxRate: invoice.taxRate.toNumber(),
      currency: invoice.currency,
      paymentMethod: 'Card Bancar (Stripe Checkout)',
      stripePaymentIntentId: invoice.stripePaymentIntentId,
      issuedAt: formatDateRo(invoice.issuedAt),
      appUrl: config.appUrl,
    });

    const log = await this.sendEmail({
      to: params.user.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
      type: 'STRIPE_INVOICE',
      metadata: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, userId: params.user.id },
    });

    AuditService.logEvent({
      eventType: 'EMAIL_SENT',
      userId: params.user.id,
      purchaseId: invoice.purchaseId,
      ip: 'system',
      userAgent: 'Invoice Service',
      metadata: { emailType: 'STRIPE_INVOICE', invoiceNumber: invoice.invoiceNumber, status: log.status },
    });
  }

  /**
   * Renders the printable HTML of an invoice (same template as the email)
   */
  public static renderInvoiceHtml(invoice: Invoice, videoTitle: string): string {
    return generateStripeInvoiceEmail({
      invoiceNumber: invoice.invoiceNumber || '',
      userName: invoice.buyerName,
      userEmail: invoice.buyerEmail,
      videoTitle,
      amount: invoice.totalAmount.toNumber(),
      subtotal: invoice.subtotal.toNumber(),
      taxAmount: invoice.taxAmount.toNumber(),
      taxRate: invoice.taxRate.toNumber(),
      currency: invoice.currency,
      paymentMethod: 'Card Bancar (Stripe)',
      stripePaymentIntentId: invoice.stripePaymentIntentId,
      issuedAt: formatDateRo(invoice.issuedAt),
      appUrl: config.appUrl,
    }).html;
  }

  /**
   * Sends a diagnostic email from the Admin Panel to verify SMTP delivery
   */
  public static async sendTestEmail(recipientEmail: string, adminUsername: string): Promise<EmailLog> {
    const subject = `[IV Concept] Verificare conexiune SMTP`;
    const html = `<!DOCTYPE html><html><body style="background:#e8e0d6; color:#2c2218; font-family:Inter, -apple-system, sans-serif; padding:20px;">
      <div style="max-width:540px; margin:0 auto; background:#f8f3ec; border:1px solid rgba(44,34,24,0.12); border-radius:14px; padding:30px;">
        <h1 style="font-size: 22px; color: #2c2218;">Conexiune SMTP funcțională</h1>
        <p style="color: #433223; font-size: 14px; line-height: 1.6;">
          Salut <strong>${escapeHtml(adminUsername)}</strong>! Acest email confirmă că serviciul SMTP al platformei funcționează corect.
        </p>
        <p style="color: #8b6847; font-size: 13px;">Host: ${config.smtp.host}:${config.smtp.port} • ${new Date().toISOString()}</p>
      </div>
    </body></html>`;

    return this.sendEmail({
      to: recipientEmail,
      subject,
      html,
      text: `Conexiune SMTP funcțională.\nHost: ${config.smtp.host}:${config.smtp.port}\nData: ${new Date().toISOString()}`,
      type: 'TEST',
      metadata: { initiatedBy: adminUsername },
    });
  }
}
