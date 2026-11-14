// Playback model, PRD section 4.4 and 9.12. Pure functions: nothing here changes a board (CORE-007).
import type { Board, Movement, Phase, Pt } from './types';
import { FADE_MS } from './params';
import { clamp, easeInOut, makePath, pointAtFraction } from './geometry';
import { ballMovement, lastIdx, playerMovement } from './ops';

export interface Scene {
  tokens: Record<string, Pt>;
  ball: { x: number; y: number; alpha: number; possessorId: string | null };
}

export function sceneAtPhase(board: Board, i: number): Scene {
  const ph = board.phases[clamp(i, 0, lastIdx(board))];
  return { tokens: ph.tokens, ball: { x: ph.ball.x, y: ph.ball.y, alpha: ph.ball.visible ? 1 : 0, possessorId: ph.ball.possessorId } };
}

function progress(t: number, m: Movement | undefined, easing: Phase['transition']['easing']): number {
  const start = m ? m.start : 0; // MOV-006: implied movements always use 0 to 1
  const end = m ? m.end : 1;
  const p = clamp((t - start) / (end - start), 0, 1);
  return easing === 'easeInOut' ? easeInOut(p) : p;
}

function along(a: Pt, b: Pt, m: Movement | undefined, t: number, easing: Phase['transition']['easing']): Pt {
  if (a.x === b.x && a.y === b.y) return a;
  return pointAtFraction(makePath(a, b, m ? m.bend : 0), progress(t, m, easing));
}

// Scene at fraction t (0 to 1) of the transition from phase i to phase i + 1.
export function sceneInTransition(board: Board, i: number, t: number): Scene {
  if (i >= lastIdx(board) || t <= 0) return sceneAtPhase(board, i);
  if (t >= 1) return sceneAtPhase(board, i + 1); // step 5: exact coordinates at t = 1
  const a = board.phases[i];
  const b = board.phases[i + 1];
  const easing = a.transition.easing;
  const tokens: Record<string, Pt> = {};
  for (const id of Object.keys(a.tokens)) tokens[id] = along(a.tokens[id], b.tokens[id] ?? a.tokens[id], playerMovement(a, id), t, easing);

  const bm = ballMovement(a);
  let ball: Pt;
  let possessorId: string | null = null;
  // The ball stays beside a player who holds it in both phases (carry, or no ball line at all).
  const holder = bm ? (bm.type === 'carry' ? bm.carrierId : null) : a.ball.possessorId && a.ball.possessorId === b.ball.possessorId ? a.ball.possessorId : null;
  if (holder && tokens[holder]) {
    const k = progress(t, playerMovement(a, holder), easing);
    const o0 = { x: a.ball.x - a.tokens[holder].x, y: a.ball.y - a.tokens[holder].y };
    const o1 = { x: b.ball.x - b.tokens[holder].x, y: b.ball.y - b.tokens[holder].y };
    ball = { x: tokens[holder].x + o0.x + (o1.x - o0.x) * k, y: tokens[holder].y + o0.y + (o1.y - o0.y) * k };
    possessorId = holder;
  } else ball = along(a.ball, b.ball, bm, t, easing);

  // BAL-008: visibility changes fade at the start (hiding) or at the end (showing).
  const f = Math.min(1, FADE_MS / a.transition.durationMs);
  let alpha = a.ball.visible ? 1 : 0;
  if (a.ball.visible && !b.ball.visible) alpha = 1 - clamp(t / f, 0, 1);
  else if (!a.ball.visible && b.ball.visible) alpha = clamp((t - (1 - f)) / f, 0, 1);
  return { tokens, ball: { x: ball.x, y: ball.y, alpha, possessorId } };
}

export interface Segment {
  phase: number;
  kind: 'hold' | 'move';
  t0: number;
  t1: number;
}
export interface Timeline {
  from: number;
  to: number;
  segs: Segment[];
  total: number;
}

// TRN-003: each phase holds, then its transition runs. Times are at 1x speed.
export function buildTimeline(board: Board, from = 0, to = lastIdx(board), holdMs = board.settings.holdMs): Timeline {
  const segs: Segment[] = [];
  let t = 0;
  for (let i = from; i <= to; i++) {
    segs.push({ phase: i, kind: 'hold', t0: t, t1: t + holdMs });
    t += holdMs;
    if (i < to) {
      const d = board.phases[i].transition.durationMs;
      segs.push({ phase: i, kind: 'move', t0: t, t1: t + d });
      t += d;
    }
  }
  return { from, to, segs, total: t };
}

export const phaseStart = (tl: Timeline, phase: number) => tl.segs.find((s) => s.phase === phase && s.kind === 'hold')?.t0 ?? 0;

export interface Frame {
  scene: Scene;
  phase: number; // the phase whose drawings show
  kind: 'hold' | 'move';
  t: number; // transition progress, 0 during a hold
  atRest: boolean;
  lineAlpha: number; // TRN-015
  trail: boolean;
}

export function frameAt(board: Board, tl: Timeline, ms: number, stepped = false): Frame {
  const time = clamp(ms, 0, tl.total);
  let seg = tl.segs[tl.segs.length - 1];
  for (const s of tl.segs) {
    if (time < s.t1) {
      seg = s;
      break;
    }
  }
  const mode = board.settings.linesDuringPlayback;
  if (seg.kind === 'hold') {
    const since = time - seg.t0;
    const fadeIn = mode === 'keep' || seg.phase === tl.from ? 1 : clamp(since / FADE_MS, 0, 1);
    return { scene: sceneAtPhase(board, seg.phase), phase: seg.phase, kind: 'hold', t: 0, atRest: true, lineAlpha: fadeIn, trail: false };
  }
  const span = seg.t1 - seg.t0;
  const t = span <= 0 ? 1 : (time - seg.t0) / span;
  const lineAlpha = mode === 'keep' ? 1 : mode === 'trail' ? 0 : 1 - clamp((time - seg.t0) / FADE_MS, 0, 1);
  // TRN-016: with reduced motion, phases step instead of animating.
  const scene = stepped ? sceneAtPhase(board, t < 0.5 ? seg.phase : seg.phase + 1) : sceneInTransition(board, seg.phase, t);
  return { scene, phase: seg.phase, kind: 'move', t, atRest: false, lineAlpha, trail: mode === 'trail' };
}

// MOV-016: a pass that ends well before its receiver's run ends.
export function passArrivesEarly(ph: Phase, m: Movement): boolean {
  if (m.type !== 'pass' || !m.receiverId) return false;
  const run = playerMovement(ph, m.receiverId);
  return !!run && run.end - m.end > 0.1 + 1e-9;
}

// MOV-017: a ball movement that starts or ends with the ball hidden.
export function ballHiddenOnMove(board: Board, i: number, m: Movement): boolean {
  if (m.subject.kind !== 'ball') return false;
  const next = i < lastIdx(board) ? board.phases[i + 1] : null;
  return !board.phases[i].ball.visible || (next !== null && !next.ball.visible);
}
