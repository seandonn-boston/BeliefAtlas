import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { mfaAction } from "@/app/auth-actions";
import { ErrorBanner, Header } from "@/components/Header";
import { mfaPending } from "@/lib/login";

type Props = { searchParams: Promise<{ t?: string; error?: string }> };

export default async function MfaPage({ searchParams }: Props) {
  const [{ t = "", error }, m] = await Promise.all([searchParams, getTranslations("auth")]);
  if (!t || !(await mfaPending(t))) redirect("/login?error=" + encodeURIComponent(m("mfaExpired")));
  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{m("mfaTitle")}</h1>
        <ErrorBanner message={error} />
        <form action={mfaAction} className="form">
          <input type="hidden" name="token" value={t} />
          <label>
            {m("mfaCode")}
            <input name="code" autoComplete="one-time-code" required autoFocus />
            <span className="field-note">{m("mfaRecovery")}</span>
          </label>
          <button className="btn solid">{m("signIn")}</button>
        </form>
        <p className="q-join"><Link href="/login">{m("startAgain")}</Link></p>
      </main>
    </>
  );
}
