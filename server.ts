// ==============================================================================
// IV Concept VOD - Full-Stack Express Server & API Gateway
// ==============================================================================

import { config } from './src/server/config.ts';
import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { securityHeaders } from './src/server/middlewares/security-headers.middleware.ts';
import { authenticate, optionalAuthenticate, requireRole } from './src/server/middlewares/auth.middleware.ts';
import { createRateLimiter } from './src/server/modules/security/rate-limiter.ts';

import { AuthController } from './src/server/modules/auth/auth.controller.ts';
import { VideosController } from './src/server/modules/videos/videos.controller.ts';
import { PlaybackController } from './src/server/modules/playback/playback.controller.ts';
import { PaymentsService } from './src/server/modules/payments/payments.service.ts';
import { EmailService } from './src/server/modules/email/email.service.ts';
import { AdminController, THUMBNAILS_DIR } from './src/server/modules/admin/admin.controller.ts';
import { db, ensureAdminUser } from './src/server/db/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxyHops);

// Express 4 does not catch rejected promises from async handlers
const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const admin = [authenticate, requireRole('ADMIN', 'SUPER_ADMIN')];

// Stripe webhook needs the raw body for signature verification, so it goes before express.json()
app.post(
  '/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response) => {
    try {
      const result = await PaymentsService.processPaymentWebhook(
        req.body,
        (req.headers['stripe-signature'] as string) || '',
        req.ip || 'unknown'
      );
      return res.json({ received: true, ...result });
    } catch (err: any) {
      if (err.message !== 'INVALID_WEBHOOK_SIGNATURE') console.error('[Webhook] Processing failed:', err);
      return res.status(400).json({ error: 'WEBHOOK_FAILED', message: err.message });
    }
  }
);

app.use(express.json());
app.use(cookieParser());
app.use(securityHeaders);

const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 20, actionName: 'auth_attempt' });
const generalApiLimiter = createRateLimiter({ windowMs: 60 * 1000, maxRequests: 120, actionName: 'api_general' });

app.use('/api', generalApiLimiter);

// Uploaded thumbnails are public images
app.use('/media/thumbnails', express.static(THUMBNAILS_DIR, { maxAge: '7d' }));

// -----------------------------------------------------------------------------
// Health (monitoring)
// -----------------------------------------------------------------------------
app.get('/api/health', ah(async (req: Request, res: Response) => {
  await db.$queryRaw`SELECT 1`;
  return res.json({ status: 'healthy', timestamp: new Date().toISOString() });
}));

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------
app.post('/api/auth/register', authLimiter, ah(AuthController.register));
app.post('/api/auth/login', authLimiter, ah(AuthController.login));
app.post('/api/auth/forgot-password', authLimiter, ah(AuthController.forgotPassword));
app.post('/api/auth/reset-password', authLimiter, ah(AuthController.resetPassword));
app.post('/api/auth/logout', ah(AuthController.logout));
app.get('/api/auth/me', authenticate, ah(AuthController.me));

// -----------------------------------------------------------------------------
// Catalog & account
// -----------------------------------------------------------------------------
app.get('/api/categories', ah(VideosController.getCategories));
app.get('/api/videos', optionalAuthenticate, ah(VideosController.getVideos));
app.get('/api/videos/:id', optionalAuthenticate, ah(VideosController.getVideoById));
app.get('/api/library', authenticate, ah(VideosController.getLibrary));
app.get('/api/account/purchases', authenticate, ah(VideosController.getPurchases));

// Printable invoice (opens a print-ready page)
app.get('/api/account/invoices/:id/print', authenticate, ah(async (req: Request, res: Response) => {
  const user = (req as any).user;
  const invoice = await db.invoice.findUnique({
    where: { id: req.params.id },
    include: { purchase: { include: { video: { select: { title: true } } } } },
  });
  if (!invoice) return res.status(404).send('Factura nu a fost găsită');
  if (invoice.userId !== user.id && user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
    return res.status(403).send('Acces interzis');
  }

  const html = EmailService.renderInvoiceHtml(invoice, invoice.purchase.video.title);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html.replace('</body>', '<script src="/print.js" defer></script></body>'));
}));

// -----------------------------------------------------------------------------
// Payments (Stripe Checkout)
// -----------------------------------------------------------------------------
app.get('/api/payments/config', (req: Request, res: Response) => {
  return res.json(PaymentsService.getPaymentConfig());
});

app.post('/api/payments/checkout/:videoId', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await PaymentsService.createCheckoutSession({
      userId: (req as any).user.id,
      videoId: req.params.videoId,
      ip: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'Unknown',
      acceptedTerms: req.body?.acceptedTerms,
    });
    return res.json(result);
  } catch (err: any) {
    const messages: Record<string, string> = {
      TERMS_NOT_ACCEPTED: 'Trebuie să accepți Termenii și renunțarea la dreptul de retragere.',
      VIDEO_NOT_FOUND: 'Videoclipul nu este disponibil pentru achiziție.',
      ALREADY_PURCHASED: 'Deții deja acest videoclip.',
    };
    if (!messages[err.message]) console.error('[Checkout] Failed to create Stripe session:', err);
    return res.status(400).json({ error: err.message, message: messages[err.message] || 'Inițializarea plății Stripe a eșuat.' });
  }
});

// Customer returned from Stripe Checkout
app.post('/api/payments/verify-stripe-session', authenticate, async (req: Request, res: Response) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'SESSION_ID_REQUIRED' });

  try {
    const result = await PaymentsService.verifyAndFulfillStripeSession(sessionId, (req as any).user.id, req.ip || 'unknown');
    return res.json(result);
  } catch (err: any) {
    console.error('[Checkout] Session verification failed:', err);
    return res.status(400).json({ success: false, message: 'Nu s-a putut verifica plata. Dacă ai fost taxat, accesul se activează automat în câteva minute.' });
  }
});

// -----------------------------------------------------------------------------
// Playback
// -----------------------------------------------------------------------------
app.post('/api/playback/:videoId/token', authenticate, ah(PlaybackController.requestToken));
app.post('/api/playback/:videoId/heartbeat', authenticate, ah(PlaybackController.heartbeat));
app.post('/api/playback/:videoId/end', authenticate, ah(PlaybackController.endSession));

// -----------------------------------------------------------------------------
// Admin (ADMIN / SUPER_ADMIN)
// -----------------------------------------------------------------------------
app.get('/api/admin/dashboard', ...admin, ah(AdminController.getDashboardKPIs));
app.get('/api/admin/live-activity', ...admin, AdminController.streamLiveActivity);
app.get('/api/admin/audit-logs', ...admin, ah(AdminController.getAuditLogs));
app.get('/api/admin/purchases', ...admin, ah(AdminController.getPurchases));
app.get('/api/admin/videos', ...admin, ah(AdminController.getVideos));
app.post('/api/admin/videos', ...admin, ah(AdminController.createVideo));
app.patch('/api/admin/videos/:id', ...admin, ah(AdminController.updateVideo));
app.delete('/api/admin/videos/:id', ...admin, ah(AdminController.deleteVideo));
app.post('/api/admin/videos/:id/file', ...admin, ah(AdminController.uploadVideoFile));
app.post('/api/admin/videos/:id/thumbnail', ...admin, ah(AdminController.uploadThumbnail));
app.post('/api/admin/categories', ...admin, ah(AdminController.createCategory));
app.get('/api/admin/smtp', ...admin, ah(AdminController.getSmtp));
app.get('/api/admin/emails', ...admin, ah(AdminController.getEmails));

app.post('/api/admin/smtp/verify', ...admin, ah(async (req: Request, res: Response) => {
  return res.json(await EmailService.verifySmtp());
}));

app.post('/api/admin/smtp/test-email', ...admin, ah(async (req: Request, res: Response) => {
  const adminUser = (req as any).user;
  const targetEmail = String(req.body.recipient || '').trim() || adminUser.email;
  const log = await EmailService.sendTestEmail(targetEmail, adminUser.username);
  return res.json({ success: log.status === 'SENT', log, error: log.error });
}));

// -----------------------------------------------------------------------------
// Error handler: log server-side, never leak stack traces
// -----------------------------------------------------------------------------
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(`[IV Concept] ${req.method} ${req.originalUrl} failed:`, err);
  if (res.headersSent) return next(err);
  return res.status(500).json({
    error: 'INTERNAL_SERVER_ERROR',
    message: 'A apărut o eroare neașteptată pe server.',
  });
});

// -----------------------------------------------------------------------------
// Unknown API routes: always JSON 404, never the SPA fallback
// -----------------------------------------------------------------------------
app.all('/api/*', (req: Request, res: Response) => {
  return res.status(404).json({ message: 'NOT_FOUND' });
});

// -----------------------------------------------------------------------------
// Frontend: Vite dev middleware locally, built files in production
// -----------------------------------------------------------------------------
async function bootstrapServer() {
  await fs.promises.mkdir(THUMBNAILS_DIR, { recursive: true });
  await db.$connect();
  await ensureAdminUser();

  if (!config.isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[IV Concept VOD] ${config.isProduction ? 'Production' : 'Development'} server on http://0.0.0.0:${config.port}`);
    console.log(`[IV Concept VOD] Uploads stored in ${config.uploadDir}`);
  });
}

bootstrapServer().catch(err => {
  console.error('[IV Concept VOD] Failed to start server:', err);
  process.exit(1);
});
