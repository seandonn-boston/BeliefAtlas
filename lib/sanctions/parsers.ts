import { countryKey, normalizeName } from "./normalize";

// The free official sanctions lists, read from the files their publishers put out. Each parser is
// a pure function from file text to entries: one entry per name, the primary name first and
// every alias after it with the same source_id. No library and no paid list provider.
//
// A parser fails loudly. A missing column or element, a row of the wrong shape or a file with no
// entries throws an error that names what is wrong, so a format change shows up as a failed
// import (and the stale-lists banner on /mod/compliance), never as a quiet import of zero names.

export type SanctionsList = "ofac_sdn" | "ofac_cons" | "un" | "eu" | "uk";
export const SANCTIONS_LISTS: readonly SanctionsList[] = ["ofac_sdn", "ofac_cons", "un", "eu", "uk"];

export type EntryKind = "person" | "entity" | "vessel" | "aircraft" | "unknown";

export type SanctionsEntry = {
  sourceId: string;     // the publisher's own id for the listed person or thing
  kind: EntryKind;
  name: string;         // as published
  nameNorm: string;     // normalizeName(name)
  isAlias: boolean;
  programs: string[];   // sanctions programmes or regimes, as the publisher names them
  countries: string[];  // ISO alpha-2 where the name could be mapped, otherwise the name upper-cased
};

// Where each list is downloaded from, free and without a key. Each list has one or more files,
// fetched together and parsed together. The files' keys are what the parser expects.
export const SANCTIONS_SOURCES: Record<SanctionsList, { label: string; files: Record<string, string> }> = {
  // OFAC's legacy CSV files. These treasury.gov addresses redirect to OFAC's newer Sanctions List
  // Service (https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV,
  // ALT.CSV, CONS_PRIM.CSV, CONS_ALT.CSV); switch to those if the redirects ever stop.
  ofac_sdn: {
    label: "OFAC SDN list",
    files: {
      primary: "https://www.treasury.gov/ofac/downloads/sdn.csv",
      alt: "https://www.treasury.gov/ofac/downloads/alt.csv",
    },
  },
  ofac_cons: {
    label: "OFAC Consolidated (non-SDN) list",
    files: {
      primary: "https://www.treasury.gov/ofac/downloads/consolidated/cons_prim.csv",
      alt: "https://www.treasury.gov/ofac/downloads/consolidated/cons_alt.csv",
    },
  },
  un: {
    label: "UN Security Council Consolidated List",
    files: { main: "https://scsanctions.un.org/resources/xml/en/consolidated.xml" },
  },
  eu: {
    label: "EU Consolidated Financial Sanctions List",
    files: { main: "https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw" },
  },
  // OFSI's consolidated list. OFSI has said the UK Sanctions List (FCDO) is to become the single
  // UK source; if this address stops serving, imports fail and the stale banner says so, and this
  // is the place to point at the UK Sanctions List's CSV instead (with a parser for its columns).
  uk: {
    label: "UK OFSI Consolidated List",
    files: { main: "https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv" },
  },
};

export class SanctionsFormatError extends Error {
  constructor(list: string, message: string) {
    super(`${list}: ${message}`);
    this.name = "SanctionsFormatError";
  }
}

// ---------- CSV (RFC 4180) ----------
// Quoted fields may hold the delimiter, line breaks and doubled quotes. A byte-order mark at the
// start is dropped. Empty lines are skipped.
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => {
    row.push(field);
    field = "";
    if (!(row.length === 1 && row[0].trim() === "")) rows.push(row);
    row = [];
  };
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field.trim() === "") {
      field = "";
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      endRow();
    } else if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) endRow();
  return rows;
}

// The column index for each wanted column, by header name. Each wanted column may have several
// known names (publishers rename columns between format versions). Throws naming every required
// column that isn't there.
function columns<K extends string>(
  list: string,
  header: string[],
  wanted: Record<K, { names: string[]; required: boolean }>,
): Record<K, number> {
  const index = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  const out = {} as Record<K, number>;
  const missing: string[] = [];
  for (const [key, spec] of Object.entries(wanted) as [K, { names: string[]; required: boolean }][]) {
    const found = spec.names.map((n) => index.get(n.toLowerCase())).find((i) => i !== undefined);
    if (found === undefined && spec.required) missing.push(spec.names.join(" or "));
    out[key] = found ?? -1;
  }
  if (missing.length) throw new SanctionsFormatError(list, `missing column ${missing.join(", ")}`);
  return out;
}

const cell = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
const uniq = <T>(xs: T[]) => [...new Set(xs)];

function entry(
  sourceId: string, kind: EntryKind, name: string, isAlias: boolean, programs: string[], countries: (string | null)[],
): SanctionsEntry | null {
  const clean = name.replace(/\s+/g, " ").trim();
  const nameNorm = normalizeName(clean);
  if (!nameNorm) return null;
  return {
    sourceId, kind, name: clean, nameNorm, isAlias, programs: uniq(programs.filter(Boolean)),
    countries: uniq(countries.filter((c): c is string => Boolean(c))),
  };
}

function nonEmpty(list: string, entries: SanctionsEntry[]): SanctionsEntry[] {
  if (!entries.length) throw new SanctionsFormatError(list, "the file has no entries");
  return entries;
}

// ---------- OFAC SDN and Consolidated (legacy CSV) ----------
// No header row. The primary file (SDN.CSV, CONS_PRIM.CSV) has 12 columns: ent_num, SDN_Name,
// SDN_Type, Program, Title, Call_Sign, Vess_type, Tonnage, GRT, Vess_flag, Vess_owner, Remarks.
// The alias file (ALT.CSV, CONS_ALT.CSV) has 5: ent_num, alt_num, alt_type, alt_name,
// alt_remarks. "-0-" means empty. The files end with a stray ^Z line, which is skipped.

const OFAC_EMPTY = (v: string) => (v.trim() === "-0-" ? "" : v.trim());

// "SDGT] [IRGC] [IFSR", "[SDGT] [IRGC]", "UKRAINE-EO13662": the program codes, whatever brackets
// are left around them.
export function ofacPrograms(field: string): string[] {
  const value = OFAC_EMPTY(field);
  if (!value) return [];
  return uniq(value.split(/[[\]]/).flatMap((p) => p.trim().split(/\s+/)).filter(Boolean));
}

const OFAC_KIND: Record<string, EntryKind> = { individual: "person", vessel: "vessel", aircraft: "aircraft", "": "entity" };

// OFAC puts nationality and citizenship in the free-text remarks ("Nationality Iran; ...").
function ofacCountries(remarks: string): (string | null)[] {
  const out: (string | null)[] = [];
  for (const m of remarks.matchAll(/\b(?:nationality|citizen)\s+([^;.]+)/gi)) out.push(countryKey(m[1]));
  return out;
}

const isDataRow = (row: string[]) => /^\d+$/.test((row[0] ?? "").trim());

export function parseOfac(list: "ofac_sdn" | "ofac_cons", primary: string, alt: string): SanctionsEntry[] {
  const entries: SanctionsEntry[] = [];
  const byId = new Map<string, { kind: EntryKind; programs: string[]; countries: (string | null)[] }>();
  parseCsv(primary).forEach((row, line) => {
    if (!isDataRow(row)) {
      if (row.join("").replace(/\x1a/g, "").trim()) throw new SanctionsFormatError(list, `primary file line ${line + 1} doesn't start with an entry number`);
      return;
    }
    if (row.length < 12) throw new SanctionsFormatError(list, `primary file line ${line + 1} has ${row.length} columns, expected 12`);
    const id = row[0].trim();
    const type = OFAC_EMPTY(row[2]).toLowerCase();
    const kind = OFAC_KIND[type];
    if (!kind) throw new SanctionsFormatError(list, `entry ${id} has an unknown SDN_Type "${row[2].trim()}"`);
    const programs = ofacPrograms(row[3]);
    const countries = [...ofacCountries(OFAC_EMPTY(row[11])), kind === "vessel" ? countryKey(OFAC_EMPTY(row[9])) : null];
    byId.set(id, { kind, programs, countries });
    const e = entry(id, kind, OFAC_EMPTY(row[1]), false, programs, countries);
    if (e) entries.push(e);
  });
  parseCsv(alt).forEach((row, line) => {
    if (!isDataRow(row)) {
      if (row.join("").replace(/\x1a/g, "").trim()) throw new SanctionsFormatError(list, `alias file line ${line + 1} doesn't start with an entry number`);
      return;
    }
    if (row.length < 5) throw new SanctionsFormatError(list, `alias file line ${line + 1} has ${row.length} columns, expected 5`);
    const id = row[0].trim();
    const parent = byId.get(id);
    // An alias of an entry the primary file doesn't have: keep it, it is still a listed name.
    const e = entry(id, parent?.kind ?? "unknown", OFAC_EMPTY(row[3]), true, parent?.programs ?? [], parent?.countries ?? []);
    if (e) entries.push(e);
  });
  return nonEmpty(list, entries);
}

// ---------- UN Security Council consolidated list (XML) ----------
// CONSOLIDATED_LIST > INDIVIDUALS > INDIVIDUAL and ENTITIES > ENTITY. No XML library: a small
// extractor for this flat, well-known shape is enough.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
      if (ref[0] === "#") {
        const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[ref.toLowerCase()] ?? whole;
    });
}

// Every element named `tag` directly or deeply inside `xml`: its inner text (raw, still encoded).
// Self-closing elements give "".
export function xmlElements(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}>)`, "g");
  return [...xml.matchAll(re)].map((m) => m[1] ?? "");
}

const xmlText = (xml: string, tag: string) => decodeXml(xmlElements(xml, tag)[0] ?? "").trim();

export function parseUn(xml: string): SanctionsEntry[] {
  if (!/<CONSOLIDATED_LIST[\s>]/.test(xml)) throw new SanctionsFormatError("un", "no CONSOLIDATED_LIST root element");
  if (!/<INDIVIDUALS[\s>/]/.test(xml) || !/<ENTITIES[\s>/]/.test(xml)) {
    throw new SanctionsFormatError("un", "missing INDIVIDUALS or ENTITIES element");
  }
  const entries: SanctionsEntry[] = [];
  const read = (block: string, kind: EntryKind, aliasTag: string) => {
    const id = xmlText(block, "DATAID");
    if (!id) throw new SanctionsFormatError("un", `an ${kind === "person" ? "INDIVIDUAL" : "ENTITY"} has no DATAID`);
    const name = kind === "person"
      ? ["FIRST_NAME", "SECOND_NAME", "THIRD_NAME", "FOURTH_NAME"].map((t) => xmlText(block, t)).filter(Boolean).join(" ")
      : xmlText(block, "FIRST_NAME");
    if (!name) throw new SanctionsFormatError("un", `entry ${id} has no FIRST_NAME`);
    const programs = [xmlText(block, "UN_LIST_TYPE")];
    const countries = xmlElements(block, "NATIONALITY").flatMap((n) => xmlElements(n, "VALUE").map((v) => countryKey(decodeXml(v))));
    const primary = entry(id, kind, name, false, programs, countries);
    if (primary) entries.push(primary);
    for (const alias of xmlElements(block, aliasTag)) {
      const e = entry(id, kind, decodeXml(xmlElements(alias, "ALIAS_NAME")[0] ?? ""), true, programs, countries);
      if (e) entries.push(e);
    }
  };
  for (const block of xmlElements(xml, "INDIVIDUAL")) read(block, "person", "INDIVIDUAL_ALIAS");
  for (const block of xmlElements(xml, "ENTITY")) read(block, "entity", "ENTITY_ALIAS");
  return nonEmpty("un", entries);
}

// ---------- EU consolidated financial sanctions list (CSV, ";") ----------
// One row per name alias, address, birth date and so on, all carrying the entity's logical id;
// rows are grouped by that id. The first name seen for an entity is taken as its primary name.

export function parseEu(text: string): SanctionsEntry[] {
  const rows = parseCsv(text, ";");
  if (!rows.length) throw new SanctionsFormatError("eu", "the file is empty");
  const col = columns("eu", rows[0], {
    id: { names: ["Entity_LogicalId"], required: true },
    type: { names: ["Entity_SubjectType_ClassificationCode", "Entity_SubjectType"], required: true },
    name: { names: ["NameAlias_WholeName"], required: true },
    programme: { names: ["Entity_Regulation_Programme", "Entity_Programme"], required: true },
    country: { names: ["Citizenship_CountryIso2Code"], required: false },
  });
  const groups = new Map<string, { kind: EntryKind; names: string[]; programs: string[]; countries: string[] }>();
  for (const row of rows.slice(1)) {
    const id = cell(row, col.id);
    if (!id) continue;
    const g = groups.get(id) ?? { kind: "unknown" as EntryKind, names: [], programs: [], countries: [] };
    const type = cell(row, col.type).toLowerCase();
    if (type === "person" || type === "p") g.kind = "person";
    else if (type === "enterprise" || type === "e") g.kind = "entity";
    const name = cell(row, col.name);
    if (name && !g.names.includes(name)) g.names.push(name);
    const programme = cell(row, col.programme);
    if (programme) g.programs.push(programme);
    const country = countryKey(cell(row, col.country));
    if (country) g.countries.push(country);
    groups.set(id, g);
  }
  const entries: SanctionsEntry[] = [];
  for (const [id, g] of groups) {
    g.names.forEach((name, i) => {
      const e = entry(id, g.kind, name, i > 0, g.programs, g.countries);
      if (e) entries.push(e);
    });
  }
  return nonEmpty("eu", entries);
}

// ---------- UK OFSI consolidated list (CSV) ----------
// The first line is "Last Updated,<date>"; the header is the row holding "Name 6". One row per
// name; rows are grouped by Group ID. Name 6 is the surname or the organisation's whole name.

export function parseUk(text: string): SanctionsEntry[] {
  const rows = parseCsv(text);
  const headerAt = rows.findIndex((r) => r.some((c) => c.trim().toLowerCase() === "name 6"));
  if (headerAt < 0) throw new SanctionsFormatError("uk", 'missing column Name 6 (no header row found)');
  const col = columns("uk", rows[headerAt], {
    n6: { names: ["Name 6"], required: true },
    n1: { names: ["Name 1"], required: true },
    n2: { names: ["Name 2"], required: true },
    n3: { names: ["Name 3"], required: true },
    n4: { names: ["Name 4"], required: true },
    n5: { names: ["Name 5"], required: true },
    type: { names: ["Group Type"], required: true },
    aliasType: { names: ["Alias Type"], required: true },
    regime: { names: ["Regime"], required: true },
    group: { names: ["Group ID"], required: true },
    country: { names: ["Country"], required: false },
    nationality: { names: ["Nationality"], required: false },
  });
  const KIND: Record<string, EntryKind> = { individual: "person", entity: "entity", ship: "vessel" };
  const groups = new Map<string, { kind: EntryKind; primary: string[]; aliases: string[]; programs: string[]; countries: (string | null)[] }>();
  for (const row of rows.slice(headerAt + 1)) {
    const id = cell(row, col.group);
    if (!id) continue;
    const g = groups.get(id) ?? { kind: "unknown" as EntryKind, primary: [], aliases: [], programs: [], countries: [] };
    g.kind = KIND[cell(row, col.type).toLowerCase()] ?? g.kind;
    const name = [col.n1, col.n2, col.n3, col.n4, col.n5, col.n6].map((i) => cell(row, i)).filter(Boolean).join(" ");
    if (name) (cell(row, col.aliasType).toLowerCase() === "primary name" ? g.primary : g.aliases).push(name);
    g.programs.push(cell(row, col.regime));
    // "Nationality" can hold several, "(1) Iran (2) Iraq"; the address "Country" is one.
    for (const n of cell(row, col.nationality).split(/\(\d+\)|[,;]/)) g.countries.push(countryKey(n));
    g.countries.push(countryKey(cell(row, col.country)));
    groups.set(id, g);
  }
  const entries: SanctionsEntry[] = [];
  for (const [id, g] of groups) {
    // A group whose rows are all aliases still has a name: its first one stands as the primary.
    const names = uniq([...g.primary, ...g.aliases]);
    const primaries = g.primary.length ? uniq(g.primary).length : 1;
    names.forEach((name, i) => {
      const e = entry(id, g.kind, name, i >= primaries, g.programs, g.countries);
      if (e) entries.push(e);
    });
  }
  return nonEmpty("uk", entries);
}

// ---------- One entry point ----------

export function parseList(list: SanctionsList, files: Record<string, string>): SanctionsEntry[] {
  const need = (key: string) => {
    const text = files[key];
    if (typeof text !== "string") throw new SanctionsFormatError(list, `missing file "${key}"`);
    return text;
  };
  switch (list) {
    case "ofac_sdn":
    case "ofac_cons":
      return parseOfac(list, need("primary"), need("alt"));
    case "un":
      return parseUn(need("main"));
    case "eu":
      return parseEu(need("main"));
    case "uk":
      return parseUk(need("main"));
  }
}
