// ==============================================================================
// IV Concept VOD - Admin: Settings Tab (SUPER_ADMIN only)
// Every editable setting with its source (admin / .env / not set), masked secrets,
// per-group save + connection tests, and a "launch status" summary on top.
// ==============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { Input, Switch, Tag, Button, Popconfirm, Alert, message } from 'antd';
import { ChangePasswordForm } from '../components/ChangePasswordForm.tsx';

type TestKey = 'bunny' | 'stripe' | 'smtp' | 'fgo';
type LaunchState = 'ok' | 'fail' | 'pending';

interface SettingView {
  key: string;
  group: string;
  secret: boolean;
  value: string | null;
  isSet: boolean;
  preview: string | null;
  source: 'admin' | 'env' | 'default' | 'none';
}

interface Infrastructure {
  nodeEnv: string;
  port: number;
  trustProxyHops: number;
  uploadDir: string;
}

interface TestResult {
  ok: boolean;
  message: string;
  details?: Record<string, any>;
}

interface FieldDef {
  key: string;
  label: string;
  type?: 'text' | 'password' | 'switch' | 'percent';
  placeholder?: string;
  help?: string;
}

interface CardDef {
  key: string;
  title: string;
  help?: string;
  fields: FieldDef[];
  test?: TestKey;
}

const TEST_URLS: Record<TestKey, string> = {
  bunny: '/api/admin/settings/test/bunny',
  stripe: '/api/admin/settings/test/stripe',
  smtp: '/api/admin/settings/test/smtp',
  fgo: '/api/admin/settings/test/fgo',
};

const TEST_LABELS: Record<TestKey, string> = {
  bunny: 'Testează Bunny',
  stripe: 'Testează Stripe',
  smtp: 'Testează emailul',
  fgo: 'FGO',
};

const CARDS: CardDef[] = [
  {
    key: 'site',
    title: 'Site',
    help: 'Adresa publică a site-ului, folosită în linkuri, emailuri și la webhook-ul Stripe.',
    fields: [
      {
        key: 'APP_URL',
        label: 'Adresa site-ului',
        placeholder: 'https://shop.ivconcept.ro',
        help: 'ex. https://shop.ivconcept.ro',
      },
    ],
  },
  {
    key: 'video',
    title: 'Bunny Stream',
    help: 'Bunny → Stream → biblioteca ta → API. Pune adresa site-ului la Allowed Domains și activează autentificarea cu token pentru embed.',
    fields: [
      { key: 'BUNNY_STREAM_LIBRARY_ID', label: 'ID bibliotecă' },
      { key: 'BUNNY_STREAM_API_KEY', label: 'Cheie API', type: 'password' },
      { key: 'BUNNY_STREAM_TOKEN_KEY', label: 'Cheie token (embed)', type: 'password' },
    ],
    test: 'bunny',
  },
  {
    key: 'payments',
    title: 'Stripe',
    help: 'Stripe → Developers → API keys.',
    fields: [
      { key: 'STRIPE_SECRET_KEY', label: 'Cheie secretă', type: 'password' },
      { key: 'STRIPE_WEBHOOK_SECRET', label: 'Secret webhook', type: 'password' },
      { key: 'STRIPE_CURRENCY', label: 'Monedă', placeholder: 'RON' },
    ],
    test: 'stripe',
  },
  {
    key: 'email',
    title: 'Email (SMTP)',
    help: 'Serverul de email folosit pentru confirmări, facturi și resetarea parolei.',
    fields: [
      { key: 'SMTP_HOST', label: 'Host SMTP', placeholder: 'smtp.example.com' },
      { key: 'SMTP_PORT', label: 'Port', placeholder: '587' },
      { key: 'SMTP_SECURE', label: 'Conexiune securizată (SSL/TLS)', type: 'switch' },
      { key: 'SMTP_USER', label: 'Utilizator', placeholder: 'nume@example.com' },
      { key: 'SMTP_PASS', label: 'Parolă', type: 'password' },
      { key: 'SMTP_FROM', label: 'Expeditor (From)', placeholder: 'IV Concept <nume@example.com>' },
    ],
    test: 'smtp',
  },
  {
    key: 'company',
    title: 'Firmă',
    help: 'Datele care apar pe facturi și în paginile legale.',
    fields: [
      { key: 'COMPANY_NAME', label: 'Nume firmă' },
      { key: 'COMPANY_CIF', label: 'CIF' },
      { key: 'COMPANY_ADDRESS', label: 'Adresă' },
      { key: 'COMPANY_EMAIL', label: 'Email' },
      { key: 'VAT_RATE', label: 'Cotă TVA', type: 'percent', help: 'Se scrie procentul, ex. 21 pentru 21%.' },
      { key: 'INVOICE_SERIES', label: 'Serie factură', placeholder: 'CNV' },
    ],
  },
  {
    key: 'player',
    title: 'Player',
    help: 'Limitele de redare și marcajul de apă afișat peste filme.',
    fields: [
      { key: 'MAX_CONCURRENT_STREAMS', label: 'Stream-uri simultane (max.)', placeholder: '1' },
      { key: 'WATERMARK_TEXT', label: 'Text watermark', placeholder: 'ivconcept.ro' },
      { key: 'WATERMARK_INTERVAL_SECONDS', label: 'Interval watermark (secunde)', placeholder: '5' },
    ],
  },
  {
    key: 'fgo',
    title: 'Facturare FGO',
    help: 'FGO → Setări eCommerce → API. Adresa platformei trebuie înregistrată în FGO, iar cheia API și codul unic se copiază din contul FGO.',
    fields: [
      { key: 'FGO_ENABLED', label: 'Facturare prin FGO', type: 'switch' },
      {
        key: 'FGO_API_URL',
        label: 'Adresa API',
        placeholder: 'https://api.fgo.ro',
        help: 'Pentru testare: https://api-testuat.fgo.ro',
      },
      { key: 'FGO_API_KEY', label: 'Cheie API', type: 'password' },
      { key: 'FGO_COD_UNIC', label: 'Cod unic', help: 'Doar cifre, fără RO.' },
      {
        key: 'FGO_PLATFORM_URL',
        label: 'Adresa platformei',
        placeholder: 'https://shop.ivconcept.ro',
        help: 'Adresa trebuie înregistrată în FGO la Setări eCommerce → API.',
      },
      { key: 'FGO_SERIES', label: 'Serie factură' },
      { key: 'FGO_STORNO_SERIES', label: 'Serie storno (opțional)' },
      {
        key: 'FGO_LAST_NUMBER',
        label: 'Ultimul număr de factură emis',
        help: 'Numărul la care ai rămas. Următoarea factură primește numărul +1. Gol = FGO alocă numărul din registru.',
      },
      { key: 'FGO_INVOICE_TYPE', label: 'Tip factură', placeholder: 'F' },
      { key: 'FGO_PAYMENT_TYPE', label: 'Tip plată', placeholder: 'Banca', help: 'Chitanta, Bon sau Banca.' },
      { key: 'FGO_UM', label: 'Unitate de măsură', placeholder: 'buc' },
      { key: 'FGO_SEND_SPV', label: 'Trimite factura în SPV', type: 'switch' },
    ],
    test: 'fgo',
  },
];

// The stored VAT rate is a fraction (0.21); the field shows a percentage (21)
function toInputValue(key: string, raw: string): string {
  if (key !== 'VAT_RATE') return raw;
  if (raw === '') return '';
  const rate = Number(raw);
  return Number.isFinite(rate) ? String(parseFloat((rate * 100).toFixed(4))) : raw;
}

function toStoredValue(key: string, input: string): string {
  if (key !== 'VAT_RATE') return input;
  if (input === '') return '';
  const percent = Number(input);
  return Number.isFinite(percent) ? String(percent / 100) : input;
}

function sourceTag(source: SettingView['source']) {
  if (source === 'admin') return <Tag color="blue">Admin</Tag>;
  if (source === 'env') return <Tag color="gold">.env</Tag>;
  if (source === 'default') return <Tag>Implicit</Tag>;
  return <Tag>Necompletat</Tag>;
}

export const AdminSettingsTab: React.FC = () => {
  const [settings, setSettings] = useState<SettingView[]>([]);
  const [infrastructure, setInfrastructure] = useState<Infrastructure | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [initial, setInitial] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [tests, setTests] = useState<Partial<Record<TestKey, TestResult>>>({});
  const [runningTests, setRunningTests] = useState<Partial<Record<TestKey, boolean>>>({});
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [savingCard, setSavingCard] = useState<string | null>(null);
  const [isCreatingWebhook, setIsCreatingWebhook] = useState<boolean>(false);

  const byKey = useMemo(() => {
    const map: Record<string, SettingView> = {};
    for (const item of settings) map[item.key] = item;
    return map;
  }, [settings]);

  // Secrets always start empty: the plaintext never reaches the browser
  const applySettings = (list: SettingView[]) => {
    const next: Record<string, string> = {};
    for (const item of list) {
      next[item.key] = item.secret ? '' : toInputValue(item.key, item.value ?? '');
    }
    setSettings(list);
    setValues(next);
    setInitial(next);
  };

  // After a save only the fields that were just written are refreshed: whatever was typed
  // and not saved in the other cards stays put, and the saved secrets are wiped from state
  const applySettingsPartially = (list: SettingView[], touched: string[]) => {
    const fresh: Record<string, string> = {};
    for (const item of list) {
      fresh[item.key] = item.secret ? '' : toInputValue(item.key, item.value ?? '');
    }
    const patch = (prev: Record<string, string>) => {
      const next = { ...prev };
      for (const key of touched) {
        if (key in fresh) next[key] = fresh[key];
      }
      return next;
    };
    setSettings(list);
    setValues(patch);
    setInitial(patch);
  };

  const loadSettings = async (touched?: string[]) => {
    try {
      const res = await fetch('/api/admin/settings');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        message.error(data.message || 'Eroare la încărcarea setărilor.');
        return;
      }
      if (touched) applySettingsPartially(data.settings || [], touched);
      else applySettings(data.settings || []);
      setInfrastructure(data.infrastructure || null);
    } catch {
      message.error('Eroare de conexiune la încărcarea setărilor.');
    }
  };

  const runTest = async (key: TestKey): Promise<void> => {
    setRunningTests((prev) => ({ ...prev, [key]: true }));
    try {
      const res = await fetch(TEST_URLS[key], { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      setTests((prev) => ({
        ...prev,
        [key]: {
          ok: Boolean(data.ok),
          message: data.message || (res.ok ? 'Testul nu a returnat niciun mesaj.' : `Testul a eșuat (HTTP ${res.status}).`),
          details: data.details,
        },
      }));
    } catch {
      setTests((prev) => ({ ...prev, [key]: { ok: false, message: 'Eroare de conexiune la rularea testului.' } }));
    } finally {
      setRunningTests((prev) => ({ ...prev, [key]: false }));
    }
  };

  const runAllTests = () => Promise.all([runTest('bunny'), runTest('stripe'), runTest('smtp'), runTest('fgo')]);

  useEffect(() => {
    const boot = async () => {
      setIsLoading(true);
      await Promise.all([loadSettings(), runAllTests()]);
      setIsLoading(false);
    };
    boot();
  }, []);

  const setFieldValue = (key: string, next: string) => {
    setValues((prev) => ({ ...prev, [key]: next }));
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });
  };

  const handleSave = async (card: CardDef) => {
    const payload: Record<string, string> = {};
    for (const field of card.fields) {
      const current = (values[field.key] ?? '').trim();
      // An empty secret means "leave it as it is"
      if (field.type === 'password') {
        if (current) payload[field.key] = current;
        continue;
      }
      if (current !== (initial[field.key] ?? '')) {
        payload[field.key] = toStoredValue(field.key, current);
      }
    }

    if (!Object.keys(payload).length) {
      message.info('Nu ai modificat nicio valoare.');
      return;
    }

    setSavingCard(card.key);
    setFieldErrors({});
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: payload }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // A 400 names the rejected key, so the message lands on that field
        if (data.key) setFieldErrors({ [data.key]: data.message || 'Valoare invalidă.' });
        else message.error(data.message || 'Setările nu au putut fi salvate.');
        return;
      }

      message.success('Setările au fost salvate.');
      const touched = Object.keys(payload);
      if (data.settings) applySettingsPartially(data.settings, touched);
      else await loadSettings(touched);
      await runAllTests();
    } catch {
      message.error('Eroare de conexiune la salvarea setărilor.');
    } finally {
      setSavingCard(null);
    }
  };

  const handleRevert = async (key: string) => {
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: { [key]: null } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        message.error(data.message || 'Setarea nu a putut fi readusă la valoarea din .env.');
        return;
      }
      message.success('Setarea folosește din nou valoarea din .env.');
      if (data.settings) applySettingsPartially(data.settings, [key]);
      else await loadSettings([key]);
      await runAllTests();
    } catch {
      message.error('Eroare de conexiune.');
    }
  };

  const handleCreateWebhook = async () => {
    setIsCreatingWebhook(true);
    try {
      const res = await fetch('/api/admin/settings/stripe-webhook', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        message.error(data.message || 'Webhook-ul nu a putut fi creat.');
        return;
      }
      message.success(data.message || 'Webhook-ul a fost creat în Stripe.');
      await Promise.all([loadSettings(), runTest('stripe')]);
    } catch {
      message.error('Eroare de conexiune.');
    } finally {
      setIsCreatingWebhook(false);
    }
  };

  const appUrlSetting = byKey['APP_URL'];
  const appUrl = (appUrlSetting?.value || '').trim();
  const siteIsHttps = /^https:\/\//i.test(appUrl);

  const bunnyTest = tests.bunny;
  const stripeTest = tests.stripe;
  const smtpTest = tests.smtp;
  const paymentsMode = stripeTest?.details?.mode as string | undefined;
  const chargesEnabled = stripeTest?.details?.chargesEnabled as boolean | undefined;
  const webhookUrl = stripeTest?.details?.webhookUrl as string | undefined;
  const webhookConfigured = stripeTest?.details?.webhookConfigured as boolean | undefined;

  const fgoEnabled = (byKey['FGO_ENABLED']?.value || '').toLowerCase() === 'true';
  const fgoMissing = [
    byKey['FGO_API_KEY']?.isSet ? '' : 'cheia API',
    (byKey['FGO_COD_UNIC']?.value || '').trim() ? '' : 'codul unic',
    (byKey['FGO_SERIES']?.value || '').trim() ? '' : 'seria',
  ].filter(Boolean);
  const fgoState: LaunchState = fgoEnabled && fgoMissing.length === 0 ? 'ok' : 'fail';
  const fgoHint = !fgoEnabled
    ? 'Facturarea FGO este dezactivată.'
    : fgoMissing.length
      ? `Lipsește ${fgoMissing.join(', ')}.`
      : 'Facturarea FGO este configurată.';

  const launchItems: { label: string; state: LaunchState; hint: string }[] = [
    {
      label: 'Adresă site',
      state: siteIsHttps ? 'ok' : 'fail',
      hint: siteIsHttps ? appUrl : 'Trebuie să înceapă cu https://',
    },
    {
      label: 'Video',
      state: bunnyTest ? (bunnyTest.ok ? 'ok' : 'fail') : 'pending',
      hint: bunnyTest?.message || 'Se verifică legătura cu Bunny Stream.',
    },
    {
      label: 'Plăți',
      state: stripeTest ? (stripeTest.ok ? 'ok' : 'fail') : 'pending',
      hint: stripeTest?.ok
        ? `${paymentsMode === 'live' ? 'Live' : 'Test'} · ${chargesEnabled ? 'activ' : 'inactiv'}`
        : stripeTest?.message || 'Se verifică cheia Stripe.',
    },
    {
      label: 'Webhook',
      state: webhookConfigured === undefined ? 'pending' : webhookConfigured ? 'ok' : 'fail',
      hint:
        webhookConfigured === undefined
          ? 'Se verifică webhook-ul Stripe.'
          : webhookConfigured
            ? 'Endpoint-ul există în Stripe.'
            : 'Endpoint-ul lipsește în Stripe.',
    },
    {
      label: 'Email',
      state: smtpTest ? (smtpTest.ok ? 'ok' : 'fail') : 'pending',
      hint: smtpTest?.message || 'Se verifică serverul SMTP.',
    },
    {
      label: 'Facturare FGO',
      state: fgoState,
      hint: fgoHint,
    },
  ];

  const renderTestResult = (key: TestKey) => {
    const result = tests[key];
    if (!result) return null;
    const missingRights = Array.isArray(result.details?.lipsa) ? (result.details.lipsa as string[]) : [];
    return (
      <Alert
        type={result.ok ? 'success' : 'error'}
        showIcon
        message={result.message}
        description={
          result.details ? (
            <div className="space-y-1">
              {missingRights.length > 0 && (
                <div className="text-[11px]">Drepturi lipsă: {missingRights.join(', ')}</div>
              )}
              <pre className="text-[11px] whitespace-pre-wrap break-all m-0">
                {JSON.stringify(result.details, null, 2)}
              </pre>
            </div>
          ) : undefined
        }
      />
    );
  };

  const renderField = (field: FieldDef) => {
    const setting = byKey[field.key];
    if (!setting) return null;

    const value = values[field.key] ?? '';
    const error = fieldErrors[field.key];
    const help =
      error ||
      field.help ||
      (field.type === 'password' ? 'Lasă gol ca să păstrezi valoarea actuală.' : '');

    return (
      <div key={field.key} className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <label className="text-xs text-ink/80">{field.label}</label>
          <div className="flex items-center gap-1.5">
            {sourceTag(setting.source)}
            {setting.source === 'admin' && (
              <Popconfirm
                title="Revii la valoarea inițială?"
                description="Valoarea salvată din panou este ștearsă; se folosește valoarea din .env sau cea implicită."
                okText="Revino"
                cancelText="Anulează"
                onConfirm={() => handleRevert(field.key)}
              >
                <Button type="text" size="small" className="text-[11px] text-muted px-1 h-6">
                  Revino la valoarea inițială
                </Button>
              </Popconfirm>
            )}
          </div>
        </div>

        {field.type === 'switch' ? (
          <Switch
            checked={value === 'true'}
            onChange={(checked) => setFieldValue(field.key, checked ? 'true' : 'false')}
          />
        ) : field.type === 'password' ? (
          <Input.Password
            value={value}
            placeholder={setting.isSet && setting.preview ? setting.preview : 'Necompletat'}
            autoComplete="new-password"
            status={error ? 'error' : undefined}
            onChange={(e) => setFieldValue(field.key, e.target.value)}
          />
        ) : (
          <Input
            value={value}
            placeholder={field.placeholder || (setting.preview || 'Necompletat')}
            addonAfter={field.type === 'percent' ? '%' : undefined}
            status={error ? 'error' : undefined}
            onChange={(e) => setFieldValue(field.key, e.target.value)}
          />
        )}

        {help && (
          <div className={error ? 'text-[11px] text-red-600' : 'text-[11px] text-muted'}>{help}</div>
        )}
      </div>
    );
  };

  if (isLoading && settings.length === 0) {
    return <div className="p-6 text-xs text-muted">Se încarcă setările…</div>;
  }

  return (
    <div className="space-y-4 pt-2">
      {/* Launch status - refreshed on open and after every save */}
      <div className="p-4 rounded-xl bg-cream border border-ink/10 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Stare lansare</h3>
          <p className="text-[11px] text-muted mt-0.5">
            Verificările rulează automat la deschidere și după fiecare salvare.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {launchItems.map((item) => (
            <div
              key={item.label}
              className="p-2.5 rounded-lg bg-cream/70 border border-ink/10 space-y-1"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-ink">{item.label}</span>
                <Tag color={item.state === 'ok' ? 'green' : item.state === 'fail' ? 'red' : 'default'}>
                  {item.state === 'ok' ? 'OK' : item.state === 'fail' ? 'Problemă' : 'Se verifică'}
                </Tag>
              </div>
              <p className="text-[11px] text-muted break-words">{item.hint}</p>
            </div>
          ))}
        </div>
      </div>

      {/* One card per group */}
      {CARDS.map((card) => (
        <div key={card.key} className="p-4 rounded-xl bg-cream border border-ink/10 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-ink">{card.title}</h3>
              {card.help && <p className="text-[11px] text-muted mt-0.5 leading-relaxed">{card.help}</p>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {card.test && (
                <Button
                  size="small"
                  loading={Boolean(runningTests[card.test])}
                  onClick={() => runTest(card.test as TestKey)}
                  className="text-xs rounded-lg"
                >
                  {TEST_LABELS[card.test]}
                </Button>
              )}
              <Button
                type="primary"
                size="small"
                loading={savingCard === card.key}
                onClick={() => handleSave(card)}
                className="text-xs font-semibold rounded-lg bg-ink text-cream hover:!bg-ink-soft hover:!text-cream border-none"
              >
                Salvează
              </Button>
            </div>
          </div>

          {card.key === 'video' && (
            <Alert
              type="warning"
              showIcon
              message="Schimbarea bibliotecii face filmele deja încărcate indisponibile."
              description="Filmele existente rămân în biblioteca veche; ele trebuie încărcate din nou în biblioteca nouă."
            />
          )}

          {card.key === 'payments' && paymentsMode === 'live' && !siteIsHttps && (
            <Alert
              type="error"
              showIcon
              message="Modul live Stripe cere ca adresa site-ului să înceapă cu https://."
              description="Setează adresa corectă în cardul „Site” și salvează, altfel webhook-ul de plăți nu poate fi creat."
            />
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {card.fields.map((field) => renderField(field))}
          </div>

          {card.key === 'payments' && (webhookUrl || stripeTest) && (
            <div className="p-3 rounded-lg bg-cream/70 border border-ink/10 space-y-2">
              <div className="text-[11px] text-muted">URL webhook Stripe</div>
              <code className="block text-[11px] text-ink break-all">
                {webhookUrl || 'Nu a fost returnat de testul Stripe.'}
              </code>
              <div className="flex flex-wrap items-center gap-2">
                <Popconfirm
                  title="Creezi webhook-ul în Stripe?"
                  description="Se creează endpoint-ul pentru evenimentele de plată, iar secretul lui este salvat automat în setări."
                  okText="Creează"
                  cancelText="Anulează"
                  onConfirm={handleCreateWebhook}
                >
                  <Button
                    size="small"
                    loading={isCreatingWebhook}
                    disabled={Boolean(webhookConfigured)}
                    className="text-xs rounded-lg"
                  >
                    Creează webhook-ul în Stripe
                  </Button>
                </Popconfirm>
                {webhookConfigured ? (
                  <span className="text-[11px] text-muted">Webhook-ul există deja în Stripe.</span>
                ) : (
                  <span className="text-[11px] text-muted">Webhook-ul nu există încă.</span>
                )}
              </div>
            </div>
          )}

          {card.test && renderTestResult(card.test)}
        </div>
      ))}

      {/* Read-only infrastructure values */}
      <div className="p-4 rounded-xl bg-cream border border-ink/10 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Server</h3>
          <p className="text-[11px] text-muted mt-0.5">Se schimbă din .env, cu repornire.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            { label: 'Mediu (NODE_ENV)', value: infrastructure?.nodeEnv },
            { label: 'Port', value: infrastructure?.port },
            { label: 'Trust proxy (hop-uri)', value: infrastructure?.trustProxyHops },
            { label: 'Director upload-uri', value: infrastructure?.uploadDir },
          ].map((row) => (
            <div key={row.label} className="space-y-1">
              <div className="text-xs text-ink/80">{row.label}</div>
              <Input value={row.value === undefined || row.value === null ? '' : String(row.value)} disabled />
            </div>
          ))}
        </div>
      </div>

      {/* Own password */}
      <div className="p-4 rounded-xl bg-cream border border-ink/10 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Parola mea</h3>
          <p className="text-[11px] text-muted mt-0.5">Schimbă parola contului tău de administrator.</p>
        </div>
        <ChangePasswordForm />
      </div>
    </div>
  );
};
