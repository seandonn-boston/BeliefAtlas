// Structured logger: line shape, levels, and redaction of anything that could identify or
// authenticate someone. No database needed.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { format, isSensitiveKey, logger, REDACTED, redact, requestIdFrom, scrub, setLogSink, type Level } from "../lib/log";
import { onRequestError, register } from "../instrumentation";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  delete process.env.LOG_LEVEL;
});

function capture(): Array<{ line: Record<string, unknown>; level: Level; raw: string }> {
  const lines: Array<{ line: Record<string, unknown>; level: Level; raw: string }> = [];
  restore = setLogSink((raw, level) => lines.push({ line: JSON.parse(raw), level, raw }));
  return lines;
}

test("a line has level, msg, time, request id and fields, as one JSON object", () => {
  const lines = capture();
  logger.child({ requestId: "req-123" }).info("vote recorded", { questionId: 42, answer: "true" });
  assert.equal(lines.length, 1);
  const { line, raw } = lines[0];
  assert.equal(raw.includes("\n"), false);
  assert.equal(line.level, "info");
  assert.equal(line.msg, "vote recorded");
  assert.equal(line.requestId, "req-123");
  assert.equal(line.questionId, 42);
  assert.equal(line.answer, "true");
  assert.ok(!Number.isNaN(Date.parse(String(line.time))));
});

test("fields cannot overwrite level, msg or time", () => {
  const line = format("warn", "real message", { level: "debug", msg: "fake", time: "never" });
  assert.equal(line.level, "warn");
  assert.equal(line.msg, "real message");
  assert.notEqual(line.time, "never");
  assert.equal(line.field_level, "debug");
  assert.equal(line.field_msg, "fake");
});

test("LOG_LEVEL filters lower levels; errors go to the error stream", () => {
  const lines = capture();
  process.env.LOG_LEVEL = "warn";
  logger.debug("hidden");
  logger.info("hidden");
  logger.warn("shown");
  logger.error("shown too");
  assert.deepEqual(
    lines.map((l) => [l.level, l.line.msg]),
    [
      ["warn", "shown"],
      ["error", "shown too"],
    ],
  );
  process.env.LOG_LEVEL = "debug";
  logger.debug("now shown");
  assert.equal(lines.at(-1)?.line.msg, "now shown");
});

test("sensitive keys are redacted whatever their value", () => {
  const sensitive = [
    "phone",
    "phoneNumber",
    "e164",
    "token",
    "sessionToken",
    "access_token",
    "code",
    "smsCode",
    "verificationCode",
    "recoveryCodes",
    "pin",
    "accountPin",
    "otp",
    "totp_secret",
    "password",
    "passwordHash",
    "cookie",
    "Cookie",
    "set-cookie",
    "authorization",
    "Authorization",
    "proxy-authorization",
    "x-api-key",
    "apiKey",
    "PHONE_PEPPER",
    "STRIPE_WEBHOOK_SECRET",
    "session",
  ];
  for (const key of sensitive) assert.equal(isSensitiveKey(key), true, key);
  const ordinary = ["questionId", "statusCode", "errorCode", "countryCode", "username", "route", "digest", "answer", "count", "spinner"];
  for (const key of ordinary) assert.equal(isSensitiveKey(key), false, key);
});

test("redaction reaches nested objects, arrays, Maps and Headers", () => {
  const headers = new Headers({ cookie: "sid=abc123456", authorization: "Bearer abcdefghijkl", "user-agent": "test" });
  const out = redact({
    account: { id: 7, phone: "+16175550100", password: "hunter2hunter2" },
    attempts: [{ code: "123456" }, { code: 654321 }],
    extra: new Map([["token", "t0ken-value"]]),
    headers,
  }) as Record<string, Record<string, unknown>>;
  assert.deepEqual(out.account, { id: 7, phone: REDACTED, password: REDACTED });
  assert.deepEqual(out.attempts, [{ code: REDACTED }, { code: REDACTED }]);
  assert.deepEqual(out.extra, { token: REDACTED });
  assert.equal(out.headers.cookie, REDACTED);
  assert.equal(out.headers.authorization, REDACTED);
  assert.equal(out.headers["user-agent"], "test");
});

test("secrets inside text are scrubbed from messages, values and errors", () => {
  const cases: Array<[string, string]> = [
    ["texted +1 617-555-0100 a code", "+1 617-555-0100"],
    ["call (617) 555-0100 now", "555-0100"],
    ["number +447700900123 rejected", "+447700900123"],
    ["your code is 482913", "482913"],
    ["PIN 4321 accepted", "4321"],
    ["GET /login/code?code=771234&next=/me", "771234"],
    ["password=hunter2 token: abc.def", "hunter2"],
    ["token: abcdefghi", "abcdefghi"],
    ["Authorization: Bearer abcdefghijklmnop", "abcdefghijklmnop"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl here", "eyJzdWIiOiIxMjMifQ"],
    ["key sk_live_51Habcdefghijk", "sk_live_51Habcdefghijk"],
    ["whsec_abcdef123456 leaked", "whsec_abcdef123456"],
    ["cookie: sid=deadbeefcafe", "deadbeefcafe"],
  ];
  for (const [input, secret] of cases) {
    const out = scrub(input);
    assert.equal(out.includes(secret), false, `${input} -> ${out}`);
  }
  // Ordinary numbers stay readable.
  assert.equal(scrub("question 123456 has 42 votes at 2026-11-17T18:10:00Z"), "question 123456 has 42 votes at 2026-11-17T18:10:00Z");

  const lines = capture();
  const err = new Error("twilio rejected +16175550100 with code 123456");
  logger.error("send failed for +1 (617) 555-0100", { error: err, note: "password=letmein" });
  const raw = lines[0].raw;
  for (const secret of ["6175550100", "617) 555-0100", "123456", "letmein"]) assert.equal(raw.includes(secret), false, secret);
  const logged = lines[0].line.error as Record<string, unknown>;
  assert.equal(logged.name, "Error");
  assert.match(String(logged.stack), /^Error: /);
});

test("circular values and odd types never make logging throw", () => {
  const lines = capture();
  const loop: Record<string, unknown> = { name: "loop" };
  loop.self = loop;
  logger.info("odd", { loop, big: BigInt(10), fn: () => 1, when: new Date(0), nan: Number.NaN });
  const line = lines[0].line;
  assert.deepEqual(line.loop, { name: "loop", self: "[circular]" });
  assert.equal(line.big, "10");
  assert.equal(line.fn, null);
  assert.equal(line.when, "1970-01-01T00:00:00.000Z");
  assert.equal(line.nan, "NaN");
});

test("request ids come from known headers and are validated", () => {
  assert.equal(requestIdFrom({ "x-request-id": "abc-123" }), "abc-123");
  assert.equal(requestIdFrom({ "x-vercel-id": ["iad1::xyz-1"] }), "iad1::xyz-1");
  assert.equal(requestIdFrom(new Headers({ "x-correlation-id": "c.1" })), "c.1");
  assert.equal(requestIdFrom({ "x-request-id": "has spaces and \"quotes\"" }), undefined);
  assert.equal(requestIdFrom({}), undefined);
  assert.equal(requestIdFrom(undefined), undefined);
});

test("onRequestError logs route and digest, never headers, query strings or bodies", async () => {
  const lines = capture();
  const err = Object.assign(new Error("boom for +16175550100"), { digest: "123abc" });
  await onRequestError(
    err,
    {
      path: "/login/code?code=771234",
      method: "POST",
      headers: { cookie: "session=secret-session-value", authorization: "Bearer abcdefghijkl", "x-request-id": "rid-9" },
    },
    {
      routerKind: "App Router",
      routePath: "/login/code",
      routeType: "action",
      renderSource: "react-server-components",
      revalidateReason: undefined,
      renderType: "dynamic",
    } as Parameters<typeof onRequestError>[2],
  );
  assert.equal(lines.length, 1);
  const { line, raw, level } = lines[0];
  assert.equal(level, "error");
  assert.equal(line.msg, "request failed");
  assert.equal(line.route, "/login/code");
  assert.equal(line.digest, "123abc");
  assert.equal(line.path, "/login/code");
  assert.equal(line.requestId, "rid-9");
  assert.equal(line.kind, "action");
  for (const secret of ["771234", "secret-session-value", "abcdefghijkl", "6175550100"]) assert.equal(raw.includes(secret), false, secret);
  assert.equal("headers" in line, false);
  assert.equal("body" in line, false);
});

test("register logs a start-up line", () => {
  const lines = capture();
  register();
  assert.equal(lines[0].line.msg, "server starting");
});
