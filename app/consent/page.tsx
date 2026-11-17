import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { consentAction } from "@/app/consent/actions";
import { Header } from "@/components/Header";
import { getAccount } from "@/lib/auth";
import { safeNext } from "@/lib/consent/context";
import { consentUrl, peekHold } from "@/lib/consent/gate";
import { CONSENT_DRAFT, currentText, hasAnsweringConsent, saleOffer, type ConsentText } from "@/lib/consent/ledger";
import { requestContext } from "@/lib/consent/request";
import { HOLD_COOKIE } from "@/lib/front-door";

// /consent: the one-time agreement before any answer counts. Every surface sends a first tap
// here (the tap is held meanwhile); browsing never needs it. Two separate choices: answering
// (the "I agree" button) and sale (an unticked box, offered only where sale is possible and
// never with Global Privacy Control on).

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("consent");
  return { title: `${t("metaTitle")} · BeliefAtlas`, robots: { index: false } };
}

type Props = { searchParams: Promise<{ next?: string; via?: string; error?: string }> };

const ERRORS = ["textChanged", "missingText"] as const;

function Body({ text }: { text: ConsentText }) {
  return (
    <div lang={text.lang}>
      {text.body.split(/\n\s*\n/).map((p, i) => <p key={i}>{p}</p>)}
    </div>
  );
}

export default async function ConsentPage({ searchParams }: Props) {
  const { next: rawNext, via, error } = await searchParams;
  const next = safeNext(rawNext);
  const holdToken = (await cookies()).get(HOLD_COOKIE)?.value;
  const account = await getAccount();
  if (!account) {
    // A held tap comes back here through /v/resume once they have an account.
    redirect(holdToken ? `/signup?next=${encodeURIComponent("/v/resume")}` : `/login?next=${encodeURIComponent(consentUrl(next))}`);
  }
  if (await hasAnsweringConsent(account.id)) redirect(holdToken ? "/v/resume" : next);

  const held = holdToken ? await peekHold(holdToken) : null;
  const surface = held?.surface ?? via ?? "web";
  const ctx = await requestContext(surface);
  const [t, c, answering, sale, offer] = await Promise.all([
    getTranslations("consent"),
    getTranslations("common.choices"),
    currentText("answering", ctx.lang),
    currentText("sale", ctx.lang),
    saleOffer(account.id, ctx),
  ]);
  const notNow = held ? `/v/${held.questionId}` : next.startsWith("/v/resume") ? "/" : next;
  const errorKey = ERRORS.find((e) => e === error) ?? (answering ? null : "missingText");

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{t("title")}</h1>
        {(CONSENT_DRAFT || answering?.draft) && <p className="notice" role="note">{t("draft")}</p>}
        {errorKey && <p className="error" role="alert">{t(`errors.${errorKey}`)}</p>}
        {held && (
          <p className="notice" role="status">
            {t("held", { choice: c(held.value) })}{held.isPrivate ? ` ${t("heldPrivate")}` : ""}
          </p>
        )}
        <p>{t("intro")}</p>
        <ul>
          <li>{t("points.kept")}</li>
          <li>{t("points.private")}</li>
          <li>{t("points.sale")}</li>
        </ul>

        {answering && (
          <form action={consentAction} className="form">
            <input type="hidden" name="next" value={next} />
            <input type="hidden" name="via" value={surface} />
            <input type="hidden" name="answeringVersion" value={answering.version} />
            <input type="hidden" name="answeringLang" value={answering.lang} />

            <section className="block">
              <h2>{t("answeringHeading")}</h2>
              <Body text={answering} />
              <p className="field-note">{t("version", { version: answering.version })}</p>
            </section>

            <section className="block">
              <h2>{t("saleHeading")}</h2>
              {offer.offer && sale ? (
                <>
                  <input type="hidden" name="saleVersion" value={sale.version} />
                  <input type="hidden" name="saleLang" value={sale.lang} />
                  <Body text={sale} />
                  <p className="field-note">{t("version", { version: sale.version })}</p>
                  {/* Unticked by default and never required: "I agree" works without it. */}
                  <label className="check"><input type="checkbox" name="sale" /> {t("saleCheckbox")}</label>
                </>
              ) : (
                <p className="note">{offer.offer ? t("saleClosed") : t(offer.reason === "gpc" ? "saleGpc" : "saleClosed")}</p>
              )}
            </section>

            <button className="btn solid">{t("agree")}</button>
          </form>
        )}

        <p className="q-join"><Link href={notNow}>{t("notNow")}</Link> · {t("notNowNote")}</p>
        <p className="note">{t.rich("settingsNote", { link: (x) => <Link href="/settings">{x}</Link> })}</p>
      </main>
    </>
  );
}
