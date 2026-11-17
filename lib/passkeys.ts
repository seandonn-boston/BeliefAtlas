import { createHash, randomBytes } from "crypto";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { query } from "./db";

// Passkeys: sign-in with Face ID, Touch ID, a fingerprint, Windows Hello or a security key.
// The biometric check happens on the device and never reaches us; the device signs a
// challenge with a private key that never leaves it, and we keep only the public key.
// `userVerification: "required"` means the device must check it is the owner (biometric or
// device PIN), not just that someone is holding it.

const RP_NAME = "BeliefAtlas";
const CEREMONY_MINUTES = 5;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// The origins a passkey may be used from: the site's own address, Vercel's deployment and
// branch addresses, and localhost outside production. Passkeys are bound to the domain, so a
// passkey made on a preview address only works there.
export function allowedOrigin(origin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const clean = url.origin;
  const allowed = new Set<string>();
  if (env.SITE_URL) allowed.add(new URL(env.SITE_URL).origin);
  for (const host of [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]) {
    if (host) allowed.add(`https://${host}`);
  }
  if (allowed.has(clean)) return clean;
  if (env.NODE_ENV !== "production" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return clean;
  return null;
}

export const rpIdFor = (origin: string) => new URL(origin).hostname;

async function saveCeremony(kind: "passkey_register" | "passkey_login", accountId: number | null, challenge: string, next: string) {
  const token = randomBytes(24).toString("base64url");
  await query("delete from auth_challenges where expires_at < now()");
  await query(
    `insert into auth_challenges (token_hash, kind, account_id, challenge, next_path, expires_at)
     values ($1, $2, $3, $4, $5, now() + interval '${CEREMONY_MINUTES} minutes')`,
    [hashToken(token), kind, accountId, challenge, next],
  );
  return token;
}

// Each ceremony can be finished once: the row is deleted as it is read.
async function takeCeremony(token: string, kind: "passkey_register" | "passkey_login") {
  const rows = await query<{ account_id: number | null; challenge: string; next_path: string }>(
    "delete from auth_challenges where token_hash = $1 and kind = $2 and expires_at > now() returning account_id, challenge, next_path",
    [hashToken(token), kind],
  );
  return rows[0] ?? null;
}

type Stored = { id: string; public_key: Buffer; counter: string; transports: string[] | null; account_id: number };

export async function registrationOptions(
  account: { id: number; username: string },
  origin: string,
): Promise<{ token: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const existing = await query<{ id: string; transports: string[] | null }>("select id, transports from passkeys where account_id = $1", [account.id]);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpIdFor(origin),
    userName: account.username,
    // A random handle, not the account id, so the passkey says nothing about our database.
    userID: new Uint8Array(createHash("sha256").update(`${process.env.PHONE_PEPPER ?? ""}:user:${account.id}`).digest()),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ?? undefined })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  return { token: await saveCeremony("passkey_register", account.id, options.challenge, "/"), options };
}

export type PasskeyResult = { ok: true } | { ok: false; error: string };

export async function finishRegistration(accountId: number, token: string, response: RegistrationResponseJSON, origin: string, name: string): Promise<PasskeyResult> {
  const ceremony = await takeCeremony(token, "passkey_register");
  if (!ceremony || ceremony.account_id !== accountId) return { ok: false, error: "That took too long. Try adding the passkey again." };
  let result;
  try {
    result = await verifyRegistrationResponse({
      response, expectedChallenge: ceremony.challenge, expectedOrigin: origin, expectedRPID: rpIdFor(origin), requireUserVerification: true,
    });
  } catch {
    return { ok: false, error: "That passkey couldn't be checked. Try again." };
  }
  if (!result.verified) return { ok: false, error: "That passkey couldn't be checked. Try again." };
  const info = result.registrationInfo;
  await query(
    `insert into passkeys (id, account_id, public_key, counter, transports, device_type, backed_up, name)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [info.credential.id, accountId, Buffer.from(info.credential.publicKey), info.credential.counter,
     info.credential.transports ?? null, info.credentialDeviceType, info.credentialBackedUp, name.slice(0, 60) || "Passkey"],
  );
  return { ok: true };
}

export async function loginOptions(origin: string, next: string): Promise<{ token: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  // No allowCredentials: the device offers whichever passkey it holds for this site.
  const options = await generateAuthenticationOptions({ rpID: rpIdFor(origin), userVerification: "required" });
  return { token: await saveCeremony("passkey_login", null, options.challenge, next), options };
}

export async function finishLogin(token: string, response: AuthenticationResponseJSON, origin: string): Promise<{ ok: true; accountId: number; next: string } | { ok: false; error: string }> {
  const ceremony = await takeCeremony(token, "passkey_login");
  if (!ceremony) return { ok: false, error: "That took too long. Try again." };
  const [stored] = await query<Stored>(
    `select p.id, p.public_key, p.counter, p.transports, p.account_id
       from passkeys p join accounts a on a.id = p.account_id
      where p.id = $1 and a.deleted_at is null`,
    [response.id],
  );
  if (!stored) return { ok: false, error: "That passkey isn't linked to an account here." };
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response, expectedChallenge: ceremony.challenge, expectedOrigin: origin, expectedRPID: rpIdFor(origin), requireUserVerification: true,
      credential: { id: stored.id, publicKey: new Uint8Array(stored.public_key), counter: Number(stored.counter), transports: stored.transports ?? undefined },
    });
  } catch {
    return { ok: false, error: "That passkey couldn't be checked. Try again." };
  }
  if (!result.verified) return { ok: false, error: "That passkey couldn't be checked. Try again." };
  await query("update passkeys set counter = $2, last_used_at = now() where id = $1", [stored.id, result.authenticationInfo.newCounter]);
  return { ok: true, accountId: stored.account_id, next: ceremony.next_path };
}

export async function listPasskeys(accountId: number) {
  return query<{ id: string; name: string; created_at: Date; last_used_at: Date | null; backed_up: boolean }>(
    "select id, name, created_at, last_used_at, backed_up from passkeys where account_id = $1 order by created_at",
    [accountId],
  );
}

export async function removePasskey(accountId: number, id: string): Promise<void> {
  await query("delete from passkeys where account_id = $1 and id = $2", [accountId, id]);
}
