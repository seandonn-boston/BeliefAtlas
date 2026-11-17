import { getAccount } from "@/lib/auth";
import { errorBody, json, offResponse } from "@/lib/headless/http";
import { getPlacement, isOrgMember, placementResults } from "@/lib/headless/placements";
import { hit, RULES, tooMany } from "@/lib/rate-limit";
import { minGroupSize } from "@/lib/regions";

// GET /api/headless/v1/placements/:placementId/results
//
// Aggregate answers given through a placement, for the org's own people only: the caller must
// be signed in to BeliefAtlas as a member of the org that owns it. No key. Small groups are hidden,
// seed votes never count, test votes don't count in production, and nothing is person-level
// (decision 2 in belief-map/headless-front-door.md). No CORS: read it in the BeliefAtlas app or
// from a same-site page.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const off = offResponse();
  if (off) return off;
  const account = await getAccount();
  if (!account) return json(errorBody("needs_signin", "Sign in to BeliefAtlas as a member of this organization."), 401);
  const limited = await hit([RULES.resultsPerAccount, String(account.id)]);
  if (limited) return json(errorBody("slow_down", tooMany(limited)), 429);

  const placement = await getPlacement((await params).id);
  // Not found and not yours look the same, so placement ids can't be probed.
  if (!placement || !(await isOrgMember(account.id, placement.orgId))) {
    return json(errorBody("not_found", "Placement not found."), 404);
  }
  const min = await minGroupSize();
  return json({
    placement: { id: placement.id, label: placement.label, kind: placement.kind },
    minGroupSize: min,
    questions: await placementResults(placement, min),
  });
}
