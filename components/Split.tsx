import { useFormatter, useTranslations } from "next-intl";
import type { Shown } from "@/lib/access";

// The true/false split: two figures and a bar. Per-answer counts and the total appear only
// when `shown` carries them (see lib/access.ts).
export function Split({ shown, reveal = false }: { shown: Shown; reveal?: boolean }) {
  const t = useTranslations("question");
  const c = useTranslations("common.choices");
  const format = useFormatter();
  const { split, sides, count } = shown;
  if (!split) return null;
  if (!shown.hasVotes) return <p className="q-hint">{t("noVotes")}</p>;

  const n = (x: number) => format.number(x);
  const segments = (["true", "false", "unsure"] as const).filter((k) => split[k] > 0);
  return (
    <div className={`split${reveal ? " split-reveal" : ""}`}>
      <div className="split-figures">
        <p className="fig">
          <span className="fig-pct">{split.true}%</span>
          <span className="fig-label"><i className="swatch true" />{c("true")}{sides && <em>{n(sides.true)}</em>}</span>
        </p>
        <p className="fig fig-right">
          <span className="fig-pct">{split.false}%</span>
          <span className="fig-label"><i className="swatch false" />{c("false")}{sides && <em>{n(sides.false)}</em>}</span>
        </p>
      </div>
      <div className="split-bar" role="img" aria-label={t("splitLabel", { t: split.true, f: split.false, u: split.unsure })}>
        {segments.map((k) => <span key={k} className={`seg ${k}`} style={{ flexGrow: split[k] }} />)}
      </div>
      <p className="split-foot">
        <span><i className="swatch unsure" />{c("unsure")} {split.unsure}%{sides && <em>{n(sides.unsure)}</em>}</span>
        {count && <span>{t("count", { kind: count.kind, n: count.kind === "exact" ? count.n : 0, e: count.kind === "exact" ? "" : count.e })}</span>}
      </p>
    </div>
  );
}
