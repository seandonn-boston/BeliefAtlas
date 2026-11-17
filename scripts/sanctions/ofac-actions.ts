// `npm run sanctions:actions`: reads OFAC's Recent Actions page once and records new actions,
// flagging possible country-programme changes for review on /mod/compliance. It changes no list.
import { pool } from "../../lib/db";
import { runOfacActionsCheck } from "../../lib/jobs/sanctions-handlers";

async function main(): Promise<number> {
  const result = await runOfacActionsCheck();
  if (!result) {
    console.log("another OFAC recent-actions check is running; nothing done");
    return 0;
  }
  console.log(`${result.found} actions on the page, ${result.inserted} new, ${result.flagged} new and flagged for review`);
  return 0;
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
