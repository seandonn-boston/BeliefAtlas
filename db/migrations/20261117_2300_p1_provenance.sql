-- P1: where every account, vote and vote event came from, so test and seed data can never be
-- mixed up with real people's answers, never sold, and can be removed completely.
--
--   real  a person who signed up on the live site. The default, and the only origin ever sold
--         or served to API keys.
--   test  made for trying the site out: preview test-mode signups, the demo data loader
--         (db/seed.ts), load tests and screenshots. Never allowed in a production database.
--   seed  fictional launch accounts and votes loaded by `npm run seed:load`, shown to make an
--         empty site feel less empty, and removed with `npm run seed:remove` before any data
--         sale or keyed API access opens (lib/provenance.ts assertNoSeedData()).
--
-- The rules are enforced here, not just in application code:
--   * A vote and a vote event always take their account's origin. A BEFORE trigger overwrites
--     whatever the insert said, so nothing a request sends can choose it.
--   * A vote or event can't be moved to an account of a different origin (account deletion
--     moves history to a stand-in, which therefore copies the origin).
--   * An account's origin can't change while it has any votes or vote events. We refuse rather
--     than cascade: cascading would silently move a person's answers in or out of what is
--     counted as real (and so in or out of a sale). Changing it means removing the data first,
--     deliberately.
--   * A 'test' account can't be created in a database marked as production (database_environment,
--     written by db/migrate.ts on a production deploy), whatever the application thinks.
--   * A 'seed' account can only be created inside a transaction that set
--     beliefatlas.seed_load = 'on', which only the seed loader does.

-- ---------- Which environment this database belongs to ----------
-- One row at most. db/migrate.ts marks the database 'production' when a production deploy
-- migrates it, and the mark is never lowered: a database that has served production stays
-- production. Unmarked means a preview or development database.
create table database_environment (
  only_row    boolean primary key default true check (only_row),
  environment text not null check (environment in ('production')),
  marked_at   timestamptz not null default now()
);

create function database_is_production() returns boolean language sql stable as $$
  select exists (select 1 from database_environment where environment = 'production')
$$;

-- ---------- Columns ----------
alter table accounts add column origin text not null default 'real'
  check (origin in ('real', 'test', 'seed'));
-- The seed file's own key for a seed account, so loading the same file again finds it.
alter table accounts add column seed_key text;
alter table accounts add constraint accounts_seed_key_only_seed check (seed_key is null or origin = 'seed');
create unique index accounts_seed_key on accounts (seed_key) where seed_key is not null;

alter table votes add column origin text not null default 'real'
  check (origin in ('real', 'test', 'seed'));
-- Constant default on the partitioned parent: no rewrite, and every partition gets the column.
alter table vote_events add column origin text not null default 'real'
  check (origin in ('real', 'test', 'seed'));

-- Nearly everything is real, so the indexes cover only the rest: "is any seed or test data
-- left?" and "which rows are seed?" stay instant however large the tables grow.
create index accounts_origin_not_real on accounts (origin) where origin <> 'real';
create index votes_origin_not_real on votes (origin, account_id) where origin <> 'real';
create index vote_events_origin_not_real on vote_events (origin, account_id) where origin <> 'real';

-- ---------- Existing demo data ----------
-- Accounts made by the demo loader (db/seed.ts) and the screenshot script before this
-- migration are test data. Their password hashes are fixed strings no real signup can have.
update accounts set origin = 'test'
 where password_hash in ('seed-account-no-login', 'screenshot-no-login');
update votes v set origin = 'test' from accounts a where a.id = v.account_id and a.origin = 'test';
update vote_events e set origin = 'test' from accounts a where a.id = e.account_id and a.origin = 'test';

-- ---------- A vote takes its account's origin ----------
create function take_account_origin() returns trigger language plpgsql as $$
declare
  o text;
begin
  -- KEY SHARE waits for an origin change in progress (which locks the account FOR UPDATE, see
  -- accounts_origin_guard) and then reads the committed value, so the two can't interleave.
  select origin into o from accounts where id = new.account_id for key share;
  if o is null then
    return new;   -- the foreign key check reports the missing account
  end if;
  if tg_op = 'UPDATE' and old.origin is distinct from o then
    raise exception '% row of a % account cannot move to a % account', tg_table_name, old.origin, o
      using errcode = 'check_violation';
  end if;
  new.origin := o;
  return new;
end $$;

create trigger votes_take_account_origin before insert or update of account_id, origin on votes
  for each row execute function take_account_origin();
-- On the partitioned parent: cloned onto every partition, including ones attached later.
create trigger vote_events_take_account_origin before insert or update of account_id, origin on vote_events
  for each row execute function take_account_origin();

-- ---------- Guarding an account's origin ----------
create function accounts_origin_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.origin is not distinct from old.origin then
    return new;
  end if;
  -- Both checks are about accounts someone could use. A deleted account's anonymous stand-in
  -- (lib/account.ts deleteAccount, deleted_at set) keeps the origin so its history keeps it too.
  if new.deleted_at is null then
    if new.origin = 'test' and database_is_production() then
      raise exception 'test accounts cannot be created in a production database'
        using errcode = 'check_violation';
    end if;
    -- Seed accounts come only from the seed loader.
    if new.origin = 'seed' and coalesce(current_setting('beliefatlas.seed_load', true), '') <> 'on' then
      raise exception 'seed accounts are created only by npm run seed:load'
        using errcode = 'check_violation';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    -- Hold the row against new votes while we look, then refuse if it has any.
    perform 1 from accounts where id = old.id for update;
    if exists (select 1 from votes where account_id = old.id)
       or exists (select 1 from vote_events where account_id = old.id) then
      raise exception 'account % has votes: its origin cannot change from % to % (remove its votes first)',
        old.id, old.origin, new.origin using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create trigger accounts_origin_guard before insert or update of origin on accounts
  for each row execute function accounts_origin_guard();
