// Safety around running the vote load test against a hosted database (Neon's Development or
// Preview branch), used by .github/workflows/neon-load-test.yml.
//
//   tsx scripts/load/remote.ts guard   refuse unless this is safe to load-test, then print
//                                      the round-trip time to the database
//   tsx scripts/load/remote.ts clean   remove everything any vote load test left behind and
//                                      prove nothing is left; exits 1 if anything is
//
// guard refuses when the process looks like production, the database is marked as production
// (lib/provenance.ts), or the database holds any real account. A load test makes test
// accounts and votes; on a database people use, that would mix test data with theirs.
//
// clean finds a load test's data by the names it gives it: accounts named
// load<tag>_<n|p|g><number> with origin 'test', and questions whose text is
// "load<tag> load question <number>". Deleting them takes their votes, skips, held taps and
// vote history with them (foreign keys cascade). It also clears the per-account vote rate
// windows the run opened. It runs even when the load test failed halfway, so a crash can't
// leave test data behind.

import { performance } from "node:perf_hooks";

const ACCOUNT_PATTERN = "^load[0-9a-z]+_[npg][0-9]+$";
const QUESTION_PATTERN = "^load[0-9a-z]+ load question [0-9]+$";

async function main(mode: string | undefined): Promise<number> {
  const { pool, query } = await import("../../lib/db");
  const { assertTestDataAllowedHere } = await import("../../lib/provenance");
  try {
    if (mode === "guard") {
      // Runs before migrations too, on a database that may not have the schema yet: an empty
      // database has nothing to protect, but a production mark or a real account always stops it.
      const [{ ready }] = await query<{ ready: boolean }>(
        "select to_regproc('database_is_production') is not null and to_regclass('accounts') is not null as ready");
      if (!ready) {
        const [{ tables }] = await query<{ tables: number }>(
          "select count(*)::int as tables from information_schema.tables where table_schema = 'public'");
        if (tables > 0) {
          console.error(`refused: this database has ${tables} table(s) but not BeliefAtlas's schema. Use BeliefAtlas's development or preview database.`);
          return 1;
        }
        console.log("empty database: ok to migrate and load-test.");
        return 0;
      }
      await assertTestDataAllowedHere("The vote load test");
      const [{ real }] = await query<{ real: number }>("select count(*)::int as real from accounts where origin = 'real'");
      if (real > 0) {
        console.error(`refused: this database has ${real} real account(s). Load-test a development or preview database with no real users.`);
        return 1;
      }
      const times: number[] = [];
      for (let i = 0; i < 25; i++) {
        const t = performance.now();
        await query("select 1");
        times.push(performance.now() - t);
      }
      times.sort((a, b) => a - b);
      const [{ version }] = await query<{ version: string }>("select current_setting('server_version') as version");
      console.log(`ok to load-test: not production, no real accounts. Postgres ${version}.`);
      console.log(`round trip to the database: median ${times[12].toFixed(1)} ms, best ${times[0].toFixed(1)} ms`);
      return 0;
    }
    if (mode === "clean") {
      // The same guard: never delete anything from a database that holds real accounts.
      await assertTestDataAllowedHere("Load test cleanup");
      const [{ real }] = await query<{ real: number }>("select count(*)::int as real from accounts where origin = 'real'");
      if (real > 0) {
        console.error(`refused: this database has ${real} real account(s); not cleaning anything here.`);
        return 1;
      }
      const accounts = await query<{ id: number }>(
        "select id from accounts where origin = 'test' and username ~ $1", [ACCOUNT_PATTERN]);
      const ids = accounts.map((a) => a.id);
      await query("delete from vote_requests where account_id = any($1::int[])", [ids]);
      await query("delete from accounts where id = any($1::int[])", [ids]);
      const qs = await query<{ id: number }>("delete from questions where normalized ~ $1 returning id", [QUESTION_PATTERN]);
      // Rate windows are keyed by a hash, not the account, so clear the vote windows outright.
      // Safe only because guard established that no real person uses this database.
      const rl = await query<{ n: number }>("with d as (delete from rate_limits where key like 'vote-acct:%' returning 1) select count(*)::int as n from d");
      console.log(`removed ${ids.length} load-test accounts, ${qs.length} load-test questions, ${rl[0].n} vote rate windows`);

      const [left] = await query<{ accounts: number; questions: number; votes: number; events: number; held: number }>(
        `select (select count(*) from accounts where username ~ $1)::int as accounts,
                (select count(*) from questions where normalized ~ $2)::int as questions,
                (select count(*) from votes v join accounts a on a.id = v.account_id where a.username ~ $1)::int as votes,
                (select count(*) from vote_events e join accounts a on a.id = e.account_id where a.username ~ $1)::int as events,
                (select count(*) from pending_votes p join questions q on q.id = p.question_id where q.normalized ~ $2)::int as held`,
        [ACCOUNT_PATTERN, QUESTION_PATTERN]);
      const total = left.accounts + left.questions + left.votes + left.events + left.held;
      console.log(`left behind: ${left.accounts} accounts, ${left.questions} questions, ${left.votes} votes, ` +
                  `${left.events} vote events, ${left.held} held taps`);
      const [origins] = await query<{ accounts: number; votes: number; events: number }>(
        `select (select count(*) from accounts where origin = 'test')::int as accounts,
                (select count(*) from votes where origin = 'test')::int as votes,
                (select count(*) from vote_events where origin = 'test')::int as events`);
      console.log(`all test data now in this database: ${origins.accounts} accounts, ${origins.votes} votes, ${origins.events} vote events`);
      return total === 0 ? 0 : 1;
    }
    console.error("usage: tsx scripts/load/remote.ts guard|clean");
    return 2;
  } finally {
    await pool.end();
  }
}

main(process.argv[2]).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
