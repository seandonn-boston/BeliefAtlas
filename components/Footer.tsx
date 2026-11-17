import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LanguageSwitch } from "./LanguageSwitch";
import { ThemeSwitch } from "./ThemeSwitch";

export async function Footer() {
  const t = await getTranslations("common.footer");
  return (
    <footer className="footer">
      <Link href="/membership">{t("membership")}</Link>
      <Link href="/terms">{t("terms")}</Link>
      <Link href="/privacy">{t("privacy")}</Link>
      <ThemeSwitch />
      <LanguageSwitch />
    </footer>
  );
}
