import type { Pt } from './types';
import { PITCH_H, PITCH_W } from './params';

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
export const clampPt = (p: Pt): Pt => ({ x: clamp(p.x, 0, PITCH_W), y: clamp(p.y, 0, PITCH_H) });
export const insidePitch = (p: Pt) => p.x >= 0 && p.x <= PITCH_W && p.y >= 0 && p.y <= PITCH_H;
export const round2 = (v: number) => Math.round(v * 100) / 100;
export const roundPt = (p: Pt): Pt => ({ x: round2(p.x), y: round2(p.y) });

// A point `d` units from `from` toward `to`. Falls back to `fallback` direction when the points coincide.
export function toward(from: Pt, to: Pt, d: number, fallback: Pt = { x: 1, y: 0 }): Pt {
  const L = dist(from, to);
  const ux = L < 0.001 ? fallback.x : (to.x - from.x) / L;
  const uy = L < 0.001 ? fallback.y : (to.y - from.y) / L;
  return { x: from.x + ux * d, y: from.y + uy * d };
}

// MOV-014: bend is a fraction of chord length. The control point sits bend * L off the chord midpoint,
// so the curve's apex sits bend * L / 2 off the chord.
export function controlPoint(a: Pt, b: Pt, bend: number): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return { x: (a.x + b.x) / 2 - dy * bend, y: (a.y + b.y) / 2 + dx * bend };
}

export function quadAt(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

export function bendFromPoint(a: Pt, b: Pt, h: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 0.001) return 0;
  const d = ((h.x - (a.x + b.x) / 2) * -dy + (h.y - (a.y + b.y) / 2) * dx) / L;
  return clamp(round2((2 * d) / L), -1, 1);
}

export interface Path {
  pts: Pt[];
  cum: number[];
  length: number;
}

export function makePath(a: Pt, b: Pt, bend: number, n = 32): Path {
  const pts: Pt[] = [];
  if (Math.abs(bend) < 0.0001) {
    pts.push(a, b);
  } else {
    const c = controlPoint(a, b, bend);
    for (let i = 0; i <= n; i++) pts.push(quadAt(a, c, b, i / n));
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return { pts, cum, length: cum[cum.length - 1] };
}

// MOV-014: constant speed along the curve, so progress maps to arc length.
export function pointAtFraction(path: Path, f: number): Pt {
  const { pts, cum, length } = path;
  if (f <= 0 || length === 0) return pts[0];
  if (f >= 1) return pts[pts.length - 1];
  const target = f * length;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const seg = cum[i] - cum[i - 1];
  const k = seg === 0 ? 0 : (target - cum[i - 1]) / seg;
  return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k };
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const t = L2 === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / L2, 0, 1);
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

export function distToPolyline(p: Pt, pts: Pt[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distToSegment(p, pts[i - 1], pts[i]));
  return best;
}

export const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
