import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "crypto";
import { query } from "../db";
import { isProductionEnv } from "../provenance";
import { keysEnabled, testOrgKeys } from "./config";
import { getPlacementOrg } from "./orgs";

// Org server keys (belief-map/headless-front-door.md section 6). Built complete, switched off by
// HEADLESS_KEYS_ENABLED. A key is "cm_live_<lookup>_<secret>": the lookup finds the row, and only
// an HMAC of the secret is stored, under a key derived from PHONE_PEPPER, so a database copy
// can't be used to call the API. The full key is shown once, when issued.
//
// A key never goes in a browser: the routes refuse any request that carries an Origin header.

type Env = Record<string, string | undefined>;
export const SCOPES = ["relay", "results"] as const;
export type Scope = (typeof SCOPES)[number];
export const isScope = (v: unknown): v is Scope => typeof v === "string" && (SCOPES as readonly string[]).includes(v);

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const lookupId = () => [...randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join("");

function hashSecret(secret: string): string {
  const pepper = process.env.PHONE_PEPPER;
  if (!pepper) throw new Error("PHONE_PEPPER is not set");
  const key = Buffer.from(hkdfSync("sha256", pepper, "belief-map", "org-credential", 32));
  return createHmac("sha256", key).update(secret).digest("hex");
}

export type IssuedKey = { id: number; key: string; lookup: string };

// Issues a key. The caller has already checked the person may (an org admin) and the plan's limit.
export async function issueCredential(
  input: { orgId: number; label: string; scopes: Scope[]; createdBy: number | null },
  env: Env = process.env,
): Promise<IssuedKey> {
  if (!keysEnabled(env)) throw new Error("Org keys are switched off.");
  const scopes = [...new Set(input.scopes.filter(isScope))];
  if (!scopes.length) throw new Error("A key needs at least one scope.");
  const lookup = lookupId();
  const secret = randomBytes(32).toString("base64url");
  const [row] = await query<{ id: string }>(
    `insert into org_credentials (org_id, lookup, secret_hash, label, scopes, created_by)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [input.orgId, lookup, hashSecret(secret), input.label.trim().slice(0, 80) || "Server key", scopes, input.createdBy],
  );
  const kind = isProductionEnv(env) ? "live" : "test";
  return { id: Number(row.id), key: `cm_${kind}_${lookup}_${secret}`, lookup };
}

export async function revokeCredential(orgId: number, credentialId: number, by: number | null): Promise<boolean> {
  const rows = await query(
    "update org_credentials set revoked_at = now(), revoked_by = $3 where id = $1 and org_id = $2 and revoked_at is null returning id",
    [credentialId, orgId, by],
  );
  return rows.length > 0;
}

// A new key with the same label and scopes; the old one keeps working for 24 hours so the org
// can swap it without downtime.
export async function rotateCredential(orgId: number, credentialId: number, by: number | null, env: Env = process.env): Promise<IssuedKey | null> {
  const [old] = await query<{ label: string; scopes: Scope[] }>(
    "select label, scopes from org_credentials where id = $1 and org_id = $2 and revoked_at is null",
    [credentialId, orgId],
  );
  if (!old) return null;
  const issued = await issueCredential({ orgId, label: old.label, scopes: old.scopes, createdBy: by }, env);
  await query(
    "update org_credentials set expires_at = least(coalesce(expires_at, 'infinity'), now() + interval '24 hours') where id = $1",
    [credentialId],
  );
  return issued;
}

export type CredentialRow = {
  id: number; label: string; lookup: string; scopes: Scope[]; created_at: Date; last_used_at: Date | null;
  expires_at: Date | null; revoked_at: Date | null;
};

export async function listCredentials(orgId: number): Promise<CredentialRow[]> {
  return query<CredentialRow>(
    `select id::int, label, lookup, scopes, created_at, last_used_at, expires_at, revoked_at
       from org_credentials where org_id = $1 order by revoked_at is not null, created_at desc`,
    [orgId],
  );
}

export async function activeCredentialCount(orgId: number): Promise<number> {
  const [r] = await query<{ n: number }>(
    "select count(*)::int as n from org_credentials where org_id = $1 and revoked_at is null and (expires_at is null or expires_at > now())",
    [orgId],
  );
  return r.n;
}

export type Caller = { orgSlug: string; orgId: number | null; credentialId: number | null; test: boolean };

// Who an Authorization header belongs to, for a scope: a test key (never in production) or, with
// keys switched on, a real key that isn't revoked or expired, of an org that is serving.
export async function callerFor(authorization: string | null, scope: Scope, env: Env = process.env): Promise<Caller | null> {
  const given = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!given) return null;
  for (const [key, slug] of testOrgKeys(env)) {
    if (key.length === given.length && timingSafeEqual(Buffer.from(key), Buffer.from(given))) {
      return { orgSlug: slug, orgId: null, credentialId: null, test: true };
    }
  }
  if (!keysEnabled(env)) return null;
  const m = given.match(/^cm_(live|test)_([a-z0-9]{10})_([A-Za-z0-9_-]{43})$/);
  if (!m) return null;
  // A test key never works in production, and a live key never works outside it.
  if ((m[1] === "live") !== isProductionEnv(env)) return null;
  const [row] = await query<{ id: string; org_id: string; secret_hash: string; scopes: Scope[] }>(
    `select id, org_id, secret_hash, scopes from org_credentials
      where lookup = $1 and revoked_at is null and (expires_at is null or expires_at > now())`,
    [m[2]],
  );
  const expected = Buffer.from(row?.secret_hash ?? "0".repeat(64), "hex");
  const actual = Buffer.from(hashSecret(m[3]), "hex");
  if (!row || !timingSafeEqual(expected, actual) || !row.scopes.includes(scope)) return null;
  const org = await getPlacementOrg(Number(row.org_id), env);
  if (!org?.serving) return null;
  // At most one write a minute per key.
  await query(
    "update org_credentials set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')",
    [row.id],
  );
  return { orgSlug: org.slug, orgId: org.id, credentialId: Number(row.id), test: false };
}
