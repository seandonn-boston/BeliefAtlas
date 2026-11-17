import { createHash, randomBytes } from "crypto";
import { query } from "./db";
import { hashPhone, normalizePhone } from "./auth";
import { hit, RULES, tooMany } from "./rate-limit";
import { checkCode, sendCode } from "./sms";

// Signing in with a code texted to the account's phone: the default way in now that passwords
// are optional. The phone number is never stored on the account (only its hash), so the person
// types it, and the code goes to what they typed.
//
// The answer is the same whether or not the number has an account, so this can't be used to
// find out who has one: a row is made either way, and a number without an account simply never
// gets a code that matches.

const EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS = 5;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export type StartLogin = { ok: true; token: string } | { ok: false; error: string };

export async function startCodeLogin(phone: string, next: string, ip: string): Promise<StartLogin> {
  const digits = normalizePhone(phone);
  if (!digits) return { ok: false, error: "Enter a valid phone number, with country code if outside the US or Canada." };
  const phoneHash = hashPhone(digits);
  const limited = await hit([RULES.smsPerIp, ip], [RULES.smsPerPhone, phoneHash], [RULES.smsPerPhoneDay, phoneHash]);
  if (limited) return { ok: false, error: tooMany(limited) };

  const [account] = await query<{ id: number }>(
    "select id from accounts where phone_hash = $1 and deleted_at is null",
    [phoneHash],
  );
  const e164 = `+${digits}`;
  let codeHash: string | null = null;
  if (account) {
    const sent = await sendCode(e164);
    if (!sent.ok) return sent;
    codeHash = sent.devCodeHash ?? null;
  }
  const token = randomBytes(24).toString("base64url");
  await query("delete from pending_logins where phone = $1 or expires_at < now()", [e164]);
  await query(
    `insert into pending_logins (token_hash, phone, account_id, code_hash, next_path, expires_at)
     values ($1, $2, $3, $4, $5, now() + interval '${EXPIRY_MINUTES} minutes')`,
    [hashToken(token), e164, account?.id ?? null, codeHash, next],
  );
  return { ok: true, token };
}

export async function codeLoginSummary(token: string): Promise<{ phoneEnding: string } | null> {
  const [row] = await query<{ phone: string }>(
    "select phone from pending_logins where token_hash = $1 and expires_at > now()",
    [hashToken(token)],
  );
  return row ? { phoneEnding: row.phone.slice(-4) } : null;
}

export type FinishLogin = { ok: true; accountId: number; next: string } | { ok: false; error: string; restart?: boolean };

export async function finishCodeLogin(token: string, code: string): Promise<FinishLogin> {
  const tokenHash = hashToken(token);
  const [row] = await query<{ phone: string; account_id: number | null; code_hash: string | null; attempts: number; next_path: string }>(
    "select phone, account_id, code_hash, attempts, next_path from pending_logins where token_hash = $1 and expires_at > now()",
    [tokenHash],
  );
  if (!row) return { ok: false, error: "That code has expired. Start again.", restart: true };
  if (row.attempts >= MAX_ATTEMPTS) {
    await query("delete from pending_logins where token_hash = $1", [tokenHash]);
    return { ok: false, error: "Too many wrong codes. Start again.", restart: true };
  }
  await query("update pending_logins set attempts = attempts + 1 where token_hash = $1", [tokenHash]);
  const ok = row.account_id !== null && (await checkCode(row.phone, code.replace(/\s/g, ""), row.code_hash));
  if (!ok) {
    const left = MAX_ATTEMPTS - row.attempts - 1;
    return { ok: false, error: left > 0 ? `That code didn't match. ${left} ${left === 1 ? "try" : "tries"} left.` : "That code didn't match." };
  }
  await query("delete from pending_logins where token_hash = $1", [tokenHash]);
  return { ok: true, accountId: row.account_id!, next: row.next_path };
}
