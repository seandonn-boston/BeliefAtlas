import { timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { getAccount, type Account } from "@/lib/auth";
import {
  baseUrl, cleanSurface, confirmationLinks, HOLD_COOKIE, HOLD_COOKIE_SECONDS, readShownToken, voteUrl,
} from "@/lib/front-door";
import { accountForIdentity, CHOICES, type Choice, type PlatformIdentity } from "@/lib/vote-engine";
// W4 consent gate: no answer counts before the 'answering' agreement (lib/consent/gate.ts).
import { consentUrl, voteWithConsent } from "@/lib/consent/gate";
import { contextFromRequest } from "@/lib/consent/request";
import { cleanDeviceRegion } from "@/lib/evidence";

// POST /api/vote — the one vote API every surface calls.
//
// Body (JSON):
//   questionId      number
//   value           "true" | "false" | "unsure" (Don't know) | "skip"
//   surface         where the tap happened: "embed", "slack", "discord", ... (see lib/front-door.ts)
//   placement       optional label within the surface (a poster id, an embed's host site)
//   shown           optional token from when the question was drawn, for answer time
//   idempotencyKey  optional; a platform's interaction id. Repeats get the same answer.
//   identity        adapters only: { provider, tenant, userId } of the person who tapped
//   context         adapters only: platform ids (team, channel, message), no personal data
//   region          optional, our own pages and app only: an ISO 3166-2 code the device worked
//                   out itself ("US-MA"). Kept only on questions wired for vote evidence (E1).
//
// Two ways in:
//   * From our own pages, with the session cookie. Same-site requests only.
//   * From a platform adapter (Slack, Discord, ...), with "Authorization: Bearer <key>" from
//     ADAPTER_KEYS and the tapper's platform identity. An identity not yet linked to an
//     account gets "needs_link" and a link to answer on the vote page instead.
//
// The answer is { outcome, ... } with outcome one of cast, same, changed, skipped,
// needs_signup, needs_link, needs_consent, limit_reached, change_used, closed, slow_down, invalid.
// needs_consent (W4): the account hasn't agreed to answering yet. From our pages the tap is held
// and consentUrl leads to the agreement, which counts it; adapters get linkUrl to the vote page.

const adapterKeys = () => (process.env.ADAPTER_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);

function isAdapter(header: string | null): boolean {
  const given = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!given) return false;
  return adapterKeys().some((key) => key.length === given.length && timingSafeEqual(Buffer.from(key), Buffer.from(given)));
}

function sameSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    const o = new URL(origin);
    return o.host === host || o.origin === new URL(baseUrl()).origin;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ outcome: "invalid", message: "Send JSON." }, { status: 400 });
  }
  const questionId = Number(body.questionId);
  const value = body.value as Choice;
  const surface = cleanSurface(body.surface);
  if (!Number.isInteger(questionId) || questionId <= 0 || !CHOICES.includes(value)) {
    return Response.json({ outcome: "invalid", message: "That vote wasn't valid." }, { status: 400 });
  }

  const adapter = isAdapter(request.headers.get("authorization"));
  let account: Account | null;
  if (adapter) {
    const raw = body.identity as Partial<PlatformIdentity> | undefined;
    if (!raw || typeof raw.provider !== "string" || typeof raw.userId !== "string") {
      return Response.json({ outcome: "invalid", message: "identity is required." }, { status: 400 });
    }
    account = await accountForIdentity({ provider: raw.provider, tenant: raw.tenant ?? null, userId: raw.userId });
    if (!account) {
      // Linking a platform account is the next wave; until then they answer on the vote page.
      return Response.json({ outcome: "needs_link", questionId, linkUrl: voteUrl(questionId, { via: surface, pick: value }) });
    }
  } else {
    if (!sameSite(request)) return Response.json({ outcome: "invalid", message: "Not allowed." }, { status: 403 });
    account = await getAccount();
  }

  // W4: an adapter's request comes from the platform's servers, so its GPC and country headers
  // aren't the tapper's: they're ignored there, and the tap isn't held (no cookie to hold it in).
  const ctx = adapter ? { gpc: false, region: null, surface, lang: "en" } : contextFromRequest(request, surface);
  const outcome = await voteWithConsent({
    account,
    questionId,
    value,
    surface,
    placement: typeof body.placement === "string" ? body.placement : null,
    surfaceContext: adapter && body.context && typeof body.context === "object" ? (body.context as Record<string, unknown>) : null,
    shownAt: readShownToken(body.shown, questionId),
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : null,
    // E1: only the tapper's own device can say where it is, so a platform adapter's region is ignored.
    region: adapter ? null : cleanDeviceRegion(body.region),
  }, ctx, { hold: !adapter });

  if (outcome.outcome === "needs_signup" || ((outcome.outcome === "limit_reached" || outcome.outcome === "needs_consent") && !adapter)) {
    (await cookies()).set(HOLD_COOKIE, outcome.holdToken, {
      path: "/", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: HOLD_COOKIE_SECONDS,
    });
  }

  switch (outcome.outcome) {
    case "cast":
    case "same":
    case "changed":
      return Response.json({ outcome: outcome.outcome, questionId, value: outcome.value, handle: outcome.handle, ...confirmationLinks(questionId) });
    case "skipped":
      return Response.json({ outcome: "skipped", questionId, handle: outcome.handle });
    case "needs_signup":
      return Response.json({ outcome: "needs_signup", questionId, signupUrl: `/signup?next=${encodeURIComponent("/v/resume")}` });
    case "needs_consent":
      return Response.json(adapter
        ? { outcome: "needs_consent", questionId, linkUrl: voteUrl(questionId, { via: surface, pick: value }) }
        : { outcome: "needs_consent", questionId, consentUrl: consentUrl("/v/resume", surface) });
    case "limit_reached":
      return Response.json({ outcome: "limit_reached", questionId, message: outcome.message, upgradeUrl: "/membership" });
    case "invalid":
      return Response.json({ outcome: "invalid", questionId, message: outcome.message }, { status: 400 });
    case "slow_down":
      return Response.json({ outcome: "slow_down", questionId, message: outcome.message }, { status: 429 });
    default:
      return Response.json({ outcome: outcome.outcome, questionId, message: outcome.message });
  }
}
