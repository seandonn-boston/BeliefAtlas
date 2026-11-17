import Link from "next/link";
import { redirect } from "next/navigation";
import { mfaAction } from "@/app/auth-actions";
import { ErrorBanner, Header } from "@/components/Header";
import { mfaPending } from "@/lib/login";

type Props = { searchParams: Promise<{ t?: string; error?: string }> };

export default async function MfaPage({ searchParams }: Props) {
  const { t = "", error } = await searchParams;
  if (!t || !(await mfaPending(t))) redirect("/login?error=" + encodeURIComponent("That sign-in has expired. Start again."));
  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">One more step</h1>
        <ErrorBanner message={error} />
        <form action={mfaAction} className="form">
          <input type="hidden" name="token" value={t} />
          <label>
            Code from your authenticator app
            <input name="code" autoComplete="one-time-code" required autoFocus />
            <span className="field-note">Lost your phone? Enter one of your recovery codes instead.</span>
          </label>
          <button className="btn solid">Sign in</button>
        </form>
        <p className="q-join"><Link href="/login">Start again</Link></p>
      </main>
    </>
  );
}
