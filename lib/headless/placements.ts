import { query, transaction } from "../db";
import { isProductionEnv, type Origin } from "../provenance";
import { pct } from "../stats";
import type { Surface } from "../front-door";

// Placements: the spots where an organization shows BeliefAtlas questions (a checkout screen, an
// article footer, an app's settings page). Created and edited in the BeliefAtlas app by the org's
// admins, never through the API. A placement id is public; it authorizes reading public cards
// and nothing else.

export const PLACEMENT_KINDS = ["site", "app", "cms", "pos", "ad", "kiosk"] as const;
export type PlacementKind = (typeof PLACEMENT_KINDS)[number];

export type Placement = {
  id: string;
  orgId: number;
  orgSlug: string;
  orgName: string;
  label: string;
  kind: PlacementKind;
  allowedOrigins: string[];
  questionIds: number[];
  // Whether it may serve at all: org active, placement not switched off, the org has said it is
  // not child-directed, and (in production) a real org.
  serving: boolean;
};

export const isPlacementId = (id: unknown): id is string => typeof id === "string" && /^pl-[a-z0-9]{12}$/.test(id);

// The vote surface a placement's taps are labelled with.
export function surfaceFor(kind: PlacementKind): Surface {
  if (kind === "pos" || kind === "kiosk") return "pos";
  if (kind === "ad") return "ad";
  return "headless";
}

type Row = {
  id: string; org_id: string; slug: string; name: string; label: string; kind: PlacementKind;
  allowed_origins: string[]; question_ids: number[]; not_child_directed: boolean;
  disabled_at: Date | null; status: string; origin: Origin;
};

export async function getPlacement(id: string, env: Record<string, string | undefined> = process.env): Promise<Placement | null> {
  if (!isPlacementId(id)) return null;
  const [row] = await query<Row>(
    `select p.id, p.org_id, o.slug, o.name, p.label, p.kind, p.allowed_origins, p.question_ids,
            p.not_child_directed, p.disabled_at, o.status, o.origin
       from org_placements p join organizations o on o.id = p.org_id
      where p.id = $1`,
    [id],
  );
  if (!row) return null;
  const originOk = row.origin === "real" || (row.origin === "test" && !isProductionEnv(env));
  return {
    id: row.id,
    orgId: Number(row.org_id),
    orgSlug: row.slug,
    orgName: row.name,
    label: row.label,
    kind: row.kind,
    allowedOrigins: row.allowed_origins,
    questionIds: row.question_ids,
    serving: row.status === "active" && !row.disabled_at && row.not_child_directed && originOk,
  };
}

// A web origin, normalized the way browsers send it ("https://shop.example"), or null.
export function cleanOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function originAllowed(placement: Placement, origin: string | null): boolean {
  const o = cleanOrigin(origin);
  return Boolean(o && placement.allowedOrigins.some((a) => cleanOrigin(a) === o));
}

export async function isOrgMember(accountId: number, orgId: number): Promise<boolean> {
  const rows = await query("select 1 from org_members where org_id = $1 and account_id = $2", [orgId, accountId]);
  return rows.length > 0;
}

// What a vote's surface_context says about a placement: the org's slug, the placement and its
// kind. Never a person's details.
export const placementContext = (p: Placement) => ({ org: p.orgSlug, placement: p.id, kind: p.kind });

// ---------- Results for the org (aggregate only) ----------

export type PlacementResult = {
  questionId: number;
  enough: boolean;                // false below the minimum group size: no numbers at all
  total: number | null;
  percentages: { true: number; false: number; unsure: number } | null;
};

// Answers given through this placement: people whose cast or change of an answer came through
// it, counted at their current answer. Seed votes never count (fictional); test votes don't count
// in production. Questions with fewer answers than `min` show nothing, so a small shop's
// handful of customers can't be picked out. Never person-level.
export async function placementResults(
  placement: Placement, min: number, env: Record<string, string | undefined> = process.env,
): Promise<PlacementResult[]> {
  const origins = isProductionEnv(env) ? ["real"] : ["real", "test"];
  const ids = placement.questionIds;
  const rows = await query<{ question_id: number; value: "true" | "false" | "unsure"; n: number }>(
    `select v.question_id, v.value, count(*)::int as n
       from votes v
      where ($2::int[] = '{}' or v.question_id = any($2::int[]))
        and v.origin = any($3::text[])
        and exists (select 1 from vote_events e
                     where e.account_id = v.account_id and e.question_id = v.question_id
                       and e.placement = $1 and e.action in ('cast', 'change'))
      group by v.question_id, v.value`,
    [placement.id, ids, origins],
  );
  const byQ = new Map<number, { true: number; false: number; unsure: number }>();
  for (const r of rows) {
    const t = byQ.get(r.question_id) ?? { true: 0, false: 0, unsure: 0 };
    t[r.value] += r.n;
    byQ.set(r.question_id, t);
  }
  const order = ids.length ? ids : [...byQ.keys()].sort((a, b) => a - b);
  return order.map((questionId) => {
    const t = byQ.get(questionId) ?? { true: 0, false: 0, unsure: 0 };
    const total = t.true + t.false + t.unsure;
    if (total < min) return { questionId, enough: false, total: null, percentages: null };
    return {
      questionId, enough: true, total,
      percentages: { true: pct(t.true, total), false: pct(t.false, total), unsure: pct(t.unsure, total) },
    };
  });
}

// ---------- Making orgs and placements (tests and, later, the org dashboard) ----------

export async function createOrg(input: { slug: string; name: string; createdBy: number; origin?: Origin; status?: "pending" | "active" }): Promise<number> {
  return transaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      "insert into organizations (slug, name, created_by, origin, status) values ($1, $2, $3, $4, $5) returning id",
      [input.slug, input.name, input.createdBy, input.origin ?? "real", input.status ?? "pending"],
    );
    const id = Number(rows[0].id);
    await client.query("insert into org_members (org_id, account_id, role) values ($1, $2, 'admin')", [id, input.createdBy]);
    return id;
  });
}

export function newPlacementId(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `pl-${[...bytes].map((b) => alphabet[b % alphabet.length]).join("")}`;
}

export async function createPlacement(input: {
  orgId: number; label: string; kind: PlacementKind; allowedOrigins?: string[]; questionIds?: number[]; notChildDirected: boolean;
}): Promise<string> {
  const id = newPlacementId();
  const origins = (input.allowedOrigins ?? []).map(cleanOrigin).filter((o): o is string => Boolean(o));
  await query(
    `insert into org_placements (id, org_id, label, kind, allowed_origins, question_ids, not_child_directed)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, input.orgId, input.label, input.kind, origins, input.questionIds ?? [], input.notChildDirected],
  );
  return id;
}
