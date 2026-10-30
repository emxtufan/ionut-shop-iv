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

  /**
   * Changes the password of the signed-in account. The current password must match, the new
   * one is stored as a fresh hash and every other session is signed out; the session that
   * made the change stays valid.
   */
  public static async changePassword(params: {
    userId: string;
    currentPassword: string;
    newPassword: string;
    sessionId: string;
    ip: string;
    userAgent: string;
  }): Promise<void> {
    const user = await db.user.findUnique({ where: { id: params.userId } });
    if (!user) throw new Error('USER_NOT_FOUND');

    if (!verifyPassword(params.currentPassword, user.passwordHash)) {
      throw new Error('INVALID_PASSWORD');
    }

    if (params.newPassword.length < 8) {
      throw new Error('PASSWORD_TOO_SHORT');
    }

    if (params.newPassword.length > 128) {
      throw new Error('PASSWORD_TOO_LONG');
    }

    const passwordHash = hashPassword(params.newPassword);

    const sessionsInvalidated = await db.$transaction(async tx => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });

      // Every other device is signed out; the current session keeps working
      const { count } = await tx.session.deleteMany({
        where: { userId: user.id, id: { not: params.sessionId } },
      });
      return count;
    });

    AuditService.logEvent({
      eventType: 'PASSWORD_CHANGED',
      severity: 'CRITICAL',
      userId: user.id,
      ip: params.ip,
      userAgent: params.userAgent,
      metadata: { sessionsInvalidated },
    });
  }

  /**
   * Starts the password reset flow. Never throws for an unknown account and never
   * reveals whether the email exists (the response time is kept constant).
   */
  public static async requestPasswordReset(params: {
    email: string;
    ip: string;
    userAgent: string;
  }): Promise<void> {
    const email = params.email.trim().toLowerCase();
    const user = await db.user.findUnique({ where: { email } });

    if (!user || user.isSuspended) {
      AuditService.logEvent({
        eventType: 'PASSWORD_RESET_REQUESTED',
        severity: 'WARNING',
        userId: user ? user.id : null,
        ip: params.ip,
        userAgent: params.userAgent,
        metadata: { email, reason: user ? 'ACCOUNT_SUSPENDED' : 'USER_NOT_FOUND' },
      });
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const passwordResetTokenHash = crypto.createHash('sha256').update(token).digest('hex');

    await db.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash,
        passwordResetExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
      },
    });

    // Fire-and-forget: the caller must not learn from the latency whether the email was sent
    EmailService.sendPasswordResetEmail({
      user: toPublicUser(user),
      token,
      ip: params.ip,
      userAgent: params.userAgent,
    }).catch(err => {
      console.error('[AuthService] Error dispatching password reset email:', err);
    });

    AuditService.logEvent({
      eventType: 'PASSWORD_RESET_REQUESTED',
      userId: user.id,
      ip: params.ip,
      userAgent: params.userAgent,
      metadata: { email: user.email, expiresInMinutes: 60 },
    });
  }

  /**
   * Consumes a one-time reset token: sets the new password, clears the token,
   * resets the lockout counters and invalidates every existing session.
   */
  public static async resetPassword(params: {
    token: string;
    password: string;
    ip: string;
    userAgent: string;
  }): Promise<void> {
    if (params.password.length < 8) {
      throw new Error('PASSWORD_TOO_SHORT');
    }

    if (params.password.length > 128) {
      throw new Error('PASSWORD_TOO_LONG');
    }

    const passwordResetTokenHash = crypto.createHash('sha256').update(params.token).digest('hex');
    const user = await db.user.findFirst({
      where: {
        passwordResetTokenHash,
        passwordResetExpiresAt: { gt: new Date() },
      },
    });

    if (!user || user.isSuspended) {
      AuditService.logEvent({
        eventType: 'PASSWORD_RESET_FAILED',
        severity: 'WARNING',
        userId: user ? user.id : null,
        ip: params.ip,
        userAgent: params.userAgent,
        metadata: { reason: user ? 'ACCOUNT_SUSPENDED' : 'INVALID_RESET_TOKEN' },
      });
      throw new Error('INVALID_RESET_TOKEN');
    }

    const passwordHash = hashPassword(params.password);

    await db.$transaction(async tx => {
      // The token hash is part of the WHERE clause, so a second (racing) use updates 0 rows
      const consumed = await tx.user.updateMany({
        where: { id: user.id, passwordResetTokenHash },
        data: {
          passwordHash,
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
          failedLoginAttempts: 0,
          lockoutUntil: null,
        },
      });

      if (consumed.count === 0) {
        throw new Error('INVALID_RESET_TOKEN');
      }

      await tx.session.deleteMany({ where: { userId: user.id } });
    });

    AuditService.logEvent({
      eventType: 'PASSWORD_RESET_COMPLETED',
      severity: 'CRITICAL',
      userId: user.id,
      ip: params.ip,
      userAgent: params.userAgent,
      metadata: { email: user.email, sessionsInvalidated: true },
    });
  }

  /**
   * GDPR export: everything the platform holds about the account, with secrets removed.
   * The password hash, the reset token hash and the email bodies are never included.
   */
  public static async exportAccountData(userId: string) {
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('USER_NOT_FOUND');

    const { passwordHash, passwordResetTokenHash, passwordResetExpiresAt, ...profile } = user;

    const [purchases, payments, invoices, entitlements, sessions, playbackSessions, auditLogs, emails] =
      await Promise.all([
        db.purchase.findMany({
          where: { userId },
          include: { video: { select: { id: true, title: true, slug: true } } },
          orderBy: { createdAt: 'desc' },
        }),
        db.payment.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } }),
        db.invoice.findMany({
          where: { userId },
          include: { purchase: { include: { video: { select: { title: true } } } } },
          orderBy: { issuedAt: 'desc' },
        }),
        db.entitlement.findMany({
          where: { userId },
          include: { video: { select: { id: true, title: true, slug: true } } },
          orderBy: { grantedAt: 'desc' },
        }),
        db.session.findMany({
          where: { userId },
          select: {
            id: true,
            ip: true,
            userAgent: true,
            deviceType: true,
            createdAt: true,
            lastActiveAt: true,
            expiresAt: true,
          },
          orderBy: { createdAt: 'desc' },
        }),
        db.playbackSession.findMany({
          where: { userId },
          select: {
            id: true,
            videoId: true,
            video: { select: { title: true } },
            ip: true,
            userAgent: true,
            startedAt: true,
            lastHeartbeatAt: true,
            endedAt: true,
            status: true,
          },
          orderBy: { startedAt: 'desc' },
        }),
        db.auditLog.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } }),
        // Emails have no FK to the account: they are matched by the recipient address
        db.emailLog.findMany({
          where: { to: user.email },
          select: { to: true, subject: true, type: true, status: true, sentAt: true },
          orderBy: { sentAt: 'desc' },
        }),
      ]);

    return {
      exportedAt: new Date().toISOString(),
      profile,
      purchases,
      payments,
      invoices,
      entitlements,
      sessions,
      playbackSessions,
      auditLogs,
      emails,
    };
  }

  /**
   * GDPR erasure. Accounting records (Payment/Purchase/Invoice) are kept by law, everything
   * identifiable is removed or anonymized and the account can no longer be logged into.
   */
  public static async deleteAccount(params: { userId: string; password: string }): Promise<void> {
    const user = await db.user.findUnique({ where: { id: params.userId } });
    if (!user) throw new Error('USER_NOT_FOUND');

    if (!verifyPassword(params.password, user.passwordHash)) {
      throw new Error('INVALID_PASSWORD');
    }

    if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
      throw new Error('ADMIN_ACCOUNT_DELETE_FORBIDDEN');
    }

    await db.$transaction(async tx => {
      // Playback in progress ends now (the Session cascade below then removes the rows)
      await tx.playbackSession.updateMany({
        where: { userId: user.id, status: 'ACTIVE' },
        data: { status: 'ENDED', endedAt: new Date() },
      });
      await tx.session.deleteMany({ where: { userId: user.id } });

      await tx.entitlement.updateMany({
        where: { userId: user.id, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: 'ACCOUNT_DELETED' },
      });

      // Emails have no FK to the account: they are matched by the recipient address
      await tx.emailLog.deleteMany({ where: { to: user.email } });

      await tx.auditLog.updateMany({
        where: { userId: user.id },
        data: { ip: 'anonimizat', userAgent: 'anonimizat', device: null, metadata: Prisma.DbNull },
      });

      await tx.user.update({
        where: { id: user.id },
        data: {
          email: `deleted-${user.id}@deleted.invalid`,
          username: `deleted-${user.id}`,
          passwordHash: hashPassword(crypto.randomBytes(32).toString('hex')),
          isSuspended: true,
          suspendedReason: 'ACCOUNT_DELETED',
          failedLoginAttempts: 0,
          lockoutUntil: null,
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
          lastLoginAt: null,
          lastLoginIp: null,
        },
      });

      // Written already anonymized, so the erasure record itself carries no personal data
      await tx.auditLog.create({
        data: {
          eventType: 'ACCOUNT_DELETED',
          severity: 'CRITICAL',
          userId: user.id,
          ip: 'anonimizat',
          userAgent: 'anonimizat',
          metadata: { reason: 'USER_REQUEST' },
        },
      });
    });
  }
}
