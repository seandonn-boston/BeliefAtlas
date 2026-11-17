import type { CategorySlug } from "../categories";
import { query, transaction } from "../db";
import { addDemerit, revokeDemerit } from "./bans";
import { logDecision, type Db } from "./log";
import { suggestDuplicate } from "./duplicates";
import { mergeQuestions, unmerge, type MergeError } from "./merge";
import { denialRule, isRuleId, type RuleId } from "./rules";
import { modelVerdict } from "./screen";
import type { HarmKind } from "./sweep";

// What a moderator can do with a held or reported question.
//   approve  - put it (back) in feeds; "Keep" for a live one. M1: it gets the "moderator
//              approved" mark (questions.approved_at) and its reports are cleared: kept for the
//              ledger, no longer counted. It can be reported, and hidden, again.
//   remove   - take it down (the owner calls this "denied"). Needs why and a suggested fix,
//              both shown to the asker. Marked harmful (hateful, harassing, private person,
//              spam) it adds a demerit to the asker; otherwise it costs them nothing. A removed
//              question is archived too, so it leaves feeds, maps and every export, and is kept
//              only for the ledger. M1: it records the rulebook rule it was made under.
//   archive  - close it to new answers and take it out of feeds, without blaming anyone
//   duplicate- merge it into the original (./merge.ts), inverted when only the polarity differs
//   suggest_duplicate - M1: send it and another question to the duplicates queue
//              (./duplicates.ts), where the two are decided side by side. Nothing is hidden.
//   category - change its subject

export type Decision =
  | { action: "approve" }
  | { action: "remove"; why: string; fix: string; harm?: HarmKind | null; rule?: RuleId | null }
  | { action: "archive" }
  | { action: "duplicate"; of: number; inverted?: boolean }
  | { action: "suggest_duplicate"; of: number }
  | { action: "category"; category: CategorySlug };

export type DecisionError = MergeError | "not_found" | "why_and_fix_required" | "already_removed" | "not_a_pair";

export async function decide(moderatorId: number, questionId: number, decision: Decision): Promise<DecisionError | null> {
  if (decision.action === "duplicate") {
    const merged = await mergeQuestions(moderatorId, questionId, decision.of, { inverted: decision.inverted ?? false });
    return merged.ok ? null : merged.error;
  }
  if (decision.action === "suggest_duplicate") {
    const outcome = await suggestDuplicate({ a: questionId, b: decision.of, source: "moderator", by: moderatorId });
    if (outcome === "invalid") return decision.of === questionId ? "self_merge" : "not_a_pair";
    // A repeat report on it has been dealt with: the pair is in the queue (or already settled).
    await query(
      `update reports set resolved_at = now(), resolution = 'duplicate_queue'
        where question_id = $1 and reason = 'duplicate' and resolved_at is null`,
      [questionId],
    );
    return null;
  }
  if (decision.action === "remove") {
    const why = decision.why.trim(), fix = decision.fix.trim();
    if (!why || !fix) return "why_and_fix_required";
    const ruleId: RuleId = decision.rule && isRuleId(decision.rule) ? decision.rule : denialRule(decision.harm);
    return transaction(async (client) => {
      const { rows } = await client.query<{ asked_by: number | null; text: string }>(
        `update questions set status = 'removed', archived_at = coalesce(archived_at, now()),
                removed_why = $3, removed_fix = $4, removed_harm = $5, removed_rule = $6, moderated_at = now(), moderated_by = $2
          where id = $1 and status <> 'removed' returning asked_by, text`,
        [questionId, moderatorId, why.slice(0, 1000), fix.slice(0, 1000), decision.harm ?? null, ruleId],
      );
      if (!rows[0]) {
        const exists = await client.query("select 1 from questions where id = $1", [questionId]);
        return exists.rows.length ? "already_removed" : "not_found";
      }
      await resolveReports(client, questionId, "remove");
      await logDecision({
        subject: "question", subjectId: questionId, action: "remove", moderatorId, ruleId,
        accountId: rows[0].asked_by, detail: decision.harm ? `${decision.harm}: ${why}` : why,
      }, client);
      if (decision.harm && rows[0].asked_by) {
        await addDemerit({
          accountId: rows[0].asked_by, kind: decision.harm, reason: why, questionId, by: moderatorId, detail: rows[0].text,
        }, client);
      }
      return null;
    });
  }

  const set: Record<"approve" | "archive" | "category", string> = {
    approve: "status = 'active', held_reason = null, approved_at = now(), approved_by = $2",
    archive: "status = 'archived', archived_at = coalesce(archived_at, now())",
    category: "category = $3",
  };
  // Only a held or live question can be approved; a removed one comes back only by appeal.
  const where = decision.action === "approve" ? "and status in ('active', 'review')" : decision.action === "archive" ? "and status <> 'removed'" : "";
  const params: unknown[] = [questionId, moderatorId];
  if (decision.action === "category") params.push(decision.category);
  return transaction(async (client) => {
    const { rows } = await client.query<{ asked_by: number | null }>(
      `update questions set ${set[decision.action]}, moderated_at = now(), moderated_by = $2 where id = $1 ${where} returning asked_by`,
      params,
    );
    if (!rows.length) return "not_found";
    if (decision.action !== "category") await resolveReports(client, questionId, decision.action);
    // A clean slate: every report so far stays in the ledger but no longer counts.
    if (decision.action === "approve") {
      await client.query(
        "update reports set cleared_at = now(), cleared_by = $2 where question_id = $1 and cleared_at is null",
        [questionId, moderatorId],
      );
    }
    await logDecision({
      subject: "question", subjectId: questionId, action: decision.action, moderatorId, accountId: rows[0].asked_by,
      detail: decision.action === "category" ? decision.category : null,
      ruleId: decision.action === "approve" ? "keep_reviewed" : null,
    }, client);
    return null;
  });
}

async function resolveReports(db: Db, questionId: number, resolution: string) {
  await db.query("update reports set resolved_at = now(), resolution = $2 where question_id = $1 and resolved_at is null", [questionId, resolution]);
}

// Undo a removal (an overturned appeal): the question is live again, a merge is undone, and
// any demerit the removal added is revoked.
export async function restoreQuestion(questionId: number, by: number | null, db: Db): Promise<boolean> {
  await unmerge(questionId, by, db);
  const { rows } = await db.query<{ asked_by: number | null }>(
    `update questions set status = 'active', archived_at = null, held_reason = null, duplicate_of = null,
            removed_why = null, removed_fix = null, removed_harm = null, removed_rule = null, moderated_at = now(), moderated_by = $2
      where id = $1 and status = 'removed' returning asked_by`,
    [questionId, by],
  );
  if (!rows[0]) return false;
  await logDecision({ subject: "question", subjectId: questionId, action: "restore", moderatorId: by, accountId: rows[0].asked_by }, db);
  const { rows: demerits } = await db.query<{ id: number }>(
    "select id::int from demerits where question_id = $1 and revoked_at is null", [questionId],
  );
  for (const d of demerits) await revokeDemerit(d.id, by, db, "question restored");
  return true;
}

// ---------- The queue ----------

// What a moderator sees. Report counts and reasons and the vote count; never the true/false
// split, so a decision can't lean on which way people answered.
export type QueueItem = {
  id: number; text: string; status: string; category: string; held_reason: string | null;
  created_at: Date; asked_by_user: boolean; votes: number; open_reports: number;
  reasons: Record<string, number> | null; notes: string[] | null; ai_review: string | null;
  approved_at: Date | null;   // M1: approved before (and reported again since)
};

// Questions waiting for review, then live questions with open reports, most-reported first.
export async function queue(limit = 50): Promise<QueueItem[]> {
  return query<QueueItem>(
    `select q.id, q.text, q.status, q.category, q.held_reason, q.created_at, q.asked_by is not null as asked_by_user,
            q.total_count as votes, coalesce(r.n, 0)::int as open_reports, r.reasons, r.notes, q.approved_at,
            (select detail from moderation_log l where l.subject = 'question' and l.subject_id = q.id and l.action = 'ai_review'
              order by l.created_at desc limit 1) as ai_review
       from questions q
       left join lateral (
         select count(*) as n,
                (select jsonb_object_agg(reason, c) from (select reason, count(*)::int as c from reports
                   where question_id = q.id and resolved_at is null and cleared_at is null group by reason) x) as reasons,
                (array_agg(note order by created_at desc) filter (where note is not null))[1:5] as notes
           from reports where question_id = q.id and resolved_at is null and cleared_at is null
       ) r on true
      where q.status = 'review' or (q.status = 'active' and coalesce(r.n, 0) > 0)
      order by (q.status = 'review') desc, coalesce(r.n, 0) desc, q.created_at
      limit $1`,
    [limit],
  );
}

// ---------- AI deep review ----------

export function aiEnabled(): boolean {
  return process.env.AI_ENABLED === "true";
}

// A second opinion from the model, kept in the log for the moderator to read. Off unless
// AI_ENABLED=true (and a key is set); it never decides anything by itself.
export async function aiReview(moderatorId: number, questionId: number): Promise<"off" | "unavailable" | "not_found" | null> {
  if (!aiEnabled()) return "off";
  const [q] = await query<{ text: string }>("select text from questions where id = $1", [questionId]);
  if (!q) return "not_found";
  const verdict = await modelVerdict(q.text, [], 15000);
  if (!verdict) return "unavailable";
  await logDecision({
    subject: "question", subjectId: questionId, action: "ai_review", moderatorId,
    detail: JSON.stringify({
      answerable: verdict.answerable_yes_no, private_person: verdict.names_private_person,
      harassing_or_hateful: verdict.harassing_or_hateful, category: verdict.category ?? null,
    }),
  });
  return null;
}
