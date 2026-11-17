// Operations scripts: migration naming, the uptime check against a local server, and the
// backup shell scripts parsing cleanly. No database needed.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { checkMigrationNames, LEGACY_MIGRATIONS, MIGRATION_NAME } from "../scripts/ops/check-migrations";
import { checkSite, normaliseBaseUrl } from "../scripts/ops/uptime";

const root = path.join(__dirname, "..");

// ---------- Migration names ----------

test("the migrations in the repository pass the naming check", () => {
  const files = readdirSync(path.join(root, "db", "migrations")).filter((f) => !f.startsWith("."));
  const report = checkMigrationNames(files);
  assert.deepEqual(report.errors, []);
});

test("new migrations need the timestamped name; only the original seven keep 00N_", () => {
  assert.equal(LEGACY_MIGRATIONS.size, 7);
  assert.match("20261117_1810_stage2_contracts.sql", MIGRATION_NAME);
  const bad = [
    "008_next_thing.sql",
    "001_init_again.sql",
    "20261117_1810_Stage2.sql",
    "20261117-1810_stage2.sql",
    "2026111_1810_short.sql",
    "20261117_1810_.sql",
    "20261117_1810_stage2.SQL",
    "20261117_1810_stage2.sql.bak",
    "README.md",
  ];
  for (const name of bad) assert.equal(checkMigrationNames([name]).errors.length, 1, name);
  const ok = checkMigrationNames([...LEGACY_MIGRATIONS, "20261118_0930_translations.sql", "20261118_0931_merges_v2.sql"]);
  assert.deepEqual(ok, { errors: [], warnings: [] });
});

test("impossible times and shared timestamps warn without failing", () => {
  const report = checkMigrationNames(["20261340_2599_odd.sql", "20261118_0930_a.sql", "20261118_0930_b.sql"]);
  assert.deepEqual(report.errors, []);
  assert.equal(report.warnings.length, 2);
});

// ---------- Uptime ----------

type Handler = (path: string) => { status: number; type?: string; body?: string; delayMs?: number };
let server: Server;
let base = "";
let handler: Handler = () => ({ status: 200 });

before(async () => {
  server = createServer((req, res) => {
    const h = handler(req.url ?? "/");
    setTimeout(() => {
      res.writeHead(h.status, h.type ? { "content-type": h.type } : {});
      res.end(h.body ?? "");
    }, h.delayMs ?? 0);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const fast = { retries: 1, retryDelayMs: 1, timeoutMs: 500 };
const healthy: Handler = (p) =>
  p.startsWith("/api/feed")
    ? { status: 200, type: "application/json", body: JSON.stringify({ items: [], next: null }) }
    : { status: 200, type: "text/html; charset=utf-8", body: "<!DOCTYPE html><html><body>BeliefAtlas</body></html>" };

test("a healthy site passes both checks", async () => {
  handler = healthy;
  const results = await checkSite(base, fast);
  assert.deepEqual(
    results.map((r) => [r.name, r.ok, r.status]),
    [
      ["home", true, 200],
      ["feed", true, 200],
    ],
  );
  assert.equal(results[1].url, `${base}/api/feed`);
});

test("a failing feed fails, after retrying", async () => {
  handler = (p) => (p.startsWith("/api/feed") ? { status: 503, type: "application/json", body: "{}" } : healthy(p));
  const [home, feed] = await checkSite(base, fast);
  assert.equal(home.ok, true);
  assert.equal(feed.ok, false);
  assert.equal(feed.status, 503);
  assert.equal(feed.attempts, 2);
});

test("wrong content counts as down: no items array, or a home page that isn't HTML", async () => {
  handler = (p) =>
    p.startsWith("/api/feed")
      ? { status: 200, type: "application/json", body: JSON.stringify({ error: "nope" }) }
      : { status: 200, type: "application/json", body: "{}" };
  const [home, feed] = await checkSite(base, { ...fast, retries: 0 });
  assert.equal(home.ok, false);
  assert.match(home.detail ?? "", /HTML/);
  assert.equal(feed.ok, false);
  assert.match(feed.detail ?? "", /items/);
});

test("a rate-limited feed still counts as up", async () => {
  handler = (p) => (p.startsWith("/api/feed") ? { status: 429, type: "application/json", body: "{}" } : healthy(p));
  const [, feed] = await checkSite(base, fast);
  assert.equal(feed.ok, true);
  assert.equal(feed.status, 429);
});

test("a slow answer times out and fails", async () => {
  handler = (p) => ({ ...healthy(p), delayMs: 300 });
  const results = await checkSite(base, { retries: 0, timeoutMs: 50 });
  assert.ok(results.every((r) => !r.ok && /timed out/.test(r.detail ?? "")));
});

test("base URLs must be http(s) without credentials; paths are kept", () => {
  assert.throws(() => normaliseBaseUrl(undefined), /no base URL/);
  assert.throws(() => normaliseBaseUrl("ftp://example.com"), /http or https/);
  assert.throws(() => normaliseBaseUrl("https://user:pass@example.com"), /credentials/);
  assert.equal(normaliseBaseUrl("https://example.com/app?x=1").toString(), "https://example.com/app/");
});

test("the uptime command exits 0 when up and 1 when down", async () => {
  const cli = path.join(root, "scripts", "ops", "uptime-check.ts");
  const tsx = path.join(root, "node_modules", ".bin", "tsx");
  const env = { ...process.env, UPTIME_RETRIES: "0", UPTIME_TIMEOUT_MS: "2000", GITHUB_ACTIONS: "" };
  // Async, not execFileSync: the server answering the child lives in this process.
  const run = (url: string) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      execFile(tsx, [cli, url], { env, cwd: root }, (err, stdout, stderr) => {
        resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr });
      });
    });
  handler = healthy;
  const up = await run(base);
  assert.equal(up.code, 0, up.out);
  assert.match(up.out, /"msg":"uptime check passed"/);
  handler = () => ({ status: 500 });
  const down = await run(base);
  assert.equal(down.code, 1, down.out);
  assert.match(down.out, /"msg":"uptime check failed"/);
});

// ---------- Shell scripts ----------

test("backup and restore-drill scripts parse and refuse to run without a database", () => {
  for (const script of ["backup.sh", "restore-drill.sh"]) {
    const file = path.join(root, "scripts", "ops", script);
    execFileSync("bash", ["-n", file]);
    let status = 0;
    try {
      // No DATABASE_URL in the environment: both scripts must stop with status 2.
      execFileSync("bash", [file], { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, stdio: "pipe" });
    } catch (err) {
      status = (err as { status: number }).status;
    }
    assert.equal(status, 2, script);
  }
});
