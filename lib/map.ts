import { CATEGORIES } from "./categories";
import { query } from "./db";
import { localizeQuestions } from "./i18n/questions";
import { MIN_GROUP_SIZE } from "./limits";

// A person's belief map: everything they've answered, grouped by subject, and where they sit
// against everyone else on each question. Private votes are included, since this is their own
// view. Removed questions are left out (they're off the map for everyone).

export type Answer = "true" | "false" | "unsure";

export type MapEntry = {
  questionId: number;
  text: string;
  lang: string;   // W3: the language `text` is in (the reader's, when an approved translation exists)
  category: string;
  value: Answer;
  firstValue: Answer | null;
  changes: number;
  answeredAt: Date;
  total: number;
  // Share of everyone who answered the same as you, in percent. Null below the minimum group
  // size, so a handful of voters can't be read off.
  sameAsYou: number | null;
  // True when your answer is the most common one; null when too few have answered or there's
  // no single most common answer.
  withMost: boolean | null;
};

export type SubjectSummary = {
  category: string;
  label: string;
  answered: number;
  counts: Record<Answer, number>;
  comparable: number;   // answered questions with enough voters to compare
  withMost: number;     // of those, how many you answered like most people
};

export type BeliefMap = {
  answered: number;
  counts: Record<Answer, number>;
  changedMind: number;   // questions where your current answer differs from your first
  comparable: number;
  withMost: number;
  includesSample: boolean; // some comparison counts sample answers (fictional launch votes)
  subjects: SubjectSummary[];
  entries: MapEntry[];
};

type Row = {
  question_id: number; text: string; lang: string; category: string; value: Answer; first_value: Answer | null;
  change_count: number; first_cast_at: Date; true_count: number; false_count: number; unsure_count: number;
  sample_count: number;
};

export function placeOf(value: Answer, counts: Record<Answer, number>) {
  const total = counts.true + counts.false + counts.unsure;
  if (total < MIN_GROUP_SIZE) return { total, sameAsYou: null, withMost: null };
  const top = Math.max(counts.true, counts.false, counts.unsure);
  const leaders = (Object.keys(counts) as Answer[]).filter((k) => counts[k] === top);
  return {
    total,
    sameAsYou: Math.round((counts[value] / total) * 100),
    withMost: leaders.length === 1 ? leaders[0] === value : null,
  };
}

const labelOf = (slug: string) => CATEGORIES.find((c) => c.slug === slug)?.label ?? "General";

// `opts.locale` (W3): the reader's language for the entries' text; defaults to this request's.
export async function beliefMap(
  accountId: number, opts: { subject?: string; limit?: number; locale?: string } = {},
): Promise<BeliefMap> {
  const rows = await query<Row>(
    `select v.question_id, q.text, q.lang, q.category, v.value, v.first_value, v.change_count, v.first_cast_at,
            q.true_count, q.false_count, q.unsure_count, q.sample_count
       from votes v join questions q on q.id = v.question_id
      where v.account_id = $1 and q.status <> 'removed'
      order by v.updated_at desc, v.question_id desc`,
    [accountId],
  );

  const empty = (): Record<Answer, number> => ({ true: 0, false: 0, unsure: 0 });
  const map: BeliefMap = { answered: 0, counts: empty(), changedMind: 0, comparable: 0, withMost: 0, includesSample: false, subjects: [], entries: [] };
  const bySubject = new Map<string, SubjectSummary>();
  const limit = opts.limit ?? 100;

  for (const r of rows) {
    const place = placeOf(r.value, { true: r.true_count, false: r.false_count, unsure: r.unsure_count });
    map.answered++;
    map.counts[r.value]++;
    if (r.first_value && r.first_value !== r.value) map.changedMind++;
    if (place.withMost !== null) {
      map.comparable++;
      if (place.withMost) map.withMost++;
      if (r.sample_count > 0) map.includesSample = true;
    }
    const s = bySubject.get(r.category) ?? {
      category: r.category, label: labelOf(r.category), answered: 0, counts: empty(), comparable: 0, withMost: 0,
    };
    s.answered++;
    s.counts[r.value]++;
    if (place.withMost !== null) {
      s.comparable++;
      if (place.withMost) s.withMost++;
    }
    bySubject.set(r.category, s);
    if ((!opts.subject || opts.subject === r.category) && map.entries.length < limit) {
      map.entries.push({
        questionId: r.question_id, text: r.text, lang: r.lang, category: r.category, value: r.value, firstValue: r.first_value,
        changes: r.change_count, answeredAt: r.first_cast_at, ...place,
      });
    }
  }
  // W3: only the entries shown are put into the reader's language (one query).
  const shown = await localizeQuestions(map.entries.map((e) => ({ id: e.questionId, text: e.text, lang: e.lang })), opts.locale);
  map.entries = map.entries.map((e, i) => ({ ...e, text: shown[i].text, lang: shown[i].lang }));
  map.subjects = [...bySubject.values()].sort((a, b) => b.answered - a.answered || a.label.localeCompare(b.label));
  return map;
}
