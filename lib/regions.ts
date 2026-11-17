import { query } from "./db";
import { NEVER_SELL_COUNTRIES } from "./sanctions/places";

// Regions decide two things, and nothing else: whether person-level answers may ever be sold
// there, and how small a group may be before it is hidden from aggregate breakdowns. Voting is
// open everywhere except the blocked places in lib/sanctions/places.ts, which proxy.ts turns
// away. Every region is closed to sale until a lawyer has reviewed it; the '*' row stands for
// everywhere without a row of its own (and for anyone whose region isn't known).

export type Region = {
  code: string;
  name: string;
  saleAllowed: boolean;
  needsOptIn: boolean;
  minGroupSize: number;
};

export const DEFAULT_REGION = "*";
const FALLBACK: Region = { code: DEFAULT_REGION, name: "Everywhere else", saleAllowed: false, needsOptIn: true, minGroupSize: 50 };

type Row = { code: string; name: string; sale_allowed: boolean; needs_opt_in: boolean; min_group_size: number };
const toRegion = (r: Row): Region => ({
  code: r.code, name: r.name, saleAllowed: r.sale_allowed, needsOptIn: r.needs_opt_in, minGroupSize: r.min_group_size,
});

// The row for a region code, or the '*' row when the code is unknown or has no row.
export async function regionFor(code: string | null | undefined): Promise<Region> {
  const rows = await query<Row>(
    `select code, name, sale_allowed, needs_opt_in, min_group_size from regions
      where code = $1 or code = '*'
      order by (code = '*')`,
    [code ?? DEFAULT_REGION],
  );
  return rows[0] ? toRegion(rows[0]) : FALLBACK;
}

export async function listRegions(): Promise<Region[]> {
  const rows = await query<Row>("select code, name, sale_allowed, needs_opt_in, min_group_size from regions order by code");
  return rows.map(toRegion);
}

// Whether a sale of person-level answers is possible at all in this region. Says nothing about
// the person: use saleAllowed() for that.
export async function saleOpenIn(code: string | null | undefined): Promise<boolean> {
  if (code && NEVER_SELL_COUNTRIES.includes(code.toUpperCase())) return false;
  return (await regionFor(code)).saleAllowed;
}

// The smallest group an aggregate breakdown may show. MIN_GROUP_SIZE in the environment
// overrides it (for development and tests with a handful of accounts); otherwise it is the
// region's own figure, 50 by default. With no region, the strictest of all regions is used,
// since an aggregate mixes people from everywhere.
export async function minGroupSize(code?: string | null): Promise<number> {
  const env = Number(process.env.MIN_GROUP_SIZE);
  if (process.env.MIN_GROUP_SIZE && Number.isInteger(env) && env > 0) return env;
  if (code !== undefined) return (await regionFor(code)).minGroupSize;
  const [row] = await query<{ n: number | null }>("select max(min_group_size)::int as n from regions");
  return row?.n ?? FALLBACK.minGroupSize;
}

// ---------- Who may be included in a sale ----------

// SQL for the ids of accounts whose answers may be included in a sale, as of now. All of:
//   * the account is a real person's (origin 'real'): test and seed accounts never are;
//   * the account exists and isn't a deleted stand-in;
//   * their latest 'answering' record is an agreement (answers given without it never count);
//   * their latest 'sale' record is an opt-in, and was not made with Global Privacy Control on;
//   * their region (or '*' when unknown or without a row) allows sale;
//   * they have never been seen in a never-sell country (China, Hong Kong, Macau): not as
//     their current region, and not on any consent record they ever made. Moving or
//     travelling later doesn't make their answers sellable.
// Every export query must start from this, so no export can forget a condition.
// The never-sell countries as a SQL array literal. The codes come from lib/sanctions/places.ts,
// two capital letters each, so they are safe to write into the query.
const NEVER_SELL_SQL = `array[${NEVER_SELL_COUNTRIES.map((c) => {
  if (!/^[A-Z]{2}$/.test(c)) throw new Error(`bad never-sell code: ${c}`);
  return `'${c}'`;
}).join(",")}]::text[]`;

export const SALE_ELIGIBLE_ACCOUNTS = `
  select a.id
    from accounts a
    join lateral (select granted, gpc from consent_records
                   where account_id = a.id and choice = 'sale'
                   order by created_at desc, id desc limit 1) s on s.granted and not s.gpc
    join lateral (select granted from consent_records
                   where account_id = a.id and choice = 'answering'
                   order by created_at desc, id desc limit 1) ans on ans.granted
    join lateral (select sale_allowed from regions
                   where code = a.region or code = '*'
                   order by (code = '*') limit 1) r on r.sale_allowed
   where a.deleted_at is null
     and a.origin = 'real'
     and coalesce(a.region, '*') <> all(${NEVER_SELL_SQL})
     and not exists (select 1 from consent_records nc
                      where nc.account_id = a.id and nc.region = any(${NEVER_SELL_SQL}))`;

// True only when the account's region allows sale AND their latest sale choice is an opt-in AND
// Global Privacy Control wasn't on when it was recorded (a GPC signal later records an opt-out,
// see lib/consent). Nothing is sold yet; this is the gate every future export goes through.
export async function saleAllowed(account: { id: number } | number): Promise<boolean> {
  const id = typeof account === "number" ? account : account.id;
  const rows = await query<{ id: number }>(`select id from (${SALE_ELIGIBLE_ACCOUNTS}) e where id = $1`, [id]);
  return rows.length === 1;
}
