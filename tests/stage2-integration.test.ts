// Stage 2 joins between workstreams: asking in Spanish keeps the question's language and uses
// the Spanish rules, while English-only checks never refuse it.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pool, query } from "../lib/db";
import type { Account } from "../lib/auth";
import { ask } from "../lib/questions";

const tag = `s2i${Date.now() % 100000}`;

async function makeAccount(name: string): Promise<Account> {
  const username = `${tag}_${name}`;
  const [row] = await query<{ id: number }>(
    `insert into accounts (username, phone_hash, password_hash, consented_at, tier, role)
     values ($1, $1, 'x', now(), 'paid', 'user') returning id`,
    [username],
  );
  return { id: row.id, username, tier: "paid", verified: false, role: "user" };
}

after(async () => {
  await query("delete from questions where asked_by in (select id from accounts where username like $1)", [`${tag}\\_%`]);
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await pool.end();
});

test("a question asked in Spanish is stored in Spanish, with Spanish rules", async () => {
  const asker = await makeAccount("es");
  const ok = await ask(asker, `los gatos duermen más de doce horas al día ${tag}`, "es");
  assert.ok(ok.ok, ok.ok ? "" : ok.error);
  const [row] = await query<{ text: string; lang: string }>("select text, lang from questions where id = $1", [ok.id]);
  assert.equal(row.lang, "es");
  assert.ok(row.text.startsWith("¿Los gatos"), row.text);

  const open = await ask(asker, "¿Cuándo empieza el verano en Chile?", "es");
  assert.equal(open.ok, false);
  assert.equal(!open.ok && open.messageKey, "translate.asking.not_yes_no");

  const link = await ask(asker, "¿Es cierto lo que dice example.com sobre el clima?", "es");
  assert.equal(link.ok, false);
  assert.equal(!link.ok && link.results?.[0]?.code, "link");
});

test("an English question is still stored as English", async () => {
  const asker = await makeAccount("en");
  const ok = await ask(asker, `Is the ${tag} river longer than the Thames`);
  assert.ok(ok.ok, ok.ok ? "" : ok.error);
  const [row] = await query<{ lang: string }>("select lang from questions where id = $1", [ok.id]);
  assert.equal(row.lang, "en");
});

test("a ban from everything stops voting; a ban from asking doesn't", async () => {
  const { castVote } = await import("../lib/votes");
  const voter = await makeAccount("voter");
  const [q] = await query<{ id: number }>("select id from questions where status = 'active' order by id limit 2");
  const [, q2] = await query<{ id: number }>("select id from questions where status = 'active' order by id limit 2");
  await query(`insert into bans (account_id, scope, cause, reason, ends_at) values ($1, 'asking', 'demerits', 'test', now() + interval '1 day')`, [voter.id]);
  assert.equal((await castVote(voter, q.id, "true", false, "direct")).ok, true);
  await query(`insert into bans (account_id, scope, cause, permanent, reason) values ($1, 'all', 'manipulation', true, 'test')`, [voter.id]);
  const refused = await castVote(voter, q2.id, "true", false, "direct");
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.code, "banned");
  await query("delete from votes where account_id = $1", [voter.id]);
  await query("delete from vote_events where account_id = $1", [voter.id]);
});
