import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Header } from "@/components/Header";
import { getAccount } from "@/lib/auth";
import { orgAccountsEnabled } from "@/lib/headless/config";
import { myOrgs, type OrgError } from "@/lib/headless/orgs";
import { createOrgAction } from "./actions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("org");
  return { title: `${t("metaTitle")} · BeliefAtlas` };
}

type Props = { searchParams: Promise<{ error?: string }> };

// The organizations a person belongs to, and a form to start one. Switched off (404) until
// HEADLESS_ORG_ACCOUNTS_ENABLED is on.
export default async function OrgsPage({ searchParams }: Props) {
  if (!orgAccountsEnabled()) notFound();
  const account = await getAccount();
  if (!account) redirect("/login?next=%2Forg");
  const [{ error }, orgs, t] = await Promise.all([searchParams, myOrgs(account.id), getTranslations("org")]);
  const errorKey = error && t.has(`errors.${error as OrgError}`) ? error : null;

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{t("title")}</h1>
        <p className="note">{t("intro")}</p>
        <p className="note">{t("notice")}</p>
        {errorKey && <p className="error" role="alert">{t(`errors.${errorKey as OrgError}`)}</p>}
        {orgs.length === 0 && <p className="empty">{t("none")}</p>}
        <ul>
          {orgs.map((o) => (
            <li key={o.id}><Link href={`/org/${o.slug}`}>{o.name}</Link> · {t("role", { role: o.role })}</li>
          ))}
        </ul>

        <section className="block">
          <h2>{t("create.title")}</h2>
          <p className="note">{t("create.note")}</p>
          <form action={createOrgAction} className="form">
            <label>{t("create.name")}<input name="name" required maxLength={120} /></label>
            <label>{t("create.slug")}<input name="slug" required pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]" /></label>
            <label>{t("create.country")}<input name="country" required pattern="[A-Za-z]{2}" maxLength={2} /></label>
            <button className="btn">{t("create.button")}</button>
          </form>
        </section>
      </main>
    </>
  );
}
