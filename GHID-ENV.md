# Ghid de configurare — ce pui în `.env` și ce pui din panou

Copiază `.env.example` în `.env` și completează doar cele câteva variabile de mai jos.
Configurația e citită doar de `src/server/config.ts`. Dacă lipsește o variabilă obligatorie, serverul nu pornește și îți spune care.

**Tot restul se configurează din aplicație: Admin → Setări.** Valorile salvate acolo au prioritate față de `.env`; valorile din `.env` rămân fallback, deci dacă ștergi o setare din panou se folosește din nou ce era în `.env`. Nu e nevoie să repornești serverul după o salvare din panou.

---

## Ce rămâne în `.env`

| Variabilă | Opțiuni | Ce să folosești |
|---|---|---|
| `DATABASE_URL` | **Neon** (gratuit la început, serverless), **Supabase** (gratuit la început), **Postgres pe VPS-ul tău**, **Railway** sau **Render** | **Recomandat:** Postgres pe același VPS cu aplicația, dacă ai deja un VPS: `postgresql://cinevault:PAROLA@localhost:5432/cinevault?schema=public`. Fără VPS: **Neon**. Copiezi „connection string” din panoul lor și adaugi la final `&sslmode=require`, dacă nu e deja acolo. Dacă parola conține `@`, `:` sau `/`, scrie-o codificată (`@` devine `%40`). |
| `NODE_ENV` | `production` sau linia comentată | **Pe server:** `production`. **Local:** pune `#` în fața liniei, altfel serverul caută `dist/` și nu mai folosește Vite. |
| `PORT` | orice port liber | `3000`. Schimbă doar dacă portul e ocupat sau hostingul îți impune altul. |
| `TRUST_PROXY_HOPS` | `0`, `1`, `2` | `0`: Node e expus direct pe internet. **`1` (cel mai des):** nginx sau Caddy în față, ori o platformă ca Railway sau Render. `2`: Cloudflare cu proxy activ plus nginx. O valoare prea mare permite falsificarea IP-ului, una prea mică face ca toți clienții să apară cu IP-ul proxy-ului. |
| `UPLOAD_DIR` | orice folder cu drept de scriere | Aici stau coperțile (`UPLOAD_DIR/thumbnails`) și cheia de criptare a setărilor (`UPLOAD_DIR/.settings.key`). **Local:** `./storage`. **Pe server:** o cale absolută, în afara folderului proiectului, ca să nu se piardă la redeploy, de exemplu `/var/lib/cinevault`. Include folderul în backup. |
| `ADMIN_EMAIL` | emailul tău real | Pe el primești și emailurile de test din panou. |
| `ADMIN_PASSWORD` | minim 12 caractere, ideal generată de un manager de parole | Se folosește **doar la prima pornire**, când se creează contul. După aceea **șterge linia** din `.env`. |
| `SETTINGS_ENCRYPTION_KEY` | **opțional** | Cheia cu care se criptează parolele și cheile API salvate din Admin → Setări. Las-o goală: aplicația generează singură `UPLOAD_DIR/.settings.key`. O pui doar dacă vrei cheia în afara folderului de stocare. Dacă o schimbi, valorile secrete salvate anterior nu mai pot fi citite și trebuie reintroduse din panou. |

După ce ai pus `DATABASE_URL`, rulează o dată `npm run db:migrate` ca să se creeze tabelele.

## Ce se configurează din Admin → Setări

Intră cu contul de admin → **Setări**. Doar contul `SUPER_ADMIN` are acces; un `ADMIN` obișnuit primește 403. Fiecare grupă are butoane de test, ca să verifici imediat ce ai salvat.

### Site și video

| Câmp | Ce pui |
|---|---|
| Adresa site-ului (`APP_URL`) | Adresa publică, fără `/` la final. **Pe server:** `https://www.domeniul-tau.ro`, exact cum o scriu clienții în browser. **Local:** `http://localhost:3000`. Greșeala cea mai des întâlnită: Stripe te trimite înapoi pe altă adresă decât cea pe care lucrezi. |
| Număr de streamuri simultane | `1` e cel mai strict și previne împrumutul contului. `2` dacă vrei să permiți telefon plus TV în aceeași casă. |
| Textul watermark / intervalul | Textul afișat peste player și la câte secunde se mută. |

### Bunny Stream (filmele)

| Câmp | Unde îl găsești |
|---|---|
| Video Library ID | Panoul Bunny → Stream → biblioteca ta → **API** → „Video Library ID” (un număr). |
| API Key | Tot acolo, „API Key”. Atenție: e cheia **bibliotecii**, nu cheia contului din Account settings. |
| Token authentication key | Biblioteca → **Security** → activezi „Embed view token authentication” → „Token authentication key”. |

În același tab **Security** mai faci două lucruri:

- Activezi **MediaCage DRM**. Basic e gratuit și blochează programele de descărcare. Enterprise e plătit și dă ecran negru la înregistrarea ecranului pe multe dispozitive.
- La **Allowed domains** pui doar domeniul tău. Adaugă și `localhost` cât testezi local, apoi scoate-l.

Când creezi biblioteca: alege regiunile de stocare cele mai apropiate de clienți (Europa). Rezoluțiile implicite sunt în regulă.

După ce salvezi, apasă **Testează Bunny**. Dacă îți spune „ID-ul bibliotecii sau cheia API e greșită.”, ai lipit cheia greșită sau numărul bibliotecii din alt cont.

### Stripe (plăți)

| Câmp | Opțiuni | Ce să folosești |
|---|---|---|
| Cheia secretă | `sk_test_…` sau `sk_live_…` | **Cât testezi:** `sk_test_…`, cu cardul de test `4242 4242 4242 4242`, fără bani reali. **La lansare:** `sk_live_…`. Le iei din Stripe Dashboard → Developers → API keys. Nu pune niciodată cheia `pk_…` aici, aia e cheia publică. |
| Secretul webhook-ului | `whsec_…` | Îl primești automat dacă apeși **Creează webhook-ul în Stripe** (vezi mai jos). Manual: Developers → Webhooks → Add endpoint `https://domeniul-tau.ro/api/payments/webhook`, cu evenimentele `checkout.session.completed`, `invoice.paid`, `charge.refunded` și `charge.dispute.created`, apoi copiezi „Signing secret”. **Local:** instalezi Stripe CLI, rulezi `stripe listen --forward-to localhost:3000/api/payments/webhook` și copiezi `whsec_…` afișat. Modul test și modul live au **webhook-uri și secrete diferite**. |
| Moneda | `RON`, `EUR`, `USD`… | `RON` dacă vinzi în România. Se aplică filmelor adăugate de acum înainte. |

Butoanele din grupă:

- **Testează Stripe**: verifică cheia, dacă plățile și retragerile sunt active, dacă webhook-ul există și dacă secretul lui e salvat. Îți arată și modul (`test` / `live`).
- **Creează webhook-ul în Stripe**: creează automat endpoint-ul `https://domeniul-tau.ro/api/payments/webhook` cu exact cele patru evenimente pe care le tratează aplicația și salvează secretul în setări. Merge doar dacă adresa site-ului începe cu `https://`. Dacă webhook-ul există deja, îți spune să îl ștergi din Stripe și să îl recreezi, ca să primești un secret nou.

### Datele firmei (apar pe factură și pe paginile legale)

| Câmp | Ce să folosești |
|---|---|
| Nume firmă | Numele exact din ONRC, de exemplu `"Ionut Tufan PFA"` sau `"Firma X S.R.L."`. |
| CIF | `RO12345678` dacă ești plătitor de TVA, `12345678` (fără RO) dacă nu ești. |
| Adresă | Adresa sediului social. |
| Email de contact | Emailul afișat pe paginile **Termeni**, **Confidențialitate** și **Cookies** (și în footer). Dacă îl lași gol, se folosește automat adresa din `SMTP_FROM`, deci nu e obligatoriu. |
| Cotă TVA | Plătitor de TVA: `0.21`. **Neplătitor** (de exemplu PFA sau microîntreprindere sub plafon): `0`, și factura nu va mai calcula TVA. Dacă nu știi sigur, întreabă-ți contabilul. |
| Serie facturi | Seria de facturi, 2–5 litere, de exemplu `CNV` sau inițialele firmei. Numerele merg automat: `CNV-2026-000001`, `000002`… Dacă ai deja facturi emise pe o serie, alege **alta**, ca să nu se suprapună. |

> Cu **Facturare FGO** activată (vezi mai jos), facturile fiscale nu mai sunt generate de aplicație, ci de FGO. Trimiterea în SPV (e-Factura ANAF) se face automat din aplicație, dacă opțiunea **Trimite factura în SPV** e activă. Fără FGO, facturile sunt generate de aplicație și **nu** se trimit automat la ANAF.

### Facturare FGO (facturi fiscale prin API)

Pașii, o singură dată:

1. **Cont FGO.** Creează un cont pe **https://testuat.fgo.ro/** pentru teste, cu datele firmei tale. Pentru producție îți trebuie un cont real pe **https://fgo.ro/**, cu abonament minim **Premium** — cheia API v2 nu se generează pe abonamentele sub acesta.
2. **Cheia v2.** În contul FGO → **Setări eCommerce → API** generezi cheia API v2 (`v2_…`). Cheia primește automat drepturile de care are nevoie aplicația: emitere, citire, anulare, încasare și SPV.
3. **Adresa platformei.** Tot la **Setări eCommerce → API** înregistrezi adresa site-ului (`https://domeniul-tau.ro`, fără `/` la final). FGO verifică adresa la fiecare scriere: dacă nu e înregistrată, emiterea facturii este refuzată.
4. **Seria.** Definește în registrul de facturi din FGO seria pe care o vei folosi (2–5 litere, de exemplu `CNV`), ca să nu se suprapună cu facturi emise deja.
5. **Admin → Setări → Facturare FGO.** Completezi:

| Câmp | Ce pui |
|---|---|
| Adresa API (`FGO_API_URL`) | **Test:** `https://api-testuat.fgo.ro`. **Producție:** `https://api.fgo.ro`. Trebuie să înceapă cu `https://`. |
| Cheie API (`FGO_API_KEY`) | Cheia v2 din contul FGO. E criptată în baza de date. |
| Cod unic (`FGO_COD_UNIC`) | CUI-ul firmei, **doar cifre, fără `RO`** (ex. `12345678`, nu `RO12345678`). |
| Adresa platformei (`FGO_PLATFORM_URL`) | Aceeași adresă pe care ai înregistrat-o la FGO. |
| Serie factură (`FGO_SERIES`) | Seria definită la pasul 4. |
| Serie storno (opțional) | Doar dacă vrei o serie separată pentru stornări. |
| Ultimul număr (`FGO_LAST_NUMBER`) | Numărul la care ai rămas în registru. Următoarea factură primește +1. **Gol** = FGO alocă numărul din registrul lui. |
| Tip factură (`FGO_INVOICE_TYPE`) | `F` (factură). |
| Tip plată (`FGO_PAYMENT_TYPE`) | `Chitanta`, `Bon` sau `Banca`. Pentru card online se folosește `Banca` — **confirmă cu contabilul** înainte de lansare. |
| Unitate de măsură (`FGO_UM`) | `buc`. |
| Trimite factura în SPV (`FGO_SEND_SPV`) | Activ dacă firma ta are obligația e-Factura. Aplicația apelează atunci trimiterea în SPV pentru fiecare factură emisă. |

6. **Testează FGO.** Apasă butonul: aplicația citește identitatea firmei și drepturile cheii, cu datele salvate. Dacă răspunde bine, **activează** comutatorul **Facturare prin FGO**.
7. **Urmărire.** Facturile emise prin FGO apar în **Admin → Facturi**, cu statusul FGO (în așteptare, emisă, eșuată), cu eroarea sau avertismentul primit de la FGO. De acolo poți reprograma o factură eșuată, retrimite emailul sau cere stornarea.

> Cât timp FGO e dezactivat, factura este generată de aplicație, cu seria din **Datele firmei** (`INVOICE_SERIES`). După ce activezi FGO, facturile noi trec prin FGO; cele vechi rămân ca atare.
>
> Cheile `FGO_*` pot sta și în `.env` (vezi `.env.example`), ca fallback. Valorile salvate în **Admin → Setări** au prioritate.

### Email (SMTP)

Opțiuni de furnizor:

| Serviciu | Potrivit pentru | Setări |
|---|---|---|
| **Gmail / Google Workspace** | început, volum mic (Gmail are o limită zilnică de trimitere) | `smtp.gmail.com`, `587`, securizat `false`, parola = **App Password** (Cont Google → Securitate → Verificare în 2 pași → Parole pentru aplicații) |
| **Brevo** (fost Sendinblue) | recomandat, are plan gratuit | `smtp-relay.brevo.com`, `587`, `false`, user și parolă SMTP din Brevo → SMTP & API |
| **Resend** | modern, simplu | `smtp.resend.com`, `465`, `true`, user `resend`, parola = cheia API |
| **Amazon SES** | volum mare, cel mai ieftin | `email-smtp.eu-central-1.amazonaws.com`, `587`, `false`, credențiale SMTP generate în SES |

| Câmp | Ce să folosești |
|---|---|
| Host / Port / Securizat | Din tabelul de mai sus. Regula: portul **587** merge cu `false`, portul **465** cu `true`. |
| Utilizator / Parolă | De la furnizorul ales. |
| Expeditor (`SMTP_FROM`) | `"IV Concept <noreply@domeniul-tau.ro>"`. Adresa trebuie să fie pe un domeniu **verificat** la furnizor (Brevo, Resend și SES îți dau înregistrările DNS de adăugat). Cu Gmail simplu poți trimite doar de pe adresa ta Gmail. Altfel emailurile ajung în spam sau sunt respinse. |

După ce completezi, apasă **Testează SMTP** în Admin → Setări: îți spune imediat dacă serverul de email acceptă datele.

---

## Backup: nu uita fișierul `.settings.key`

Setările secrete (parole SMTP, chei Stripe, chei Bunny) sunt criptate cu o cheie care stă în **`<UPLOAD_DIR>/.settings.key`**.

- Salvează acest fișier **separat** de backup-ul bazei de date. Fără el, valorile criptate din baza de date nu pot fi citite, iar cheile trebuie reintroduse manual din Admin → Setări.
- Nu îl muta și nu îl șterge între două deploy-uri: dacă dispare, aplicația generează altul și secretele vechi devin ilizibile.
- Dacă vrei să ții cheia în altă parte (de exemplu în `.env`), completează `SETTINGS_ENCRYPTION_KEY`.

---

## Pe scurt: ce aș alege eu

| Parte | Alegere |
|---|---|
| Bază de date | Neon (sau Postgres pe VPS, dacă ai deja unul) |
| Email | Brevo, cu domeniul tău verificat |
| Stripe | `sk_test_` până ai testat o plată cap-coadă, apoi `sk_live_` |
| Bunny | MediaCage Basic, Allowed domains = doar domeniul tău |
| Restul | valorile implicite din Admin → Setări |

