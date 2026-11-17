import { createHash, randomBytes } from "crypto";
import { query, transaction } from "./db";
import { hashPassword, hashPhone, normalizePhone } from "./auth";
import { hit, RULES, tooMany } from "./rate-limit";
import { checkCode, sendCode } from "./sms";
import { checkAdult } from "./age";
import { humanChallenge } from "./human-check";
import { lineTypeChecker } from "./phone-check";
import { TERMS_VERSION } from "./legal";
import { generateUsername, usernameProblem } from "./usernames";
import { signupOrigin } from "./provenance";

// Signing up is two steps: details first, then the code texted to the phone. The account is
// only created once the code checks out.
//
// Before any text is sent, the details pass four filters in this order: an adult date of
// birth (checked, then discarded), the invisible human challenge, rate limits per IP address
// and per browser, and a line-type check that turns away virtual and VoIP numbers.

const EXPIRY_MINUTES = 15;
const MAX_ATTEMPTS = 5;
const RESEND_AFTER_SECONDS = 30;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Username and password are optional: a blank username is generated, and without a password
// the account signs in by passkey or texted code. Agreeing to the terms is passive: the form
// says that creating the account means agreeing, and the version agreed to is recorded.
export type StartInput = {
  username?: string; phone: string; password?: string; dob: string; next: string; ip: string;
  device: string; challengeToken: string;
};
// `underage` tells the caller to lock this browser out of retrying with another date.
export type StartResult = { ok: true; token: string } | { ok: false; error: string; underage?: boolean };

export async function startSignup(input: StartInput): Promise<StartResult> {
  const chosen = (input.username ?? "").trim().toLowerCase();
  const password = input.password ?? "";
  const digits = normalizePhone(input.phone);
  if (chosen) {
    const problem = usernameProblem(chosen);
    if (problem) return { ok: false, error: problem };
  }
  if (password && password.length < 8) return { ok: false, error: "Passwords need at least 8 characters." };
  if (password.length > 200) return { ok: false, error: "Passwords can be at most 200 characters." };
  if (!digits) return { ok: false, error: "Enter a valid phone number, with country code if outside the US or Canada." };
  const age = checkAdult(input.dob);
  if (!age.ok) return { ok: false, error: age.error, underage: age.underage };

  const human = await humanChallenge().verify(input.challengeToken, input.ip, "signup");
  if (!human.ok) return human;

  const phoneHash = hashPhone(digits);
  const limited = await hit(
    [RULES.signupPerIp, input.ip],
    [RULES.signupPerIpDay, input.ip],
    [RULES.signupPerDevice, input.device],
    [RULES.smsPerIp, input.ip],
    [RULES.smsPerPhone, phoneHash],
    [RULES.smsPerPhoneDay, phoneHash],
  );
  if (limited) return { ok: false, error: tooMany(limited) };

  const [taken] = await query<{ username: boolean; phone: boolean }>(
    `select exists(select 1 from accounts where username = $1) as username,
            exists(select 1 from accounts where phone_hash = $2) as phone`,
    [chosen, phoneHash],
  );
  if (taken.phone) return { ok: false, error: "That phone number already has an account. Sign in instead." };
  if (chosen && taken.username) return { ok: false, error: "That username is taken." };
  const username = chosen || (await generateUsername());

  const e164 = `+${digits}`;
  const line = await lineTypeChecker().check(e164);
  if (!line.ok) return line;
  const sent = await sendCode(e164);
  if (!sent.ok) return sent;

  const token = randomBytes(24).toString("base64url");
  await query("delete from pending_signups where phone_hash = $1 or expires_at < now()", [phoneHash]);
  await query(
    `insert into pending_signups (token_hash, username, phone, phone_hash, password_hash, code_hash, next_path,
                                  age_method, phone_line_type, terms_version, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'dob', $8, $9, now() + interval '${EXPIRY_MINUTES} minutes')`,
    [hashToken(token), username, e164, phoneHash, password ? hashPassword(password) : null, sent.devCodeHash ?? null, input.next,
     line.lineType, TERMS_VERSION],
  );
  return { ok: true, token };
}

type Pending = {
  token_hash: string; username: string; phone: string; phone_hash: string; password_hash: string | null;
  code_hash: string | null; attempts: number; next_path: string; seconds_since_send: number;
  age_method: string; age_verified_at: Date; phone_line_type: string | null; terms_version: string | null;
};

async function pending(token: string): Promise<Pending | null> {
  const rows = await query<Pending>(
    `select *, extract(epoch from now() - last_sent_at)::int as seconds_since_send
       from pending_signups where token_hash = $1 and expires_at > now()`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

// The last four digits, for "we texted a code to ••• 1234".
export async function pendingSummary(token: string): Promise<{ phoneEnding: string } | null> {
  const row = await pending(token);
  return row ? { phoneEnding: row.phone.slice(-4) } : null;
}

export type VerifyResult = { ok: true; accountId: number; next: string } | { ok: false; error: string; restart?: boolean };

export async function verifySignup(token: string, code: string): Promise<VerifyResult> {
  const row = await pending(token);
  if (!row) return { ok: false, error: "That code has expired. Start again.", restart: true };
  if (row.attempts >= MAX_ATTEMPTS) {
    await query("delete from pending_signups where token_hash = $1", [row.token_hash]);
    return { ok: false, error: "Too many wrong codes. Start again.", restart: true };
  }
  await query("update pending_signups set attempts = attempts + 1 where token_hash = $1", [row.token_hash]);
  const ok = await checkCode(row.phone, code.replace(/\s/g, ""), row.code_hash);
  if (!ok) {
    const left = MAX_ATTEMPTS - row.attempts - 1;
    return { ok: false, error: left > 0 ? `That code didn't match. ${left} ${left === 1 ? "try" : "tries"} left.` : "That code didn't match." };
  }

  // 'real' everywhere but preview test mode, where it is 'test' (lib/provenance.ts). Read from
  // the environment, never from anything the request sent.
  const origin = signupOrigin();
  try {
    return await transaction(async (client) => {
      const created = await client.query<{ id: number }>(
        `insert into accounts (username, phone_hash, password_hash, consented_at, phone_verified_at,
                               age_verified_at, age_method, phone_line_type, terms_version, origin)
         values ($1, $2, $3, now(), now(), $4, $5, $6, $7, $8) returning id`,
        [row.username, row.phone_hash, row.password_hash, row.age_verified_at, row.age_method, row.phone_line_type,
         row.terms_version ?? TERMS_VERSION, origin],
      );
      await client.query("delete from pending_signups where token_hash = $1", [row.token_hash]);
      return { ok: true as const, accountId: created.rows[0].id, next: row.next_path };
    });
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code !== "23505") throw err;
    await query("delete from pending_signups where token_hash = $1", [row.token_hash]);
    return {
      ok: false,
      restart: true,
      error: e.constraint?.includes("phone") ? "That phone number already has an account. Sign in instead." : "Someone just took that username. Start again with another.",
    };
  }
}

export async function resendCode(token: string, ip: string): Promise<{ ok: boolean; error?: string }> {
  const row = await pending(token);
  if (!row) return { ok: false, error: "That code has expired. Start again." };
  if (row.seconds_since_send < RESEND_AFTER_SECONDS) {
    return { ok: false, error: `Wait ${RESEND_AFTER_SECONDS - row.seconds_since_send} seconds before asking for another code.` };
  }
  const limited = await hit([RULES.smsPerIp, ip], [RULES.smsPerPhone, row.phone_hash], [RULES.smsPerPhoneDay, row.phone_hash]);
  if (limited) return { ok: false, error: tooMany(limited) };
  const sent = await sendCode(row.phone);
  if (!sent.ok) return sent;
  await query(
    `update pending_signups set sends = sends + 1, last_sent_at = now(), attempts = 0,
            code_hash = coalesce($2, code_hash) where token_hash = $1`,
    [row.token_hash, sent.devCodeHash ?? null],
  );
  return { ok: true };
}
