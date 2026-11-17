import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { smsCodeAction } from "@/app/auth-actions";
import { ErrorBanner, Header } from "@/components/Header";
import { smsLoginSummary } from "@/lib/login";
import { smsMode } from "@/lib/sms";

type Props = { searchParams: Promise<{ t?: string; error?: string }> };

export default async function LoginCodePage({ searchParams }: Props) {
  const { t = "", error } = await searchParams;
  const [summary, m] = await Promise.all([t ? smsLoginSummary(t) : null, getTranslations("auth")]);
  if (!summary) redirect("/login?error=" + encodeURIComponent(m("codeExpired")));
  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{m("codeTitle")}</h1>
        <ErrorBanner message={error} />
        <form action={smsCodeAction} className="form">
          <input type="hidden" name="token" value={t} />
          <label>
            {m("codeSent", { ending: summary.phoneEnding })}
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{4,12}" required autoFocus />
            {smsMode === "dev" && <span className="field-note">{m("devCode")}</span>}
          </label>
          <button className="btn solid">{m("signIn")}</button>
        </form>
        <p className="q-join"><Link href="/login">{m("tryAnother")}</Link></p>
      </main>
    </>
  );
}
