// ==============================================================================
// IV Concept VOD - Bunny Stream client
// Docs: https://bunny.net/docs/reference/video_createvideo (API),
//       https://bunny.net/docs/stream-embed-token-authentication (embed tokens)
// ==============================================================================

import crypto from 'crypto';
import type { Readable } from 'stream';
import { config } from '../../config.ts';
import { db } from '../../db/index.ts';

const API = `https://video.bunnycdn.com/library/${config.bunny.libraryId}/videos`;

// Bunny VideoModel.status: 0 Created, 1 Uploaded, 2 Processing, 3 Transcoding, 4 Finished, 5 Error, 6 UploadFailed
const FINISHED = 4;
const FAILED = [5, 6];

async function call(path: string, init: RequestInit & { duplex?: 'half' } = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { AccessKey: config.bunny.apiKey, accept: 'application/json', ...init.headers },
  });
  if (!res.ok) {
    throw new Error(`Bunny Stream ${init.method || 'GET'} ${path} failed: HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export class BunnyService {
  /** Creates an empty video entry and returns its GUID */
  public static async createVideo(title: string): Promise<string> {
    const video = await call('', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    return video.guid;
  }

  /** Streams the file bytes straight to Bunny (no copy on our disk) */
  public static async uploadVideo(guid: string, body: Readable, contentLength?: string): Promise<void> {
    await call(`/${guid}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        ...(contentLength && { 'content-length': contentLength }),
      },
      body: body as any,
      duplex: 'half',
    });
  }

  /** Transcoding state mapped to our VideoStatus, plus duration once known */
  public static async getProcessingState(guid: string): Promise<{ status: 'PROCESSING' | 'READY' | 'FAILED'; length: number }> {
    const video = await call(`/${guid}`);
    const status = video.status === FINISHED ? 'READY' : FAILED.includes(video.status) ? 'FAILED' : 'PROCESSING';
    return { status, length: video.length || 0 };
  }

  public static async deleteVideo(guid: string): Promise<void> {
    await call(`/${guid}`, { method: 'DELETE' });
  }

  /** Signed embed URL: token = SHA256_HEX(token_security_key + video_id + expires) */
  public static embedUrl(guid: string, expires: number): string {
    const token = crypto.createHash('sha256').update(`${config.bunny.tokenKey}${guid}${expires}`).digest('hex');
    return `https://player.mediadelivery.net/embed/${config.bunny.libraryId}/${guid}?token=${token}&expires=${expires}&autoplay=true&showSpeed=true`;
  }
}

let lastSync = 0;

/**
 * Pulls transcoding results from Bunny for videos still PROCESSING.
 * No API calls when nothing is processing; otherwise at most once every 15s.
 */
// ponytail: polling on page loads; switch to Bunny's webhook if you upload many videos at once
export async function syncProcessingVideos() {
  if (Date.now() - lastSync < 15000) return;
  lastSync = Date.now();

  const pending = await db.video.findMany({
    where: { status: 'PROCESSING', bunnyVideoId: { not: null } },
    select: { id: true, bunnyVideoId: true, durationSeconds: true },
  });

  await Promise.all(
    pending.map(async v => {
      try {
        const state = await BunnyService.getProcessingState(v.bunnyVideoId!);
        if (state.status !== 'PROCESSING') {
          await db.video.update({
            where: { id: v.id },
            data: { status: state.status, durationSeconds: state.length || v.durationSeconds },
          });
        }
      } catch (err) {
        console.error('[Bunny] Status check failed for video', v.id, err);
      }
    })
  );
}
