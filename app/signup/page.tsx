import type { Metadata } from "next";
import Link from "next/link";
import Script from "next/script";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { signupAction } from "@/app/actions";
import { ErrorBanner, Header } from "@/components/Header";
import { AGE_GATE_COOKIE } from "@/lib/age";
import { humanChallenge, TURNSTILE_SCRIPT } from "@/lib/human-check";
import { smsMode } from "@/lib/sms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("signup");
  return { title: `${t("metaTitle")} · BeliefAtlas` };
}

type Props = { searchParams: Promise<{ error?: string; next?: string }> };

// No accounts for anyone under 18, ever: the date of birth is checked (and not kept), and a
// browser that gave an under-18 date is shown only the refusal for a while (lib/age.ts).
export default async function SignupPage({ searchParams }: Props) {
  const { error, next = "/" } = await searchParams;
  const gated = Boolean((await cookies()).get(AGE_GATE_COOKIE));
  const challenge = humanChallenge();
  const t = await getTranslations("signup");
  const signIn = (x: React.ReactNode) => <Link href={`/login?next=${encodeURIComponent(next)}`}>{x}</Link>;

  // In production, signups stay closed until both the bot check and phone codes are set up.
  if (challenge.name === "off" || smsMode === "off") {
    return (
      <>
        <Header />
        <main className="wrap wrap-narrow">
          <h1 className="page-title">{t("closedTitle")}</h1>
          <p>{t("closedBody")}</p>
          <p className="q-join">{t.rich("haveAccount", { link: signIn })}</p>
        </main>
      </>
    );
  }

  if (gated) {
    return (
      <>
        <Header />
        <main className="wrap wrap-narrow">
          <h1 className="page-title">{t("title")}</h1>
          <p>{t("underage")}</p>
        </main>
      </>
    );
  }

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{t("title")}</h1>
        <ErrorBanner message={error} />
        <form action={signupAction} className="form">
          <input type="hidden" name="back" value={next} />
          <label>
            {t("username")} <span className="field-note">{t("optional")}</span>
            <input name="username" autoComplete="username" minLength={3} maxLength={20} />
            <span className="field-note">{t("usernameNote")}</span>
          </label>
          <label>
            {t("dob")}
            {/* autocomplete="bday" lets phones and browsers fill this from the person's own contact card. */}
            <input name="dob" type="date" autoComplete="bday" required />
            <span className="field-note">{t("dobNote")}</span>
          </label>
          <label>
            {t("phone")}
            <input name="phone" type="tel" autoComplete="tel" required />
            <span className="field-note">{t("phoneNote")}</span>
          </label>
          <label>
            {t("password")} <span className="field-note">{t("optional")}</span>
            <input name="password" type="password" autoComplete="new-password" minLength={8} />
            <span className="field-note">{t("passwordNote")}</span>
          </label>
          {challenge.siteKey && (
            <>
              <Script src={TURNSTILE_SCRIPT} strategy="afterInteractive" />
              <div className="cf-turnstile" data-sitekey={challenge.siteKey} data-action="signup" data-theme="dark" data-appearance="interaction-only" />
            </>
          )}
          <p className="field-note">
            {t.rich("terms", {
              terms: (x) => <Link href="/terms">{x}</Link>,
              privacy: (x) => <Link href="/privacy">{x}</Link>,
            })}
          </p>
          <button className="btn solid">{t("continue")}</button>
        </form>
        <p className="q-join">{t.rich("haveOne", { link: signIn })}</p>
      </main>
    </>
  );
}
