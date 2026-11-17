// Headless front door tests (lib/headless, app/api/headless/v1): the switch, question cards,
// placements, the hosted-tap labels, the server relay (still the one vote engine), and
// aggregate-only results with small groups hidden and seed votes left out. Test data only: every
// org and account here is marked 'test' and removed at the end. Runs against DATABASE_URL.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { pool, query, transaction } from "../lib/db";
import type { Account } from "../lib/auth";
import { currentText, recordConsent } from "../lib/consent";
import { linkIdentity, vote } from "../lib/vote-engine";
import { questionCard } from "../lib/headless/cards";
import { testOrgKeys } from "../lib/headless/config";
import { placementSurfaceContext, returnOrigin } from "../lib/headless/handoff";
import { UNOFFICIAL_NOTICE } from "../lib/headless/notice";
import { blockedOrgCountry } from "../lib/headless/org-eligibility";
import { createOrg, createPlacement, getPlacement, OrgNotAllowed, placementResults } from "../lib/headless/placements";
import { cleanUserId, orgForCredential, relayVote } from "../lib/headless/relay";
import contract from "../sdks/contract/v1.json";
import { GET as indexGET } from "../app/api/headless/v1/route";
import { GET as questionGET } from "../app/api/headless/v1/questions/[id]/route";
import { GET as splitGET } from "../app/api/headless/v1/questions/[id]/split/route";
import { GET as placementGET } from "../app/api/headless/v1/placements/[id]/route";
import { POST as votesPOST } from "../app/api/headless/v1/votes/route";

const tag = `hl${Date.now().toString(36)}`;
const SHOP = "https://shop.example";
const KEY = `test-key-${tag}-0123456789`;
const ENV_KEYS = ["HEADLESS_ENABLED", "HEADLESS_RELAY_ENABLED", "HEADLESS_TEST_ORG_KEYS", "MIN_GROUP_SIZE"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let n = 0;
async function makeAccount(): Promise<Account> {
  const name = `${tag}_${n++}`;
  const [row] = await query<{ id: number }>(
    `insert into accounts (username, phone_hash, password_hash, consented_at, origin) values ($1, $1, 'x', now(), 'test') returning id`,
    [name],
  );
  return { id: row.id, username: name, tier: "free", verified: false, role: "user" };
}

async function agree(account: Account) {
  const text = await currentText("answering", "en");
  const r = await recordConsent(
    { accountId: account.id, choice: "answering", granted: true, version: text!.version, lang: "en" },
    { gpc: false, region: null, surface: "web", lang: "en" },
  );
  assert.ok(r.ok);
}

let qn = 0;
async function makeQuestion(status: "active" | "archived" = "active"): Promise<number> {
  const text = `Headless ${tag} claim number ${qn++} is true`;
  const [row] = await query<{ id: number }>(
    `insert into questions (text, normalized, status, archived_at) values ($1, lower($1), $2, case when $2 = 'archived' then now() end) returning id`,
    [text, status],
  );
  return row.id;
}

const req = (path: string, init: RequestInit = {}) => new Request(`http://localhost:3000${path}`, init);
const ctx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

let admin: Account;
let orgId: number;
let otherOrgId: number;
let q1: number;
let q2: number;
let qArchived: number;
let site: string;      // serving placement, kind site, allows SHOP
let pos: string;       // serving placement, kind pos
let pending: string;   // placement of an org that isn't active yet
let noAttest: string;  // placement without the not-child-directed attestation
let other: string;     // another org's placement

before(async () => {
  admin = await makeAccount();
  orgId = await createOrg({ slug: `${tag}-shop`, name: "Test Shop", createdBy: admin.id, origin: "test", status: "active", country: "US", sanctionsClearedAt: new Date() });
  otherOrgId = await createOrg({ slug: `${tag}-other`, name: "Other", createdBy: admin.id, origin: "test", status: "active", country: "US", sanctionsClearedAt: new Date() });
  const pendingOrg = await createOrg({ slug: `${tag}-pend`, name: "Pending", createdBy: admin.id, origin: "test", country: "US", sanctionsClearedAt: new Date() });
  q1 = await makeQuestion();
  q2 = await makeQuestion();
  qArchived = await makeQuestion("archived");
  site = await createPlacement({ orgId, label: "Footer", kind: "site", allowedOrigins: [SHOP], questionIds: [q1, q2, qArchived], notChildDirected: true });
  pos = await createPlacement({ orgId, label: "Till 1", kind: "pos", questionIds: [q1], notChildDirected: true });
  pending = await createPlacement({ orgId: pendingOrg, label: "x", kind: "site", questionIds: [q1], notChildDirected: true });
  noAttest = await createPlacement({ orgId, label: "y", kind: "site", questionIds: [q1], notChildDirected: false });
  other = await createPlacement({ orgId: otherOrgId, label: "z", kind: "site", questionIds: [q1], notChildDirected: true });
});

beforeEach(() => {
  process.env.HEADLESS_ENABLED = "true";
  process.env.HEADLESS_RELAY_ENABLED = "true";
  process.env.HEADLESS_TEST_ORG_KEYS = `${tag}-shop:${KEY}`;
  delete process.env.MIN_GROUP_SIZE;
});

after(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await query("delete from organizations where slug like $1", [`${tag}-%`]);
  await query("delete from questions where normalized like $1", [`headless ${tag} %`]);
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await pool.end();
});

// ---------- The switch ----------

test("switched off, every route answers 404", async () => {
  process.env.HEADLESS_ENABLED = "false";
  for (const res of [
    await indexGET(),
    await questionGET(req(`/api/headless/v1/questions/${q1}`), ctx(q1)),
    await splitGET(req(`/api/headless/v1/questions/${q1}/split`), ctx(q1)),
    await placementGET(req(`/api/headless/v1/placements/${site}`), ctx(site)),
    await votesPOST(req("/api/headless/v1/votes", { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: "{}" })),
  ]) assert.equal(res.status, 404);
  assert.equal(await returnOrigin(site, SHOP), null, "the vote page ignores return addresses while off");
  assert.equal(await placementSurfaceContext(site), null);
});

test("the relay has its own switch, off by default", async () => {
  delete process.env.HEADLESS_RELAY_ENABLED;
  const res = await votesPOST(req("/api/headless/v1/votes", { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: "{}" }));
  assert.equal(res.status, 404);
});

// ---------- Cards ----------

test("a card has the four choices, a shown token, and no split", async () => {
  const res = await questionGET(req(`/api/headless/v1/questions/${q1}`), ctx(q1));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const card = await res.json();
  assert.deepEqual(Object.keys(card).sort(), Object.keys(contract.card).sort(), "matches the SDK contract");
  assert.deepEqual(card.choices.map((c: { value: string }) => c.value), ["true", "false", "unsure", "skip"]);
  assert.deepEqual(card.choices.map((c: { counts: boolean }) => c.counts), [true, true, true, false]);
  assert.match(card.shown, new RegExp(`^${q1}\\.\\d+\\.`));
  for (const key of ["split", "percentages", "tally", "total"]) assert.ok(!(key in card), `no ${key} before answering`);
  const url = new URL(card.choices[0].answerUrl);
  assert.equal(url.pathname, `/v/${q1}`);
  assert.equal(url.searchParams.get("pick"), "true");
  assert.equal(url.searchParams.get("via"), "headless");
});

test("labels come in the requested language", async () => {
  const card = await questionCard(q1, { locale: "es-MX" });
  assert.ok(card);
  assert.notEqual(card.choices[2].label, "Don't know");
});

test("a placement labels the answer links, and only an allowed origin gets told", async () => {
  const placement = (await getPlacement(site))!;
  const allowed = (await questionCard(q1, { placement, returnOrigin: `${SHOP}/checkout?x=1` }))!;
  const url = new URL(allowed.choices[1].answerUrl!);
  assert.equal(url.searchParams.get("at"), site);
  assert.equal(url.searchParams.get("ret"), SHOP, "origin only, never a path");
  const stranger = (await questionCard(q1, { placement, returnOrigin: "https://evil.example" }))!;
  assert.equal(new URL(stranger.choices[1].answerUrl!).searchParams.get("ret"), null);
  const till = (await questionCard(q1, { placement: (await getPlacement(pos))! }))!;
  assert.equal(new URL(till.choices[0].answerUrl!).searchParams.get("via"), "pos");
});

test("an archived question is closed: no answer links, no shown token", async () => {
  const card = (await questionCard(qArchived))!;
  assert.equal(card.status, "archived");
  assert.equal(card.shown, null);
  assert.ok(card.choices.every((c) => c.answerUrl === null));
});

test("a merged question answers with the one it was merged into", async () => {
  const dup = await makeQuestion();
  await query("update questions set status = 'removed', duplicate_of = $2 where id = $1", [dup, q2]);
  const card = (await questionCard(dup))!;
  assert.equal(card.id, q2);
  assert.equal(card.mergedFrom, dup);
  assert.equal((await questionGET(req("/api/headless/v1/questions/999999999"), ctx(999999999))).status, 404);
});

test("a placement serves its active questions in order; CORS only for its own origins", async () => {
  const res = await placementGET(req(`/api/headless/v1/placements/${site}`, { headers: { origin: SHOP } }), ctx(site));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), SHOP);
  const body = await res.json();
  assert.deepEqual(body.questions.map((c: { id: number }) => c.id), [q1, q2], "archived left out");
  assert.equal(body.placement.org.slug, `${tag}-shop`);
  const stranger = await placementGET(req(`/api/headless/v1/placements/${site}`, { headers: { origin: "https://evil.example" } }), ctx(site));
  assert.equal(stranger.headers.get("access-control-allow-origin"), null);
});

test("a placement that isn't serving is 404: org pending, or no child-directed attestation", async () => {
  for (const id of [pending, noAttest, "pl-doesnotexist", "nonsense"]) {
    assert.equal((await placementGET(req(`/api/headless/v1/placements/${id}`), ctx(id))).status, 404, id);
  }
  assert.equal((await questionGET(req(`/api/headless/v1/questions/${q1}?placement=${pending}`), ctx(q1))).status, 404);
});

test("orgs in Russia, Belarus, China or a sanctioned place can't be created", async () => {
  for (const country of ["RU", "BY", "CN", "IR", "KP", "CU"]) {
    assert.equal(blockedOrgCountry(country), true, country);
    await assert.rejects(
      createOrg({ slug: `${tag}-x${country.toLowerCase()}`, name: "No", createdBy: admin.id, origin: "test", country }),
      OrgNotAllowed, country,
    );
  }
  assert.equal(blockedOrgCountry(null), true);
  assert.equal(blockedOrgCountry("us"), true);
  assert.equal(blockedOrgCountry("US"), false);
});

test("an org that hasn't cleared sanctions screening never serves, even when active", async () => {
  const unscreened = await createOrg({ slug: `${tag}-unscr`, name: "Unscreened", createdBy: admin.id, origin: "test", status: "active", country: "US" });
  const id = await createPlacement({ orgId: unscreened, label: "x", kind: "site", questionIds: [q1], notChildDirected: true });
  assert.equal((await getPlacement(id))?.serving, false);
  assert.equal((await placementGET(req(`/api/headless/v1/placements/${id}`), ctx(id))).status, 404);
  await query("update organizations set sanctions_cleared_at = now() where id = $1", [unscreened]);
  assert.equal((await getPlacement(id))?.serving, true);
  // A country later found to be blocked switches it off again (a direct edit; the app refuses it).
  await query("update organizations set country = 'BY' where id = $1", [unscreened]);
  assert.equal((await getPlacement(id))?.serving, false);
});

test("every card, split and placement card carries the unofficial notice, in the reader's language", async () => {
  const en = await questionCard(q1);
  assert.equal(en?.notice, UNOFFICIAL_NOTICE.en);
  const es = await questionCard(q1, { locale: "es" });
  assert.ok(es?.notice.startsWith("No oficial"));
  const split = await (await splitGET(req(`/api/headless/v1/questions/${q1}/split?lang=es`), ctx(q1))).json();
  assert.ok(split.notice.startsWith("No oficial"));
  const placement = await (await placementGET(req(`/api/headless/v1/placements/${site}`), ctx(site))).json();
  for (const card of placement.questions) assert.equal(card.notice, UNOFFICIAL_NOTICE.en);
});

test("test orgs never serve in production", async () => {
  const p = await getPlacement(site, { VERCEL_ENV: "production" });
  assert.equal(p?.serving, false);
});

// ---------- Hosted tap ----------

test("a hosted tap through a placement is labelled with it, and its page may be told", async () => {
  const person = await makeAccount();
  await agree(person);
  assert.equal(await returnOrigin(site, `${SHOP}/anything`), SHOP);
  assert.equal(await returnOrigin(site, "https://evil.example"), null);
  assert.equal(await returnOrigin(noAttest, SHOP), null);
  const outcome = await vote({
    account: person, questionId: q1, value: "true", surface: "headless", placement: site,
    surfaceContext: await placementSurfaceContext(site),
  });
  assert.equal(outcome.outcome, "cast");
  const [event] = await query<{ surface: string; placement: string; surface_context: Record<string, string> }>(
    "select surface, placement, surface_context from vote_events where account_id = $1 and question_id = $2 and action = 'cast'",
    [person.id, q1],
  );
  assert.equal(event.surface, "headless");
  assert.equal(event.placement, site);
  assert.deepEqual(event.surface_context, { org: `${tag}-shop`, placement: site, kind: "site" });
});

// ---------- Server relay ----------

const relay = (body: Record<string, unknown>, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }) =>
  votesPOST(req("/api/headless/v1/votes", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

test("the relay needs a credential, and refuses browsers", async () => {
  const body = { placementId: site, userId: "u1", questionId: q1, value: "true", idempotencyKey: "k1" };
  assert.equal((await relay(body, {})).status, 401);
  assert.equal((await relay(body, { authorization: "Bearer wrong-key-0123456789" })).status, 401);
  assert.equal((await relay(body, { authorization: `Bearer ${KEY}`, origin: SHOP })).status, 403);
});

test("test credentials are never read in production", () => {
  const env = { HEADLESS_TEST_ORG_KEYS: `a:${KEY}`, VERCEL_ENV: "production" };
  assert.equal(testOrgKeys(env).size, 0);
  assert.equal(orgForCredential(`Bearer ${KEY}`, env), null);
  assert.equal(orgForCredential(`Bearer ${KEY}`, { HEADLESS_TEST_ORG_KEYS: `a:${KEY}` }), "a");
});

test("user ids are opaque: no emails or phone numbers", () => {
  assert.equal(cleanUserId("cust_123"), "cust_123");
  assert.equal(cleanUserId("someone@example.com"), null);
  assert.equal(cleanUserId("+16175550123"), null);
});

test("an unlinked user gets needs_link and the hosted page; nothing counts", async () => {
  const res = await relay({ placementId: site, userId: `${tag}-nobody`, questionId: q1, value: "false", idempotencyKey: "k2" });
  const body = await res.json();
  assert.equal(body.outcome, "needs_link");
  assert.equal(new URL(body.linkUrl).searchParams.get("at"), site);
});

test("a linked user without consent is not counted", async () => {
  const person = await makeAccount();
  await linkIdentity(person.id, { provider: `org:${tag}-shop`, tenant: String(orgId), userId: "cust-noconsent" });
  const body = await (await relay({ placementId: site, userId: "cust-noconsent", questionId: q1, value: "true", idempotencyKey: "k3" })).json();
  assert.equal(body.outcome, "needs_consent");
  assert.equal((await query("select 1 from votes where account_id = $1", [person.id])).length, 0);
});

test("a linked, consenting user is counted by the one engine, labelled, without a handle", async () => {
  const person = await makeAccount();
  await agree(person);
  await linkIdentity(person.id, { provider: `org:${tag}-shop`, tenant: String(orgId), userId: "cust-42" });
  const card = (await questionCard(q2))!;
  const body = { placementId: pos, userId: "cust-42", questionId: q1, value: "unsure", idempotencyKey: "till-1-tx-9", shown: card.shown };
  const first = await (await relay(body)).json();
  assert.deepEqual(first, { outcome: "cast", questionId: q1, value: "unsure" });
  assert.ok(!JSON.stringify(first).includes(person.username), "the org never gets the BeliefAtlas handle");
  const again = await (await relay(body)).json();
  assert.equal(again.outcome, "cast", "a retry with the same key returns the stored answer");
  const events = await query<{ surface: string; placement: string; surface_context: Record<string, string> }>(
    "select surface, placement, surface_context from vote_events where account_id = $1 and question_id = $2",
    [person.id, q1],
  );
  assert.equal(events.length, 1, "counted once");
  assert.equal(events[0].surface, "pos");
  assert.equal(events[0].placement, pos);
  assert.equal(events[0].surface_context.kind, "pos");
  // Daily limits and the change rule are the engine's: a change today is allowed once.
  const changed = await (await relay({ ...body, value: "true", idempotencyKey: "till-1-tx-10" })).json();
  assert.equal(changed.outcome, "changed");
  const again2 = await (await relay({ ...body, value: "false", idempotencyKey: "till-1-tx-11" })).json();
  assert.equal(again2.outcome, "change_used");
});

test("an org can only relay to its own placements and their questions", async () => {
  const theirs = await relayVote(`${tag}-shop`, { placementId: other, userId: "u", questionId: q1, value: "true", idempotencyKey: "k" });
  assert.equal(theirs.outcome, "forbidden");
  const notListed = await relayVote(`${tag}-shop`, { placementId: pos, userId: "u", questionId: q2, value: "true", idempotencyKey: "k" });
  assert.equal(notListed.outcome, "forbidden");
  const email = await relayVote(`${tag}-shop`, { placementId: pos, userId: "a@b.co", questionId: q1, value: "true", idempotencyKey: "k" });
  assert.equal(email.outcome, "invalid");
});

// ---------- Results ----------

test("results are aggregate, hidden below the minimum, and leave out seed and (in production) test votes", async () => {
  const q = await makeQuestion();
  const placementId = await createPlacement({ orgId, label: "Results", kind: "site", questionIds: [q], notChildDirected: true });
  const placement = (await getPlacement(placementId))!;
  for (const value of ["true", "true", "false"] as const) {
    const p = await makeAccount();
    await agree(p);
    const o = await vote({ account: p, questionId: q, value, surface: "headless", placement: placementId });
    assert.equal(o.outcome, "cast");
  }
  // A vote on the same question but not through the placement doesn't count for it.
  const elsewhere = await makeAccount();
  await vote({ account: elsewhere, questionId: q, value: "false", surface: "web" });

  // A fictional seed vote through the placement never counts.
  await transaction(async (client) => {
    await client.query("set local beliefatlas.seed_load = 'on'");
    const { rows } = await client.query<{ id: number }>(
      "insert into accounts (username, phone_hash, password_hash, consented_at, origin) values ($1, $1, 'x', now(), 'seed') returning id",
      [`${tag}_seed`],
    );
    await client.query("insert into votes (account_id, question_id, value, first_value) values ($1, $2, 'false', 'false')", [rows[0].id, q]);
    await client.query(
      "insert into vote_events (account_id, question_id, action, value, surface, placement) values ($1, $2, 'cast', 'false', 'headless', $3)",
      [rows[0].id, q, placementId],
    );
  });

  const hidden = await placementResults(placement, 50);
  assert.deepEqual(hidden, [{ questionId: q, enough: false, total: null, percentages: null }]);

  const shown = await placementResults(placement, 3);
  assert.equal(shown[0].total, 3, "three test votes through the placement; not the web vote, not the seed vote");
  assert.deepEqual(shown[0].percentages, { true: 66.7, false: 33.3, unsure: 0 });
  assert.ok(!JSON.stringify(shown).match(/account|user|handle/i), "nothing person-level");

  const prod = await placementResults(placement, 1, { VERCEL_ENV: "production" });
  assert.equal(prod[0].enough, false, "test votes don't count in production");
  await query("delete from accounts where username = $1", [`${tag}_seed`]).catch(() => undefined);
});

test("the split endpoint gives percentages and the notice, nothing else", async () => {
  const body = await (await splitGET(req(`/api/headless/v1/questions/${q1}/split`), ctx(q1))).json();
  assert.deepEqual(Object.keys(body).sort(), ["hasVotes", "notice", "percentages", "questionId"]);
});

test("the index says what's on", async () => {
  const body = await (await indexGET()).json();
  assert.equal(body.version, 1);
  assert.equal(body.relay, true);
});
