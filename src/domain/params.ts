// PRD section 8.7. Every numeric parameter lives here, once.
import type { Format } from './types';

export const APP_VERSION = '0.2.0';
export const SCHEMA_VERSION = 1;

export const PITCH_W = 1000; // PARAM-01
export const PITCH_H = 640;
export const RENDER_MARGIN = 30; // PARAM-02
export const TOKEN_D = 30; // PARAM-03
export const TOKEN_MIN_PX = 18;
export const BALL_D = 14; // PARAM-04
export const BALL_MIN_PX = 10;
export const POSSESSION_OFFSET = 22; // PARAM-05
export const DRAG_THRESHOLD_TOUCH = 8; // PARAM-06
export const DRAG_THRESHOLD_MOUSE = 4;
export const LONG_PRESS_MS = 500; // PARAM-07
export const HIT_RADIUS_PX = 22; // PARAM-08
export const SNAP_RADIUS_PX = 28; // PARAM-09
export const MIN_LINE_PX = 16; // PARAM-10
export const MIN_ZONE = 30; // PARAM-11
export const ZOOM_MIN = 1; // PARAM-12
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 1.25;
export const NUDGE = 5; // PARAM-14
export const NUDGE_SHIFT = 25;
export const AUTOSAVE_MS = 400; // PARAM-15
export const AUTOSAVE_MAX_MS = 2000;
export const SAVE_RETRY_S = [2, 5, 10, 30]; // PARAM-16
export const UNDO_DEPTH = 100; // PARAM-17
export const GHOST_OPACITY = 0.35; // PARAM-18
export const DURATION_DEFAULT = 1500; // PARAM-19
export const DURATION_MIN = 250;
export const DURATION_MAX = 10000;
export const DURATION_STEP = 250;
export const HOLD_DEFAULT = 400; // PARAM-20
export const HOLD_MAX = 3000;
export const SPEEDS = [0.5, 1, 1.5, 2]; // PARAM-21
export const TIMING_STEP = 0.05; // PARAM-22
export const TIMING_MIN_SPAN = 0.1;
export const FADE_MS = 200; // PARAM-23
export const EXTRA_PLAYERS = 5; // PARAM-24
export const MAX_PHASES = 30; // PARAM-25
export const MAX_ANNOTATIONS = 60; // PARAM-26
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024; // PARAM-29
export const IMPORT_MAX_DEPTH = 12;
export const PNG_LONG_EDGE = 1920; // PARAM-30
export const STORYBOARD_MAX_EDGE = 4096;
export const VIDEO_FPS = 30; // PARAM-31
export const VIDEO_MAX_MS = 3 * 60 * 1000;
export const VERSIONS_AUTO = 20; // PARAM-33
export const VERSIONS_NAMED = 20;
export const VERSION_EVERY_MS = 10 * 60 * 1000;
export const BOARD_DELETE_UNDO_MS = 10000; // PARAM-36
export const PRESENT_HIDE_MS = 3000; // PARAM-37
export const THUMB_REFRESH_MS = 500; // PARAM-38

export const FORMAT_SIZE: Record<Format, number> = { '5v5': 5, '7v7': 7, '9v9': 9, '11v11': 11 };
export const FORMATS: Format[] = ['5v5', '7v7', '9v9', '11v11'];
export const teamLimit = (f: Format) => FORMAT_SIZE[f] + EXTRA_PLAYERS;

// PARAM-27 text lengths
export const LEN = {
  title: 80,
  team: 24,
  phase: 40,
  caption: 140,
  playerName: 24,
  role: 20,
  text: 80,
  lineLabel: 40,
  versionName: 40,
};

export const TEAM_TOKENS = Array.from({ length: 10 }, (_, i) => `team-${i + 1}`);
export const NOTE_TOKENS = Array.from({ length: 6 }, (_, i) => `note-${i + 1}`);
