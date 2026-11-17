import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Header } from "@/components/Header";

export default async function GoodbyePage() {
  const t = await getTranslations("account");
  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{t("goodbyeTitle")}</h1>
        <p>{t("goodbyeBody")}</p>
        <p><Link href="/">{t("backToQuestions")}</Link></p>
      </main>
    </>
  );
}
