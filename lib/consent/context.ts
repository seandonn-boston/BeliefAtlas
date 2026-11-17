import { SURFACES } from "../front-door";

// What a consent record needs to know about the request it came from. Built from request
// headers by lib/consent/request.ts in the app, or by hand in tests and platform adapters.
export type ConsentContext = {
  gpc: boolean;            // the browser sent Global Privacy Control (Sec-GPC: 1)
  region: string | null;   // ISO 3166-1 alpha-2 from the hosting platform, or null (the '*' region)
  surface: string;         // where the choice was made: a vote surface, or 'settings'
  lang: string;            // the interface language, which picks the consent text shown
};

// Surfaces a choice can be made on: every vote surface, plus the pages that only change consent.
export const CONSENT_SURFACES = [...SURFACES, "settings", "consent"] as const;

export const cleanConsentSurface = (s: unknown): string =>
  typeof s === "string" && (CONSENT_SURFACES as readonly string[]).includes(s) ? s : "web";

// Global Privacy Control: a browser setting that asks sites not to sell or share the person's
// data. The header is exactly "1" when it is on.
export const gpcFrom = (value: string | null | undefined) => value?.trim() === "1";

// The visitor's country from Vercel's free x-vercel-ip-country header. Anything that isn't a
// plain two-letter code (missing, "XX" for unknown, a spoofed value) is null, which is the '*'
// region: closed to sale. Elsewhere than Vercel the header is absent and everyone is '*'.
export function regionFrom(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(code) && code !== "XX" ? code : null;
}

// Where to return after the consent step: same-site paths only, never /consent itself.
export function safeNext(raw: unknown): string {
  const path = typeof raw === "string" ? raw.trim() : "";
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\") || path.startsWith("/consent")) return "/";
  return path;
}

type HeaderSource ={ get(name: string): string | null };

export function contextFromHeaders(h: HeaderSource, surface: string, lang: string): ConsentContext {
  return {
    gpc: gpcFrom(h.get("sec-gpc")),
    region: regionFrom(h.get("x-vercel-ip-country")),
    surface: cleanConsentSurface(surface),
    lang,
  };
}
