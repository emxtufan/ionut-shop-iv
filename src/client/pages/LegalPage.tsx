import React, { useEffect, useState } from 'react';

// ==============================================================================
// Legal pages: Terms / Privacy / Cookies. Rendered from ?page=terms|privacy|cookies
// Seller details come from GET /api/public/company (see server.ts).
// ==============================================================================

export interface CompanyInfo {
  name: string;
  cif: string;
  address: string;
  email: string;
}

export type LegalPageKey = 'terms' | 'privacy' | 'cookies';

interface LegalPageProps {
  page: LegalPageKey;
}

const UPDATED_AT = 'Ultima actualizare: 30 octombrie 2026';

const PAGE_TITLES: Record<LegalPageKey, string> = {
  terms: 'Termeni și condiții',
  privacy: 'Politica de confidențialitate',
  cookies: 'Politica de cookies',
};

const ANPC_SAL_URL = 'https://anpc.ro/ce-este-sal/';
const ANPC_CLAIMS_URL = 'https://reclamatiisal.anpc.ro/';
const ANSPDCP_URL = 'https://www.dataprotection.ro/';

// Shown until the API answers
const EMPTY_COMPANY: CompanyInfo = { name: '…', cif: '…', address: '…', email: '…' };

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="space-y-2">
    <h2 className="text-base font-semibold tracking-tight text-ink">{title}</h2>
    <div className="space-y-2 text-sm leading-relaxed text-muted">{children}</div>
  </section>
);

const List: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ul className="list-disc space-y-1 pl-5">{children}</ul>
);

const ExternalLink: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className="text-ink underline decoration-ink/30 hover:decoration-ink transition-colors"
  >
    {children}
  </a>
);

export const LegalPage: React.FC<LegalPageProps> = ({ page }) => {
  const [company, setCompany] = useState<CompanyInfo | null>(null);

  useEffect(() => {
    fetch('/api/public/company')
      .then((res) => res.json())
      .then((data: CompanyInfo) => setCompany(data))
      .catch((e) => console.error(e));
  }, []);

  const seller = company ?? EMPTY_COMPANY;

  const sellerEmail = company?.email ? (
    <a
      href={`mailto:${company.email}`}
      className="text-ink underline decoration-ink/30 hover:decoration-ink transition-colors"
    >
      {company.email}
    </a>
  ) : (
    seller.email
  );

  return (
    <div className="max-w-3xl mx-auto px-6 pt-2 pb-16 space-y-8">
      <header className="space-y-2 border-b border-ink/10 pb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{PAGE_TITLES[page]}</h1>
        <p className="text-xs text-muted">{UPDATED_AT}</p>
      </header>

      {page === 'terms' && (
        <div className="space-y-7">
          <Section title="1. Identificarea vânzătorului">
            <p>Serviciul este operat de:</p>
            <List>
              <li>
                <span className="text-ink font-medium">Firmă:</span> {seller.name}
              </li>
              <li>
                <span className="text-ink font-medium">CIF:</span> {seller.cif}
              </li>
              <li>
                <span className="text-ink font-medium">Adresă:</span> {seller.address}
              </li>
              <li>
                <span className="text-ink font-medium">Email:</span> {sellerEmail}
              </li>
            </List>
          </Section>

          <Section title="2. Obiectul contractului">
            <p>
              Prin intermediul platformei poți cumpăra acces digital la filme, individual. Accesul se acordă pe
              contul cumpărătorului, pentru uz personal, neexclusiv și netransmisibil. Nu dobândești drepturi de
              autor asupra filmului, ci doar dreptul de a îl viziona în contul tău, în condițiile de mai jos.
            </p>
          </Section>

          <Section title="3. Contul de utilizator">
            <p>
              Un cont este destinat unei singure persoane. Parola este responsabilitatea ta și nu o împărtăși
              nimănui; activitatea desfășurată din contul tău îți este atribuită. Numărul de vizionări simultane
              este limitat la nivelul platformei.
            </p>
          </Section>

          <Section title="4. Preț, plată și facturare">
            <p>
              Prețurile afișate sunt în RON și includ TVA. Plata se face online prin Stripe. Factura se emite
              electronic, prin furnizorul nostru de facturare FGO, și se trimite pe emailul contului, după
              confirmarea plății.
            </p>
          </Section>

          <Section title="5. Livrare">
            <p>Accesul la filmul cumpărat se activează imediat după confirmarea plății.</p>
          </Section>

          <Section title="6. Dreptul de retragere">
            <p>
              Conform OUG 34/2014 ai dreptul de a te retrage din contract în termen de 14 zile. Pentru conținut
              digital, prin bifarea căsuței din checkout soliciți în mod expres furnizarea imediată a conținutului
              și confirmi că îți pierzi dreptul de retragere odată ce furnizarea a început (art. 16 lit. m din OUG
              34/2014).
            </p>
          </Section>

          <Section title="7. Utilizare interzisă">
            <p>
              Nu ai voie să copiezi, să înregistrezi sau să redistribui filmele și nici să partajezi contul. În
              cazul unor astfel de încălcări, contul poate fi suspendat fără rambursare.
            </p>
          </Section>

          <Section title="8. Proprietate intelectuală">
            <p>
              Filmele, mărcile, textele și elementele grafice din platformă aparțin titularilor lor și sunt
              protejate de legea drepturilor de autor. Accesul cumpărat nu îți dă dreptul să le folosești în alte
              scopuri decât vizionarea personală.
            </p>
          </Section>

          <Section title="9. Rambursări">
            <p>
              Dacă un conținut cumpărat este indisponibil sau are un defect tehnic care nu poate fi rezolvat,
              returnăm suma plătită. Scrie-ne la {sellerEmail}.
            </p>
          </Section>

          <Section title="10. Suspendare și încetare">
            <p>
              Putem suspenda sau înceta accesul la cont dacă încalci acești termeni, dacă există indicii de
              fraudă ori dacă legea ne obligă. Poți cere închiderea contului oricând, la {sellerEmail}.
            </p>
          </Section>

          <Section title="11. Răspundere">
            <p>
              Răspunderea noastră este limitată, în limitele permise de lege, la suma plătită pentru conținutul în
              cauză. Nu răspundem pentru întreruperi cauzate de conexiunea ta la internet, de dispozitivul tău sau
              de servicii ale unor terți aflate în afara controlului nostru.
            </p>
          </Section>

          <Section title="12. Reclamații">
            <p>
              Dacă ai o nemulțumire, scrie-ne întâi la {sellerEmail} și încercăm să o rezolvăm. Dacă nu ajungem la
              o soluție, te poți adresa Autorității Naționale pentru Protecția Consumatorilor (ANPC):{' '}
              <ExternalLink href={ANPC_SAL_URL}>https://anpc.ro/ce-este-sal/</ExternalLink> — formulare de
              reclamație: <ExternalLink href={ANPC_CLAIMS_URL}>https://reclamatiisal.anpc.ro/</ExternalLink>.
            </p>
          </Section>

          <Section title="13. Lege aplicabilă">
            <p>Acești termeni sunt guvernați de legea română.</p>
          </Section>
        </div>
      )}

      {page === 'privacy' && (
        <div className="space-y-7">
          <Section title="1. Operatorul de date">
            <p>Operatorul datelor cu caracter personal prelucrate prin această platformă este:</p>
            <List>
              <li>
                <span className="text-ink font-medium">Firmă:</span> {seller.name}
              </li>
              <li>
                <span className="text-ink font-medium">CIF:</span> {seller.cif}
              </li>
              <li>
                <span className="text-ink font-medium">Adresă:</span> {seller.address}
              </li>
              <li>
                <span className="text-ink font-medium">Email:</span> {sellerEmail}
              </li>
            </List>
          </Section>

          <Section title="2. Ce date prelucrăm">
            <List>
              <li>Datele contului: email, username și hash-ul parolei.</li>
              <li>Datele despre plăți: procesate de Stripe; nu stocăm datele cardului.</li>
              <li>
                Datele de facturare: nume, respectiv denumirea firmei, CUI și Nr. Reg. Com. pentru firme, adresa
                și, opțional, telefonul.
              </li>
              <li>Adresa IP și user-agent.</li>
              <li>Jurnalul de redare și jurnalul de securitate.</li>
              <li>Emailurile trimise către tine.</li>
            </List>
          </Section>

          <Section title="3. Scopuri și temei legal">
            <List>
              <li>
                <span className="text-ink font-medium">Executarea contractului</span> (art. 6 alin. 1 lit. b
                GDPR): crearea și administrarea contului, accesul la filmele cumpărate, livrarea conținutului.
              </li>
              <li>
                <span className="text-ink font-medium">Obligație legală</span> (art. 6 alin. 1 lit. c GDPR):
                emiterea facturii, evidența contabilă și păstrarea documentelor fiscale.
              </li>
              <li>
                <span className="text-ink font-medium">Interesul nostru legitim</span> (art. 6 alin. 1 lit. f
                GDPR): securitatea platformei și prevenirea fraudei, inclusiv limitarea partajării conturilor.
              </li>
            </List>
          </Section>

          <Section title="4. Destinatari">
            <List>
              <li>
                <span className="text-ink font-medium">Stripe</span> — procesarea plăților.
              </li>
              <li>
                <span className="text-ink font-medium">FGO</span> — emiterea facturilor fiscale și trimiterea lor
                în SPV (ANAF).
              </li>
              <li>
                <span className="text-ink font-medium">Bunny.net</span> — livrarea conținutului video.
              </li>
              <li>
                <span className="text-ink font-medium">Resend</span> — trimiterea emailurilor.
              </li>
              <li>
                <span className="text-ink font-medium">Google Fonts</span> — încărcarea fonturilor; la această
                încărcare browserul tău transmite adresa IP către Google.
              </li>
              <li>
                <span className="text-ink font-medium">Furnizorul de hosting</span> — găzduirea aplicației și a
                bazei de date.
              </li>
              <li>
                <span className="text-ink font-medium">Autoritățile</span> — atunci când legea ne obligă să le
                furnizăm datele.
              </li>
            </List>
          </Section>

          <Section title="5. Transferuri în afara SEE">
            <p>
              Unii dintre furnizorii de mai sus pot prelucra date în afara Spațiului Economic European.
              Transferurile se fac prin mecanismele prevăzute de furnizorii respectivi.
            </p>
          </Section>

          <Section title="6. Cât timp păstrăm datele">
            <List>
              <li>Datele contului: cât timp contul este activ.</li>
              <li>Datele de facturare și documentele contabile: conform legislației fiscale.</li>
              <li>Jurnalele de securitate: cât sunt necesare pentru scopul pentru care au fost colectate.</li>
            </List>
          </Section>

          <Section title="7. Drepturile tale">
            <p>
              Ai dreptul de acces, de rectificare, de ștergere, de restricționare a prelucrării, de portabilitate și
              de opoziție. Poți depune plângere la Autoritatea Națională de Supraveghere a Prelucrării Datelor cu
              Caracter Personal (ANSPDCP):{' '}
              <ExternalLink href={ANSPDCP_URL}>https://www.dataprotection.ro/</ExternalLink>.
            </p>
          </Section>

          <Section title="8. Cum îți exerciți drepturile">
            <p>
              Din pagina „Achizițiile mele” poți exporta datele contului și îți poți șterge contul. Pentru orice
              altă cerere, scrie-ne la {sellerEmail}.
            </p>
          </Section>

          <Section title="9. Ștergerea contului">
            <p>
              La ștergerea contului, datele de cont se anonimizează. Documentele contabile rămân păstrate, pentru
              că legea ne obligă să le păstrăm.
            </p>
          </Section>
        </div>
      )}

      {page === 'cookies' && (
        <div className="space-y-7">
          <Section title="1. Cookie-ul pe care îl folosim">
            <p>
              Aplicația setează un singur cookie: <span className="text-ink font-mono text-xs">cinevault_session</span>.
              Este strict necesar, are atributul httpOnly, expiră în 30 de zile și ține minte că ești autentificat.
              Pentru un cookie strict necesar nu este nevoie de consimțământ.
            </p>
          </Section>

          <Section title="2. Fără analiză sau publicitate">
            <p>Nu folosim cookie-uri de analiză, de urmărire sau de publicitate.</p>
          </Section>

          <Section title="3. Fonturile Google">
            <p>
              Fonturile sunt încărcate de la Google Fonts. Această aplicație nu setează cookie-uri prin Google
              Fonts, dar la încărcarea fonturilor browserul tău transmite adresa IP către Google.
            </p>
          </Section>
        </div>
      )}
    </div>
  );
};
