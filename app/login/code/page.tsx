import Link from "next/link";
import { redirect } from "next/navigation";
import { smsCodeAction } from "@/app/auth-actions";
import { ErrorBanner, Header } from "@/components/Header";
import { smsLoginSummary } from "@/lib/login";
import { smsMode } from "@/lib/sms";

type Props = { searchParams: Promise<{ t?: string; error?: string }> };

export default async function LoginCodePage({ searchParams }: Props) {
  const { t = "", error } = await searchParams;
  const summary = t ? await smsLoginSummary(t) : null;
  if (!summary) redirect("/login?error=" + encodeURIComponent("That code has expired. Start again."));
  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">Enter the code we texted you</h1>
        <ErrorBanner message={error} />
        <form action={smsCodeAction} className="form">
          <input type="hidden" name="token" value={t} />
          <label>
            If the number ending {summary.phoneEnding} has an account, a code is on its way.
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{4,12}" required autoFocus />
            {smsMode === "dev" && <span className="field-note">Development mode: the code is in the server log.</span>}
          </label>
          <button className="btn solid">Sign in</button>
        </form>
        <p className="q-join"><Link href="/login">Try another way</Link></p>
      </main>
    </>
  );
}
