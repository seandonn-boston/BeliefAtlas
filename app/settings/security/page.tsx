import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
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

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.security");
  return { title: `${t("metaTitle")} · BeliefAtlas` };
}

type Props = { searchParams: Promise<{ error?: string; saved?: string; setup?: string; welcome?: string; next?: string }> };

const SAVED: Record<string, string> = { username: "username", pin: "pin", password: "password", "totp-off": "totpOff" };

export default async function SecurityPage({ searchParams }: Props) {
  const account = await getAccount();
  if (!account) redirect("/login?next=%2Fsettings%2Fsecurity");
  const { error, saved, setup, welcome, next } = await searchParams;
  const [t, format] = await Promise.all([getTranslations("settings.security"), getFormatter()]);
  const [info] = await query<{ has_pin: boolean; has_password: boolean; totp_on: boolean }>(
    `select pin_hash is not null as has_pin, password_hash is not null as has_password, totp_enabled_at is not null as totp_on
       from accounts where id = $1`,
    [account.id],
  );
  const passkeys = await listPasskeys(account.id);
  const totpSetup = setup === "totp" && !info.totp_on ? await pendingTotp(account.id, account.username) : null;
  const codesLeft = info.totp_on ? await recoveryCodesLeft(account.id) : 0;
  const date = (d: Date) => format.dateTime(d, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  const continueTo = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{welcome ? t("welcomeTitle") : t("title")}</h1>
        <ErrorBanner message={error} />
        {saved && SAVED[saved] && <p className="note">{t("saved", { what: SAVED[saved] })}</p>}
        {welcome && (
          <p>{t.rich("welcome", { link: (x) => <Link href={continueTo}>{x}</Link> })}</p>
        )}

        <section className="block">
          <h2>{t("passkeys")}</h2>
          <p className="note">{t("passkeysNote")}</p>
          {passkeys.length > 0 && (
            <ul className="passkey-list">
              {passkeys.map((p) => (
                <li key={p.id}>
                  <span>{t("passkeyLine", { name: p.name, synced: p.backed_up ? "yes" : "no", added: date(p.created_at) })}{p.last_used_at ? t("lastUsed", { date: date(p.last_used_at) }) : ""}</span>
                  <form action={removePasskeyAction} className="aside-form">
                    <input type="hidden" name="id" value={p.id} />
                    <ConfirmFields hasPin={info.has_pin} hasPassword={info.has_password} />
                    <button className="link">{t("remove")}</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <PasskeyAdd label={passkeys.length ? t("addAnother") : t("addPasskey")} />
        </section>

        <section className="block">
          <h2>{t("totp")}</h2>
          {info.totp_on ? (
            <>
              <p className="note">{t("totpOn", { n: codesLeft })}</p>
              <form action={totpDisableAction} className="form">
                <ConfirmFields hasPin={info.has_pin} hasPassword={info.has_password} />
                <button className="btn">{t("turnOff")}</button>
              </form>
            </>
          ) : totpSetup ? (
            <>
              <p className="note">{t("totpSetup")}</p>
              <p><code>{totpSetup.secret.replace(/(.{4})/g, "$1 ").trim()}</code></p>
              <p className="note"><a href={totpSetup.uri}>{t("openApp")}</a></p>
              <TotpConfirm />
            </>
          ) : (
            <>
              <p className="note">{t("totpOff")}</p>
              <form action={totpBeginAction}><button className="btn">{t("setUpTotp")}</button></form>
            </>
          )}
        </section>

        <section className="block">
          <h2>{t("pin")}</h2>
          <p className="note">{t("pinNote")}</p>
          <form action={setPinAction} className="form">
            {info.has_pin && <label>{t("currentPin")}<input name="current" type="password" inputMode="numeric" autoComplete="off" required /></label>}
            <label>{info.has_pin ? t("newPin") : t("pinLabel")}<input name="pin" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{4,8}" required /></label>
            <label>{t("repeat")}<input name="pin2" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{4,8}" required /></label>
            <button className="btn">{info.has_pin ? t("changePin") : t("setPin")}</button>
          </form>
        </section>

        <section className="block">
          <h2>{t("username")}</h2>
          <form action={renameAction} className="form">
            <label>
              {t("username")}
              <input name="username" defaultValue={account.username} autoComplete="username" required minLength={3} maxLength={20} />
              <span className="field-note">{t("usernameNote")}</span>
            </label>
            <button className="btn">{t("save")}</button>
          </form>
        </section>

        <section className="block">
          <h2>{t("password")}</h2>
          <p className="note">{t("passwordNote", { has: info.has_password ? "yes" : "no" })}</p>
          <form action={setPasswordAction} className="form">
            {(info.has_pin || info.has_password) && <ConfirmFields hasPin={info.has_pin} hasPassword={info.has_password} />}
            <label>{info.has_password ? t("newPassword") : t("passwordLabel")}<input name="new_password" type="password" autoComplete="new-password" minLength={8} maxLength={200} required /></label>
            <button className="btn">{info.has_password ? t("changePassword") : t("addPassword")}</button>
          </form>
        </section>

        <section className="block">
          <h2>{t("idCheck")}</h2>
          <p className="note">{identityVerifier().enabled ? t("idCheckOn") : t("idCheckOff")}</p>
        </section>

        <p className="q-join"><Link href="/settings">{t("back")}</Link></p>
      </main>
    </>
  );
}
