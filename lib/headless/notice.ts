import { loadMessages } from "../i18n/messages";
import type { Locale } from "../i18n/locales";

// Sean's rule (17 Nov): every question card, embed and export carries an always-visible notice
// that BeliefAtlas is unofficial. The API puts it on every card, split and results response, and
// both SDKs draw it under every card, falling back to their own copy if a response lacks it.
//
// The site banner's text, when develop adds it as common.unofficial, wins here so the site and
// the front door say the same thing; until then these are the words.
export const UNOFFICIAL_NOTICE: Record<string, string> = {
  en: "Unofficial. Opinions of BeliefAtlas users, not official statistics, polls or law.",
  es: "No oficial. Opiniones de usuarios de BeliefAtlas; no son estadísticas, encuestas ni leyes oficiales.",
};

export async function unofficialNotice(locale: Locale): Promise<string> {
  const messages = await loadMessages(locale);
  const fromSite = (messages.common as Record<string, unknown> | undefined)?.unofficial;
  if (typeof fromSite === "string" && fromSite.trim()) return fromSite;
  return UNOFFICIAL_NOTICE[locale] ?? UNOFFICIAL_NOTICE.en;
}
