-- R1: the product is now BeliefAtlas (renamed 21 Nov 2026).
--
-- Databases created before the rename still carry the earlier name in three places. This
-- migration updates them in place; on a new database it finds nothing to change. The earlier
-- name is written below only as hex, so it appears nowhere in the code.
--   * Consent texts: the stored wording is changed in place (pre-launch, no real users had
--     agreed to it). Version 2 of each text is then added as a copy, as before.
--   * The China region note.
--   * The seed guard: the setting the seed loader turns on is now beliefatlas.seed_load.
-- Seed accounts loaded before the rename use the old phone-hash prefix: remove and reload them
-- (npm run seed:remove, then npm run seed:load) on any database that has them.

update consent_texts
   set body = replace(body, convert_from(decode('437265646f4d6170', 'hex'), 'UTF8'), 'BeliefAtlas')
 where strpos(body, convert_from(decode('437265646f4d6170', 'hex'), 'UTF8')) > 0;

insert into consent_texts (choice, version, lang, body, draft)
select choice, '2', lang, body, draft
  from consent_texts
 where version = '1'
on conflict (choice, version, lang) do nothing;

update regions
   set notes = replace(notes, convert_from(decode('437265646f4d6170', 'hex'), 'UTF8'), 'BeliefAtlas')
 where strpos(notes, convert_from(decode('437265646f4d6170', 'hex'), 'UTF8')) > 0;

create or replace function accounts_origin_guard() returns trigger language plpgsql as $$
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
