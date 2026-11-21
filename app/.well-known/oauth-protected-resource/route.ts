import { protectedResourceMetadata, whenEnabled } from "@/lib/ai-head/config";

// OAuth protected-resource metadata for the AI head's MCP server (claude-plugin.md). 404 while
// AI_HEAD_ENABLED is off.
export function GET() {
  return whenEnabled(() => Response.json(protectedResourceMetadata(), { headers: { "cache-control": "public, max-age=300" } }));
}
