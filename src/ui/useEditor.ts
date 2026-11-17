// Editor state. Document changes go through commit() only (INT-001); everything else is view state (INT-002).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Board, LineType, Pt, Selection } from '../domain/types';
import { EMPTY_SELECTION } from '../domain/types';
import { UNDO_DEPTH, VERSION_EVERY_MS } from '../domain/params';
import * as ops from '../domain/ops';
import { buildTimeline, frameAt, phaseStart, sceneInTransition, type Frame, type Timeline } from '../domain/playback';
import { tokenLabel } from '../domain/labels';
import { DEFAULT_VIEW, type Cam, type ViewState } from '../render/camera';
import { teamMode, type HitRef } from '../render/draw';
import { Saver, addVersion, getPref, loadBoard, setPref, type LoadResult, type SaveStatus } from '../store/db';
import type { MenuState } from './kit';
import { trackEdit, trackEvent } from '../store/analytics';

export type Tool = 'select' | 'player' | 'run' | 'pass' | 'carry' | 'shot' | 'arrow' | 'zone' | 'text' | 'erase' | 'pan';
export const LINE_TYPES: LineType[] = ['run', 'pass', 'carry', 'shot', 'arrow'];
export const isLineTool = (t: Tool): t is LineType => (LINE_TYPES as string[]).includes(t);

export interface ToastMsg {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

export type Dialog =
  | { kind: 'deletePlayers'; ids: string[] }
  | { kind: 'deletePhase'; index: number }
  | { kind: 'reorder'; from: number; to: number }
  | { kind: 'clearDrawings'; index: number }
  | { kind: 'deleteLine'; movementId: string }
  | { kind: 'settings' }
  | { kind: 'export' }
  | { kind: 'formation' }
  | { kind: 'format'; format: Board['format'] }
  | { kind: 'versions' }
  | { kind: 'shortcuts' }
  | { kind: 'objects' }
  | { kind: 'roster' }
  | { kind: 'import' };

export interface TextEdit {
  id: string | null;
  at: Pt;
  text: string;
}

interface UndoEntry {
  board: Board;
  label: string;
  phaseIdx: number;
}

const prefersReducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function devicePref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`pitchplay:${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
export function setDevicePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`pitchplay:${key}`, JSON.stringify(value));
  } catch {
    // Device preferences are optional.
  }
}

export function sanitizeSelection(board: Board, phaseIdx: number, sel: Selection, focus: ViewState['focus']): Selection {
  const ph = board.phases[phaseIdx];
  const players = sel.players.filter((id) => {
    const p = ops.playerById(board, id);
    return !!p && teamMode(board, focus, p.teamId) === 'show';
  });
  const movementId = sel.movementId && ph.movements.some((m) => m.id === sel.movementId) ? sel.movementId : null;
  const annotationId = sel.annotationId && ph.annotations.some((a) => a.id === sel.annotationId) ? sel.annotationId : null;
  if (players.length === sel.players.length && movementId === sel.movementId && annotationId === sel.annotationId) return sel;
  return { players, ball: sel.ball, movementId, annotationId };
}

export function useEditor(loaded: LoadResult, available: boolean, viewOnly = false) {
  const [board, setBoardState] = useState<Board>(loaded.board);
  const boardRef = useRef(board);
  const [preview, setPreview] = useState<Board | null>(null);
  const [phaseIdx, setPhaseIdx] = useState(0);
  const phaseRef = useRef(0);
  const [sel, setSelState] = useState<Selection>(EMPTY_SELECTION);
  const selRef = useRef(sel);
  const [tool, setToolState] = useState<Tool>('select');
  const [view, setViewState] = useState<ViewState>(DEFAULT_VIEW);
  const viewRef = useRef(view);
  const camRef = useRef<Cam | null>(null);
  const gestureRef = useRef<{ cancel: () => boolean }>({ cancel: () => false });
  const [status, setStatus] = useState<SaveStatus>(available ? 'saved' : 'session');
  const [readOnly, setReadOnly] = useState<null | 'other' | 'moved' | 'viewer'>(viewOnly ? 'viewer' : null);
  const [restoredFrom, setRestoredFrom] = useState<string | null>(loaded.restoredFrom);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [playerTeam, setPlayerTeam] = useState<string>(loaded.board.primaryTeamId);
  const [addSeveral, setAddSeveral] = useState(false);
  const [zoneShape, setZoneShape] = useState<'rect' | 'ellipse'>('rect');
  const [moveMode, setMoveMode] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const session = useRef({ alsoMovedShown: false, versioned: false, lastVersionAt: Date.now(), toastId: 0 });

  const saver = useMemo(() => new Saver(setStatus, loaded.board.revision, available), [loaded, available]);
  useEffect(() => () => saver.dispose(), [saver]);

  // ---------- messages ----------
  const announce = useCallback((text: string) => setAnnouncement((prev) => (prev === text ? `${text} ` : text)), []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (text: string, action?: ToastMsg['action'], ms = action ? 6000 : 2000) => {
      const id = ++session.current.toastId;
      setToasts((t) => [...t.filter((x) => x.text !== text).slice(-2), { id, text, action }]);
      setTimeout(() => dismissToast(id), ms);
    },
    [dismissToast],
  );

  // ---------- selection, tool, view ----------
  const setSel = useCallback((s: Selection) => {
    selRef.current = s;
    setSelState(s);
  }, []);
  const clearSel = useCallback(() => setSel(EMPTY_SELECTION), [setSel]);

  const setTool = useCallback(
    (t: Tool) => {
      gestureRef.current.cancel();
      setMoveMode(false);
      setToolState(t);
      if (isLineTool(t)) setDevicePref('lineType', t); // LIN-001
      announce(`${t[0].toUpperCase()}${t.slice(1)} tool`);
    },
    [announce],
  );

  const setView = useCallback(
    (v: ViewState | ((prev: ViewState) => ViewState), cancelGesture = false) => {
      if (cancelGesture) gestureRef.current.cancel(); // PIT-010
      const next = typeof v === 'function' ? v(viewRef.current) : v;
      const prev = viewRef.current;
      viewRef.current = next;
      setViewState(next);
      if (next.focus !== prev.focus) {
        // TFM-007: a selection that becomes hidden or ghosted is cleared.
        const clean = sanitizeSelection(boardRef.current, phaseRef.current, selRef.current, next.focus);
        if (clean !== selRef.current) {
          setSel(clean);
          const hiddenTeam = next.focus === 'other' ? ops.primaryTeam(boardRef.current) : ops.otherTeam(boardRef.current);
          announce(`Selection cleared, ${hiddenTeam.name} ${next.focus === 'ghost' ? 'ghosted' : 'hidden'}`);
        }
      }
    },
    [announce, setSel],
  );

  // PIT-011: view preferences are stored per board per device and never exported.
  const boardId = loaded.board.id;
  useEffect(() => {
    let live = true;
    void getPref<{ view: ViewState; phaseIdx: number }>(`view:${boardId}`).then((p) => {
      if (!live || !p) return;
      if (p.view) {
        viewRef.current = { ...DEFAULT_VIEW, ...p.view };
        setViewState(viewRef.current);
      }
      if (typeof p.phaseIdx === 'number') {
        phaseRef.current = Math.min(p.phaseIdx, ops.lastIdx(boardRef.current));
        setPhaseIdx(phaseRef.current);
      }
    });
    return () => {
      live = false;
    };
  }, [boardId]);
  useEffect(() => {
    const t = setTimeout(() => void setPref(`view:${boardId}`, { view, phaseIdx }), 300);
    return () => clearTimeout(t);
  }, [boardId, view, phaseIdx]);

  // ---------- playback (TRN) ----------
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursorState] = useState<number | null>(null);
  const cursorRef = useRef<number | null>(null);
  const [speed, setSpeed] = useState(1);
  const speedRef = useRef(1);
  speedRef.current = speed;
  const [fullMotion, setFullMotion] = useState(false);
  const stepped = prefersReducedMotion() && !fullMotion;
  const timeline: Timeline = useMemo(() => buildTimeline(board), [board]);
  const tlRef = useRef(timeline);
  tlRef.current = timeline;
  const setCursor = (c: number | null) => {
    cursorRef.current = c;
    setCursorState(c);
  };
  const frame: Frame | null = useMemo(() => (cursor === null ? null : frameAt(board, timeline, cursor, stepped)), [board, timeline, cursor, stepped]);
  const trailFrom = useMemo(() => (frame && frame.trail && frame.kind === 'move' ? sceneInTransition(board, frame.phase, Math.max(0, frame.t - 0.14)) : null), [board, frame]);
  const locked = playing || cursor !== null;

  const stop = useCallback(() => {
    setPlaying(false);
    setCursor(null);
  }, []);

  const selectPhaseRaw = useCallback(
    (i: number) => {
      const idx = Math.max(0, Math.min(i, ops.lastIdx(boardRef.current)));
      if (idx === phaseRef.current) return;
      phaseRef.current = idx;
      setPhaseIdx(idx);
      // PHS-008: the same player stays selected by ID; lines and drawings belong to their phase.
      const s = selRef.current;
      if (s.movementId || s.annotationId) setSel({ ...s, movementId: null, annotationId: null });
    },
    [setSel],
  );

  const setPhase = useCallback(
    (i: number) => {
      gestureRef.current.cancel(); // INT-007
      stop(); // TRN-009: picking a phase stops playback
      selectPhaseRaw(i);
      const ph = boardRef.current.phases[Math.max(0, Math.min(i, ops.lastIdx(boardRef.current)))];
      announce(`Phase ${Math.min(i, ops.lastIdx(boardRef.current)) + 1} of ${boardRef.current.phases.length}, ${ph.name}`);
    },
    [announce, selectPhaseRaw, stop],
  );

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let shownPhase = -1;
    const tick = (now: number) => {
      const tl = tlRef.current;
      const b = boardRef.current;
      let c = (cursorRef.current ?? 0) + (now - last) * speedRef.current;
      last = now;
      if (c >= tl.total) {
        if (b.settings.loop) c = 0; // TRN-005
        else {
          setPlaying(false);
          setCursor(null);
          selectPhaseRaw(ops.lastIdx(b));
          announce('Playback finished');
          return;
        }
      }
      setCursor(c);
      const f = frameAt(b, tl, c);
      if (f.phase !== shownPhase) {
        shownPhase = f.phase;
        selectPhaseRaw(f.phase);
        if (f.kind === 'hold') announce(`Phase ${f.phase + 1} of ${b.phases.length}, ${b.phases[f.phase].name}`);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, announce, selectPhaseRaw]);

  const play = useCallback(() => {
    const b = boardRef.current;
    if (b.phases.length < 2) return; // TRN-011
    gestureRef.current.cancel();
    setPreview(null);
    if (cursorRef.current === null) {
      // TRN-002: from the selected phase; from the last phase it starts again at phase 1.
      const from = phaseRef.current >= ops.lastIdx(b) ? 0 : phaseRef.current;
      setCursor(phaseStart(tlRef.current, from));
    }
    setPlaying(true);
    trackEvent('playback_started','editor');
    announce('Playing');
  }, [announce]);

  const pause = useCallback(() => {
    setPlaying(false);
    const c = cursorRef.current;
    if (c !== null) {
      const f = frameAt(boardRef.current, tlRef.current, c);
      if (f.atRest) {
        selectPhaseRaw(f.phase);
        setCursor(null);
      }
    }
    announce('Paused');
  }, [announce, selectPhaseRaw]);

  const seek = useCallback(
    (ms: number, settle: boolean) => {
      setPlaying(false);
      const f = frameAt(boardRef.current, tlRef.current, ms);
      selectPhaseRaw(f.phase);
      // TRN-008: releasing on a tick selects that phase; between phases the canvas stays read-only.
      setCursor(settle && f.atRest ? null : ms);
    },
    [selectPhaseRaw],
  );

  const nearestPhase = useCallback(() => {
    const c = cursorRef.current;
    if (c === null) return;
    const f = frameAt(boardRef.current, tlRef.current, c);
    stop();
    selectPhaseRaw(f.kind === 'move' && f.t >= 0.5 ? f.phase + 1 : f.phase);
  }, [selectPhaseRaw, stop]);

  // TRN-010: a hidden tab pauses playback.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        if (cursorRef.current !== null) pause();
        void saver.flush(); // PST-005
      }
    };
    const onHide = () => void saver.flush();
    const onLeave = (e: BeforeUnloadEvent) => {
      if (saver.dirty || saver.status === 'failed') e.preventDefault();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('beforeunload', onLeave);
    };
  }, [pause, saver]);

  // ---------- document changes ----------
  const applyBoard = useCallback(
    (next: Board) => {
      boardRef.current = next;
      setBoardState(next);
      setPreview(null);
      if (phaseRef.current > ops.lastIdx(next)) {
        phaseRef.current = ops.lastIdx(next);
        setPhaseIdx(phaseRef.current);
      }
      const clean = sanitizeSelection(next, phaseRef.current, selRef.current, viewRef.current.focus);
      if (clean !== selRef.current) setSel(clean);
      saver.schedule(next); // PST-002
      setHistory({ undo: undoStack.current.length, redo: redoStack.current.length });
    },
    [saver, setSel],
  );

  const commit = useCallback(
    (next: Board | null | undefined, label: string): boolean => {
      if (!next) return false;
      if (readOnly) return false;
      if (cursorRef.current !== null) {
        toast('Pause to edit.'); // TRN-009
        return false;
      }
      const before = boardRef.current;
      // PST-012: an automatic version on the first edit after opening and every 10 minutes of editing.
      const now = Date.now();
      if (!session.current.versioned || now - session.current.lastVersionAt > VERSION_EVERY_MS) {
        session.current.versioned = true;
        session.current.lastVersionAt = now;
        void addVersion(before, 'auto').catch(() => undefined);
      }
      undoStack.current.push({ board: before, label, phaseIdx: phaseRef.current });
      if (undoStack.current.length > UNDO_DEPTH) undoStack.current.shift(); // HIS-003
      redoStack.current = []; // HIS-004
      applyBoard(next);
      trackEdit(label);
      return true;
    },
    [applyBoard, readOnly, toast],
  );

  const travel = useCallback(
    (from: UndoEntry[], to: UndoEntry[], word: string) => {
      if (readOnly) return;
      stop(); // TRN-017
      gestureRef.current.cancel();
      const entry = from.pop();
      if (!entry) return;
      const cur = boardRef.current;
      to.push({ board: cur, label: entry.label, phaseIdx: phaseRef.current });
      // Undo is itself a document change, so the revision keeps counting up.
      applyBoard({ ...entry.board, revision: cur.revision + 1, updatedAt: new Date().toISOString() });
      selectPhaseRaw(entry.phaseIdx);
      announce(`${word}: ${entry.label}`); // HIS-006
    },
    [announce, applyBoard, readOnly, selectPhaseRaw, stop],
  );
  const undo = useCallback(() => travel(undoStack.current, redoStack.current, 'Undid'), [travel]);
  const redo = useCallback(() => travel(redoStack.current, undoStack.current, 'Redid'), [travel]);

  // Replace the whole board from outside the undo stack (conflict "Load latest", moving the edit lock).
  const reload = useCallback(async () => {
    const fresh = await loadBoard(boardId);
    if (!fresh) return;
    undoStack.current = [];
    redoStack.current = [];
    saver.reset(fresh.board.revision);
    boardRef.current = fresh.board;
    setBoardState(fresh.board);
    setPreview(null);
    phaseRef.current = Math.min(phaseRef.current, ops.lastIdx(fresh.board));
    setPhaseIdx(phaseRef.current);
    setSel(EMPTY_SELECTION);
    setHistory({ undo: 0, redo: 0 });
  }, [boardId, saver, setSel]);

  // ---------- one editing tab per board (PST-009) ----------
  const release = useRef<(() => void) | null>(null);
  const takeOver = useRef<() => void>(() => undefined);
  useEffect(() => {
    // View-only public previews never acquire an edit lock or become writable via takeover.
    if (viewOnly || !available || typeof navigator === 'undefined' || !navigator.locks || typeof BroadcastChannel === 'undefined') return;
    const name = `pitchplay-board-${boardId}`;
    const channel = new BroadcastChannel('pitchplay');
    let disposed = false;
    const hold = (lock: Lock | null, wasWaiting: boolean) => {
      if (!lock) {
        if (!disposed) setReadOnly('other');
        return undefined;
      }
      if (disposed) return undefined;
      if (wasWaiting) void reload().then(() => setReadOnly(null));
      else setReadOnly(null);
      return new Promise<void>((resolve) => {
        release.current = resolve;
      });
    };
    void navigator.locks.request(name, { ifAvailable: true }, (lock) => hold(lock, false));
    channel.onmessage = (e) => {
      if (e.data?.type !== 'take' || e.data.boardId !== boardId || !release.current) return;
      void saver.flush().then(() => {
        setReadOnly('moved');
        release.current?.();
        release.current = null;
      });
    };
    takeOver.current = () => {
      channel.postMessage({ type: 'take', boardId });
      void navigator.locks.request(name, (lock) => hold(lock, true));
    };
    return () => {
      disposed = true;
      release.current?.();
      release.current = null;
      channel.close();
    };
  }, [available, boardId, reload, saver, viewOnly]);

  // ---------- shared actions ----------
  const selectRef = useCallback(
    (ref: HitRef, additive = false) => {
      const b = boardRef.current;
      const s = selRef.current;
      if (ref.kind === 'player') {
        const has = s.players.includes(ref.id);
        const players = additive ? (has ? s.players.filter((x) => x !== ref.id) : [...s.players, ref.id]) : [ref.id];
        setSel({ players, ball: additive ? s.ball : false, movementId: null, annotationId: null });
        const p = ops.playerById(b, ref.id);
        if (p && !additive) announce(`Selected ${tokenLabel(b, p, b.phases[phaseRef.current].tokens[p.id])}`);
        else announce(`${players.length + (additive && s.ball ? 1 : 0)} selected`);
      } else if (ref.kind === 'ball') {
        setSel({ players: additive ? s.players : [], ball: additive ? !s.ball : true, movementId: null, annotationId: null });
        announce('Selected ball');
      } else if (ref.kind === 'movement') {
        setSel({ ...EMPTY_SELECTION, movementId: ref.id });
        announce('Selected movement line');
      } else if (ref.kind === 'annotation') {
        setSel({ ...EMPTY_SELECTION, annotationId: ref.id });
        announce(`Selected ${ref.sub === 'text' ? 'label' : ref.sub}`);
      }
    },
    [announce, setSel],
  );

  // ANN-001: lines, zones and labels go at once; players ask first; the ball cannot be deleted.
  const deleteRefs = useCallback(
    (refs: HitRef[]) => {
      const b = boardRef.current;
      const i = phaseRef.current;
      const players = refs.filter((r) => r.kind === 'player').map((r) => (r as { id: string }).id);
      if (players.length) {
        const lockedOne = players.map((id) => ops.playerById(b, id)).find((p) => p?.locked);
        if (lockedOne && players.length === 1) {
          toast(`#${lockedOne.number} is locked. Unlock to move it or draw its runs.`, {
            label: 'Unlock',
            run: () => commit(ops.updatePlayer(boardRef.current, lockedOne.id, { locked: false }), `unlock #${lockedOne.number}`),
          });
          return;
        }
        setDialog({ kind: 'deletePlayers', ids: players });
        return;
      }
      const ref = refs[0];
      if (!ref) return;
      if (ref.kind === 'ball') {
        toast("The ball can't be deleted. Hide it instead.", {
          label: 'Hide ball',
          run: () => commit(ops.setBallVisible(boardRef.current, phaseRef.current, false), 'hide ball'),
        });
      } else if (ref.kind === 'movement') commit(ops.deleteMovement(b, i, ref.id), 'delete line');
      else if (ref.kind === 'annotation') commit(ops.deleteAnnotation(b, i, ref.id), `delete ${ref.sub === 'text' ? 'label' : ref.sub}`);
    },
    [commit, toast],
  );

  const deleteSelection = useCallback(() => {
    const s = selRef.current;
    if (s.players.length) deleteRefs(s.players.map((id) => ({ kind: 'player', id }) as HitRef));
    else if (s.movementId) deleteRefs([{ kind: 'movement', id: s.movementId }]);
    else if (s.annotationId) deleteRefs([{ kind: 'annotation', id: s.annotationId, sub: 'line' }]);
    else if (s.ball) deleteRefs([{ kind: 'ball' }]);
  }, [deleteRefs]);

  const addPhase = useCallback(
    (withDrawings = false) => {
      const b = boardRef.current;
      if (ops.phasesFull(b)) {
        toast('30 phases is the limit.');
        return;
      }
      const i = phaseRef.current;
      if (commit(ops.addPhase(b, i, withDrawings), 'add phase')) {
        selectPhaseRaw(i + 1);
        announce(`Added ${boardRef.current.phases[i + 1].name}`);
      }
    },
    [announce, commit, selectPhaseRaw, toast],
  );

  const shown = preview ?? board;

  return {
    board,
    boardRef,
    shown,
    setPreview,
    phaseIdx,
    phaseRef,
    setPhase,
    sel,
    selRef,
    setSel,
    clearSel,
    selectRef,
    tool,
    setTool,
    view,
    viewRef,
    setView,
    camRef,
    gestureRef,
    status,
    saver,
    readOnly,
    takeOver,
    restoredFrom,
    setRestoredFrom,
    reload,
    toasts,
    toast,
    dismissToast,
    announce,
    announcement,
    menu,
    setMenu,
    dialog,
    setDialog,
    textEdit,
    setTextEdit,
    playerTeam,
    setPlayerTeam,
    addSeveral,
    setAddSeveral,
    zoneShape,
    setZoneShape,
    moveMode,
    setMoveMode,
    presenting,
    setPresenting,
    inspectorOpen,
    setInspectorOpen,
    canUndo: history.undo > 0,
    canRedo: history.redo > 0,
    undo,
    redo,
    commit,
    deleteRefs,
    deleteSelection,
    addPhase,
    session,
    // playback
    playing,
    cursor,
    frame,
    trailFrom,
    locked,
    timeline,
    speed,
    setSpeed,
    play,
    pause,
    stop,
    seek,
    nearestPhase,
    stepped,
    reducedMotion: prefersReducedMotion(),
    fullMotion,
    setFullMotion,
  };
}

export type Editor = ReturnType<typeof useEditor>;
