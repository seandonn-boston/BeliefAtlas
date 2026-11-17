import { placementCards } from "@/lib/headless/cards";
import { errorBody, json, offResponse, readLimit } from "@/lib/headless/http";
import { cleanOrigin, getPlacement, originAllowed } from "@/lib/headless/placements";
import { API_VERSION, headlessEnabled } from "@/lib/headless/config";

// GET /api/headless/v1/placements/:placementId?lang=es&origin=https://shop.example
//
// The placement and its question cards, in order. Servers may call it from anywhere; browsers
// only from the placement's allowed origins (CORS). A placement that isn't serving (org not
// active, switched off, not marked as not child-directed) is 404.
function cors(request: Request, allowed: (origin: string) => boolean): Record<string, string> {
  const origin = cleanOrigin(request.headers.get("origin"));
  return origin && allowed(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" }
    : { Vary: "Origin" };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const off = offResponse();
  if (off) return off;
  const placement = await getPlacement((await params).id);
  const headers = placement ? cors(request, (o) => originAllowed(placement, o)) : { Vary: "Origin" };
  const limited = await readLimit(request, headers);
  if (limited) return limited;
  if (!placement || !placement.serving) return json(errorBody("not_found", "Placement not found."), 404, headers);

  const url = new URL(request.url);
  const cards = await placementCards(placement, { locale: url.searchParams.get("lang"), returnOrigin: url.searchParams.get("origin") });
  return json({
    version: API_VERSION,
    placement: { id: placement.id, kind: placement.kind, label: placement.label, org: { slug: placement.orgSlug, name: placement.orgName } },
    questions: cards,
  }, 200, headers);
}

export async function OPTIONS(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!headlessEnabled()) return new Response(null, { status: 404 });
  const placement = await getPlacement((await params).id);
  return new Response(null, { status: 204, headers: placement ? cors(request, (o) => originAllowed(placement, o)) : { Vary: "Origin" } });
}
