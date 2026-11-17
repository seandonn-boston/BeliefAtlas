// Before a code is texted, the number can be checked for what kind of line it is. Virtual
// and VoIP numbers are cheap to rent by the thousand, which is how bot farms pass SMS
// verification, so they are turned away.
//
// PHONE_LINE_CHECK picks the checker:
//   "twilio"  Twilio Lookup v2 line type intelligence (needs TWILIO_ENABLED=true,
//             TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN; billed per lookup)
//   unset     no check; every number passes (development, or until the lookup is paid for)
// PHONE_ALLOW_UNKNOWN=false also turns away numbers the lookup can't classify. By default they
// pass, because many genuine non-US mobiles come back unknown.

import { logger } from "@/lib/log";

export type LineType =
  | "mobile" | "personal" | "landline" | "fixedVoip" | "nonFixedVoip" | "tollFree" | "premium"
  | "sharedCost" | "uan" | "voicemail" | "pager" | "unknown";

export type LineCheck = { ok: true; lineType: LineType } | { ok: false; lineType?: LineType; error: string };

export interface LineTypeChecker {
  readonly name: string;
  check(e164: string): Promise<LineCheck>;
}

const ALLOWED: ReadonlySet<LineType> = new Set(["mobile", "personal"]);
const KNOWN: ReadonlySet<string> = new Set([
  "mobile", "personal", "landline", "fixedVoip", "nonFixedVoip", "tollFree", "premium",
  "sharedCost", "uan", "voicemail", "pager", "unknown",
]);

// The policy, kept apart from any provider so it can be tested on its own.
export function judgeLineType(lineType: LineType, allowUnknown: boolean): LineCheck {
  if (ALLOWED.has(lineType)) return { ok: true, lineType };
  if (lineType === "unknown") {
    return allowUnknown ? { ok: true, lineType } : { ok: false, lineType, error: "We couldn't confirm that number is a mobile phone. Try another number." };
  }
  if (lineType === "fixedVoip" || lineType === "nonFixedVoip") {
    return { ok: false, lineType, error: "Internet and virtual phone numbers can't be used. Use your mobile number." };
  }
  if (lineType === "landline") return { ok: false, lineType, error: "That looks like a landline. Use a mobile number that can receive texts." };
  return { ok: false, lineType, error: "That kind of number can't be used. Use your mobile number." };
}

export const noLineCheck: LineTypeChecker = {
  name: "none",
  async check() {
    return { ok: true, lineType: "unknown" };
  },
};

export function twilioLookup(sid: string, token: string, allowUnknown: boolean): LineTypeChecker {
  return {
    name: "twilio",
    async check(e164) {
      let response: Response;
      try {
        response = await fetch(
          `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`,
          { headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` } },
        );
      } catch (err) {
        // The lookup is a filter in front of the texted code, not the check itself. If it is
        // unreachable, let the number through rather than closing signups.
        logger.error("twilio lookup unreachable", { err });
        return { ok: true, lineType: "unknown" };
      }
      const data = (await response.json().catch(() => ({}))) as {
        valid?: boolean;
        line_type_intelligence?: { type?: string | null; error_code?: number | null } | null;
        code?: number;
      };
      if (response.status === 404 || data.valid === false) {
        return { ok: false, error: "Enter a valid phone number, with country code if outside the US or Canada." };
      }
      if (!response.ok) {
        logger.error("twilio lookup failed", { status: response.status, errorCode: data.code });
        return { ok: true, lineType: "unknown" };
      }
      const raw = data.line_type_intelligence?.type ?? "unknown";
      const lineType = (KNOWN.has(raw) ? raw : "unknown") as LineType;
      return judgeLineType(lineType, allowUnknown);
    },
  };
}

// Read at call time so tests and config changes take effect without a restart of the module.
export function lineTypeChecker(env: NodeJS.ProcessEnv = process.env): LineTypeChecker {
  const allowUnknown = env.PHONE_ALLOW_UNKNOWN !== "false";
  if (env.PHONE_LINE_CHECK === "twilio" && env.TWILIO_ENABLED === "true") {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
      logger.error("PHONE_LINE_CHECK=twilio needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN");
      return { name: "misconfigured", check: async () => ({ ok: false, error: "Phone verification isn't set up on this server yet." }) };
    }
    return twilioLookup(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, allowUnknown);
  }
  return noLineCheck;
}
