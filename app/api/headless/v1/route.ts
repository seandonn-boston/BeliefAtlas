import { API_BASE, API_VERSION, relayEnabled } from "@/lib/headless/config";
import { json, offResponse, preflight, PUBLIC_CORS } from "@/lib/headless/http";

// GET /api/headless/v1 — what this deployment offers. Design: belief-map/headless-front-door.md.
export async function GET() {
  const off = offResponse();
  if (off) return off;
  return json({
    version: API_VERSION,
    base: API_BASE,
    relay: relayEnabled(),
    routes: {
      question: `${API_BASE}/questions/{id}`,
      split: `${API_BASE}/questions/{id}/split`,
      placement: `${API_BASE}/placements/{placementId}`,
      results: `${API_BASE}/placements/{placementId}/results`,
      votes: `${API_BASE}/votes`,
    },
  }, 200, PUBLIC_CORS);
}

export const OPTIONS = () => preflight();
