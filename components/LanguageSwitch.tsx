import { getLocale, getTranslations } from "next-intl/server";
import { setLanguageAction } from "@/app/actions";
import { LOCALES } from "@/lib/i18n/locales";

// The language picker sits beside the theme picker and swaps the same way: one tap, a cookie,
// and the page comes back in the new language. Each name is written in its own language.
export async function LanguageSwitch() {
  const [current, t] = await Promise.all([getLocale(), getTranslations("common.language")]);
  return (
    <form action={setLanguageAction} className="theme-switch" aria-label={t("label")}>
      {LOCALES.map((l) => (
        <button key={l.code} name="lang" value={l.code} lang={l.code} aria-pressed={current === l.code}
          className="link" title={l.review ? t("review") : undefined}>
          {l.name}
        </button>
      ))}
    </form>
  );
}
