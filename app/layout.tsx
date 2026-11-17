import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import "@fontsource-variable/archivo/wdth.css";
import "./globals.css";
import { Footer } from "@/components/Footer";
import { direction } from "@/lib/i18n/locales";
import { getTheme, THEME_COLOR } from "@/lib/theme";

const CLIENT_NAMESPACES = ["common", "feed", "question", "vote", "auth"] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return { title: t("brand"), description: t("description") };
}

export async function generateViewport(): Promise<Viewport> {
  return { width: "device-width", initialScale: 1, themeColor: THEME_COLOR[await getTheme()] };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [theme, locale, messages] = await Promise.all([getTheme(), getLocale(), getMessages()]);
  // Only the namespaces that components running in the browser use go down with the page.
  const forBrowser = Object.fromEntries(CLIENT_NAMESPACES.map((ns) => [ns, messages[ns]]));
  return (
    <html lang={locale} dir={direction(locale)} data-theme={theme}>
      <body>
        <NextIntlClientProvider messages={forBrowser}>
          {children}
          <Footer />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
