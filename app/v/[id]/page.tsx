import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
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
import { CHOICE_LABELS, CHOICES, peekHeldVote, type Choice } from "@/lib/vote-engine";
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
  const description = `True or false? Answer in one tap on ${brandName()}.`;
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
  const account = await getAccount();
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
          You have a held answer. <a href="/v/resume">Count it now</a>.
        </p>
      )}

      <article className="fd-card">
        <h1 className="fd-q">{question.text}</h1>

        {counted ? (
          <div className="fd-done" role="status">
            <p className="fd-done-line">
              <span className={`fd-chip ${myVote.value}`}>{CHOICE_LABELS[myVote.value as Choice]}</span>
              {done === "same" ? " was already counted for " : done === "changed" ? " is your new answer, counted for " : " counted for "}
              <Link href={links.accountUrl}>@{account!.username}</Link>
            </p>
            <TellOpener
              origin={new URL(baseUrl()).origin}
              close={query.popup === "1"}
              message={{ questionId, value: myVote.value, handle: account!.username }}
            />
          </div>
        ) : done === "skipped" ? (
          <p className="fd-done-line" role="status">Skipped. Nothing was counted, and it may come back around another day.</p>
        ) : done === "limit_reached" ? (
          <p className="notice" role="status">
            You&apos;ve used today&apos;s votes. Your answer is held for 24 hours:{" "}
            <Link href="/membership">become a member</Link> and it counts straight away, or come back tomorrow.
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
                {CHOICE_LABELS[v]}
              </button>
            ))}
            {!myVote && (
              <button name="value" value="skip" autoFocus={pick === "skip"} className={`fd-btn skip${pick === "skip" ? " picked" : ""}`}>
                Skip
              </button>
            )}
          </form>
        )}
        {closed && <p className="q-hint">This question no longer takes new votes.</p>}
        {pick && !myVote && !done && <p className="fd-hint">Tap {CHOICE_LABELS[pick]} to confirm.</p>}

        <div className="fd-links">
          {myVote && <Link href={links.changeUrl}>Change your vote</Link>}
          {account && <Link href={links.accountUrl}>Your account</Link>}
          {!account && <span>Tap an answer, then make an account in a few seconds and it counts.</span>}
          <ShareButton url={links.shareUrl} text={question.text} className="btn small" />
        </div>
      </article>
    </main>
  );
}
