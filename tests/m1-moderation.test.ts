// M1, the owner's moderation decisions, against DATABASE_URL: approval marks a question and
// wipes its report slate while the ledger keeps the reports; an approved question can be
// reported and hidden again; suspected duplicates stay live and a dismissed pair isn't suggested
// again; inverted merges flip true/false, keep unsure, keep counters exact and record the
// original answer; people whose answer moved get a heads-up and a free change; overturning an
// inverted merge restores everything. Cleans up after itself.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { exportData } from "../lib/account";
import type { Account } from "../lib/auth";
import { pool, query } from "../lib/db";
import { toCard } from "../lib/cards";
import { beliefMap } from "../lib/map";
import { ask, getQuestion, normalize } from "../lib/questions";
import { castVote } from "../lib/votes";
import {
  decide, decideAppeal, decideDuplicate, dismissMergeNotice, duplicatesQueue, fileAppeal, isRuleId, openMergeNotices,
  queue, report, REPORT_THRESHOLD, RULEBOOK, suggestDuplicate,
} from "../lib/moderation";

const tag = `m1${Date.now().toString(36)}`;
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

// Straight into the table, so the ask-time duplicate check doesn't pair test questions.
async function makeQuestion(text: string): Promise<number> {
  const [row] = await query<{ id: number }>(
    "insert into questions (text, normalized, asked_by) values ($1, $2, $3) returning id",
    [text, normalize(text), asker.id],
  );
  questionIds.push(row.id);
  return row.id;
}

const vote = async (who: Account, q: number, value: "true" | "false" | "unsure") => {
  const result = await castVote(who, q, value, false, "direct");
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result;
};

const statusOf = async (id: number) =>
  (await query<{ status: string; approved_at: Date | null }>("select status, approved_at from questions where id = $1", [id]))[0];

// The counters on the question must match the votes table exactly.
async function assertCountersExact(id: number) {
  const [row] = await query<{ t: number; f: number; u: number; vt: number; vf: number; vu: number }>(
    `select q.true_count as t, q.false_count as f, q.unsure_count as u,
            (select count(*)::int from votes where question_id = q.id and value = 'true') as vt,
            (select count(*)::int from votes where question_id = q.id and value = 'false') as vf,
            (select count(*)::int from votes where question_id = q.id and value = 'unsure') as vu
       from questions q where q.id = $1`,
    [id],
  );
  assert.deepEqual([row.t, row.f, row.u], [row.vt, row.vf, row.vu], `counters on #${id}`);
  return { t: row.t, f: row.f, u: row.u };
}

const votesOn = (id: number) =>
  query<{ account_id: number; value: string; first_value: string | null }>(
    "select account_id, value, first_value from votes where question_id = $1 order by account_id", [id],
  );

before(async () => {
  asker = await makeAccount("asker", "paid");
  mod = await makeAccount("mod", "free", "moderator");
});

after(async () => {
  await query("delete from questions where id = any($1::int[]) or asked_by in (select id from accounts where username like $2)", [questionIds, `${tag}\\_%`]);
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await pool.end();
});

const openCounted = async (id: number) =>
  (await query<{ n: number }>(
    "select count(*)::int as n from reports where question_id = $1 and resolved_at is null and cleared_at is null", [id],
  ))[0].n;

test("approval marks the question and wipes its report count; the old reports stay in the ledger", async () => {
  const q = await makeQuestion(`Is the ${tag} approval question about lighthouses`);
  const reporters = await Promise.all(Array.from({ length: REPORT_THRESHOLD }, (_, i) => makeAccount(`ra${i}`)));
  for (const r of reporters) await report(r.id, q, "spam", "");
  assert.equal((await statusOf(q)).status, "review");
  assert.equal(await getQuestion(q).then((x) => x?.approved), false);

  assert.equal(await decide(mod.id, q, { action: "approve" }), null);
  const after = await statusOf(q);
  assert.equal(after.status, "active");
  assert.ok(after.approved_at, "the moderator approved mark is set");
  assert.equal((await getQuestion(q))?.approved, true);
  assert.equal(await openCounted(q), 0, "the report count is wiped clean");
  assert.ok(!(await queue(500)).some((i) => i.id === q), "an approved question leaves the queue");

  // The ledger keeps every report, marked cleared by the moderator.
  const ledger = await query<{ cleared_at: Date | null; cleared_by: number | null }>(
    "select cleared_at, cleared_by from reports where question_id = $1", [q],
  );
  assert.equal(ledger.length, REPORT_THRESHOLD);
  assert.ok(ledger.every((r) => r.cleared_at && r.cleared_by === mod.id));
  const [log] = await query<{ rule_id: string }>(
    "select rule_id from moderation_log where subject = 'question' and subject_id = $1 and action = 'approve'", [q],
  );
  assert.equal(log.rule_id, "keep_reviewed");

  // The mark reaches the feed cards.
  const card = toCard({ id: q, text: "x", status: "active", category: "general", t: 0, f: 0, u: 0, approved: true }, null);
  assert.equal(card.approved, true);
});

test("an approved question can be reported again, and hidden again by new reports", async () => {
  const q = await makeQuestion(`Is the ${tag} second look question about canals`);
  const reporters = await Promise.all(Array.from({ length: REPORT_THRESHOLD }, (_, i) => makeAccount(`rb${i}`)));
  for (const r of reporters) await report(r.id, q, "hateful", "");
  assert.equal(await decide(mod.id, q, { action: "approve" }), null);

  // The same people report again: new rows, the old ones untouched.
  for (const r of reporters.slice(0, -1)) assert.equal(await report(r.id, q, "other", "again"), "recorded");
  assert.equal((await statusOf(q)).status, "active", "below the threshold it stays live");
  assert.equal(await openCounted(q), REPORT_THRESHOLD - 1);
  assert.equal(await report(reporters.at(-1)!.id, q, "other", "again"), "hidden");
  const hidden = await statusOf(q);
  assert.equal(hidden.status, "review");
  assert.ok(hidden.approved_at, "it keeps the mark from before");
  const all = await query<{ cleared: boolean }>("select cleared_at is not null as cleared from reports where question_id = $1", [q]);
  assert.equal(all.length, REPORT_THRESHOLD * 2);
  assert.equal(all.filter((r) => r.cleared).length, REPORT_THRESHOLD);
});

test("a suspected duplicate goes to the queue and stays live, taking answers", async () => {
  const original = await ask(asker, `Did the ${tag} Democrats win the 2026 midterm election`);
  assert.ok(original.ok, original.ok ? "" : original.error);
  questionIds.push(original.id);
  const repeat = await ask(asker, `Did the ${tag} Democrats not lose the 2026 midterm election`);
  assert.ok(repeat.ok, repeat.ok ? "" : repeat.error);
  questionIds.push(repeat.id);

  const [pair] = await query<{ id: number; source: string; status: string }>(
    "select id::int, source, status from duplicate_suspects where question_a = $1 and question_b = $2",
    [Math.min(original.id, repeat.id), Math.max(original.id, repeat.id)],
  );
  assert.ok(pair, "the near-match was queued at ask time");
  assert.deepEqual([pair.source, pair.status], ["ask", "open"]);
  assert.equal((await statusOf(repeat.id)).status, "active");
  assert.equal((await statusOf(original.id)).status, "active");

  // "Repeats another question" reports never hide it, however many.
  const reporters = await Promise.all(Array.from({ length: REPORT_THRESHOLD + 1 }, (_, i) => makeAccount(`rd${i}`)));
  for (const r of reporters) assert.equal(await report(r.id, repeat.id, "duplicate", "", original.id), "duplicate_queue");
  assert.equal((await statusOf(repeat.id)).status, "active");
  const voter = await makeAccount("dupvoter");
  await vote(voter, repeat.id, "true");

  const queued = (await duplicatesQueue(500)).find((p) => p.id === pair.id);
  assert.ok(queued);
  assert.equal(queued.times_suggested, 1 + reporters.length);
  assert.equal(queued.b.votes + queued.a.votes, 1);
  // Vote counts only: never which way people answered.
  for (const side of [queued.a, queued.b]) {
    assert.deepEqual(Object.keys(side).sort(), ["asked_by_user", "created_at", "id", "status", "text", "votes"]);
  }

  // A moderator can pair two questions too.
  const third = await makeQuestion(`Is the ${tag} third question about tides`);
  assert.equal(await decide(mod.id, third, { action: "suggest_duplicate", of: original.id }), null);
  const [byMod] = await query<{ source: string }>(
    "select source from duplicate_suspects where question_a = $1 and question_b = $2",
    [Math.min(third, original.id), Math.max(third, original.id)],
  );
  assert.equal(byMod.source, "moderator");
  assert.equal((await statusOf(third)).status, "active");
});

test("a pair dismissed as not duplicates is never suggested again", async () => {
  const a = await makeQuestion(`Did the ${tag} Democrats win the 2028 race`);
  const b = await makeQuestion(`Did the ${tag} Republicans lose the 2028 race`);
  assert.equal(await suggestDuplicate({ a, b, source: "moderator", by: mod.id }), "suggested");
  const [pair] = await query<{ id: number }>("select id::int from duplicate_suspects where question_a = $1 and question_b = $2", [a, b]);
  assert.equal(await decideDuplicate(mod.id, pair.id, { action: "dismiss" }), null);
  assert.equal(await decideDuplicate(mod.id, pair.id, { action: "dismiss" }), "decided");

  assert.equal(await suggestDuplicate({ a: b, b: a, source: "ask", similarity: 0.9 }), "settled");
  const reporter = await makeAccount("redismiss");
  assert.equal(await report(reporter.id, b, "duplicate", "", a), "duplicate_queue");
  const rows = await query<{ status: string; rule_id: string; times_suggested: number }>(
    "select status, rule_id, times_suggested from duplicate_suspects where question_a = $1 and question_b = $2", [a, b],
  );
  assert.deepEqual(rows, [{ status: "dismissed", rule_id: "dup_different_subject", times_suggested: 1 }]);
  assert.ok(!(await duplicatesQueue(500)).some((p) => p.id === pair.id));
  assert.equal((await statusOf(a)).status, "active");
  assert.equal((await statusOf(b)).status, "active");
});

test("an inverted merge flips true and false, keeps unsure, keeps counters exact and records the original answer", async () => {
  const original = await makeQuestion(`Did the ${tag} Greens win the 2030 council vote`);
  const repeat = await makeQuestion(`Did the ${tag} Greens not lose the 2030 council vote`);
  const yes = await makeAccount("inv_yes"), no = await makeAccount("inv_no");
  const unsure = await makeAccount("inv_unsure"), both = await makeAccount("inv_both");
  await vote(yes, repeat, "true");
  await vote(no, repeat, "false");
  await vote(unsure, repeat, "unsure");
  await vote(both, original, "true");
  await vote(both, repeat, "false");

  assert.equal(await suggestDuplicate({ a: original, b: repeat, source: "moderator", by: mod.id }), "suggested");
  const [pair] = await query<{ id: number }>("select id::int from duplicate_suspects where question_a = $1 and question_b = $2", [original, repeat]);
  assert.equal(await decideDuplicate(mod.id, pair.id, { action: "merge", inverted: true, keep: 999999999 }), "keep_not_in_pair");
  assert.equal(await decideDuplicate(mod.id, pair.id, { action: "merge", inverted: true, keep: original }), null);

  const [merge] = await query<{ id: number; inverted: boolean; rule_id: string; votes_moved: number; votes_kept: number }>(
    "select id::int, inverted, rule_id, votes_moved, votes_kept from question_merges where from_question_id = $1", [repeat],
  );
  assert.deepEqual([merge.inverted, merge.rule_id, merge.votes_moved, merge.votes_kept], [true, "dup_inverted_polarity", 3, 1]);
  assert.ok(isRuleId(merge.rule_id) && RULEBOOK.some((r) => r.id === merge.rule_id));
  assert.equal((await query<{ status: string }>("select status from duplicate_suspects where id = $1", [pair.id]))[0].status, "merged");

  // Moved answers flipped; the person who answered both keeps their own answer on the original.
  const moved = new Map((await votesOn(original)).map((v) => [v.account_id, [v.value, v.first_value]]));
  assert.deepEqual(moved.get(yes.id), ["false", "false"]);
  assert.deepEqual(moved.get(no.id), ["true", "true"]);
  assert.deepEqual(moved.get(unsure.id), ["unsure", "unsure"]);
  assert.deepEqual(moved.get(both.id), ["true", "true"]);
  assert.deepEqual(await votesOn(repeat), [{ account_id: both.id, value: "false", first_value: "false" }]);
  assert.deepEqual(await assertCountersExact(original), { t: 2, f: 1, u: 1 });
  assert.deepEqual(await assertCountersExact(repeat), { t: 0, f: 1, u: 0 });

  // The history records the move with the answer as originally given.
  const history = await query<{ account_id: number; question_id: number; value: string; original_value: string; moved_by_merge: number }>(
    `select account_id, question_id, value, original_value, moved_by_merge::int from vote_events
      where account_id = any($1::int[]) and action = 'cast' order by account_id, question_id`,
    [[yes.id, no.id, unsure.id]],
  );
  assert.deepEqual(history.map((h) => [h.account_id, h.question_id, h.value, h.original_value, h.moved_by_merge]), [
    [yes.id, original, "false", "true", merge.id],
    [no.id, original, "true", "false", merge.id],
    [unsure.id, original, "unsure", "unsure", merge.id],
  ]);
  const bothHistory = await query<{ question_id: number; moved_by_merge: number | null }>(
    "select question_id, moved_by_merge from vote_events where account_id = $1 order by question_id", [both.id],
  );
  assert.deepEqual(bothHistory.map((h) => [h.question_id, h.moved_by_merge]), [[original, null], [repeat, null]]);

  // Heads-ups for moved answers only.
  const notices = await query<{ account_id: number; original_value: string; counted_value: string }>(
    "select account_id, original_value, counted_value from merge_notices where merge_id = $1 order by account_id", [merge.id],
  );
  assert.deepEqual(notices.map((x) => [x.account_id, x.original_value, x.counted_value]), [
    [yes.id, "true", "false"], [no.id, "false", "true"], [unsure.id, "unsure", "unsure"],
  ]);
  assert.deepEqual(await openMergeNotices(both.id, original), []);
});

test("the heads-up is shown on the original, marked seen, and dismissed by keeping the answer", async () => {
  const original = await makeQuestion(`Is the ${tag} river wider than the canal`);
  const repeat = await makeQuestion(`Is the ${tag} canal not wider than the river`);
  const [person, stranger] = await Promise.all([makeAccount("notice"), makeAccount("stranger")]);
  await vote(person, repeat, "true");
  assert.equal(await decide(mod.id, repeat, { action: "duplicate", of: original, inverted: true }), null);

  const [shown] = await openMergeNotices(person.id, original);
  assert.ok(shown);
  assert.equal(shown.from_text, `Is the ${tag} canal not wider than the river`);
  assert.deepEqual([shown.original_value, shown.counted_value, shown.inverted], ["true", "false", true]);
  const [seen] = await query<{ seen_at: Date | null }>("select seen_at from merge_notices where id = $1", [shown.id]);
  assert.ok(seen.seen_at);
  assert.deepEqual(await openMergeNotices(person.id, repeat), [], "only on the original's page");

  assert.equal(await dismissMergeNotice(stranger.id, shown.id), false, "nobody else can dismiss it");
  assert.equal(await dismissMergeNotice(person.id, shown.id), true);
  assert.deepEqual(await openMergeNotices(person.id, original), []);
  const [kept] = await votesOn(original);
  assert.deepEqual([kept.account_id, kept.value], [person.id, "false"], "keeping changes nothing");
});

test("changing an answer after a merge doesn't use up the day's change", async () => {
  const original = await makeQuestion(`Is the ${tag} tower taller than the bridge`);
  const repeat = await makeQuestion(`Is the ${tag} bridge not taller than the tower`);
  const person = await makeAccount("freechange");
  await vote(person, repeat, "true");
  // They already changed their answer on the repeat today; that history moves with them.
  assert.equal((await castVote(person, repeat, "false", false, "direct")).ok, true);
  assert.equal((await castVote(person, repeat, "unsure", false, "direct")).ok, false, "one change per day");
  assert.equal(await decide(mod.id, repeat, { action: "duplicate", of: original, inverted: true }), null);
  assert.equal((await votesOn(original))[0].value, "true");

  // The change in answer to the heads-up is free, and closes it.
  assert.deepEqual(await castVote(person, original, "false", false, "direct"), { ok: true, outcome: "changed" });
  const [notice] = await query<{ changed_at: Date | null }>(
    "select changed_at from merge_notices where account_id = $1 and into_question_id = $2", [person.id, original],
  );
  assert.ok(notice.changed_at);
  const [review] = await query<{ merge_review: number | null }>(
    "select merge_review from vote_events where account_id = $1 and question_id = $2 order by id desc limit 1", [person.id, original],
  );
  assert.ok(review.merge_review, "the free change is marked in the history");
  // Their one change for today is still there...
  assert.deepEqual(await castVote(person, original, "unsure", false, "direct"), { ok: true, outcome: "changed" });
  // ...and now it's spent.
  const spent = await castVote(person, original, "true", false, "direct");
  assert.equal(spent.ok, false);
  assert.equal(spent.ok ? null : spent.code, "change_used");
  await assertCountersExact(original);
});

test("overturning an inverted merge on appeal restores every answer, history and counter", async () => {
  const original = await makeQuestion(`Is the ${tag} museum older than the library`);
  const repeat = await makeQuestion(`Is the ${tag} library not older than the museum`);
  const [p1, p2, p3, both] = await Promise.all(["p1", "p2", "p3", "both"].map((x) => makeAccount(`undo_${x}`)));
  await vote(p1, repeat, "true");
  await vote(p2, repeat, "false");
  await vote(p3, repeat, "unsure");
  await vote(both, original, "false");
  await vote(both, repeat, "true");
  const accounts = [p1.id, p2.id, p3.id, both.id];
  const snapshot = async () => ({
    original: await votesOn(original),
    repeat: await votesOn(repeat),
    counters: [await assertCountersExact(original), await assertCountersExact(repeat)],
    history: await query(
      `select id::int, account_id, question_id, action, value, original_value, moved_by_merge, merge_review from vote_events
        where account_id = any($1::int[]) order by id`,
      [accounts],
    ),
  });
  const before = await snapshot();

  assert.equal(await decide(mod.id, repeat, { action: "duplicate", of: original, inverted: true }), null);
  const merged = await snapshot();
  assert.notDeepEqual(merged, before);
  assert.equal((await query("select 1 from merge_notices where from_question_id = $1", [repeat])).length, 3);

  const appeal = await fileAppeal(asker.id, "question", repeat, "Different claim, not the same question.");
  assert.ok(appeal.ok);
  assert.equal(await decideAppeal(mod.id, appeal.ok ? appeal.id : 0, "overturned", "Agreed, keep them apart."), null);

  assert.equal((await statusOf(repeat)).status, "active");
  assert.deepEqual(await snapshot(), before, "answers, first answers, history and counters are back as they were");
  assert.equal((await query("select 1 from question_merges where from_question_id = $1", [repeat])).length, 0);
  assert.equal((await query("select 1 from merge_notices where from_question_id = $1", [repeat])).length, 0);
  assert.equal((await query("select 1 from moderation_log where subject_id = $1 and action = 'unmerge'", [repeat])).length, 1);
});

test("a denied question records its rule and leaves the asker's map and export", async () => {
  const q = await makeQuestion(`Is the ${tag} denied question about a neighbour`);
  const voter = await makeAccount("deniedvoter");
  await vote(voter, q, "true");
  assert.equal(await decide(mod.id, q, { action: "remove", why: "Names a private person.", fix: "Ask about a public figure.", harm: "private_person" }), null);
  const [row] = await query<{ removed_rule: string }>("select removed_rule from questions where id = $1", [q]);
  assert.equal(row.removed_rule, "deny_private_person");
  const [log] = await query<{ rule_id: string }>("select rule_id from moderation_log where subject_id = $1 and action = 'remove'", [q]);
  assert.equal(log.rule_id, "deny_private_person");

  assert.ok(!(await beliefMap(voter.id, { locale: "en" })).entries.some((e) => e.questionId === q));
  const exported = await exportData(voter.id);
  assert.equal(exported.currentVotes.length, 0);
  assert.equal(exported.voteHistory.length, 0);
  assert.equal(exported.answersOnRemovedQuestions.length, 1);
  assert.equal(await getQuestion(q), null);
});
