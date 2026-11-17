-- W1: partition vote_events by month on created_at (UTC months).
--
-- vote_events is the append-only history and the largest table. Monthly range partitions keep
-- each month's rows and indexes together, let "today" and "as of" reads skip old months, and
-- let a month be detached or archived later without touching the rest.
--
-- The existing table is copied into the new partitioned table inside this migration's single
-- transaction, under an exclusive lock, and the copy is counted before the old table is
-- dropped. Every column, default, check constraint, foreign key and index is carried over from
-- the table as it stands (read from the catalog, so a column or index added before this runs
-- is kept too). The primary key becomes (id, created_at), because a partitioned table's keys
-- must include the partition key; ids still come from one identity sequence and stay unique.
--
-- A default partition catches any row whose month has no partition yet, so an insert never
-- fails. vote_events_ensure_partitions() creates months ahead of time; the job queue runs it
-- daily (lib/jobs/handlers.ts), and vote_events_ensure_partition() moves any rows that landed
-- in the default partition into their month when that month is created.

-- ---------- Creating one month ----------
-- Creates the partition for the UTC month containing p_month, if it doesn't exist yet. The
-- table is created on its own and then attached, which takes a lighter lock on vote_events than
-- CREATE TABLE ... PARTITION OF. Rows for that month already sitting in the default partition
-- are moved in first, so the attach can't fail on them. Returns true if it created one.
create or replace function vote_events_ensure_partition(p_month date) returns boolean
language plpgsql as $$
declare
  m     date        := date_trunc('month', p_month)::date;
  lo    timestamptz := m::timestamp at time zone 'UTC';
  hi    timestamptz := (m + interval '1 month')::timestamp at time zone 'UTC';
  part  text        := format('vote_events_p%s', to_char(m, 'YYYY_MM'));
  cols  text;
begin
  if to_regclass(format('public.%I', part)) is not null then
    return false;
  end if;
  -- One creator at a time; check again once we hold the lock.
  perform pg_advisory_xact_lock(hashtext('vote_events_partitions'));
  if to_regclass(format('public.%I', part)) is not null then
    return false;
  end if;

  execute format('create table public.%I (like public.vote_events including defaults including constraints including storage)', part);

  if to_regclass('public.vote_events_default') is not null then
    -- Hold inserts into the default partition while its rows for this month move over.
    lock table public.vote_events_default in access exclusive mode;
    select string_agg(quote_ident(attname), ', ' order by attnum) into cols
      from pg_attribute
     where attrelid = 'public.vote_events'::regclass and attnum > 0 and not attisdropped;
    execute format(
      'with moved as (delete from public.vote_events_default where created_at >= %L and created_at < %L returning %s)
       insert into public.%I (%s) select %s from moved',
      lo, hi, cols, part, cols, cols);
  end if;

  execute format('alter table public.vote_events attach partition public.%I for values from (%L) to (%L)', part, lo, hi);
  return true;
end $$;

-- Creates this month and the next p_ahead months. Safe to run any number of times.
create or replace function vote_events_ensure_partitions(p_ahead integer default 3) returns integer
language plpgsql as $$
declare
  this_month date := date_trunc('month', now() at time zone 'UTC')::date;
  created integer := 0;
begin
  for i in 0..greatest(p_ahead, 0) loop
    if vote_events_ensure_partition((this_month + make_interval(months => i))::date) then
      created := created + 1;
    end if;
  end loop;
  return created;
end $$;

-- ---------- Moving the existing table ----------
do $$
declare
  old_rel   regclass;
  old_seq   text;
  old_last  bigint := 0;
  r         record;
  cols      text;
  n_old     bigint;
  n_new     bigint;
  next_id   bigint;
begin
  if exists (select 1 from pg_partitioned_table where partrelid = 'public.vote_events'::regclass) then
    raise notice 'vote_events is already partitioned';
    return;
  end if;

  lock table public.vote_events in access exclusive mode;

  -- Anything this migration can't carry over is refused rather than dropped.
  if exists (select 1 from pg_trigger where tgrelid = 'public.vote_events'::regclass and not tgisinternal) then
    raise exception 'vote_events has triggers; carry them over before partitioning';
  end if;
  if exists (select 1 from pg_depend d join pg_rewrite w on w.oid = d.objid
              where d.refobjid = 'public.vote_events'::regclass and d.classid = 'pg_rewrite'::regclass
                and w.ev_class <> 'public.vote_events'::regclass) then
    raise exception 'views depend on vote_events; recreate them after partitioning';
  end if;
  if exists (select 1 from pg_constraint where confrelid = 'public.vote_events'::regclass) then
    raise exception 'foreign keys reference vote_events; they need (id, created_at)';
  end if;
  if exists (select 1 from pg_index i where i.indrelid = 'public.vote_events'::regclass
                and i.indisunique and not i.indisprimary) then
    raise exception 'vote_events has a unique index other than its primary key';
  end if;

  -- Step the old table and its sequence and indexes out of the way.
  old_seq := pg_get_serial_sequence('public.vote_events', 'id');
  alter table public.vote_events rename to vote_events_unpartitioned;
  old_rel := 'public.vote_events_unpartitioned'::regclass;
  if old_seq is not null then
    execute format('select last_value from %s', old_seq) into old_last;
    execute format('alter sequence %s rename to vote_events_unpartitioned_id_seq', old_seq);
  end if;

  create temporary table w1_old_indexes on commit drop as
    select c.relname as name, pg_get_indexdef(i.indexrelid) as def
      from pg_index i join pg_class c on c.oid = i.indexrelid
     where i.indrelid = old_rel and not i.indisprimary;
  for r in select name from w1_old_indexes loop
    execute format('alter index public.%I rename to %I', r.name, left('w1old_' || r.name, 63));
  end loop;
  alter index public.vote_events_pkey rename to vote_events_unpartitioned_pkey;

  -- The new table: same columns, defaults, identity, check constraints and storage.
  create table public.vote_events (
    like public.vote_events_unpartitioned including defaults including identity including constraints
      including storage including comments including generated including statistics,
    constraint vote_events_pkey primary key (id, created_at)
  ) partition by range (created_at);

  -- Foreign keys, under their own names.
  for r in select conname, pg_get_constraintdef(oid) as def from pg_constraint
            where conrelid = old_rel and contype = 'f' order by conname loop
    execute format('alter table public.vote_events add constraint %I %s', r.conname, r.def);
  end loop;

  -- Indexes, under their own names, on the partitioned table (every partition gets them).
  for r in select name, def from w1_old_indexes loop
    -- The definitions were read before the rename, so they carry the original index names.
    execute replace(r.def, ' ON public.vote_events_unpartitioned ', ' ON public.vote_events ');
  end loop;

  -- One partition per month that has rows, plus this month and the next three.
  for r in select distinct date_trunc('month', created_at at time zone 'UTC')::date as m
             from public.vote_events_unpartitioned loop
    perform vote_events_ensure_partition(r.m);
  end loop;
  perform vote_events_ensure_partitions(3);
  create table public.vote_events_default partition of public.vote_events default;

  -- Copy every row with its own id, then check nothing was lost.
  select string_agg(quote_ident(attname), ', ' order by attnum) into cols
    from pg_attribute where attrelid = old_rel and attnum > 0 and not attisdropped;
  execute format('insert into public.vote_events (%s) overriding system value select %s from public.vote_events_unpartitioned', cols, cols);

  select count(*) into n_old from public.vote_events_unpartitioned;
  select count(*) into n_new from public.vote_events;
  if n_old <> n_new then
    raise exception 'vote_events copy lost rows: % before, % after', n_old, n_new;
  end if;

  -- New ids continue after the highest id ever handed out.
  select greatest(coalesce((select max(id) from public.vote_events), 0), old_last) + 1 into next_id;
  perform setval(pg_get_serial_sequence('public.vote_events', 'id'), next_id, false);

  drop table public.vote_events_unpartitioned;
end $$;
