import Link from "next/link";
import Script from "next/script";
import { cookies } from "next/headers";
import { signupAction } from "@/app/actions";
import { ErrorBanner, Header } from "@/components/Header";
import { AGE_GATE_COOKIE } from "@/lib/age";
import { humanChallenge, TURNSTILE_SCRIPT } from "@/lib/human-check";
import { smsMode } from "@/lib/sms";

type Props = { searchParams: Promise<{ error?: string; next?: string }> };

export default async function SignupPage({ searchParams }: Props) {
  const { error, next = "/" } = await searchParams;
  const gated = Boolean((await cookies()).get(AGE_GATE_COOKIE));
  const challenge = humanChallenge();

  // In production, signups stay closed until both the bot check and phone codes are set up.
  if (challenge.name === "off" || smsMode === "off") {
    return (
      <>
        <Header />
        <main className="wrap wrap-narrow">
          <h1 className="page-title">Signups aren&apos;t open yet</h1>
          <p>We&apos;re finishing the checks that keep Belief Map to real people. Check back soon.</p>
          <p className="q-join">Already have an account? <Link href={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link>.</p>
        </main>
      </>
    );
  }

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
          <label>
            Username <span className="field-note">(optional)</span>
            <input name="username" autoComplete="username" minLength={3} maxLength={20} />
            <span className="field-note">Leave it blank and we&apos;ll pick one. You can change it later.</span>
          </label>
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
          <label>
            Password <span className="field-note">(optional)</span>
            <input name="password" type="password" autoComplete="new-password" minLength={8} />
            <span className="field-note">Without one, you sign in with a passkey or a texted code.</span>
          </label>
          {challenge.siteKey && (
            <>
              <Script src={TURNSTILE_SCRIPT} strategy="afterInteractive" />
              <div className="cf-turnstile" data-sitekey={challenge.siteKey} data-action="signup" data-theme="dark" data-appearance="interaction-only" />
            </>
          )}
          <p className="field-note">
            By continuing, you agree to the <Link href="/terms">terms</Link> and <Link href="/privacy">privacy
            policy</Link>, including that your votes are recorded and used, without your name, in published results and
            data.
          </p>
          <button className="btn solid">Continue</button>
        </form>
        <p className="q-join">Already have one? <Link href={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link>.</p>
      </main>
    </>
  );
}
