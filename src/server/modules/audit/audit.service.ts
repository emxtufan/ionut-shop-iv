// ==============================================================================
// IV Concept VOD - Audit & Live Event Dispatcher
// ==============================================================================

import type { Response } from 'express';
import { db } from '../../db/index.ts';
import type { AuditSeverity } from '../../../types/index.ts';

// Live SSE subscribers for Admin Live Activity
const sseClients: Set<Response> = new Set();

export class AuditService {
  /**
   * Records a security/business event. Fire-and-forget: a failed audit write is logged, never thrown.
   */
  public static logEvent(params: {
    eventType: string;
    severity?: AuditSeverity;
    userId?: string | null;
    adminId?: string | null;
    videoId?: string | null;
    purchaseId?: string | null;
    ip: string;
    userAgent: string;
    device?: string;
    metadata?: Record<string, any>;
  }): void {
    db.auditLog
      .create({
        data: {
          eventType: params.eventType,
          severity: params.severity || 'INFO',
          userId: params.userId || null,
          adminId: params.adminId || null,
          videoId: params.videoId || null,
          purchaseId: params.purchaseId || null,
          ip: params.ip || 'unknown',
          userAgent: params.userAgent || 'unknown',
          device: params.device || null,
          metadata: params.metadata,
        },
        include: { user: { select: { email: true, username: true } } },
      })
      .then(({ user, ...log }) => {
        this.broadcastToAdmins({ ...log, userEmail: user?.email, userName: user?.username });
      })
      .catch(err => console.error('[AuditService] Failed to write audit log:', err));
  }

  public static registerSseClient(res: Response) {
    sseClients.add(res);
    res.on('close', () => {
      sseClients.delete(res);
    });
  }

  private static broadcastToAdmins(log: object) {
    const data = `data: ${JSON.stringify(log)}\n\n`;
    sseClients.forEach(res => {
      try {
        res.write(data);
      } catch {
        sseClients.delete(res);
      }
    });
  }
}
