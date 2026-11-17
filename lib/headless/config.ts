import { isProductionEnv } from "../provenance";

// The headless front door's switches (belief-map/headless-front-door.md section 13). All off by
// default. Nothing here is a secret; the only credentials the relay accepts today are test-only
// ones, refused in production, because no org keys are issued until Sean decides (decision 3).

type Env = Record<string, string | undefined>;

export const API_VERSION = 1;
export const API_BASE = "/api/headless/v1";

// The whole front door. Off means every /api/headless/v1 route answers 404, and the vote page
// ignores headless return addresses. Keep it off in production until the domain is chosen
// (Sean: no share link, QR code or embed goes out before then).
export const headlessEnabled = (env: Env = process.env) => env.HEADLESS_ENABLED === "true";

// The server relay (path 3): an org's server sends a tap on behalf of its own linked user. Off
// by default and by recommendation (decision 4: the org would see each person's answer).
export const relayEnabled = (env: Env = process.env) => headlessEnabled(env) && env.HEADLESS_RELAY_ENABLED === "true";

// Test-only relay credentials, "slug:key,slug:key". Never read in production, so a real org can
// never be given one of these by mistake.
export function testOrgKeys(env: Env = process.env): Map<string, string> {
  const keys = new Map<string, string>();
  if (isProductionEnv(env)) return keys;
  for (const pair of (env.HEADLESS_TEST_ORG_KEYS ?? "").split(",")) {
    const i = pair.indexOf(":");
    if (i <= 0) continue;
    const slug = pair.slice(0, i).trim();
    const key = pair.slice(i + 1).trim();
    if (slug && key.length >= 16) keys.set(key, slug);
  }
  return keys;
}
