// W1 job queue: enqueue, claim with skip locked, retries with backoff, dead jobs, recurring
// jobs, taking back a dead worker's job, and the partition and rollup handlers. Every test
// uses its own job kinds, so nothing here picks up another test's jobs.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pool, query } from "../lib/db";
import {
  PARTITIONS_JOB, ROLLUP_JOB, claim, deadJobs, drain, enqueue, enqueueOnce, ensureVoteEventPartitions, getJob,
  reapExpired, registerDefaultHandlers, registerHandler, rollupDay, runOne, scheduleRecurring, utcDay,
} from "../lib/jobs";
import { vote } from "../lib/vote-engine";
import type { Account } from "../lib/auth";

const tag = `w1j${Date.now().toString(36)}`;
const kind = (name: string) => `w1test.${tag}.${name}`;
const now0 = () => 0;

let voter: Account;
const questionIds: number[] = [];

before(async () => {
  const [row] = await query<{ id: number }>(
    `insert into accounts (username, phone_hash, password_hash, consented_at, tier)
     values ($1, $1, 'x', now(), 'paid') returning id`,
    [`${tag}_voter`],
  );
  voter = { id: row.id, username: `${tag}_voter`, tier: "paid", verified: false, role: "user" };
});

after(async () => {
  await query("delete from jobs where kind like $1", [`w1test.${tag}.%`]);
  await query("delete from question_daily_stats where question_id = any($1::int[])", [questionIds]);
  await query("delete from questions where id = any($1::int[])", [questionIds]);
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await pool.end();
});

test("a queued job runs once with its payload and is marked done", async () => {
  const k = kind("echo");
  const seen: unknown[] = [];
  registerHandler(k, async (payload) => {
    seen.push(payload);
  });
  const id = await enqueue(k, { hello: "world" });
  const r = await runOne({ kinds: [k] });
  assert.equal(r.status, "done");
  assert.deepEqual(seen, [{ hello: "world" }]);
  const job = await getJob(id);
  assert.ok(job?.done_at);
  assert.equal(job?.attempts, 1);
  assert.equal(job?.locked_by, null);
  assert.equal((await runOne({ kinds: [k] })).status, "idle");
});

test("a job set for later waits until then", async () => {
  const k = kind("later");
  registerHandler(k, async () => {});
  const id = await enqueue(k, {}, new Date(Date.now() + 3600_000));
  assert.equal((await runOne({ kinds: [k] })).status, "idle");
  await query("update jobs set run_at = now() where id = $1", [id]);
  assert.equal((await runOne({ kinds: [k] })).status, "done");
});

test("a failing job is retried with backoff, keeps its last error, and dies at max_attempts", async () => {
  const k = kind("flaky");
  let calls = 0;
  registerHandler(k, async () => {
    calls++;
    throw new Error(`boom ${calls}`);
  });
  const id = await enqueue(k, {}, null, { maxAttempts: 3 });

  // Default backoff: the job goes into the future, so nothing is due right after a failure.
  const first = await runOne({ kinds: [k] });
  assert.equal(first.status, "failed");
  assert.ok(first.status === "failed" && !first.dead);
  let job = await getJob(id);
  assert.equal(job?.attempts, 1);
  assert.match(job?.last_error ?? "", /boom 1/);
  assert.ok(job!.run_at.getTime() > Date.now() + 5_000, "backed off by several seconds");
  assert.equal(job?.locked_at, null);
  assert.equal((await runOne({ kinds: [k] })).status, "idle");

  // With no backoff it comes straight back, and dies on its third try.
  await query("update jobs set run_at = now() where id = $1", [id]);
  const rest = await drain({ kinds: [k], backoff: now0 });
  assert.deepEqual(rest.map((r) => r.status), ["failed", "failed"]);
  assert.ok(rest[1].status === "failed" && rest[1].dead);
  job = await getJob(id);
  assert.equal(job?.attempts, 3);
  assert.equal(job?.done_at, null);
  assert.match(job?.last_error ?? "", /boom 3/);
  assert.equal(calls, 3);
  assert.equal((await runOne({ kinds: [k], backoff: now0 })).status, "idle", "a dead job is never claimed again");
  assert.ok((await deadJobs(500)).some((j) => j.id === id));
});

test("backoff grows with each try and is capped", async () => {
  const { backoffSeconds } = await import("../lib/jobs");
  const a1 = backoffSeconds(1);
  const a4 = backoffSeconds(4);
  assert.ok(a1 >= 8 && a1 <= 12, `first retry ~10s, got ${a1}`);
  assert.ok(a4 >= 64 && a4 <= 96, `fourth retry ~80s, got ${a4}`);
  assert.ok(backoffSeconds(30) <= 3600 * 1.2);
});

test("a job of a kind nobody handles fails with a clear error", async () => {
  const k = kind("orphan");
  const id = await enqueue(k, {}, null, { maxAttempts: 1 });
  const r = await runOne({ kinds: [k] });
  assert.ok(r.status === "failed" && r.dead);
  assert.match((await getJob(id))?.last_error ?? "", /no handler registered/);
});

test("workers claiming at once never take the same job (skip locked)", async () => {
  const k = kind("many");
  const runs = new Map<number, number>();
  registerHandler(k, async (_payload, job) => {
    runs.set(job.id, (runs.get(job.id) ?? 0) + 1);
    await new Promise((r) => setTimeout(r, 5));
  });
  const ids = [];
  for (let i = 0; i < 40; i++) ids.push(await enqueue(k, { i }));
  // Six workers drain the queue together.
  await Promise.all(Array.from({ length: 6 }, (_, w) => drain({ kinds: [k], workerId: `${tag}-w${w}` })));
  assert.equal(runs.size, 40);
  assert.ok([...runs.values()].every((n) => n === 1), "every job ran exactly once");
  const [{ n }] = await query<{ n: number }>(
    "select count(*)::int as n from jobs where kind = $1 and done_at is not null and attempts = 1",
    [k],
  );
  assert.equal(n, 40);

  // And two raw claims racing for a single job: one wins.
  await enqueue(k, {});
  const both = await Promise.all([claim(`${tag}-a`, [k]), claim(`${tag}-b`, [k])]);
  assert.equal(both.filter(Boolean).length, 1);
});

test("a recurring job is queued once and queues its next run after it finishes", async () => {
  const k = kind("tick");
  let ticks = 0;
  registerHandler(k, async () => {
    ticks++;
  }, { everySeconds: 600 });
  await scheduleRecurring([k]);
  await scheduleRecurring([k]);
  assert.equal(await enqueueOnce(k), null, "one is already waiting");
  const waiting = await query("select 1 from jobs where kind = $1 and done_at is null", [k]);
  assert.equal(waiting.length, 1);

  assert.equal((await runOne({ kinds: [k] })).status, "done");
  assert.equal(ticks, 1);
  const [next] = await query<{ run_at: Date }>("select run_at from jobs where kind = $1 and done_at is null", [k]);
  assert.ok(next, "the next run is queued");
  const ahead = next.run_at.getTime() - Date.now();
  assert.ok(ahead > 590_000 && ahead <= 600_000, `about ten minutes ahead, got ${ahead}ms`);
});

test("a job held by a worker that stopped is taken back after its lease", async () => {
  const k = kind("lost");
  let ran = 0;
  registerHandler(k, async () => {
    ran++;
  });
  const id = await enqueue(k, {});
  const claimed = await claim(`${tag}-crashed`, [k]);
  assert.equal(claimed?.id, id);
  assert.equal((await runOne({ kinds: [k] })).status, "idle", "still locked");
  await query("update jobs set locked_at = now() - interval '10 minutes' where id = $1", [id]);
  assert.ok((await reapExpired(300, now0)) >= 1);
  const job = await getJob(id);
  assert.equal(job?.locked_by, null);
  assert.match(job?.last_error ?? "", /did not finish/);
  assert.equal((await runOne({ kinds: [k] })).status, "done");
  assert.equal(ran, 1);
  assert.equal((await getJob(id))?.attempts, 2);
});

test("the partition job keeps months ahead of time", async () => {
  registerDefaultHandlers();
  const created = await ensureVoteEventPartitions(3);
  assert.ok(created >= 0);
  const month = (offset: number) => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + offset);
    return `vote_events_p${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const names = await query<{ relname: string }>(
    `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'vote_events'::regclass`,
  );
  const have = new Set(names.map((n) => n.relname));
  for (const offset of [0, 1, 2, 3]) assert.ok(have.has(month(offset)), `${month(offset)} exists`);
  assert.ok(have.has("vote_events_default"));
  // Running it again creates nothing new.
  assert.equal(await ensureVoteEventPartitions(3), 0);
  // The job itself runs through the queue (any queued copy is left for the real worker).
  const id = await enqueue(PARTITIONS_JOB, { monthsAhead: 2 });
  await query("update jobs set kind = $2 where id = $1", [id, kind("partitions")]);
  const { handlerFor } = await import("../lib/jobs");
  registerHandler(kind("partitions"), handlerFor(PARTITIONS_JOB)!.handler);
  assert.equal((await runOne({ kinds: [kind("partitions")] })).status, "done");
});

test("the rollup job counts a day's activity per question from the history", async () => {
  registerDefaultHandlers();
  const ids: number[] = [];
  for (const name of ["a", "b"]) {
    const [row] = await query<{ id: number }>(
      "insert into questions (text, normalized) values ($1, $1) returning id",
      [`${tag} rollup question ${name}`],
    );
    ids.push(row.id);
    questionIds.push(row.id);
  }
  const others: Account[] = [];
  for (let i = 0; i < 3; i++) {
    const [row] = await query<{ id: number }>(
      `insert into accounts (username, phone_hash, password_hash, consented_at, tier)
       values ($1, $1, 'x', now(), 'free') returning id`,
      [`${tag}_r${i}`],
    );
    others.push({ id: row.id, username: `${tag}_r${i}`, tier: "free", verified: false, role: "user" });
  }
  for (const a of [voter, ...others.slice(0, 2)]) await vote({ account: a, questionId: ids[0], value: "true", surface: "web" });
  await vote({ account: others[2], questionId: ids[0], value: "false", surface: "web" });
  await vote({ account: voter, questionId: ids[0], value: "unsure", surface: "web" }); // a change
  await vote({ account: others[0], questionId: ids[1], value: "skip", surface: "web" });

  await rollupDay(utcDay(new Date()));
  const rows = await query<Record<string, number>>(
    `select question_id, casts, changes, deletes, skips, answered_true, answered_false, answered_unsure, voters
       from question_daily_stats where question_id = any($1::int[]) and day = (now() at time zone 'utc')::date
      order by question_id`,
    [ids],
  );
  assert.deepEqual(rows, [
    { question_id: ids[0], casts: 4, changes: 1, deletes: 0, skips: 0, answered_true: 3, answered_false: 1, answered_unsure: 1, voters: 4 },
    { question_id: ids[1], casts: 0, changes: 0, deletes: 0, skips: 1, answered_true: 0, answered_false: 0, answered_unsure: 0, voters: 0 },
  ]);
  // Rolling up again gives the same rows, not double.
  await rollupDay(utcDay(new Date()));
  const again = await query<{ casts: number }>(
    "select casts from question_daily_stats where question_id = $1 and day = (now() at time zone 'utc')::date",
    [ids[0]],
  );
  assert.deepEqual(again, [{ casts: 4 }]);
  await assert.rejects(rollupDay("2026-13-45"), /bad day/);
  assert.ok(ROLLUP_JOB);
});
