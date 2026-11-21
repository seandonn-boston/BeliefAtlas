import { authorizationServerMetadata, whenEnabled } from "@/lib/ai-head/config";

// OAuth authorization-server metadata for linking a BeliefAtlas account to an AI assistant
// (claude-plugin.md). 404 while AI_HEAD_ENABLED is off.
export function GET() {
  return whenEnabled(() => Response.json(authorizationServerMetadata(), { headers: { "cache-control": "public, max-age=300" } }));
}
