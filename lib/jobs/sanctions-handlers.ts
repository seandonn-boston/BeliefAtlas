import { pool } from "../db";
import { checkRecentActions, type ActionsCheck } from "../sanctions/ofac-actions";
import { fetchText, refreshLists, type Fetcher, type RefreshResult } from "../sanctions/screening";
import { registerHandler } from "./registry";

// The two daily sanctions jobs. Each holds a Postgres advisory lock while it runs, so a second
// copy started at the same time (two workers, or a worker and `npm run sanctions:refresh`)
// finds the lock taken and returns at once instead of importing the same lists twice.

export const SANCTIONS_REFRESH_JOB = "sanctions.refresh";
export const OFAC_ACTIONS_JOB = "sanctions.ofac_recent_actions";

// Runs fn while holding a session advisory lock on its own connection, or returns null when
// another run holds it.
async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const client = await pool.connect();
  try {
    const { rows: [lock] } = await client.query<{ got: boolean }>("select pg_try_advisory_lock(hashtext($1)) as got", [name]);
    if (!lock.got) return null;
    try {
      return await fn();
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1))", [name]);
    }
  } finally {
    client.release();
  }
}

// Fetches and imports every list and rescreens parties; null when another run is in progress.
export function runSanctionsRefresh(fetcher: Fetcher = fetchText): Promise<RefreshResult | null> {
  return withLock(SANCTIONS_REFRESH_JOB, () => refreshLists(fetcher));
}

export function runOfacActionsCheck(fetcher: Fetcher = fetchText): Promise<ActionsCheck | null> {
  return withLock(OFAC_ACTIONS_JOB, () => checkRecentActions(fetcher));
}

let registered = false;

export function registerSanctionsHandlers(): void {
  if (registered) return;
  registered = true;
  // Every list is attempted; if any failed, the job fails after the others are stored, so the
  // failure is in the jobs table and the job is tried again with the usual backoff.
  registerHandler(SANCTIONS_REFRESH_JOB, async () => {
    const result = await runSanctionsRefresh();
    const failed = result?.results.filter((r) => !r.ok) ?? [];
    if (failed.length) {
      throw new Error(failed.map((r) => `${r.list}: ${r.ok ? "" : r.error}`).join("; "));
    }
  }, { everySeconds: 24 * 3600 });
  registerHandler(OFAC_ACTIONS_JOB, async () => { await runOfacActionsCheck(); }, { everySeconds: 24 * 3600 });
}
