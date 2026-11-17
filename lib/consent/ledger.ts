import type { PoolClient } from "pg";
import { query, transaction } from "../db";
import { regionFor } from "../regions";
import { cleanConsentSurface, regionFrom, type ConsentContext } from "./context";

// The consent ledger. Two separate choices:
//   answering  required before any answer counts. Belief data is special-category data, so this
//              is an explicit, recorded agreement, not "needed to use the app".
//   sale       optional, off by default, never required to vote. Including someone's answers in
//              data that is sold needs this AND a region open to sale AND no GPC signal.
//
// consent_records is append-only (the database refuses updates): every grant, withdrawal and
// GPC opt-out is a new row, and the current state is the latest row per choice.

export const CONSENT_CHOICES = ["answering", "sale"] as const;
export type ConsentChoice = (typeof CONSENT_CHOICES)[number];

// The consent texts are drafts until a lawyer has reviewed them, like /terms and /privacy
// (lib/legal.ts). Each text row also carries its own `draft` flag, which the pages show.
export const CONSENT_DRAFT = true;

export type ConsentText = { choice: ConsentChoice; version: string; lang: string; body: string; draft: boolean };

export type ConsentRecord = {
  id: number;
  choice: ConsentChoice;
  granted: boolean;
  textVersion: string;
  lang: string;
  surface: string;
  region: string | null;
  gpc: boolean;
  createdAt: Date;
};

type RecordRow = {
  id: string; choice: ConsentChoice; granted: boolean; text_version: string; lang: string; surface: string;
  region: string | null; gpc: boolean; created_at: Date;
};
const toRecord = (r: RecordRow): ConsentRecord => ({
  id: Number(r.id), choice: r.choice, granted: r.granted, textVersion: r.text_version, lang: r.lang,
  surface: r.surface, region: r.region, gpc: r.gpc, createdAt: r.created_at,
});

// ---------- Texts ----------

// The current version of a choice's text in a language, falling back to English when that
// language has no translation of the current version. The newest version is the current one.
export async function currentText(choice: ConsentChoice, lang: string): Promise<ConsentText | null> {
  const rows = await query<ConsentText>(
    `with latest as (
       select version from consent_texts where choice = $1 order by created_at desc, version desc limit 1
     )
     select t.choice, t.version, t.lang, t.body, t.draft
       from consent_texts t join latest l on l.version = t.version
      where t.choice = $1 and t.lang in ($2, 'en')
      order by (t.lang = $2) desc
      limit 1`,
    [choice, lang],
  );
  return rows[0] ?? null;
}

async function textExists(choice: ConsentChoice, version: string, lang: string): Promise<boolean> {
  const rows = await query("select 1 from consent_texts where choice = $1 and version = $2 and lang = $3", [choice, version, lang]);
  return rows.length === 1;
}

// ---------- State ----------

export type ConsentState = Record<ConsentChoice, ConsentRecord | null>;

const LATEST = `
  select distinct on (choice) id, choice, granted, text_version, lang, surface, region, gpc, created_at
    from consent_records where account_id = $1
   order by choice, created_at desc, id desc`;

// The latest record for each choice (null when the person has never made that choice).
export async function consentState(accountId: number): Promise<ConsentState> {
  const rows = await query<RecordRow>(LATEST, [accountId]);
  const state: ConsentState = { answering: null, sale: null };
  for (const r of rows) state[r.choice] = toRecord(r);
  return state;
}

// Whether answers from this account may be counted. A new version of the text doesn't undo an
// earlier agreement; to ask everyone again, record nothing and compare textVersion instead.
export async function hasAnsweringConsent(accountId: number): Promise<boolean> {
  const rows = await query<{ granted: boolean }>(
    `select granted from consent_records where account_id = $1 and choice = 'answering'
      order by created_at desc, id desc limit 1`,
    [accountId],
  );
  return rows[0]?.granted === true;
}

// The person's own view of sale: on only when the latest record is an opt-in made without GPC.
// (Whether a sale may actually include them also depends on the region: see saleAllowed().)
export const saleIsOn = (state: ConsentState) => Boolean(state.sale?.granted && !state.sale.gpc);

// Every record for the account, newest first: the history shown in settings and the export.
export async function consentHistory(accountId: number): Promise<ConsentRecord[]> {
  const rows = await query<RecordRow>(
    `select id, choice, granted, text_version, lang, surface, region, gpc, created_at
       from consent_records where account_id = $1 order by created_at desc, id desc`,
    [accountId],
  );
  return rows.map(toRecord);
}

// ---------- Recording ----------

export type RecordInput = {
  accountId: number;
  choice: ConsentChoice;
  granted: boolean;
  version: string;   // the version of the text that was shown
  lang: string;      // the language of the text that was shown
};
export type RecordResult = { ok: true; record: ConsentRecord } | { ok: false; error: RecordError };
export type RecordError = "unknown_text" | "gpc" | "region_closed" | "no_account";

async function insert(
  client: PoolClient | null, input: RecordInput, ctx: ConsentContext, gpc: boolean,
): Promise<ConsentRecord> {
  const region = regionFrom(ctx.region);
  const sql = `insert into consent_records (account_id, choice, granted, text_version, lang, surface, region, gpc)
               values ($1, $2, $3, $4, $5, $6, $7, $8)
               returning id, choice, granted, text_version, lang, surface, region, gpc, created_at`;
  const params = [input.accountId, input.choice, input.granted, input.version, input.lang, cleanConsentSurface(ctx.surface), region, gpc];
  const rows = client ? (await client.query<RecordRow>(sql, params)).rows : await query<RecordRow>(sql, params);
  // The account's region is the latest one seen with a choice; unknown never overwrites known.
  if (region) {
    const update = "update accounts set region = $2 where id = $1 and region is distinct from $2";
    if (client) await client.query(update, [input.accountId, region]);
    else await query(update, [input.accountId, region]);
  }
  return toRecord(rows[0]);
}

// Record one choice. A sale opt-in is refused while GPC is on or where sale isn't open, so the
// ledger can never say "yes" in a situation where yes isn't possible. Withdrawals are always
// accepted.
export async function recordConsent(input: RecordInput, ctx: ConsentContext): Promise<RecordResult> {
  if (!CONSENT_CHOICES.includes(input.choice)) return { ok: false, error: "unknown_text" };
  if (!(await textExists(input.choice, input.version, input.lang))) return { ok: false, error: "unknown_text" };
  const [account] = await query<{ region: string | null }>(
    "select region from accounts where id = $1 and deleted_at is null", [input.accountId],
  );
  if (!account) return { ok: false, error: "no_account" };
  if (input.choice === "sale" && input.granted) {
    if (ctx.gpc) return { ok: false, error: "gpc" };
    const region = (await regionFor(regionFrom(ctx.region) ?? account.region)).saleAllowed;
    if (!region) return { ok: false, error: "region_closed" };
  }
  return { ok: true, record: await insert(null, input, ctx, ctx.gpc) };
}

// Global Privacy Control counts as an opt-out of sale. When a request from a signed-in account
// carries it, record the opt-out once (not on every request): a new row only if the latest sale
// record isn't already a GPC opt-out. Returns true when a row was written.
export async function honorGpc(accountId: number, ctx: ConsentContext): Promise<boolean> {
  if (!ctx.gpc) return false;
  const text = await currentText("sale", ctx.lang);
  if (!text) return false;
  return transaction(async (client) => {
    // One opt-out per account even when two requests race.
    await client.query("select pg_advisory_xact_lock(727275, $1)", [accountId]);
    const { rows } = await client.query<{ granted: boolean; gpc: boolean }>(
      `select granted, gpc from consent_records where account_id = $1 and choice = 'sale'
        order by created_at desc, id desc limit 1`,
      [accountId],
    );
    if (rows[0] && !rows[0].granted && rows[0].gpc) return false;
    const exists = await client.query("select 1 from accounts where id = $1 and deleted_at is null", [accountId]);
    if (!exists.rowCount) return false;
    await insert(client, { accountId, choice: "sale", granted: false, version: text.version, lang: text.lang }, ctx, true);
    return true;
  });
}

// Whether to offer the sale choice at all on this request: never with GPC on, never where the
// region (the request's, else the one last recorded on the account, else '*') isn't open.
export type SaleOffer = { offer: true } | { offer: false; reason: "gpc" | "region_closed" };

export async function saleOffer(accountId: number, ctx: ConsentContext): Promise<SaleOffer> {
  if (ctx.gpc) return { offer: false, reason: "gpc" };
  const [account] = await query<{ region: string | null }>("select region from accounts where id = $1", [accountId]);
  const open = (await regionFor(regionFrom(ctx.region) ?? account?.region ?? null)).saleAllowed;
  return open ? { offer: true } : { offer: false, reason: "region_closed" };
}
