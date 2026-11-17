import { transaction } from "../db";
import { logDecision, type Db } from "./log";

// Merging a repeat into the original. How votes combine is still the owner's open decision
// (open decision 9 in the build plan), so this is one clearly named default, recorded on every
// merge so any merge can be explained later:
//
//   move_unanswered_keep_original
//     - a person who answered only the repeat has their answer (and its history) moved to the
//       original, as if they had answered it there;
//     - a person who answered both keeps their answer on the original; their answer on the
//       repeat stays with the repeat, which is removed, so it counts nowhere.
//
// A different rule later is a new name here; old merges keep the name they were made under.
export const MERGE_RULE = "move_unanswered_keep_original";

export type MergeError = "self_merge" | "original_not_live" | "not_found" | "already_merged";
export type MergeResult = { ok: true; moved: number; kept: number; rule: string } | { ok: false; error: MergeError };

export async function mergeQuestions(moderatorId: number | null, fromId: number, intoId: number): Promise<MergeResult> {
  if (fromId === intoId) return { ok: false, error: "self_merge" };
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

    const { rows: moved } = await client.query<{ account_id: number }>(
      `update votes v set question_id = $2
        where v.question_id = $1
          and not exists (select 1 from votes w where w.account_id = v.account_id and w.question_id = $2)
        returning v.account_id`,
      [fromId, intoId],
    );
    const movedIds = moved.map((m) => m.account_id);
    if (movedIds.length) {
      await client.query(
        "update vote_events set question_id = $2 where question_id = $1 and account_id = any($3::int[])",
        [fromId, intoId, movedIds],
      );
    }
    const { rows: [{ kept }] } = await client.query<{ kept: number }>(
      "select count(*)::int as kept from votes where question_id = $1", [fromId],
    );

    await client.query(
      `update questions set status = 'removed', duplicate_of = $2, archived_at = coalesce(archived_at, now()),
              moderated_at = now(), moderated_by = $3
        where id = $1`,
      [fromId, intoId, moderatorId],
    );
    await client.query(
      `insert into question_merges (from_question_id, into_question_id, rule, votes_moved, votes_kept, merged_by, moved_accounts)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [fromId, intoId, MERGE_RULE, movedIds.length, kept, moderatorId, movedIds],
    );
    await client.query(
      "update reports set resolved_at = now(), resolution = 'duplicate' where question_id = $1 and resolved_at is null",
      [fromId],
    );
    await logDecision({
      subject: "question", subjectId: fromId, action: "duplicate", moderatorId,
      detail: `${intoId} (${MERGE_RULE}: ${movedIds.length} moved, ${kept} kept)`,
    }, client);
    return { ok: true, moved: movedIds.length, kept, rule: MERGE_RULE } as const;
  });
}

// Undo a merge (an overturned appeal): the moved answers go back to the repeat with their
// history, and the merge record is removed. The log keeps both decisions.
export async function unmerge(fromId: number, by: number | null, db: Db): Promise<boolean> {
  const { rows } = await db.query<{ id: number; into_question_id: number; moved_accounts: number[] }>(
    "delete from question_merges where from_question_id = $1 returning id::int, into_question_id, moved_accounts",
    [fromId],
  );
  const merge = rows[0];
  if (!merge) return false;
  if (merge.moved_accounts.length) {
    const { rows: back } = await db.query<{ account_id: number }>(
      `update votes v set question_id = $1
        where v.question_id = $2 and v.account_id = any($3::int[])
          and not exists (select 1 from votes w where w.account_id = v.account_id and w.question_id = $1)
        returning v.account_id`,
      [fromId, merge.into_question_id, merge.moved_accounts],
    );
    await db.query(
      "update vote_events set question_id = $1 where question_id = $2 and account_id = any($3::int[])",
      [fromId, merge.into_question_id, back.map((b) => b.account_id)],
    );
  }
  await logDecision({ subject: "question", subjectId: fromId, action: "unmerge", moderatorId: by, detail: String(merge.into_question_id) }, db);
  return true;
}
