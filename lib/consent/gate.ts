import { createHash } from "crypto";
import type { Account } from "../auth";
import { query, transaction } from "../db";
import { SOURCES, type Source } from "../votes";
import {
  CHOICES, claimHeldVote, holdVote, vote, type Choice, type VoteInput, type VoteOutcome,
} from "../vote-engine";
import type { ConsentContext } from "./context";
import { hasAnsweringConsent, honorGpc } from "./ledger";

// The consent gate in front of the vote engine. Every surface that counts an answer (the feed,
// the question page, the one-tap /v page and the embeds that open it, the vote API and the
// platform adapters) calls voteWithConsent() instead of vote():
//
//   * signed out: vote() holds the tap and asks them to sign up, as before; /v/resume then
//     sends them through /consent before the held tap is claimed;
//   * signed in, no agreement to answering yet: the tap is held ('needs_consent') and nothing
//     is counted; the caller sends them to /consent, which counts the tap once they agree;
//   * signed in and agreed: vote() as usual.
//
// A Global Privacy Control signal on the tap records a sale opt-out on the way through.

export type GateOutcome = VoteOutcome | { outcome: "needs_consent"; questionId: number; holdToken: string };

export type GateOptions = {
  // Platform adapters can't put the hold cookie on the tapper's browser, so they don't hold:
  // they send the person to the vote page, where the tap is made again and held there.
  hold?: boolean;
};

// Where to send someone whose tap was held for consent. `next` is where to return afterwards.
export function consentUrl(next: string, surface?: string): string {
  const params = new URLSearchParams({ next });
  if (surface && surface !== "web") params.set("via", surface);
  return `/consent?${params}`;
}

// Same hashing as lib/vote-engine.ts: only the hash of a hold token is stored.
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Hold a tap until they agree, keeping "vote privately" and the feed it came from, which the
// vote engine's own holds don't carry.
export async function holdForConsent(input: VoteInput): Promise<string> {
  const token = await holdVote(input, "needs_consent");
  if (input.isPrivate || input.source) {
    await query("update pending_votes set is_private = $2, source = $3 where token_hash = $1", [
      hashToken(token), Boolean(input.isPrivate), input.source ?? null,
    ]);
  }
  return token;
}

export async function voteWithConsent(input: VoteInput, ctx: ConsentContext, opts: GateOptions = {}): Promise<GateOutcome> {
  if (!input.account) return vote(input);
  const account = input.account;
  await honorGpc(account.id, ctx);
  if (await hasAnsweringConsent(account.id)) return vote(input);

  // Same checks vote() makes before counting, so a held tap is always one that could count.
  const questionId = input.questionId;
  if (!Number.isInteger(questionId) || questionId <= 0 || !CHOICES.includes(input.value)) {
    return { outcome: "invalid", questionId, message: "That vote wasn't valid." };
  }
  const [question] = await query<{ status: string }>("select status from questions where id = $1", [questionId]);
  if (!question || question.status === "removed") {
    return { outcome: "invalid", questionId, message: "That question wasn't found." };
  }
  if (question.status !== "active") return { outcome: "closed", questionId, message: "This question is closed to new votes." };

  const holdToken = opts.hold === false ? "" : await holdForConsent(input);
  return { outcome: "needs_consent", questionId, holdToken };
}

// ---------- Held taps ----------

export type HeldTap = { questionId: number; value: Choice; surface: string; reason: string; isPrivate: boolean };

// What a hold token is waiting with, without claiming it.
export async function peekHold(token: string): Promise<HeldTap | null> {
  const [row] = await query<{ question_id: number; value: Choice; surface: string; reason: string; is_private: boolean }>(
    `select question_id, value, surface, reason, is_private from pending_votes
      where token_hash = $1 and claimed_at is null and expires_at > now()`,
    [hashToken(token)],
  );
  return row ? { questionId: row.question_id, value: row.value, surface: row.surface, reason: row.reason, isPrivate: row.is_private } : null;
}

// Count a held tap for an account that has agreed to answering. Holds made by the gate (and
// any private hold) are claimed here so "vote privately" and the source carry through; every
// other hold goes to the vote engine's claimHeldVote(). Returns null when there's nothing to
// claim, and refuses (null) for an account without the agreement: nothing counts before it.
export async function claimHeld(token: string, account: Account): Promise<VoteOutcome | null> {
  if (!(await hasAnsweringConsent(account.id))) return null;
  const tokenHash = hashToken(token);
  const [meta] = await query<{ reason: string; is_private: boolean }>(
    "select reason, is_private from pending_votes where token_hash = $1 and claimed_at is null and expires_at > now()",
    [tokenHash],
  );
  if (!meta) return null;
  if (meta.reason !== "needs_consent" && !meta.is_private) return claimHeldVote(token, account);

  const held = await transaction(async (client) => {
    const res = await client.query<{
      question_id: number; value: Choice; surface: string; placement: string | null; is_private: boolean; source: string | null;
      surface_context: Record<string, unknown> | null; shown_at: Date | null; tapped_at: Date;
    }>(
      `select question_id, value, surface, placement, is_private, source, surface_context, shown_at, tapped_at
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

  const input: VoteInput = {
    account,
    questionId: held.question_id,
    value: held.value,
    surface: held.surface,
    placement: held.placement,
    surfaceContext: held.surface_context,
    shownAt: held.shown_at,
    tappedAt: held.tapped_at,
    isPrivate: held.is_private,
    source: SOURCES.includes(held.source as Source) ? (held.source as Source) : undefined,
  };
  const outcome = await vote(input);
  // Over today's limit: vote() held it again; keep it private on the new hold too.
  if (outcome.outcome === "limit_reached" && held.is_private) {
    await query("update pending_votes set is_private = true, source = $2 where token_hash = $1", [
      hashToken(outcome.holdToken), held.source,
    ]);
  }
  return outcome;
}

// For the website's own vote forms, which count through castVote() directly: hold the tap and
// return its token when the account hasn't agreed to answering yet, or null to count it now.
// Records a GPC opt-out on the way through, like voteWithConsent().
export async function holdIfNoConsent(input: VoteInput & { account: Account }, ctx: ConsentContext): Promise<string | null> {
  await honorGpc(input.account.id, ctx);
  if (await hasAnsweringConsent(input.account.id)) return null;
  return holdForConsent(input);
}
