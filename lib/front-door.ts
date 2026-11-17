import { createHmac, timingSafeEqual } from "crypto";

// Settings for the front door: the pieces that are still open decisions are read from the
// environment so they can be flipped without a code change.

// The public address that share links, embeds and preview images point at. A placeholder
// until the domain is chosen.
export function baseUrl(): string {
  const raw = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

// Every place a vote can come from. A label that isn't on this list is stored as "web".
export const SURFACES = [
  "web", "share", "embed", "qr", "email", "sms", "whatsapp", "rcs", "imessage",
  "slack", "discord", "teams", "telegram", "messenger", "instagram", "reddit",
  "x", "threads", "bluesky", "mastodon", "truth", "pinterest", "snapchat", "facebook",
  "twitch", "youtube", "wechat", "google", "ad", "extension",
] as const;
export type Surface = (typeof SURFACES)[number];

export const cleanSurface = (s: unknown): Surface =>
  typeof s === "string" && (SURFACES as readonly string[]).includes(s) ? (s as Surface) : "web";

// Placement is a free label (a poster id, an embed's host site). Keep it short and plain.
export const cleanPlacement = (p: unknown): string | null => {
  if (typeof p !== "string") return null;
  const v = p.trim().toLowerCase().replace(/[^a-z0-9._:-]/g, "").slice(0, 64);
  return v || null;
};

// ---------- "Shown at" tokens ----------
// When a question is drawn (the vote page, an embed, a card), the server signs the moment it was
// shown. The tap sends it back, so answer time is measured by our clock, not the browser's.

const SHOWN_MAX_AGE_MS = 24 * 3600 * 1000;

function secret(): string {
  return process.env.SHARE_SECRET || process.env.PHONE_PEPPER || "dev-only-secret";
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url").slice(0, 22);

export function shownToken(questionId: number, at: Date = new Date()): string {
  const payload = `${questionId}.${at.getTime()}`;
  return `${payload}.${sign(payload)}`;
}

// The moment the question was shown, or null if the token is missing, forged, for another
// question, or more than a day old.
export function readShownToken(token: unknown, questionId: number, now: Date = new Date()): Date | null {
  if (typeof token !== "string") return null;
  const [id, ms, mac] = token.split(".");
  if (!id || !ms || !mac || Number(id) !== questionId) return null;
  const expected = Buffer.from(sign(`${id}.${ms}`));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const at = Number(ms);
  if (!Number.isFinite(at) || at > now.getTime() + 5000 || now.getTime() - at > SHOWN_MAX_AGE_MS) return null;
  return new Date(at);
}

// Milliseconds from being shown to the tap. Null where it can't be known or isn't believable.
export function answerMs(shownAt: Date | null | undefined, tappedAt: Date): number | null {
  if (!shownAt) return null;
  const ms = tappedAt.getTime() - shownAt.getTime();
  return ms >= 0 && ms <= SHOWN_MAX_AGE_MS ? ms : null;
}

// ---------- Links ----------

export const voteUrl = (questionId: number, opts: { via?: Surface; pick?: "true" | "false" | "unsure" | "skip" } = {}) => {
  const params = new URLSearchParams();
  if (opts.via) params.set("via", opts.via);
  if (opts.pick) params.set("pick", opts.pick);
  const rest = params.toString();
  return `${baseUrl()}/v/${questionId}${rest ? `?${rest}` : ""}`;
};

export const embedUrl = (questionId: number) => `${baseUrl()}/embed/${questionId}`;

export const EMBED_SIZE = { width: 480, height: 300 };

export function embedHtml(questionId: number, title: string): string {
  const esc = title.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<iframe src="${embedUrl(questionId)}" title="${esc}" width="${EMBED_SIZE.width}" height="${EMBED_SIZE.height}" style="border:0;max-width:100%" allow="web-share; storage-access" loading="lazy"></iframe>`;
}

// The question id a BeliefAtlas link points at, if it is one of ours.
export function questionIdFromUrl(raw: string): number | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== new URL(baseUrl()).origin) return null;
  const match = url.pathname.match(/^\/(?:v|q|embed)\/(\d+)\/?$/);
  const id = match ? Number(match[1]) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

// The product name on share previews, embeds and the vote page.
export const brandName = () => process.env.BRAND_NAME || "BeliefAtlas";

// The cookie that holds a tap made before signing in (or past the daily limit), so only the
// browser that tapped can have it counted.
export const HOLD_COOKIE = "cm_hold";
export const HOLD_COOKIE_SECONDS = 24 * 3600;

// Where a confirmation links to.
export const confirmationLinks = (questionId: number) => ({
  changeUrl: `/q/${questionId}`,
  accountUrl: "/settings",
  shareUrl: voteUrl(questionId, { via: "share" }),
});
