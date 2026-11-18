// BeliefAtlas headless front door SDK for JavaScript and TypeScript (browser, Node, edge).
// API v1. Design: belief-map/headless-front-door.md. No dependencies.
//
// What it does:
//   * fetch question cards and placements (public data, no key);
//   * hosted tap: open BeliefAtlas's vote page with the answer highlighted, and hear back when it
//     counted (never what was picked, never who);
//   * draw a card as plain HTML for server rendering, and describe every vote outcome;
//   * server relay (switched off on BeliefAtlas's side; Node only, needs an org credential).
//
// Votes are never cast by opening a link. They count from a tap on BeliefAtlas's own page, or from
// a signed server relay.

export const API_VERSION = 1;

export type Choice = "true" | "false" | "unsure" | "skip";
export const CHOICES: readonly Choice[] = ["true", "false", "unsure", "skip"];

export interface CardChoice {
  value: Choice;
  label: string;
  counts: boolean;
  answerUrl: string | null;
}

export interface QuestionCard {
  version: number;
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
  /** Always shown with the card: BeliefAtlas is unofficial. renderCardHtml draws it. */
  notice: string;
}

/** Drawn when a response lacks a notice; never leave it out of what you show. */
export const UNOFFICIAL_NOTICE = "Unofficial. Opinions of BeliefAtlas users, not official statistics, polls or law.";

export interface PlacementResponse {
  version: number;
  placement: { id: string; kind: string; label: string; org: { slug: string; name: string } };
  questions: QuestionCard[];
}

export interface Split {
  questionId: number;
  hasVotes: boolean;
  percentages: { true: number; false: number; unsure: number };
  notice: string;
}

export interface PlacementResults {
  placement: { id: string; label: string; kind: string };
  minGroupSize: number;
  questions: { questionId: number; enough: boolean; total: number | null; percentages: Split["percentages"] | null }[];
  notice: string;
}

export type RelayOutcome =
  | { outcome: "cast" | "same" | "changed"; questionId: number; value: Choice }
  | { outcome: "skipped"; questionId: number }
  | { outcome: "needs_link" | "needs_consent"; questionId: number; linkUrl: string }
  | { outcome: "limit_reached" | "change_used" | "closed" | "slow_down" | "invalid" | "forbidden"; questionId: number; message: string };

export interface RelayInput {
  userId: string;          // your own opaque id for the person; never an email or phone number
  questionId: number;
  value: Choice;
  idempotencyKey: string;  // your own id for this interaction, reused on retries
  shown?: string | null;   // the card's `shown` token
  lang?: string;
}

export interface ClientOptions {
  baseUrl: string;               // BeliefAtlas's address
  placement?: string;            // your placement id, "pl-…"
  lang?: string;                 // reader language, e.g. "es"
  origin?: string;               // your page's origin, to be told when a hosted tap counts
  credential?: string;           // an org server key (cm_live_...); server only, never in a browser
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class BeliefAtlasError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "BeliefAtlasError";
  }
}

const isBrowser = () => typeof window !== "undefined" && typeof document !== "undefined";

export class BeliefAtlas {
  readonly baseUrl: string;
  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions) {
    if (!opts?.baseUrl) throw new TypeError("baseUrl is required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    if (opts.credential && isBrowser()) {
      throw new BeliefAtlasError("An organization credential must never be used in a browser.", 0, "server_only");
    }
    this.opts = opts;
  }

  private api(path: string, params: Record<string, string | undefined> = {}): string {
    const url = new URL(`${this.baseUrl}/api/headless/v${API_VERSION}${path}`);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    return url.toString();
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const doFetch = this.opts.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: controller.signal, headers: { accept: "application/json", ...(init.headers ?? {}) } });
    } catch (err) {
      throw new BeliefAtlasError(`BeliefAtlas could not be reached: ${(err as Error).message}`, 0, "network");
    } finally {
      clearTimeout(timer);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok && !(body && typeof body === "object" && "outcome" in body)) {
      const b = (body ?? {}) as { error?: string; message?: string };
      throw new BeliefAtlasError(b.message ?? `BeliefAtlas answered ${res.status}`, res.status, b.error ?? "http_error");
    }
    return body as T;
  }

  /** One question card. */
  question(id: number, opts: { lang?: string } = {}): Promise<QuestionCard> {
    return this.request(this.api(`/questions/${encodeURIComponent(String(id))}`, {
      lang: opts.lang ?? this.opts.lang, placement: this.opts.placement, origin: this.opts.origin,
    }));
  }

  /** Your placement and its question cards, in order. */
  placement(opts: { lang?: string } = {}): Promise<PlacementResponse> {
    if (!this.opts.placement) throw new TypeError("placement is required");
    return this.request(this.api(`/placements/${encodeURIComponent(this.opts.placement)}`, {
      lang: opts.lang ?? this.opts.lang, origin: this.opts.origin,
    }));
  }

  /** Percentages only. Show it after a vote counted, so first answers stay blind. */
  split(id: number, opts: { lang?: string } = {}): Promise<Split> {
    return this.request(this.api(`/questions/${encodeURIComponent(String(id))}/split`, { lang: opts.lang ?? this.opts.lang }));
  }

  /**
   * Server relay: send a tap made in your own UI for your linked user. Switched off on BeliefAtlas's
   * side until it's decided; Node and server runtimes only.
   */
  relayVote(input: RelayInput): Promise<RelayOutcome> {
    if (isBrowser()) throw new BeliefAtlasError("relayVote runs on your server, never in a browser.", 0, "server_only");
    if (!this.opts.credential) throw new BeliefAtlasError("relayVote needs an organization credential.", 0, "unauthorized");
    if (!this.opts.placement) throw new TypeError("placement is required");
    if (!input.idempotencyKey) throw new TypeError("idempotencyKey is required");
    return this.request(this.api("/votes"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.credential}` },
      body: JSON.stringify({ placementId: this.opts.placement, ...input }),
    });
  }

  /**
   * Your placement's aggregate results, read from your server with a key that has the results
   * scope. Small groups are hidden. Keys are switched off on BeliefAtlas's side until it's decided.
   */
  results(opts: { lang?: string } = {}): Promise<PlacementResults> {
    if (isBrowser()) throw new BeliefAtlasError("results with a key runs on your server, never in a browser.", 0, "server_only");
    if (!this.opts.credential) throw new BeliefAtlasError("results needs an organization key with the results scope.", 0, "unauthorized");
    if (!this.opts.placement) throw new TypeError("placement is required");
    return this.request(this.api(`/placements/${encodeURIComponent(this.opts.placement)}/results`, { lang: opts.lang ?? this.opts.lang }), {
      headers: { authorization: `Bearer ${this.opts.credential}` },
    });
  }
}

// ---------- Hosted tap (browser) ----------

export type HostedResult = { status: "counted" | "skipped" | "closed" | "blocked"; questionId: number };

type MessageWindow = {
  open: (url: string, target: string, features: string) => { closed: boolean; focus?: () => void } | null;
  addEventListener: (type: "message", fn: (e: { origin: string; source: unknown; data: unknown }) => void) => void;
  removeEventListener: (type: "message", fn: (e: { origin: string; source: unknown; data: unknown }) => void) => void;
  location?: { assign: (url: string) => void };
};

/**
 * Open BeliefAtlas's vote page for one choice in a small window. The person confirms with one tap,
 * signed in as themselves (signing up there if they need to). Resolves when BeliefAtlas says it
 * counted or was skipped, or when the window closes. Your page never learns what was picked.
 *
 * If the browser blocks the window, resolves { status: "blocked" }; navigate to the choice's
 * answerUrl instead.
 */
export function answer(card: QuestionCard, value: Choice, opts: { window?: MessageWindow; pollMs?: number; timeoutMs?: number } = {}): Promise<HostedResult> {
  const choice = card.choices.find((c) => c.value === value);
  if (!choice?.answerUrl) return Promise.reject(new BeliefAtlasError("This question is closed to new answers.", 0, "closed"));
  const w = opts.window ?? (globalThis as unknown as { window?: MessageWindow }).window;
  if (!w) return Promise.reject(new BeliefAtlasError("answer() runs in a browser.", 0, "browser_only"));
  const url = new URL(choice.answerUrl);
  url.searchParams.set("popup", "1");
  const expectedOrigin = url.origin;
  const popup = w.open(url.toString(), "beliefatlas", "popup,width=480,height=640");
  if (!popup) return Promise.resolve({ status: "blocked", questionId: card.id });

  return new Promise((resolve) => {
    let done = false;
    const finish = (status: HostedResult["status"]) => {
      if (done) return;
      done = true;
      w.removeEventListener("message", onMessage);
      clearInterval(poll);
      clearTimeout(timeout);
      resolve({ status, questionId: card.id });
    };
    const onMessage = (e: { origin: string; source: unknown; data: unknown }) => {
      if (e.origin !== expectedOrigin || e.source !== popup) return;
      const data = e.data as { type?: string; questionId?: number } | null;
      if (!data || data.questionId !== card.id) return;
      if (data.type === "beliefatlas:counted") finish("counted");
      else if (data.type === "beliefatlas:skipped") finish("skipped");
    };
    w.addEventListener("message", onMessage);
    const poll = setInterval(() => popup.closed && finish("closed"), opts.pollMs ?? 500);
    const timeout = setTimeout(() => finish("closed"), opts.timeoutMs ?? 10 * 60_000);
  });
}

// ---------- Drawing ----------

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * The card as plain, unstyled HTML: the question and one link per choice to BeliefAtlas's vote page.
 * For server rendering and places without scripts. Style it with your own CSS via the
 * `beliefatlas-*` classes. Opening a link never votes; it opens the page where one tap does.
 */
export function renderCardHtml(card: QuestionCard, opts: { headingLevel?: 2 | 3 | 4; newTab?: boolean } = {}): string {
  const h = `h${opts.headingLevel ?? 3}`;
  const target = opts.newTab === false ? "" : ' target="_blank" rel="noopener"';
  const choices = card.choices
    .filter((c) => c.answerUrl)
    .map((c) => `<li><a class="beliefatlas-choice beliefatlas-${c.value}" href="${escapeHtml(c.answerUrl!)}"${target}>${escapeHtml(c.label)}</a></li>`)
    .join("");
  const body = card.status === "active" && choices
    ? `<ul class="beliefatlas-choices">${choices}</ul>`
    : `<p class="beliefatlas-closed">This question is closed to new answers.</p>`;
  // The notice is always drawn, in the card's own markup, so it can't be dropped by accident.
  const notice = `<p class="beliefatlas-notice">${escapeHtml(card.notice?.trim() || UNOFFICIAL_NOTICE)}</p>`;
  return `<section class="beliefatlas-card" data-question="${card.id}"><${h} class="beliefatlas-text" lang="${escapeHtml(card.lang)}">${escapeHtml(card.text)}</${h}>${body}${notice}</section>`;
}

export type Described = { tone: "done" | "info" | "action" | "error"; text: string; linkUrl?: string };

/** What to show for any relay outcome, in plain English. Unknown outcomes send people to BeliefAtlas. */
export function describeOutcome(o: RelayOutcome | { outcome: string; questionId: number; [k: string]: unknown }, fallbackUrl?: string): Described {
  const msg = (o as { message?: string }).message;
  const link = (o as { linkUrl?: string }).linkUrl;
  switch (o.outcome) {
    case "cast": return { tone: "done", text: "Counted. Thanks for answering." };
    case "same": return { tone: "done", text: "You already gave that answer." };
    case "changed": return { tone: "done", text: "Your answer was changed." };
    case "skipped": return { tone: "info", text: "Skipped." };
    case "needs_link": return { tone: "action", text: "Link your BeliefAtlas account to answer here.", linkUrl: link };
    case "needs_consent": return { tone: "action", text: "Agree to BeliefAtlas's terms for answering, then your answer counts.", linkUrl: link };
    case "limit_reached": return { tone: "info", text: msg ?? "That's all the answers for today." };
    case "change_used": return { tone: "info", text: msg ?? "You can change this answer again tomorrow." };
    case "closed": return { tone: "info", text: msg ?? "This question is closed to new answers." };
    case "slow_down": return { tone: "error", text: msg ?? "Too many answers at once. Try again in a minute." };
    case "invalid":
    case "forbidden": return { tone: "error", text: msg ?? "That answer couldn't be sent." };
    default: return { tone: "action", text: "Answer on BeliefAtlas.", linkUrl: link ?? fallbackUrl };
  }
}
