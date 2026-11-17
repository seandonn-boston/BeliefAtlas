// An invisible "are you a person" challenge on the signup form, so scripts can't start
// signups (and burn texted codes) at scale. Cloudflare Turnstile is the provider; it is free
// and usually never shows the person anything.
//
// TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY turn it on. Without them, outside production,
// a development bypass passes every signup so the form works on a laptop. In production
// without them, signup is closed, the same as with phone verification.

import { logger } from "@/lib/log";

export type ChallengeResult = { ok: true } | { ok: false; error: string };

export interface HumanChallenge {
  readonly name: "turnstile" | "dev" | "off";
  // Rendered into the signup form. Null means nothing to render.
  readonly siteKey: string | null;
  verify(token: string, ip: string, action: string): Promise<ChallengeResult>;
}

// The hidden field Turnstile's widget adds to the form it sits in.
export const CHALLENGE_FIELD = "cf-turnstile-response";
export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js";

const FAILED = "We couldn't confirm you're a person. Reload the page and try again.";

export const devChallenge: HumanChallenge = {
  name: "dev",
  siteKey: null,
  async verify() {
    return { ok: true };
  },
};

export const closedChallenge: HumanChallenge = {
  name: "off",
  siteKey: null,
  async verify() {
    return { ok: false, error: "Signup isn't open on this server yet." };
  },
};

export function turnstile(siteKey: string, secret: string): HumanChallenge {
  return {
    name: "turnstile",
    siteKey,
    async verify(token, ip, action) {
      // Tokens are at most 2048 characters; anything else is not one.
      if (!token || token.length > 2048) return { ok: false, error: FAILED };
      const body = new URLSearchParams({ secret, response: token });
      if (ip && ip !== "local") body.set("remoteip", ip);
      try {
        const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
        const data = (await response.json().catch(() => ({}))) as { success?: boolean; action?: string; "error-codes"?: string[] };
        if (data.success !== true) {
          if (data["error-codes"]?.some((c) => c.startsWith("invalid-input-secret") || c === "missing-input-secret")) {
            logger.error("turnstile secret rejected", { errorCodes: data["error-codes"] });
          }
          return { ok: false, error: FAILED };
        }
        // A token made for another form on the site doesn't count for this one.
        if (data.action && data.action !== action) return { ok: false, error: FAILED };
        return { ok: true };
      } catch (err) {
        // Failing closed: if the check can't run, a bot would otherwise walk straight in.
        logger.error("turnstile unreachable", { err });
        return { ok: false, error: "The signup check didn't load. Try again in a minute." };
      }
    },
  };
}

export function humanChallenge(env: NodeJS.ProcessEnv = process.env): HumanChallenge {
  const siteKey = env.TURNSTILE_SITE_KEY;
  const secret = env.TURNSTILE_SECRET_KEY;
  if (siteKey && secret) return turnstile(siteKey, secret);
  return env.NODE_ENV === "production" ? closedChallenge : devChallenge;
}
