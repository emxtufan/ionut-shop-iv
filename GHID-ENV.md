# Ghid `.env` — ce pui pe fiecare linie

Copiază `.env.example` în `.env` și completează după ghidul de mai jos.
Configurația e citită doar de `src/server/config.ts`. Dacă lipsește o variabilă obligatorie, serverul nu pornește și îți spune care.

---

## Server

| Variabilă | Opțiuni | Ce să folosești |
|---|---|---|
| `NODE_ENV` | `production` sau linia comentată | **Pe server:** `production`. **Local:** pune `#` în fața liniei, altfel serverul caută `dist/` și nu mai folosește Vite. |
| `PORT` | orice port liber | `3000`. Schimbă doar dacă portul e ocupat sau hostingul îți impune altul. |
| `APP_URL` | adresa publică a site-ului, fără `/` la final | **Pe server:** `https://www.domeniul-tau.ro`, exact cum scriu clienții în browser. **Local:** `http://localhost:3000`. Greșeala cea mai des întâlnită: Stripe te trimite înapoi pe altă adresă decât cea pe care lucrezi. |
| `TRUST_PROXY_HOPS` | `0`, `1`, `2` | `0`: Node e expus direct pe internet. **`1` (cel mai des):** nginx sau Caddy în față, ori o platformă ca Railway sau Render. `2`: Cloudflare cu proxy activ plus nginx. O valoare prea mare permite falsificarea IP-ului, una prea mică face ca toți clienții să apară cu IP-ul proxy-ului. |

## Baza de date

| Variabilă | Opțiuni | Ce să folosești |
|---|---|---|
| `DATABASE_URL` | **Neon** (gratuit la început, serverless), **Supabase** (gratuit la început), **Postgres pe VPS-ul tău**, **Railway** sau **Render** | **Recomandat:** Postgres pe același VPS cu aplicația, dacă ai deja un VPS: `postgresql://cinevault:PAROLA@localhost:5432/cinevault?schema=public`. Fără VPS: **Neon**. Copiezi „connection string” din panoul lor și adaugi la final `&sslmode=require`, dacă nu e deja acolo. Dacă parola conține `@`, `:` sau `/`, scrie-o codificată (`@` devine `%40`). |

După ce ai pus `DATABASE_URL`, rulează o dată `npm run db:migrate` ca să se creeze tabelele.

## Primul admin

| Variabilă | Ce să folosești |
|---|---|
| `ADMIN_EMAIL` | Emailul tău real. Pe el primești și emailurile de test din panou. |
| `ADMIN_PASSWORD` | Minim 12 caractere, ideal generată de un manager de parole. Se folosește **doar la prima pornire**, când se creează contul. După aceea **șterge linia** din `.env`. |

## Bunny Stream (filmele)

| Variabilă | Unde o găsești |
|---|---|
| `BUNNY_STREAM_LIBRARY_ID` | Panoul Bunny → Stream → biblioteca ta → **API** → „Video Library ID” (un număr). |
| `BUNNY_STREAM_API_KEY` | Tot acolo, „API Key”. Atenție: e cheia **bibliotecii**, nu cheia contului din Account settings. |
| `BUNNY_STREAM_TOKEN_KEY` | Biblioteca → **Security** → activezi „Embed view token authentication” → „Token authentication key”. |

În același tab **Security** mai faci două lucruri:

- Activezi **MediaCage DRM**. Basic e gratuit și blochează programele de descărcare. Enterprise e plătit și dă ecran negru la înregistrarea ecranului pe multe dispozitive.
- La **Allowed domains** pui doar domeniul tău. Adaugă și `localhost` cât testezi local, apoi scoate-l.

Când creezi biblioteca: alege regiunile de stocare cele mai apropiate de clienți (Europa). Rezoluțiile implicite sunt în regulă.

## Stocare și limite

| Variabilă | Opțiuni | Ce să folosești |
|---|---|---|
| `UPLOAD_DIR` | orice folder cu drept de scriere | Aici stau doar copertele, deci ocupă puțin. **Local:** `./storage`. **Pe server:** o cale absolută, în afara folderului proiectului, ca să nu se piardă la redeploy, de exemplu `/var/lib/cinevault`. Include folderul în backup. |
| `MAX_CONCURRENT_STREAMS` | `1`, `2`, `3`… | `1` e cel mai strict și previne împrumutul contului. `2` dacă vrei să permiți telefon plus TV în aceeași casă. |

## Stripe (plăți)

| Variabilă | Opțiuni | Ce să folosești |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` sau `sk_live_…` | **Cât testezi:** `sk_test_…`, cu cardul de test `4242 4242 4242 4242`, fără bani reali. **La lansare:** `sk_live_…`. Le iei din Stripe Dashboard → Developers → API keys. Nu pune niciodată cheia `pk_…` aici, aia e cheia publică. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | **Pe server:** Developers → Webhooks → Add endpoint `https://domeniul-tau.ro/api/payments/webhook`, cu evenimentele `checkout.session.completed`, `invoice.paid`, `charge.refunded` și `charge.dispute.created`, apoi copiezi „Signing secret”. **Local:** instalezi Stripe CLI, rulezi `stripe listen --forward-to localhost:3000/api/payments/webhook` și copiezi `whsec_…` afișat. Modul test și modul live au **webhook-uri și secrete diferite**. |
| `STRIPE_CURRENCY` | `RON`, `EUR`, `USD`… | `RON` dacă vinzi în România. Se aplică filmelor adăugate de acum înainte. |

## Datele firmei (apar pe factură și pe paginile legale)

| Variabilă | Ce să folosești |
|---|---|
| `COMPANY_NAME` | Numele exact din ONRC, de exemplu `"Ionut Tufan PFA"` sau `"Firma X S.R.L."`. |
| `COMPANY_CIF` | `RO12345678` dacă ești plătitor de TVA, `12345678` (fără RO) dacă nu ești. |
| `COMPANY_ADDRESS` | Adresa sediului social, între ghilimele. |
| `COMPANY_EMAIL` | Opțional. Emailul de contact afișat pe paginile **Termeni**, **Confidențialitate** și **Cookies** (și în footer). Dacă lași linia goală, se folosește automat adresa din `SMTP_FROM`, deci nu e obligatoriu să o completezi. |
| `VAT_RATE` | Plătitor de TVA: `0.21`. **Neplătitor** (de exemplu PFA sau microîntreprindere sub plafon): `0`, și factura nu va mai calcula TVA. Dacă nu știi sigur, întreabă-ți contabilul. |
| `INVOICE_SERIES` | Seria de facturi, 2–5 litere, de exemplu `CNV` sau inițialele firmei. Numerele merg automat: `CNV-2026-000001`, `000002`… Dacă ai deja facturi emise pe o serie, alege **alta**, ca să nu se suprapună. |

> Facturile sunt generate de aplicație. Dacă firma ta are obligația e-Factura (SPV ANAF), ele **nu se trimit automat** acolo, deci discută cu contabilul.

## Email (SMTP)

Opțiuni:

| Serviciu | Potrivit pentru | Setări |
|---|---|---|
| **Gmail / Google Workspace** | început, volum mic (Gmail are o limită zilnică de trimitere) | `smtp.gmail.com`, `587`, `false`, `SMTP_PASS` = **App Password** (Cont Google → Securitate → Verificare în 2 pași → Parole pentru aplicații) |
| **Brevo** (fost Sendinblue) | recomandat, are plan gratuit | `smtp-relay.brevo.com`, `587`, `false`, user și parolă SMTP din Brevo → SMTP & API |
| **Resend** | modern, simplu | `smtp.resend.com`, `465`, `true`, `SMTP_USER=resend`, `SMTP_PASS` = cheia API |
| **Amazon SES** | volum mare, cel mai ieftin | `email-smtp.eu-central-1.amazonaws.com`, `587`, `false`, credențiale SMTP generate în SES |

| Variabilă | Ce să folosești |
|---|---|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | Din tabelul de mai sus. Regula: portul **587** merge cu `false`, portul **465** cu `true`. |
| `SMTP_USER` / `SMTP_PASS` | De la furnizorul ales. |
| `SMTP_FROM` | `"IV Concept <noreply@domeniul-tau.ro>"`. Adresa trebuie să fie pe un domeniu **verificat** la furnizor (Brevo, Resend și SES îți dau înregistrările DNS de adăugat). Cu Gmail simplu poți trimite doar de pe adresa ta Gmail. Altfel emailurile ajung în spam sau sunt respinse. |

După ce completezi, din Studio → Email → **Verifică Conexiune** și **Trimite Email de Test** vezi imediat dacă SMTP-ul merge.

---

## Pe scurt: ce aș alege eu

| Parte | Alegere |
|---|---|
| Bază de date | Neon (sau Postgres pe VPS, dacă ai deja unul) |
| Email | Brevo, cu domeniul tău verificat |
| Stripe | `sk_test_` până ai testat o plată cap-coadă, apoi `sk_live_` |
| Bunny | MediaCage Basic, Allowed domains = doar domeniul tău |
| Restul | valorile implicite din `.env.example` |
