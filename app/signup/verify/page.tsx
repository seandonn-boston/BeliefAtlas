import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resendCodeAction, verifySignupAction } from "@/app/actions";
import { ErrorBanner, Header } from "@/components/Header";
import { pendingSummary } from "@/lib/signup";
import { PREVIEW_SMS_CODE, previewTestMode } from "@/lib/preview";
import { smsMode } from "@/lib/sms";

type Props = { searchParams: Promise<{ t?: string; error?: string; sent?: string }> };

export default async function VerifyPage({ searchParams }: Props) {
  const { t: token = "", error, sent } = await searchParams;
  const [summary, t] = await Promise.all([token ? pendingSummary(token) : null, getTranslations("signup.verify")]);
  if (!summary) redirect("/signup?error=" + encodeURIComponent(t("expired")));

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{t("title")}</h1>
        <ErrorBanner message={error} />
        <form action={verifySignupAction} className="form">
          <input type="hidden" name="token" value={token} />
          <label>
            {t("codeLabel", { ending: summary.phoneEnding })}
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{4,12}" required autoFocus />
            {sent && <span className="field-note">{t("newCode")}</span>}
            {smsMode === "dev" && (
              <span className="field-note">
                {previewTestMode ? t("preview", { code: PREVIEW_SMS_CODE }) : t("dev")}
              </span>
            )}
          </label>
          <button className="btn solid">{t("create")}</button>
        </form>
        <form action={resendCodeAction} className="aside-form">
          <input type="hidden" name="token" value={token} />
          <span>{t("noText")}</span>
          <button className="link">{t("sendNew")}</button>
        </form>
        <p className="q-join"><Link href="/signup">{t("differentNumber")}</Link></p>
      </main>
    </>
  );
}
