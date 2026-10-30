// ==============================================================================
// IV Concept VOD - Videos, Catalog & User Account Controller
// ==============================================================================

import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { db } from '../../db/index.ts';
import { syncProcessingVideos } from '../bunny/bunny.service.ts';

function isStaff(user: any): boolean {
  return user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';
}

async function ownedVideoIds(user: any): Promise<Set<string>> {
  if (!user) return new Set();
  const entitlements = await db.entitlement.findMany({
    where: { userId: user.id, status: 'ACTIVE' },
    select: { videoId: true },
  });
  return new Set(entitlements.map(e => e.videoId));
}

export class VideosController {
  /**
   * Public Catalog with optional authentication to compute ownership
   */
  public static async getVideos(req: Request, res: Response) {
    const user = (req as any).user;
    const category = req.query.category as string;
    const search = (req.query.search as string)?.toLowerCase();
    const filter = req.query.filter as string; // 'all', 'purchased', 'unpurchased'
    const sort = req.query.sort as string; // 'newest', 'price-low', 'price-high'

    await syncProcessingVideos();
    const list = await db.video.findMany({
      where: {
        isPublished: true,
        status: 'READY',
        ...(category && category !== 'all' ? { categoryId: category } : {}),
      },
      include: { category: true },
      orderBy: { createdAt: 'desc' },
    });

    const owned = await ownedVideoIds(user);

    let mapped = list
      .filter(
        v =>
          !search ||
          v.title.toLowerCase().includes(search) ||
          v.description.toLowerCase().includes(search) ||
          v.tags.some(t => t.toLowerCase().includes(search))
      )
      .map(v => {
        const isPurchased = isStaff(user) || owned.has(v.id);
        return { ...v, isPurchased, hasEntitlement: isPurchased };
      });

    if (filter === 'purchased') {
      mapped = mapped.filter(v => v.isPurchased);
    } else if (filter === 'unpurchased') {
      mapped = mapped.filter(v => !v.isPurchased);
    }

    if (sort === 'price-low') {
      mapped.sort((a, b) => a.priceAmount.toNumber() - b.priceAmount.toNumber());
    } else if (sort === 'price-high') {
      mapped.sort((a, b) => b.priceAmount.toNumber() - a.priceAmount.toNumber());
    }

    return res.json({ videos: mapped, total: mapped.length });
  }

  /**
   * Single Video Details
   */
  public static async getVideoById(req: Request, res: Response) {
    const user = (req as any).user;

    const video = await db.video.findUnique({ where: { id: req.params.id }, include: { category: true } });
    if (!video || (!video.isPublished && !isStaff(user))) {
      return res.status(404).json({ error: 'VIDEO_NOT_FOUND', message: 'Videoclipul nu a fost găsit.' });
    }

    const isPurchased = isStaff(user) || (await ownedVideoIds(user)).has(video.id);
    return res.json({ ...video, isPurchased, hasEntitlement: isPurchased });
  }

  /**
   * User Library: only purchased videos
   */
  public static async getLibrary(req: Request, res: Response) {
    const user = (req as any).user;

    const entitlements = await db.entitlement.findMany({
      where: { userId: user.id, status: 'ACTIVE' },
      include: { video: { include: { category: true } } },
      orderBy: { grantedAt: 'desc' },
    });

    const library = entitlements.map(({ video, grantedAt }) => ({
      ...video,
      isPurchased: true,
      hasEntitlement: true,
      entitlementGrantedAt: grantedAt,
    }));

    return res.json({ library, total: library.length });
  }

  /**
   * Categories with the number of visible videos
   */
  public static async getCategories(req: Request, res: Response) {
    const categories = await db.category.findMany({
      include: { _count: { select: { videos: { where: { isPublished: true, status: 'READY' } } } } },
      orderBy: { name: 'asc' },
    });
    return res.json({
      categories: categories.map(({ _count, ...cat }) => ({ ...cat, videoCount: _count.videos })),
    });
  }

  /**
   * User Purchase History
   */
  public static async getPurchases(req: Request, res: Response) {
    const user = (req as any).user;

    const purchases = await db.purchase.findMany({
      where: { userId: user.id },
      include: {
        video: true,
        // Only what PurchasesPage renders + the FGO document links: fgoError/fgoWarning never leave the server
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            status: true,
            sellerName: true,
            sellerCif: true,
            sellerAddress: true,
            subtotal: true,
            taxRate: true,
            taxAmount: true,
            totalAmount: true,
            currency: true,
            buyerName: true,
            buyerEmail: true,
            buyerType: true,
            buyerCui: true,
            buyerRegCom: true,
            buyerCountry: true,
            buyerCounty: true,
            buyerCity: true,
            buyerAddress: true,
            buyerPhone: true,
            fgoStatus: true,
            fgoPdfUrl: true,
            fgoStornoPdfUrl: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      purchases: purchases.map(({ invoice, ...p }) => ({
        ...p,
        invoiceId: invoice?.id,
        invoiceNumber: invoice?.invoiceNumber,
        invoice,
      })),
    });
  }

  /**
   * Billing details from the last checkout that carried them (prefills the next one)
   */
  public static async getBilling(req: Request, res: Response) {
    const user = (req as any).user;

    const payment = await db.payment.findFirst({
      where: { userId: user.id, billing: { not: Prisma.DbNull } },
      select: { billing: true },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ billing: payment?.billing ?? null });
  }
}
