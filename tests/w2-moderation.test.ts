// W2 moderation pipeline against DATABASE_URL: demerits and escalating bans (never permanent
// for asking), ordinary denials that cost nothing, banned accounts that still vote, appeals
// that restore and lift, merges that record their rule, the switched-off auto-remove, and
// manipulation signals that ban only the manipulators. Cleans up after itself.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pool, query } from "../lib/db";
import type { Account } from "../lib/auth";
import { ask } from "../lib/questions";
import { castVote } from "../lib/votes";
import {
  activeBan, addDemerit, AUTO_REMOVE_MIN_VOTES, autoRemoveDue, BAN_AT_POINTS, BAN_LADDER_DAYS, banForManipulation,
  banLengthDays, decide, decideAppeal, fileAppeal, MERGE_RULE, myModeration, report, REPORT_THRESHOLD, reviewSignal,
  scanForManipulation,
} from "../lib/moderation";

const tag = `w2${Date.now().toString(36)}`;
const questionIds: number[] = [];
let asker: Account;
let mod: Account;
let n = 0;

async function makeAccount(name: string, tier: "free" | "paid" = "free", role: Account["role"] = "user"): Promise<Account> {
  const username = `${tag}_${name}_${n++}`;
  const [row] = await query<{ id: number }>(
    `insert into accounts (username, phone_hash, password_hash, consented_at, tier, role)
     values ($1, $1, 'x', now(), $2, $3) returning id`,
    [username, tier, role],
  );
  return { id: row.id, username, tier, verified: false, role };
}

async function makeQuestion(by: Account, text: string): Promise<number> {
  const result = await ask(by, text);
  assert.ok(result.ok, result.ok ? "" : result.error);
  questionIds.push(result.id);
  return result.id;
}

const demeritCount = async (accountId: number) =>
  (await query<{ n: number }>("select count(*)::int as n from demerits where account_id = $1", [accountId]))[0].n;
const status = async (id: number) =>
  (await query<{ status: string; archived_at: Date | null }>("select status, archived_at from questions where id = $1", [id]))[0];

before(async () => {
  asker = await makeAccount("asker", "paid");
  mod = await makeAccount("mod", "free", "moderator");
});

after(async () => {
  await query("delete from questions where id = any($1::int[]) or asked_by in (select id from accounts where username like $2)", [questionIds, `${tag}\\_%`]);
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await pool.end();
});

test("bans for asking lengthen each time: 1, 7, 30, then 90 days", async () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(banLengthDays), [1, 7, 30, 90, 90, 90]);
  assert.deepEqual([...BAN_LADDER_DAYS], [1, 7, 30, 90]);

  const person = await makeAccount("ladder");
  const ends: number[] = [];
  for (let i = 0; i < BAN_AT_POINTS + 4; i++) {
    const { ban } = await addDemerit({ accountId: person.id, kind: "spam", reason: `test ${i}` });
    if (i + 1 < BAN_AT_POINTS) assert.equal(ban, null, "the first harmful question is a warning");
    else ends.push(ban!.ends_at!.getTime());
  }
  const day = 86_400_000;
  const started = Date.now();
  // Each ban runs on from the one before, so the steps are the gaps between end times.
  const steps = ends.map((e, i) => Math.round((e - (i ? ends[i - 1] : started)) / day));
  assert.deepEqual(steps, [1, 7, 30, 90, 90]);
});

test("no permanent ban is possible for asking, however many demerits", async () => {
  const person = await makeAccount("repeat");
  for (let i = 0; i < 8; i++) await addDemerit({ accountId: person.id, kind: "hateful", reason: `test ${i}` });
  const bans = await query<{ permanent: boolean; ends_at: Date | null; cause: string; scope: string }>(
    "select permanent, ends_at, cause, scope from bans where account_id = $1", [person.id],
  );
  assert.ok(bans.length > 0);
  for (const b of bans) {
    assert.equal(b.permanent, false);
    assert.ok(b.ends_at);
    assert.equal(b.cause, "demerits");
    assert.equal(b.scope, "asking");
  }
  // The database refuses a permanent ban for anything but manipulation...
  await assert.rejects(query(
    "insert into bans (account_id, cause, permanent, reason, ends_at) values ($1, 'demerits', true, 'x', null)", [person.id],
  ));
  await assert.rejects(query(
    "insert into bans (account_id, cause, permanent, reason, ends_at) values ($1, 'other', true, 'x', null)", [person.id],
  ));
  // ...and the code refuses one without a confirmed manipulation signal naming the account.
  const client = await pool.connect();
  try {
    await assert.rejects(banForManipulation(person.id, 999_999_999, mod.id, client));
  } finally {
    client.release();
  }
});

test("an ordinary denial adds no demerit; a harmful one does", async () => {
  const person = await makeAccount("asks", "paid");
  for (const text of [
    "Is my boss allowed to read my email?",
    "Is the new tax law fucking stupid?",
    "Did the NYT report this at nytimes.com",
    "What is the best planet?",
  ]) {
    const result = await ask(person, text);
    assert.equal(result.ok, false, text);
    assert.ok(!result.ok && !result.harmful, text);
  }
  const ordinary = await ask(person, "Is my landlord allowed to keep the deposit?");
  assert.ok(!ordinary.ok && ordinary.results?.[0]?.span && ordinary.results[0].fix === "a landlord" && ordinary.suggestion);
  assert.equal(await demeritCount(person.id), 0);

  const harmful = await ask(person, "Are immigrants vermin?");
  assert.ok(!harmful.ok && harmful.harmful);
  assert.equal(await demeritCount(person.id), 1);
  const spam = await ask(person, `Is the ${tag} shop great? Use code SAVE20 today`);
  assert.ok(!spam.ok && spam.harmful);
  assert.equal(await demeritCount(person.id), 2);
});

test("a banned account can't ask, but can still vote", async () => {
  const person = await makeAccount("banned", "paid");
  const q = await makeQuestion(asker, `Is the ${tag} lighthouse painted blue`);
  for (let i = 0; i < BAN_AT_POINTS; i++) await addDemerit({ accountId: person.id, kind: "harassing", reason: "test" });
  const ban = await activeBan(person.id, "asking");
  assert.ok(ban && !ban.permanent);
  assert.equal(await activeBan(person.id, "voting"), null);

  const refused = await ask(person, `Is the ${tag} harbour deeper than the bay`);
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.ban?.id === ban!.id);

  const voted = await castVote(person, q, "true", false, "direct");
  assert.equal(voted.ok, true);
});

test("removing needs why and a fix, archives the question, and only harmful removals add a demerit", async () => {
  const person = await makeAccount("removed", "paid");
  const q1 = await makeQuestion(person, `Is the ${tag} pier longer than the jetty`);
  assert.equal(await decide(mod.id, q1, { action: "remove", why: "", fix: "x" }), "why_and_fix_required");
  assert.equal(await decide(mod.id, q1, { action: "remove", why: "It repeats a local rumour.", fix: "Ask about the published measurements." }), null);
  const s1 = await status(q1);
  assert.equal(s1.status, "removed");
  assert.ok(s1.archived_at);
  assert.equal(await demeritCount(person.id), 0);

  const q2 = await makeQuestion(person, `Is the ${tag} mayor secretly a lizard person`);
  assert.equal(await decide(mod.id, q2, { action: "remove", why: "Harassing.", fix: "Ask about a policy.", harm: "harassing" }), null);
  assert.equal(await demeritCount(person.id), 1);
  const mine = await myModeration(person.id);
  const shown = mine.questions.find((q) => q.id === q1)!;
  assert.equal(shown.removed_why, "It repeats a local rumour.");
  assert.equal(shown.removed_fix, "Ask about the published measurements.");
});

test("appeals: once per item; overturning restores a question and lifts a ban; every decision is logged", async () => {
  const person = await makeAccount("appeals", "paid");
  const q = await makeQuestion(person, `Is the ${tag} ferry faster than the bridge`);
  await decide(mod.id, q, { action: "remove", why: "Spam.", fix: "Ask without the promotion.", harm: "spam" });

  const first = await fileAppeal(person.id, "question", q, "It's a real question about my commute.");
  assert.ok(first.ok);
  assert.deepEqual(await fileAppeal(person.id, "question", q, "Again"), { ok: false, error: "already_appealed" });
  const stranger = await makeAccount("stranger");
  assert.deepEqual(await fileAppeal(stranger.id, "question", q, "Mine?"), { ok: false, error: "not_yours" });

  assert.equal(await decideAppeal(person.id, first.ok ? first.id : 0, "overturned", "self"), "own_appeal");
  assert.equal(await decideAppeal(mod.id, first.ok ? first.id : 0, "overturned", ""), "note_required");
  assert.equal(await decideAppeal(mod.id, first.ok ? first.id : 0, "overturned", "Not spam; restored."), null);
  const restored = await status(q);
  assert.equal(restored.status, "active");
  assert.equal(restored.archived_at, null);
  // The removal's demerit goes with it.
  const [{ active }] = await query<{ active: number }>(
    "select count(*)::int as active from demerits where account_id = $1 and revoked_at is null", [person.id],
  );
  assert.equal(active, 0);
  assert.equal(await decideAppeal(mod.id, first.ok ? first.id : 0, "upheld", "again"), "decided");

  // A ban, appealed and overturned, is lifted.
  for (let i = 0; i < BAN_AT_POINTS; i++) await addDemerit({ accountId: person.id, kind: "spam", reason: "test" });
  const ban = await activeBan(person.id);
  assert.ok(ban);
  const banAppeal = await fileAppeal(person.id, "ban", ban!.id, "I was quoting someone.");
  assert.ok(banAppeal.ok);
  assert.equal(await decideAppeal(mod.id, banAppeal.ok ? banAppeal.id : 0, "overturned", "Context was clear."), null);
  assert.equal(await activeBan(person.id), null);
  assert.ok((await ask(person, `Is the ${tag} ferry slower in winter`)).ok);
  questionIds.push(...(await query<{ id: number }>("select id from questions where asked_by = $1", [person.id])).map((r) => r.id));

  // An upheld appeal changes nothing but is still logged.
  const d = (await query<{ id: number }>("select id::int from demerits where account_id = $1 and revoked_at is null limit 1", [person.id]))[0];
  const demeritAppeal = await fileAppeal(person.id, "demerit", d.id, "Please reconsider.");
  assert.ok(demeritAppeal.ok);
  assert.equal(await decideAppeal(mod.id, demeritAppeal.ok ? demeritAppeal.id : 0, "upheld", "It was spam."), null);

  const log = await query<{ action: string }>(
    "select action from moderation_log where subject = 'appeal' and account_id = $1 order by id", [person.id],
  );
  assert.deepEqual(log.map((l) => l.action), ["appeal_overturned", "appeal_overturned", "appeal_upheld"]);
  assert.ok((await query("select 1 from moderation_log where subject = 'ban' and action = 'lift' and account_id = $1", [person.id])).length);
  assert.ok((await query("select 1 from moderation_log where subject = 'question' and action = 'restore' and subject_id = $1", [q])).length);
});

test("a merge records its rule and combines votes by it; an overturned merge moves them back", async () => {
  const original = await makeQuestion(asker, `Is the ${tag} lake colder than the sea`);
  const repeat = await makeQuestion(asker, `Is the ${tag} lake colder than the ocean nearby`);
  const both = await makeAccount("both");
  const onlyRepeat = await makeAccount("only");
  await castVote(both, original, "true", false, "direct");
  await castVote(both, repeat, "false", false, "direct");
  await castVote(onlyRepeat, repeat, "false", false, "direct");

  assert.equal(await decide(mod.id, repeat, { action: "duplicate", of: repeat }), "self_merge");
  assert.equal(await decide(mod.id, repeat, { action: "duplicate", of: original }), null);
  const [merge] = await query<{ rule: string; votes_moved: number; votes_kept: number; moved_accounts: number[] }>(
    "select rule, votes_moved, votes_kept, moved_accounts from question_merges where from_question_id = $1", [repeat],
  );
  assert.equal(merge.rule, MERGE_RULE);
  assert.equal(merge.rule, "move_unanswered_keep_original");
  assert.deepEqual([merge.votes_moved, merge.votes_kept, merge.moved_accounts], [1, 1, [onlyRepeat.id]]);

  const votes = await query<{ account_id: number; value: string }>(
    "select account_id, value from votes where question_id = $1 order by account_id", [original],
  );
  assert.deepEqual(votes.map((v) => [v.account_id, v.value]), [[both.id, "true"], [onlyRepeat.id, "false"]]);
  const [counts] = await query<{ t: number; f: number }>("select true_count as t, false_count as f from questions where id = $1", [original]);
  assert.deepEqual(counts, { t: 1, f: 1 });
  const merged = await status(repeat);
  assert.equal(merged.status, "removed");
  assert.ok(merged.archived_at);

  const appeal = await fileAppeal(asker.id, "question", repeat, "They're different bodies of water.");
  assert.ok(appeal.ok);
  assert.equal(await decideAppeal(mod.id, appeal.ok ? appeal.id : 0, "overturned", "Fair, different question."), null);
  assert.equal((await status(repeat)).status, "active");
  const back = await query<{ account_id: number }>("select account_id from votes where question_id = $1 order by account_id", [repeat]);
  assert.deepEqual(back.map((v) => v.account_id), [both.id, onlyRepeat.id]);
  assert.equal((await query("select 1 from question_merges where from_question_id = $1", [repeat])).length, 0);
});

test("heavy reports hide pending review; auto-remove stays off unless REPORT_AUTO_REMOVE=true", async () => {
  const saved = process.env.REPORT_AUTO_REMOVE;
  delete process.env.REPORT_AUTO_REMOVE;
  try {
    assert.equal(autoRemoveDue(1000, 1000), false);
    const q = await makeQuestion(asker, `Is the ${tag} heavily reported claim true`);
    const voters = [];
    for (let i = 0; i < AUTO_REMOVE_MIN_VOTES; i++) voters.push(await makeAccount(`v${i}`));
    for (const [k, v] of voters.entries()) await castVote(v, q, k % 2 ? "true" : "false", false, "direct");
    // Half of the voters report it: far past both lines, and still only hidden.
    for (const v of voters.slice(0, AUTO_REMOVE_MIN_VOTES / 2)) await report(v.id, q, "hateful", "");
    const hidden = await status(q);
    assert.equal(hidden.status, "review");
    assert.equal(hidden.archived_at, null);
    assert.ok(AUTO_REMOVE_MIN_VOTES / 2 >= REPORT_THRESHOLD);

    process.env.REPORT_AUTO_REMOVE = "true";
    assert.equal(autoRemoveDue(AUTO_REMOVE_MIN_VOTES, Math.floor(AUTO_REMOVE_MIN_VOTES / 4) - 1), false);
    assert.equal(autoRemoveDue(AUTO_REMOVE_MIN_VOTES - 1, AUTO_REMOVE_MIN_VOTES), false);
    assert.equal(autoRemoveDue(AUTO_REMOVE_MIN_VOTES, Math.ceil(AUTO_REMOVE_MIN_VOTES / 4)), true);
    assert.equal(await report(voters.at(-1)!.id, q, "spam", ""), "removed");
    const removed = await status(q);
    assert.equal(removed.status, "removed");
    assert.ok(removed.archived_at);
    // No demerit: the rule decides nothing about harm.
    assert.equal(await demeritCount(asker.id), 0);
  } finally {
    if (saved === undefined) delete process.env.REPORT_AUTO_REMOVE;
    else process.env.REPORT_AUTO_REMOVE = saved;
  }
});

test("a burst of new accounts is a signal; confirming bans only those accounts, permanently", async () => {
  const target = await makeAccount("target", "paid");
  const q = await makeQuestion(target, `Is the ${tag} brigaded question popular`);
  const honest = await makeAccount("honest");
  await castVote(honest, q, "true", false, "direct");
  const socks = [];
  for (let k = 0; k < 8; k++) socks.push(await makeAccount(`sock${k}`));
  for (const s of socks) await castVote(s, q, "false", false, "direct");

  await scanForManipulation({ minAccounts: 8, windowMinutes: 10, newAccountDays: 7 });
  const signals = await query<{ id: number; detail: { accounts: number[] } }>(
    "select id::int, detail from manipulation_signals where question_id = $1 and reviewed_at is null", [q],
  );
  assert.equal(signals.length, 1);
  assert.deepEqual([...signals[0].detail.accounts].sort(), socks.map((s) => s.id).sort());
  // Scanning again doesn't raise it twice.
  await scanForManipulation({ minAccounts: 8, windowMinutes: 10, newAccountDays: 7 });
  assert.equal((await query("select 1 from manipulation_signals where question_id = $1", [q])).length, 1);

  // Trying to sneak the asker and an honest voter into the ban list does nothing.
  const result = await reviewSignal(mod.id, signals[0].id, "confirmed", [...socks.map((s) => s.id), target.id, honest.id]);
  assert.deepEqual(result, { ok: true, banned: 8 });
  for (const s of socks) {
    const ban = await activeBan(s.id, "voting");
    assert.ok(ban?.permanent && ban.cause === "manipulation");
  }
  assert.equal(await activeBan(target.id), null);
  assert.equal(await activeBan(honest.id), null);
  assert.deepEqual(await reviewSignal(mod.id, signals[0].id, "dismissed"), { ok: false, error: "reviewed" });
});
