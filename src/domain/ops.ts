// Document operations. Every exported op is a pure function: it takes a board and returns a new board
// (revision + 1) or null when nothing changes. Callers commit the result as one undo entry (INT-001).
import type {
  Annotation,
  Board,
  BoardSettings,
  Format,
  LineType,
  MoveType,
  Movement,
  Phase,
  Player,
  Pt,
  Slot,
  Subject,
  Team,
  Transition,
} from './types';
import {
  APP_VERSION,
  DURATION_DEFAULT,
  DURATION_MAX,
  DURATION_MIN,
  FORMAT_SIZE,
  HOLD_DEFAULT,
  LEN,
  MAX_ANNOTATIONS,
  MAX_PHASES,
  MIN_ZONE,
  PITCH_H,
  PITCH_W,
  POSSESSION_OFFSET,
  SCHEMA_VERSION,
  TIMING_MIN_SPAN,
  teamLimit,
} from './params';
import { clamp, clampPt, dist, round2, roundPt, toward } from './geometry';
import { PRESETS, getPreset, slotPosition, type PresetSlot } from './presets';

// ---------- ids and small accessors ----------

export function newId(prefix: string): string {
  const raw = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`;
  return `${prefix}_${raw.replace(/[^a-z0-9]/gi, '').slice(0, 10)}`;
}
export const newBoardId = () => globalThis.crypto.randomUUID();

const clone = <T>(v: T): T => structuredClone(v);

export const lastIdx = (b: Board) => b.phases.length - 1;
export const playerById = (b: Board, id: string) => b.roster.find((p) => p.id === id);
export const teamById = (b: Board, id: string) => b.teams.find((t) => t.id === id)!;
export const teamBySlot = (b: Board, slot: Slot) => b.teams.find((t) => t.slot === slot)!;
export const primaryTeam = (b: Board) => teamById(b, b.primaryTeamId);
export const otherTeam = (b: Board) => b.teams.find((t) => t.id !== b.primaryTeamId)!;
export const teamPlayers = (b: Board, teamId: string) => b.roster.filter((p) => p.teamId === teamId);
export function attacksOf(b: Board, teamId: string): 'right' | 'left' {
  const isA = teamById(b, teamId).slot === 'A';
  return isA ? b.teamAAttacks : b.teamAAttacks === 'right' ? 'left' : 'right';
}
export const playerTag = (p: Player) => `#${p.number}`;
export const playerLabel = (p: Player) => (p.name ? `#${p.number} ${p.name}` : `#${p.number}`);

export const sameSubject = (a: Subject, b: Subject) =>
  a.kind === 'ball' ? b.kind === 'ball' : b.kind === 'player' && a.playerId === b.playerId;
export const subjectPos = (ph: Phase, s: Subject): Pt =>
  s.kind === 'ball' ? { x: ph.ball.x, y: ph.ball.y } : ph.tokens[s.playerId];
export const movementOf = (ph: Phase, s: Subject) => ph.movements.find((m) => sameSubject(m.subject, s));
export const playerMovement = (ph: Phase, playerId: string) => movementOf(ph, { kind: 'player', playerId });
export const ballMovement = (ph: Phase) => movementOf(ph, { kind: 'ball' });

// CORE-005: the tip is the subject's position in the next phase, or the pending tip on the last phase.
export function tipOf(b: Board, i: number, m: Movement): Pt {
  if (i >= lastIdx(b)) return m.pendingTip ?? subjectPos(b.phases[i], m.subject);
  return subjectPos(b.phases[i + 1], m.subject);
}

// LIN-004: next-phase position, else pending tip, else current position.
export function landingPoint(b: Board, i: number, playerId: string): Pt {
  const ph = b.phases[i];
  if (i < lastIdx(b)) return b.phases[i + 1].tokens[playerId];
  return playerMovement(ph, playerId)?.pendingTip ?? ph.tokens[playerId];
}

export function subjectName(b: Board, s: Subject): string {
  if (s.kind === 'ball') return 'the ball';
  const p = playerById(b, s.playerId);
  return p ? playerTag(p) : 'player';
}

// ---------- transaction helper and invariant maintenance ----------

function edit(board: Board, fn: (d: Board) => void): Board {
  const d = clone(board);
  fn(d);
  sync(d);
  d.revision = board.revision + 1;
  d.updatedAt = new Date().toISOString();
  return d;
}

// Keeps linked data consistent after any change (DAT-008 to DAT-014).
export function sync(d: Board): void {
  const n = d.phases.length;
  for (let pass = 0; pass < 2; pass++) {
    d.phases.forEach((ph, i) => {
      const last = i === n - 1;
      const next = last ? null : d.phases[i + 1];
      // DAT-010: pending tips exist only on the last phase.
      ph.movements = ph.movements.filter((m) => {
        if (!last) {
          m.pendingTip = null;
          return true;
        }
        return m.pendingTip !== null;
      });
      // DAT-012: a ball carry needs its carrier's carry and possession at the start.
      const bm = ballMovement(ph);
      if (bm && bm.type === 'carry') {
        const cid = bm.carrierId;
        const pm = cid ? playerMovement(ph, cid) : undefined;
        const broken =
          !cid || !pm || pm.type !== 'carry' || ph.ball.possessorId !== cid || (next !== null && next.ball.possessorId !== cid);
        if (broken) {
          ph.movements = ph.movements.filter((m) => m !== bm);
        } else if (last && pm.pendingTip) {
          const c = ph.tokens[cid];
          bm.pendingTip = roundPt(clampPt({ x: pm.pendingTip.x + ph.ball.x - c.x, y: pm.pendingTip.y + ph.ball.y - c.y }));
        }
      }
      const ballCarry = ph.movements.find((m) => m.subject.kind === 'ball' && m.type === 'carry');
      for (const m of ph.movements) {
        if (m.subject.kind === 'player' && m.type === 'carry' && ballCarry?.carrierId !== m.subject.playerId) m.type = 'run';
        if (m.type !== 'pass') m.receiverId = null; // DAT-013
        if (!(m.subject.kind === 'ball' && m.type === 'carry')) m.carrierId = null;
        if (m.type === 'pass' && m.receiverId) {
          if (next) {
            if (next.ball.possessorId !== m.receiverId) m.receiverId = null; // DAT-014
          } else {
            const land = landingPoint(d, i, m.receiverId);
            m.pendingTip = roundPt(clampPt(toward(land, ph.ball, POSSESSION_OFFSET)));
          }
        }
      }
      // DAT-011: no movement shorter than 1 u.
      ph.movements = ph.movements.filter((m) => dist(subjectPos(ph, m.subject), tipOf(d, i, m)) >= 1);
    });
  }
}

function placePlayer(ph: Phase, id: string, to: Pt): void {
  const from = ph.tokens[id];
  const p = roundPt(clampPt(to));
  if (ph.ball.possessorId === id) {
    const b = clampPt({ x: ph.ball.x + p.x - from.x, y: ph.ball.y + p.y - from.y });
    ph.ball.x = round2(b.x);
    ph.ball.y = round2(b.y);
  }
  ph.tokens[id] = p;
}

function setBall(ph: Phase, p: Pt, possessorId: string | null): void {
  const c = roundPt(clampPt(p));
  ph.ball.x = c.x;
  ph.ball.y = c.y;
  ph.ball.possessorId = possessorId;
}

const attackVec = (b: Board, teamId: string): Pt => ({ x: attacksOf(b, teamId) === 'right' ? 1 : -1, y: 0 });

// ---------- board creation (BRD-004, BRD-008) ----------

export interface CreateSpec {
  title?: string;
  format?: Format;
  presetA?: string;
  presetB?: string;
  nameA?: string;
  nameB?: string;
  colorA?: string;
  colorB?: string;
  primary?: Slot;
  teamAAttacks?: 'right' | 'left';
}

export const cleanTitle = (s: string | undefined, fallback: string) => {
  const t = (s ?? '').trim().slice(0, LEN.title);
  return t.length ? t : fallback;
};

export function createBoard(spec: CreateSpec = {}): Board {
  const format = spec.format ?? '5v5';
  const teamAAttacks = spec.teamAAttacks ?? 'right';
  const colorA = spec.colorA ?? 'team-1';
  let colorB = spec.colorB ?? 'team-2';
  if (colorB === colorA) colorB = colorA === 'team-2' ? 'team-1' : 'team-2';
  const teams: [Team, Team] = [
    { id: 't_home', slot: 'A', name: cleanTitle(spec.nameA, 'HOME').slice(0, LEN.team), color: colorA, marker: 'solid' },
    { id: 't_away', slot: 'B', name: cleanTitle(spec.nameB, 'AWAY').slice(0, LEN.team), color: colorB, marker: 'outlined' },
  ];
  const roster: Player[] = [];
  const tokens: Record<string, Pt> = {};
  const fill = (team: Team, presetName: string | undefined, attacks: 'right' | 'left') => {
    const preset = getPreset(format, presetName ?? PRESETS[format][0].name);
    for (const s of preset.slots) {
      const id = newId('p');
      roster.push({ id, teamId: team.id, number: s.number, name: '', role: s.role, isGoalkeeper: s.isGoalkeeper, locked: false });
      tokens[id] = slotPosition(s, attacks);
    }
  };
  fill(teams[0], spec.presetA, teamAAttacks);
  fill(teams[1], spec.presetB, teamAAttacks === 'right' ? 'left' : 'right');
  const now = new Date().toISOString();
  return {
    id: newBoardId(),
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    title: cleanTitle(spec.title, 'Untitled tactic'),
    format,
    pitchTemplate: format,
    pitchTheme: 'grass',
    teams,
    primaryTeamId: spec.primary === 'B' ? teams[1].id : teams[0].id,
    teamAAttacks,
    roster,
    phases: [
      {
        id: newId('ph'),
        name: 'Starting shape',
        caption: '',
        tokens,
        ball: { x: PITCH_W / 2, y: PITCH_H / 2, visible: true, possessorId: null },
        movements: [],
        annotations: [],
        transition: { durationMs: DURATION_DEFAULT, easing: 'easeInOut' },
      },
    ],
    settings: { showNames: false, showImplied: false, linesDuringPlayback: 'fade', holdMs: HOLD_DEFAULT, loop: false, exportMark: true },
    createdAt: now,
    updatedAt: now,
    revision: 0,
  };
}

// DAT-025: a copy gets a new board ID and its own record.
export function copyBoard(board: Board, title: string): Board {
  const d = clone(board);
  const now = new Date().toISOString();
  d.id = newBoardId();
  d.title = title.slice(0, LEN.title);
  d.revision = 0;
  d.createdAt = now;
  d.updatedAt = now;
  return d;
}

// ---------- players and ball (PLY, BAL) ----------

export interface MoveOpts {
  snapU?: number; // PARAM-09 converted to canonical units by the caller
  eligible?: (playerId: string) => boolean; // hidden and ghosted players cannot take the ball
}

// PLY-008 to PLY-012, PLY-022, BAL-002 to BAL-005. Returns null when nothing can move.
export function moveSelection(
  board: Board,
  i: number,
  sel: { players: string[]; ball: boolean },
  dx: number,
  dy: number,
  opts: MoveOpts = {},
): Board | null {
  const ph0 = board.phases[i];
  const ids = sel.players.filter((id) => ph0.tokens[id]);
  if (!ids.length && !sel.ball) return null;
  if (ids.some((id) => playerById(board, id)?.locked)) return null;
  const pts = ids.map((id) => ph0.tokens[id]);
  if (sel.ball) pts.push(ph0.ball);
  // The group stops when any member reaches the edge.
  dx = clamp(dx, -Math.min(...pts.map((p) => p.x)), PITCH_W - Math.max(...pts.map((p) => p.x)));
  dy = clamp(dy, -Math.min(...pts.map((p) => p.y)), PITCH_H - Math.max(...pts.map((p) => p.y)));
  if (Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005) return null;
  return edit(board, (d) => {
    const ph = d.phases[i];
    const possessorMoved = !!ph.ball.possessorId && ids.includes(ph.ball.possessorId);
    for (const id of ids) {
      const to = { x: ph.tokens[id].x + dx, y: ph.tokens[id].y + dy };
      if (sel.ball && ph.ball.possessorId === id) ph.tokens[id] = roundPt(clampPt(to));
      else placePlayer(ph, id, to);
    }
    if (sel.ball) {
      const drop = roundPt(clampPt({ x: ph.ball.x + dx, y: ph.ball.y + dy }));
      ph.ball.x = drop.x;
      ph.ball.y = drop.y;
      if (!possessorMoved) {
        const snap = opts.snapU ?? 0;
        if (ph.ball.possessorId && dist(drop, ph.tokens[ph.ball.possessorId]) > snap) ph.ball.possessorId = null; // BAL-004
        if (!ids.length && snap > 0) {
          // BAL-003: dropped near a player.
          let best: string | null = null;
          let bestD = snap;
          for (const p of d.roster) {
            if (opts.eligible && !opts.eligible(p.id)) continue;
            const dd = dist(drop, ph.tokens[p.id]);
            if (dd <= bestD) {
              bestD = dd;
              best = p.id;
            }
          }
          if (best) {
            const c = ph.tokens[best];
            setBall(ph, toward(c, drop, POSSESSION_OFFSET, attackVec(d, playerById(d, best)!.teamId)), best);
          }
        }
      }
    }
  });
}

export function lowestFreeNumber(b: Board, teamId: string): number {
  const used = new Set(teamPlayers(b, teamId).map((p) => p.number));
  for (let n = 1; n <= 99; n++) if (!used.has(n)) return n;
  return 99;
}

export const teamIsFull = (b: Board, teamId: string) => teamPlayers(b, teamId).length >= teamLimit(b.format);

// PLY-002: same position in every phase.
export function addPlayer(board: Board, teamId: string, at: Pt): { board: Board; playerId: string } | null {
  if (teamIsFull(board, teamId)) return null;
  const id = newId('p');
  const p = roundPt(clampPt(at));
  const next = edit(board, (d) => {
    d.roster.push({ id, teamId, number: lowestFreeNumber(d, teamId), name: '', role: '', isGoalkeeper: false, locked: false });
    for (const ph of d.phases) ph.tokens[id] = { ...p };
  });
  return { board: next, playerId: id };
}

// PLY-020
export function duplicatePlayer(board: Board, playerId: string): { board: Board; playerId: string } | null {
  const src = playerById(board, playerId);
  if (!src || teamIsFull(board, src.teamId)) return null;
  const id = newId('p');
  const next = edit(board, (d) => {
    d.roster.push({ ...src, id, number: lowestFreeNumber(d, src.teamId), isGoalkeeper: false, locked: false });
    for (const ph of d.phases) ph.tokens[id] = roundPt(clampPt({ x: ph.tokens[playerId].x + 30, y: ph.tokens[playerId].y + 30 }));
  });
  return { board: next, playerId: id };
}

export function validNumber(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 99;
}

// PLY-014, PLY-017, PLY-018. The caller validates the number first.
export function updatePlayer(board: Board, playerId: string, patch: Partial<Omit<Player, 'id'>>): Board | null {
  const p = playerById(board, playerId);
  if (!p) return null;
  if (patch.number !== undefined && !validNumber(patch.number)) return null;
  if (patch.teamId !== undefined && patch.teamId !== p.teamId && teamIsFull(board, patch.teamId)) return null;
  const clean: Partial<Player> = { ...patch };
  if (clean.name !== undefined) clean.name = clean.name.trim().slice(0, LEN.playerName);
  if (clean.role !== undefined) clean.role = clean.role.trim().slice(0, LEN.role);
  if ((Object.keys(clean) as (keyof Player)[]).every((k) => clean[k] === p[k])) return null;
  return edit(board, (d) => Object.assign(playerById(d, playerId)!, clean));
}

export function duplicateNumber(b: Board, playerId: string, number: number): boolean {
  const p = playerById(b, playerId);
  return !!p && b.roster.some((o) => o.id !== playerId && o.teamId === p.teamId && o.number === number);
}

// Counts shown in the PLY-019 confirmation.
export function playerLinks(b: Board, ids: string[]): { lines: number; ballLinks: number } {
  const set = new Set(ids);
  let lines = 0;
  let ballLinks = 0;
  for (const ph of b.phases) {
    if (ph.ball.possessorId && set.has(ph.ball.possessorId)) ballLinks++;
    for (const m of ph.movements) {
      if (m.subject.kind === 'player' && set.has(m.subject.playerId)) lines++;
      else if ((m.receiverId && set.has(m.receiverId)) || (m.carrierId && set.has(m.carrierId))) ballLinks++;
    }
  }
  return { lines, ballLinks };
}

// PLY-019, PLY-023: remove from the roster and from every phase, with linked data.
export function deletePlayers(board: Board, ids: string[]): Board | null {
  const set = new Set(ids.filter((id) => playerById(board, id) && !playerById(board, id)!.locked));
  if (!set.size) return null;
  return edit(board, (d) => {
    d.roster = d.roster.filter((p) => !set.has(p.id));
    for (const ph of d.phases) {
      for (const id of set) delete ph.tokens[id];
      ph.movements = ph.movements.filter(
        (m) => !(m.subject.kind === 'player' && set.has(m.subject.playerId)) && !(m.carrierId && set.has(m.carrierId)),
      );
      for (const m of ph.movements) if (m.receiverId && set.has(m.receiverId)) m.receiverId = null;
      if (ph.ball.possessorId && set.has(ph.ball.possessorId)) ph.ball.possessorId = null;
    }
  });
}

// BAL-006 and the "Give ball" quick action.
export function setPossession(board: Board, i: number, playerId: string | null): Board | null {
  const ph0 = board.phases[i];
  if (ph0.ball.possessorId === playerId) return null;
  return edit(board, (d) => {
    const ph = d.phases[i];
    if (!playerId) {
      ph.ball.possessorId = null;
      return;
    }
    const c = ph.tokens[playerId];
    const v = attackVec(d, playerById(d, playerId)!.teamId);
    setBall(ph, { x: c.x + v.x * POSSESSION_OFFSET, y: c.y }, playerId);
  });
}

export function setBallVisible(board: Board, i: number, visible: boolean): Board | null {
  if (board.phases[i].ball.visible === visible) return null;
  return edit(board, (d) => {
    d.phases[i].ball.visible = visible;
  });
}

// ---------- movements (MOV, LIN) ----------

export interface MovementSpec {
  subject: Subject;
  type: MoveType;
  tip: Pt;
  receiverId?: string | null;
  bend?: number;
}
export interface AddMovementResult {
  board: Board;
  movementId: string;
  replaced: Movement | null; // MOV-007
  movedInNext: boolean; // MOV-001
}

const blankMovement = (subject: Subject, type: MoveType, bend = 0): Movement => ({
  id: newId('m'),
  subject,
  type,
  bend,
  start: 0,
  end: 1,
  receiverId: null,
  carrierId: null,
  label: '',
  pendingTip: null,
});

function applyBallTip(d: Board, i: number, m: Movement, tip: Pt, receiverId: string | null): void {
  const ph = d.phases[i];
  const next = i < lastIdx(d) ? d.phases[i + 1] : null;
  const recv = m.type === 'pass' ? receiverId : null;
  m.receiverId = recv;
  if (recv) {
    const land = landingPoint(d, i, recv);
    const at = toward(land, ph.ball, POSSESSION_OFFSET);
    if (next) setBall(next, at, recv);
    else m.pendingTip = roundPt(clampPt(at));
  } else if (next) setBall(next, tip, null);
  else m.pendingTip = roundPt(clampPt(tip));
}

function applyPlayerTip(d: Board, i: number, m: Movement, tip: Pt): void {
  if (m.subject.kind !== 'player') return;
  const next = i < lastIdx(d) ? d.phases[i + 1] : null;
  if (next) placePlayer(next, m.subject.playerId, tip);
  else m.pendingTip = roundPt(clampPt(tip));
}

// MOV-001, MOV-002, MOV-007, MOV-009, MOV-012, MOV-013.
export function addMovement(board: Board, i: number, spec: MovementSpec): AddMovementResult | null {
  const ph0 = board.phases[i];
  const tip = roundPt(clampPt(spec.tip));
  let { type } = spec;
  const subject = spec.subject;
  if (subject.kind === 'player') {
    const p = playerById(board, subject.playerId);
    if (!p || p.locked) return null; // PLY-018
    if (type === 'pass' || type === 'shot') return null;
    if (type === 'carry' && ph0.ball.possessorId !== p.id) type = 'run';
  } else {
    if (!ph0.ball.visible) return null; // BAL-007
    if (type === 'run') type = 'pass';
    if (type === 'carry') return null; // a carry is drawn from the carrier
  }
  if (dist(subjectPos(ph0, subject), tip) < 1) return null;
  const replaced = movementOf(ph0, subject) ?? null;
  let movementId = '';
  const next = edit(board, (d) => {
    const ph = d.phases[i];
    const hasNext = i < lastIdx(d);
    ph.movements = ph.movements.filter((m) => !sameSubject(m.subject, subject));
    const m = blankMovement(subject, type, spec.bend ?? 0);
    movementId = m.id;
    ph.movements.push(m);
    if (subject.kind === 'player') {
      if (type === 'carry') {
        const c = ph.tokens[subject.playerId];
        const off = { x: ph.ball.x - c.x, y: ph.ball.y - c.y };
        ph.movements = ph.movements.filter((x) => x.subject.kind !== 'ball');
        const bm = blankMovement({ kind: 'ball' }, 'carry', m.bend);
        bm.carrierId = subject.playerId;
        ph.movements.push(bm);
        if (hasNext) {
          const nx = d.phases[i + 1];
          nx.tokens[subject.playerId] = tip;
          setBall(nx, { x: tip.x + off.x, y: tip.y + off.y }, subject.playerId);
        } else {
          m.pendingTip = tip;
          bm.pendingTip = roundPt(clampPt({ x: tip.x + off.x, y: tip.y + off.y }));
        }
      } else applyPlayerTip(d, i, m, tip);
    } else applyBallTip(d, i, m, tip, spec.receiverId ?? null);
  });
  if (!next.phases[i].movements.some((m) => m.id === movementId)) return null;
  return { board: next, movementId, replaced, movedInNext: i < lastIdx(board) };
}

// MOV-005: dragging a tip moves the subject in the next phase (or the pending tip).
export function setMovementTip(board: Board, i: number, movementId: string, tip: Pt, receiverId: string | null = null): Board | null {
  const m0 = board.phases[i].movements.find((m) => m.id === movementId);
  if (!m0) return null;
  if (m0.subject.kind === 'player' && playerById(board, m0.subject.playerId)?.locked) return null;
  return edit(board, (d) => {
    const ph = d.phases[i];
    const m = ph.movements.find((x) => x.id === movementId)!;
    if (m.subject.kind === 'player') applyPlayerTip(d, i, m, tip);
    else if (m.type === 'carry' && m.carrierId) {
      // The ball travels with its carrier, so move the carrier's tip.
      const c = ph.tokens[m.carrierId];
      const pm = playerMovement(ph, m.carrierId);
      if (pm) applyPlayerTip(d, i, pm, { x: tip.x - (ph.ball.x - c.x), y: tip.y - (ph.ball.y - c.y) });
    } else applyBallTip(d, i, m, tip, receiverId);
  });
}

export interface MovementPatch {
  bend?: number;
  start?: number;
  end?: number;
  label?: string;
  type?: MoveType;
}

// LIN-006, LIN-008, LIN-009, TRN-013.
export function updateMovement(board: Board, i: number, movementId: string, patch: MovementPatch): Board | null {
  const m0 = board.phases[i].movements.find((m) => m.id === movementId);
  if (!m0) return null;
  const ph0 = board.phases[i];
  if (patch.type && patch.type !== m0.type) {
    const ok =
      m0.subject.kind === 'ball'
        ? m0.type !== 'carry' && (patch.type === 'pass' || patch.type === 'shot')
        : (patch.type === 'run' || patch.type === 'carry') && (patch.type === 'run' || ph0.ball.possessorId === m0.subject.playerId);
    if (!ok) return null;
  }
  return edit(board, (d) => {
    const ph = d.phases[i];
    const m = ph.movements.find((x) => x.id === movementId)!;
    if (patch.bend !== undefined) m.bend = clamp(round2(patch.bend), -1, 1);
    if (patch.label !== undefined) m.label = patch.label.slice(0, LEN.lineLabel);
    if (patch.start !== undefined || patch.end !== undefined) {
      let s = clamp(patch.start ?? m.start, 0, 1 - TIMING_MIN_SPAN);
      let e = clamp(patch.end ?? m.end, TIMING_MIN_SPAN, 1);
      if (e - s < TIMING_MIN_SPAN) {
        if (patch.start !== undefined) e = Math.min(1, s + TIMING_MIN_SPAN);
        s = Math.min(s, e - TIMING_MIN_SPAN);
      }
      m.start = round2(s);
      m.end = round2(e);
    }
    if (patch.type && patch.type !== m.type) {
      const tip = tipOf(d, i, m);
      const hasNext = i < lastIdx(d);
      if (m.subject.kind === 'ball') {
        m.type = patch.type;
        if (patch.type === 'shot') {
          m.receiverId = null;
          if (hasNext) d.phases[i + 1].ball.possessorId = null;
        }
      } else if (patch.type === 'carry') {
        const pid = m.subject.playerId;
        const c = ph.tokens[pid];
        const off = { x: ph.ball.x - c.x, y: ph.ball.y - c.y };
        m.type = 'carry';
        ph.movements = ph.movements.filter((x) => x.subject.kind !== 'ball');
        const bm = blankMovement({ kind: 'ball' }, 'carry', m.bend);
        bm.carrierId = pid;
        ph.movements.push(bm);
        if (hasNext) setBall(d.phases[i + 1], { x: tip.x + off.x, y: tip.y + off.y }, pid);
        else bm.pendingTip = roundPt(clampPt({ x: tip.x + off.x, y: tip.y + off.y }));
      } else {
        m.type = 'run';
        ph.movements = ph.movements.filter((x) => !(x.subject.kind === 'ball' && x.type === 'carry'));
      }
    }
    // A carry pair shares one curve and one timing.
    if (m.type === 'carry') {
      const pair =
        m.subject.kind === 'player'
          ? ph.movements.find((x) => x.subject.kind === 'ball' && x.type === 'carry')
          : m.carrierId
            ? playerMovement(ph, m.carrierId)
            : undefined;
      if (pair) {
        pair.bend = m.bend;
        pair.start = m.start;
        pair.end = m.end;
      }
    }
  });
}

// MOV-018
export function deleteMovement(board: Board, i: number, movementId: string, keepInPlace = false): Board | null {
  const m0 = board.phases[i].movements.find((m) => m.id === movementId);
  if (!m0) return null;
  return edit(board, (d) => {
    const ph = d.phases[i];
    const next = i < lastIdx(d) ? d.phases[i + 1] : null;
    const group = ph.movements.filter(
      (m) =>
        m.id === movementId ||
        (m0.type === 'carry' &&
          m.type === 'carry' &&
          (m0.subject.kind === 'player' ? m.carrierId === m0.subject.playerId : m.subject.kind === 'player' && m.subject.playerId === m0.carrierId)),
    );
    ph.movements = ph.movements.filter((m) => !group.includes(m));
    if (keepInPlace && next) {
      for (const m of group) {
        if (m.subject.kind === 'player') next.tokens[m.subject.playerId] = { ...ph.tokens[m.subject.playerId] };
        else setBall(next, ph.ball, ph.ball.possessorId);
      }
    }
  });
}

// LIN-010
export function unlinkReceiver(board: Board, i: number, movementId: string): Board | null {
  const m0 = board.phases[i].movements.find((m) => m.id === movementId);
  if (!m0 || !m0.receiverId) return null;
  return edit(board, (d) => {
    const m = d.phases[i].movements.find((x) => x.id === movementId)!;
    m.receiverId = null;
    if (i < lastIdx(d)) d.phases[i + 1].ball.possessorId = null;
  });
}

// ---------- annotations (LIN static, ZON, TXT, ANN) ----------

export const annotationsFull = (b: Board, i: number) => b.phases[i].annotations.length >= MAX_ANNOTATIONS;

function cleanAnnotation(a: Annotation): Annotation {
  if (a.kind === 'line') {
    return { ...a, from: roundPt(clampPt(a.from)), to: roundPt(clampPt(a.to)), bend: clamp(round2(a.bend), -1, 1), label: a.label.slice(0, LEN.lineLabel) };
  }
  if (a.kind === 'zone') {
    const w = clamp(a.w, MIN_ZONE, PITCH_W);
    const h = clamp(a.h, MIN_ZONE, PITCH_H);
    return {
      ...a,
      w: round2(w),
      h: round2(h),
      x: round2(clamp(a.x, 0, PITCH_W - w)),
      y: round2(clamp(a.y, 0, PITCH_H - h)),
      opacity: clamp(Math.round(a.opacity * 20) / 20, 0.1, 0.5),
      label: a.label.slice(0, LEN.lineLabel),
    };
  }
  const lines = a.text.split('\n').slice(0, 3).join('\n').slice(0, LEN.text);
  return { ...a, ...roundPt(clampPt(a)), text: lines };
}

export function makeLine(lineType: LineType, from: Pt, to: Pt, color = 'note-1'): Annotation {
  return { id: newId('a'), kind: 'line', lineType, from, to, bend: 0, color, label: '' };
}
// ZON-002: any drag direction, normalized to top-left plus size.
export function makeZone(shape: 'rect' | 'ellipse', a: Pt, b: Pt): Annotation {
  return {
    id: newId('a'),
    kind: 'zone',
    shape,
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
    fill: 'note-1',
    opacity: 0.25,
    outline: 'dashed',
    label: '',
  };
}
export function makeText(at: Pt, text: string): Annotation {
  return { id: newId('a'), kind: 'text', x: at.x, y: at.y, text, size: 'm', color: 'note-6', background: true, align: 'center' };
}

export function addAnnotation(board: Board, i: number, a: Annotation): Board | null {
  if (annotationsFull(board, i)) return null;
  if (a.kind === 'zone' && (a.w < MIN_ZONE || a.h < MIN_ZONE)) return null; // PARAM-11
  if (a.kind === 'text' && !a.text.trim()) return null; // TXT-003
  if (a.kind === 'line' && dist(a.from, a.to) < 1) return null;
  return edit(board, (d) => {
    d.phases[i].annotations.push(cleanAnnotation(a));
  });
}

export function updateAnnotation(board: Board, i: number, id: string, patch: Partial<Annotation>): Board | null {
  const a0 = board.phases[i].annotations.find((a) => a.id === id);
  if (!a0) return null;
  const merged = cleanAnnotation({ ...a0, ...patch } as Annotation);
  if (merged.kind === 'text' && !merged.text.trim()) return deleteAnnotation(board, i, id); // TXT-003
  if (JSON.stringify(merged) === JSON.stringify(a0)) return null;
  return edit(board, (d) => {
    const list = d.phases[i].annotations;
    list[list.findIndex((a) => a.id === id)] = merged;
  });
}

export function moveAnnotation(board: Board, i: number, id: string, dx: number, dy: number): Board | null {
  const a = board.phases[i].annotations.find((x) => x.id === id);
  if (!a) return null;
  if (a.kind === 'line') {
    const xs = [a.from.x, a.to.x];
    const ys = [a.from.y, a.to.y];
    dx = clamp(dx, -Math.min(...xs), PITCH_W - Math.max(...xs));
    dy = clamp(dy, -Math.min(...ys), PITCH_H - Math.max(...ys));
    return updateAnnotation(board, i, id, { from: { x: a.from.x + dx, y: a.from.y + dy }, to: { x: a.to.x + dx, y: a.to.y + dy } });
  }
  return updateAnnotation(board, i, id, { x: a.x + dx, y: a.y + dy });
}

export function deleteAnnotation(board: Board, i: number, id: string): Board | null {
  if (!board.phases[i].annotations.some((a) => a.id === id)) return null;
  return edit(board, (d) => {
    d.phases[i].annotations = d.phases[i].annotations.filter((a) => a.id !== id);
  });
}

// ZON-006
export function reorderAnnotation(board: Board, i: number, id: string, to: 'front' | 'back'): Board | null {
  const list = board.phases[i].annotations;
  const at = list.findIndex((a) => a.id === id);
  if (at < 0 || (to === 'front' ? at === list.length - 1 : at === 0)) return null;
  return edit(board, (d) => {
    const l = d.phases[i].annotations;
    const [a] = l.splice(at, 1);
    if (to === 'front') l.push(a);
    else l.unshift(a);
  });
}

export function drawingCounts(ph: Phase): { lines: number; zones: number; labels: number; total: number } {
  const lines = ph.movements.length + ph.annotations.filter((a) => a.kind === 'line').length;
  const zones = ph.annotations.filter((a) => a.kind === 'zone').length;
  const labels = ph.annotations.filter((a) => a.kind === 'text').length;
  return { lines, zones, labels, total: lines + zones + labels };
}

// ANN-003
export function clearDrawings(board: Board, i: number): Board | null {
  if (!drawingCounts(board.phases[i]).total) return null;
  return edit(board, (d) => {
    d.phases[i].annotations = [];
    d.phases[i].movements = [];
  });
}

// ---------- phases (PHS, MOV-003, MOV-008) ----------

export const phasesFull = (b: Board) => b.phases.length >= MAX_PHASES;

function nextPhaseName(b: Board): string {
  let k = b.phases.length + 1;
  const names = new Set(b.phases.map((p) => p.name));
  while (names.has(`Phase ${k}`)) k++;
  return `Phase ${k}`;
}

// PHS-002, PHS-003, MOV-003. Inserts right after phase i.
export function addPhase(board: Board, i: number, withDrawings = false): Board | null {
  if (phasesFull(board)) return null;
  return edit(board, (d) => {
    const src = d.phases[i];
    const oldNext = i < lastIdx(d) ? d.phases[i + 1] : null;
    const np: Phase = {
      id: newId('ph'),
      name: nextPhaseName(d),
      caption: '',
      tokens: clone(src.tokens),
      ball: clone(src.ball),
      movements: [],
      annotations: withDrawings ? src.annotations.map((a) => ({ ...clone(a), id: newId('a') })) : [],
      transition: clone(src.transition),
    };
    let ballMoved = false;
    for (const m of src.movements) {
      const tip = oldNext ? subjectPos(oldNext, m.subject) : (m.pendingTip ?? subjectPos(src, m.subject));
      if (m.subject.kind === 'player') np.tokens[m.subject.playerId] = { ...tip };
      else {
        ballMoved = true;
        const holder = m.type === 'pass' ? m.receiverId : m.type === 'carry' ? m.carrierId : null;
        setBall(np, tip, holder);
      }
      m.pendingTip = null;
    }
    const holder = np.ball.possessorId;
    if (holder) {
      if (!ballMoved) {
        // The possessor ran off without the ball: it stays where it was, free.
        if (dist(np.tokens[holder], src.tokens[holder]) > 1) np.ball.possessorId = null;
      } else if (oldNext) {
        // Keep the ball beside its holder even when the holder has no line of its own.
        const o = oldNext.tokens[holder];
        const h = np.tokens[holder];
        setBall(np, { x: h.x + oldNext.ball.x - o.x, y: h.y + oldNext.ball.y - o.y }, holder);
      }
    }
    d.phases.splice(i + 1, 0, np);
  });
}

export interface RestructureResult {
  board: Board;
  updated: number;
  removed: number;
}

// MOV-008: re-point movements after a structural change.
function restructure(board: Board, mutate: (d: Board) => void): RestructureResult {
  let updated = 0;
  let removed = 0;
  const next = edit(board, (d) => {
    const oldTips = new Map<string, Pt>();
    d.phases.forEach((ph, i) => ph.movements.forEach((m) => oldTips.set(m.id, tipOf(d, i, m))));
    mutate(d);
    const n = d.phases.length;
    let before = 0;
    d.phases.forEach((ph, i) =>
      ph.movements.forEach((m) => {
        before++;
        m.pendingTip = i === n - 1 ? (oldTips.get(m.id) ?? null) : null;
      }),
    );
    sync(d);
    let after = 0;
    d.phases.forEach((ph, i) =>
      ph.movements.forEach((m) => {
        after++;
        const o = oldTips.get(m.id);
        if (o && dist(o, tipOf(d, i, m)) > 0.01) updated++;
      }),
    );
    removed = before - after;
  });
  return { board: next, updated, removed };
}

// PHS-007
export function deletePhase(board: Board, i: number): RestructureResult | null {
  if (board.phases.length <= 1) return null;
  return restructure(board, (d) => {
    d.phases.splice(i, 1);
  });
}

// PHS-006
export function movePhase(board: Board, from: number, to: number): RestructureResult | null {
  if (from === to || to < 0 || to > lastIdx(board) || from < 0 || from > lastIdx(board)) return null;
  return restructure(board, (d) => {
    const [p] = d.phases.splice(from, 1);
    d.phases.splice(to, 0, p);
  });
}

// PHS-004: an empty name is rejected by the caller with an inline error.
export function renamePhase(board: Board, i: number, name: string): Board | null {
  const n = name.trim().slice(0, LEN.phase);
  if (!n || n === board.phases[i].name) return null;
  return edit(board, (d) => {
    d.phases[i].name = n;
  });
}

export function setCaption(board: Board, i: number, caption: string): Board | null {
  const c = caption.slice(0, LEN.caption);
  if (c === board.phases[i].caption) return null;
  return edit(board, (d) => {
    d.phases[i].caption = c;
  });
}

// TRN-012
export function setTransition(board: Board, i: number, patch: Partial<Transition>): Board | null {
  const t0 = board.phases[i].transition;
  const t: Transition = {
    durationMs: clamp(Math.round((patch.durationMs ?? t0.durationMs) / 250) * 250, DURATION_MIN, DURATION_MAX),
    easing: patch.easing ?? t0.easing,
  };
  if (t.durationMs === t0.durationMs && t.easing === t0.easing) return null;
  return edit(board, (d) => {
    d.phases[i].transition = t;
  });
}

// ---------- board settings (BRD-010, BRD-016 to BRD-021) ----------

export interface BoardPatch {
  title?: string;
  pitchTheme?: Board['pitchTheme'];
  pitchTemplate?: Format;
  primaryTeamId?: string;
  teamAAttacks?: 'right' | 'left';
  settings?: Partial<BoardSettings>;
}

export function updateBoard(board: Board, patch: BoardPatch): Board | null {
  const p: BoardPatch = { ...patch };
  if (p.title !== undefined) p.title = cleanTitle(p.title, board.title); // BRD-005
  const next = edit(board, (d) => {
    if (p.title !== undefined) d.title = p.title;
    if (p.pitchTheme) d.pitchTheme = p.pitchTheme;
    if (p.pitchTemplate) d.pitchTemplate = p.pitchTemplate;
    if (p.primaryTeamId && d.teams.some((t) => t.id === p.primaryTeamId)) d.primaryTeamId = p.primaryTeamId;
    if (p.teamAAttacks) d.teamAAttacks = p.teamAAttacks;
    if (p.settings) {
      Object.assign(d.settings, p.settings);
      d.settings.holdMs = clamp(Math.round(d.settings.holdMs), 0, 3000);
    }
  });
  const strip = (b: Board) => JSON.stringify({ ...b, revision: 0, updatedAt: '' });
  return strip(next) === strip(board) ? null : next;
}

// BRD-006, BRD-007, DAT-003: the two teams keep different colors and markers.
export function updateTeam(board: Board, teamId: string, patch: Partial<Pick<Team, 'name' | 'color' | 'marker'>>): Board | null {
  const t0 = teamById(board, teamId);
  const other = board.teams.find((t) => t.id !== teamId)!;
  const name = patch.name !== undefined ? patch.name.trim().slice(0, LEN.team) || t0.name : t0.name;
  if (patch.color && patch.color === other.color) return null;
  const color = patch.color ?? t0.color;
  const marker = patch.marker ?? t0.marker;
  if (name === t0.name && color === t0.color && marker === t0.marker) return null;
  return edit(board, (d) => {
    const t = teamById(d, teamId);
    t.name = name;
    t.color = color;
    if (marker !== t.marker) {
      const o = d.teams.find((x) => x.id !== teamId)!;
      o.marker = t.marker;
      t.marker = marker;
    }
  });
}

// ---------- formations (FRM) ----------

// FRM-003: goalkeeper to the goalkeeper slot, then nearest free slot, ties to the lower shirt number.
export function matchSlots(board: Board, teamId: string, slots: PresetSlot[], phaseIdx: number, skipLocked = true): Map<string, number> {
  const attacks = attacksOf(board, teamId);
  const ph = board.phases[phaseIdx];
  const out = new Map<string, number>();
  const free = new Set(slots.map((_, k) => k));
  const players = teamPlayers(board, teamId)
    .filter((p) => !(skipLocked && p.locked))
    .sort((a, b) => a.number - b.number);
  const gkSlot = slots.findIndex((s) => s.isGoalkeeper);
  const gk = players.find((p) => p.isGoalkeeper);
  if (gk && gkSlot >= 0) {
    out.set(gk.id, gkSlot);
    free.delete(gkSlot);
  }
  const rest = players.filter((p) => !out.has(p.id));
  while (free.size && rest.length) {
    let best: { pi: number; k: number; d: number } | null = null;
    rest.forEach((p, pi) => {
      for (const k of free) {
        const dd = dist(ph.tokens[p.id], slotPosition(slots[k], attacks));
        if (!best || dd < best.d - 0.001) best = { pi, k, d: dd };
      }
    });
    if (!best) break;
    const b: { pi: number; k: number } = best;
    out.set(rest[b.pi].id, b.k);
    free.delete(b.k);
    rest.splice(b.pi, 1);
  }
  return out;
}

export function applyFormation(board: Board, teamIds: string[], presetName: string, phaseIdx: number, allPhases: boolean): Board | null {
  const preset = getPreset(board.format, presetName);
  const next = edit(board, (d) => {
    for (const teamId of teamIds) {
      const attacks = attacksOf(d, teamId);
      const match = matchSlots(d, teamId, preset.slots, phaseIdx);
      const targets = allPhases ? d.phases : [d.phases[phaseIdx]];
      for (const ph of targets) for (const [pid, k] of match) placePlayer(ph, pid, slotPosition(preset.slots[k], attacks));
    }
  });
  return JSON.stringify(next.phases) === JSON.stringify(board.phases) ? null : next;
}

export interface FormatPlan {
  format: Format;
  perTeam: { teamId: string; preset: string; add: { number: number; role: string }[]; removeDefault: string[]; mustRemove: number }[];
}

// FRM-004 to FRM-006: what a format change would do, for the conversion preview.
export function planFormatChange(board: Board, format: Format): FormatPlan {
  const preset = PRESETS[format][0];
  const perTeam = board.teams.map((t) => {
    const players = teamPlayers(board, t.id);
    const match = matchSlots(board, t.id, preset.slots, 0, false);
    const usedSlots = new Set(match.values());
    const used = new Set(players.map((p) => p.number));
    const add: { number: number; role: string }[] = [];
    preset.slots.forEach((s, k) => {
      if (usedSlots.has(k)) return;
      let n = used.has(s.number) ? 1 : s.number;
      while (used.has(n) && n < 99) n++;
      used.add(n);
      add.push({ number: n, role: s.role });
    });
    const removeDefault =
      players.length > FORMAT_SIZE[format] ? players.filter((p) => !match.has(p.id) && !p.isGoalkeeper && !p.locked).map((p) => p.id) : [];
    return { teamId: t.id, preset: preset.name, add, removeDefault, mustRemove: Math.max(0, players.length - teamLimit(format)) };
  });
  return { format, perTeam };
}

// FRM-005 to FRM-007: one transaction.
export function changeFormat(board: Board, format: Format, removeIds: string[], switchTemplate = true): Board | null {
  if (format === board.format) return null;
  const preset = PRESETS[format][0];
  const removing = new Set(removeIds.filter((id) => !playerById(board, id)?.locked));
  for (const t of board.teams) {
    if (teamPlayers(board, t.id).filter((p) => !removing.has(p.id)).length > teamLimit(format)) return null;
  }
  let base = board;
  if (removing.size) base = deletePlayers(board, [...removing]) ?? board;
  const next = edit(base, (d) => {
    d.format = format;
    if (switchTemplate) d.pitchTemplate = format;
    for (const t of d.teams) {
      if (teamPlayers(d, t.id).length >= FORMAT_SIZE[format]) continue;
      const attacks = attacksOf(d, t.id);
      const match = matchSlots(d, t.id, preset.slots, 0, false);
      const usedSlots = new Set(match.values());
      preset.slots.forEach((s, k) => {
        if (usedSlots.has(k)) return;
        const used = new Set(teamPlayers(d, t.id).map((p) => p.number));
        let n = used.has(s.number) ? 1 : s.number;
        while (used.has(n) && n < 99) n++;
        const id = newId('p');
        d.roster.push({ id, teamId: t.id, number: n, name: '', role: s.role, isGoalkeeper: s.isGoalkeeper && !teamPlayers(d, t.id).some((p) => p.isGoalkeeper), locked: false });
        for (const ph of d.phases) ph.tokens[id] = slotPosition(s, attacks);
      });
    }
  });
  next.revision = board.revision + 1;
  return next;
}
