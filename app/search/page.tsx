import { getTranslations } from "next-intl/server";
import { DidYouMean } from "@/components/DidYouMean";
import { ErrorBanner, Header } from "@/components/Header";
import { checkQuestion } from "@/lib/checks";
import { QuestionCard } from "@/components/QuestionCard";
import { present } from "@/lib/access";
import { getAccount } from "@/lib/auth";
import { normalize, search, tidy } from "@/lib/questions";
import { tallies } from "@/lib/stats";
import { myVotes } from "@/lib/votes";

type Props = { searchParams: Promise<{ q?: string; error?: string; keep?: string; edit?: string }> };

export default async function SearchPage({ searchParams }: Props) {
  const { q = "", error, keep, edit } = await searchParams;
  const text = q.trim().slice(0, 200);
  const [account, t] = await Promise.all([getAccount(), getTranslations("ask")]);
  const view = "compact"; // a short list of matches to scan
  const matches = text ? await search(text) : [];
  const ids = matches.map((m) => m.id);
  const [tally, mine] = await Promise.all([tallies(ids), account ? myVotes(account.id, ids) : new Map()]);

  // There is no "new question" button anywhere. Asking is only offered here, after a search
  // that didn't turn up the same question.
  const alreadyAsked = matches.some((m) => normalize(m.text) === normalize(tidy(text)));
  const checked = checkQuestion(text);
  const back = `/search?q=${encodeURIComponent(text)}`;

  return (
    <>
      <Header q={text} focus={edit === "1"} />
      <main className={`wrap wrap-${view}`}>
        <ErrorBanner message={error} />

        {text && !alreadyAsked && (
          <DidYouMean checked={checked} signedIn={Boolean(account)} dismissed={keep === "1"} hasMatches={matches.length > 0} back={back} />
        )}

        {text && <h1 className="list-title">{matches.length ? t("matches") : t("noMatches")}</h1>}
        <div className={`feed feed-${view}`}>
          {matches.map((m) => (
            <QuestionCard
              key={m.id}
              question={m}
              shown={present(tally.get(m.id)!, { account, voted: mine.has(m.id), closed: m.status !== "active" })}
              myVote={mine.get(m.id)}
              signedIn={Boolean(account)}
              source="search"
              back={back}
            />
          ))}
        </div>
      </main>
    </>
  );
}
