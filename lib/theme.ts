import { cookies } from "next/headers";

// The page themes. OLED is true black, so unlit pixels stay off on emissive screens. Digital
// Paper is a warm, low-contrast-glare light theme, closer to an e-ink page. More may follow;
// each is one block of colour tokens in app/globals.css, so a theme never touches a component.
export const THEMES = [
  { value: "oled", label: "OLED" },
  { value: "paper", label: "Digital Paper" },
] as const;
export type Theme = (typeof THEMES)[number]["value"];
export const THEME_COOKIE = "cm_theme";

// The browser chrome colour for each theme (the address bar on phones).
export const THEME_COLOR: Record<Theme, string> = { oled: "#000000", paper: "#f3efe6" };

export const isTheme = (value: unknown): value is Theme => THEMES.some((t) => t.value === value);

export async function getTheme(): Promise<Theme> {
  const value = (await cookies()).get(THEME_COOKIE)?.value;
  return isTheme(value) ? value : "oled";
}
