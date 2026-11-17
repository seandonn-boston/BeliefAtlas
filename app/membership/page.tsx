import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { billingPortalAction, checkoutAction } from "@/app/actions";
import { ErrorBanner, Header } from "@/components/Header";
import { getAccount } from "@/lib/auth";
import { billingMode } from "@/lib/billing";

export const metadata: Metadata = { title: "Membership · BeliefAtlas" };

type Props = { searchParams: Promise<{ error?: string; welcome?: string }> };

export default async function MembershipPage({ searchParams }: Props) {
  const { error, welcome } = await searchParams;
  const [account, t] = await Promise.all([getAccount(), getTranslations("membership")]);
  const member = account?.tier === "paid";

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{member ? t("titleMember") : t("title")}</h1>
        <ErrorBanner message={error} />
        {welcome && (
          <p className="notice" role="status">
            {member ? t("welcomeMember") : t("welcomePending")}
          </p>
        )}
        {!member && <p className="price">{t("price")} <span>{t("priceNote")}</span></p>}
        <ul className="member-list">
          {(["unlimited", "counts", "firmly", "trend", "visibility"] as const).map((k) => <li key={k}>{t(`perks.${k}`)}</li>)}
        </ul>

        {!account ? (
          <p className="q-join">
            {t.rich("joinPrompt", {
              signup: (x) => <Link href="/signup?next=%2Fmembership">{x}</Link>,
              login: (x) => <Link href="/login?next=%2Fmembership">{x}</Link>,
            })}
          </p>
        ) : member ? (
          <form action={billingPortalAction}>
            <input type="hidden" name="back" value="/membership" />
            <button className="btn">{billingMode === "dev" ? t("endDev") : t("manage")}</button>
          </form>
        ) : billingMode === "off" ? (
          <p className="q-hint">{t("soon")}</p>
        ) : (
          <form action={checkoutAction}>
            <input type="hidden" name="back" value="/membership" />
            <button className="btn solid">{billingMode === "dev" ? t("joinDev") : t("join")}</button>
            <p className="field-note">{t("stripeNote")}</p>
          </form>
        )}
      </main>
    </>
  );
}
