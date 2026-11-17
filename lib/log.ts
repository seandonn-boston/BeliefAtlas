// Structured logs: one JSON object per line, which Vercel's log view (or any log shipper)
// can search and filter. Every line has level, msg and time, the request id when known, and
// whatever fields the caller adds.
//
// Redaction runs on every line before it is written, so phone numbers, tokens, codes,
// passwords, cookies and authorization headers never reach a log, even when a caller passes
// a whole object by mistake. Two layers:
//   1. Keys: a field whose name looks sensitive (phone, token, password, cookie, code, pin...)
//      is replaced with "[redacted]" whatever its value.
//   2. Text: every string (the message, error messages and stacks, field values) is scrubbed
//      for phone numbers, bearer tokens, JWTs, provider keys and key=value secrets.
//
// No Node-only imports: instrumentation.ts runs in both the Node.js and Edge runtimes.

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export const REDACTED = "[redacted]";

// ---------- Key-based redaction ----------

// Matched against the key lowercased with everything but letters and digits removed, so
// "Set-Cookie", "x_api_key" and "phoneNumber" all normalise to something on this list.
const SENSITIVE_KEY_PARTS = [
  "phone",
  "e164",
  "msisdn",
  "token",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "cookie",
  "authorization",
  "apikey",
  "pepper",
  "credential",
  "session",
  "otp",
  "totp",
  "signature",
  "privatekey",
];
// Keys that end in "code" or "pin" (code, smsCode, verificationCode, recoveryCodes, accountPin)
// hold one-time codes and PINs. These "...code" keys are ordinary diagnostics and stay.
const SAFE_CODE_KEYS = new Set(["statuscode", "errorcode", "exitcode", "httpcode", "countrycode", "langcode", "languagecode"]);

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!k) return false;
  if (SENSITIVE_KEY_PARTS.some((part) => k.includes(part))) return true;
  if (SAFE_CODE_KEYS.has(k)) return false;
  return /codes?$/.test(k) || /pins?$/.test(k) || k === "auth";
}

// ---------- Text-based redaction ----------

const TEXT_RULES: Array<[RegExp, string]> = [
  // Authorization header values and bearer tokens.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Provider keys and webhook secrets (Stripe, Anthropic, GitHub, Twilio-style SIDs).
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{6,}/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9]{6,}/g, REDACTED],
  [/\bsk-ant-[A-Za-z0-9_-]{6,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\b(AC|SK|VA)[0-9a-f]{32}\b/g, REDACTED],
  // key=value and key: value pairs in query strings, cookies and messages.
  [
    /\b(password|passwd|pass|pwd|token|access_token|refresh_token|id_token|session|sid|secret|api[_-]?key|apikey|code|otp|pin|cookie|auth|authorization)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,"']+)/gi,
    `$1$2${REDACTED}`,
  ],
  // "code 123456", "your code is 123456", "PIN 1234".
  [/\b(code|otp|pin|passcode)(\s+is)?(\s+)\d{4,8}\b/gi, `$1$2$3${REDACTED}`],
  // Phone numbers: international (+ and 8 to 15 digits, with common separators) and North
  // American ten-digit forms. Plain ids and timestamps have no + or separators, so they stay.
  [/\+\d[\d\s().-]{6,18}\d/g, "[phone]"],
  [/(?<![\w+])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "[phone]"],
];

export function scrub(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TEXT_RULES) out = out.replace(pattern, replacement);
  return out;
}

// ---------- Values ----------

const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_STRING = 4000;
const STACK_LINES = 8;

type Plain = string | number | boolean | null | Plain[] | { [key: string]: Plain };

function errorFields(err: Error, seen: WeakSet<object>, depth: number): { [key: string]: Plain } {
  const out: { [key: string]: Plain } = { name: err.name, message: scrub(err.message) };
  const digest = (err as { digest?: unknown }).digest;
  if (digest !== undefined) out.digest = String(digest);
  const code = (err as { code?: unknown }).code;
  // An error's code is a diagnostic (ECONNREFUSED, 23505), not a one-time code.
  if (typeof code === "string" || typeof code === "number") out.errorCode = scrub(String(code));
  if (err.stack) out.stack = scrub(err.stack.split("\n").slice(0, STACK_LINES).join("\n"));
  if (err.cause !== undefined) out.cause = redact(err.cause, seen, depth + 1);
  return out;
}

// Returns a JSON-safe copy of value with sensitive keys and text removed.
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): Plain {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return scrub(value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== "object") return null;
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[depth]";
  seen.add(value);
  if (value instanceof Error) return errorFields(value, seen, depth);
  if (typeof Headers !== "undefined" && value instanceof Headers) {
    return redact(Object.fromEntries(value.entries()), seen, depth + 1);
  }
  if (value instanceof URL) return redact(value.toString(), seen, depth + 1);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => redact(v, seen, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`[+${value.length - MAX_ARRAY} more]`);
    return items;
  }
  if (value instanceof Map) return redact(Object.fromEntries(value), seen, depth + 1);
  if (value instanceof Set) return redact([...value], seen, depth + 1);
  const out: { [key: string]: Plain } = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(v, seen, depth + 1);
  }
  return out;
}

// ---------- Request ids ----------

// The id a platform or proxy gave this request, when there is one: Vercel's x-vercel-id,
// or a conventional x-request-id / x-correlation-id. Accepts a Headers object or the plain
// header record Next passes to onRequestError.
export function requestIdFrom(headers: Headers | Record<string, string | string[] | undefined> | undefined | null): string | undefined {
  if (!headers) return undefined;
  const get = (name: string): string | undefined => {
    if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name) ?? undefined;
    const raw = (headers as Record<string, string | string[] | undefined>)[name];
    return Array.isArray(raw) ? raw[0] : raw;
  };
  const id = get("x-request-id") ?? get("x-vercel-id") ?? get("x-correlation-id");
  // Ids are short opaque strings; anything else is not trusted into the log.
  return id && /^[A-Za-z0-9:._-]{1,128}$/.test(id) ? id : undefined;
}

// ---------- Output ----------

export type LogLine = { level: Level; msg: string; time: string; requestId?: string } & Record<string, Plain | undefined>;
type Sink = (line: string, level: Level) => void;

const defaultSink: Sink = (line, level) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};
let sink: Sink = defaultSink;

// For tests: capture lines instead of printing them. Returns a function that restores output.
export function setLogSink(next: Sink | null): () => void {
  const previous = sink;
  sink = next ?? defaultSink;
  return () => {
    sink = previous;
  };
}

function threshold(): number {
  const configured = (typeof process !== "undefined" ? process.env.LOG_LEVEL : undefined)?.toLowerCase();
  return configured && configured in LEVELS ? LEVELS[configured as Level] : LEVELS.info;
}

const RESERVED = new Set(["level", "msg", "time", "requestId"]);

// Builds the line without writing it. Exported for tests.
export function format(level: Level, msg: string, fields: Fields = {}): LogLine {
  const { requestId, ...rest } = fields;
  const line: LogLine = { level, msg: scrub(String(msg)), time: new Date().toISOString() };
  if (typeof requestId === "string" && requestId) line.requestId = scrub(requestId);
  const clean = redact(rest);
  if (clean && typeof clean === "object" && !Array.isArray(clean)) {
    for (const [key, value] of Object.entries(clean)) line[RESERVED.has(key) ? `field_${key}` : key] = value;
  }
  return line;
}

export function log(level: Level, msg: string, fields?: Fields): void {
  if (LEVELS[level] < threshold()) return;
  let text: string;
  try {
    text = JSON.stringify(format(level, msg, fields));
  } catch {
    // Never let logging throw into the caller.
    text = JSON.stringify({ level, msg: scrub(String(msg)), time: new Date().toISOString(), logError: "unserialisable fields" });
  }
  sink(text, level);
}

export type Logger = {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  // A logger that adds these fields (a requestId, a job id) to every line.
  child(bound: Fields): Logger;
};

function make(bound: Fields): Logger {
  const at = (level: Level) => (msg: string, fields?: Fields) => log(level, msg, { ...bound, ...fields });
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (more) => make({ ...bound, ...more }),
  };
}

export const logger: Logger = make({});
