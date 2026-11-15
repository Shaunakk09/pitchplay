// Editor screen: layout regions (7.2), tools (7.3), keyboard (8.8), banners and dialogs.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Board } from '../domain/types';
import { NUDGE, NUDGE_SHIFT, PRESENT_HIDE_MS, SNAP_RADIUS_PX, ZOOM_STEP, teamLimit } from '../domain/params';
import * as ops from '../domain/ops';
import { viewLabel, type ViewPreset } from '../domain/labels';
import { panBy, zoomAt, type Focus, type OrientationPref, type ViewState } from '../render/camera';
import { teamMode } from '../render/draw';
import { addVersion, debug, getRawBoard, loadBoard, putBoard, storageAvailable, type LoadResult } from '../store/db';
import { ExportSheet, projectBlob } from './ExportSheet';
import { ImportDialog, pickProjectFile } from './ImportDialog';
import { Inspector, inspectorTitle } from './Inspector';
import { Confirm, Icon, IconButton, Menu, download, safeName, type MenuItem } from './kit';
import { PhaseRail, Playback } from './PhaseRail';
import { FormatDialog, FormationDialog, ObjectsDialog, RosterDialog, SettingsDialog, ShortcutsDialog, VersionsDialog } from './Sheets';
import { Stage } from './Stage';
import { CollaborationDialog } from './Collaboration';
import { fetchCloudBoard } from '../store/community';
import { type BoardAccess } from '../store/cloud';
import { LINE_TYPES, devicePref, isLineTool, setDevicePref, useEditor, type Editor, type Tool } from './useEditor';

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

export function EditorScreen(props: { boardId: string; initial?: Board; cloudAccess?: BoardAccess; onExit: (sessionBoard?: Board) => void; onOpen: (id: string, initial?: Board) => void }) {
  const [state, setState] = useState<{ loaded: LoadResult; available: boolean; access: BoardAccess } | 'missing' | null>(null);
  useEffect(() => {
    let live = true;
    setState(null);
    void (async () => {
      if (props.cloudAccess === 'revoked') { if(live)setState('missing'); return; }
      const available = await storageAvailable();
      // The stored record wins; the in-memory copy is only for browsers without storage.
      const stored = available ? await loadBoard(props.boardId).catch(() => null) : null;
      // Shared and public links work even when this device has never opened the board.
      const remote = !stored && !props.initial
        ? await fetchCloudBoard(props.boardId).catch((e) => { console.warn('Board access unavailable',e); return null; })
        : null;
      const loaded = stored ?? (props.initial ? { board: props.initial, restoredFrom: null, damaged: null }
        : remote ? { board: remote.board, restoredFrom: null, damaged: null } : null);
      const access = remote?.access ?? props.cloudAccess ?? 'owner';
      if (live) setState(loaded ? { loaded, available, access } : 'missing');
    })();
    return () => {
      live = false;
    };
  }, [props.boardId, props.initial]);
  if (state === null) return <div className="center-note">Opening board.</div>;
  if (state === 'missing') {
    return (
      <div className="center-note">
        <p>This board is not stored in this browser.</p>
        <button type="button" className="btn primary" onClick={() => props.onExit()}>
          Back to boards
        </button>
      </div>
    );
  }
  return <EditorInner key={props.boardId} loaded={state.loaded} available={state.available} cloudAccess={state.access} onExit={props.onExit} onOpen={props.onOpen} />;
}

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: 'select', label: 'Select', key: 'V' },
  { tool: 'player', label: 'Player', key: 'P' },
  { tool: 'run', label: 'Run', key: 'R' },
  { tool: 'pass', label: 'Pass', key: 'S' },
  { tool: 'carry', label: 'Carry', key: 'C' },
  { tool: 'shot', label: 'Shot', key: 'X' },
  { tool: 'arrow', label: 'Arrow', key: 'A' },
  { tool: 'zone', label: 'Zone', key: 'Z' },
  { tool: 'text', label: 'Text', key: 'T' },
  { tool: 'erase', label: 'Erase', key: 'E' },
  { tool: 'pan', label: 'Pan', key: 'H' },
];
const KEY_TOOL: Record<string, Tool> = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.tool]));
const STATUS_LABEL: Record<string, string> = { saved: 'Saved', saving: 'Saving', failed: 'Save failed', session: 'Session only', conflict: 'Not saved', readonly: 'Read-only' };

function EditorInner({ loaded, available, cloudAccess, onExit, onOpen }: { loaded: LoadResult; available: boolean; cloudAccess: BoardAccess; onExit: (sessionBoard?: Board) => void; onOpen: (id: string, initial?: Board) => void }) {
  const ed = useEditor(loaded, available, cloudAccess === 'viewer' || cloudAccess === 'revoked');
  const { board, phaseIdx, view, tool, sel } = ed;
  const compact = useMedia('(max-width: 1024px)');
  const spaceHeld = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [confirmLoadLatest, setConfirmLoadLatest] = useState(false);
  const [sheetFull, setSheetFull] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // A collapsed timeline keeps the pitch usable on a phone. The controls remain available.
  const [mobilePhasesOpen, setMobilePhasesOpen] = useState(false);
  const primary = ops.primaryTeam(board);
  const other = ops.otherTeam(board);
  const hasSel = sel.players.length > 0 || sel.ball || !!sel.movementId || !!sel.annotationId;

  // ---------- leaving (BRD-014) ----------
  const leave = useCallback(async () => {
    ed.stop();
    if (ed.saver.dirty) {
      const done = await Promise.race([ed.saver.flush(), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
      if (!done && ed.saver.status === 'failed') return; // stays in the editor with the PST-006 banner
    }
    onExit(available ? undefined : ed.boardRef.current);
  }, [available, ed, onExit]);

  // ---------- view helpers ----------
  const setPreset = (preset: ViewPreset) => ed.setView((v) => ({ ...v, preset, zoom: 1, cx: null, cy: null }), true); // PIT-002
  const zoomBy = (factor: number) => {
    const cam = ed.camRef.current;
    if (cam) ed.setView(zoomAt(ed.viewRef.current, cam, { x: cam.W / 2, y: cam.H / 2 }, cam.zoom * factor), true);
  };
  const fit = () => ed.setView((v) => ({ ...v, zoom: 1, cx: null, cy: null }), true); // PIT-007
  const setFocus = (focus: Focus) => ed.setView((v) => ({ ...v, focus })); // TFM-008: the camera does not move
  const eligible = (playerId: string) => {
    const p = ops.playerById(ed.boardRef.current, playerId);
    return !!p && teamMode(ed.boardRef.current, ed.viewRef.current.focus, p.teamId) === 'show';
  };

  // ---------- present mode (PRS) ----------
  const [presentUi, setPresentUi] = useState(true);
  const [presentCaptions, setPresentCaptions] = useState(true);
  const [presentWhole, setPresentWhole] = useState(false);
  const viewBeforePresent = useRef<ViewState | null>(null);
  const wake = useRef<{ release: () => Promise<void> } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pokePresent = useCallback(() => {
    setPresentUi(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setPresentUi(false), PRESENT_HIDE_MS); // PARAM-37
  }, []);
  const startPresent = () => {
    ed.gestureRef.current.cancel();
    ed.clearSel();
    ed.setMenu(null);
    viewBeforePresent.current = ed.viewRef.current;
    setPresentWhole(false);
    ed.setPresenting(true);
    pokePresent();
    void rootRef.current?.requestFullscreen?.().catch(() => undefined); // PRS-001
    void (navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock
      ?.request('screen')
      .then((w) => (wake.current = w))
      .catch(() => undefined); // PRS-005
  };
  const endPresent = useCallback(() => {
    if (ed.cursor !== null) ed.nearestPhase(); // PRS-004: the last presented phase stays selected
    ed.setPresenting(false);
    if (viewBeforePresent.current) ed.setView(viewBeforePresent.current);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    void wake.current?.release().catch(() => undefined);
    wake.current = null;
  }, [ed]);
  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement && ed.presenting && rootRef.current?.dataset.fs === '1') endPresent();
      if (rootRef.current) rootRef.current.dataset.fs = document.fullscreenElement ? '1' : '0';
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, [ed.presenting, endPresent]);
  const togglePresentWhole = (on: boolean) => {
    setPresentWhole(on);
    ed.setView(on ? { ...ed.viewRef.current, preset: 'full', zoom: 1, cx: null, cy: null } : (viewBeforePresent.current ?? ed.viewRef.current));
  };

  // ---------- keyboard (8.8) ----------
  const nudge = useRef<{ base: Board; dx: number; dy: number; last: Board | null } | null>(null);
  useEffect(() => {
    const isText = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (ed.dialog || ed.menu || ed.textEdit || importFile || confirmLoadLatest) return; // INT-004: a modal comes first
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (ed.presenting) {
        pokePresent();
        if (key === ' ' || key === 'k') (e.preventDefault(), ed.playing ? ed.pause() : ed.play());
        else if (key === 'ArrowRight' || key === 'ArrowDown') ed.setPhase(ed.phaseRef.current + 1);
        else if (key === 'ArrowLeft' || key === 'ArrowUp') ed.setPhase(ed.phaseRef.current - 1);
        else if (key === 'Escape') endPresent();
        return;
      }
      if (isText(e.target)) return;
      // J-09: inside the toolbar, arrow keys move between tools instead of nudging.
      if (key.startsWith('Arrow') && e.target instanceof HTMLElement && e.target.closest('[role="toolbar"]')) {
        const items = [...e.target.closest('[role="toolbar"]')!.querySelectorAll<HTMLElement>('button:not(:disabled)')];
        const at = items.indexOf(e.target as HTMLElement);
        const step = key === 'ArrowDown' || key === 'ArrowRight' ? 1 : -1;
        items[(at + step + items.length) % items.length]?.focus();
        e.preventDefault();
        return;
      }
      if (key === 'Escape') {
        // INT-008: cancel the active draft or gesture; else clear the selection.
        if (!ed.gestureRef.current.cancel()) ed.clearSel();
        return;
      }
      if (key === ' ') {
        if (!(e.target instanceof HTMLButtonElement)) {
          spaceHeld.current = true;
          e.preventDefault();
        }
        return;
      }
      if (mod && key === 'z') return void (e.preventDefault(), e.shiftKey ? ed.redo() : ed.undo());
      if (mod && key === 'y') return void (e.preventDefault(), ed.redo());
      if (mod && key === 'Enter') return void (e.preventDefault(), ed.addPhase(false));
      if (mod && key === 'a') {
        e.preventDefault();
        const b = ed.boardRef.current;
        ed.setSel({ players: b.roster.filter((p) => eligible(p.id)).map((p) => p.id), ball: true, movementId: null, annotationId: null });
        return;
      }
      if (mod && key === 'd') {
        e.preventDefault();
        const id = ed.selRef.current.players[0];
        const r = id ? ops.duplicatePlayer(ed.boardRef.current, id) : null;
        if (r && ed.commit(r.board, 'duplicate player')) ed.selectRef({ kind: 'player', id: r.playerId });
        return;
      }
      if (mod || e.altKey) return;
      if (key.startsWith('Arrow')) {
        const s = ed.selRef.current;
        const cam = ed.camRef.current;
        if (!cam || ed.locked || ed.readOnly) return;
        const step = e.shiftKey ? NUDGE_SHIFT : NUDGE; // PARAM-14
        const sx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
        const sy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
        const dx = cam.portrait ? -sy : sx;
        const dy = cam.portrait ? sx : sy;
        const n = nudge.current ?? { base: ed.boardRef.current, dx: 0, dy: 0, last: null };
        const i = ed.phaseRef.current;
        let next: Board | null = null;
        if (s.players.length || s.ball) {
          const lockedOne = s.players.map((id) => ops.playerById(n.base, id)).find((p) => p?.locked);
          if (lockedOne) return void ed.toast(`#${lockedOne.number} is locked. Unlock to move it or draw its runs.`);
          next = ops.moveSelection(n.base, i, s, n.dx + dx, n.dy + dy, { snapU: SNAP_RADIUS_PX / cam.s, eligible });
        } else if (s.annotationId) next = ops.moveAnnotation(n.base, i, s.annotationId, n.dx + dx, n.dy + dy);
        else return;
        e.preventDefault();
        if (next) {
          n.dx += dx;
          n.dy += dy;
          n.last = next;
        }
        nudge.current = n;
        ed.setPreview(n.last);
        return;
      }
      if (key === 'Delete' || key === 'Backspace') return void (e.preventDefault(), ed.locked ? ed.toast('Pause to edit.') : ed.deleteSelection());
      if (key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        const s = ed.selRef.current;
        const a = s.annotationId ? ed.boardRef.current.phases[ed.phaseRef.current].annotations.find((x) => x.id === s.annotationId) : null;
        if (a?.kind === 'text') ed.setTextEdit({ id: a.id, at: { x: a.x, y: a.y }, text: a.text });
        else ed.setInspectorOpen(true);
        return;
      }
      if (key === 'k') return void (ed.playing ? ed.pause() : ed.play());
      if (key === '[') return ed.setPhase(ed.phaseRef.current - 1);
      if (key === ']') return ed.setPhase(ed.phaseRef.current + 1);
      if (key === '0') return fit();
      if (key === '+' || key === '=') return zoomBy(ZOOM_STEP);
      if (key === '-') return zoomBy(1 / ZOOM_STEP);
      if (key === 'f') return startPresent();
      if (key === '?') return ed.setDialog({ kind: 'shortcuts' });
      if (KEY_TOOL[key] && !ed.readOnly) ed.setTool(KEY_TOOL[key]);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') spaceHeld.current = false;
      if (e.key.startsWith('Arrow') && nudge.current) {
        // PLY-012: one transaction per key hold, committed on key up.
        const n = nudge.current;
        nudge.current = null;
        ed.setPreview(null);
        if (n.last) ed.commit(n.last, 'nudge selection');
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  });

  // ---------- menus ----------
  const menuAt = (el: HTMLElement, items: MenuItem[], title?: string) => {
    const r = el.getBoundingClientRect();
    ed.setMenu({ x: r.left, y: r.bottom + 4, items, title });
  };
  const exportProject = async () => {
    const out = await download(projectBlob(ed.boardRef.current), `${safeName(ed.boardRef.current.title)}.pitchplay`);
    if (out === 'unavailable') ed.toast('Saving files is not available in this view. Open PitchPlay in its own tab to download.');
  };
  const openOverflow = (el: HTMLElement) =>
    menuAt(el, [
      ...(compact
        ? [
            { label: 'Present', run: startPresent },
            { label: 'Export', run: () => ed.setDialog({ kind: 'export' }) },
          ]
        : []),
      { label: 'Share & collaborate', run: () => setShareOpen(true) },
      { label: 'Board settings', run: () => ed.setDialog({ kind: 'settings' }) },
      { label: 'Apply formation', run: () => ed.setDialog({ kind: 'formation' }), disabled: !!ed.readOnly },
      { label: 'Objects', run: () => ed.setDialog({ kind: 'objects' }) },
      { label: 'Version history', run: () => ed.setDialog({ kind: 'versions' }) },
      { label: 'Import', run: () => pickProjectFile(setImportFile) },
      { label: 'Export project file', run: exportProject },
      { label: 'Keyboard shortcuts', run: () => ed.setDialog({ kind: 'shortcuts' }) },
      { label: 'Show tips again', run: () => (setDevicePref('coach', 0), setCoach(0)) },
    ]);
  const openViewMenu = (el: HTMLElement) => {
    const cam = ed.camRef.current;
    const pan = (dx: number, dy: number) => cam && ed.setView(panBy(ed.viewRef.current, cam, dx, dy));
    const orient = (o: OrientationPref) => ed.setView((v) => ({ ...v, orientation: o }), true); // GEO-008
    menuAt(
      el,
      [
        { label: `${view.orientation === 'auto' ? '● ' : ''}Orientation: Auto`, run: () => orient('auto') },
        { label: `${view.orientation === 'landscape' ? '● ' : ''}Orientation: Landscape`, run: () => orient('landscape') },
        { label: `${view.orientation === 'portrait' ? '● ' : ''}Orientation: Portrait`, run: () => orient('portrait') },
        { label: view.showLines ? 'Hide lines' : 'Show lines', run: () => ed.setView((v) => ({ ...v, showLines: !v.showLines })) }, // LIN-013
        { label: 'Zoom in', run: () => zoomBy(ZOOM_STEP) },
        { label: 'Zoom out', run: () => zoomBy(1 / ZOOM_STEP) },
        { label: 'Fit', run: fit },
        { label: 'Pan left', run: () => pan(120, 0), disabled: view.zoom <= 1 }, // INT-009f
        { label: 'Pan right', run: () => pan(-120, 0), disabled: view.zoom <= 1 },
        { label: 'Pan up', run: () => pan(0, 120), disabled: view.zoom <= 1 },
        { label: 'Pan down', run: () => pan(0, -120), disabled: view.zoom <= 1 },
      ],
      'View',
    );
  };

  // ---------- coach marks (BRD-015) ----------
  const [coach, setCoach] = useState<number>(() => devicePref('coach', 0));
  const COACH = ['Drag a player to move it.', 'Pick Run, then drag from a player to draw where it goes.', 'Add a phase. Players land where their lines end.', 'Press Play to watch the sequence.'];
  const nextCoach = (n: number) => {
    setCoach(n);
    setDevicePref('coach', n);
  };

  // ---------- text label editor (TXT) ----------
  const commitText = (text: string) => {
    const te = ed.textEdit;
    if (!te) return;
    const b = ed.boardRef.current;
    const i = ed.phaseRef.current;
    ed.setTextEdit(null);
    if (te.id) ed.commit(ops.updateAnnotation(b, i, te.id, { text }), text.trim() ? 'edit label' : 'delete label');
    else if (text.trim()) {
      const a = ops.makeText(te.at, text);
      if (ed.commit(ops.addAnnotation(b, i, a), 'add label')) {
        ed.setSel({ players: [], ball: false, movementId: null, annotationId: a.id });
        ed.setTool('select');
      }
    }
  };

  // ---------- derived UI ----------
  const half = view.preset.startsWith('half');
  const third = view.preset.startsWith('third');
  const zoomLabel = view.zoom > 1.001 ? `${view.zoom.toFixed(1)}x · Fit` : '1x';
  const lineTool = isLineTool(tool);
  const phase = board.phases[phaseIdx];
  const playerTeamFull = ops.teamIsFull(board, ed.playerTeam);
  const statusKey = ed.readOnly ? 'readonly' : ed.status;
  const d = ed.dialog;

  const toolButton = (t: (typeof TOOLS)[number]) => (
    <button key={t.tool} type="button" className="tool" aria-pressed={tool === t.tool} aria-label={`${t.label} tool`} title={`${t.label} (${t.key})`} disabled={!!ed.readOnly && t.tool !== 'select' && t.tool !== 'pan'} onClick={() => ed.setTool(t.tool)}>
      <Icon name={t.tool} />
      <span>{t.label}</span>
    </button>
  );
  const lastLine = devicePref<Tool>('lineType', 'run');
  const dock = (
    <>
      {toolButton(TOOLS[0])}
      {toolButton(TOOLS[1])}
      <button type="button" className="tool" aria-pressed={lineTool} aria-label="Line tool" disabled={!!ed.readOnly} onClick={() => ed.setTool(lineTool ? tool : isLineTool(lastLine) ? lastLine : 'run')}>
        <Icon name={lineTool ? tool : isLineTool(lastLine) ? lastLine : 'run'} />
        <span>{lineTool ? TOOLS.find((x) => x.tool === tool)!.label : 'Line'}</span>
      </button>
      {toolButton(TOOLS[7])}
      {toolButton(TOOLS[8])}
      <button
        type="button"
        className="tool"
        aria-pressed={tool === 'erase' || tool === 'pan'}
        aria-label="More tools"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          ed.setMenu({
            x: r.left,
            y: r.top - 120,
            items: [
              { label: 'Erase', run: () => ed.setTool('erase'), disabled: !!ed.readOnly },
              { label: 'Pan', run: () => ed.setTool('pan') },
            ],
          });
        }}
      >
        <Icon name={tool === 'erase' ? 'erase' : tool === 'pan' ? 'pan' : 'more'} />
        <span>{tool === 'erase' ? 'Erase' : tool === 'pan' ? 'Pan' : 'More'}</span>
      </button>
    </>
  );

  let options: React.ReactNode = null;
  if (ed.moveMode) {
    options = (
      <>
        <span>Tap where it should go.</span>
        <button type="button" className="btn small" onClick={() => ed.setMoveMode(false)}>
          Cancel
        </button>
      </>
    );
  } else if (tool === 'player') {
    options = (
      <>
        <div className="segmented" role="group" aria-label="Team for new players">
          {board.teams.map((t) => (
            <button key={t.id} type="button" aria-pressed={ed.playerTeam === t.id} onClick={() => ed.setPlayerTeam(t.id)}>
              {t.name}
            </button>
          ))}
        </div>
        <label className="inline-check">
          <input type="checkbox" checked={ed.addSeveral} onChange={(e) => ed.setAddSeveral(e.target.checked)} /> Add several
        </label>
        <span className={playerTeamFull ? 'limit' : ''}>
          {playerTeamFull ? `${ops.teamById(board, ed.playerTeam).name} has ${teamLimit(board.format)} players, the limit for ${board.format}.` : 'Tap the pitch to add a player.'}
        </span>
      </>
    );
  } else if (lineTool) {
    const hints: Record<string, string> = {
      run: 'Drag from a player.',
      pass: 'Drag from the ball to a player.',
      carry: 'Drag from the player who has the ball.',
      shot: 'Drag from the ball.',
      arrow: 'Drag anywhere. Arrows never move anything.',
    };
    options = (
      <>
        <div className="segmented" role="group" aria-label="Line type">
          {LINE_TYPES.map((t) => (
            <button key={t} type="button" aria-pressed={tool === t} onClick={() => ed.setTool(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <span className={ops.annotationsFull(board, phaseIdx) && tool === 'arrow' ? 'limit' : ''}>{ops.annotationsFull(board, phaseIdx) && tool === 'arrow' ? 'This phase has 60 drawings, the limit.' : hints[tool]}</span>
      </>
    );
  } else if (tool === 'zone') {
    options = ops.annotationsFull(board, phaseIdx) ? (
      <span className="limit">This phase has 60 drawings, the limit.</span>
    ) : (
      <>
        <div className="segmented" role="group" aria-label="Zone shape">
          <button type="button" aria-pressed={ed.zoneShape === 'rect'} onClick={() => ed.setZoneShape('rect')}>
            Rectangle
          </button>
          <button type="button" aria-pressed={ed.zoneShape === 'ellipse'} onClick={() => ed.setZoneShape('ellipse')}>
            Ellipse
          </button>
        </div>
        <span>Drag to draw a zone.</span>
      </>
    );
  } else if (tool === 'text') options = <span>{ops.annotationsFull(board, phaseIdx) ? 'This phase has 60 drawings, the limit.' : 'Tap the pitch to place a label.'}</span>;
  else if (tool === 'erase') options = <span>Tap a line, zone, label or player to remove it.</span>;
  else if (tool === 'pan') options = <span>Drag to move the view. Pinch or scroll to zoom.</span>;
  else if (view.focus === 'ghost') {
    options = (
      <>
        <span>{other.name} is shown as a ghost and cannot be edited.</span>
        <button type="button" className="btn small" onClick={() => setFocus('both')}>
          Edit {other.name}
        </button>
      </>
    );
  } else if (ed.readOnly) options = <span>Read-only in this tab.</span>;
  else options = <span>{compact ? 'Drag a player to move it. Pick a tool to draw.' : 'Drag players or the ball to move them. Pick a tool on the left to draw runs, passes and zones.'}</span>;

  const banners: React.ReactNode[] = [];
  if (ed.status === 'session')
    banners.push(
      <div key="session" className="banner" role="alert">
        <span>This browser is not keeping boards right now. Export a project file before you close this tab.</span>
        <button type="button" className="btn small" onClick={exportProject}>
          Export project
        </button>
      </div>,
    );
  if (ed.status === 'failed')
    banners.push(
      <div key="failed" className="banner danger" role="alert">
        <span>Could not save this board. Your changes are still open in this tab. Export a project file or retry.</span>
        <button type="button" className="btn small" onClick={() => void ed.saver.flush()}>
          Retry
        </button>
        <button type="button" className="btn small" onClick={exportProject}>
          Export project
        </button>
      </div>,
    );
  if (ed.status === 'conflict')
    banners.push(
      <div key="conflict" className="banner danger" role="alert">
        <span>This board changed in another tab.</span>
        <button type="button" className="btn small" onClick={() => setConfirmLoadLatest(true)}>
          Load latest
        </button>
        <button
          type="button"
          className="btn small"
          onClick={async () => {
            const copy = ops.copyBoard(ed.boardRef.current, `${ed.boardRef.current.title} (copy)`);
            await putBoard(copy, null).catch(() => undefined);
            onOpen(copy.id, copy);
          }}
        >
          Save mine as a copy
        </button>
      </div>,
    );
  if (ed.readOnly)
    banners.push(
      <div key="ro" className="banner" role="status">
        <span>{ed.readOnly === 'viewer' ? 'View-only tactic. Remix it to create an editable copy.' : ed.readOnly === 'other' ? 'This board is open for editing in another tab.' : 'Editing moved to another tab. This tab is read-only.'}</span>
        {ed.readOnly !== 'viewer' && <button type="button" className="btn small" onClick={() => ed.takeOver.current()}>
          Edit here instead
        </button>}
      </div>,
    );
  if (ed.restoredFrom)
    banners.push(
      <div key="restored" className="banner" role="status">
        <span>Restored the version from {new Date(ed.restoredFrom).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} because the latest save was damaged.</span>
        <button type="button" className="btn small" onClick={async () => download(new Blob([JSON.stringify(loaded.damaged ?? (await getRawBoard(board.id)), null, 2)], { type: 'application/json' }), `${safeName(board.title)}-damaged.json`)}>
          Export damaged data
        </button>
        <button type="button" className="btn small" onClick={() => ed.setRestoredFrom(null)}>
          Dismiss
        </button>
      </div>,
    );

  // On phones the collapsed sheet header is always there (it names the selection, or the
  // phase when nothing is selected), so selecting something never resizes the pitch.
  const sheetState = !compact ? 'side' : ed.inspectorOpen ? (sheetFull ? 'full' : 'half') : 'collapsed';
  void hasSel;
  // On phones the sheet closes itself once nothing is selected and the user deselects by tapping the pitch.
  const closeSheet = () => (ed.setInspectorOpen(false), setSheetFull(false));

  return (
    <div ref={rootRef} className={`editor ${compact ? 'compact' : 'wide'} ${ed.presenting ? 'presenting' : ''}`} data-theme={board.pitchTheme}>
      <header className="topbar">
        <IconButton icon="back" label="Back to boards" onClick={() => void leave()} />
        {renamingTitle ? (
          <input
            className="title-input"
            autoFocus
            defaultValue={board.title}
            maxLength={80}
            aria-label="Board title"
            onBlur={(e) => (ed.commit(ops.updateBoard(ed.boardRef.current, { title: e.target.value }), 'rename board'), setRenamingTitle(false))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              else if (e.key === 'Escape') {
                (e.target as HTMLInputElement).value = board.title; // BRD-010: Escape cancels
                setRenamingTitle(false);
              }
            }}
          />
        ) : (
          <button type="button" className="title" title="Rename board" disabled={!!ed.readOnly} onClick={() => setRenamingTitle(true)}>
            {board.title}
          </button>
        )}
        <span className={`save-status ${statusKey}`} role="status" aria-live="polite">
          <i aria-hidden="true" />
          {STATUS_LABEL[statusKey]}
        </span>
        <span className="spacer" />
        {!compact && <button type="button" className="btn ghost" onClick={() => setShareOpen(true)}>Share</button>}
        <IconButton icon="undo" label="Undo" kbd="Ctrl+Z" onClick={ed.undo} disabled={!ed.canUndo || !!ed.readOnly} />
        <IconButton icon="redo" label="Redo" kbd="Ctrl+Shift+Z" onClick={ed.redo} disabled={!ed.canRedo || !!ed.readOnly} />
        {!compact && (
          <>
            <button type="button" className="btn ghost" onClick={startPresent}>
              <Icon name="present" size={18} /> Present
            </button>
            <button type="button" className="btn primary" onClick={() => ed.setDialog({ kind: 'export' })}>
              <Icon name="export" size={18} /> Export
            </button>
          </>
        )}
        <button type="button" className="iconbtn" aria-label="More actions" title="More actions" aria-haspopup="menu" onClick={(e) => openOverflow(e.currentTarget)}>
          <Icon name="more" />
        </button>
      </header>

      <nav className="viewbar" aria-label="View">
        <div className="seg-track" role="group" aria-label="Pitch view">
        <button type="button" className="chip" aria-pressed={view.preset === 'full'} onClick={() => setPreset('full')}>
          Full
        </button>
        <button
          type="button"
          className="chip"
          aria-pressed={half}
          aria-haspopup="menu"
          onClick={(e) =>
            menuAt(e.currentTarget, [
              { label: viewLabel(board, 'half-own'), run: () => setPreset('half-own') },
              { label: viewLabel(board, 'half-opp'), run: () => setPreset('half-opp') },
            ])
          }
        >
          {half ? viewLabel(board, view.preset) : 'Half'}
        </button>
        <button
          type="button"
          className="chip"
          aria-pressed={third}
          aria-haspopup="menu"
          onClick={(e) =>
            menuAt(e.currentTarget, [
              { label: viewLabel(board, 'third-def'), run: () => setPreset('third-def') },
              { label: viewLabel(board, 'third-mid'), run: () => setPreset('third-mid') },
              { label: viewLabel(board, 'third-att'), run: () => setPreset('third-att') },
            ])
          }
        >
          {third ? viewLabel(board, view.preset) : 'Third'}
        </button>
        </div>
        <span className="sep" />
        <label className="chip select-chip">
          <span className="sr-only">Team focus</span>
          <select value={view.focus} onChange={(e) => setFocus(e.target.value as Focus)} aria-label="Team focus">
            <option value="both">Both teams</option>
            <option value="ghost">
              {primary.name} + {other.name} ghost
            </option>
            <option value="primary">{primary.name} only</option>
            <option value="other">{other.name} only</option>
          </select>
        </label>
        <button
          type="button"
          className="chip view-as-switch"
          disabled={!!ed.readOnly || ed.locked}
          onClick={() => ed.commit(ops.updateBoard(ed.boardRef.current, { primaryTeamId: other.id }), 'change primary team')}
        >
          Viewing as {primary.name}
        </button>
        <span className="spacer" />
        <IconButton icon="plus" label="Zoom in" kbd="+" onClick={() => zoomBy(ZOOM_STEP)} disabled={view.zoom >= 4} className="mini hide-compact" />
        <button type="button" className="chip" onClick={fit} disabled={view.zoom <= 1.001} title="Fit (0)" aria-label={`Zoom ${view.zoom.toFixed(1)}x. Fit view`}>
          {zoomLabel}
        </button>
        <button type="button" className="chip" aria-haspopup="menu" onClick={(e) => openViewMenu(e.currentTarget)}>
          View
        </button>
      </nav>

      {banners.length > 0 && <div className="banners">{banners}</div>}

      <div className={`tools ${compact ? 'dock' : 'rail'}`} role="toolbar" aria-label="Tools" aria-orientation={compact ? 'horizontal' : 'vertical'}>
        {compact ? dock : TOOLS.map(toolButton)}
      </div>

      <main className="stage-wrap">
        {options && <div className="tool-options">{options}</div>}
        <Stage ed={ed} spaceHeld={spaceHeld} />
        {!ed.presenting && coach < COACH.length && !ed.readOnly && (
          <div className="coach" role="note">
            <b>
              Tip {coach + 1} of {COACH.length}
            </b>
            <span>{COACH[coach]}</span>
            <button type="button" className="btn small" onClick={() => nextCoach(coach + 1)}>
              {coach === COACH.length - 1 ? 'Done' : 'Next'}
            </button>
            <button type="button" className="btn small ghost" onClick={() => nextCoach(COACH.length)}>
              Skip
            </button>
          </div>
        )}
        {ed.cursor !== null && !ed.playing && !ed.presenting && (
          <div className="stage-chip">
            Between phases. The pitch is read-only here.
            <button type="button" className="btn small" onClick={() => ed.nearestPhase()}>
              Go to nearest phase
            </button>
          </div>
        )}
      </main>

      <aside className={`inspector ${sheetState}`} aria-label="Inspector">
        <header className="inspector-head">
          <button type="button" className="inspector-title" onClick={() => compact && (ed.inspectorOpen ? setSheetFull(!sheetFull) : ed.setInspectorOpen(true))} aria-expanded={!compact || ed.inspectorOpen}>
            {inspectorTitle(ed)}
          </button>
          <IconButton icon="list" label="Objects" onClick={() => ed.setDialog({ kind: 'objects' })} className="mini" />
          {compact && <IconButton icon={ed.inspectorOpen ? 'down' : 'up'} label={ed.inspectorOpen ? 'Collapse inspector' : 'Open inspector'} onClick={() => (ed.inspectorOpen ? closeSheet() : ed.setInspectorOpen(true))} className="mini" />}
        </header>
        {(sheetState === 'side' || sheetState === 'half' || sheetState === 'full') && <Inspector ed={ed} />}
      </aside>

      <footer className={`bottom ${compact ? 'mobile-bottom' : ''} ${mobilePhasesOpen ? 'phases-expanded' : 'phases-collapsed'}`}>
        {compact && <div className="mobile-phase-heading">
          <button type="button" className="mobile-phase-toggle" aria-expanded={mobilePhasesOpen} aria-controls="pitchplay-phase-strip" onClick={() => setMobilePhasesOpen((open) => !open)}>
            <Icon name="list" size={17} />
            <span className="mobile-phase-number">Phase {phaseIdx + 1} <small>/ {board.phases.length}</small></span>
            <span className="mobile-phase-name">{phase.name}</span>
            <Icon name={mobilePhasesOpen ? 'down' : 'up'} size={17} />
          </button>
          <button type="button" className="mobile-phase-add" aria-label="Add phase" disabled={!!ed.readOnly || ed.locked || ops.phasesFull(board)} onClick={() => { ed.addPhase(false); setMobilePhasesOpen(true); }}>
            <Icon name="plus" size={17} /> <span>Add</span>
          </button>
        </div>}
        <div id="pitchplay-phase-strip" className="mobile-phase-strip"><PhaseRail ed={ed} /></div>
        <Playback ed={ed} compact={compact} />
      </footer>

      {ed.presenting && (
        <div
          className={`present-ui ${presentUi ? '' : 'idle'}`}
          onPointerMove={pokePresent}
          onPointerDown={(e) => {
            pokePresent();
            (e.currentTarget as HTMLElement).dataset.x = String(e.clientX);
          }}
          onPointerUp={(e) => {
            // PRS-003: swipes step phases.
            const x0 = Number((e.currentTarget as HTMLElement).dataset.x ?? e.clientX);
            if (e.target !== e.currentTarget) return;
            if (e.clientX - x0 > 60) ed.setPhase(phaseIdx - 1);
            else if (x0 - e.clientX > 60) ed.setPhase(phaseIdx + 1);
          }}
        >
          <div className="present-top">
            <span className="present-phase">
              <b>{phaseIdx + 1}</b> / {board.phases.length} · {phase.name}
            </span>
            <label className="inline-check">
              <input type="checkbox" checked={presentCaptions} onChange={(e) => setPresentCaptions(e.target.checked)} /> Captions
            </label>
            <label className="inline-check">
              <input type="checkbox" checked={presentWhole} onChange={(e) => togglePresentWhole(e.target.checked)} /> Whole pitch
            </label>
            <IconButton icon="close" label="Close present mode" onClick={endPresent} />
          </div>
          {presentCaptions && phase.caption && <div className="present-caption">{phase.caption}</div>}
          <div className="present-controls">
            <IconButton icon="prev" label="Previous phase" onClick={() => ed.setPhase(phaseIdx - 1)} disabled={phaseIdx === 0} />
            <button type="button" className="play-btn" aria-label={ed.playing ? 'Pause' : 'Play'} disabled={board.phases.length < 2} onClick={() => (ed.playing ? ed.pause() : ed.play())}>
              <Icon name={ed.playing ? 'pause' : 'play'} size={26} />
            </button>
            <IconButton icon="next" label="Next phase" onClick={() => ed.setPhase(phaseIdx + 1)} disabled={phaseIdx >= ops.lastIdx(board)} />
            <select value={ed.speed} onChange={(e) => ed.setSpeed(Number(e.target.value))} aria-label="Playback speed">
              {[0.5, 1, 1.5, 2].map((s) => (
                <option key={s} value={s}>
                  {s}x
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {shareOpen && <CollaborationDialog board={board} access={cloudAccess} onClose={() => setShareOpen(false)}
        onRestore={(snapshot) => ed.commit({ ...snapshot, id: ed.boardRef.current.id,
          createdAt: ed.boardRef.current.createdAt, revision: ed.boardRef.current.revision + 1,
          updatedAt: new Date().toISOString() }, 'restore cloud version')} />}
      {ed.textEdit && <TextEditor initial={ed.textEdit.text} isNew={!ed.textEdit.id} compact={compact} onCommit={commitText} onCancel={() => ed.setTextEdit(null)} />}

      {d?.kind === 'settings' && <SettingsDialog ed={ed} />}
      {d?.kind === 'export' && <ExportSheet ed={ed} />}
      {d?.kind === 'formation' && <FormationDialog ed={ed} />}
      {d?.kind === 'format' && <FormatDialog ed={ed} format={d.format} />}
      {d?.kind === 'versions' && <VersionsDialog ed={ed} />}
      {d?.kind === 'shortcuts' && <ShortcutsDialog ed={ed} />}
      {d?.kind === 'objects' && <ObjectsDialog ed={ed} />}
      {d?.kind === 'roster' && <RosterDialog ed={ed} />}
      {d?.kind === 'deletePlayers' && <DeletePlayers ed={ed} ids={d.ids} />}
      {d?.kind === 'deletePhase' && (
        <Confirm
          title="Delete phase"
          body={`Delete '${board.phases[d.index]?.name}'? It has ${ops.drawingCounts(board.phases[d.index] ?? phase).total} drawings.`}
          confirm="Delete"
          danger
          onClose={() => ed.setDialog(null)}
          onConfirm={() => {
            // PHS-007: stop playback, apply MOV-008, select the previous phase (or the next if it was first).
            ed.stop();
            const res = ops.deletePhase(ed.boardRef.current, d.index);
            if (res && ed.commit(res.board, 'delete phase')) {
              ed.setPhase(Math.max(0, d.index - 1));
              if (res.updated || res.removed) ed.toast(`${res.updated} ${res.updated === 1 ? 'line' : 'lines'} updated, ${res.removed} removed.`, { label: 'Undo', run: () => ed.undo() });
            }
          }}
        />
      )}
      {d?.kind === 'reorder' &&
        (() => {
          const res = ops.movePhase(board, d.from, d.to);
          if (!res) return null;
          const parts = [];
          if (res.updated) parts.push(`${res.updated} ${res.updated === 1 ? 'line' : 'lines'} will update`);
          if (res.removed) parts.push(`${res.removed} will be removed`);
          return (
            <Confirm
              title="Move phase"
              body={`${parts.join(', ')}. Lines always end where the player or ball is in the next phase.`}
              confirm="Move phase"
              onClose={() => ed.setDialog(null)}
              onConfirm={() => {
                ed.stop();
                if (ed.commit(res.board, 'reorder phases')) ed.setPhase(d.to);
              }}
            />
          );
        })()}
      {d?.kind === 'clearDrawings' &&
        (() => {
          const c = ops.drawingCounts(board.phases[d.index] ?? phase);
          return (
            <Confirm
              title="Clear drawings"
              body={`Remove ${c.lines} ${c.lines === 1 ? 'line' : 'lines'}, ${c.zones} ${c.zones === 1 ? 'zone' : 'zones'} and ${c.labels} ${c.labels === 1 ? 'label' : 'labels'} from '${board.phases[d.index]?.name}'? Player positions stay.`}
              confirm="Clear"
              danger
              onClose={() => ed.setDialog(null)}
              onConfirm={() => ed.commit(ops.clearDrawings(ed.boardRef.current, d.index), 'clear drawings')}
            />
          );
        })()}
      {d?.kind === 'deleteLine' && (
        <Confirm title="Delete line" body="The line goes. The player or ball still ends up where the line pointed." confirm="Delete line" danger onClose={() => ed.setDialog(null)} onConfirm={() => ed.commit(ops.deleteMovement(ed.boardRef.current, ed.phaseRef.current, d.movementId), 'delete line')} />
      )}
      {confirmLoadLatest && (
        <Confirm title="Load the latest save?" body="Changes made in this tab since the other tab saved are discarded." confirm="Load latest" danger onClose={() => setConfirmLoadLatest(false)} onConfirm={() => void ed.reload()} />
      )}
      {importFile && (
        <ImportDialog
          file={importFile}
          onClose={() => setImportFile(null)}
          onOpenNew={async (b) => {
            await ed.saver.flush(); // IMP-009
            const copy = ops.copyBoard(b, b.title);
            if (available) await putBoard(copy, null);
            setImportFile(null);
            onOpen(copy.id, available ? undefined : copy);
          }}
          onReplace={
            ed.readOnly
              ? undefined
              : async (b) => {
                  const cur = ed.boardRef.current;
                  await ed.saver.flush();
                  await addVersion(cur, 'auto').catch(() => undefined); // IMP-007
                  ed.commit({ ...b, id: cur.id, revision: cur.revision + 1, createdAt: cur.createdAt, updatedAt: new Date().toISOString() }, 'replace board from file');
                  setImportFile(null);
                }
          }
        />
      )}

      {ed.menu && (
        <Menu
          menu={ed.menu}
          onClose={(picked) => {
            const m = ed.menu;
            ed.setMenu(null);
            if (!picked) m?.onDismiss?.();
          }}
        />
      )}

      <div className="toasts" role="status" aria-live="polite">
        {ed.toasts.map((t) => (
          <div key={t.id} className="toast">
            <span>{t.text}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  ed.dismissToast(t.id);
                  t.action!.run();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="sr-only" aria-live="polite">
        {ed.announcement}
      </div>
      {import.meta.env.DEV && <DevHooks ed={ed} />}
    </div>
  );
}

// Development-only handle for automated checks (AT-090 forces save failures through it).
function DevHooks({ ed }: { ed: Editor }) {
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__pitchplay = { ed, ops, debug };
  });
  return null;
}

function DeletePlayers({ ed, ids }: { ed: Editor; ids: string[] }) {
  const b = ed.board;
  const players = ids.map((id) => ops.playerById(b, id)).filter((p): p is NonNullable<typeof p> => !!p && !p.locked);
  const links = ops.playerLinks(
    b,
    players.map((p) => p.id),
  );
  const n = b.phases.length;
  const names = players.map(ops.playerLabel).join(', ');
  const skipped = ids.length - players.length;
  // PLY-019, PLY-023
  return (
    <Confirm
      title={players.length === 1 ? 'Remove player' : `Remove ${players.length} players`}
      body={`Remove ${names} from ${n === 1 ? 'the board' : `all ${n} phases`}? ${links.lines} movement ${links.lines === 1 ? 'line' : 'lines'} and ${links.ballLinks} ball ${links.ballLinks === 1 ? 'link' : 'links'} go too.${skipped ? ` ${skipped} locked ${skipped === 1 ? 'player stays' : 'players stay'}.` : ''}`}
      confirm="Remove"
      danger
      onClose={() => ed.setDialog(null)}
      onConfirm={() =>
        ed.commit(
          ops.deletePlayers(
            ed.boardRef.current,
            players.map((p) => p.id),
          ),
          players.length === 1 ? `remove #${players[0].number}` : 'remove players',
        )
      }
    />
  );
}

function TextEditor(props: { initial: string; isNew: boolean; compact: boolean; onCommit: (t: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(props.initial);
  const [bottom, setBottom] = useState(0);
  // RSP-006: keep the field and Done above the virtual keyboard.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const on = () => setBottom(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    on();
    vv.addEventListener('resize', on);
    vv.addEventListener('scroll', on);
    return () => {
      vv.removeEventListener('resize', on);
      vv.removeEventListener('scroll', on);
    };
  }, []);
  const lines = v.split('\n');
  return (
    <div className="scrim clear" onPointerDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div className={`text-editor ${props.compact ? 'as-sheet' : ''}`} role="dialog" aria-label={props.isNew ? 'New label' : 'Edit label'} style={props.compact ? { bottom } : undefined}>
        <textarea
          autoFocus
          rows={3}
          maxLength={80}
          value={v}
          placeholder="Label text"
          aria-label="Label text"
          onChange={(e) => setV(e.target.value.split('\n').slice(0, 3).join('\n'))}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') props.onCancel(); // TXT-002
            else if (e.key === 'Enter' && !e.shiftKey && !props.compact) {
              e.preventDefault();
              props.onCommit(v);
            } else if (e.key === 'Enter' && lines.length >= 3) e.preventDefault();
          }}
        />
        <div className="text-editor-foot">
          <small>{v.length}/80 · up to 3 lines{props.compact ? '' : ' · Shift+Enter for a new line'}</small>
          <button type="button" className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => props.onCommit(v)}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
