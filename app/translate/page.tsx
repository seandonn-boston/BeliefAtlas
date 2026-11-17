import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ErrorBanner, Header } from "@/components/Header";
import { getAccount } from "@/lib/auth";
import { direction, type Locale } from "@/lib/i18n/locales";
import { machineTranslationEnabled } from "@/lib/i18n/machine";
import { MAX_TRANSLATION_LENGTH, reviewLanguages, reviewQueue, type QueueTab, type ReviewError } from "@/lib/i18n/review";
import { translateAction } from "./actions";
import "./translate.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("translate");
  return { title: `${t("title")} · BeliefAtlas`, robots: { index: false } };
}

type Props = {
  searchParams: Promise<{ lang?: string; tab?: string; page?: string; done?: string; id?: string; error?: string }>;
};

const DONE = ["save", "approve", "reject", "withdraw"] as const;
const ERRORS: ReviewError[] = ["forbidden", "not_found", "empty", "too_long", "same_language", "already_approved", "nothing_to_review"];

// The translation review queue, for moderators, admins and translators. Pick a language, see the
// live questions with no approved translation into it, write or edit a draft, and approve or
// reject. Only approved translations are shown to readers.
export default async function TranslatePage({ searchParams }: Props) {
  const account = await getAccount();
  const langs = await reviewLanguages(account);
  if (!account || langs.length === 0) notFound();

  const params = await searchParams;
  const [ui, t, format] = await Promise.all([getLocale(), getTranslations("translate"), getFormatter()]);
  // Default to a language other than English when there is one: most of the catalog is English.
  const lang: Locale = langs.find((l) => l === params.lang)
    ?? langs.find((l) => l === ui && l !== "en") ?? langs.find((l) => l !== "en") ?? langs[0];
  const tab: QueueTab = params.tab === "approved" ? "approved" : "todo";
  const page = Math.max(0, Math.floor(Number(params.page) || 0));
  const queue = await reviewQueue(lang, tab, page);

  const names = new Intl.DisplayNames([ui], { type: "language" });
  const languageName = (code: string) => names.of(code) ?? code;
  const href = (over: Record<string, string | number>) => {
    const p = new URLSearchParams({ lang, tab });
    for (const [k, v] of Object.entries(over)) p.set(k, String(v));
    if (p.get("page") === "0") p.delete("page");
    return `/translate?${p}`;
  };
  const done = DONE.find((d) => d === params.done);
  const error = ERRORS.find((e) => e === params.error);

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{t("title")}</h1>
        <p className="note">{t("intro")}</p>

        <nav className="cats tr-nav" aria-label={t("languages")}>
          <div className="cats-in">
            {langs.map((l) => (
              <Link key={l} href={`/translate?lang=${l}&tab=${tab}`} aria-current={l === lang ? "page" : undefined} lang={ui}>
                {languageName(l)}
              </Link>
            ))}
          </div>
        </nav>
        <nav className="cats tr-nav" aria-label={t("title")}>
          <div className="cats-in">
            <Link href={`/translate?lang=${lang}`} aria-current={tab === "todo" ? "page" : undefined}>{t("tabs.todo")}</Link>
            <Link href={`/translate?lang=${lang}&tab=approved`} aria-current={tab === "approved" ? "page" : undefined}>{t("tabs.approved")}</Link>
          </div>
        </nav>
        <p className="note">
          {t("draftsWaiting", { n: queue.drafts })} · {t(machineTranslationEnabled() ? "machine.on" : "machine.off")}
        </p>

        <ErrorBanner message={error ? t(`errors.${error}`) : undefined} />
        {done && <p className="notice" role="status">{t(`done.${done}`, { id: params.id ?? "" })}</p>}
        {queue.items.length === 0 && <p className="empty">{t(`empty.${tab}`)}</p>}

        {queue.items.map((item) => {
          const tr = item.translation;
          return (
            <section key={item.id} id={`q${item.id}`} className="mod-item">
              <p className="mod-meta">
                {t("meta", { id: item.id, language: languageName(item.lang), n: item.votes })}
                {" · "}<span className={`tr-status ${tr?.status ?? "none"}`}>{t(`status.${tr?.status ?? "none"}`)}</span>
              </p>
              <h2 className="q-text" lang={item.lang} dir={direction(item.lang)}>
                <Link href={`/q/${item.id}`}>{item.text}</Link>
              </h2>
              {tr && (
                <p className="mod-why">
                  {tr.source === "machine" ? t("machineDraft") : tr.draftedBy ? t("draftedBy", { name: tr.draftedBy }) : null}
                  {tr.reviewedBy && <>{tr.source === "machine" || tr.draftedBy ? " · " : ""}{t("reviewedBy", { name: tr.reviewedBy })}</>}
                  {" · "}{format.dateTime(tr.at, { dateStyle: "medium" })}
                </p>
              )}

              <form action={translateAction} className="form tr-form">
                <input type="hidden" name="questionId" value={item.id} />
                <input type="hidden" name="lang" value={lang} />
                <input type="hidden" name="tab" value={tab} />
                <input type="hidden" name="page" value={page} />
                <label>
                  {t("field", { language: languageName(lang) })}
                  <textarea
                    name="text"
                    lang={lang}
                    dir={direction(lang)}
                    rows={2}
                    maxLength={MAX_TRANSLATION_LENGTH}
                    defaultValue={tr?.text ?? ""}
                    readOnly={tr?.status === "approved"}
                    required
                  />
                </label>
                <div className="mod-actions">
                  {tr?.status === "approved" ? (
                    <button name="act" value="withdraw" className="btn small" formNoValidate>{t("actions.withdraw")}</button>
                  ) : (
                    <>
                      <button name="act" value="approve" className="btn solid small">{t("actions.approve")}</button>
                      <button name="act" value="save" className="btn small">{t("actions.save")}</button>
                      {tr?.status === "draft" && (
                        <button name="act" value="reject" className="btn small" formNoValidate>{t("actions.reject")}</button>
                      )}
                    </>
                  )}
                </div>
                {tr?.status !== "approved" && <p className="note">{t("approveNote")}</p>}
              </form>
            </section>
          );
        })}

        {(page > 0 || queue.more) && (
          <nav className="tr-pages">
            {page > 0 ? <Link href={href({ page: page - 1 })}>{t("previous")}</Link> : <span />}
            {queue.more && <Link href={href({ page: page + 1 })}>{t("next")}</Link>}
          </nav>
        )}
      </main>
    </>
  );
}
