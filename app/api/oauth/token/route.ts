import { aiHeadEnabled } from "@/lib/ai-head/config";
import { exchange } from "@/lib/ai-head/oauth";

// POST /api/oauth/token — swaps a one-use code (with its PKCE verifier) or a refresh token for a
// new access and refresh token. Form-encoded, as OAuth requires. 404 while AI_HEAD_ENABLED is off.

export async function POST(request: Request) {
  if (!aiHeadEnabled()) return new Response("Not found", { status: 404 });
  let form: Record<string, string | undefined>;
  try {
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("application/json")) form = await request.json();
    else form = Object.fromEntries(new URLSearchParams(await request.text())) as Record<string, string>;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const result = await exchange(form);
  const headers = { "cache-control": "no-store", pragma: "no-cache" };
  if (!result.ok) return Response.json({ error: result.error }, { status: result.error === "invalid_client" ? 401 : 400, headers });
  return Response.json(result.body, { headers });
}
