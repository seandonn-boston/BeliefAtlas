// W1 data and vote engine: the language a vote was given in, closed questions taking no votes
// or edits (including under a race with the archive), the daily allowance under concurrency,
// monthly partitions of vote_events, the split cache and replica reads.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pool, query } from "../lib/db";
import type { Account } from "../lib/auth";
import { castVote, cleanLang, deleteVote, setVisibility, skip } from "../lib/votes";
import { claimHeldVote, vote } from "../lib/vote-engine";
import { clearSplitCache, closeReplica, invalidateSplits, readQuery, tallies } from "../lib/stats";

const tag = `w1v${Date.now().toString(36)}`;
const questionIds: number[] = [];
let n = 0;

async function makeAccount(tier: "free" | "paid" = "free"): Promise<Account> {
  const username = `${tag}_${n++}`;
  const [row] = await query<{ id: number }>(
    `insert into accounts (username, phone_hash, password_hash, consented_at, tier)
     values ($1, $1, 'x', now(), $2) returning id`,
    [username, tier],
  );
  return { id: row.id, username, tier, verified: false, role: "user" };
}

async function makeQuestions(count: number): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `insert into questions (text, normalized)
     select $1 || ' question ' || i, $1 || ' question ' || i from generate_series($2::int, $2::int + $3::int - 1) i
     returning id`,
    [tag, questionIds.length, count],
  );
  const ids = rows.map((r) => r.id);
  questionIds.push(...ids);
  return ids;
}

const voteRow = (accountId: number, questionId: number) =>
  query<{ value: string; lang: string | null; is_private: boolean }>(
    "select value, lang, is_private from votes where account_id = $1 and question_id = $2",
    [accountId, questionId],
  ).then((r) => r[0] ?? null);

const events = (accountId: number, questionId: number) =>
  query<{ action: string; value: string | null; lang: string | null }>(
    "select action, value, lang from vote_events where account_id = $1 and question_id = $2 order by id",
    [accountId, questionId],
  );

const counters = (questionId: number) =>
  query<{ t: number; f: number; u: number }>(
    "select true_count as t, false_count as f, unsure_count as u from questions where id = $1",
    [questionId],
  ).then((r) => r[0]);

before(async () => {
  clearSplitCache();
});

after(async () => {
  await query("delete from questions where id = any($1::int[])", [questionIds]);
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await closeReplica();
  await pool.end();
});

// ---------- Language ----------

test("language tags are cleaned to one shape", () => {
  assert.equal(cleanLang("en"), "en");
  assert.equal(cleanLang("EN"), "en");
  assert.equal(cleanLang("pt-br"), "pt-BR");
  assert.equal(cleanLang("pt_BR"), "pt-BR");
  assert.equal(cleanLang(" fil "), "fil");
  assert.equal(cleanLang("english"), null);
  assert.equal(cleanLang("en-US-x-foo"), null);
  assert.equal(cleanLang("<script>"), null);
  assert.equal(cleanLang(42), null);
  assert.equal(cleanLang(undefined), null);
});

test("the vote engine records the language the voter saw on the vote and its events", async () => {
  const [q, q2, q3] = await makeQuestions(3);
  const a = await makeAccount();
  assert.equal((await vote({ account: a, questionId: q, value: "true", surface: "web", lang: "es" })).outcome, "cast");
  assert.equal((await voteRow(a.id, q))?.lang, "es");

  // A change records the language of the new answer.
  assert.equal((await vote({ account: a, questionId: q, value: "false", surface: "web", lang: "pt-br" })).outcome, "changed");
  assert.equal((await voteRow(a.id, q))?.lang, "pt-BR");
  assert.deepEqual(await events(a.id, q), [
    { action: "cast", value: "true", lang: "es" },
    { action: "change", value: "false", lang: "pt-BR" },
  ]);

  // Skips carry it too; no language or a bad one is stored as unknown.
  await vote({ account: a, questionId: q2, value: "skip", surface: "web", lang: "fr" });
  assert.deepEqual(await events(a.id, q2), [{ action: "skip", value: null, lang: "fr" }]);
  await vote({ account: a, questionId: q3, value: "unsure", surface: "web", lang: "not a language" });
  assert.equal((await voteRow(a.id, q3))?.lang, null);
  assert.equal((await events(a.id, q3))[0].lang, null);
});

test("a held tap keeps its language until it is counted", async () => {
  const [q] = await makeQuestions(1);
  const held = await vote({ account: null, questionId: q, value: "true", surface: "share", lang: "de" });
  assert.equal(held.outcome, "needs_signup");
  const token = held.outcome === "needs_signup" ? held.holdToken : "";
  const a = await makeAccount();
  assert.equal((await claimHeldVote(token, a))?.outcome, "cast");
  assert.equal((await voteRow(a.id, q))?.lang, "de");
});

// ---------- Closed questions ----------

test("archived questions take no new votes, changes, deletes, skips or publishing", async () => {
  const [q, fresh] = await makeQuestions(2);
  const a = await makeAccount();
  const b = await makeAccount();
  await vote({ account: a, questionId: q, value: "true", surface: "web" });
  await vote({ account: b, questionId: q, value: "false", surface: "web", isPrivate: true });
  await query("update questions set status = 'archived', archived_at = now() where id = $1", [q]);
  const before = await counters(q);

  const c = await makeAccount();
  assert.equal((await vote({ account: c, questionId: q, value: "true", surface: "web" })).outcome, "closed");
  assert.equal((await vote({ account: a, questionId: q, value: "false", surface: "web" })).outcome, "closed");
  assert.equal((await vote({ account: a, questionId: q, value: "true", surface: "web" })).outcome, "closed");
  assert.equal((await vote({ account: c, questionId: q, value: "skip", surface: "web" })).outcome, "closed");
  // Straight to the lower layer too, as the website's server actions do.
  const changed = await castVote(a, q, "unsure", false, "direct");
  assert.ok(!changed.ok && changed.code === "closed");
  const deleted = await deleteVote(a, q, "direct");
  assert.ok(!deleted.ok && deleted.code === "closed");
  assert.equal(await skip(c, q), false);
  // Hiding a vote changes no answer and is still allowed; making one public is not.
  assert.ok((await setVisibility(a, q, true)).ok);
  const shown = await setVisibility(b, q, false);
  assert.ok(!shown.ok && shown.code === "closed");

  assert.deepEqual(await counters(q), before);
  assert.equal((await voteRow(a.id, q))?.value, "true");
  assert.equal((await voteRow(c.id, q)), null);
  assert.deepEqual((await events(c.id, q)), []);
  assert.deepEqual((await events(a.id, q)).map((e) => e.action), ["cast", "visibility"]);
  // Other questions are untouched.
  assert.equal((await vote({ account: c, questionId: fresh, value: "true", surface: "web" })).outcome, "cast");
});

test("removed questions take no votes or edits either", async () => {
  const [q] = await makeQuestions(1);
  const a = await makeAccount();
  await vote({ account: a, questionId: q, value: "true", surface: "web" });
  await query("update questions set status = 'removed' where id = $1", [q]);
  assert.equal((await vote({ account: a, questionId: q, value: "false", surface: "web" })).outcome, "invalid");
  assert.equal((await vote({ account: await makeAccount(), questionId: q, value: "true", surface: "web" })).outcome, "invalid");
  const changed = await castVote(a, q, "false", false, "direct");
  assert.ok(!changed.ok && changed.code === "closed");
  const deleted = await deleteVote(a, q, "direct");
  assert.ok(!deleted.ok && deleted.code === "closed");
  assert.equal((await voteRow(a.id, q))?.value, "true");
  assert.equal((await events(a.id, q)).length, 1);
});

test("a question under review takes no new answers but existing votes can still change", async () => {
  const [q] = await makeQuestions(1);
  const a = await makeAccount();
  await vote({ account: a, questionId: q, value: "true", surface: "web" });
  await query("update questions set status = 'review' where id = $1", [q]);
  assert.equal((await vote({ account: await makeAccount(), questionId: q, value: "true", surface: "web" })).outcome, "closed");
  assert.equal((await vote({ account: a, questionId: q, value: "false", surface: "web" })).outcome, "changed");
});

test("no vote lands after an archive that races it, and counters stay exact", async () => {
  const [q] = await makeQuestions(1);
  const voters = await Promise.all(Array.from({ length: 30 }, () => makeAccount()));
  const results: string[] = [];
  const votes = voters.map((a, i) =>
    new Promise((r) => setTimeout(r, i)).then(() => vote({ account: a, questionId: q, value: i % 2 ? "true" : "false", surface: "web" })),
  );
  const archive = new Promise((r) => setTimeout(r, 12)).then(async () => {
    await query("update questions set status = 'archived', archived_at = now() where id = $1", [q]);
    return query<{ at: Date }>("select now() as at").then((r) => r[0].at);
  });
  const [archivedBy, ...outcomes] = await Promise.all([archive, ...votes]);
  for (const o of outcomes) results.push((o as { outcome: string }).outcome);
  const cast = results.filter((o) => o === "cast").length;
  assert.equal(cast + results.filter((o) => o === "closed").length, voters.length);

  const [rows] = await query<{ votes: number; casts: number; late: number }>(
    `select (select count(*)::int from votes where question_id = $1) as votes,
            (select count(*)::int from vote_events where question_id = $1 and action = 'cast') as casts,
            (select count(*)::int from vote_events where question_id = $1 and created_at > $2) as late`,
    [q, archivedBy],
  );
  assert.equal(rows.votes, cast);
  assert.equal(rows.casts, cast);
  assert.equal(rows.late, 0, "nothing was written after the archive committed");
  const c = await counters(q);
  assert.equal(c.t + c.f + c.u, cast);
});

// ---------- The daily allowance under concurrency ----------

test("a free account racing past its 100 votes gets exactly 100, and skips use none", async () => {
  const ids = await makeQuestions(120);
  const a = await makeAccount("free");
  const skips = await makeQuestions(10);
  const outcomes = await Promise.all([
    ...ids.map((q) => castVote(a, q, "true", false, "direct")),
    ...skips.map((q) => skip(a, q)),
  ]);
  const casts = outcomes.slice(0, ids.length) as Awaited<ReturnType<typeof castVote>>[];
  assert.equal(casts.filter((r) => r.ok).length, 100);
  assert.equal(casts.filter((r) => !r.ok && r.code === "limit_reached").length, 20);
  const [{ cast, skipped }] = await query<{ cast: number; skipped: number }>(
    `select count(*) filter (where action = 'cast')::int as cast, count(*) filter (where action = 'skip')::int as skipped
       from vote_events where account_id = $1`,
    [a.id],
  );
  assert.equal(cast, 100);
  assert.equal(skipped, 10);
});

test("two changes racing on one vote: only one counts", async () => {
  const [q] = await makeQuestions(1);
  const a = await makeAccount();
  await castVote(a, q, "true", false, "direct");
  const [x, y] = await Promise.all([castVote(a, q, "false", false, "direct"), castVote(a, q, "unsure", false, "direct")]);
  assert.equal([x, y].filter((r) => r.ok).length, 1);
  assert.equal([x, y].filter((r) => !r.ok && r.code === "change_used").length, 1);
  assert.equal((await events(a.id, q)).filter((e) => e.action === "change").length, 1);
});

// ---------- Partitions ----------

test("vote_events is partitioned by month and today's votes land in this month", async () => {
  const [{ strategy }] = await query<{ strategy: string }>(
    "select partstrat as strategy from pg_partitioned_table where partrelid = 'vote_events'::regclass",
  );
  assert.equal(strategy, "r");
  const [pk] = await query<{ def: string }>(
    "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'vote_events'::regclass and contype = 'p'",
  );
  assert.equal(pk.def, "PRIMARY KEY (id, created_at)");
  const [q] = await makeQuestions(1);
  const a = await makeAccount();
  await vote({ account: a, questionId: q, value: "true", surface: "web" });
  const d = new Date();
  const month = `vote_events_p${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const [row] = await query<{ part: string }>(
    "select tableoid::regclass::text as part from vote_events where account_id = $1",
    [a.id],
  );
  assert.equal(row.part, month);
  // The check constraints still hold on the partitioned table.
  await assert.rejects(
    query("insert into vote_events (account_id, question_id, action) values ($1, $2, 'bogus')", [a.id, q]),
    /vote_events_action_check/,
  );
});

test("a month with no partition lands in the default one and moves when its month is made", async () => {
  const [q] = await makeQuestions(1);
  const a = await makeAccount();
  const far = "2099-07-15T12:00:00Z";
  try {
    await query(
      "insert into vote_events (account_id, question_id, action, value, created_at) values ($1, $2, 'cast', 'true', $3)",
      [a.id, q, far],
    );
    const where = () =>
      query<{ part: string }>("select tableoid::regclass::text as part from vote_events where account_id = $1", [a.id])
        .then((r) => r.map((x) => x.part));
    assert.deepEqual(await where(), ["vote_events_default"]);
    const [{ made }] = await query<{ made: boolean }>("select vote_events_ensure_partition('2099-07-01') as made");
    assert.equal(made, true);
    assert.deepEqual(await where(), ["vote_events_p2099_07"]);
    const [{ again }] = await query<{ again: boolean }>("select vote_events_ensure_partition('2099-07-31') as again");
    assert.equal(again, false);
  } finally {
    await query("delete from vote_events where account_id = $1", [a.id]);
    await query("drop table if exists vote_events_p2099_07");
  }
});

// ---------- Split cache and replica reads ----------

test("splits are cached briefly and a vote on this instance clears its question", async () => {
  const [q] = await makeQuestions(1);
  clearSplitCache();
  assert.deepEqual((await tallies([q])).get(q), { true: 0, false: 0, unsure: 0, total: 0 });
  // A change made behind the cache's back isn't seen until it expires or is cleared...
  await query("update questions set true_count = 7 where id = $1", [q]);
  assert.equal((await tallies([q])).get(q)?.true, 0);
  invalidateSplits([q]);
  assert.equal((await tallies([q])).get(q)?.true, 7);
  await query("update questions set true_count = 0 where id = $1", [q]);
  invalidateSplits([q]);
  assert.equal((await tallies([q])).get(q)?.total, 0);
  // ...but a vote counted here is seen at once.
  await vote({ account: await makeAccount(), questionId: q, value: "false", surface: "web" });
  assert.deepEqual((await tallies([q])).get(q), { true: 0, false: 1, unsure: 0, total: 1 });
  // Callers get their own copy.
  const mine = (await tallies([q])).get(q)!;
  mine.false = 99;
  assert.equal((await tallies([q])).get(q)?.false, 1);
  // Unknown questions read as empty.
  assert.deepEqual((await tallies([2_000_000_001])).get(2_000_000_001), { true: 0, false: 0, unsure: 0, total: 0 });
});

test("reads go to the replica when one is set, and to the primary if it can't be reached", async () => {
  const saved = process.env.DATABASE_REPLICA_URL;
  try {
    delete process.env.DATABASE_REPLICA_URL;
    assert.deepEqual(await readQuery<{ one: number }>("select 1 as one"), [{ one: 1 }]);

    // A "replica" that is really the primary, under its own pool.
    process.env.DATABASE_REPLICA_URL = process.env.DATABASE_URL;
    const [{ pid }] = await readQuery<{ pid: number }>("select pg_backend_pid() as pid");
    const [primary] = await query<{ pid: number }>("select pg_backend_pid() as pid");
    assert.ok(pid > 0 && primary.pid > 0);
    await assert.rejects(readQuery("select * from no_such_table_w1"), /no_such_table_w1/);

    // Nothing listening: falls back to the primary.
    process.env.DATABASE_REPLICA_URL = "postgres://nobody:nothing@127.0.0.1:1/none";
    assert.deepEqual(await readQuery<{ one: number }>("select 1 as one"), [{ one: 1 }]);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_REPLICA_URL;
    else process.env.DATABASE_REPLICA_URL = saved;
    await closeReplica();
  }
});
