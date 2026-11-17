import { query } from "./db";
import { LIMITS, TODAY_UTC } from "./limits";
import type { Account } from "./auth";
import { screenQuestion } from "./moderation";
import { checkQuestion } from "./checks";
import { meaningMatches } from "./embeddings"; // W3: meaning-based search, off unless EMBEDDINGS_URL is set

export type Question = { id: number; text: string; status: string; category: string; created_at: Date };
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
    "select id, text, status, category, created_at from questions where id = $1 and status <> 'removed'",
    [id],
  );
  return rows[0] ?? null;
}

export type AskResult =
  | { ok: true; id: number; held: boolean }
  | { ok: false; error: string; existingId?: number };

export async function ask(account: Account, raw: string): Promise<AskResult> {
  // The same checks the search page shows with their fixes; here they only refuse.
  const blocking = checkQuestion(raw).results.find((r) => r.blocking);
  if (blocking) return { ok: false, error: blocking.reason };
  const problem = booleanProblem(raw);
  if (problem) return { ok: false, error: problem };

  const text = tidy(raw);
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

  const screen = await screenQuestion(text, matches);
  if (screen.reject) return { ok: false, error: screen.reject };
  if (screen.duplicateOf) return { ok: false, error: "That question has already been asked.", existingId: screen.duplicateOf };

  const rows = await query<{ id: number }>(
    `insert into questions (text, normalized, asked_by, category, status, held_reason)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (normalized) do nothing returning id`,
    [text, normalize(text), account.id, screen.category, screen.hold ? "review" : "active", screen.hold ?? null],
  );
  if (!rows[0]) return { ok: false, error: "That question has already been asked." };
  return { ok: true, id: rows[0].id, held: Boolean(screen.hold) };
}

// Where a removed question now lives, if it was merged into another.
export async function mergedInto(id: number): Promise<number | null> {
  const rows = await query<{ duplicate_of: number | null }>(
    "select duplicate_of from questions where id = $1 and status = 'removed'",
    [id],
  );
  return rows[0]?.duplicate_of ?? null;
}
