import { query } from "../db";
import type { VoteValue } from "../votes";

// The heads-up after a merge. Everyone whose answer a merge moved answered a question they
// weren't actually asked, so the original's page (where people review and change answers)
// tells them: "This question has been rephrased. You answered '<repeat>' with <answer>, which
// counts here as <answer>. Would you like to review your answer?" Keeping it dismisses the
// notice; changing it is free (it doesn't use up the day's change, see lib/votes.ts) and
// closes the notice too. The notices are made by ./merge.ts and go with the merge if an appeal
// overturns it.

export type MergeNotice = {
  id: number;
  merge_id: number;
  from_question_id: number;
  from_text: string;
  into_question_id: number;
  original_value: VoteValue;
  counted_value: VoteValue;
  inverted: boolean;
  created_at: Date;
};

// The open heads-ups for this person on this question, newest first. Marks them seen.
export async function openMergeNotices(accountId: number, questionId: number): Promise<MergeNotice[]> {
  const rows = await query<MergeNotice>(
    `select n.id::int, n.merge_id::int, n.from_question_id, f.text as from_text, n.into_question_id,
            n.original_value, n.counted_value, m.inverted, n.created_at
       from merge_notices n
       join question_merges m on m.id = n.merge_id
       join questions f on f.id = n.from_question_id
      where n.account_id = $1 and n.into_question_id = $2 and n.dismissed_at is null and n.changed_at is null
      order by n.created_at desc`,
    [accountId, questionId],
  );
  if (rows.length) {
    await query(
      "update merge_notices set seen_at = now() where id = any($1::bigint[]) and seen_at is null",
      [rows.map((r) => r.id)],
    );
  }
  return rows;
}

// "Keep my answer": the notice goes. Only the person's own notice.
export async function dismissMergeNotice(accountId: number, noticeId: number): Promise<boolean> {
  const rows = await query(
    `update merge_notices set dismissed_at = now(), seen_at = coalesce(seen_at, now())
      where id = $1 and account_id = $2 and dismissed_at is null and changed_at is null returning id`,
    [noticeId, accountId],
  );
  return rows.length > 0;
}
