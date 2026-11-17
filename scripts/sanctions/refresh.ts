// `npm run sanctions:refresh`: downloads every sanctions list once, imports it, rescreens every
// party and prints what happened to each list. The same work the daily sanctions.refresh job does.
import { pool } from "../../lib/db";
import { runSanctionsRefresh } from "../../lib/jobs/sanctions-handlers";

async function main(): Promise<number> {
  const result = await runSanctionsRefresh();
  if (!result) {
    console.log("another sanctions refresh is running; nothing done");
    return 0;
  }
  for (const r of result.results) {
    console.log(r.ok ? `${r.list}: ok, ${r.entries} names (import #${r.importId})` : `${r.list}: FAILED (import #${r.importId}): ${r.error}`);
  }
  console.log(`rescreened ${result.rescreened} parties`);
  return result.results.every((r) => r.ok) ? 0 : 1;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
