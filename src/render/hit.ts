// Hit testing in screen space (INT-010 to INT-013). Hidden and ghosted objects are never candidates.
import type { Board, Pt, Selection } from '../domain/types';
import { HIT_RADIUS_PX } from '../domain/params';
import { dist, distToPolyline } from '../domain/geometry';
import { playerById, playerLabel, teamById } from '../domain/ops';
import type { Cam, Focus } from './camera';
import { ballRadius, handlesFor, movementPath, playerMode, screenPath, textBox, tokenRadius, type Handle, type HitRef } from './draw';

export interface HitCtx {
  board: Board;
  phaseIdx: number;
  cam: Cam;
  focus: Focus;
  selection: Selection;
  showLines: boolean;
  touch: boolean;
}

export function hitHandle(pt: Pt, c: HitCtx): Handle | null {
  let best: Handle | null = null;
  let bestD = HIT_RADIUS_PX; // PARAM-08
  for (const h of handlesFor(c.board, c.phaseIdx, c.selection, c.cam)) {
    const d = dist(pt, h);
    if (d <= bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

// When one candidate is clearly the one meant, skip the chooser.
function narrow<T extends { d: number }>(list: T[], inner: number): T[] {
  if (list.length < 2) return list;
  list.sort((a, b) => a.d - b.d);
  const inside = list.filter((x) => x.d <= inner);
  if (inside.length === 1) return inside;
  if (list[0].d < list[1].d * 0.6) return [list[0]];
  return inside.length > 1 ? inside : list;
}

export function playersAt(pt: Pt, c: HitCtx): { id: string; d: number }[] {
  const ph = c.board.phases[c.phaseIdx];
  const r = tokenRadius(c.cam);
  const reach = Math.max(r, HIT_RADIUS_PX);
  const out: { id: string; d: number }[] = [];
  for (const p of c.board.roster) {
    if (playerMode(c.board, c.focus, p) !== 'show') continue;
    const d = dist(pt, c.cam.toScreen(ph.tokens[p.id]));
    if (d <= reach) out.push({ id: p.id, d });
  }
  return narrow(out, r);
}

// INT-011 priority: text labels, ball, players, movement lines, static lines, zones.
// Returns every candidate at the highest priority that has one; two or more open the chooser (INT-012).
export function hitObjects(pt: Pt, c: HitCtx): HitRef[] {
  const { board, cam } = c;
  const ph = board.phases[c.phaseIdx];
  const texts = ph.annotations.filter((a) => {
    if (a.kind !== 'text') return false;
    const b = textBox(a, cam);
    return pt.x >= b.x - 4 && pt.x <= b.x + b.w + 4 && pt.y >= b.y - 4 && pt.y <= b.y + b.h + 4;
  });
  if (texts.length) return texts.reverse().map((a) => ({ kind: 'annotation', id: a.id, sub: 'text' }) as HitRef);

  const dBall = dist(pt, cam.toScreen(ph.ball));
  if (dBall <= ballRadius(cam) + 2) return [{ kind: 'ball' }]; // INT-013
  const players = playersAt(pt, c);
  if (players.length) return players.map((p) => ({ kind: 'player', id: p.id }));
  if (dBall <= HIT_RADIUS_PX) return [{ kind: 'ball' }];

  const tol = c.touch ? 21 : 13;
  if (c.showLines) {
    const moves: { ref: HitRef; d: number }[] = [];
    for (const m of ph.movements) {
      if (m.subject.kind === 'player') {
        const p = playerById(board, m.subject.playerId);
        if (!p || playerMode(board, c.focus, p) !== 'show') continue;
      } else if (m.type === 'carry') continue;
      const d = distToPolyline(pt, movementPath(board, c.phaseIdx, m, cam));
      if (d <= tol) moves.push({ ref: { kind: 'movement', id: m.id }, d });
    }
    if (moves.length) return narrow(moves, tol * 0.4).map((x) => x.ref);
    const lines: { ref: HitRef; d: number }[] = [];
    for (const a of ph.annotations) {
      if (a.kind !== 'line') continue;
      const d = distToPolyline(pt, screenPath(cam, a.from, a.to, a.bend));
      if (d <= tol) lines.push({ ref: { kind: 'annotation', id: a.id, sub: 'line' }, d });
    }
    if (lines.length) return narrow(lines, tol * 0.4).map((x) => x.ref);
  }
  const q = cam.toCanon(pt);
  const zones = ph.annotations.filter((a) => {
    if (a.kind !== 'zone') return false;
    if (a.shape === 'rect') return q.x >= a.x && q.x <= a.x + a.w && q.y >= a.y && q.y <= a.y + a.h;
    const nx = (q.x - (a.x + a.w / 2)) / (a.w / 2);
    const ny = (q.y - (a.y + a.h / 2)) / (a.h / 2);
    return nx * nx + ny * ny <= 1;
  });
  return zones.reverse().map((a) => ({ kind: 'annotation', id: a.id, sub: 'zone' }) as HitRef);
}

export function describeHit(board: Board, phaseIdx: number, ref: HitRef): string {
  const ph = board.phases[phaseIdx];
  if (ref.kind === 'ball') return 'Ball';
  if (ref.kind === 'player') {
    const p = playerById(board, ref.id);
    return p ? `${teamById(board, p.teamId).name} ${playerLabel(p)}` : 'Player';
  }
  if (ref.kind === 'movement') {
    const m = ph.movements.find((x) => x.id === ref.id);
    if (!m) return 'Line';
    const who = m.subject.kind === 'ball' ? 'ball' : (() => {
      const p = playerById(board, m.subject.playerId);
      return p ? `#${p.number}` : 'player';
    })();
    return `${m.type[0].toUpperCase()}${m.type.slice(1)} from ${who}${m.label ? ` "${m.label}"` : ''}`;
  }
  if (ref.kind === 'annotation') {
    const a = ph.annotations.find((x) => x.id === ref.id);
    if (!a) return 'Drawing';
    if (a.kind === 'line') return `${a.lineType[0].toUpperCase()}${a.lineType.slice(1)} line${a.label ? ` "${a.label}"` : ''}`;
    if (a.kind === 'zone') return `${a.shape === 'rect' ? 'Rectangle' : 'Ellipse'} zone${a.label ? ` "${a.label}"` : ''}`;
    return `Label "${a.text.split('\n')[0]}"`;
  }
  return 'Handle';
}

// PLY-021: players and the ball inside a marquee. Annotations are excluded.
export function marqueeSelect(a: Pt, b: Pt, c: HitCtx): { players: string[]; ball: boolean } {
  const ph = c.board.phases[c.phaseIdx];
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  const inside = (p: Pt) => {
    const s = c.cam.toScreen(p);
    return s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1;
  };
  return {
    players: c.board.roster.filter((p) => playerMode(c.board, c.focus, p) === 'show' && inside(ph.tokens[p.id])).map((p) => p.id),
    ball: inside(ph.ball),
  };
}
