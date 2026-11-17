import { query } from "../db";
import { normalize } from "../questions";
import { isLocale, LOCALES, type Locale } from "./locales";

// The translation review queue (/translate). People write or edit a draft, and a reviewer
// approves or rejects it; only approved translations are ever shown to readers. Moderators and
// admins review every language; anyone else needs a row in translator_grants for that language
// (or '*'), given with `npm run translate:grant -- <username> <lang|*>`.

export type Reviewer = { id: number; role: string };
export type ReviewError =
  | "forbidden" | "not_found" | "empty" | "too_long" | "same_language" | "already_approved" | "nothing_to_review";
export type ReviewResult = { ok: true } | { ok: false; error: ReviewError };

export const MAX_TRANSLATION_LENGTH = 250;
export const QUEUE_PAGE_SIZE = 20;

const STAFF = new Set(["moderator", "admin"]);

// The interface languages this person may review, in the picker's order.
export async function reviewLanguages(account: Reviewer | null): Promise<Locale[]> {
  if (!account) return [];
  if (STAFF.has(account.role)) return LOCALES.map((l) => l.code);
  const grants = await query<{ lang: string }>("select lang from translator_grants where account_id = $1", [account.id]);
  const langs = new Set(grants.map((g) => g.lang));
  return LOCALES.map((l) => l.code).filter((code) => langs.has("*") || langs.has(code));
}

export async function canReview(account: Reviewer | null, lang: string): Promise<boolean> {
  return isLocale(lang) && (await reviewLanguages(account)).includes(lang);
}

export type QueueTab = "todo" | "approved";
export type QueueItem = {
  id: number;
  text: string;          // the canonical text
  lang: string;          // its language
  category: string;
  votes: number;
  translation: {
    text: string;
    status: "draft" | "approved" | "rejected";
    source: "human" | "machine";
    draftedBy: string | null;
    reviewedBy: string | null;
    at: Date;
  } | null;
};

type QueueRow = {
  id: number; text: string; lang: string; category: string; votes: number;
  t_text: string | null; t_status: "draft" | "approved" | "rejected" | null; t_source: "human" | "machine" | null;
  drafted_by: string | null; reviewed_by: string | null; t_at: Date | null;
};

// "todo": live questions with no approved translation into `lang`, waiting drafts first, then
// rejected ones, then the untranslated, most-answered first. "approved": what readers see now,
// most recently reviewed first.
export async function reviewQueue(
  lang: Locale, tab: QueueTab = "todo", page = 0, pageSize = QUEUE_PAGE_SIZE,
): Promise<{ items: QueueItem[]; more: boolean; drafts: number }> {
  const offset = Math.max(0, page) * pageSize;
  const select = `
    select q.id, q.text, q.lang, q.category, q.total_count as votes,
           t.text as t_text, t.status as t_status, t.source as t_source,
           d.username as drafted_by, r.username as reviewed_by, coalesce(t.reviewed_at, t.created_at) as t_at
      from questions q
      left join question_translations t on t.question_id = q.id and t.lang = $1
      left join accounts d on d.id = t.drafted_by
      left join accounts r on r.id = t.reviewed_by`;
  const rows = tab === "approved"
    ? await query<QueueRow>(
      `${select}
        where t.status = 'approved' and q.status <> 'removed'
        order by t.reviewed_at desc nulls last, q.id
        limit $2 offset $3`,
      [lang, pageSize + 1, offset],
    )
    : await query<QueueRow>(
      `${select}
        where q.status = 'active' and q.lang <> $1 and (t.status is null or t.status <> 'approved')
        order by (t.status = 'draft') desc nulls last, q.total_count desc, q.id
        limit $2 offset $3`,
      [lang, pageSize + 1, offset],
    );
  const [{ n }] = await query<{ n: number }>(
    `select count(*)::int as n from question_translations t join questions q on q.id = t.question_id
      where t.lang = $1 and t.status = 'draft' and q.status = 'active'`,
    [lang],
  );
  return {
    items: rows.slice(0, pageSize).map((r) => ({
      id: r.id, text: r.text, lang: r.lang, category: r.category, votes: r.votes,
      translation: r.t_text === null ? null : {
        text: r.t_text, status: r.t_status!, source: r.t_source!, draftedBy: r.drafted_by, reviewedBy: r.reviewed_by, at: r.t_at!,
      },
    })),
    more: rows.length > pageSize,
    drafts: n,
  };
}

// A translation's text as stored: whitespace tidied, nothing else changed (each language has its
// own punctuation, so no "?" is added).
export function cleanTranslation(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

async function check(account: Reviewer | null, questionId: number, lang: string, text?: string): Promise<ReviewError | null> {
  if (!account || !(await canReview(account, lang))) return "forbidden";
  const [q] = await query<{ lang: string }>("select lang from questions where id = $1 and status <> 'removed'", [questionId]);
  if (!q) return "not_found";
  if (q.lang === lang) return "same_language";
  if (text !== undefined) {
    if (!text || !normalize(text)) return "empty";
    if (text.length > MAX_TRANSLATION_LENGTH) return "too_long";
  }
  return null;
}

// Write or edit a draft. A person's edit makes it a human draft; saving a machine draft unchanged
// keeps it marked as machine. An approved translation is withdrawn first, never overwritten in
// place, so readers never see unreviewed words.
export async function saveDraft(account: Reviewer | null, questionId: number, lang: string, raw: string): Promise<ReviewResult> {
  const text = cleanTranslation(raw);
  const problem = await check(account, questionId, lang, text);
  if (problem) return { ok: false, error: problem };
  const rows = await query(
    `insert into question_translations (question_id, lang, text, normalized, status, source, drafted_by)
     values ($1, $2, $3, $4, 'draft', 'human', $5)
     on conflict (question_id, lang) do update set
       text = excluded.text,
       normalized = excluded.normalized,
       status = 'draft',
       source = case when question_translations.text = excluded.text then question_translations.source else 'human' end,
       drafted_by = case when question_translations.text = excluded.text then question_translations.drafted_by else excluded.drafted_by end,
       reviewed_by = null,
       reviewed_at = null
     where question_translations.status <> 'approved'
     returning 1`,
    [questionId, lang, text, normalize(text), account!.id],
  );
  return rows.length ? { ok: true } : { ok: false, error: "already_approved" };
}

// Approve the draft, or, with `raw`, save those words and approve them in one step. Readers see
// it from now on, in feeds, search and the question pages.
export async function approve(account: Reviewer | null, questionId: number, lang: string, raw?: string): Promise<ReviewResult> {
  if (raw !== undefined) {
    const saved = await saveDraft(account, questionId, lang, raw);
    if (!saved.ok) return saved;
  } else {
    const problem = await check(account, questionId, lang);
    if (problem) return { ok: false, error: problem };
  }
  const rows = await query(
    `update question_translations set status = 'approved', reviewed_by = $3, reviewed_at = now()
      where question_id = $1 and lang = $2 and status <> 'approved' returning 1`,
    [questionId, lang, account!.id],
  );
  return rows.length ? { ok: true } : { ok: false, error: "nothing_to_review" };
}

export async function reject(account: Reviewer | null, questionId: number, lang: string): Promise<ReviewResult> {
  const problem = await check(account, questionId, lang);
  if (problem) return { ok: false, error: problem };
  const rows = await query(
    `update question_translations set status = 'rejected', reviewed_by = $3, reviewed_at = now()
      where question_id = $1 and lang = $2 and status = 'draft' returning 1`,
    [questionId, lang, account!.id],
  );
  return rows.length ? { ok: true } : { ok: false, error: "nothing_to_review" };
}

// Take an approved translation off readers' screens and back into the queue as a draft.
export async function withdraw(account: Reviewer | null, questionId: number, lang: string): Promise<ReviewResult> {
  const problem = await check(account, questionId, lang);
  if (problem) return { ok: false, error: problem };
  const rows = await query(
    `update question_translations set status = 'draft', reviewed_by = $3, reviewed_at = now()
      where question_id = $1 and lang = $2 and status = 'approved' returning 1`,
    [questionId, lang, account!.id],
  );
  return rows.length ? { ok: true } : { ok: false, error: "nothing_to_review" };
}

// ---- Translator grants ----

export function isGrantLang(lang: string): boolean {
  return lang === "*" || isLocale(lang);
}

export async function grantTranslator(accountId: number, lang: string, grantedBy: number | null = null): Promise<void> {
  if (!isGrantLang(lang)) throw new Error(`Not a language this site offers: ${lang}`);
  await query(
    "insert into translator_grants (account_id, lang, granted_by) values ($1, $2, $3) on conflict do nothing",
    [accountId, lang, grantedBy],
  );
}

export async function revokeTranslator(accountId: number, lang: string): Promise<void> {
  await query("delete from translator_grants where account_id = $1 and lang = $2", [accountId, lang]);
}
