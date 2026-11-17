import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE, fromAcceptLanguage, isLocale, LANG_COOKIE, type Locale } from "./locales";
import { loadMessages } from "./messages";

// The language comes from the picker's cookie, then the browser, then English. URLs never carry
// a language, so a shared link opens in the reader's own language.
export async function getLocale(): Promise<Locale> {
  const chosen = (await cookies()).get(LANG_COOKIE)?.value;
  if (isLocale(chosen)) return chosen;
  return fromAcceptLanguage((await headers()).get("accept-language")) ?? DEFAULT_LOCALE;
}

export default getRequestConfig(async () => {
  const locale = await getLocale();
  return { locale, messages: await loadMessages(locale), timeZone: "UTC" };
});
