import { pool } from "./db";
import { logger } from "./log";
import { isPreviewTestMode } from "./preview";

// Provenance: where every account, vote and vote event came from. See
// db/migrations/20261117_2300_p1_provenance.sql for the rules the database itself enforces.
//
//   real  a person who signed up on the live site. The default; the only origin ever sold or
//         served to API keys.
//   test  made for trying the site out (preview test-mode signups, the demo data loader, load
//         tests, screenshots). Impossible in production: refused by the code here and by the
//         database once it is marked as production.
//   seed  fictional launch accounts and votes (npm run seed:load), there to make an empty site
//         feel less empty. Removed completely (npm run seed:remove) before data sales open:
//         while any remains, assertNoSeedData() keeps sale exports and keyed API access closed.

export type Origin = "real" | "test" | "seed";
export const ORIGINS: readonly Origin[] = ["real", "test", "seed"];

type Env = Record<string, string | undefined>;

// Anything with pg's query(): the shared pool, a pooled client inside a transaction, or a
// script's own Pool.
export type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };

async function rows<T>(db: Queryable, text: string, values: unknown[] = []): Promise<T[]> {
  return (await db.query(text, values)).rows as T[];
}

// ---------- Which environment this is ----------

// Production is Vercel's production deployment, or NODE_ENV=production anywhere that isn't a
// Vercel preview (a server started with `next start`, a script run with NODE_ENV=production).
export function isProductionEnv(env: Env = process.env): boolean {
  if (env.VERCEL_ENV === "production") return true;
  if (env.VERCEL_ENV === "preview") return false;
  return env.NODE_ENV === "production";
}

export class TestDataRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDataRefused";
  }
}

// Throws when this process is a production environment. Every path that makes test data
// (the demo loader, load tests, preview test-mode signups) calls it first.
export function assertTestDataAllowed(what: string, env: Env = process.env): void {
  if (isProductionEnv(env)) {
    throw new TestDataRefused(
      `${what} makes test data and never runs in production ` +
        `(VERCEL_ENV=${env.VERCEL_ENV ?? "unset"}, NODE_ENV=${env.NODE_ENV ?? "unset"}).`,
    );
  }
}

// Whether the database itself says it is production's. db/migrate.ts marks it on a production
// deploy and the mark is never removed, so this catches a laptop or preview pointed at the
// production database even when its own environment variables look harmless.
export async function databaseIsProduction(db: Queryable = pool): Promise<boolean> {
  const [row] = await rows<{ production: boolean }>(db, "select database_is_production() as production");
  return Boolean(row?.production);
}

// Both checks: this process isn't production, and neither is the database it points at.
export async function assertTestDataAllowedHere(what: string, db: Queryable = pool, env: Env = process.env): Promise<void> {
  assertTestDataAllowed(what, env);
  if (await databaseIsProduction(db)) {
    throw new TestDataRefused(`${what} makes test data, and this database is marked as production. Point DATABASE_URL at a preview or development database.`);
  }
}

// Marks the database as production's when this process is the production deploy. Run by
// db/migrate.ts. Returns whether the database is marked afterwards.
export async function markProductionDatabase(db: Queryable = pool, env: Env = process.env): Promise<boolean> {
  if (isProductionEnv(env)) {
    await db.query("insert into database_environment (environment) values ('production') on conflict (only_row) do nothing");
  }
  return databaseIsProduction(db);
}

// ---------- New accounts ----------

// The origin a new signup gets. Preview test mode makes test accounts; everywhere else a signup
// is a real person. Nothing a request sends takes part in this.
export function signupOrigin(env: Env = process.env): Origin {
  if (!isPreviewTestMode(env)) return "real";
  // Preview test mode needs VERCEL_ENV=preview, so this can't fire; it stays as a second lock.
  assertTestDataAllowed("A preview test-mode signup", env);
  return "test";
}

// ---------- How much of each origin there is ----------

export type OriginCounts = { accounts: number; votes: number; events: number; skips: number };

export async function originCounts(origin: Origin, db: Queryable = pool): Promise<OriginCounts> {
  const [row] = await rows<OriginCounts>(
    db,
    `select (select count(*) from accounts where origin = $1)::int as accounts,
            (select count(*) from votes where origin = $1)::int as votes,
            (select count(*) from vote_events where origin = $1)::int as events,
            (select count(*) from skips s join accounts a on a.id = s.account_id where a.origin = $1)::int as skips`,
    [origin],
  );
  return row;
}

const isEmpty = (c: OriginCounts) => c.accounts + c.votes + c.events + c.skips === 0;

// ---------- The gate on selling and keyed access ----------

export const SEED_DATA_PRESENT_MESSAGE = "seed data still present; data sales open after it is removed";

export class SeedDataPresent extends Error {
  readonly status = 503;
  constructor() {
    super(SEED_DATA_PRESENT_MESSAGE);
    this.name = "SeedDataPresent";
  }
}

// True while any seed account, vote or vote event is left. Each probe uses a partial index of
// the non-real rows, so this costs next to nothing however large the tables are.
export async function seedDataPresent(db: Queryable = pool): Promise<boolean> {
  const [row] = await rows<{ present: boolean }>(
    db,
    `select exists (select 1 from accounts where origin = 'seed')
         or exists (select 1 from votes where origin = 'seed')
         or exists (select 1 from vote_events where origin = 'seed') as present`,
  );
  return Boolean(row?.present);
}

// The hard gate: sale exports and API-key requests call this first, and get SeedDataPresent
// (HTTP 503) until npm run seed:remove has removed every seed row.
export async function assertNoSeedData(db: Queryable = pool): Promise<void> {
  if (await seedDataPresent(db)) throw new SeedDataPresent();
}

// ---------- Start-up and deploy check ----------

export type ProvenanceReport = {
  productionEnv: boolean;
  productionDatabase: boolean;
  test: OriginCounts;
  seed: OriginCounts;
  problems: string[];
};

// Looks for test data where it must never be, and a preview connected to the production
// database. Logs every problem loudly (error level) and returns the findings. Never throws for
// what it finds; a failed query is the caller's to log.
export async function checkDatabaseProvenance(db: Queryable = pool, env: Env = process.env): Promise<ProvenanceReport> {
  const productionEnv = isProductionEnv(env);
  const productionDatabase = await databaseIsProduction(db);
  const [test, seed] = [await originCounts("test", db), await originCounts("seed", db)];
  const problems: string[] = [];

  if ((productionEnv || productionDatabase) && !isEmpty(test)) {
    problems.push(
      `PRODUCTION DATABASE HOLDS TEST DATA: ${test.accounts} accounts, ${test.votes} votes, ${test.events} vote events. ` +
        "Test data must never mix with real data; remove it with npm run test-data:remove.",
    );
  }
  if (productionDatabase && env.VERCEL_ENV === "preview") {
    problems.push(
      "A PREVIEW IS CONNECTED TO THE PRODUCTION DATABASE. Every environment needs its own database (DEPLOY.md, Environments and data).",
    );
  }
  if (productionDatabase && !productionEnv && env.VERCEL_ENV === "development") {
    problems.push("A development deployment is connected to the production database.");
  }
  if (productionEnv && env.PREVIEW_TEST_MODE) {
    problems.push("PREVIEW_TEST_MODE is set in production. It has no effect there, but set it for Preview only.");
  }

  for (const problem of problems) logger.error(problem, { check: "provenance" });
  if (productionEnv && !isEmpty(seed)) {
    logger.warn("seed data present: sale exports and API-key access stay closed until npm run seed:remove", {
      check: "provenance", seedAccounts: seed.accounts, seedVotes: seed.votes,
    });
  }
  return { productionEnv, productionDatabase, test, seed, problems };
}
