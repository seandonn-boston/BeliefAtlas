// The chart specs render through the chart library without a browser (server-side SVG),
// so a broken spec or a library upgrade that drops an option fails here, not on the page.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as echarts from "echarts/core";
import { toOption } from "../components/charts/renderer";
import { trendChart, visibilityChart } from "../lib/charts";

function renderSvg(spec: ReturnType<typeof trendChart>): string {
  const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 600, height: spec.height });
  chart.setOption(toOption(spec, "sans-serif"));
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg;
}

test("trend chart draws three named lines, an even-split guide and day labels", () => {
  const history = Array.from({ length: 14 }, (_, i) => ({
    day: `2026-11-${String(i + 1).padStart(2, "0")}`,
    total: i === 3 ? 0 : 40 + i,
    pctTrue: 50 + i,
    pctFalse: 40 - i,
    pctUnsure: 10,
  }));
  const spec = trendChart(history as Parameters<typeof trendChart>[0]);
  assert.equal(spec.series[0].values[3], null, "a day with no votes is a gap, not a zero");

  const svg = renderSvg(spec);
  assert.match(svg, /^<svg/);
  for (const name of ["True", "False"]) assert.ok(svg.includes(`>${name}<`), `${name} is labelled`);
  assert.match(svg, />Don(&#39;|&apos;|')t know</, "Don't know is labelled");
  assert.ok(svg.includes("Nov 1"), "category labels are drawn");
  assert.ok(svg.includes("100%"), "the value axis carries its suffix");
  assert.ok(svg.includes("stroke-dasharray"), "the reference line and the unsure series are dashed");
});

test("visibility chart draws public and private as stacked bars", () => {
  const group = (t: number, f: number) => ({ total: 100, pctTrue: t, pctFalse: f, pctUnsure: 100 - t - f });
  const spec = visibilityChart(
    group(60, 30) as Parameters<typeof visibilityChart>[0],
    group(45, 50) as Parameters<typeof visibilityChart>[1],
  );
  const svg = renderSvg(spec);
  assert.ok(svg.includes(">Public<") && svg.includes(">Private<"));
  assert.ok(svg.includes("#2196e8") && svg.includes("#dd6f17"), "answer colours are used");
});
