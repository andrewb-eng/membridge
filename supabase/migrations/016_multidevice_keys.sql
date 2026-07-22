-- ---------------------------------------------------------------------------
-- 016 — multi-device key recovery: let a member DELETE only their OWN
-- team_keys rows.
--
-- Why: each device holds its own keypair, and a team key is sealed per member
-- pubkey. When a user moves to a NEW device (or their OS key store is reset),
-- the new device generates a fresh keypair — so every existing team-key row
-- sealed to the OLD pubkey is now unopenable on the new device. Nothing
-- re-seals that member while a (dead) row exists: join-seal only targets
-- members with NO row at an epoch, and team_keys_insert is used with
-- ignore-duplicates so the stale row is never overwritten. The member is
-- stuck, and their own encrypted history is unreadable on the new device.
--
-- The client (lib/teamsync.js reconcileTeamKeys) heals this by having the
-- affected member DROP their own unopenable rows, which turns them back into
-- "missing" so a current key-holder re-seals the SAME epoch keys to the new
-- pubkey — recovering full history, not just new content. That delete needs a
-- policy: team_keys has SELECT + INSERT but no DELETE, so RLS denies it today.
--
-- Security: scoped hard to `member_user_id = auth.uid()` — a member can only
-- ever delete rows addressed to THEMSELVES. No member can drop a teammate's
-- row, so this cannot be used to lock anyone out (a DoS). Membership is still
-- required. Re-sealing (the recovery half) rides the existing INSERT policy.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'team_keys'
                   and policyname = 'team_keys_delete_own') then
    create policy team_keys_delete_own on public.team_keys
      for delete using (
        public.is_team_member(team_id)
        and member_user_id = auth.uid()
      );
  end if;
end $$;
