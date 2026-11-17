import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { reportAction, revealAction, visibilityAction } from "@/app/actions";
import { Chart } from "@/components/Chart";
import { ErrorBanner, Header } from "@/components/Header";
import { QuestionCard } from "@/components/QuestionCard";
import { detailLevel, present, type DetailLevel } from "@/lib/access";
import { getAccount } from "@/lib/auth";
import { trendChart, visibilityChart } from "@/lib/charts";
import { query } from "@/lib/db";
import { openMergeNotices, REPORT_REASONS, type MergeNotice } from "@/lib/moderation";
import { localizeQuestion } from "@/lib/i18n/questions";
import { getQuestion, mergedInto } from "@/lib/questions";
import { questionStats, type QuestionStats } from "@/lib/stats";
import { hasRevealed, myVotes } from "@/lib/votes";
import { keepMergedAnswerAction } from "./actions";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; voted?: string; held?: string; reported?: string }>;
};

export default async function QuestionPage({ params, searchParams }: Props) {
  const [{ id }, { error, voted, held, reported }] = await Promise.all([params, searchParams]);
  const questionId = Number(id);
  if (!Number.isInteger(questionId) || questionId <= 0) notFound();
  const question = await getQuestion(questionId);
  if (!question) {
    const original = await mergedInto(questionId);
    if (original) redirect(`/q/${original}`);
    notFound();
  }

  // W3: the question's text in the reader's language when an approved translation exists.
  const [account, t, local] = await Promise.all([getAccount(), getTranslations("question"), localizeQuestion(question)]);
  const [stats, mine, revealed, notices] = await Promise.all([
    questionStats(questionId),
    account ? myVotes(account.id, [questionId]) : new Map(),
    account ? hasRevealed(account.id, questionId) : false,
    account ? openMergeNotices(account.id, questionId) : ([] as MergeNotice[]),
  ]);
  const myVote = mine.get(questionId);
  const aiAnswers = await query<{ model: string; value: string }>(
    "select model, value from ai_answers where question_id = $1 order by answered_at",
    [questionId],
  );
  const back = `/q/${questionId}`;
  const shown = present(stats.tally, {
    account, voted: Boolean(myVote), revealed, closed: question.status !== "active",
  });
  const level = detailLevel(account, Boolean(myVote));

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <ErrorBanner message={error} />
        {held && question.status === "review" && (
          <p className="notice" role="status">{t("held")}</p>
        )}
        {reported && <p className="notice" role="status">{t("reported")}</p>}
        {/* M1: the heads-up after a merge moved their answer here. Only while they still have an answer. */}
        {myVote && notices.map((n) => (
          <section key={n.id} className="notice merge-notice" aria-labelledby={`rephrased-${n.id}`}>
            <p id={`rephrased-${n.id}`}>
              {t("rephrased.body", { old: n.from_text, original: n.original_value, counted: n.counted_value })}
            </p>
            <p className="field-note">{t("rephrased.free")}</p>
            <form action={keepMergedAnswerAction} className="mod-actions">
              <input type="hidden" name="questionId" value={questionId} />
              <input type="hidden" name="noticeId" value={n.id} />
              <button className="btn small">{t("rephrased.keep")}</button>
              <a className="btn small" href="#answer">{t("rephrased.change")}</a>
            </form>
          </section>
        ))}
        <div className="feed feed-detail" id="answer">
          <QuestionCard
            question={local}
            shown={shown}
            myVote={myVote}
            signedIn={Boolean(account)}
            source="direct"
            back={back}
            linkTitle={false}
            reveal={Boolean(voted)}
          />
        </div>

        {account && myVote && (
          <form action={visibilityAction} className="aside-form">
            <input type="hidden" name="questionId" value={questionId} />
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="to" value={myVote.is_private ? "public" : "private"} />
            <span>{t("yourVoteIs", { private: myVote.is_private ? "yes" : "no" })}</span>
            <button className="link">{t("makeIt", { private: myVote.is_private ? "yes" : "no" })}</button>
          </form>
        )}

        {!shown.split && (
          <form action={revealAction} className="aside-form">
            <input type="hidden" name="questionId" value={questionId} />
            <input type="hidden" name="back" value={back} />
            <span>{t("voteFirst")}</span>
            <button className="link">{t("showResults")}</button>
          </form>
        )}

        {/* Only once the split is visible, so an AI's answer can't steer a first vote. */}
        {shown.split && aiAnswers.length > 0 && (
          <p className="ai-note">
            {aiAnswers.map((a) => t("aiAnswered", { model: a.model, value: a.value })).join("; ")}.
            {" "}{t("aiNote")}
          </p>
        )}

        {shown.split && shown.hasVotes && <Details stats={stats} level={level} signedIn={Boolean(account)} back={back} />}

        {account && question.status === "active" && !reported && (
          <details className="report">
            <summary>{t("report.summary")}</summary>
            <form action={reportAction} className="form">
              <input type="hidden" name="questionId" value={questionId} />
              <input type="hidden" name="back" value={back} />
              <fieldset>
                <legend>{t("report.legend")}</legend>
                {REPORT_REASONS.map((r) => (
                  <label key={r.value} className="check"><input type="radio" name="reason" value={r.value} required /> {t(`report.reasons.${r.value}`)}</label>
                ))}
              </fieldset>
              <label>
                {t("report.duplicateOf")} <span className="field-note">{t("report.duplicateOfNote")}</span>
                <input name="duplicateOf" maxLength={300} inputMode="url" />
              </label>
              <label>
                {t("report.note")} <span className="field-note">{t("report.optional")}</span>
                <input name="note" maxLength={500} placeholder={t("report.notePlaceholder")} />
              </label>
              <button className="btn">{t("report.send")}</button>
            </form>
          </details>
        )}
      </main>
    </>
  );
}

// What the page shows grows with the viewer's level (lib/access.ts). Arrival routes and the
// time filters are never shown here; they are API-only.
async function Details({ stats, level, signedIn, back }: { stats: QuestionStats; level: DetailLevel; signedIn: boolean; back: string }) {
  const { churn, visibility, blindFirstVotes, history } = stats;
  const [t, format] = await Promise.all([getTranslations("question.details"), getFormatter()]);

  if (level !== "member") {
    return (
      <>
        {level === "voter" && (
          <section className="block">
            <h2>{t("firmly")}</h2>
            <p className="headline-stat">
              <span className="tile-value">{churn.pctChangedMind}%</span>
              <span>{t("changedMind")}</span>
            </p>
          </section>
        )}
        <section className="block locked">
          <h2>{t("forMembers")}</h2>
          <ul>
            <li>{t("lockedTrend")}</li>
            <li>{t("lockedChurn")}</li>
            <li>{t("lockedVisibility")}</li>
          </ul>
          <p className="note">
            {signedIn
              ? t.rich("joinMember", { link: (c) => <Link href="/membership">{c}</Link> })
              : t.rich("joinVisitor", { link: (c) => <Link href={`/signup?next=${encodeURIComponent(back)}`}>{c}</Link> })}
          </p>
        </section>
      </>
    );
  }

  const count = (n: number) => t("people", { n });
  const tiles = [
    { value: churn.pctChangedOnce, label: t("changedOnce"), sub: count(churn.changedOnce) },
    { value: churn.pctChangedMoreThanOnce, label: t("changedMore"), sub: count(churn.changedMoreThanOnce) },
    { value: churn.pctChangedInLast7Days, label: t("changedWeek"), sub: count(churn.changedInLast7Days) },
    { value: blindFirstVotes.pct, label: t("blind"), sub: count(blindFirstVotes.count) },
  ];
  const days = history.filter((h) => h.total > 0);
  const first = days[0], last = days[days.length - 1];

  return (
    <>
      <section className="block">
        <h2>{t("firmly")}</h2>
        <ul className="tiles">
          {tiles.map((t) => (
            <li key={t.label}>
              <span className="tile-value">{t.value}%</span>
              <span className="tile-label">{t.label}</span>
              <span className="tile-sub">{t.sub}</span>
            </li>
          ))}
        </ul>
        <p className="note">{t("sharesNote")}</p>
      </section>

      <section className="block">
        <h2>{t("last14")}</h2>
        {days.length >= 2 ? (
          <>
            <Chart
              spec={trendChart(history)}
              label={t("trendLabel", { t1: first.pctTrue, d1: first.day, t2: last.pctTrue, d2: last.day, f1: first.pctFalse, f2: last.pctFalse })}
            />
            <p className="note">{t("trendNote", { t1: first.pctTrue, t2: last.pctTrue, f1: first.pctFalse, f2: last.pctFalse })}</p>
          </>
        ) : (
          <p className="note">{t("noHistory")}</p>
        )}
      </section>

      <section className="block">
        <h2>{t("visibility")}</h2>
        {visibility.public && visibility.private ? (
          <>
            <Chart
              spec={visibilityChart(visibility.public, visibility.private)}
              label={t("visibilityLabel", { pt: visibility.public.pctTrue, pf: visibility.public.pctFalse, qt: visibility.private.pctTrue, qf: visibility.private.pctFalse })}
            />
            <p className="note">
              {t("visibilityNote", {
                pt: visibility.public.pctTrue, qt: visibility.private.pctTrue,
                pn: format.number(visibility.public.total), qn: format.number(visibility.private.total),
              })}
            </p>
          </>
        ) : (
          <p className="note">{t("tooFewVisibility")}</p>
        )}
      </section>
    </>
  );
}
