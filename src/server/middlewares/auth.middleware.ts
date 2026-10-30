// ==============================================================================
// IV Concept VOD - Authentication & RBAC Middleware
// ==============================================================================

import type { Request, Response, NextFunction } from 'express';
import { AuthService } from '../modules/auth/auth.service.ts';
import type { Role } from '../../types/index.ts';

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await AuthService.validateSession(req.cookies['cinevault_session']);
    if (!result) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Autentificare necesară.' });
    }
    (req as any).user = result.user;
    (req as any).session = result.session;
    next();
  } catch (err) {
    next(err);
  }
}

export async function optionalAuthenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await AuthService.validateSession(req.cookies['cinevault_session']);
    if (result) {
      (req as any).user = result.user;
      (req as any).session = result.session;
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Autentificare necesară.' });
    }

    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({
        error: 'FORBIDDEN_INSUFFICIENT_PERMISSIONS',
        message: 'Nu aveți permisiunea de a accesa această secțiune protejată.',
      });
    }

    next();
  };
}
