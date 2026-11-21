import { aiHeadEnabled } from "@/lib/ai-head/config";
import { registerClient } from "@/lib/ai-head/oauth";
import { hit, type Rule } from "@/lib/rate-limit";
import { ipFromRequest } from "@/lib/request";

// POST /api/oauth/register — OAuth dynamic client registration (RFC 7591) for AI assistants.
// Registering makes an AI *client*, never an account; only Claude's callback addresses are
// accepted for now (lib/ai-head/oauth.ts). 404 while AI_HEAD_ENABLED is off.

const perAddress: Rule = { name: "ai-register", limit: 10, windowSeconds: 3600 };

export async function POST(request: Request) {
  if (!aiHeadEnabled()) return new Response("Not found", { status: 404 });
  if (await hit([perAddress, ipFromRequest(request)])) {
    return Response.json({ error: "slow_down", error_description: "Too many registrations." }, { status: 429 });
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_client_metadata", error_description: "Send JSON." }, { status: 400 });
  }
  const result = await registerClient(body);
  if (!result.ok) return Response.json({ error: result.error, error_description: result.description }, { status: 400 });
  const c = result.client;
  return Response.json(
    {
      client_id: c.id,
      client_name: c.clientName,
      redirect_uris: c.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}
