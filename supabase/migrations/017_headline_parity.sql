-- Wire parity (teammate sees the author's quality): the card headline now
-- crosses team sync. On E2E teams (encrypt on, the default) it rides INSIDE
-- the ciphertext and needs no backend change — this migration is for the
-- explicit encrypt:false hatch, where content lives in plaintext columns:
--   1. memory_entries gains a nullable `headline` text column (dual-written
--      by push; null under the ciphertext-only cutover like every content
--      column).
--   2. team_feed returns it so the desktop feed can render the author's
--      verbatim glance line instead of deriving a truncated title from the
--      summary's first sentence.
--
-- Clients degrade gracefully without this migration: push drops the column
-- on PGRST204 and retries, pull drops it from select= and retries. Numbered
-- 017 — 015 (feedback) and 016 (multidevice keys) are taken.
--
-- ⚠ Deploy gate — same discipline as 009/013/014: apply to the LIVE Supabase
-- before expecting plaintext-hatch teams to carry headlines. Every statement
-- is re-runnable. Run in the Supabase SQL editor (one transaction) or
-- `supabase db push`; with psql, use `psql -1 -f`.

-- ---------------------------------------------------------------------------
-- 1. memory_entries.headline — additive, nullable.
-- ---------------------------------------------------------------------------
alter table public.memory_entries
  add column if not exists headline text;

-- ---------------------------------------------------------------------------
-- 2. team_feed: drop + recreate to add `headline` to the return row (Postgres
-- refuses to change a function's OUT row type in place — same dance as
-- 013/014).
-- ---------------------------------------------------------------------------
drop function if exists public.team_feed(
  uuid, timestamptz, bigint, integer, uuid, uuid, text, timestamptz, timestamptz);

create or replace function public.team_feed(
  p_team uuid,
  p_before_created_at timestamptz default null,
  p_before_id bigint default null,
  p_limit integer default 50,
  p_author uuid default null,
  p_project uuid default null,
  p_source text default null,
  p_since timestamptz default null,
  p_until timestamptz default null
)
returns table (
  id bigint, project_id uuid, project_name text,
  author_id uuid, author_name text,
  ts timestamptz, source text, ask text, summary text, files jsonb, created_at timestamptz,
  goal text, decisions text, gotchas text, changes jsonb,
  session text, ciphertext text, nonce text, key_epoch integer,
  distilled boolean, headline text
)
language sql
security definer
set search_path = public
stable
as $$
  select e.id, e.project_id, p.name, e.author_id, e.author_name,
         e.ts, e.source, e.ask, e.summary, e.files, e.created_at,
         e.goal, e.decisions, e.gotchas, e.changes,
         e.session, e.ciphertext, e.nonce, e.key_epoch,
         e.distilled, e.headline
  from public.memory_entries e
  join public.projects p on p.id = e.project_id
  where p.team_id = p_team
    and p.archived_at is null
    and public.is_team_member(p_team)
    and (p_before_created_at is null
         or (e.created_at, e.id) < (p_before_created_at, p_before_id))
    and (p_author is null or e.author_id = p_author)
    and (p_project is null or e.project_id = p_project)
    and (p_source is null or e.source = p_source)
    and (p_since is null or e.ts >= p_since)
    and (p_until is null or e.ts <= p_until)
  order by e.created_at desc, e.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;
