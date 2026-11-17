import { questionCard } from "@/lib/headless/cards";
import { errorBody, json, offResponse, preflight, PUBLIC_CORS, readLimit } from "@/lib/headless/http";
import { getPlacement } from "@/lib/headless/placements";

// GET /api/headless/v1/questions/:id?lang=es&placement=pl-…&origin=https://shop.example
//
// One question card (lib/headless/cards.ts). Public data, so any site may read it. With a
// placement, the answer links are labelled with it; with an origin that the placement allows,
// a hosted tap tells that page when the vote counted (never what was picked, never who).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const off = offResponse();
  if (off) return off;
  const limited = await readLimit(request, PUBLIC_CORS);
  if (limited) return limited;

  const url = new URL(request.url);
  const questionId = Number((await params).id);
  if (!Number.isInteger(questionId) || questionId <= 0) return json(errorBody("invalid", "Invalid question id."), 400, PUBLIC_CORS);

  const pid = url.searchParams.get("placement");
  const placement = pid ? await getPlacement(pid) : null;
  if (pid && (!placement || !placement.serving)) return json(errorBody("not_found", "Placement not found."), 404, PUBLIC_CORS);

  const card = await questionCard(questionId, {
    locale: url.searchParams.get("lang"),
    placement,
    returnOrigin: url.searchParams.get("origin"),
  });
  if (!card) return json(errorBody("not_found", "Question not found."), 404, PUBLIC_CORS);
  return json(card, 200, PUBLIC_CORS);
}

export const OPTIONS = () => preflight();
