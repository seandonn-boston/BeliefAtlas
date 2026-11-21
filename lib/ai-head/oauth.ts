import { createHash } from "crypto";
import type { Account } from "../auth";
import { query, transaction } from "../db";
import {
  ACCESS_TTL_S, CODE_TTL_S, CONSENT_VERSION, hmac, randomToken, REFRESH_TTL_S, SCOPE, sameString,
} from "./config";

// The account link behind the Claude plugin: standard OAuth 2.1 with PKCE, so the chat app holds
// a token for one person and nothing else (belief-map/claude-plugin.md, section 3, option A).
//
//   1. Claude registers itself (dynamic client registration). That makes an AI *client*, never
//      an account: AI never logs in or votes (Sean, 20 Nov 2026).
//   2. The person, signed in to BeliefAtlas as themselves, agrees on /oauth/authorize. That makes a
//      grant tied to their own account, and a one-use code.
//   3. Claude swaps the code for an access token (one hour) and a refresh token (30 days, replaced
//      on every use). Only HMACs of codes and tokens are stored.
//
// Two parties agree, which is Sean's "dual agreement": the AI client's registration and the
// person's own sign-in and consent.

// ---------- Which callback addresses we accept ----------
// For now only Claude's: its web callback, and the loopback address Claude Code uses (any port,
// as RFC 8252 allows for native apps). Other assistants are added here when Sean says so.

const WEB_CALLBACKS: Record<string, string> = {
  "https://claude.ai/api/mcp/auth_callback": "claude",
  "https://claude.com/api/mcp/auth_callback": "claude",
};

function loopback(uri: string): URL | null {
  try {
    const u = new URL(uri);
    if (u.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return null;
    if (u.username || u.password || u.hash) return null;
    return u;
  } catch {
    return null;
  }
}

export function platformFor(uri: string): string | null {
  if (WEB_CALLBACKS[uri]) return WEB_CALLBACKS[uri];
  return loopback(uri) ? "claude-code" : null;
}

// A callback given at sign-in matches a registered one exactly, or, for loopback addresses, in
// everything but the port.
export function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  const g = loopback(given);
  if (!g) return false;
  return registered.some((r) => {
    const u = loopback(r);
    return Boolean(u) && u!.hostname === g.hostname && u!.pathname === g.pathname && u!.search === g.search;
  });
}

// ---------- 1. Registration ----------

export type ClientRecord = { id: string; platform: string; clientName: string; redirectUris: string[] };

export type RegisterResult =
  | { ok: true; client: ClientRecord }
  | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };

export async function registerClient(
  body: Record<string, unknown>,
  origin: "live" | "test" = "live",
): Promise<RegisterResult> {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!uris.length || uris.length > 5) {
    return { ok: false, error: "invalid_redirect_uri", description: "Give one to five redirect_uris." };
  }
  const platforms = new Set(uris.map(platformFor));
  if (platforms.has(null)) {
    return { ok: false, error: "invalid_redirect_uri", description: "Only Claude's callback addresses are accepted for now." };
  }
  if (platforms.size > 1) {
    return { ok: false, error: "invalid_redirect_uri", description: "All redirect_uris must belong to one app." };
  }
  const method = body.token_endpoint_auth_method ?? "none";
  if (method !== "none") {
    return { ok: false, error: "invalid_client_metadata", description: "Only public clients (token_endpoint_auth_method none) are supported." };
  }
  const platform = [...platforms][0]!;
  const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : platform;
  const id = randomToken("cmc").slice(0, 40);
  await query(
    "insert into ai_clients (id, platform, client_name, redirect_uris, origin) values ($1, $2, $3, $4, $5)",
    [id, platform, name, uris, origin],
  );
  return { ok: true, client: { id, platform, clientName: name, redirectUris: uris } };
}

export async function getClient(id: string): Promise<ClientRecord | null> {
  const [row] = await query<{ id: string; platform: string; client_name: string; redirect_uris: string[] }>(
    "select id, platform, client_name, redirect_uris from ai_clients where id = $1 and revoked_at is null",
    [id],
  );
  return row ? { id: row.id, platform: row.platform, clientName: row.client_name, redirectUris: row.redirect_uris } : null;
}

// ---------- 2. The person agrees ----------

export type AuthorizeRequest = {
  client: ClientRecord;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string;
};

// Errors that mean we can't trust the callback address are shown on our page, never redirected.
export type AuthorizeCheck =
  | { ok: true; request: AuthorizeRequest }
  | { ok: false; showError: string }
  | { ok: false; redirectError: string; redirectUri: string; state: string | null };

export async function checkAuthorizeRequest(params: Record<string, string | undefined>): Promise<AuthorizeCheck> {
  const client = params.client_id ? await getClient(params.client_id) : null;
  if (!client) return { ok: false, showError: "This app isn't registered with BeliefAtlas." };
  const redirectUri = params.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : "");
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
    return { ok: false, showError: "This app's return address doesn't match its registration." };
  }
  const state = params.state ?? null;
  const fail = (error: string) => ({ ok: false as const, redirectError: error, redirectUri, state });
  if (params.response_type !== "code") return fail("unsupported_response_type");
  if (!params.code_challenge || params.code_challenge_method !== "S256") return fail("invalid_request");
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(params.code_challenge)) return fail("invalid_request");
  const scopes = (params.scope ?? SCOPE).split(/\s+/).filter(Boolean);
  if (scopes.some((s) => s !== SCOPE)) return fail("invalid_scope");
  return { ok: true, request: { client, redirectUri, state, codeChallenge: params.code_challenge, scope: SCOPE } };
}

function withParams(uri: string, params: Record<string, string | null>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  return u.toString();
}

export const denyRedirect = (redirectUri: string, error: string, state: string | null) =>
  withParams(redirectUri, { error, state });

// The person said yes. Makes or renews their grant to this client and returns where to send the
// browser, carrying a one-use code.
export async function approve(account: Account, req: AuthorizeRequest): Promise<string> {
  const [grant] = await query<{ id: string }>(
    `insert into ai_grants (account_id, client_id, scope, consent_version)
     values ($1, $2, $3, $4)
     on conflict (account_id, client_id)
     do update set scope = excluded.scope, consent_version = excluded.consent_version, created_at = now(), revoked_at = null
     returning id`,
    [account.id, req.client.id, req.scope, CONSENT_VERSION],
  );
  const code = randomToken("cmcode");
  await query(
    `insert into ai_auth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [hmac("code", code), grant.id, req.redirectUri, req.codeChallenge, CODE_TTL_S],
  );
  return withParams(req.redirectUri, { code, state: req.state });
}

// ---------- 3. Tokens ----------

export type TokenResponse = {
  access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string;
};
export type TokenResult = { ok: true; body: TokenResponse } | { ok: false; error: "invalid_grant" | "invalid_request" | "unsupported_grant_type" | "invalid_client" };

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

async function issue(grantId: string | number): Promise<TokenResponse> {
  const access = randomToken("cma");
  const refresh = randomToken("cmr");
  await query(
    `insert into ai_tokens (token_hash, grant_id, kind, expires_at) values
       ($1, $3, 'access',  now() + make_interval(secs => $4)),
       ($2, $3, 'refresh', now() + make_interval(secs => $5))`,
    [hmac("token", access), hmac("token", refresh), grantId, ACCESS_TTL_S, REFRESH_TTL_S],
  );
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
}

export async function exchange(form: Record<string, string | undefined>): Promise<TokenResult> {
  const clientId = form.client_id ?? "";
  if (form.grant_type === "authorization_code") {
    const { code, redirect_uri: redirectUri, code_verifier: verifier } = form;
    if (!code || !redirectUri || !verifier) return { ok: false, error: "invalid_request" };
    const grantId = await transaction(async (db) => {
      const res = await db.query<{ grant_id: string; redirect_uri: string; code_challenge: string; client_id: string }>(
        `update ai_auth_codes c set used_at = now()
           from ai_grants g
          where c.code_hash = $1 and c.used_at is null and c.expires_at > now()
            and g.id = c.grant_id and g.revoked_at is null
         returning c.grant_id, c.redirect_uri, c.code_challenge, g.client_id`,
        [hmac("code", code)],
      );
      const row = res.rows[0];
      if (!row) return null;
      if (row.client_id !== clientId || row.redirect_uri !== redirectUri) return null;
      if (!sameString(s256(verifier), row.code_challenge)) return null;
      return row.grant_id;
    });
    if (!grantId) return { ok: false, error: "invalid_grant" };
    return { ok: true, body: await issue(grantId) };
  }
  if (form.grant_type === "refresh_token") {
    const refresh = form.refresh_token;
    if (!refresh) return { ok: false, error: "invalid_request" };
    const grantId = await transaction(async (db) => {
      const res = await db.query<{ grant_id: string; client_id: string }>(
        `update ai_tokens t set used_at = now()
           from ai_grants g join ai_clients c on c.id = g.client_id
          where t.token_hash = $1 and t.kind = 'refresh' and t.used_at is null and t.expires_at > now()
            and g.id = t.grant_id and g.revoked_at is null and c.revoked_at is null
         returning t.grant_id, g.client_id`,
        [hmac("token", refresh)],
      );
      const row = res.rows[0];
      return row && row.client_id === clientId ? row.grant_id : null;
    });
    if (!grantId) return { ok: false, error: "invalid_grant" };
    return { ok: true, body: await issue(grantId) };
  }
  return { ok: false, error: "unsupported_grant_type" };
}

// ---------- Who is calling ----------

export type Linked = { grantId: number; account: Account; clientId: string; platform: string };

export async function linkedFor(authorization: string | null): Promise<Linked | null> {
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return null;
  const [row] = await query<{
    grant_id: string; client_id: string; platform: string;
    id: number; username: string; tier: Account["tier"]; verified: boolean; role: Account["role"];
  }>(
    `select g.id as grant_id, c.id as client_id, c.platform, a.id, a.username, a.tier, a.verified, a.role
       from ai_tokens t
       join ai_grants g on g.id = t.grant_id
       join ai_clients c on c.id = g.client_id
       join accounts a on a.id = g.account_id
      where t.token_hash = $1 and t.kind = 'access' and t.expires_at > now()
        and g.revoked_at is null and c.revoked_at is null and a.deleted_at is null`,
    [hmac("token", token)],
  );
  if (!row) return null;
  await query("update ai_grants set last_used_at = now() where id = $1", [row.grant_id]);
  return {
    grantId: Number(row.grant_id),
    clientId: row.client_id,
    platform: row.platform,
    account: { id: row.id, username: row.username, tier: row.tier, verified: row.verified, role: row.role },
  };
}

// ---------- Unlinking ----------

export async function revokeGrant(accountId: number, grantId: number): Promise<boolean> {
  const rows = await query<{ id: string }>(
    "update ai_grants set revoked_at = now() where id = $1 and account_id = $2 and revoked_at is null returning id",
    [grantId, accountId],
  );
  if (!rows.length) return false;
  await query("delete from ai_tokens where grant_id = $1", [grantId]);
  return true;
}

export async function grantsFor(accountId: number) {
  return query<{ id: string; client_name: string; platform: string; created_at: Date; last_used_at: Date | null }>(
    `select g.id, c.client_name, c.platform, g.created_at, g.last_used_at
       from ai_grants g join ai_clients c on c.id = g.client_id
      where g.account_id = $1 and g.revoked_at is null
      order by g.created_at desc`,
    [accountId],
  );
}
