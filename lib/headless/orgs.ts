import type { Account } from "../auth";
import { query, transaction } from "../db";
import type { Origin } from "../provenance";
import { noBuyersFrom } from "../sanctions/places";
import { addParty } from "../sanctions/screening";
import { keysEnabled } from "./config";
import { activeCredentialCount, isScope, issueCredential, revokeCredential, rotateCredential, type IssuedKey, type Scope } from "./credentials";
import { effectivePlan, isPlanId, PLANS, type Plan, type PlanId } from "./plans";
import { cleanOrigin, isPlacementId, newPlacementId, orgServes, PLACEMENT_KINDS, type PlacementKind } from "./placements";

// Org accounts (belief-map/headless-front-door.md section 6): what /org does, kept here so the
// rules are tested without the pages. People who run an org are ordinary BeliefAtlas accounts; an
// org never has a login of its own. Every change checks the person's role in that org.
//
// An org made in the app starts 'active' with its sanctions screening pending: nothing it makes
// serves until a person approves the screening (on /mod/compliance), which is the one gate.

export type OrgRole = "admin" | "member";
export type OrgError =
  | "slug" | "slug_taken" | "name" | "country" | "too_many_orgs" | "not_admin" | "no_user" | "already_member"
  | "plan_members" | "last_admin" | "plan_placements" | "kind" | "label" | "attest" | "questions" | "origins"
  | "not_found" | "plan_keys" | "plan_relay" | "not_serving" | "plan";

export type Org = {
  id: number; slug: string; name: string; status: string; origin: Origin; country: string | null;
  plan: PlanId; planStatus: string | null; screening: string | null; serving: boolean; effective: Plan;
};

type OrgRow = {
  id: string; slug: string; name: string; status: string; origin: Origin; country: string | null;
  plan: string; plan_status: string | null; screening: string | null;
};
const orgSelect = (extra = "") => `select o.id, o.slug, o.name, o.status, o.origin, o.country, o.plan, o.plan_status, sp.status as screening${extra}
                      from organizations o left join screened_parties sp on sp.id = o.screened_party_id`;

function toOrg(r: OrgRow, env: Record<string, string | undefined>): Org {
  const plan = isPlanId(r.plan) ? r.plan : "free";
  return {
    id: Number(r.id), slug: r.slug, name: r.name, status: r.status, origin: r.origin, country: r.country,
    plan, planStatus: r.plan_status, screening: r.screening, serving: orgServes(r, env),
    effective: effectivePlan(plan, r.plan_status),
  };
}

export async function getPlacementOrg(orgId: number, env: Record<string, string | undefined> = process.env): Promise<Org | null> {
  const [r] = await query<OrgRow>(`${orgSelect()} where o.id = $1`, [orgId]);
  return r ? toOrg(r, env) : null;
}

export async function myOrgs(accountId: number, env: Record<string, string | undefined> = process.env): Promise<(Org & { role: OrgRole })[]> {
  const rows = await query<OrgRow & { role: OrgRole }>(
    `${orgSelect(", m.role")} join org_members m on m.org_id = o.id where m.account_id = $1 order by o.name`,
    [accountId],
  );
  return rows.map((r) => ({ ...toOrg(r, env), role: r.role }));
}

export async function orgForMember(slug: string, accountId: number, env: Record<string, string | undefined> = process.env): Promise<(Org & { role: OrgRole }) | null> {
  const [r] = await query<OrgRow & { role: OrgRole }>(
    `${orgSelect(", m.role")} join org_members m on m.org_id = o.id where o.slug = $1 and m.account_id = $2`,
    [slug, accountId],
  );
  return r ? { ...toOrg(r, env), role: r.role } : null;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const MAX_ORGS_PER_ACCOUNT = 5;

export async function createOrgForAccount(
  account: Account, input: { name: string; slug: string; country: string }, origin: Origin = "real",
): Promise<{ ok: true; slug: string } | { ok: false; error: OrgError }> {
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  const country = input.country.trim().toUpperCase();
  if (!name || name.length > 120) return { ok: false, error: "name" };
  if (!SLUG.test(slug)) return { ok: false, error: "slug" };
  if (!/^[A-Z]{2}$/.test(country)) return { ok: false, error: "country" };
  if (noBuyersFrom(country)) return { ok: false, error: "country" };
  const [{ n }] = await query<{ n: number }>("select count(*)::int as n from organizations where created_by = $1", [account.id]);
  if (n >= MAX_ORGS_PER_ACCOUNT) return { ok: false, error: "too_many_orgs" };
  if ((await query("select 1 from organizations where slug = $1", [slug])).length) return { ok: false, error: "slug_taken" };
  const party = await addParty({ kind: "org", name, country });
  try {
    await transaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into organizations (slug, name, created_by, origin, status, country, screened_party_id)
         values ($1, $2, $3, $4, 'active', $5, $6) returning id`,
        [slug, name, account.id, origin, country, party.id],
      );
      await client.query("insert into org_members (org_id, account_id, role) values ($1, $2, 'admin')", [rows[0].id, account.id]);
    });
  } catch (err) {
    await query("delete from screened_parties where id = $1", [party.id]);
    if ((err as { code?: string }).code === "23505") return { ok: false, error: "slug_taken" };
    throw err;
  }
  return { ok: true, slug };
}

// ---------- Members ----------

export type Member = { accountId: number; username: string; role: OrgRole; addedAt: Date };

export async function listMembers(orgId: number): Promise<Member[]> {
  return query<Member>(
    `select a.id as "accountId", a.username, m.role, m.added_at as "addedAt"
       from org_members m join accounts a on a.id = m.account_id
      where m.org_id = $1 and a.deleted_at is null order by m.role, a.username`,
    [orgId],
  );
}

type Done = { ok: true } | { ok: false; error: OrgError };
const fail = (error: OrgError): Done => ({ ok: false, error });

// Adds a BeliefAtlas account by username. They need an account already (18+, phone-checked).
export async function addMember(org: Org & { role: OrgRole }, username: string, role: OrgRole): Promise<Done> {
  if (org.role !== "admin") return fail("not_admin");
  const [person] = await query<{ id: number }>("select id from accounts where lower(username) = lower($1) and deleted_at is null", [username.trim()]);
  if (!person) return fail("no_user");
  const [{ n }] = await query<{ n: number }>("select count(*)::int as n from org_members where org_id = $1", [org.id]);
  if (n >= org.effective.members) return fail("plan_members");
  const added = await query(
    "insert into org_members (org_id, account_id, role) values ($1, $2, $3) on conflict do nothing returning org_id",
    [org.id, person.id, role === "admin" ? "admin" : "member"],
  );
  return added.length ? { ok: true } : fail("already_member");
}

// Removes someone (or changes their role). An org always keeps at least one admin.
export async function setMember(org: Org & { role: OrgRole }, accountId: number, change: OrgRole | "remove"): Promise<Done> {
  if (org.role !== "admin") return fail("not_admin");
  return transaction(async (client) => {
    const { rows: admins } = await client.query<{ account_id: number }>(
      "select account_id from org_members where org_id = $1 and role = 'admin' for update",
      [org.id],
    );
    const isAdmin = admins.some((a) => a.account_id === accountId);
    if (isAdmin && change !== "admin" && admins.length === 1) return fail("last_admin");
    const res = change === "remove"
      ? await client.query("delete from org_members where org_id = $1 and account_id = $2", [org.id, accountId])
      : await client.query("update org_members set role = $3 where org_id = $1 and account_id = $2", [org.id, accountId, change]);
    return res.rowCount ? { ok: true } : fail("not_found");
  });
}

// ---------- Placements ----------

export type PlacementRow = {
  id: string; label: string; kind: PlacementKind; allowed_origins: string[]; question_ids: number[];
  not_child_directed: boolean; disabled_at: Date | null; created_at: Date;
};

export async function listPlacements(orgId: number): Promise<PlacementRow[]> {
  return query<PlacementRow>(
    `select id, label, kind, allowed_origins, question_ids, not_child_directed, disabled_at, created_at
       from org_placements where org_id = $1 order by disabled_at is not null, created_at`,
    [orgId],
  );
}

export type PlacementInput = { label: string; kind: string; origins: string; questions: string; notChildDirected: boolean };

// Parses the form's lists: origins one per line or comma, question ids or links to them.
async function cleanPlacementInput(input: PlacementInput): Promise<
  { ok: true; label: string; kind: PlacementKind; origins: string[]; questionIds: number[] } | { ok: false; error: OrgError }
> {
  const label = input.label.trim();
  if (!label || label.length > 120) return { ok: false, error: "label" };
  if (!(PLACEMENT_KINDS as readonly string[]).includes(input.kind)) return { ok: false, error: "kind" };
  if (!input.notChildDirected) return { ok: false, error: "attest" };
  const rawOrigins = input.origins.split(/[\s,]+/).filter(Boolean);
  const origins = rawOrigins.map(cleanOrigin);
  if (origins.some((o) => !o) || origins.length > 20) return { ok: false, error: "origins" };
  const ids = input.questions.split(/[\s,]+/).filter(Boolean).map((t) => Number(t.match(/(\d+)\/?$/)?.[1]));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0) || ids.length > 50) return { ok: false, error: "questions" };
  if (ids.length) {
    const found = await query<{ id: number }>("select id from questions where id = any($1::int[]) and status = 'active'", [ids]);
    if (found.length !== new Set(ids).size) return { ok: false, error: "questions" };
  }
  return { ok: true, label, kind: input.kind as PlacementKind, origins: [...new Set(origins as string[])], questionIds: [...new Set(ids)] };
}

export async function createOrgPlacement(org: Org & { role: OrgRole }, input: PlacementInput): Promise<{ ok: true; id: string } | { ok: false; error: OrgError }> {
  if (org.role !== "admin") return { ok: false, error: "not_admin" };
  const clean = await cleanPlacementInput(input);
  if (!clean.ok) return clean;
  const [{ n }] = await query<{ n: number }>("select count(*)::int as n from org_placements where org_id = $1 and disabled_at is null", [org.id]);
  if (n >= org.effective.placements) return { ok: false, error: "plan_placements" };
  const id = newPlacementId();
  await query(
    `insert into org_placements (id, org_id, label, kind, allowed_origins, question_ids, not_child_directed)
     values ($1, $2, $3, $4, $5, $6, true)`,
    [id, org.id, clean.label, clean.kind, clean.origins, clean.questionIds],
  );
  return { ok: true, id };
}

export async function updateOrgPlacement(org: Org & { role: OrgRole }, placementId: string, input: PlacementInput): Promise<Done> {
  if (org.role !== "admin") return fail("not_admin");
  if (!isPlacementId(placementId)) return fail("not_found");
  const clean = await cleanPlacementInput(input);
  if (!clean.ok) return clean;
  const res = await query(
    `update org_placements set label = $3, kind = $4, allowed_origins = $5, question_ids = $6, not_child_directed = true
      where id = $1 and org_id = $2 returning id`,
    [placementId, org.id, clean.label, clean.kind, clean.origins, clean.questionIds],
  );
  return res.length ? { ok: true } : fail("not_found");
}

// Switches a placement off (it stops serving at once) or back on, within the plan's limit.
export async function setPlacementOn(org: Org & { role: OrgRole }, placementId: string, on: boolean): Promise<Done> {
  if (org.role !== "admin") return fail("not_admin");
  if (on) {
    const [{ n }] = await query<{ n: number }>("select count(*)::int as n from org_placements where org_id = $1 and disabled_at is null", [org.id]);
    if (n >= org.effective.placements) return fail("plan_placements");
  }
  const res = await query(
    `update org_placements set disabled_at = ${on ? "null" : "coalesce(disabled_at, now())"} where id = $1 and org_id = $2 returning id`,
    [placementId, org.id],
  );
  return res.length ? { ok: true } : fail("not_found");
}

// ---------- Server keys ----------
// Admins only, within the plan's key limit, and only for an org that is serving (screening
// approved). The full key is returned once, here, and never again: only its hash is kept.

export async function issueOrgKey(
  org: Org & { role: OrgRole }, by: Account, input: { label: string; scopes: string[] }, env: Record<string, string | undefined> = process.env,
): Promise<{ ok: true; key: IssuedKey } | { ok: false; error: OrgError }> {
  if (!keysEnabled(env)) return { ok: false, error: "not_found" };
  if (org.role !== "admin") return { ok: false, error: "not_admin" };
  if (!org.serving) return { ok: false, error: "not_serving" };
  const label = input.label.trim();
  if (!label || label.length > 80) return { ok: false, error: "label" };
  const scopes = [...new Set(input.scopes.filter(isScope))] as Scope[];
  if (!scopes.length) return { ok: false, error: "label" };
  if (scopes.includes("relay") && !org.effective.relay) return { ok: false, error: "plan_relay" };
  if ((await activeCredentialCount(org.id)) >= org.effective.keys) return { ok: false, error: "plan_keys" };
  return { ok: true, key: await issueCredential({ orgId: org.id, label, scopes, createdBy: by.id }, env) };
}

export async function revokeOrgKey(org: Org & { role: OrgRole }, by: Account, credentialId: number): Promise<Done> {
  if (org.role !== "admin") return fail("not_admin");
  return (await revokeCredential(org.id, credentialId, by.id)) ? { ok: true } : fail("not_found");
}

// A new key now; the old one keeps working for a day so the org can swap it without downtime.
export async function rotateOrgKey(
  org: Org & { role: OrgRole }, by: Account, credentialId: number, env: Record<string, string | undefined> = process.env,
): Promise<{ ok: true; key: IssuedKey } | { ok: false; error: OrgError }> {
  if (!keysEnabled(env)) return { ok: false, error: "not_found" };
  if (org.role !== "admin") return { ok: false, error: "not_admin" };
  if (!org.serving) return { ok: false, error: "not_serving" };
  const key = await rotateCredential(org.id, credentialId, by.id, env);
  return key ? { ok: true, key } : { ok: false, error: "not_found" };
}

// ---------- Plans set by BeliefAtlas (while billing is off, or for a deal made by hand) ----------

export async function setPlanByAdmin(by: Account, orgId: number, plan: PlanId): Promise<Done> {
  if (by.role !== "admin") return fail("not_admin");
  if (!isPlanId(plan)) return fail("plan");
  const res = await query(
    `update organizations set plan = $2, plan_status = case when $2 = 'free' then null else 'manual' end, plan_changed_at = now()
      where id = $1 returning id`,
    [orgId, plan],
  );
  return res.length ? { ok: true } : fail("not_found");
}

export { PLANS };
