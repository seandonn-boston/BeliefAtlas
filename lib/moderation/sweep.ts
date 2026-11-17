import { applyFixes, checkQuestion, tidyQuestion } from "../checks";
import type { CheckResult } from "../checks";
import type { CategorySlug } from "../categories";
import type { Match } from "../questions";
import {
  ACCUSATIONS, DEGRADING, DEHUMANISING, DEHUMANISING_STRONG, GROUP, loose, MY_RELATION, NEGATIVE, SELF_OPENERS, SLURS,
  SPAM_PATTERNS, SWEARS, VIOLENCE, VIOLENT_ACT,
} from "./lexicon";
import { categoryFrom, modelVerdict, unknownNames } from "./screen";

// The few-second sweep when a question is asked. Rules first (free, instant, no service);
// with AI_ENABLED=true and a key, the model in ./screen.ts adds its view on top, within a time
// budget. Three outcomes:
//   allow  - goes live;
//   hold   - posted but kept out of feeds until a moderator looks;
//   deny   - not posted. Every denial says why, where and gives a fix (a CheckResult).
// Only harmful denials (hateful, harassing, targeting a private person, spam) carry a penalty:
// a demerit (./demerits.ts). Swearing or a question only the asker could answer just needs
// rewording and costs nothing.

export const HARM_KINDS = ["hateful", "harassing", "private_person", "spam"] as const;
export type HarmKind = (typeof HARM_KINDS)[number];
export const isHarmKind = (v: unknown): v is HarmKind => HARM_KINDS.includes(v as HarmKind);

export type SweepDecision = "allow" | "hold" | "deny";
export type Sweep = {
  decision: SweepDecision;
  results: CheckResult[];      // what to change, for a denial; empty otherwise
  harm: HarmKind | null;       // set only for a harmful denial
  hold: string | null;         // why it is held, for the moderator (English, stored on the question)
  suggestion: string | null;   // the whole question with every fix applied
  duplicateOf?: number;        // the model found the same question in other words
  category: CategorySlug;
};

type Found = { start: number; end: number; value: string };
function findAll(text: string, source: string, flags = "giu"): Found[] {
  const re = new RegExp(source, flags.includes("g") ? flags : flags + "g");
  return [...text.matchAll(re)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, value: m[0] }));
}
const any = (words: string[]) => words.map((w) => loose(w, w.endsWith("s") ? "" : "s?")).join("|");

const harmResult = (code: CheckResult["code"], key: string, at: Found | null, reason: string, values?: Record<string, string>): CheckResult => ({
  code, blocking: true, key, reason, values,
  span: at ? { start: at.start, end: at.end } : null,
  fix: at ? "" : null,
});

// ---------- Harm ----------

function hateful(text: string): { results: CheckResult[]; hold: string | null } {
  const results: CheckResult[] = [];
  for (const slur of SLURS) {
    for (const m of findAll(text, loose(slur.word, slur.suffix ?? ""))) {
      results.push(harmResult("hateful", "hateful_slur", m,
        `"${m.value}" is a slur. Questions can't use slurs; if the question is about a group of people, call them by their own name.`,
        { word: m.value }));
    }
  }
  const outright = [
    `${GROUP}\\s+(?:are|is|were)\\s+(?:all\\s+|just\\s+|nothing\\s+but\\s+|simply\\s+|really\\s+)?${DEHUMANISING}(?![\\p{L}])`,
    `(?<![\\p{L}])(?:are|is|were)\\s+(?:all\\s+|most\\s+)?${GROUP}\\s+(?:just\\s+|really\\s+|nothing\\s+but\\s+)?${DEHUMANISING}(?![\\p{L}])`,
  ];
  for (const source of outright) {
    for (const m of findAll(text, source)) {
      results.push(harmResult("hateful", "hateful_dehumanising", m,
        "Questions can't call a group of people vermin, animals or less than human. Ask about a specific claim or policy instead.",
        { where: m.value }));
    }
  }
  const violence = [
    `${GROUP}\\s+should\\s+(?:all\\s+)?${VIOLENCE}(?![\\p{L}])`,
    `(?<![\\p{L}])should\\s+(?:all\\s+)?${GROUP}\\s+${VIOLENCE}(?![\\p{L}])`,
    `(?<![\\p{L}])should\\s+(?:we|people|everyone|someone|they|the\\s+government)\\s+${VIOLENT_ACT}\\s+(?:all\\s+)?${GROUP}(?![\\p{L}])`,
  ];
  for (const source of violence) {
    for (const m of findAll(text, source)) {
      results.push(harmResult("hateful", "hateful_violence", m,
        "Questions can't call for violence against a group of people.", { where: m.value }));
    }
  }
  if (results.length) return { results, hold: null };

  // Not outright, but a person should look.
  const nearStrong = new RegExp(`${GROUP}[^?.!]{0,60}?${DEHUMANISING_STRONG}|${DEHUMANISING_STRONG}[^?.!]{0,60}?${GROUP}`, "iu");
  const sweeping = [
    `${GROUP}\\s+(?:are|is|were)\\s+(?:all\\s+|just\\s+|naturally\\s+|inherently\\s+|more\\s+)?${NEGATIVE}(?![\\p{L}])`,
    `(?<![\\p{L}])(?:are|is|were)\\s+(?:all\\s+|most\\s+)?${GROUP}\\s+(?:just\\s+|naturally\\s+|inherently\\s+|more\\s+)?${NEGATIVE}(?![\\p{L}])`,
  ];
  if (nearStrong.test(text) || sweeping.some((s) => new RegExp(s, "iu").test(text))) {
    return { results, hold: "May be hateful: a sweeping claim about a group of people" };
  }
  return { results, hold: null };
}

function spam(text: string): CheckResult[] {
  const out: CheckResult[] = [];
  for (const pattern of SPAM_PATTERNS) {
    for (const m of findAll(text, pattern.source, pattern.flags)) {
      out.push(harmResult("spam", "spam", m,
        "This reads as advertising. Questions are for claims people can answer true or false, not for promoting anything.",
        { where: m.value }));
    }
  }
  return out;
}

// ---------- Ordinary ----------

function swearing(text: string): CheckResult[] {
  const out: CheckResult[] = [];
  for (const swear of SWEARS) {
    for (const m of findAll(text, loose(swear.word, swear.suffix ?? ""))) {
      if (out.some((r) => r.span && r.span.start < m.end && m.start < r.span.end)) continue;
      const fix = swear.fix(m.value);
      out.push({
        code: "obscene", blocking: true, span: { start: m.start, end: m.end }, fix,
        key: fix ? "obscene_fix" : "obscene", values: fix ? { word: m.value, fix } : { word: m.value },
        reason: fix
          ? `Questions can't swear. Try "${fix}" instead of "${m.value}".`
          : `Questions can't swear. Take out "${m.value}"; the question works without it.`,
      });
    }
  }
  return out;
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");
function tooSpecific(text: string): CheckResult[] {
  const out: CheckResult[] = [];
  for (const m of text.matchAll(MY_RELATION)) {
    const relation = m[2];
    const plural = /s$/i.test(relation) && !/^(boss|ex)$/i.test(relation);
    const fix = plural ? relation : `${article(relation)} ${relation}`;
    out.push({
      code: "too_specific", blocking: true, span: { start: m.index!, end: m.index! + m[0].length }, fix,
      key: "too_specific_relation", values: { where: m[0], fix },
      reason: `Only you know "${m[0]}", so nobody else can answer this. Ask it about ${fix} in general.`,
    });
  }
  const opener = text.match(/^(\S+\s+i)(?=\s)/i);
  const general = opener ? SELF_OPENERS[opener[1].toLowerCase()] : undefined;
  if (opener && general) {
    out.push({
      code: "too_specific", blocking: true, span: { start: 0, end: opener[1].length }, fix: general,
      key: "too_specific_self", values: { where: opener[1], fix: general },
      reason: `"${opener[1]}" asks about you, and only you can answer that. Ask it about people in general: "${general} ...".`,
    });
    // "my", "me" and "myself" follow the asker into the general version.
    for (const w of text.slice(opener[1].length).matchAll(/(?<![\p{L}])(my|me|myself|mine)(?![\p{L}])/giu)) {
      const start = opener[1].length + w.index!;
      if (out.some((r) => r.span && r.span.start <= start && start < r.span.end)) continue;
      const to = { my: "their", me: "them", myself: "themselves", mine: "theirs" }[w[1].toLowerCase()]!;
      out.push({
        code: "too_specific", blocking: true, span: { start, end: start + w[1].length }, fix: to,
        key: "too_specific_self", values: { where: w[1], fix: to },
        reason: `"${w[1]}" asks about you; for everyone it becomes "${to}".`,
      });
    }
  }
  return out;
}

// ---------- Names and personal details ----------

const ACCUSATION = new RegExp(any(ACCUSATIONS), "iu");
const DEGRADE = new RegExp(any(DEGRADING), "iu");

// The rules alone, with no database and no model: what a test or a preview can run.
export function classify(raw: string): { results: CheckResult[]; harm: HarmKind | null; hold: string | null } {
  const text = raw.replace(/\s+/g, " ").trim();
  const hate = hateful(text);
  if (hate.results.length) return { results: hate.results, harm: "hateful", hold: null };
  const promo = spam(text);
  if (promo.length) return { results: promo, harm: "spam", hold: null };

  // A personal detail with an accusation is aimed at someone real: harmful. A personal detail
  // alone is an ordinary fix, and lib/checks already blocks it.
  const personal = checkQuestion(text).results.filter((r) => r.code === "personal_data");
  if (personal.length && ACCUSATION.test(text)) {
    return {
      harm: "private_person", hold: null,
      results: personal.map((p) => ({
        ...p, code: "private_person" as const, key: "private_person", values: { where: text.slice(p.span!.start, p.span!.end) },
        reason: "This points at a private person and accuses them of something. Questions can't target private people; ask about the behaviour in general.",
      })),
    };
  }

  const ordinary = [...personal, ...swearing(text), ...tooSpecific(text)];
  if (ordinary.length) return { results: ordinary, harm: null, hold: hate.hold };
  return { results: [], harm: null, hold: hate.hold };
}

// Turn rule results into a sweep, with the whole-question suggestion.
function deny(text: string, results: CheckResult[], harm: HarmKind | null, category: CategorySlug): Sweep {
  results.sort((a, b) => (a.span?.start ?? -1) - (b.span?.start ?? -1));
  const fixed = tidyQuestion(applyFixes(text, results));
  // A harmful question has no rewrite that keeps its point; offer one only for ordinary fixes.
  const suggestion = harm || fixed === tidyQuestion(text) || fixed.length < 12 ? null : fixed;
  return { decision: "deny", results, harm, hold: null, suggestion, category };
}

export const SWEEP_BUDGET_MS = Number(process.env.SWEEP_BUDGET_MS ?? 4000);

export async function sweep(raw: string, matches: Match[] = []): Promise<Sweep> {
  const text = raw.replace(/\s+/g, " ").trim();
  const category = categoryFrom(matches);
  const ruled = classify(text);
  if (ruled.results.length) return deny(text, ruled.results, ruled.harm, category);

  // Names not known to be public. With a degrading insult: harassing, denied. With another
  // insult or accusation, or alone: held for a moderator.
  const names = await unknownNames(text);
  if (names.length && DEGRADE.test(text)) {
    const results = names.flatMap((name) => {
      const at = text.indexOf(name);
      return at < 0 ? [] : [harmResult("harassing", "harassing", { start: at, end: at + name.length, value: name },
        `This insults ${name}, who may be a private person. Questions can't insult or demean people.`, { name })];
    });
    return deny(text, results, "harassing", category);
  }
  let hold = ruled.hold;
  if (!hold && names.length) {
    hold = ACCUSATION.test(text)
      ? `May accuse a private person: ${names.join(", ")}`
      : `May name a private person: ${names.join(", ")}`;
  }

  // The model, when it is switched on, within the budget. Rules have already run.
  const verdict = await modelVerdict(text, matches, SWEEP_BUDGET_MS);
  if (verdict) {
    const duplicate = matches.find((m) => m.id === verdict.duplicate_of);
    const cat = verdict.category ?? category;
    if (duplicate) return { decision: "deny", results: [], harm: null, hold: null, suggestion: null, duplicateOf: duplicate.id, category: cat };
    if (!hold && verdict.harassing_or_hateful) hold = "Flagged as possibly harassing or hateful";
    if (!hold && verdict.names_private_person) hold = "Flagged as possibly naming a private person";
    return { decision: hold ? "hold" : "allow", results: [], harm: null, hold, suggestion: null, category: cat };
  }
  return { decision: hold ? "hold" : "allow", results: [], harm: null, hold, suggestion: null, category };
}
