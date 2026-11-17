import Link from "next/link";
import { loginAction } from "@/app/actions";
import { startCodeLoginAction } from "@/app/login/actions";
import { ErrorBanner, Header } from "@/components/Header";

type Props = { searchParams: Promise<{ error?: string; next?: string }> };

// Signing in: a texted code by default (passwords are optional), or a password for accounts
// that set one.
export default async function LoginPage({ searchParams }: Props) {
  const { error, next = "/" } = await searchParams;
  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">Sign in</h1>
        <ErrorBanner message={error} />
        <form action={startCodeLoginAction} className="form">
          <input type="hidden" name="back" value={next} />
          <label>Phone number<input name="phone" type="tel" autoComplete="tel" required /></label>
          <button className="btn solid">Text me a code</button>
        </form>
        <details className="block">
          <summary>Use a password instead</summary>
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
