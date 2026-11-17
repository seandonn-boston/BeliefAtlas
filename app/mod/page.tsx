import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ErrorBanner, Header } from "@/components/Header";
import { getAccount } from "@/lib/auth";
import { CATEGORIES } from "@/lib/categories";
import {
  aiEnabled, AUTO_REMOVED, duplicatesQueue, HARM_KINDS, MERGE_RULE, openAppeals, openSignals, queue, rulesOfKind,
  type OpenAppeal, type OpenSignal, type QueueItem, type SuspectPair, type SuspectSide,
} from "@/lib/moderation";
import {
  aiReviewAction, decideAppealAction, duplicateAction, moderateAction, reviewSignalAction, scanSignalsAction,
} from "./actions";

type Props = { searchParams: Promise<{ error?: string; done?: string; id?: string; n?: string; banned?: string }> };

// The moderator view: held and reported questions, suspected duplicates (M1), appeals, and
// manipulation signals. It shows the question, its report count and reasons, and how many votes
// it has, never the true/false split, so no decision leans on which way people answered.
export default async function ModerationPage({ searchParams }: Props) {
  const account = await getAccount();
  if (!account || account.role === "user") notFound();
  const { error, done, id, n, banned } = await searchParams;
  const [items, pairs, appeals, signals, t, compliance] = await Promise.all([
    queue(), duplicatesQueue(), openAppeals(), openSignals(), getTranslations("mod"), getTranslations("compliance"),
  ]);

  const doneKeys = ["question", "appeal", "signal", "scan", "ai", "duplicate", "suggested"];
  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{t("title")}</h1>
        <p className="note">{t("intro")}</p>
        <p className="note"><Link href="/mod/compliance">{compliance("link")}</Link></p>
        <ErrorBanner message={error} />
        {done && doneKeys.includes(done) && (
          <p className="notice" role="status">
            {t(`done.${done}`, { id: id ?? "", n: Number(n ?? 0) })}
            {done === "signal" && banned !== undefined && <> {t("done.banned", { n: Number(banned) })}</>}
          </p>
        )}

        <h2 className="list-title" id="questions">{t("sections.questions")}</h2>
        {items.length === 0 && <p className="empty">{t("empty.questions")}</p>}
        {items.map((item) => <QuestionItem key={item.id} item={item} />)}

        <h2 className="list-title" id="duplicates">{t("sections.duplicates")}</h2>
        {pairs.length === 0 && <p className="empty">{t("empty.duplicates")}</p>}
        {pairs.map((pair) => <DuplicateItem key={pair.id} pair={pair} />)}

        <h2 className="list-title" id="appeals">{t("sections.appeals")}</h2>
        {appeals.length === 0 && <p className="empty">{t("empty.appeals")}</p>}
        {appeals.map((appeal) => <AppealItem key={appeal.id} appeal={appeal} />)}

        <h2 className="list-title" id="signals">{t("sections.signals")}</h2>
        <form action={scanSignalsAction} className="mod-actions">
          <button className="btn small">{t("signals.scan")}</button>
        </form>
        {signals.length === 0 && <p className="empty">{t("empty.signals")}</p>}
        {signals.map((signal) => <SignalItem key={signal.id} signal={signal} />)}
      </main>
    </>
  );
}

async function QuestionItem({ item }: { item: QueueItem }) {
  const [t, common] = await Promise.all([getTranslations("mod"), getTranslations("common")]);
  const subject = (slug: string) => (common.has(`categories.${slug}`) ? common(`categories.${slug}`) : slug);
  const review = item.ai_review ? (JSON.parse(item.ai_review) as Record<string, unknown>) : null;
  return (
    <section className="mod-item">
      <p className="mod-meta">
        #{item.id} · {item.status === "review" ? t("item.held") : t("item.live")} · {subject(item.category)}
        {" · "}{t("item.votes", { n: item.votes })} · {t("item.reports", { n: item.open_reports })}
        {" · "}{item.asked_by_user ? t("item.byUser") : t("item.catalog")}
        {item.approved_at && <>{" · "}{t("item.approvedBefore")}</>}
      </p>
      <h3 className="q-text"><Link href={`/q/${item.id}`}>{item.text}</Link></h3>
      {item.held_reason && <p className="mod-why">{item.held_reason}</p>}
      {item.reasons && (
        <ul className="mod-reports">
          {Object.entries(item.reasons).map(([reason, count]) => (
            <li key={reason}>{t("item.reasonCount", { n: count, reason: t.has(`reasons.${reason}`) ? t(`reasons.${reason}`) : reason })}</li>
          ))}
        </ul>
      )}
      {item.notes?.map((note, i) => <blockquote key={i} className="mod-note">{note}</blockquote>)}
      {review && (
        <p className="mod-note">
          {t("item.aiReview", {
            answerable: String(review.answerable), private_person: String(review.private_person),
            harassing_or_hateful: String(review.harassing_or_hateful),
          })}
        </p>
      )}

      <form action={moderateAction} className="mod-actions">
        <input type="hidden" name="questionId" value={item.id} />
        <button name="action" value="approve" className="btn small">{item.status === "review" ? t("actions.approve") : t("actions.keep")}</button>
        <button name="action" value="archive" className="btn small">{t("actions.archive")}</button>
      </form>

      <details>
        <summary>{t("actions.remove")}</summary>
        <form action={moderateAction} className="form">
          <input type="hidden" name="questionId" value={item.id} />
          <input type="hidden" name="action" value="remove" />
          <label>
            {t("actions.removeWhy")} <span className="field-note">{t("actions.removeWhyNote")}</span>
            <textarea name="why" required maxLength={1000} rows={2} />
          </label>
          <label>
            {t("actions.removeFix")} <span className="field-note">{t("actions.removeFixNote")}</span>
            <textarea name="fix" required maxLength={1000} rows={2} />
          </label>
          <fieldset>
            <legend>{t("actions.harm")}</legend>
            <label className="check"><input type="radio" name="harm" value="" defaultChecked /> {t("actions.harmNone")}</label>
            {HARM_KINDS.map((kind) => (
              <label key={kind} className="check"><input type="radio" name="harm" value={kind} /> {t(`harm.${kind}`)}</label>
            ))}
          </fieldset>
          <label>
            {t("actions.rule")}
            <select name="rule" defaultValue="">
              <option value="">{t("actions.ruleFromHarm")}</option>
              {rulesOfKind("deny").map((r) => <option key={r.id} value={r.id}>{t(`rulebook.${r.id}`)}</option>)}
            </select>
          </label>
          <button className="btn small">{t("actions.remove")}</button>
        </form>
      </details>

      {/* M1: duplicates are decided side by side in the duplicates queue, not merged from here. */}
      <form action={moderateAction} className="mod-actions">
        <input type="hidden" name="questionId" value={item.id} />
        <input type="hidden" name="action" value="suggest_duplicate" />
        <input name="of" inputMode="numeric" placeholder={t("actions.original")} aria-label={t("actions.originalLabel")} required />
        <button className="btn small">{t("actions.suggestDuplicate")}</button>
      </form>
      <p className="field-note">{t("actions.suggestDuplicateNote")}</p>

      <form action={moderateAction} className="mod-actions">
        <input type="hidden" name="questionId" value={item.id} />
        <input type="hidden" name="action" value="category" />
        <select name="category" defaultValue={item.category} aria-label={t("actions.subject")}>
          {CATEGORIES.map((c) => <option key={c.slug} value={c.slug}>{subject(c.slug)}</option>)}
        </select>
        <button className="btn small">{t("actions.changeSubject")}</button>
      </form>

      {aiEnabled() && (
        <form action={aiReviewAction} className="mod-actions">
          <input type="hidden" name="questionId" value={item.id} />
          <button className="btn small">{t("actions.aiReview")}</button>
        </form>
      )}
    </section>
  );
}

// M1: a suspected duplicate pair, side by side, with the owner's test next to the buttons.
async function DuplicateItem({ pair }: { pair: SuspectPair }) {
  const [t, format] = await Promise.all([getTranslations("mod"), getFormatter()]);
  const side = (q: SuspectSide, older: boolean) => (
    <div className="dup-side">
      <p className="mod-meta">
        {t("duplicates.side", { id: q.id, status: q.status, votes: q.votes, byUser: q.asked_by_user ? "yes" : "no" })}
        {" · "}{format.dateTime(new Date(q.created_at), { dateStyle: "medium" })}
      </p>
      <h3 className="q-text"><Link href={`/q/${q.id}`}>{q.text}</Link></h3>
      <label className="check">
        <input type="radio" name="keep" value={q.id} defaultChecked={older} /> {t("duplicates.keepThis")}
      </label>
    </div>
  );
  return (
    <section className="mod-item">
      <p className="mod-meta">
        {t("duplicates.meta", { id: pair.id, source: pair.source, times: pair.times_suggested })}
        {pair.similarity !== null && <>{" · "}{t("duplicates.similarity", { pct: Math.round(pair.similarity * 100) })}</>}
      </p>
      <form action={duplicateAction} className="form">
        <input type="hidden" name="pairId" value={pair.id} />
        <fieldset className="dup-pair">
          <legend>{t("duplicates.keep")}</legend>
          {side(pair.a, true)}
          {side(pair.b, false)}
        </fieldset>
        <div className="dup-guidance">
          <p><strong>{t("duplicates.guidanceTitle")}</strong></p>
          <ul>
            <li>{t("duplicates.guidanceInverted")}</li>
            <li>{t("duplicates.guidanceSame")}</li>
            <li>{t("duplicates.guidanceApart")}</li>
          </ul>
          <p className="field-note">{t("duplicates.guidanceAfter")}</p>
          <p className="field-note">{t("actions.mergeRule", { rule: MERGE_RULE, explain: t(`rules.${MERGE_RULE}`) })}</p>
        </div>
        <div className="mod-actions">
          <button name="action" value="dismiss" className="btn small">{t("duplicates.dismiss")}</button>
          <button name="action" value="merge" className="btn small">{t("duplicates.merge")}</button>
          <button name="action" value="merge_inverted" className="btn small">{t("duplicates.mergeInverted")}</button>
        </div>
      </form>
    </section>
  );
}

async function AppealItem({ appeal }: { appeal: OpenAppeal }) {
  const [t, format] = await Promise.all([getTranslations("mod"), getFormatter()]);
  const when = (d: Date) => format.dateTime(d, { dateStyle: "medium", timeStyle: "short" });
  const auto = appeal.removed_why === AUTO_REMOVED;
  return (
    <section className="mod-item">
      <p className="mod-meta">{t("appeals.about", { id: appeal.id, subject: appeal.subject, subjectId: appeal.subject_id })}</p>
      {appeal.question_text && <h3 className="q-text">{appeal.question_text}</h3>}
      {auto && <p className="mod-why">{t("appeals.autoRemoved")}</p>}
      {!auto && appeal.removed_why && <p className="mod-why">{t("appeals.removedWhy", { why: appeal.removed_why })}</p>}
      {appeal.removed_fix && <p className="mod-meta">{t("appeals.removedFix", { fix: appeal.removed_fix })}</p>}
      {appeal.harm && <p className="mod-meta">{t("appeals.harm", { kind: t.has(`harmShort.${appeal.harm}`) ? t(`harmShort.${appeal.harm}`) : appeal.harm })}</p>}
      {appeal.subject === "ban" && (
        <p className="mod-meta">
          {appeal.ban_permanent || !appeal.ban_ends_at ? t("appeals.banPermanent") : t("appeals.banUntil", { date: when(appeal.ban_ends_at) })}
          {appeal.ban_reason && <> · {t("appeals.banReason", { reason: appeal.ban_reason })}</>}
        </p>
      )}
      {appeal.demerit_reason && <p className="mod-meta">{t("appeals.demeritReason", { reason: appeal.demerit_reason })}</p>}
      <p className="mod-meta">{t("appeals.theirWords")}</p>
      <blockquote className="mod-note">{appeal.body}</blockquote>

      <form action={decideAppealAction} className="form">
        <input type="hidden" name="appealId" value={appeal.id} />
        <label>
          {t("appeals.note")} <span className="field-note">{t("appeals.noteHelp")}</span>
          <textarea name="note" required maxLength={2000} rows={2} />
        </label>
        <p className="field-note">{t("appeals.overturnHelp")}</p>
        <div className="mod-actions">
          <button name="outcome" value="upheld" className="btn small">{t("appeals.uphold")}</button>
          <button name="outcome" value="overturned" className="btn small">{t("appeals.overturn")}</button>
        </div>
      </form>
    </section>
  );
}

async function SignalItem({ signal }: { signal: OpenSignal }) {
  const t = await getTranslations("mod");
  return (
    <section className="mod-item">
      <p className="mod-meta">
        #{signal.id} · {t.has(`signals.kinds.${signal.kind}`) ? t(`signals.kinds.${signal.kind}`) : signal.kind}
        {signal.votes !== null && <> · {t("signals.votes", { n: signal.votes })}</>}
      </p>
      {signal.question_id && (
        <h3 className="q-text">
          <Link href={`/q/${signal.question_id}`}>{t("signals.question", { id: signal.question_id, text: signal.question_text ?? "" })}</Link>
        </h3>
      )}
      <p className="mod-why">
        {t("signals.summary", { n: signal.accounts, days: signal.new_account_days, minutes: signal.window_minutes })}
      </p>
      <form action={reviewSignalAction} className="form">
        <input type="hidden" name="signalId" value={signal.id} />
        <fieldset>
          <legend>{t("signals.accounts")}</legend>
          {signal.account_ids.map((accountId) => (
            <label key={accountId} className="check">
              <input type="checkbox" name="ban" value={accountId} defaultChecked /> {t("signals.account", { id: accountId })}
            </label>
          ))}
        </fieldset>
        <p className="field-note">{t("signals.accountsHelp")}</p>
        <div className="mod-actions">
          <button name="outcome" value="confirmed" className="btn small">{t("signals.confirm")}</button>
          <button name="outcome" value="dismissed" className="btn small">{t("signals.dismiss")}</button>
        </div>
      </form>
    </section>
  );
}
