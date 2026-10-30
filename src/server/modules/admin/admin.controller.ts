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
import { BunnyService, syncProcessingVideos } from '../bunny/bunny.service.ts';

export const THUMBNAILS_DIR = path.join(config.uploadDir, 'thumbnails');

const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.webm', '.mov'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

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
    return res.status(201).json({ category });
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
