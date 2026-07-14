# Team Hub — Desktop Dashboard Overhaul

_Date: 2026-07-13 · Status: approved (Marco picked the hybrid layout; "just build it")_

## Problem

MemBridge is a team collaboration tool, but the dashboard's Team tab is account
and link plumbing: auth, create/join forms, invite codes, linked-project rows.
You cannot see who is in a team, what projects a team has, or what any member
has been doing. This overhaul makes the Team tab a real collaboration hub.

## Decisions made with Marco

- **Surface:** desktop app dashboard (`lib/dashboard.js`), not the hosted web app.
- **IA:** rich Team hub tab — Overview keeps local projects; the Team tab becomes
  the per-team hub. (Not a full team-first reorganization.)
- **Activity:** woven everywhere — hub feed, per-member activity, per-project activity.
- **Layout:** hybrid ("Option C") — a glanceable one-page hub per team, plus full
  drill-down pages for each member and each team project.
- **Theme:** unchanged. Same design system (cards, buttons, accent gradient). This
  is a content/IA overhaul, not a restyle.

## Navigation

- `#team` — hub for the currently selected team. Multi-team users get a switcher
  dropdown in the hub header (selection persisted in localStorage); the dropdown
  also holds "+ New team" and "Join with invite", removing those forms from the page.
- `#team-member=<teamId>/<userId>` — member page.
- `#team-project=<teamId>/<projectId>` — team project page.
- Same hash-routing idiom as `#project=`: browser-back exits, Team tab stays lit
  on all three routes.
- Signed out → existing auth view, unchanged. Signed in with no team → empty
  state with "Create a team" and "Join with invite" actions.
- The oversized team hero is replaced by a compact header: team name/switcher,
  role badge, member count, **Invite** and **Team settings** actions.

## Pages

### Team hub (`#team`)

- **Header:** name/switcher · role badge · member count · Invite · Team settings · Sync now.
- **Main column — activity feed:** `team_feed` RPC, grouped by day. Each entry:
  author avatar + name, tool badge, project chip, ask text, expandable files,
  relative time. Filter chips (member / project / tool) filter in place.
  "Load more" uses keyset pagination (`p_before_created_at`/`p_before_id`).
- **Side column — Members card:** avatar, display name, role, last active
  (derived from feed data); click → member page.
- **Side column — Projects card:** team projects from the `project_stats` view —
  name, contributor count, last activity; locally-linked projects show a chip.
  Click → team project page. Card footer: "Share a local project…" (the existing
  link flow, relocated). Auto-link suggestions appear as a banner above the feed.

### Member page (`#team-member=`)

- Header: avatar, display name, role, joined date. Owners/admins get a role
  dropdown and Remove-from-team (never on the owner); your own row gets
  "Leave team" instead.
- **Their projects:** aggregated client-side from their recent feed entries
  (`team_feed` with `p_author`, up to 200) — project name, recent entry count,
  last activity. Labeled "recent" to stay honest about the window.
- **Their recent work:** the same filtered feed rendered as a timeline, Load more.

### Team project page (`#team-project=`)

- Header: project name, repo URL, contributor count, last activity
  (`project_stats`). If linked to a local folder: chip linking to the local
  `#project=` page, plus Unlink. If not linked locally: "Link a local folder" action.
- **Contributors:** aggregated client-side from the project's recent feed entries
  (`team_feed` with `p_project`) — member, recent entry count, last entry.
- **Activity:** the project-filtered feed, Load more.

### Invite panel (from hub header)

Create invite links with optional expiry (days) and max uses — the schema v2
`create_invite` already supports both (closes parity-plan features 4 and 5).
Copy link, revoke a link, and the legacy UUID code for owners.

### Team settings panel (from hub header)

Rename team (owner/admin), leave team, and — for owners — rotate the legacy
invite code. Destructive actions confirm first.

## Backend

**No schema changes.** Everything runs on schema v2 RPCs that already exist:
`my_teams`, `team_members_list`, `team_feed`, `project_stats`, `create_invite`,
`revoke_invite`, `rotate_invite`, `remove_member`, `set_role`, `rename_team`,
`leave_team`.

### New `lib/teamsync.js` wrappers

`listMembers`, `teamFeed`, `projectStats`, `removeMember`, `setRole`,
`renameTeam`, `leaveTeam` — thin `rpc()`/`rest()` calls following the existing
style (auth check, one call, return rows).

### New/changed `lib/server.js` routes

| Route | Method | Purpose |
|---|---|---|
| `/api/team/members?teamId=` | GET | `team_members_list` |
| `/api/team/feed?teamId=&author=&project=&source=&beforeCreatedAt=&beforeId=` | GET | `team_feed` |
| `/api/team/projects?teamId=` | GET | `project_stats` + local link info |
| `/api/team/remove-member` | POST | `remove_member` |
| `/api/team/set-role` | POST | `set_role` |
| `/api/team/rename` | POST | `rename_team` |
| `/api/team/leave` | POST | `leave_team` |
| `/api/team/revoke-invite` | POST | `revoke_invite` |
| `/api/team/invite` | POST | gains `expiresDays`, `maxUses` |

All follow the existing pattern: validate input, call teamsync, return JSON,
credentials never reach the browser.

### UI code layout

Team hub UI moves to a new `lib/dashboard-team.js` (HTML + client JS fragment)
that `lib/dashboard.js` composes in — keeps the main file from growing past
~2000 lines and gives team code a focused home.

## Error handling & empty states

- Unreachable backend → friendly error card with Retry; never blocks the rest
  of the dashboard.
- Solo team → members card shows an invite CTA; empty feed explains that
  activity appears after teammates' tools sync.
- All member/project aggregations are windowed ("recent") — no pretense of
  all-time stats without a server-side aggregate.

## Testing

Extend the existing offline mock-Supabase suite (`test/run-tests.js`):
- wrapper tests for each new teamsync function (RPC name + args + auth guard);
- route tests for each new/changed endpoint (success, validation error,
  signed-out);
- invite route passes `expiresDays`/`maxUses` through to `create_invite`.

## Out of scope

- Web app (`web/`) parity with this hub — follow-up.
- Server-side all-time per-member stats (would need a new RPC/migration).
- Real-time updates; the feed refreshes on load and on demand.
