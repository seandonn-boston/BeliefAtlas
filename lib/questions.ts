import { query } from "./db";
import { LIMITS, TODAY_UTC } from "./limits";
import type { Account } from "./auth";
import { activeBan, addDemerit, classify, suspectsAtAsk, sweep, type Ban, type HarmKind } from "./moderation";
import { checkQuestion, type CheckResult } from "./checks";
import { tidyIn, yesNoProblemIn } from "./i18n/asking";
import { meaningMatches } from "./embeddings"; // W3: meaning-based search, off unless EMBEDDINGS_URL is set

// `approved` (M1): a moderator reviewed it and kept it (the "moderator approved" mark).
export type Question = { id: number; text: string; status: string; category: string; created_at: Date; approved?: boolean };
// W3: `lang` is the language of `text` for this hit (it may be an approved translation).
export type Match = Question & { similarity: number; lang: string };

// Lowercase, strip punctuation, collapse whitespace. Two questions with the same normalized
// form are the same question.
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Tidy what the person typed into the form a question is stored in.
export function tidy(text: string): string {
  const t = text.replace(/\s+/g, " ").trim().replace(/[?.!\s]+$/, "");
  return t ? t.charAt(0).toUpperCase() + t.slice(1) + "?" : "";
}

const OPENERS = new Set([
  "is", "are", "was", "were", "am", "do", "does", "did", "will", "would", "can", "could",
  "should", "has", "have", "had", "may", "might", "must", "shall",
  "isn't", "aren't", "wasn't", "weren't", "don't", "doesn't", "didn't", "won't", "wouldn't",
  "can't", "couldn't", "shouldn't", "hasn't", "haven't", "hadn't",
]);

// A question must be answerable with one tap: true or false. This is the cheap first gate;
// lib/moderation is where a model-based check belongs.
export function booleanProblem(text: string): string | null {
  const t = tidy(text);
  const words = t.slice(0, -1).split(" ").filter(Boolean);
  if (t.length < 12 || words.length < 3) return "That's too short to be a question.";
  if (t.length > 200) return "Keep questions under 200 characters.";
  if (!/\p{L}{2,}/u.test(t)) return "That doesn't look like a question.";
  if (!OPENERS.has(words[0].toLowerCase())) {
    return 'Questions need a true-or-false answer. Start with a word like "Is", "Did", "Will" or "Does".';
  }
  return null;
}

// ---- W3 (languages) owns search() below; the ask path above and below is another workstream's.
// Search matches canonical texts and approved translations alike and always returns the
// canonical question id, so a Spanish search finds an English question with a Spanish
// translation, and asking in Spanish finds it as a duplicate. Each hit carries `text` and `lang`
// of what matched (pages pass hits through localizeQuestions to show the reader's language).
// When EMBEDDINGS_URL points at a self-hosted embeddings service, meaning-based matches are
// merged in too; without it this is trigram matching alone.
export async function search(text: string, limit = 10): Promise<Match[]> {
  const norm = normalize(text);
  if (!norm) return [];
  const [trigram, meaning] = await Promise.all([
    query<Match>(
      `select id, text, lang, status, category, created_at, similarity from (
         select distinct on (id) id, text, lang, status, category, created_at, similarity from (
           select q.id, q.text, q.lang, q.status, q.category, q.created_at,
                  similarity(q.normalized, $1)::float as similarity
             from questions q
            where q.status in ('active', 'archived')
              and (q.normalized % $1 or q.normalized like '%' || $2 || '%')
           union all
           select q.id, t.text, t.lang, q.status, q.category, q.created_at,
                  similarity(t.normalized, $1)::float
             from question_translations t join questions q on q.id = t.question_id
            where t.status = 'approved' and q.status in ('active', 'archived')
              and (t.normalized % $1 or t.normalized like '%' || $2 || '%')
         ) hits
         order by id, similarity desc
       ) best
       order by similarity desc, created_at
       limit $3`,
      [norm, norm.replace(/[%_\\]/g, ""), limit],
    ),
    meaningMatches(text, limit),
  ]);
  if (meaning.length === 0) return trigram;
  const best = new Map<number, Match>();
  for (const m of [...trigram, ...meaning]) {
    const have = best.get(m.id);
    if (!have || m.similarity > have.similarity) best.set(m.id, m);
  }
  return [...best.values()]
    .sort((a, b) => b.similarity - a.similarity || +new Date(a.created_at) - +new Date(b.created_at))
    .slice(0, limit);
}

export async function getQuestion(id: number): Promise<Question | null> {
  const rows = await query<Question>(
    "select id, text, status, category, created_at, approved_at is not null as approved from questions where id = $1 and status <> 'removed'",
    [id],
  );
  return rows[0] ?? null;
}

export type AskResult =
  | { ok: true; id: number; held: boolean }
  | {
      ok: false;
      error: string;                     // in English, for logs and callers without a page
      existingId?: number;               // it was already asked: here
      results?: CheckResult[];           // what to change: why, where and a fix for each
      text?: string;                     // the text the results' spans point into
      suggestion?: string | null;        // the whole question with the fixes applied
      harmful?: boolean;                 // the denial added a demerit
      ban?: Ban;                         // they can't ask right now
      messageKey?: string;               // a full message key (e.g. "translate.asking.too_short") for the page to translate
    };

// "Why. Where. Fix." in one English line, for logs and for callers that show a single message.
export function describeResult(r: CheckResult, text: string): string {
  const where = r.span ? text.slice(r.span.start, r.span.end) : null;
  const fix = r.fix === null ? null : r.fix === "" ? "remove it" : `"${r.fix}"`;
  return [r.reason, where && `Where: "${where}".`, fix && `Suggested fix: ${fix}.`].filter(Boolean).join(" ");
}

export function banMessage(ban: Ban): string {
  return ban.permanent
    ? "This account is banned for vote manipulation. You can appeal at /appeals."
    : `You can't ask questions until ${ban.ends_at!.toISOString().slice(0, 16).replace("T", " ")} UTC. You can still vote and browse, and you can appeal at /appeals.`;
}

async function deny(account: Account, raw: string, results: CheckResult[], harm: HarmKind | null, suggestion: string | null): Promise<AskResult> {
  const text = raw.replace(/\s+/g, " ").trim();
  // Only harmful questions cost anything. Rewording is free.
  if (harm) await addDemerit({ accountId: account.id, kind: harm, reason: results[0]?.reason ?? harm, detail: text });
  return {
    ok: false, error: results[0] ? describeResult(results[0], text) : "This question can't be asked.",
    results, text, suggestion, harmful: Boolean(harm),
  };
}

// Checks that read the same in every language. The rest (spelling, "Is / Did / Will" openers,
// lowercase "i", open-ended English words) are English rules and only apply to English.
const ANY_LANGUAGE_CHECKS = new Set(["link", "personal_data", "too_short", "too_long", "repeated_word"]);

// `lang` is the language the question is asked in (the asker's interface language). A question
// keeps the language it was asked in; translations hang off its one canonical id.
export async function ask(account: Account, raw: string, lang = "en"): Promise<AskResult> {
  const english = lang === "en";
  // A ban from asking: they can still vote and browse.
  const ban = await activeBan(account.id, "asking");
  if (ban) return { ok: false, error: banMessage(ban), ban };

  // Harm first, so a hateful question with a link in it still counts as hateful.
  const harmful = classify(raw);
  if (harmful.harm) return deny(account, raw, harmful.results, harmful.harm, null);

  // The same checks the search page shows with their fixes; here they refuse.
  const checked = checkQuestion(raw);
  const blocking = checked.results.filter((r) => r.blocking && (english || ANY_LANGUAGE_CHECKS.has(r.code)));
  if (blocking.length) {
    return { ok: false, error: describeResult(blocking[0], checked.text), results: blocking, text: checked.text, suggestion: checked.suggestion };
  }
  if (english) {
    const problem = booleanProblem(raw);
    if (problem) return { ok: false, error: problem };
  } else {
    const problem = yesNoProblemIn(lang, raw);
    if (problem) return { ok: false, error: `Question refused: ${problem}`, messageKey: `translate.asking.${problem}` };
  }

  const text = english ? tidy(raw) : tidyIn(lang, raw);
  const matches = await search(text, 5);
  const exact = matches.find((m) => normalize(m.text) === normalize(text));
  if (exact) return { ok: false, error: "That question has already been asked.", existingId: exact.id };

  const limit = LIMITS[account.tier].questionsPerDay;
  if (Number.isFinite(limit)) {
    const [{ n }] = await query<{ n: number }>(
      `select count(*)::int as n from questions where asked_by = $1 and ${TODAY_UTC("created_at")}`,
      [account.id],
    );
    if (n >= limit) return { ok: false, error: `You've asked ${limit} questions today. Try again tomorrow.` };
  }

  // The sweep: allow, hold for a moderator, or deny with why, where and a fix.
  const swept = await sweep(text, matches);
  if (swept.duplicateOf) return { ok: false, error: "That question has already been asked.", existingId: swept.duplicateOf };
  if (swept.decision === "deny") return deny(account, text, swept.results, swept.harm, swept.suggestion);
  const hold = swept.decision === "hold" ? swept.hold ?? "Held for review" : null;

  const rows = await query<{ id: number }>(
    `insert into questions (text, normalized, asked_by, category, status, held_reason, lang)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (normalized) do nothing returning id`,
    [text, normalize(text), account.id, swept.category, hold ? "review" : "active", hold, lang],
  );
  if (!rows[0]) return { ok: false, error: "That question has already been asked." };
  // M1: a close match that isn't the same text goes to the moderators' duplicates queue. The
  // question is posted and takes answers as usual.
  await suspectsAtAsk(rows[0].id, matches);
  return { ok: true, id: rows[0].id, held: Boolean(hold) };
}

// Where a removed question now lives, if it was merged into another.
export async function mergedInto(id: number): Promise<number | null> {
  const rows = await query<{ duplicate_of: number | null }>(
    "select duplicate_of from questions where id = $1 and status = 'removed'",
    [id],
  );
  return rows[0]?.duplicate_of ?? null;
}
