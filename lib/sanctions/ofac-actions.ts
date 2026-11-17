import { query } from "../db";
import { decodeXml } from "./parsers";
import { knownCountryNames, normalizeName } from "./normalize";
import { BLOCKED_COUNTRIES, BLOCKED_SUBDIVISIONS, NO_BUYER_COUNTRIES } from "./places";
import { fetchText, type Fetcher } from "./screening";

// The daily look at OFAC's Recent Actions page. New actions are recorded, and those that may
// touch a country programme are flagged for a person to read on /mod/compliance. This never
// changes lib/sanctions/places.ts or any list: a change of policy is a person's edit there.

export const OFAC_RECENT_ACTIONS_URL = "https://ofac.treasury.gov/recent-actions";
const OFAC_ORIGIN = "https://ofac.treasury.gov";

export type RecentAction = { date: string; title: string; url: string };

const stripTags = (html: string) => decodeXml(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

// The listing links every action to /recent-actions/YYYYMMDD (with _N for a second action that
// day), so the date is read from the link; a date written as MM/DD/YYYY just before the link is
// the fallback. Tolerant of the page's markup changing around those links. Throws when the page
// has no actions at all, which means the page changed and this parser needs a look.
export function parseRecentActions(html: string): RecentAction[] {
  const out: RecentAction[] = [];
  const seen = new Set<string>();
  const link = /<a\b[^>]*\bhref\s*=\s*["']((?:https?:\/\/ofac\.treasury\.gov)?\/recent-actions\/([^"'?#]+))["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(link)) {
    const [, href, slug, inner] = m;
    const title = stripTags(inner);
    if (!title) continue;
    let date: string | null = null;
    const fromSlug = /^(\d{4})(\d{2})(\d{2})/.exec(slug);
    if (fromSlug) date = `${fromSlug[1]}-${fromSlug[2]}-${fromSlug[3]}`;
    if (!date) {
      const before = html.slice(Math.max(0, (m.index ?? 0) - 600), m.index ?? 0);
      const dates = [...before.matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g)];
      const last = dates.at(-1);
      if (last) date = `${last[3]}-${last[1].padStart(2, "0")}-${last[2].padStart(2, "0")}`;
    }
    if (!date || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) continue;
    const url = href.startsWith("http") ? href : `${OFAC_ORIGIN}${href}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ date, title, url });
  }
  if (!out.length) throw new Error("OFAC recent actions: no actions found on the page; its format may have changed");
  return out;
}

// ---------- Which actions to flag ----------
// The rule, kept simple on purpose:
//   1. the title names a place we watch: a blocked or no-buyer country (lib/sanctions/places.ts),
//      a blocked region of Ukraine or Ukraine itself, Syria, Venezuela (or their adjectives,
//      "Iranian", "Russia-related"); or
//   2. the title has a programme word ("General License", "Sanctions Regulations", "Executive
//      Order", "country", "program") and names any country at all.
// Over-flagging costs a click on "Reviewed"; missing a new country programme costs more.

const ADJECTIVES = ["Cuban", "Iranian", "North Korean", "DPRK", "Russian", "Belarusian", "Chinese", "Venezuelan", "Syrian", "Ukrainian"];

export function watchedPlaceNames(): string[] {
  const names = [
    ...BLOCKED_COUNTRIES.map((p) => p.name),
    ...NO_BUYER_COUNTRIES.map((p) => p.name.replace(/\s*\(.*\)/, "")),
    ...Object.values(BLOCKED_SUBDIVISIONS).flat().map((p) => p.name),
    "Ukraine", "Syria", "Venezuela", ...ADJECTIVES,
  ];
  return [...new Set(names)];
}

const POLICY_WORDS = /\b(general licen[cs]es?|sanctions regulations|executive orders?|countr(?:y|ies)|programs?)\b/i;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function isCountryProgram(title: string): boolean {
  const watched = watchedPlaceNames().some((name) => new RegExp(`\\b${escape(name)}\\b`, "i").test(title));
  if (watched) return true;
  if (!POLICY_WORDS.test(title)) return false;
  const words = ` ${normalizeName(title)} `;
  return knownCountryNames().some((name) => name.length > 3 && words.includes(` ${name} `));
}

export type ActionsCheck = { found: number; inserted: number; flagged: number };

// Fetches the page, records actions not seen before, and says how many were new and flagged.
export async function checkRecentActions(fetcher: Fetcher = fetchText): Promise<ActionsCheck> {
  const actions = parseRecentActions(await fetcher(OFAC_RECENT_ACTIONS_URL));
  let inserted = 0;
  let flagged = 0;
  for (const a of actions) {
    const flag = isCountryProgram(a.title);
    const rows = await query(
      `insert into ofac_recent_actions (action_date, title, url, is_country_program) values ($1, $2, $3, $4)
       on conflict (action_date, title) do nothing returning id`,
      [a.date, a.title.slice(0, 1000), a.url, flag],
    );
    if (rows.length) {
      inserted++;
      if (flag) flagged++;
    }
  }
  return { found: actions.length, inserted, flagged };
}

export type FlaggedAction = { id: number; action_date: string; title: string; url: string; seen_at: Date };

export async function unreviewedCountryActions(): Promise<FlaggedAction[]> {
  return query<FlaggedAction>(
    `select id::int, to_char(action_date, 'YYYY-MM-DD') as action_date, title, url, seen_at
       from ofac_recent_actions where is_country_program and not reviewed
      order by action_date desc, id desc limit 100`,
  );
}

export async function markActionReviewed(id: number, reviewerAccountId: number): Promise<boolean> {
  const rows = await query(
    `update ofac_recent_actions set reviewed = true, reviewed_by = $2, reviewed_at = now()
      where id = $1 and not reviewed returning id`,
    [id, reviewerAccountId],
  );
  return rows.length > 0;
}
