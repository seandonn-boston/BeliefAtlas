import { createHash } from "crypto";
import type { PoolClient } from "pg";
import { pool } from "./db";
import { rollupDay } from "./jobs/handlers";
import { databaseIsProduction, isProductionEnv, originCounts, type OriginCounts } from "./provenance";
import { randomUsername } from "./usernames";

// Seed data: fictional launch accounts and votes, marked origin 'seed' (lib/provenance.ts).
// They make an empty site feel less empty, are never sold or served to API keys, and are
// removed completely before data sales open.
//
//   npm run seed:load -- <file.json|file.csv>   load a file (idempotent)
//   npm run seed:status                         how much seed data is left
//   npm run seed:remove [-- --dry-run]          remove every seed account, vote, event and skip
//
// ---------- File format ----------
// JSON:
//   {
//     "accounts": [ { "key": "s0001", "createdAt": "2026-11-20T15:00:00Z" } ],
//     "votes": [
//       { "account": "s0001", "questionId": 42, "value": "true", "castAt": "2026-11-21T09:30:00Z" },
//       { "account": "s0001", "question": "Is a hot dog a sandwich?", "value": "unsure" }
//     ]
//   }
//   * key: the file's own name for a fictional account, 1-64 letters, digits, _ . : or -. It is
//     stored on the account (accounts.seed_key) so loading the file again finds it; the account's
//     username is generated like a real signup's ("calm_otter123"). Accounts named only in
//     votes are created too; "accounts" is needed only to give a createdAt.
//   * createdAt (optional): when the account appears to have joined. Defaults to just before its
//     first vote, or now.
//   * questionId or question: the question by id, or by its exact text. It must be active.
//   * value: true, false or unsure (JSON booleans true/false also work).
//   * castAt (optional): when the vote was cast, not in the future. Defaults to now.
// CSV: a header row and one vote per row, columns in any order:
//   account,question_id,question,value,cast_at
//   s0001,42,,true,2026-11-21T09:30:00Z
//   s0002,,"Is a hot dog a sandwich?",unsure,
// Fields may be double-quoted (a quote inside is written twice).
//
// Every row is checked before anything is written, and the whole file loads in one
// transaction or not at all. Loading the same file again changes nothing: existing accounts
// are found by key, and a vote already there is left as it is (counted as "already present",
// or "kept" if the file now gives a different answer).

export type VoteValue = "true" | "false" | "unsure";
export type SeedAccount = { key: string; createdAt?: Date };
export type SeedVote = { account: string; questionId?: number; question?: string; value: VoteValue; castAt?: Date };
export type SeedFile = { accounts: SeedAccount[]; votes: SeedVote[] };

export class SeedFileError extends Error {
  constructor(readonly problems: string[]) {
    super(`The seed file has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  ${problems.slice(0, 50).join("\n  ")}` +
      (problems.length > 50 ? `\n  ...and ${problems.length - 50} more` : ""));
    this.name = "SeedFileError";
  }
}

const KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const VALUES = new Set(["true", "false", "unsure"]);

// ---------- Parsing ----------

function parseTime(raw: unknown, where: string, problems: string[]): Date | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const date = typeof raw === "string" ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) {
    problems.push(`${where}: not an ISO 8601 time`);
    return undefined;
  }
  if (date.getTime() > Date.now() + 60_000) problems.push(`${where}: in the future`);
  return date;
}

function parseValue(raw: unknown, where: string, problems: string[]): VoteValue {
  const value = typeof raw === "boolean" ? String(raw) : typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!VALUES.has(value)) problems.push(`${where}: value must be true, false or unsure`);
  return value as VoteValue;
}

function parseVote(raw: Record<string, unknown>, where: string, problems: string[]): SeedVote {
  const account = typeof raw.account === "string" ? raw.account.trim() : "";
  if (!KEY.test(account)) problems.push(`${where}: account must be a key of 1-64 letters, digits, _ . : or -`);
  const idRaw = raw.questionId;
  const questionId = idRaw === undefined || idRaw === null || idRaw === "" ? undefined : Number(idRaw);
  const question = typeof raw.question === "string" && raw.question.trim() ? raw.question : undefined;
  if (questionId !== undefined && (!Number.isInteger(questionId) || questionId <= 0)) problems.push(`${where}: questionId must be a positive whole number`);
  if (questionId === undefined && question === undefined) problems.push(`${where}: give questionId or question`);
  if (questionId !== undefined && question !== undefined) problems.push(`${where}: give questionId or question, not both`);
  return {
    account,
    questionId,
    question,
    value: parseValue(raw.value, where, problems),
    castAt: parseTime(raw.castAt, `${where} castAt`, problems),
  };
}

export function parseSeedJson(text: string): SeedFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new SeedFileError([`not valid JSON: ${(err as Error).message}`]);
  }
  const problems: string[] = [];
  const obj = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  const accountsRaw = obj.accounts ?? [];
  const votesRaw = obj.votes;
  if (!Array.isArray(accountsRaw)) problems.push(`"accounts" must be a list`);
  if (!Array.isArray(votesRaw)) problems.push(`"votes" must be a list`);
  if (problems.length) throw new SeedFileError(problems);

  const accounts = (accountsRaw as unknown[]).map((a, i): SeedAccount => {
    const r = (a ?? {}) as Record<string, unknown>;
    const key = typeof r.key === "string" ? r.key.trim() : "";
    if (!KEY.test(key)) problems.push(`accounts[${i}]: key must be 1-64 letters, digits, _ . : or -`);
    return { key, createdAt: parseTime(r.createdAt, `accounts[${i}] createdAt`, problems) };
  });
  const votes = (votesRaw as unknown[]).map((v, i) => parseVote((v ?? {}) as Record<string, unknown>, `votes[${i}]`, problems));
  if (problems.length) throw new SeedFileError(problems);
  return { accounts, votes };
}

// RFC 4180 style: commas, double quotes, quotes doubled inside quotes, CRLF or LF.
export function parseCsvRows(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) out.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) throw new SeedFileError(["CSV: a quoted field is never closed"]);
  row.push(field);
  if (row.some((f) => f !== "")) out.push(row);
  return out;
}

export function parseSeedCsv(text: string): SeedFile {
  const [header, ...lines] = parseCsvRows(text.replace(/^﻿/, ""));
  if (!header) throw new SeedFileError(["CSV: empty file"]);
  const cols = header.map((h) => h.trim().toLowerCase());
  const known = ["account", "question_id", "question", "value", "cast_at"];
  const unknown = cols.filter((c) => !known.includes(c));
  const problems: string[] = [];
  if (unknown.length) problems.push(`CSV: unknown columns ${unknown.join(", ")} (expected ${known.join(", ")})`);
  for (const needed of ["account", "value"]) if (!cols.includes(needed)) problems.push(`CSV: missing column ${needed}`);
  if (!cols.includes("question_id") && !cols.includes("question")) problems.push("CSV: needs a question_id or question column");
  if (problems.length) throw new SeedFileError(problems);
  const at = (line: string[], name: string) => {
    const i = cols.indexOf(name);
    return i < 0 ? undefined : line[i];
  };
  const votes = lines.map((line, i) =>
    parseVote(
      { account: at(line, "account"), questionId: at(line, "question_id"), question: at(line, "question"), value: at(line, "value"), castAt: at(line, "cast_at") },
      `row ${i + 2}`,
      problems,
    ),
  );
  if (problems.length) throw new SeedFileError(problems);
  return { accounts: [], votes };
}

export function parseSeedFile(name: string, text: string): SeedFile {
  if (/\.json$/i.test(name)) return parseSeedJson(text);
  if (/\.csv$/i.test(name)) return parseSeedCsv(text);
  throw new SeedFileError(["the file must end in .json or .csv"]);
}

// ---------- Loading ----------

export type LoadResult = {
  accountsCreated: number;
  accountsExisting: number;
  votesAdded: number;
  votesAlreadyPresent: number;
  votesKept: number;   // already there with a different answer; left as they were
};

type Env = Record<string, string | undefined>;

// Seed data is meant for the production launch, but loading it there must be deliberate:
// SEED_ALLOW=1 for that one run.
export async function assertSeedLoadAllowed(env: Env = process.env): Promise<void> {
  const production = isProductionEnv(env) || (await databaseIsProduction());
  if (production && env.SEED_ALLOW !== "1") {
    throw new Error("This is a production database. Loading seed data here needs SEED_ALLOW=1 for this run: SEED_ALLOW=1 npm run seed:load -- <file>");
  }
}

const phoneHashFor = (key: string) => `seed:${createHash("sha256").update(`beliefatlas-seed:${key}`).digest("hex")}`;
// Not a scrypt "salt:hash" pair, so no password ever signs in (lib/auth.ts verifyPassword).
const NO_LOGIN = "seed-origin-no-login";
const CHUNK = 2000;

export async function loadSeed(file: SeedFile, env: Env = process.env): Promise<LoadResult> {
  await assertSeedLoadAllowed(env);
  const problems: string[] = [];
  const now = new Date();

  const declared = new Map<string, SeedAccount>();
  for (const a of file.accounts) {
    if (declared.has(a.key)) problems.push(`account ${a.key} is listed twice`);
    declared.set(a.key, a);
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local beliefatlas.seed_load = 'on'");

    // Questions: by id, or by exact text. Each must be active, not archived and not merged away.
    const ids = [...new Set(file.votes.flatMap((v) => (v.questionId ? [v.questionId] : [])))];
    const texts = [...new Set(file.votes.flatMap((v) => (v.question !== undefined ? [v.question] : [])))];
    const found = await client.query<{ id: number; text: string; open: boolean }>(
      `select q.id, q.text,
              (q.status = 'active' and q.archived_at is null
               and not exists (select 1 from question_merges m where m.from_question_id = q.id)) as open
         from questions q where q.id = any($1::int[]) or q.text = any($2::text[])`,
      [ids, texts],
    );
    const byId = new Map(found.rows.map((r) => [r.id, r]));
    const byText = new Map<string, typeof found.rows>();
    for (const r of found.rows) byText.set(r.text, [...(byText.get(r.text) ?? []), r]);
    const resolved = file.votes.map((v, i) => {
      const where = `vote ${i + 1}`;
      let q = v.questionId ? byId.get(v.questionId) : undefined;
      if (v.questionId && !q) problems.push(`${where}: no question ${v.questionId}`);
      if (v.question !== undefined) {
        const matches = byText.get(v.question) ?? [];
        if (matches.length === 0) problems.push(`${where}: no question with exactly the text "${v.question}"`);
        if (matches.length > 1) problems.push(`${where}: ${matches.length} questions have the text "${v.question}"; use questionId`);
        q = matches.length === 1 ? matches[0] : undefined;
      }
      if (q && !q.open) problems.push(`${where}: question ${q.id} is not open (archived, removed, in review or merged)`);
      return { ...v, questionId: q?.id ?? 0, castAt: v.castAt ?? now };
    });
    // One answer per account and question.
    const pairs = new Map<string, number>();
    resolved.forEach((v, i) => {
      if (!v.questionId) return;
      const pair = `${v.account}\u0000${v.questionId}`;
      if (pairs.has(pair)) problems.push(`vote ${i + 1}: ${v.account} answers question ${v.questionId} twice (also vote ${pairs.get(pair)! + 1})`);
      else pairs.set(pair, i);
    });

    // Accounts: every key named in the file.
    const keys = [...new Set([...file.accounts.map((a) => a.key), ...file.votes.map((v) => v.account)])];
    const firstVote = new Map<string, Date>();
    for (const v of resolved) {
      const prev = firstVote.get(v.account);
      if (!prev || v.castAt < prev) firstVote.set(v.account, v.castAt);
    }
    for (const [key, a] of declared) {
      const first = firstVote.get(key);
      if (a.createdAt && first && a.createdAt > first) problems.push(`account ${key}: createdAt is after its first vote`);
    }
    if (problems.length) throw new SeedFileError(problems);

    const existing = await client.query<{ id: number; seed_key: string; origin: string }>(
      "select id, seed_key, origin from accounts where seed_key = any($1::text[])",
      [keys],
    );
    const idByKey = new Map(existing.rows.map((r) => [r.seed_key, r.id]));
    const missing = keys.filter((k) => !idByKey.has(k));
    const usernames = await freshUsernames(client, missing.length);
    for (let i = 0; i < missing.length; i += CHUNK) {
      const part = missing.slice(i, i + CHUNK);
      const created = part.map((k) => {
        const first = firstVote.get(k);
        return declared.get(k)?.createdAt ?? (first ? new Date(first.getTime() - 60_000) : now);
      });
      const res = await client.query<{ id: number; seed_key: string }>(
        `insert into accounts (username, phone_hash, password_hash, consented_at, created_at, last_active_at, origin, seed_key)
         select u, p, $3, c, c, c, 'seed', k
           from unnest($1::text[], $2::text[], $4::timestamptz[], $5::text[]) as t(u, p, c, k)
         returning id, seed_key`,
        [usernames.slice(i, i + CHUNK), part.map(phoneHashFor), NO_LOGIN, created, part],
      );
      for (const r of res.rows) idByKey.set(r.seed_key, r.id);
    }

    // Votes, each with its 'cast' event, written only where the account hasn't answered yet.
    let votesAdded = 0;
    for (let i = 0; i < resolved.length; i += CHUNK) {
      const part = resolved.slice(i, i + CHUNK);
      const res = await client.query<{ n: number }>(
        `with input as (
           select * from unnest($1::int[], $2::int[], $3::text[], $4::timestamptz[]) as t(account_id, question_id, value, at)
         ), added as (
           insert into votes (account_id, question_id, value, is_private, first_value, first_cast_at, first_surface,
                              change_count, updated_at)
           select account_id, question_id, value, false, value, at, 'seed', 0, at from input
           on conflict (account_id, question_id) do nothing
           returning account_id, question_id, value, first_cast_at
         ), events as (
           insert into vote_events (account_id, question_id, action, value, is_private, source, surface, tapped_at, created_at)
           select account_id, question_id, 'cast', value, false, 'seed', 'seed', first_cast_at, first_cast_at from added
           returning 1
         )
         select (select count(*) from events)::int as n`,
        [part.map((v) => idByKey.get(v.account)), part.map((v) => v.questionId), part.map((v) => v.value), part.map((v) => v.castAt)],
      );
      votesAdded += res.rows[0].n;
    }
    const [{ kept }] = (
      await client.query<{ kept: number }>(
        `select count(*)::int as kept
           from unnest($1::int[], $2::int[], $3::text[]) as t(account_id, question_id, value)
           join votes v using (account_id, question_id)
          where v.value <> t.value`,
        [resolved.map((v) => idByKey.get(v.account)), resolved.map((v) => v.questionId), resolved.map((v) => v.value)],
      )
    ).rows;

    await client.query("commit");
    return {
      accountsCreated: missing.length,
      accountsExisting: keys.length - missing.length,
      votesAdded,
      votesAlreadyPresent: resolved.length - votesAdded - kept,
      votesKept: kept,
    };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

// Usernames that look like any generated signup's and are free (here and among each other).
async function freshUsernames(client: PoolClient, count: number): Promise<string[]> {
  const out = new Set<string>();
  while (out.size < count) {
    const batch = Array.from({ length: Math.min(5000, (count - out.size) * 2) }, () => randomUsername()).filter((u) => !out.has(u));
    const taken = await client.query<{ username: string }>(
      `select username from accounts where username = any($1::text[])
       union select username from pending_signups where username = any($1::text[])`,
      [batch],
    );
    const used = new Set(taken.rows.map((r) => r.username));
    for (const u of batch) if (!used.has(u) && out.size < count) out.add(u);
  }
  return [...out];
}

// ---------- Removing ----------

export type RemoveResult = {
  origin: "seed" | "test";
  dryRun: boolean;
  removed: OriginCounts;
  questionsTouched: number;
  countersChecked: number;   // questions whose counters were compared with the votes table
  daysRolledUp: number;
};

export class CounterMismatch extends Error {
  constructor(readonly questionIds: number[]) {
    super(`Counters disagree with the votes table for questions ${questionIds.slice(0, 20).join(", ")}; nothing was removed.`);
    this.name = "CounterMismatch";
  }
}

// Removes every account of this origin and, with them (foreign keys cascade), their votes,
// vote events, skips, reveals, sessions and the rest. The counter trigger takes their votes off
// questions.true_count etc. (and seed votes off sample_count); before committing, the counters of every touched question are
// compared with a fresh count of the votes table, and any difference rolls everything back.
// Afterwards the daily rollups of the days their events fell on are rebuilt.
export async function removeOrigin(origin: "seed" | "test", opts: { dryRun?: boolean } = {}): Promise<RemoveResult> {
  const dryRun = Boolean(opts.dryRun);
  const client = await pool.connect();
  let days: string[] = [];
  let result: RemoveResult;
  try {
    await client.query("begin");
    // One removal at a time.
    await client.query("select pg_advisory_xact_lock(hashtext('beliefatlas.remove_origin'))");
    const removed = await originCounts(origin, client);
    const touched = await client.query<{ question_id: number }>(
      `select question_id from votes where origin = $1
       union select question_id from vote_events where origin = $1
       union select s.question_id from skips s join accounts a on a.id = s.account_id where a.origin = $1`,
      [origin],
    );
    const questionIds = touched.rows.map((r) => r.question_id);
    const dayRows = await client.query<{ day: string }>(
      "select distinct to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day from vote_events where origin = $1 order by 1",
      [origin],
    );
    days = dayRows.rows.map((r) => r.day);

    // Questions asked by these accounts would be left pointing at nothing. Refuse rather than
    // guess whether they should stay in the catalog.
    const asked = await client.query<{ id: number }>(
      "select q.id from questions q join accounts a on a.id = q.asked_by where a.origin = $1 order by q.id",
      [origin],
    );
    if (asked.rows.length) {
      throw new Error(
        `${asked.rows.length} question(s) were asked by ${origin} accounts (ids ${asked.rows.slice(0, 20).map((r) => r.id).join(", ")}). ` +
          "Decide what happens to them (archive them, or clear asked_by) before removing these accounts.",
      );
    }

    if (dryRun) {
      await client.query("rollback");
      return { origin, dryRun, removed, questionsTouched: questionIds.length, countersChecked: 0, daysRolledUp: 0 };
    }

    await client.query("delete from accounts where origin = $1", [origin]);
    const left = await originCounts(origin, client);
    if (left.accounts + left.votes + left.events + left.skips > 0) {
      throw new Error(`${origin} rows remain after removal (${JSON.stringify(left)}); nothing was removed.`);
    }
    const mismatched = await client.query<{ id: number }>(
      `select q.id from questions q
         left join (select question_id,
                           count(*) filter (where value = 'true')   as t,
                           count(*) filter (where value = 'false')  as f,
                           count(*) filter (where value = 'unsure') as u,
                           count(*) filter (where origin = 'seed')  as s
                      from votes where question_id = any($1::int[]) group by question_id) c on c.question_id = q.id
        where q.id = any($1::int[])
          and (q.true_count, q.false_count, q.unsure_count, q.sample_count)
              is distinct from (coalesce(c.t, 0), coalesce(c.f, 0), coalesce(c.u, 0), coalesce(c.s, 0))`,
      [questionIds],
    );
    if (mismatched.rows.length) throw new CounterMismatch(mismatched.rows.map((r) => r.id));
    await client.query("commit");
    result = { origin, dryRun, removed, questionsTouched: questionIds.length, countersChecked: questionIds.length, daysRolledUp: 0 };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  for (const day of days) await rollupDay(day);
  return { ...result, daysRolledUp: days.length };
}
