// Test data for trying the headless front door on a laptop or a preview: one 'test' org, one
// placement on the first few active questions, and its admin. Refuses to run in production or
// against a database marked as production (lib/provenance.ts), so it can never mix with real data.
//
//   npx tsx --env-file-if-exists=.env.local scripts/headless/test-data.ts load [origin]
//   npx tsx --env-file-if-exists=.env.local scripts/headless/test-data.ts remove
import { pool, query } from "../../lib/db";
import { assertTestDataAllowedHere } from "../../lib/provenance";
import { cleanOrigin, createOrg, createPlacement } from "../../lib/headless/placements";

const SLUG = "headless-test-org";
const ADMIN = "headless_test_admin";

async function remove() {
  await query("delete from organizations where slug = $1 and origin = 'test'", [SLUG]);
  await query("delete from accounts where username = $1 and origin = 'test'", [ADMIN]);
}

async function load(origin: string | null) {
  await remove();
  const [admin] = await query<{ id: number }>(
    "insert into accounts (username, phone_hash, password_hash, consented_at, origin) values ($1, $1, 'x', now(), 'test') returning id",
    [ADMIN],
  );
  const orgId = await createOrg({ slug: SLUG, name: "Headless Test Org", createdBy: admin.id, origin: "test", status: "active" });
  const questions = await query<{ id: number }>("select id from questions where status = 'active' order by id limit 3");
  const placement = await createPlacement({
    orgId, label: "Test placement", kind: "site", allowedOrigins: origin ? [origin] : [],
    questionIds: questions.map((q) => q.id), notChildDirected: true,
  });
  console.log(JSON.stringify({ org: SLUG, placement, questions: questions.map((q) => q.id) }));
}

async function main() {
  await assertTestDataAllowedHere("scripts/headless/test-data.ts");
  const [cmd, origin] = process.argv.slice(2);
  if (cmd === "load") await load(cleanOrigin(origin));
  else if (cmd === "remove") await remove();
  else throw new Error("usage: test-data.ts load [origin] | remove");
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
}).finally(() => pool.end());
