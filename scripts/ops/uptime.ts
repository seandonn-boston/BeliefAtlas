// The checks behind scripts/ops/uptime-check.ts, kept apart from the command line so tests
// can run them against a local server.
//
// Two pages are checked: the home page (server rendering and the database behind it) and
// the public feed API (route handlers, the rate limiter and a JSON response). Each is
// retried a couple of times so one slow cold start doesn't page anyone.

export type CheckResult = {
  name: string;
  url: string;
  ok: boolean;
  status: number | null;
  ms: number;
  attempts: number;
  detail?: string;
};

export type UptimeOptions = {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
};

type Probe = { name: string; path: string; verify: (response: Response) => Promise<string | null> };

// Each verify returns null when the response is healthy, or a short reason when it isn't.
const PROBES: Probe[] = [
  {
    name: "home",
    path: "/",
    verify: async (response) => {
      if (response.status !== 200) return `status ${response.status}`;
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("text/html")) return `expected HTML, got ${type || "no content-type"}`;
      const body = await response.text();
      return body.includes("<html") ? null : "response is not an HTML page";
    },
  },
  {
    name: "feed",
    path: "/api/feed",
    verify: async (response) => {
      // A rate-limited answer still proves the route, the limiter and the database are up.
      if (response.status === 429) return null;
      if (response.status !== 200) return `status ${response.status}`;
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return "response is not JSON";
      }
      const items = (data as { items?: unknown } | null)?.items;
      return Array.isArray(items) ? null : "JSON has no items array";
    },
  },
];

export function normaliseBaseUrl(raw: string | undefined): URL {
  if (!raw || !raw.trim()) throw new Error("no base URL: pass one as the first argument or set UPTIME_URL");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("base URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("base URL must be http or https");
  if (url.username || url.password) throw new Error("base URL must not carry credentials");
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(base: URL, p: Probe, options: Required<UptimeOptions>): Promise<CheckResult> {
  const url = new URL(p.path.replace(/^\//, ""), base).toString();
  let last: CheckResult = { name: p.name, url, ok: false, status: null, ms: 0, attempts: 0 };
  for (let attempt = 1; attempt <= options.retries + 1; attempt++) {
    const started = Date.now();
    try {
      const response = await options.fetchImpl(url, {
        redirect: "follow",
        cache: "no-store",
        headers: { "user-agent": "BeliefAtlas-uptime-check/1", accept: p.name === "feed" ? "application/json" : "text/html" },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const problem = await p.verify(response);
      last = { name: p.name, url, ok: problem === null, status: response.status, ms: Date.now() - started, attempts: attempt };
      if (problem) last.detail = problem;
      else if (response.status === 429) last.detail = "rate limited (counted as up)";
    } catch (err) {
      const e = err as Error;
      const detail = e.name === "TimeoutError" ? `timed out after ${options.timeoutMs} ms` : e.message;
      last = { name: p.name, url, ok: false, status: null, ms: Date.now() - started, attempts: attempt, detail };
    }
    if (last.ok) return last;
    if (attempt <= options.retries) await sleep(options.retryDelayMs * attempt);
  }
  return last;
}

export async function checkSite(baseUrl: string, opts: UptimeOptions = {}): Promise<CheckResult[]> {
  const base = normaliseBaseUrl(baseUrl);
  const options: Required<UptimeOptions> = {
    timeoutMs: opts.timeoutMs ?? 10_000,
    retries: opts.retries ?? 2,
    retryDelayMs: opts.retryDelayMs ?? 2_000,
    fetchImpl: opts.fetchImpl ?? fetch,
  };
  return Promise.all(PROBES.map((p) => probe(base, p, options)));
}
