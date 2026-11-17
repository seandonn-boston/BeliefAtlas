import { createHash, randomBytes } from "crypto";
import { query, transaction } from "./db";
import { open, seal } from "./secrets";
import { matchCode, newSecret, otpauthUri } from "./totp";

// The second step at sign-in: a code from an authenticator app, or one of ten single-use
// recovery codes for when the phone with the app is lost.

const PURPOSE = "totp-v1";
const RECOVERY_COUNT = 10;
const hashRecovery = (code: string) => createHash("sha256").update(code.replace(/[\s-]/g, "").toLowerCase()).digest("hex");

export async function mfaEnabled(accountId: number): Promise<boolean> {
  const [row] = await query<{ on: boolean }>("select totp_enabled_at is not null as on from accounts where id = $1", [accountId]);
  return Boolean(row?.on);
}

// Starts setup: a new secret, held encrypted until the person proves their app has it.
export async function beginTotp(accountId: number, label: string): Promise<{ secret: string; uri: string }> {
  const secret = newSecret();
  await query("update accounts set totp_pending_enc = $2 where id = $1", [accountId, seal(secret, PURPOSE)]);
  return { secret, uri: otpauthUri(secret, label) };
}

export async function pendingTotp(accountId: number, label: string): Promise<{ secret: string; uri: string } | null> {
  const [row] = await query<{ enc: string | null }>("select totp_pending_enc as enc from accounts where id = $1", [accountId]);
  const secret = row?.enc ? open(row.enc, PURPOSE) : null;
  return secret ? { secret, uri: otpauthUri(secret, label) } : null;
}

export type ConfirmResult = { ok: true; recoveryCodes: string[] } | { ok: false; error: string };

export async function confirmTotp(accountId: number, code: string, now = Date.now()): Promise<ConfirmResult> {
  const [row] = await query<{ enc: string | null }>("select totp_pending_enc as enc from accounts where id = $1", [accountId]);
  const secret = row?.enc ? open(row.enc, PURPOSE) : null;
  if (!secret) return { ok: false, error: "Start the authenticator setup again." };
  const step = matchCode(secret, code.replace(/\s/g, ""), now, null);
  if (step === null) return { ok: false, error: "That code didn't match. Check the time on your phone and try the newest code." };
  const recoveryCodes = Array.from({ length: RECOVERY_COUNT }, () => {
    const raw = randomBytes(5).toString("hex");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  await transaction(async (client) => {
    await client.query(
      `update accounts set totp_secret_enc = totp_pending_enc, totp_pending_enc = null, totp_enabled_at = now(),
              totp_last_step = $2 where id = $1`,
      [accountId, step],
    );
    await client.query("delete from recovery_codes where account_id = $1", [accountId]);
    for (const c of recoveryCodes) {
      await client.query("insert into recovery_codes (account_id, code_hash) values ($1, $2)", [accountId, hashRecovery(c)]);
    }
  });
  return { ok: true, recoveryCodes };
}

// Checks an authenticator code, or a recovery code (which is then used up).
export async function checkSecondFactor(accountId: number, raw: string, now = Date.now()): Promise<boolean> {
  const code = raw.replace(/\s/g, "");
  if (/^\d{6}$/.test(code)) {
    const [row] = await query<{ enc: string | null; last: string | null }>(
      "select totp_secret_enc as enc, totp_last_step as last from accounts where id = $1",
      [accountId],
    );
    const secret = row?.enc ? open(row.enc, PURPOSE) : null;
    if (!secret) return false;
    const step = matchCode(secret, code, now, row.last === null ? null : Number(row.last));
    if (step === null) return false;
    // Only the first request to record this step wins, so the same code can't be used twice
    // even by two requests at once.
    const updated = await query(
      "update accounts set totp_last_step = $2 where id = $1 and (totp_last_step is null or totp_last_step < $2) returning id",
      [accountId, step],
    );
    return updated.length === 1;
  }
  const used = await query(
    `update recovery_codes set used_at = now()
      where id = (select id from recovery_codes where account_id = $1 and code_hash = $2 and used_at is null limit 1)
      returning id`,
    [accountId, hashRecovery(code)],
  );
  return used.length === 1;
}

export async function recoveryCodesLeft(accountId: number): Promise<number> {
  const [row] = await query<{ n: number }>(
    "select count(*)::int as n from recovery_codes where account_id = $1 and used_at is null",
    [accountId],
  );
  return row.n;
}

export async function disableTotp(accountId: number): Promise<void> {
  await query(
    `update accounts set totp_secret_enc = null, totp_pending_enc = null, totp_enabled_at = null, totp_last_step = null
      where id = $1`,
    [accountId],
  );
  await query("delete from recovery_codes where account_id = $1", [accountId]);
}
