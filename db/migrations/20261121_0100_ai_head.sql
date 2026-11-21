-- AI head: the Claude plugin's MCP server and the account link behind it
-- (belief-map/claude-plugin.md). Everything here is unused while AI_HEAD_ENABLED is off.
--
-- An AI client never gets an account and never votes (Sean, 20 Nov 2026). These tables hold
-- the AI client's registration, the person's own grant to it, and the short-lived tokens the
-- chat app holds for that person. Only HMACs of codes and tokens are stored.

-- An AI client registered by OAuth dynamic client registration. kind is always 'ai'.
-- platform is worked out from the callback address ('claude', 'claude-code'), not trusted.
create table ai_clients (
  id             text primary key,                 -- the public client_id
  kind           text not null default 'ai' check (kind = 'ai'),
  platform       text not null,
  client_name    text not null,
  redirect_uris  text[] not null,
  origin         text not null default 'live' check (origin in ('live', 'test')),
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz
);

-- One person's grant to one AI client: "show me BeliefAtlas cards, send the answers I tap".
-- share_answers: whether the card tells the assistant what they picked by default.
create table ai_grants (
  id             bigint generated always as identity primary key,
  account_id     integer not null references accounts(id) on delete cascade,
  client_id      text not null references ai_clients(id) on delete cascade,
  scope          text not null,
  consent_version text not null,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  unique (account_id, client_id)
);
create index ai_grants_account on ai_grants (account_id);

-- Authorization codes: one use, ten minutes, bound to the PKCE challenge and callback.
create table ai_auth_codes (
  code_hash       text primary key,
  grant_id        bigint not null references ai_grants(id) on delete cascade,
  redirect_uri    text not null,
  code_challenge  text not null,
  expires_at      timestamptz not null,
  used_at         timestamptz
);

-- Access tokens (one hour) and refresh tokens (30 days, replaced on every use).
create table ai_tokens (
  token_hash   text primary key,
  grant_id     bigint not null references ai_grants(id) on delete cascade,
  kind         text not null check (kind in ('access', 'refresh')),
  expires_at   timestamptz not null,
  used_at      timestamptz,                      -- refresh tokens: set when exchanged
  created_at   timestamptz not null default now()
);
create index ai_tokens_grant on ai_tokens (grant_id);

-- Card tokens that have been spent: a card can send one answer, once.
create table ai_card_taps (
  token_hash   text primary key,
  grant_id     bigint references ai_grants(id) on delete set null,
  question_id  integer not null,
  used_at      timestamptz not null default now()
);

-- Every call through the AI door, labelled as AI traffic, for budgets and the behaviour ladder.
-- No chat content and no question text from the conversation; the address is hashed.
create table ai_requests (
  id            bigint generated always as identity primary key,
  caller_kind   text not null default 'ai' check (caller_kind = 'ai'),
  client_id     text,
  grant_id      bigint,
  platform      text,
  method        text not null,
  tool          text,
  ip_hash       text not null,
  claude_egress boolean not null default false,  -- came from Anthropic's published range: a hint only
  outcome       text,
  created_at    timestamptz not null default now()
);
create index ai_requests_created on ai_requests (created_at);
create index ai_requests_grant on ai_requests (grant_id, created_at);
