// Domain model, PRD section 5.1. Canonical units: 1 u = 0.1 m, pitch 1000 x 640.

export type Format = '5v5' | '7v7' | '9v9' | '11v11';
export type Theme = 'grass' | 'dark' | 'print';
export type Slot = 'A' | 'B';

export interface Pt {
  x: number;
  y: number;
}

export interface Team {
  id: string;
  slot: Slot;
  name: string;
  color: string; // team palette token, team-1 to team-10
  marker: 'solid' | 'outlined';
}

export interface Player {
  id: string;
  teamId: string;
  number: number;
  name: string;
  role: string;
  isGoalkeeper: boolean;
  locked: boolean;
}

export interface BallState {
  x: number;
  y: number;
  visible: boolean;
  possessorId: string | null;
}

export type Subject = { kind: 'player'; playerId: string } | { kind: 'ball' };
export type MoveType = 'run' | 'carry' | 'pass' | 'shot';
export type LineType = MoveType | 'arrow';

export interface Movement {
  id: string;
  subject: Subject;
  type: MoveType;
  bend: number;
  start: number;
  end: number;
  receiverId: string | null;
  carrierId: string | null;
  label: string;
  pendingTip: Pt | null;
}

export interface LineAnn {
  id: string;
  kind: 'line';
  lineType: LineType;
  from: Pt;
  to: Pt;
  bend: number;
  color: string; // annotation palette token, note-1 to note-6
  label: string;
}

export interface ZoneAnn {
  id: string;
  kind: 'zone';
  shape: 'rect' | 'ellipse';
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  opacity: number;
  outline: 'solid' | 'dashed' | 'none';
  label: string;
}

export interface TextAnn {
  id: string;
  kind: 'text';
  x: number;
  y: number;
  text: string;
  size: 's' | 'm' | 'l';
  color: string;
  background: boolean;
  align: 'left' | 'center';
}

export type Annotation = LineAnn | ZoneAnn | TextAnn;

export interface Transition {
  durationMs: number;
  easing: 'linear' | 'easeInOut';
}

export interface Phase {
  id: string;
  name: string;
  caption: string;
  tokens: Record<string, Pt>;
  ball: BallState;
  movements: Movement[];
  annotations: Annotation[];
  transition: Transition;
}

export interface BoardSettings {
  showNames: boolean;
  showImplied: boolean;
  linesDuringPlayback: 'fade' | 'keep' | 'trail';
  holdMs: number;
  loop: boolean;
  exportMark: boolean;
}

export interface Board {
  id: string;
  schemaVersion: number;
  appVersion: string;
  title: string;
  format: Format;
  pitchTemplate: Format;
  pitchTheme: Theme;
  teams: [Team, Team];
  primaryTeamId: string;
  teamAAttacks: 'right' | 'left';
  roster: Player[];
  phases: Phase[];
  settings: BoardSettings;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

// Selection is view state, never part of the document (INT-002).
export interface Selection {
  players: string[];
  ball: boolean;
  movementId: string | null;
  annotationId: string | null;
}

export const EMPTY_SELECTION: Selection = { players: [], ball: false, movementId: null, annotationId: null };
