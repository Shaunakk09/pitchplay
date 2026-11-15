# PitchPlay community, publishing and shared playbooks

Shipped on 15 Nov 2026 using the **dedicated PitchPlay Supabase project**. No XChange resources are used.

## Discover

From the playbook, choose **Discover**. Search public tactics by title, description, tag or formation; filter by pitch format and sort by publication date. **View tactic** opens a read-only preview; **Remix** creates a new private, editable board in your own playbook. Signed-in users can bookmark public tactics.

No board is public by default. Discover initially shows an empty state until its owner explicitly publishes a board.

## Sharing and permissions

Open a private, cloud-synced board and choose **Share** (desktop), or **More actions → Share & collaborate** (mobile). The owner can:
- Publish or unpublish a board; set a description and up to five tags.
- Invite teammates by their email address, assigning **Can view** or **Can edit** rights.
- Copy a playbook invitation link or open their email app with a prepared invite.
- Review accepted members, change member rights, revoke access or withdraw invitations.
- Copy a public link after publishing.

An invite is a **real database row**, not an arbitrary share token. The recipient must authenticate using the **same confirmed email** to see the invitation in **My Playbook → Invitations**. On acceptance, the database creates a member record granting exactly the invited rights. An invitation is **not automatically emailed**: the owner must send the invitation link/email. This design avoids exposing server-side email privileges to the browser.

| Permission | Guest/public visitor | Viewer | Editor | Owner |
| --- | --- | --- | --- | --- |
| View published board | Yes | Yes | Yes | Yes |
| View invited private board | No | Yes | Yes | Yes |
| Edit shared tactics | No | No | Yes | Yes |
| Publish/unpublish | No | No | No | Yes |
| Invite, change access, remove members | No | No | No | Yes |
| Read cloud change history | No | Yes | Yes | Yes |
| Restore previous cloud revision | No | No | Yes | Yes |
| Delete the source board | No | No | No | Yes |

A **public board is view-only** for anyone who has not been given editor rights. For public boards, Remix is the way to create an independent editable copy. Public URLs use `#board-<uuid>`.

## Audit and concurrent edits

Every committed cloud edit creates a **server-side revision snapshot** with timestamp, editor email (private to members), action and version number. The latest 100 snapshots are retained per board. Members can inspect history, and editors/owners can restore an older snapshot **as a new revision** rather than erasing the trail.

Cloud writes use an optimistic revision check, which prevents silently overwriting another person's newer save. If two people edit simultaneously and one has already saved, the other must reload/resolve a conflict; **live multi-cursor, Google-Docs-style editing is not supported**. There is no live presence indicator, automated email notification, or public-comment/moderation system yet.

Offline access uses IndexedDB and the most recently cached board/role. After reconnecting, cloud access is revalidated. Revoking access prevents future server reads/writes but cannot erase previously exported files or copies that recipients already stored offline.

## Data access and safeguards

Supabase tables:
- `pitchplay_tactics`: board + explicit publication settings.
- `pitchplay_board_members`: confirmed members and rights.
- `pitchplay_board_invites`: invitations limited to the owner's board and the invited verified email.
- `pitchplay_board_versions`: snapshot history; readable only by owners/members.
- `pitchplay_favorites`: user-specific public bookmarks.

All are protected by **row-level security**, with owner/editor restrictions enforced by policies and triggers. Security-definer helpers are confined to a non-exposed `private` schema with fixed `search_path` and limited execute grants. The browser uses only a public Supabase publishable key, never a secret/service-role key.

### End-to-end acceptance test (still needed before a public launch)

1. Create test users A and B with verified, different emails; keep a third account C uninvited.
2. A creates and privately saves a board. Verify B and C cannot read it.
3. A invites B as a viewer; B sees the pending invite and accepts. B can view but cannot edit or publish.
4. A upgrades B to editor. B edits and saves. A sees B's email/timestamp and can restore an older snapshot.
5. While B edits, A saves a newer version; verify B sees an optimistic concurrency conflict rather than overwriting A's save.
6. A revokes B; verify B can no longer read/write the cloud board.
7. A publishes the board. Signed-out users can view it via Discover and its public link, but cannot edit; signed-in users can bookmark and remix.
8. A unpublishes; verify a fresh signed-out user can no longer read it.
9. Test on iPhone and Android, in the installed PWA, including returning after the device was offline.
10. Verify the production domain is **public** in Vercel's Deployment Protection settings; a successful Vercel build alone does not prove public access.

Note: Database schema/RLS and the Vercel source build have been verified, but this complete multi-account exercise has not been run.
