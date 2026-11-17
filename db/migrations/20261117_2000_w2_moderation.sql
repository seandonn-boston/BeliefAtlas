-- W2, the moderation pipeline: what a removal tells the asker, a ledger that covers bans,
-- demerits, appeals and manipulation as well as questions, and enough on a merge to undo it.

-- ---------- Removals say why and how to fix it ----------
-- Every required change to a question says why, where and gives a suggested fix. A removal
-- shows the asker these. `removed_harm` is set only when the removal was for something harmful
-- (and so added a demerit); an ordinary removal leaves it null.
alter table questions
  add column removed_why  text,
  add column removed_fix  text,
  add column removed_harm text check (removed_harm in ('hateful', 'harassing', 'private_person', 'spam'));

-- ---------- Demerits keep what was denied ----------
-- A harmful question denied at the sweep was never posted, so the demerit keeps its text for
-- the appeal. `kind` is the harm that earned it.
alter table demerits
  add column kind   text check (kind in ('hateful', 'harassing', 'private_person', 'spam')),
  add column detail text;

-- ---------- Merges can be undone ----------
-- The accounts whose votes moved, so an overturned merge can move them back.
alter table question_merges
  add column moved_accounts integer[] not null default '{}';

-- ---------- One ledger for every decision ----------
-- The log covered only questions. Bans, demerits, appeals and manipulation signals are decided
-- too, and every decision goes here.
alter table moderation_log alter column question_id drop not null;
alter table moderation_log
  add column subject    text not null default 'question'
    check (subject in ('question', 'ban', 'demerit', 'appeal', 'signal')),
  add column subject_id bigint,
  add column account_id integer references accounts(id) on delete set null;   -- whose item it was
update moderation_log set subject_id = question_id where subject_id is null;
create index moderation_log_subject on moderation_log (subject, subject_id, created_at);

-- ---------- Manipulation signals ----------
create index manipulation_signals_question on manipulation_signals (question_id, kind, created_at);

-- Bans that are in force, for the check on every ask.
create index bans_in_force on bans (account_id, ends_at) where lifted_at is null;
