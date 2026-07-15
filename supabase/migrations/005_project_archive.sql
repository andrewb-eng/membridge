-- Project soft-delete: owners/admins can archive a shared project for the whole
-- team (reversible), hiding it from the unified feed and the projects lists
-- without destroying its history. Mirrors 002_team_v2.sql's security-definer +
-- is_team_manager() gate style. Additive/idempotent; run in the Supabase SQL
-- editor or `supabase db push`. Depends on 002 (is_team_manager) and 004
-- (the summary-carrying team_feed signature dropped+recreated below).

alter table public.projects add column if not exists archived_at timestamptz;
alter table public.projects
  add column if not exists archived_by uuid references auth.users (id);

-- Archive: manager-gated soft delete. The RPC — not RLS — is the real
-- authorization boundary, so a plain member calling it directly is refused.
create or replace function public.archive_project(p_project uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team uuid;
begin
  select team_id into v_team from public.projects where id = p_project;
  if v_team is null then
    raise exception 'unknown project';
  end if;
  if not public.is_team_manager(v_team) then
    raise exception 'only a team owner or admin can delete a project for the team';
  end if;
  update public.projects
    set archived_at = now(), archived_by = auth.uid()
    where id = p_project;
end;
$$;

-- Unarchive: the same manager gate; restores the project everywhere.
create or replace function public.unarchive_project(p_project uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team uuid;
begin
  select team_id into v_team from public.projects where id = p_project;
  if v_team is null then
    raise exception 'unknown project';
  end if;
  if not public.is_team_manager(v_team) then
    raise exception 'only a team owner or admin can restore a project';
  end if;
  update public.projects
    set archived_at = null, archived_by = null
    where id = p_project;
end;
$$;

-- team_feed must skip archived projects. Postgres refuses to change a
-- function's RETURNS TABLE via create-or-replace, so DROP+recreate the
-- 9-arg signature (unchanged since 004), adding `and p.archived_at is null`.
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
  ts timestamptz, source text, ask text, summary text, files jsonb, created_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select e.id, e.project_id, p.name, e.author_id, e.author_name,
         e.ts, e.source, e.ask, e.summary, e.files, e.created_at
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

-- project_stats view (source for teamProjectsPayload): exclude archived. Column
-- set is identical to 002's, so create-or-replace is enough — no drop needed.
create or replace view public.project_stats
with (security_invoker = on) as
  select p.id as project_id, p.team_id, p.name, p.repo_url,
         max(e.ts) as last_activity,
         count(distinct e.author_id) as contributors,
         count(e.id) as entries
  from public.projects p
  left join public.memory_entries e on e.project_id = p.id
  where p.archived_at is null
  group by p.id;
