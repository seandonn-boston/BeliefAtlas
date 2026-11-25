// E1 vote evidence tests: only wired questions keep the extra record; each vote action writes one
// row with the attributes as they stood, the device's region, the interface and the answer it
// replaced; nothing is kept for a vote that didn't count; a buyer only ever gets day-level totals
// of real, public, sale-opted-in answers with small groups hidden; deleting an account clears the
// attributes on its history. They run against DATABASE_URL and clean up after themselves.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pool, query } from "../lib/db";
import type { Account } from "../lib/auth";
import { currentText, recordConsent, voteWithConsent, type ConsentContext } from "../lib/consent";
import { setDemographics } from "../lib/demographics";
import { cleanDeviceRegion, evidenceTotals, interfaceFor, unwireQuestion, wireQuestion, wiredQuestions } from "../lib/evidence";
import { deleteAccount, exportData } from "../lib/account";
import { deleteVote } from "../lib/votes";
import { vote } from "../lib/vote-engine";

const tag = `e1e${Date.now().toString(36)}`;
const OPEN = "XB";   // a user-assigned ISO code, used here as a region open to sale
const web = (over: Partial<ConsentContext> = {}): ConsentContext => ({ gpc: false, region: null, surface: "web", lang: "en", ...over });

let n = 0;
async function makeAccount(origin: "real" | "test" = "real"): Promise<Account> {
  const name = `${tag}_${n++}`;
  const [row] = await query<{ id: number }>(
    `insert into accounts (username, phone_hash, password_hash, consented_at, origin) values ($1, $1, 'x', now(), $2) returning id`,
    [name, origin],
  );
  return { id: row.id, username: name, tier: "free", verified: false, role: "user" };
}

async function agree(account: Account, ctx = web()) {
  const text = await currentText("answering", "en");
  assert.ok((await recordConsent({ accountId: account.id, choice: "answering", granted: true, version: text!.version, lang: "en" }, ctx)).ok);
}

async function optInToSale(account: Account) {
  const text = await currentText("sale", "en");
  const r = await recordConsent({ accountId: account.id, choice: "sale", granted: true, version: text!.version, lang: "en" }, web({ region: OPEN }));
  assert.ok(r.ok, JSON.stringify(r));
}

let wired = 0;
let unwired = 0;

type Row = {
  action: string; value: string | null; previous_value: string | null; change_number: number;
  seconds_since_previous: number | null; age_range: string | null; home_country: string | null; region: string | null; interface: string;
};
const evidenceFor = (accountId: number, questionId: number) =>
  query<Row>(
    `select e.action, e.value, ve.previous_value, ve.change_number, ve.seconds_since_previous,
            ve.age_range, ve.home_country, ve.region, ve.interface
       from vote_events e join vote_evidence ve on ve.event_id = e.id and ve.event_created_at = e.created_at
      where e.account_id = $1 and e.question_id = $2 order by e.created_at, e.id`,
    [accountId, questionId],
  );

before(async () => {
  await query("delete from questions where normalized like 'e1 fixture %'");
  const rows = await query<{ id: number }>(
    `insert into questions (text, normalized, true_count, false_count, unsure_count)
     select 'E1 fixture ' || $1 || ' ' || i, 'e1 fixture ' || $1 || ' ' || i, 500000, 500000, i * 1000
       from generate_series(1, 2) i returning id`,
    [tag],
  );
  [wired, unwired] = rows.map((r) => r.id);
  await wireQuestion(wired, "e1 test");
  await query("insert into regions (code, name, sale_allowed) values ($1, 'Test region open to sale', true) on conflict (code) do update set sale_allowed = true", [OPEN]);
});

after(async () => {
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await query("delete from accounts where username like 'deleted\\_%' and id in (select account_id from vote_events where question_id in ($1, $2))", [wired, unwired]);
  await query("delete from questions where normalized like 'e1 fixture %'");
  await query("delete from regions where code = $1", [OPEN]);
  await pool.end();
});

test("the region the device reports is kept only as an ISO 3166-2 code", () => {
  assert.equal(cleanDeviceRegion("us-ma"), "US-MA");
  assert.equal(cleanDeviceRegion("GB-SCT"), "GB-SCT");
  assert.equal(cleanDeviceRegion("42.36,-71.06"), null);
  assert.equal(cleanDeviceRegion("Boston"), null);
  assert.equal(cleanDeviceRegion("US"), null);
  assert.equal(cleanDeviceRegion(undefined), null);
});

test("the interface comes from the surface unless the app or AI head says so", () => {
  assert.equal(interfaceFor("web"), "web");
  assert.equal(interfaceFor("embed"), "web");
  assert.equal(interfaceFor("slack"), "integration");
  assert.equal(interfaceFor("sms"), "integration");
  assert.equal(interfaceFor("web", "ai_head"), "ai_head");
  assert.equal(interfaceFor("web", "robot"), "web");
});

test("only wired questions keep evidence", async () => {
  assert.ok((await wiredQuestions()).includes(wired));
  const me = await makeAccount();
  assert.equal((await vote({ account: me, questionId: unwired, value: "true", surface: "web", region: "US-MA" })).outcome, "cast");
  assert.equal((await evidenceFor(me.id, unwired)).length, 0);
  assert.equal((await vote({ account: me, questionId: wired, value: "true", surface: "web", region: "US-MA" })).outcome, "cast");
  assert.equal((await evidenceFor(me.id, wired)).length, 1);
});

test("a cast, a change and a withdrawal each write one row, with the answer they replaced", async () => {
  const me = await makeAccount();
  await setDemographics(me.id, { ageRange: "35-44", country: "us" });
  const shownAt = new Date(Date.now() - 4000);
  assert.equal((await vote({ account: me, questionId: wired, value: "true", surface: "web", region: "us-ma", shownAt })).outcome, "cast");

  // Back-date the answer so the hold time is measurable, then change it.
  await query("update votes set updated_at = now() - interval '90 seconds' where account_id = $1 and question_id = $2", [me.id, wired]);
  assert.equal((await vote({ account: me, questionId: wired, value: "false", surface: "slack" })).outcome, "changed");

  let rows = await evidenceFor(me.id, wired);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    action: "cast", value: "true", previous_value: null, change_number: 0, seconds_since_previous: null,
    age_range: "35-44", home_country: "US", region: "US-MA", interface: "web",
  });
  assert.equal(rows[1].action, "change");
  assert.equal(rows[1].value, "false");
  assert.equal(rows[1].previous_value, "true");
  assert.equal(rows[1].change_number, 1);
  assert.ok(rows[1].seconds_since_previous! >= 89 && rows[1].seconds_since_previous! < 120, String(rows[1].seconds_since_previous));
  assert.equal(rows[1].region, null, "no region sent, none kept");
  assert.equal(rows[1].interface, "integration");

  // The once-a-day change rule still applies, so withdraw on a fresh account instead.
  const other = await makeAccount();
  await vote({ account: other, questionId: wired, value: "unsure", surface: "web" });
  assert.deepEqual(await deleteVote(other, wired, "direct"), { ok: true });
  rows = await evidenceFor(other.id, wired);
  assert.deepEqual(rows.map((r) => [r.action, r.value, r.previous_value, r.change_number]), [
    ["cast", "unsure", null, 0],
    ["delete", null, "unsure", 1],
  ]);
});

test("a skip is evidence too, and the attributes are a snapshot of that moment", async () => {
  const me = await makeAccount();
  await setDemographics(me.id, { ageRange: "18-24" });
  assert.equal((await vote({ account: me, questionId: wired, value: "skip", surface: "web" })).outcome, "skipped");
  await setDemographics(me.id, { ageRange: "25-34" });
  assert.equal((await vote({ account: me, questionId: wired, value: "true", surface: "web", interface: "ai_head" })).outcome, "cast");
  const rows = await evidenceFor(me.id, wired);
  assert.deepEqual(rows.map((r) => [r.action, r.age_range, r.interface]), [
    ["skip", "18-24", "web"],
    ["cast", "25-34", "ai_head"],
  ]);
});

test("nothing is kept for an answer that didn't count", async () => {
  const me = await makeAccount();
  const outcome = await voteWithConsent({ account: me, questionId: wired, value: "true", surface: "web", region: "US-MA" }, web());
  assert.equal(outcome.outcome, "needs_consent");
  assert.equal((await evidenceFor(me.id, wired)).length, 0);
  await agree(me);
  assert.equal((await voteWithConsent({ account: me, questionId: wired, value: "true", surface: "web", region: "US-MA" }, web())).outcome, "cast");
  assert.equal((await evidenceFor(me.id, wired)).length, 1);
});

test("a buyer gets day-level totals of sale-opted-in, real, public answers, with small groups hidden", async () => {
  const min = Number(process.env.MIN_GROUP_SIZE) || 50;
  assert.ok(min <= 10, "set MIN_GROUP_SIZE for this test");
  // A full group of real, opted-in people: 45-54, US, US-NY, answering True on the web.
  for (let i = 0; i < min; i++) {
    const p = await makeAccount();
    await setDemographics(p.id, { ageRange: "45-54", country: "US" });
    await agree(p);
    await optInToSale(p);
    await vote({ account: p, questionId: wired, value: "true", surface: "web", region: "US-NY" });
  }
  // One short of a group in another region: hidden.
  for (let i = 0; i < min - 1; i++) {
    const p = await makeAccount();
    await setDemographics(p.id, { ageRange: "45-54", country: "US" });
    await agree(p);
    await optInToSale(p);
    await vote({ account: p, questionId: wired, value: "true", surface: "web", region: "US-VT" });
  }
  // Same group, but not opted in, private, or test accounts: never counted.
  const notOptedIn = await makeAccount();
  await setDemographics(notOptedIn.id, { ageRange: "45-54", country: "US" });
  await agree(notOptedIn);
  await vote({ account: notOptedIn, questionId: wired, value: "true", surface: "web", region: "US-NY" });
  const privateOne = await makeAccount();
  await setDemographics(privateOne.id, { ageRange: "45-54", country: "US" });
  await agree(privateOne);
  await optInToSale(privateOne);
  await vote({ account: privateOne, questionId: wired, value: "true", surface: "web", region: "US-NY", isPrivate: true });
  const tester = await makeAccount("test");
  await setDemographics(tester.id, { ageRange: "45-54", country: "US" });
  await agree(tester);
  await vote({ account: tester, questionId: wired, value: "true", surface: "web", region: "US-NY" });

  const totals = await evidenceTotals(wired);
  assert.equal(totals.length, 1, JSON.stringify(totals));
  const [t] = totals;
  assert.match(t.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(t.action, "cast");
  assert.equal(t.value, "true");
  assert.equal(t.region, "US-NY");
  assert.equal(t.ageRange, "45-54");
  assert.equal(t.people, min);
  assert.ok(!("accountId" in t) && !("person" in t));
});

test("deleting an account keeps the dated history but clears who and where", async () => {
  const me = await makeAccount();
  await setDemographics(me.id, { ageRange: "55-64", country: "CA" });
  await vote({ account: me, questionId: wired, value: "false", surface: "web", region: "CA-ON" });
  const exported = await exportData(me.id);
  assert.equal(exported.voteEvidence.length, 1);
  assert.equal((exported.voteEvidence[0] as { region: string }).region, "CA-ON");

  const [{ id: eventId }] = await query<{ id: string }>(
    "select id from vote_events where account_id = $1 and question_id = $2 and action = 'cast'", [me.id, wired],
  );
  await deleteAccount(me.id);
  const [row] = await query<{ age_range: string | null; home_country: string | null; region: string | null; interface: string }>(
    "select age_range, home_country, region, interface from vote_evidence where event_id = $1", [eventId],
  );
  assert.deepEqual(row, { age_range: null, home_country: null, region: null, interface: "web" });
});

test("unwiring a question stops new evidence and keeps what was already kept", async () => {
  const before = await query<{ n: number }>(
    "select count(*)::int as n from vote_evidence ve join vote_events e on e.id = ve.event_id and e.created_at = ve.event_created_at where e.question_id = $1",
    [wired],
  );
  await unwireQuestion(wired);
  const me = await makeAccount();
  await vote({ account: me, questionId: wired, value: "true", surface: "web", region: "US-MA" });
  assert.equal((await evidenceFor(me.id, wired)).length, 0);
  const afterRows = await query<{ n: number }>(
    "select count(*)::int as n from vote_evidence ve join vote_events e on e.id = ve.event_id and e.created_at = ve.event_created_at where e.question_id = $1",
    [wired],
  );
  assert.equal(afterRows[0].n, before[0].n);
  await wireQuestion(wired);
});
