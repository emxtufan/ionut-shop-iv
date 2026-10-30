// ==============================================================================
// IV Concept VOD - Sliding Window In-Memory Rate Limiter
// ==============================================================================

import type { Request, Response, NextFunction } from 'express';
import { AuditService } from '../audit/audit.service.ts';

interface RateLimitRecord {
  count: number;
  resetAt: number;
  /** Set once the block for the current window was audited, so a burst cannot flood the DB / SSE. */
  reported: boolean;
}

const ipBuckets = new Map<string, RateLimitRecord>();

const MAX_TRACKED_BUCKETS = 10000;

function pruneExpiredBuckets(now: number): void {
  ipBuckets.forEach((record, key) => {
    if (now > record.resetAt) ipBuckets.delete(key);
  });
}

export function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  message?: string;
  actionName?: string;
}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || 'unknown';
    const key = `${options.actionName || 'general'}:${ip}`;
    const now = Date.now();

    if (ipBuckets.size > MAX_TRACKED_BUCKETS) pruneExpiredBuckets(now);

    const record = ipBuckets.get(key);

    if (!record || now > record.resetAt) {
      ipBuckets.set(key, {
        count: 1,
        resetAt: now + options.windowMs,
        reported: false,
      });
      return next();
    }

    record.count++;

    if (record.count > options.maxRequests) {
      const retryAfterSeconds = Math.ceil((record.resetAt - now) / 1000);

      // Log excessive attempt once per window: a blocked attacker must not generate unbounded DB writes.
      if (!record.reported) {
        record.reported = true;
        AuditService.logEvent({
          eventType: 'TOO_MANY_REQUESTS',
          severity: 'WARNING',
          ip,
          userAgent: req.headers['user-agent'] || '',
          metadata: {
            action: options.actionName,
            limit: options.maxRequests,
            windowMs: options.windowMs,
            blockedRequests: record.count,
          },
        });
      }

      res.setHeader('Retry-After', String(retryAfterSeconds));

      return res.status(429).json({
        error: 'TOO_MANY_REQUESTS',
        message: options.message || 'Prea multe solicitări. Te rugăm să încerci din nou mai târziu.',
        retryAfterSeconds,
      });
    }

    next();
  };
}
