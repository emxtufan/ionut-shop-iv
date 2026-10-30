// ==============================================================================
// IV Concept VOD - Playback & Streaming Controller
// ==============================================================================

import type { Request, Response } from 'express';
import { PlaybackService } from './playback.service.ts';

export class PlaybackController {
  /**
   * Request Playback Authorization Token
   */
  public static async requestToken(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const session = (req as any).session;

      const auth = await PlaybackService.requestPlayback({
        userId: user.id,
        videoId: req.params.videoId,
        sessionId: session.id,
        ip: req.ip || 'unknown',
        userAgent: req.headers['user-agent'] || 'Unknown',
      });

      return res.json(auth);
    } catch (err: any) {
      const statusMap: Record<string, number> = {
        VIDEO_NOT_PURCHASED: 403,
        ACCOUNT_SUSPENDED: 403,
        ACCOUNT_SECURITY_CHALLENGE: 403,
        VIDEO_NOT_READY: 400,
        VIDEO_NOT_FOUND: 404,
        BUNNY_NOT_CONFIGURED: 503,
      };

      const messageMap: Record<string, string> = {
        VIDEO_NOT_PURCHASED: 'Nu dețineți accesul pentru acest videoclip premium. Vă rugăm să finalizați achiziția.',
        ACCOUNT_SUSPENDED: 'Contul este suspendat. Contactați asistența tehnică.',
        ACCOUNT_SECURITY_CHALLENGE: 'Activitate suspectă detectată pe cont. Stream-ul a fost restricționat.',
        VIDEO_NOT_READY: 'Videoclipul nu este încă disponibil pentru redare.',
        VIDEO_NOT_FOUND: 'Videoclipul solicitat nu există.',
        BUNNY_NOT_CONFIGURED: 'Serviciul video nu este configurat încă.',
      };

      if (!statusMap[err.message]) console.error('[PlaybackController] requestToken failed:', err);
      return res.status(statusMap[err.message] || 500).json({
        error: err.message,
        message: messageMap[err.message] || 'Nu s-a putut autoriza redarea videoclipului.',
      });
    }
  }

  /**
   * Heartbeat to keep session active
   */
  public static async heartbeat(req: Request, res: Response) {
    const user = (req as any).user;
    const { jti } = req.body;
    if (!jti) return res.status(400).json({ error: 'JTI_REQUIRED' });

    const result = await PlaybackService.heartbeat({ jti, userId: user.id });
    return res.json(result);
  }

  /**
   * End Session
   */
  public static async endSession(req: Request, res: Response) {
    const user = (req as any).user;
    const { jti } = req.body;
    if (jti) await PlaybackService.endSession(jti, user.id);
    return res.json({ success: true });
  }
}
