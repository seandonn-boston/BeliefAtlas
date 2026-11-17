// The small-slice guard for aggregate breakdowns (by source, by visibility, by age range, by
// country, ...). A slice smaller than the minimum group size (lib/regions.ts minGroupSize) could
// point at a handful of people, so it is never shown.
//
// Hiding one small slice isn't enough when the total is published too: total minus the visible
// slices gives the hidden one back. So when what's hidden adds up to fewer than the minimum,
// the next smallest visible slices are hidden as well (complementary suppression) until the
// hidden remainder is at least the minimum or nothing is left to show. With `merge`, the hidden
// slices come back as one "other" slice when together they are big enough.

export type SliceOptions<T> = {
  merge?: (size: number, hidden: T[]) => T;   // build an "other" slice from the hidden ones
  complementary?: boolean;                     // default true; false only when no total is shown anywhere
};

export function hideSmallSlices<T>(slices: T[], size: (slice: T) => number, min: number, opts: SliceOptions<T> = {}): T[] {
  const complementary = opts.complementary ?? true;
  const hidden = new Set<T>(slices.filter((s) => size(s) < min));
  const hiddenTotal = () => [...hidden].reduce((n, s) => n + size(s), 0);

  if (complementary) {
    const visible = slices.filter((s) => !hidden.has(s)).sort((a, b) => size(a) - size(b));
    while (hiddenTotal() > 0 && hiddenTotal() < min && visible.length) hidden.add(visible.shift()!);
  }

  const shown = slices.filter((s) => !hidden.has(s));
  const rest = hiddenTotal();
  if (opts.merge && hidden.size && rest >= min) shown.push(opts.merge(rest, slices.filter((s) => hidden.has(s))));
  return shown;
}

// For a breakdown into named groups that already hide themselves below the minimum (null), like
// public versus private: if any group has some people but fewer than the minimum, hide them all,
// since the others and the total would give the small one back. An empty group reveals nothing.
export function hideAllIfAnySmall<K extends string, T>(
  groups: Record<K, T | null>, sizes: Record<K, number>, min: number,
): Record<K, T | null> {
  const keys = Object.keys(groups) as K[];
  if (!keys.some((k) => sizes[k] > 0 && sizes[k] < min)) return groups;
  return Object.fromEntries(keys.map((k) => [k, null])) as Record<K, T | null>;
}
