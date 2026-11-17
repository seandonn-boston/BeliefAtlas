import { query } from "../db";
import { DEFAULT_LOCALE } from "./locales";
import { readerLocale } from "./reader";

// Showing a question in the reader's language. A question has one canonical id and one
// canonical text (in questions.lang); an approved translation into the reader's language is
// shown in its place. Drafts and rejected translations are never shown to readers.
//
// Every row that passes through here comes back with `lang`, the language its `text` is
// actually in, so the page can put a `lang` attribute on the element that shows it (screen
// readers, hyphenation and fonts all depend on it).
//
// A row may arrive with `lang` already set; that means its `text` is in that language (a feed
// row carries questions.lang; a search hit carries the language of the text that matched). A
// row already in the reader's language is kept as it is, so a page that is all one language
// costs no extra query.

export type QuestionText = { id: number; text: string; lang?: string | null };
export type Localized<T extends QuestionText> = T & { lang: string; translated: boolean };

// What the database knows for one question in one reader language.
export type TextChoice = { canonicalText: string; canonicalLang: string; approved: string | null };

// Pure: pick the text to show for each row. Kept apart from the query so it can be tested alone.
export function applyTranslations<T extends QuestionText>(
  rows: T[], locale: string, known: Map<number, TextChoice>,
): Localized<T>[] {
  return rows.map((row) => {
    if (row.lang === locale) return { ...row, lang: locale, translated: false };
    const k = known.get(row.id);
    if (!k) return { ...row, lang: row.lang ?? DEFAULT_LOCALE, translated: false };
    if (k.approved !== null && k.canonicalLang !== locale) {
      return { ...row, text: k.approved, lang: locale, translated: true };
    }
    return { ...row, text: k.canonicalText, lang: k.canonicalLang, translated: false };
  });
}

// For a list of question rows, swap in the approved translation for `locale` where there is one
// and otherwise keep (or restore) the canonical text. `locale` defaults to the reader's language
// for this request.
export async function localizeQuestions<T extends QuestionText>(rows: T[], locale?: string): Promise<Localized<T>[]> {
  const lang = locale ?? (await readerLocale());
  const ids = [...new Set(rows.filter((r) => r.lang !== lang).map((r) => r.id))];
  const known = new Map<number, TextChoice>();
  if (ids.length) {
    const found = await query<{ id: number; text: string; lang: string; approved: string | null }>(
      `select q.id, q.text, q.lang, t.text as approved
         from questions q
         left join question_translations t
           on t.question_id = q.id and t.lang = $2 and t.status = 'approved'
        where q.id = any($1::int[])`,
      [ids, lang],
    );
    for (const f of found) known.set(f.id, { canonicalText: f.text, canonicalLang: f.lang, approved: f.approved });
  }
  return applyTranslations(rows, lang, known);
}

// One question, the same way.
export async function localizeQuestion<T extends QuestionText>(row: T, locale?: string): Promise<Localized<T>> {
  return (await localizeQuestions([row], locale))[0];
}
