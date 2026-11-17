// Draws a ChartSpec with Apache ECharts (Apache-2.0, free for commercial use).
// This is the only file that knows about the charting library. An in-house chart system
// can replace it by exporting a renderChart with the same signature.

import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { ChartSpec } from "@/lib/charts";

echarts.use([LineChart, BarChart, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, SVGRenderer]);

// House style for every chart: the page colour, hairline grid, thin marks, text in ink rather
// than series colours. The palette comes from the theme's CSS tokens (app/globals.css), so a
// chart matches OLED or Digital Paper; these are the OLED values, used when no page is present.
export type Palette = { page: string; raise: string; ink: string; dim: string; line: string; grid: string; guide: string };
export const OLED_PALETTE: Palette = {
  page: "#000000", raise: "#0b0c0e", ink: "#eef1f6", dim: "#99a1ae", line: "#23262c", grid: "#16181c", guide: "#3a3f47",
};

function paletteFrom(el: HTMLElement): Palette {
  const css = getComputedStyle(el);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    page: token("--black", OLED_PALETTE.page),
    raise: token("--raise", OLED_PALETTE.raise),
    ink: token("--ink", OLED_PALETTE.ink),
    dim: token("--dim", OLED_PALETTE.dim),
    line: token("--line", OLED_PALETTE.line),
    grid: token("--line-soft", OLED_PALETTE.grid),
    guide: token("--hover-line", OLED_PALETTE.guide),
  };
}

// Series colours arrive in the spec as the OLED answer colours; on another theme they map to
// that theme's answer tokens.
function seriesColor(color: string, el: HTMLElement | null): string {
  if (!el) return color;
  const css = getComputedStyle(el);
  const byOled: Record<string, string> = { "#2196e8": "--true", "#dd6f17": "--false", "#6b7480": "--unsure" };
  const name = byOled[color.toLowerCase()];
  return (name && css.getPropertyValue(name).trim()) || color;
}

export function toOption(spec: ChartSpec, fontFamily: string, p: Palette = OLED_PALETTE, el: HTMLElement | null = null): echarts.EChartsCoreOption {
  const { ink: INK, dim: DIM, line: LINE, grid: GRID, guide: GUIDE } = p;
  const { axis } = spec;
  const fmt = (v: unknown) => (v === null || v === undefined || v === "-" ? "–" : `${v}${axis.suffix}`);

  const valueAxis = {
    type: "value" as const,
    min: 0,
    max: axis.max,
    interval: axis.step,
    axisLabel: { color: DIM, fontSize: 12, formatter: `{value}${axis.suffix}` },
    splitLine: { lineStyle: { color: GRID } },
  };
  const categoryAxis = {
    type: "category" as const,
    data: spec.categories,
    axisLine: { lineStyle: { color: LINE } },
    axisTick: { lineStyle: { color: LINE } },
    axisLabel: { color: DIM, fontSize: 12, interval: spec.labelEvery ? spec.labelEvery - 1 : "auto" },
  };

  const common = {
    backgroundColor: "transparent",
    animation: false,
    textStyle: { fontFamily, color: INK },
    legend: {
      left: 0,
      top: 0,
      icon: "roundRect",
      itemWidth: 12,
      itemHeight: 12,
      itemGap: 18,
      textStyle: { color: INK, fontSize: 13, fontWeight: 500 },
      inactiveColor: GUIDE,
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: p.raise,
      borderColor: GUIDE,
      borderWidth: 1,
      textStyle: { color: INK, fontSize: 13 },
      valueFormatter: fmt,
    },
  };

  if (spec.kind === "line") {
    return {
      ...common,
      grid: { left: 4, right: spec.endLabels ? 60 : 8, top: 40, bottom: 4, outerBoundsMode: "same" },
      tooltip: { ...common.tooltip, axisPointer: { type: "line", lineStyle: { color: GUIDE, width: 1 } } },
      xAxis: { ...categoryAxis, boundaryGap: false },
      yAxis: valueAxis,
      series: spec.series.map((s, i) => ({
        type: "line",
        name: s.name,
        data: s.values,
        color: seriesColor(s.color, el),
        connectNulls: true,
        showSymbol: false,
        lineStyle: { width: 2, type: s.dashed ? [4, 3] : "solid" },
        endLabel: spec.endLabels
          ? { show: true, formatter: s.name, color: INK, fontSize: 12, fontWeight: 600 }
          : undefined,
        emphasis: { focus: "series" },
        markLine:
          i === 0 && spec.referenceLine !== undefined
            ? {
                silent: true,
                symbol: "none",
                label: { show: false },
                lineStyle: { color: GUIDE, type: "dashed", width: 1 },
                data: [{ yAxis: spec.referenceLine }],
              }
            : undefined,
      })),
    };
  }

  // Horizontal stacked bars, first category on top.
  return {
    ...common,
    grid: { left: 4, right: 12, top: 40, bottom: 4, outerBoundsMode: "same" },
    tooltip: { ...common.tooltip, axisPointer: { type: "none" } },
    xAxis: valueAxis,
    yAxis: { ...categoryAxis, inverse: true },
    series: spec.series.map((s) => ({
      type: "bar",
      name: s.name,
      data: s.values,
      color: seriesColor(s.color, el),
      stack: "total",
      barWidth: 22,
      itemStyle: { borderColor: p.page, borderWidth: 2 },   // a 2px gap of surface between fills
      emphasis: { focus: "series" },
    })),
  };
}

// Draw `spec` into `el`, keep it sized to its box, and return a function that removes it.
export function renderChart(el: HTMLElement, spec: ChartSpec): () => void {
  const chart = echarts.init(el, undefined, { renderer: "svg" });
  chart.setOption(toOption(spec, getComputedStyle(el).fontFamily, paletteFrom(el), el));
  const observer = new ResizeObserver(() => chart.resize());
  observer.observe(el);
  return () => {
    observer.disconnect();
    chart.dispose();
  };
}
