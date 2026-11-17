import { createHash } from "crypto";
import type { PoolClient } from "pg";
import { pool, query, transaction } from "../db";
import { countryName, normalizeName } from "./normalize";
import { parseList, SANCTIONS_LISTS, SANCTIONS_SOURCES, type SanctionsList } from "./parsers";
import { noBuyersFrom } from "./places";

// Sanctions screening for data buyers, organisations and the people given access through one.
// A future buyer or organisation signup calls addParty(); the party then waits on
// /mod/compliance until a moderator or admin approves or refuses it. Nothing is ever approved
// automatically: "clear" only means no list matched, and approval still takes a person.
//
// The lists are the free official ones (lib/sanctions/parsers.ts), refreshed daily by the
// sanctions.refresh job. While any list is more than STALE_HOURS old, or was never loaded,
// approvals are refused (assertScreeningFresh).

export type PartyKind = "buyer" | "org_member" | "org";
export type PartyStatus = "pending" | "clear" | "review" | "refused" | "approved";
export type HitResolution = "open" | "false_match" | "true_match";

export type Fetcher = (url: string) => Promise<string>;

export const STALE_HOURS = 48;

// ---------- Matching ----------
// Names are compared after normalizeName() with pg_trgm, which splits names into words before
// taking trigrams, so word order never matters ("putin vladimir" = "vladimir putin", score 1:
// an exact token-set match is always a hit). A listed name is a possible match when either
//   * similarity(entry, party) >= SIMILARITY (0.6): catches spelling and transliteration
//     variants ("john smith" / "jon smith" 0.62, "kim jong un" / "kim jong il" 0.60) while a
//     merely related name ("alpha bank" / "alfa bank" 0.50) is left out; or
//   * one name sits whole inside the other, word_similarity >= CONTAINED (0.9): "sberbank"
//     against the listed "sberbank of russia" scores only 0.47 on similarity but is plainly the
//     same organisation. Only names of at least MIN_CONTAINED characters count this way, so a
//     short word ("bank") doesn't match every listed bank.
// A shared country adds COUNTRY_BONUS to the score; it never removes a hit, since a listed
// person can be based anywhere. Every hit goes to a person: the threshold trades a few more
// reviews for not missing a listed party behind a spelling difference.
export const SIMILARITY = 0.6;
export const CONTAINED = 0.9;
export const MIN_CONTAINED = 6;
export const COUNTRY_BONUS = 0.1;

export type Candidate = {
  entry_id: number; list: SanctionsList; source_id: string; name: string; countries: string[]; score: number;
};

// Listed names that may be this party, best first, one per listed person or thing.
export async function findMatches(name: string, country: string | null, db: PoolClient): Promise<Candidate[]> {
  const norm = normalizeName(name);
  if (!norm) return [];
  await db.query(`select set_config('pg_trgm.similarity_threshold', $1, true),
                         set_config('pg_trgm.word_similarity_threshold', $2, true)`, [String(SIMILARITY), String(CONTAINED)]);
  const { rows } = await db.query<Candidate>(
    `select distinct on (list, source_id) entry_id, list, source_id, name, countries, score from (
       select e.id::int as entry_id, e.list, e.source_id, e.name, e.countries,
              least(1, greatest(
                similarity(e.name_norm, $1),
                case when length($1) >= $3::int then word_similarity($1, e.name_norm) else 0 end,
                case when length(e.name_norm) >= $3 then word_similarity(e.name_norm, $1) else 0 end
              ) + case when $2::text is not null and $2::text = any(e.countries) then $4::real else 0 end)::real as score
         from sanctions_entries e
         join sanctions_list_imports i on i.id = e.import_id and i.is_current
        where e.name_norm % $1
           or (length($1) >= $3 and e.name_norm %> $1)
           or (length(e.name_norm) >= $3 and e.name_norm <% $1)
     ) m
     where score >= $5::real
     order by list, source_id, score desc`,
    [norm, country, MIN_CONTAINED, COUNTRY_BONUS, Math.min(SIMILARITY, CONTAINED)],
  );
  return rows.sort((a, b) => b.score - a.score);
}

// ---------- Imports ----------

export type ImportResult =
  | { list: SanctionsList; ok: true; importId: number; entries: number }
  | { list: SanctionsList; ok: false; importId: number; error: string };

const sourceUrl = (list: SanctionsList) => Object.values(SANCTIONS_SOURCES[list].files).join(" ");

function sha256Of(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const key of Object.keys(files).sort()) hash.update(`${key}\0${files[key]}\0`);
  return hash.digest("hex");
}

async function recordFailure(list: SanctionsList, error: string, sha256: string | null): Promise<ImportResult> {
  const [row] = await query<{ id: string }>(
    `insert into sanctions_list_imports (list, source_url, sha256, status, error) values ($1, $2, $3, 'failed', $4) returning id`,
    [list, sourceUrl(list), sha256, error.slice(0, 2000)],
  );
  return { list, ok: false, importId: Number(row.id), error };
}

const BATCH = 2000;

// Parses the list's files and stores them as its new current import, in one transaction. When
// parsing fails, a failed import is recorded and the previous current import stays current.
export async function importList(list: SanctionsList, files: Record<string, string>): Promise<ImportResult> {
  const sha256 = sha256Of(files);
  let entries;
  try {
    entries = parseList(list, files);
  } catch (err) {
    return recordFailure(list, (err as Error).message, sha256);
  }
  try {
    return await transaction(async (db) => {
      // Two imports of the same list take turns, so exactly one ends up current.
      await db.query("select pg_advisory_xact_lock(hashtext('sanctions.import:' || $1))", [list]);
      const { rows: [imp] } = await db.query<{ id: string }>(
        `insert into sanctions_list_imports (list, source_url, sha256, entry_count, status)
         values ($1, $2, $3, $4, 'ok') returning id`,
        [list, sourceUrl(list), sha256, entries.length],
      );
      const importId = Number(imp.id);
      for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH).map((e) => ({
          source_id: e.sourceId, kind: e.kind, name: e.name, name_norm: e.nameNorm, is_alias: e.isAlias,
          programs: e.programs, countries: e.countries,
        }));
        await db.query(
          `insert into sanctions_entries (import_id, list, source_id, kind, name, name_norm, is_alias, programs, countries)
           select $1, $2, x.source_id, x.kind, x.name, x.name_norm, x.is_alias, x.programs, x.countries
             from jsonb_to_recordset($3::jsonb)
                  as x(source_id text, kind text, name text, name_norm text, is_alias boolean, programs text[], countries text[])`,
          [importId, list, JSON.stringify(batch)],
        );
      }
      await db.query("update sanctions_list_imports set is_current = false where list = $1 and is_current", [list]);
      await db.query("update sanctions_list_imports set is_current = true where id = $1", [importId]);
      // Old names go; the import rows stay as the record of each fetch. Hits keep the matched
      // name and source id when their entry is deleted, and a rescreen links them to the new one.
      await db.query("delete from sanctions_entries where list = $1 and import_id <> $2", [list, importId]);
      return { list, ok: true as const, importId, entries: entries.length };
    });
  } catch (err) {
    return recordFailure(list, (err as Error).message, sha256);
  }
}

// The default fetcher: plain HTTPS, no key, with a timeout so a hung download can't stall the job.
export const fetchText: Fetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { "user-agent": "BeliefAtlas sanctions screening" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
};

export type RefreshResult = { results: ImportResult[]; rescreened: number };

// Fetches and imports every list, then rescreens every party that isn't refused. One list
// failing (download or format) is recorded and doesn't stop the others.
export async function refreshLists(fetcher: Fetcher = fetchText, lists: readonly SanctionsList[] = SANCTIONS_LISTS): Promise<RefreshResult> {
  const results: ImportResult[] = [];
  for (const list of lists) {
    let files: Record<string, string>;
    try {
      files = {};
      for (const [key, url] of Object.entries(SANCTIONS_SOURCES[list].files)) files[key] = await fetcher(url);
    } catch (err) {
      results.push(await recordFailure(list, `download failed: ${(err as Error).message}`, null));
      continue;
    }
    results.push(await importList(list, files));
  }
  const rescreened = await rescreenAll();
  return { results, rescreened };
}

// Screens every party again against the current lists. Pending parties are included so that
// parties added before any list was loaded get screened; refused parties stay refused.
export async function rescreenAll(): Promise<number> {
  const parties = await query<{ id: string }>(
    "select id from screened_parties where status in ('pending', 'clear', 'approved', 'review') order by id",
  );
  for (const p of parties) await screenParty(Number(p.id));
  return parties.length;
}

// ---------- Freshness ----------

export type ListFreshness = {
  list: SanctionsList;
  label: string;
  lastOkAt: Date | null;
  entryCount: number | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  stale: boolean;
};

export async function listFreshness(): Promise<ListFreshness[]> {
  const rows = await query<{ list: SanctionsList; ok_at: Date | null; entry_count: number | null; fail_at: Date | null; error: string | null; stale: boolean }>(
    `select l.list, cur.fetched_at as ok_at, cur.entry_count, fail.fetched_at as fail_at, fail.error,
            (cur.fetched_at is null or cur.fetched_at < now() - make_interval(hours => $2)) as stale
       from unnest($1::text[]) as l(list)
       left join sanctions_list_imports cur on cur.list = l.list and cur.is_current
       left join lateral (
         select fetched_at, error from sanctions_list_imports f
          where f.list = l.list and f.status = 'failed' order by f.fetched_at desc, f.id desc limit 1
       ) fail on true`,
    [SANCTIONS_LISTS, STALE_HOURS],
  );
  const byList = new Map(rows.map((r) => [r.list, r]));
  return SANCTIONS_LISTS.map((list) => {
    const r = byList.get(list);
    return {
      list, label: SANCTIONS_SOURCES[list].label, lastOkAt: r?.ok_at ?? null, entryCount: r?.entry_count ?? null,
      lastFailureAt: r?.fail_at ?? null, lastError: r?.error ?? null, stale: r?.stale ?? true,
    };
  });
}

// True when any list's current import is older than STALE_HOURS, or a list was never loaded.
export async function screeningIsStale(): Promise<boolean> {
  return (await listFreshness()).some((l) => l.stale);
}

export class ScreeningStale extends Error {
  constructor() {
    super(`sanctions lists are stale (a list is missing or older than ${STALE_HOURS} hours); approvals wait for a fresh refresh`);
    this.name = "ScreeningStale";
  }
}

// Every approval calls this first.
export async function assertScreeningFresh(): Promise<void> {
  if (await screeningIsStale()) throw new ScreeningStale();
}

// ---------- Parties ----------

export type Party = {
  id: number; kind: PartyKind; name: string; country: string | null; status: PartyStatus; status_reason: string | null;
  last_screened_at: Date | null; reviewed_by: number | null; reviewed_at: Date | null; created_at: Date;
};

const PARTY_COLUMNS = `id::int, kind, name, country, status, status_reason, last_screened_at, reviewed_by, reviewed_at, created_at`;

export async function getParty(id: number): Promise<Party | null> {
  return (await query<Party>(`select ${PARTY_COLUMNS} from screened_parties where id = $1`, [id]))[0] ?? null;
}

const countryLabel = (code: string | null) => (code ? `${countryName(code)} (${code})` : "no stated country");

// What a future buyer or organisation signup calls: records the party and screens it at once.
export async function addParty(input: { kind: PartyKind; name: string; country: string | null }): Promise<Party> {
  const country = input.country?.trim().toUpperCase() || null;
  if (country && !/^[A-Z]{2}$/.test(country)) throw new Error(`country must be an ISO alpha-2 code, not ${input.country}`);
  const [row] = await query<{ id: string }>(
    "insert into screened_parties (kind, name, name_norm, country) values ($1, $2, $3, $4) returning id",
    [input.kind, input.name.trim(), normalizeName(input.name), country],
  );
  return screenParty(Number(row.id));
}

// Screens one party against the current lists and sets its status:
//   * based in a country refused outright (noBuyersFrom: blocked or no-buyer countries, or no
//     country at all) -> refused, naming the country; no list check is needed for that;
//   * any open possible match, new or left from an earlier screen -> review;
//   * otherwise clear, or still approved if a person approved it before.
// An open hit is never cleared here, and an approved party with a new hit goes back to review.
// A party a person refused stays refused.
export async function screenParty(partyId: number): Promise<Party> {
  await transaction(async (db) => {
    const { rows: [p] } = await db.query<{ id: string; name: string; country: string | null; status: PartyStatus; reviewed_by: number | null }>(
      "select id, name, country, status, reviewed_by from screened_parties where id = $1 for update",
      [partyId],
    );
    if (!p) throw new Error(`no screened party ${partyId}`);
    if (p.status === "refused" && p.reviewed_by !== null) return;

    if (noBuyersFrom(p.country)) {
      await db.query(
        `update screened_parties set status = 'refused', last_screened_at = now(),
                status_reason = $2 where id = $1`,
        [partyId, `No organisations or data buyers are accepted from ${countryLabel(p.country)}.`],
      );
      return;
    }

    const loaded = await db.query("select 1 from sanctions_list_imports where is_current limit 1");
    if (!loaded.rowCount) {
      await db.query(
        "update screened_parties set status = 'pending', status_reason = $2 where id = $1 and status <> 'approved'",
        [partyId, "No sanctions list has been loaded yet; screened once the lists are."],
      );
      return;
    }

    const matches = await findMatches(p.name, p.country, db);
    for (const m of matches) {
      await db.query(
        `insert into screening_hits (party_id, entry_id, list, source_id, matched_name, score)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (party_id, list, (coalesce(source_id, matched_name)))
         do update set entry_id = excluded.entry_id, score = greatest(screening_hits.score, excluded.score)`,
        [partyId, m.entry_id, m.list, m.source_id, m.name, m.score],
      );
    }
    const { rows: [open] } = await db.query<{ n: number }>(
      "select count(*)::int as n from screening_hits where party_id = $1 and resolution = 'open'",
      [partyId],
    );
    if (open.n > 0) {
      await db.query(
        `update screened_parties set status = 'review', last_screened_at = now(), status_reason = $2 where id = $1`,
        [partyId, `${open.n} possible sanctions list ${open.n === 1 ? "match" : "matches"} to review.`],
      );
    } else if (p.status === "approved") {
      await db.query("update screened_parties set last_screened_at = now() where id = $1", [partyId]);
    } else {
      await db.query(
        `update screened_parties set status = 'clear', last_screened_at = now(),
                status_reason = 'No sanctions list match. Waiting for a person to approve.' where id = $1`,
        [partyId],
      );
    }
  });
  return (await getParty(partyId))!;
}

// ---------- Decisions (moderators and admins) ----------
// Each returns null when done, or a short error code the page turns into a message.

export type DecisionError = "not_found" | "decided" | "open_hits" | "no_buyer_country" | "refused" | "reason" | "not_screened";

// A person's verdict on one possible match. A true match refuses the party. When the last open
// hit is marked a false match, the party goes back to clear: it still needs an approval.
export async function resolveHit(
  hitId: number, reviewerAccountId: number, resolution: Exclude<HitResolution, "open">, note: string,
): Promise<DecisionError | null> {
  return transaction(async (db) => {
    const { rows: [hit] } = await db.query<{ party_id: string; list: string; matched_name: string; resolution: HitResolution }>(
      "select party_id, list, matched_name, resolution from screening_hits where id = $1 for update",
      [hitId],
    );
    if (!hit) return "not_found";
    if (hit.resolution !== "open") return "decided";
    await db.query("select 1 from screened_parties where id = $1 for update", [hit.party_id]);
    await db.query(
      "update screening_hits set resolution = $2, resolved_by = $3, resolved_at = now(), note = nullif($4, '') where id = $1",
      [hitId, resolution, reviewerAccountId, note.trim().slice(0, 2000)],
    );
    if (resolution === "true_match") {
      await db.query(
        `update screened_parties set status = 'refused', reviewed_by = $2, reviewed_at = now(), status_reason = $3 where id = $1`,
        [hit.party_id, reviewerAccountId, `Confirmed match on the ${SANCTIONS_SOURCES[hit.list as SanctionsList]?.label ?? hit.list}: ${hit.matched_name}.`],
      );
      return null;
    }
    const { rows: [open] } = await db.query<{ n: number }>(
      "select count(*)::int as n from screening_hits where party_id = $1 and resolution = 'open'",
      [hit.party_id],
    );
    if (open.n === 0) {
      await db.query(
        `update screened_parties set status = 'clear',
                status_reason = 'Every possible match was reviewed as not the same. Waiting for a person to approve.'
          where id = $1 and status = 'review'`,
        [hit.party_id],
      );
    }
    return null;
  });
}

// Approval: refused while the lists are stale (throws ScreeningStale). Screens the party again
// against the current lists first, then approves only a party with no open hit, not refused and
// not based in a refused country.
export async function approveParty(partyId: number, reviewerAccountId: number): Promise<DecisionError | null> {
  await assertScreeningFresh();
  const before = await getParty(partyId);
  if (!before) return "not_found";
  const party = await screenParty(partyId);
  if (noBuyersFrom(party.country)) return "no_buyer_country";
  if (party.status === "refused") return "refused";
  if (party.status === "review") return "open_hits";
  if (party.status === "pending" || !party.last_screened_at) return "not_screened";
  if (party.status === "approved") return null;
  const res = await pool.query(
    `update screened_parties set status = 'approved', reviewed_by = $2, reviewed_at = now(),
            status_reason = 'Approved after sanctions screening.'
      where id = $1 and status = 'clear'
        and not exists (select 1 from screening_hits where party_id = $1 and resolution = 'open')`,
    [partyId, reviewerAccountId],
  );
  return res.rowCount ? null : "open_hits";
}

export async function refuseParty(partyId: number, reviewerAccountId: number, reason: string): Promise<DecisionError | null> {
  const why = reason.trim();
  if (!why) return "reason";
  const res = await pool.query(
    "update screened_parties set status = 'refused', reviewed_by = $2, reviewed_at = now(), status_reason = $3 where id = $1",
    [partyId, reviewerAccountId, why.slice(0, 2000)],
  );
  return res.rowCount ? null : "not_found";
}

// ---------- For /mod/compliance ----------

export type OpenHit = { id: number; list: SanctionsList; matched_name: string; score: number; source_id: string | null; programs: string[] | null };
export type PartyForReview = Party & { hits: OpenHit[] };

// Parties waiting on a person: those with open hits, and those screened clear but not approved.
export async function partiesToReview(): Promise<PartyForReview[]> {
  const parties = await query<Party>(
    `select ${PARTY_COLUMNS} from screened_parties where status in ('review', 'clear') order by status = 'clear', created_at`,
  );
  if (!parties.length) return [];
  const hits = await query<OpenHit & { party_id: number }>(
    `select h.id::int, h.party_id::int, h.list, h.matched_name, h.score, h.source_id, e.programs
       from screening_hits h left join sanctions_entries e on e.id = h.entry_id
      where h.party_id = any($1::bigint[]) and h.resolution = 'open'
      order by h.score desc`,
    [parties.map((p) => p.id)],
  );
  return parties.map((p) => ({ ...p, hits: hits.filter((h) => h.party_id === p.id) }));
}
