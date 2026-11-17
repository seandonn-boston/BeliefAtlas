import { query } from "../db";
import { normalize } from "../questions";
import { cleanTranslation, MAX_TRANSLATION_LENGTH } from "./review";

// Machine drafts: an optional self-hosted translator writes first drafts for the review queue.
// Off by default. It runs only when TRANSLATE_URL points at a LibreTranslate-compatible service
// you host yourself (no paid service, no key in code):
//
//   TRANSLATE_URL      e.g. http://localhost:5000 (or the full .../translate endpoint)
//   TRANSLATE_API_KEY  optional, only if your LibreTranslate instance requires one
//   TRANSLATE_TIMEOUT_MS  default 15000
//
// Every machine draft is stored with status 'draft' and source 'machine' and is never shown to
// readers until a person approves it at /translate. A question that already has any row for the
// language (a person's draft, an approved or a rejected translation) is left alone.
//
//   npm run translate:drafts -- --lang es --limit 50

export interface Translator {
  translate(text: string, from: string, to: string): Promise<string>;
}

type Env = Record<string, string | undefined>;

export function machineTranslationEnabled(env: Env = process.env): boolean {
  return Boolean(env.TRANSLATE_URL?.trim());
}

export class LibreTranslate implements Translator {
  private readonly endpoint: string;
  constructor(url: string, private readonly apiKey?: string, private readonly timeoutMs = 15000) {
    const base = url.trim().replace(/\/+$/, "");
    this.endpoint = base.endsWith("/translate") ? base : `${base}/translate`;
  }

  async translate(text: string, from: string, to: string): Promise<string> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, source: from, target: to, format: "text", ...(this.apiKey ? { api_key: this.apiKey } : {}) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`translator: ${response.status}`);
    const body = (await response.json()) as { translatedText?: unknown };
    if (typeof body.translatedText !== "string") throw new Error("translator: no translatedText in the response");
    return body.translatedText;
  }
}

// The configured translator, or null when machine drafting is off.
export function getTranslator(env: Env = process.env): Translator | null {
  if (!machineTranslationEnabled(env)) return null;
  return new LibreTranslate(env.TRANSLATE_URL!, env.TRANSLATE_API_KEY || undefined, Number(env.TRANSLATE_TIMEOUT_MS) || 15000);
}

export type DraftRun = { enabled: boolean; created: number; failed: number; considered: number };

// Write machine drafts into `lang` for up to `limit` live questions that have nothing for that
// language yet, most-answered first. Returns at once, doing nothing, when no translator is set.
// `ids` limits the run to those questions (e.g. one just asked).
export async function draftMachineTranslations(
  { lang, limit = 50, ids }: { lang: string; limit?: number; ids?: number[] },
  translator: Translator | null = getTranslator(),
): Promise<DraftRun> {
  if (!translator) return { enabled: false, created: 0, failed: 0, considered: 0 };
  const todo = await query<{ id: number; text: string; lang: string }>(
    `select q.id, q.text, q.lang from questions q
      where q.status = 'active' and q.lang <> $1
        and ($3::int[] is null or q.id = any($3::int[]))
        and not exists (select 1 from question_translations t where t.question_id = q.id and t.lang = $1)
      order by q.total_count desc, q.id
      limit $2`,
    [lang, Math.max(0, Math.min(limit, 1000)), ids ?? null],
  );
  let created = 0, failed = 0;
  for (const q of todo) {
    try {
      const text = cleanTranslation(await translator.translate(q.text, q.lang, lang));
      if (!normalize(text) || text.length > MAX_TRANSLATION_LENGTH) { failed++; continue; }
      const rows = await query(
        `insert into question_translations (question_id, lang, text, normalized, status, source)
         values ($1, $2, $3, $4, 'draft', 'machine')
         on conflict (question_id, lang) do nothing returning 1`,
        [q.id, lang, text, normalize(text)],
      );
      if (rows.length) created++;
    } catch (err) {
      failed++;
      console.warn(JSON.stringify({ level: "warn", msg: "machine translation failed", questionId: q.id, error: (err as Error).message }));
    }
  }
  return { enabled: true, created, failed, considered: todo.length };
}
