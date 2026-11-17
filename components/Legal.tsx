import { getTranslations } from "next-intl/server";
import { LEGAL_DRAFT, LEGAL_UPDATED } from "@/lib/legal";

// Legal pages stay in English until each translation has been reviewed by a lawyer; only the
// frame around them is translated.
export async function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  const t = await getTranslations("common");
  return (
    <main className="wrap wrap-narrow legal" lang="en">
      <h1 className="page-title">{title}</h1>
      {LEGAL_DRAFT && <p className="notice" role="note">{t("legalDraft")}</p>}
      <p className="field-note">{t("lastUpdated", { date: LEGAL_UPDATED })}</p>
      {children}
    </main>
  );
}
