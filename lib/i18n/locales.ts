// The interface languages. A question is one canonical id whatever language it's read in; its
// translations live in question_translations and go live only after a person approves them.
//
// To add a language: add it here, add messages/<code>/*.json (any key left out falls back to
// English), and it appears in the picker. `review` marks a language whose interface text still
// needs a native speaker to check it.
export const LOCALES = [
  { code: "en", name: "English", review: false },
  { code: "es", name: "Español", review: true },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];
export const DEFAULT_LOCALE: Locale = "en";
export const LANG_COOKIE = "cm_lang";

// Right-to-left scripts. The layout flips by the `dir` attribute on <html>, and the CSS uses
// logical properties, so a right-to-left language needs no component changes.
const RTL = new Set(["ar", "he", "fa", "ur", "ps", "yi"]);
export const direction = (code: string): "ltr" | "rtl" => (RTL.has(code.split("-")[0]) ? "rtl" : "ltr");

export const isLocale = (value: unknown): value is Locale => LOCALES.some((l) => l.code === value);

// The best supported language from an Accept-Language header, by quality then order.
export function fromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag: tag.toLowerCase(), q: q ? Number(q.slice(2)) || 0 : 1, i };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of ranked) {
    const base = tag.split("-")[0];
    if (isLocale(base)) return base;
  }
  return null;
}
