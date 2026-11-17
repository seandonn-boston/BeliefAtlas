-- M1, the owner's moderation decisions of 17 Nov 2026 (section 7 of asking-and-moderation.md):
-- the "moderator approved" mark with a clean report slate, a duplicates queue that never hides
-- a question, merges that can invert polarity, a heads-up for everyone whose answer moved, and
-- rule ids on merges and denials so the rulebook can be attached later (lib/moderation/rules.ts).

-- Flip an answer for an inverted merge: true <-> false, unsure stays unsure.
create function vote_flip(v text) returns text language sql immutable as $$
  select case v when 'true' then 'false' when 'false' then 'true' else v end
$$;

-- ---------- Approval wipes the report slate, the ledger keeps it ----------
-- A moderator's approval clears every report on the question: the rows stay for the ledger, but
-- counts and the hide threshold only see uncleared reports. Someone who reported before the
-- approval can report again, which is a new row, so the old one is never overwritten.
alter table reports
  add column cleared_at   timestamptz,
  add column cleared_by   integer references accounts(id) on delete set null,
  -- For a "repeats another question" report: the question it repeats, when the reporter said.
  add column duplicate_of integer references questions(id) on delete set null;
alter table reports drop constraint reports_question_id_account_id_key;
create unique index reports_one_live on reports (question_id, account_id) where cleared_at is null;
drop index reports_open;
create index reports_open on reports (question_id) where resolved_at is null and cleared_at is null;

-- The mark. Set by the latest approval; a question hidden again by new reports keeps it, but a
-- hidden question isn't shown anywhere until a moderator looks again.
alter table questions
  add column approved_at  timestamptz,
  add column approved_by  integer references accounts(id) on delete set null,
  -- The rulebook rule a denial was made under (lib/moderation/rules.ts).
  add column removed_rule text;

-- Every decision can name the rule it was made under.
alter table moderation_log add column rule_id text;

-- ---------- Merges that invert ----------
-- `inverted`: the repeat asks the same thing with the opposite polarity, so a moved True counts
-- as False and the other way round (unsure stays unsure). `rule_id` is the rulebook rule; `rule`
-- stays the vote-combining rule (move_unanswered_keep_original).
alter table question_merges
  add column inverted boolean not null default false,
  add column rule_id  text;

-- The history records a move: which merge moved the row here, and the answer as originally
-- given (before an inverted merge flipped it). `merge_review` marks a change made in answer to
-- a merge heads-up; it doesn't use up the day's change (lib/votes.ts).
alter table vote_events
  add column moved_by_merge bigint,
  add column original_value text check (original_value in ('true', 'false', 'unsure')),
  add column merge_review   bigint;
create index vote_events_moved_by_merge on vote_events (moved_by_merge) where moved_by_merge is not null;

-- ---------- Suspected duplicates ----------
-- A pair waiting for a moderator. Neither question is hidden: both keep taking answers. One row
-- per pair, ever, so a pair a moderator dismissed is never suggested again.
create table duplicate_suspects (
  id              bigint generated always as identity primary key,
  question_a      integer not null references questions(id) on delete cascade,   -- the lower id
  question_b      integer not null references questions(id) on delete cascade,
  source          text not null check (source in ('ask', 'report', 'moderator')),
  similarity      real,
  suggested_by    integer references accounts(id) on delete set null,
  times_suggested integer not null default 1,
  status          text not null default 'open' check (status in ('open', 'dismissed', 'merged')),
  decided_by      integer references accounts(id) on delete set null,
  decided_at      timestamptz,
  rule_id         text,
  created_at      timestamptz not null default now(),
  check (question_a < question_b)
);
create unique index duplicate_suspects_pair on duplicate_suspects (question_a, question_b);
create index duplicate_suspects_open on duplicate_suspects (created_at) where status = 'open';

-- ---------- The heads-up after a merge ----------
-- One per person whose answer a merge moved. Shown on the original's page until they keep or
-- change their answer. Removed with the merge if the merge is overturned.
create table merge_notices (
  id               bigint generated always as identity primary key,
  account_id       integer not null references accounts(id) on delete cascade,
  merge_id         bigint not null references question_merges(id) on delete cascade,
  from_question_id integer not null references questions(id) on delete cascade,
  into_question_id integer not null references questions(id) on delete cascade,
  original_value   text not null check (original_value in ('true', 'false', 'unsure')),
  counted_value    text not null check (counted_value in ('true', 'false', 'unsure')),
  created_at       timestamptz not null default now(),
  seen_at          timestamptz,
  dismissed_at     timestamptz,     -- kept their answer
  changed_at       timestamptz,     -- changed it (that change was free)
  unique (account_id, merge_id)
);
create index merge_notices_open on merge_notices (account_id, into_question_id)
  where dismissed_at is null and changed_at is null;
