// Screenshots of every main screen, for checking the look of a change.
//
//   node scripts/screenshots.mjs [out-dir]
//
// Needs a running app (BASE_URL, default http://localhost:3000) on a database with the
// catalog and the demo votes loaded (npm run db:seed:questions && npm run db:seed:demo),
// and Playwright with Chromium installed (npx playwright install chromium). It creates two
// throwaway accounts, shot_free and shot_paid (test data, origin 'test'), signed in by writing
// sessions directly, so it must never run against a production database (which also refuses
// test accounts itself once a production deploy has marked it).

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import pg from "pg";
import { chromium } from "playwright";

if (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production") {
  throw new Error("screenshots.mjs writes test accounts; not for production.");
}

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = process.argv[2] ?? "screenshots";
mkdirSync(OUT, { recursive: true });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sha = (s) => createHash("sha256").update(s).digest("hex");

async function signedIn(username, tier) {
  const { rows } = await pool.query(
    `insert into accounts (username, phone_hash, password_hash, consented_at, phone_verified_at, tier, origin)
     values ($1, $2, 'screenshot-no-login', now(), now(), $3, 'test')
     on conflict (username) do update set tier = excluded.tier returning id`,
    [username, sha(`shot:${username}`), tier],
  );
  const token = randomBytes(32).toString("hex");
  await pool.query(
    "insert into sessions (token_hash, account_id, expires_at) values ($1, $2, now() + interval '1 day')",
    [sha(token), rows[0].id],
  );
  return { id: rows[0].id, token };
}

// The two most-voted questions: one to show before voting, one after.
const top = await pool.query(
  `select q.id from questions q join vote_events e on e.question_id = q.id
    where q.status = 'active' group by q.id order by count(*) desc limit 2`,
);
const [unvoted, voted] = top.rows.map((r) => r.id);
if (!voted) throw new Error("No voted questions found. Run npm run db:seed:demo first.");

const free = await signedIn("shot_free", "free");
const paid = await signedIn("shot_paid", "paid");
await pool.query("delete from votes where account_id = $1", [free.id]);
await pool.query("delete from vote_events where account_id = $1", [free.id]);
await pool.query(
  "insert into votes (account_id, question_id, value, is_private) values ($1, $2, 'true', false)",
  [free.id, voted],
);
await pool.query(
  "insert into vote_events (account_id, question_id, action, value, is_private, source, blind) values ($1, $2, 'cast', 'true', false, 'direct', true)",
  [free.id, voted],
);
await pool.end();

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

// [file name, who, path, layout, full page]
const SHOTS = [
  ["home-compact-visitor", null, "/", "compact", true],
  ["home-tiles-visitor", null, "/", "tiles", true],
  ["home-swipe-visitor", null, "/", "swipe", false],
  ["home-compact-free", free, "/", "compact", true],
  ["home-tiles-free", free, "/", "tiles", true],
  ["home-swipe-free", free, "/", "swipe", false],
  ["question-before-vote-free", free, `/q/${unvoted}`, "compact", true],
  ["question-after-vote-free", free, `/q/${voted}`, "compact", true],
  ["question-paid", paid, `/q/${voted}`, "compact", true],
  ["search-ask-now-free", free, "/search?q=Is%20a%20hot%20dog%20a%20sandwich", "compact", true],
  ["signup-visitor", null, "/signup", "compact", true],
];

const browser = await chromium.launch();
for (const [device, options] of Object.entries(VIEWPORTS)) {
  for (const [name, who, path, layout, fullPage] of SHOTS) {
    const context = await browser.newContext({ ...options, colorScheme: "dark" });
    const cookies = [{ name: "bm_view", value: layout, url: BASE }];
    if (who) cookies.push({ name: "bm_session", value: who.token, url: BASE });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto(BASE + path, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400); // charts draw after hydration
    await page.screenshot({ path: `${OUT}/${device}-${name}.png`, fullPage });
    await context.close();
    console.log(`${device}-${name}`);
  }
}
await browser.close();
