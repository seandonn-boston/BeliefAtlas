import { query, transaction } from "./db";

// Optional things a person can tell us about themselves, each of which can be cleared at any
// time. Nothing here is required for anything.
//
// Children: a parent (every account is 18+) may describe their own children only in
// non-identifying terms, son, daughter or child, and an age range. There is no place for a
// child's name, birth date or account, in this code or in the table (account_children has only
// relation and age_range), and anything else offered is refused rather than dropped silently.

export const AGE_RANGES = ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"] as const;
export const CHILD_RELATIONS = ["son", "daughter", "child"] as const;
export const CHILD_AGE_RANGES = ["0-2", "3-5", "6-9", "10-12", "13-15", "16-17", "18+"] as const;
export const MAX_CHILDREN = 20;

export type AgeRange = (typeof AGE_RANGES)[number];
export type ChildRelation = (typeof CHILD_RELATIONS)[number];
export type ChildAgeRange = (typeof CHILD_AGE_RANGES)[number];

export type Demographics = { ageRange: AgeRange | null; country: string | null; isParent: boolean | null; updatedAt: Date | null };
export type Child = { id: number; relation: ChildRelation; ageRange: ChildAgeRange; createdAt: Date };

export const DEMOGRAPHIC_FIELDS = ["ageRange", "country", "isParent"] as const;
export type DemographicField = (typeof DEMOGRAPHIC_FIELDS)[number];

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && list.includes(v as T);

// An ISO 3166-1 alpha-2 country code, upper-case, or null.
export function cleanCountry(raw: unknown): string | null {
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

export async function getDemographics(accountId: number): Promise<Demographics> {
  const [row] = await query<{ age_range: AgeRange | null; country: string | null; is_parent: boolean | null; updated_at: Date }>(
    "select age_range, country, is_parent, updated_at from account_demographics where account_id = $1",
    [accountId],
  );
  return row
    ? { ageRange: row.age_range, country: row.country, isParent: row.is_parent, updatedAt: row.updated_at }
    : { ageRange: null, country: null, isParent: null, updatedAt: null };
}

export type DemographicsInput = Partial<{ ageRange: string | null; country: string | null; isParent: boolean | null }>;
export type SaveResult = { ok: true } | { ok: false; error: "age_range" | "country" | "unknown_field" | "relation" | "child_age" | "not_parent" | "too_many" };

// Set any of the fields; a field given as null (or "") is cleared, a field left out is kept.
export async function setDemographics(accountId: number, input: DemographicsInput): Promise<SaveResult> {
  for (const key of Object.keys(input)) {
    if (!(DEMOGRAPHIC_FIELDS as readonly string[]).includes(key)) return { ok: false, error: "unknown_field" };
  }
  const blank = (v: unknown) => v === null || v === "" || v === undefined;
  if ("ageRange" in input && !blank(input.ageRange) && !isOneOf(AGE_RANGES, input.ageRange)) return { ok: false, error: "age_range" };
  if ("country" in input && !blank(input.country) && !cleanCountry(input.country)) return { ok: false, error: "country" };

  const current = await getDemographics(accountId);
  const next = {
    ageRange: "ageRange" in input ? (blank(input.ageRange) ? null : (input.ageRange as AgeRange)) : current.ageRange,
    country: "country" in input ? (blank(input.country) ? null : cleanCountry(input.country)) : current.country,
    isParent: "isParent" in input ? (input.isParent ?? null) : current.isParent,
  };
  await transaction(async (client) => {
    if (next.ageRange === null && next.country === null && next.isParent === null) {
      await client.query("delete from account_demographics where account_id = $1", [accountId]);
    } else {
      await client.query(
        `insert into account_demographics (account_id, age_range, country, is_parent, updated_at)
         values ($1, $2, $3, $4, now())
         on conflict (account_id) do update
           set age_range = excluded.age_range, country = excluded.country, is_parent = excluded.is_parent, updated_at = now()`,
        [accountId, next.ageRange, next.country, next.isParent],
      );
    }
    // No longer saying they're a parent clears what they said about children.
    if (next.isParent !== true) await client.query("delete from account_children where account_id = $1", [accountId]);
  });
  return { ok: true };
}

export async function clearDemographic(accountId: number, field: DemographicField): Promise<SaveResult> {
  if (!(DEMOGRAPHIC_FIELDS as readonly string[]).includes(field)) return { ok: false, error: "unknown_field" };
  return setDemographics(accountId, { [field]: null });
}

// Clear everything: all three fields and every child.
export async function clearAllDemographics(accountId: number): Promise<void> {
  await transaction(async (client) => {
    await client.query("delete from account_children where account_id = $1", [accountId]);
    await client.query("delete from account_demographics where account_id = $1", [accountId]);
  });
}

export async function listChildren(accountId: number): Promise<Child[]> {
  const rows = await query<{ id: string; relation: ChildRelation; age_range: ChildAgeRange; created_at: Date }>(
    "select id, relation, age_range, created_at from account_children where account_id = $1 order by created_at, id",
    [accountId],
  );
  return rows.map((r) => ({ id: Number(r.id), relation: r.relation, ageRange: r.age_range, createdAt: r.created_at }));
}

// Only relation and ageRange are accepted. Anything else (a name, a birth date, an account or
// any other key) refuses the whole child, so a form or an API can't slip one in.
export async function addChild(accountId: number, input: Record<string, unknown>): Promise<SaveResult> {
  for (const key of Object.keys(input)) {
    if (key !== "relation" && key !== "ageRange") return { ok: false, error: "unknown_field" };
  }
  if (!isOneOf(CHILD_RELATIONS, input.relation)) return { ok: false, error: "relation" };
  if (!isOneOf(CHILD_AGE_RANGES, input.ageRange)) return { ok: false, error: "child_age" };
  const demographics = await getDemographics(accountId);
  if (demographics.isParent !== true) return { ok: false, error: "not_parent" };
  const [{ n }] = await query<{ n: number }>("select count(*)::int as n from account_children where account_id = $1", [accountId]);
  if (n >= MAX_CHILDREN) return { ok: false, error: "too_many" };
  await query("insert into account_children (account_id, relation, age_range) values ($1, $2, $3)", [
    accountId, input.relation, input.ageRange,
  ]);
  return { ok: true };
}

export async function removeChild(accountId: number, childId: number): Promise<void> {
  await query("delete from account_children where account_id = $1 and id = $2", [accountId, childId]);
}
