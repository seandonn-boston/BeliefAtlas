-- W1: what the job queue (lib/jobs) and its first two handlers need.

-- A recurring job checks that one of its kind is already waiting before it queues another.
create index jobs_pending_kind on jobs (kind, run_at) where done_at is null;

-- Jobs that ran out of attempts, for an operator to look at. They stay in the table with their
-- last error and are never claimed again.
create index jobs_dead on jobs (kind, created_at) where done_at is null and attempts >= max_attempts;

-- ---------- Daily rollup per question ----------
-- Written by the stats.rollup job from vote_events, one UTC day at a time, and rewritten
-- whenever that day is rolled up again, so it always matches the history (including after an
-- account is deleted). Internal: anything shown from it still goes through the minimum group
-- size like every other stat.
create table question_daily_stats (
  question_id    integer not null references questions(id) on delete cascade,
  day            date not null,
  casts          integer not null default 0,   -- first answers (and re-votes after a delete)
  changes        integer not null default 0,
  deletes        integer not null default 0,
  skips          integer not null default 0,
  answered_true   integer not null default 0,  -- answers given that day (casts and changes) by value
  answered_false  integer not null default 0,
  answered_unsure integer not null default 0,
  voters         integer not null default 0,   -- distinct accounts that cast, changed or deleted
  rolled_up_at   timestamptz not null default now(),
  primary key (question_id, day)
);
create index question_daily_stats_day on question_daily_stats (day);
