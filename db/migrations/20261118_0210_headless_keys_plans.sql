-- Org keys and plans for the headless front door (belief-map/headless-front-door.md sections 6
-- and 14). Built complete and switched off: keys are issued only with HEADLESS_KEYS_ENABLED, and
-- paid plans are sold only with HEADLESS_ORG_BILLING_ENABLED and Stripe configured. Sean's
-- freeze on keys and billing is temporary; this is ready for when he lifts it.

-- An org's plan. 'free' until it buys one; the limits live in lib/headless/plans.ts.
alter table organizations
  add column plan text not null default 'free' check (plan in ('free', 'pro', 'business')),
  -- Stripe's status for the plan's subscription (active, past_due, canceled, ...), or 'dev' or
  -- 'manual' when set without Stripe. Null on the free plan.
  add column plan_status text,
  add column stripe_customer_id text unique,
  add column plan_changed_at timestamptz;

-- Server keys. Only a hash of the secret is stored: the full key is shown once, when issued.
-- Format: cm_live_<lookup>_<secret> (cm_test_ outside production).
create table org_credentials (
  id            bigint generated always as identity primary key,
  org_id        bigint not null references organizations(id) on delete cascade,
  lookup        text not null unique check (lookup ~ '^[a-z0-9]{10}$'),
  secret_hash   text not null,
  label         text not null check (length(label) between 1 and 80),
  -- relay: send taps from the org's server (also needs HEADLESS_RELAY_ENABLED).
  -- results: read the org's aggregate placement results from its server.
  scopes        text[] not null check (scopes <@ array['relay', 'results'] and cardinality(scopes) > 0),
  created_by    integer references accounts(id) on delete set null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  -- A rotated key keeps working until expires_at, so the org can swap it without downtime.
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_by    integer references accounts(id) on delete set null
);
create index org_credentials_org on org_credentials (org_id);
