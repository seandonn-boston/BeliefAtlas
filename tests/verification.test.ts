// The age, phone line-type and human checks on their own, with network calls replaced.
// No database needed.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ageOn, checkAdult, earliestToday, parseDob } from "../lib/age";
import { humanChallenge, turnstile } from "../lib/human-check";
import { judgeLineType, lineTypeChecker, twilioLookup } from "../lib/phone-check";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("age: dates are parsed strictly", () => {
  assert.deepEqual(parseDob("1990-05-01"), { year: 1990, month: 5, day: 1 });
  assert.equal(parseDob("1990-02-30"), null);
  assert.equal(parseDob("1990-5-1"), null);
  assert.equal(parseDob("05/01/1990"), null);
  assert.equal(parseDob(""), null);
});

test("age: whole years, birthday counted from its first day", () => {
  assert.equal(ageOn({ year: 2008, month: 6, day: 15 }, { year: 2026, month: 6, day: 14 }), 17);
  assert.equal(ageOn({ year: 2008, month: 6, day: 15 }, { year: 2026, month: 6, day: 15 }), 18);
  // 29 February birthdays arrive on 1 March in other years.
  assert.equal(ageOn({ year: 2008, month: 2, day: 29 }, { year: 2026, month: 2, day: 28 }), 17);
  assert.equal(ageOn({ year: 2008, month: 2, day: 29 }, { year: 2026, month: 3, day: 1 }), 18);
  assert.equal(ageOn({ year: 2008, month: 2, day: 29 }, { year: 2028, month: 2, day: 29 }), 20);
});

test("age: the 18+ gate uses the earliest date anywhere on Earth", () => {
  // 05:00 UTC on 15 June is still 14 June at UTC-12.
  const now = new Date(Date.UTC(2026, 5, 15, 5));
  assert.deepEqual(earliestToday(now), { year: 2026, month: 6, day: 14 });
  const turning = checkAdult("2008-06-15", now);
  assert.equal(turning.ok, false);
  assert.equal(!turning.ok && turning.underage, true);
  assert.equal(checkAdult("2008-06-15", new Date(Date.UTC(2026, 5, 15, 13))).ok, true);
  assert.equal(checkAdult("1950-01-01", now).ok, true);
  const future = checkAdult("2030-01-01", now);
  assert.equal(!future.ok && future.underage, false);
  const ancient = checkAdult("1880-01-01", now);
  assert.equal(!ancient.ok && ancient.underage, false);
  const blank = checkAdult("", now);
  assert.equal(!blank.ok && blank.underage, false);
});

test("line type: mobiles pass, VoIP, landlines and the rest don't", () => {
  assert.equal(judgeLineType("mobile", true).ok, true);
  assert.equal(judgeLineType("personal", true).ok, true);
  for (const t of ["nonFixedVoip", "fixedVoip", "landline", "tollFree", "premium", "pager", "voicemail"] as const) {
    assert.equal(judgeLineType(t, true).ok, false, t);
  }
  assert.equal(judgeLineType("unknown", true).ok, true);
  assert.equal(judgeLineType("unknown", false).ok, false);
});

test("line type: Twilio Lookup is asked the right way and its answer applied", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  let type: string | null = "mobile";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization") });
    return new Response(JSON.stringify({ valid: true, line_type_intelligence: { type } }), { status: 200 });
  }) as typeof fetch;
  const lookup = twilioLookup("AC_test", "token_test", true);
  assert.deepEqual(await lookup.check("+16175550100"), { ok: true, lineType: "mobile" });
  assert.equal(calls[0].url, "https://lookups.twilio.com/v2/PhoneNumbers/%2B16175550100?Fields=line_type_intelligence");
  assert.equal(calls[0].auth, `Basic ${Buffer.from("AC_test:token_test").toString("base64")}`);

  type = "nonFixedVoip";
  assert.equal((await lookup.check("+16175550101")).ok, false);
  type = null; // Twilio couldn't classify it
  assert.deepEqual(await lookup.check("+16175550102"), { ok: true, lineType: "unknown" });
  assert.equal((await twilioLookup("AC_test", "token_test", false).check("+16175550102")).ok, false);
  type = "somethingNew";
  assert.deepEqual(await lookup.check("+16175550103"), { ok: true, lineType: "unknown" });

  globalThis.fetch = (async () => new Response(JSON.stringify({ valid: false }), { status: 200 })) as typeof fetch;
  assert.equal((await lookup.check("+10000000000")).ok, false);

  // An outage lets the number through to the texted code rather than closing signups.
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  assert.deepEqual(await lookup.check("+16175550104"), { ok: true, lineType: "unknown" });
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  assert.deepEqual(await lookup.check("+16175550105"), { ok: true, lineType: "unknown" });
});

test("line type: the checker is chosen from the environment", async () => {
  assert.equal(lineTypeChecker({} as NodeJS.ProcessEnv).name, "none");
  assert.deepEqual(await lineTypeChecker({} as NodeJS.ProcessEnv).check("+16175550100"), { ok: true, lineType: "unknown" });
  const env = { PHONE_LINE_CHECK: "twilio", TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "t" } as unknown as NodeJS.ProcessEnv;
  assert.equal(lineTypeChecker(env).name, "twilio");
  const broken = lineTypeChecker({ PHONE_LINE_CHECK: "twilio" } as unknown as NodeJS.ProcessEnv);
  assert.equal((await broken.check("+16175550100")).ok, false);
});

test("human check: development bypass, closed in production without keys", async () => {
  const dev = humanChallenge({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
  assert.equal(dev.name, "dev");
  assert.equal(dev.siteKey, null);
  assert.deepEqual(await dev.verify("", "1.2.3.4", "signup"), { ok: true });

  const prod = humanChallenge({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  assert.equal(prod.name, "off");
  assert.equal((await prod.verify("anything", "1.2.3.4", "signup")).ok, false);

  const on = humanChallenge({ NODE_ENV: "production", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" } as unknown as NodeJS.ProcessEnv);
  assert.equal(on.name, "turnstile");
  assert.equal(on.siteKey, "site");
});

test("human check: Turnstile tokens are verified with Cloudflare", async () => {
  const bodies: string[] = [];
  let answer: Record<string, unknown> = { success: true, action: "signup" };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    bodies.push(String(init.body));
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
  const check = turnstile("site", "secret");

  assert.deepEqual(await check.verify("tok", "1.2.3.4", "signup"), { ok: true });
  assert.equal(bodies[0], "secret=secret&response=tok&remoteip=1.2.3.4");
  await check.verify("tok", "local", "signup");
  assert.equal(bodies[1], "secret=secret&response=tok"); // no IP when there isn't a real one

  assert.equal((await check.verify("", "1.2.3.4", "signup")).ok, false);
  assert.equal(bodies.length, 2); // an empty token never reaches Cloudflare

  answer = { success: true, action: "login" };
  assert.equal((await check.verify("tok", "1.2.3.4", "signup")).ok, false);
  answer = { success: false, "error-codes": ["invalid-input-response"] };
  assert.equal((await check.verify("tok", "1.2.3.4", "signup")).ok, false);

  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  assert.equal((await check.verify("tok", "1.2.3.4", "signup")).ok, false);
});
