import type { GroupStat, QuestionStats } from "./stats";

// Answer colours. They only ever mean an answer, in charts and in the interface alike
// (the same values live in app/globals.css as --true, --false and --unsure).
export const COLORS = { true: "#2196e8", false: "#dd6f17", unsure: "#6b7480" } as const;

// What a chart shows, described without reference to any charting library. Pages build a
// ChartSpec and hand it to components/Chart.tsx; only the renderer behind that component
// knows which library draws it. Replacing the library (or swapping in an in-house chart
// system) means writing a new renderer, not touching pages or these builders.
export type ChartSeries = {
  name: string;
  color: string;
  values: (number | null)[];   // one per category; null means no data that day
  dashed?: boolean;
};

export type ChartSpec = {
  kind: "line" | "stacked-bar";  // line: a trend over categories; stacked-bar: horizontal bars of shares
  height: number;
  categories: string[];
  series: ChartSeries[];
  axis: { max: number; step: number; suffix: string };   // the value axis, from 0
  labelEvery?: number;           // show every nth category label
  referenceLine?: number;        // a dashed guide on the value axis, e.g. an even split
  endLabels?: boolean;           // name each line at its right-hand end
};

const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// Share answering true / false / unsure on each of the last 14 days.
export function trendChart(history: QuestionStats["history"]): ChartSpec {
  const values = (pick: (h: QuestionStats["history"][number]) => number) =>
    history.map((h) => (h.total > 0 ? pick(h) : null));
  return {
    kind: "line",
    height: 240,
    categories: history.map((h) => dayLabel(h.day)),
    labelEvery: 3,
    axis: { max: 100, step: 25, suffix: "%" },
    referenceLine: 50,
    endLabels: true,   // identity never rests on colour alone
    series: [
      { name: "True", color: COLORS.true, values: values((h) => h.pctTrue) },
      { name: "False", color: COLORS.false, values: values((h) => h.pctFalse) },
      { name: "Don't know", color: COLORS.unsure, values: values((h) => h.pctUnsure), dashed: true },
    ],
  };
}

// The same question, answered with and without a name attached.
export function visibilityChart(pub: NonNullable<GroupStat>, priv: NonNullable<GroupStat>): ChartSpec {
  return {
    kind: "stacked-bar",
    height: 170,
    categories: ["Public", "Private"],
    axis: { max: 100, step: 25, suffix: "%" },
    series: [
      { name: "True", color: COLORS.true, values: [pub.pctTrue, priv.pctTrue] },
      { name: "False", color: COLORS.false, values: [pub.pctFalse, priv.pctFalse] },
      { name: "Don't know", color: COLORS.unsure, values: [pub.pctUnsure, priv.pctUnsure] },
    ],
  };
}
