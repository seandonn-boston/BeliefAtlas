import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Header } from "@/components/Header";
import { getAccount } from "@/lib/auth";
import { beliefMap, type Answer } from "@/lib/map";

export const metadata: Metadata = { title: "Your map · BeliefAtlas" };

type Props = { searchParams: Promise<{ subject?: string }> };

const WORD: Record<Answer, string> = { true: "True", false: "False", unsure: "Don't know" };
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

function Bar({ counts }: { counts: Record<Answer, number> }) {
  const total = counts.true + counts.false + counts.unsure;
  return (
    <div className="split-bar map-bar" aria-hidden="true">
      {(["true", "false", "unsure"] as const).map((k) =>
        counts[k] ? <span key={k} className={`seg ${k}`} style={{ flexGrow: counts[k] / total }} /> : null,
      )}
    </div>
  );
}

// Your belief map: what you've answered, by subject, and where you sit against everyone else.
export default async function MapPage({ searchParams }: Props) {
  const account = await getAccount();
  if (!account) redirect("/login?next=%2Fme");
  const { subject } = await searchParams;
  const map = await beliefMap(account.id, { subject });
  const current = map.subjects.find((s) => s.category === subject);

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">Your map</h1>

        {map.answered === 0 ? (
          <p className="empty">
            Nothing here yet. <Link href="/">Answer a few questions</Link> and your map fills in: what you believe, by
            subject, and where you stand against everyone else.
          </p>
        ) : (
          <>
            <dl className="map-stats">
              <div><dt>Answered</dt><dd>{map.answered.toLocaleString("en-US")}</dd></div>
              <div><dt>With most people</dt><dd>{map.comparable ? `${pct(map.withMost, map.comparable)}%` : "–"}</dd></div>
              <div><dt>Changed your mind</dt><dd>{map.changedMind.toLocaleString("en-US")}</dd></div>
            </dl>
            <p className="map-legend">
              <span><i className="swatch true" />True {map.counts.true}</span>
              <span><i className="swatch false" />False {map.counts.false}</span>
              <span><i className="swatch unsure" />Don&apos;t know {map.counts.unsure}</span>
            </p>

            <h2 className="list-title">By subject</h2>
            <ul className="map-subjects">
              {map.subjects.map((s) => (
                <li key={s.category}>
                  <Link href={s.category === subject ? "/me" : `/me?subject=${s.category}`} aria-current={s.category === subject ? "page" : undefined}>
                    <span className="map-subject-name">{s.label}</span>
                    <span className="map-subject-meta">
                      {s.answered} answered{s.comparable ? ` · with most people on ${pct(s.withMost, s.comparable)}%` : ""}
                    </span>
                    <Bar counts={s.counts} />
                  </Link>
                </li>
              ))}
            </ul>

            <h2 className="list-title">{current ? `Your answers in ${current.label}` : "Your answers, latest first"}</h2>
            <ul className="map-entries">
              {map.entries.map((e) => (
                <li key={e.questionId}>
                  <Link href={`/q/${e.questionId}`} className="map-q">{e.text}</Link>
                  <p className="map-place">
                    <span className={`map-chip ${e.value}`}>{WORD[e.value]}</span>
                    {e.sameAsYou === null
                      ? <span>Too few answers yet to compare</span>
                      : <span>{e.sameAsYou}% of {e.total.toLocaleString("en-US")} said the same{e.withMost ? ", the most common answer" : ""}</span>}
                    {e.firstValue && e.firstValue !== e.value && <span>First said {WORD[e.firstValue]}</span>}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </>
  );
}
