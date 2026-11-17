-- The front door: one vote engine that every surface calls (the website, share links, embeds,
-- and later Slack, Discord, texts and the rest).
--
-- What this adds:
--   * Where and how fast each answer was given, on every vote event.
--   * The first answer kept next to the current one, so "first instinct" and "later changes"
--     are first-class data instead of something replayed from history.
--   * A "skip" action, so "skipped first, answered later" is visible too. A skip is not a vote:
--     it adds nothing to the split and uses none of the day's votes. "Don't know" is a vote
--     (the existing 'unsure' value): it counts in the split and toward the daily allowance.
--   * Idempotency for platform retries, held votes for people who tap before signing in, and
--     linked platform identities for the in-place integrations that come next.

-- ---------- Vote events: surface, timing, skip ----------

alter table vote_events drop constraint vote_events_action_check;
alter table vote_events add constraint vote_events_action_check
  check (action in ('cast', 'change', 'delete', 'visibility', 'skip'));

alter table vote_events
  add column surface         text not null default 'web',   -- web, share, embed, qr, email, slack, discord, ...
  add column placement       text,                           -- where on that surface, e.g. a poster id or embed host
  add column surface_context jsonb,                          -- platform ids (team, channel, message), never personal data
  add column shown_at        timestamptz,                    -- when the question was put in front of this person
  add column tapped_at       timestamptz,                    -- when they tapped; differs from created_at for held votes
  add column answer_ms       integer;                        -- tapped_at - shown_at, when both are known

create index vote_events_surface on vote_events (surface, created_at);

-- ---------- Votes: the first answer, kept next to the current one ----------
-- first_* is written once and never updated, including after a delete and a re-vote.

alter table votes
  add column first_value     text check (first_value in ('true', 'false', 'unsure')),
  add column first_surface   text,
  add column first_answer_ms integer,
  add column first_blind     boolean,
  add column change_count    integer not null default 0,
  add column last_changed_at timestamptz;

-- Backfill from history: the earliest cast for each vote, and how many changes followed it.
update votes v
   set first_value     = f.value,
       first_cast_at   = f.created_at,
       first_surface   = 'web',
       first_blind     = f.blind,
       change_count    = coalesce(c.n, 0),
       last_changed_at = c.last_at
  from (select distinct on (account_id, question_id) account_id, question_id, value, created_at, blind
          from vote_events where action = 'cast'
         order by account_id, question_id, created_at, id) f
  left join (select account_id, question_id, count(*)::int as n, max(created_at) as last_at
               from vote_events where action in ('change', 'delete')
              group by account_id, question_id) c
         on c.account_id = f.account_id and c.question_id = f.question_id
 where v.account_id = f.account_id and v.question_id = f.question_id;

update votes set first_value = value, first_surface = 'web' where first_value is null;

-- ---------- Idempotency ----------
-- Platforms retry (Slack after 3 seconds, Discord, webhooks), and a double tap is common.
-- The same key always gets the same answer. Rows are kept for two days.

create table vote_requests (
  idempotency_key text primary key,
  account_id      integer not null references accounts(id) on delete cascade,
  result          jsonb not null,
  created_at      timestamptz not null default now()
);
create index vote_requests_created on vote_requests (created_at);

-- ---------- Held votes ----------
-- Someone taps an answer before they are signed in (or after their daily votes ran out).
-- The tap is held for a day and counted, with its original tap time and surface, once they
-- sign up, sign in or upgrade. Only the browser that tapped holds the token.

create table pending_votes (
  token_hash      text primary key,
  question_id     integer not null references questions(id) on delete cascade,
  value           text not null check (value in ('true', 'false', 'unsure', 'skip')),
  surface         text not null,
  placement       text,
  surface_context jsonb,
  shown_at        timestamptz,
  tapped_at       timestamptz not null default now(),
  reason          text not null check (reason in ('needs_signup', 'limit_reached')),
  claimed_by      integer references accounts(id) on delete set null,
  claimed_at      timestamptz,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '24 hours'
);
create index pending_votes_expiry on pending_votes (expires_at);

-- ---------- Linked platform identities ----------
-- A Slack, Discord, Teams or Telegram user linked once to a BeliefAtlas account, so their taps on
-- an in-place card count for that account. Used by the platform adapters that come next.

create table linked_identities (
  id               bigint generated always as identity primary key,
  account_id       integer not null references accounts(id) on delete cascade,
  provider         text not null,                 -- slack, discord, teams, telegram, ...
  provider_tenant  text not null default '',      -- Slack team id, Teams tenant id; '' where none
  provider_user_id text not null,
  linked_at        timestamptz not null default now(),
  last_used_at     timestamptz,
  revoked_at       timestamptz,
  unique (provider, provider_tenant, provider_user_id)
);
create index linked_identities_account on linked_identities (account_id);

-- ---------- Lighter signup ----------
-- Username and password are both optional. Without a username one is generated (and can be
-- changed in settings); without a password the account signs in with a texted code. Passwords
-- stay as one optional factor so passkeys, PINs and other factors can sit beside them later.
-- An account with no password has password_hash = ''.

-- Agreement is a "By continuing you agree" line at the button. Which version of the terms was
-- on screen, and when, is recorded with the account.
alter table accounts add column terms_version text;
alter table pending_signups add column terms_version text;

-- Signing in with a texted code. A row is made for any number typed, with or without an
-- account, so the page can't be used to find out whether a number has an account.
create table pending_logins (
  token_hash   text primary key,
  phone        text not null,                -- needed to check the code; deleted with the row
  account_id   integer references accounts(id) on delete cascade,
  code_hash    text,                         -- development mode only
  attempts     integer not null default 0,
  next_path    text not null default '/',
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index pending_logins_expiry on pending_logins (expires_at);
