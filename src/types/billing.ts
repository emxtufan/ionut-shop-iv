// ==============================================================================
// IV Concept VOD - Billing details (invoice buyer data, FGO integration)
// Shared by client and server. Plain TypeScript only: no enum, no namespace,
// so the file runs with Node's type stripping (no build step needed).
// ==============================================================================

export type BillingDetails = {
  type: 'PF' | 'PJ';
  name: string;
  cui?: string;
  regCom?: string;
  country: string;
  county?: string;
  city: string;
  address: string;
  phone?: string;
};

export type CountyOption = { code: string; name: string };

export type CountryOption = { code: string; name: string };

/** Codurile de județ folosite de FGO, cu numele oficial (cu diacritice). */
export const RO_COUNTIES: CountyOption[] = [
  { code: 'AB', name: 'Alba' },
  { code: 'AR', name: 'Arad' },
  { code: 'AG', name: 'Argeș' },
  { code: 'BC', name: 'Bacău' },
  { code: 'BH', name: 'Bihor' },
  { code: 'BN', name: 'Bistrița-Năsăud' },
  { code: 'BT', name: 'Botoșani' },
  { code: 'BV', name: 'Brașov' },
  { code: 'BR', name: 'Brăila' },
  { code: 'B', name: 'București' },
  { code: 'BZ', name: 'Buzău' },
  { code: 'CS', name: 'Caraș-Severin' },
  { code: 'CL', name: 'Călărași' },
  { code: 'CJ', name: 'Cluj' },
  { code: 'CT', name: 'Constanța' },
  { code: 'CV', name: 'Covasna' },
  { code: 'DB', name: 'Dâmbovița' },
  { code: 'DJ', name: 'Dolj' },
  { code: 'GL', name: 'Galați' },
  { code: 'GR', name: 'Giurgiu' },
  { code: 'GJ', name: 'Gorj' },
  { code: 'HR', name: 'Harghita' },
  { code: 'HD', name: 'Hunedoara' },
  { code: 'IL', name: 'Ialomița' },
  { code: 'IS', name: 'Iași' },
  { code: 'IF', name: 'Ilfov' },
  { code: 'MM', name: 'Maramureș' },
  { code: 'MH', name: 'Mehedinți' },
  { code: 'MS', name: 'Mureș' },
  { code: 'NT', name: 'Neamț' },
  { code: 'OT', name: 'Olt' },
  { code: 'PH', name: 'Prahova' },
  { code: 'SM', name: 'Satu Mare' },
  { code: 'SJ', name: 'Sălaj' },
  { code: 'SB', name: 'Sibiu' },
  { code: 'SV', name: 'Suceava' },
  { code: 'TR', name: 'Teleorman' },
  { code: 'TM', name: 'Timiș' },
  { code: 'TL', name: 'Tulcea' },
  { code: 'VS', name: 'Vaslui' },
  { code: 'VL', name: 'Vâlcea' },
  { code: 'VN', name: 'Vrancea' },
];

/** Țările acceptate la facturare: România prima, apoi UE + câteva țări vecine/extindere. */
export const COUNTRIES: CountryOption[] = [
  { code: 'RO', name: 'România' },
  { code: 'AT', name: 'Austria' },
  { code: 'BE', name: 'Belgia' },
  { code: 'BG', name: 'Bulgaria' },
  { code: 'HR', name: 'Croația' },
  { code: 'CY', name: 'Cipru' },
  { code: 'CZ', name: 'Cehia' },
  { code: 'DK', name: 'Danemarca' },
  { code: 'EE', name: 'Estonia' },
  { code: 'FI', name: 'Finlanda' },
  { code: 'FR', name: 'Franța' },
  { code: 'DE', name: 'Germania' },
  { code: 'GR', name: 'Grecia' },
  { code: 'HU', name: 'Ungaria' },
  { code: 'IE', name: 'Irlanda' },
  { code: 'IT', name: 'Italia' },
  { code: 'LV', name: 'Letonia' },
  { code: 'LT', name: 'Lituania' },
  { code: 'LU', name: 'Luxemburg' },
  { code: 'MT', name: 'Malta' },
  { code: 'NL', name: 'Țările de Jos' },
  { code: 'PL', name: 'Polonia' },
  { code: 'PT', name: 'Portugalia' },
  { code: 'SK', name: 'Slovacia' },
  { code: 'SI', name: 'Slovenia' },
  { code: 'ES', name: 'Spania' },
  { code: 'SE', name: 'Suedia' },
  { code: 'GB', name: 'Marea Britanie' },
  { code: 'MD', name: 'Republica Moldova' },
  { code: 'CH', name: 'Elveția' },
  { code: 'NO', name: 'Norvegia' },
  { code: 'US', name: 'Statele Unite ale Americii' },
  { code: 'CA', name: 'Canada' },
];

/** Cheia de control pentru CUI/CIF, aliniată la dreapta peste cifrele fără ultima. */
const CUI_CONTROL_KEY = '753217532';

/**
 * Verifică un CUI românesc: se ignoră prefixul RO și spațiile, apoi cifra de control
 * se calculează cu cheia 753217532 (suma produselor * 10 % 11, 10 devine 0).
 */
export function isValidRoCui(cui: string): boolean {
  const digits = String(cui ?? '')
    .replace(/\s+/g, '')
    .replace(/^RO/i, '');
  if (!/^\d{2,10}$/.test(digits)) return false;

  const body = digits.slice(0, -1);
  const check = Number(digits.slice(-1));
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    sum += Number(body[i]) * Number(CUI_CONTROL_KEY[CUI_CONTROL_KEY.length - body.length + i]);
  }
  const control = (sum * 10) % 11;
  return (control === 10 ? 0 : control) === check;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validează datele de facturare primite din formular (input necunoscut).
 * Se face trim pe toate câmpurile, iar cui/country/county se scriu cu majuscule.
 */
export function validateBilling(
  input: unknown
): { ok: true; value: BillingDetails } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Datele de facturare lipsesc.' };
  }
  const raw = input as Record<string, unknown>;

  const type = text(raw.type).toUpperCase();
  if (type !== 'PF' && type !== 'PJ') {
    return { ok: false, error: 'Tipul clientului trebuie să fie PF (persoană fizică) sau PJ (persoană juridică).' };
  }

  const name = text(raw.name);
  if (name.length < 2 || name.length > 255) {
    return { ok: false, error: 'Numele trebuie să aibă între 2 și 255 de caractere.' };
  }

  const country = text(raw.country).toUpperCase();
  if (!COUNTRIES.some((item) => item.code === country)) {
    return { ok: false, error: 'Țara trebuie să fie una dintre țările acceptate.' };
  }

  const city = text(raw.city);
  if (city.length < 1 || city.length > 100) {
    return { ok: false, error: 'Orașul este obligatoriu și poate avea cel mult 100 de caractere.' };
  }

  const address = text(raw.address);
  if (address.length < 3 || address.length > 500) {
    return { ok: false, error: 'Adresa trebuie să aibă între 3 și 500 de caractere.' };
  }

  const phone = text(raw.phone);
  if (phone) {
    if (phone.length > 30) return { ok: false, error: 'Telefonul poate avea cel mult 30 de caractere.' };
    if (!/^[0-9+ ()-]+$/.test(phone)) {
      return { ok: false, error: 'Telefonul poate conține doar cifre, +, spații, paranteze și cratime.' };
    }
  }

  // Județul există doar pentru adresele din România
  let county: string | undefined;
  if (country === 'RO') {
    const code = text(raw.county).toUpperCase();
    if (!RO_COUNTIES.some((item) => item.code === code)) {
      return { ok: false, error: 'Județul este obligatoriu și trebuie să fie un județ din România.' };
    }
    county = code;
  }

  // Persoana juridică are CUI obligatoriu și, opțional, numărul din Registrul Comerțului
  let cui: string | undefined;
  let regCom: string | undefined;
  if (type === 'PJ') {
    cui = text(raw.cui).replace(/\s+/g, '').toUpperCase();
    if (!cui) return { ok: false, error: 'CUI-ul este obligatoriu pentru persoana juridică.' };
    if (cui.length > 128) return { ok: false, error: 'CUI-ul poate avea cel mult 128 de caractere.' };
    if (country === 'RO' && !isValidRoCui(cui)) return { ok: false, error: 'CUI invalid' };

    const regComValue = text(raw.regCom);
    if (regComValue.length > 128) {
      return { ok: false, error: 'Numărul din Registrul Comerțului poate avea cel mult 128 de caractere.' };
    }
    if (regComValue) regCom = regComValue;
  }

  const value: BillingDetails = { type, name, country, city, address };
  if (cui) value.cui = cui;
  if (regCom) value.regCom = regCom;
  if (county) value.county = county;
  if (phone) value.phone = phone;

  return { ok: true, value };
}
