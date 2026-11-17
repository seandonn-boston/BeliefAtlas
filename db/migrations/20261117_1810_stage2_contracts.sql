-- Stage 2 contracts: the tables every Stage 2 workstream builds on. One canonical question across
-- languages, merges and archive, the moderation ledger (demerits, bans, appeals), the consent
-- ledger, optional demographics, the region table, and a Postgres job queue.
-- From here on, migrations use timestamp names so parallel work never collides on a number.

-- ---------- Languages ----------
-- Every question has one canonical id. Its own text is in `lang`; translations hang off it and
-- go live only after a person approves them.
alter table questions add column lang text not null default 'en';

create table question_translations (
  question_id  integer not null references questions(id) on delete cascade,
  lang         text not null check (lang ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  text         text not null,
  normalized   text not null,
  status       text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  source       text not null default 'human' check (source in ('human', 'machine')),
  drafted_by   integer references accounts(id) on delete set null,
  reviewed_by  integer references accounts(id) on delete set null,
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now(),
  primary key (question_id, lang)
);
create index question_translations_review on question_translations (lang, created_at) where status = 'draft';
create index question_translations_trgm on question_translations using gin (normalized gin_trgm_ops) where status = 'approved';

-- The language the voter saw when they answered.
alter table votes add column lang text;
alter table vote_events add column lang text;
alter table pending_votes add column lang text;

-- ---------- Merges and archive ----------
-- When two questions ask the same thing, one is merged into the other. The rule says how votes
-- were combined (open decision 9 in the build plan), so a merge can always be explained.
create table question_merges (
  id               bigint generated always as identity primary key,
  from_question_id integer not null references questions(id) on delete cascade,
  into_question_id integer not null references questions(id) on delete cascade,
  rule             text not null,
  votes_moved      integer not null default 0,
  votes_kept       integer not null default 0,
  merged_by        integer references accounts(id) on delete set null,
  created_at       timestamptz not null default now(),
  check (from_question_id <> into_question_id)
);
create unique index question_merges_from on question_merges (from_question_id);

-- Archived and removed questions leave feeds, take no answers or edits, and never appear in an
-- export or a sale. `archived_at` records when, for the appeal clock.
alter table questions add column archived_at timestamptz;

-- ---------- Moderation ledger ----------
-- A demerit is added only for harmful questions, never for an ordinary denial. Points expire.
create table demerits (
  id          bigint generated always as identity primary key,
  account_id  integer not null references accounts(id) on delete cascade,
  question_id integer references questions(id) on delete set null,
  reason      text not null,
  points      integer not null default 1 check (points > 0),
  created_by  integer references accounts(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '180 days',
  revoked_at  timestamptz
);
create index demerits_active on demerits (account_id, expires_at) where revoked_at is null;

-- Bans for questions asked are always temporary and lengthen each time. A permanent ban is only
-- ever for vote manipulation, and the database refuses any other.
create table bans (
  id          bigint generated always as identity primary key,
  account_id  integer not null references accounts(id) on delete cascade,
  scope       text not null default 'asking' check (scope in ('asking', 'all')),
  cause       text not null check (cause in ('demerits', 'manipulation', 'other')),
  permanent   boolean not null default false,
  reason      text not null,
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,
  lifted_at   timestamptz,
  lifted_by   integer references accounts(id) on delete set null,
  created_by  integer references accounts(id) on delete set null,
  created_at  timestamptz not null default now(),
  check (permanent = (ends_at is null)),
  check (not permanent or cause = 'manipulation')
);
create index bans_active on bans (account_id) where lifted_at is null;

create table appeals (
  id           bigint generated always as identity primary key,
  account_id   integer not null references accounts(id) on delete cascade,
  subject      text not null check (subject in ('question', 'ban', 'demerit')),
  subject_id   bigint not null,
  body         text not null check (length(body) between 1 and 2000),
  status       text not null default 'open' check (status in ('open', 'upheld', 'overturned')),
  decided_by   integer references accounts(id) on delete set null,
  decided_at   timestamptz,
  outcome_note text,
  created_at   timestamptz not null default now()
);
create unique index appeals_one_open on appeals (account_id, subject, subject_id) where status = 'open';
create index appeals_queue on appeals (created_at) where status = 'open';

-- Signals of coordinated or fake voting. These feed the only path to a permanent ban, and only
-- after a person reviews them.
create table manipulation_signals (
  id          bigint generated always as identity primary key,
  account_id  integer references accounts(id) on delete cascade,
  question_id integer references questions(id) on delete cascade,
  kind        text not null,
  detail      jsonb,
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by integer references accounts(id) on delete set null,
  outcome     text check (outcome in ('confirmed', 'dismissed'))
);
create index manipulation_signals_open on manipulation_signals (created_at) where reviewed_at is null;

-- ---------- Consent ledger ----------
-- Two separate choices. `answering` is required before any answer counts; `sale` is optional,
-- off by default and never required to vote. Every text shown is kept by version so a record
-- always says exactly what the person agreed to.
create table consent_texts (
  choice     text not null check (choice in ('answering', 'sale')),
  version    text not null,
  lang       text not null default 'en',
  body       text not null,
  created_at timestamptz not null default now(),
  primary key (choice, version, lang)
);

-- Append-only: a change is a new row, never an update, so the history is the record.
create table consent_records (
  id           bigint generated always as identity primary key,
  account_id   integer not null references accounts(id) on delete cascade,
  choice       text not null check (choice in ('answering', 'sale')),
  granted      boolean not null,
  text_version text not null,
  lang         text not null default 'en',
  surface      text not null,
  region       text,
  gpc          boolean not null default false,
  created_at   timestamptz not null default now()
);
create index consent_records_latest on consent_records (account_id, choice, created_at desc);

-- A tap held before signup can carry the consent given on that screen, claimed with the vote.
alter table pending_votes add column consent_version text;

-- ---------- Regions ----------
-- Voting is open everywhere. Whether person-level answers may ever be sold is decided per
-- region, and every region starts closed until a lawyer has reviewed it.
create table regions (
  code            text primary key,      -- ISO 3166-1 alpha-2, or '*' for the default
  name            text not null,
  sale_allowed    boolean not null default false,
  needs_opt_in    boolean not null default true,
  min_group_size  integer not null default 50,
  reviewed_at     timestamptz,
  notes           text
);
insert into regions (code, name, notes) values
  ('*', 'Everywhere else', 'Closed to sale until reviewed by a lawyer.');

alter table accounts add column region text;

-- ---------- Optional demographics ----------
-- Everything here is optional and can be cleared at any time. Children are described only by
-- non-identifying answers from a parent; never a child's name, birth date or account.
create table account_demographics (
  account_id  integer primary key references accounts(id) on delete cascade,
  age_range   text check (age_range in ('18-24', '25-34', '35-44', '45-54', '55-64', '65+')),
  country     text,
  is_parent   boolean,
  updated_at  timestamptz not null default now()
);

create table account_children (
  id          bigint generated always as identity primary key,
  account_id  integer not null references accounts(id) on delete cascade,
  relation    text not null check (relation in ('son', 'daughter', 'child')),
  age_range   text not null check (age_range in ('0-2', '3-5', '6-9', '10-12', '13-15', '16-17', '18+')),
  created_at  timestamptz not null default now()
);
create index account_children_account on account_children (account_id);

-- ---------- Jobs ----------
-- A small queue in Postgres (no Redis): the sweep, translations, embeddings and rollups.
-- Workers claim with `for update skip locked`.
create table jobs (
  id          bigint generated always as identity primary key,
  kind        text not null,
  payload     jsonb not null default '{}',
  run_at      timestamptz not null default now(),
  attempts    integer not null default 0,
  max_attempts integer not null default 5,
  locked_at   timestamptz,
  locked_by   text,
  done_at     timestamptz,
  last_error  text,
  created_at  timestamptz not null default now()
);
create index jobs_ready on jobs (run_at, id) where done_at is null;

-- ---------- Language preference ----------
alter table accounts add column lang text;
