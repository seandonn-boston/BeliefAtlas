import type { PoolClient } from "pg";
import { pool } from "../db";

// Every moderation decision, kept for accountability: questions, bans, demerits, appeals and
// manipulation signals alike. Automatic decisions (the sweep, the report rule) have no
// moderator and say so in `action`.

export type Db = Pick<PoolClient, "query">;
export type LogSubject = "question" | "ban" | "demerit" | "appeal" | "signal";

export async function logDecision(
  entry: {
    subject: LogSubject;
    subjectId: number | null;
    action: string;
    moderatorId?: number | null;
    questionId?: number | null;
    accountId?: number | null;
    detail?: string | null;
    ruleId?: string | null;    // M1: the rulebook rule the decision was made under (./rules.ts)
  },
  db: Db = pool,
): Promise<void> {
  await db.query(
    `insert into moderation_log (subject, subject_id, question_id, account_id, moderator_id, action, detail, rule_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.subject,
      entry.subjectId,
      entry.questionId ?? (entry.subject === "question" ? entry.subjectId : null),
      entry.accountId ?? null,
      entry.moderatorId ?? null,
      entry.action,
      entry.detail ?? null,
      entry.ruleId ?? null,
    ],
  );
}
