import { transaction } from "../db";
import { logDecision, type Db } from "./log";
import type { RuleId } from "./rules";

// Merging a repeat into the original. How votes combine is one clearly named rule, recorded on
// every merge so any merge can be explained later:
//
//   move_unanswered_keep_original
//     - a person who answered only the repeat has their answer (and its history) moved to the
//       original, as if they had answered it there;
//     - a person who answered both keeps their answer on the original; their answer on the
//       repeat stays with the repeat, which is removed, so it counts nowhere.
//
// A different rule later is a new name here; old merges keep the name they were made under.
//
// M1: a merge can be inverted. The owner's test is "does the data tell two different stories":
// "the Democrats won the 2026 midterm election" and "the Democrats did not lose the 2026 midterm
// election" ask the same thing with the polarity flipped, so they are combined and the
// repeat's No counts as the original's Yes. An inverted merge flips every moved answer
// (true <-> false, unsure stays unsure), including the first answer kept on the vote, and the
// moved history rows record the answer as it was originally given (vote_events.original_value)
// and the merge that moved them (vote_events.moved_by_merge). Everyone whose answer moved gets a
// heads-up (merge_notices, ./notices.ts). The rulebook rule the merge was made under is stored
// as rule_id (./rules.ts).
export const MERGE_RULE = "move_unanswered_keep_original";

export type MergeOptions = { inverted?: boolean; ruleId?: RuleId };
export type MergeError = "self_merge" | "original_not_live" | "not_found" | "already_merged";
export type MergeResult =
  | { ok: true; id: number; moved: number; kept: number; rule: string; inverted: boolean }
  | { ok: false; error: MergeError };

export async function mergeQuestions(
  moderatorId: number | null, fromId: number, intoId: number, opts: MergeOptions = {},
): Promise<MergeResult> {
  if (fromId === intoId) return { ok: false, error: "self_merge" };
  const inverted = opts.inverted ?? false;
  const ruleId: RuleId = opts.ruleId ?? (inverted ? "dup_inverted_polarity" : "dup_same_polarity");
  return transaction(async (client) => {
    const { rows: qs } = await client.query<{ id: number; status: string }>(
      "select id, status from questions where id = any($1::int[]) order by id for update",
      [[fromId, intoId]],
    );
    const from = qs.find((q) => q.id === fromId);
    const into = qs.find((q) => q.id === intoId);
    if (!from) return { ok: false, error: "not_found" } as const;
    if (!into || !["active", "archived"].includes(into.status)) return { ok: false, error: "original_not_live" } as const;
    const { rows: done } = await client.query("select 1 from question_merges where from_question_id = $1", [fromId]);
    if (done.length) return { ok: false, error: "already_merged" } as const;

    // The merge record first, so the moved history can name it.
    const { rows: [merge] } = await client.query<{ id: number }>(
      `insert into question_merges (from_question_id, into_question_id, rule, merged_by, inverted, rule_id)
       values ($1, $2, $3, $4, $5, $6) returning id::int`,
      [fromId, intoId, MERGE_RULE, moderatorId, inverted, ruleId],
    );

    // Move the answers of people who answered only the repeat, flipped if inverted. The counter
    // trigger (003_vote_counters.sql) takes each from the repeat's counts and adds it, as
    // counted, to the original's.
    const { rows: moved } = await client.query<{ account_id: number; original: string; counted: string }>(
      `with old as (
         select v.account_id, v.value from votes v
          where v.question_id = $1
            and not exists (select 1 from votes w where w.account_id = v.account_id and w.question_id = $2)
          for update
       )
       update votes v set question_id = $2,
              value = case when $3 then vote_flip(v.value) else v.value end,
              first_value = case when $3 then vote_flip(v.first_value) else v.first_value end
         from old
        where v.question_id = $1 and v.account_id = old.account_id
        returning v.account_id, old.value as original, v.value as counted`,
      [fromId, intoId, inverted],
    );
    const movedIds = moved.map((m) => m.account_id);
    if (movedIds.length) {
      // Their history moves with them, recording the answer as given and the merge that moved it.
      await client.query(
        `update vote_events set question_id = $2, moved_by_merge = $4, original_value = value,
                value = case when $3 then vote_flip(value) else value end
          where question_id = $1 and account_id = any($5::int[])`,
        [fromId, intoId, inverted, merge.id, movedIds],
      );
      await client.query(
        `insert into merge_notices (account_id, merge_id, from_question_id, into_question_id, original_value, counted_value)
         select a, $1, $2, $3, o, c from unnest($4::int[], $5::text[], $6::text[]) as m(a, o, c)`,
        [merge.id, fromId, intoId, movedIds, moved.map((m) => m.original), moved.map((m) => m.counted)],
      );
    }
    const { rows: [{ kept }] } = await client.query<{ kept: number }>(
      "select count(*)::int as kept from votes where question_id = $1", [fromId],
    );
    await client.query(
      "update question_merges set votes_moved = $2, votes_kept = $3, moved_accounts = $4 where id = $1",
      [merge.id, movedIds.length, kept, movedIds],
    );

    await client.query(
      `update questions set status = 'removed', duplicate_of = $2, archived_at = coalesce(archived_at, now()),
              moderated_at = now(), moderated_by = $3
        where id = $1`,
      [fromId, intoId, moderatorId],
    );
    await client.query(
      "update reports set resolved_at = now(), resolution = 'duplicate' where question_id = $1 and resolved_at is null",
      [fromId],
    );
    // A suspected pair for these two is settled.
    await client.query(
      `update duplicate_suspects set status = 'merged', decided_by = $3, decided_at = now(), rule_id = $4
        where question_a = least($1::int, $2::int) and question_b = greatest($1::int, $2::int) and status = 'open'`,
      [fromId, intoId, moderatorId, ruleId],
    );
    await logDecision({
      subject: "question", subjectId: fromId, action: "duplicate", moderatorId, ruleId,
      detail: `${intoId} (${MERGE_RULE}${inverted ? ", inverted" : ""}: ${movedIds.length} moved, ${kept} kept)`,
    }, client);
    return { ok: true, id: merge.id, moved: movedIds.length, kept, rule: MERGE_RULE, inverted } as const;
  });
}

// Undo a merge (an overturned appeal): the moved answers go back to the repeat with their
// history, flipped back if the merge inverted them, and the merge record and its heads-ups are
// removed. The log keeps both decisions.
//
// An answer the person changed on the original after the merge goes back too, in the repeat's
// polarity, and so does the history they made there after the merge. History on the original
// from before the merge that the merge didn't move stays where it is.
export async function unmerge(fromId: number, by: number | null, db: Db): Promise<boolean> {
  const { rows } = await db.query<{
    id: number; into_question_id: number; moved_accounts: number[]; inverted: boolean; created_at: Date;
  }>(
    `select id::int, into_question_id, moved_accounts, inverted, created_at
       from question_merges where from_question_id = $1 for update`,
    [fromId],
  );
  const merge = rows[0];
  if (!merge) return false;
  if (merge.moved_accounts.length) {
    await db.query(
      `update votes v set question_id = $1,
              value = case when $4 then vote_flip(v.value) else v.value end,
              first_value = case when $4 then vote_flip(v.first_value) else v.first_value end
        where v.question_id = $2 and v.account_id = any($3::int[])
          and not exists (select 1 from votes w where w.account_id = v.account_id and w.question_id = $1)`,
      [fromId, merge.into_question_id, merge.moved_accounts, merge.inverted],
    );
    await db.query(
      `update vote_events set question_id = $1,
              value = case when moved_by_merge = $4 then original_value
                           when $5 then vote_flip(value) else value end,
              moved_by_merge = null, original_value = null, merge_review = null
        where question_id = $2 and account_id = any($3::int[])
          and (moved_by_merge = $4 or created_at >= $6)`,
      [fromId, merge.into_question_id, merge.moved_accounts, merge.id, merge.inverted, merge.created_at],
    );
  }
  // The heads-ups go with the merge (on delete cascade).
  await db.query("delete from question_merges where id = $1", [merge.id]);
  // Overturned: they aren't duplicates, so don't suggest the pair again.
  await db.query(
    `update duplicate_suspects set status = 'dismissed', decided_by = $3, decided_at = now(), rule_id = 'dup_different_subject'
      where question_a = least($1::int, $2::int) and question_b = greatest($1::int, $2::int)`,
    [fromId, merge.into_question_id, by],
  );
  await logDecision({ subject: "question", subjectId: fromId, action: "unmerge", moderatorId: by, detail: String(merge.into_question_id) }, db);
  return true;
}
