import en from "../../messages/en/common.json";
import es from "../../messages/es/common.json";
import { fromAcceptLanguage, isLocale, LANG_COOKIE, type Locale } from "../i18n/locales";
import { placeBlocked } from "./places";

// The one plain page a visitor in a blocked place sees, whatever they asked for. It is served
// straight from proxy.ts with status 451 (Unavailable For Legal Reasons), so it needs no
// database, no layout and no scripts. API calls get the same answer as JSON.

const TEXT: Record<Locale, { title: string; body: string }> = { en: en.unavailable, es: es.unavailable };

type Req = { headers: { get(name: string): string | null }; cookies: { get(name: string): { value: string } | undefined } };

// The blocked place for this request, from Vercel's free location headers, or null.
export function blockedPlaceFor(req: Req) {
  return placeBlocked(req.headers.get("x-vercel-ip-country"), req.headers.get("x-vercel-ip-country-region"));
}

export function unavailableLocale(req: Req): Locale {
  const cookie = req.cookies.get(LANG_COOKIE)?.value;
  return isLocale(cookie) ? cookie : fromAcceptLanguage(req.headers.get("accept-language")) ?? "en";
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function unavailableHtml(locale: Locale): string {
  const t = TEXT[locale] ?? TEXT.en;
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escape(t.title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#fff;color:#111;padding:16px}
@media (prefers-color-scheme:dark){body{background:#000;color:#eee}}main{max-width:32rem}h1{font-size:1.5rem;margin:0 0 .5rem}</style>
</head><body><main><h1>${escape(t.title)}</h1><p>${escape(t.body)}</p></main></body></html>`;
}

export function unavailableJson(locale: Locale) {
  return { error: "unavailable_here", message: (TEXT[locale] ?? TEXT.en).body };
}
