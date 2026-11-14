// Camera: view presets, zoom, pan and orientation. All of it is view state (CORE-001, CORE-003).
import type { Board, Pt } from '../domain/types';
import { PITCH_H, PITCH_W, RENDER_MARGIN, ZOOM_MAX, ZOOM_MIN } from '../domain/params';
import { clamp } from '../domain/geometry';
import { cropX, type ViewPreset } from '../domain/labels';

export type Focus = 'both' | 'ghost' | 'primary' | 'other';
export type OrientationPref = 'auto' | 'landscape' | 'portrait';

export interface ViewState {
  preset: ViewPreset;
  zoom: number;
  cx: number | null; // canonical camera centre; null means the preset's centre
  cy: number | null;
  orientation: OrientationPref;
  focus: Focus;
  showLines: boolean;
}

export const DEFAULT_VIEW: ViewState = { preset: 'full', zoom: 1, cx: null, cy: null, orientation: 'auto', focus: 'both', showLines: true };

export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// PIT-003. The render margin (PARAM-02) is added only on real pitch edges.
export function viewRegion(board: Board, preset: ViewPreset): Region {
  const [a, b] = cropX(board, preset);
  return {
    x0: a <= 0 ? -RENDER_MARGIN : a,
    x1: b >= PITCH_W ? PITCH_W + RENDER_MARGIN : b,
    y0: -RENDER_MARGIN,
    y1: PITCH_H + RENDER_MARGIN,
  };
}
export const FULL_REGION: Region = { x0: -RENDER_MARGIN, y0: -RENDER_MARGIN, x1: PITCH_W + RENDER_MARGIN, y1: PITCH_H + RENDER_MARGIN };

export interface Cam {
  W: number;
  H: number;
  s: number; // px per canonical unit
  s0: number; // px per unit at zoom 1
  zoom: number;
  portrait: boolean;
  cx: number;
  cy: number;
  region: Region;
  toScreen(p: Pt): Pt;
  toCanon(p: Pt): Pt;
  matrix: [number, number, number, number, number, number];
}

export function camFor(region: Region, W: number, H: number, portrait: boolean, zoom = 1, cx: number | null = null, cy: number | null = null): Cam {
  const rw = region.x1 - region.x0;
  const rh = region.y1 - region.y0;
  const s0 = Math.max(0.01, portrait ? Math.min(W / rh, H / rw) : Math.min(W / rw, H / rh));
  const z = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
  const s = s0 * z;
  const hx = (portrait ? H : W) / (2 * s);
  const hy = (portrait ? W : H) / (2 * s);
  const midX = (region.x0 + region.x1) / 2;
  const midY = (region.y0 + region.y1) / 2;
  // PIT-006: the visible area never passes the region.
  const ccx = rw <= 2 * hx ? midX : clamp(cx ?? midX, region.x0 + hx, region.x1 - hx);
  const ccy = rh <= 2 * hy ? midY : clamp(cy ?? midY, region.y0 + hy, region.y1 - hy);
  // GEO-007: portrait rotates 90 degrees counter-clockwise, canonical right at the top.
  const toScreen = portrait
    ? (p: Pt) => ({ x: W / 2 + (p.y - ccy) * s, y: H / 2 - (p.x - ccx) * s })
    : (p: Pt) => ({ x: W / 2 + (p.x - ccx) * s, y: H / 2 + (p.y - ccy) * s });
  const toCanon = portrait
    ? (p: Pt) => ({ x: ccx - (p.y - H / 2) / s, y: ccy + (p.x - W / 2) / s })
    : (p: Pt) => ({ x: ccx + (p.x - W / 2) / s, y: ccy + (p.y - H / 2) / s });
  const matrix: Cam['matrix'] = portrait ? [0, -s, s, 0, W / 2 - ccy * s, H / 2 + ccx * s] : [s, 0, 0, s, W / 2 - ccx * s, H / 2 - ccy * s];
  return { W, H, s, s0, zoom: z, portrait, cx: ccx, cy: ccy, region, toScreen, toCanon, matrix };
}

// GEO-006: Auto means portrait when the canvas is taller than it is wide.
export const isPortrait = (pref: OrientationPref, W: number, H: number) => pref === 'portrait' || (pref === 'auto' && H > W);

export function makeCam(board: Board, view: ViewState, W: number, H: number): Cam {
  return camFor(viewRegion(board, view.preset), W, H, isPortrait(view.orientation, W, H), view.zoom, view.cx, view.cy);
}

// PIT-005: zoom anchored at a screen point.
export function zoomAt(view: ViewState, cam: Cam, anchor: Pt, zoom: number): ViewState {
  const z = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
  if (z === ZOOM_MIN) return { ...view, zoom: 1, cx: null, cy: null };
  const q = cam.toCanon(anchor);
  const s = cam.s0 * z;
  const cx = cam.portrait ? q.x + (anchor.y - cam.H / 2) / s : q.x - (anchor.x - cam.W / 2) / s;
  const cy = cam.portrait ? q.y - (anchor.x - cam.W / 2) / s : q.y - (anchor.y - cam.H / 2) / s;
  return { ...view, zoom: z, cx, cy };
}

export function panBy(view: ViewState, cam: Cam, dx: number, dy: number): ViewState {
  if (cam.zoom <= 1) return view;
  const cx = cam.portrait ? cam.cx + dy / cam.s : cam.cx - dx / cam.s;
  const cy = cam.portrait ? cam.cy - dx / cam.s : cam.cy - dy / cam.s;
  return { ...view, cx, cy };
}

export function isVisible(cam: Cam, p: Pt, pad = 0): boolean {
  const s = cam.toScreen(p);
  const r = cam.region;
  return s.x >= pad && s.x <= cam.W - pad && s.y >= pad && s.y <= cam.H - pad && p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
}

// PIT-009: centre a point at the current scale. From a preset crop this enters the zoomed state.
export function centreOn(view: ViewState, board: Board, cam: Cam, p: Pt): ViewState {
  const r = viewRegion(board, view.preset);
  if (p.x >= r.x0 && p.x <= r.x1) return { ...view, zoom: Math.max(view.zoom, 1.25), cx: p.x, cy: p.y };
  // Outside the crop: show the whole pitch at the same scale.
  const full = camFor(FULL_REGION, cam.W, cam.H, cam.portrait);
  return { ...view, preset: 'full', zoom: clamp(cam.s / full.s0, 1.25, ZOOM_MAX), cx: p.x, cy: p.y };
}
