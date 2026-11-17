import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import type { Ban } from "@/lib/moderation";

// Shown in place of the ask buttons while an account is banned from asking: why, when it ends,
// that voting and browsing still work, and where to appeal.
export async function AskBanNotice({ ban }: { ban: Ban }) {
  const [t, format] = await Promise.all([getTranslations("appeals.askBan"), getFormatter()]);
  return (
    <div className="notice" role="status">
      <p><strong>{t("title")}</strong></p>
      <p>
        {ban.permanent || !ban.ends_at
          ? t("permanent")
          : t("until", { date: format.dateTime(ban.ends_at, { dateStyle: "medium", timeStyle: "short" }) })}
      </p>
      <p>{t.rich("appeal", { link: (c) => <Link href="/appeals">{c}</Link> })}</p>
    </div>
  );
}
