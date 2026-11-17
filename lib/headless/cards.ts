import { query } from "../db";
import { baseUrl, shownToken, type Surface } from "../front-door";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../i18n/locales";
import { loadMessages } from "../i18n/messages";
import { localizeQuestion } from "../i18n/questions";
import { mergedInto } from "../questions";
import { CHOICES, type Choice } from "../vote-engine";
import { topPage } from "../feed";
import { API_BASE, API_VERSION } from "./config";
import { unofficialNotice } from "./notice";
import { originAllowed, surfaceFor, type Placement } from "./placements";

// The question card, v1: the one shape every SDK draws (belief-map/headless-front-door.md
// section 4). It carries no split: cards hide results until the person answers, so a first
// answer is their own. Opening any link in it never casts a vote; only a tap on BeliefAtlas's
// own page does (or, switched off, a signed server relay).

export type CardChoice = { value: Choice; label: string; counts: boolean; answerUrl: string | null };

export type QuestionCard = {
  version: typeof API_VERSION;
  id: number;
  mergedFrom?: number;
  text: string;
  lang: string;
  translated: boolean;
  status: "active" | "archived";
  approved: boolean;
  choices: CardChoice[];
  shown: string | null;
  links: { question: string; results: string };
  // Always shown with the card (Sean's rule): BeliefAtlas is unofficial.
  notice: string;
};

export type CardOptions = {
  locale?: string | null;
  placement?: Placement | null;
  // The page that asked for the card, told when a hosted tap counts. Used only when it is one
  // of the placement's allowed origins.
  returnOrigin?: string | null;
  now?: Date;
};

export const cardLocale = (raw: unknown): Locale => {
  if (typeof raw !== "string") return DEFAULT_LOCALE;
  const base = raw.trim().split(/[-_]/)[0].toLowerCase();
  return isLocale(base) ? base : DEFAULT_LOCALE;
};

export async function choiceLabels(locale: Locale): Promise<Record<Choice, string>> {
  const messages = await loadMessages(locale);
  const choices = (messages.common as Record<string, unknown>).choices as Record<string, string> | undefined;
  return {
    true: choices?.true ?? "True",
    false: choices?.false ?? "False",
    unsure: choices?.unsure ?? "Don't know",
    skip: choices?.skip ?? "Skip",
  };
}

// The hosted-tap link for one choice: the one-tap vote page with that answer highlighted.
export function answerUrl(questionId: number, pick: Choice, opts: { surface?: Surface; placement?: string | null; ret?: string | null } = {}): string {
  const params = new URLSearchParams();
  params.set("via", opts.surface ?? "headless");
  if (opts.placement) params.set("at", opts.placement);
  params.set("pick", pick);
  if (opts.ret) params.set("ret", opts.ret);
  return `${baseUrl()}/v/${questionId}?${params}`;
}

type Row = { id: number; text: string; lang: string; status: string; approved: boolean };

async function row(questionId: number): Promise<Row | null> {
  const [r] = await query<Row>(
    "select id, text, lang, status, approved_at is not null as approved from questions where id = $1 and status <> 'removed'",
    [questionId],
  );
  return r ?? null;
}

function build(r: Row, labels: Record<Choice, string>, local: { text: string; lang: string; translated: boolean }, notice: string, opts: CardOptions): QuestionCard {
  const active = r.status === "active";
  const placement = opts.placement ?? null;
  const surface = placement ? surfaceFor(placement.kind) : "headless";
  const ret = placement && opts.returnOrigin && originAllowed(placement, opts.returnOrigin) ? new URL(opts.returnOrigin).origin : null;
  return {
    version: API_VERSION,
    id: r.id,
    text: local.text,
    lang: local.lang,
    translated: local.translated,
    status: active ? "active" : "archived",
    approved: r.approved,
    choices: CHOICES.map((value) => ({
      value,
      label: labels[value],
      counts: value !== "skip",
      answerUrl: active ? answerUrl(r.id, value, { surface, placement: placement?.id, ret }) : null,
    })),
    shown: active ? shownToken(r.id, opts.now) : null,
    links: { question: `${baseUrl()}/v/${r.id}`, results: `${baseUrl()}${API_BASE}/questions/${r.id}/split` },
    notice,
  };
}

// One card. A question merged into another answers with the one it was merged into; a removed
// or missing question is null.
export async function questionCard(questionId: number, opts: CardOptions = {}): Promise<QuestionCard | null> {
  if (!Number.isInteger(questionId) || questionId <= 0) return null;
  let r = await row(questionId);
  let mergedFrom: number | undefined;
  if (!r) {
    const target = await mergedInto(questionId);
    if (!target) return null;
    r = await row(target);
    if (!r) return null;
    mergedFrom = questionId;
  }
  const locale = cardLocale(opts.locale);
  const [labels, local, notice] = await Promise.all([
    choiceLabels(locale), localizeQuestion({ id: r.id, text: r.text, lang: r.lang }, locale), unofficialNotice(locale),
  ]);
  const card = build(r, labels, local, notice, opts);
  return mergedFrom ? { ...card, mergedFrom } : card;
}

// The cards for a placement, in its order; an empty list means the public feed's top questions.
// Archived questions are left out of a placement's list (nothing to answer).
export async function placementCards(placement: Placement, opts: Omit<CardOptions, "placement"> = {}, limit = 12): Promise<QuestionCard[]> {
  const ids = placement.questionIds.length
    ? placement.questionIds.slice(0, 50)
    : (await topPage(null, null, limit, cardLocale(opts.locale))).rows.map((r) => r.id);
  const cards = await Promise.all(ids.map((id) => questionCard(id, { ...opts, placement })));
  const seen = new Set<number>();
  return cards.filter((c): c is QuestionCard => {
    if (!c || c.status !== "active" || seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}
