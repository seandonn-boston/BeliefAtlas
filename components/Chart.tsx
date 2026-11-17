"use client";

import { useEffect, useRef } from "react";
import type { ChartSpec } from "@/lib/charts";

type Props = { spec: ChartSpec; label: string };

// The one place pages draw a chart. It takes a library-neutral ChartSpec and hands it to the
// renderer in components/charts/renderer.ts, loaded only in the browser. To replace the
// charting library, write a new renderer with the same renderChart signature.
export function Chart({ spec, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const key = JSON.stringify(spec);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    import("./charts/renderer").then(({ renderChart }) => {
      if (cancelled || !ref.current) return;
      dispose = renderChart(ref.current, JSON.parse(key) as ChartSpec);
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [key]);

  return <div ref={ref} className="chart" style={{ height: spec.height }} role="img" aria-label={label} />;
}
