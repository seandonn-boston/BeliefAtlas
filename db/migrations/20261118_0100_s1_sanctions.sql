-- S1, sanctions screening for data buyers and anyone given organisation access
-- (lib/sanctions/screening.ts). There is no buyers or organisations table yet: a future signup
-- creates a screened party and waits for a person's approval here. Nothing is auto-approved.

create extension if not exists pg_trgm;

-- ---------- The lists ----------
-- One row per download of one list. Only the latest successful import of a list is current;
-- a failed download or parse is recorded with its error and leaves the previous one current.
create table sanctions_list_imports (
  id           bigint generated always as identity primary key,
  list         text not null check (list in ('ofac_sdn', 'ofac_cons', 'un', 'eu', 'uk')),
  fetched_at   timestamptz not null default now(),
  source_url   text not null,
  sha256       text,
  entry_count  integer not null default 0,
  status       text not null check (status in ('ok', 'failed')),
  error        text,
  is_current   boolean not null default false,
  check (not is_current or status = 'ok'),
  check (status = 'ok' or error is not null)
);
create unique index sanctions_list_imports_one_current on sanctions_list_imports (list) where is_current;
create index sanctions_list_imports_latest on sanctions_list_imports (list, fetched_at desc);

-- One row per listed name: the primary name and each alias, sharing the publisher's source_id.
-- Entries of imports that are no longer current are deleted after each successful import; the
-- import rows stay as the history of what was fetched when.
create table sanctions_entries (
  id          bigint generated always as identity primary key,
  import_id   bigint not null references sanctions_list_imports(id) on delete cascade,
  list        text not null check (list in ('ofac_sdn', 'ofac_cons', 'un', 'eu', 'uk')),
  source_id   text not null,
  kind        text not null check (kind in ('person', 'entity', 'vessel', 'aircraft', 'unknown')),
  name        text not null,
  name_norm   text not null,
  is_alias    boolean not null default false,
  programs    text[] not null default '{}',
  countries   text[] not null default '{}'
);
create index sanctions_entries_import on sanctions_entries (import_id);
create index sanctions_entries_name_trgm on sanctions_entries using gin (name_norm gin_trgm_ops);

-- ---------- Who we screen ----------
-- buyer: a data buyer (person or company); org: an organisation; org_member: a person given
-- access through one. Country is ISO 3166-1 alpha-2, the country the party is based in.
create table screened_parties (
  id                bigint generated always as identity primary key,
  kind              text not null check (kind in ('buyer', 'org_member', 'org')),
  name              text not null check (length(trim(name)) > 0),
  name_norm         text not null,
  country           char(2),
  created_at        timestamptz not null default now(),
  -- pending: not screened yet; clear: screened, no open possible match (still needs approval);
  -- review: open possible matches; refused; approved: a moderator or admin approved it.
  status            text not null default 'pending' check (status in ('pending', 'clear', 'review', 'refused', 'approved')),
  status_reason     text,
  last_screened_at  timestamptz,
  reviewed_by       integer references accounts(id) on delete set null,
  reviewed_at       timestamptz
);
create index screened_parties_status on screened_parties (status);

-- A possible match between a party and a listed name. One row per party, list and listed person
-- or thing (source_id, or the matched name when there is none), so a rescreen raises the score
-- of an existing hit instead of adding a duplicate, and a hit a person marked as a false match
-- isn't raised again for the same listing.
create table screening_hits (
  id            bigint generated always as identity primary key,
  party_id      bigint not null references screened_parties(id) on delete cascade,
  entry_id      bigint references sanctions_entries(id) on delete set null,
  list          text not null,
  source_id     text,
  matched_name  text not null,
  score         real not null,
  created_at    timestamptz not null default now(),
  resolution    text not null default 'open' check (resolution in ('open', 'false_match', 'true_match')),
  resolved_by   integer references accounts(id) on delete set null,
  resolved_at   timestamptz,
  note          text
);
create unique index screening_hits_one_per_listing on screening_hits (party_id, list, (coalesce(source_id, matched_name)));
create index screening_hits_open on screening_hits (party_id) where resolution = 'open';

-- ---------- OFAC's recent actions ----------
-- Recorded daily for a person to read. Nothing here changes lib/sanctions/places.ts or any list.
create table ofac_recent_actions (
  id                  bigint generated always as identity primary key,
  action_date         date not null,
  title               text not null,
  url                 text not null,
  is_country_program  boolean not null default false,
  seen_at             timestamptz not null default now(),
  reviewed            boolean not null default false,
  reviewed_by         integer references accounts(id) on delete set null,
  reviewed_at         timestamptz,
  unique (action_date, title)
);
create index ofac_recent_actions_unreviewed on ofac_recent_actions (action_date desc) where not reviewed and is_country_program;
