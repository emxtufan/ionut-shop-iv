// ==============================================================================
// IV Concept VOD - Authentication Controller
// ==============================================================================

import type { Request, Response } from 'express';
import { AuthService } from './auth.service.ts';
import { config } from '../../config.ts';

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  maxAge: config.sessionDurationDays * 24 * 60 * 60 * 1000,
};

export class AuthController {
  public static async register(req: Request, res: Response) {
    try {
      const { email, username, password } = req.body;
      if (!email || !username || !password) {
        return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Toate câmpurile sunt obligatorii.' });
      }

      const { user, session } = await AuthService.register({
        email,
        username,
        password,
        ip: req.ip || 'unknown',
        userAgent: req.headers['user-agent'] || 'Unknown',
      });

      res.cookie('cinevault_session', session.token, SESSION_COOKIE_OPTIONS);
      return res.status(201).json({ user });
    } catch (err: any) {
      const messageMap: Record<string, string> = {
        EMAIL_ALREADY_EXISTS: 'O adresă de email identică este deja înregistrată.',
        USERNAME_ALREADY_EXISTS: 'Acest nume de utilizator este deja folosit.',
        PASSWORD_TOO_SHORT: 'Parola trebuie să aibă minim 8 caractere.',
        PASSWORD_TOO_LONG: 'Parola poate avea maxim 128 de caractere.',
        EMAIL_INVALID: 'Adresa de email nu este validă.',
        USERNAME_INVALID: 'Numele de utilizator trebuie să aibă între 3 și 30 de caractere (litere, cifre, punct, underscore sau cratimă).',
      };
      if (!messageMap[err.message]) console.error('[AuthController] register failed:', err);
      return res.status(400).json({
        error: err.message,
        message: messageMap[err.message] || 'A apărut o eroare la înregistrare.',
      });
    }
  }

  public static async login(req: Request, res: Response) {
    try {
      const { identifier, password } = req.body;
      if (!identifier || !password) {
        return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Introduceți email/utilizator și parola.' });
      }

      const { user, session } = await AuthService.login({
        identifier,
        password,
        ip: req.ip || 'unknown',
        userAgent: req.headers['user-agent'] || 'Unknown',
      });

      res.cookie('cinevault_session', session.token, SESSION_COOKIE_OPTIONS);
      return res.status(200).json({ user });
    } catch (err: any) {
      const messageMap: Record<string, string> = {
        INVALID_CREDENTIALS: 'Date de autentificare incorecte.',
        ACCOUNT_SUSPENDED: 'Contul dumneavoastră a fost suspendat de către administrator.',
        ACCOUNT_TEMPORARILY_LOCKED: 'Cont blocat temporar din cauza prea multor tentative eșuate (15 minute).',
      };
      if (!messageMap[err.message]) console.error('[AuthController] login failed:', err);
      return res.status(401).json({
        error: err.message,
        message: messageMap[err.message] || 'Autentificare eșuată.',
      });
    }
  }

  public static async logout(req: Request, res: Response) {
    const token = req.cookies['cinevault_session'];
    if (token) {
      await AuthService.logout(token, req.ip || 'unknown', req.headers['user-agent'] || 'Unknown');
    }
    res.clearCookie('cinevault_session');
    return res.json({ success: true, message: 'Deconectare reușită.' });
  }

  public static async me(req: Request, res: Response) {
    return res.json({ user: (req as any).user });
  }
}
