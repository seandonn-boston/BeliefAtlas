import { getAccount } from "@/lib/auth";
import { errorBody, json, offResponse } from "@/lib/headless/http";
import { cardLocale } from "@/lib/headless/cards";
import { callerFor } from "@/lib/headless/credentials";
import { unofficialNotice } from "@/lib/headless/notice";
import { getPlacement, isOrgMember, placementResults } from "@/lib/headless/placements";
import { hit, RULES, tooMany } from "@/lib/rate-limit";
import { minGroupSize } from "@/lib/regions";

// GET /api/headless/v1/placements/:placementId/results
//
// Aggregate answers given through a placement, for the org's own people only: the caller must
// be signed in to BeliefAtlas as a member of the org that owns it, or be the org's server with a key
// that has the results scope (keys are switched off until HEADLESS_KEYS_ENABLED; a key is never
// accepted from a browser). Small groups are hidden,
// seed votes never count, test votes don't count in production, and nothing is person-level
// (decision 2 in belief-map/headless-front-door.md). No CORS: read it in the BeliefAtlas app or
// from a same-site page.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const off = offResponse();
  if (off) return off;
  const authorization = request.headers.get("authorization");
  let orgId: number | null = null;
  let who: string;
  if (authorization) {
    if (request.headers.get("origin")) return json(errorBody("server_only", "Use an organization key from your server, never from a browser."), 403);
    const caller = await callerFor(authorization, "results");
    if (!caller?.orgId) return json(errorBody("unauthorized", "A valid organization key with the results scope is required."), 401);
    orgId = caller.orgId;
    who = `key:${caller.credentialId}`;
  } else {
    const account = await getAccount();
    if (!account) return json(errorBody("needs_signin", "Sign in to BeliefAtlas as a member of this organization."), 401);
    who = String(account.id);
    const placement = await getPlacement((await params).id);
    if (placement && (await isOrgMember(account.id, placement.orgId))) orgId = placement.orgId;
  }
  const limited = await hit([RULES.resultsPerAccount, who]);
  if (limited) return json(errorBody("slow_down", tooMany(limited)), 429);

  const placement = await getPlacement((await params).id);
  // Not found and not yours look the same, so placement ids can't be probed.
  if (!placement || orgId === null || placement.orgId !== orgId) {
    return json(errorBody("not_found", "Placement not found."), 404);
  }
  const min = await minGroupSize();
  return json({
    placement: { id: placement.id, label: placement.label, kind: placement.kind },
    minGroupSize: min,
    questions: await placementResults(placement, min),
    // Exports carry the notice too (Sean's rule), so a copied chart still says it's unofficial.
    notice: await unofficialNotice(cardLocale(new URL(request.url).searchParams.get("lang"))),
  });
}
