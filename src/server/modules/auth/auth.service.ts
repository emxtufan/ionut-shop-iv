// ==============================================================================
// IV Concept VOD - Authentication & Session Service
// ==============================================================================

import crypto from 'crypto';
import { Prisma, type User as DbUser, type Session } from '@prisma/client';
import { db, hashPassword, verifyPassword } from '../../db/index.ts';
import { config } from '../../config.ts';
import { AuditService } from '../audit/audit.service.ts';
import { EmailService } from '../email/email.service.ts';

export type PublicUser = Omit<DbUser, 'passwordHash'>;

export function toPublicUser({ passwordHash, ...user }: DbUser): PublicUser {
  return user;
}

export class AuthService {
  /**
   * Helper to parse simple user-agent device string
   */
  public static parseDevice(userAgent: string): string {
    let os = 'Unknown OS';
    let browser = 'Browser';

    if (/iphone|ipad|ipod/i.test(userAgent)) os = 'iOS';
    else if (/android/i.test(userAgent)) os = 'Android';
    else if (/macintosh|mac os x/i.test(userAgent)) os = 'macOS';
    else if (/windows/i.test(userAgent)) os = 'Windows';
    else if (/linux/i.test(userAgent)) os = 'Linux';

    if (/edg/i.test(userAgent)) browser = 'Edge';
    else if (/chrome|crios/i.test(userAgent)) browser = 'Chrome';
    else if (/firefox|fxios/i.test(userAgent)) browser = 'Firefox';
    else if (/safari/i.test(userAgent)) browser = 'Safari';

    return `${browser} pe ${os}`;
  }

  /**
   * Register a new user
   */
  public static async register(params: {
    email: string;
    username: string;
    password: string;
    ip: string;
    userAgent: string;
  }): Promise<{ user: PublicUser; session: Session }> {
    const email = params.email.trim().toLowerCase();
    const username = params.username.trim();

    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('EMAIL_INVALID');
    }

    if (username.length < 3 || username.length > 30 || !/^[\p{L}\p{N}._-]+$/u.test(username)) {
      throw new Error('USERNAME_INVALID');
    }

    if (params.password.length < 8) {
      throw new Error('PASSWORD_TOO_SHORT');
    }

    if (params.password.length > 128) {
      throw new Error('PASSWORD_TOO_LONG');
    }

    if (await db.user.findUnique({ where: { email } })) {
      throw new Error('EMAIL_ALREADY_EXISTS');
    }
    if (await db.user.findFirst({ where: { username: { equals: username, mode: 'insensitive' } } })) {
      throw new Error('USERNAME_ALREADY_EXISTS');
    }

    let newUser: DbUser;
    try {
      newUser = await db.user.create({
        data: {
          email,
          username,
          passwordHash: hashPassword(params.password),
          lastLoginAt: new Date(),
          lastLoginIp: params.ip,
        },
      });
    } catch (err) {
      // Lost a race with a concurrent registration for the same email/username
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new Error('EMAIL_ALREADY_EXISTS');
      }
      throw err;
    }

    AuditService.logEvent({
      eventType: 'USER_REGISTERED',
      userId: newUser.id,
      ip: params.ip,
      userAgent: params.userAgent,
      metadata: { email: newUser.email, username: newUser.username },
    });

    const session = await this.createSession(newUser.id, params.ip, params.userAgent);
    const user = toPublicUser(newUser);

    EmailService.sendWelcomeEmail(user, params.ip, params.userAgent).catch(err => {
      console.error('[AuthService] Error dispatching welcome email:', err);
    });

    return { user, session };
  }

  /**
   * Login with email or username and password
   */
  public static async login(params: {
    identifier: string; // email or username
    password: string;
    ip: string;
    userAgent: string;
  }): Promise<{ user: PublicUser; session: Session }> {
    const ident = params.identifier.trim();
    const user = await db.user.findFirst({
      where: {
        OR: [
          { email: ident.toLowerCase() },
          { username: { equals: ident, mode: 'insensitive' } },
        ],
      },
    });

    if (!user) {
      AuditService.logEvent({
        eventType: 'USER_LOGIN_FAILED',
        severity: 'WARNING',
        ip: params.ip,
        userAgent: params.userAgent,
        metadata: { identifier: params.identifier, reason: 'USER_NOT_FOUND' },
      });
      throw new Error('INVALID_CREDENTIALS');
    }

    if (user.isSuspended) {
      AuditService.logEvent({
        eventType: 'USER_LOGIN_FAILED',
        severity: 'CRITICAL',
        userId: user.id,
        ip: params.ip,
        userAgent: params.userAgent,
        metadata: { reason: 'ACCOUNT_SUSPENDED' },
      });
      throw new Error('ACCOUNT_SUSPENDED');
    }

    if (user.lockoutUntil && user.lockoutUntil.getTime() > Date.now()) {
      AuditService.logEvent({
        eventType: 'USER_LOGIN_FAILED',
        severity: 'CRITICAL',
        userId: user.id,
        ip: params.ip,
        userAgent: params.userAgent,
        metadata: { reason: 'ACCOUNT_TEMPORARILY_LOCKED', lockoutUntil: user.lockoutUntil },
      });
      throw new Error('ACCOUNT_TEMPORARILY_LOCKED');
    }

    // A password past the bcrypt input limit cannot match any stored hash: fail like a wrong password, no hashing
    if (params.password.length > 128) {
      throw new Error('INVALID_CREDENTIALS');
    }

    if (!verifyPassword(params.password, user.passwordHash)) {
      const attempts = user.failedLoginAttempts + 1;
      const lockoutUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null; // 15 min
      await db.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: attempts, lockoutUntil },
      });

      AuditService.logEvent({
        eventType: lockoutUntil ? 'TOO_MANY_LOGIN_ATTEMPTS' : 'USER_LOGIN_FAILED',
        severity: lockoutUntil ? 'CRITICAL' : 'WARNING',
        userId: user.id,
        ip: params.ip,
        userAgent: params.userAgent,
        metadata: { attempts, lockoutUntil },
      });
      throw new Error('INVALID_CREDENTIALS');
    }

    const updated = await db.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockoutUntil: null, lastLoginAt: new Date(), lastLoginIp: params.ip },
    });

    const session = await this.createSession(user.id, params.ip, params.userAgent);

    AuditService.logEvent({
      eventType: 'USER_LOGIN_SUCCESS',
      userId: user.id,
      ip: params.ip,
      userAgent: params.userAgent,
      device: session.deviceType,
      metadata: { role: user.role },
    });

    return { user: toPublicUser(updated), session };
  }

  /**
   * Creates a persisted session with an opaque random token
   */
  public static async createSession(userId: string, ip: string, userAgent: string): Promise<Session> {
    return db.session.create({
      data: {
        userId,
        token: `sess_${crypto.randomBytes(32).toString('hex')}`,
        ip,
        userAgent,
        deviceType: this.parseDevice(userAgent),
        expiresAt: new Date(Date.now() + config.sessionDurationDays * 86400000),
      },
    });
  }

  /**
   * Validate session token
   */
  public static async validateSession(token: string): Promise<{ user: PublicUser; session: Session } | null> {
    if (!token) return null;
    const session = await db.session.findUnique({ where: { token }, include: { user: true } });
    if (!session) return null;

    if (session.expiresAt.getTime() < Date.now()) {
      await db.session.delete({ where: { id: session.id } }).catch(() => {});
      return null;
    }
    if (session.user.isSuspended) return null;

    // Throttle activity writes to once a minute per session
    if (Date.now() - session.lastActiveAt.getTime() > 60000) {
      await db.session.update({ where: { id: session.id }, data: { lastActiveAt: new Date() } });
    }

    const { user, ...sessionOnly } = session;
    return { user: toPublicUser(user), session: sessionOnly };
  }

  /**
   * Invalidate a single session
   */
  public static async logout(token: string, ip: string, userAgent: string) {
    const session = await db.session.findUnique({ where: { token } });
    if (!session) return;

    await db.session.delete({ where: { id: session.id } });
    AuditService.logEvent({
      eventType: 'USER_LOGOUT',
      userId: session.userId,
      ip,
      userAgent,
    });
  }
}
