// ==============================================================================
// IV Concept VOD - Admin Management & Live Telemetry Controller
// ==============================================================================

import type { Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { db } from '../../db/index.ts';
import { config } from '../../config.ts';
import { AuditService } from '../audit/audit.service.ts';
import { EmailService } from '../email/email.service.ts';
import { AuthService } from '../auth/auth.service.ts';
import { BunnyService, syncProcessingVideos } from '../bunny/bunny.service.ts';
import { FgoService } from '../fgo/fgo.service.ts';

export const THUMBNAILS_DIR = path.join(config.uploadDir, 'thumbnails');

const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.webm', '.mov'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const USERS_PAGE_SIZE = 50;
const INVOICES_PAGE_SIZE = 20;
const INVOICE_FGO_FILTERS = ['FAILED', 'PENDING', 'DONE', 'NONE'];

function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function auditContext(req: Request) {
  return {
    adminId: (req as any).user.id as string,
    ip: req.ip || 'unknown',
    userAgent: req.headers['user-agent'] || '',
  };
}

/**
 * Streams the raw request body to `dir/finalName` via a temp file. Returns false if the upload was aborted.
 */
async function saveUpload(req: Request, dir: string, finalName: string): Promise<boolean> {
  const tmpPath = path.join(dir, `.${finalName}.${crypto.randomBytes(4).toString('hex')}.part`);
  try {
    await pipeline(req, fs.createWriteStream(tmpPath));
    await fs.promises.rename(tmpPath, path.join(dir, finalName));
    return true;
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true });
    console.error('[AdminController] Upload failed:', err);
    return false;
  }
}

export class AdminController {
  /**
   * Main KPI Dashboard
   */
  public static async getDashboardKPIs(req: Request, res: Response) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [totalUsers, activeUsers24h, allSales, todaySales, activeStreamsCount, topGroups] = await Promise.all([
      db.user.count(),
      db.user.count({ where: { lastLoginAt: { gt: new Date(Date.now() - 24 * 3600000) } } }),
      db.purchase.aggregate({ where: { status: 'PAID' }, _sum: { amount: true }, _count: true }),
      db.purchase.aggregate({ where: { status: 'PAID', createdAt: { gte: startOfToday } }, _sum: { amount: true } }),
      db.playbackSession.count({
        where: { status: 'ACTIVE', lastHeartbeatAt: { gt: new Date(Date.now() - config.heartbeatTimeoutMs) } },
      }),
      db.purchase.groupBy({
        by: ['videoId'],
        where: { status: 'PAID' },
        _count: true,
        _sum: { amount: true },
        orderBy: { _sum: { amount: 'desc' } },
        take: 5,
      }),
    ]);

    const topVideoRows = await db.video.findMany({ where: { id: { in: topGroups.map(g => g.videoId) } } });
    const topVideos = topGroups
      .map(g => ({
        video: topVideoRows.find(v => v.id === g.videoId),
        salesCount: g._count,
        revenue: g._sum.amount?.toNumber() || 0,
      }))
      .filter(t => t.video);

    return res.json({
      kpis: {
        totalUsers,
        activeUsers24h,
        totalSalesCount: allSales._count,
        totalRevenueRon: allSales._sum.amount?.toNumber() || 0,
        revenueTodayRon: todaySales._sum.amount?.toNumber() || 0,
        activeStreamsCount,
        topVideos,
      },
    });
  }

  /**
   * Live Activity SSE Feed
   */
  public static streamLiveActivity(req: Request, res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write('event: connected\ndata: {"status":"connected"}\n\n');
    AuditService.registerSseClient(res);
  }

  /**
   * Latest audit logs
   */
  public static async getAuditLogs(req: Request, res: Response) {
    const severity = req.query.severity as string;
    const eventType = req.query.eventType as string;

    const logs = await db.auditLog.findMany({
      where: {
        ...(severity && severity !== 'ALL' ? { severity: severity as any } : {}),
        ...(eventType ? { eventType } : {}),
      },
      include: { user: { select: { email: true, username: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return res.json({
      logs: logs.map(({ user, ...log }) => ({ ...log, userEmail: user?.email, userName: user?.username })),
    });
  }

  /**
   * All purchases (orders table)
   */
  public static async getPurchases(req: Request, res: Response) {
    const purchases = await db.purchase.findMany({
      include: {
        user: { select: { id: true, email: true, username: true } },
        video: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return res.json({ purchases });
  }

  /**
   * Invoices (FGO) - Paginated list (20 per page, newest first), optional fgoStatus filter.
   * Returns every invoice field; no relations are loaded.
   */
  public static async getInvoices(req: Request, res: Response) {
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
    const status = String(req.query.status || '').trim().toUpperCase();

    if (status && status !== 'ALL' && !INVOICE_FGO_FILTERS.includes(status)) {
      return res.status(400).json({
        error: 'INVALID_STATUS',
        message: `Statusul poate fi ${INVOICE_FGO_FILTERS.join(', ')}.`,
      });
    }

    const where = status === 'NONE' ? { fgoStatus: null } : status && status !== 'ALL' ? { fgoStatus: status } : {};

    const [items, total, failedCount] = await Promise.all([
      db.invoice.findMany({
        where,
        orderBy: { seq: 'desc' },
        skip: (page - 1) * INVOICES_PAGE_SIZE,
        take: INVOICES_PAGE_SIZE,
      }),
      db.invoice.count({ where }),
      db.invoice.count({ where: { fgoStatus: 'FAILED' } }),
    ]);

    return res.json({ items, total, failedCount });
  }

  /**
   * Invoices - Put a failed invoice back at the head of the FGO queue
   */
  public static async retryInvoice(req: Request, res: Response) {
    const invoice = await db.invoice.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true },
    });
    if (!invoice) return res.status(404).json({ error: 'INVOICE_NOT_FOUND', message: 'Factura nu a fost găsită.' });

    try {
      await FgoService.retry(invoice.id);
    } catch (err: any) {
      return res.status(400).json({ error: 'INVOICE_RETRY_FAILED', message: err.message || 'Reîncercarea facturii a eșuat.' });
    }

    AuditService.logEvent({
      eventType: 'ADMIN_RETRIED_INVOICE',
      severity: 'WARNING',
      userId: invoice.userId,
      ...auditContext(req),
      metadata: { invoiceId: invoice.id },
    });

    return res.json({ success: true, message: 'Factura a fost reprogramată pentru emitere.' });
  }

  /**
   * Invoices - Send the invoice email again (with the PDF when FGO still serves it)
   */
  public static async resendInvoiceEmail(req: Request, res: Response) {
    const invoice = await db.invoice.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true },
    });
    if (!invoice) return res.status(404).json({ error: 'INVOICE_NOT_FOUND', message: 'Factura nu a fost găsită.' });

    let sent: boolean;
    try {
      sent = await FgoService.resendEmail(invoice.id);
    } catch (err: any) {
      return res.status(400).json({ error: 'INVOICE_EMAIL_FAILED', message: err.message || 'Trimiterea emailului a eșuat.' });
    }

    AuditService.logEvent({
      eventType: 'ADMIN_RESENT_INVOICE_EMAIL',
      ...auditContext(req),
      metadata: { invoiceId: invoice.id },
    });

    if (!sent) {
      return res.status(502).json({ error: 'EMAIL_SEND_FAILED', message: 'Emailul cu factura nu a putut fi trimis.' });
    }

    return res.json({ success: true, message: 'Emailul cu factura a fost retrimis.' });
  }

  /**
   * Invoices - Ask FGO for a storno (the queue issues it on the next run)
   */
  public static async requestInvoiceStorno(req: Request, res: Response) {
    const invoice = await db.invoice.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true },
    });
    if (!invoice) return res.status(404).json({ error: 'INVOICE_NOT_FOUND', message: 'Factura nu a fost găsită.' });

    try {
      await FgoService.requestStorno(invoice.id);
    } catch (err: any) {
      return res.status(400).json({ error: 'INVOICE_STORNO_FAILED', message: err.message || 'Stornarea facturii a eșuat.' });
    }

    AuditService.logEvent({
      eventType: 'ADMIN_REQUESTED_INVOICE_STORNO',
      severity: 'WARNING',
      userId: invoice.userId,
      ...auditContext(req),
      metadata: { invoiceId: invoice.id },
    });

    return res.json({ success: true, message: 'Stornarea a fost programată.' });
  }

  /**
   * User Management - Paginated list (50 per page, newest first). Never returns passwordHash or tokens.
   */
  public static async getUsers(req: Request, res: Response) {
    const search = String(req.query.search || '').trim();
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);

    const where = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' as const } },
            { username: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [items, total] = await Promise.all([
      db.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          username: true,
          role: true,
          isSuspended: true,
          createdAt: true,
          lastLoginAt: true,
          lockoutUntil: true,
          _count: { select: { entitlements: { where: { status: 'ACTIVE' } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * USERS_PAGE_SIZE,
        take: USERS_PAGE_SIZE,
      }),
      db.user.count({ where }),
    ]);

    return res.json({ items, total });
  }

  /**
   * User Management - Single user with entitlements and session count
   */
  public static async getUserById(req: Request, res: Response) {
    const user = await db.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        isSuspended: true,
        suspendedReason: true,
        failedLoginAttempts: true,
        lockoutUntil: true,
        lastLoginAt: true,
        lastLoginIp: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { sessions: true } },
      },
    });
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'Utilizatorul nu a fost găsit.' });

    const entitlements = await db.entitlement.findMany({
      where: { userId: user.id },
      select: {
        status: true,
        purchaseId: true,
        grantedAt: true,
        video: { select: { id: true, title: true } },
      },
      orderBy: { grantedAt: 'desc' },
    });

    const { _count, ...details } = user;
    return res.json({
      user: details,
      entitlements: entitlements.map(e => ({
        videoId: e.video.id,
        videoTitle: e.video.title,
        status: e.status,
        purchaseId: e.purchaseId,
        createdAt: e.grantedAt,
      })),
      sessionsCount: _count.sessions,
    });
  }

  /**
   * User Management - Suspend / reactivate or change role.
   * An admin can never touch their own account, a SUPER_ADMIN account, and (unless SUPER_ADMIN) roles.
   */
  public static async updateUser(req: Request, res: Response) {
    const actor = (req as any).user;
    const { isSuspended, role } = req.body;

    const target = await db.user.findUnique({ where: { id: req.params.id } });
    if (!target) return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'Utilizatorul nu a fost găsit.' });

    if (target.id === actor.id) {
      return res.status(400).json({ error: 'CANNOT_MODIFY_SELF', message: 'Nu îți poți modifica propriul cont.' });
    }
    if (target.role === 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'FORBIDDEN_TARGET_SUPER_ADMIN', message: 'Conturile SUPER_ADMIN nu pot fi modificate.' });
    }

    if (role !== undefined) {
      if (actor.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'FORBIDDEN_ROLE_CHANGE', message: 'Doar un SUPER_ADMIN poate schimba rolurile.' });
      }
      // SUPER_ADMIN is never assigned from the API
      if (role !== 'USER' && role !== 'ADMIN') {
        return res.status(400).json({ error: 'INVALID_ROLE', message: 'Rolurile permise sunt USER și ADMIN.' });
      }
    }

    if (isSuspended !== undefined && typeof isSuspended !== 'boolean') {
      return res.status(400).json({ error: 'INVALID_SUSPENSION', message: 'Valoare invalidă pentru suspendare.' });
    }

    const suspend = isSuspended === true;

    const updated = await db.$transaction(async tx => {
      const user = await tx.user.update({
        where: { id: target.id },
        data: {
          ...(isSuspended !== undefined && { isSuspended }),
          ...(role !== undefined && { role }),
        },
      });

      if (suspend) {
        // Running streams are closed before the sessions disappear, so players stop instead of erroring out
        await tx.playbackSession.updateMany({
          where: { userId: target.id, status: 'ACTIVE' },
          data: { status: 'ENDED', endedAt: new Date() },
        });
        await tx.session.deleteMany({ where: { userId: target.id } });
      }

      return user;
    });

    AuditService.logEvent({
      eventType: suspend ? 'ADMIN_SUSPENDED_USER' : 'ADMIN_UPDATED_USER',
      severity: suspend || role !== undefined ? 'WARNING' : 'INFO',
      userId: target.id,
      ...auditContext(req),
      metadata: {
        changedFields: Object.keys(req.body || {}),
        previousRole: target.role,
        role: updated.role,
        isSuspended: updated.isSuspended,
      },
    });

    const { passwordHash, ...safeUser } = updated;
    return res.json({ user: safeUser });
  }

  /**
   * User Management - Kill every session and clear the brute-force lockout.
   * A regular admin can never force a SUPER_ADMIN out.
   */
  public static async logoutAllSessions(req: Request, res: Response) {
    const actor = (req as any).user;

    const target = await db.user.findUnique({ where: { id: req.params.id } });
    if (!target) return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'Utilizatorul nu a fost găsit.' });

    if (target.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        error: 'FORBIDDEN_TARGET_SUPER_ADMIN',
        message: 'Doar un SUPER_ADMIN poate deconecta un cont SUPER_ADMIN.',
      });
    }

    const [deleted] = await db.$transaction([
      db.session.deleteMany({ where: { userId: target.id } }),
      db.user.update({
        where: { id: target.id },
        data: { failedLoginAttempts: 0, lockoutUntil: null },
      }),
    ]);

    AuditService.logEvent({
      eventType: 'ADMIN_LOGGED_OUT_ALL_SESSIONS',
      severity: 'WARNING',
      userId: target.id,
      ...auditContext(req),
      metadata: { deletedSessions: deleted.count },
    });

    return res.json({ success: true, message: 'Toate sesiunile utilizatorului au fost închise.' });
  }

  /**
   * User Management - Send the standard password reset email on behalf of the user.
   * A regular admin can never trigger a reset for a SUPER_ADMIN, nor for a suspended account.
   */
  public static async sendPasswordReset(req: Request, res: Response) {
    const actor = (req as any).user;

    const target = await db.user.findUnique({ where: { id: req.params.id } });
    if (!target) return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'Utilizatorul nu a fost găsit.' });

    if (target.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        error: 'FORBIDDEN_TARGET_SUPER_ADMIN',
        message: 'Doar un SUPER_ADMIN poate trimite resetarea parolei unui cont SUPER_ADMIN.',
      });
    }

    if (target.isSuspended) {
      return res.status(409).json({ error: 'USER_SUSPENDED', message: 'Contul este suspendat.' });
    }

    await AuthService.requestPasswordReset({
      email: target.email,
      ip: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'Unknown',
    });

    AuditService.logEvent({
      eventType: 'ADMIN_SENT_PASSWORD_RESET',
      severity: 'WARNING',
      userId: target.id,
      ...auditContext(req),
      metadata: { email: target.email, isSuspended: target.isSuspended },
    });

    return res.json({ success: true, message: 'Emailul de resetare a parolei a fost trimis.' });
  }

  /**
   * User Management - Manually grant a video. A manual grant has no purchase behind it.
   */
  public static async grantEntitlement(req: Request, res: Response) {
    const user = await db.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'Utilizatorul nu a fost găsit.' });

    const videoId = typeof req.body?.videoId === 'string' ? req.body.videoId.trim() : '';
    if (!videoId) return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Selectează un videoclip.' });

    const video = await db.video.findUnique({ where: { id: videoId } });
    if (!video) return res.status(404).json({ error: 'VIDEO_NOT_FOUND', message: 'Videoclipul nu a fost găsit.' });

    const existing = await db.entitlement.findUnique({
      where: { userId_videoId: { userId: user.id, videoId: video.id } },
    });

    // A grant only keeps the purchaseId if the access already came from a real purchase
    const entitlement = await db.entitlement.upsert({
      where: { userId_videoId: { userId: user.id, videoId: video.id } },
      update: {
        status: 'ACTIVE',
        purchaseId: existing?.purchaseId ?? null,
        revokedAt: null,
        revokedReason: null,
      },
      create: {
        userId: user.id,
        videoId: video.id,
        purchaseId: null,
        status: 'ACTIVE',
      },
    });

    AuditService.logEvent({
      eventType: 'ADMIN_GRANTED_ENTITLEMENT',
      userId: user.id,
      videoId: video.id,
      ...auditContext(req),
      metadata: { entitlementId: entitlement.id, purchaseId: entitlement.purchaseId, videoTitle: video.title },
    });

    return res.json({ entitlement });
  }

  /**
   * User Management - Revoke a video. The purchase/payment rows stay untouched.
   */
  public static async revokeEntitlement(req: Request, res: Response) {
    const { id, videoId } = req.params;

    const user = await db.user.findUnique({ where: { id } });
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'Utilizatorul nu a fost găsit.' });

    const existing = await db.entitlement.findUnique({
      where: { userId_videoId: { userId: user.id, videoId } },
    });
    if (!existing) {
      return res.status(404).json({ error: 'ENTITLEMENT_NOT_FOUND', message: 'Utilizatorul nu are acest videoclip în bibliotecă.' });
    }

    const [entitlement] = await db.$transaction([
      db.entitlement.update({
        where: { id: existing.id },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: 'ADMIN_REVOKED' },
      }),
      // Ends the running streams like POST /playback/:videoId/end does, so the heartbeat returns { active: false }
      db.playbackSession.updateMany({
        where: { userId: user.id, videoId, status: 'ACTIVE' },
        data: { status: 'ENDED', endedAt: new Date() },
      }),
    ]);

    AuditService.logEvent({
      eventType: 'ADMIN_REVOKED_ENTITLEMENT',
      severity: 'WARNING',
      userId: user.id,
      videoId,
      ...auditContext(req),
      metadata: { entitlementId: entitlement.id, purchaseId: existing.purchaseId },
    });

    return res.json({ entitlement });
  }

  /**
   * Video Management - List all videos (including drafts)
   */
  public static async getVideos(req: Request, res: Response) {
    await syncProcessingVideos();
    const videos = await db.video.findMany({
      include: { category: true, _count: { select: { purchases: { where: { status: 'PAID' } } } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({
      videos: videos.map(({ _count, ...v }) => ({ ...v, salesCount: _count.purchases })),
    });
  }

  /**
   * Video Management - Create video metadata. The file is uploaded separately (uploadVideoFile).
   */
  public static async createVideo(req: Request, res: Response) {
    const { title, description, categoryId, tags, priceAmount } = req.body;

    if (!title || priceAmount === undefined || !categoryId) {
      return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Titlul, categoria și prețul sunt obligatorii.' });
    }

    // Number(x) turns garbage into NaN and Prisma would reject it with an opaque error
    const price = Number(priceAmount);
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: 'INVALID_PRICE', message: 'Preț invalid.' });
    }

    if (tags !== undefined && (!Array.isArray(tags) || !tags.every((tag: unknown) => typeof tag === 'string'))) {
      return res.status(400).json({ error: 'INVALID_TAGS', message: 'Etichete invalide.' });
    }

    const video = await db.video.create({
      data: {
        title,
        slug: `${slugify(title)}-${crypto.randomBytes(3).toString('hex')}`,
        description: description || '',
        categoryId,
        tags: Array.isArray(tags) ? tags : [],
        priceAmount: price,
        currency: config.stripe.currency,
      },
    });

    AuditService.logEvent({
      eventType: 'ADMIN_CREATED_VIDEO',
      videoId: video.id,
      ...auditContext(req),
      metadata: { title: video.title, price: video.priceAmount.toNumber() },
    });

    return res.status(201).json({ video });
  }

  /**
   * Video Management - Update metadata / publish state
   */
  public static async updateVideo(req: Request, res: Response) {
    const video = await db.video.findUnique({ where: { id: req.params.id } });
    if (!video) return res.status(404).json({ error: 'VIDEO_NOT_FOUND' });

    const { title, description, categoryId, tags, priceAmount, isPublished } = req.body;

    const price = priceAmount === undefined ? undefined : Number(priceAmount);
    if (price !== undefined && (!Number.isFinite(price) || price < 0)) {
      return res.status(400).json({ error: 'INVALID_PRICE', message: 'Preț invalid.' });
    }

    if (tags !== undefined && (!Array.isArray(tags) || !tags.every((tag: unknown) => typeof tag === 'string'))) {
      return res.status(400).json({ error: 'INVALID_TAGS', message: 'Etichete invalide.' });
    }

    // A PROCESSING video may be published: it shows up in the catalog as soon as Bunny finishes
    if (isPublished === true && video.status !== 'READY' && video.status !== 'PROCESSING') {
      return res.status(400).json({
        error: 'VIDEO_FILE_MISSING',
        message: 'Încarcă fișierul video înainte de a publica.',
      });
    }

    const updated = await db.video.update({
      where: { id: video.id },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(categoryId !== undefined && { categoryId }),
        ...(tags !== undefined && { tags }),
        ...(price !== undefined && { priceAmount: price }),
        ...(isPublished !== undefined && {
          isPublished: Boolean(isPublished),
          publishedAt: isPublished && !video.publishedAt ? new Date() : video.publishedAt,
        }),
      },
    });

    AuditService.logEvent({
      eventType: 'ADMIN_UPDATED_VIDEO',
      videoId: video.id,
      ...auditContext(req),
      metadata: { updatedFields: Object.keys(req.body) },
    });

    return res.json({ video: updated });
  }

  /**
   * Uploads the video file to Bunny Stream. Body = raw file bytes, streamed through to Bunny.
   * Query: ?name=<original file name>&duration=<seconds>
   */
  public static async uploadVideoFile(req: Request, res: Response) {
    if (!BunnyService.isConfigured()) {
      return res.status(503).json({ error: 'BUNNY_NOT_CONFIGURED', message: 'Serviciul video nu este configurat încă.' });
    }

    const video = await db.video.findUnique({ where: { id: req.params.id } });
    if (!video) return res.status(404).json({ error: 'VIDEO_NOT_FOUND' });

    const ext = path.extname(String(req.query.name || '')).toLowerCase();
    if (!VIDEO_EXTENSIONS.includes(ext)) {
      return res.status(400).json({ error: 'UNSUPPORTED_FORMAT', message: `Formate acceptate: ${VIDEO_EXTENSIONS.join(', ')}` });
    }

    // A replacement file gets a fresh Bunny video; the old one is deleted after the new upload succeeds
    const bunnyVideoId = await BunnyService.createVideo(video.title);
    try {
      await BunnyService.uploadVideo(bunnyVideoId, req, req.headers['content-length']);
    } catch (err) {
      console.error('[AdminController] Bunny upload failed:', err);
      await BunnyService.deleteVideo(bunnyVideoId).catch(() => {});
      return res.status(502).json({ error: 'UPLOAD_FAILED', message: 'Încărcarea către Bunny Stream a eșuat. Încearcă din nou.' });
    }

    const updated = await db.video.update({
      where: { id: video.id },
      data: {
        bunnyVideoId,
        status: 'PROCESSING',
        durationSeconds: Math.round(Number(req.query.duration)) || video.durationSeconds,
      },
    });

    if (video.bunnyVideoId) {
      await BunnyService.deleteVideo(video.bunnyVideoId).catch(err =>
        console.error('[AdminController] Could not delete old Bunny video', video.bunnyVideoId, err)
      );
    }

    AuditService.logEvent({
      eventType: 'ADMIN_UPLOADED_VIDEO_FILE',
      videoId: video.id,
      ...auditContext(req),
      metadata: { bunnyVideoId, bytes: Number(req.headers['content-length']) || null },
    });

    return res.json({ video: updated });
  }

  /**
   * Uploads the thumbnail image. Body = raw image bytes. Query: ?name=<original file name>
   */
  public static async uploadThumbnail(req: Request, res: Response) {
    const video = await db.video.findUnique({ where: { id: req.params.id } });
    if (!video) return res.status(404).json({ error: 'VIDEO_NOT_FOUND' });

    const ext = path.extname(String(req.query.name || '')).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) {
      return res.status(400).json({ error: 'UNSUPPORTED_FORMAT', message: `Formate acceptate: ${IMAGE_EXTENSIONS.join(', ')}` });
    }

    // New name on every upload so browsers/CDNs never serve a cached old image
    const fileName = `${video.id}-${Date.now()}${ext}`;
    if (!(await saveUpload(req, THUMBNAILS_DIR, fileName))) {
      return res.status(400).json({ error: 'UPLOAD_FAILED', message: 'Încărcarea a fost întreruptă.' });
    }

    if (video.thumbnailUrl.startsWith('/media/thumbnails/')) {
      await fs.promises.rm(path.join(THUMBNAILS_DIR, path.basename(video.thumbnailUrl)), { force: true });
    }

    const updated = await db.video.update({
      where: { id: video.id },
      data: { thumbnailUrl: `/media/thumbnails/${fileName}` },
    });
    return res.json({ video: updated });
  }

  /**
   * Video Management - Delete (only videos nobody has bought)
   */
  public static async deleteVideo(req: Request, res: Response) {
    const video = await db.video.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { purchases: true, entitlements: true } } },
    });
    if (!video) return res.status(404).json({ error: 'VIDEO_NOT_FOUND' });

    if (video._count.purchases > 0 || video._count.entitlements > 0) {
      return res.status(409).json({
        error: 'VIDEO_HAS_PURCHASES',
        message: 'Videoclipul a fost cumpărat și nu poate fi șters. Ascunde-l din catalog (dezactivează „Publicat”).',
      });
    }

    await db.video.delete({ where: { id: video.id } });
    if (video.bunnyVideoId) {
      await BunnyService.deleteVideo(video.bunnyVideoId).catch(err =>
        console.error('[AdminController] Could not delete Bunny video', video.bunnyVideoId, err)
      );
    }
    if (video.thumbnailUrl.startsWith('/media/thumbnails/')) {
      await fs.promises.rm(path.join(THUMBNAILS_DIR, path.basename(video.thumbnailUrl)), { force: true });
    }

    AuditService.logEvent({
      eventType: 'ADMIN_DELETED_VIDEO',
      severity: 'WARNING',
      videoId: video.id,
      ...auditContext(req),
      metadata: { deletedTitle: video.title },
    });

    return res.json({ success: true, message: 'Videoclipul a fost șters.' });
  }

  /**
   * Category Management - Create
   */
  public static async createCategory(req: Request, res: Response) {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Numele categoriei este obligatoriu.' });

    const slug = slugify(name);
    if (await db.category.findUnique({ where: { slug } })) {
      return res.status(409).json({ error: 'CATEGORY_EXISTS', message: 'Există deja o categorie cu acest nume.' });
    }

    const category = await db.category.create({
      data: { name, slug, description: req.body.description || null },
    });

    AuditService.logEvent({
      eventType: 'ADMIN_CREATED_CATEGORY',
      ...auditContext(req),
      metadata: { categoryId: category.id, name: category.name },
    });

    return res.status(201).json({ category });
  }

  /**
   * Category Management - Rename (same slug normalization as creation)
   */
  public static async updateCategory(req: Request, res: Response) {
    const category = await db.category.findUnique({ where: { id: req.params.id } });
    if (!category) return res.status(404).json({ error: 'CATEGORY_NOT_FOUND', message: 'Categoria nu a fost găsită.' });

    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Numele categoriei este obligatoriu.' });

    const slug = slugify(name);
    const duplicate = await db.category.findUnique({ where: { slug } });
    if (duplicate && duplicate.id !== category.id) {
      return res.status(409).json({ error: 'CATEGORY_EXISTS', message: 'Există deja o categorie cu acest nume.' });
    }

    const updated = await db.category.update({ where: { id: category.id }, data: { name, slug } });

    AuditService.logEvent({
      eventType: 'ADMIN_UPDATED_CATEGORY',
      ...auditContext(req),
      metadata: { categoryId: category.id, name, previousName: category.name },
    });

    return res.json({ category: updated });
  }

  /**
   * Category Management - Delete (only empty categories)
   */
  public static async deleteCategory(req: Request, res: Response) {
    const category = await db.category.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { videos: true } } },
    });
    if (!category) return res.status(404).json({ error: 'CATEGORY_NOT_FOUND', message: 'Categoria nu a fost găsită.' });

    if (category._count.videos > 0) {
      return res.status(409).json({
        error: 'CATEGORY_HAS_VIDEOS',
        message: `Categoria „${category.name}” conține filme și nu poate fi ștearsă. Mută filmele într-o altă categorie mai întâi.`,
      });
    }

    await db.category.delete({ where: { id: category.id } });

    AuditService.logEvent({
      eventType: 'ADMIN_DELETED_CATEGORY',
      severity: 'WARNING',
      ...auditContext(req),
      metadata: { categoryId: category.id, deletedName: category.name },
    });

    return res.json({ success: true, message: 'Categoria a fost ștearsă.' });
  }

  /**
   * SMTP status + email stats
   */
  public static async getSmtp(req: Request, res: Response) {
    const counts = await db.emailLog.groupBy({ by: ['status'], _count: true });
    const count = (status: string) => counts.find(c => c.status === status)?._count || 0;
    return res.json({
      config: EmailService.getSmtpConfig(),
      stats: { totalSent: count('SENT'), failed: count('FAILED') },
    });
  }

  public static async getEmails(req: Request, res: Response) {
    const emails = await db.emailLog.findMany({ orderBy: { sentAt: 'desc' }, take: 200 });
    return res.json({ emails });
  }
}
