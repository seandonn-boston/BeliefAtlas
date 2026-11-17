// Runs during every Vercel build. In preview test mode (lib/preview.ts) it loads the question
// catalog and the demo votes, so a preview has something to show; anywhere else it does nothing.
// Both loaders are safe to rerun: the catalog is refreshed and demo votes are added only once.
//
// The demo votes are test data, so this refuses (and fails the build) if the preview's
// database is marked as production: each environment needs its own database (DEPLOY.md).
import { execSync } from "child_process";
import { pool } from "../lib/db";
import { assertTestDataAllowedHere } from "../lib/provenance";
import { previewTestMode } from "../lib/preview";

async function main() {
  if (!previewTestMode) {
    console.log("preview seed: skipped (not a preview in test mode)");
    return;
  }
  await assertTestDataAllowedHere("The preview seed (catalog and demo votes)");
  execSync("tsx db/seed-questions.ts", { stdio: "inherit" });
  execSync("tsx db/seed.ts", { stdio: "inherit" });
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
