// S2 sample answers (Sean, 20 Nov 2026): seed votes are fictional launch answers, labelled as
// sample answers wherever a split shows. Each question counts the seed votes inside its totals;
// the count follows loads, removals and moderator merges, real votes never touch it, and every
// reader of a split carries it to the label. Runs against DATABASE_URL and removes what it creates.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { pool, query } from "../lib/db";
import { present } from "../lib/access";
import { toCard } from "../lib/cards";
import { SAMPLE_ANSWERS_NOTE } from "../lib/legal";
import { beliefMap } from "../lib/map";
import { databaseIsProduction } from "../lib/provenance";
import { loadSeed, removeOrigin } from "../lib/seed-data";
import { clearSplitCache, questionStats, tallies } from "../lib/stats";

const tag = `s2s${Date.now().toString(36)}`;
const questions: number[] = [];
let realAccount = 0;

const sampleCount = async (id: number) =>
  (await query<{ n: number }>("select sample_count as n from questions where id = $1", [id]))[0].n;

before(async () => {
  // Removes every seed account in the database it runs against, as the provenance tests do.
  if (await databaseIsProduction()) throw new Error("tests/s2-sample-answers.test.ts must not run against a production database");
  await query("delete from accounts where origin = 'seed'");
  await query("delete from questions where normalized like 's2 sample fixture %'");
  const rows = await query<{ id: number }>(
    `insert into questions (text, normalized)
     select 'S2 sample fixture ' || $1 || ' ' || i || '?', 's2 sample fixture ' || $1 || ' ' || i
       from generate_series(1, 3) i returning id`,
    [tag],
  );
  questions.push(...rows.map((r) => r.id));
  const [acct] = await query<{ id: number }>(
    "insert into accounts (username, phone_hash, password_hash, consented_at) values ($1, $1, 'x', now()) returning id",
    [`${tag}_real`],
  );
  realAccount = acct.id;
});

after(async () => {
  await query("delete from accounts where origin = 'seed'");
  await query("delete from accounts where id = $1", [realAccount]);
  await query("delete from questions where id = any($1::int[])", [questions]);
  await pool.end();
});

test("the sample count follows seed loads and removal, and real votes never touch it", async () => {
  const [q1, q2, q3] = questions;
  await query("insert into votes (account_id, question_id, value) values ($1, $2, 'true'), ($1, $3, 'false')", [realAccount, q1, q3]);
  assert.equal(await sampleCount(q1), 0);

  await loadSeed({
    accounts: [],
    votes: [
      { account: "s2-a", questionId: q1, value: "true" },
      { account: "s2-b", questionId: q1, value: "false" },
      { account: "s2-a", questionId: q2, value: "unsure" },
    ],
  }, {});
  assert.deepEqual([await sampleCount(q1), await sampleCount(q2), await sampleCount(q3)], [2, 1, 0]);

  // A real answer changing or going away leaves the sample count alone.
  await query("update votes set value = 'unsure' where account_id = $1 and question_id = $2", [realAccount, q1]);
  await query("delete from votes where account_id = $1 and question_id = $2", [realAccount, q3]);
  assert.equal(await sampleCount(q1), 2);

  // A moderator merge that moves a seed answer moves its count with it.
  await query(
    "update votes set question_id = $1 from accounts a where a.id = votes.account_id and a.seed_key = 's2-a' and votes.question_id = $2",
    [q3, q2],
  );
  assert.deepEqual([await sampleCount(q2), await sampleCount(q3)], [0, 1]);

  const removed = await removeOrigin("seed");
  assert.equal(removed.removed.votes, 3);
  assert.deepEqual([await sampleCount(q1), await sampleCount(q2), await sampleCount(q3)], [0, 0, 0]);
  await query("delete from votes where account_id = $1", [realAccount]);
});

test("every reader of a split carries the sample answers to the label", async () => {
  const [q1, q2] = questions;
  await query("insert into votes (account_id, question_id, value) values ($1, $2, 'true')", [realAccount, q1]);
  await loadSeed({
    accounts: [],
    votes: [
      { account: "s2-c", questionId: q1, value: "false" },
      { account: "s2-d", questionId: q1, value: "false" },
    ],
  }, {});

  clearSplitCache();
  const tally = (await tallies([q1, q2])).get(q1)!;
  assert.deepEqual(tally, { true: 1, false: 2, unsure: 0, total: 3, sample: 2 });
  // No sample answers, no field: the label stays away.
  assert.deepEqual((await tallies([q2])).get(q2), { true: 0, false: 0, unsure: 0, total: 0 });

  // Everyone who sees the split is told; only viewers with exact counts get the number.
  assert.deepEqual(present(tally, { account: null, voted: false }).sample, { n: null });
  assert.deepEqual(present(tally, { account: { tier: "free" }, voted: true }).sample, { n: 2 });
  assert.equal(present({ true: 1, false: 0, unsure: 0, total: 1 }, { account: null, voted: false }).sample, null);

  // Feed cards read the counter from the question row.
  const card = toCard({ id: q1, text: "x", status: "active", category: "general", t: 1, f: 2, u: 0, s: 2 }, null);
  assert.deepEqual(card.shown.sample, { n: null });

  // The question page and the stats API count them from the vote history.
  const stats = await questionStats(q1);
  assert.equal(stats.tally.sample, 2);

  // Your map says so when a comparison includes them.
  const map = await beliefMap(realAccount);
  assert.equal(map.includesSample, false); // one voter compared is below the group size
  await query("update questions set true_count = true_count + 20 where id = $1", [q1]); // a crowd, for the comparison
  assert.equal((await beliefMap(realAccount)).includesSample, true);
  await query("update questions set true_count = true_count - 20 where id = $1", [q1]);

  await removeOrigin("seed");
  clearSplitCache();
  assert.equal((await tallies([q1])).get(q1)?.sample, undefined);
  await query("delete from votes where account_id = $1", [realAccount]);
});

test("the label reads the same in every language", () => {
  assert.match(SAMPLE_ANSWERS_NOTE, /sample answers/);
  for (const lang of ["en", "es"]) {
    const common = JSON.parse(readFileSync(`messages/${lang}/common.json`, "utf8"));
    for (const key of ["label", "labelCount", "detail", "mapNote"]) assert.ok(common.sample?.[key], `${lang} common.sample.${key}`);
    assert.match(common.sample.labelCount, /\{n, plural,/);
  }
});
