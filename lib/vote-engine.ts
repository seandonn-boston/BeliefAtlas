import { createHash, randomBytes } from "crypto";
import { query, transaction } from "./db";
import type { Account } from "./auth";
import { cleanPlacement, cleanSurface, type Surface } from "./front-door";
import { hit, RULES, tooMany } from "./rate-limit";
import { invalidateSplits } from "./stats";
import { castVote, cleanLang, skip, type Source, type VoteValue } from "./votes";

// The one vote engine. Every surface (the website, share links, embeds, QR codes, and the
// Slack, Discord, text and email adapters that come next) calls vote() and gets back an
// outcome it can draw in its own way. Limits, the once-a-day change rule, idempotency and the
// labels on the data all live here and in lib/votes.ts, nowhere else.

// What a surface offers: True, False and Don't know are votes; Skip is not. "Don't know" is
// stored as 'unsure', counts in the split, and uses one of the day's votes like any vote.
// Skip adds nothing to the split and uses no votes.
export type Choice = VoteValue | "skip";
export const CHOICES: Choice[] = ["true", "false", "unsure", "skip"];
export const CHOICE_LABELS: Record<Choice, string> = { true: "True", false: "False", unsure: "Don't know", skip: "Skip" };

export type VoteInput = {
  account: Account | null;
  questionId: number;
  value: Choice;
  surface: Surface | string;
  placement?: string | null;
  surfaceContext?: Record<string, unknown> | null;
  shownAt?: Date | null;
  tappedAt?: Date;
  idempotencyKey?: string | null;   // a platform's interaction id, or a per-tap key from our pages
  isPrivate?: boolean;
  source?: Source;
  lang?: string | null;             // the language the question was shown in, e.g. "en" or "pt-BR"
};

export type VoteOutcome =
  | { outcome: "cast" | "same" | "changed"; questionId: number; value: VoteValue; handle: string }
  | { outcome: "skipped"; questionId: number; handle: string }
  | { outcome: "needs_signup"; questionId: number; holdToken: string }
  | { outcome: "limit_reached"; questionId: number; message: string; holdToken: string }
  | { outcome: "change_used" | "closed" | "slow_down" | "invalid"; questionId: number; message: string };

export const isCounted = (o: VoteOutcome) => o.outcome === "cast" || o.outcome === "same" || o.outcome === "changed";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Count a tap for a signed-in account. Never holds; that is the caller's choice.
async function apply(account: Account, input: VoteInput): Promise<VoteOutcome> {
  const questionId = input.questionId;
  const meta = {
    surface: cleanSurface(input.surface),
    placement: cleanPlacement(input.placement),
    surfaceContext: input.surfaceContext ?? null,
    shownAt: input.shownAt ?? null,
    tappedAt: input.tappedAt ?? new Date(),
    lang: cleanLang(input.lang),
  };
  const source = input.source ?? "direct";
  if (input.value === "skip") {
    if (!(await skip(account, questionId, source, meta))) {
      // Not recorded: either it's already answered (a skip changes nothing) or it's closed.
      const [q] = await query<{ status: string }>("select status from questions where id = $1", [questionId]);
      if (!q || q.status === "archived" || q.status === "removed") {
        return { outcome: "closed", questionId, message: "This question is closed to new votes." };
      }
    }
    return { outcome: "skipped", questionId, handle: account.username };
  }
  const value = input.value;

  const result = await castVote(account, questionId, value, input.isPrivate ?? false, source, meta);
  if (result.ok) {
    // This instance shows the new split straight away; others catch up within the cache's TTL.
    if (result.outcome !== "same") invalidateSplits([questionId]);
    return { outcome: result.outcome ?? "cast", questionId, value, handle: account.username };
  }
  switch (result.code) {
    case "limit_reached":
      return { outcome: "limit_reached", questionId, message: result.error, holdToken: "" };
    case "closed":
      return { outcome: "closed", questionId, message: result.error };
    case "banned":
      return { outcome: "invalid", questionId, message: result.error };
    default:
      return { outcome: "change_used", questionId, message: result.error };
  }
}

// Hold a tap for a day, to be counted once the person signs up, signs in or upgrades.
// Returns the token; only its hash is stored.
export async function holdVote(input: VoteInput, reason: "needs_signup" | "limit_reached" | "needs_consent"): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await query(
    `insert into pending_votes (token_hash, question_id, value, surface, placement, surface_context, shown_at, tapped_at, reason, lang)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      hashToken(token),
      input.questionId,
      input.value,
      cleanSurface(input.surface),
      cleanPlacement(input.placement),
      input.surfaceContext ? JSON.stringify(input.surfaceContext) : null,
      input.shownAt ?? null,
      input.tappedAt ?? new Date(),
      reason,
      cleanLang(input.lang),
    ],
  );
  if (Math.random() < 0.02) {
    await query("delete from pending_votes where expires_at < now() - interval '1 day'");
    await query("delete from vote_requests where created_at < now() - interval '2 days'");
  }
  return token;
}

export async function vote(input: VoteInput): Promise<VoteOutcome> {
  const questionId = input.questionId;
  if (!Number.isInteger(questionId) || questionId <= 0 || !CHOICES.includes(input.value)) {
    return { outcome: "invalid", questionId, message: "That vote wasn't valid." };
  }
  const notFound: VoteOutcome = { outcome: "invalid", questionId, message: "That question wasn't found." };
  const status = async () =>
    (await query<{ status: string }>("select status from questions where id = $1", [questionId]))[0]?.status ?? null;

  if (!input.account) {
    const s = await status();
    if (!s || s === "removed") return notFound;
    if (s !== "active") return { outcome: "closed", questionId, message: "This question is closed to new votes." };
    return { outcome: "needs_signup", questionId, holdToken: await holdVote(input, "needs_signup") };
  }
  const account = input.account;

  // A repeat of a request we've already answered (a platform retry, a double tap) gets the
  // same answer and changes nothing.
  const key = input.idempotencyKey ? `${account.id}:${String(input.idempotencyKey).slice(0, 200)}` : null;
  if (key) {
    const [seen] = await query<{ result: VoteOutcome }>(
      "select result from vote_requests where idempotency_key = $1",
      [key],
    );
    if (seen) return seen.result;
  }

  // Anti-abuse ceiling per account (never per IP or device).
  const limited = await hit([RULES.votesPerAccount, String(account.id)]);
  if (limited) return { outcome: "slow_down", questionId, message: tooMany(limited) };

  // The question's status is checked inside the vote's own transaction (lib/votes.ts): archived
  // and removed questions take no answers, changes or skips. Only a refusal needs to know which,
  // because a missing or removed question reads as not found rather than closed.
  let outcome = await apply(account, input);
  if (outcome.outcome === "closed") {
    const s = await status();
    if (!s || s === "removed") outcome = notFound;
  }
  if (outcome.outcome === "limit_reached") {
    outcome = { ...outcome, holdToken: await holdVote(input, "limit_reached") };
  }
  if (key) {
    await query(
      "insert into vote_requests (idempotency_key, account_id, result) values ($1, $2, $3) on conflict do nothing",
      [key, account.id, JSON.stringify(outcome)],
    );
  }
  return outcome;
}

// Count a held tap for the account that just signed up, signed in or upgraded, with the
// original tap time and surface. A tap still over the daily limit stays held.
export async function claimHeldVote(token: string, account: Account): Promise<VoteOutcome | null> {
  const tokenHash = hashToken(token);
  const held = await transaction(async (client) => {
    const res = await client.query<{
      question_id: number; value: Choice; surface: string; placement: string | null;
      surface_context: Record<string, unknown> | null; shown_at: Date | null; tapped_at: Date; lang: string | null;
    }>(
      `select question_id, value, surface, placement, surface_context, shown_at, tapped_at, lang
         from pending_votes
        where token_hash = $1 and claimed_at is null and expires_at > now()
        for update skip locked`,
      [tokenHash],
    );
    const row = res.rows[0];
    if (!row) return null;
    await client.query("update pending_votes set claimed_by = $2, claimed_at = now() where token_hash = $1", [tokenHash, account.id]);
    return row;
  });
  if (!held) return null;

  const outcome = await apply(account, {
    account,
    questionId: held.question_id,
    value: held.value,
    surface: held.surface,
    placement: held.placement,
    surfaceContext: held.surface_context,
    shownAt: held.shown_at,
    tappedAt: held.tapped_at,
    lang: held.lang,
  });
  if (outcome.outcome === "limit_reached") {
    // Still over today's limit: put it back so an upgrade can count it.
    await query("update pending_votes set claimed_by = null, claimed_at = null where token_hash = $1", [tokenHash]);
    return { ...outcome, holdToken: token };
  }
  return outcome;
}

// Which question a held tap is for, and what was picked, without claiming it.
export async function peekHeldVote(token: string): Promise<{ questionId: number; value: Choice } | null> {
  const [row] = await query<{ question_id: number; value: Choice }>(
    "select question_id, value from pending_votes where token_hash = $1 and claimed_at is null and expires_at > now()",
    [hashToken(token)],
  );
  return row ? { questionId: row.question_id, value: row.value } : null;
}

// ---------- Linked platform identities (used by the adapters that come next) ----------

export type PlatformIdentity = { provider: string; tenant?: string | null; userId: string };

export async function accountForIdentity(identity: PlatformIdentity): Promise<Account | null> {
  const [row] = await query<Account>(
    `select a.id, a.username, a.tier, a.verified, a.role
       from linked_identities l join accounts a on a.id = l.account_id
      where l.provider = $1 and l.provider_tenant = $2 and l.provider_user_id = $3
        and l.revoked_at is null and a.deleted_at is null`,
    [identity.provider, identity.tenant ?? "", identity.userId],
  );
  if (row) {
    await query(
      "update linked_identities set last_used_at = now() where provider = $1 and provider_tenant = $2 and provider_user_id = $3",
      [identity.provider, identity.tenant ?? "", identity.userId],
    );
  }
  return row ?? null;
}

export async function linkIdentity(accountId: number, identity: PlatformIdentity): Promise<void> {
  await query(
    `insert into linked_identities (account_id, provider, provider_tenant, provider_user_id)
     values ($1, $2, $3, $4)
     on conflict (provider, provider_tenant, provider_user_id)
     do update set account_id = excluded.account_id, linked_at = now(), revoked_at = null`,
    [accountId, identity.provider, identity.tenant ?? "", identity.userId],
  );
}
