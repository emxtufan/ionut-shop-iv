// ==============================================================================
// IV Concept VOD - Secure Playback Service
// Flow: POST /token (entitlement + risk + concurrency checks) -> signed Bunny
//       Stream embed URL (MediaCage DRM is enforced by Bunny's player).
//       The player heartbeats; a session over the concurrency limit is told to stop.
// ==============================================================================

import crypto from 'crypto';
import { db } from '../../db/index.ts';
import { config } from '../../config.ts';
import type { PlaybackAuthorization } from '../../../types/index.ts';
import { AuditService } from '../audit/audit.service.ts';
import { RiskEngine } from '../security/risk-engine.ts';
import { BunnyService, syncProcessingVideos } from '../bunny/bunny.service.ts';

/** Lifetime of the signed embed URL; the player verifies it once, when the iframe loads. */
const PLAYBACK_TOKEN_TTL_SECONDS = 600;

export class PlaybackService {
  /**
   * Request Playback Authorization (entitlement, risk engine, concurrent streams)
   */
  public static async requestPlayback(params: {
    userId: string;
    videoId: string;
    sessionId: string;
    ip: string;
    userAgent: string;
  }): Promise<PlaybackAuthorization> {
    const user = await db.user.findUnique({ where: { id: params.userId } });
    if (!user) throw new Error('USER_NOT_FOUND');
    if (user.isSuspended) throw new Error('ACCOUNT_SUSPENDED');

    let video = await db.video.findUnique({ where: { id: params.videoId } });
    if (video?.status === 'PROCESSING') {
      await syncProcessingVideos();
      video = await db.video.findUnique({ where: { id: params.videoId } });
    }
    if (!video) throw new Error('VIDEO_NOT_FOUND');

    const isAdmin = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';
    if (video.status !== 'READY' || !video.bunnyVideoId || (!video.isPublished && !isAdmin)) {
      throw new Error('VIDEO_NOT_READY');
    }

    // Signed embed URLs cannot be produced without the Bunny library/token key
    if (!BunnyService.isConfigured()) throw new Error('BUNNY_NOT_CONFIGURED');

    // 1. Entitlement check (admins can preview everything)
    if (!isAdmin) {
      const entitlement = await db.entitlement.findUnique({
        where: { userId_videoId: { userId: user.id, videoId: video.id } },
      });
      if (entitlement?.status !== 'ACTIVE') {
        AuditService.logEvent({
          eventType: 'VIDEO_PLAYBACK_DENIED',
          severity: 'WARNING',
          userId: user.id,
          videoId: video.id,
          ip: params.ip,
          userAgent: params.userAgent,
          metadata: { reason: 'ENTITLEMENT_MISSING' },
        });
        throw new Error('VIDEO_NOT_PURCHASED');
      }
    }

    // 2. Risk Engine check
    const risk = await RiskEngine.evaluateUserRisk(user.id);
    if (risk.level === 'CRITICAL') {
      AuditService.logEvent({
        eventType: 'VIDEO_PLAYBACK_DENIED',
        severity: 'CRITICAL',
        userId: user.id,
        videoId: video.id,
        ip: params.ip,
        userAgent: params.userAgent,
        metadata: { reason: 'HIGH_FRAUD_RISK_SUSPEND', riskReasons: risk.reasons },
      });
      throw new Error('ACCOUNT_SECURITY_CHALLENGE');
    }

    // 3. Concurrent stream limit: terminate the oldest streams beyond the limit
    const activeStreams = await db.playbackSession.findMany({
      where: { userId: user.id, status: 'ACTIVE', lastHeartbeatAt: { gt: new Date(Date.now() - config.heartbeatTimeoutMs) } },
      orderBy: { startedAt: 'asc' },
    });
    const toTerminate = activeStreams.slice(0, Math.max(0, activeStreams.length - config.maxConcurrentStreams + 1));
    if (toTerminate.length) {
      await db.playbackSession.updateMany({
        where: { id: { in: toTerminate.map(s => s.id) } },
        data: { status: 'TERMINATED_CONCURRENT_LIMIT', endedAt: new Date() },
      });
      AuditService.logEvent({
        eventType: 'CONCURRENT_STREAM_TERMINATED',
        severity: 'WARNING',
        userId: user.id,
        videoId: video.id,
        ip: params.ip,
        userAgent: params.userAgent,
        metadata: { terminatedPlaybackSessions: toTerminate.map(s => s.id) },
      });
    }

    // 4. New playback session + signed Bunny embed URL, valid for the length of the film plus one hour
    const jti = crypto.randomBytes(16).toString('hex');
    const expires = Math.floor(Date.now() / 1000) + video.durationSeconds + 3600;

    const playbackSession = await db.playbackSession.create({
      data: {
        userId: user.id,
        videoId: video.id,
        sessionId: params.sessionId,
        jtiNonce: jti,
        ip: params.ip,
        userAgent: params.userAgent,
      },
    });

    AuditService.logEvent({
      eventType: 'VIDEO_VIEW_STARTED',
      userId: user.id,
      videoId: video.id,
      ip: params.ip,
      userAgent: params.userAgent,
      metadata: { jti },
    });

    return {
      expiresAt: new Date(expires * 1000).toISOString(),
      jti,
      embedUrl: BunnyService.embedUrl(video.bunnyVideoId, expires),
      watermark: {
        text: config.watermark.text,
        userId: user.id,
        sessionId: playbackSession.id,
        refreshIntervalSeconds: config.watermark.intervalSeconds,
      },
    };
  }

  /**
   * Heartbeat keeps the playback session alive; { active: false } tells the player to stop
   */
  public static async heartbeat(params: { jti: string; userId: string }): Promise<{ active: boolean }> {
    const session = await db.playbackSession.findUnique({ where: { jtiNonce: params.jti } });
    if (!session || session.userId !== params.userId || session.status !== 'ACTIVE') {
      return { active: false };
    }

    await db.playbackSession.update({ where: { id: session.id }, data: { lastHeartbeatAt: new Date() } });
    return { active: true };
  }

  public static async endSession(jti: string, userId: string) {
    const session = await db.playbackSession.findUnique({ where: { jtiNonce: jti } });
    if (!session || session.userId !== userId || session.status !== 'ACTIVE') return;

    await db.playbackSession.update({ where: { id: session.id }, data: { status: 'ENDED', endedAt: new Date() } });

    AuditService.logEvent({
      eventType: 'VIDEO_VIEW_STOPPED',
      userId,
      videoId: session.videoId,
      ip: session.ip,
      userAgent: session.userAgent,
      metadata: { durationWatched: (Date.now() - session.startedAt.getTime()) / 1000 },
    });
  }
}
