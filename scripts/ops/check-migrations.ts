// Migration naming check, run in CI.
//
//   npx tsx scripts/ops/check-migrations.ts [dir]   (default db/migrations)
//
// db/migrate.ts applies files in name order, so names decide the order migrations run in.
// The seven original files keep their 00N_ names; every file added since must be named
// YYYYMMDD_HHMM_description.sql (UTC, lowercase, digits and underscores), which sorts after
// them and keeps branches written in parallel from colliding on the next number.

import { readdirSync } from "node:fs";
import path from "node:path";

export const LEGACY_MIGRATIONS = new Set([
  "001_init.sql",
  "002_catalog.sql",
  "003_vote_counters.sql",
  "004_launch.sql",
  "005_human_verification.sql",
  "006_auth_layers.sql",
  "007_front_door.sql",
]);

export const MIGRATION_NAME = /^\d{8}_\d{4}_[a-z0-9_]+\.sql$/;

export type MigrationReport = { errors: string[]; warnings: string[] };

// A name can match the pattern and still not be a real time (20261340_2599_...). That is
// a warning rather than a failure: the order is still well defined.
function realTimestamp(name: string): boolean {
  const [, y, mo, d, h, mi] = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})_/.exec(name) ?? [];
  if (!y) return false;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(mo) - 1 &&
    date.getUTCDate() === Number(d) &&
    date.getUTCHours() === Number(h) &&
    date.getUTCMinutes() === Number(mi)
  );
}

export function checkMigrationNames(files: string[]): MigrationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prefixes = new Map<string, string>();
  for (const file of [...files].sort()) {
    if (LEGACY_MIGRATIONS.has(file)) continue;
    if (!MIGRATION_NAME.test(file)) {
      errors.push(
        `${file}: new migrations must be named YYYYMMDD_HHMM_description.sql (lowercase letters, digits, underscores); only the original 001-007 files keep 00N_ names`,
      );
      continue;
    }
    if (!realTimestamp(file)) warnings.push(`${file}: the date and time in the name are not a real UTC time`);
    const prefix = file.slice(0, 13);
    const other = prefixes.get(prefix);
    if (other) warnings.push(`${file}: shares the timestamp ${prefix} with ${other}; their order then depends on the description`);
    else prefixes.set(prefix, file);
  }
  return { errors, warnings };
}

function main() {
  const dir = process.argv[2] ?? path.join(process.cwd(), "db", "migrations");
  const files = readdirSync(dir).filter((f) => !f.startsWith("."));
  const { errors, warnings } = checkMigrationNames(files);
  const gh = Boolean(process.env.GITHUB_ACTIONS);
  for (const w of warnings) console.log(gh ? `::warning title=Migration name::${w}` : `warning: ${w}`);
  for (const e of errors) console.log(gh ? `::error title=Migration name::${e}` : `error: ${e}`);
  if (errors.length) {
    console.log(`${errors.length} migration file name(s) need fixing`);
    process.exit(1);
  }
  console.log(`${files.length} migration file names ok`);
}

// Run only from the command line, not when a test imports the checks.
if (process.argv[1] && /check-migrations\.ts$/.test(process.argv[1])) main();
