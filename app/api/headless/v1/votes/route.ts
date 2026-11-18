import { relayEnabled } from "@/lib/headless/config";
import { callerFor } from "@/lib/headless/credentials";
import { errorBody, json } from "@/lib/headless/http";
import { getPlacementOrg } from "@/lib/headless/orgs";
import { relayRule } from "@/lib/headless/plans";
import { relayVote, type RelayInput } from "@/lib/headless/relay";
import { RULES } from "@/lib/rate-limit";

// POST /api/headless/v1/votes — the server relay (switched off; decision 4 in
// belief-map/headless-front-door.md). An org's server sends a tap made in its own UI for its own
// linked user. Server to server only: a request carrying a browser Origin is refused, so an org
// credential can't be used from a web page.
//
// Body: { placementId, userId, questionId, value, idempotencyKey, shown?, lang? }
// Auth: "Authorization: Bearer <org key>" with the relay scope. Real keys are issued on /org
// once HEADLESS_KEYS_ENABLED is on, and only on a plan that includes the relay; until then only
// the test-only HEADLESS_TEST_ORG_KEYS work, never in production.
const STATUS: Record<string, number> = { invalid: 400, forbidden: 403, slow_down: 429 };

export async function POST(request: Request) {
  if (!relayEnabled()) return json(errorBody("not_found", "Not found."), 404);
  if (request.headers.get("origin")) {
    return json(errorBody("server_only", "Send votes from your server, never from a browser."), 403);
  }
  const caller = await callerFor(request.headers.get("authorization"), "relay");
  if (!caller) return json(errorBody("unauthorized", "A valid organization key with the relay scope is required."), 401);
  let rule = RULES.relayPerOrg;
  if (!caller.test && caller.orgId) {
    const org = await getPlacementOrg(caller.orgId);
    if (!org?.effective.relay) return json(errorBody("plan", "Your organization's plan doesn't include sending votes from your server."), 403);
    rule = relayRule(org.effective);
  }

  let body: Partial<RelayInput>;
  try {
    body = await request.json();
  } catch {
    return json(errorBody("invalid", "Send JSON."), 400);
  }
  const outcome = await relayVote(caller.orgSlug, {
    placementId: String(body.placementId ?? ""),
    userId: body.userId as string,
    questionId: Number(body.questionId),
    value: body.value as RelayInput["value"],
    idempotencyKey: body.idempotencyKey as string,
    shown: typeof body.shown === "string" ? body.shown : null,
    lang: typeof body.lang === "string" ? body.lang : null,
  }, rule);
  return json(outcome, STATUS[outcome.outcome] ?? 200);
}
