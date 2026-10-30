# IV Concept — platformă VOD (vânzare de acces la filme)

Express + React (Vite) + PostgreSQL (Prisma) + Stripe Checkout + SMTP + Bunny Stream (MediaCage DRM).
Filmele se încarcă din panoul de admin și sunt stocate, convertite și protejate de Bunny Stream.

## De unde se încarcă configurația

Sunt două locuri, iar ordinea e simplă: **Admin → Setări are prioritate, `.env` e fallback.**

- **`.env`** (rădăcină, model în `.env.example`) conține doar infrastructura: `DATABASE_URL`, `NODE_ENV`, `PORT`, `TRUST_PROXY_HOPS`, `UPLOAD_DIR`, primul cont de admin (`ADMIN_EMAIL`, `ADMIN_PASSWORD`) și, opțional, `SETTINGS_ENCRYPTION_KEY`. Pe server poți pune aceleași variabile în panoul hostingului; cele setate pe server au prioritate față de `.env`.
- **Admin → Setări** conține restul: adresa site-ului (`APP_URL`), Bunny Stream, Stripe, SMTP, datele firmei, TVA, moneda, watermark, streamuri simultane, facturarea FGO. Doar contul `SUPER_ADMIN` are acces. Ce salvezi acolo intră în vigoare imediat, fără repornire. Dacă ștergi o setare din panou, se folosește din nou valoarea din `.env` (sau valoarea implicită a aplicației).
- Toată configurația e citită într-un singur loc: `src/server/config.ts`. Dacă lipsește `DATABASE_URL`, serverul **nu pornește** și îți spune exact ce lipsește. Nu există mod de test sau simulare.


## Instalare (prima dată)

```bash
npm install                 # instalează și generează clientul Prisma
cp .env.example .env        # apoi completează .env
npm run db:migrate          # creează tabelele în PostgreSQL
npm run build               # compilează frontend-ul în dist/
npm start                   # pornește serverul (NODE_ENV=production în .env)
```

La prima pornire se creează automat contul SUPER_ADMIN din `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
După asta, scoate `ADMIN_PASSWORD` din `.env`.

Local, pentru dezvoltare: comentează `NODE_ENV` în `.env`, rulează `npm run dev` și, din Admin → Setări, pune la adresa site-ului `http://localhost:3000`.

## Cum încarci un film

1. Intră cu contul de admin → meniul contului → **Studio Administration**.
2. **Adaugă Videoclip** → completezi titlul, descrierea, categoria (poți crea una nouă direct din listă) și prețul.
3. Alegi **fișierul video** (`.mp4`, `.mov`, `.webm`, `.m4v`) și **imaginea de copertă** (`.jpg`, `.png`, `.webp`).
4. Apeși **Creează videoclip**. Se vede progresul încărcării. Serverul trimite fișierul direct la Bunny Stream, fără copie pe disc.
5. Statusul devine **„Se procesează (Bunny)”**, cât timp Bunny convertește filmul (de obicei câteva minute). Apasă **Actualizează**: când devine **„Gata”**, filmul apare în catalog (dacă e „Publicat”).

Unde ajung fișierele:

- **Filmul:** în biblioteca ta Bunny Stream (îl vezi și în panoul Bunny). Se redă doar prin player-ul Bunny, cu link semnat pe server pentru cine l-a cumpărat, și cu MediaCage DRM, care blochează descărcarea.
- **Coperta:** în `UPLOAD_DIR/thumbnails/…`, publică la `/media/thumbnails/…`. Include folderul în backup.
- **Cheia setărilor:** `UPLOAD_DIR/.settings.key`. Include-o în backup **separat** de baza de date: fără ea, cheile API salvate din panou nu mai pot fi citite și trebuie reintroduse.

Configurare Bunny (o singură dată): Admin → Setări → grupul video (Library ID, API Key, Token Authentication Key). MediaCage DRM activ și Allowed domains = domeniul tău, în panoul Bunny → Security. Apoi apasă **Testează Bunny**.

## Plăți (Stripe)

1. Admin → Setări → Stripe: pune cheia secretă (`sk_test_…` pentru probe, `sk_live_…` pentru bani reali) și moneda.
2. Apasă **Creează webhook-ul în Stripe**: aplicația creează endpoint-ul `https://domeniul-tau.ro/api/payments/webhook` cu evenimentele `checkout.session.completed`, `invoice.paid`, `charge.refunded`, `charge.dispute.created` și salvează secretul (`whsec_…`) în setări. Merge doar dacă adresa site-ului începe cu `https://`.
   Manual: Stripe Dashboard → Developers → Webhooks → Add endpoint pe aceeași adresă, cu aceleași evenimente, apoi copiază „Signing secret” în câmpul de secret webhook.
3. Local: `stripe listen --forward-to localhost:3000/api/payments/webhook` îți dă un `whsec_…` temporar, pe care îl pui în același câmp.

Fluxul: client → Stripe Checkout → înapoi pe site. Accesul se activează fie la întoarcere, fie prin webhook, oricare ajunge primul. Se emite factura (dacă facturarea FGO e activă, prin API-ul FGO; altfel local, cu seria `INVOICE_SERIES`, număr secvențial, TVA `VAT_RATE` și datele firmei din `COMPANY_*`) și se trimit emailurile de confirmare. La refund total sau dispută, accesul se revocă automat.

## Facturare (FGO)

1. Admin → Setări → **Facturare FGO**: pune adresa API (`https://api-testuat.fgo.ro` pentru teste, `https://api.fgo.ro` în producție), cheia API v2 din contul FGO, codul unic al firmei (doar cifre, fără `RO`), seria din registrul de facturi și ultimul număr emis.
2. Apasă **Testează FGO**: verifică cheia, codul unic și drepturile ei. Dacă răspunde bine, activează comutatorul **Facturare prin FGO**.
3. Facturile emise prin FGO apar în **Admin → Facturi**, cu statusul lor. De acolo poți reprograma o emitere eșuată, retrimite emailul cu factura sau cere stornarea.
4. Dacă opțiunea **Trimite factura în SPV** e activă, aplicația trimite factura în SPV (e-Factura ANAF) imediat după emitere.

Crearea contului FGO, înregistrarea adresei site-ului la FGO, seria din registru și tipul de încasare pentru card: vezi `GHID-ENV.md`, secțiunea **Facturare FGO**.

## În spatele unui reverse proxy (nginx)

- `TRUST_PROXY_HOPS=1`, ca să se vadă IP-ul real al clienților.
- Filmele pot fi mari, deci ridică limita de upload: `client_max_body_size 20G;` și `proxy_request_buffering off;` pe `location /api/admin/`.
