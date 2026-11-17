import { query, transaction } from "../db";
import { nearestCloseMatch, suggestDuplicate } from "./duplicates";
import { logDecision } from "./log";

// Reports from voters. Every report needs a reason. Reports from REPORT_THRESHOLD different
// accounts hide a question until a moderator looks ("hide pending review", the default).
//
// The owner hasn't decided what heavily reported questions should do beyond that. An
// automatic removal is built and switched off: with REPORT_AUTO_REMOVE=true, a question with
// at least AUTO_REMOVE_MIN_VOTES votes, a quarter or more of whose voters reported it, is
// removed (archived) without waiting. It adds no demerit, and the asker can appeal.
//
// M1, the owner's decisions:
//   - A moderator's approval clears every report on the question (reports.cleared_at): the rows
//     stay for the ledger, but counts and the threshold only see uncleared reports, so an
//     approved question starts from a clean slate. It can still be reported, and enough new
//     reports hide it again.
//   - A "repeats another question" report never hides anything: duplicates go to the
//     duplicates queue (./duplicates.ts) and keep taking answers. The reporter can name the
//     question it repeats; without one, its nearest close match is paired with it.

export const REPORT_REASONS = [
  { value: "duplicate", label: "It repeats another question" },
  { value: "not_yes_no", label: "It can't be answered true or false" },
  { value: "private_person", label: "It's about a private person" },
  { value: "hateful", label: "It's hateful or harassing" },
  { value: "spam", label: "It's spam or advertising" },
  { value: "other", label: "Something else" },
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number]["value"];
export const isReportReason = (v: string): v is ReportReason => REPORT_REASONS.some((r) => r.value === v);

// Reports from this many different accounts take a question out of feeds until reviewed.
export const REPORT_THRESHOLD = Number(process.env.REPORT_THRESHOLD ?? 5);

export const AUTO_REMOVE_MIN_VOTES = 50;
export const AUTO_REMOVE_SHARE = 0.25;
// Stored as removed_why for an automatic removal, so the appeal page can explain it in the
// reader's language.
export const AUTO_REMOVED = "auto:reports";

export function autoRemoveEnabled(): boolean {
  return process.env.REPORT_AUTO_REMOVE === "true";
}

// Would the automatic rule remove a question with these numbers? Always no while it is off.
export function autoRemoveDue(votes: number, reportingVoters: number): boolean {
  return autoRemoveEnabled() && votes >= AUTO_REMOVE_MIN_VOTES && reportingVoters >= AUTO_REMOVE_SHARE * votes;
}

export type ReportOutcome = "recorded" | "hidden" | "removed" | "duplicate_queue";

// The reports that count: not yet resolved, not cleared by an approval, and not about a repeat.
const COUNTED = "resolved_at is null and cleared_at is null and reason <> 'duplicate'";

export async function report(
  accountId: number, questionId: number, reason: ReportReason, note: string, duplicateOf: number | null = null,
): Promise<ReportOutcome> {
  if (!isReportReason(reason)) throw new Error("A report needs one of the listed reasons.");
  let repeatOf = reason === "duplicate" && duplicateOf && duplicateOf !== questionId ? duplicateOf : null;
  if (repeatOf && !(await query("select 1 from questions where id = $1 and status <> 'removed'", [repeatOf])).length) repeatOf = null;
  const [row] = await query<{ id: number }>(
    `insert into reports (question_id, account_id, reason, note, duplicate_of) values ($1, $2, $3, nullif($4, ''), $5)
     on conflict (question_id, account_id) where cleared_at is null do update
       set reason = excluded.reason, note = excluded.note, duplicate_of = excluded.duplicate_of, created_at = now(),
           resolved_at = null, resolution = null
     returning id::int`,
    [questionId, accountId, reason, note.slice(0, 500), repeatOf],
  );

  if (reason === "duplicate") {
    // To the duplicates queue, not toward hiding. If no pair can be made (no question named and
    // no close match), the report stays open for a moderator, who can pair it by hand.
    const other = repeatOf ?? (await nearestCloseMatch(questionId))?.id ?? null;
    const outcome = other ? await suggestDuplicate({ a: questionId, b: other, source: "report", by: accountId }) : "invalid";
    if (outcome === "suggested" || outcome === "again" || outcome === "settled") {
      await query("update reports set resolved_at = now(), resolution = 'duplicate_queue' where id = $1", [row.id]);
      return "duplicate_queue";
    }
    return "recorded";
  }

  if (autoRemoveEnabled()) {
    const [counts] = await query<{ votes: number; reporters: number; status: string }>(
      `select q.total_count as votes, q.status,
              (select count(*)::int from reports r join votes v on v.account_id = r.account_id and v.question_id = r.question_id
                where r.question_id = q.id and r.resolved_at is null and r.cleared_at is null and r.reason <> 'duplicate') as reporters
         from questions q where q.id = $1`,
      [questionId],
    );
    if (counts && ["active", "review"].includes(counts.status) && autoRemoveDue(counts.votes, counts.reporters)) {
      await transaction(async (client) => {
        const { rows } = await client.query(
          `update questions set status = 'removed', archived_at = now(), removed_why = $2, removed_fix = null,
                  removed_harm = null, moderated_at = now(), moderated_by = null
            where id = $1 and status in ('active', 'review') returning id`,
          [questionId, AUTO_REMOVED],
        );
        if (!rows.length) return;
        await client.query(
          "update reports set resolved_at = now(), resolution = 'auto_remove' where question_id = $1 and resolved_at is null",
          [questionId],
        );
        await logDecision({
          subject: "question", subjectId: questionId, action: "auto_remove",
          detail: `${counts.reporters} of ${counts.votes} voters reported it`,
        }, client);
      });
      return "removed";
    }
  }

  // Hide pending review. Not a decision, so not logged: the moderator's decision that follows is.
  const hidden = await query(
    `update questions set status = 'review', held_reason = 'Reported by ' || $2 || ' or more people'
      where id = $1 and status = 'active'
        and (select count(*) from reports where question_id = $1 and ${COUNTED}) >= $2
      returning id`,
    [questionId, REPORT_THRESHOLD],
  );
  return hidden.length ? "hidden" : "recorded";
}
