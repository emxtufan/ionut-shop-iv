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

/**
 * Base Apple-style email container with crisp typography, dark mode / high contrast and zero visual slop
 */
function wrapHtmlTemplate(title: string, bodyContent: string, appUrl: string): string {
  return `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #e8e0d6;
      color: #2c2218;
      font-family: Inter, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
      line-height: 1.5;
    }
    .wrapper {
      width: 100%;
      background-color: #e8e0d6;
      padding: 40px 16px;
    }
    .card {
      max-width: 580px;
      margin: 0 auto;
      background-color: #f8f3ec;
      border: 1px solid rgba(44, 34, 24, 0.12);
      border-radius: 16px;
      overflow: hidden;
      padding: 40px 36px;
    }
    .brand-header {
      margin-bottom: 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(44, 34, 24, 0.1);
      padding-bottom: 20px;
    }
    .brand-logo {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: #2c2218;
      text-decoration: none;
    }
    .brand-pill {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #8b6847;
      font-weight: 500;
    }
    h1 {
      font-size: 26px;
      font-weight: 600;
      letter-spacing: -0.6px;
      color: #2c2218;
      margin: 0 0 12px 0;
      line-height: 1.25;
    }
    p {
      font-size: 15px;
      color: #433223;
      margin: 0 0 20px 0;
      line-height: 1.6;
    }
    .highlight-box {
      background-color: #f1e9de;
      border: 1px solid rgba(44, 34, 24, 0.1);
      border-radius: 12px;
      padding: 20px;
      margin: 24px 0;
    }
    .item-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      font-size: 14px;
      border-bottom: 1px solid rgba(44, 34, 24, 0.04);
    }
    .item-row:last-child {
      border-bottom: none;
    }
    .item-label {
      color: #8b6847;
    }
    .item-value {
      color: #2c2218;
      font-weight: 500;
    }
    .cta-container {
      margin: 32px 0 16px 0;
      text-align: center;
    }
    .cta-button {
      display: inline-block;
      background-color: #2c2218;
      color: #f8f3ec !important;
      font-weight: 600;
      font-size: 14px;
      padding: 13px 32px;
      border-radius: 10px;
      text-decoration: none;
      letter-spacing: -0.2px;
      transition: background-color 0.2s ease;
    }
    .footer {
      max-width: 580px;
      margin: 28px auto 0 auto;
      text-align: center;
      font-size: 12px;
      color: #8b6847;
      line-height: 1.6;
    }
    .footer a {
      color: #8b6847;
      text-decoration: none;
    }
    .stripe-badge {
      display: inline-block;
      padding: 4px 10px;
      background-color: rgba(179, 139, 96, 0.15);
      border: 1px solid rgba(179, 139, 96, 0.4);
      color: #8b6847;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      margin-bottom: 16px;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="brand-header">
        <a href="${escapeHtml(appUrl)}" class="brand-logo">IV CONCEPT</a>
        <span class="brand-pill">Premium Streaming</span>
      </div>
      ${bodyContent}
    </div>
    <div class="footer">
      <p style="font-size: 12px; color: #8b6847; margin-bottom: 6px;">
        Acest email a fost trimis automat de către platforma IV Concept VOD.
      </p>
      <p style="font-size: 11px; color: #8b6847; margin: 0;">
        ${escapeHtml(company.name)} • ${escapeHtml(company.address)} • Plăți securizate prin Stripe
      </p>
    </div>
  </div>
</body>
</html>`;
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
              <img src="cid:logo@ivconcept" width="96" height="96" alt="IVconcept" style="display:block;margin:0 auto 32px;border:0">
              <h1 style="font-size:28px;font-weight:700;color:#111111;letter-spacing:-0.5px;margin:0 0 16px;">${escapeHtml(title)}</h1>
              <p style="font-size:17px;line-height:1.6;color:#444444;margin:0 0 32px;">${escapeHtml(intro)}</p>${buttonHtml}${bodyHtml}${infoBoxHtml}
              <p style="font-size:15px;line-height:1.6;color:#555555;margin:40px 0 0;">${escapeHtml(footerNote)}</p>
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
 * 1. Welcome & Account Creation Template
 */
export function generateWelcomeEmail(data: WelcomeEmailData): { subject: string; html: string; text: string } {
  const subject = `Bun venit în IV Concept, ${data.username}`;
  const now = data.registrationDate || new Date().toLocaleDateString('ro-RO', { year: 'numeric', month: 'long', day: 'numeric' });

  const body = `
    <h1>Bun venit în IV Concept</h1>
    <p>
      Contul tău a fost configurat cu succes. Ai acces la colecția noastră privată de masterclass-uri cinematice, documentare exclusive și producții video de înaltă definiție 4K HDR.
    </p>

    <div class="highlight-box">
      <div class="item-row">
        <span class="item-label">Utilizator</span>
        <span class="item-value">${escapeHtml(data.username)}</span>
      </div>
      <div class="item-row">
        <span class="item-label">Email</span>
        <span class="item-value">${escapeHtml(data.email)}</span>
      </div>
      <div class="item-row">
        <span class="item-label">Data înregistrării</span>
        <span class="item-value">${escapeHtml(now)}</span>
      </div>
      ${data.ip ? `
      <div class="item-row">
        <span class="item-label">IP Înregistrare</span>
        <span class="item-value" style="font-family: monospace; font-size: 12px;">${escapeHtml(data.ip)}</span>
      </div>` : ''}
    </div>

    <p style="font-size: 14px;">
      Fiecare titlu cumpărat pe IV Concept oferă <strong>licență permanentă pe viață</strong>, fără abonamente lunare recurente sau reclame.
    </p>

    <div class="cta-container">
      <a href="${escapeHtml(data.appUrl)}" class="cta-button">Explorează Catalogul</a>
    </div>
  `;

  const html = wrapHtmlTemplate('Bun venit în IV Concept', body, data.appUrl);

  const text = `Bun venit în IV Concept, ${data.username}!\n\n` +
    `Contul tău a fost creat cu succes pentru adresa ${data.email}.\n` +
    `Data înregistrării: ${now}\n\n` +
    `Accesează catalogul la: ${data.appUrl}\n\n` +
    `${company.name}`;

  return { subject, html, text };
}

/**
 * 2. Purchase Confirmation Template
 */
export function generatePurchaseEmail(data: PurchaseEmailData): { subject: string; html: string; text: string } {
  const subject = `Confirmare Achiziție: ${data.videoTitle} — IV Concept`;

  const body = `
    <div class="stripe-badge">Plată Confirmată • Licență Activă</div>
    <h1>Achiziție finalizată cu succes</h1>
    <p>
      Mulțumim pentru comanda plasată. Licența ta digitală pentru <strong>${escapeHtml(data.videoTitle)}</strong> este acum activă permanent în contul tău.
    </p>

    <div class="highlight-box">
      <div class="item-row">
        <span class="item-label">Titlu Producție</span>
        <span class="item-value" style="text-align: right; max-width: 60%;">${escapeHtml(data.videoTitle)}</span>
      </div>
      <div class="item-row">
        <span class="item-label">Sumă Achitată</span>
        <span class="item-value" style="font-size: 16px; font-weight: 700; color: #3f6b35;">${escapeHtml(data.amount)} ${escapeHtml(data.currency)}</span>
      </div>
      <div class="item-row">
        <span class="item-label">Număr Factură</span>
        <span class="item-value" style="font-family: monospace; font-size: 12px;">${escapeHtml(data.invoiceNumber)}</span>
      </div>
      <div class="item-row">
        <span class="item-label">Tip Licență</span>
        <span class="item-value">Acces Permanent (fără expirare)</span>
      </div>
      <div class="item-row">
        <span class="item-label">Procesator Plată</span>
        <span class="item-value">Stripe Payments</span>
      </div>
    </div>

    <p style="font-size: 14px;">
      Poți viziona producția imediat pe orice dispozitiv (Desktop, Tabletă, Smart TV).
    </p>

    <div class="cta-container">
      <a href="${escapeHtml(data.appUrl)}/?video_id=${escapeHtml(data.videoId)}" class="cta-button">Vizionează Acum</a>
    </div>
  `;

  const html = wrapHtmlTemplate('Confirmare Achiziție', body, data.appUrl);

  const text = `Confirmare Achiziție IV Concept\n\n` +
    `Ai cumpărat cu succes: ${data.videoTitle}\n` +
    `Sumă: ${data.amount} ${data.currency}\n` +
    `Factură nr: ${data.invoiceNumber}\n` +
    `Licență: Acces Permanent\n\n` +
    `Vizionează la: ${data.appUrl}/?video_id=${data.videoId}\n\n` +
    `Mulțumim!\n${company.name}`;

  return { subject, html, text };
}

/**
 * 3. Stripe Fiscal Invoice & Receipt Template (Factură Fiscală Digitală)
 */
export function generateStripeInvoiceEmail(data: InvoiceEmailData): { subject: string; html: string; text: string } {
  const subject = `Factură Fiscală #${data.invoiceNumber} — ${company.name}`;
  const vatPercent = Math.round(data.taxRate * 10000) / 100;
  const statusBadge = data.status === 'REFUNDED' ? 'STORNATĂ' : 'ACHITAT';

  const body = `
    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px;">
      <div>
        <div class="stripe-badge">Factură Fiscală Digitală</div>
        <h1 style="margin-bottom: 4px;">Factură #${escapeHtml(data.invoiceNumber)}</h1>
        <p style="margin: 0; font-size: 13px; color: #8b6847;">Data emiterii: ${escapeHtml(data.issuedAt)}</p>
      </div>
      <div style="text-align: right;">
        <span style="display: inline-block; padding: 4px 10px; background-color: rgba(63, 107, 53, 0.12); border: 1px solid rgba(63, 107, 53, 0.3); color: #3f6b35; border-radius: 6px; font-size: 12px; font-weight: 700;">
          ${statusBadge}
        </span>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; font-size: 12px; line-height: 1.5; color: #433223; border-top: 1px solid rgba(44,34,24,0.1); border-bottom: 1px solid rgba(44,34,24,0.1); padding: 16px 0;">
      <div>
        <strong style="color: #2c2218; display: block; margin-bottom: 4px; font-size: 13px;">Furnizor:</strong>
        ${escapeHtml(company.name)}<br>
        CIF: ${escapeHtml(company.cif)}<br>
        ${escapeHtml(company.address)}
      </div>
      <div>
        <strong style="color: #2c2218; display: block; margin-bottom: 4px; font-size: 13px;">Cumpărător:</strong>
        ${escapeHtml(data.userName)}<br>
        Email: ${escapeHtml(data.userEmail)}<br>
        Metodă de plată: ${escapeHtml(data.paymentMethod)}<br>
        ${data.stripePaymentIntentId ? `Ref Stripe: <span style="font-family: monospace;">${escapeHtml(data.stripePaymentIntentId)}</span>` : ''}
      </div>
    </div>

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px;">
      <thead>
        <tr style="border-bottom: 1px solid rgba(44,34,24,0.15); text-align: left; color: #8b6847;">
          <th style="padding: 8px 0; font-weight: 500;">Descriere Serviciu</th>
          <th style="padding: 8px 12px; text-align: center; font-weight: 500;">Cant.</th>
          <th style="padding: 8px 0; text-align: right; font-weight: 500;">Total</th>
        </tr>
      </thead>
      <tbody>
        <tr style="border-bottom: 1px solid rgba(44,34,24,0.1); color: #2c2218;">
          <td style="padding: 12px 0;">
            <div style="font-weight: 600;">Licență Digitală Streaming VOD (Permanent)</div>
            <div style="font-size: 12px; color: #8b6847; margin-top: 2px;">${escapeHtml(data.videoTitle)}</div>
          </td>
          <td style="padding: 12px; text-align: center;">1</td>
          <td style="padding: 12px 0; text-align: right; font-weight: 600;">${escapeHtml(data.amount)} ${escapeHtml(data.currency)}</td>
        </tr>
      </tbody>
    </table>

    <div style="max-width: 260px; margin-left: auto; margin-bottom: 28px; font-size: 13px;">
      <div style="display: flex; justify-content: space-between; padding: 4px 0; color: #8b6847;">
        <span>Subtotal:</span>
        <span style="color: #2c2218;">${escapeHtml(data.subtotal.toFixed(2))} ${escapeHtml(data.currency)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; padding: 4px 0; color: #8b6847;">
        <span>TVA (${escapeHtml(vatPercent)}% inclusă):</span>
        <span style="color: #2c2218;">${escapeHtml(data.taxAmount.toFixed(2))} ${escapeHtml(data.currency)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; padding: 10px 0; border-top: 1px solid rgba(44,34,24,0.15); margin-top: 6px; font-size: 16px; font-weight: 700; color: #2c2218;">
        <span>Total Achitat:</span>
        <span style="color: #3f6b35;">${escapeHtml(data.amount)} ${escapeHtml(data.currency)}</span>
      </div>
    </div>

    <div class="cta-container">
      <a href="${escapeHtml(data.appUrl)}/?view=purchases" class="cta-button">Vezi în Cont & Descarcă</a>
    </div>
  `;

  const html = wrapHtmlTemplate(`Factură #${data.invoiceNumber}`, body, data.appUrl);

  const text = `Factură Fiscală #${data.invoiceNumber}\n` +
    `${company.name} (CIF ${company.cif})\n\n` +
    `Cumpărător: ${data.userName} (${data.userEmail})\n` +
    `Data emiterii: ${data.issuedAt}\n` +
    `Produs: Licență VOD - ${data.videoTitle}\n` +
    `Total: ${data.amount} ${data.currency} (TVA inclusă)\n` +
    `Status: ACHITAT (Stripe)\n` +
    `Ref Stripe: ${data.stripePaymentIntentId || 'OK'}\n\n` +
    `Vizualizare chitanță: ${data.appUrl}/?view=purchases`;

  return { subject, html, text };
}

/**
 * 4. Password Reset Template (one-time link, valid for 1 hour)
 */
export function generatePasswordResetEmail(data: PasswordResetEmailData): { subject: string; html: string; text: string } {
  const subject = `Resetarea parolei — ${company.name}`;
  const expiresInMinutes = data.expiresInMinutes || 60;
  const resetUrl = `${data.appUrl}/?resetToken=${encodeURIComponent(data.resetToken)}`;

  const body = `
    <h1>Resetarea parolei</h1>
    <p>
      Am primit o solicitare de resetare a parolei pentru contul <strong>${escapeHtml(data.email)}</strong>.
      Apasă butonul de mai jos pentru a alege o parolă nouă.
    </p>

    <div class="cta-container">
      <a href="${escapeHtml(resetUrl)}" class="cta-button">Setează parola nouă</a>
    </div>

    <div class="highlight-box">
      <div class="item-row">
        <span class="item-label">Utilizator</span>
        <span class="item-value">${escapeHtml(data.username)}</span>
      </div>
      <div class="item-row">
        <span class="item-label">Valabilitate link</span>
        <span class="item-value">${escapeHtml(expiresInMinutes)} minute</span>
      </div>
      <div class="item-row">
        <span class="item-label">Utilizări permise</span>
        <span class="item-value">O singură dată</span>
      </div>
    </div>

    <p style="font-size: 14px;">
      Linkul expiră în ${escapeHtml(expiresInMinutes)} minute și poate fi folosit o singură dată. Dacă nu ai solicitat
      resetarea parolei, ignoră acest email — parola ta rămâne neschimbată.
    </p>
  `;

  const html = wrapHtmlTemplate('Resetarea parolei', body, data.appUrl);

  const text = `Resetarea parolei ${company.name}\n\n` +
    `Am primit o solicitare de resetare a parolei pentru adresa ${data.email}.\n` +
    `Deschide linkul pentru a alege o parolă nouă: ${resetUrl}\n\n` +
    `Linkul expiră în ${expiresInMinutes} minute și poate fi folosit o singură dată.\n` +
    `Dacă nu ai solicitat resetarea parolei, ignoră acest email.\n\n` +
    `${company.name}`;

  return { subject, html, text };
}

/**
 * 5. FGO Fiscal Invoice / Storno Email (PDF-ul fiscal emis de FGO)
 */
export function generateFgoInvoiceEmail(data: FgoInvoiceEmailData): { subject: string; html: string; text: string } {
  const label = data.isStorno ? 'Factură storno' : 'Factura';
  const subject = `${label} ${data.invoiceNumber} — ${company.name}`;
  const total = `${data.total.toFixed(2)} ${data.currency}`;

  const intro = `${data.isStorno
    ? 'Factura inițială a fost stornată. Documentul emis de FGO este atașat acestui email.'
    : 'Factura fiscală a fost emisă. Documentul emis de FGO este atașat acestui email.'}${data.pdfUrl ? ' Îl poți descărca oricând și cu butonul de mai jos.' : ''}`;

  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:15px;line-height:1.6;color:#444444;text-align:left;">
                <tr>
                  <td style="padding:12px 0;border-top:1px solid #e5e5e5;color:#888888;">Cumpărător</td>
                  <td style="padding:12px 0;border-top:1px solid #e5e5e5;text-align:right;color:#111111;">${escapeHtml(data.buyerName)}</td>
                </tr>
                <tr>
                  <td style="padding:12px 0;border-top:1px solid #e5e5e5;color:#888888;">Număr document</td>
                  <td style="padding:12px 0;border-top:1px solid #e5e5e5;text-align:right;color:#111111;font-family:monospace;">${escapeHtml(data.invoiceNumber)}</td>
                </tr>
                <tr>
                  <td style="padding:12px 0;border-top:1px solid #e5e5e5;color:#888888;">Total (TVA inclus)</td>
                  <td style="padding:12px 0;border-top:1px solid #e5e5e5;text-align:right;color:#111111;font-weight:700;">${escapeHtml(total)}</td>
                </tr>
                <tr>
                  <td style="padding:12px 0;border-top:1px solid #e5e5e5;border-bottom:1px solid #e5e5e5;color:#888888;">Data emiterii</td>
                  <td style="padding:12px 0;border-top:1px solid #e5e5e5;border-bottom:1px solid #e5e5e5;text-align:right;color:#111111;">${escapeHtml(data.issuedAt)}</td>
                </tr>
              </table>`;

  // Company details in the info box, only the ones configured in the admin panel
  const companyLines = [
    escapeHtml(company.name),
    company.cif ? `CUI: ${escapeHtml(company.cif)}` : '',
    escapeHtml(company.address),
  ].filter(Boolean);

  const html = renderLayout({
    title: `${label} ${data.invoiceNumber}`,
    intro,
    button: data.pdfUrl ? { label: 'Descarcă factura PDF', url: data.pdfUrl } : undefined,
    body,
    footerNote: 'Acest email a fost trimis automat de către platforma IV Concept VOD.',
    infoBox: companyLines.length ? companyLines.join('<br>') : undefined,
  });

  const text = `${label} ${data.invoiceNumber}\n` +
    `${company.name} (CIF ${company.cif})\n\n` +
    `Cumpărător: ${data.buyerName}\n` +
    `Data emiterii: ${data.issuedAt}\n` +
    `Total (TVA inclus): ${total}\n` +
    (data.pdfUrl ? `Descarcă factura: ${data.pdfUrl}\n` : '') +
    `\n${company.name}`;

  return { subject, html, text };
}
