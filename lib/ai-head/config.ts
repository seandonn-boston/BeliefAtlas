import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { baseUrl } from "../front-door";

// Switches for the AI head (belief-map/claude-plugin.md, section 6). All off by default.
//
//   AI_HEAD_ENABLED=true      /api/mcp, the OAuth pages and discovery files exist. Read tools
//                             only: find questions, show a card, read results.
//   AI_HEAD_ANSWERS=count     the card shows answer buttons for linked people, and a tap counts.
//                             Anything else (default "off"): the card shows no buttons.
//
// In production both also need PUBLIC_BASE_URL, so nothing goes out before the domain is
// chosen (Sean, 17 Nov 2026).
//
// An AI client never gets an account and never votes (Sean, 20 Nov 2026). Only the person's own
// tap on BeliefAtlas's card counts, through the same vote engine as every other door.

export type AnswerMode = "off" | "count";

const isProduction = (env: NodeJS.ProcessEnv) => env.VERCEL_ENV === "production";

export function aiHeadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AI_HEAD_ENABLED !== "true") return false;
  if (isProduction(env) && !env.PUBLIC_BASE_URL) return false;
  return true;
}

export function answerMode(env: NodeJS.ProcessEnv = process.env): AnswerMode {
  if (!aiHeadEnabled(env)) return "off";
  return env.AI_HEAD_ANSWERS === "count" ? "count" : "off";
}

export const mcpUrl = () => `${baseUrl()}/api/mcp`;
export const issuer = () => baseUrl();

// The one scope a person grants: see cards, send the answers they tap, read results.
export const SCOPE = "beliefatlas.cards";

// The words on the consent page, versioned so we know which one each person agreed to.
// A draft until a lawyer has read it, like the other consent texts.
export const CONSENT_VERSION = "ai-link-2026-11-21-draft";

// Placeholders for Sean to set (claude-plugin.md section 5).
export const BUDGETS = {
  perGrantPerMinute: 60,
  perAddressPerMinute: 20,
};

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 24 * 3600;
export const CODE_TTL_S = 600;
export const CARD_TTL_MS = 3600 * 1000;

// ---------- Hashing and random values ----------
// Codes and tokens are stored only as an HMAC keyed from the server's existing PHONE_PEPPER, so
// there's no new secret to manage. Tests and local runs fall back to a fixed dev value.

const pepper = () => process.env.PHONE_PEPPER || "dev-only-pepper";

export const hmac = (purpose: string, value: string) =>
  createHmac("sha256", pepper()).update(`${purpose}:${value}`).digest("hex");

export const randomToken = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

export function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- Discovery documents (OAuth protected resource and authorization server) ----------

export const protectedResourceMetadata = () => ({
  resource: mcpUrl(),
  authorization_servers: [issuer()],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ["header"],
  resource_name: "BeliefAtlas",
});

export const authorizationServerMetadata = () => ({
  issuer: issuer(),
  authorization_endpoint: `${issuer()}/oauth/authorize`,
  token_endpoint: `${issuer()}/api/oauth/token`,
  registration_endpoint: `${issuer()}/api/oauth/register`,
  scopes_supported: [SCOPE],
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
});

// The 401 that tells an MCP client where to sign in.
export const unauthorizedHeader = () =>
  `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource", scope="${SCOPE}"`;

const notFound = () => new Response("Not found", { status: 404 });
export const whenEnabled = (make: () => Response): Response => (aiHeadEnabled() ? make() : notFound());
