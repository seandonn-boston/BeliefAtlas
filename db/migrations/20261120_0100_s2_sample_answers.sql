-- Sample answers: seed votes (origin 'seed', lib/provenance.ts) are fictional launch answers. Sean,
-- 20 Nov 2026: label them as sample answers wherever they show. Each question keeps a count of
-- the seed votes inside its totals, so every split can say "includes sample answers" without a
-- second query.
--
-- The count is kept by triggers that fire only for seed rows (the WHEN clause is checked before
-- any function runs), so a real vote pays nothing for it. A vote's origin never changes
-- (20261117_2300_p1_provenance.sql), but a moderator merge can move a seed vote to another
-- question, which the update trigger follows.

alter table questions add column sample_count integer not null default 0 check (sample_count >= 0);

create function sync_sample_count() returns trigger language plpgsql as $$
begin
  if tg_op in ('DELETE', 'UPDATE') and old.origin = 'seed' then
    update questions set sample_count = sample_count - 1 where id = old.question_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.origin = 'seed' then
    update questions set sample_count = sample_count + 1 where id = new.question_id;
  end if;
  return null;
end $$;

create trigger votes_sample_insert after insert on votes
  for each row when (new.origin = 'seed') execute function sync_sample_count();
create trigger votes_sample_delete after delete on votes
  for each row when (old.origin = 'seed') execute function sync_sample_count();
create trigger votes_sample_move after update of question_id on votes
  for each row when ((old.origin = 'seed' or new.origin = 'seed') and old.question_id is distinct from new.question_id)
  execute function sync_sample_count();

-- Count what is already there.
update questions q set sample_count = c.n
  from (select question_id, count(*)::int as n from votes where origin = 'seed' group by question_id) c
 where c.question_id = q.id;
