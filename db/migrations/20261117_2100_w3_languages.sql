-- W3, languages: who may review translations, and an optional store for meaning-based search.

-- ---------- Translators ----------
-- Moderators and admins can review every language. Anyone else can be given one language (or
-- '*' for all) here. This is a grant table rather than a new accounts.role value on purpose: the
-- moderation pages let in every role that isn't 'user', and a translator must not get those.
create table translator_grants (
  account_id  integer not null references accounts(id) on delete cascade,
  lang        text not null check (lang = '*' or lang ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  granted_by  integer references accounts(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (account_id, lang)
);

-- The approved list for a language, newest review first (the "Approved" tab of /translate).
create index question_translations_approved on question_translations (lang, reviewed_at desc) where status = 'approved';

-- ---------- Meaning-based search (off unless EMBEDDINGS_URL is set) ----------
-- One vector per question per language per model: the canonical text, and each approved
-- translation. Kept as a plain real[] so no extension is needed. Nearest-neighbour search is a
-- scan with cm_cosine(), which is fine for a few hundred thousand rows; when the catalog
-- outgrows that, move this column to pgvector and an HNSW index without changing callers.
create table question_embeddings (
  question_id integer not null references questions(id) on delete cascade,
  lang        text not null,
  model       text not null,
  embedding   real[] not null,
  source_text text not null,
  updated_at  timestamptz not null default now(),
  primary key (question_id, lang, model)
);
create index question_embeddings_model on question_embeddings (model);

create function cm_cosine(a real[], b real[]) returns double precision
language sql immutable strict parallel safe as $$
  select case when sqrt(sum(x * x)) = 0 or sqrt(sum(y * y)) = 0 then 0
              else sum(x * y) / (sqrt(sum(x * x)) * sqrt(sum(y * y))) end
    from unnest(a, b) as v(x, y)
$$;
