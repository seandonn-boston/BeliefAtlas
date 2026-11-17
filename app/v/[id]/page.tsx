import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { tapAction } from "@/app/v/actions";
import { ShareButton, TellOpener } from "@/components/ShareButton";
import { Split } from "@/components/Split";
import { present } from "@/lib/access";
import { getAccount } from "@/lib/auth";
import {
  baseUrl, brandName, cleanPlacement, cleanSurface, confirmationLinks, HOLD_COOKIE, shownToken, voteUrl,
} from "@/lib/front-door";
import { getQuestion, mergedInto } from "@/lib/questions";
import { tallies } from "@/lib/stats";
import { CHOICES, peekHeldVote, type Choice } from "@/lib/vote-engine";
import { myVotes } from "@/lib/votes";
import "../front-door.css";

// The one-tap vote page: where every share link, QR code, ad, email and link-out lands.
//
//   /v/12                    the question, True / False / Don't know, and Skip
//   /v/12?pick=true          the same, with True already highlighted (from an email or ad
//                            button, a QR code on a poster). Opening it never casts the vote:
//                            only a tap does, so scanners and previews can't vote for anyone.
//   /v/12?via=qr&at=poster7  labels where the tap came from
//   /v/12?done=cast          the confirmation after a vote

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ via?: string; at?: string; pick?: string; done?: string; error?: string; popup?: string }>;
};


export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const questionId = Number((await params).id);
  const question = Number.isInteger(questionId) && questionId > 0 ? await getQuestion(questionId) : null;
  if (!question) return { title: brandName() };
  const url = voteUrl(question.id);
  const t = await getTranslations("vote");
  const description = t("metaDescription", { brand: brandName() });
  return {
    metadataBase: new URL(baseUrl()),
    title: `${question.text} | ${brandName()}`,
    description,
    alternates: {
      canonical: url,
      types: { "application/json+oembed": `${baseUrl()}/api/oembed?url=${encodeURIComponent(url)}` },
    },
    openGraph: { type: "website", siteName: brandName(), title: question.text, description, url },
    twitter: { card: "summary_large_image", title: question.text, description },
  };
}

export default async function VotePage({ params, searchParams }: Props) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const questionId = Number(id);
  if (!Number.isInteger(questionId) || questionId <= 0) notFound();
  const question = await getQuestion(questionId);
  if (!question) {
    const original = await mergedInto(questionId);
    if (original) redirect(`/v/${original}`);
    notFound();
  }

  const via = cleanSurface(query.via);
  const at = cleanPlacement(query.at);
  const pick = CHOICES.includes(query.pick as Choice) ? (query.pick as Choice) : null;
  const done = query.done ?? null;
  const [account, t, c] = await Promise.all([getAccount(), getTranslations("vote"), getTranslations("common.choices")]);
  const [mine, tally] = await Promise.all([
    account ? myVotes(account.id, [questionId]) : new Map(),
    tallies([questionId]),
  ]);
  const myVote = mine.get(questionId) ?? null;
  const closed = question.status !== "active";

  // A tap held from before they signed in (or from past the daily limit).
  const holdToken = (await cookies()).get(HOLD_COOKIE)?.value;
  const held = account && holdToken ? await peekHeldVote(holdToken) : null;

  // The split stays hidden until they answer, so the first answer is their own.
  const shown = present(tally.get(questionId)!, { account, voted: Boolean(myVote), closed });
  const showSplit = Boolean(myVote) || closed;
  const links = confirmationLinks(questionId);
  const counted = myVote && (done === "cast" || done === "changed" || done === "same");

  return (
    <main className="fd">
      <p className="fd-brand"><Link href="/">{brandName()}</Link></p>

      {held && (
        <p className="notice" role="status">
          {/* A plain link on purpose: <Link> could prefetch it, and opening it counts the held answer. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          {t.rich("heldAnswer", { link: (x) => <a href="/v/resume">{x}</a> })}
        </p>
      )}

      <article className="fd-card">
        <h1 className="fd-q">{question.text}</h1>

        {counted ? (
          <div className="fd-done" role="status">
            <p className="fd-done-line">
              <span className={`fd-chip ${myVote.value}`}>{c(myVote.value as Choice)}</span>
              {" "}{t("counted", { done: done ?? "cast" })}{" "}
              <Link href={links.accountUrl}>@{account!.username}</Link>
            </p>
            <TellOpener
              origin={new URL(baseUrl()).origin}
              close={query.popup === "1"}
              message={{ questionId, value: myVote.value, handle: account!.username }}
            />
          </div>
        ) : done === "skipped" ? (
          <p className="fd-done-line" role="status">{t("skipped")}</p>
        ) : done === "limit_reached" ? (
          <p className="notice" role="status">
            {t.rich("limitReached", { link: (x) => <Link href="/membership">{x}</Link> })}
          </p>
        ) : query.error ? (
          <p className="error" role="alert">{query.error}</p>
        ) : null}

        {showSplit && <Split shown={shown} reveal={Boolean(counted)} />}

        {!closed && (
          <form action={tapAction} className="fd-vote">
            <input type="hidden" name="questionId" value={questionId} />
            <input type="hidden" name="via" value={via} />
            {at && <input type="hidden" name="at" value={at} />}
            {query.popup === "1" && <input type="hidden" name="popup" value="1" />}
            <input type="hidden" name="shown" value={shownToken(questionId)} />
            {(["true", "false", "unsure"] as const).map((v) => (
              <button
                key={v}
                name="value"
                value={v}
                autoFocus={pick === v}
                aria-pressed={myVote?.value === v}
                className={`fd-btn ${v}${myVote?.value === v ? " mine" : ""}${pick === v && !myVote ? " picked" : ""}`}
              >
                {c(v)}
              </button>
            ))}
            {!myVote && (
              <button name="value" value="skip" autoFocus={pick === "skip"} className={`fd-btn skip${pick === "skip" ? " picked" : ""}`}>
                {c("skip")}
              </button>
            )}
          </form>
        )}
        {closed && <p className="q-hint">{t("closed")}</p>}
        {pick && !myVote && !done && <p className="fd-hint">{t("tapToConfirm", { choice: c(pick) })}</p>}

        <div className="fd-links">
          {myVote && <Link href={links.changeUrl}>{t("change")}</Link>}
          {account && <Link href={links.accountUrl}>{t("account")}</Link>}
          {!account && <span>{t("joinHint")}</span>}
          <ShareButton url={links.shareUrl} text={question.text} className="btn small" />
        </div>
      </article>
    </main>
  );
}
