// Org accounts, server keys and plans for the headless front door (lib/headless/orgs.ts,
// credentials.ts, plans.ts, org-billing.ts). Built complete and switched off: these tests switch
// them on in-process only. Test data only: every org and account is 'test' and removed at the end.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { Account } from "../lib/auth";
import { pool, query } from "../lib/db";
import { keysEnabled, orgAccountsEnabled, orgBillingEnabled } from "../lib/headless/config";
import { callerFor, issueCredential } from "../lib/headless/credentials";
import { orgBillingMode } from "../lib/headless/org-billing";
import {
  addMember, createOrgForAccount, createOrgPlacement, getPlacementOrg, issueOrgKey, MAX_ORGS_PER_ACCOUNT, myOrgs, orgForMember,
  revokeOrgKey, rotateOrgKey, setMember, setPlacementOn, setPlanByAdmin, updateOrgPlacement,
} from "../lib/headless/orgs";
import { deleteTestOrgs, getPlacement } from "../lib/headless/placements";
import { effectivePlan, PLANS } from "../lib/headless/plans";
import { GET as resultsGET } from "../app/api/headless/v1/placements/[id]/results/route";
import { POST as votesPOST } from "../app/api/headless/v1/votes/route";

const tag = `ho${Date.now().toString(36)}`;
const ENV_KEYS = [
  "HEADLESS_ENABLED", "HEADLESS_RELAY_ENABLED", "HEADLESS_ORG_ACCOUNTS_ENABLED", "HEADLESS_KEYS_ENABLED",
  "HEADLESS_ORG_BILLING_ENABLED", "HEADLESS_TEST_ORG_KEYS", "PHONE_PEPPER",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let n = 0;
async function makeAccount(role: Account["role"] = "user"): Promise<Account> {
  const name = `${tag}_${n++}`;
  const [row] = await query<{ id: number }>(
    `insert into accounts (username, phone_hash, password_hash, consented_at, origin) values ($1, $1, 'x', now(), 'test') returning id`,
    [name],
  );
  return { id: row.id, username: name, tier: "free", verified: false, role };
}
async function makeQuestion(): Promise<number> {
  const text = `Org ${tag} claim ${n++} is true`;
  const [row] = await query<{ id: number }>("insert into questions (text, normalized, status) values ($1, lower($1), 'active') returning id", [text]);
  return row.id;
}
const approve = (orgId: number) =>
  query("update screened_parties set status = 'approved', status_reason = 'Test org, approved for tests.' where id = (select screened_party_id from organizations where id = $1 and origin = 'test')", [orgId]);
async function start(owner: Account, suffix: string) {
  const r = await createOrgForAccount(owner, { name: `Org ${suffix}`, slug: `${tag}-${suffix}`, country: "US" }, "test");
  assert.ok(r.ok, JSON.stringify(r));
  return (await orgForMember(`${tag}-${suffix}`, owner.id))!;
}
const placementInput = (q: number) => ({ label: "Checkout", kind: "pos", origins: "", questions: String(q), notChildDirected: true });

let owner: Account;
let q: number;

before(async () => {
  process.env.PHONE_PEPPER ??= "test-pepper-for-org-keys-only";
  owner = await makeAccount();
  q = await makeQuestion();
});
beforeEach(() => {
  process.env.HEADLESS_ENABLED = "true";
  process.env.HEADLESS_RELAY_ENABLED = "true";
  process.env.HEADLESS_ORG_ACCOUNTS_ENABLED = "true";
  process.env.HEADLESS_KEYS_ENABLED = "true";
  delete process.env.HEADLESS_ORG_BILLING_ENABLED;
  delete process.env.HEADLESS_TEST_ORG_KEYS;
});
after(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await deleteTestOrgs(`${tag}-%`);
  await query("delete from questions where normalized like $1", [`org ${tag} %`]);
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await pool.end();
});

test("every switch is off by default, and each needs the one before it", () => {
  assert.equal(orgAccountsEnabled({}), false);
  assert.equal(keysEnabled({ HEADLESS_KEYS_ENABLED: "true" }), false);
  assert.equal(keysEnabled({ HEADLESS_ENABLED: "true", HEADLESS_KEYS_ENABLED: "true" }), false);
  assert.equal(keysEnabled({ HEADLESS_ENABLED: "true", HEADLESS_ORG_ACCOUNTS_ENABLED: "true", HEADLESS_KEYS_ENABLED: "true" }), true);
  assert.equal(orgBillingEnabled({ HEADLESS_ENABLED: "true", HEADLESS_ORG_BILLING_ENABLED: "true" }), false);
  assert.equal(orgBillingMode({}), "off");
  // Switched on outside production but without Stripe prices: the local development mode.
  assert.equal(orgBillingMode({ HEADLESS_ENABLED: "true", HEADLESS_ORG_ACCOUNTS_ENABLED: "true", HEADLESS_ORG_BILLING_ENABLED: "true" }), "dev");
  assert.equal(orgBillingMode({ HEADLESS_ENABLED: "true", HEADLESS_ORG_ACCOUNTS_ENABLED: "true", HEADLESS_ORG_BILLING_ENABLED: "true", NODE_ENV: "production" }), "off");
});

test("starting an org: its maker is admin, screening is pending, and nothing serves until approved", async () => {
  const org = await start(owner, "a");
  assert.equal(org.role, "admin");
  assert.equal(org.screening !== "approved", true);
  assert.equal(org.serving, false);
  assert.deepEqual((await myOrgs(owner.id)).map((o) => o.slug), [`${tag}-a`]);
  await approve(org.id);
  assert.equal((await getPlacementOrg(org.id))!.serving, true);
});

test("an org can't be started from a refused country, with a taken name, or past the per-account cap", async () => {
  const maker = await makeAccount();
  for (const country of ["RU", "BY", "CN", "IR", "VE"]) {
    assert.deepEqual(await createOrgForAccount(maker, { name: "X", slug: `${tag}-c${country.toLowerCase()}`, country }, "test"), { ok: false, error: "country" });
  }
  assert.deepEqual(await createOrgForAccount(maker, { name: "X", slug: `${tag}-a`, country: "US" }, "test"), { ok: false, error: "slug_taken" });
  assert.deepEqual(await createOrgForAccount(maker, { name: "X", slug: "No Spaces!", country: "US" }, "test"), { ok: false, error: "slug" });
  for (let i = 0; i < MAX_ORGS_PER_ACCOUNT; i++) await start(maker, `cap${i}`);
  assert.deepEqual(await createOrgForAccount(maker, { name: "X", slug: `${tag}-capx`, country: "US" }, "test"), { ok: false, error: "too_many_orgs" });
});

test("people: admins add and change them, within the plan, and the last admin can't leave", async () => {
  const boss = await makeAccount();
  const org = await start(boss, "people");
  const a = await makeAccount();
  const b = await makeAccount();
  assert.deepEqual(await addMember(org, a.username, "member"), { ok: true });
  assert.deepEqual(await addMember(org, a.username, "member"), { ok: false, error: "already_member" });
  assert.deepEqual(await addMember(org, `${tag}_nobody`, "member"), { ok: false, error: "no_user" });
  assert.deepEqual(await addMember(org, b.username, "member"), { ok: true });
  // Free plan: three people.
  assert.deepEqual(await addMember(org, (await makeAccount()).username, "member"), { ok: false, error: "plan_members" });
  const asMember = (await orgForMember(org.slug, a.id))!;
  assert.deepEqual(await addMember(asMember, "x", "member"), { ok: false, error: "not_admin" });
  assert.deepEqual(await setMember(org, boss.id, "remove"), { ok: false, error: "last_admin" });
  assert.deepEqual(await setMember(org, a.id, "admin"), { ok: true });
  assert.deepEqual(await setMember(org, boss.id, "remove"), { ok: true });
  assert.equal(await orgForMember(org.slug, boss.id), null);
});

test("placements: the child attestation is required, questions must exist, and the plan caps them", async () => {
  const boss = await makeAccount();
  const org = await start(boss, "pl");
  assert.deepEqual(await createOrgPlacement(org, { ...placementInput(q), notChildDirected: false }), { ok: false, error: "attest" });
  assert.deepEqual(await createOrgPlacement(org, { ...placementInput(q), questions: "999999999" }), { ok: false, error: "questions" });
  assert.deepEqual(await createOrgPlacement(org, { ...placementInput(q), origins: "http://insecure.example" }), { ok: false, error: "origins" });
  const ids: string[] = [];
  for (let i = 0; i < PLANS.free.placements; i++) {
    const r = await createOrgPlacement(org, { ...placementInput(q), questions: `https://beliefatlas.example/q/${q}` });
    assert.ok(r.ok);
    ids.push(r.id);
  }
  assert.deepEqual(await createOrgPlacement(org, placementInput(q)), { ok: false, error: "plan_placements" });
  // Switching one off frees a slot; switching it back on needs one.
  assert.deepEqual(await setPlacementOn(org, ids[0], false), { ok: true });
  assert.ok((await createOrgPlacement(org, placementInput(q))).ok);
  assert.deepEqual(await setPlacementOn(org, ids[0], true), { ok: false, error: "plan_placements" });
  assert.deepEqual(await updateOrgPlacement(org, ids[1], { ...placementInput(q), label: "Till 2" }), { ok: true });
  assert.equal((await getPlacement(ids[1]))!.label, "Till 2");
  // Not serving until the org's screening is approved.
  assert.equal((await getPlacement(ids[1]))!.serving, false);
  await approve(org.id);
  assert.equal((await getPlacement(ids[1]))!.serving, true);
});

test("plans: a paid plan counts only while paying, and only a BeliefAtlas admin sets one by hand", async () => {
  assert.equal(effectivePlan("pro", "active").id, "pro");
  assert.equal(effectivePlan("pro", "past_due").id, "pro");
  assert.equal(effectivePlan("pro", "canceled").id, "free");
  assert.equal(effectivePlan("pro", null).id, "free");
  assert.equal(effectivePlan("nonsense", "active").id, "free");
  const org = await start(await makeAccount(), "plan");
  assert.deepEqual(await setPlanByAdmin(owner, org.id, "pro"), { ok: false, error: "not_admin" });
  assert.deepEqual(await setPlanByAdmin(await makeAccount("admin"), org.id, "pro"), { ok: true });
  assert.equal((await getPlacementOrg(org.id))!.effective.id, "pro");
});

test("keys: admins only, approved orgs only, within the plan, and relay only on a plan with it", async () => {
  const boss = await makeAccount();
  let org = await start(boss, "keys");
  assert.deepEqual(await issueOrgKey(org, boss, { label: "Till", scopes: ["results"] }), { ok: false, error: "not_serving" });
  await approve(org.id);
  org = (await orgForMember(org.slug, boss.id))!;
  assert.deepEqual(await issueOrgKey(org, boss, { label: "Till", scopes: ["relay"] }), { ok: false, error: "plan_relay" });
  assert.deepEqual(await issueOrgKey(org, boss, { label: "Till", scopes: ["admin"] }), { ok: false, error: "label" });
  const first = await issueOrgKey(org, boss, { label: "Reports", scopes: ["results"] });
  assert.ok(first.ok);
  assert.match(first.key.key, /^cm_test_[a-z0-9]{10}_[A-Za-z0-9_-]{43}$/);
  // Free plan: one key.
  assert.deepEqual(await issueOrgKey(org, boss, { label: "Two", scopes: ["results"] }), { ok: false, error: "plan_keys" });
  // Only a hash is stored.
  const [row] = await query<{ secret_hash: string }>("select secret_hash from org_credentials where id = $1", [first.key.id]);
  assert.ok(!first.key.key.includes(row.secret_hash));
  assert.equal(row.secret_hash.length, 64);
  process.env.HEADLESS_KEYS_ENABLED = "false";
  assert.deepEqual(await issueOrgKey(org, boss, { label: "Off", scopes: ["results"] }), { ok: false, error: "not_found" });
  await assert.rejects(issueCredential({ orgId: org.id, label: "x", scopes: ["results"], createdBy: null }));
});

test("a key works for its scope only, never across environments, and stops when revoked or the org stops serving", async () => {
  const boss = await makeAccount();
  const org = await start(boss, "auth");
  await approve(org.id);
  const admin = (await orgForMember(org.slug, boss.id))!;
  const r = await issueOrgKey(admin, boss, { label: "Reports", scopes: ["results"] });
  assert.ok(r.ok);
  const bearer = `Bearer ${r.key.key}`;
  assert.equal((await callerFor(bearer, "results"))?.orgSlug, org.slug);
  assert.equal(await callerFor(bearer, "relay"), null);
  assert.equal(await callerFor(`Bearer ${r.key.key.slice(0, -1)}x`, "results"), null);
  assert.equal(await callerFor(bearer, "results", { ...process.env, NODE_ENV: "production" }), null);
  assert.equal(await callerFor(bearer, "results", { ...process.env, HEADLESS_KEYS_ENABLED: "false" }), null);
  await query("update organizations set status = 'suspended' where id = $1", [org.id]);
  assert.equal(await callerFor(bearer, "results"), null);
  await query("update organizations set status = 'active' where id = $1", [org.id]);
  assert.deepEqual(await revokeOrgKey(admin, boss, r.key.id), { ok: true });
  assert.equal(await callerFor(bearer, "results"), null);
});

test("rotating gives a new key and leaves the old one working for a day", async () => {
  const boss = await makeAccount();
  const org = await start(boss, "rot");
  await approve(org.id);
  const admin = (await orgForMember(org.slug, boss.id))!;
  const old = await issueOrgKey(admin, boss, { label: "Reports", scopes: ["results"] });
  assert.ok(old.ok);
  const fresh = await rotateOrgKey(admin, boss, old.key.id);
  assert.ok(fresh.ok);
  assert.notEqual(fresh.key.key, old.key.key);
  assert.ok(await callerFor(`Bearer ${old.key.key}`, "results"));
  assert.ok(await callerFor(`Bearer ${fresh.key.key}`, "results"));
  await query("update org_credentials set expires_at = now() - interval '1 second' where id = $1", [old.key.id]);
  assert.equal(await callerFor(`Bearer ${old.key.key}`, "results"), null);
});

test("the relay takes a real key on a plan that includes it, and the results route takes a results key", async () => {
  const boss = await makeAccount();
  const org = await start(boss, "relay");
  await approve(org.id);
  const admin = (await orgForMember(org.slug, boss.id))!;
  const placement = await createOrgPlacement(admin, placementInput(q));
  assert.ok(placement.ok);
  const reports = await issueOrgKey(admin, boss, { label: "Reports", scopes: ["results"] });
  assert.ok(reports.ok);

  const send = (key: string, headers: Record<string, string> = {}) => votesPOST(new Request("http://localhost:3000/api/headless/v1/votes", {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ placementId: placement.id, userId: "cust-1", questionId: q, value: "true", idempotencyKey: "t1" }),
  }));
  assert.equal((await send(reports.key.key)).status, 401); // results-only key

  await setPlanByAdmin(await makeAccount("admin"), org.id, "pro");
  const pro = (await orgForMember(org.slug, boss.id))!;
  const till = await issueOrgKey(pro, boss, { label: "Till", scopes: ["relay"] });
  assert.ok(till.ok);
  const res = await send(till.key.key);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).outcome, "needs_link"); // unlinked user: nothing counted
  assert.equal((await send(till.key.key, { origin: "https://shop.example" })).status, 403);
  // The plan lapses: the key stays, but the relay is refused.
  await query("update organizations set plan_status = 'canceled' where id = $1", [org.id]);
  assert.equal((await send(till.key.key)).status, 403);

  const results = (key: string, headers: Record<string, string> = {}) => resultsGET(
    new Request(`http://localhost:3000/api/headless/v1/placements/${placement.id}/results`, { headers: { authorization: `Bearer ${key}`, ...headers } }),
    { params: Promise.resolve({ id: placement.id }) },
  );
  const ok = await results(reports.key.key);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.placement.id, placement.id);
  assert.ok(typeof body.notice === "string" && body.notice.length > 0);
  assert.equal((await results(reports.key.key, { origin: "https://shop.example" })).status, 403);
  assert.equal((await results(till.key.key)).status, 401); // relay-only key
  // Another org's key can't read this placement.
  const otherBoss = await makeAccount();
  const other = await start(otherBoss, "relay2");
  await approve(other.id);
  const otherKey = await issueOrgKey((await orgForMember(other.slug, otherBoss.id))!, otherBoss, { label: "R", scopes: ["results"] });
  assert.ok(otherKey.ok);
  assert.equal((await results(otherKey.key.key)).status, 404);
});
