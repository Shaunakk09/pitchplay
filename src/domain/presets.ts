// Appendix A formation presets (draft, D-22) and Appendix B pitch templates (draft, D-21).
import type { Format, Pt } from './types';
import { PITCH_H, PITCH_W } from './params';

export interface PresetSlot {
  number: number;
  role: string;
  isGoalkeeper: boolean;
  x: number;
  y: number;
}
export interface Preset {
  name: string;
  slots: PresetSlot[];
}

// "number role x y" per slot, for a team attacking right.
const RAW: Record<Format, Record<string, string>> = {
  '5v5': {
    '1-2-1': '1 GK 40 320 · 5 CB 190 320 · 7 RM 320 500 · 11 LM 320 140 · 9 ST 450 320',
    '2-2': '1 GK 40 320 · 2 RB 200 440 · 3 LB 200 200 · 7 RF 400 440 · 11 LF 400 200',
    '2-1-1': '1 GK 40 320 · 2 RB 190 450 · 3 LB 190 190 · 8 CM 320 320 · 9 ST 450 320',
  },
  '7v7': {
    '2-3-1': '1 GK 40 320 · 2 RB 190 440 · 3 LB 190 200 · 7 RM 320 530 · 8 CM 300 320 · 11 LM 320 110 · 9 ST 450 320',
    '3-2-1': '1 GK 40 320 · 2 RB 190 500 · 5 CB 180 320 · 3 LB 190 140 · 8 CM 320 420 · 10 CM 320 220 · 9 ST 450 320',
    '2-1-2-1': '1 GK 40 320 · 2 RB 190 440 · 3 LB 190 200 · 6 DM 280 320 · 7 RM 360 500 · 11 LM 360 140 · 9 ST 450 320',
  },
  '9v9': {
    '3-2-3': '1 GK 40 320 · 2 RB 190 500 · 5 CB 180 320 · 3 LB 190 140 · 6 CM 300 400 · 8 CM 300 240 · 7 RW 420 530 · 9 ST 450 320 · 11 LW 420 110',
    '3-3-2': '1 GK 40 320 · 2 RB 190 500 · 5 CB 180 320 · 3 LB 190 140 · 7 RM 320 530 · 8 CM 300 320 · 11 LM 320 110 · 9 ST 450 380 · 10 ST 450 260',
    '4-3-1': '1 GK 40 320 · 2 RB 200 540 · 5 CB 190 400 · 4 CB 190 240 · 3 LB 200 100 · 7 RM 320 500 · 8 CM 310 320 · 11 LM 320 140 · 9 ST 450 320',
  },
  '11v11': {
    '4-4-2': '1 GK 40 320 · 2 RB 200 560 · 5 CB 190 400 · 6 CB 190 240 · 3 LB 200 80 · 7 RM 320 560 · 4 CM 310 390 · 8 CM 310 250 · 11 LM 320 80 · 9 ST 450 370 · 10 ST 450 270',
    '4-3-3': '1 GK 40 320 · 2 RB 200 560 · 5 CB 190 400 · 4 CB 190 240 · 3 LB 200 80 · 6 DM 280 320 · 8 CM 340 430 · 10 CM 340 210 · 7 RW 440 540 · 9 ST 460 320 · 11 LW 440 100',
    '4-2-3-1': '1 GK 40 320 · 2 RB 200 560 · 5 CB 190 400 · 4 CB 190 240 · 3 LB 200 80 · 6 DM 280 390 · 8 DM 280 250 · 7 RAM 380 540 · 10 CAM 380 320 · 11 LAM 380 100 · 9 ST 460 320',
    '3-5-2': '1 GK 40 320 · 4 CB 190 460 · 5 CB 180 320 · 6 CB 190 180 · 2 RWB 320 580 · 7 CM 320 420 · 8 DM 280 320 · 10 CM 320 220 · 3 LWB 320 60 · 9 ST 450 370 · 11 ST 450 270',
  },
};

function parse(raw: string): PresetSlot[] {
  return raw.split(' · ').map((s) => {
    const [n, role, x, y] = s.trim().split(/\s+/);
    return { number: Number(n), role, isGoalkeeper: role === 'GK', x: Number(x), y: Number(y) };
  });
}

export const PRESETS: Record<Format, Preset[]> = Object.fromEntries(
  Object.entries(RAW).map(([f, byName]) => [f, Object.entries(byName).map(([name, raw]) => ({ name, slots: parse(raw) }))]),
) as Record<Format, Preset[]>;

export function getPreset(format: Format, name: string): Preset {
  return PRESETS[format].find((p) => p.name === name) ?? PRESETS[format][0];
}

// FRM-001: a team attacking left uses the slots rotated 180 degrees.
export function slotPosition(slot: Pt, attacks: 'right' | 'left'): Pt {
  return attacks === 'right' ? { x: slot.x, y: slot.y } : { x: PITCH_W - slot.x, y: PITCH_H - slot.y };
}

// GEO-003 and Appendix B. Left end only; the right end mirrors.
export interface PitchTemplate {
  circleR: number;
  penaltyArea: { x: number; y0: number; y1: number } | null;
  goalArea: { x: number; y0: number; y1: number } | null;
  penaltySpot: number | null; // x of the spot
  arcR: number | null;
  goal: { y0: number; y1: number };
  cornerR: number | null;
}

export const TEMPLATES: Record<Format, PitchTemplate> = {
  '11v11': {
    circleR: 91.5,
    penaltyArea: { x: 165, y0: 118.4, y1: 521.6 },
    goalArea: { x: 55, y0: 228.4, y1: 411.6 },
    penaltySpot: 110,
    arcR: 91.5,
    goal: { y0: 283.4, y1: 356.6 },
    cornerR: 10,
  },
  '9v9': {
    circleR: 80,
    penaltyArea: { x: 150, y0: 130, y1: 510 },
    goalArea: { x: 50, y0: 230, y1: 410 },
    penaltySpot: 100,
    arcR: 80,
    goal: { y0: 285, y1: 355 },
    cornerR: 10,
  },
  '7v7': {
    circleR: 70,
    penaltyArea: { x: 140, y0: 150, y1: 490 },
    goalArea: null,
    penaltySpot: 100,
    arcR: null,
    goal: { y0: 280, y1: 360 },
    cornerR: 10,
  },
  '5v5': {
    circleR: 70,
    penaltyArea: { x: 120, y0: 170, y1: 470 },
    goalArea: null,
    penaltySpot: null,
    arcR: null,
    goal: { y0: 270, y1: 370 },
    cornerR: null,
  },
};
