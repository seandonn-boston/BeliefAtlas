import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { loginAction } from "@/app/actions";
import { smsLoginAction } from "@/app/auth-actions";
import { ErrorBanner, Header } from "@/components/Header";
import { PasskeySignIn } from "@/components/PasskeySignIn";

type Props = { searchParams: Promise<{ error?: string; next?: string }> };

// A passkey first, a texted code second, and a password for accounts that set one.
export default async function LoginPage({ searchParams }: Props) {
  const [{ error, next = "/" }, t] = await Promise.all([searchParams, getTranslations("auth")]);
  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{t("signIn")}</h1>
        <ErrorBanner message={error} />
        <PasskeySignIn next={next} />

        <section className="block">
          <h2>{t("orText")}</h2>
          <form action={smsLoginAction} className="form">
            <input type="hidden" name="back" value={next} />
            <label>{t("phone")}<input name="phone" type="tel" autoComplete="tel" required /></label>
            <button className="btn">{t("textMe")}</button>
          </form>
        </section>

        <details className="block">
          <summary>{t("usePassword")}</summary>
          <form action={loginAction} className="form">
            <input type="hidden" name="back" value={next} />
            <label>{t("username")}<input name="username" autoComplete="username" required /></label>
            <label>{t("password")}<input name="password" type="password" autoComplete="current-password" required /></label>
            <button className="btn">{t("signIn")}</button>
          </form>
        </details>

        <p className="q-join">{t.rich("newHere", { link: (x) => <Link href={`/signup?next=${encodeURIComponent(next)}`}>{x}</Link> })}</p>
      </main>
    </>
  );
}
