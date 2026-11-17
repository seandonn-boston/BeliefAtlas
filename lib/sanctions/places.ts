// Where BeliefAtlas does not go, in one place. Everything that blocks a visitor, a phone number, a
// buyer or an organisation by country reads these lists and nothing else, so a change of policy
// is one edit here (and a test run), never a hunt through the code.
//
// Changes to these lists are never made automatically. The daily OFAC check
// (lib/sanctions/ofac-actions.ts) only flags new country-program actions for a person to review.
//
// Codes are ISO 3166-1 alpha-2 for countries and ISO 3166-2 subdivision codes for regions, the
// form Vercel's free x-vercel-ip-country and x-vercel-ip-country-region headers use.

export type BlockedPlace = { code: string; name: string; why: string; since: string };

// No voting, no signup, no accounts, no organisations and no data buyers: the whole site answers
// "not available here". There is no exemption for free communications (Sean, 17 Nov 2026).
export const BLOCKED_COUNTRIES: readonly BlockedPlace[] = [
  { code: "CU", name: "Cuba", why: "Comprehensive US sanctions (Cuban Assets Control Regulations)", since: "2026-11-17" },
  { code: "IR", name: "Iran", why: "Comprehensive US sanctions (Iranian Transactions and Sanctions Regulations)", since: "2026-11-17" },
  { code: "KP", name: "North Korea", why: "Comprehensive US sanctions (North Korea Sanctions Regulations)", since: "2026-11-17" },
  { code: "RU", name: "Russia", why: "BeliefAtlas policy (Sean, 17 Nov 2026), beyond what US law requires", since: "2026-11-17" },
  { code: "BY", name: "Belarus", why: "BeliefAtlas policy (Sean, 17 Nov 2026), beyond what US law requires", since: "2026-11-17" },
];

// Regions of a country that is otherwise open. Ukraine is open; these occupied regions are under
// comprehensive US sanctions. Vercel sends the subdivision without its country prefix ("43"), so
// both forms are accepted.
export const BLOCKED_SUBDIVISIONS: Readonly<Record<string, readonly BlockedPlace[]>> = {
  UA: [
    { code: "43", name: "Crimea", why: "Comprehensive US sanctions (Ukraine-/Russia-related, Crimea region)", since: "2026-11-17" },
    { code: "40", name: "Sevastopol", why: "Comprehensive US sanctions (Ukraine-/Russia-related, Crimea region)", since: "2026-11-17" },
    { code: "14", name: "Donetsk", why: "Comprehensive US sanctions (so-called DNR region, E.O. 14065)", since: "2026-11-17" },
    { code: "09", name: "Luhansk", why: "Comprehensive US sanctions (so-called LNR region, E.O. 14065)", since: "2026-11-17" },
  ],
};

// Voting is open here, but no organisation or data buyer based here is accepted. Every blocked
// country is refused too (see noBuyersFrom). China: Sean's call; Venezuela and the blocked
// countries also match the 2025 DOJ bulk sensitive data rule's countries of concern (scope for a
// lawyer to confirm).
export const NO_BUYER_COUNTRIES: readonly BlockedPlace[] = [
  { code: "CN", name: "China (including Hong Kong and Macau)", why: "BeliefAtlas policy; DOJ bulk data rule country of concern", since: "2026-11-17" },
  { code: "HK", name: "Hong Kong", why: "Treated as China under the DOJ bulk data rule", since: "2026-11-17" },
  { code: "MO", name: "Macau", why: "Treated as China under the DOJ bulk data rule", since: "2026-11-17" },
  { code: "VE", name: "Venezuela", why: "DOJ bulk data rule country of concern", since: "2026-11-17" },
];

// Voters here are welcome, but their answers are never sold, whatever a region row or a
// lawyer's later approval says, and no server of ours runs here.
export const NEVER_SELL_COUNTRIES: readonly string[] = ["CN", "HK", "MO"];

// Recorded so nobody re-adds it from memory: Syria is NOT blocked. OFAC ended its comprehensive
// Syria sanctions in 2025 (E.O. 14312, regulations removed 25 Aug 2025, Caesar Act repealed
// 18 Dec 2025) and rescinded the state-sponsor-of-terrorism listing on 24 Aug 2026. Only
// list-based sanctions on named people remain, which buyer screening covers.
export const CHECKED_NOT_BLOCKED = [
  { code: "SY", name: "Syria", checked: "2026-11-17", source: "ofac.treasury.gov Syria-related sanctions page" },
] as const;

// Phone country codes refused at signup. +7 is shared by Russia and Kazakhstan: Kazakhstan's
// numbers start +76 or +77 and stay open. Numbers in occupied Ukraine can't be told apart by
// prefix (they use Ukrainian +380 or Russian +7 numbers), so those rely on the location check.
export const BLOCKED_PHONE_PREFIXES: readonly { prefix: string; country: string }[] = [
  { prefix: "+53", country: "CU" },
  { prefix: "+98", country: "IR" },
  { prefix: "+850", country: "KP" },
  { prefix: "+375", country: "BY" },
  { prefix: "+73", country: "RU" },
  { prefix: "+74", country: "RU" },
  { prefix: "+78", country: "RU" },
  { prefix: "+79", country: "RU" },
];

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

// Whether a visitor at this country (and region, where known) is blocked. Unknown location is
// not blocked: Vercel always sends a country in production, and local development has none.
export function placeBlocked(country: string | null | undefined, region?: string | null): BlockedPlace | null {
  const c = norm(country);
  if (!c) return null;
  const whole = BLOCKED_COUNTRIES.find((p) => p.code === c);
  if (whole) return whole;
  const r = norm(region).replace(new RegExp(`^${c}-`), "");
  if (!r) return null;
  return BLOCKED_SUBDIVISIONS[c]?.find((p) => p.code === r) ?? null;
}

// The country a phone number belongs to when that country is blocked, or null. Takes E.164.
export function phoneBlocked(e164: string): string | null {
  const n = e164.replace(/[^\d+]/g, "");
  return BLOCKED_PHONE_PREFIXES.find((p) => n.startsWith(p.prefix))?.country ?? null;
}

// Whether an organisation or data buyer based in this country is refused outright.
export function noBuyersFrom(country: string | null | undefined): boolean {
  const c = norm(country);
  if (!c) return true; // no stated country, no approval
  return BLOCKED_COUNTRIES.some((p) => p.code === c) || NO_BUYER_COUNTRIES.some((p) => p.code === c);
}
