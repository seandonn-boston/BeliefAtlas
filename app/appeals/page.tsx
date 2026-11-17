import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { ErrorBanner, Header } from "@/components/Header";
import { getAccount } from "@/lib/auth";
import { AUTO_REMOVED, myModeration, type Appeal, type AppealSubject } from "@/lib/moderation";
import { appealAction } from "./actions";

type Props = { searchParams: Promise<{ error?: string; sent?: string }> };

// A person's own removed questions, bans and demerits, each with its appeal: the form if they
// haven't appealed it yet, or where the appeal stands.
export default async function AppealsPage({ searchParams }: Props) {
  const [{ error, sent }, account, t, format] = await Promise.all([
    searchParams, getAccount(), getTranslations("appeals"), getFormatter(),
  ]);
  if (!account) {
    return (
      <>
        <Header />
        <main className="wrap wrap-narrow">
          <h1 className="page-title">{t("title")}</h1>
          <p>{t.rich("signIn", { link: (c) => <Link href={`/login?next=${encodeURIComponent("/appeals")}`}>{c}</Link> })}</p>
        </main>
      </>
    );
  }

  const { questions, bans, demerits, appeals } = await myModeration(account.id);
  const when = (d: Date) => format.dateTime(d, { dateStyle: "medium", timeStyle: "short" });
  const appealFor = (subject: AppealSubject, id: number) => appeals.find((a) => a.subject === subject && a.subject_id === id);
  const nothing = !questions.length && !bans.length && !demerits.length;

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{t("title")}</h1>
        <p className="note">{t("intro")}</p>
        <ErrorBanner message={error} />
        {sent && <p className="notice" role="status">{t("sent")}</p>}
        {nothing && <p className="empty">{t("nothing")}</p>}

        {questions.length > 0 && <h2 className="list-title">{t("questions")}</h2>}
        {questions.map((q) => {
          const auto = q.removed_why === AUTO_REMOVED;
          return (
            <section key={q.id} className="mod-item">
              <h3 className="q-text">{q.text}</h3>
              {q.duplicate_of
                ? <p className="mod-why">{t.rich("merged", { id: q.duplicate_of, link: (c) => <Link href={`/q/${q.duplicate_of}`}>{c}</Link> })}</p>
                : <p className="mod-why">{auto ? t("autoWhy") : t("removedWhy", { why: q.removed_why ?? "" })}</p>}
              {(auto || q.removed_fix) && <p className="mod-meta">{auto ? t("autoFix") : t("removedFix", { fix: q.removed_fix ?? "" })}</p>}
              {q.removed_harm && <p className="mod-meta">{t("harm", { kind: q.removed_harm })}</p>}
              <AppealBox subject="question" id={q.id} appeal={appealFor("question", q.id)} />
            </section>
          );
        })}

        {bans.length > 0 && <h2 className="list-title">{t("bans")}</h2>}
        {bans.map((b) => (
          <section key={b.id} className="mod-item">
            <p className="mod-why">
              {b.permanent ? t("banPermanent") : t("banAsking", { date: when(b.ends_at!) })}
            </p>
            {b.lifted_at && <p className="mod-meta">{t("banLifted", { date: when(b.lifted_at) })}</p>}
            {!b.lifted_at && !b.in_force && b.ends_at && <p className="mod-meta">{t("banEnded", { date: when(b.ends_at) })}</p>}
            {(b.in_force || appealFor("ban", b.id)) && <AppealBox subject="ban" id={b.id} appeal={appealFor("ban", b.id)} />}
          </section>
        ))}

        {demerits.length > 0 && <h2 className="list-title">{t("demerits")}</h2>}
        {demerits.map((d) => (
          <section key={d.id} className="mod-item">
            <p className="mod-why">{t("demeritKind", { kind: d.kind ?? "other" })}</p>
            {d.detail && <p className="mod-meta">{t("demeritText", { text: d.detail })}</p>}
            <p className="mod-meta">
              {d.revoked_at ? t("demeritRevoked") : d.active ? t("demerit", { points: d.points, date: when(d.expires_at) }) : t("demeritExpired")}
            </p>
            {(d.active || appealFor("demerit", d.id)) && <AppealBox subject="demerit" id={d.id} appeal={appealFor("demerit", d.id)} />}
          </section>
        ))}
      </main>
    </>
  );
}

async function AppealBox({ subject, id, appeal }: { subject: AppealSubject; id: number; appeal?: Appeal }) {
  const t = await getTranslations("appeals");
  if (appeal) {
    return (
      <div className="notice">
        <p>{t(`status.${appeal.status}`)}</p>
        <p className="mod-meta">{t("yourAppeal", { body: appeal.body })}</p>
        {appeal.outcome_note && <p>{t("note", { note: appeal.outcome_note })}</p>}
      </div>
    );
  }
  return (
    <form action={appealAction} className="form">
      <input type="hidden" name="subject" value={subject} />
      <input type="hidden" name="subjectId" value={id} />
      <label>
        {t("why")} <span className="field-note">{t("once")}</span>
        <textarea name="body" required maxLength={2000} rows={3} />
      </label>
      <button className="btn small">{t("send")}</button>
    </form>
  );
}
