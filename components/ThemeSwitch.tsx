import { setThemeAction } from "@/app/actions";
import { getTheme, THEMES } from "@/lib/theme";

// Theme sits in the footer of every page, so anyone can change it, signed in or not. The
// language picker will sit beside it (same cookie mechanism, same instant swap).
export async function ThemeSwitch() {
  const current = await getTheme();
  return (
    <form action={setThemeAction} className="theme-switch" aria-label="Theme">
      {THEMES.map((t) => (
        <button key={t.value} name="theme" value={t.value} aria-pressed={current === t.value} className="link">
          {t.label}
        </button>
      ))}
    </form>
  );
}
