import type { PoolClient } from "pg";
import { query, transaction } from "./db";
import { LIMITS } from "./limits";
import type { Account } from "./auth";

export type VoteValue = "true" | "false" | "unsure";
export const VOTE_VALUES: VoteValue[] = ["true", "false", "unsure"];

export const SOURCES = ["feed:contested", "feed:fresh", "feed:random", "feed:top", "search", "direct"] as const;
export type Source = (typeof SOURCES)[number];

export type MyVote = { question_id: number; value: VoteValue; is_private: boolean };

// Why a vote didn't count, for callers that route people (to sign up, to upgrade, to try
// again tomorrow) instead of only showing the message.
export type VoteFailure = "closed" | "change_used" | "limit_reached" | "private_limit" | "no_vote" | "banned";
export type VoteResult =
  | { ok: true; outcome?: "cast" | "same" | "changed" }
  | { ok: false; error: string; code?: VoteFailure };

// Where and when a vote was given. Everything is optional; the website sends none of it.
export type VoteMeta = {
  surface?: string;                              // see SURFACES in lib/front-door.ts
  placement?: string | null;
  surfaceContext?: Record<string, unknown> | null;
  shownAt?: Date | null;                         // when the question was put in front of them
  tappedAt?: Date;                               // when they tapped; earlier than now for held votes
  lang?: string | null;                          // the language the question was shown in (see cleanLang)
};

// A language tag as stored in votes.lang and vote_events.lang ("en", "pt-BR"): the shape
// question_translations.lang accepts. Anything else is recorded as unknown (null).
export function cleanLang(lang: unknown): string | null {
  if (typeof lang !== "string") return null;
  const m = /^([a-zA-Z]{2,3})(?:[-_]([a-zA-Z]{2}))?$/.exec(lang.trim());
  if (!m) return null;
  return m[2] ? `${m[1].toLowerCase()}-${m[2].toUpperCase()}` : m[1].toLowerCase();
}

const fail = (error: string, code?: VoteFailure): VoteResult => ({ ok: false, error, code });
const CHANGE_USED = "You already changed your vote on this question today. Try again tomorrow.";
const CLOSED = "This question is closed to new votes.";
const BANNED = "This account can't vote. You can appeal at /appeals.";
const CLOSED_EDIT = "This question is closed, so votes on it can't be changed.";

// Archived and removed questions take no answers and no edits. A question under review takes
// no new answers, but a vote already on it can still be changed or withdrawn.
const FROZEN = ["archived", "removed"];
const isActive = (status: string) => status === "active";
const isEditable = (status: string) => !FROZEN.includes(status);

// Thrown inside a vote's transaction when the question closed while the vote was being
// written; the transaction rolls back and the caller gets "closed".
class QuestionClosed extends Error {}
const closedOr = (message: string) => (err: unknown): VoteResult => {
  if (err instanceof QuestionClosed) return fail(message, "closed");
  throw err;
};

function timing(meta: VoteMeta) {
  const tappedAt = meta.tappedAt ?? new Date();
  const shownAt = meta.shownAt ?? null;
  const ms = shownAt ? tappedAt.getTime() - shownAt.getTime() : NaN;
  const answerMs = ms >= 0 && ms <= 24 * 3600 * 1000 ? ms : null;
  return { tappedAt, shownAt, answerMs };
}

// Today's UTC calendar day as a range on created_at, so only this month's partition of
// vote_events is read (wrapping the column, as in ::date, would read every month).
const TODAY_RANGE = `created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
                 and created_at <  (date_trunc('day', now() at time zone 'utc') at time zone 'utc') + interval '1 day'`;

async function countToday(client: PoolClient, accountId: number, where: string, params: unknown[] = []) {
  const res = await client.query<{ n: number }>(
    `select count(*)::int as n from vote_events
      where account_id = $1 and ${TODAY_RANGE} and ${where}`,
    [accountId, ...params],
  );
  return res.rows[0].n;
}

// One change per question per day, for every tier. A change is a new value or a delete.
// M1: history a merge moved here, and a change made in answer to a merge heads-up, don't count.
const SPENT_CHANGE = "action in ('change', 'delete') and moved_by_merge is null and merge_review is null";
async function changedToday(client: PoolClient, accountId: number, questionId: number) {
  return (await countToday(client, accountId, `question_id = $2 and ${SPENT_CHANGE}`, [questionId])) > 0;
}

async function questionState(client: PoolClient, questionId: number) {
  const res = await client.query<{ status: string }>("select status from questions where id = $1", [questionId]);
  return res.rows[0] ?? null;
}

// Checked again once the vote is written. Writing a vote updates the question's counters (the
// trigger in 003_vote_counters.sql), which holds the question's row lock until commit, so this
// read sees any archive or removal that committed first; one that commits later comes after
// the vote. Either way no vote lands on a question after it closed.
async function assertStillOpen(client: PoolClient, questionId: number, allowed: (status: string) => boolean) {
  const state = await questionState(client, questionId);
  if (!state || !allowed(state.status)) throw new QuestionClosed();
}

// Takes this account's lock (votes for one account are serialised so daily limits can't be
// raced past), then reads everything a vote, change or skip decides on in one query.
//
// The lock must be its own statement. A `select ... for update` that waits for the lock
// re-checks only the locked row afterwards; everything else in that statement (today's counts,
// the current vote) would come from the snapshot taken before the wait, i.e. before the other
// transaction's vote, and two racing votes could both spend the last one. The read after the
// lock takes a fresh snapshot that includes whatever the previous holder committed.
type VoteState = {
  status: string | null;                // the question's status; null if there is no such question
  value: VoteValue | null;              // the current vote, if any
  is_private: boolean | null;
  casts_today: number;
  changed_today: boolean;               // this vote was already changed or withdrawn today
  merge_review: number | null;          // M1: an open merge heads-up here; the next change is free
  private_changes_today: number;        // only counted when the current vote is private
  revealed: boolean;
  skipped: boolean;
  first: { value: VoteValue; at: string; surface: string; answer_ms: number | null; blind: boolean | null } | null;
};

async function lockAndRead(client: PoolClient, accountId: number, questionId: number, withFirst: boolean): Promise<VoteState> {
  const locked = await client.query("select 1 from accounts where id = $1 for update", [accountId]);
  if (!locked.rowCount) throw new Error(`account ${accountId} not found`);
  // Named, so each connection plans this once and reuses the plan. Planning it fresh (four
  // look-ups in the monthly-partitioned vote_events) cost about 4.6 ms of database CPU per
  // vote, more than everything else in a vote together, and capped the engine near 700 a second.
  const res = await client.query<VoteState>({
    name: "vote-state",
    text: `select q.status, v.value, v.is_private,
            (select count(*)::int from vote_events e
              where e.account_id = $1 and ${TODAY_RANGE} and e.action = 'cast') as casts_today,
            exists (select 1 from vote_events e
                     where e.account_id = $1 and e.question_id = $2 and ${TODAY_RANGE}
                       and e.action in ('change', 'delete') and e.moved_by_merge is null and e.merge_review is null) as changed_today,
            (select n.merge_id::int from merge_notices n
              where n.account_id = $1 and n.into_question_id = $2 and n.dismissed_at is null and n.changed_at is null
              order by n.id desc limit 1) as merge_review,
            case when v.is_private then
              (select count(*)::int from vote_events e
                where e.account_id = $1 and ${TODAY_RANGE} and e.action = 'change' and e.is_private)
            else 0 end as private_changes_today,
            exists (select 1 from reveals r where r.account_id = $1 and r.question_id = $2) as revealed,
            exists (select 1 from skips s where s.account_id = $1 and s.question_id = $2) as skipped,
            case when v.value is null and $3 then
              (select json_build_object('value', f.value, 'at', coalesce(f.tapped_at, f.created_at), 'surface', f.surface,
                                        'answer_ms', f.answer_ms, 'blind', f.blind)
                 from vote_events f
                where f.account_id = $1 and f.question_id = $2 and f.action = 'cast'
                order by f.created_at, f.id limit 1)
            end as first
       from accounts a
       left join questions q on q.id = $2
       left join votes v on v.account_id = a.id and v.question_id = $2
      where a.id = $1`,
    values: [accountId, questionId, withFirst],
  });
  return res.rows[0];
}

// Which question statuses an event may still be written under (see insertEvent).
const OPEN_FOR_CAST = "status = 'active'";
const OPEN_FOR_EDIT = "status not in ('archived', 'removed')";

// Writes a cast or change event, but only if the question is still open, and throws
// QuestionClosed (rolling the vote back) if it isn't. It runs after the vote row is written,
// which fired the counter trigger (003_vote_counters.sql) and so holds the question's row lock
// until commit; this statement therefore sees any archive or removal that committed first, and
// one that commits later comes after the vote. Either way no vote lands on a closed question.
// M1: `mergeReview` marks a change made in answer to a merge heads-up (it doesn't use up the
// day's change).
async function insertEvent(client: PoolClient, action: "cast" | "change", open: string, params: unknown[], mergeReview: number | null = null) {
  const res = await client.query(
    `insert into vote_events (account_id, question_id, action, value, is_private, source, blind,
                              surface, placement, surface_context, shown_at, tapped_at, answer_ms, lang, merge_review)
     select $1::int, $2::int, '${action}', $3::text, $4::boolean, $5::text, $6::boolean,
            $7::text, $8::text, $9::jsonb, $10::timestamptz, $11::timestamptz, $12::int, $13::text, $14::bigint
       from questions where id = $2::int and ${open}`,
    [...params, mergeReview],
  );
  if (res.rowCount !== 1) throw new QuestionClosed();
}

async function currentVote(client: PoolClient, accountId: number, questionId: number) {
  const res = await client.query<{ value: VoteValue; is_private: boolean }>(
    "select value, is_private from votes where account_id = $1 and question_id = $2 for update",
    [accountId, questionId],
  );
  return res.rows[0] ?? null;
}

// Cast a first vote, or change an existing one. `isPrivate` only applies to a first vote;
// visibility of an existing vote is changed with setVisibility. Every surface reaches this
// through lib/vote-engine.ts; `meta` says where and how fast the answer was given, and in
// which language.
export function castVote(
  account: Account,
  questionId: number,
  value: VoteValue,
  isPrivate: boolean,
  source: Source,
  meta: VoteMeta = {},
): Promise<VoteResult> {
  const limits = LIMITS[account.tier];
  const surface = meta.surface ?? "web";
  const placement = meta.placement ?? null;
  const context = meta.surfaceContext ? JSON.stringify(meta.surfaceContext) : null;
  const lang = cleanLang(meta.lang);
  const { tappedAt, shownAt, answerMs } = timing(meta);
  return transaction(async (client): Promise<VoteResult> => {
    // Serialise this account's votes so daily limits can't be raced past, and read everything
    // the rules need in the same round trip.
    const state = await lockAndRead(client, account.id, questionId, true);
    if (!state.status || !isEditable(state.status)) return fail(CLOSED, "closed");
    // A ban from everything (only ever for confirmed vote manipulation) stops voting too; a ban
    // from asking never does. Bans are rare and indexed by account, so this stays cheap.
    const banned = await client.query(
      `select 1 from bans where account_id = $1 and scope = 'all' and lifted_at is null
          and starts_at <= now() and (permanent or ends_at > now()) limit 1`,
      [account.id],
    );
    if (banned.rowCount) return fail(BANNED, "banned");

    if (!state.value) {
      if (!isActive(state.status)) return fail(CLOSED, "closed");
      if (state.changed_today) return fail(CHANGE_USED, "change_used");
      if (state.casts_today >= limits.votesPerDay) {
        return fail(`You've used your ${limits.votesPerDay} votes for today.`, "limit_reached");
      }
      const blind = !state.revealed;
      // A vote that was deleted and is now given again keeps its first answer: the re-vote is a
      // change in the history, not a new first instinct.
      const first = state.first;
      let priorChanges = 0;
      if (first) {
        const prior = await client.query<{ changes: number }>(
          `select count(*)::int as changes from vote_events
            where account_id = $1 and question_id = $2 and action in ('change', 'delete')`,
          [account.id, questionId],
        );
        priorChanges = prior.rows[0].changes;
      }
      if (state.skipped) {
        await client.query("delete from skips where account_id = $1 and question_id = $2", [account.id, questionId]);
      }
      // Writing the vote fires the counter trigger, which holds the question's row until commit;
      // from here on, as few round trips as possible.
      await client.query(
        `insert into votes (account_id, question_id, value, is_private, first_value, first_cast_at, first_surface,
                            first_answer_ms, first_blind, change_count, last_changed_at, lang)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        first
          ? [account.id, questionId, value, isPrivate, first.value, new Date(first.at), first.surface, first.answer_ms,
             first.blind, priorChanges + 1, tappedAt, lang]
          : [account.id, questionId, value, isPrivate, value, tappedAt, surface, answerMs, blind, 0, null, lang],
      );
      await insertEvent(client, "cast", OPEN_FOR_CAST, [
        account.id, questionId, value, isPrivate, source, blind, surface, placement, context, shownAt, tappedAt, answerMs, lang,
      ]);
      return { ok: true, outcome: "cast" };
    }

    if (state.value === value) return { ok: true, outcome: "same" };
    // M1: the first change after a merge moved this answer here is free.
    if (state.changed_today && !state.merge_review) return fail(CHANGE_USED, "change_used");
    if (state.is_private && state.private_changes_today >= limits.privateRecastsPerDay) {
      return fail(`You've used your ${limits.privateRecastsPerDay} private vote changes for today.`, "private_limit");
    }
    // votes.lang is the language the current answer was given in.
    await client.query(
      `update votes set value = $3, updated_at = now(), change_count = change_count + 1, last_changed_at = $4, lang = $5
        where account_id = $1 and question_id = $2`,
      [account.id, questionId, value, tappedAt, lang],
    );
    await insertEvent(client, "change", OPEN_FOR_EDIT, [
      account.id, questionId, value, state.is_private, source, null, surface, placement, context, shownAt, tappedAt, answerMs, lang,
    ], state.merge_review);
    if (state.merge_review) {
      // M1: the heads-up is answered.
      await client.query(
        "update merge_notices set changed_at = now() where account_id = $1 and into_question_id = $2 and changed_at is null and dismissed_at is null",
        [account.id, questionId],
      );
    }
    return { ok: true, outcome: "changed" };
  }).catch(closedOr(CLOSED));
}

// Remove your vote. The question stays, and can come back around in your feed. A vote on an
// archived or removed question stays as it was (it goes when the account is deleted).
export function deleteVote(account: Account, questionId: number, source: Source): Promise<VoteResult> {
  return transaction(async (client): Promise<VoteResult> => {
    await client.query("select 1 from accounts where id = $1 for update", [account.id]);
    const existing = await currentVote(client, account.id, questionId);
    if (!existing) return { ok: true };
    const question = await questionState(client, questionId);
    if (!question || !isEditable(question.status)) return fail(CLOSED_EDIT, "closed");
    if (await changedToday(client, account.id, questionId)) return fail(CHANGE_USED, "change_used");
    await client.query("delete from votes where account_id = $1 and question_id = $2", [account.id, questionId]);
    await assertStillOpen(client, questionId, isEditable);
    await client.query(
      `insert into vote_events (account_id, question_id, action, value, is_private, source)
       values ($1, $2, 'delete', null, $3, $4)`,
      [account.id, questionId, existing.is_private, source],
    );
    return { ok: true };
  }).catch(closedOr(CLOSED_EDIT));
}

// Private to public is always free. Public to private is limited on the free tier. On an
// archived or removed question a vote can still be hidden (that changes no answer and no
// split), but not made public.
export function setVisibility(account: Account, questionId: number, isPrivate: boolean): Promise<VoteResult> {
  const limits = LIMITS[account.tier];
  return transaction(async (client) => {
    await client.query("select 1 from accounts where id = $1 for update", [account.id]);
    const existing = await currentVote(client, account.id, questionId);
    if (!existing) return fail("Vote first, then choose who can see it.", "no_vote");
    if (existing.is_private === isPrivate) return { ok: true };
    if (!isPrivate) {
      const question = await questionState(client, questionId);
      if (!question || !isEditable(question.status)) return fail(CLOSED_EDIT, "closed");
    }
    if (
      isPrivate &&
      (await countToday(client, account.id, "action = 'visibility' and is_private")) >= limits.publicToPrivatePerDay
    ) {
      return fail(`You've made ${limits.publicToPrivatePerDay} votes private today. Try again tomorrow.`);
    }
    await client.query(
      "update votes set is_private = $3, updated_at = now() where account_id = $1 and question_id = $2",
      [account.id, questionId, isPrivate],
    );
    await client.query(
      `insert into vote_events (account_id, question_id, action, value, is_private, source)
       values ($1, $2, 'visibility', $3, $4, 'direct')`,
      [account.id, questionId, existing.value, isPrivate],
    );
    return { ok: true };
  });
}

// Skip a question. It goes back into the pool, and the skip is recorded so "skipped first,
// answered later" shows in the history. A skip is not a vote: it adds nothing to the split and
// uses none of the day's votes. Skipping a question already answered changes nothing (the
// history would otherwise read as the vote being withdrawn), and neither does skipping an
// archived or removed question. Returns whether it was recorded.
export function skip(account: Account, questionId: number, source: Source = "direct", meta: VoteMeta = {}): Promise<boolean> {
  const surface = meta.surface ?? "web";
  const context = meta.surfaceContext ? JSON.stringify(meta.surfaceContext) : null;
  const lang = cleanLang(meta.lang);
  const { tappedAt, shownAt, answerMs } = timing(meta);
  return transaction(async (client) => {
    const state = await lockAndRead(client, account.id, questionId, false);
    if (!state.status || !isEditable(state.status) || state.value) return false;
    await client.query(
      `insert into vote_events (account_id, question_id, action, value, is_private, source,
                                surface, placement, surface_context, shown_at, tapped_at, answer_ms, lang)
       values ($1, $2, 'skip', null, false, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [account.id, questionId, source, surface, meta.placement ?? null, context, shownAt, tappedAt, answerMs, lang],
    );
    await client.query(
      `insert into skips (account_id, question_id) values ($1, $2)
       on conflict (account_id, question_id) do update set skipped_at = now()`,
      [account.id, questionId],
    );
    return true;
  });
}

// The voter asked to see results before voting; their first vote will not count as blind.
export async function reveal(account: Account, questionId: number): Promise<void> {
  await query(
    "insert into reveals (account_id, question_id) values ($1, $2) on conflict do nothing",
    [account.id, questionId],
  );
}

export async function hasRevealed(accountId: number, questionId: number): Promise<boolean> {
  const rows = await query("select 1 from reveals where account_id = $1 and question_id = $2", [accountId, questionId]);
  return rows.length > 0;
}

export async function myVotes(accountId: number, questionIds: number[]): Promise<Map<number, MyVote>> {
  if (!questionIds.length) return new Map();
  const rows = await query<MyVote>(
    "select question_id, value, is_private from votes where account_id = $1 and question_id = any($2::int[])",
    [accountId, questionIds],
  );
  return new Map(rows.map((r) => [r.question_id, r]));
}
