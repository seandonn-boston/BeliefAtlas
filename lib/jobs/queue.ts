import type { Pool, PoolClient } from "pg";
import { pool } from "../db";

// A small job queue in Postgres, on the `jobs` table (db/migrations/20261117_1810_stage2_contracts.sql).
// No Redis: a job is a row, a worker claims it with `for update skip locked` so two workers
// never take the same job, and a failed job comes back later with a growing delay until it
// runs out of attempts.
//
// A job's life:
//   waiting  done_at is null, locked_at is null, attempts < max_attempts, run_at in the future or past
//   running  locked_at and locked_by are set (a worker holds it; attempts already counts this try)
//   done     done_at is set
//   dead     done_at is null and attempts >= max_attempts; last_error says why. Never claimed again.
// A worker that dies mid-job leaves its lock; once the lease runs out, reapExpired() counts that
// try as failed and the job waits for its next try like any other failure.

export type Job<P = unknown> = {
  id: number;
  kind: string;
  payload: P;
  run_at: Date;
  attempts: number;
  max_attempts: number;
  locked_at: Date | null;
  locked_by: string | null;
  done_at: Date | null;
  last_error: string | null;
  created_at: Date;
};

export type Db = Pool | PoolClient;

export type EnqueueOptions = {
  maxAttempts?: number;
  db?: Db;               // a transaction's client, so the job is queued only if it commits
};

const KIND = /^[a-z][a-z0-9_.:-]{0,63}$/;

// The `jobs.id` column is a bigint, which pg returns as a string; ids here stay well inside a
// JavaScript number.
const toJob = <P>(row: Record<string, unknown>): Job<P> => ({ ...(row as unknown as Job<P>), id: Number(row.id) });

export async function enqueue<P = Record<string, unknown>>(
  kind: string,
  payload: P = {} as P,
  runAt?: Date | null,
  opts: EnqueueOptions = {},
): Promise<number> {
  if (!KIND.test(kind)) throw new Error(`bad job kind: ${kind}`);
  const db = opts.db ?? pool;
  const res = await db.query<{ id: string }>(
    `insert into jobs (kind, payload, run_at, max_attempts)
     values ($1, $2, coalesce($3::timestamptz, now()), $4) returning id`,
    [kind, JSON.stringify(payload ?? {}), runAt ?? null, opts.maxAttempts ?? 5],
  );
  return Number(res.rows[0].id);
}

// Queue a job of this kind unless one is already waiting or running. Used for recurring work,
// so a schedule never piles up copies of itself however many workers start. Returns the id of
// the job queued, or null if one was already there.
export async function enqueueOnce<P = Record<string, unknown>>(
  kind: string,
  payload: P = {} as P,
  runAt?: Date | null,
  opts: Omit<EnqueueOptions, "db"> = {},
): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Two workers checking at once would both see nothing; the lock makes them take turns.
    await client.query("select pg_advisory_xact_lock(hashtext('jobs:' || $1))", [kind]);
    const waiting = await client.query(
      "select 1 from jobs where kind = $1 and done_at is null and attempts < max_attempts limit 1",
      [kind],
    );
    const id = waiting.rowCount ? null : await enqueue(kind, payload, runAt, { ...opts, db: client });
    await client.query("commit");
    return id;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

// Take the next job that is due, if any. `kinds` limits which kinds this worker runs.
export async function claim(workerId: string, kinds?: string[] | null): Promise<Job | null> {
  const res = await pool.query(
    `with next as (
       select id from jobs
        where done_at is null and locked_at is null and attempts < max_attempts and run_at <= now()
          and ($2::text[] is null or kind = any($2::text[]))
        order by run_at, id
        limit 1
        for update skip locked
     )
     update jobs j set locked_at = now(), locked_by = $1, attempts = j.attempts + 1
       from next where j.id = next.id
     returning j.*`,
    [workerId, kinds?.length ? kinds : null],
  );
  return res.rows[0] ? toJob(res.rows[0]) : null;
}

export async function complete(job: Job, workerId: string): Promise<void> {
  await pool.query(
    "update jobs set done_at = now(), locked_at = null, locked_by = null where id = $1 and locked_by = $2",
    [job.id, workerId],
  );
}

// The delay before try number `attempt + 1`, in seconds: 10s, 20s, 40s ... up to an hour, with
// a little jitter so jobs that failed together don't all come back together.
export function backoffSeconds(attempt: number): number {
  const base = Math.min(3600, 10 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

// Record a failed try. The job waits `delaySeconds` for its next try, or is dead if that was its
// last. Returns whether it is dead.
export async function fail(job: Job, workerId: string, error: unknown, delaySeconds: number): Promise<boolean> {
  const message = errorText(error);
  const res = await pool.query<{ dead: boolean }>(
    `update jobs
        set locked_at = null, locked_by = null, last_error = $3,
            run_at = case when attempts >= max_attempts then run_at
                          else now() + make_interval(secs => $4) end
      where id = $1 and locked_by = $2
      returning attempts >= max_attempts as dead`,
    [job.id, workerId, message, Math.max(0, delaySeconds)],
  );
  return res.rows[0]?.dead ?? false;
}

// Release jobs whose worker stopped answering: their lock is older than the lease. That try
// counts as failed.
export async function reapExpired(leaseSeconds: number, backoff: (attempt: number) => number = backoffSeconds): Promise<number> {
  const res = await pool.query<{ id: string; attempts: number }>(
    `update jobs
        set locked_at = null, locked_by = null,
            last_error = 'worker ' || coalesce(locked_by, '?') || ' did not finish within ' || $1::int || 's'
      where done_at is null and locked_at < now() - make_interval(secs => $1::int)
      returning id, attempts`,
    [leaseSeconds],
  );
  for (const row of res.rows) {
    await pool.query(
      "update jobs set run_at = now() + make_interval(secs => $2) where id = $1 and attempts < max_attempts and locked_at is null",
      [row.id, Math.max(0, backoff(row.attempts))],
    );
  }
  return res.rowCount ?? 0;
}

export async function getJob(id: number): Promise<Job | null> {
  const res = await pool.query("select * from jobs where id = $1", [id]);
  return res.rows[0] ? toJob(res.rows[0]) : null;
}

// Jobs that ran out of attempts, newest first.
export async function deadJobs(limit = 50): Promise<Job[]> {
  const res = await pool.query(
    "select * from jobs where done_at is null and attempts >= max_attempts order by created_at desc limit $1",
    [limit],
  );
  return res.rows.map((r) => toJob(r));
}

export function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 2000);
}
