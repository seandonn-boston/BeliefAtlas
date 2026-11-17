import { Pool, type QueryResultRow } from "pg";
import { query } from "./db";
import { MIN_GROUP_SIZE } from "./limits";

// ---------- Reads that may go to a replica ----------
// Stats and exports only read, and can be a moment behind, so they go to a read replica when
// DATABASE_REPLICA_URL is set and to the primary otherwise. If the replica can't be reached
// the read falls back to the primary rather than failing. Anything that must see a write the
// same request just made (a vote, then "your vote") keeps using query() from lib/db.

const globalForReplica = globalThis as unknown as { __beliefatlasReplicaPool?: Pool; __beliefatlasReplicaUrl?: string };

function replicaPool(): Pool | null {
  const url = process.env.DATABASE_REPLICA_URL;
  if (!url) return null;
  if (globalForReplica.__beliefatlasReplicaPool && globalForReplica.__beliefatlasReplicaUrl === url) {
    return globalForReplica.__beliefatlasReplicaPool;
  }
  // The URL changed (or this is the first read): close any pool for the old one.
  globalForReplica.__beliefatlasReplicaPool?.end().catch(() => {});
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.PG_REPLICA_POOL_MAX ?? process.env.PG_POOL_MAX ?? (process.env.VERCEL ? 3 : 10)),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
  // An idle client losing its connection must not crash the process.
  pool.on("error", () => {});
  globalForReplica.__beliefatlasReplicaPool = pool;
  globalForReplica.__beliefatlasReplicaUrl = url;
  return pool;
}

// Errors that mean "couldn't talk to the replica", as opposed to a bad query (which would fail
// on the primary too and is thrown as is). Class 08 is connection exceptions; 57P01-57P03 are
// shutdown and "cannot connect now".
function unreachable(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code !== "string") return true;
  return code.startsWith("08") || /^57P0[123]$/.test(code) || /^E[A-Z]+$/.test(code);
}

export async function readQuery<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const replica = replicaPool();
  if (!replica) return query<T>(text, params);
  try {
    return (await replica.query<T>(text, params)).rows;
  } catch (err) {
    if (!unreachable(err)) throw err;
    return query<T>(text, params);
  }
}

// Closes the replica pool, if one was opened (for scripts and tests that end their process).
export async function closeReplica(): Promise<void> {
  const pool = globalForReplica.__beliefatlasReplicaPool;
  globalForReplica.__beliefatlasReplicaPool = undefined;
  globalForReplica.__beliefatlasReplicaUrl = undefined;
  if (pool) await pool.end();
}

export type Tally = { true: number; false: number; unsure: number; total: number };

export const pct = (n: number, total: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

export function percentages(t: Tally) {
  return { true: pct(t.true, t.total), false: pct(t.false, t.total), unsure: pct(t.unsure, t.total) };
}

// ---------- A short cache of splits ----------
// Feeds and vote pages read the same popular questions' splits over and over. Each instance
// keeps them for a few seconds (SPLIT_CACHE_MS, default 3000; 0 turns the cache off), up to
// SPLIT_CACHE_MAX questions, dropping the least recently stored first. A vote counted on this
// instance clears its question straight away (lib/vote-engine.ts).

const SPLIT_TTL_MS = Math.max(0, Number(process.env.SPLIT_CACHE_MS ?? 3000));
const SPLIT_MAX = Math.max(1, Number(process.env.SPLIT_CACHE_MAX ?? 5000));
const splitCache = new Map<number, { tally: Tally; at: number }>();

function cachedSplit(id: number, now: number): Tally | null {
  const hit = splitCache.get(id);
  if (!hit) return null;
  if (now - hit.at >= SPLIT_TTL_MS) {
    splitCache.delete(id);
    return null;
  }
  return hit.tally;
}

function storeSplit(id: number, tally: Tally, now: number) {
  if (SPLIT_TTL_MS === 0) return;
  splitCache.delete(id);
  splitCache.set(id, { tally, at: now });
  while (splitCache.size > SPLIT_MAX) splitCache.delete(splitCache.keys().next().value!);
}

export function invalidateSplits(questionIds: number[]): void {
  for (const id of questionIds) splitCache.delete(id);
}

export function clearSplitCache(): void {
  splitCache.clear();
}

export const splitCacheSize = () => splitCache.size;

// Current tallies for a list of questions, read from the counters kept on each question.
export async function tallies(questionIds: number[]): Promise<Map<number, Tally>> {
  const now = Date.now();
  const map = new Map<number, Tally>();
  const missing: number[] = [];
  for (const id of questionIds) {
    const hit = cachedSplit(id, now);
    if (hit) map.set(id, { ...hit });
    else {
      map.set(id, { true: 0, false: 0, unsure: 0, total: 0 });
      missing.push(id);
    }
  }
  if (!missing.length) return map;
  const rows = await readQuery<{ id: number; t: number; f: number; u: number }>(
    "select id, true_count as t, false_count as f, unsure_count as u from questions where id = any($1::int[])",
    [missing],
  );
  for (const r of rows) {
    const tally = { true: r.t, false: r.f, unsure: r.u, total: r.t + r.f + r.u };
    storeSplit(r.id, tally, now);
    map.set(r.id, { ...tally });
  }
  return map;
}

export type StatsOptions = {
  asOf?: Date;          // reconstruct the vote as it stood at this moment
  activeSince?: Date;   // only count accounts active at or after this moment
};

export type GroupStat = { total: number; pctTrue: number; pctFalse: number; pctUnsure: number } | null; // null = below the minimum group size

export type QuestionStats = {
  asOf: string;
  activeSince: string | null;
  tally: Tally;
  percentages: { true: number; false: number; unsure: number };
  churn: {
    everVoted: number;
    changedOnce: number;
    changedMoreThanOnce: number;
    changedInLast7Days: number;
    pctChangedMind: number;      // changed at least once
    pctChangedOnce: number;
    pctChangedMoreThanOnce: number;
    pctChangedInLast7Days: number;
  };
  blindFirstVotes: { count: number; pct: number };
  visibility: { public: GroupStat; private: GroupStat };
  sources: { source: string; votes: number }[];
  history: { day: string; total: number; pctTrue: number; pctFalse: number; pctUnsure: number }[];
};

// The state of each account's vote at $2: its most recent event at or before that moment.
const LATEST = `
  select distinct on (e.account_id) e.account_id, e.value, e.is_private
    from vote_events e join accounts a on a.id = e.account_id
   where e.question_id = $1 and e.created_at <= $2
     and ($3::timestamptz is null or a.last_active_at >= $3)
   order by e.account_id, e.created_at desc, e.id desc`;

const group = (total: number, t: number, f: number): GroupStat =>
  total >= MIN_GROUP_SIZE
    ? { total, pctTrue: pct(t, total), pctFalse: pct(f, total), pctUnsure: pct(total - t - f, total) }
    : null;

// Everything is computed from vote_events, so any past moment can be reconstructed.
export async function questionStats(questionId: number, opts: StatsOptions = {}): Promise<QuestionStats> {
  const asOf = opts.asOf ?? new Date();
  const activeSince = opts.activeSince ?? null;
  const params = [questionId, asOf, activeSince];

  const [[now], [churn], sources, history] = await Promise.all([
    readQuery<{ t: number; f: number; u: number; pub_n: number; pub_t: number; pub_f: number; priv_n: number; priv_t: number; priv_f: number }>(
      `with latest as (${LATEST})
       select count(*) filter (where value = 'true')::int   as t,
              count(*) filter (where value = 'false')::int  as f,
              count(*) filter (where value = 'unsure')::int as u,
              count(*) filter (where not is_private)::int                    as pub_n,
              count(*) filter (where not is_private and value = 'true')::int as pub_t,
              count(*) filter (where not is_private and value = 'false')::int as pub_f,
              count(*) filter (where is_private)::int                        as priv_n,
              count(*) filter (where is_private and value = 'true')::int     as priv_t,
              count(*) filter (where is_private and value = 'false')::int    as priv_f
         from latest where value is not null`,
      params,
    ),
    readQuery<{ ever: number; once: number; multi: number; recent: number; blind_n: number }>(
      `select count(*)::int                             as ever,
              count(*) filter (where changes = 1)::int  as once,
              count(*) filter (where changes > 1)::int  as multi,
              count(*) filter (where recent > 0)::int   as recent,
              count(*) filter (where first_blind)::int  as blind_n
         from (
           select e.account_id,
                  count(*) filter (where e.action = 'change') as changes,
                  count(*) filter (where e.action in ('change', 'delete')
                                     and e.created_at > $2::timestamptz - interval '7 days') as recent,
                  (array_agg(e.blind order by e.created_at, e.id) filter (where e.action = 'cast'))[1] as first_blind
             from vote_events e join accounts a on a.id = e.account_id
            where e.question_id = $1 and e.created_at <= $2 and e.action <> 'skip'
              and ($3::timestamptz is null or a.last_active_at >= $3)
            group by e.account_id
         ) per_account`,
      params,
    ),
    readQuery<{ source: string; votes: number }>(
      `select e.source, count(*)::int as votes
         from vote_events e join accounts a on a.id = e.account_id
        where e.question_id = $1 and e.created_at <= $2 and e.action = 'cast'
          and ($3::timestamptz is null or a.last_active_at >= $3)
        group by e.source order by votes desc`,
      params,
    ),
    readQuery<{ day: string; t: number; f: number; u: number }>(
      `select to_char(d, 'YYYY-MM-DD') as day, s.t, s.f, s.u
         from generate_series(date_trunc('day', $2::timestamptz, 'UTC') - interval '13 days',
                              date_trunc('day', $2::timestamptz, 'UTC'), interval '1 day') d
        cross join lateral (
          select count(*) filter (where value = 'true')::int   as t,
                 count(*) filter (where value = 'false')::int  as f,
                 count(*) filter (where value = 'unsure')::int as u
            from (
              select distinct on (e.account_id) e.value
                from vote_events e join accounts a on a.id = e.account_id
               where e.question_id = $1
                 and e.created_at < d + interval '1 day' and e.created_at <= $2
                 and ($3::timestamptz is null or a.last_active_at >= $3)
               order by e.account_id, e.created_at desc, e.id desc
            ) l
           where value is not null
        ) s
        order by d`,
      params,
    ),
  ]);

  const tally: Tally = { true: now.t, false: now.f, unsure: now.u, total: now.t + now.f + now.u };
  return {
    asOf: asOf.toISOString(),
    activeSince: activeSince ? activeSince.toISOString() : null,
    tally,
    percentages: percentages(tally),
    churn: {
      everVoted: churn.ever,
      changedOnce: churn.once,
      changedMoreThanOnce: churn.multi,
      changedInLast7Days: churn.recent,
      pctChangedMind: pct(churn.once + churn.multi, churn.ever),
      pctChangedOnce: pct(churn.once, churn.ever),
      pctChangedMoreThanOnce: pct(churn.multi, churn.ever),
      pctChangedInLast7Days: pct(churn.recent, churn.ever),
    },
    blindFirstVotes: { count: churn.blind_n, pct: pct(churn.blind_n, churn.ever) },
    visibility: { public: group(now.pub_n, now.pub_t, now.pub_f), private: group(now.priv_n, now.priv_t, now.priv_f) },
    sources: sources.filter((s) => s.votes >= MIN_GROUP_SIZE),
    history: history.map((h) => {
      const total = h.t + h.f + h.u;
      return { day: h.day, total, pctTrue: pct(h.t, total), pctFalse: pct(h.f, total), pctUnsure: pct(h.u, total) };
    }),
  };
}
