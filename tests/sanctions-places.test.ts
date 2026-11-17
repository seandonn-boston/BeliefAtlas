// Sanctioned places: the whole site is unavailable from Iran, North Korea, Cuba, Russia, Belarus
// and occupied Crimea, Sevastopol, Donetsk and Luhansk; phone numbers from blocked countries are
// refused at signup and sign-in; no buyers or organisations from blocked countries, China or
// Venezuela; and answers from China, Hong Kong and Macau are never sold. The database tests run
// against DATABASE_URL and clean up.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import { pool, query } from "../lib/db";
import { currentText, recordConsent, type ConsentContext } from "../lib/consent";
import { saleAllowed, saleOpenIn } from "../lib/regions";
import { startSignup } from "../lib/signup";
import { startSmsLogin } from "../lib/login";
import {
  BLOCKED_COUNTRIES, noBuyersFrom, phoneBlocked, PHONE_NOT_AVAILABLE, placeBlocked,
} from "../lib/sanctions/places";
import { proxy } from "../proxy";

const tag = `sanc${Date.now().toString(36)}`;
const OPEN = "XB"; // a user-assigned ISO code, used here as a region open to sale

test("whole countries are blocked: Iran, North Korea, Cuba, Russia, Belarus", () => {
  for (const c of ["IR", "KP", "CU", "RU", "BY", "ru", " by "]) assert.ok(placeBlocked(c), c);
  assert.deepEqual(BLOCKED_COUNTRIES.map((p) => p.code).sort(), ["BY", "CU", "IR", "KP", "RU"]);
});

test("occupied Ukraine is blocked by region; the rest of Ukraine is open", () => {
  for (const r of ["43", "UA-43", "40", "14", "09", "ua-09"]) assert.ok(placeBlocked("UA", r), r);
  for (const r of ["30", "46", "UA-32", null, ""]) assert.equal(placeBlocked("UA", r), null, String(r));
  // A region code only means something with its own country.
  assert.equal(placeBlocked("PL", "14"), null);
});

test("open places stay open: Syria (sanctions lifted), China, Venezuela, the US, and unknown", () => {
  for (const c of ["SY", "CN", "HK", "VE", "US", "KZ", "UA", null, undefined, ""]) assert.equal(placeBlocked(c), null, String(c));
});

test("phone numbers from blocked countries are recognised; Kazakhstan's +7 numbers are not", () => {
  assert.equal(phoneBlocked("+375291234567"), "BY");
  assert.equal(phoneBlocked("+79161234567"), "RU");
  assert.equal(phoneBlocked("+7 495 123-45-67"), "RU");
  assert.equal(phoneBlocked("+989121234567"), "IR");
  assert.equal(phoneBlocked("+8501912345678"), "KP");
  assert.equal(phoneBlocked("+5351234567"), "CU");
  for (const n of ["+77011234567", "+76221234567", "+12025550123", "+380441234567", "+963112345678", "+8613812345678"]) {
    assert.equal(phoneBlocked(n), null, n);
  }
});

test("no buyers or organisations from blocked countries, China, Hong Kong, Macau or Venezuela", () => {
  for (const c of ["RU", "BY", "IR", "KP", "CU", "CN", "HK", "MO", "VE", "cn"]) assert.equal(noBuyersFrom(c), true, c);
  for (const c of ["US", "GB", "UA", "SY", "KZ"]) assert.equal(noBuyersFrom(c), false, c);
  assert.equal(noBuyersFrom(null), true, "no stated country, no approval");
});

const req = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(new URL(path, "https://example.com"), { headers });

test("every page from a blocked place gets one plain 451 page, in the visitor's language", async () => {
  for (const [country, region] of [["RU", ""], ["BY", ""], ["IR", ""], ["UA", "43"], ["UA", "14"]]) {
    const res = proxy(req("/v/1", { "x-vercel-ip-country": country, "x-vercel-ip-country-region": region }));
    assert.equal(res.status, 451, `${country} ${region}`);
    assert.match(await res.text(), /Not available here/);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  const es = proxy(req("/signup", { "x-vercel-ip-country": "CU", cookie: "cm_lang=es" }));
  assert.match(await es.text(), /No disponible aquí/);
  const accept = proxy(req("/", { "x-vercel-ip-country": "KP", "accept-language": "es-MX,es;q=0.9" }));
  assert.match(await accept.text(), /No disponible aquí/);
});

test("API calls from a blocked place get the same answer as JSON", async () => {
  const res = proxy(req("/api/vote", { "x-vercel-ip-country": "BY" }));
  assert.equal(res.status, 451);
  assert.equal((await res.json()).error, "unavailable_here");
});

test("everyone else passes straight through", () => {
  const open: Record<string, string>[] = [{ "x-vercel-ip-country": "US" }, { "x-vercel-ip-country": "UA", "x-vercel-ip-country-region": "30" },
                   { "x-vercel-ip-country": "CN" }, { "x-vercel-ip-country": "SY" }, {}];
  for (const h of open) {
    const res = proxy(req("/", h));
    assert.equal(res.headers.get("x-middleware-next"), "1", JSON.stringify(h));
  }
});

const signupInput = (phone: string) => ({ phone, dob: "1990-01-01", next: "/", ip: "198.51.100.7", device: "d", challengeToken: "" });

test("signup and texted sign-in refuse numbers from blocked countries before anything is sent", async () => {
  for (const phone of ["+375 29 123 4567", "+7 916 123 45 67", "+98 912 123 4567", "+850 191 234 5678", "+53 5 123 4567"]) {
    assert.deepEqual(await startSignup(signupInput(phone)), { ok: false, error: PHONE_NOT_AVAILABLE }, phone);
    assert.deepEqual(await startSmsLogin(phone, "198.51.100.7", "/"), { ok: false, error: PHONE_NOT_AVAILABLE }, phone);
  }
});

// ---------- China: voters welcome, answers never sold ----------

const ctx = (region: string | null): ConsentContext => ({ gpc: false, region, surface: "web", lang: "en" });
let n = 0;
async function sellerIn(region: string) {
  const name = `${tag}_${n++}`;
  const [row] = await query<{ id: number }>(
    "insert into accounts (username, phone_hash, password_hash, consented_at) values ($1, $1, 'x', now()) returning id", [name]);
  const answering = await currentText("answering", "en");
  const sale = await currentText("sale", "en");
  assert.ok((await recordConsent({ accountId: row.id, choice: "answering", granted: true, version: answering!.version, lang: "en" }, ctx(region))).ok);
  assert.ok((await recordConsent({ accountId: row.id, choice: "sale", granted: true, version: sale!.version, lang: "en" }, ctx(region))).ok);
  return row.id;
}

before(async () => {
  await query("insert into regions (code, name, sale_allowed) values ($1, 'Test region open to sale', true) on conflict (code) do update set sale_allowed = true", [OPEN]);
});

after(async () => {
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await query("delete from regions where code = $1", [OPEN]);
  await pool.end();
});

test("China, Hong Kong and Macau are closed to sale, and the database refuses to open them", async () => {
  for (const c of ["CN", "HK", "MO", "cn"]) assert.equal(await saleOpenIn(c), false, c);
  await assert.rejects(query("update regions set sale_allowed = true where code = 'CN'"), /regions_never_sell/);
});

test("someone ever seen in China is never sold, even after moving to a region open to sale", async () => {
  const elsewhere = await sellerIn(OPEN);
  assert.equal(await saleAllowed(elsewhere), true, "the control: an opted-in account in an open region");

  const moved = await sellerIn(OPEN);
  const answering = await currentText("answering", "en");
  // One later record made from China is enough, wherever they are now.
  await recordConsent({ accountId: moved, choice: "answering", granted: true, version: answering!.version, lang: "en" }, ctx("CN"));
  await query("update accounts set region = $2 where id = $1", [moved, OPEN]);
  assert.equal(await saleAllowed(moved), false);

  const there = await sellerIn(OPEN);
  await query("update accounts set region = 'HK' where id = $1", [there]);
  assert.equal(await saleAllowed(there), false);
});
