import { createHash, randomBytes } from "crypto";
import { query } from "./db";
import { hashPhone, normalizePhone, verifyPassword } from "./auth";
import { mfaEnabled, checkSecondFactor } from "./mfa";
import { hit, RULES, tooMany } from "./rate-limit";
import { checkCode, sendCode } from "./sms";
import { phoneBlocked, PHONE_NOT_AVAILABLE } from "./sanctions/places";

// Three ways in: a passkey (lib/passkeys.ts), a code texted to the phone on the account, or a
// password for accounts that set one. Texted codes and passwords are followed by the
// authenticator-app step when the account has turned it on. A passkey already proves both the
// device and the person (Face ID, fingerprint or the device PIN), so it needs no second step.

const CHALLENGE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export type LoginStep =
  | { ok: true; accountId: number; next: string }
  | { ok: true; mfaToken: string }
  | { ok: false; error: string };

async function challenge(kind: "sms_login" | "mfa", accountId: number | null, next: string, extra: { phone?: string; codeHash?: string } = {}) {
  const token = randomBytes(24).toString("base64url");
  await query("delete from auth_challenges where expires_at < now()");
  await query(
    `insert into auth_challenges (token_hash, kind, account_id, phone, code_hash, next_path, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + interval '${CHALLENGE_MINUTES} minutes')`,
    [hashToken(token), kind, accountId, extra.phone ?? null, extra.codeHash ?? null, next],
  );
  return token;
}

// After the first factor: straight in, or on to the authenticator step.
async function afterFirstFactor(accountId: number, next: string): Promise<LoginStep> {
  if (await mfaEnabled(accountId)) return { ok: true, mfaToken: await challenge("mfa", accountId, next) };
  return { ok: true, accountId, next };
}

export async function passwordLogin(identifier: string, password: string, ip: string, next: string): Promise<LoginStep> {
  const name = identifier.trim().toLowerCase();
  const limited = await hit([RULES.loginPerIp, ip], [RULES.loginPerName, name]);
  if (limited) return { ok: false, error: tooMany(limited) };
  const rows = await query<{ id: number; password_hash: string | null }>(
    "select id, password_hash from accounts where username = $1 and deleted_at is null",
    [name],
  );
  const row = rows[0];
  if (!row?.password_hash || !verifyPassword(password, row.password_hash)) {
    return { ok: false, error: "Wrong username or password. Accounts without a password sign in with a passkey or a texted code." };
  }
  return afterFirstFactor(row.id, next);
}

// Always answers with a token, whether or not the number has an account, so the form can't
// be used to find out who is signed up. A code is only texted to numbers that have one.
export async function startSmsLogin(rawPhone: string, ip: string, next: string): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const digits = normalizePhone(rawPhone);
  if (!digits) return { ok: false, error: "Enter a valid phone number, with country code if outside the US or Canada." };
  // No code is ever texted to a number from a blocked country.
  if (phoneBlocked(`+${digits}`)) return { ok: false, error: PHONE_NOT_AVAILABLE };
  const phoneHash = hashPhone(digits);
  const limited = await hit([RULES.loginPerIp, ip], [RULES.smsPerIp, ip], [RULES.smsPerPhone, phoneHash], [RULES.smsPerPhoneDay, phoneHash]);
  if (limited) return { ok: false, error: tooMany(limited) };
  const [account] = await query<{ id: number }>("select id from accounts where phone_hash = $1 and deleted_at is null", [phoneHash]);
  const e164 = `+${digits}`;
  // The number is kept for the "code sent to the number ending ..." line, so the page reads the
  // same either way; it is deleted with the challenge.
  if (!account) return { ok: true, token: await challenge("sms_login", null, next, { phone: e164 }) };
  const sent = await sendCode(e164);
  if (!sent.ok) return sent;
  return { ok: true, token: await challenge("sms_login", account.id, next, { phone: e164, codeHash: sent.devCodeHash }) };
}

type Row = { token_hash: string; account_id: number | null; phone: string | null; code_hash: string | null; attempts: number; next_path: string };

async function load(token: string, kind: "sms_login" | "mfa"): Promise<Row | null> {
  const rows = await query<Row>(
    "select * from auth_challenges where token_hash = $1 and kind = $2 and expires_at > now()",
    [hashToken(token), kind],
  );
  return rows[0] ?? null;
}

export type CodeResult = LoginStep & { restart?: boolean };

export async function verifySmsLogin(token: string, rawCode: string): Promise<CodeResult> {
  const row = await load(token, "sms_login");
  if (!row) return { ok: false, error: "That code has expired. Start again.", restart: true };
  if (row.attempts >= MAX_ATTEMPTS) {
    await query("delete from auth_challenges where token_hash = $1", [row.token_hash]);
    return { ok: false, error: "Too many wrong codes. Start again.", restart: true };
  }
  await query("update auth_challenges set attempts = attempts + 1 where token_hash = $1", [row.token_hash]);
  const ok = row.account_id !== null && row.phone !== null && (await checkCode(row.phone, rawCode.replace(/\s/g, ""), row.code_hash));
  if (!ok) return { ok: false, error: "That code didn't match." };
  await query("delete from auth_challenges where token_hash = $1", [row.token_hash]);
  return afterFirstFactor(row.account_id!, row.next_path);
}

export async function verifyMfa(token: string, code: string): Promise<CodeResult> {
  const row = await load(token, "mfa");
  if (!row || row.account_id === null) return { ok: false, error: "That sign-in has expired. Start again.", restart: true };
  const limited = await hit([RULES.mfaPerAccount, String(row.account_id)]);
  if (limited) return { ok: false, error: tooMany(limited) };
  if (row.attempts >= MAX_ATTEMPTS) {
    await query("delete from auth_challenges where token_hash = $1", [row.token_hash]);
    return { ok: false, error: "Too many wrong codes. Start again.", restart: true };
  }
  await query("update auth_challenges set attempts = attempts + 1 where token_hash = $1", [row.token_hash]);
  if (!(await checkSecondFactor(row.account_id, code))) return { ok: false, error: "That code didn't match." };
  await query("delete from auth_challenges where token_hash = $1", [row.token_hash]);
  return { ok: true, accountId: row.account_id, next: row.next_path };
}

export async function smsLoginSummary(token: string): Promise<{ phoneEnding: string } | null> {
  const row = await load(token, "sms_login");
  return row ? { phoneEnding: (row.phone ?? "").slice(-4) } : null;
}

export async function mfaPending(token: string): Promise<boolean> {
  return Boolean(await load(token, "mfa"));
}
