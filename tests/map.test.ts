// Your map: totals, subjects, where you sit against everyone else, and small groups kept hidden.
// Runs against DATABASE_URL and cleans up after itself.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Account } from "../lib/auth";
import { pool, query } from "../lib/db";
import { MIN_GROUP_SIZE } from "../lib/limits";
import { beliefMap, placeOf } from "../lib/map";
import { ask } from "../lib/questions";
import { vote } from "../lib/vote-engine";

const tag = `map${Date.now().toString(36)}`;
const people: Account[] = [];
const questionIds: number[] = [];

async function makeAccount(name: string): Promise<Account> {
  const [row] = await query<{ id: number }>(
    `insert into accounts (username, phone_hash, password_hash, consented_at, tier)
     values ($1, $2, 'x', now(), 'paid') returning id`,
    [`${tag}_${name}`, `${tag}_${name}`],
  );
  return { id: row.id, username: `${tag}_${name}`, tier: "paid", verified: false, role: "user" };
}

before(async () => {
  for (let i = 0; i < MIN_GROUP_SIZE + 1; i++) people.push(await makeAccount(`p${i}`));
});

after(async () => {
  await query("delete from questions where id = any($1::int[])", [questionIds]);
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await pool.end();
});

test("placeOf hides groups below the minimum and finds the most common answer", () => {
  assert.deepEqual(placeOf("true", { true: 1, false: 0, unsure: 0 }).sameAsYou, MIN_GROUP_SIZE > 1 ? null : 100);
  const big = { true: 60, false: 30, unsure: 10 };
  assert.deepEqual(placeOf("true", big), { total: 100, sameAsYou: 60, withMost: true });
  assert.deepEqual(placeOf("unsure", big), { total: 100, sameAsYou: 10, withMost: false });
  // A tie has no single most common answer.
  assert.equal(placeOf("true", { true: 50, false: 50, unsure: 0 }).withMost, null);
});

test("the map counts answers, subjects, changes of mind and leaves out removed questions", async () => {
  const [me, ...others] = people;
  const ask1 = await ask(me, `Is the ${tag} harbour bridge older than the tower`);
  const ask2 = await ask(me, `Is the ${tag} river wider than the canal`);
  const ask3 = await ask(me, `Is the ${tag} old mill still standing`);
  for (const r of [ask1, ask2, ask3]) assert.ok(r.ok, r.ok ? "" : r.error);
  const [q1, q2, q3] = [ask1, ask2, ask3].map((r) => (r.ok ? r.id : 0));
  questionIds.push(q1, q2, q3);

  // Everyone answers q1, most of them True; only two people answer q2.
  for (const p of others) await vote({ account: p, questionId: q1, value: "true", surface: "web" });
  assert.equal((await vote({ account: me, questionId: q1, value: "false", surface: "web" })).outcome, "cast");
  assert.equal((await vote({ account: me, questionId: q1, value: "true", surface: "web" })).outcome, "changed");
  await vote({ account: others[0], questionId: q2, value: "false", surface: "web" });
  await vote({ account: me, questionId: q2, value: "unsure", surface: "web" });
  await vote({ account: me, questionId: q3, value: "false", surface: "web" });
  await query("update questions set status = 'removed' where id = $1", [q3]);

  const map = await beliefMap(me.id);
  assert.equal(map.answered, 2);
  assert.deepEqual(map.counts, { true: 1, false: 0, unsure: 1 });
  assert.equal(map.changedMind, 1);
  assert.equal(map.comparable, 1);
  assert.equal(map.withMost, 1);
  assert.equal(map.entries.length, 2);
  assert.ok(!map.entries.some((e) => e.questionId === q3), "removed questions stay off the map");

  const first = map.entries.find((e) => e.questionId === q1)!;
  assert.equal(first.value, "true");
  assert.equal(first.firstValue, "false");
  assert.equal(first.sameAsYou, 100);
  assert.equal(first.withMost, true);
  const second = map.entries.find((e) => e.questionId === q2)!;
  assert.equal(second.sameAsYou, null, "two answers is too few to show");

  const subject = map.subjects[0];
  const filtered = await beliefMap(me.id, { subject: subject.category });
  assert.ok(filtered.entries.every((e) => e.category === subject.category));
  assert.equal(filtered.answered, 2, "the totals cover every subject even when filtered");
});
