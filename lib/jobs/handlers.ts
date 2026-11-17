import { query, transaction } from "../db";
import { scanForManipulation } from "../moderation";
import { registerHandler } from "./registry";
import { registerSanctionsHandlers } from "./sanctions-handlers";

// The jobs W1 runs. Both are safe to run any number of times, and at the same time on two
// workers: the queue delivers a job at least once, not exactly once.

export const PARTITIONS_JOB = "partitions.vote_events";
export const ROLLUP_JOB = "stats.rollup";
// W2: looks for bursts of new accounts voting the same way. It only records signals; a person
// reviews each one on /mod, and only a confirmed signal can lead to a ban.
export const MANIPULATION_JOB = "moderation.scan_manipulation";

// ---------- Monthly partitions of vote_events ----------
// Creates this month's partition and the next few, ahead of time, so rows never have to sit
// in the default partition. Runs daily; on most days it finds nothing to do.
export async function ensureVoteEventPartitions(monthsAhead = 3): Promise<number> {
  const ahead = Math.max(0, Math.min(24, Math.floor(monthsAhead)));
  const [row] = await query<{ created: number }>("select vote_events_ensure_partitions($1) as created", [ahead]);
  return row.created;
}

// ---------- Daily rollup per question ----------
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

// Rewrites question_daily_stats for one UTC day from vote_events. Only that day's partition is
// read. Returns how many questions had activity.
export async function rollupDay(day: string): Promise<number> {
  if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new Error(`bad day: ${day}`);
  return transaction(async (client) => {
    // Two rollups of the same day take turns, so neither sees the other's half-written rows.
    await client.query("select pg_advisory_xact_lock(hashtext('stats.rollup:' || $1))", [day]);
    await client.query("delete from question_daily_stats where day = $1::date", [day]);
    const res = await client.query(
      `insert into question_daily_stats
              (question_id, day, casts, changes, deletes, skips, answered_true, answered_false, answered_unsure, voters)
       select question_id, $1::date,
              count(*) filter (where action = 'cast'),
              count(*) filter (where action = 'change'),
              count(*) filter (where action = 'delete'),
              count(*) filter (where action = 'skip'),
              count(*) filter (where action in ('cast', 'change') and value = 'true'),
              count(*) filter (where action in ('cast', 'change') and value = 'false'),
              count(*) filter (where action in ('cast', 'change') and value = 'unsure'),
              count(distinct account_id) filter (where action in ('cast', 'change', 'delete'))
         from vote_events
        where created_at >= ($1::date::timestamp at time zone 'UTC')
          and created_at <  (($1::date + 1)::timestamp at time zone 'UTC')
          and action <> 'visibility'
        group by question_id`,
      [day],
    );
    return res.rowCount ?? 0;
  });
}

// With no day given, rolls up yesterday (to settle it) and today (so far).
export async function rollup(payload: { day?: string } = {}): Promise<void> {
  if (payload.day) {
    await rollupDay(payload.day);
    return;
  }
  const now = Date.now();
  await rollupDay(utcDay(new Date(now - 86_400_000)));
  await rollupDay(utcDay(new Date(now)));
}

let registered = false;

export function registerDefaultHandlers(): void {
  if (registered) return;
  registered = true;
  registerHandler<{ monthsAhead?: number }>(
    PARTITIONS_JOB,
    async (payload) => {
      await ensureVoteEventPartitions(payload.monthsAhead ?? 3);
    },
    { everySeconds: 24 * 3600 },
  );
  registerHandler<{ day?: string }>(ROLLUP_JOB, (payload) => rollup(payload), { everySeconds: 3600 });
  registerHandler(MANIPULATION_JOB, async () => { await scanForManipulation(); }, { everySeconds: 600 });
  // S1: the daily sanctions list refresh and OFAC recent-actions check (lib/jobs/sanctions-handlers.ts).
  registerSanctionsHandlers();
}
