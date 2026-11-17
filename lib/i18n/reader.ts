import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, fromAcceptLanguage, isLocale, LANG_COOKIE, type Locale } from "./locales";

// The reader's language for this request: the picker's cookie, then the browser, then English.
// URLs never carry a language, so a shared link opens in the reader's own language.
export async function requestLocale(): Promise<Locale> {
  const chosen = (await cookies()).get(LANG_COOKIE)?.value;
  if (isLocale(chosen)) return chosen;
  return fromAcceptLanguage((await headers()).get("accept-language")) ?? DEFAULT_LOCALE;
}

// The same, for library code that also runs outside a request (scripts, tests): there it falls
// back to English. Next's own signals (an error with a `digest`, used to mark a page dynamic)
// are passed through untouched.
export async function readerLocale(): Promise<Locale> {
  try {
    return await requestLocale();
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return DEFAULT_LOCALE;
  }
}
