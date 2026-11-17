import { hostname } from "os";
import { randomBytes } from "crypto";
import { backoffSeconds, claim, complete, enqueueOnce, errorText, fail, reapExpired, type Job } from "./queue";
import { handlerFor, registeredKinds } from "./registry";

export type WorkerOptions = {
  workerId?: string;
  kinds?: string[];                          // only these kinds; default: every registered kind
  pollMs?: number;                           // how long to wait when nothing is due (default 1000)
  leaseSeconds?: number;                     // a job held longer than this is taken back (default 300)
  backoff?: (attempt: number) => number;     // seconds before the next try (default backoffSeconds)
  signal?: AbortSignal;                      // stops the loop after the current job
  log?: (line: string) => void;
};

export type RunResult =
  | { status: "idle" }
  | { status: "done"; job: Job }
  | { status: "failed"; job: Job; dead: boolean; error: string };

export const newWorkerId = () => `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;

// Queue the next run of every recurring kind that has none waiting.
export async function scheduleRecurring(kinds: string[] = registeredKinds(), from: Date = new Date()): Promise<void> {
  for (const kind of kinds) {
    const spec = handlerFor(kind);
    if (spec?.everySeconds) await enqueueOnce(kind, {}, from, { maxAttempts: spec.maxAttempts });
  }
}

// Claim and run one due job, if there is one.
export async function runOne(opts: WorkerOptions = {}): Promise<RunResult> {
  const workerId = opts.workerId ?? newWorkerId();
  const kinds = opts.kinds ?? registeredKinds();
  if (!kinds.length) return { status: "idle" };
  const job = await claim(workerId, kinds);
  if (!job) return { status: "idle" };

  const spec = handlerFor(job.kind);
  let result: RunResult;
  try {
    if (!spec) throw new Error(`no handler registered for ${job.kind}`);
    await spec.handler(job.payload as Record<string, unknown>, job as Job<Record<string, unknown>>);
    await complete(job, workerId);
    result = { status: "done", job };
  } catch (err) {
    const error = errorText(err);
    const dead = await fail(job, workerId, err, (opts.backoff ?? backoffSeconds)(job.attempts));
    result = { status: "failed", job, dead, error };
  }

  // A recurring job queues its next run once this one is settled (done, or out of attempts).
  if (spec?.everySeconds && (result.status === "done" || result.dead)) {
    await enqueueOnce(job.kind, {}, new Date(Date.now() + spec.everySeconds * 1000), { maxAttempts: spec.maxAttempts });
  }
  return result;
}

// Run every job that is due now, then return. For cron-style use and for tests.
export async function drain(opts: WorkerOptions = {}, limit = 1000): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (let i = 0; i < limit && !opts.signal?.aborted; i++) {
    const r = await runOne(opts);
    if (r.status === "idle") break;
    results.push(r);
  }
  return results;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

// The worker loop: run due jobs one at a time, wait when there are none, take back jobs whose
// worker died, and stop when `signal` aborts. Errors talking to the database are logged and
// retried after a pause rather than ending the loop.
export async function runWorker(opts: WorkerOptions = {}): Promise<{ done: number; failed: number }> {
  const workerId = opts.workerId ?? newWorkerId();
  const log = opts.log ?? (() => {});
  const pollMs = opts.pollMs ?? 1000;
  const leaseSeconds = opts.leaseSeconds ?? 300;
  const counts = { done: 0, failed: 0 };
  let lastReap = 0;
  log(`worker ${workerId} running ${(opts.kinds ?? registeredKinds()).join(", ")}`);

  while (!opts.signal?.aborted) {
    try {
      if (Date.now() - lastReap > Math.min(60_000, leaseSeconds * 1000)) {
        const reaped = await reapExpired(leaseSeconds, opts.backoff);
        if (reaped) log(`took back ${reaped} job(s) from workers that stopped`);
        lastReap = Date.now();
      }
      const r = await runOne({ ...opts, workerId });
      if (r.status === "idle") {
        await sleep(pollMs, opts.signal);
      } else if (r.status === "done") {
        counts.done++;
        log(`done ${r.job.kind} #${r.job.id}`);
      } else {
        counts.failed++;
        log(`${r.dead ? "dead" : "failed"} ${r.job.kind} #${r.job.id} (try ${r.job.attempts}/${r.job.max_attempts}): ${r.error}`);
      }
    } catch (err) {
      log(`worker error: ${errorText(err)}`);
      await sleep(Math.max(pollMs, 1000), opts.signal);
    }
  }
  log(`worker ${workerId} stopped`);
  return counts;
}
