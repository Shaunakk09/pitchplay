// Export rendering (EXP). Frames come from the playback model at exact timestamps, never from the
// screen, and never include editor-only state (EXP-003, EXP-009, DAT-024).
import type { Board } from '../domain/types';
import { isHosted } from '../host';
import { PNG_LONG_EDGE, STORYBOARD_MAX_EDGE, VIDEO_FPS } from '../domain/params';
import { buildTimeline, frameAt, sceneAtPhase, sceneInTransition, type Scene } from '../domain/playback';
import { FULL_REGION, camFor, viewRegion, type Focus, type Region, type ViewState } from '../render/camera';
import { drawScene, drawStyledLine, lineTypesUsed } from '../render/draw';
import { NUMBER_FONT, TEXT_FONT, THEMES } from '../render/themes';
import { GifWriter, makeZip } from './encoders';

export interface FrameOpts {
  area: 'view' | 'whole'; // EXP-004
  bothTeams: boolean;
  portrait: boolean;
  title: boolean;
  phaseName: boolean;
  caption: boolean;
  legend: boolean;
  mark: boolean;
  showLines: boolean;
}

export interface FrameState {
  phaseIdx: number;
  scene: Scene;
  lineAlpha?: number;
  trailFrom?: Scene | null;
}

interface Layout {
  region: Region;
  zoom: number;
  cx: number | null;
  cy: number | null;
  focus: Focus;
}

function layoutOf(board: Board, view: ViewState, o: FrameOpts): Layout {
  const focus: Focus = o.bothTeams ? 'both' : view.focus;
  if (o.area === 'whole') return { region: FULL_REGION, zoom: 1, cx: null, cy: null, focus };
  return { region: viewRegion(board, view.preset), zoom: view.zoom, cx: view.cx, cy: view.cy, focus };
}

// The caption band is kept only when a phase in the range has a caption, so no empty strip is exported.
export function captionIfAny(board: Board, o: FrameOpts, from: number, to: number): FrameOpts {
  const any = board.phases.slice(from, to + 1).some((p) => p.caption.trim());
  return any ? o : { ...o, caption: false };
}

function bands(board: Board, W: number, H: number, o: FrameOpts, phases: number[]) {
  const u = Math.max(W, H) / 1920;
  const header = o.title || o.phaseName ? Math.round(92 * u) : 0;
  const caption = o.caption ? Math.round(76 * u) : 0;
  const legendTypes = o.legend ? lineTypesUsed(board, phases) : [];
  const foot = legendTypes.length || o.mark ? Math.round(58 * u) : 0;
  return { u, header, caption, foot, legendTypes };
}

let pitchCanvas: HTMLCanvasElement | null = null;

// Draws one composed frame at a fixed size: header, pitch, caption, legend and mark.
export function composeFrame(ctx: CanvasRenderingContext2D, W: number, H: number, board: Board, view: ViewState, o: FrameOpts, st: FrameState, legendPhases: number[], captionText?: string): void {
  const th = THEMES[board.pitchTheme];
  const lay = layoutOf(board, view, o);
  const b = bands(board, W, H, o, legendPhases);
  const ph = board.phases[st.phaseIdx];
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = th.margin;
  ctx.fillRect(0, 0, W, H);
  const pw = W;
  const phh = Math.max(10, H - b.header - b.caption - b.foot);
  pitchCanvas ??= document.createElement('canvas');
  if (pitchCanvas.width !== pw || pitchCanvas.height !== phh) {
    pitchCanvas.width = pw;
    pitchCanvas.height = phh;
  }
  const pctx = pitchCanvas.getContext('2d')!;
  const cam = camFor(lay.region, pw, phh, o.portrait, lay.zoom, lay.cx, lay.cy);
  drawScene(pctx, { board, phaseIdx: st.phaseIdx, scene: st.scene, cam, dpr: 1, focus: lay.focus, showLines: o.showLines, lineAlpha: st.lineAlpha, trailFrom: st.trailFrom, editor: null });
  ctx.drawImage(pitchCanvas, 0, b.header);

  ctx.fillStyle = th.neutral;
  ctx.textBaseline = 'middle';
  const pad = Math.round(36 * b.u);
  if (b.header) {
    ctx.textAlign = 'left';
    if (o.title) {
      ctx.font = `700 ${Math.round(44 * b.u)}px ${NUMBER_FONT}`;
      ctx.fillText(board.title, pad, b.header / 2, o.phaseName ? W * 0.58 : W - pad * 2);
    }
    if (o.phaseName) {
      ctx.font = `600 ${Math.round(30 * b.u)}px ${TEXT_FONT}`;
      ctx.textAlign = o.title ? 'right' : 'left';
      ctx.fillText(`${st.phaseIdx + 1}. ${ph.name}`, o.title ? W - pad : pad, b.header / 2, o.title ? W * 0.36 : W - pad * 2);
    }
  }
  if (b.caption) {
    const text = captionText ?? ph.caption;
    ctx.textAlign = 'center';
    ctx.font = `500 ${Math.round(30 * b.u)}px ${TEXT_FONT}`;
    if (text) ctx.fillText(text, W / 2, b.header + phh + b.caption / 2, W - pad * 2);
  }
  if (b.foot) {
    const y = H - b.foot / 2;
    let x = pad;
    ctx.font = `500 ${Math.round(22 * b.u)}px ${TEXT_FONT}`;
    ctx.textAlign = 'left';
    for (const t of b.legendTypes) {
      const len = 64 * b.u;
      drawStyledLine(ctx, [{ x, y }, { x: x + len, y }], t, th.neutral, Math.max(2, 3.4 * b.u));
      ctx.fillStyle = th.neutral;
      const label = `${t[0].toUpperCase()}${t.slice(1)}`;
      ctx.fillText(label, x + len + 12 * b.u, y);
      x += len + 12 * b.u + ctx.measureText(label).width + 34 * b.u;
    }
    if (o.mark) {
      ctx.textAlign = 'right';
      ctx.globalAlpha = 0.75;
      ctx.fillText('Made with PitchPlay', W - pad, y);
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

// Natural image size: the pitch area keeps the crop's aspect; bands are added around it.
export function imageSize(board: Board, view: ViewState, o: FrameOpts, longEdge: number, screenAspect: number | null, phases: number[]): { W: number; H: number } {
  const lay = layoutOf(board, view, o);
  const rw = lay.region.x1 - lay.region.x0;
  const rh = lay.region.y1 - lay.region.y0;
  let aspect = o.portrait ? rh / rw : rw / rh;
  if (o.area === 'view' && lay.zoom > 1 && screenAspect) aspect = screenAspect;
  let W = aspect >= 1 ? longEdge : Math.round(longEdge * aspect);
  let H = aspect >= 1 ? Math.round(longEdge / aspect) : longEdge;
  const b = bands(board, W, H, o, phases);
  const extra = b.header + b.caption + b.foot;
  H += extra;
  const k = longEdge / Math.max(W, H);
  if (k < 1) {
    W = Math.round(W * k);
    H = Math.round(H * k);
  }
  return { W: W - (W % 2), H: H - (H % 2) };
}

const toBlob = (c: HTMLCanvasElement, type = 'image/png') =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('The browser could not encode the image'))), type));

export function renderPhaseCanvas(board: Board, view: ViewState, opts: FrameOpts, phaseIdx: number, longEdge: number, screenAspect: number | null, range: [number, number] = [phaseIdx, phaseIdx]): HTMLCanvasElement {
  const o = captionIfAny(board, opts, range[0], range[1]);
  const { W, H } = imageSize(board, view, o, longEdge, screenAspect, [phaseIdx]);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  composeFrame(c.getContext('2d')!, W, H, board, view, o, { phaseIdx, scene: sceneAtPhase(board, phaseIdx) }, [phaseIdx]);
  return c;
}

// EXP-005
export async function exportImage(board: Board, view: ViewState, o: FrameOpts, phaseIdx: number, twoX: boolean, screenAspect: number | null): Promise<Blob> {
  return toBlob(renderPhaseCanvas(board, view, o, phaseIdx, PNG_LONG_EDGE * (twoX ? 2 : 1), screenAspect));
}

// EXP-006: 3 columns for landscape pitches, 2 for portrait; index, name and caption per cell.
export async function exportStoryboard(board: Board, view: ViewState, o: FrameOpts, from: number, to: number, screenAspect: number | null): Promise<Blob> {
  const n = to - from + 1;
  const cols = Math.min(n, o.portrait ? 2 : 3);
  const rows = Math.ceil(n / cols);
  const cellOpts: FrameOpts = { ...captionIfAny(board, o, from, to), title: false, phaseName: true, legend: false, mark: false };
  let edge = 1280;
  let size = imageSize(board, view, cellOpts, edge, screenAspect, []);
  const gap = 24;
  const head = o.title ? 110 : 0;
  const foot = o.legend || o.mark ? 70 : 0;
  const total = () => ({ W: cols * size.W + (cols + 1) * gap, H: rows * size.H + (rows + 1) * gap + head + foot });
  while (Math.max(total().W, total().H) > STORYBOARD_MAX_EDGE && edge > 240) {
    edge -= 40;
    size = imageSize(board, view, cellOpts, edge, screenAspect, []);
  }
  const { W, H } = total();
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const th = THEMES[board.pitchTheme];
  ctx.fillStyle = th.margin;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = th.neutral;
  ctx.textBaseline = 'middle';
  if (head) {
    ctx.font = `700 52px ${NUMBER_FONT}`;
    ctx.fillText(board.title, gap, head / 2 + gap / 2, W - gap * 2);
  }
  const cell = document.createElement('canvas');
  cell.width = size.W;
  cell.height = size.H;
  const cctx = cell.getContext('2d')!;
  for (let k = 0; k < n; k++) {
    const i = from + k;
    composeFrame(cctx, size.W, size.H, board, view, cellOpts, { phaseIdx: i, scene: sceneAtPhase(board, i) }, []);
    ctx.drawImage(cell, gap + (k % cols) * (size.W + gap), head + gap + Math.floor(k / cols) * (size.H + gap));
  }
  if (foot) {
    const phases = Array.from({ length: n }, (_, k) => from + k);
    const types = o.legend ? lineTypesUsed(board, phases) : [];
    const y = H - foot / 2 - gap / 2;
    let x = gap;
    ctx.font = `500 24px ${TEXT_FONT}`;
    for (const t of types) {
      drawStyledLine(ctx, [{ x, y }, { x: x + 70, y }], t, th.neutral, 3.5);
      ctx.fillStyle = th.neutral;
      const label = `${t[0].toUpperCase()}${t.slice(1)}`;
      ctx.fillText(label, x + 82, y);
      x += 82 + ctx.measureText(label).width + 36;
    }
    if (o.mark) {
      ctx.textAlign = 'right';
      ctx.globalAlpha = 0.75;
      ctx.fillText('Made with PitchPlay', W - gap, y);
      ctx.globalAlpha = 1;
    }
  }
  return toBlob(c);
}

// EXP-007
export async function exportZip(board: Board, view: ViewState, o: FrameOpts, from: number, to: number, screenAspect: number | null, name: (i: number) => string): Promise<Blob> {
  const files: { name: string; data: Uint8Array }[] = [];
  for (let i = from; i <= to; i++) {
    const blob = await toBlob(renderPhaseCanvas(board, view, o, i, PNG_LONG_EDGE, screenAspect, [from, to]));
    files.push({ name: name(i), data: new Uint8Array(await blob.arrayBuffer()) });
  }
  return makeZip(files);
}

// ---------- animation ----------

export interface AnimOpts extends FrameOpts {
  from: number;
  to: number;
  speed: number;
  holdMs: number;
  titleCard: boolean;
  W: number;
  H: number;
}

export const TITLE_CARD_MS = 1500;

// Length in milliseconds of the exported animation (AT-106).
export function animationLength(board: Board, a: Pick<AnimOpts, 'from' | 'to' | 'speed' | 'holdMs' | 'titleCard'>): number {
  return buildTimeline(board, a.from, a.to, a.holdMs).total / a.speed + (a.titleCard ? TITLE_CARD_MS : 0);
}

function drawTitleCard(ctx: CanvasRenderingContext2D, board: Board, W: number, H: number) {
  const th = THEMES[board.pitchTheme];
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = th.margin;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = th.neutral;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const u = Math.max(W, H) / 1920;
  ctx.font = `700 ${Math.round(92 * u)}px ${NUMBER_FONT}`;
  ctx.fillText(board.title, W / 2, H / 2 - 20 * u, W * 0.86);
  ctx.font = `500 ${Math.round(34 * u)}px ${TEXT_FONT}`;
  ctx.globalAlpha = 0.8;
  ctx.fillText(`${board.teams[0].name} v ${board.teams[1].name} · ${board.format}`, W / 2, H / 2 + 70 * u, W * 0.86);
  ctx.restore();
}

// Draws the animation frame at time ms (export clock, title card included).
function drawAnimFrame(ctx: CanvasRenderingContext2D, board: Board, view: ViewState, opts: AnimOpts, ms: number) {
  const a = captionIfAny(board, opts, opts.from, opts.to) as AnimOpts;
  if (a.titleCard && ms < TITLE_CARD_MS) {
    drawTitleCard(ctx, board, a.W, a.H);
    return;
  }
  const tl = buildTimeline(board, a.from, a.to, a.holdMs);
  const t = (ms - (a.titleCard ? TITLE_CARD_MS : 0)) * a.speed;
  const f = frameAt(board, tl, t); // EXP-014: reduced motion never changes exports
  const phases = Array.from({ length: a.to - a.from + 1 }, (_, k) => a.from + k);
  const trail = f.trail && f.kind === 'move' ? sceneInTransition(board, f.phase, Math.max(0, f.t - 0.14)) : null;
  // A caption shows during its phase's hold and outgoing transition (EXP-008).
  composeFrame(ctx, a.W, a.H, board, view, a, { phaseIdx: f.phase, scene: f.scene, lineAlpha: f.lineAlpha, trailFrom: trail }, phases, board.phases[f.phase].caption);
}

export function pickVideoMime(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const options = [
    { mime: 'video/mp4;codecs=avc1.42E01E', ext: 'mp4' },
    { mime: 'video/mp4', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9', ext: 'webm' },
    { mime: 'video/webm;codecs=vp8', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' },
  ];
  return options.find((o) => MediaRecorder.isTypeSupported(o.mime)) ?? null;
}

export class Cancelled extends Error {}

// EXP-010 fallback path: real-time recording. It takes as long as the animation.
export async function exportVideo(board: Board, view: ViewState, a: AnimOpts, onProgress: (p: number) => void, signal: AbortSignal): Promise<{ blob: Blob; ext: string }> {
  const pick = pickVideoMime();
  if (!pick) throw new Error('this browser cannot record video');
  const canvas = document.createElement('canvas');
  canvas.width = a.W;
  canvas.height = a.H;
  const ctx = canvas.getContext('2d')!;
  const total = animationLength(board, a);
  drawAnimFrame(ctx, board, view, a, 0);
  const stream = canvas.captureStream(VIDEO_FPS);
  const rec = new MediaRecorder(stream, { mimeType: pick.mime, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  rec.start(250);
  const t0 = performance.now();
  await new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (signal.aborted) return reject(new Cancelled());
      const ms = performance.now() - t0;
      drawAnimFrame(ctx, board, view, a, Math.min(ms, total));
      onProgress(Math.min(1, ms / total));
      if (ms >= total + 120) return resolve();
      setTimeout(tick, 1000 / VIDEO_FPS);
    };
    tick();
  }).finally(() => {
    if (rec.state !== 'inactive') rec.stop();
    stream.getTracks().forEach((t) => t.stop());
  });
  await stopped;
  if (signal.aborted) throw new Cancelled(); // EXP-011: cancel discards the partial file
  return { blob: new Blob(chunks, { type: pick.mime.split(';')[0] }), ext: pick.ext };
}

// EXP-012: frames at exact timestamps, 15 fps.
export async function exportGif(board: Board, view: ViewState, a: AnimOpts, onProgress: (p: number) => void, signal: AbortSignal): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = a.W;
  canvas.height = a.H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const total = animationLength(board, a);
  const frames = Math.max(1, Math.ceil((total / 1000) * 15));
  const gif = new GifWriter(a.W, a.H);
  const grab = (k: number) => {
    drawAnimFrame(ctx, board, view, a, Math.min(total, (k * 1000) / 15));
    return ctx.getImageData(0, 0, a.W, a.H).data;
  };
  const sampleAt = [...new Set([0, Math.floor(frames / 4), Math.floor(frames / 2), Math.floor((3 * frames) / 4), frames - 1])];
  gif.buildPalette(sampleAt.map(grab));
  for (let k = 0; k < frames; k++) {
    if (signal.aborted) throw new Cancelled();
    gif.addFrame(grab(k));
    if (k % 3 === 0) {
      onProgress((k + 1) / frames);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return gif.finish();
}

// EXP-015
export async function shareFile(blob: Blob, name: string): Promise<boolean> {
  try {
    const file = new File([blob], name, { type: blob.type });
    if (!navigator.canShare?.({ files: [file] })) return false;
    await navigator.share({ files: [file], title: name });
    return true;
  } catch {
    return false;
  }
}
export const canShareFiles = () => {
  if (isHosted()) return false; // the claude.ai page frame refuses Web Share
  try {
    return !!navigator.canShare?.({ files: [new File([new Blob(['x'])], 'x.png', { type: 'image/png' })] });
  } catch {
    return false;
  }
};
