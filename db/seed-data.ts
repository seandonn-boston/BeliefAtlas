// Seed data commands. The file format is described at the top of lib/seed-data.ts.
//
//   npm run seed:load -- <file.json|file.csv>     load fictional seed accounts and votes
//                                                 (in production only with SEED_ALLOW=1)
//   npm run seed:status                           how much seed (and test) data is left
//   npm run seed:remove [-- --dry-run]            remove every seed account and its data
//   npm run test-data:remove [-- --dry-run]       remove every test account and its data
import { readFileSync } from "fs";
import path from "path";
import { pool } from "../lib/db";
import { databaseIsProduction, originCounts, seedDataPresent } from "../lib/provenance";
import { loadSeed, parseSeedFile, removeOrigin, SeedFileError } from "../lib/seed-data";

const [command, ...rest] = process.argv.slice(2);
const dryRun = rest.includes("--dry-run");
const files = rest.filter((a) => !a.startsWith("--"));

const line = (label: string, c: { accounts: number; votes: number; events: number; skips: number }) =>
  `${label}: ${c.accounts} accounts, ${c.votes} votes, ${c.events} vote events, ${c.skips} skips`;

async function status() {
  const [seed, test, production, present] = [
    await originCounts("seed"), await originCounts("test"), await databaseIsProduction(), await seedDataPresent(),
  ];
  console.log(`database: ${production ? "PRODUCTION (marked by a production deploy)" : "not marked as production"}`);
  console.log(line("seed", seed));
  console.log(line("test", test));
  console.log(
    present
      ? "Sale exports and API-key access are CLOSED while seed data remains. Remove it with npm run seed:remove."
      : "No seed data: sale exports and API-key access are not held back by seed data.",
  );
  if (production && test.accounts + test.votes + test.events > 0) {
    console.log("WARNING: this production database holds test data. Remove it with npm run test-data:remove.");
  }
}

async function remove(origin: "seed" | "test") {
  const r = await removeOrigin(origin, { dryRun });
  const verb = dryRun ? "would remove" : "removed";
  console.log(`${verb} ${line(origin, r.removed).slice(origin.length + 2)} (${r.questionsTouched} questions touched)`);
  if (!dryRun) {
    console.log(`question counters checked against the votes table: ${r.countersChecked} questions, all match`);
    console.log(`daily rollups rebuilt: ${r.daysRolledUp} days`);
  }
}

async function main() {
  if (command === "load") {
    if (files.length !== 1) throw new Error("Usage: npm run seed:load -- <file.json|file.csv>");
    const file = path.resolve(files[0]);
    const parsed = parseSeedFile(file, readFileSync(file, "utf8"));
    const r = await loadSeed(parsed);
    console.log(`accounts: ${r.accountsCreated} created, ${r.accountsExisting} already loaded`);
    console.log(`votes: ${r.votesAdded} added, ${r.votesAlreadyPresent} already present` +
      (r.votesKept ? `, ${r.votesKept} kept with their earlier answer (the file now differs)` : ""));
  } else if (command === "status") {
    await status();
  } else if (command === "remove") {
    await remove("seed");
  } else if (command === "remove-test") {
    await remove("test");
  } else {
    throw new Error("Usage: db/seed-data.ts load <file> | status | remove [--dry-run] | remove-test [--dry-run]");
  }
}

main()
  .catch((err) => {
    console.error(err instanceof SeedFileError ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
