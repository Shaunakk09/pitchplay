// One renderer for the editor, thumbnails, present mode and every export (EXP-019).
import type { Annotation, Board, LineAnn, LineType, Movement, Player, Pt, Selection, TextAnn, ZoneAnn } from '../domain/types';
import { BALL_D, BALL_MIN_PX, GHOST_OPACITY, PITCH_H, PITCH_W, TOKEN_D, TOKEN_MIN_PX } from '../domain/params';
import { controlPoint, dist, makePath, quadAt } from '../domain/geometry';
import { lastIdx, playerById, subjectPos, teamById, tipOf } from '../domain/ops';
import type { Scene } from '../domain/playback';
import { TEMPLATES } from '../domain/presets';
import type { Cam, Focus } from './camera';
import { ACCENT, NUMBER_FONT, TEXT_FONT, THEMES, inkOn, noteHex, teamHex, type ThemeColors } from './themes';

export type HitRef =
  | { kind: 'player'; id: string }
  | { kind: 'ball' }
  | { kind: 'movement'; id: string }
  | { kind: 'annotation'; id: string; sub: 'line' | 'zone' | 'text' }
  | { kind: 'handle'; id: string };

export type Draft =
  | { kind: 'line'; from: Pt; to: Pt; lineType: LineType; color: string }
  | { kind: 'zone'; shape: 'rect' | 'ellipse'; a: Pt; b: Pt };

export interface EditorOverlay {
  selection: Selection;
  draft?: Draft | null;
  marquee?: { a: Pt; b: Pt } | null; // screen px
  snapPoints?: Pt[]; // canonical
  highlight?: HitRef | null;
  pendingStart?: Pt | null; // canonical, first tap of a tap-tap line or zone
}

export interface DrawOpts {
  board: Board;
  phaseIdx: number;
  scene: Scene;
  cam: Cam;
  dpr: number;
  focus: Focus;
  showLines: boolean;
  lineAlpha?: number;
  trailFrom?: Scene | null;
  editor?: EditorOverlay | null;
  thumb?: boolean; // phase and library thumbnails: tokens at true scale, no numbers or labels
}

export const tokenRadius = (cam: Cam) => Math.max(TOKEN_MIN_PX / 2, (TOKEN_D / 2) * cam.s);
export const ballRadius = (cam: Cam) => Math.max(BALL_MIN_PX / 2, (BALL_D / 2) * cam.s);
const lineWidth = (cam: Cam) => Math.max(2, 3.4 * cam.s);

// TFM-001 to TFM-003
export function teamMode(board: Board, focus: Focus, teamId: string): 'show' | 'ghost' | 'hide' {
  if (focus === 'both') return 'show';
  const primary = teamId === board.primaryTeamId;
  if (focus === 'ghost') return primary ? 'show' : 'ghost';
  if (focus === 'primary') return primary ? 'show' : 'hide';
  return primary ? 'hide' : 'show';
}
export const playerMode = (board: Board, focus: Focus, p: Player) => teamMode(board, focus, p.teamId);

// ---------- geometry in screen space ----------

export function screenPath(cam: Cam, a: Pt, b: Pt, bend: number): Pt[] {
  return makePath(a, b, bend, 28).pts.map(cam.toScreen);
}
export function movementPath(board: Board, i: number, m: Movement, cam: Cam): Pt[] {
  return screenPath(cam, subjectPos(board.phases[i], m.subject), tipOf(board, i, m), m.bend);
}
export const bendHandle = (a: Pt, b: Pt, bend: number): Pt => quadAt(a, controlPoint(a, b, bend), b, 0.5);

function trim(pts: Pt[], head: number, tail: number): Pt[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  if (total <= head + tail + 2) return pts;
  const at = (d: number): Pt => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const k = (d - cum[i - 1]) / seg;
    return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k };
  };
  const out = [at(head)];
  for (let i = 0; i < pts.length; i++) if (cum[i] > head && cum[i] < total - tail) out.push(pts[i]);
  out.push(at(total - tail));
  return out;
}

function endDir(pts: Pt[]): Pt {
  const e = pts[pts.length - 1];
  let k = pts.length - 2;
  while (k > 0 && dist(pts[k], e) < 8) k--;
  const d = dist(pts[k], e) || 1;
  return { x: (e.x - pts[k].x) / d, y: (e.y - pts[k].y) / d };
}

function poly(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
}

function wavy(pts: Pt[], amp: number, wave: number, calm: number): Pt[] {
  const out: Pt[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const L = dist(a, b);
    if (L === 0) continue;
    const nx = -(b.y - a.y) / L;
    const ny = (b.x - a.x) / L;
    for (let s = 0; s < L; s += 2) {
      const dd = d + s;
      const fade = Math.min(1, dd / 8, Math.max(0, total - calm - dd) / 8);
      const o = Math.sin((dd / wave) * Math.PI * 2) * amp * fade;
      out.push({ x: a.x + ((b.x - a.x) * s) / L + nx * o, y: a.y + ((b.y - a.y) * s) / L + ny * o });
    }
    d += L;
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// LIN-012: run dashed, pass solid, carry wavy, shot thick with a target end, arrow thin with an open head.
// `under` paints a soft edge in a contrasting color first, so team colors read on every pitch theme.
export function drawStyledLine(ctx: CanvasRenderingContext2D, pts: Pt[], type: LineType, color: string, w: number, selected = false, under?: string) {
  if (pts.length < 2) return;
  const head = type === 'arrow' ? w * 3.2 : type === 'shot' ? w * 4 : w * 3.4;
  const e = pts[pts.length - 1];
  const u = endDir(pts);
  const trimmed = type === 'arrow' ? pts : trim(pts, 0, head * 0.8);
  const body = type === 'carry' ? wavy(trimmed, w * 1.5, w * 6, head * 0.4) : trimmed;
  const base = type === 'shot' ? w * 1.7 : type === 'arrow' ? w * 0.75 : w;
  const hw = head * 0.52;
  const bx = e.x - u.x * head;
  const by = e.y - u.y * head;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (selected) {
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.globalAlpha *= 0.45;
    ctx.lineWidth = w + 8;
    poly(ctx, pts);
    ctx.stroke();
    ctx.restore();
  }
  const paint = (col: string, extra: number) => {
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = base + extra;
    if (type === 'run') ctx.setLineDash([w * 2.6, w * 2.4]);
    poly(ctx, body);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(bx - u.y * hw, by + u.x * hw);
    ctx.lineTo(e.x, e.y);
    ctx.lineTo(bx + u.y * hw, by - u.x * hw);
    if (type === 'arrow') ctx.stroke();
    else {
      ctx.closePath();
      ctx.fill();
      if (extra) {
        ctx.lineWidth = extra;
        ctx.stroke();
      }
    }
    if (type === 'shot') {
      ctx.lineWidth = Math.max(1.5, w * 0.6) + extra;
      ctx.beginPath();
      ctx.arc(e.x, e.y, head * 0.75, 0, Math.PI * 2);
      ctx.stroke();
    }
  };
  if (under) {
    ctx.save();
    ctx.globalAlpha *= 0.5;
    paint(under, 3);
    ctx.restore();
  }
  paint(color, 0);
  ctx.restore();
}

function haloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, halo: string) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = halo;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function lineLabel(ctx: CanvasRenderingContext2D, pts: Pt[], label: string, color: string, halo: string, cam: Cam) {
  if (!label) return;
  const mid = pts[Math.floor(pts.length / 2)];
  const prev = pts[Math.max(0, Math.floor(pts.length / 2) - 1)];
  const d = dist(mid, prev) || 1;
  const off = Math.max(11, 9 * cam.s + 8);
  const px = Math.max(11, Math.min(18, 15 * cam.s + 4));
  ctx.save();
  ctx.font = `600 ${px}px ${TEXT_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  haloText(ctx, label, mid.x + (-(mid.y - prev.y) / d) * off, mid.y + ((mid.x - prev.x) / d) * off, color, halo);
  ctx.restore();
}

// ---------- text labels ----------

const TEXT_U = { s: 15, m: 21, l: 30 };
let measureCtx: CanvasRenderingContext2D | null = null;

export interface TextBox {
  x: number;
  y: number;
  w: number;
  h: number;
  px: number;
  lines: string[];
}

export function textBox(a: TextAnn, cam: Cam): TextBox {
  const px = Math.max(11, TEXT_U[a.size] * cam.s);
  const lines = a.text.split('\n');
  let w = Math.max(...lines.map((l) => l.length)) * px * 0.58;
  if (typeof document !== 'undefined') {
    measureCtx ??= document.createElement('canvas').getContext('2d');
    if (measureCtx) {
      measureCtx.font = `600 ${px}px ${TEXT_FONT}`;
      w = Math.max(...lines.map((l) => measureCtx!.measureText(l).width));
    }
  }
  const pad = px * 0.35;
  const h = lines.length * px * 1.25 + pad * 2;
  const s = cam.toScreen(a);
  const x = a.align === 'center' ? s.x - w / 2 - pad : s.x - pad;
  return { x, y: s.y - h / 2, w: w + pad * 2, h, px, lines };
}

// ---------- pitch ----------

function drawPitch(ctx: CanvasRenderingContext2D, board: Board, cam: Cam, th: ThemeColors) {
  const t = TEMPLATES[board.pitchTemplate];
  const lw = Math.max(1.3, 1.6 * cam.s) / cam.s;
  ctx.fillStyle = th.pitch;
  ctx.fillRect(0, 0, PITCH_W, PITCH_H);
  if (th.stripe !== th.pitch) {
    ctx.fillStyle = th.stripe;
    for (let k = 0; k < 10; k += 2) ctx.fillRect(k * 100, 0, 100, PITCH_H);
  }
  ctx.strokeStyle = th.line;
  ctx.fillStyle = th.line;
  ctx.lineWidth = lw;
  ctx.lineJoin = 'miter';
  ctx.strokeRect(0, 0, PITCH_W, PITCH_H);
  ctx.beginPath();
  ctx.moveTo(500, 0);
  ctx.lineTo(500, PITCH_H);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(500, 320, t.circleR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(500, 320, lw * 1.6, 0, Math.PI * 2);
  ctx.fill();
  for (const right of [false, true]) {
    const X = (x: number) => (right ? PITCH_W - x : x);
    if (t.penaltyArea) ctx.strokeRect(Math.min(X(0), X(t.penaltyArea.x)), t.penaltyArea.y0, t.penaltyArea.x, t.penaltyArea.y1 - t.penaltyArea.y0);
    if (t.goalArea) ctx.strokeRect(Math.min(X(0), X(t.goalArea.x)), t.goalArea.y0, t.goalArea.x, t.goalArea.y1 - t.goalArea.y0);
    if (t.penaltySpot !== null) {
      ctx.beginPath();
      ctx.arc(X(t.penaltySpot), 320, lw * 1.4, 0, Math.PI * 2);
      ctx.fill();
      if (t.arcR && t.penaltyArea) {
        const a = Math.acos((t.penaltyArea.x - t.penaltySpot) / t.arcR);
        ctx.beginPath();
        if (right) ctx.arc(X(t.penaltySpot), 320, t.arcR, Math.PI - a, Math.PI + a);
        else ctx.arc(t.penaltySpot, 320, t.arcR, -a, a);
        ctx.stroke();
      }
    }
    // Goal frame, 20 u deep inside the render margin.
    ctx.strokeRect(right ? PITCH_W : -20, t.goal.y0, 20, t.goal.y1 - t.goal.y0);
    if (t.cornerR) {
      for (const bottom of [false, true]) {
        const start = right ? (bottom ? Math.PI : Math.PI / 2) : bottom ? -Math.PI / 2 : 0;
        ctx.beginPath();
        ctx.arc(X(0), bottom ? PITCH_H : 0, t.cornerR, start, start + Math.PI / 2);
        ctx.stroke();
      }
    }
  }
}

// ---------- tokens and ball ----------

export function drawToken(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  o: { color: string; marker: 'solid' | 'outlined'; number: number; gk: boolean; locked: boolean; name: string; ghost: boolean; selected: boolean; possession: boolean; th: ThemeColors },
) {
  ctx.save();
  if (o.ghost) ctx.globalAlpha *= GHOST_OPACITY; // PARAM-18
  if (o.gk) {
    ctx.beginPath();
    ctx.arc(x, y, r + Math.max(2.5, r * 0.26), 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.5, r * 0.13);
    ctx.strokeStyle = o.color;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = o.marker === 'solid' ? o.color : o.th.tokenBase;
  ctx.fill();
  if (o.marker === 'outlined') {
    ctx.beginPath();
    ctx.arc(x, y, r * 0.82, 0, Math.PI * 2);
    ctx.lineWidth = r * 0.3;
    ctx.strokeStyle = o.color;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = o.th.outline;
  if (o.ghost) ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = o.marker === 'solid' ? inkOn(o.color) : '#14201A';
  ctx.font = `700 ${Math.round(r * (o.number > 9 ? 0.9 : 1.05))}px ${NUMBER_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (r >= 6) ctx.fillText(String(o.number), x, y + r * 0.06);
  if (o.possession) {
    ctx.beginPath();
    ctx.arc(x, y, r + 3.5, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = o.th.neutral;
    ctx.setLineDash([2, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (o.locked) {
    const br = Math.max(5, r * 0.42);
    const bx = x + r * 0.78;
    const by = y - r * 0.78;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = '#14201A';
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(bx - br * 0.45, by - br * 0.1, br * 0.9, br * 0.6);
    ctx.beginPath();
    ctx.arc(bx, by - br * 0.1, br * 0.3, Math.PI, 0);
    ctx.lineWidth = Math.max(1, br * 0.2);
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();
  }
  if (o.selected) {
    ctx.beginPath();
    ctx.arc(x, y, r + 5, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = ACCENT;
    ctx.stroke();
  }
  if (o.name) {
    const label = o.name.length > 12 ? `${o.name.slice(0, 12)}…` : o.name; // BRD-021
    ctx.font = `600 ${Math.max(10, Math.min(13, r * 0.8))}px ${TEXT_FONT}`;
    ctx.textBaseline = 'top';
    haloText(ctx, label, x, y + r + 4, o.th.neutral, o.th.halo);
  }
  ctx.restore();
}

function drawBall(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number, selected: boolean, th: ThemeColors) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.lineWidth = Math.max(1.25, r * 0.22);
  ctx.strokeStyle = '#14201A';
  ctx.stroke();
  ctx.beginPath();
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + (k * Math.PI * 2) / 5;
    ctx.lineTo(x + Math.cos(a) * r * 0.42, y + Math.sin(a) * r * 0.42);
  }
  ctx.closePath();
  ctx.fillStyle = '#14201A';
  ctx.fill();
  if (selected) {
    ctx.beginPath();
    ctx.arc(x, y, r + 5, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = ACCENT;
    ctx.stroke();
  }
  ctx.restore();
}

// ---------- annotations ----------

function drawZone(ctx: CanvasRenderingContext2D, z: ZoneAnn, cam: Cam, board: Board, th: ThemeColors, selected: boolean) {
  const a = cam.toScreen({ x: z.x, y: z.y });
  const b = cam.toScreen({ x: z.x + z.w, y: z.y + z.h });
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  const color = noteHex(z.fill, board.pitchTheme);
  ctx.save();
  ctx.beginPath();
  if (z.shape === 'rect') ctx.rect(x, y, w, h);
  else ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.globalAlpha *= z.opacity;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha /= z.opacity;
  if (z.outline !== 'none' || selected) {
    ctx.lineWidth = selected ? 2.5 : 2;
    ctx.strokeStyle = selected ? ACCENT : color;
    if (z.outline === 'dashed' && !selected) ctx.setLineDash([7, 5]);
    ctx.stroke();
  }
  if (z.label) {
    ctx.font = `600 ${Math.max(11, Math.min(18, 16 * cam.s + 4))}px ${TEXT_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    haloText(ctx, z.label, x + w / 2, y + h / 2, th.neutral, th.halo);
  }
  ctx.restore();
}

function drawText(ctx: CanvasRenderingContext2D, a: TextAnn, cam: Cam, board: Board, th: ThemeColors, selected: boolean) {
  const box = textBox(a, cam);
  const color = noteHex(a.color, board.pitchTheme);
  ctx.save();
  if (a.background) {
    ctx.fillStyle = th.halo;
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, 5);
    ctx.fill();
  }
  if (selected) {
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.strokeRect(box.x - 2, box.y - 2, box.w + 4, box.h + 4);
  }
  ctx.font = `600 ${box.px}px ${TEXT_FONT}`;
  ctx.textAlign = a.align === 'center' ? 'center' : 'left';
  ctx.textBaseline = 'middle';
  const pad = box.px * 0.35;
  const tx = a.align === 'center' ? box.x + box.w / 2 : box.x + pad;
  box.lines.forEach((line, k) => {
    const ty = box.y + pad + box.px * 1.25 * (k + 0.5);
    // SEC-003: fillText draws plain text only, never markup.
    if (a.background) {
      ctx.fillStyle = color;
      ctx.fillText(line, tx, ty);
    } else haloText(ctx, line, tx, ty, color, th.halo);
  });
  ctx.restore();
}

// ---------- handles ----------

export interface Handle {
  id: string;
  x: number;
  y: number;
}

export function zoneHandlePoints(z: ZoneAnn): Record<string, Pt> {
  const { x, y, w, h } = z;
  return {
    nw: { x, y },
    n: { x: x + w / 2, y },
    ne: { x: x + w, y },
    e: { x: x + w, y: y + h / 2 },
    se: { x: x + w, y: y + h },
    s: { x: x + w / 2, y: y + h },
    sw: { x, y: y + h },
    w: { x, y: y + h / 2 },
  };
}

export function handlesFor(board: Board, i: number, sel: Selection, cam: Cam): Handle[] {
  const ph = board.phases[i];
  const out: Handle[] = [];
  const push = (id: string, p: Pt) => {
    const s = cam.toScreen(p);
    out.push({ id, x: s.x, y: s.y });
  };
  if (sel.movementId) {
    const m = ph.movements.find((x) => x.id === sel.movementId);
    if (m) {
      const a = subjectPos(ph, m.subject);
      const b = tipOf(board, i, m);
      push('tip', b);
      push('bend', bendHandle(a, b, m.bend));
    }
  }
  if (sel.annotationId) {
    const a = ph.annotations.find((x) => x.id === sel.annotationId);
    if (a?.kind === 'line') {
      push('from', a.from);
      push('to', a.to);
      push('bend', bendHandle(a.from, a.to, a.bend));
    } else if (a?.kind === 'zone') {
      for (const [id, p] of Object.entries(zoneHandlePoints(a))) push(id, p);
    }
  }
  return out;
}

function drawHandles(ctx: CanvasRenderingContext2D, hs: Handle[]) {
  for (const h of hs) {
    ctx.beginPath();
    if (h.id === 'bend') {
      ctx.moveTo(h.x, h.y - 8);
      ctx.lineTo(h.x + 8, h.y);
      ctx.lineTo(h.x, h.y + 8);
      ctx.lineTo(h.x - 8, h.y);
      ctx.closePath();
    } else if (h.id.length <= 2) ctx.rect(h.x - 5.5, h.y - 5.5, 11, 11);
    else ctx.arc(h.x, h.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = ACCENT;
    ctx.stroke();
  }
}

// ---------- scene ----------

export function lineTypesUsed(board: Board, phases: number[]): LineType[] {
  const seen = new Set<LineType>();
  for (const i of phases) {
    const ph = board.phases[i];
    if (!ph) continue;
    ph.movements.forEach((m) => seen.add(m.type));
    ph.annotations.forEach((a) => a.kind === 'line' && seen.add(a.lineType));
  }
  return (['run', 'pass', 'carry', 'shot', 'arrow'] as LineType[]).filter((t) => seen.has(t));
}

export function drawScene(ctx: CanvasRenderingContext2D, o: DrawOpts): void {
  const { board, cam, dpr, scene } = o;
  const i = Math.min(o.phaseIdx, lastIdx(board));
  const ph = board.phases[i];
  const th = THEMES[board.pitchTheme];
  const ed = o.editor ?? null;
  const sel = ed?.selection;
  const m = cam.matrix;
  const lineAlpha = o.showLines ? (o.lineAlpha ?? 1) : 0;
  const atRest = scene.tokens === ph.tokens;
  const r = o.thumb ? Math.max(2.4, (TOKEN_D / 2) * cam.s * 1.7) : tokenRadius(cam);
  const br = o.thumb ? Math.max(1.6, (BALL_D / 2) * cam.s * 1.7) : ballRadius(cam);
  const lw = o.thumb ? Math.max(1.2, 3.4 * cam.s) : lineWidth(cam);
  const hot = (ref: HitRef) => {
    const h = ed?.highlight;
    if (!h || h.kind !== ref.kind) return false;
    return h.kind === 'ball' || (h as { id: string }).id === (ref as { id: string }).id;
  };

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = th.margin;
  ctx.fillRect(0, 0, cam.W, cam.H);
  // PIT-004: nothing outside the crop is drawn; shapes crossing the edge are clipped.
  ctx.setTransform(dpr * m[0], dpr * m[1], dpr * m[2], dpr * m[3], dpr * m[4], dpr * m[5]);
  ctx.beginPath();
  ctx.rect(cam.region.x0, cam.region.y0, cam.region.x1 - cam.region.x0, cam.region.y1 - cam.region.y0);
  ctx.clip();
  drawPitch(ctx, board, cam, th);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // ANN-004 layer order: zones, static lines, movement lines, players, ball, text, selection.
  for (const a of ph.annotations) if (a.kind === 'zone') drawZone(ctx, a, cam, board, th, sel?.annotationId === a.id || hot({ kind: 'annotation', id: a.id, sub: 'zone' }));

  if (lineAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = lineAlpha;
    for (const a of ph.annotations) {
      if (a.kind !== 'line') continue;
      const pts = screenPath(cam, a.from, a.to, a.bend);
      const color = noteHex(a.color, board.pitchTheme);
      drawStyledLine(ctx, pts, a.lineType, color, lw, sel?.annotationId === a.id || hot({ kind: 'annotation', id: a.id, sub: 'line' }), board.pitchTheme === 'print' ? undefined : th.outline);
      lineLabel(ctx, pts, a.label, color, th.halo, cam);
    }
    // LIN-014: implied movements as faint dotted lines.
    if (board.settings.showImplied && atRest && i < lastIdx(board)) {
      const next = board.phases[i + 1];
      ctx.save();
      ctx.globalAlpha = lineAlpha * 0.55;
      ctx.setLineDash([2, 6]);
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      for (const p of board.roster) {
        if (playerMode(board, o.focus, p) !== 'show') continue;
        if (ph.movements.some((x) => x.subject.kind === 'player' && x.subject.playerId === p.id)) continue;
        if (dist(ph.tokens[p.id], next.tokens[p.id]) < 1) continue;
        ctx.strokeStyle = teamHex(teamById(board, p.teamId).color);
        poly(ctx, [cam.toScreen(ph.tokens[p.id]), cam.toScreen(next.tokens[p.id])]);
        ctx.stroke();
      }
      ctx.restore();
    }
    for (const mv of ph.movements) {
      let color = th.neutral;
      let ghost = false;
      let player: Player | undefined;
      if (mv.subject.kind === 'player') {
        player = playerById(board, mv.subject.playerId);
        if (!player) continue;
        const mode = playerMode(board, o.focus, player);
        if (mode === 'hide') continue; // TFM-002
        ghost = mode === 'ghost';
        color = teamHex(teamById(board, player.teamId).color);
        if (board.pitchTheme !== 'print' && inkOn(color) === '#FFFFFF' && color === '#1B1D22') color = '#3A3F49';
      } else if (mv.type === 'carry') continue; // the carrier's wavy line already shows the carry
      const full = movementPath(board, i, mv, cam);
      const selected = sel?.movementId === mv.id || hot({ kind: 'movement', id: mv.id });
      ctx.save();
      if (ghost) ctx.globalAlpha *= GHOST_OPACITY;
      const startGap = mv.subject.kind === 'player' ? r + 2 : br + 2;
      const endGap = mv.subject.kind === 'player' ? r + 1 : 0;
      const pts = trim(full, startGap, endGap);
      drawStyledLine(ctx, pts, mv.type, color, lw, selected, board.pitchTheme === 'print' ? undefined : th.outline);
      lineLabel(ctx, full, mv.label, th.neutral, th.halo, cam);
      // LIN-005: a hollow outline with the shirt number marks where the player lands.
      if (player) {
        const tip = full[full.length - 1];
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, r, 0, Math.PI * 2);
        ctx.lineWidth = 1.75;
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = `700 ${Math.round(r * 0.95)}px ${NUMBER_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.globalAlpha *= 0.85;
        if (r >= 6) haloText(ctx, String(player.number), tip.x, tip.y + r * 0.06, th.neutral, th.halo);
      }
      ctx.restore();
    }
    ctx.restore();
  }

  // TRN-015 trail: moving tokens leave a short fading trail.
  if (o.trailFrom) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = lw * 1.2;
    for (const p of board.roster) {
      if (playerMode(board, o.focus, p) === 'hide') continue;
      const a = o.trailFrom.tokens[p.id];
      const b = scene.tokens[p.id];
      if (!a || !b || dist(a, b) < 0.5) continue;
      const sa = cam.toScreen(a);
      const sb = cam.toScreen(b);
      const g = ctx.createLinearGradient(sa.x, sa.y, sb.x, sb.y);
      const hex = teamHex(teamById(board, p.teamId).color);
      g.addColorStop(0, `${hex}00`);
      g.addColorStop(1, `${hex}CC`);
      ctx.strokeStyle = g;
      poly(ctx, [sa, sb]);
      ctx.stroke();
    }
    ctx.restore();
  }

  for (const pass of ['ghost', 'show'] as const) {
    for (const p of board.roster) {
      if (playerMode(board, o.focus, p) !== pass) continue;
      const pos = scene.tokens[p.id];
      if (!pos) continue;
      const s = cam.toScreen(pos);
      const team = teamById(board, p.teamId);
      drawToken(ctx, s.x, s.y, r, {
        color: teamHex(team.color),
        marker: team.marker,
        number: p.number,
        gk: p.isGoalkeeper,
        locked: p.locked && !!ed,
        name: board.settings.showNames && !o.thumb ? p.name : '',
        ghost: pass === 'ghost',
        selected: !!sel?.players.includes(p.id) || hot({ kind: 'player', id: p.id }),
        possession: scene.ball.possessorId === p.id && scene.ball.alpha > 0,
        th,
      });
    }
  }

  // TFM-005: the ball shows in every focus mode unless it is hidden itself.
  const bs = cam.toScreen(scene.ball);
  drawBall(ctx, bs.x, bs.y, br, scene.ball.alpha, !!sel?.ball || hot({ kind: 'ball' }), th);
  if (ed && atRest && !ph.ball.visible) {
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(bs.x, bs.y, br, 0, Math.PI * 2);
    ctx.strokeStyle = th.neutral;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (sel?.ball) {
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(bs.x, bs.y, br + 5, 0, Math.PI * 2);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.restore();
  }

  if (!o.thumb) for (const a of ph.annotations) if (a.kind === 'text') drawText(ctx, a, cam, board, th, sel?.annotationId === a.id || hot({ kind: 'annotation', id: a.id, sub: 'text' }));

  if (ed) {
    if (ed.snapPoints) {
      for (const p of ed.snapPoints) {
        const s = cam.toScreen(p);
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 7, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = ACCENT;
        ctx.stroke();
      }
    }
    const d = ed.draft;
    if (d?.kind === 'line') {
      ctx.save();
      ctx.globalAlpha = 0.9;
      drawStyledLine(ctx, [cam.toScreen(d.from), cam.toScreen(d.to)], d.lineType, d.color, lw);
      ctx.restore();
    } else if (d?.kind === 'zone') {
      const a = cam.toScreen(d.a);
      const b = cam.toScreen(d.b);
      ctx.save();
      ctx.setLineDash([7, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = noteHex('note-1', board.pitchTheme);
      ctx.fillStyle = `${noteHex('note-1', board.pitchTheme)}40`;
      ctx.beginPath();
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      if (d.shape === 'rect') ctx.rect(x, y, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      else ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(a.x - b.x) / 2, Math.abs(a.y - b.y) / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    if (ed.pendingStart) {
      const s = cam.toScreen(ed.pendingStart);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = ACCENT;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = ACCENT;
      ctx.fill();
    }
    if (atRest && sel) drawHandles(ctx, handlesFor(board, i, sel, cam));
    if (ed.marquee) {
      const { a, b } = ed.marquee;
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = ACCENT;
      ctx.fillStyle = `${ACCENT}22`;
      ctx.beginPath();
      ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();
}

export type { Annotation, LineAnn };
