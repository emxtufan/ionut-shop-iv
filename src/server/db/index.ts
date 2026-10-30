// ==============================================================================
// IV Concept VOD - Database (PostgreSQL via Prisma)
// ==============================================================================

import crypto from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { config } from '../config.ts';

// Serialize Decimal columns (prices, amounts) as JSON numbers instead of strings
(Prisma.Decimal.prototype as any).toJSON = function () {
  return this.toNumber();
};

export const db = new PrismaClient();

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

export function verifyPassword(password: string, combinedHash: string): boolean {
  try {
    const [salt, key] = combinedHash.split(':');
    if (!salt || !key) return false;
    const keyBuffer = Buffer.from(key, 'hex');
    const derivedKey = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(keyBuffer, derivedKey);
  } catch {
    return false;
  }
}

/**
 * Creates the first SUPER_ADMIN from ADMIN_EMAIL / ADMIN_PASSWORD when the database has no admin.
 */
export async function ensureAdminUser() {
  const adminCount = await db.user.count({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } } });
  if (adminCount > 0) return;

  const { email, password } = config.admin;
  if (!email || !password) {
    console.warn('[IV Concept] No admin account exists. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env and restart.');
    return;
  }
  if (password.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
  }

  await db.user.upsert({
    where: { email },
    update: { role: 'SUPER_ADMIN' },
    create: {
      email,
      username: email.split('@')[0],
      passwordHash: hashPassword(password),
      role: 'SUPER_ADMIN',
    },
  });
  console.log(`[IV Concept] SUPER_ADMIN account ready for ${email}. You can now remove ADMIN_PASSWORD from .env.`);
}
