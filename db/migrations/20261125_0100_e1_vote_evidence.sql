-- E1: vote evidence, the small extra record kept beside each vote action on a wired question.
--
-- Every vote action already gives us most of the five Ws in vote_events:
--   who   vote_events.account_id   a number, never a name (accounts hold no name at all)
--   what  vote_events.action, value
--   when  vote_events.created_at (exact) and tapped_at
--   how   vote_events.surface, answer_ms (time to decide), lang, is_private, origin
-- This table adds only what vote_events doesn't have, and nothing more:
--   who   the person's own chosen attributes as they stood at that moment (age range, home
--         country). A snapshot, because people change them and the evidence is about then.
--   where a coarse region the phone worked out itself (ISO 3166-2, e.g. 'US-MA'). Never a
--         coordinate, never a trail, never guessed from the network.
--   how   the interface family: web, app, ai_head (a person answering inside an AI chat;
--         the AI never votes) or integration (Slack, Discord, texts and the rest).
--   what  the answer they had before this action, how many times they had changed it, and how
--         long they had held it: the indirect, honest signal (conviction and churn).
--
-- Not collected, by design: who they were with, where they were going, coordinates, contacts,
-- browsing, or anything about another person.
--
-- Only questions listed in vote_evidence_questions get these rows, so it can be wired to one
-- question first and widened later without a code change.
--
-- Joined to vote_events by its key (id, created_at), not by a foreign key (see below). There is
-- no question_id or account_id here: merges and account deletion move vote_events rows, and
-- this follows them through the join instead of going stale. Seed, test and real stay apart through vote_events.origin.

create table vote_evidence_questions (
  question_id integer primary key references questions(id) on delete cascade,
  added_at    timestamptz not null default now(),
  note        text
);

create table vote_evidence (
  event_id               bigint      not null,
  event_created_at       timestamptz not null,
  age_range              text check (age_range in ('18-24', '25-34', '35-44', '45-54', '55-64', '65+')),
  home_country           text check (home_country ~ '^[A-Z]{2}$'),
  region                 text check (region ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$'),
  interface              text not null check (interface in ('web', 'app', 'ai_head', 'integration')),
  previous_value         text check (previous_value in ('true', 'false', 'unsure')),
  change_number          integer not null default 0 check (change_number >= 0),
  seconds_since_previous integer check (seconds_since_previous >= 0),
  primary key (event_id, event_created_at)
);

-- No foreign key to vote_events: one that references a partitioned table would stop a month's
-- partition being detached or archived (and the W1 partitioning step refuses them). Instead a
-- vote event that is deleted takes its evidence with it, and the vote path only ever writes
-- evidence for an event it has just written in the same transaction.
create or replace function vote_evidence_follow_delete() returns trigger
language plpgsql as $$
begin
  delete from vote_evidence where event_id = old.id and event_created_at = old.created_at;
  return old;
end $$;

create trigger vote_events_delete_evidence after delete on vote_events
  for each row execute function vote_evidence_follow_delete();

comment on table vote_evidence is
  'Per-action evidence for wired questions. Person-level: never handed to a buyer. Buyers get day-level totals with small groups hidden (lib/evidence.ts).';
