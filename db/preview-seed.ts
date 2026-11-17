// Runs during every Vercel build. In preview test mode (lib/preview.ts) it loads the question
// catalog and the demo votes, so a preview has something to show; anywhere else it does nothing.
// Both loaders are safe to rerun: the catalog is refreshed and demo votes are added only once.
import { execSync } from "child_process";
import { previewTestMode } from "../lib/preview";

if (!previewTestMode) {
  console.log("preview seed: skipped (not a preview in test mode)");
} else {
  execSync("tsx db/seed-questions.ts", { stdio: "inherit" });
  execSync("tsx db/seed.ts", { stdio: "inherit" });
}
