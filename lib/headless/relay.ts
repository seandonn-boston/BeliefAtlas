import { timingSafeEqual } from "crypto";
import { readShownToken } from "../front-door";
import { voteWithConsent } from "../consent/gate";
import { hit, RULES, tooMany } from "../rate-limit";
import { accountForIdentity, CHOICES, type Choice } from "../vote-engine";
import { answerUrl } from "./cards";
import { testOrgKeys } from "./config";
import { getPlacement, placementContext, surfaceFor, type Placement } from "./placements";

// The server relay (path 3, switched off): an org's server sends a tap made in its own UI, for
// its own user id, which that person linked to their BeliefAtlas account once. The vote still goes
// through voteWithConsent() -> vote() -> castVote(), so consent, limits, the change rule and
// idempotency are exactly the engine's.
//
// What the org gets back never includes the person's BeliefAtlas handle. It already knows what its
// user tapped (the tap happened in its UI), which is why this path is off by recommendation
// (decision 4 in belief-map/headless-front-door.md).

export type RelayInput = {
  placementId: string;
  userId: string;          // the org's own opaque id for its user; never an email or phone number
  questionId: number;
  value: Choice;
  idempotencyKey: string;  // the org's own id for this interaction
  shown?: string | null;   // the card's shown token
  lang?: string | null;
};

export type RelayOutcome =
  | { outcome: "cast" | "same" | "changed"; questionId: number; value: Choice }
  | { outcome: "skipped"; questionId: number }
  | { outcome: "needs_link" | "needs_consent"; questionId: number; linkUrl: string }
  | { outcome: "limit_reached" | "change_used" | "closed" | "slow_down" | "invalid" | "forbidden"; questionId: number; message: string };

// Which test org a relay credential belongs to, or null. Only test credentials exist; real
// issuance waits for Sean (decision 3).
export function orgForCredential(authorization: string | null, env: Record<string, string | undefined> = process.env): string | null {
  const given = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!given) return null;
  for (const [key, slug] of testOrgKeys(env)) {
    if (key.length === given.length && timingSafeEqual(Buffer.from(key), Buffer.from(given))) return slug;
  }
  return null;
}

export const cleanUserId = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  // Opaque ids only: an email address or a phone number is personal data we don't take.
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(v) || /^\+?\d{7,15}$/.test(v)) return null;
  return v;
};

export async function relayVote(orgSlug: string, input: RelayInput): Promise<RelayOutcome> {
  const questionId = input.questionId;
  const bad = (message: string): RelayOutcome => ({ outcome: "invalid", questionId, message });
  if (!Number.isInteger(questionId) || questionId <= 0 || !CHOICES.includes(input.value)) return bad("That vote wasn't valid.");
  const userId = cleanUserId(input.userId);
  if (!userId) return bad("userId must be your own opaque id for the person (letters, digits, . _ : -), never an email or phone number.");
  if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim()) return bad("idempotencyKey is required.");

  const placement: Placement | null = await getPlacement(input.placementId);
  if (!placement || placement.orgSlug !== orgSlug) return { outcome: "forbidden", questionId, message: "That placement isn't yours." };
  if (!placement.serving) return { outcome: "forbidden", questionId, message: "That placement isn't switched on." };
  if (placement.questionIds.length && !placement.questionIds.includes(questionId)) {
    return { outcome: "forbidden", questionId, message: "That question isn't in this placement." };
  }

  const identity = { provider: `org:${placement.orgSlug}`, tenant: String(placement.orgId), userId };
  const limited = await hit([RULES.relayPerOrg, placement.orgSlug], [RULES.votesPerIdentity, `${identity.provider}:${identity.tenant}:${userId}`]);
  if (limited) return { outcome: "slow_down", questionId, message: tooMany(limited) };

  const surface = surfaceFor(placement.kind);
  const hosted = answerUrl(questionId, input.value, { surface, placement: placement.id });
  const account = await accountForIdentity(identity);
  if (!account) return { outcome: "needs_link", questionId, linkUrl: hosted };

  const outcome = await voteWithConsent({
    account,
    questionId,
    value: input.value,
    surface,
    placement: placement.id,
    surfaceContext: placementContext(placement),
    shownAt: readShownToken(input.shown, questionId),
    // Scoped to the org so two orgs' ids can't collide; vote() scopes it to the account too.
    idempotencyKey: `org:${placement.orgSlug}:${input.idempotencyKey.trim().slice(0, 150)}`,
    lang: input.lang ?? null,
    // The relay comes from the org's servers: its headers say nothing about the person, so no
    // GPC or region from them, and no hold (there's no browser to hold it in).
  }, { gpc: false, region: null, surface, lang: "en" }, { hold: false });

  switch (outcome.outcome) {
    case "cast":
    case "same":
    case "changed":
      return { outcome: outcome.outcome, questionId, value: outcome.value };
    case "skipped":
      return { outcome: "skipped", questionId };
    case "needs_consent":
    case "needs_signup":
      return { outcome: outcome.outcome === "needs_consent" ? "needs_consent" : "needs_link", questionId, linkUrl: hosted };
    default:
      return { outcome: outcome.outcome, questionId, message: outcome.message };
  }
}
