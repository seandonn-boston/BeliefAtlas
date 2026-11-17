import Link from "next/link";
import { redirect } from "next/navigation";
import { finishCodeLoginAction } from "@/app/login/actions";
import { ErrorBanner, Header } from "@/components/Header";
import { codeLoginSummary } from "@/lib/code-login";

type Props = { searchParams: Promise<{ t?: string; error?: string }> };

export default async function CodeLoginPage({ searchParams }: Props) {
  const { t = "", error } = await searchParams;
  const summary = await codeLoginSummary(t);
  if (!summary) redirect("/login?error=" + encodeURIComponent("That code has expired. Start again."));
  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">Enter your code</h1>
        <ErrorBanner message={error} />
        <p>If ••• {summary.phoneEnding} has an account, we&apos;ve texted it a code.</p>
        <form action={finishCodeLoginAction} className="form">
          <input type="hidden" name="token" value={t} />
          <label>Code<input name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus /></label>
          <button className="btn solid">Sign in</button>
        </form>
        <p className="q-join">No code? <Link href="/login">Try again</Link> or <Link href="/signup">create an account</Link>.</p>
      </main>
    </>
  );
}
