-- China, Hong Kong and Macau: voters are welcome, their answers are never sold (Sean, 17 Nov 2026).
-- The rule lives in lib/sanctions/places.ts and lib/regions.ts; this makes the database refuse
-- it too, so no admin edit of the regions table can open sale there.

insert into regions (code, name, sale_allowed, notes) values
  ('CN', 'China', false, 'Never sold: BeliefAtlas policy and the 2025 DOJ bulk data rule.'),
  ('HK', 'Hong Kong', false, 'Never sold: treated as China.'),
  ('MO', 'Macau', false, 'Never sold: treated as China.')
on conflict (code) do update set sale_allowed = false, notes = excluded.notes;

alter table regions add constraint regions_never_sell
  check (not (code in ('CN', 'HK', 'MO') and sale_allowed));
