import { relayEnabled } from "@/lib/headless/config";
import { errorBody, json } from "@/lib/headless/http";
import { orgForCredential, relayVote, type RelayInput } from "@/lib/headless/relay";

// POST /api/headless/v1/votes — the server relay (switched off; decision 4 in
// belief-map/headless-front-door.md). An org's server sends a tap made in its own UI for its own
// linked user. Server to server only: a request carrying a browser Origin is refused, so an org
// credential can't be used from a web page.
//
// Body: { placementId, userId, questionId, value, idempotencyKey, shown?, lang? }
// Auth: "Authorization: Bearer <org credential>". No credentials are issued yet; only the
// test-only HEADLESS_TEST_ORG_KEYS work, and never in production.
const STATUS: Record<string, number> = { invalid: 400, forbidden: 403, slow_down: 429 };

export async function POST(request: Request) {
  if (!relayEnabled()) return json(errorBody("not_found", "Not found."), 404);
  if (request.headers.get("origin")) {
    return json(errorBody("server_only", "Send votes from your server, never from a browser."), 403);
  }
  const orgSlug = orgForCredential(request.headers.get("authorization"));
  if (!orgSlug) return json(errorBody("unauthorized", "A valid organization credential is required."), 401);

  let body: Partial<RelayInput>;
  try {
    body = await request.json();
  } catch {
    return json(errorBody("invalid", "Send JSON."), 400);
  }
  const outcome = await relayVote(orgSlug, {
    placementId: String(body.placementId ?? ""),
    userId: body.userId as string,
    questionId: Number(body.questionId),
    value: body.value as RelayInput["value"],
    idempotencyKey: body.idempotencyKey as string,
    shown: typeof body.shown === "string" ? body.shown : null,
    lang: typeof body.lang === "string" ? body.lang : null,
  });
  return json(outcome, STATUS[outcome.outcome] ?? 200);
}
