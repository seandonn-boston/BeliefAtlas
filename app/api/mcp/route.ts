import { aiHeadEnabled, answerMode, unauthorizedHeader } from "@/lib/ai-head/config";
import { handleMcp, hashAddress, inClaudeEgress } from "@/lib/ai-head/mcp";
import { linkedFor } from "@/lib/ai-head/oauth";
import { contextFromRequest } from "@/lib/consent/request";
import { baseUrl } from "@/lib/front-door";
import { ipFromRequest } from "@/lib/request";

// POST /api/mcp — the AI head's MCP server, the door the BeliefAtlas Claude plugin points at
// (belief-map/claude-plugin.md). Streamable HTTP with plain JSON answers: one JSON-RPC message
// per POST, no server-sent stream.
//
// Switched off (404) unless AI_HEAD_ENABLED=true. While answering is on (AI_HEAD_ANSWERS=count),
// every call must carry the person's own link (OAuth), so the chat app's connect step asks them
// to sign in to BeliefAtlas first. With answering off, the read tools work without a link, under a
// small per-address budget. Every call is logged as AI traffic.

const notFound = () => new Response("Not found", { status: 404 });

function originAllowed(origin: string | null): boolean {
  if (!origin) return true; // server-to-server calls, which is how Claude's apps connect
  try {
    const o = new URL(origin).origin;
    return o === new URL(baseUrl()).origin || o === "https://claude.ai" || o === "https://claude.com";
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!aiHeadEnabled()) return notFound();
  if (!originAllowed(request.headers.get("origin"))) return new Response("Forbidden", { status: 403 });

  const authorization = request.headers.get("authorization");
  const linked = await linkedFor(authorization);
  if (!linked && (authorization || answerMode() === "count")) {
    return Response.json(
      { error: "invalid_token", error_description: "Link your BeliefAtlas account to use BeliefAtlas here." },
      { status: 401, headers: { "www-authenticate": unauthorizedHeader() } },
    );
  }

  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  if (Array.isArray(message)) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Send one message per request." } }, { status: 400 });
  }

  const ip = ipFromRequest(request);
  const answer = await handleMcp(message, {
    linked,
    ipHash: hashAddress(ip),
    claudeEgress: inClaudeEgress(ip),
    consent: contextFromRequest(request, "assistant"),
  });
  if (!answer) return new Response(null, { status: 202 });
  return Response.json(answer, { headers: { "cache-control": "no-store" } });
}

// No server-sent stream and no sessions to end.
export function GET() {
  return aiHeadEnabled() ? new Response("Method not allowed", { status: 405, headers: { allow: "POST" } }) : notFound();
}
export const DELETE = GET;
