import Link from "next/link";
import type { FormEvent } from "react";
import { useTranslations } from "next-intl";
import { deleteVoteAction, skipAction, voteAction } from "@/app/actions";
import type { Shown } from "@/lib/access";
import type { MyVote, Source } from "@/lib/votes";
import { ApprovedMark } from "./ApprovedMark";
import { Split } from "./Split";

type Props = {
  // lang: W3, the language `text` is in. approved: M1, the "moderator approved" mark.
  question: { id: number; text: string; status: string; lang?: string; approved?: boolean };
  shown: Shown;
  myVote?: MyVote | null;
  signedIn: boolean;
  source: Source;
  back: string;          // path to return to after an action
  linkTitle?: boolean;
  reveal?: boolean;      // animate the split in: this is the question just voted on
  // Set by LiveCard in feeds, where votes are saved in place. Without it the forms submit
  // normally and the page reloads, which is also what happens when scripts are off.
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  busy?: boolean;
  error?: string | null;
};

export function QuestionCard({
  question, shown, myVote, signedIn, source, back, linkTitle = true, reveal, onSubmit, busy, error,
}: Props) {
  const t = useTranslations("question");
  const c = useTranslations("common.choices");
  const common = useTranslations("common");
  const closed = question.status !== "active";
  const canVote = signedIn && !(closed && !myVote);
  const answer = (value: "true" | "false" | "unsure", kind: string) => (
    <button name="value" value={value} data-act={value} disabled={busy}
      className={`btn ${kind} ${value}${myVote?.value === value ? " mine" : ""}`}
      aria-pressed={myVote?.value === value}>{c(value)}</button>
  );

  return (
    <article className={`q${myVote ? " is-voted" : ""}`}>
      <h2 className="q-text" lang={question.lang}>
        {linkTitle ? <Link href={`/q/${question.id}`}>{question.text}</Link> : question.text}
        {question.approved && <ApprovedMark label={t("approved.label")} hint={t("approved.hint")} />}
      </h2>

      {shown.split ? (
        <Split shown={shown} reveal={reveal} />
      ) : (
        <p className="q-hint">
          {shown.count
            ? `${t("countSoFar", { kind: shown.count.kind, n: shown.count.kind === "exact" ? shown.count.n : 0, e: shown.count.kind === "exact" ? "" : shown.count.e })} `
            : ""}
          {t("voteToSee")}
        </p>
      )}

      {canVote && (
        <form action={voteAction} onSubmit={onSubmit} className="vote">
          <input type="hidden" name="questionId" value={question.id} />
          <input type="hidden" name="source" value={source} />
          <input type="hidden" name="back" value={back} />
          <div className="vote-main">
            {answer("true", "answer")}
            {answer("false", "answer")}
          </div>
          <div className="vote-side">
            {answer("unsure", "quiet")}
            {myVote ? (
              <button formAction={deleteVoteAction} data-act="delete" disabled={busy} className="btn quiet">{t("delete")}</button>
            ) : (
              <button formAction={skipAction} data-act="skip" disabled={busy} className="btn quiet">{c("skip")}</button>
            )}
          </div>
          {error && <p className="q-error" role="alert">{error}</p>}
          {myVote ? (
            <p className="vote-note">{t("voted", { value: myVote.value, private: myVote.is_private ? "yes" : "no" })}</p>
          ) : (
            <label className="vote-private"><input type="checkbox" name="private" /> {t("votePrivately")}</label>
          )}
        </form>
      )}

      {question.status === "archived" && <p className="q-hint">{t("archived")}</p>}
      {question.status === "review" && (
        <p className="q-hint">{t("inReview")}</p>
      )}
      {!signedIn && (
        <p className="q-join">
          {common.rich("createAccountTo", { what: "vote", link: (x) => <Link href={`/signup?next=${encodeURIComponent(back)}`}>{x}</Link> })}
        </p>
      )}
    </article>
  );
}
