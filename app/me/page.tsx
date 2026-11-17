import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Header } from "@/components/Header";
import { getAccount } from "@/lib/auth";
import { beliefMap, type Answer } from "@/lib/map";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("map");
  return { title: `${t("title")} · BeliefAtlas` };
}

type Props = { searchParams: Promise<{ subject?: string }> };

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
  const [map, t, c, cats, format] = await Promise.all([
    beliefMap(account.id, { subject }), getTranslations("map"), getTranslations("common.choices"),
    getTranslations("common.categories"), getFormatter(),
  ]);
  const WORD = (a: Answer) => c(a);
  const label = (slug: string) => (cats.has(slug) ? cats(slug) : slug);
  const current = map.subjects.find((s) => s.category === subject);

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{t("title")}</h1>

        {map.answered === 0 ? (
          <p className="empty">{t.rich("empty", { link: (x) => <Link href="/">{x}</Link> })}</p>
        ) : (
          <>
            <dl className="map-stats">
              <div><dt>{t("answered")}</dt><dd>{format.number(map.answered)}</dd></div>
              <div><dt>{t("withMost")}</dt><dd>{map.comparable ? `${pct(map.withMost, map.comparable)}%` : "–"}</dd></div>
              <div><dt>{t("changedMind")}</dt><dd>{format.number(map.changedMind)}</dd></div>
            </dl>
            <p className="map-legend">
              <span><i className="swatch true" />{c("true")} {format.number(map.counts.true)}</span>
              <span><i className="swatch false" />{c("false")} {format.number(map.counts.false)}</span>
              <span><i className="swatch unsure" />{c("unsure")} {format.number(map.counts.unsure)}</span>
            </p>

            <h2 className="list-title">{t("bySubject")}</h2>
            <ul className="map-subjects">
              {map.subjects.map((s) => (
                <li key={s.category}>
                  <Link href={s.category === subject ? "/me" : `/me?subject=${s.category}`} aria-current={s.category === subject ? "page" : undefined}>
                    <span className="map-subject-name">{label(s.category)}</span>
                    <span className="map-subject-meta">
                      {t("subjectMeta", { n: format.number(s.answered) })}
                      {s.comparable ? ` · ${t("subjectWithMost", { pct: pct(s.withMost, s.comparable) })}` : ""}
                    </span>
                    <Bar counts={s.counts} />
                  </Link>
                </li>
              ))}
            </ul>

            <h2 className="list-title">{current ? t("inSubject", { subject: label(current.category) }) : t("latest")}</h2>
            <ul className="map-entries">
              {map.entries.map((e) => (
                <li key={e.questionId}>
                  <Link href={`/q/${e.questionId}`} className="map-q" lang={e.lang /* W3 */}>{e.text}</Link>
                  <p className="map-place">
                    <span className={`map-chip ${e.value}`}>{WORD(e.value)}</span>
                    {e.sameAsYou === null
                      ? <span>{t("tooFew")}</span>
                      : <span>{t("sameAsYou", { pct: e.sameAsYou, total: format.number(e.total) })}{e.withMost ? t("mostCommon") : ""}</span>}
                    {e.firstValue && e.firstValue !== e.value && <span>{t("firstSaid", { choice: WORD(e.firstValue) })}</span>}
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
