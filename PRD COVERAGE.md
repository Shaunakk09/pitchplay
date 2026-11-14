# PRD coverage: PitchPlay MVP against PRD v3.0

Checked 14 November 2026, updated for the 0.2.0 preview release (see the end of this file). Scope rule used: build P0 (PRD sections 3 to 9). P1 and P2 are
"later" in the PRD (section 2.4) and are not built.

How it was checked:
- 50 automated tests on the domain logic, all passing (`npm test`). Each also checks the
  data invariants of PRD 5.4 after every operation.
- The app was driven in a browser at 1280 px and at 375 by 812 px: create, drag, draw,
  tap-tap drawing, add phase, undo, pinch, views, focus, themes, timing, reorder, export.
- The browser window was hidden during those checks, so anything that needs a visible,
  running animation frame was not watched live. Those items are marked "not watched".

## P0 status by requirement family

| Family | Status | Notes |
| --- | --- | --- |
| CORE | Done | All ten rules enforced in the domain and the editor |
| MOV | Done | MOV-001 to MOV-018, tested |
| DAT | Done | All 26 invariants checked after every operation, on load and on import |
| GEO | Done | 11v11 markings, 9v9, 7v7, 5v5 templates, orientation, labels, metres, three themes |
| RSP | Mostly | RSP-005 is partial: the sheet covers at most 50% but the camera does not pan and there is no "View moved" chip. Phone landscape hides the phase rail instead of collapsing it. Tablets use the same responsive rules, no tablet-specific design |
| INT | Done | State table, arbitration, gesture policy, non-drag alternatives, hit priority, chooser |
| BRD | Done | Library, create, rename, duplicate, delete with 10 s undo, settings, coach marks, storage banner |
| FRM | Done | Presets, apply formation with preview, format change with conversion preview |
| PIT | Done | Full, half, thirds, pinch and wheel zoom, pan, fit, outside-view chip, per-device view memory |
| TFM | Done | Four focus modes, ghost, "Viewing as", "Edit AWAY" |
| PLY | Done | Add, select, drag, move by tap, nudge, quick actions, inspector, lock, duplicate, delete, multi-select, objects panel, roster table |
| BAL | Done | Possession by drop, follow, release, hide, inspector |
| LIN | Done | Five types, linking rules of 4.3, landing markers, handles, static lines, implied lines, limits |
| ZON | Done | Rectangle and ellipse, 8 handles, Shift keeps proportions, inspector, layering |
| TXT | Done | Place, edit, sizes, colors, background, align, plain text only |
| ANN | Done | Delete, erase, clear drawings, layer order |
| PHS | Done | Add, add with drawings, rename, caption, reorder with a preview of line changes, delete, limit, thumbnails |
| TRN | Mostly | Play, pause, previous, next, restart, speed, loop, scrubber, timing lanes with draggable ends, three line modes. TRN-016 is partial: with reduced motion the phases step, without the 200 ms cross-fade. Live playback not watched |
| PRS | Done, not watched | Full screen, overlay that hides after 3 s, keys, basic swipes, wake lock |
| HIS | Done | 100 entries, one per gesture or field commit |
| PST | Done, part untested | Autosave, status, flush on hide, retry, storage banners, versions. The two-tab lock (PST-009, PST-010) and damaged-record recovery (PST-011) are written but were not exercised with two real tabs |
| IMP | Mostly | Entry points, strict validation, summary, open as new, replace, problems list. IMP-002: validation runs on the main thread, not in a worker |
| EXP | Mostly | PNG, storyboard, ZIP, GIF and project file checked. Video: see "Left out on purpose" |
| ACC | Partial | Accessible names, keyboard for every function, focus ring, 44 px targets, announcements, objects panel. No formal WCAG 2.2 AA audit, no screen reader pass |
| SEC | Done | Nothing leaves the device, strict import validation, text never rendered as markup, Content Security Policy |
| ANL | None, as the PRD says | ANL-001: no analytics until D-19 is decided |
| PER | Not measured | Offline after first load works through a service worker (PER-002). The fps, save and export budgets were not measured on the reference devices |

## Left out on purpose

1. **Exact-frame video encoding (EXP-009, first choice of EXP-010).** The video export
   records the animation in real time (the PRD's own fallback path): MP4 where the browser
   can record it, otherwise WebM. A 20 s animation takes about 20 s to export, and the tab
   must stay in front. The faster-than-real-time encoder path needs a hand-written MP4
   writer and was judged too heavy for this pass. Not watched end to end.
2. **Bundled fonts (EXP-018).** The app uses the device's own fonts. No font files ship.
3. **Release criteria of PRD 14.** Device matrix, usability rounds and performance
   measurement are test activities, not code.

## P1 and P2 (not built, by PRD design)

Drill kit, board templates, camera keyframes per phase, freehand lines, polygon zones,
zone rotation, voice-over, pointer in present mode, kit patterns, share links, accounts,
cloud sync, community features.

## Decisions made where the PRD was silent

PRD rule 0.4 says to list these instead of deciding silently. Each one is a small default
that can be changed in one place.

| # | Situation | What the build does | Where |
| --- | --- | --- | --- |
| 1 | A player who holds the ball gets a run (not a carry), then "Add phase" | The ball stays where it was and nobody holds it in the new phase | `ops.ts` addPhase |
| 2 | The same player holds the ball in two phases and no ball line is drawn | In playback the ball stays beside that player instead of sliding in a straight line | `playback.ts` |
| 3 | "Apply formation" to all phases | Players are matched to spots using the current phase, and keep that spot in every phase | `ops.ts` applyFormation |
| 4 | How far a curve bends at bend = 1 | The curve's highest point sits half a line-length off the straight line | `geometry.ts` |
| 5 | Two tokens close together under one tap | No chooser when the tap is clearly inside one token, or one is much nearer | `hit.ts` |
| 6 | The ball is small on a phone | It can be tapped within 22 px when no player is under the finger | `hit.ts` |
| 7 | Carry drawn from a ball nobody holds | A static carry line | `Stage.tsx` |
| 8 | Numbers for players added by a format change | The preset's number when free, otherwise the lowest free number | `ops.ts` |
| 9 | Export with "Caption" on but no captions written | No empty caption strip in the output | `render.ts` |
| 10 | Revision after undo | It keeps counting up, because undo changes the document | `useEditor.ts` |
| 11 | Team and annotation color values, line dash patterns | Placeholder values. PRD 15.4 lists these as design deliverables | `themes.ts`, `draw.ts` |
| 12 | Receiver of a pass is unlinked when the ball is given to someone else in the next phase | The link is dropped so DAT-014 always holds | `ops.ts` sync |

## Known rough edges

- The look was restyled on 14 November 2026 to light and minimal: white chrome, hairline
  borders, black primary buttons, one orange accent for "selected" and "current". All of it
  lives in `src/styles.css`; pitch colors and fonts are in `src/render/themes.ts`.
- On a phone, a text label placed near the touchline can be cut by the pitch edge.
- The preset slots are used as-is on a format change, so a new player can land on top of
  an existing one. They can be dragged apart.

## 0.2.0 preview release (14 November 2026)

Found by driving the built app in a real browser at 1280 by 800, 390 by 844 and 375 by 812
(touch emulated), and fixed:

| # | Problem | Fix |
| --- | --- | --- |
| 1 | On phones the pitch shrank, grew and even flipped between portrait and landscape whenever the tool changed, because the tool options row wrapped to three lines for line tools and disappeared for Select | One fixed-height, single-line, scrollable tool options row for every tool (`Editor.tsx`, `styles.css`) |
| 2 | On phones the pitch shrank and every token moved as soon as something was selected, because the inspector header appeared and took layout space. The next tap then landed on the wrong object: a pass started on the ball became a static line from a player | The collapsed inspector header is always shown on phones and names the phase when nothing is selected (`Editor.tsx`) |
| 3 | Phase rail took a large share of a phone screen | Slimmer phase cards under 600 px (`styles.css`) |
| 4 | Missing favicon caused a 404 on every load | Inline SVG favicon (`index.html`) |
| 5 | Exported file names had double spaces where characters were removed | `safeName` collapses whitespace (`kit.tsx`) |
| 6 | Import summary said "1 zones" | Singular and plural (`ImportDialog.tsx`) |

Added for people trying the preview:

- "See an example" on the empty library (and "Example" in the header): a ready-made 11v11,
  four-phase board with runs, two linked passes, a carry, a zone and captions
  (`src/domain/sample.ts`, covered by a test).
- An "Early preview" note in the library: boards stay in this browser; export to keep a copy.
- A short description under the empty-state headline.
- `src/host.ts` and `npm run build:hosted` for the claude.ai page (see README).

Checked end to end in the browser after the fixes: create, draw run and pass with touch,
receiver chooser, add phase, playback, present mode, PNG, storyboard, GIF, MP4 video and
project file export, import with summary, two-tab lock hand-over, reload persistence, and the
hosted build inside a sandboxed frame. Still not done: measurement on the reference devices
(PER), a screen reader pass, and the PRD 14.3 usability rounds.
