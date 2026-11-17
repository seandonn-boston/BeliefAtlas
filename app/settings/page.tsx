import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { billingPortalAction, deleteAccountAction } from "@/app/actions";
import { AboutSection } from "@/app/settings/AboutSection";
import { PrivacySection } from "@/app/settings/PrivacySection";
import { ConfirmFields } from "@/components/ConfirmFields";
import { ErrorBanner, Header } from "@/components/Header";
import { getAccount } from "@/lib/auth";
import { query } from "@/lib/db";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings");
  return { title: `${t("metaTitle")} · BeliefAtlas` };
}

type Props = { searchParams: Promise<{ error?: string; saved?: string; problem?: string }> };

const PROBLEMS = [
  "gpc", "region_closed", "unknown_text", "no_account", "age_range", "country", "unknown_field", "relation", "child_age",
  "not_parent", "too_many",
] as const;

export default async function SettingsPage({ searchParams }: Props) {
  const account = await getAccount();
  if (!account) redirect("/login?next=%2Fsettings");
  const { error, saved, problem } = await searchParams;
  const [t, format] = await Promise.all([getTranslations("settings"), getFormatter()]);
  const [info] = await query<{ created_at: Date; phone_verified_at: Date | null; votes: number; subscription_status: string | null; stripe_customer_id: string | null; has_pin: boolean; has_password: boolean }>(
    `select created_at, phone_verified_at, subscription_status, stripe_customer_id,
            pin_hash is not null as has_pin, password_hash is not null as has_password,
            (select count(*)::int from votes where account_id = a.id) as votes
       from accounts a where id = $1`,
    [account.id],
  );
  const date = (d: Date) => format.dateTime(d, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const problemKey = PROBLEMS.find((p) => p === problem);

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{t("title")}</h1>
        <ErrorBanner message={error} />
        {problemKey && <p className="error" role="alert">{t(`problems.${problemKey}`)}</p>}
        {saved && <p className="notice" role="status">{t("saved", { what: saved })}</p>}
        <dl>
          <div className="settings-row"><dt>{t("rows.username")}</dt><dd>{account.username}</dd></div>
          <div className="settings-row"><dt>{t("rows.security")}</dt><dd><Link href="/settings/security">{t("rows.securityLink")}</Link></dd></div>
          <div className="settings-row"><dt>{t("rows.phone")}</dt><dd>{t("rows.phoneState", { confirmed: info.phone_verified_at ? "yes" : "no" })}</dd></div>
          <div className="settings-row"><dt>{t("rows.joined")}</dt><dd>{date(info.created_at)}</dd></div>
          <div className="settings-row"><dt>{t("rows.currentVotes")}</dt><dd>{format.number(info.votes)}</dd></div>
          <div className="settings-row">
            <dt>{t("rows.membership")}</dt>
            <dd>{account.tier === "paid" ? t("rows.member") : <Link href="/membership">{t("rows.freeJoin")}</Link>}</dd>
          </div>
        </dl>

        {info.stripe_customer_id && (
          <form action={billingPortalAction} className="aside-form">
            <input type="hidden" name="back" value="/settings" />
            <span>{t("billing.note")}</span>
            <button className="link">{t("billing.manage")}</button>
          </form>
        )}

        <PrivacySection accountId={account.id} />
        <AboutSection accountId={account.id} />

        <section className="block">
          <h2>{t("appeals.title")}</h2>
          <p className="note">{t("appeals.body")}</p>
          <p><Link href="/appeals">{t("appeals.link")}</Link></p>
        </section>

        <section className="block">
          <h2>{t("data.title")}</h2>
          <p className="note">{t("data.body")}</p>
          <p><a className="btn" href="/api/me/export" download>{t("data.download")}</a></p>
        </section>

        <section className="block">
          <h2>{t("delete.title")}</h2>
          <p className="note">
            {t.rich("delete.body", { paid: account.tier === "paid" ? "yes" : "no", link: (x) => <Link href="/privacy">{x}</Link> })}
          </p>
          <form action={deleteAccountAction} className="form">
            <label>{t("delete.confirm")}<input name="confirm" autoComplete="off" required /></label>
            <ConfirmFields hasPin={info.has_pin} hasPassword={info.has_password} />
            <button className="btn danger-solid">{t("delete.button")}</button>
          </form>
        </section>
      </main>
    </>
  );
}
