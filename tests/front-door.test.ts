// Front door tests: the one vote engine, first answers kept apart from later changes, held
// votes, idempotency, and the link and token helpers. They run against DATABASE_URL and clean
// up after themselves.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pool, query } from "../lib/db";
import type { Account } from "../lib/auth";
import { ask } from "../lib/questions";
import { questionStats } from "../lib/stats";
import { deleteVote } from "../lib/votes";
import { claimHeldVote, linkIdentity, accountForIdentity, peekHeldVote, vote } from "../lib/vote-engine";
import {
  answerMs, cleanPlacement, cleanSurface, embedHtml, questionIdFromUrl, readShownToken, shownToken, voteUrl,
} from "../lib/front-door";

const tag = `fd${Date.now().toString(36)}`;
let alice: Account;
let bob: Account;
let paid: Account;
const questionIds: number[] = [];

async function makeAccount(name: string, tier: "free" | "paid"): Promise<Account> {
  const [row] = await query<{ id: number }>(
    `insert into accounts (username, phone_hash, password_hash, consented_at, tier)
     values ($1, $2, 'x', now(), $3) returning id`,
    [`${tag}_${name}`, `${tag}_${name}`, tier],
  );
  return { id: row.id, username: `${tag}_${name}`, tier, verified: false, role: "user" };
}

async function makeQuestion(text: string): Promise<number> {
  const result = await ask(paid, text);
  assert.ok(result.ok, result.ok ? "" : result.error);
  questionIds.push(result.id);
  return result.id;
}

const voteRow = (accountId: number, questionId: number) =>
  query<{
    value: string; first_value: string; first_surface: string; first_answer_ms: number | null;
    first_cast_at: Date; change_count: number; last_changed_at: Date | null;
  }>("select * from votes where account_id = $1 and question_id = $2", [accountId, questionId]).then((r) => r[0]);

before(async () => {
  alice = await makeAccount("alice", "free");
  bob = await makeAccount("bob", "free");
  paid = await makeAccount("paid", "paid");
});

after(async () => {
  await query("delete from questions where id = any($1::int[])", [questionIds]);
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await pool.end();
});

test("a first vote records surface, placement and answer time", async () => {
  const q = await makeQuestion(`Is the ${tag} lighthouse painted red`);
  const shownAt = new Date(Date.now() - 1500);
  const tappedAt = new Date();
  const outcome = await vote({
    account: alice, questionId: q, value: "true", surface: "qr", placement: "Poster-7!", shownAt, tappedAt,
  });
  assert.equal(outcome.outcome, "cast");
  assert.ok(outcome.outcome === "cast" && outcome.handle === alice.username);

  const [event] = await query<{ action: string; surface: string; placement: string; answer_ms: number; blind: boolean }>(
    "select action, surface, placement, answer_ms, blind from vote_events where account_id = $1 and question_id = $2",
    [alice.id, q],
  );
  assert.equal(event.action, "cast");
  assert.equal(event.surface, "qr");
  assert.equal(event.placement, "poster-7");
  assert.equal(event.answer_ms, tappedAt.getTime() - shownAt.getTime());
  assert.equal(event.blind, true);

  const row = await voteRow(alice.id, q);
  assert.equal(row.first_value, "true");
  assert.equal(row.first_surface, "qr");
  assert.equal(row.first_answer_ms, 1500);
  assert.equal(row.change_count, 0);
});

test("the first answer survives a change, and a second change the same day is refused", async () => {
  const q = await makeQuestion(`Is the ${tag} harbour deeper than the bay`);
  assert.equal((await vote({ account: bob, questionId: q, value: "true", surface: "share" })).outcome, "cast");
  assert.equal((await vote({ account: bob, questionId: q, value: "true", surface: "share" })).outcome, "same");
  assert.equal((await vote({ account: bob, questionId: q, value: "false", surface: "embed" })).outcome, "changed");
  assert.equal((await vote({ account: bob, questionId: q, value: "true", surface: "embed" })).outcome, "change_used");

  const row = await voteRow(bob.id, q);
  assert.equal(row.value, "false");
  assert.equal(row.first_value, "true");
  assert.equal(row.first_surface, "share");
  assert.equal(row.change_count, 1);
  assert.ok(row.last_changed_at);
});

test("a delete and re-vote keeps the original first answer", async () => {
  const q = await makeQuestion(`Is the ${tag} ferry faster than the bridge`);
  await vote({ account: paid, questionId: q, value: "false", surface: "slack" });
  const before = await voteRow(paid.id, q);
  assert.ok((await deleteVote(paid, q, "direct")).ok);
  // The once-a-day change rule blocks the re-vote today; move the history back a day.
  await query(
    "update vote_events set created_at = created_at - interval '1 day' where account_id = $1 and question_id = $2",
    [paid.id, q],
  );
  assert.equal((await vote({ account: paid, questionId: q, value: "true", surface: "web" })).outcome, "cast");
  const row = await voteRow(paid.id, q);
  assert.equal(row.value, "true");
  assert.equal(row.first_value, "false");
  assert.equal(row.first_surface, "slack");
  assert.equal(row.first_cast_at.getTime(), before.first_cast_at.getTime());
  assert.equal(row.change_count, 2);
});

test("skip goes back into the pool, is recorded, and is not a vote", async () => {
  const q = await makeQuestion(`Is the ${tag} orchard older than the farmhouse`);
  const outcome = await vote({ account: alice, questionId: q, value: "skip", surface: "embed" });
  assert.equal(outcome.outcome, "skipped");
  assert.equal((await query("select 1 from votes where account_id = $1 and question_id = $2", [alice.id, q])).length, 0);
  assert.equal((await query("select 1 from skips where account_id = $1 and question_id = $2", [alice.id, q])).length, 1);
  const [event] = await query<{ action: string }>(
    "select action from vote_events where account_id = $1 and question_id = $2",
    [alice.id, q],
  );
  assert.equal(event.action, "skip");
  const stats = await questionStats(q);
  assert.equal(stats.churn.everVoted, 0);
  assert.equal(stats.tally.total, 0);

  // Answering later is still a first answer, and a skip after answering changes nothing.
  assert.equal((await vote({ account: alice, questionId: q, value: "false", surface: "web" })).outcome, "cast");
  assert.equal((await voteRow(alice.id, q)).first_value, "false");
  assert.equal((await vote({ account: alice, questionId: q, value: "skip", surface: "web" })).outcome, "skipped");
  assert.equal((await voteRow(alice.id, q)).value, "false");
  assert.equal((await questionStats(q)).tally.false, 1);
});

test("skips use none of the day's votes; Don't know is a vote and uses one", async () => {
  const q = await makeQuestion(`Is the ${tag} canal longer than the river`);
  const other = await makeQuestion(`Is the ${tag} dam higher than the weir`);
  const counter = await makeAccount("counter", "free");
  // 99 of today's 100 votes used.
  await query(
    `insert into vote_events (account_id, question_id, action, value, source)
     select $1, $2, 'cast', 'true', 'direct' from generate_series(1, 99)`,
    [counter.id, questionIds[0]],
  );
  for (let i = 0; i < 3; i++) {
    assert.equal((await vote({ account: counter, questionId: other, value: "skip", surface: "web" })).outcome, "skipped");
  }
  assert.equal((await vote({ account: counter, questionId: q, value: "unsure", surface: "web" })).outcome, "cast");
  assert.equal((await voteRow(counter.id, q)).value, "unsure");
  assert.equal((await questionStats(q)).tally.unsure, 1);
  assert.equal((await vote({ account: counter, questionId: other, value: "true", surface: "web" })).outcome, "limit_reached");
});

test("the same idempotency key always gets the same answer and votes once", async () => {
  const q = await makeQuestion(`Is the ${tag} tower taller than the spire`);
  const first = await vote({ account: alice, questionId: q, value: "true", surface: "discord", idempotencyKey: "interaction-1" });
  const retry = await vote({ account: alice, questionId: q, value: "true", surface: "discord", idempotencyKey: "interaction-1" });
  assert.equal(first.outcome, "cast");
  assert.deepEqual(retry, first);
  const [{ n }] = await query<{ n: number }>(
    "select count(*)::int as n from vote_events where account_id = $1 and question_id = $2",
    [alice.id, q],
  );
  assert.equal(n, 1);
});

test("a tap before signing in is held and counted later with its original tap time", async () => {
  const q = await makeQuestion(`Is the ${tag} meadow wider than the field`);
  const tappedAt = new Date(Date.now() - 60_000);
  const held = await vote({ account: null, questionId: q, value: "false", surface: "share", tappedAt, shownAt: new Date(tappedAt.getTime() - 900) });
  assert.equal(held.outcome, "needs_signup");
  assert.ok(held.outcome === "needs_signup" && held.holdToken.length > 20);
  const token = held.outcome === "needs_signup" ? held.holdToken : "";
  assert.deepEqual(await peekHeldVote(token), { questionId: q, value: "false" });

  const claimed = await claimHeldVote(token, bob);
  assert.equal(claimed?.outcome, "cast");
  const row = await voteRow(bob.id, q);
  assert.equal(row.value, "false");
  assert.equal(row.first_surface, "share");
  assert.equal(row.first_answer_ms, 900);
  assert.equal(row.first_cast_at.getTime(), tappedAt.getTime());

  // A held tap counts once.
  assert.equal(await claimHeldVote(token, bob), null);
  assert.equal(await claimHeldVote("not-a-token", bob), null);
});

test("past the daily limit, the tap is held and counts after an upgrade", async () => {
  const q = await makeQuestion(`Is the ${tag} quarry deeper than the well`);
  const limited = await makeAccount("limited", "free");
  // Use up today's allowance with history rows (cheaper than a hundred questions).
  await query(
    `insert into vote_events (account_id, question_id, action, value, source)
     select $1, $2, 'cast', 'true', 'direct' from generate_series(1, 100)`,
    [limited.id, questionIds[0]],
  );
  const outcome = await vote({ account: limited, questionId: q, value: "true", surface: "email" });
  assert.equal(outcome.outcome, "limit_reached");
  const token = outcome.outcome === "limit_reached" ? outcome.holdToken : "";
  assert.ok(token);

  // Still over the limit: stays held.
  assert.equal((await claimHeldVote(token, limited))?.outcome, "limit_reached");
  await query("update accounts set tier = 'paid' where id = $1", [limited.id]);
  const upgraded: Account = { ...limited, tier: "paid" };
  assert.equal((await claimHeldVote(token, upgraded))?.outcome, "cast");
  assert.equal((await voteRow(limited.id, q)).first_surface, "email");
});

test("closed and missing questions, and bad input, are refused", async () => {
  const q = await makeQuestion(`Is the ${tag} pier older than the station`);
  await query("update questions set status = 'archived' where id = $1", [q]);
  assert.equal((await vote({ account: alice, questionId: q, value: "true", surface: "web" })).outcome, "closed");
  assert.equal((await vote({ account: null, questionId: q, value: "true", surface: "web" })).outcome, "closed");
  assert.equal((await vote({ account: alice, questionId: 2_000_000_000, value: "true", surface: "web" })).outcome, "invalid");
  assert.equal((await vote({ account: alice, questionId: q, value: "maybe" as "true", surface: "web" })).outcome, "invalid");
});

test("linked platform identities resolve to their account", async () => {
  const identity = { provider: "slack", tenant: `T${tag}`, userId: "U123" };
  assert.equal(await accountForIdentity(identity), null);
  await linkIdentity(alice.id, identity);
  assert.equal((await accountForIdentity(identity))?.id, alice.id);
  assert.equal(await accountForIdentity({ ...identity, tenant: "other" }), null);
});

test("shown-at tokens are signed, per question and short-lived", () => {
  const at = new Date(Date.now() - 2000);
  const token = shownToken(42, at);
  assert.equal(readShownToken(token, 42)?.getTime(), at.getTime());
  assert.equal(readShownToken(token, 43), null);
  assert.equal(readShownToken(token.replace(/.$/, (c) => (c === "A" ? "B" : "A")), 42), null);
  assert.equal(readShownToken(shownToken(42, new Date(Date.now() - 2 * 86400_000)), 42), null);
  assert.equal(readShownToken(undefined, 42), null);
  assert.equal(answerMs(at, new Date(at.getTime() + 750)), 750);
  assert.equal(answerMs(null, new Date()), null);
  assert.equal(answerMs(new Date(), new Date(Date.now() - 1000)), null);
});

test("labels and links are cleaned and recognised", () => {
  assert.equal(cleanSurface("slack"), "slack");
  assert.equal(cleanSurface("<script>"), "web");
  assert.equal(cleanPlacement("  Poster 7 / Lobby "), "poster7lobby");
  assert.equal(cleanPlacement(""), null);
  const link = voteUrl(12, { via: "qr", pick: "true" });
  assert.match(link, /\/v\/12\?via=qr&pick=true$/);
  assert.equal(questionIdFromUrl(link), 12);
  assert.equal(questionIdFromUrl(link.replace("/v/", "/embed/")), 12);
  assert.equal(questionIdFromUrl("https://elsewhere.example/v/12"), null);
  assert.equal(questionIdFromUrl("not a url"), null);
  assert.match(embedHtml(12, 'Is "it" <true>?'), /title="Is &quot;it&quot; &lt;true>\?"/);
});

test("signup without a username or password, then sign in with a texted code", async () => {
  const { startSignup, verifySignup } = await import("../lib/signup");
  const { startCodeLogin, finishCodeLogin } = await import("../lib/code-login");
  const { TERMS_VERSION } = await import("../lib/legal");
  const { verifyPassword } = await import("../lib/auth");
  process.env.SMS_DEV_CODE = "135790";
  const phone = `415${String(Date.now()).slice(-7)}`;
  const started = await startSignup({
    phone, dob: "1990-05-01", terms: TERMS_VERSION, next: "/v/resume", ip: `ip-${tag}`, device: `dev-${tag}`, challengeToken: "",
  });
  assert.ok(started.ok, started.ok ? "" : started.error);
  if (!started.ok) return;
  const done = await verifySignup(started.token, "135790");
  assert.ok(done.ok);
  if (!done.ok) return;
  assert.equal(done.next, "/v/resume");
  const [account] = await query<{ username: string; password_hash: string; terms_version: string; consented_at: Date }>(
    "select username, password_hash, terms_version, consented_at from accounts where id = $1",
    [done.accountId],
  );
  assert.match(account.username, /^belief_[a-z0-9]{8}$/);
  assert.equal(account.password_hash, "");
  assert.equal(verifyPassword("", account.password_hash), false);
  assert.equal(account.terms_version, TERMS_VERSION);
  assert.ok(account.consented_at);

  // Sign in with a texted code.
  const login = await startCodeLogin(phone, "/settings", `ip-${tag}`);
  assert.ok(login.ok);
  if (!login.ok) return;
  assert.equal((await finishCodeLogin(login.token, "000000")).ok, false);
  const signedIn = await finishCodeLogin(login.token, "135 790");
  assert.ok(signedIn.ok && signedIn.accountId === done.accountId && signedIn.next === "/settings");
  assert.equal((await finishCodeLogin(login.token, "135790")).ok, false); // used up

  // A number with no account gets the same answer, and no code ever matches.
  const nobody = await startCodeLogin(`212${String(Date.now()).slice(-7)}`, "/", `ip-${tag}`);
  assert.ok(nobody.ok);
  if (nobody.ok) assert.equal((await finishCodeLogin(nobody.token, "135790")).ok, false);
  await query("delete from accounts where id = $1", [done.accountId]);
  delete process.env.SMS_DEV_CODE;
});
