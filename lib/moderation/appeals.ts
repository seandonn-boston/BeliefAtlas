import { pool, query, transaction } from "../db";
import { liftBan, revokeDemerit } from "./bans";
import { restoreQuestion } from "./decisions";
import { logDecision } from "./log";

// Appeals. A signed-in person sees their removed questions, bans and demerits, and can appeal
// each one once. A moderator other than them decides: upheld or overturned, always with a
// note. Overturning a removal restores the question; overturning a ban lifts it; overturning
// a demerit revokes it (and lifts a ban it no longer supports). Every decision is logged.

export const APPEAL_SUBJECTS = ["question", "ban", "demerit"] as const;
export type AppealSubject = (typeof APPEAL_SUBJECTS)[number];
export const isAppealSubject = (v: string): v is AppealSubject => APPEAL_SUBJECTS.includes(v as AppealSubject);
export const APPEAL_MAX = 2000;

export type Appeal = {
  id: number; subject: AppealSubject; subject_id: number; body: string;
  status: "open" | "upheld" | "overturned"; outcome_note: string | null; created_at: Date; decided_at: Date | null;
};
export type RemovedQuestion = {
  id: number; text: string; removed_why: string | null; removed_fix: string | null; removed_harm: string | null;
  duplicate_of: number | null; archived_at: Date | null;
};
export type BanRecord = {
  id: number; scope: string; cause: string; permanent: boolean; reason: string; starts_at: Date; ends_at: Date | null;
  lifted_at: Date | null; in_force: boolean;
};
export type DemeritRecord = {
  id: number; question_id: number | null; kind: string | null; reason: string; detail: string | null; points: number;
  created_at: Date; expires_at: Date; revoked_at: Date | null; active: boolean;
};

export type MyModeration = {
  questions: RemovedQuestion[];
  bans: BanRecord[];
  demerits: DemeritRecord[];
  appeals: Appeal[];
};

export async function myModeration(accountId: number): Promise<MyModeration> {
  const [questions, bans, demerits, appeals] = await Promise.all([
    query<RemovedQuestion>(
      `select id, text, removed_why, removed_fix, removed_harm, duplicate_of, archived_at from questions
        where asked_by = $1 and status = 'removed' order by coalesce(moderated_at, created_at) desc limit 50`,
      [accountId],
    ),
    query<BanRecord>(
      `select id::int, scope, cause, permanent, reason, starts_at, ends_at, lifted_at,
              (lifted_at is null and (permanent or ends_at > now())) as in_force
         from bans where account_id = $1 order by created_at desc limit 50`,
      [accountId],
    ),
    query<DemeritRecord>(
      `select id::int, question_id, kind, reason, detail, points, created_at, expires_at, revoked_at,
              (revoked_at is null and expires_at > now()) as active
         from demerits where account_id = $1 order by created_at desc limit 50`,
      [accountId],
    ),
    query<Appeal>(
      `select id::int, subject, subject_id::int, body, status, outcome_note, created_at, decided_at
         from appeals where account_id = $1 order by created_at desc`,
      [accountId],
    ),
  ]);
  return { questions, bans, demerits, appeals };
}

export type AppealError = "empty" | "too_long" | "not_yours" | "already_appealed";

// Is this item theirs, and still something an appeal can change?
async function appealable(accountId: number, subject: AppealSubject, subjectId: number): Promise<boolean> {
  const sql: Record<AppealSubject, string> = {
    question: "select 1 from questions where id = $1 and asked_by = $2 and status = 'removed'",
    ban: "select 1 from bans where id = $1 and account_id = $2 and lifted_at is null",
    demerit: "select 1 from demerits where id = $1 and account_id = $2 and revoked_at is null",
  };
  return (await query(sql[subject], [subjectId, accountId])).length > 0;
}

export async function fileAppeal(
  accountId: number, subject: AppealSubject, subjectId: number, rawBody: string,
): Promise<{ ok: true; id: number } | { ok: false; error: AppealError }> {
  const body = rawBody.trim();
  if (!body) return { ok: false, error: "empty" };
  if (body.length > APPEAL_MAX) return { ok: false, error: "too_long" };
  if (!isAppealSubject(subject) || !(await appealable(accountId, subject, subjectId))) return { ok: false, error: "not_yours" };
  // Once per item, ever: the database also allows only one open appeal per item.
  const before = await query("select 1 from appeals where account_id = $1 and subject = $2 and subject_id = $3", [accountId, subject, subjectId]);
  if (before.length) return { ok: false, error: "already_appealed" };
  try {
    const [row] = await query<{ id: number }>(
      "insert into appeals (account_id, subject, subject_id, body) values ($1, $2, $3, $4) returning id::int",
      [accountId, subject, subjectId, body],
    );
    return { ok: true, id: row.id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { ok: false, error: "already_appealed" };
    throw err;
  }
}

export type AppealDecisionError = "not_found" | "note_required" | "own_appeal" | "decided";

export async function decideAppeal(
  moderatorId: number, appealId: number, outcome: "upheld" | "overturned", rawNote: string,
): Promise<AppealDecisionError | null> {
  const note = rawNote.trim();
  if (!note) return "note_required";
  return transaction(async (client) => {
    const { rows } = await client.query<{ account_id: number; subject: AppealSubject; subject_id: number; status: string }>(
      "select account_id, subject, subject_id::int, status from appeals where id = $1 for update",
      [appealId],
    );
    const appeal = rows[0];
    if (!appeal) return "not_found";
    if (appeal.status !== "open") return "decided";
    if (appeal.account_id === moderatorId) return "own_appeal";

    await client.query(
      "update appeals set status = $2, decided_by = $3, decided_at = now(), outcome_note = $4 where id = $1",
      [appealId, outcome, moderatorId, note.slice(0, 2000)],
    );
    if (outcome === "overturned") {
      if (appeal.subject === "question") await restoreQuestion(appeal.subject_id, moderatorId, client);
      if (appeal.subject === "ban") await liftBan(appeal.subject_id, moderatorId, client);
      if (appeal.subject === "demerit") await revokeDemerit(appeal.subject_id, moderatorId, client);
    }
    await logDecision({
      subject: "appeal", subjectId: appealId, action: `appeal_${outcome}`, moderatorId, accountId: appeal.account_id,
      questionId: appeal.subject === "question" ? appeal.subject_id : null,
      detail: `${appeal.subject} ${appeal.subject_id}: ${note.slice(0, 500)}`,
    }, client);
    return null;
  });
}

// Open appeals for the moderator queue, oldest first, with what each is about. No usernames:
// the decision is about the item, not the person.
export type OpenAppeal = {
  id: number; subject: AppealSubject; subject_id: number; body: string; created_at: Date; account_id: number;
  question_text: string | null; removed_why: string | null; removed_fix: string | null; harm: string | null;
  ban_reason: string | null; ban_ends_at: Date | null; ban_permanent: boolean | null; demerit_reason: string | null;
};

export async function openAppeals(limit = 50): Promise<OpenAppeal[]> {
  const { rows } = await pool.query<OpenAppeal>(
    `select a.id::int, a.subject, a.subject_id::int, a.body, a.created_at, a.account_id,
            coalesce(q.text, d.detail) as question_text,
            q.removed_why, q.removed_fix, coalesce(q.removed_harm, d.kind) as harm,
            b.reason as ban_reason, b.ends_at as ban_ends_at, b.permanent as ban_permanent,
            d.reason as demerit_reason
       from appeals a
       left join questions q on a.subject = 'question' and q.id = a.subject_id
       left join bans b on a.subject = 'ban' and b.id = a.subject_id
       left join demerits d on a.subject = 'demerit' and d.id = a.subject_id
      where a.status = 'open'
      order by a.created_at
      limit $1`,
    [limit],
  );
  return rows;
}
