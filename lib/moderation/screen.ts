import { CATEGORIES, isCategory, type CategorySlug } from "../categories";
import { query } from "../db";
import type { Match } from "../questions";
import { sweep } from "./sweep";

// Helpers for the sweep (./sweep.ts): names not known to be public, the subject a question
// probably belongs to, and the optional model. Three layers check a question:
//   1. the search page, where the asker sees similar questions and the fixes first;
//   2. the sweep, when they press "Ask now";
//   3. reports from voters, and the moderator queue.
// With AI_ENABLED=true and ANTHROPIC_API_KEY set a small model adds its view; without both,
// rules decide. The model is a paid API, so it stays off until AI_ENABLED is set on purpose.

export type Screen = {
  reject?: string;              // refuse, with this message
  duplicateOf?: number;         // refuse as a repeat of this question
  hold?: string;                // accept, but keep out of feeds until a moderator approves
  category: CategorySlug;
};

// A run of capitalised words after the first word, such as "Jane Smith" or "Red Sox".
const NAME = /(?<!^)\b([A-Z][a-z'’-]+(?:\s+(?:[A-Z]\.|[A-Z][a-z'’-]+))+)/g;

export async function unknownNames(text: string): Promise<string[]> {
  const names = [...new Set([...text.matchAll(NAME)].map((m) => m[1]))];
  const unknown: string[] = [];
  for (const name of names) {
    // A name already in the catalog (a president, a city, a team) is public enough.
    const rows = await query("select 1 from questions where status = 'active' and asked_by is null and text like $1 limit 1", [
      `%${name.replace(/[%_\\]/g, "")}%`,
    ]);
    if (!rows.length) unknown.push(name);
  }
  return unknown;
}

export function categoryFrom(matches: Match[]): CategorySlug {
  const near = matches.find((m) => m.similarity >= 0.3 && m.category !== "general");
  return near && isCategory(near.category) ? near.category : "general";
}

export type Verdict = {
  duplicate_of: number | null;
  category?: CategorySlug;
  answerable_yes_no: boolean;
  names_private_person: boolean;
  harassing_or_hateful: boolean;
};

// The model's view of a question, or null when it is off, has no key, or is too slow.
export async function modelVerdict(text: string, matches: Match[], timeoutMs = 8000): Promise<Verdict | null> {
  const key = process.env.AI_ENABLED === "true" ? process.env.ANTHROPIC_API_KEY : undefined;
  if (!key) return null;
  const prompt = `A user wants to post this yes-or-no question to a public voting site:
"${text}"

Existing questions that may be the same:
${matches.map((m) => `#${m.id}: ${m.text}`).join("\n") || "(none)"}

Subjects: ${CATEGORIES.filter((c) => c.slug !== "general").map((c) => c.slug).join(", ")}

Reply with JSON only, no other text:
{"duplicate_of": <id of an existing question asking the same thing in other words, or null; questions about different people, places, numbers or dates are NOT duplicates>,
 "category": <one subject from the list>,
 "answerable_yes_no": <true if it can be answered true or false>,
 "names_private_person": <true if it names or identifies a private individual rather than a public figure, place, team or organisation>,
 "harassing_or_hateful": <true if it insults, harasses or demeans a person or group>}`;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.MODERATION_MODEL ?? "claude-haiku-5-5",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const data = (await response.json()) as { content: { type: string; text?: string }[] };
    const raw = data.content.map((c) => c.text ?? "").join("");
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const verdict = JSON.parse(json) as Omit<Verdict, "category"> & { category?: string };
    return { ...verdict, category: isCategory(verdict.category) ? verdict.category : undefined };
  } catch (err) {
    console.error("moderation model unavailable, using rules", (err as Error).message);
    return null;
  }
}

// The older single-answer form of the sweep, kept for callers that only want reject / hold.
export async function screenQuestion(text: string, matches: Match[]): Promise<Screen> {
  const result = await sweep(text, matches);
  if (result.duplicateOf) return { duplicateOf: result.duplicateOf, category: result.category };
  if (result.decision === "deny") return { reject: result.results[0]?.reason ?? "This question can't be asked.", category: result.category };
  return { hold: result.hold ?? undefined, category: result.category };
}
