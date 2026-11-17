import { getTranslations } from "next-intl/server";
import { setThemeAction } from "@/app/actions";
import { getTheme, THEMES } from "@/lib/theme";

// Theme sits in the footer of every page, so anyone can change it, signed in or not.
export async function ThemeSwitch() {
  const [current, t] = await Promise.all([getTheme(), getTranslations("common.theme")]);
  return (
    <form action={setThemeAction} className="theme-switch" aria-label={t("label")}>
      {THEMES.map((theme) => (
        <button key={theme.value} name="theme" value={theme.value} aria-pressed={current === theme.value} className="link">
          {t(theme.value)}
        </button>
      ))}
    </form>
  );
}
