// `npm run jobs:work` runs the job worker until Ctrl-C or SIGTERM.
// `npm run jobs:work -- --once` runs every job that is due now and exits (for a cron).
// Options: --kinds=a,b (only these kinds), --poll-ms=1000, --lease-seconds=300.
import { pool } from "../db";
import { closeReplica } from "../stats";
import { registerDefaultHandlers } from "./handlers";
import { drain, runWorker, scheduleRecurring } from "./worker";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

async function main() {
  registerDefaultHandlers();
  const kinds = arg("kinds")?.split(",").filter(Boolean);
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  await scheduleRecurring(kinds);

  if (process.argv.includes("--once")) {
    const results = await drain({ kinds, log });
    for (const r of results) {
      if (r.status === "done") log(`done ${r.job.kind} #${r.job.id}`);
      if (r.status === "failed") log(`${r.dead ? "dead" : "failed"} ${r.job.kind} #${r.job.id}: ${r.error}`);
    }
    return results.some((r) => r.status === "failed") ? 1 : 0;
  }

  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());
  await runWorker({
    kinds,
    log,
    signal: stop.signal,
    pollMs: Number(arg("poll-ms") ?? process.env.JOBS_POLL_MS ?? 1000),
    leaseSeconds: Number(arg("lease-seconds") ?? 300),
  });
  return 0;
}

main()
  .then(async (code) => {
    await closeReplica();
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
