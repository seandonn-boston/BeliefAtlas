import type { Metadata, Viewport } from "next";
import "@fontsource-variable/archivo/wdth.css";
import "./globals.css";
import { Footer } from "@/components/Footer";
import { getTheme, THEME_COLOR } from "@/lib/theme";

export const metadata: Metadata = {
  title: "BeliefAtlas",
  description: "What people believe, how firmly, and how it changes.",
};

export async function generateViewport(): Promise<Viewport> {
  return { width: "device-width", initialScale: 1, themeColor: THEME_COLOR[await getTheme()] };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = await getTheme();
  return (
    <html lang="en" data-theme={theme}>
      <body>
        {children}
        <Footer />
      </body>
    </html>
  );
}
