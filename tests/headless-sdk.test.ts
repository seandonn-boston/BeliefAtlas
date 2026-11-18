// The JavaScript SDK (sdks/javascript) against the real /api/headless/v1 route handlers, run in
// process: every SDK request goes to the handler it would reach over the network. Test data
// only (a 'test' org, placement and accounts), removed at the end. Runs against DATABASE_URL.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pool, query } from "../lib/db";
import { currentText, recordConsent } from "../lib/consent";
import { linkIdentity } from "../lib/vote-engine";
import { createOrg, createPlacement, deleteTestOrgs } from "../lib/headless/placements";

// Test orgs only: their sanctions screening marked approved, so their placements serve.
const approveScreening = (o: number) => query("update screened_parties set status = 'approved', status_reason = 'Test org, approved for tests.' where id = (select screened_party_id from organizations where id = $1 and origin = 'test')", [o]);
import {
  answer, BeliefAtlas, BeliefAtlasError, describeOutcome, renderCardHtml, UNOFFICIAL_NOTICE, type QuestionCard,
} from "../sdks/javascript/src/index";
import contract from "../sdks/contract/v1.json";
import { GET as questionGET } from "../app/api/headless/v1/questions/[id]/route";
import { GET as splitGET } from "../app/api/headless/v1/questions/[id]/split/route";
import { GET as placementGET } from "../app/api/headless/v1/placements/[id]/route";
import { POST as votesPOST } from "../app/api/headless/v1/votes/route";

const tag = `hs${Date.now().toString(36)}`;
const BASE = "http://localhost:3000";
const SHOP = "https://shop.example";
const KEY = `sdk-test-key-${tag}-0123456789`;
const ENV_KEYS = ["HEADLESS_ENABLED", "HEADLESS_RELAY_ENABLED", "HEADLESS_TEST_ORG_KEYS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// A fetch that hands each request to the route handler it would reach.
const inProcess: typeof fetch = async (input, init) => {
  const request = new Request(input as string, init);
  const path = new URL(request.url).pathname;
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/api\/headless\/v1\/questions\/([^/]+)\/split$/))) return splitGET(request, ctx(m[1]));
  if ((m = path.match(/^\/api\/headless\/v1\/questions\/([^/]+)$/))) return questionGET(request, ctx(m[1]));
  if ((m = path.match(/^\/api\/headless\/v1\/placements\/([^/]+)$/))) return placementGET(request, ctx(m[1]));
  if (path === "/api/headless/v1/votes") return votesPOST(request);
  return new Response("{}", { status: 404 });
};

let placementId: string;
let q: number;

before(async () => {
  process.env.HEADLESS_ENABLED = "true";
  process.env.HEADLESS_RELAY_ENABLED = "true";
  process.env.HEADLESS_TEST_ORG_KEYS = `${tag}-org:${KEY}`;
  const [admin] = await query<{ id: number }>(
    "insert into accounts (username, phone_hash, password_hash, consented_at, origin) values ($1, $1, 'x', now(), 'test') returning id",
    [`${tag}_admin`],
  );
  const orgId = await createOrg({ slug: `${tag}-org`, name: "SDK Test Org", createdBy: admin.id, origin: "test", status: "active", country: "US" });
  await approveScreening(orgId);
  const [row] = await query<{ id: number }>(
    "insert into questions (text, normalized) values ($1, lower($1)) returning id",
    [`Headless sdk ${tag} claim is true`],
  );
  q = row.id;
  placementId = await createPlacement({ orgId, label: "SDK", kind: "app", allowedOrigins: [SHOP], questionIds: [q], notChildDirected: true });
  const [person] = await query<{ id: number }>(
    "insert into accounts (username, phone_hash, password_hash, consented_at, origin) values ($1, $1, 'x', now(), 'test') returning id",
    [`${tag}_person`],
  );
  const text = await currentText("answering", "en");
  await recordConsent({ accountId: person.id, choice: "answering", granted: true, version: text!.version, lang: "en" }, { gpc: false, region: null, surface: "web", lang: "en" });
  await linkIdentity(person.id, { provider: `org:${tag}-org`, tenant: String(orgId), userId: "member-7" });
});

after(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await deleteTestOrgs(`${tag}-%`);
  await query("delete from questions where normalized like $1", [`headless sdk ${tag} %`]);
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await pool.end();
});

const client = (extra: Partial<ConstructorParameters<typeof BeliefAtlas>[0]> = {}) =>
  new BeliefAtlas({ baseUrl: `${BASE}/`, placement: placementId, origin: SHOP, fetch: inProcess, ...extra });

test("question() returns a card in the contract's shape, labelled with the placement", async () => {
  const card = await client().question(q);
  assert.deepEqual(Object.keys(card).sort(), Object.keys(contract.card).sort());
  const url = new URL(card.choices[0].answerUrl!);
  assert.equal(url.searchParams.get("at"), placementId);
  assert.equal(url.searchParams.get("ret"), SHOP);
});

test("placement() returns the placement and its cards", async () => {
  const body = await client().placement();
  assert.deepEqual(Object.keys(body).sort(), Object.keys(contract.placement).sort());
  assert.deepEqual(body.questions.map((c) => c.id), [q]);
});

test("split() returns percentages only", async () => {
  const split = await client().split(q);
  assert.deepEqual(Object.keys(split).sort(), Object.keys(contract.split).sort());
});

test("errors come back as BeliefAtlasError with the status", async () => {
  await assert.rejects(client().question(999999999), (e: unknown) => e instanceof BeliefAtlasError && e.status === 404 && e.code === "not_found");
  process.env.HEADLESS_ENABLED = "false";
  try {
    await assert.rejects(client().question(q), (e: unknown) => e instanceof BeliefAtlasError && e.status === 404);
  } finally {
    process.env.HEADLESS_ENABLED = "true";
  }
});

test("relayVote() counts through the one engine and never returns a handle", async () => {
  const card = await client().question(q);
  const c = client({ credential: KEY });
  const first = await c.relayVote({ userId: "member-7", questionId: q, value: "true", idempotencyKey: "sdk-1", shown: card.shown });
  assert.deepEqual(first, { outcome: "cast", questionId: q, value: "true" });
  const unlinked = await c.relayVote({ userId: "member-unknown", questionId: q, value: "true", idempotencyKey: "sdk-2" });
  assert.equal(unlinked.outcome, "needs_link");
  assert.equal(describeOutcome(unlinked).tone, "action");
});

test("relayVote() refuses without a credential, and in a browser", async () => {
  assert.throws(() => client().relayVote({ userId: "x", questionId: q, value: "true", idempotencyKey: "k" }), /credential/);
  const g = globalThis as Record<string, unknown>;
  g.window = {};
  g.document = {};
  try {
    assert.throws(() => client({ credential: KEY }), /browser/);
  } finally {
    delete g.window;
    delete g.document;
  }
});

test("results() needs a key and refuses a browser", () => {
  assert.throws(() => client().results(), /key/);
});

test("describeOutcome() draws every outcome in the contract", () => {
  for (const [name, outcome] of Object.entries(contract.relayOutcomes)) {
    const d = describeOutcome(outcome as Parameters<typeof describeOutcome>[0]);
    assert.ok(d.text.length > 0, name);
    if (name === "needs_link" || name === "needs_consent") assert.ok(d.linkUrl, name);
  }
  assert.equal(describeOutcome({ outcome: "something_new", questionId: 1 }, "https://x.test/v/1").linkUrl, "https://x.test/v/1");
});

test("renderCardHtml() escapes the text and links every choice to the hosted page", () => {
  const card = { ...(contract.card as QuestionCard), text: `Is <b>"this"</b> & that true?` };
  const html = renderCardHtml(card);
  assert.ok(html.includes("Is &lt;b&gt;&quot;this&quot;&lt;/b&gt; &amp; that true?"));
  assert.equal((html.match(/class="beliefatlas-choice /g) ?? []).length, 4);
  assert.ok(!html.includes("<script"));
  assert.ok(html.includes(`<p class="beliefatlas-notice">${contract.card.notice}</p>`));
  // A response without a notice still gets one.
  assert.ok(renderCardHtml({ ...card, notice: "" }).includes(UNOFFICIAL_NOTICE));
  const closed = renderCardHtml({ ...card, status: "archived", choices: card.choices.map((c) => ({ ...c, answerUrl: null })) });
  assert.ok(closed.includes("closed to new answers"));
});

// A fake browser window for the hosted tap.
function fakeWindow() {
  const listeners = new Set<(e: { origin: string; source: unknown; data: unknown }) => void>();
  const popup = { closed: false };
  const opened: string[] = [];
  return {
    popup,
    opened,
    send: (e: { origin: string; source: unknown; data: unknown }) => listeners.forEach((fn) => fn(e)),
    win: {
      open: (url: string) => { opened.push(url); return popup; },
      addEventListener: (_: "message", fn: (e: { origin: string; source: unknown; data: unknown }) => void) => listeners.add(fn),
      removeEventListener: (_: "message", fn: (e: { origin: string; source: unknown; data: unknown }) => void) => listeners.delete(fn),
    },
  };
}

test("answer() opens the vote page and trusts only BeliefAtlas's own message about this question", async () => {
  const card = contract.card as QuestionCard;
  const f = fakeWindow();
  const result = answer(card, "false", { window: f.win, pollMs: 5 });
  assert.equal(new URL(f.opened[0]).searchParams.get("pick"), "false");
  assert.equal(new URL(f.opened[0]).searchParams.get("popup"), "1");
  f.send({ origin: "https://evil.example", source: f.popup, data: { type: "beliefatlas:counted", questionId: card.id } });
  f.send({ origin: "https://beliefatlas.example.test", source: {}, data: { type: "beliefatlas:counted", questionId: card.id } });
  f.send({ origin: "https://beliefatlas.example.test", source: f.popup, data: { type: "beliefatlas:counted", questionId: 999 } });
  f.send({ origin: "https://beliefatlas.example.test", source: f.popup, data: { type: "beliefatlas:counted", questionId: card.id } });
  assert.deepEqual(await result, { status: "counted", questionId: card.id });
});

test("answer() reports a closed window and a blocked popup", async () => {
  const card = contract.card as QuestionCard;
  const f = fakeWindow();
  const result = answer(card, "true", { window: f.win, pollMs: 5 });
  f.popup.closed = true;
  assert.equal((await result).status, "closed");
  const blocked = await answer(card, "true", { window: { ...f.win, open: () => null } });
  assert.equal(blocked.status, "blocked");
});
