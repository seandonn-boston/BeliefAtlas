import { DEFAULT_LOCALE, isLocale, type Locale } from "./locales";
import { readerLocale } from "./reader";

// Asking in any language. A question asked while the interface is in Spanish is stored with
// questions.lang = 'es' and its text kept exactly as asked (no translation step), so it gets a
// canonical id like any other, and votes in every language count on it.
//
// For the ask path (lib/questions.ts ask() and app/actions.ts askAction, owned by another
// workstream), the change is:
//   insert into questions (text, normalized, ..., lang) values (..., $n)   with $n = await askingLanguage()
// and, for a language other than English, `tidyIn(lang, raw)` / `yesNoProblemIn(lang, raw)` in
// place of the English-only tidy() / booleanProblem(), whose "Is / Did / Will" opener rule would
// refuse every Spanish question.

// The language a question asked now is in: the interface language of this request.
export async function askingLanguage(): Promise<Locale> {
  return readerLocale();
}

// The language to store, from anything a caller has (a form field, an account preference).
export function questionLanguage(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

// Tidy a question into the form it is stored in, by the conventions of its language.
export function tidyIn(lang: string, raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim().replace(/^[¿¡\s]+/, "").replace(/[?.!\s]+$/, "");
  if (!t) return "";
  const body = t.charAt(0).toLocaleUpperCase(lang) + t.slice(1);
  // Spanish opens a question with ¿ as well as closing it with ?.
  return lang === "es" ? `¿${body}?` : `${body}?`;
}

// Words that open an open question (what, which, when...) rather than a yes-or-no one. Only the
// accented interrogatives count: unaccented "que", "como", "donde" are also ordinary words
// ("¿Que llueva mañana es probable?").
const OPEN_QUESTION: Record<string, RegExp> = {
  es: /^(qué|cuál(es)?|cuándo|dónde|adónde|cómo|quién(es)?|cuánt[oa]s?|por qué|para qué)(\s|$)/,
};

export type YesNoProblem = "too_short" | "too_long" | "not_a_question" | "not_yes_no";

// The cheap first gate for a language other than English: a question must be answerable with
// one tap, true or false. English keeps lib/questions.ts booleanProblem(). Returns a message key
// under translate.asking (en and es), or null when the question is fine.
export function yesNoProblemIn(lang: string, raw: string): YesNoProblem | null {
  const t = tidyIn(lang, raw);
  const inner = t.replace(/^¿/, "").replace(/\?$/, "");
  const words = inner.split(" ").filter(Boolean);
  if (t.length < 12 || words.length < 3) return "too_short";
  if (t.length > 200) return "too_long";
  if (!/\p{L}{2,}/u.test(t)) return "not_a_question";
  if (OPEN_QUESTION[lang]?.test(inner.toLocaleLowerCase(lang))) return "not_yes_no";
  return null;
}
