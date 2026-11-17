import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  removePasskeyAction, renameAction, setPasswordAction, setPinAction, totpBeginAction, totpDisableAction,
} from "@/app/auth-actions";
import { ConfirmFields } from "@/components/ConfirmFields";
import { ErrorBanner, Header } from "@/components/Header";
import { PasskeyAdd } from "@/components/PasskeyAdd";
import { TotpConfirm } from "@/components/TotpConfirm";
import { getAccount } from "@/lib/auth";
import { query } from "@/lib/db";
import { identityVerifier } from "@/lib/identity-verification";
import { pendingTotp, recoveryCodesLeft } from "@/lib/mfa";
import { listPasskeys } from "@/lib/passkeys";

export const metadata: Metadata = { title: "Security · BeliefAtlas" };

type Props = { searchParams: Promise<{ error?: string; saved?: string; setup?: string; welcome?: string; next?: string }> };

const SAVED: Record<string, string> = {
  username: "Username changed.",
  pin: "PIN saved.",
  password: "Password saved.",
  "totp-off": "Authenticator app turned off.",
};

export default async function SecurityPage({ searchParams }: Props) {
  const account = await getAccount();
  if (!account) redirect("/login?next=%2Fsettings%2Fsecurity");
  const { error, saved, setup, welcome, next } = await searchParams;
  const [info] = await query<{ has_pin: boolean; has_password: boolean; totp_on: boolean }>(
    `select pin_hash is not null as has_pin, password_hash is not null as has_password, totp_enabled_at is not null as totp_on
       from accounts where id = $1`,
    [account.id],
  );
  const passkeys = await listPasskeys(account.id);
  const totpSetup = setup === "totp" && !info.totp_on ? await pendingTotp(account.id, account.username) : null;
  const codesLeft = info.totp_on ? await recoveryCodesLeft(account.id) : 0;
  const date = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  const continueTo = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{welcome ? "Your account is ready" : "Sign-in and security"}</h1>
        <ErrorBanner message={error} />
        {saved && SAVED[saved] && <p className="note">{SAVED[saved]}</p>}
        {welcome && (
          <p>
            Add a passkey so next time you sign in with Face ID, your fingerprint or your computer&apos;s PIN instead of a
            texted code. Or <Link href={continueTo}>skip for now</Link>.
          </p>
        )}

        <section className="block">
          <h2>Passkeys</h2>
          <p className="note">
            The fastest and safest way to sign in. Your device checks your face, fingerprint or PIN itself; nothing
            biometric is ever sent to us.
          </p>
          {passkeys.length > 0 && (
            <ul className="passkey-list">
              {passkeys.map((p) => (
                <li key={p.id}>
                  <span>{p.name}{p.backed_up ? " · synced" : ""} · added {date(p.created_at)}{p.last_used_at ? ` · last used ${date(p.last_used_at)}` : ""}</span>
                  <form action={removePasskeyAction} className="aside-form">
                    <input type="hidden" name="id" value={p.id} />
                    <ConfirmFields hasPin={info.has_pin} hasPassword={info.has_password} />
                    <button className="link">Remove</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <PasskeyAdd label={passkeys.length ? "Add another passkey" : "Add a passkey"} />
        </section>

        <section className="block">
          <h2>Authenticator app</h2>
          {info.totp_on ? (
            <>
              <p className="note">
                On. Signing in with a texted code or a password also asks for a code from your app. {codesLeft} recovery
                {codesLeft === 1 ? " code" : " codes"} left.
              </p>
              <form action={totpDisableAction} className="form">
                <ConfirmFields hasPin={info.has_pin} hasPassword={info.has_password} />
                <button className="btn">Turn off</button>
              </form>
            </>
          ) : totpSetup ? (
            <>
              <p className="note">
                In your authenticator app (Google Authenticator, 1Password, Authy, or the iPhone Passwords app), add an
                account with this setup key, or open the link on the phone that has the app.
              </p>
              <p><code>{totpSetup.secret.replace(/(.{4})/g, "$1 ").trim()}</code></p>
              <p className="note"><a href={totpSetup.uri}>Open in authenticator app</a></p>
              <TotpConfirm />
            </>
          ) : (
            <>
              <p className="note">A second step after a texted code or password: a six-digit code from an app on your phone. Free, and works offline.</p>
              <form action={totpBeginAction}><button className="btn">Set up an authenticator app</button></form>
            </>
          )}
        </section>

        <section className="block">
          <h2>Account PIN</h2>
          <p className="note">
            Asked for before removing a passkey, turning off the authenticator app, changing your password or deleting
            your account. 4 to 8 digits; stored only as a one-way hash.
          </p>
          <form action={setPinAction} className="form">
            {info.has_pin && <label>Current PIN<input name="current" type="password" inputMode="numeric" autoComplete="off" required /></label>}
            <label>{info.has_pin ? "New PIN" : "PIN"}<input name="pin" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{4,8}" required /></label>
            <label>Repeat it<input name="pin2" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{4,8}" required /></label>
            <button className="btn">{info.has_pin ? "Change PIN" : "Set PIN"}</button>
          </form>
        </section>

        <section className="block">
          <h2>Username</h2>
          <form action={renameAction} className="form">
            <label>
              Username
              <input name="username" defaultValue={account.username} autoComplete="username" required minLength={3} maxLength={20} />
              <span className="field-note">Letters, numbers and underscores. You can change it once a day.</span>
            </label>
            <button className="btn">Save</button>
          </form>
        </section>

        <section className="block">
          <h2>Password</h2>
          <p className="note">
            Optional. {info.has_password ? "You can sign in with your username and password." : "Without one, you sign in with a passkey or a texted code."}
          </p>
          <form action={setPasswordAction} className="form">
            {(info.has_pin || info.has_password) && <ConfirmFields hasPin={info.has_pin} hasPassword={info.has_password} />}
            <label>{info.has_password ? "New password" : "Password"}<input name="new_password" type="password" autoComplete="new-password" minLength={8} maxLength={200} required /></label>
            <button className="btn">{info.has_password ? "Change password" : "Add a password"}</button>
          </form>
        </section>

        <section className="block">
          <h2>Face and ID check</h2>
          <p className="note">
            {identityVerifier().enabled
              ? "Confirm your identity with a face scan and a photo ID for the verified tier."
              : "A face scan with a photo ID, for the verified tier, isn't available yet."}
          </p>
        </section>

        <p className="q-join"><Link href="/settings">Back to settings</Link></p>
      </main>
    </>
  );
}
