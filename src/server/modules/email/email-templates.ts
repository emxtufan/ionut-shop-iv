// ==============================================================================
// IV Concept VOD - Minimalist Apple-Inspired Email Templates
// ==============================================================================

import { config } from '../../config.ts';

// Live reference on purpose: the settings service mutates config.company in place,
// so values saved in the admin panel are used by the next rendered email.
const company = config.company;

/**
 * Escapes a dynamic value before it is interpolated into HTML (& < > " ')
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Romanian money format used by every email: "49,00 RON".
 */
function formatMoney(amount: number, currency: string): string {
  return `${amount.toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export interface WelcomeEmailData {
  username: string;
  email: string;
  appUrl: string;
  ip?: string;
  registrationDate?: string;
}

export interface PurchaseEmailData {
  username: string;
  email: string;
  videoTitle: string;
  amount: number;
  currency: string;
  invoiceNumber: string;
  purchaseId: string;
  videoId: string;
  appUrl: string;
  thumbnailUrl?: string;
}

export interface InvoiceEmailData {
  invoiceNumber: string;
  userName: string;
  userEmail: string;
  videoTitle: string;
  amount: number;
  subtotal: number;
  taxAmount: number;
  currency: string;
  taxRate: number;
  paymentMethod: string;
  stripePaymentIntentId?: string | null;
  issuedAt: string;
  status?: string | null;
  appUrl: string;
}

export interface PasswordResetEmailData {
  username: string;
  email: string;
  resetToken: string;
  appUrl: string;
  expiresInMinutes?: number;
}

export interface FgoInvoiceEmailData {
  isStorno: boolean;
  invoiceNumber: string;
  buyerName: string;
  total: number;
  currency: string;
  issuedAt: string;
  pdfUrl: string;
  appUrl: string;
}

export interface LayoutButton {
  label: string;
  url: string;
}

export interface LayoutOptions {
  title: string;
  intro: string;
  button?: LayoutButton;
  body?: string;
  footerNote: string;
  infoBox?: string;
}

const EMAIL_FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

/**
 * Shared email layout: white card (max 560px) on a light page, centered text, table-based and
 * fully inline-styled so Gmail / Outlook render it without an external stylesheet.
 * The logo is attached inline by the email service under the cid used below.
 */
export function renderLayout({ title, intro, button, body, footerNote, infoBox }: LayoutOptions): string {
  const buttonHtml = button
    ? `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 8px;">
                <tr>
                  <td bgcolor="#7B5A3C" style="border-radius:10px;">
                    <a href="${escapeHtml(button.url)}" style="display:inline-block;padding:14px 28px;font-size:17px;font-weight:600;color:#ffffff;text-decoration:none;font-family:${EMAIL_FONT};">${escapeHtml(button.label)}</a>
                  </td>
                </tr>
              </table>`
    : '';

  const bodyHtml = body
    ? `
              ${body}`
    : '';

  const infoBoxHtml = infoBox
    ? `
              <div style="background-color:#f2f2f4;border-radius:12px;padding:24px;font-size:13px;line-height:1.6;color:#888888;margin-top:32px;">${infoBox}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f8f8f8;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8f8f8;">
    <tr>
      <td align="center" style="padding:48px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background-color:#ffffff;border:1px solid #e5e5e5;border-radius:24px;">
          <tr>
            <td style="padding:56px 40px;text-align:center;font-family:${EMAIL_FONT};">
              <img src="cid:logo@ivconcept" width="96" height="96" alt="IVconcept" style="display:block;margin:0 auto 32px;border:0;border-radius:50%">
              <h1 style="font-size:28px;font-weight:700;color:#111111;letter-spacing:-0.5px;margin:0 0 16px;">${escapeHtml(title)}</h1>
              <p style="font-size:17px;line-height:1.6;color:#444444;margin:0 0 32px;">${escapeHtml(intro)}</p>${buttonHtml}${bodyHtml}
              <p style="font-size:15px;line-height:1.6;color:#555555;margin:40px 0 0;">${escapeHtml(footerNote)}</p>${infoBoxHtml}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Contact address used in the footer: the company email from the settings, else the SMTP sender.
 * Read live, exactly like `company` above, so a change saved in the admin panel applies at once.
 */
function contactEmail(): string {
  const raw = (config.company.email || config.smtp.from || '').trim();
  const email = (raw.match(/<([^<>]+)>/)?.[1] || raw).trim();
  return /no-?reply/i.test(email) ? '' : email;
}

/**
 * Footer note of every email except the password reset: who receives it and where to ask questions.
 */
function defaultFooterNote(): string {
  const email = contactEmail();
  return 'Primești acest email pentru că ai un cont pe IVconcept.' +
    (email ? ` Pentru întrebări, scrie-ne la ${email}.` : '');
}

/**
 * Company details (name, CUI, address) shown in the info box of every email, HTML flavour.
 */
function companyInfoBox(): string | undefined {
  const lines = [
    escapeHtml(company.name),
    company.cif ? `CUI: ${escapeHtml(company.cif)}` : '',
    escapeHtml(company.address),
  ].filter(Boolean);

  return lines.length ? lines.join('<br>') : undefined;
}

/**
 * Same company details as plain text, for the text/alternative part.
 */
function companyInfoText(): string[] {
  return [
    company.name,
    company.cif ? `CUI: ${company.cif}` : '',
    company.address,
  ].filter(Boolean);
}

export interface LayoutTextOptions {
  title: string;
  intro: string;
  button?: LayoutButton;
  body?: string;
  footerNote: string;
}

/**
 * Plain-text twin of `renderLayout`: same sentences in the same order, no HTML.
 */
function renderLayoutText({ title, intro, button, body, footerNote }: LayoutTextOptions): string {
  return [
    title,
    intro,
    button ? `${button.label}: ${button.url}` : '',
    body ?? '',
    footerNote,
    companyInfoText().join('\n'),
  ].filter(Boolean).join('\n\n');
}

/**
 * 1. Welcome & Account Creation Template
 */
export function generateWelcomeEmail(data: WelcomeEmailData): { subject: string; html: string; text: string } {
  const subject = `Bun venit în IV Concept, ${data.username}`;
  const title = `Bine ai venit, ${data.username}! 👋`;
  const intro = 'Contul tău a fost creat, iar filmele din colecția IVconcept te așteaptă.';
  const button = { label: 'Vezi filmele', url: data.appUrl };
  const footerNote = defaultFooterNote();

  const html = renderLayout({ title, intro, button, footerNote, infoBox: companyInfoBox() });

  const text = renderLayoutText({ title, intro, button, footerNote });

  return { subject, html, text };
}

/**
 * 2. Purchase Confirmation Template
 */
export function generatePurchaseEmail(data: PurchaseEmailData): { subject: string; html: string; text: string } {
  const subject = `Confirmare Achiziție: ${data.videoTitle} — IV Concept`;
  const title = 'Filmul tău e gata de vizionat 🍿';
  const intro = `Ai acces la „${data.videoTitle}” oricând, din Biblioteca mea.`;
  const button = { label: 'Vizionează acum', url: `${data.appUrl}/?video_id=${data.videoId}` };
  const footerNote = defaultFooterNote();

  const html = renderLayout({ title, intro, button, footerNote, infoBox: companyInfoBox() });

  const text = renderLayoutText({ title, intro, button, footerNote });

  return { subject, html, text };
}

/**
 * 3. Stripe Fiscal Invoice & Receipt Template (Factură Fiscală Digitală)
 */
export function generateStripeInvoiceEmail(data: InvoiceEmailData): { subject: string; html: string; text: string } {
  const subject = `Factură Fiscală #${data.invoiceNumber} — ${company.name}`;
  const vatPercent = Math.round(data.taxRate * 10000) / 100;
  const status = data.status === 'REFUNDED' ? 'Stornată' : 'Achitată';

  const title = 'Mulțumim pentru comandă! 🎬';
  const intro = `Factura #${data.invoiceNumber}, în valoare de ${formatMoney(data.amount, data.currency)}, a fost emisă pentru ${data.videoTitle}.`;
  const button = { label: 'Vezi factura', url: `${data.appUrl}/?view=purchases` };
  const footerNote = defaultFooterNote();

  // The printable invoice page reuses this HTML: the fiscal details stay, only the processor name is gone
  const lines: [string, string][] = [
    ['Film', data.videoTitle],
    ['Cumpărător', data.userName],
    ['Email', data.userEmail],
    ['Subtotal', formatMoney(data.subtotal, data.currency)],
    [`TVA (${vatPercent}%)`, formatMoney(data.taxAmount, data.currency)],
    ['Total', formatMoney(data.amount, data.currency)],
    ['Data emiterii', data.issuedAt],
    ['Status', status],
  ];

  const body = `<div style="background-color:#f7f7f8;border-radius:12px;padding:20px 24px;text-align:left;font-size:15px;line-height:1.7;color:#444444;">${
    lines.map(([label, value]) => `${escapeHtml(label)}: ${escapeHtml(value)}`).join('<br>')
  }</div>`;

  const html = renderLayout({ title, intro, button, body, footerNote, infoBox: companyInfoBox() });

  const text = renderLayoutText({
    title,
    intro,
    button,
    body: lines.map(([label, value]) => `${label}: ${value}`).join('\n'),
    footerNote,
  });

  return { subject, html, text };
}

/**
 * 4. Password Reset Template (one-time link, valid for 1 hour)
 */
export function generatePasswordResetEmail(data: PasswordResetEmailData): { subject: string; html: string; text: string } {
  const subject = `Resetarea parolei — ${company.name}`;
  const expiresInMinutes = data.expiresInMinutes || 60;
  const resetUrl = `${data.appUrl}/?resetToken=${encodeURIComponent(data.resetToken)}`;

  const title = 'Resetează-ți parola';
  const intro = `Ai cerut o parolă nouă pentru contul ${data.email}. Linkul de mai jos este valabil ${expiresInMinutes} minute.`;
  const button = { label: 'Setează o parolă nouă', url: resetUrl };
  const footerNote = 'Dacă nu ai cerut resetarea, ignoră acest email. Parola ta rămâne neschimbată.';

  const html = renderLayout({ title, intro, button, footerNote, infoBox: companyInfoBox() });

  const text = renderLayoutText({ title, intro, button, footerNote });

  return { subject, html, text };
}

/**
 * 5. Fiscal Invoice / Storno Email (the PDF issued for the purchase is attached)
 */
export function generateFgoInvoiceEmail(data: FgoInvoiceEmailData): { subject: string; html: string; text: string } {
  const total = formatMoney(data.total, data.currency);

  const subject = data.isStorno
    ? `Factura de stornare ${data.invoiceNumber} · IVconcept`
    : `Factura ta ${data.invoiceNumber} · IVconcept`;

  const title = data.isStorno ? 'Rambursarea a fost procesată' : 'Mulțumim pentru comandă! 🎬';

  const intro = data.isStorno
    ? `Am returnat ${total} pentru comanda ta. Factura de stornare ${data.invoiceNumber} este atașată acestui email.`
    : `Plata de ${total} a fost confirmată. Factura ${data.invoiceNumber} este atașată acestui email.`;

  const button = data.pdfUrl
    ? { label: data.isStorno ? 'Descarcă factura de stornare' : 'Descarcă factura', url: data.pdfUrl }
    : undefined;

  const footerNote = defaultFooterNote();

  const html = renderLayout({ title, intro, button, footerNote, infoBox: companyInfoBox() });

  const text = renderLayoutText({ title, intro, button, footerNote });

  return { subject, html, text };
}
