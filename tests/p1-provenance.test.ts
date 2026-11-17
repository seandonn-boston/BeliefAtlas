// P1 provenance: every account, vote and vote event is real, test or seed. A vote takes its
// account's origin in the database; preview test-mode signups are test and production refuses
// test data; seed data loads idempotently and its removal puts every counter back exactly;
// sale exports and keyed stats never see test or seed data. Runs against DATABASE_URL and
// removes what it creates.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pool, query, transaction } from "../lib/db";
import type { Account } from "../lib/auth";
import { deleteAccount } from "../lib/account";
import { currentText, recordConsent, SALE_EXPORT_SQL, saleExportRows, type ConsentContext } from "../lib/consent";
import { setLogSink } from "../lib/log";
import {
  assertNoSeedData, assertTestDataAllowed, assertTestDataAllowedHere, checkDatabaseProvenance, databaseIsProduction, isProductionEnv,
  markProductionDatabase, originCounts, SEED_DATA_PRESENT_MESSAGE, SeedDataPresent, seedDataPresent, signupOrigin,
  TestDataRefused,
} from "../lib/provenance";
import { SALE_ELIGIBLE_ACCOUNTS } from "../lib/regions";
import {
  assertSeedLoadAllowed, loadSeed, parseCsvRows, parseSeedCsv, parseSeedFile, parseSeedJson, removeOrigin, SeedFileError,
} from "../lib/seed-data";
import { startSignup, verifySignup } from "../lib/signup";
import { castVote } from "../lib/votes";
import { GET as statsGET } from "../app/api/questions/[id]/stats/route";

process.env.SMS_DEV_CODE = "246802";
const KEY = "p1-provenance-test-key";
process.env.API_KEYS = [process.env.API_KEYS, KEY].filter(Boolean).join(",");

const tag = `p1p${Date.now().toString(36)}`;
const OPEN = "XQ";   // a user-assigned ISO code, used here as a region open to sale
const questions: number[] = [];
let n = 0;

async function makeAccount(origin: "real" | "test" = "real"): Promise<Account> {
  const name = `${tag}_${n++}`;
  const [row] = await query<{ id: number }>(
    `insert into accounts (username, phone_hash, password_hash, consented_at, origin) values ($1, $1, 'x', now(), $2) returning id`,
    [name, origin],
  );
  return { id: row.id, username: name, tier: "free", verified: false, role: "user" };
}

// Seed accounts can only be made where beliefatlas.seed_load is on, as the loader does.
async function makeSeedAccount(): Promise<Account> {
  const name = `${tag}_${n++}`;
  const id = await transaction(async (client) => {
    await client.query("set local beliefatlas.seed_load = 'on'");
    const res = await client.query<{ id: number }>(
      `insert into accounts (username, phone_hash, password_hash, consented_at, origin, seed_key)
       values ($1, $1, 'x', now(), 'seed', $1) returning id`,
      [name],
    );
    return res.rows[0].id;
  });
  return { id, username: name, tier: "free", verified: false, role: "user" };
}

const counts = async (questionId: number) =>
  (await query<{ t: number; f: number; u: number }>(
    "select true_count as t, false_count as f, unsure_count as u from questions where id = $1",
    [questionId],
  ))[0];
const countedFromVotes = async (questionId: number) =>
  (await query<{ t: number; f: number; u: number }>(
    `select count(*) filter (where value = 'true')::int as t, count(*) filter (where value = 'false')::int as f,
            count(*) filter (where value = 'unsure')::int as u from votes where question_id = $1`,
    [questionId],
  ))[0];
const origins = async (table: "votes" | "vote_events", accountId: number) =>
  (await query<{ origin: string }>(`select distinct origin from ${table} where account_id = $1`, [accountId])).map((r) => r.origin);

before(async () => {
  // These tests remove every seed account in the database they run against.
  if (await databaseIsProduction()) throw new Error("tests/p1-provenance.test.ts must not run against a production database");
  // Earlier runs that stopped half way.
  await query("delete from accounts where origin = 'seed'");
  await query("delete from accounts where username like 'p1p%' and origin <> 'seed'");
  await query("delete from questions where normalized like 'p1 provenance fixture %'");
  const rows = await query<{ id: number }>(
    `insert into questions (text, normalized)
     select 'P1 provenance fixture ' || $1 || ' ' || i || '?', 'p1 provenance fixture ' || $1 || ' ' || i
       from generate_series(1, 6) i returning id`,
    [tag],
  );
  questions.push(...rows.map((r) => r.id));
  await query("insert into regions (code, name, sale_allowed) values ($1, 'P1 test region open to sale', true) on conflict (code) do update set sale_allowed = true", [OPEN]);
});

after(async () => {
  await query("delete from accounts where origin = 'seed'");
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await query("delete from questions where id = any($1::int[])", [questions]);
  await query("delete from regions where code = $1", [OPEN]);
  await pool.end();
});

// ---------- The database keeps a vote's origin equal to its account's ----------

test("a vote takes its account's origin, whatever the insert says", async () => {
  const [q1, q2] = questions;
  const tester = await makeAccount("test");
  const person = await makeAccount("real");

  // Written directly, claiming to be real: the trigger overwrites it.
  await query("insert into votes (account_id, question_id, value, origin) values ($1, $2, 'true', 'real')", [tester.id, q1]);
  await query(
    "insert into vote_events (account_id, question_id, action, value, origin) values ($1, $2, 'cast', 'true', 'real')",
    [tester.id, q1],
  );
  // Through the vote engine's own path.
  assert.ok((await castVote(tester, q2, "false", false, "direct")).ok);
  assert.ok((await castVote(person, q2, "true", false, "direct")).ok);
  assert.deepEqual(await origins("votes", tester.id), ["test"]);
  assert.deepEqual(await origins("vote_events", tester.id), ["test"]);
  assert.deepEqual(await origins("votes", person.id), ["real"]);
  assert.deepEqual(await origins("vote_events", person.id), ["real"]);

  // Setting it afterwards doesn't stick either.
  await query("update votes set origin = 'real' where account_id = $1", [tester.id]);
  assert.deepEqual(await origins("votes", tester.id), ["test"]);

  // History can't be moved to an account of another origin.
  await assert.rejects(query("update vote_events set account_id = $2 where account_id = $1", [tester.id, person.id]), /cannot move/);
  await assert.rejects(query("update votes set account_id = $2 where account_id = $1 and question_id = $3", [tester.id, person.id, q1]), /cannot move/);

  // An account with votes can't change origin; one without can.
  await assert.rejects(query("update accounts set origin = 'real' where id = $1", [tester.id]), /has votes/);
  const empty = await makeAccount("test");
  await query("update accounts set origin = 'real' where id = $1", [empty.id]);

  // Seed accounts only come from the loader.
  await assert.rejects(
    query("insert into accounts (username, phone_hash, password_hash, consented_at, origin) values ($1, $1, 'x', now(), 'seed')", [`${tag}_rogue`]),
    /seed:load/,
  );
  await assert.rejects(query("update accounts set origin = 'seed' where id = $1", [empty.id]), /seed:load/);

  // Deleting a test account keeps its history as test, under the stand-in.
  const [{ count: before }] = await query<{ count: number }>("select count(*)::int as count from vote_events where origin = 'test' and question_id = $1", [q2]);
  await deleteAccount(tester.id);
  const [{ count: afterDelete }] = await query<{ count: number }>("select count(*)::int as count from vote_events where origin = 'test' and question_id = $1", [q2]);
  assert.equal(afterDelete, before + 1);   // the cast, now the stand-in's, plus the 'delete' event
  await query("delete from accounts where origin = 'test' and deleted_at is not null and id in (select account_id from vote_events where question_id = any($1::int[]))", [questions]);
  await query("delete from votes where account_id = $1", [person.id]);
  for (const q of [q1, q2]) assert.deepEqual(await counts(q), await countedFromVotes(q));
});

// ---------- Test data and production ----------

test("environments: what counts as production", () => {
  assert.equal(isProductionEnv({ VERCEL_ENV: "production" }), true);
  assert.equal(isProductionEnv({ NODE_ENV: "production" }), true);
  assert.equal(isProductionEnv({ NODE_ENV: "production", VERCEL_ENV: "preview" }), false);
  assert.equal(isProductionEnv({ NODE_ENV: "development" }), false);
  assert.equal(isProductionEnv({}), false);
  assert.throws(() => assertTestDataAllowed("the demo loader", { VERCEL_ENV: "production" }), TestDataRefused);
  assert.throws(() => assertTestDataAllowed("the demo loader", { NODE_ENV: "production" }), TestDataRefused);
  assert.doesNotThrow(() => assertTestDataAllowed("the demo loader", { NODE_ENV: "production", VERCEL_ENV: "preview" }));
  assert.equal(signupOrigin({ VERCEL_ENV: "preview", PREVIEW_TEST_MODE: "1" }), "test");
  assert.equal(signupOrigin({ VERCEL_ENV: "preview" }), "real");
  // PREVIEW_TEST_MODE set in production by mistake changes nothing.
  assert.equal(signupOrigin({ VERCEL_ENV: "production", PREVIEW_TEST_MODE: "1" }), "real");
  assert.equal(signupOrigin({ NODE_ENV: "production", PREVIEW_TEST_MODE: "1" }), "real");
});

async function signUp(): Promise<number> {
  const k = n++;
  const started = await startSignup({
    phone: `303${String(Date.now() + k * 7919).slice(-7)}`, dob: "1988-08-08", next: "/", ip: `ip-${tag}-${k}`,
    device: `dev-${tag}-${k}`, challengeToken: "",
  });
  assert.ok(started.ok, started.ok ? "" : started.error);
  if (!started.ok) throw new Error();
  const done = await verifySignup(started.token, "246802");
  assert.ok(done.ok, done.ok ? "" : done.error);
  if (!done.ok) throw new Error();
  await query("update accounts set username = $2 where id = $1", [done.accountId, `${tag}_${k}`]);
  return done.accountId;
}

test("a preview test-mode signup makes a test account; production makes real ones and refuses test data", async () => {
  const saved = { VERCEL_ENV: process.env.VERCEL_ENV, PREVIEW_TEST_MODE: process.env.PREVIEW_TEST_MODE };
  const origin = async (id: number) => (await query<{ origin: string }>("select origin from accounts where id = $1", [id]))[0].origin;
  try {
    process.env.VERCEL_ENV = "preview";
    process.env.PREVIEW_TEST_MODE = "1";
    assert.equal(await origin(await signUp()), "test");

    process.env.VERCEL_ENV = "production";
    assert.equal(await origin(await signUp()), "real");
    await assert.rejects(assertTestDataAllowedHere("the demo loader"), TestDataRefused);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(await origin(await signUp()), "real");

  // The database refuses test accounts once a production deploy has marked it, whatever the
  // process's own environment says. Done inside a transaction that is rolled back.
  const client = await pool.connect();
  const lines: string[] = [];
  const restore = setLogSink((line) => lines.push(line));
  try {
    await client.query("begin");
    await client.query(
      "insert into accounts (username, phone_hash, password_hash, consented_at, origin) values ($1, $1, 'x', now(), 'test')",
      [`${tag}_before_mark`],
    );
    assert.equal(await markProductionDatabase(client, {}), false);   // not a production process: no mark
    assert.equal(await markProductionDatabase(client, { VERCEL_ENV: "production" }), true);
    await assert.rejects(assertTestDataAllowedHere("the demo loader", client, {}), /marked as production/);
    await client.query("savepoint s");
    await assert.rejects(
      client.query("insert into accounts (username, phone_hash, password_hash, consented_at, origin) values ($1, $1, 'x', now(), 'test')", [`${tag}_after_mark`]),
      /production database/,
    );
    await client.query("rollback to savepoint s");
    // The deploy and start-up check: loud about the test account already there, and about a preview on this database.
    const report = await checkDatabaseProvenance(client, { VERCEL_ENV: "preview" });
    assert.ok(report.productionDatabase);
    assert.ok(report.problems.some((p) => p.startsWith("PRODUCTION DATABASE HOLDS TEST DATA")));
    assert.ok(report.problems.some((p) => p.startsWith("A PREVIEW IS CONNECTED TO THE PRODUCTION DATABASE")));
    assert.ok(lines.some((l) => JSON.parse(l).level === "error" && JSON.parse(l).msg.includes("HOLDS TEST DATA")));
  } finally {
    restore();
    await client.query("rollback");
    client.release();
  }
  // Unmarked again: the rollback took the mark with it.
  assert.equal((await checkDatabaseProvenance(pool, {})).productionDatabase, false);
});

// ---------- Seed data ----------

test("seed files: JSON and CSV parse, and bad rows are all reported before anything loads", async () => {
  assert.deepEqual(parseCsvRows('a,b\r\n"x, ""y""",2\n\n'), [["a", "b"], ['x, "y"', "2"]]);
  const csv = parseSeedCsv('account,question,value,cast_at\ns1,"Is it, really?",TRUE,2026-11-01T00:00:00Z\n');
  assert.deepEqual(csv.votes[0], { account: "s1", questionId: undefined, question: "Is it, really?", value: "true", castAt: new Date("2026-11-01T00:00:00Z") });
  assert.throws(() => parseSeedFile("seed.txt", "{}"), SeedFileError);
  assert.throws(() => parseSeedJson("not json"), SeedFileError);
  const bad = (() => {
    try {
      parseSeedJson(JSON.stringify({ votes: [
        { account: "bad key!", questionId: 1, value: "true" },
        { account: "ok", value: "maybe" },
        { account: "ok", questionId: 1, value: "true", castAt: "2999-01-01T00:00:00Z" },
      ] }));
    } catch (err) {
      return err as SeedFileError;
    }
  })();
  assert.ok(bad instanceof SeedFileError);
  assert.equal(bad.problems.length, 4);   // bad key; no question; bad value; future castAt

  // Problems found against the database (unknown or closed questions, an answer given twice)
  // stop the whole file.
  const [, , , , , closedQ] = questions;
  await query("update questions set status = 'archived', archived_at = now() where id = $1", [closedQ]);
  await assert.rejects(
    loadSeed({ accounts: [], votes: [
      { account: "s-bad", questionId: 2_000_000_000, value: "true" },
      { account: "s-bad", questionId: closedQ, value: "true" },
      { account: "s-twice", questionId: questions[2], value: "true" },
      { account: "s-twice", question: `P1 provenance fixture ${tag} 3?`, value: "false" },
    ] }),
    (err: SeedFileError) => err instanceof SeedFileError && err.problems.length === 3,
  );
  assert.equal((await originCounts("seed")).accounts, 0);
});

test("seed load is idempotent, refuses production without SEED_ALLOW, and seed:remove restores counters exactly", async () => {
  const [q1, q2, q3] = questions.slice(2, 5);
  // Real answers already there, which must be untouched.
  const people = [await makeAccount(), await makeAccount(), await makeAccount()];
  await query(
    "insert into votes (account_id, question_id, value) values ($1, $4, 'true'), ($2, $4, 'false'), ($3, $5, 'unsure')",
    [people[0].id, people[1].id, people[2].id, q1, q2],
  );
  const beforeSeed = await Promise.all([q1, q2, q3].map(counts));

  await assert.rejects(assertSeedLoadAllowed({ VERCEL_ENV: "production" }), /SEED_ALLOW=1/);
  await assert.doesNotReject(assertSeedLoadAllowed({ VERCEL_ENV: "production", SEED_ALLOW: "1" }));
  await assert.rejects(loadSeed({ accounts: [], votes: [] }, { NODE_ENV: "production" }), /SEED_ALLOW=1/);

  const file = parseSeedJson(JSON.stringify({
    accounts: [{ key: "launch-1", createdAt: "2026-11-01T12:00:00Z" }],
    votes: [
      { account: "launch-1", questionId: q1, value: "true", castAt: "2026-11-02T09:00:00Z" },
      { account: "launch-1", question: `P1 provenance fixture ${tag} 4?`, value: "false", castAt: "2026-11-03T09:00:00Z" },
      { account: "launch-2", questionId: q1, value: false },
      { account: "launch-2", questionId: q3, value: "unsure" },
      { account: "launch-3", questionId: q3, value: "true", castAt: "2026-10-20T08:00:00Z" },
    ],
  }));
  const first = await loadSeed(file, {});
  assert.deepEqual(first, { accountsCreated: 3, accountsExisting: 0, votesAdded: 5, votesAlreadyPresent: 0, votesKept: 0 });
  const again = await loadSeed(file, {});
  assert.deepEqual(again, { accountsCreated: 0, accountsExisting: 3, votesAdded: 0, votesAlreadyPresent: 5, votesKept: 0 });
  // A later version of the file that changes an answer leaves the loaded one as it was.
  file.votes[0].value = "unsure";
  assert.equal((await loadSeed(file, {})).votesKept, 1);

  assert.deepEqual(await originCounts("seed"), { accounts: 3, votes: 5, events: 5, skips: 0 });
  assert.deepEqual(await counts(q1), { t: beforeSeed[0].t + 1, f: beforeSeed[0].f + 1, u: beforeSeed[0].u });
  const seeded = await query<{ username: string; origin: string; created_at: Date; password_hash: string }>(
    "select username, origin, created_at, password_hash from accounts where seed_key = 'launch-1'",
  );
  assert.equal(seeded[0].origin, "seed");
  assert.match(seeded[0].username, /^[a-z]+_[a-z]+\d{1,3}$/);
  assert.equal(seeded[0].created_at.toISOString(), "2026-11-01T12:00:00.000Z");
  assert.ok(!seeded[0].password_hash.includes(":"));   // never signs in
  const events = await query<{ origin: string; source: string; created_at: Date }>(
    "select e.origin, e.source, e.created_at from vote_events e join accounts a on a.id = e.account_id where a.seed_key = 'launch-1' order by e.created_at",
  );
  assert.deepEqual(events.map((e) => [e.origin, e.source, e.created_at.toISOString()]), [
    ["seed", "seed", "2026-11-02T09:00:00.000Z"], ["seed", "seed", "2026-11-03T09:00:00.000Z"],
  ]);
  // A skip by a seed account goes with it too.
  await query("insert into skips (account_id, question_id) select id, $1 from accounts where seed_key = 'launch-3'", [q1]);

  // The dry run changes nothing.
  const dry = await removeOrigin("seed", { dryRun: true });
  assert.deepEqual(dry.removed, { accounts: 3, votes: 5, events: 5, skips: 1 });
  assert.equal((await originCounts("seed")).accounts, 3);

  const removed = await removeOrigin("seed");
  assert.deepEqual(removed.removed, { accounts: 3, votes: 5, events: 5, skips: 1 });
  assert.equal(removed.countersChecked, 3);
  assert.equal(removed.daysRolledUp, 4);
  assert.deepEqual(await originCounts("seed"), { accounts: 0, votes: 0, events: 0, skips: 0 });
  assert.equal(await seedDataPresent(), false);
  const afterRemoval = await Promise.all([q1, q2, q3].map(counts));
  assert.deepEqual(afterRemoval, beforeSeed);
  for (const q of [q1, q2, q3]) assert.deepEqual(await counts(q), await countedFromVotes(q));
  // The real answers are all still there.
  assert.equal((await query("select 1 from votes where account_id = any($1::int[])", [people.map((p) => p.id)])).length, 3);
  await query("delete from votes where account_id = any($1::int[])", [people.map((p) => p.id)]);
});

// ---------- Never sold, never served to keys while seed remains ----------

const ctx = (): ConsentContext => ({ gpc: false, region: OPEN, surface: "web", lang: "en" });
async function agreeAndOptIn(account: Account) {
  for (const choice of ["answering", "sale"] as const) {
    const text = await currentText(choice, "en");
    const r = await recordConsent({ accountId: account.id, choice, granted: true, version: text!.version, lang: "en" }, ctx());
    assert.ok(r.ok);
  }
  await query("update accounts set region = $2 where id = $1", [account.id, OPEN]);
}

test("sale exports never include test or seed accounts, and refuse to run while seed data remains", async () => {
  const q = questions[1];
  const person = await makeAccount("real");
  const tester = await makeAccount("test");
  const seed = await makeSeedAccount();
  for (const a of [person, tester, seed]) {
    await agreeAndOptIn(a);
    await query("insert into votes (account_id, question_id, value) values ($1, $2, 'true')", [a.id, q]);
  }

  // The eligible-accounts query and the export query each leave test and seed out.
  const eligible = (await query<{ id: number }>(`select id from (${SALE_ELIGIBLE_ACCOUNTS}) e where id = any($1::int[])`, [[person.id, tester.id, seed.id]])).map((r) => r.id);
  assert.deepEqual(eligible, [person.id]);
  const exported = await query<{ account_id: number }>(SALE_EXPORT_SQL, [[q], 1000]);
  assert.deepEqual(exported.map((r) => r.account_id), [person.id]);

  // And the export itself refuses outright while any seed data exists.
  const salt = "a-fresh-random-salt-for-this-export";
  await assert.rejects(saleExportRows({ salt, questionIds: [q] }), SeedDataPresent);
  await assert.rejects(assertNoSeedData(), { message: SEED_DATA_PRESENT_MESSAGE });

  await removeOrigin("seed");
  const rows = await saleExportRows({ salt, questionIds: [q] });
  assert.equal(rows.length, 1);
  await query("delete from votes where question_id = $1", [q]);
});

test("keyed stats answer 503 while seed data exists and work once it is removed", async () => {
  const q = questions[0];
  const keyed = () =>
    statsGET(new Request(`http://localhost/api/questions/${q}/stats`, { headers: { authorization: `Bearer ${KEY}` } }), {
      params: Promise.resolve({ id: String(q) }),
    });
  const seed = await makeSeedAccount();
  await query("insert into votes (account_id, question_id, value) values ($1, $2, 'true')", [seed.id, q]);

  const closed = await keyed();
  assert.equal(closed.status, 503);
  assert.deepEqual(await closed.json(), { error: "seed data still present; data sales open after it is removed" });

  await removeOrigin("seed");
  const open = await keyed();
  assert.equal(open.status, 200);
  const body = await open.json();
  assert.equal(body.access, "api");
  assert.equal(body.question.id, q);
});
