// ==============================================================================
// IV Concept VOD - Admin-editable settings
// Values stored in the Setting table override the environment variables at runtime:
// every saved value is applied into the live `config` object (in place), so the rest
// of the app keeps reading the same `config` it already imports. Deleting an override
// restores the value that was present in the environment when the server started.
// Secrets are encrypted with AES-256-GCM; their plaintext never leaves this module.
// ==============================================================================

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { db } from '../../db/index.ts';
import { config } from '../../config.ts';

export type SettingGroup = 'site' | 'video' | 'payments' | 'email' | 'company';

export interface SettingDef {
  key: string;
  secret: boolean;
  group: SettingGroup;
  /**
   * Value the key currently has inside `config`. Read once, before the overrides are applied,
   * so it is the real default declared in config.ts (used when there is no env variable).
   */
  read?(): string;
  /** Receives the effective value (override or, when null was written, the env value). */
  apply(value: string): void;
  /** Returns a Romanian error message, or null when the value is valid. */
  validate(value: string): string | null;
}

export interface SettingView {
  key: string;
  group: SettingGroup;
  secret: boolean;
  value: string | null;
  isSet: boolean;
  preview: string | null;
  source: 'admin' | 'env' | 'default' | 'none';
}

/** Environment values captured at startup, used whenever an override is removed. */
const ENV: Record<string, string> = {};

/**
 * Values read from `config` before the first override is applied, i.e. the real defaults
 * declared in config.ts. An override removal with no environment variable falls back to
 * these, so the key keeps its default instead of ending up empty.
 */
const DEFAULTS: Record<string, string> = {};
let defaultsCaptured = false;

function captureDefaults(): void {
  if (defaultsCaptured) return;
  for (const def of SETTING_DEFS) {
    if (def.read) DEFAULTS[def.key] = def.read();
  }
  defaultsCaptured = true;
}

function envValue(key: string): string {
  return ENV[key] ?? '';
}

/** What removing an override restores: the environment value, else the default from config. */
function fallbackValue(key: string): string {
  return envValue(key) || DEFAULTS[key] || '';
}

function senderAddress(): string {
  const raw = (config.smtp.from || '').trim();
  return (raw.match(/<([^<>]+)>/)?.[1] || raw).trim();
}

function isInteger(value: string): boolean {
  return /^\d+$/.test(value);
}

function intInRange(min: number, max: number, message: string) {
  return (value: string): string | null => {
    if (!value) return null;
    if (!isInteger(value) || Number(value) < min || Number(value) > max) return message;
    return null;
  };
}

export const SETTING_DEFS: SettingDef[] = [
  // --- Site ------------------------------------------------------------------
  {
    key: 'APP_URL',
    secret: false,
    group: 'site',
    apply: value => {
      config.appUrl = value.replace(/\/$/, '');
    },
    validate: value => {
      if (!value) return null;
      if (!/^https?:\/\//i.test(value)) return 'Trebuie să fie un URL complet, care începe cu https://.';
      if (config.isProduction && !/^https:\/\//i.test(value)) return 'În producție adresa trebuie să înceapă cu https://.';
      if (value.endsWith('/')) return 'Nu poate avea / la final.';
      try {
        new URL(value);
      } catch {
        return 'Trebuie să fie un URL valid (ex: https://ivconcept.ro).';
      }
      return null;
    },
  },

  // --- Video (Bunny Stream + playback) ---------------------------------------
  {
    key: 'BUNNY_STREAM_LIBRARY_ID',
    secret: false,
    group: 'video',
    apply: value => {
      config.bunny.libraryId = value;
    },
    validate: () => null,
  },
  {
    key: 'BUNNY_STREAM_API_KEY',
    secret: true,
    group: 'video',
    apply: value => {
      config.bunny.apiKey = value;
    },
    validate: () => null,
  },
  {
    key: 'BUNNY_STREAM_TOKEN_KEY',
    secret: true,
    group: 'video',
    apply: value => {
      config.bunny.tokenKey = value;
    },
    validate: () => null,
  },
  {
    key: 'MAX_CONCURRENT_STREAMS',
    secret: false,
    group: 'video',
    read: () => String(config.maxConcurrentStreams),
    apply: value => {
      config.maxConcurrentStreams = value ? Number(value) : 1;
    },
    validate: intInRange(1, 20, 'Trebuie să fie un număr întreg între 1 și 20.'),
  },
  {
    key: 'WATERMARK_TEXT',
    secret: false,
    group: 'video',
    read: () => config.watermark.text,
    apply: value => {
      config.watermark.text = value || 'ivconcept.ro';
    },
    validate: value => {
      if (!value) return null;
      if (value.length < 1 || value.length > 60) return 'Trebuie să aibă între 1 și 60 de caractere.';
      return null;
    },
  },
  {
    key: 'WATERMARK_INTERVAL_SECONDS',
    secret: false,
    group: 'video',
    read: () => String(config.watermark.intervalSeconds),
    apply: value => {
      config.watermark.intervalSeconds = value ? Number(value) : 5;
    },
    validate: intInRange(1, 300, 'Trebuie să fie un număr întreg între 1 și 300.'),
  },

  // --- Payments --------------------------------------------------------------
  {
    key: 'STRIPE_SECRET_KEY',
    secret: true,
    group: 'payments',
    apply: value => {
      config.stripe.secretKey = value;
    },
    validate: value => {
      if (!value) return null;
      if (!/^sk_(live|test)_/.test(value)) return 'Trebuie să fie o cheie secretă Stripe (sk_live_... sau sk_test_...).';
      return null;
    },
  },
  {
    key: 'STRIPE_WEBHOOK_SECRET',
    secret: true,
    group: 'payments',
    apply: value => {
      config.stripe.webhookSecret = value;
    },
    validate: value => {
      if (!value) return null;
      if (!value.startsWith('whsec_')) return 'Trebuie să fie un secret de webhook Stripe (whsec_...).';
      return null;
    },
  },
  {
    key: 'STRIPE_CURRENCY',
    secret: false,
    group: 'payments',
    read: () => config.stripe.currency,
    apply: value => {
      config.stripe.currency = (value || 'RON').toUpperCase();
    },
    validate: value => {
      if (!value) return null;
      if (!/^[A-Za-z]{3}$/.test(value)) return 'Trebuie să fie un cod de monedă din 3 litere (ex: RON).';
      return null;
    },
  },

  // --- Email (SMTP) ----------------------------------------------------------
  {
    key: 'SMTP_HOST',
    secret: false,
    group: 'email',
    apply: value => {
      config.smtp.host = value;
    },
    validate: () => null,
  },
  {
    key: 'SMTP_PORT',
    secret: false,
    group: 'email',
    read: () => String(config.smtp.port),
    apply: value => {
      config.smtp.port = value ? Number(value) : 587;
    },
    validate: intInRange(1, 65535, 'Trebuie să fie un număr întreg între 1 și 65535.'),
  },
  {
    key: 'SMTP_SECURE',
    secret: false,
    group: 'email',
    read: () => String(config.smtp.secure),
    apply: value => {
      config.smtp.secure = value ? value.toLowerCase() === 'true' : config.smtp.port === 465;
    },
    validate: value => {
      if (!value) return null;
      if (value.toLowerCase() !== 'true' && value.toLowerCase() !== 'false') return 'Valoarea trebuie să fie true sau false.';
      return null;
    },
  },
  {
    key: 'SMTP_USER',
    secret: false,
    group: 'email',
    apply: value => {
      config.smtp.user = value;
    },
    validate: () => null,
  },
  {
    key: 'SMTP_PASS',
    secret: true,
    group: 'email',
    apply: value => {
      config.smtp.pass = value;
    },
    validate: () => null,
  },
  {
    key: 'SMTP_FROM',
    secret: false,
    group: 'email',
    apply: value => {
      config.smtp.from = value;
    },
    validate: () => null,
  },

  // --- Company (invoices, legal pages) --------------------------------------
  {
    key: 'COMPANY_NAME',
    secret: false,
    group: 'company',
    apply: value => {
      config.company.name = value;
    },
    validate: () => null,
  },
  {
    key: 'COMPANY_CIF',
    secret: false,
    group: 'company',
    apply: value => {
      config.company.cif = value;
    },
    validate: () => null,
  },
  {
    key: 'COMPANY_ADDRESS',
    secret: false,
    group: 'company',
    apply: value => {
      config.company.address = value;
    },
    validate: () => null,
  },
  {
    key: 'COMPANY_EMAIL',
    secret: false,
    group: 'company',
    apply: value => {
      config.company.email = value || senderAddress();
    },
    validate: () => null,
  },
  {
    key: 'VAT_RATE',
    secret: false,
    group: 'company',
    read: () => String(config.company.vatRate),
    apply: value => {
      config.company.vatRate = value ? Number(value) : 0.21;
    },
    validate: value => {
      if (!value) return null;
      const rate = Number(value);
      if (!Number.isFinite(rate) || rate < 0 || rate > 1) return 'Trebuie să fie un număr între 0 și 1 (ex: 0.21).';
      return null;
    },
  },
  {
    key: 'INVOICE_SERIES',
    secret: false,
    group: 'company',
    read: () => config.company.invoiceSeries,
    apply: value => {
      config.company.invoiceSeries = value || 'CNV';
    },
    validate: () => null,
  },
];

const DEF_BY_KEY = new Map(SETTING_DEFS.map(def => [def.key, def]));

for (const def of SETTING_DEFS) {
  ENV[def.key] = (process.env[def.key] || '').trim();
}

// --- Secret storage (AES-256-GCM, "iv:tag:cipher", all base64) -----------------

let cachedKey: Buffer | null = null;

function keyFilePath(): string {
  return path.join(config.uploadDir, '.settings.key');
}

function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = (process.env.SETTINGS_ENCRYPTION_KEY || '').trim();
  if (fromEnv) {
    cachedKey = crypto.createHash('sha256').update(fromEnv).digest();
    return cachedKey;
  }

  const file = keyFilePath();
  try {
    cachedKey = fs.readFileSync(file);
    return cachedKey;
  } catch {
    // Missing key file: create it (32 random bytes, owner-only, never overwrite an existing one)
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
    }
    cachedKey = fs.readFileSync(file);
    return cachedKey;
  }
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

function decrypt(payload: string): string {
  const [iv, tag, data] = payload.split(':');
  if (!iv || !tag || !data) throw new Error('INVALID_CIPHERTEXT');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export class SettingsService {
  private static listeners = new Set<() => void | Promise<void>>();

  /**
   * Reads every stored setting and applies it over `config`.
   * An undecryptable secret is logged (without its value) and left on the env value.
   */
  public static async load(): Promise<void> {
    // Snapshot of the config values before any override is applied: removing an override
    // has to restore exactly this state (env value, or the default from config.ts)
    captureDefaults();

    const rows = await db.setting.findMany();
    const byKey = new Map(rows.map(row => [row.key, row]));

    for (const def of SETTING_DEFS) {
      const row = byKey.get(def.key);
      let value: string | null = null;

      if (row) {
        if (def.secret) {
          try {
            value = decrypt(row.value);
          } catch {
            console.error(`[SettingsService] Could not decrypt setting ${def.key}; keeping the environment value.`);
            value = null;
          }
        } else {
          value = row.value;
        }
      }

      def.apply(value ?? fallbackValue(def.key));
    }
  }

  /**
   * Every key with its state. Secret values are never returned, only a masked preview.
   */
  public static async list(): Promise<SettingView[]> {
    const rows = await db.setting.findMany();
    const byKey = new Map(rows.map(row => [row.key, row]));

    return SETTING_DEFS.map(def => {
      const row = byKey.get(def.key);

      const fallback = fallbackValue(def.key);
      const source: SettingView['source'] = row
        ? 'admin'
        : envValue(def.key)
          ? 'env'
          : fallback
            ? 'default'
            : 'none';

      // A secret can come from the environment just as well as from an admin override,
      // so its state is read from the effective value (admin, else env), never from the row alone.
      let secretValue: string | null = null;
      if (def.secret) {
        if (row) {
          try {
            secretValue = decrypt(row.value);
          } catch {
            secretValue = null;
          }
        }
        if (secretValue === null) secretValue = envValue(def.key) || null;
      }

      let preview: string | null = null;
      if (secretValue) {
        preview = secretValue.length >= 12 ? `••••${secretValue.slice(-4)}` : '••••';
      }

      return {
        key: def.key,
        group: def.group,
        secret: def.secret,
        value: def.secret ? null : row ? row.value : fallback,
        isSet: def.secret ? Boolean(secretValue) : Boolean(row) || source === 'default',
        preview,
        source,
      };
    });
  }

  /**
   * Saves overrides. `null` removes the override (the value falls back to the environment).
   * All values are validated before anything is written; writes are transactional.
   */
  public static async update(
    values: Record<string, string | null | undefined>,
    actorId: string | null = null
  ): Promise<void> {
    const ops: { def: SettingDef; value: string | null }[] = [];

    for (const [key, raw] of Object.entries(values || {})) {
      const def = DEF_BY_KEY.get(key);
      if (!def) {
        const err: any = new Error(`Setare necunoscută: ${key}`);
        err.key = key;
        err.details = { key, message: 'Setare necunoscută.' };
        throw err;
      }
      if (raw === undefined) continue;
      if (raw === null) {
        ops.push({ def, value: null });
        continue;
      }

      const value = String(raw).trim();
      const message = def.validate(value);
      if (message) {
        const err: any = new Error(message);
        err.key = key;
        err.details = { key, message };
        throw err;
      }
      ops.push({ def, value });
    }

    if (!ops.length) return;

    await db.$transaction(async tx => {
      for (const { def, value } of ops) {
        if (value === null) {
          await tx.setting.deleteMany({ where: { key: def.key } });
          continue;
        }
        const stored = def.secret ? encrypt(value) : value;
        await tx.setting.upsert({
          where: { key: def.key },
          create: { key: def.key, value: stored, isSecret: def.secret, updatedBy: actorId },
          update: { value: stored, isSecret: def.secret, updatedBy: actorId },
        });
      }
    });

    // Applied only after the transaction succeeded, so a failed save changes nothing in memory
    for (const { def, value } of ops) {
      def.apply(value ?? fallbackValue(def.key));
    }

    for (const listener of [...this.listeners]) {
      try {
        await listener();
      } catch (err) {
        console.error('[SettingsService] A settings change listener failed:', err);
      }
    }
  }

  /** Registers a callback run after every successful save (used to reset cached clients). */
  public static onChange(fn: () => void | Promise<void>): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
