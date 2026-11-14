// Data integrity invariants (PRD 5.4) and import validation (IMP-002, SEC-002).
import type { Board } from './types';
import {
  APP_VERSION,
  DURATION_MAX,
  DURATION_MIN,
  FORMATS,
  HOLD_MAX,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_DEPTH,
  LEN,
  MAX_ANNOTATIONS,
  MAX_PHASES,
  MIN_ZONE,
  NOTE_TOKENS,
  PITCH_H,
  PITCH_W,
  SCHEMA_VERSION,
  TEAM_TOKENS,
  teamLimit,
} from './params';
import { dist } from './geometry';
import { subjectPos, tipOf } from './ops';

// ---------- invariants ----------

const inPitch = (x: number, y: number) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= PITCH_W && y >= 0 && y <= PITCH_H;

// Returns plain-language problems. An empty list means the board is valid.
export function checkInvariants(b: Board): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  const uniq = (id: string, what: string) => {
    if (ids.has(id)) out.push(`${what} "${id}" is used twice`); // DAT-002
    ids.add(id);
  };
  const [a, c] = b.teams;
  if (b.teams.length !== 2 || a.slot === c.slot) out.push('A board needs exactly two teams, one per slot'); // DAT-003
  else {
    if (a.id === c.id) out.push('The two teams share one ID');
    if (a.color === c.color) out.push('The two teams use the same color');
    if (a.marker === c.marker) out.push('The two teams use the same marker');
  }
  const teamIds = new Set(b.teams.map((t) => t.id));
  if (!teamIds.has(b.primaryTeamId)) out.push('The primary team is not one of the two teams'); // DAT-016
  const roster = new Set<string>();
  for (const p of b.roster) {
    uniq(p.id, 'Player');
    roster.add(p.id);
    if (!teamIds.has(p.teamId)) out.push(`Player ${p.id} belongs to a team that does not exist`); // DAT-004
  }
  for (const t of b.teams) {
    const n = b.roster.filter((p) => p.teamId === t.id).length;
    if (n > teamLimit(b.format)) out.push(`${t.name} has ${n} players, more than the limit of ${teamLimit(b.format)} for ${b.format}`); // DAT-018
  }
  if (b.phases.length < 1) out.push('A board needs at least one phase'); // DAT-015
  if (b.phases.length > MAX_PHASES) out.push(`The board has ${b.phases.length} phases, more than the limit of ${MAX_PHASES}`);
  b.phases.forEach((ph, i) => {
    const n = i + 1;
    const last = i === b.phases.length - 1;
    uniq(ph.id, 'Phase');
    for (const id of roster) {
      const t = ph.tokens[id];
      if (!t) out.push(`Phase ${n}: player ${id} has no position`); // DAT-005
      else if (!inPitch(t.x, t.y)) out.push(`Phase ${n}: player ${id} is outside the pitch`); // DAT-007
    }
    for (const id of Object.keys(ph.tokens)) if (!roster.has(id)) out.push(`Phase ${n}: a position exists for unknown player ${id}`);
    if (!inPitch(ph.ball.x, ph.ball.y)) out.push(`Phase ${n}: the ball is outside the pitch`);
    if (ph.ball.possessorId && !roster.has(ph.ball.possessorId)) out.push(`Phase ${n}: the ball is held by unknown player ${ph.ball.possessorId}`); // DAT-009
    if (ph.annotations.length > MAX_ANNOTATIONS) out.push(`Phase ${n} has ${ph.annotations.length} drawings, more than the limit of ${MAX_ANNOTATIONS}`);
    const subjects = new Set<string>();
    for (const m of ph.movements) {
      uniq(m.id, 'Line');
      const key = m.subject.kind === 'ball' ? 'ball' : m.subject.playerId;
      if (subjects.has(key)) out.push(`Phase ${n}: two movement lines start from the same subject`); // DAT-008
      subjects.add(key);
      if (m.subject.kind === 'player' && !roster.has(m.subject.playerId)) {
        out.push(`Phase ${n}: a line starts from unknown player ${m.subject.playerId}`);
        continue;
      }
      if (m.subject.kind === 'player' && m.type !== 'run' && m.type !== 'carry') out.push(`Phase ${n}: a player line must be a run or a carry`);
      if (m.subject.kind === 'ball' && m.type === 'run') out.push(`Phase ${n}: a ball line cannot be a run`);
      if (m.receiverId && !roster.has(m.receiverId)) out.push(`Phase ${n}: a pass goes to unknown player ${m.receiverId}`);
      if (m.carrierId && !roster.has(m.carrierId)) out.push(`Phase ${n}: a carry names unknown player ${m.carrierId}`);
      if (m.receiverId && m.type !== 'pass') out.push(`Phase ${n}: only a pass can have a receiver`); // DAT-013
      if (m.carrierId && !(m.subject.kind === 'ball' && m.type === 'carry')) out.push(`Phase ${n}: only a ball carry can name a carrier`);
      if (last !== (m.pendingTip !== null)) out.push(`Phase ${n}: a line ${last ? 'on the last phase needs' : 'before the last phase cannot have'} a pending tip`); // DAT-010
      if (m.pendingTip && !inPitch(m.pendingTip.x, m.pendingTip.y)) out.push(`Phase ${n}: a line ends outside the pitch`);
      if (!(m.start >= 0 && m.end <= 1 && m.end - m.start >= 0.1 - 1e-9)) out.push(`Phase ${n}: a line has invalid timing`); // DAT-017
      if (!(m.bend >= -1 && m.bend <= 1)) out.push(`Phase ${n}: a line has an invalid curve`);
      if ((last ? m.pendingTip !== null : true) && dist(subjectPos(ph, m.subject), tipOf(b, i, m)) < 1) out.push(`Phase ${n}: a line is shorter than 1 unit`); // DAT-011
      if (m.type === 'pass' && m.receiverId && !last && b.phases[i + 1].ball.possessorId !== m.receiverId)
        out.push(`Phase ${n}: a pass names a receiver who does not hold the ball in the next phase`); // DAT-014
      if (m.subject.kind === 'ball' && m.type === 'carry') {
        const pm = ph.movements.find((x) => x.subject.kind === 'player' && x.subject.playerId === m.carrierId);
        if (!m.carrierId || !pm || pm.type !== 'carry' || ph.ball.possessorId !== m.carrierId) out.push(`Phase ${n}: a ball carry has no matching carrier`); // DAT-012
      }
      if (m.subject.kind === 'player' && m.type === 'carry') {
        const pid = m.subject.playerId;
        if (!ph.movements.some((x) => x.subject.kind === 'ball' && x.type === 'carry' && x.carrierId === pid)) out.push(`Phase ${n}: a carry has no matching ball movement`);
      }
    }
    for (const an of ph.annotations) {
      uniq(an.id, 'Drawing');
      if (an.kind === 'line') {
        if (!inPitch(an.from.x, an.from.y) || !inPitch(an.to.x, an.to.y)) out.push(`Phase ${n}: a line is outside the pitch`);
      } else if (an.kind === 'zone') {
        if (!inPitch(an.x, an.y) || !inPitch(an.x + an.w, an.y + an.h) || an.w < MIN_ZONE || an.h < MIN_ZONE) out.push(`Phase ${n}: a zone is outside the pitch or too small`);
      } else if (!inPitch(an.x, an.y)) out.push(`Phase ${n}: a label is outside the pitch`);
    }
  });
  return out;
}

// ---------- strict schema (unknown keys rejected) ----------

type S =
  | { t: 'str'; min: number; max: number }
  | { t: 'num'; min: number; max: number; int?: boolean }
  | { t: 'bool' }
  | { t: 'enum'; v: readonly string[] }
  | { t: 'obj'; k: Record<string, S> }
  | { t: 'arr'; of: S; min?: number; max?: number }
  | { t: 'map'; of: S }
  | { t: 'nullable'; of: S }
  | { t: 'union'; key: string; v: Record<string, S> };

const str = (min: number, max: number): S => ({ t: 'str', min, max });
const num = (min: number, max: number, int = false): S => ({ t: 'num', min, max, int });
const bool: S = { t: 'bool' };
const en = (...v: string[]): S => ({ t: 'enum', v });
const obj = (k: Record<string, S>): S => ({ t: 'obj', k });
const arr = (of: S, min = 0, max = 10000): S => ({ t: 'arr', of, min, max });
const nullable = (of: S): S => ({ t: 'nullable', of });

const id = str(1, 64);
const pt = obj({ x: num(0, PITCH_W), y: num(0, PITCH_H) });
const note = en(...NOTE_TOKENS);
const format = en(...FORMATS);

const movement = obj({
  id,
  subject: { t: 'union', key: 'kind', v: { player: obj({ kind: en('player'), playerId: id }), ball: obj({ kind: en('ball') }) } },
  type: en('run', 'carry', 'pass', 'shot'),
  bend: num(-1, 1),
  start: num(0, 1),
  end: num(0, 1),
  receiverId: nullable(id),
  carrierId: nullable(id),
  label: str(0, LEN.lineLabel),
  pendingTip: nullable(pt),
});

const annotation: S = {
  t: 'union',
  key: 'kind',
  v: {
    line: obj({ id, kind: en('line'), lineType: en('run', 'pass', 'carry', 'shot', 'arrow'), from: pt, to: pt, bend: num(-1, 1), color: note, label: str(0, LEN.lineLabel) }),
    zone: obj({
      id,
      kind: en('zone'),
      shape: en('rect', 'ellipse'),
      x: num(0, PITCH_W),
      y: num(0, PITCH_H),
      w: num(MIN_ZONE, PITCH_W),
      h: num(MIN_ZONE, PITCH_H),
      fill: note,
      opacity: num(0.1, 0.5),
      outline: en('solid', 'dashed', 'none'),
      label: str(0, LEN.lineLabel),
    }),
    text: obj({ id, kind: en('text'), x: num(0, PITCH_W), y: num(0, PITCH_H), text: str(1, LEN.text), size: en('s', 'm', 'l'), color: note, background: bool, align: en('left', 'center') }),
  },
};

const boardSchema = obj({
  id,
  title: str(1, LEN.title),
  format,
  pitchTemplate: format,
  pitchTheme: en('grass', 'dark', 'print'),
  teams: arr(obj({ id, slot: en('A', 'B'), name: str(1, LEN.team), color: en(...TEAM_TOKENS), marker: en('solid', 'outlined') }), 2, 2),
  primaryTeamId: id,
  teamAAttacks: en('right', 'left'),
  roster: arr(obj({ id, teamId: id, number: num(1, 99, true), name: str(0, LEN.playerName), role: str(0, LEN.role), isGoalkeeper: bool, locked: bool }), 0, 64),
  phases: arr(
    obj({
      id,
      name: str(1, LEN.phase),
      caption: str(0, LEN.caption),
      tokens: { t: 'map', of: pt },
      ball: obj({ x: num(0, PITCH_W), y: num(0, PITCH_H), visible: bool, possessorId: nullable(id) }),
      movements: arr(movement, 0, 65),
      annotations: arr(annotation, 0, MAX_ANNOTATIONS),
      transition: obj({ durationMs: num(DURATION_MIN, DURATION_MAX), easing: en('linear', 'easeInOut') }),
    }),
    1,
    MAX_PHASES,
  ),
  settings: obj({
    showNames: bool,
    showImplied: bool,
    linesDuringPlayback: en('fade', 'keep', 'trail'),
    holdMs: num(0, HOLD_MAX),
    loop: bool,
    exportMark: bool,
  }),
  createdAt: str(1, 40),
  updatedAt: str(1, 40),
  revision: num(0, Number.MAX_SAFE_INTEGER, true),
});

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function pathLabel(path: string): string {
  // "board.phases.2.tokens.p_19" reads better as "Phase 3: tokens.p_19"
  const m = /^board\.phases\.(\d+)\.?(.*)$/.exec(path);
  if (m) return `Phase ${Number(m[1]) + 1}${m[2] ? `: ${m[2]}` : ''}`;
  return path.replace(/^board\.?/, '') || 'The file';
}

function check(v: unknown, s: S, path: string, out: string[]): void {
  if (out.length >= 20) return;
  const where = pathLabel(path);
  switch (s.t) {
    case 'str':
      if (typeof v !== 'string') out.push(`${where} must be text`);
      else if (v.length < s.min || v.length > s.max) out.push(`${where} must be ${s.min} to ${s.max} characters long`);
      return;
    case 'num':
      if (typeof v !== 'number' || !Number.isFinite(v)) out.push(`${where} must be a number`);
      else if (v < s.min || v > s.max) out.push(`${where} is ${v}, outside ${s.min} to ${s.max}`);
      else if (s.int && !Number.isInteger(v)) out.push(`${where} must be a whole number`);
      return;
    case 'bool':
      if (typeof v !== 'boolean') out.push(`${where} must be true or false`);
      return;
    case 'enum':
      if (typeof v !== 'string' || !s.v.includes(v)) out.push(`${where} has a value that is not allowed`);
      return;
    case 'nullable':
      if (v !== null) check(v, s.of, path, out);
      return;
    case 'arr':
      if (!Array.isArray(v)) out.push(`${where} must be a list`);
      else if (v.length < (s.min ?? 0) || v.length > (s.max ?? Infinity)) out.push(`${where} has ${v.length} items, outside ${s.min} to ${s.max}`);
      else v.forEach((item, i) => check(item, s.of, `${path}.${i}`, out));
      return;
    case 'map':
      if (typeof v !== 'object' || v === null || Array.isArray(v)) out.push(`${where} must be an object`);
      else for (const k of Object.keys(v)) check((v as Record<string, unknown>)[k], s.of, `${path}.${k}`, out);
      return;
    case 'union': {
      const kind = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[s.key] : undefined;
      if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(s.v, kind)) out.push(`${where} has an unknown ${s.key}`);
      else check(v, s.v[kind], path, out);
      return;
    }
    case 'obj': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        out.push(`${where} must be an object`);
        return;
      }
      const rec = v as Record<string, unknown>;
      for (const k of Object.keys(rec)) if (!Object.prototype.hasOwnProperty.call(s.k, k)) out.push(`${where} has an unknown field "${k}"`);
      for (const k of Object.keys(s.k)) {
        if (!Object.prototype.hasOwnProperty.call(rec, k)) out.push(`${where} is missing "${k}"`);
        else check(rec[k], s.k[k], path ? `${path}.${k}` : k, out);
      }
    }
  }
}

function scan(v: unknown, depth: number): string | null {
  if (depth > IMPORT_MAX_DEPTH) return 'The file is nested too deeply';
  if (typeof v !== 'object' || v === null) return null;
  for (const k of Object.keys(v)) {
    if (FORBIDDEN.has(k)) return `The file contains a forbidden key "${k}"`;
    const r = scan((v as Record<string, unknown>)[k], depth + 1);
    if (r) return r;
  }
  return null;
}

export type ParseResult =
  | { ok: true; board: Board }
  | { ok: false; reason: 'too-large' | 'newer' | 'invalid'; problems: string[] };

// IMP-002 to IMP-006. Never touches a stored board (DAT-022).
export function parseProject(text: string, byteLength = text.length): ParseResult {
  const bad = (problems: string[], reason: 'too-large' | 'newer' | 'invalid' = 'invalid'): ParseResult => ({ ok: false, reason, problems: problems.slice(0, 5) });
  if (byteLength > IMPORT_MAX_BYTES) return bad([], 'too-large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad(['The file is not a PitchPlay project (it is not valid JSON)']);
  }
  const forbidden = scan(raw, 1);
  if (forbidden) return bad([forbidden]);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad(['The file is not a PitchPlay project']);
  const env = raw as Record<string, unknown>;
  if (typeof env.schemaVersion !== 'number') return bad(['The file has no format version']);
  if (env.schemaVersion > SCHEMA_VERSION) return bad([], 'newer');
  if (env.schemaVersion !== SCHEMA_VERSION) return bad([`Format version ${env.schemaVersion} is not supported`]); // DAT-026
  const problems: string[] = [];
  for (const k of Object.keys(env)) if (!['schemaVersion', 'appVersion', 'board'].includes(k)) problems.push(`The file has an unknown field "${k}"`);
  if (typeof env.appVersion !== 'string') problems.push('The file has no app version');
  check(env.board, boardSchema, 'board', problems);
  if (problems.length) return bad(problems);
  const board = { ...(env.board as object), schemaVersion: SCHEMA_VERSION, appVersion: String(env.appVersion) } as Board;
  const semantic = checkInvariants(board);
  if (semantic.length) return bad(semantic);
  return { ok: true, board };
}

// EXP-016, DAT-023: the full board in a versioned envelope. No view preferences, history or personal metadata.
export function serializeProject(board: Board): string {
  const { schemaVersion: _s, appVersion: _a, ...rest } = board;
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, board: rest }, null, 2);
}

// Used when a stored record is read back (PST-011).
export function isValidStoredBoard(b: unknown): b is Board {
  if (typeof b !== 'object' || b === null) return false;
  const { schemaVersion, appVersion, ...rest } = b as Record<string, unknown>;
  if (schemaVersion !== SCHEMA_VERSION || typeof appVersion !== 'string') return false;
  const problems: string[] = [];
  check(rest, boardSchema, 'board', problems);
  return problems.length === 0 && checkInvariants(b as Board).length === 0;
}
