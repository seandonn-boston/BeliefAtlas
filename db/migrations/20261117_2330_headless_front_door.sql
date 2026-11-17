-- The headless front door: organizations show BeliefAtlas questions inside their own sites, apps,
-- checkout screens and CMSs (design: belief-map/headless-front-door.md).
--
-- Built switched off (HEADLESS_ENABLED). Nothing here holds a secret: no API keys, no billing,
-- no bank details. Placement ids are public, like a publishable key: they identify a spot where
-- an org shows questions; they authorize nothing beyond reading public question cards.
--
-- No org from a sanctioned place, Russia, Belarus or China, and none that hasn't cleared sanctions
-- screening (lib/headless/org-eligibility.ts).
--
-- Orgs never ask questions through the API (Sean's rule: questions are asked on the BeliefAtlas
-- website or app). Placements only point at questions that already exist.

create table organizations (
  id          bigint generated always as identity primary key,
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name        text not null check (length(name) between 1 and 120),
  -- pending until reviewed; suspended switches every placement off at once.
  status      text not null default 'pending' check (status in ('pending', 'active', 'suspended')),
  -- Same origins as accounts (lib/provenance.ts): test orgs exist only for tests and previews.
  origin      text not null default 'real' check (origin in ('real', 'test', 'seed')),
  -- Where the org is based (ISO 3166-1 alpha-2). Orgs in sanctioned places, Russia, Belarus or China may
  -- not be orgs at all (Sean, 17 Nov); an org with no country never serves.
  country     text check (country ~ '^[A-Z]{2}$'),
  -- Set by the sanctions screening (US, UN, EU and UK lists) when the org is clear. Null means
  -- not yet screened, or a match: either way it never serves.
  sanctions_cleared_at timestamptz,
  created_by  integer references accounts(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- People who run an org are ordinary BeliefAtlas accounts (18+, phone-checked), never a separate
-- kind of login.
create table org_members (
  org_id      bigint not null references organizations(id) on delete cascade,
  account_id  integer not null references accounts(id) on delete cascade,
  role        text not null default 'member' check (role in ('admin', 'member')),
  added_at    timestamptz not null default now(),
  primary key (org_id, account_id)
);
create index org_members_account on org_members (account_id);

-- One spot where an org shows questions: "checkout screen, Back Bay store", "article footer".
create table org_placements (
  id               text primary key check (id ~ '^pl-[a-z0-9]{12}$'),
  org_id           bigint not null references organizations(id) on delete cascade,
  label            text not null check (length(label) between 1 and 120),
  kind             text not null check (kind in ('site', 'app', 'cms', 'pos', 'ad', 'kiosk')),
  -- Web origins allowed to read this placement from a browser, and to be told a vote counted.
  allowed_origins  text[] not null default '{}',
  -- Questions to show, in order. Empty means the public feed.
  question_ids     integer[] not null default '{}',
  -- The org says the placement is not on a child-directed site or app (Sean: no data on
  -- children, ever). A placement without it never serves.
  not_child_directed boolean not null default false,
  created_at       timestamptz not null default now(),
  disabled_at      timestamptz
);
create index org_placements_org on org_placements (org_id);

-- Placement results count answers given through a placement (vote_events.placement).
create index vote_events_placement on vote_events (placement, question_id) where placement is not null;
