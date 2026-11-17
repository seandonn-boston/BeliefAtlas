import { createHmac } from "crypto";
import { query } from "./db";
import { hashPassword, verifyPassword } from "./auth";
import { hit, RULES, tooMany } from "./rate-limit";

// An account PIN guards sensitive actions on a signed-in account: deleting it, removing a
// passkey, turning off the authenticator app, changing the password. It is stored hashed
// with scrypt, like a password. Because a PIN has few possible values, it is first keyed with
// the server's pepper, so a copy of the database alone can't be used to guess PINs offline.

export function pinProblem(pin: string): string | null {
  if (!/^\d{4,8}$/.test(pin)) return "A PIN is 4 to 8 digits.";
  if (/^(\d)\1+$/.test(pin)) return "Pick a PIN that isn't one digit repeated.";
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return "Pick a PIN that isn't a run like 1234.";
  return null;
}

function peppered(pin: string): string {
  const pepper = process.env.PHONE_PEPPER;
  if (!pepper) throw new Error("PHONE_PEPPER is not set");
  return createHmac("sha256", pepper).update(`pin:${pin}`).digest("hex");
}

type Factors = { pin_hash: string | null; password_hash: string | null };

async function factors(accountId: number): Promise<Factors | null> {
  const [row] = await query<Factors>("select pin_hash, password_hash from accounts where id = $1", [accountId]);
  return row ?? null;
}

export async function hasPin(accountId: number): Promise<boolean> {
  return Boolean((await factors(accountId))?.pin_hash);
}

export type Confirm = { ok: true } | { ok: false; error: string };

// Confirms it is really the account holder before a sensitive action: the PIN if one is set,
// otherwise the password. An account with neither is asked to set a PIN first.
export async function confirmIdentity(accountId: number, input: { pin?: string; password?: string }): Promise<Confirm> {
  const row = await factors(accountId);
  if (!row) return { ok: false, error: "That account wasn't found." };
  if (!row.pin_hash && !row.password_hash) return { ok: false, error: "Set an account PIN in Security first." };
  const limited = await hit([RULES.pinPerAccount, String(accountId)]);
  if (limited) return { ok: false, error: tooMany(limited) };
  if (row.pin_hash) {
    return input.pin && verifyPassword(peppered(input.pin), row.pin_hash) ? { ok: true } : { ok: false, error: "That PIN isn't right." };
  }
  return input.password && verifyPassword(input.password, row.password_hash!) ? { ok: true } : { ok: false, error: "That password isn't right." };
}

// Setting a PIN for the first time needs nothing more than being signed in; changing one
// needs the current one.
export async function setPin(accountId: number, pin: string, current?: string): Promise<Confirm> {
  const problem = pinProblem(pin);
  if (problem) return { ok: false, error: problem };
  const row = await factors(accountId);
  if (!row) return { ok: false, error: "That account wasn't found." };
  if (row.pin_hash) {
    const confirmed = await confirmIdentity(accountId, { pin: current });
    if (!confirmed.ok) return confirmed;
  }
  await query("update accounts set pin_hash = $2 where id = $1", [accountId, hashPassword(peppered(pin))]);
  return { ok: true };
}
