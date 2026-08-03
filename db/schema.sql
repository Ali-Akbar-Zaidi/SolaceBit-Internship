-- =============================================================================
-- Website RAG Chatbot - Supabase / Postgres schema (pgvector)
--
-- Stores knowledge bases for multiple websites so a single chat query can be
-- answered from whichever site actually contains the information.
--
-- Layout:
--   knowledge_bases - one row per indexed website
--   kb_pages        - one row per crawled page
--   kb_chunks       - one row per embedded text chunk (the retrieval unit)
--
-- Embeddings are 768-dimensional (nomic-embed-text). The dimension is fixed in
-- the column type, so switching embedding models requires a migration.
-- =============================================================================

create extension if not exists vector;
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- knowledge_bases
-- -----------------------------------------------------------------------------
create table if not exists public.knowledge_bases (
    id          uuid primary key default gen_random_uuid(),
    site_url    text        not null unique,
    site_title  text        not null,
    origin      text        not null,
    embed_model text        not null,
    page_count  integer     not null default 0,
    chunk_count integer     not null default 0,
    status      text        not null default 'pending'
                  check (status in ('pending', 'indexing', 'ready', 'failed')),
    error       text,
    indexed_at  timestamptz,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

comment on table public.knowledge_bases is
    'One row per indexed website. site_url is the canonical crawl entry point.';

-- -----------------------------------------------------------------------------
-- kb_pages
-- -----------------------------------------------------------------------------
create table if not exists public.kb_pages (
    id           uuid primary key default gen_random_uuid(),
    kb_id        uuid        not null references public.knowledge_bases(id) on delete cascade,
    url          text        not null,
    title        text        not null,
    content_hash text        not null,
    char_count   integer     not null,
    token_count  integer     not null,
    scraped_at   timestamptz not null default now(),
    unique (kb_id, url)
);

create index if not exists kb_pages_kb_id_idx on public.kb_pages (kb_id);

comment on table public.kb_pages is
    'One row per crawled page. content_hash allows skipping re-embedding of unchanged pages.';

-- -----------------------------------------------------------------------------
-- kb_chunks
-- -----------------------------------------------------------------------------
create table if not exists public.kb_chunks (
    id          uuid primary key default gen_random_uuid(),
    kb_id       uuid         not null references public.knowledge_bases(id) on delete cascade,
    page_id     uuid         not null references public.kb_pages(id) on delete cascade,
    chunk_index integer      not null,
    content     text         not null,
    token_count integer      not null,
    embedding   vector(768)  not null,
    created_at  timestamptz  not null default now(),
    unique (page_id, chunk_index)
);

create index if not exists kb_chunks_kb_id_idx   on public.kb_chunks (kb_id);
create index if not exists kb_chunks_page_id_idx on public.kb_chunks (page_id);

-- Approximate nearest-neighbour index for cosine distance. HNSW gives good
-- recall at low latency and, unlike IVFFlat, needs no training data up front.
create index if not exists kb_chunks_embedding_idx
    on public.kb_chunks
    using hnsw (embedding vector_cosine_ops)
    with (m = 16, ef_construction = 64);

comment on table public.kb_chunks is
    'Embedded text chunks - the unit of retrieval. embedding is L2-normalised by the client.';

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists knowledge_bases_touch on public.knowledge_bases;
create trigger knowledge_bases_touch
    before update on public.knowledge_bases
    for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- match_chunks - cosine similarity search across one or all knowledge bases
--
--   query_embedding : the embedded question
--   match_count     : max rows to return
--   min_score       : similarity floor (0..1); rows below this are discarded
--   kb_ids          : null/empty = search every ready knowledge base
--
-- Cosine similarity is 1 - cosine_distance, so the <=> operator drives both the
-- ordering and the score. Returns richest-first.
-- -----------------------------------------------------------------------------
create or replace function public.match_chunks(
    query_embedding vector(768),
    match_count     integer default 6,
    min_score       double precision default 0.55,
    kb_ids          uuid[] default null
)
returns table (
    chunk_id    uuid,
    kb_id       uuid,
    site_title  text,
    site_url    text,
    page_url    text,
    page_title  text,
    content     text,
    token_count integer,
    score       double precision
)
language sql
stable
as $$
    select
        c.id                                        as chunk_id,
        c.kb_id,
        kb.site_title,
        kb.site_url,
        p.url                                       as page_url,
        p.title                                     as page_title,
        c.content,
        c.token_count,
        1 - (c.embedding <=> query_embedding)       as score
    from public.kb_chunks c
    join public.kb_pages        p  on p.id  = c.page_id
    join public.knowledge_bases kb on kb.id = c.kb_id
    where kb.status = 'ready'
      and (kb_ids is null or array_length(kb_ids, 1) is null or c.kb_id = any (kb_ids))
      and 1 - (c.embedding <=> query_embedding) >= min_score
    order by c.embedding <=> query_embedding
    limit match_count;
$$;

comment on function public.match_chunks is
    'Cosine-similarity retrieval over kb_chunks, restricted to knowledge bases in the ready state.';

-- -----------------------------------------------------------------------------
-- Row Level Security
--
-- All application traffic uses the Postgres role via DATABASE_URL, which
-- bypasses RLS. Policies below exist so that anon/authenticated API keys get
-- read-only access and never write.
-- -----------------------------------------------------------------------------
alter table public.knowledge_bases enable row level security;
alter table public.kb_pages        enable row level security;
alter table public.kb_chunks       enable row level security;

drop policy if exists knowledge_bases_read on public.knowledge_bases;
create policy knowledge_bases_read on public.knowledge_bases
    for select to anon, authenticated using (true);

drop policy if exists kb_pages_read on public.kb_pages;
create policy kb_pages_read on public.kb_pages
    for select to anon, authenticated using (true);

drop policy if exists kb_chunks_read on public.kb_chunks;
create policy kb_chunks_read on public.kb_chunks
    for select to anon, authenticated using (true);
