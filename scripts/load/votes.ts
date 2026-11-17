// Load test for the vote engine. Drives lib/vote-engine.ts vote() directly (no HTTP) from
// many accounts at once at a target rate, then checks the data is still exactly right:
//
//   1. No double spends: no free account casts more than 100 new votes in a day, accounts
//      racing past the limit get exactly what is left, skips use none of it, and no vote is
//      changed more than once in a day.
//   2. The counters on each question equal the votes table.
//   3. Every vote has its events: a cast, the latest answer matching the vote and its language,
//      and the change count matching the change events.
//   4. Closed questions: after a question is archived or removed mid-run, nothing more lands on it.
//   5. Every call got the outcome its script expected (cast, same, changed, change_used, skipped,
//      closed, limit_reached) and nothing threw.
//
// Prints a summary and exits 1 if any check fails. Uses only Node built-ins and the app's own
// modules, against DATABASE_URL. It makes its own accounts (test data, origin 'test') and
// questions (tagged) and deletes them afterwards unless --keep is given. It refuses to run in
// production or against a database marked as production (lib/provenance.ts).
//
//   npm run load:votes -- --rate=1000 --seconds=10
//
// Options: --rate=1000 (vote calls a second), --seconds=10, --pool=32 (database connections),
// --concurrency=256 (calls in flight), --per-account=25 (calls per ordinary account),
// --greedy=20 (accounts that race past the daily limit),
// --paid=10, --keep, --require-rate (also fail if the achieved rate is under 90% of the target).

import { performance } from "node:perf_hooks";
import type { Account } from "../../lib/auth";
import type { Choice, VoteInput, VoteOutcome } from "../../lib/vote-engine";

// ---------- Options ----------
const arg = (name: string, fallback: number) => {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a number`);
  return n;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const RATE = arg("rate", 1000);
const SECONDS = arg("seconds", 10);
const POOL = arg("pool", 32);
const CONCURRENCY = arg("concurrency", 256);
const GREEDY = arg("greedy", 20);
const PAID = arg("paid", 10);
const KEEP = flag("keep");
const REQUIRE_RATE = flag("require-rate");

// The pool size is read when lib/db loads, so set it before importing anything that uses it.
process.env.PG_POOL_MAX = String(POOL);

const FREE_LIMIT = 100;          // lib/limits.ts, free tier
// Calls per ordinary account in the run (at most 55, under the per-account ceiling of 60 calls
// a minute). Fewer calls per account means more accounts, closer to real traffic.
const PER_ACCOUNT_CALLS = Math.min(55, Math.max(8, arg("per-account", 25)));
const GREEDY_PRESEED = 70;       // votes a greedy account has already used before the run
const GREEDY_BURST = 45;         // new votes it then tries all at once (only 30 can count)
const GREEDY_SKIPS = 10;         // skips mixed into the burst (must use none of the allowance)
const CLOSED_COUNT = 5;          // questions archived (3) or removed (2) halfway through
const LANGS = ["en", "es", "fr", "de", "pt-BR", "ja", null];

// ---------- Small helpers ----------
let seed = 20261117;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const shuffle = <T>(xs: T[]): T[] => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
};
const VALUES = ["true", "false", "unsure"] as const;
const otherValue = (v: (typeof VALUES)[number]) => VALUES.filter((x) => x !== v);

// A token bucket: take() resolves at the target rate, evenly, with at most a tenth of a second
// of burst.
class RateGate {
  private tokens = 0;
  private waiters: (() => void)[] = [];
  private timer: NodeJS.Timeout;
  constructor(perSecond: number) {
    const tick = 5;
    const perTick = (perSecond * tick) / 1000;
    const cap = Math.max(1, perSecond / 10);
    this.timer = setInterval(() => {
      this.tokens = Math.min(cap, this.tokens + perTick);
      while (this.tokens >= 1 && this.waiters.length) {
        this.tokens -= 1;
        this.waiters.shift()!();
      }
    }, tick);
  }
  take(): Promise<void> {
    if (this.tokens >= 1 && !this.waiters.length) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  stop() {
    clearInterval(this.timer);
  }
}

type Expect = Array<VoteOutcome["outcome"]>;
type Call = {
  account: Account;
  questionId: number;
  value: Choice;
  lang: string | null;
  key?: string;
  expect: Expect;           // outcomes that are right for this call (before any question closes)
  startedAt?: number;
  ms?: number;
  outcome?: VoteOutcome["outcome"];
  error?: string;
};
// A task is a few calls for one account and one question, run in order; a group inside it
// runs at once (racing changes, a retried request, a greedy account's burst).
type Step = Call | Call[];
type Task = { name: string; steps: Step[] };

async function main() {
  const { pool, query } = await import("../../lib/db");
  const { vote } = await import("../../lib/vote-engine");
  const { castVote } = await import("../../lib/votes");
  const { clearSplitCache } = await import("../../lib/stats");
  const { assertTestDataAllowedHere } = await import("../../lib/provenance");
  await assertTestDataAllowedHere("The vote load test");

  const tag = `load${Date.now().toString(36)}`;
  const totalCalls = Math.round(RATE * SECONDS);
  const greedyCalls = GREEDY * (GREEDY_BURST + GREEDY_SKIPS);
  const normalCount = Math.max(10, Math.ceil(Math.max(0, totalCalls - greedyCalls) / PER_ACCOUNT_CALLS));
  const questionCount = Math.max(400, GREEDY_PRESEED + GREEDY_BURST + GREEDY_SKIPS + CLOSED_COUNT + 50);
  const log = (line: string) => console.log(line);
  log(`load test ${tag}: target ${RATE} calls/s for ${SECONDS}s (${totalCalls} calls), ` +
      `${normalCount} free + ${PAID} paid + ${GREEDY} limit-racing accounts, ${questionCount} questions, ` +
      `pool ${POOL}, ${CONCURRENCY} in flight`);

  // ---------- Setup ----------
  const t0 = performance.now();
  const qRows = await query<{ id: number }>(
    `insert into questions (text, normalized)
     select $1 || ' load question ' || i, $1 || ' load question ' || i from generate_series(1, $2::int) i
     returning id`,
    [tag, questionCount],
  );
  const questions = qRows.map((r) => r.id);
  const closedSet = questions.slice(0, CLOSED_COUNT);
  const openQuestions = questions.slice(CLOSED_COUNT);

  async function makeAccounts(kind: string, count: number, tier: "free" | "paid"): Promise<Account[]> {
    const rows = await query<{ id: number; username: string }>(
      `insert into accounts (username, phone_hash, password_hash, consented_at, tier, origin)
       select $1 || '_' || $2 || i, $1 || '_' || $2 || i, 'x', now(), $3, 'test' from generate_series(1, $4::int) i
       returning id, username`,
      [tag, kind, tier, count],
    );
    return rows.map((r) => ({ id: r.id, username: r.username, tier, verified: false, role: "user" }));
  }
  const normal = await makeAccounts("n", normalCount, "free");
  const paid = await makeAccounts("p", PAID, "paid");
  const greedy = await makeAccounts("g", GREEDY, "free");
  const accountIds = [...normal, ...paid, ...greedy].map((a) => a.id);

  // Greedy accounts have already used 70 of today's 100 votes (real votes, with their events).
  // Each works through its own shuffled list of questions.
  const greedyQuestions = new Map(greedy.map((a) => [a.id, shuffle([...openQuestions])]));
  await Promise.all(greedy.map(async (a) => {
    for (const q of greedyQuestions.get(a.id)!.slice(0, GREEDY_PRESEED)) {
      const r = await castVote(a, q, pick(VALUES), false, "direct", { lang: "en" });
      if (!r.ok) throw new Error(`preseed failed: ${r.error}`);
    }
  }));
  log(`setup ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  // ---------- The script ----------
  const tasks: Task[] = [];
  const call = (account: Account, questionId: number, value: Choice, expect: Expect, extra: Partial<Call> = {}): Call =>
    ({ account, questionId, value, lang: pick(LANGS), expect, ...extra });

  for (const a of [...normal, ...paid]) {
    const qs = shuffle([...openQuestions]);
    let budget = PER_ACCOUNT_CALLS - 2;
    // One probe on a question that closes halfway through: cast, then change.
    const probeQ = pick(closedSet);
    const first = pick(VALUES);
    tasks.push({ name: "probe", steps: [call(a, probeQ, first, ["cast"]), call(a, probeQ, otherValue(first)[0], ["changed"])] });
    let i = 0;
    while (budget > 0) {
      const q = qs[i++];
      const v = pick(VALUES);
      const r = rand();
      if (r < 0.3 || budget < 3) {
        tasks.push({ name: "cast", steps: [call(a, q, v, ["cast"])] });
        budget -= 1;
      } else if (r < 0.45) {
        tasks.push({ name: "same", steps: [call(a, q, v, ["cast"]), call(a, q, v, ["same"])] });
        budget -= 2;
      } else if (r < 0.6) {
        const [x, y] = otherValue(v);
        tasks.push({ name: "change-twice", steps: [call(a, q, v, ["cast"]), call(a, q, x, ["changed"]), call(a, q, y, ["change_used"])] });
        budget -= 3;
      } else if (r < 0.72) {
        // Two different changes at once: exactly one counts.
        const [x, y] = otherValue(v);
        tasks.push({ name: "race-change", steps: [call(a, q, v, ["cast"]), [call(a, q, x, ["changed", "change_used"]), call(a, q, y, ["changed", "change_used"])]] });
        budget -= 3;
      } else if (r < 0.82) {
        tasks.push({ name: "skip-then-vote", steps: [call(a, q, "skip", ["skipped"]), call(a, q, v, ["cast"])] });
        budget -= 2;
      } else if (r < 0.9) {
        tasks.push({ name: "skip", steps: [call(a, q, "skip", ["skipped"])] });
        budget -= 1;
      } else {
        // A platform retrying the same request at once: one vote, whatever the order.
        const key = `${tag}:${a.id}:${q}`;
        tasks.push({ name: "retry", steps: [[call(a, q, v, ["cast", "same"], { key }), call(a, q, v, ["cast", "same"], { key })]] });
        budget -= 2;
      }
    }
  }
  // Greedy accounts: 45 new votes and 10 skips, in waves of BURST_WAVE at once. 30 votes fit
  // in what's left. (All 55 at once would park most of the connection pool on one account's
  // lock, which measures the pool, not the engine; eight at once still races.)
  const BURST_WAVE = 8;
  for (const a of greedy) {
    const mine = greedyQuestions.get(a.id)!;
    const fresh = mine.slice(GREEDY_PRESEED, GREEDY_PRESEED + GREEDY_BURST);
    const skips = mine.slice(GREEDY_PRESEED + GREEDY_BURST, GREEDY_PRESEED + GREEDY_BURST + GREEDY_SKIPS);
    const burst = shuffle([
      ...fresh.map((q) => call(a, q, pick(VALUES), ["cast", "limit_reached"])),
      ...skips.map((q) => call(a, q, "skip", ["skipped"])),
    ]);
    const steps: Call[][] = [];
    for (let i = 0; i < burst.length; i += BURST_WAVE) steps.push(burst.slice(i, i + BURST_WAVE));
    tasks.push({ name: "greedy-burst", steps });
  }
  shuffle(tasks);
  const allCalls: Call[] = tasks.flatMap((t) => t.steps.flat());

  // ---------- Run ----------
  clearSplitCache();
  const gate = new RateGate(RATE);
  let issued = 0;
  let closedAtMs = 0;          // performance.now() once the archive and removal committed
  let closedAtDb: Date | null = null;
  let closing: Promise<void> | null = null;
  const closeHalfway = () => {
    if (closing || issued < allCalls.length / 2) return;
    closing = (async () => {
      await query("update questions set status = 'archived', archived_at = now() where id = any($1::int[])", [closedSet.slice(0, 3)]);
      await query("update questions set status = 'removed' where id = any($1::int[])", [closedSet.slice(3)]);
      closedAtMs = performance.now();
      closedAtDb = (await query<{ at: Date }>("select now() as at"))[0].at;
    })();
  };

  async function run(c: Call) {
    await gate.take();
    issued++;
    closeHalfway();
    c.startedAt = performance.now();
    const input: VoteInput = {
      account: c.account, questionId: c.questionId, value: c.value, surface: "web", lang: c.lang,
      idempotencyKey: c.key ?? null,
    };
    try {
      c.outcome = (await vote(input)).outcome;
    } catch (err) {
      c.error = (err as Error).message;
    }
    c.ms = performance.now() - c.startedAt;
  }

  let next = 0;
  const runStart = performance.now();
  const progress = setInterval(() => {
    const s = (performance.now() - runStart) / 1000;
    log(`  ${s.toFixed(0)}s: ${issued}/${allCalls.length} calls, ${(issued / s).toFixed(0)}/s`);
  }, 2000);
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      for (const step of task.steps) {
        if (Array.isArray(step)) await Promise.all(step.map(run));
        else await run(step);
      }
    }
  }));
  const runSeconds = (performance.now() - runStart) / 1000;
  clearInterval(progress);
  gate.stop();
  await closing;

  // ---------- Checks ----------
  type Check = { name: string; ok: boolean; detail: string };
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // 5. Outcomes, per call and per racing group.
  const closedIds = new Set(closedSet);
  const afterClose = (c: Call) => closedAtMs > 0 && c.startedAt! > closedAtMs;
  const errors = allCalls.filter((c) => c.error);
  const wrong = allCalls.filter((c) => {
    if (c.error) return false;
    if (closedIds.has(c.questionId) && afterClose(c)) return !["closed", "invalid"].includes(c.outcome!);
    // A call that raced the close itself may have been refused; anything else must be as expected.
    if (closedIds.has(c.questionId) && ["closed", "invalid", "change_used"].includes(c.outcome!)) return false;
    return !c.expect.includes(c.outcome!);
  });
  check("no call threw", errors.length === 0, errors.length ? `${errors.length} threw, e.g. ${errors[0].error}` : `${allCalls.length} calls`);
  check("every call got the outcome its script expected", wrong.length === 0,
    wrong.length ? `${wrong.length} unexpected, e.g. ${wrong.slice(0, 3).map((c) => `${c.value}→${c.outcome} (wanted ${c.expect.join("/")})`).join(", ")}` : "all as expected");
  const raceGroups = tasks.flatMap((t) => t.steps.filter((s): s is Call[] => Array.isArray(s) && t.name === "race-change"))
    .filter((g) => !closedIds.has(g[0].questionId));
  const badRaces = raceGroups.filter((g) => g.filter((c) => c.outcome === "changed").length !== 1);
  check("racing changes: exactly one of each pair counts", badRaces.length === 0, `${raceGroups.length} pairs, ${badRaces.length} wrong`);
  const retryGroups = tasks.filter((t) => t.name === "retry").map((t) => t.steps[0] as Call[]);
  const badRetries = retryGroups.filter((g) => g.filter((c) => c.outcome === "cast").length < 1);
  check("retried requests vote once", badRetries.length === 0, `${retryGroups.length} retried pairs, ${badRetries.length} with no vote`);

  // 1. Allowance and the once-a-day change rule.
  const greedyRows = await query<{ id: number; casts: number; skips: number }>(
    `select a.id,
            count(*) filter (where e.action = 'cast')::int as casts,
            count(*) filter (where e.action = 'skip')::int as skips
       from accounts a join vote_events e on e.account_id = a.id
      where a.id = any($1::int[]) group by a.id`,
    [greedy.map((a) => a.id)],
  );
  const greedyOff = greedyRows.filter((r) => r.casts !== FREE_LIMIT || r.skips !== GREEDY_SKIPS);
  const burstOutcomes = tasks.filter((t) => t.name === "greedy-burst").map((t) => t.steps.flat());
  const burstOff = burstOutcomes.filter((g) =>
    g.filter((c) => c.outcome === "cast").length !== FREE_LIMIT - GREEDY_PRESEED ||
    g.filter((c) => c.outcome === "limit_reached").length !== GREEDY_BURST - (FREE_LIMIT - GREEDY_PRESEED));
  check(`limit racers get exactly ${FREE_LIMIT} votes, skips free`, greedyRows.length === GREEDY && greedyOff.length === 0 && burstOff.length === 0,
    `${GREEDY} accounts each tried ${GREEDY_PRESEED}+${GREEDY_BURST} votes and ${GREEDY_SKIPS} skips; ` +
    `${greedyOff.length + burstOff.length} off` + (greedyOff[0] ? ` (e.g. ${greedyOff[0].casts} casts, ${greedyOff[0].skips} skips)` : ""));
  const [{ over }] = await query<{ over: number }>(
    `select count(*)::int as over from (
       select e.account_id from vote_events e join accounts a on a.id = e.account_id
        where a.tier = 'free' and e.action = 'cast'
          and e.created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
        group by e.account_id having count(*) > $1) x`,
    [FREE_LIMIT],
  );
  check(`no free account anywhere has more than ${FREE_LIMIT} votes today`, over === 0, `${over} over`);
  const [{ twice }] = await query<{ twice: number }>(
    `select count(*)::int as twice from (
       select account_id, question_id from vote_events
        where account_id = any($1::int[]) and action in ('change', 'delete')
          and created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
        group by 1, 2 having count(*) > 1) x`,
    [accountIds],
  );
  check("no vote changed more than once today", twice === 0, `${twice} changed twice`);

  // 2. Counters equal the votes table, for every question in the database.
  const [{ drift, checked }] = await query<{ drift: number; checked: number }>(
    `select count(*) filter (where (q.true_count, q.false_count, q.unsure_count)
                              is distinct from (coalesce(v.t, 0), coalesce(v.f, 0), coalesce(v.u, 0)))::int as drift,
            count(*)::int as checked
       from questions q
       left join (select question_id,
                         count(*) filter (where value = 'true')::int as t,
                         count(*) filter (where value = 'false')::int as f,
                         count(*) filter (where value = 'unsure')::int as u
                    from votes group by question_id) v on v.question_id = q.id`,
  );
  check("question counters equal the votes table", drift === 0, `${checked} questions, ${drift} off`);

  // 3. Every vote has its events, and they agree with it.
  const [ev] = await query<{ votes: number; no_cast: number; value_off: number; lang_off: number; changes_off: number; orphans: number }>(
    `with latest as (
       select distinct on (account_id, question_id) account_id, question_id, value, lang
         from vote_events
        where account_id = any($1::int[]) and action in ('cast', 'change')
        order by account_id, question_id, id desc),
     counts as (
       select account_id, question_id,
              count(*) filter (where action = 'cast') as casts,
              count(*) filter (where action = 'change') as changes
         from vote_events where account_id = any($1::int[]) group by 1, 2)
     select count(*)::int as votes,
            count(*) filter (where coalesce(c.casts, 0) = 0)::int as no_cast,
            count(*) filter (where l.value is distinct from v.value)::int as value_off,
            count(*) filter (where l.lang is distinct from v.lang)::int as lang_off,
            count(*) filter (where c.changes is distinct from v.change_count::bigint)::int as changes_off,
            (select count(*)::int from counts c2
              where c2.casts > 0 and not exists (select 1 from votes v2 where v2.account_id = c2.account_id and v2.question_id = c2.question_id)) as orphans
       from votes v
       left join latest l using (account_id, question_id)
       left join counts c using (account_id, question_id)
      where v.account_id = any($1::int[])`,
    [accountIds],
  );
  check("every vote has its events and matches the latest", ev.no_cast + ev.value_off + ev.lang_off + ev.changes_off + ev.orphans === 0,
    `${ev.votes} votes: ${ev.no_cast} without a cast, ${ev.value_off} value, ${ev.lang_off} language, ` +
    `${ev.changes_off} change count off; ${ev.orphans} casts with no vote`);
  // A retried request repeats the first answer, so both copies can say "cast" for one vote:
  // count each retried pair once.
  const retried = new Set(retryGroups.flat());
  const castOutcomes = allCalls.filter((c) => c.outcome === "cast" && !retried.has(c)).length +
    retryGroups.filter((g) => g.some((c) => c.outcome === "cast")).length + GREEDY * GREEDY_PRESEED;
  const changedOutcomes = allCalls.filter((c) => c.outcome === "changed").length;
  const [dbCounts] = await query<{ casts: number; changes: number; skips: number }>(
    `select count(*) filter (where action = 'cast')::int as casts, count(*) filter (where action = 'change')::int as changes,
            count(*) filter (where action = 'skip')::int as skips
       from vote_events where account_id = any($1::int[])`,
    [accountIds],
  );
  const skipOutcomes = allCalls.filter((c) => c.outcome === "skipped").length;
  check("every counted call wrote exactly one event", dbCounts.casts === castOutcomes && dbCounts.changes === changedOutcomes && dbCounts.skips === skipOutcomes,
    `casts ${castOutcomes} reported / ${dbCounts.casts} stored, changes ${changedOutcomes} / ${dbCounts.changes}, skips ${skipOutcomes} / ${dbCounts.skips}`);

  // 4. Closed questions.
  const lateCalls = allCalls.filter((c) => closedIds.has(c.questionId) && afterClose(c));
  const [{ late }] = await query<{ late: number }>(
    "select count(*)::int as late from vote_events where question_id = any($1::int[]) and created_at > $2",
    [closedSet, closedAtDb ?? new Date(8.64e15)],
  );
  check("nothing lands on a question after it closes", closedAtDb !== null && late === 0 && lateCalls.length > 0,
    `${CLOSED_COUNT} closed halfway; ${lateCalls.length} later calls on them all refused; ${late} events after the close`);

  // Throughput.
  const lat = allCalls.map((c) => c.ms ?? 0).sort((a, b) => a - b);
  const pctl = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))].toFixed(1);
  const rate = allCalls.length / runSeconds;
  const writes = allCalls.filter((c) => c.outcome === "cast" || c.outcome === "changed").length;
  check(`rate at least 90% of ${RATE}/s${REQUIRE_RATE ? "" : " (reported only)"}`,
    REQUIRE_RATE ? rate >= RATE * 0.9 : true, `${rate.toFixed(0)}/s`);

  const outcomes = new Map<string, number>();
  for (const c of allCalls) outcomes.set(c.outcome ?? "error", (outcomes.get(c.outcome ?? "error") ?? 0) + 1);

  log("");
  log(`ran ${allCalls.length} vote calls in ${runSeconds.toFixed(2)}s: ${rate.toFixed(0)} calls/s ` +
      `(${(writes / runSeconds).toFixed(0)} writes/s: casts and changes)`);
  log(`latency ms: p50 ${pctl(50)}, p95 ${pctl(95)}, p99 ${pctl(99)}, max ${lat.at(-1)!.toFixed(1)}`);
  log(`outcomes: ${[...outcomes].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  log("");
  for (const c of checks) log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  const failed = checks.filter((c) => !c.ok).length;
  log("");
  log(failed ? `FAILED: ${failed} of ${checks.length} checks` : `PASSED: all ${checks.length} checks`);

  // ---------- Cleanup ----------
  if (!KEEP) {
    await query("delete from vote_requests where account_id = any($1::int[])", [accountIds]);
    await query("delete from accounts where id = any($1::int[])", [accountIds]);
    await query("delete from questions where id = any($1::int[])", [questions]);
  } else {
    log(`kept accounts and questions tagged ${tag}`);
  }
  await pool.end();
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
