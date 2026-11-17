import type { PoolClient } from "pg";
import { query, transaction } from "./db";
import { LIMITS, TODAY_UTC } from "./limits";
import type { Account } from "./auth";

export type VoteValue = "true" | "false" | "unsure";
export const VOTE_VALUES: VoteValue[] = ["true", "false", "unsure"];

export const SOURCES = ["feed:contested", "feed:fresh", "feed:random", "feed:top", "search", "direct"] as const;
export type Source = (typeof SOURCES)[number];

export type MyVote = { question_id: number; value: VoteValue; is_private: boolean };

// Why a vote didn't count, for callers that route people (to sign up, to upgrade, to try
// again tomorrow) instead of only showing the message.
export type VoteFailure = "closed" | "change_used" | "limit_reached" | "private_limit" | "no_vote";
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
};

const fail = (error: string, code?: VoteFailure): VoteResult => ({ ok: false, error, code });
const CHANGE_USED = "You already changed your vote on this question today. Try again tomorrow.";

function timing(meta: VoteMeta) {
  const tappedAt = meta.tappedAt ?? new Date();
  const shownAt = meta.shownAt ?? null;
  const ms = shownAt ? tappedAt.getTime() - shownAt.getTime() : NaN;
  const answerMs = ms >= 0 && ms <= 24 * 3600 * 1000 ? ms : null;
  return { tappedAt, shownAt, answerMs };
}

async function countToday(client: PoolClient, accountId: number, where: string, params: unknown[] = []) {
  const res = await client.query<{ n: number }>(
    `select count(*)::int as n from vote_events
      where account_id = $1 and ${TODAY_UTC("created_at")} and ${where}`,
    [accountId, ...params],
  );
  return res.rows[0].n;
}

// One change per question per day, for every tier. A change is a new value or a delete.
async function changedToday(client: PoolClient, accountId: number, questionId: number) {
  return (await countToday(client, accountId, "question_id = $2 and action in ('change', 'delete')", [questionId])) > 0;
}

async function activeQuestion(client: PoolClient, questionId: number) {
  const res = await client.query("select 1 from questions where id = $1 and status = 'active'", [questionId]);
  return res.rowCount === 1;
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
// through lib/vote-engine.ts; `meta` says where and how fast the answer was given.
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
  const { tappedAt, shownAt, answerMs } = timing(meta);
  return transaction(async (client) => {
    // Serialise this account's votes so daily limits can't be raced past.
    await client.query("select 1 from accounts where id = $1 for update", [account.id]);
    const existing = await currentVote(client, account.id, questionId);

    if (!existing) {
      if (!(await activeQuestion(client, questionId))) return fail("This question is closed to new votes.", "closed");
      if (await changedToday(client, account.id, questionId)) return fail(CHANGE_USED, "change_used");
      if ((await countToday(client, account.id, "action = 'cast'")) >= limits.votesPerDay) {
        return fail(`You've used your ${limits.votesPerDay} votes for today.`, "limit_reached");
      }
      const revealed = await client.query(
        "select 1 from reveals where account_id = $1 and question_id = $2",
        [account.id, questionId],
      );
      const blind = revealed.rowCount === 0;
      // A vote that was deleted and is now given again keeps its first answer: the re-vote is a
      // change in the history, not a new first instinct.
      const prior = await client.query<{
        value: VoteValue; at: Date; surface: string; answer_ms: number | null; blind: boolean | null; changes: number; last_at: Date | null;
      }>(
        `select f.value, coalesce(f.tapped_at, f.created_at) as at, f.surface, f.answer_ms, f.blind,
                (select count(*)::int from vote_events c
                  where c.account_id = $1 and c.question_id = $2 and c.action in ('change', 'delete')) as changes,
                (select max(created_at) from vote_events c
                  where c.account_id = $1 and c.question_id = $2 and c.action in ('change', 'delete')) as last_at
           from vote_events f
          where f.account_id = $1 and f.question_id = $2 and f.action = 'cast'
          order by f.created_at, f.id limit 1`,
        [account.id, questionId],
      );
      const first = prior.rows[0];
      await client.query(
        `insert into votes (account_id, question_id, value, is_private, first_value, first_cast_at, first_surface,
                            first_answer_ms, first_blind, change_count, last_changed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        first
          ? [account.id, questionId, value, isPrivate, first.value, first.at, first.surface, first.answer_ms, first.blind,
             first.changes + 1, tappedAt]
          : [account.id, questionId, value, isPrivate, value, tappedAt, surface, answerMs, blind, 0, null],
      );
      await client.query(
        `insert into vote_events (account_id, question_id, action, value, is_private, source, blind,
                                  surface, placement, surface_context, shown_at, tapped_at, answer_ms)
         values ($1, $2, 'cast', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [account.id, questionId, value, isPrivate, source, blind, surface, placement, context, shownAt, tappedAt, answerMs],
      );
      await client.query("delete from skips where account_id = $1 and question_id = $2", [account.id, questionId]);
      return { ok: true, outcome: "cast" };
    }

    if (existing.value === value) return { ok: true, outcome: "same" };
    if (await changedToday(client, account.id, questionId)) return fail(CHANGE_USED, "change_used");
    if (
      existing.is_private &&
      (await countToday(client, account.id, "action = 'change' and is_private")) >= limits.privateRecastsPerDay
    ) {
      return fail(`You've used your ${limits.privateRecastsPerDay} private vote changes for today.`, "private_limit");
    }
    await client.query(
      `update votes set value = $3, updated_at = now(), change_count = change_count + 1, last_changed_at = $4
        where account_id = $1 and question_id = $2`,
      [account.id, questionId, value, tappedAt],
    );
    await client.query(
      `insert into vote_events (account_id, question_id, action, value, is_private, source,
                                surface, placement, surface_context, shown_at, tapped_at, answer_ms)
       values ($1, $2, 'change', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [account.id, questionId, value, existing.is_private, source, surface, placement, context, shownAt, tappedAt, answerMs],
    );
    return { ok: true, outcome: "changed" };
  });
}

// Remove your vote. The question stays, and can come back around in your feed.
export function deleteVote(account: Account, questionId: number, source: Source): Promise<VoteResult> {
  return transaction(async (client) => {
    await client.query("select 1 from accounts where id = $1 for update", [account.id]);
    const existing = await currentVote(client, account.id, questionId);
    if (!existing) return { ok: true };
    if (await changedToday(client, account.id, questionId)) return fail(CHANGE_USED, "change_used");
    await client.query("delete from votes where account_id = $1 and question_id = $2", [account.id, questionId]);
    await client.query(
      `insert into vote_events (account_id, question_id, action, value, is_private, source)
       values ($1, $2, 'delete', null, $3, $4)`,
      [account.id, questionId, existing.is_private, source],
    );
    return { ok: true };
  });
}

// Private to public is always free. Public to private is limited on the free tier.
export function setVisibility(account: Account, questionId: number, isPrivate: boolean): Promise<VoteResult> {
  const limits = LIMITS[account.tier];
  return transaction(async (client) => {
    await client.query("select 1 from accounts where id = $1 for update", [account.id]);
    const existing = await currentVote(client, account.id, questionId);
    if (!existing) return fail("Vote first, then choose who can see it.", "no_vote");
    if (existing.is_private === isPrivate) return { ok: true };
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
// history would otherwise read as the vote being withdrawn). Returns whether it was recorded.
export function skip(account: Account, questionId: number, source: Source = "direct", meta: VoteMeta = {}): Promise<boolean> {
  const surface = meta.surface ?? "web";
  const context = meta.surfaceContext ? JSON.stringify(meta.surfaceContext) : null;
  const { tappedAt, shownAt, answerMs } = timing(meta);
  return transaction(async (client) => {
    await client.query("select 1 from accounts where id = $1 for update", [account.id]);
    if (await currentVote(client, account.id, questionId)) return false;
    await client.query(
      `insert into vote_events (account_id, question_id, action, value, is_private, source,
                                surface, placement, surface_context, shown_at, tapped_at, answer_ms)
       values ($1, $2, 'skip', null, false, $3, $4, $5, $6, $7, $8, $9)`,
      [account.id, questionId, source, surface, meta.placement ?? null, context, shownAt, tappedAt, answerMs],
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
