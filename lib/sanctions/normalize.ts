// Names in a form that can be compared across lists and alphabets with Latin transliterations:
// "OOO Röмашка-Trade, Ltd." and "romashka trade" should land close together. The same function
// runs on list entries at import and on the parties we screen, so both sides always match.

// Legal-form words that say nothing about who an organisation is. Dropped wherever they appear
// in the name (Russian forms usually come first: "OOO Romashka"), unless nothing would be left.
export const COMPANY_SUFFIXES: ReadonlySet<string> = new Set([
  "ltd", "llc", "llp", "lp", "plc", "inc", "incorporated", "gmbh", "ooo", "zao", "oao", "pao", "pjsc", "ojsc", "cjsc",
  "jsc", "co", "corp", "corporation", "sa", "ag", "bv", "nv", "srl", "spa", "limited", "company",
]);

// Letters that NFKD leaves whole but people write in plain Latin.
const FOLD: Record<string, string> = { ß: "ss", æ: "ae", ø: "o", đ: "d", ð: "d", ł: "l", ı: "i", œ: "oe", þ: "th", ħ: "h" };

export function normalizeName(raw: string | null | undefined): string {
  const folded = (raw ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")             // accents and other combining marks
    .toLowerCase()
    .replace(/[ßæøđðłıœþħ]/g, (c) => FOLD[c] ?? c)
    .replace(/['’‘`ʼ.]/g, "")            // O'Brien -> obrien, L.L.C. -> llc, S.A. -> sa
    .replace(/[^\p{L}\p{N}]+/gu, " ")    // every other punctuation mark or symbol is a gap
    .trim();
  if (!folded) return "";
  const tokens = folded.split(/\s+/);
  const kept = tokens.filter((t) => !COMPANY_SUFFIXES.has(t));
  return (kept.length ? kept : tokens).join(" ");
}

// ---------- Countries ----------
// Lists name countries in words ("Russian Federation", "Iran (Islamic Republic of)"); parties
// carry ISO 3166-1 alpha-2 codes. Names are mapped to codes with the runtime's own region names
// (Intl, no data file to keep up to date) plus the UN-style long forms the lists use. A name
// that can't be mapped is kept as written, upper-cased, so nothing is lost.

const LONG_FORMS: Record<string, string> = {
  "russian federation": "RU",
  "iran islamic republic of": "IR",
  "islamic republic of iran": "IR",
  "democratic peoples republic of korea": "KP",
  "korea democratic peoples republic of": "KP",
  "dprk": "KP",
  "republic of korea": "KR",
  "korea republic of": "KR",
  "syrian arab republic": "SY",
  "venezuela bolivarian republic of": "VE",
  "bolivarian republic of venezuela": "VE",
  "united states of america": "US",
  "usa": "US",
  "united kingdom of great britain and northern ireland": "GB",
  "uk": "GB",
  "viet nam": "VN",
  "lao peoples democratic republic": "LA",
  "bolivia plurinational state of": "BO",
  "tanzania united republic of": "TZ",
  "united republic of tanzania": "TZ",
  "democratic republic of the congo": "CD",
  "congo democratic republic of the": "CD",
  "republic of the congo": "CG",
  "congo": "CG",
  "turkiye": "TR",
  "czech republic": "CZ",
  "myanmar": "MM",
  "burma": "MM",
  "republic of moldova": "MD",
  "moldova republic of": "MD",
  "state of palestine": "PS",
  "palestine": "PS",
  "cote divoire": "CI",
  "ivory coast": "CI",
  "belarus republic of": "BY",
  "crimea": "UA",
  "hong kong sar": "HK",
  "macao": "MO",
  "macau": "MO",
};

const NOT_COUNTRIES = new Set(["EU", "EZ", "UN", "ZZ"]);

let nameToCode: Map<string, string> | null = null;

function countryNames(): Map<string, string> {
  if (nameToCode) return nameToCode;
  const map = new Map<string, string>();
  const display = new Intl.DisplayNames(["en"], { type: "region" });
  const A = "A".charCodeAt(0);
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(A + i, A + j);
      // Not countries: groupings (EU, UN, EZ), private-use codes (QM-QZ, XA-XZ but Kosovo).
      if (NOT_COUNTRIES.has(code) || code[0] === "Q" || (code[0] === "X" && code !== "XK")) continue;
      let name: string | undefined;
      try {
        // Retired codes (YD, SU, ZR, BU...) still have names; they map to today's code instead.
        if (Intl.getCanonicalLocales(`und-${code}`)[0] !== `und-${code}`) continue;
        name = display.of(code);
      } catch {
        continue;
      }
      // Unknown codes come back as the code itself; "Unknown Region" for reserved ones.
      if (!name || name === code || /unknown/i.test(name)) continue;
      const key = normalizeName(name);
      if (key && !map.has(key)) map.set(key, code);
      // "Myanmar (Burma)", "Hong Kong SAR China": the short part alone too.
      const short = normalizeName(name.replace(/\(.*\)/, ""));
      if (short && !map.has(short)) map.set(short, code);
    }
  }
  for (const [name, code] of Object.entries(LONG_FORMS)) map.set(name, code);
  nameToCode = map;
  return map;
}

// The ISO alpha-2 code for a country written as a code or a name, or null when unknown.
export function toCountryCode(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (/^[A-Za-z]{2}$/.test(value)) {
    const code = value.toUpperCase();
    return [...countryNames().values()].includes(code) ? code : null;
  }
  return countryNames().get(normalizeName(value)) ?? null;
}

// For storing on an entry: the code when known, otherwise the name as written, upper-cased.
export function countryKey(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  return toCountryCode(value) ?? value.toUpperCase();
}

// Every country the runtime knows by name, for finding country names in free text.
export function knownCountryNames(): string[] {
  return [...countryNames().keys()];
}

export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
