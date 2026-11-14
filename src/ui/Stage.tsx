// The canvas and every pointer gesture on it (PRD section 8). Gestures preview through setPreview and
// write to the document only on release, as one transaction.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Board, LineType, Pt, Subject, ZoneAnn } from '../domain/types';
import { DRAG_THRESHOLD_MOUSE, DRAG_THRESHOLD_TOUCH, LONG_PRESS_MS, MIN_LINE_PX, MIN_ZONE, PITCH_H, PITCH_W, SNAP_RADIUS_PX } from '../domain/params';
import { bendFromPoint, clampPt, dist } from '../domain/geometry';
import * as ops from '../domain/ops';
import { sceneAtPhase } from '../domain/playback';
import { makeCam, panBy, zoomAt, type Cam, type ViewState } from '../render/camera';
import { ballRadius, drawScene, teamMode, type Draft, type Handle, type HitRef } from '../render/draw';
import { describeHit, hitHandle, hitObjects, marqueeSelect, playersAt, type HitCtx } from '../render/hit';
import { noteHex, teamHex } from '../render/themes';
import { THEMES } from '../render/themes';
import { devicePref, isLineTool, setDevicePref, type Editor } from './useEditor';

interface LineStart {
  type: LineType;
  from: Pt;
  subject: Subject | null;
}

type Target =
  | { kind: 'handle'; handle: Handle }
  | { kind: 'objects'; refs: HitRef[] }
  | { kind: 'empty' }
  | { kind: 'line'; info: LineStart }
  | { kind: 'zone' }
  | { kind: 'tap' };

type Gesture =
  | { mode: 'idle' }
  | { mode: 'pressed'; id: number; start: Pt; touch: boolean; target: Target; longPressed: boolean; additive: boolean }
  | { mode: 'drag'; id: number; apply: (cur: Pt) => Board | null; last: Board | null; label: string }
  | { mode: 'line'; id: number; info: LineStart }
  | { mode: 'zone'; id: number; a: Pt }
  | { mode: 'marquee'; id: number; start: Pt; additive: boolean }
  | { mode: 'camera'; id: number; last: Pt }
  | { mode: 'pinch'; d0: number; c0: Pt; view0: ViewState; cam0: Cam };

export function Stage({ ed, spaceHeld }: { ed: Editor; spaceHeld: React.MutableRefObject<boolean> }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ W: 0, H: 0 });
  const g = useRef<Gesture>({ mode: 'idle' });
  const pointers = useRef(new Map<number, { x: number; y: number; touch: boolean }>());
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTap = useRef<{ t: number; id: string | null }>({ t: 0, id: null });
  const pending = useRef<{ kind: 'line'; info: LineStart } | { kind: 'zone'; a: Pt } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [marquee, setMarquee] = useState<{ a: Pt; b: Pt } | null>(null);
  const [snapPoints, setSnapPoints] = useState<Pt[]>([]);
  const [highlight, setHighlight] = useState<HitRef | null>(null);
  const [pendingStart, setPendingStart] = useState<Pt | null>(null);
  const [edgeFlash, setEdgeFlash] = useState(false);
  const shiftHeld = useRef(false);

  const { board, shown, phaseIdx, view, sel, tool, frame } = ed;
  const cam = useMemo(() => makeCam(board, view, Math.max(1, size.W), Math.max(1, size.H)), [board, view, size]);
  ed.camRef.current = cam;

  const clearOverlays = useCallback(() => {
    setDraft(null);
    setMarquee(null);
    setSnapPoints([]);
    setHighlight(null);
  }, []);

  // 8.2 Cancelled: restore the pre-gesture state, no undo entry.
  const cancel = useCallback((): boolean => {
    const active = g.current.mode !== 'idle' || pending.current !== null || ed.moveMode;
    if (longPress.current) clearTimeout(longPress.current);
    g.current = { mode: 'idle' };
    pending.current = null;
    setPendingStart(null);
    clearOverlays();
    ed.setPreview(null);
    if (ed.moveMode) ed.setMoveMode(false);
    return active;
  }, [clearOverlays, ed]);
  ed.gestureRef.current.cancel = cancel;

  // RSP-007: a resize or rotation cancels the active gesture; camera centre, zoom, selection and phase are kept.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => {
        if (Math.abs(s.W - r.width) < 0.5 && Math.abs(s.H - r.height) < 0.5) return s;
        if (g.current.mode !== 'idle') cancel();
        return { W: r.width, H: r.height };
      });
    };
    measure(); // measured once up front: ResizeObserver waits for a rendered frame, which a background tab never gets
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [cancel]);

  // ---------- drawing ----------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.W < 2 || size.H < 2) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.round(size.W * dpr);
    const h = Math.round(size.H * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const idx = frame ? frame.phase : phaseIdx;
    drawScene(ctx, {
      board: shown,
      phaseIdx: idx,
      scene: frame ? frame.scene : sceneAtPhase(shown, idx),
      cam,
      dpr,
      focus: view.focus,
      showLines: view.showLines,
      lineAlpha: frame ? frame.lineAlpha : 1,
      trailFrom: ed.trailFrom,
      editor: ed.presenting || frame ? null : { selection: sel, draft, marquee, snapPoints, highlight, pendingStart },
    });
  }, [shown, phaseIdx, frame, cam, size, view.focus, view.showLines, sel, draft, marquee, snapPoints, highlight, pendingStart, ed.presenting, ed.trailFrom]);

  // ---------- helpers ----------
  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const hitCtx = (touch: boolean): HitCtx => ({ board: ed.boardRef.current, phaseIdx: ed.phaseRef.current, cam, focus: view.focus, selection: ed.selRef.current, showLines: view.showLines, touch });
  const eligible = (playerId: string) => {
    const p = ops.playerById(ed.boardRef.current, playerId);
    return !!p && teamMode(ed.boardRef.current, view.focus, p.teamId) === 'show';
  };
  const snapU = SNAP_RADIUS_PX / cam.s;
  const tagOf = (b: Board, s: Subject) => ops.subjectName(b, s);

  const smallHint = () => {
    const n = devicePref('smallHints', 0);
    if (n < 3) {
      setDevicePref('smallHints', n + 1);
      ed.toast('Drag further to draw.');
    }
  };

  const lockedHint = (playerId: string) => {
    const p = ops.playerById(ed.boardRef.current, playerId);
    if (!p) return;
    ed.toast(`#${p.number} is locked. Unlock to move it or draw its runs.`, {
      label: 'Unlock',
      run: () => ed.commit(ops.updatePlayer(ed.boardRef.current, p.id, { locked: false }), `unlock #${p.number}`),
    });
  };

  // LIN-004: players whose landing point is within the snap radius of a pass tip.
  const receiversNear = (tip: Pt): string[] => {
    const b = ed.boardRef.current;
    const i = ed.phaseRef.current;
    const holder = b.phases[i].ball.possessorId;
    const s = cam.toScreen(tip);
    return b.roster
      .filter((p) => p.id !== holder && eligible(p.id))
      .map((p) => ({ id: p.id, d: dist(s, cam.toScreen(ops.landingPoint(b, i, p.id))) }))
      .filter((x) => x.d <= SNAP_RADIUS_PX)
      .sort((a, c) => a.d - c.d)
      .map((x) => x.id);
  };

  // 4.3: what a line drawn from this point is linked to.
  const resolveStart = (p: Pt, type: LineType, touch: boolean): LineStart | null => {
    const b = ed.boardRef.current;
    const ph = b.phases[ed.phaseRef.current];
    const q = clampPt(cam.toCanon(p));
    const stat = (): LineStart => ({ type, from: q, subject: null });
    if (type === 'arrow') return stat();
    const dBall = dist(p, cam.toScreen(ph.ball));
    const pl = playersAt(p, hitCtx(touch))[0]?.id ?? null;
    const ballHit = dBall <= ballRadius(cam) + 3 || (!pl && dBall <= SNAP_RADIUS_PX);
    const showBall = () =>
      ed.toast('Show the ball to draw a pass.', { label: 'Show ball', run: () => ed.commit(ops.setBallVisible(ed.boardRef.current, ed.phaseRef.current, true), 'show ball') });
    const fromPlayer = (id: string, t: LineType): LineStart | null => {
      const player = ops.playerById(b, id)!;
      if (player.locked) {
        lockedHint(id);
        return null;
      }
      return { type: t, from: ph.tokens[id], subject: { kind: 'player', playerId: id } };
    };
    if (ballHit) {
      if (type === 'carry') return ph.ball.possessorId ? fromPlayer(ph.ball.possessorId, 'carry') : stat();
      if (!ph.ball.visible) {
        showBall(); // BAL-007
        return null;
      }
      if (type === 'run') ed.setTool('pass'); // the type chip shows the change
      return { type: type === 'run' ? 'pass' : type, from: { x: ph.ball.x, y: ph.ball.y }, subject: { kind: 'ball' } };
    }
    if (pl) {
      const player = ops.playerById(b, pl)!;
      const has = ph.ball.possessorId === pl;
      if (type === 'pass' || type === 'shot') {
        if (has) {
          if (!ph.ball.visible) {
            showBall();
            return null;
          }
          return { type, from: { x: ph.ball.x, y: ph.ball.y }, subject: { kind: 'ball' } };
        }
        if (type === 'pass') ed.toast('Draw from the ball to animate a pass.');
        return stat();
      }
      if (type === 'carry' && !has) {
        ed.toast(`Give #${player.number} the ball to draw a carry.`, {
          label: 'Give ball',
          run: () => ed.commit(ops.setPossession(ed.boardRef.current, ed.phaseRef.current, pl), `give ball to #${player.number}`),
        });
        ed.setTool('run');
        return fromPlayer(pl, 'run');
      }
      return fromPlayer(pl, type);
    }
    if (type === 'pass') ed.toast('Draw from the ball to animate a pass.');
    return stat();
  };

  const commitMovement = (info: LineStart, tip: Pt, receiverId: string | null) => {
    const b = ed.boardRef.current;
    const i = ed.phaseRef.current;
    if (!info.subject || info.type === 'arrow') return;
    const r = ops.addMovement(b, i, { subject: info.subject, type: info.type, tip, receiverId });
    if (!r) return;
    if (!ed.commit(r.board, `draw ${info.type}`)) return;
    ed.setSel({ players: [], ball: false, movementId: r.movementId, annotationId: null });
    const who = tagOf(b, info.subject);
    const undoIt = { label: 'Undo', run: () => ed.undo() };
    if (r.replaced) ed.toast(`Replaced ${who}'s ${r.replaced.type}.`, undoIt); // MOV-007
    else if (r.movedInNext && !ed.session.current.alsoMovedShown) {
      ed.session.current.alsoMovedShown = true;
      ed.toast(`Also moved ${who} in '${b.phases[i + 1].name}'.`, undoIt); // MOV-001
    }
  };

  const finishLine = (info: LineStart, tipRaw: Pt, at: Pt) => {
    const tip = clampPt(tipRaw);
    if (dist(cam.toScreen(info.from), cam.toScreen(tip)) < MIN_LINE_PX) {
      smallHint(); // LIN-002
      return;
    }
    const b = ed.boardRef.current;
    const i = ed.phaseRef.current;
    if (!info.subject) {
      if (ops.annotationsFull(b, i)) {
        ed.toast('This phase has 60 drawings, the limit.');
        return;
      }
      const ann = ops.makeLine(info.type, info.from, tip);
      if (ed.commit(ops.addAnnotation(b, i, ann), `draw ${info.type} line`)) ed.setSel({ players: [], ball: false, movementId: null, annotationId: ann.id });
      return;
    }
    if (info.subject.kind === 'ball' && info.type === 'pass') {
      const cands = receiversNear(tip);
      if (cands.length >= 2) {
        // MOV-010: nothing commits until a choice is made; dismissing commits with no receiver.
        const r = canvasRef.current!.getBoundingClientRect();
        ed.setMenu({
          x: r.left + at.x,
          y: r.top + at.y,
          title: 'Who receives the pass?',
          items: [
            ...cands.map((id) => ({ label: describeHit(b, i, { kind: 'player', id }), run: () => commitMovement(info, tip, id) })),
            { label: 'No receiver', run: () => commitMovement(info, tip, null) },
          ],
          onDismiss: () => commitMovement(info, tip, null),
        });
        return;
      }
      commitMovement(info, tip, cands[0] ?? null); // MOV-009
      return;
    }
    commitMovement(info, tip, null);
  };

  const finishZone = (a: Pt, bRaw: Pt) => {
    const b = clampPt(bRaw);
    const board0 = ed.boardRef.current;
    const i = ed.phaseRef.current;
    if (Math.abs(a.x - b.x) < MIN_ZONE || Math.abs(a.y - b.y) < MIN_ZONE) {
      smallHint(); // ZON-002
      return;
    }
    if (ops.annotationsFull(board0, i)) {
      ed.toast('This phase has 60 drawings, the limit.');
      return;
    }
    const z = ops.makeZone(ed.zoneShape, a, b);
    if (ed.commit(ops.addAnnotation(board0, i, z), 'draw zone')) {
      ed.setSel({ players: [], ball: false, movementId: null, annotationId: z.id });
      ed.setTool('select');
    }
  };

  const openChooser = (refs: HitRef[], at: Pt, pick: (r: HitRef) => void) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const b = ed.boardRef.current;
    ed.setMenu({ x: r.left + at.x, y: r.top + at.y, title: 'Which one?', items: refs.map((ref) => ({ label: describeHit(b, ed.phaseRef.current, ref), run: () => pick(ref) })) });
  };

  const openQuickActions = (playerId: string, at: Pt) => {
    const b = ed.boardRef.current;
    const p = ops.playerById(b, playerId);
    if (!p) return;
    const r = canvasRef.current!.getBoundingClientRect();
    const i = ed.phaseRef.current;
    ed.selectRef({ kind: 'player', id: playerId });
    // PLY-013: quick actions never delete without the confirmation.
    ed.setMenu({
      x: r.left + at.x,
      y: r.top + at.y,
      title: `#${p.number}${p.name ? ` ${p.name}` : ''}`,
      items: [
        { label: 'Edit', run: () => ed.setInspectorOpen(true) },
        { label: 'Move', run: () => ed.setMoveMode(true), disabled: p.locked },
        { label: 'Give ball', run: () => ed.commit(ops.setPossession(ed.boardRef.current, i, playerId), `give ball to #${p.number}`), disabled: b.phases[i].ball.possessorId === playerId },
        {
          label: 'Duplicate',
          run: () => {
            const res = ops.duplicatePlayer(ed.boardRef.current, playerId);
            if (res && ed.commit(res.board, `duplicate #${p.number}`)) ed.selectRef({ kind: 'player', id: res.playerId });
          },
          disabled: ops.teamIsFull(b, p.teamId),
        },
        { label: p.locked ? 'Unlock' : 'Lock', run: () => ed.commit(ops.updatePlayer(ed.boardRef.current, playerId, { locked: !p.locked }), `${p.locked ? 'unlock' : 'lock'} #${p.number}`) },
        { label: 'Delete', danger: true, run: () => ed.deleteRefs([{ kind: 'player', id: playerId }]) },
      ],
    });
  };

  // ---------- gesture transitions ----------
  const beginDrag = (gs: Extract<Gesture, { mode: 'pressed' }>, p: Pt) => {
    const b0 = ed.boardRef.current;
    const i = ed.phaseRef.current;
    const ph = b0.phases[i];
    const start = cam.toCanon(gs.start);
    const delta = (cur: Pt) => {
      const q = cam.toCanon(cur);
      return { dx: q.x - start.x, dy: q.y - start.y };
    };
    const t = gs.target;
    if (t.kind === 'handle') {
      const s = ed.selRef.current;
      const h = t.handle.id;
      if (s.movementId) {
        const m = ph.movements.find((x) => x.id === s.movementId);
        if (!m) return;
        const a = ops.subjectPos(ph, m.subject);
        if (h === 'tip') {
          const owner = m.subject.kind === 'player' ? m.subject.playerId : m.carrierId;
          if (owner && ops.playerById(b0, owner)?.locked) {
            lockedHint(owner); // PLY-018
            g.current = { mode: 'idle' };
            return;
          }
          g.current = {
            mode: 'drag',
            id: gs.id,
            label: 'move line tip',
            last: null,
            apply: (cur) => {
              const tip = clampPt(cam.toCanon(cur));
              const recv = m.type === 'pass' ? (receiversNear(tip)[0] ?? null) : null;
              setSnapPoints(recv ? [ops.landingPoint(b0, i, recv)] : []);
              return ops.setMovementTip(b0, i, m.id, tip, recv); // MOV-005
            },
          };
        } else {
          const tip = ops.tipOf(b0, i, m);
          g.current = { mode: 'drag', id: gs.id, label: 'bend line', last: null, apply: (cur) => ops.updateMovement(b0, i, m.id, { bend: bendFromPoint(a, tip, cam.toCanon(cur)) }) };
        }
      } else if (s.annotationId) {
        const a = ph.annotations.find((x) => x.id === s.annotationId);
        if (!a) return;
        if (a.kind === 'line') {
          g.current = {
            mode: 'drag',
            id: gs.id,
            label: 'edit line',
            last: null,
            apply: (cur) => {
              const q = clampPt(cam.toCanon(cur));
              if (h === 'from') return ops.updateAnnotation(b0, i, a.id, { from: q });
              if (h === 'to') return ops.updateAnnotation(b0, i, a.id, { to: q });
              return ops.updateAnnotation(b0, i, a.id, { bend: bendFromPoint(a.from, a.to, q) });
            },
          };
        } else if (a.kind === 'zone') {
          g.current = { mode: 'drag', id: gs.id, label: 'resize zone', last: null, apply: (cur) => ops.updateAnnotation(b0, i, a.id, resizeZone(a, h, clampPt(cam.toCanon(cur)), shiftHeld.current)) };
        }
      }
      return;
    }
    if (t.kind === 'objects') {
      const ref = t.refs[0];
      if (ref.kind === 'player' || ref.kind === 'ball') {
        const s = ed.selRef.current;
        const inSel = ref.kind === 'ball' ? s.ball : s.players.includes(ref.id);
        const group = inSel ? { players: s.players, ball: s.ball } : { players: ref.kind === 'player' ? [ref.id] : [], ball: ref.kind === 'ball' };
        if (!inSel) ed.selectRef(ref);
        const lockedId = group.players.find((id) => ops.playerById(b0, id)?.locked);
        if (lockedId) {
          lockedHint(lockedId);
          g.current = { mode: 'idle' };
          return;
        }
        const label = group.players.length + (group.ball ? 1 : 0) > 1 ? 'move selection' : ref.kind === 'ball' ? 'move ball' : `move ${tagOf(b0, { kind: 'player', playerId: ref.id })}`;
        g.current = {
          mode: 'drag',
          id: gs.id,
          label,
          last: null,
          apply: (cur) => {
            const { dx, dy } = delta(cur);
            return ops.moveSelection(b0, i, group, dx, dy, { snapU, eligible }); // PLY-008
          },
        };
      } else if (ref.kind === 'annotation') {
        ed.selectRef(ref);
        g.current = {
          mode: 'drag',
          id: gs.id,
          label: `move ${ref.sub === 'text' ? 'label' : ref.sub}`,
          last: null,
          apply: (cur) => {
            const { dx, dy } = delta(cur);
            return ops.moveAnnotation(b0, i, ref.id, dx, dy);
          },
        };
      } else {
        ed.selectRef(ref); // a movement line starts at its subject and has no body drag
        g.current = { mode: 'idle' };
      }
      return;
    }
    if (t.kind === 'empty') {
      // 8.4: a mouse drag on empty pitch is a marquee; on touch only after a long press.
      if (!gs.touch || gs.longPressed) {
        g.current = { mode: 'marquee', id: gs.id, start: gs.start, additive: gs.additive };
        setMarquee({ a: gs.start, b: p });
      } else g.current = { mode: 'idle' };
      return;
    }
    if (t.kind === 'line') g.current = { mode: 'line', id: gs.id, info: t.info };
    else if (t.kind === 'zone') g.current = { mode: 'zone', id: gs.id, a: clampPt(cam.toCanon(gs.start)) };
    else g.current = { mode: 'idle' };
  };

  const onTap = (gs: Extract<Gesture, { mode: 'pressed' }>, p: Pt) => {
    const b = ed.boardRef.current;
    const i = ed.phaseRef.current;
    const q = clampPt(cam.toCanon(p));
    let t = gs.target;
    const curTool = ed.tool;
    if (t.kind === 'handle') {
      // A tap on a handle while a line tool is active is a tap on the pitch (tap-tap drawing, INT-009b).
      if (!isLineTool(curTool)) return;
      if (pending.current?.kind === 'line') t = { kind: 'tap' };
      else {
        const info = resolveStart(gs.start, curTool, gs.touch);
        if (!info) return;
        t = { kind: 'line', info };
      }
    }
    if (curTool === 'select') {
      if (ed.moveMode) {
        // INT-009a: Move, then tap a destination.
        const s = ed.selRef.current;
        const anchor = s.players.length ? b.phases[i].tokens[s.players[0]] : s.ball ? b.phases[i].ball : null;
        ed.setMoveMode(false);
        if (anchor) ed.commit(ops.moveSelection(b, i, { players: s.players, ball: s.ball }, q.x - anchor.x, q.y - anchor.y, { snapU, eligible }), 'move selection');
        return;
      }
      const refs = t.kind === 'objects' ? t.refs : [];
      if (!refs.length) {
        ed.clearSel();
        return;
      }
      if (refs.length > 1) {
        openChooser(refs, p, (r) => ed.selectRef(r)); // INT-012
        return;
      }
      const ref = refs[0];
      const now = performance.now();
      const id = 'id' in ref ? ref.id : 'ball';
      if (ref.kind === 'annotation' && ref.sub === 'text' && lastTap.current.id === id && now - lastTap.current.t < 400) {
        const a = b.phases[i].annotations.find((x) => x.id === ref.id);
        if (a?.kind === 'text') ed.setTextEdit({ id: a.id, at: { x: a.x, y: a.y }, text: a.text }); // TXT-005
      }
      lastTap.current = { t: now, id };
      ed.selectRef(ref, gs.additive);
      return;
    }
    if (isLineTool(curTool)) {
      // INT-009b: tap the start, then tap the tip.
      const pend = pending.current;
      if (pend?.kind === 'line') {
        pending.current = null;
        setPendingStart(null);
        finishLine(pend.info, q, p);
      } else if (t.kind === 'line') {
        pending.current = { kind: 'line', info: t.info };
        setPendingStart(t.info.from);
      }
      return;
    }
    if (curTool === 'zone') {
      const pend = pending.current;
      if (pend?.kind === 'zone') {
        pending.current = null;
        setPendingStart(null);
        finishZone(pend.a, q); // INT-009c
      } else {
        pending.current = { kind: 'zone', a: q };
        setPendingStart(q);
      }
      return;
    }
    if (curTool === 'text') {
      if (ops.annotationsFull(b, i)) ed.toast('This phase has 60 drawings, the limit.');
      else ed.setTextEdit({ id: null, at: q, text: '' }); // TXT-001
      return;
    }
    if (curTool === 'player') {
      const hit = playersAt(p, hitCtx(gs.touch))[0];
      if (hit) {
        ed.selectRef({ kind: 'player', id: hit.id }); // PLY-004
        return;
      }
      const res = ops.addPlayer(b, ed.playerTeam, q);
      if (!res) return; // PLY-005: the limit message shows in the tool options
      if (ed.commit(res.board, 'add player')) {
        ed.selectRef({ kind: 'player', id: res.playerId });
        if (b.phases.length > 1) ed.toast(`Added to all ${b.phases.length} phases`);
        if (!ed.addSeveral) {
          ed.setTool('select'); // PLY-003
          ed.setInspectorOpen(true);
        }
      }
      return;
    }
    if (curTool === 'erase') {
      const refs = hitObjects(p, hitCtx(gs.touch));
      if (refs.length > 1) openChooser(refs, p, (r) => ed.deleteRefs([r])); // ANN-002
      else if (refs.length === 1) ed.deleteRefs(refs);
    }
  };

  // ---------- pointer events ----------
  const onPointerDown = (e: React.PointerEvent) => {
    if (ed.presenting) return;
    const p = local(e);
    const touch = e.pointerType !== 'mouse';
    pointers.current.set(e.pointerId, { ...p, touch: e.pointerType === 'touch' });
    try {
      canvasRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // Capture can fail for synthetic pointers.
    }
    const touches = [...pointers.current.values()].filter((t) => t.touch);
    if (touches.length === 2) {
      // INT-006: a second finger cancels the drag, then a pinch begins.
      const keepPending = pending.current;
      cancel();
      pending.current = keepPending;
      g.current = { mode: 'pinch', d0: Math.max(1, dist(touches[0], touches[1])), c0: { x: (touches[0].x + touches[1].x) / 2, y: (touches[0].y + touches[1].y) / 2 }, view0: ed.viewRef.current, cam0: cam };
      return;
    }
    if (pointers.current.size > 1 || g.current.mode !== 'idle') return;
    if (e.button === 2) return;
    if (tool === 'pan' || spaceHeld.current || e.button === 1) {
      g.current = { mode: 'camera', id: e.pointerId, last: p };
      return;
    }
    if (ed.readOnly) return;
    if (ed.locked) {
      ed.toast('Pause to edit.'); // TRN-009
      return;
    }
    const hc = hitCtx(touch);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const press = (target: Target) => {
      g.current = { mode: 'pressed', id: e.pointerId, start: p, touch, target, longPressed: false, additive };
    };
    if (tool === 'select' || isLineTool(tool)) {
      const h = hitHandle(p, hc);
      // With a line tool, a static line's start handle stays out of the way of new lines drawn from the same spot.
      if (h && (tool === 'select' || h.id !== 'from')) {
        press({ kind: 'handle', handle: h });
        return;
      }
    }
    if (tool === 'select') {
      const refs = ed.moveMode ? [] : hitObjects(p, hc);
      press(refs.length ? { kind: 'objects', refs } : { kind: 'empty' });
      if (longPress.current) clearTimeout(longPress.current);
      longPress.current = setTimeout(() => {
        const cur = g.current;
        if (cur.mode !== 'pressed') return;
        if (cur.target.kind === 'objects' && cur.target.refs[0].kind === 'player') {
          g.current = { mode: 'idle' };
          openQuickActions(cur.target.refs[0].id, p); // PLY-013
        } else if (cur.target.kind === 'empty') cur.longPressed = true;
      }, LONG_PRESS_MS);
    } else if (isLineTool(tool)) {
      if (pending.current?.kind === 'line') press({ kind: 'tap' });
      else {
        const info = resolveStart(p, tool, touch);
        if (info) press({ kind: 'line', info });
      }
    } else if (tool === 'zone') press({ kind: 'zone' });
    else if (tool === 'erase') {
      setHighlight(hitObjects(p, hc)[0] ?? null);
      press({ kind: 'tap' });
    } else press({ kind: 'tap' });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    shiftHeld.current = e.shiftKey;
    const rec = pointers.current.get(e.pointerId);
    if (rec) {
      rec.x = p.x;
      rec.y = p.y;
    }
    const cur = g.current;
    if (cur.mode === 'pinch') {
      const touches = [...pointers.current.values()].filter((t) => t.touch);
      if (touches.length < 2) return;
      const d = Math.max(1, dist(touches[0], touches[1]));
      const c = { x: (touches[0].x + touches[1].x) / 2, y: (touches[0].y + touches[1].y) / 2 };
      const zoomed = zoomAt(cur.view0, cur.cam0, cur.c0, cur.view0.zoom * (d / cur.d0)); // PIT-005
      ed.setView(panBy(zoomed, makeCam(board, zoomed, size.W, size.H), c.x - cur.c0.x, c.y - cur.c0.y));
      return;
    }
    if (cur.mode === 'idle' || cur.id !== e.pointerId) return;
    if (cur.mode === 'pressed') {
      if (dist(p, cur.start) <= (cur.touch ? DRAG_THRESHOLD_TOUCH : DRAG_THRESHOLD_MOUSE)) return; // PARAM-06
      if (longPress.current) clearTimeout(longPress.current);
      setHighlight(null);
      beginDrag(cur, p);
    }
    const now = g.current;
    if (now.mode === 'drag') {
      now.last = now.apply(p);
      ed.setPreview(now.last);
    } else if (now.mode === 'line') {
      const to = clampPt(cam.toCanon(p));
      const b = ed.boardRef.current;
      let color = THEMES[b.pitchTheme].neutral;
      if (!now.info.subject) color = noteHex('note-1', b.pitchTheme);
      else if (now.info.subject.kind === 'player') color = teamHex(ops.teamById(b, ops.playerById(b, now.info.subject.playerId)!.teamId).color);
      setDraft({ kind: 'line', from: now.info.from, to, lineType: now.info.type, color });
      if (now.info.subject?.kind === 'ball' && now.info.type === 'pass') setSnapPoints(receiversNear(to).map((id) => ops.landingPoint(b, ed.phaseRef.current, id)));
    } else if (now.mode === 'zone') setDraft({ kind: 'zone', shape: ed.zoneShape, a: now.a, b: clampPt(cam.toCanon(p)) });
    else if (now.mode === 'marquee') setMarquee({ a: now.start, b: p });
    else if (now.mode === 'camera') {
      ed.setView(panBy(ed.viewRef.current, cam, p.x - now.last.x, p.y - now.last.y)); // PIT-006
      now.last = p;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const p = local(e);
    pointers.current.delete(e.pointerId);
    if (longPress.current) clearTimeout(longPress.current);
    const cur = g.current;
    if (cur.mode === 'pinch') {
      if ([...pointers.current.values()].filter((t) => t.touch).length < 2) g.current = { mode: 'idle' };
      return;
    }
    if (cur.mode === 'idle' || cur.id !== e.pointerId) return;
    g.current = { mode: 'idle' };
    clearOverlays();
    if (cur.mode === 'pressed') onTap(cur, p);
    else if (cur.mode === 'drag') {
      const result = cur.last;
      ed.setPreview(null);
      if (result) {
        // PLY-009: a short edge flash shows when the release point was clamped.
        const q = cam.toCanon(p);
        if (q.x < 0 || q.x > PITCH_W || q.y < 0 || q.y > PITCH_H) {
          setEdgeFlash(true);
          setTimeout(() => setEdgeFlash(false), 260);
        }
        ed.commit(result, cur.label);
      }
    } else if (cur.mode === 'line') finishLine(cur.info, cam.toCanon(p), p);
    else if (cur.mode === 'zone') finishZone(cur.a, cam.toCanon(p));
    else if (cur.mode === 'marquee') {
      const picked = marqueeSelect(cur.start, p, hitCtx(false));
      const s = ed.selRef.current;
      ed.setSel({
        players: cur.additive ? [...new Set([...s.players, ...picked.players])] : picked.players,
        ball: cur.additive ? s.ball || picked.ball : picked.ball,
        movementId: null,
        annotationId: null,
      });
      const n = picked.players.length + (picked.ball ? 1 : 0);
      if (n) ed.announce(`${n} selected`);
    }
  };

  const onPointerCancel = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const keep = pending.current;
    cancel();
    pending.current = keep;
    if (keep) setPendingStart(keep.kind === 'line' ? keep.info.from : keep.a);
  };

  // Wheel: zoom anchored at the cursor; trackpad two-finger scroll pans (8.4).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = ed.camRef.current;
      if (!c) return;
      const r = el.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      const mouseWheel = e.deltaX === 0 && Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY);
      if (e.ctrlKey || mouseWheel) ed.setView(zoomAt(ed.viewRef.current, c, at, c.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0016))));
      else ed.setView(panBy(ed.viewRef.current, c, -e.deltaX, -e.deltaY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ed]);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (ed.locked || ed.readOnly || ed.presenting) return;
    const p = local(e);
    const ref = hitObjects(p, hitCtx(false))[0];
    if (!ref) return;
    if (ref.kind === 'player') openQuickActions(ref.id, p);
    else {
      ed.selectRef(ref);
      const r = canvasRef.current!.getBoundingClientRect();
      const items = [{ label: 'Edit', run: () => ed.setInspectorOpen(true) }];
      if (ref.kind === 'ball') items.push({ label: 'Move', run: () => ed.setMoveMode(true) });
      else items.push({ label: 'Delete', run: () => (ref.kind === 'movement' ? ed.setDialog({ kind: 'deleteLine', movementId: ref.id }) : ed.deleteRefs([ref])) });
      ed.setMenu({ x: r.left + p.x, y: r.top + p.y, items });
    }
  };

  const cursorStyle = tool === 'pan' ? 'grab' : tool === 'select' ? (ed.moveMode ? 'crosshair' : 'default') : 'crosshair';
  const ph = board.phases[phaseIdx];
  const summary = `Pitch, ${ph.name}, phase ${phaseIdx + 1} of ${board.phases.length}. ${board.roster.length} players. Use the Objects panel to reach every item.`;

  return (
    <div ref={wrapRef} className={`stage ${edgeFlash ? 'edge-flash' : ''}`}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label={summary}
        style={{ cursor: cursorStyle, width: '100%', height: '100%', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={(e) => g.current.mode !== 'idle' && g.current.mode !== 'pinch' && 'id' in g.current && g.current.id === e.pointerId && pointers.current.has(e.pointerId) && onPointerCancel(e)}
        onContextMenu={onContextMenu}
        onFocus={() => {
          // ACC-005: tabbing into the canvas focuses the selection or the first player.
          const s = ed.selRef.current;
          if (!s.players.length && !s.ball && !s.movementId && !s.annotationId && board.roster.length && !ed.presenting) {
            const first = board.roster.find((pl) => teamMode(board, view.focus, pl.teamId) === 'show');
            if (first && document.activeElement?.matches(':focus-visible')) ed.selectRef({ kind: 'player', id: first.id });
          }
        }}
      />
    </div>
  );
}

function resizeZone(z: ZoneAnn, handle: string, q: Pt, keepAspect = false): Partial<ZoneAnn> {
  let x0 = z.x;
  let y0 = z.y;
  let x1 = z.x + z.w;
  let y1 = z.y + z.h;
  if (handle.includes('w')) x0 = Math.min(q.x, x1 - MIN_ZONE);
  if (handle.includes('e')) x1 = Math.max(q.x, x0 + MIN_ZONE);
  if (handle.includes('n')) y0 = Math.min(q.y, y1 - MIN_ZONE);
  if (handle.includes('s')) y1 = Math.max(q.y, y0 + MIN_ZONE);
  if (keepAspect && handle.length === 2) {
    // Corner handle with Shift: keep the zone's proportions, anchored at the opposite corner.
    const ratio = z.w / z.h;
    let w = x1 - x0;
    let h = y1 - y0;
    if (w / h > ratio) w = h * ratio;
    else h = w / ratio;
    if (handle.includes('w')) x0 = x1 - w;
    else x1 = x0 + w;
    if (handle.includes('n')) y0 = y1 - h;
    else y1 = y0 + h;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
