import { cleanOrigin, getPlacement, isPlacementId, originAllowed, placementContext } from "./placements";
import { headlessEnabled } from "./config";

// The hosted tap (path 1): an org's button opens the one-tap vote page with
// ?via=headless&at=<placement>&pick=<answer>&ret=<the org page's origin>. The person taps on our
// page, signed in as themselves, and the vote goes through the usual engine. These helpers let
// the vote page label the vote with the placement and tell the org page that it counted.

// The org page to tell, when the front door is on and the placement allows that origin.
// The message carries only the question id: never the answer, never the handle.
export async function returnOrigin(at: string | null | undefined, ret: string | null | undefined): Promise<string | null> {
  if (!headlessEnabled() || !isPlacementId(at)) return null;
  const origin = cleanOrigin(ret);
  if (!origin) return null;
  const placement = await getPlacement(at);
  return placement?.serving && originAllowed(placement, origin) ? origin : null;
}

// What a hosted tap through a placement is labelled with in vote_events.surface_context.
export async function placementSurfaceContext(at: string | null | undefined): Promise<Record<string, unknown> | null> {
  if (!headlessEnabled() || !isPlacementId(at)) return null;
  const placement = await getPlacement(at);
  return placement?.serving ? placementContext(placement) : null;
}
