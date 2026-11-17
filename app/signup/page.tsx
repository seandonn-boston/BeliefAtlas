import Link from "next/link";
import Script from "next/script";
import { cookies } from "next/headers";
import { signupAction } from "@/app/actions";
import { ErrorBanner, Header } from "@/components/Header";
import { AGE_GATE_COOKIE } from "@/lib/age";
import { humanChallenge, TURNSTILE_SCRIPT } from "@/lib/human-check";

type Props = { searchParams: Promise<{ error?: string; next?: string }> };

export default async function SignupPage({ searchParams }: Props) {
  const { error, next = "/" } = await searchParams;
  const gated = Boolean((await cookies()).get(AGE_GATE_COOKIE));
  const challenge = humanChallenge();

  if (gated) {
    return (
      <>
        <Header />
        <main className="wrap wrap-narrow">
          <h1 className="page-title">Create an account</h1>
          <p>Sorry, you need to be 18 or older to create an account.</p>
        </main>
      </>
    );
  }

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">Create an account</h1>
        <ErrorBanner message={error} />
        <form action={signupAction} className="form">
          <input type="hidden" name="back" value={next} />
          <label>Username<input name="username" autoComplete="username" required minLength={3} maxLength={20} /></label>
          <label>
            Date of birth
            {/* autocomplete="bday" lets phones and browsers fill this from the person's own contact card. */}
            <input name="dob" type="date" autoComplete="bday" required />
            <span className="field-note">We check it once and don&apos;t keep it.</span>
          </label>
          <label>
            Phone number
            <input name="phone" type="tel" autoComplete="tel" required />
            <span className="field-note">
              We text it a code to confirm it is yours. Use a mobile number; internet and virtual numbers can&apos;t be used.
              One account per number; it is stored only as a one-way hash and never shared.
            </span>
          </label>
          <label>Password<input name="password" type="password" autoComplete="new-password" required minLength={8} /></label>
          <label className="check">
            <input type="checkbox" name="consent" required />
            <span>
              I agree to the <Link href="/terms">terms</Link> and <Link href="/privacy">privacy policy</Link>, including
              that my votes are recorded and used, without my name, in published results and data.
            </span>
          </label>
          {challenge.siteKey && (
            <>
              <Script src={TURNSTILE_SCRIPT} strategy="afterInteractive" />
              <div className="cf-turnstile" data-sitekey={challenge.siteKey} data-action="signup" data-theme="dark" data-appearance="interaction-only" />
            </>
          )}
          <button className="btn solid">Text me a code</button>
        </form>
        <p className="q-join">Already have one? <Link href={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link>.</p>
      </main>
    </>
  );
}
