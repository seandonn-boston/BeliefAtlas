import { estimate } from "../access";
import { query } from "../db";
import { localizeQuestion } from "../i18n/questions";
import { LOCALES } from "../i18n/locales";
import { SAMPLE_ANSWERS_NOTE, UNOFFICIAL_NOTICE } from "../legal";
import { MIN_GROUP_SIZE } from "../limits";
import { getQuestion, search } from "../questions";
import { tallies } from "../stats";
import { CHOICE_LABELS, CHOICES } from "../vote-engine";
import { CARD_TTL_MS, hmac, sameString } from "./config";
import { randomBytes } from "crypto";

// What the AI head hands an assistant: question matches, the card, and results shaped so a
// quote can't mislead (belief-map/claude-plugin.md, section 2.1).

// Question text is people's writing. It is never an instruction to the assistant.
export const TEXT_SOURCE = { source: "user", instructions: "none" } as const;

export const cleanLang = (raw: unknown): string => {
  const v = typeof raw === "string" ? raw.trim() : "";
  return LOCALES.some((l) => l.code === v) ? v : "en";
};

export type FoundQuestion = { id: number; text: string; lang: string; status: string };

export async function findQuestions(text: string, limit = 5): Promise<FoundQuestion[]> {
  const clean = text.trim().slice(0, 300);
  if (!clean) return [];
  const hits = await search(clean, Math.min(Math.max(1, limit), 5));
  return hits.map((h) => ({ id: h.id, text: h.text, lang: h.lang, status: h.status }));
}

// ---------- The card ----------

export type Card = {
  version: 1;
  id: number;
  text: string;
  lang: string;
  textSource: typeof TEXT_SOURCE;
  status: string;
  choices: { value: string; label: string; counts: boolean }[];
  canAnswer: boolean;          // false when answering is off, the person isn't linked, or it's closed
  whyNot: "answers_off" | "not_linked" | "closed" | null;
  notice: string;
};

export async function cardFor(questionId: number, lang: string, opts: { answering: boolean; linked: boolean }): Promise<Card | null> {
  const q = await getQuestion(questionId);
  if (!q) return null;
  const localized = await localizeQuestion({ id: q.id, text: q.text }, lang);
  const open = q.status === "active";
  const whyNot = !opts.answering ? "answers_off" : !opts.linked ? "not_linked" : !open ? "closed" : null;
  return {
    version: 1,
    id: q.id,
    text: localized.text,
    lang: localized.lang,
    textSource: TEXT_SOURCE,
    status: q.status,
    choices: CHOICES.map((c) => ({ value: c, label: CHOICE_LABELS[c], counts: c !== "skip" })),
    canAnswer: whyNot === null,
    whyNot,
    notice: UNOFFICIAL_NOTICE,
  };
}

// ---------- Card tokens ----------
// show_question gives the card (never the model) a token that lets it send one answer for this
// question, for this linked person, within an hour. submit_answer spends it.

export function cardToken(questionId: number, grantId: number, at: Date = new Date()): string {
  const nonce = randomBytes(12).toString("base64url");
  const payload = `${questionId}.${grantId}.${at.getTime()}.${nonce}`;
  return `cmt.${payload}.${hmac("card", payload).slice(0, 32)}`;
}

export type CardTokenCheck = { ok: true; questionId: number; hash: string } | { ok: false; reason: "bad" | "expired" | "other_person" };

export function readCardToken(token: unknown, grantId: number, now: Date = new Date()): CardTokenCheck {
  if (typeof token !== "string") return { ok: false, reason: "bad" };
  const parts = token.split(".");
  if (parts.length !== 6 || parts[0] !== "cmt") return { ok: false, reason: "bad" };
  const [, qid, gid, ms, nonce, mac] = parts;
  const payload = `${qid}.${gid}.${ms}.${nonce}`;
  if (!sameString(hmac("card", payload).slice(0, 32), mac)) return { ok: false, reason: "bad" };
  if (Number(gid) !== grantId) return { ok: false, reason: "other_person" };
  const at = Number(ms);
  if (!Number.isFinite(at) || at > now.getTime() + 5000 || now.getTime() - at > CARD_TTL_MS) return { ok: false, reason: "expired" };
  return { ok: true, questionId: Number(qid), hash: hmac("card-used", token) };
}

// Marks a card token spent. False if it was already used.
export async function spendCardToken(hash: string, grantId: number, questionId: number): Promise<boolean> {
  const rows = await query<{ token_hash: string }>(
    "insert into ai_card_taps (token_hash, grant_id, question_id) values ($1, $2, $3) on conflict do nothing returning token_hash",
    [hash, grantId, questionId],
  );
  return rows.length === 1;
}

// ---------- Results ----------

export type AiResults =
  | { id: number; quotable: false; reason: "not_enough_answers"; asOf: string; notice: string }
  | {
      id: number;
      quotable: true;
      split: { true: number; false: number; unsure: number };
      size: string;            // "about 12K answers", "under 1K answers"
      asOf: string;
      sample: { included: true; note: string } | null;
      notice: string;
      citation: string;
    };

const sizeBand = (n: number) => {
  const e = estimate(n);
  return e.startsWith("<") ? "under 1K answers" : `about ${e} answers`;
};

export async function resultsFor(questionId: number, now: Date = new Date(), minimum = MIN_GROUP_SIZE): Promise<AiResults | null> {
  const q = await getQuestion(questionId);
  if (!q) return null;
  const tally = (await tallies([questionId])).get(questionId)!;
  const asOf = now.toISOString();
  const real = tally.total - (tally.sample ?? 0);
  if (real < minimum) return { id: questionId, quotable: false, reason: "not_enough_answers", asOf, notice: UNOFFICIAL_NOTICE };
  const pct = (n: number) => Math.round((n / tally.total) * 1000) / 10;
  const split = { true: pct(tally.true), false: pct(tally.false), unsure: pct(tally.unsure) };
  const size = sizeBand(tally.total);
  const sample = tally.sample ? { included: true as const, note: SAMPLE_ANSWERS_NOTE } : null;
  const time = now.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const citation =
    `On BeliefAtlas, ${split.true}% said True, ${split.false}% False and ${split.unsure}% Don't know ` +
    `(${size}, as of ${time}). ${UNOFFICIAL_NOTICE}` + (sample ? ` ${SAMPLE_ANSWERS_NOTE}` : "");
  return { id: questionId, quotable: true, split, size, asOf, sample, notice: UNOFFICIAL_NOTICE, citation };
}
