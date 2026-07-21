-- 012_memory_entries_update.sql
--
-- Per-session prompt sharing lets a user retroactively backfill or scrub the
-- verbatim prompt on already-synced rows. reshareSession does this by re-pushing
-- the session's rows with PostgREST `resolution=merge-duplicates`, which compiles
-- to `INSERT ... ON CONFLICT (...) DO UPDATE`. Postgres applies the table's
-- UPDATE RLS policy to that DO-UPDATE branch — and memory_entries had only
-- SELECT and INSERT policies, so the update was silently blocked and the row
-- kept its original (un-scrubbed) prompt. Add an UPDATE policy scoped exactly
-- like the insert policy: an author may update only their own rows, and only
-- within a team they belong to.
--
-- Without this migration on the live backend, "Hide from team" / "Share" toggles
-- appear to work in the UI but never change what teammates already pulled.

create policy memory_entries_update on public.memory_entries
  for update
  using (
    author_id = auth.uid()
    and public.is_team_member((select team_id from public.projects where id = project_id))
  )
  with check (
    author_id = auth.uid()
    and public.is_team_member((select team_id from public.projects where id = project_id))
  );
