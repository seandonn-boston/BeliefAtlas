// Uptime check: is the site answering?
//
//   npx tsx scripts/ops/uptime-check.ts https://example.com
//   UPTIME_URL=https://example.com npx tsx scripts/ops/uptime-check.ts
//
// Fetches the home page and /api/feed, retrying each a couple of times, and prints one JSON
// log line per page. Exits 0 when both are healthy and 1 when either is not, so it works
// from cron, a GitHub Actions schedule (.github/workflows/uptime.yml) or any free monitor
// that runs a command. Optional: UPTIME_TIMEOUT_MS (default 10000), UPTIME_RETRIES (default 2).

import { logger } from "../../lib/log";
import { checkSite } from "./uptime";

async function main(): Promise<number> {
  const base = process.argv[2] ?? process.env.UPTIME_URL;
  const results = await checkSite(base ?? "", {
    timeoutMs: Number(process.env.UPTIME_TIMEOUT_MS) || undefined,
    retries: process.env.UPTIME_RETRIES !== undefined ? Number(process.env.UPTIME_RETRIES) : undefined,
  });
  for (const r of results) {
    const fields = { check: r.name, url: r.url, status: r.status, ms: r.ms, attempts: r.attempts, detail: r.detail };
    if (r.ok) logger.info("uptime check passed", fields);
    else logger.error("uptime check failed", fields);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    // GitHub Actions shows ::error lines as annotations on the run.
    if (process.env.GITHUB_ACTIONS) for (const r of failed) console.log(`::error title=Uptime check failed::${r.name} (${r.url}): ${r.detail ?? "unhealthy"}`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    logger.error("uptime check could not run", { error: err });
    process.exit(2);
  },
);
