import { getRequestConfig } from "next-intl/server";
import { loadMessages } from "./messages";
import { requestLocale } from "./reader";

// The language comes from the picker's cookie, then the browser, then English (lib/i18n/reader).
export const getLocale = requestLocale;

export default getRequestConfig(async () => {
  const locale = await requestLocale();
  return { locale, messages: await loadMessages(locale), timeZone: "UTC" };
});
