import type { CheckedQuestion, CheckResult } from "./types";
import { applyFixes, checkQuestion, tidyQuestion } from "./index";

// Grammar from a self-hosted LanguageTool server (https://languagetool.org, free and open
// source). Only when LANGUAGETOOL_URL is set; with it unset the rule checks in ./index.ts are
// all there is. No hosted service and no API key: point it at your own server, e.g.
//   docker run -p 8010:8010 erikvl87/languagetool   ->   LANGUAGETOOL_URL=http://localhost:8010
// Grammar never blocks: every finding is a suggestion the asker can ignore, and a slow or
// broken server returns nothing rather than holding up the page.

export const GRAMMAR_TIMEOUT_MS = 2500;

type LtMatch = {
  message: string;
  shortMessage?: string;
  offset: number;
  length: number;
  replacements?: { value: string }[];
  rule?: { id?: string; issueType?: string; category?: { id?: string } };
};

export function grammarEnabled(): boolean {
  return Boolean(process.env.LANGUAGETOOL_URL);
}

// LanguageTool's own language codes for the interface languages we have.
const LT_LANG: Record<string, string> = { en: "en-US", es: "es" };

export async function grammarCheck(
  text: string,
  options: { lang?: string; url?: string; fetchImpl?: typeof fetch } = {},
): Promise<CheckResult[]> {
  const base = options.url ?? process.env.LANGUAGETOOL_URL;
  if (!base || !text.trim()) return [];
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const body = new URLSearchParams({ text, language: LT_LANG[options.lang ?? "en"] ?? "auto" });
    const response = await doFetch(`${base.replace(/\/+$/, "")}/v2/check`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(GRAMMAR_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const data = (await response.json()) as { matches?: LtMatch[] };
    return (data.matches ?? [])
      .filter((m) => Number.isInteger(m.offset) && m.length > 0 && m.offset + m.length <= text.length)
      .map((m): CheckResult => {
        const fix = m.replacements?.[0]?.value ?? null;
        const where = text.slice(m.offset, m.offset + m.length);
        const message = (m.shortMessage || m.message || "").trim() || "This may not be grammatical.";
        return {
          code: "grammar",
          blocking: false,
          span: { start: m.offset, end: m.offset + m.length },
          fix,
          key: fix === null ? "grammar" : "grammar_fix",
          values: fix === null ? { message, where } : { message, where, fix },
          reason: fix === null ? `${message} ("${where}")` : `${message} ("${where}" → "${fix}")`,
        };
      });
  } catch (err) {
    console.error("grammar check unavailable", (err as Error).message);
    return [];
  }
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

// The rule checks plus grammar, as one result. Grammar findings that land on something a rule
// already marked are dropped, so a word is never flagged twice.
export async function checkQuestionWithGrammar(
  raw: string,
  options: { lang?: string; url?: string; fetchImpl?: typeof fetch } = {},
): Promise<CheckedQuestion> {
  const checked = checkQuestion(raw);
  if (!(options.url ?? process.env.LANGUAGETOOL_URL)) return checked;
  const grammar = (await grammarCheck(checked.text, options)).filter(
    (g) => !checked.results.some((r) => r.span && g.span && overlaps(r.span, g.span)),
  );
  if (!grammar.length) return checked;
  const results = [...checked.results, ...grammar].sort((a, b) => (a.span?.start ?? -1) - (b.span?.start ?? -1));
  // When nothing blocks, the suggestion is every fix applied at once: the rules' spelling fixes
  // and grammar's. A blocked question keeps the rules' own rewrite.
  let suggestion = checked.suggestion;
  if (!checked.blocked) {
    const fixed = tidyQuestion(applyFixes(checked.text, results));
    if (fixed !== tidyQuestion(checked.text)) suggestion = fixed;
  }
  return { ...checked, results, suggestion };
}
