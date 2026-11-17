import { loadMessages } from "../i18n/messages";
import type { Locale } from "../i18n/locales";
import { UNOFFICIAL_NOTICE } from "../legal";

// Sean's rule (17 Nov): every question card, embed and export carries an always-visible notice
// that BeliefAtlas is unofficial. The API puts it on every card, split and results response, and
// both SDKs draw it under every card, falling back to their own copy if a response lacks it.
// Same words as the site banner: lib/legal.ts, translated in messages/<lang>/common.json.
export { UNOFFICIAL_NOTICE };

export async function unofficialNotice(locale: Locale): Promise<string> {
  const messages = await loadMessages(locale);
  const unofficial = (messages.common as Record<string, unknown> | undefined)?.unofficial as Record<string, unknown> | undefined;
  const full = unofficial?.full;
  return typeof full === "string" && full.trim() ? full : UNOFFICIAL_NOTICE;
}
