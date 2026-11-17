import type { CheckedQuestion, CheckResult } from "./types";

export type { CheckedQuestion, CheckResult, CheckCode } from "./types";

// Checks a question as typed, before it can be posted. Free and self-contained: plain rules,
// no paid service. Each finding says why, where and what to change (lib/checks/types.ts).

const MIN_LENGTH = 12;
export const MAX_LENGTH = 200;

const OPENERS = new Set([
  "is", "are", "was", "were", "am", "do", "does", "did", "will", "would", "can", "could",
  "should", "has", "have", "had", "may", "might", "must", "shall",
  "isn't", "aren't", "wasn't", "weren't", "don't", "doesn't", "didn't", "won't", "wouldn't",
  "can't", "couldn't", "shouldn't", "hasn't", "haven't", "hadn't",
]);
// Verbs that can move to the front to turn a statement into a question ("X is Y" -> "Is X Y?").
const MOVABLE = new Set([
  "is", "are", "was", "were", "will", "would", "can", "could", "should", "has", "have", "had",
  "may", "might", "must", "isn't", "aren't", "wasn't", "weren't", "won't", "can't", "couldn't",
  "shouldn't", "hasn't", "haven't",
]);
const OPEN_ENDED = new Set(["what", "why", "how", "who", "whom", "whose", "when", "where", "which"]);
// Words that start a statement and lose their capital when a verb moves in front of them.
const LOWER_AFTER_MOVE = new Set([
  "the", "a", "an", "this", "that", "these", "those", "my", "our", "your", "their", "his", "her", "its",
  "it", "there", "we", "you", "they", "he", "she", "most", "all", "some", "many", "every", "no", "people",
  "humans", "everyone", "nobody", "someone", "something", "nothing", "everything", "water", "money",
]);

// Top-level domains common enough to treat "word.tld" as a link. Kept short on purpose so
// "Node.js" or "3.14" never trip it.
const TLDS = "com|org|net|io|co|gov|edu|info|news|ly|me|tv|us|uk|ca|au|de|fr|app|dev|ai|gg|be|to|link|site|online|xyz|biz";
const LINK_PATTERNS: RegExp[] = [
  /\bhttps?:\/\/\S+/gi,
  /\bwww\.\S+/gi,
  new RegExp(`\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})\\b(?:\\/\\S*)?`, "gi"),
  // Spelled out to get past a filter: "nytimes dot com", "example (dot) org", "site[.]com".
  new RegExp(`\\b[a-z0-9-]+\\s*(?:\\(|\\[)?\\s*(?:dot|\\.)\\s*(?:\\)|\\])?\\s*(?:${TLDS})\\b(?:\\s*(?:slash|\\/)\\s*\\S+)?`, "gi"),
];

const PERSONAL_DATA: [RegExp, string, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "Questions can't include email addresses, so nobody can be contacted or identified through one.", "email"],
  [/(?:\+?\d[\s().-]*){10,}/g, "Questions can't include phone numbers, so nobody can be contacted or identified through one.", "phone"],
  [/(^|\s)@[A-Za-z0-9_]{2,}/g, "Questions can't include social media handles, which point at one person's account.", "handle"],
  [/\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Ct|Court|Way|Pl|Place)\b/g,
    "Questions can't include street addresses, which point at someone's home.", "address"],
];

// Common misspellings. A starting list until a self-hosted grammar checker (LanguageTool) is
// added; it never blocks.
const MISSPELLINGS: Record<string, string> = {
  teh: "the", recieve: "receive", beleive: "believe", belive: "believe", definately: "definitely",
  seperate: "separate", goverment: "government", govenment: "government", wierd: "weird", alot: "a lot",
  untill: "until", occured: "occurred", thier: "their", wich: "which", becuase: "because", beacuse: "because",
  tommorow: "tomorrow", tomorow: "tomorrow", accomodate: "accommodate", enviroment: "environment",
  existance: "existence", independant: "independent", neccessary: "necessary", necessery: "necessary",
  occurence: "occurrence", publically: "publicly", reccomend: "recommend", recomend: "recommend",
  truely: "truly", arguement: "argument", calender: "calendar", concious: "conscious", embarass: "embarrass",
  foriegn: "foreign", happend: "happened", knowlege: "knowledge", millenium: "millennium",
  noticable: "noticeable", posession: "possession", prefered: "preferred", questionaire: "questionnaire",
  succesful: "successful", sucessful: "successful", vaccum: "vacuum", peice: "piece", freind: "friend",
  beggining: "beginning", buisness: "business", busness: "business", comming: "coming", finaly: "finally",
  intresting: "interesting", sucess: "success", realy: "really", scince: "science", sience: "science",
  scientifc: "scientific", climat: "climate", vaccine: "vaccine", vacine: "vaccine", vaccinne: "vaccine",
  presidant: "president", goverments: "governments", countires: "countries", contries: "countries",
  doesnt: "doesn't", dont: "don't", didnt: "didn't", isnt: "isn't", arent: "aren't", wasnt: "wasn't",
  werent: "weren't", cant: "can't", wont: "won't", shouldnt: "shouldn't", couldnt: "couldn't",
  wouldnt: "wouldn't", hasnt: "hasn't", havent: "haven't",
};

const collapse = (raw: string) => raw.replace(/\s+/g, " ").trim();
const matchCase = (word: string, fix: string) =>
  word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase() ? fix[0].toUpperCase() + fix.slice(1) : fix;

function findAll(text: string, pattern: RegExp): { start: number; end: number; value: string }[] {
  const out: { start: number; end: number; value: string }[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  for (const m of text.matchAll(re)) {
    // A pattern may capture leading space ("(^|\s)@handle"); point at the thing itself.
    const lead = m[1] && /^\s+$/.test(m[1]) ? m[1].length : 0;
    out.push({ start: m.index! + lead, end: m.index! + m[0].length, value: m[0].slice(lead) });
  }
  return out;
}

// Removing a link or a personal detail also removes the little word that pointed at it, so
// "Did the NYT report this at nytimes.com" becomes "Did the NYT report this", not "... this at".
const POINTER = /(?:^|\s)(?:at|on|from|in|via|see|here|by|:)\s*$/i;
function removal(text: string, m: { start: number; end: number }): { start: number; end: number } {
  const before = text.slice(0, m.start);
  const pointer = before.match(POINTER);
  return { start: pointer ? m.start - pointer[0].length : m.start, end: m.end };
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

// Apply each result's fix to its span, from the end backwards so earlier offsets stay right.
export function applyFixes(text: string, results: CheckResult[]): string {
  const edits = results
    .filter((r) => r.span && r.fix !== null)
    .map((r) => ({ range: r.replace ?? r.span!, fix: r.fix! }))
    .sort((a, b) => b.range.start - a.range.start);
  let out = text;
  let lastStart = Infinity;
  for (const e of edits) {
    if (e.range.end > lastStart) continue; // overlapping edits: keep the later one only
    out = out.slice(0, e.range.start) + e.fix + out.slice(e.range.end);
    lastStart = e.range.start;
  }
  return out;
}

// Store form: one space, capital first letter, one question mark.
export function tidyQuestion(text: string): string {
  const t = collapse(text).replace(/\s+([,;:])/g, "$1").replace(/[?.!\s]+$/, "").replace(/^[,;:\s]+/, "");
  return t ? t.charAt(0).toUpperCase() + t.slice(1) + "?" : "";
}

// "The earth is flat" -> "Is the earth flat?"; otherwise "Is it true that ...?".
export function asTrueFalse(text: string): string | null {
  const t = tidyQuestion(text).slice(0, -1);
  const words = t.split(" ");
  if (!words.length || OPEN_ENDED.has(words[0].toLowerCase())) return null;
  const at = words.findIndex((w, i) => i > 0 && i <= 6 && MOVABLE.has(w.toLowerCase()));
  if (at > 0) {
    const verb = words[at].toLowerCase();
    const subject = words.slice(0, at);
    if (LOWER_AFTER_MOVE.has(subject[0].toLowerCase())) subject[0] = subject[0].toLowerCase();
    const rest = words.slice(at + 1);
    return tidyQuestion([verb, ...subject, ...rest].join(" "));
  }
  const first = LOWER_AFTER_MOVE.has(words[0].toLowerCase()) ? words[0].toLowerCase() : words[0];
  return tidyQuestion(["Is it true that", first, ...words.slice(1)].join(" "));
}

export function checkQuestion(raw: string): CheckedQuestion {
  const text = collapse(raw);
  const results: CheckResult[] = [];

  const taken: { start: number; end: number }[] = [];
  for (const [pattern, reason, kind] of PERSONAL_DATA) {
    for (const m of findAll(text, pattern)) {
      if (taken.some((t) => overlaps(t, m))) continue;
      taken.push(m);
      results.push({
        code: "personal_data", blocking: true, span: { start: m.start, end: m.end }, fix: "",
        replace: removal(text, m), reason, key: `personal_${kind}`,
      });
    }
  }

  // Links block. Naming a source in words is fine; a link isn't (Sean, 17 Nov 2026).
  for (const pattern of LINK_PATTERNS) {
    for (const m of findAll(text, pattern)) {
      if (taken.some((t) => overlaps(t, m))) continue;
      taken.push(m);
      results.push({
        code: "link", blocking: true, span: { start: m.start, end: m.end }, fix: "", replace: removal(text, m),
        key: "link",
        reason: "Questions can't contain links, including shortened or spelled-out ones. Name the source in words instead, like \"an article in the New York Times\".",
      });
    }
  }

  // Spelling and grammar: suggestions only.
  for (const m of text.matchAll(/\p{L}[\p{L}']*/gu)) {
    const word = m[0];
    const fix = MISSPELLINGS[word.toLowerCase()];
    if (fix && fix !== word.toLowerCase()) {
      results.push({
        code: "spelling", blocking: false, span: { start: m.index!, end: m.index! + word.length },
        fix: matchCase(word, fix), key: "spelling", values: { word, fix: matchCase(word, fix) },
        reason: `"${word}" looks misspelled; did you mean "${matchCase(word, fix)}"?`,
      });
    }
  }
  for (const m of text.matchAll(/\b(\p{L}+)\s+\1\b/giu)) {
    if (results.some((r) => r.span && overlaps(r.span, { start: m.index!, end: m.index! + m[0].length }))) continue;
    results.push({
      code: "repeated_word", blocking: false, span: { start: m.index!, end: m.index! + m[0].length },
      fix: m[1], key: "repeated_word", values: { word: m[1] }, reason: `"${m[1]}" appears twice in a row.`,
    });
  }
  for (const m of text.matchAll(/(^|\s)(i)(?=\s|'|$)/g)) {
    const start = m.index! + m[1].length;
    results.push({ code: "lowercase_i", blocking: false, span: { start, end: start + 1 }, fix: "I", key: "lowercase_i", reason: '"I" is always a capital letter.' });
  }

  // Shape: long enough, short enough, and answerable true or false. Checked on the text with
  // links and personal details taken out, since those are being fixed anyway.
  const cleaned = tidyQuestion(applyFixes(text, results));
  const words = cleaned.slice(0, -1).split(" ").filter(Boolean);
  if (cleaned.length > MAX_LENGTH) {
    results.push({
      code: "too_long", blocking: true, span: { start: Math.min(MAX_LENGTH, text.length), end: text.length }, fix: null,
      key: "too_long", values: { max: MAX_LENGTH, length: cleaned.length },
      reason: `Questions can be at most ${MAX_LENGTH} characters; this one is ${cleaned.length}. Try cutting it to the one claim you want answered.`,
    });
  } else if (cleaned.length < MIN_LENGTH || words.length < 3 || !/\p{L}{2,}/u.test(cleaned)) {
    results.push({
      code: "too_short", blocking: true, span: null, fix: null, key: "too_short",
      reason: "That's too short to be a question. Say the whole claim, like \"Is the Great Wall of China visible from space?\"",
    });
  } else if (!OPENERS.has(words[0].toLowerCase())) {
    const openEnded = OPEN_ENDED.has(words[0].toLowerCase());
    const firstWord = text.match(/^\S+/);
    results.push({
      code: "not_true_false", blocking: true,
      span: firstWord ? { start: 0, end: firstWord[0].length } : null,
      fix: null,
      key: openEnded ? "open_ended" : "statement",
      values: { word: words[0] },
      reason: openEnded
        ? `Questions starting with "${words[0]}" ask for an explanation, and BeliefAtlas questions need a true-or-false answer. Ask about one claim, starting with a word like "Is", "Did", "Will" or "Does".`
        : 'This reads as a statement. BeliefAtlas questions need a true-or-false answer, so start with a word like "Is", "Did", "Will" or "Does".',
    });
  }

  results.sort((a, b) => (a.span?.start ?? -1) - (b.span?.start ?? -1));
  const blocked = results.some((r) => r.blocking);

  // One suggestion for the whole question: every span fix, then the true/false rewrite.
  let suggestion: string | null = tidyQuestion(applyFixes(text, results));
  if (results.some((r) => r.code === "not_true_false")) suggestion = asTrueFalse(suggestion);
  if (suggestion !== null) {
    const again = checkQuestion_shape(suggestion);
    if (!again || suggestion === tidyQuestion(text)) suggestion = null;
  }
  return { text, results, blocked, suggestion };
}

// Would a suggestion itself pass the blocking checks? Only offer it if so.
function checkQuestion_shape(suggestion: string): boolean {
  const words = suggestion.slice(0, -1).split(" ").filter(Boolean);
  return suggestion.length >= MIN_LENGTH && suggestion.length <= MAX_LENGTH && words.length >= 3
    && OPENERS.has(words[0].toLowerCase());
}
