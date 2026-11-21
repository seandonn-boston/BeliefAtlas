// W4 consent tests: no answer counts before the 'answering' agreement, the held tap counts once
// after it, sale is separate and off by default, Global Privacy Control is an opt-out, the ledger
// is append-only, and region '*' never allows sale. They run against DATABASE_URL and clean up.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pool, query } from "../lib/db";
import type { Account } from "../lib/auth";
import {
  claimHeld, consentHistory, consentState, contextFromHeaders, currentText, hasAnsweringConsent, holdIfNoConsent,
  honorGpc, peekHold, recordConsent, regionFrom, safeNext, saleExportRows, saleIsOn, saleOffer, voteWithConsent,
  type ConsentContext,
} from "../lib/consent";
import { saleAllowed } from "../lib/regions";

const tag = `w4c${Date.now().toString(36)}`;
const OPEN = "XA";   // a user-assigned ISO code, used here as a region open to sale

const web = (over: Partial<ConsentContext> = {}): ConsentContext => ({ gpc: false, region: null, surface: "web", lang: "en", ...over });

let n = 0;
async function makeAccount(tier: "free" | "paid" = "free"): Promise<Account> {
  const name = `${tag}_${n++}`;
  const [row] = await query<{ id: number }>(
    `insert into accounts (username, phone_hash, password_hash, consented_at, tier) values ($1, $1, 'x', now(), $2) returning id`,
    [name, tier],
  );
  return { id: row.id, username: name, tier, verified: false, role: "user" };
}

// Fixture questions, made in one statement when this file starts. Each has a large, even
// true/false split and a distinct total, so a test vote never moves it in either feed. Test
// files run one at a time, so they are removed again when this file ends (and, in case a run was
// cut short, before it starts): their made-up counters must never linger in a database.
const fixtures: number[] = [];
const closed: Record<"archived" | "removed", number[]> = { archived: [], removed: [] };
const makeQuestion = (): number => {
  const id = fixtures.shift();
  assert.ok(id, "out of fixture questions");
  return id;
};

async function makeFixtures() {
  await query("delete from questions where normalized like 'w4 fixture %'");
  const rows = await query<{ id: number; status: "active" | "archived" | "removed" }>(
    `insert into questions (text, normalized, status, archived_at, true_count, false_count, unsure_count)
     select 'W4 fixture ' || $1 || ' ' || i, 'w4 fixture ' || $1 || ' ' || i, s,
            case when s = 'archived' then now() end, 500000, 500000, i * 1000
       from generate_series(1, 16) i,
            lateral (select case when i <= 12 then 'active' when i <= 14 then 'archived' else 'removed' end as s) st
     returning id, status`,
    [tag],
  );
  for (const r of rows) {
    if (r.status === "active") fixtures.push(r.id);
    else closed[r.status].push(r.id);
  }
}

async function agree(account: Account, ctx = web()) {
  const text = await currentText("answering", "en");
  const r = await recordConsent({ accountId: account.id, choice: "answering", granted: true, version: text!.version, lang: "en" }, ctx);
  assert.ok(r.ok);
}

async function optInToSale(account: Account, ctx: ConsentContext) {
  const text = await currentText("sale", "en");
  return recordConsent({ accountId: account.id, choice: "sale", granted: true, version: text!.version, lang: "en" }, ctx);
}

const votesFor = (accountId: number, questionId: number) =>
  query<{ value: string; is_private: boolean }>("select value, is_private from votes where account_id = $1 and question_id = $2", [accountId, questionId]);
const castEvents = (accountId: number, questionId: number) =>
  query("select 1 from vote_events where account_id = $1 and question_id = $2 and action = 'cast'", [accountId, questionId]);

before(async () => {
  await makeFixtures();
  await query("insert into regions (code, name, sale_allowed) values ($1, 'Test region open to sale', true) on conflict (code) do update set sale_allowed = true", [OPEN]);
});

after(async () => {
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await query("delete from questions where normalized like 'w4 fixture %'");
  await query("delete from regions where code = $1", [OPEN]);
  await pool.end();
});

test("a first answer without consent is held, and nothing is counted", async () => {
  const q = makeQuestion();
  const me = await makeAccount();
  const outcome = await voteWithConsent({ account: me, questionId: q, value: "true", surface: "embed" }, web({ surface: "embed" }));
  assert.equal(outcome.outcome, "needs_consent");
  assert.ok(outcome.outcome === "needs_consent" && outcome.holdToken.length > 20);
  assert.equal((await votesFor(me.id, q)).length, 0);
  assert.equal((await castEvents(me.id, q)).length, 0);
  const held = await peekHold(outcome.outcome === "needs_consent" ? outcome.holdToken : "");
  assert.deepEqual(held && { reason: held.reason, surface: held.surface, value: held.value }, { reason: "needs_consent", surface: "embed", value: "true" });

  // Still nothing counts, however many times they tap, and the held tap can't be claimed yet.
  const again = await voteWithConsent({ account: me, questionId: q, value: "false", surface: "web" }, web());
  assert.equal(again.outcome, "needs_consent");
  assert.equal(await claimHeld(outcome.outcome === "needs_consent" ? outcome.holdToken : "", me), null);
  assert.equal((await votesFor(me.id, q)).length, 0);
});

test("after agreeing, the held answer counts exactly once, with its original surface", async () => {
  const q = makeQuestion();
  const me = await makeAccount();
  const held = await voteWithConsent({ account: me, questionId: q, value: "false", surface: "qr", placement: "poster-9" }, web({ surface: "qr" }));
  assert.equal(held.outcome, "needs_consent");
  const token = held.outcome === "needs_consent" ? held.holdToken : "";

  await agree(me, web({ surface: "qr" }));
  assert.equal(await hasAnsweringConsent(me.id), true);
  const counted = await claimHeld(token, me);
  assert.equal(counted?.outcome, "cast");
  assert.equal(await claimHeld(token, me), null, "a token counts once");
  assert.deepEqual((await votesFor(me.id, q)).map((v) => v.value), ["false"]);
  assert.equal((await castEvents(me.id, q)).length, 1);
  const [event] = await query<{ surface: string; placement: string }>(
    "select surface, placement from vote_events where account_id = $1 and question_id = $2", [me.id, q],
  );
  assert.deepEqual(event, { surface: "qr", placement: "poster-9" });

  // From now on, taps count straight away.
  const q2 = makeQuestion();
  assert.equal((await voteWithConsent({ account: me, questionId: q2, value: "true", surface: "web" }, web())).outcome, "cast");
});

test("a private tap held for consent is counted as private", async () => {
  const q = makeQuestion();
  const me = await makeAccount();
  const token = await holdIfNoConsent({ account: me, questionId: q, value: "true", surface: "web", isPrivate: true, source: "feed:fresh" }, web());
  assert.ok(token);
  assert.equal((await peekHold(token!))?.isPrivate, true);
  await agree(me);
  assert.equal((await claimHeld(token!, me))?.outcome, "cast");
  assert.deepEqual(await votesFor(me.id, q), [{ value: "true", is_private: true }]);
  const [event] = await query<{ source: string }>("select source from vote_events where account_id = $1 and question_id = $2", [me.id, q]);
  assert.equal(event.source, "feed:fresh");
  // Once agreed, the website's own forms count directly.
  assert.equal(await holdIfNoConsent({ account: me, questionId: q, value: "true", surface: "web" }, web()), null);
});

test("platform adapters aren't held (no cookie to hold it in); bad input and closed questions aren't held", async () => {
  const q = makeQuestion();
  const me = await makeAccount();
  const adapter = await voteWithConsent({ account: me, questionId: q, value: "true", surface: "slack" }, web({ surface: "slack" }), { hold: false });
  assert.deepEqual(adapter, { outcome: "needs_consent", questionId: q, holdToken: "" });
  assert.equal((await voteWithConsent({ account: me, questionId: -1, value: "true", surface: "web" }, web())).outcome, "invalid");
  assert.equal((await voteWithConsent({ account: me, questionId: closed.archived[0], value: "true", surface: "web" }, web())).outcome, "closed");
  assert.equal((await voteWithConsent({ account: me, questionId: closed.removed[0], value: "true", surface: "web" }, web())).outcome, "invalid");
});

test("sale is off by default and never needed to answer", async () => {
  const q = makeQuestion();
  const me = await makeAccount();
  await agree(me, web({ region: OPEN }));
  const state = await consentState(me.id);
  assert.equal(state.sale, null);
  assert.equal(saleIsOn(state), false);
  assert.equal(await saleAllowed(me), false);
  assert.equal((await voteWithConsent({ account: me, questionId: q, value: "unsure", surface: "web" }, web())).outcome, "cast");
  assert.equal(await saleAllowed(me), false, "answering doesn't opt anyone in to sale");
});

test("opting in and out of sale, where the region allows it", async () => {
  const me = await makeAccount();
  await agree(me, web({ region: OPEN }));
  assert.deepEqual(await saleOffer(me.id, web({ region: OPEN })), { offer: true });
  const on = await optInToSale(me, web({ region: OPEN, surface: "consent" }));
  assert.ok(on.ok);
  assert.equal(await saleAllowed(me.id), true);

  const text = await currentText("sale", "en");
  await recordConsent({ accountId: me.id, choice: "sale", granted: false, version: text!.version, lang: "en" }, web({ surface: "settings" }));
  assert.equal(await saleAllowed(me.id), false, "one withdrawal removes them from every sale");
  assert.equal(saleIsOn(await consentState(me.id)), false);
});

test("region '*' never allows sale, even with an opt-in on record", async () => {
  const me = await makeAccount();
  await agree(me);
  assert.deepEqual(await saleOffer(me.id, web()), { offer: false, reason: "region_closed" });
  const refused = await optInToSale(me, web());
  assert.deepEqual(refused, { ok: false, error: "region_closed" });

  // Even a granted row written directly doesn't open sale for an unknown region or one without a row.
  const text = await currentText("sale", "en");
  await query(
    "insert into consent_records (account_id, choice, granted, text_version, lang, surface) values ($1, 'sale', true, $2, 'en', 'web')",
    [me.id, text!.version],
  );
  assert.equal(await saleAllowed(me), false);
  await query("update accounts set region = 'QZ' where id = $1", [me.id]);
  assert.equal(await saleAllowed(me), false);
  const [star] = await query<{ sale_allowed: boolean }>("select sale_allowed from regions where code = '*'");
  assert.equal(star.sale_allowed, false);
});

test("Global Privacy Control records an opt-out and forces sale off", async () => {
  const q = makeQuestion();
  const me = await makeAccount();
  await agree(me, web({ region: OPEN }));
  assert.ok((await optInToSale(me, web({ region: OPEN }))).ok);
  assert.equal(await saleAllowed(me), true);

  // A tap with GPC on records the opt-out on the way through, once.
  const gpc = web({ gpc: true, region: OPEN, surface: "web" });
  assert.equal((await voteWithConsent({ account: me, questionId: q, value: "true", surface: "web" }, gpc)).outcome, "cast");
  const state = await consentState(me.id);
  assert.equal(state.sale?.granted, false);
  assert.equal(state.sale?.gpc, true);
  assert.equal(await saleAllowed(me), false);
  assert.equal(await honorGpc(me.id, gpc), false, "no second row while it's already a GPC opt-out");
  assert.equal((await consentHistory(me.id)).filter((r) => r.choice === "sale").length, 2);

  // With GPC on, an opt-in is refused and the page doesn't offer it.
  assert.deepEqual(await optInToSale(me, gpc), { ok: false, error: "gpc" });
  assert.deepEqual(await saleOffer(me.id, gpc), { offer: false, reason: "gpc" });

  // A granted row made with GPC on never allows sale.
  const text = await currentText("sale", "en");
  await query(
    "insert into consent_records (account_id, choice, granted, text_version, lang, surface, gpc) values ($1, 'sale', true, $2, 'en', 'web', true)",
    [me.id, text!.version],
  );
  assert.equal(await saleAllowed(me), false);

  // GPC with no sale choice on record is recorded too.
  const other = await makeAccount();
  assert.equal(await honorGpc(other.id, gpc), true);
  assert.equal((await consentState(other.id)).sale?.gpc, true);
});

test("consent records are append-only and keep text version, language, surface and region", async () => {
  const me = await makeAccount();
  await agree(me, web({ surface: "embed", region: OPEN }));
  const [record] = await consentHistory(me.id);
  assert.equal(record.choice, "answering");
  assert.equal(record.granted, true);
  assert.equal(record.textVersion, "2");
  assert.equal(record.lang, "en");
  assert.equal(record.surface, "embed");
  assert.equal(record.region, OPEN);
  const [account] = await query<{ region: string }>("select region from accounts where id = $1", [me.id]);
  assert.equal(account.region, OPEN);

  await assert.rejects(query("update consent_records set granted = false where account_id = $1", [me.id]), /append-only/);
  await assert.rejects(query("delete from consent_records where account_id = $1", [me.id]), /append-only/);

  // A withdrawal is a new row; the first one is untouched.
  const text = await currentText("answering", "en");
  await recordConsent({ accountId: me.id, choice: "answering", granted: false, version: text!.version, lang: "en" }, web({ surface: "settings" }));
  const history = await consentHistory(me.id);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((r) => [r.granted, r.surface]), [[false, "settings"], [true, "embed"]]);
  assert.equal(await hasAnsweringConsent(me.id), false);
});

test("only texts that exist can be recorded, in the language shown", async () => {
  const me = await makeAccount();
  assert.deepEqual(
    await recordConsent({ accountId: me.id, choice: "answering", granted: true, version: "999", lang: "en" }, web()),
    { ok: false, error: "unknown_text" },
  );
  const es = await currentText("answering", "es");
  assert.equal(es?.lang, "es");
  assert.equal(es?.draft, true, "texts are drafts until a lawyer reviews them");
  const fallback = await currentText("answering", "fr");
  assert.equal(fallback?.lang, "en");
  const r = await recordConsent({ accountId: me.id, choice: "answering", granted: true, version: es!.version, lang: "es" }, web({ lang: "es" }));
  assert.ok(r.ok && r.record.lang === "es");
});

test("request headers: GPC, country and surface", () => {
  const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });
  assert.deepEqual(
    contextFromHeaders(headers({ "sec-gpc": "1", "x-vercel-ip-country": "mx" }), "embed", "es"),
    { gpc: true, region: "MX", surface: "embed", lang: "es" },
  );
  assert.deepEqual(contextFromHeaders(headers({}), "nonsense", "en"), { gpc: false, region: null, surface: "web", lang: "en" });
  assert.equal(regionFrom("XX"), null);
  assert.equal(regionFrom("USA"), null);
  assert.equal(contextFromHeaders(headers({ "sec-gpc": "0" }), "settings", "en").gpc, false);
  assert.equal(safeNext("//evil.example"), "/");
  assert.equal(safeNext("/consent?next=/"), "/");
  assert.equal(safeNext("/q/12?x=1"), "/q/12?x=1");
});

test("the sale export includes only eligible accounts, public answers and active questions", async () => {
  const active = makeQuestion();
  const [archived, removed] = [closed.archived[1], closed.removed[1]];
  const yes = await makeAccount();
  const no = await makeAccount();
  for (const a of [yes, no]) await agree(a, web({ region: OPEN }));
  assert.ok((await optInToSale(yes, web({ region: OPEN }))).ok);
  for (const a of [yes, no]) {
    assert.equal((await voteWithConsent({ account: a, questionId: active, value: "true", surface: "web" }, web())).outcome, "cast");
    // Answers given before a question was archived or removed (written directly: they're closed now).
    for (const q of [archived, removed]) {
      await query("insert into votes (account_id, question_id, value) values ($1, $2, 'true')", [a.id, q]);
    }
  }
  const privateQ = makeQuestion();
  await voteWithConsent({ account: yes, questionId: privateQ, value: "false", surface: "web", isPrivate: true }, web());

  const salt = "a-fresh-random-salt-for-this-export";
  const rows = await saleExportRows({ salt, questionIds: [active, archived, removed, privateQ] });
  assert.deepEqual(rows.map((r) => r.questionId), [active]);
  assert.equal(rows[0].value, "true");
  assert.ok(!rows[0].person.includes(String(yes.id)));
  await assert.rejects(saleExportRows({ salt: "short" }));

  // Withdrawing removes them from the next export.
  const text = await currentText("sale", "en");
  await recordConsent({ accountId: yes.id, choice: "sale", granted: false, version: text!.version, lang: "en" }, web());
  assert.equal((await saleExportRows({ salt, questionIds: [active] })).length, 0);
});
