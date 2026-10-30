// ==============================================================================
// IV Concept VOD - Multi-Signal Fraud & Account Sharing Risk Engine
// ==============================================================================

import { db } from '../../db/index.ts';
import { config } from '../../config.ts';
import type { RiskLevel } from '../../../types/index.ts';

export interface RiskEvaluation {
  score: number; // 0 - 100
  level: RiskLevel;
  reasons: string[];
  recommendedAction: 'ALLOW' | 'CHALLENGE_2FA' | 'TERMINATE_SECONDARY_STREAMS' | 'TEMPORARY_SUSPEND';
}

export class RiskEngine {
  /**
   * Evaluates user behavior across login, sessions, playback and network signals
   */
  public static async evaluateUserRisk(userId: string): Promise<RiskEvaluation> {
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) {
      return { score: 0, level: 'LOW', reasons: ['Utilizator necunoscut'], recommendedAction: 'ALLOW' };
    }

    let score = 0;
    const reasons: string[] = [];

    // 1. Failed login attempts check
    if (user.failedLoginAttempts >= 3) {
      score += 25;
      reasons.push(`${user.failedLoginAttempts} tentative eșuate de autentificare recente.`);
    }

    // 2. Active sessions and distinct IPs
    const userSessions = await db.session.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      select: { ip: true },
    });
    const distinctIps = new Set(userSessions.map(s => s.ip));
    if (distinctIps.size > 3) {
      score += 35;
      reasons.push(`Contul are ${distinctIps.size} adrese IP distincte active simultan (suspiciune credential sharing).`);
    } else if (distinctIps.size > 1) {
      score += 15;
      reasons.push(`Sesiuni active din ${distinctIps.size} locații/IP-uri diferite.`);
    }

    // 3. Concurrent active playback streams
    const activeStreams = await db.playbackSession.count({
      where: { userId, status: 'ACTIVE', lastHeartbeatAt: { gt: new Date(Date.now() - config.heartbeatTimeoutMs) } },
    });
    if (activeStreams > config.maxConcurrentStreams) {
      score += 40;
      reasons.push(`Depășire limită stream-uri simultane: ${activeStreams} fluxuri active detectate (limită: ${config.maxConcurrentStreams}).`);
    }

    // 4. Recent 403 access denials (last hour)
    const recentDenials = await db.auditLog.count({
      where: { userId, eventType: 'VIDEO_PLAYBACK_DENIED', createdAt: { gt: new Date(Date.now() - 3600000) } },
    });
    if (recentDenials >= 3) {
      score += 30;
      reasons.push(`${recentDenials} tentative de acces la conținut neautorizat în ultima oră.`);
    }

    score = Math.min(100, score);

    let level: RiskLevel = 'LOW';
    let recommendedAction: RiskEvaluation['recommendedAction'] = 'ALLOW';

    if (score >= 75) {
      level = 'CRITICAL';
      recommendedAction = 'TEMPORARY_SUSPEND';
    } else if (score >= 50) {
      level = 'HIGH';
      recommendedAction = 'TERMINATE_SECONDARY_STREAMS';
    } else if (score >= 25) {
      level = 'MEDIUM';
      recommendedAction = 'CHALLENGE_2FA';
    }

    return {
      score,
      level,
      reasons: reasons.length > 0 ? reasons : ['Activitate normală, comportament conform.'],
      recommendedAction,
    };
  }
}
