// AI head tests (belief-map/claude-plugin.md): the switches, linking a person's account to an
// assistant (OAuth with PKCE), the MCP tools, and the rule that only the person's own tap on
// BeliefAtlas's card counts. An AI never gets an account and never votes. Every client these tests
// register is marked origin 'test', and everything is removed afterwards.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { after, before, test } from "node:test";
import { pool, query } from "../lib/db";
import type { Account } from "../lib/auth";
import { ask } from "../lib/questions";
import { currentText, recordConsent, type ConsentContext } from "../lib/consent";
import { aiHeadEnabled, answerMode, authorizationServerMetadata, protectedResourceMetadata, SCOPE } from "../lib/ai-head/config";
import { approve, checkAuthorizeRequest, exchange, linkedFor, platformFor, redirectMatches, registerClient, revokeGrant, type Linked } from "../lib/ai-head/oauth";
import { cardToken, readCardToken, resultsFor } from "../lib/ai-head/cards";
import { cardHtml, CARD_MIME, CARD_URI } from "../lib/ai-head/card-html";
import { handleMcp, inClaudeEgress, type McpContext } from "../lib/ai-head/mcp";
import { mcpJson, pluginBase } from "../scripts/plugin/build";

const tag = `ai${Date.now().toString(36)}`;
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const web: ConsentContext = { gpc: false, region: null, surface: "assistant", lang: "en" };
const questionIds: number[] = [];
let person: Account;
let other: Account;
let noConsent: Account;
let asker: Account;
let qid: number;

async function makeAccount(name: string, tier: "free" | "paid" = "free"): Promise<Account> {
  const [row] = await query<{ id: number }>(
    `insert into accounts (username, phone_hash, password_hash, consented_at, tier)
     values ($1, $2, 'x', now(), $3) returning id`,
    [`${tag}_${name}`, `${tag}_${name}`, tier],
  );
  return { id: row.id, username: `${tag}_${name}`, tier, verified: false, role: "user" };
}

async function agree(account: Account) {
  const text = await currentText("answering", "en");
  const r = await recordConsent({ accountId: account.id, choice: "answering", granted: true, version: text!.version, lang: "en" }, web);
  assert.ok(r.ok);
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function testClient(uris = [CALLBACK]) {
  const r = await registerClient({ redirect_uris: uris, client_name: `${tag} client` }, "test");
  assert.ok(r.ok);
  return r.client;
}

// Runs the whole link: register, consent page check, the person's yes, the code exchange.
async function link(account: Account) {
  const client = await testClient();
  const { verifier, challenge } = pkce();
  const check = await checkAuthorizeRequest({
    response_type: "code", client_id: client.id, redirect_uri: CALLBACK,
    code_challenge: challenge, code_challenge_method: "S256", scope: SCOPE, state: "s1",
  });
  assert.equal(check.ok, true);
  assert.ok(check.ok);
  const back = new URL(await approve(account, check.request));
  assert.equal(back.searchParams.get("state"), "s1");
  const code = back.searchParams.get("code")!;
  const tokens = await exchange({ grant_type: "authorization_code", client_id: client.id, code, redirect_uri: CALLBACK, code_verifier: verifier });
  assert.ok(tokens.ok);
  const linked = await linkedFor(`Bearer ${tokens.body.access_token}`);
  assert.ok(linked);
  return { client, code, verifier, tokens: tokens.body, linked };
}

let n = 0;
const ctxFor = (linked: Linked | null, mode: "off" | "count" = "count"): McpContext => ({
  linked, ipHash: `${tag}_${++n}`, claudeEgress: false, consent: web, mode,
});
const call = async (ctx: McpContext, name: string, args: Record<string, unknown>) => {
  const res = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, ctx);
  assert.ok(res && "result" in res, JSON.stringify(res));
  return res.result as { content: { text: string }[]; structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown>; isError?: boolean };
};

before(async () => {
  person = await makeAccount("person");
  other = await makeAccount("other");
  noConsent = await makeAccount("noconsent");
  asker = await makeAccount("asker", "paid");
  await agree(person);
  await agree(other);
  const q = await ask(asker, `Is the ${tag} harbour bridge painted green?`);
  assert.ok(q.ok, q.ok ? "" : q.error);
  qid = q.id;
  questionIds.push(qid);
});

after(async () => {
  await query("delete from ai_card_taps where question_id = any($1::int[])", [questionIds]);
  await query("delete from ai_requests where ip_hash like $1", [`${tag}\\_%`]);
  await query("delete from ai_clients where origin = 'test' and client_name like $1", [`${tag}%`]);
  await query("delete from questions where id = any($1::int[])", [questionIds]);
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await pool.end();
});

// ---------- Switches ----------

test("the AI head is off unless switched on, and production also needs the domain", () => {
  assert.equal(aiHeadEnabled({} as unknown as NodeJS.ProcessEnv), false);
  assert.equal(aiHeadEnabled({ AI_HEAD_ENABLED: "1" } as unknown as NodeJS.ProcessEnv), false);
  assert.equal(aiHeadEnabled({ AI_HEAD_ENABLED: "true" } as unknown as NodeJS.ProcessEnv), true);
  assert.equal(aiHeadEnabled({ AI_HEAD_ENABLED: "true", VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv), false);
  assert.equal(aiHeadEnabled({ AI_HEAD_ENABLED: "true", VERCEL_ENV: "production", PUBLIC_BASE_URL: "https://x.org" } as unknown as NodeJS.ProcessEnv), true);
  assert.equal(answerMode({ AI_HEAD_ANSWERS: "count" } as unknown as NodeJS.ProcessEnv), "off");
  assert.equal(answerMode({ AI_HEAD_ENABLED: "true" } as unknown as NodeJS.ProcessEnv), "off");
  assert.equal(answerMode({ AI_HEAD_ENABLED: "true", AI_HEAD_ANSWERS: "count" } as unknown as NodeJS.ProcessEnv), "count");
});

test("discovery documents name only public clients with PKCE", () => {
  const as = authorizationServerMetadata();
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
  assert.ok(protectedResourceMetadata().resource.endsWith("/api/mcp"));
});

// ---------- Linking an account ----------

test("only Claude's callbacks can register, one app per client", async () => {
  assert.equal(platformFor(CALLBACK), "claude");
  assert.equal(platformFor("http://localhost:53211/callback"), "claude-code");
  assert.equal(platformFor("https://evil.example/callback"), null);
  assert.ok(redirectMatches(["http://localhost/callback"], "http://localhost:4567/callback"));
  assert.ok(!redirectMatches([CALLBACK], "https://claude.ai/api/mcp/auth_callback/x"));
  const bad = await registerClient({ redirect_uris: ["https://evil.example/cb"] }, "test");
  assert.equal(bad.ok, false);
  const mixed = await registerClient({ redirect_uris: [CALLBACK, "http://localhost/callback"] }, "test");
  assert.equal(mixed.ok, false);
  const secret = await registerClient({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "client_secret_post" }, "test");
  assert.equal(secret.ok, false);
});

test("the consent page refuses requests without PKCE or with another scope", async () => {
  const client = await testClient();
  const base = { response_type: "code", client_id: client.id, redirect_uri: CALLBACK, code_challenge: pkce().challenge, code_challenge_method: "S256", scope: SCOPE };
  assert.equal((await checkAuthorizeRequest({ ...base, code_challenge_method: "plain" })).ok, false);
  assert.equal((await checkAuthorizeRequest({ ...base, code_challenge: undefined })).ok, false);
  assert.equal((await checkAuthorizeRequest({ ...base, scope: "votes.write" })).ok, false);
  assert.equal((await checkAuthorizeRequest({ ...base, redirect_uri: "https://evil.example/cb" })).ok, false);
  assert.equal((await checkAuthorizeRequest({ ...base, client_id: "nope" })).ok, false);
  assert.equal((await checkAuthorizeRequest(base)).ok, true);
});

test("a code works once, only with the right verifier, and refresh tokens rotate", async () => {
  const client = await testClient();
  const { verifier, challenge } = pkce();
  const check = await checkAuthorizeRequest({ response_type: "code", client_id: client.id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", scope: SCOPE });
  assert.ok(check.ok);
  const code = new URL(await approve(person, check.request)).searchParams.get("code")!;
  const wrong = await exchange({ grant_type: "authorization_code", client_id: client.id, code, redirect_uri: CALLBACK, code_verifier: pkce().verifier });
  assert.deepEqual(wrong, { ok: false, error: "invalid_grant" });
  // The failed try spent the code, so the right verifier is now too late as well.
  const late = await exchange({ grant_type: "authorization_code", client_id: client.id, code, redirect_uri: CALLBACK, code_verifier: verifier });
  assert.equal(late.ok, false);

  const { tokens, client: c2 } = await link(person);
  const again = await exchange({ grant_type: "refresh_token", client_id: c2.id, refresh_token: tokens.refresh_token });
  assert.ok(again.ok);
  const reused = await exchange({ grant_type: "refresh_token", client_id: c2.id, refresh_token: tokens.refresh_token });
  assert.deepEqual(reused, { ok: false, error: "invalid_grant" });
  const otherClient = await exchange({ grant_type: "refresh_token", client_id: client.id, refresh_token: again.body.refresh_token });
  assert.equal(otherClient.ok, false);
});

test("the link belongs to the person, not the AI: no account is made, and unlinking cuts it off", async () => {
  const before = await query<{ n: string }>("select count(*) as n from accounts");
  const { linked, tokens } = await link(person);
  const afterCount = await query<{ n: string }>("select count(*) as n from accounts");
  assert.equal(afterCount[0].n, before[0].n);
  assert.equal(linked.account.id, person.id);
  assert.equal(linked.platform, "claude");
  assert.equal(await linkedFor("Bearer nope"), null);
  assert.equal(await linkedFor(null), null);
  assert.equal(await revokeGrant(other.id, linked.grantId), false);
  assert.equal(await revokeGrant(person.id, linked.grantId), true);
  assert.equal(await linkedFor(`Bearer ${tokens.access_token}`), null);
});

// ---------- MCP ----------

test("initialize and tools/list: submit_answer is for the card only", async () => {
  const ctx = ctxFor(null, "off");
  const init = await handleMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, ctx);
  assert.ok(init && "result" in init);
  assert.equal((init.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
  assert.equal(await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx), null);
  const list = await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ctx);
  assert.ok(list && "result" in list);
  const tools = (list.result as { tools: { name: string; _meta?: { ui?: { visibility?: string[]; resourceUri?: string } } }[] }).tools;
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ["find_questions", "get_results", "show_question", "submit_answer"]);
  assert.deepEqual(byName.submit_answer._meta?.ui?.visibility, ["app"]);
  assert.equal(byName.show_question._meta?.ui?.resourceUri, CARD_URI);
  const unknown = await handleMcp({ jsonrpc: "2.0", id: 3, method: "votes/cast" }, ctx);
  assert.ok(unknown && "error" in unknown);
});

test("the card resource loads nothing from outside and never writes question text as HTML", async () => {
  const res = await handleMcp({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: CARD_URI } }, ctxFor(null, "off"));
  assert.ok(res && "result" in res);
  const [content] = (res.result as { contents: { mimeType: string; text: string; _meta: { ui: { csp: Record<string, string[]> } } }[] }).contents;
  assert.equal(content.mimeType, CARD_MIME);
  for (const list of Object.values(content._meta.ui.csp)) assert.deepEqual(list, []);
  const html = cardHtml();
  assert.ok(!/<script[^>]+src=|<link[^>]+href=|https?:\/\//i.test(html), "no outside loads");
  assert.ok(!/innerHTML/.test(html));
});

test("find_questions and show_question: exact text, labelled as people's writing", async () => {
  const ctx = ctxFor(null, "off");
  const found = await call(ctx, "find_questions", { query: `${tag} harbour bridge` });
  const qs = found.structuredContent!.questions as { id: number; text: string }[];
  assert.ok(qs.some((q) => q.id === qid));
  assert.deepEqual(found.structuredContent!.textSource, { source: "user", instructions: "none" });
  const shown = await call(ctx, "show_question", { id: qid });
  const card = shown.structuredContent!.card as { text: string; canAnswer: boolean; whyNot: string };
  assert.equal(card.text, `Is the ${tag} harbour bridge painted green?`);
  assert.equal(card.canAnswer, false);
  assert.equal(card.whyNot, "answers_off");
  assert.equal(shown._meta, undefined);
});

test("a card token goes only to a linked person's card, never into the text the model reads", async () => {
  const { linked } = await link(person);
  const unlinked = await call(ctxFor(null), "show_question", { id: qid });
  assert.equal((unlinked.structuredContent!.card as { whyNot: string }).whyNot, "not_linked");
  assert.equal(unlinked._meta, undefined);
  const shown = await call(ctxFor(linked), "show_question", { id: qid });
  const token = shown._meta?.["beliefatlas/cardToken"] as string;
  assert.match(token, /^cmt\./);
  assert.ok(!JSON.stringify(shown.content).includes(token));
  assert.ok(!JSON.stringify(shown.structuredContent).includes(token));
});

test("submit_answer refuses anything but a fresh tap on this person's card", async () => {
  const mine = (await link(person)).linked;
  const theirs = (await link(other)).linked;
  const token = cardToken(qid, mine.grantId);
  const tries: [McpContext, Record<string, unknown>, string][] = [
    [ctxFor(mine, "off"), { cardToken: token, value: "true" }, "answers_off"],
    [ctxFor(null), { cardToken: token, value: "true" }, "not_linked"],
    [ctxFor(mine), { cardToken: token, value: "maybe" }, "invalid"],
    [ctxFor(mine), { cardToken: "cmt.1.2.3.4.5", value: "true" }, "token_bad"],
    [ctxFor(mine), { value: "true" }, "token_bad"],
    [ctxFor(theirs), { cardToken: token, value: "true" }, "token_other_person"],
    [ctxFor(mine), { cardToken: cardToken(qid, mine.grantId, new Date(Date.now() - 2 * 3600 * 1000)), value: "true" }, "token_expired"],
  ];
  for (const [ctx, args, outcome] of tries) {
    const r = await call(ctx, "submit_answer", args);
    assert.equal(r.isError, true, outcome);
    assert.equal(r.structuredContent!.outcome, outcome);
    assert.equal(r.structuredContent!.counted, false);
  }
  const votes = await query("select 1 from votes where question_id = $1", [qid]);
  assert.equal(votes.length, 0);
  assert.deepEqual(readCardToken(token, mine.grantId).ok, true);
});

test("the person's own tap counts once, through the one vote engine, labelled as from an assistant", async () => {
  const { linked } = await link(person);
  const shown = await call(ctxFor(linked), "show_question", { id: qid });
  const token = shown._meta!["beliefatlas/cardToken"] as string;
  const r = await call(ctxFor(linked), "submit_answer", { cardToken: token, value: "false" });
  assert.equal(r.structuredContent!.outcome, "cast");
  assert.equal(r.structuredContent!.counted, true);
  assert.match(String(r.structuredContent!.forAssistant), /answered False .* own tap/);
  const [event] = await query<{ account_id: number; surface: string; placement: string; surface_context: { platform: string } }>(
    "select account_id, surface, placement, surface_context from vote_events where question_id = $1", [qid],
  );
  assert.equal(event.account_id, person.id);
  assert.equal(event.surface, "assistant");
  assert.equal(event.placement, "claude");
  assert.equal(event.surface_context.platform, "claude");

  const reused = await call(ctxFor(linked), "submit_answer", { cardToken: token, value: "true" });
  assert.equal(reused.structuredContent!.outcome, "token_used");
  const [row] = await query<{ value: string }>("select value from votes where account_id = $1 and question_id = $2", [person.id, qid]);
  assert.equal(row.value, "false");
});

test("someone who hasn't agreed to answering is sent to agree first, and nothing is held", async () => {
  const { linked } = await link(noConsent);
  const token = cardToken(qid, linked.grantId);
  const r = await call(ctxFor(linked), "submit_answer", { cardToken: token, value: "true" });
  assert.equal(r.structuredContent!.outcome, "needs_consent");
  assert.equal(r.structuredContent!.counted, false);
  assert.match(String(r.structuredContent!.linkUrl), /consent/);
  const votes = await query("select 1 from votes where account_id = $1", [noConsent.id]);
  assert.equal(votes.length, 0);
});

test("results aren't quotable under the minimum, and carry notice, size and time when they are", async () => {
  const few = await call(ctxFor(null, "off"), "get_results", { id: qid });
  assert.equal((few.structuredContent!.results as { quotable: boolean }).quotable, false);
  const now = new Date("2026-11-21T12:00:00Z");
  const r = await resultsFor(qid, now, 1);
  assert.ok(r && r.quotable);
  assert.equal(r.split.false, 100);
  assert.equal(r.size, "under 1K answers");
  assert.match(r.citation, /On BeliefAtlas, 0% said True, 100% False .*2026-11-21 12:00 UTC/);
});

test("every call is logged as AI traffic, and an address over budget is slowed", async () => {
  const ctx = ctxFor(null, "off");
  for (let i = 0; i < 20; i++) await handleMcp({ jsonrpc: "2.0", id: i, method: "ping" }, ctx);
  const slowed = await handleMcp({ jsonrpc: "2.0", id: 99, method: "tools/list" }, ctx);
  assert.ok(slowed && "error" in slowed);
  const [row] = await query<{ caller_kind: string; outcome: string }>(
    "select caller_kind, outcome from ai_requests where ip_hash = $1 order by id desc limit 1", [ctx.ipHash],
  );
  assert.equal(row.caller_kind, "ai");
  assert.equal(row.outcome, "slow_down");
  assert.equal(inClaudeEgress("160.79.105.4"), true);
  assert.equal(inClaudeEgress("160.79.112.4"), false);
});

// ---------- The plugin package ----------

test("the plugin holds no secrets and is built only for the real domain or a local try", () => {
  const manifest = JSON.parse(readFileSync("integrations/claude-plugin/beliefatlas/.claude-plugin/plugin.json", "utf8"));
  assert.equal(manifest.name, "beliefatlas");
  const skill = readFileSync("integrations/claude-plugin/beliefatlas/skills/beliefatlas/SKILL.md", "utf8");
  assert.match(skill, /^---\nname: beliefatlas\ndescription: /);
  assert.match(skill, /never answer, sign in, make an account or vote/i);
  assert.equal(pluginBase({} as unknown as NodeJS.ProcessEnv, false).ok, false);
  assert.equal(pluginBase({ PUBLIC_BASE_URL: "http://beliefatlas.org" } as unknown as NodeJS.ProcessEnv, false).ok, false);
  assert.equal(pluginBase({ PUBLIC_BASE_URL: "https://beliefatlas.vercel.app" } as unknown as NodeJS.ProcessEnv, false).ok, false);
  assert.equal(pluginBase({ PUBLIC_BASE_URL: "https://localhost:3000" } as unknown as NodeJS.ProcessEnv, false).ok, false);
  assert.deepEqual(pluginBase({ PUBLIC_BASE_URL: "https://beliefatlas.org/" } as unknown as NodeJS.ProcessEnv, false), { ok: true, base: "https://beliefatlas.org" });
  assert.deepEqual(pluginBase({} as unknown as NodeJS.ProcessEnv, true), { ok: true, base: "http://localhost:3000" });
  const mcp = JSON.parse(mcpJson("https://beliefatlas.org"));
  assert.deepEqual(mcp, { mcpServers: { beliefatlas: { type: "http", url: "https://beliefatlas.org/api/mcp" } } });
});
