import Link from "next/link";
import { loginAction } from "@/app/actions";
import { smsLoginAction } from "@/app/auth-actions";
import { ErrorBanner, Header } from "@/components/Header";
import { PasskeySignIn } from "@/components/PasskeySignIn";

type Props = { searchParams: Promise<{ error?: string; next?: string }> };

// A passkey first, a texted code second, and a password for accounts that set one.
export default async function LoginPage({ searchParams }: Props) {
  const { error, next = "/" } = await searchParams;
  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">Sign in</h1>
        <ErrorBanner message={error} />
        <PasskeySignIn next={next} />

        <section className="block">
          <h2>Or get a code by text</h2>
          <form action={smsLoginAction} className="form">
            <input type="hidden" name="back" value={next} />
            <label>Phone number<input name="phone" type="tel" autoComplete="tel" required /></label>
            <button className="btn">Text me a code</button>
          </form>
        </section>

        <details className="block">
          <summary>Use a password</summary>
          <form action={loginAction} className="form">
            <input type="hidden" name="back" value={next} />
            <label>Username<input name="username" autoComplete="username" required /></label>
            <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
            <button className="btn">Sign in</button>
          </form>
        </details>

        <p className="q-join">New here? <Link href={`/signup?next=${encodeURIComponent(next)}`}>Create an account</Link>.</p>
      </main>
    </>
  );
}
