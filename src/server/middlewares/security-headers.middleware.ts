// ==============================================================================
// IV Concept VOD - Security Headers & Protection Middleware
// ==============================================================================

import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.ts';

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  // Strict Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy (disable mic, camera, geolocation for video protection)
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self)');

  // Strict Transport Security (HSTS)
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');

  // Content-Security-Policy: images from this server, videos only through the Bunny Stream player iframe
  // Production forbids inline/eval script; the dev server needs them for Vite HMR + React refresh.
  const scriptSrc = config.isProduction
    ? "script-src 'self'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  const connectSrc = config.isProduction
    ? "connect-src 'self' blob:"
    : "connect-src 'self' blob: ws:";

  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "frame-src https://player.mediadelivery.net https://iframe.mediadelivery.net",
      connectSrc,
      "frame-ancestors 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );

  next();
}
