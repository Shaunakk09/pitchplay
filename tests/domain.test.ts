// Acceptance tests from PRD section 11 that can be proven at the domain level.
// Every test also checks the data integrity invariants (5.4) after each operation.
import { describe, expect, it } from 'vitest';
import type { Board, Movement } from '../src/domain/types';
import * as ops from '../src/domain/ops';
import { checkInvariants, parseProject, serializeProject } from '../src/domain/validate';
import { buildTimeline, frameAt, passArrivesEarly, sceneInTransition } from '../src/domain/playback';
import { cropX, metresReadout, viewLabel } from '../src/domain/labels';
import { dist, makePath, pointAtFraction } from '../src/domain/geometry';
import { PRESETS } from '../src/domain/presets';

const ok = (b: Board | null | undefined): Board => {
  expect(b).toBeTruthy();
  expect(checkInvariants(b!)).toEqual([]);
  return b!;
};
const byNum = (b: Board, slot: 'A' | 'B', n: number) => b.roster.find((p) => p.teamId === ops.teamBySlot(b, slot).id && p.number === n)!;
const ball: { kind: 'ball' } = { kind: 'ball' };
const player = (id: string) => ({ kind: 'player' as const, playerId: id });
const mv = (b: Board, i: number, id: string): Movement => b.phases[i].movements.find((m) => m.id === id)!;

describe('boards and formations', () => {
  it('AT-001 default board', () => {
    const b = ok(ops.createBoard());
    expect(b.title).toBe('Untitled tactic');
    expect(b.format).toBe('5v5');
    expect(b.phases).toHaveLength(1);
    expect(b.phases[0].name).toBe('Starting shape');
    expect(ops.teamPlayers(b, 't_home')).toHaveLength(5);
    expect(ops.teamPlayers(b, 't_away')).toHaveLength(5);
    expect(b.phases[0].ball).toEqual({ x: 500, y: 320, visible: true, possessorId: null });
    expect(b.revision).toBe(0);
  });

  it('AT-002 each format, one goalkeeper, AWAY rotated 180 degrees', () => {
    for (const [format, n] of [['7v7', 7], ['9v9', 9], ['11v11', 11]] as const) {
      const b = ok(ops.createBoard({ format }));
      const preset = PRESETS[format][0];
      for (const t of b.teams) {
        const ps = ops.teamPlayers(b, t.id);
        expect(ps).toHaveLength(n);
        expect(ps.filter((p) => p.isGoalkeeper)).toHaveLength(1);
      }
      preset.slots.forEach((s) => {
        expect(b.phases[0].tokens[byNum(b, 'A', s.number).id]).toEqual({ x: s.x, y: s.y });
        expect(b.phases[0].tokens[byNum(b, 'B', s.number).id]).toEqual({ x: 1000 - s.x, y: 640 - s.y });
      });
    }
  });

  it('AT-003 blank title falls back', () => {
    expect(ops.createBoard({ title: '   ' }).title).toBe('Untitled tactic');
  });

  it('AT-006 a duplicate has a new ID and leaves the original alone', () => {
    const b = ops.createBoard();
    const snap = JSON.stringify(b);
    const c = ok(ops.copyBoard(b, `${b.title} (copy)`));
    expect(c.id).not.toBe(b.id);
    ok(ops.addPhase(c, 0));
    expect(JSON.stringify(b)).toBe(snap);
  });

  it('AT-008 apply formation moves matched players only', () => {
    let b = ops.createBoard({ format: '11v11' });
    const home = ops.teamBySlot(b, 'A').id;
    // scatter HOME
    ops.teamPlayers(b, home).forEach((p, k) => {
      b = ok(ops.moveSelection(b, 0, { players: [p.id], ball: false }, 37 + k * 5, k % 2 ? 23 : -19));
    });
    const awayBefore = ops.teamPlayers(b, 't_away').map((p) => b.phases[0].tokens[p.id]);
    const after = ok(ops.applyFormation(b, [home], '4-3-3', 0, false));
    const slots = PRESETS['11v11'].find((p) => p.name === '4-3-3')!.slots;
    const taken = ops.teamPlayers(after, home).map((p) => after.phases[0].tokens[p.id]);
    for (const s of slots) expect(taken.some((t) => t.x === s.x && t.y === s.y)).toBe(true);
    expect(ops.teamPlayers(after, 't_away').map((p) => after.phases[0].tokens[p.id])).toEqual(awayBefore);
  });

  it('AT-009 up-conversion adds players in every phase and keeps positions', () => {
    let b = ops.createBoard({ format: '7v7' });
    for (let k = 0; k < 5; k++) b = ok(ops.addPhase(b, k));
    const before = structuredClone(b.phases.map((p) => p.tokens));
    const after = ok(ops.changeFormat(b, '11v11', []));
    expect(after.format).toBe('11v11');
    expect(after.pitchTemplate).toBe('11v11');
    for (const t of after.teams) expect(ops.teamPlayers(after, t.id)).toHaveLength(11);
    after.phases.forEach((ph, i) => {
      for (const [id, pos] of Object.entries(before[i])) expect(ph.tokens[id]).toEqual(pos);
      expect(Object.keys(ph.tokens)).toHaveLength(22);
    });
    expect(after.revision).toBe(b.revision + 1);
  });

  it('AT-010 down-conversion pre-selects 6 per team, never goalkeepers or locked players', () => {
    let b = ops.createBoard({ format: '11v11' });
    const locked = byNum(b, 'A', 9);
    b = ok(ops.updatePlayer(b, locked.id, { locked: true }));
    const plan = ops.planFormatChange(b, '5v5');
    for (const t of plan.perTeam) {
      for (const id of t.removeDefault) {
        const p = ops.playerById(b, id)!;
        expect(p.isGoalkeeper).toBe(false);
        expect(p.locked).toBe(false);
      }
    }
    expect(plan.perTeam.find((t) => t.teamId === 't_away')!.removeDefault).toHaveLength(6);
    const away = plan.perTeam.flatMap((t) => t.removeDefault);
    const after = ok(ops.changeFormat(b, '5v5', away));
    expect(ops.teamPlayers(after, 't_away')).toHaveLength(5);
  });
});

describe('players and ball', () => {
  it('AT-026 new player in every phase, lowest free number', () => {
    let b = ops.createBoard();
    b = ok(ops.addPhase(b, 0));
    b = ok(ops.addPhase(b, 1));
    const r = ops.addPlayer(b, 't_home', { x: 300, y: 200 })!;
    const after = ok(r.board);
    expect(ops.playerById(after, r.playerId)!.number).toBe(2);
    for (const ph of after.phases) expect(ph.tokens[r.playerId]).toEqual({ x: 300, y: 200 });
  });

  it('AT-028 the roster limit blocks adding', () => {
    let b = ops.createBoard({ format: '11v11' });
    for (let k = 0; k < 5; k++) b = ok(ops.addPlayer(b, 't_home', { x: 100 + k, y: 100 })!.board);
    expect(ops.teamPlayers(b, 't_home')).toHaveLength(16);
    expect(ops.addPlayer(b, 't_home', { x: 10, y: 10 })).toBeNull();
  });

  it('AT-029 and AT-031 a drag moves this phase only and clamps inside the pitch', () => {
    let b = ops.createBoard();
    b = ok(ops.addPhase(b, 0));
    const p = byNum(b, 'A', 5);
    const after = ok(ops.moveSelection(b, 0, { players: [p.id], ball: false }, -5000, 40));
    expect(after.phases[0].tokens[p.id]).toEqual({ x: 0, y: 360 });
    expect(after.phases[1].tokens[p.id]).toEqual(b.phases[1].tokens[p.id]);
    expect(after.revision).toBe(b.revision + 1);
  });

  it('AT-036 deleting a player removes all linked data', () => {
    let b = ops.createBoard();
    const p9 = byNum(b, 'A', 9);
    b = ok(ops.addMovement(b, 0, { subject: player(p9.id), type: 'run', tip: { x: 600, y: 300 } })!.board);
    b = ok(ops.addPhase(b, 0));
    b = ok(ops.addMovement(b, 1, { subject: player(p9.id), type: 'run', tip: { x: 700, y: 200 } })!.board);
    b = ok(ops.addPhase(b, 1));
    b = ok(ops.setPossession(b, 2, p9.id));
    expect(ops.playerLinks(b, [p9.id])).toEqual({ lines: 2, ballLinks: 1 });
    const after = ok(ops.deletePlayers(b, [p9.id]));
    expect(ops.playerById(after, p9.id)).toBeUndefined();
    for (const ph of after.phases) {
      expect(ph.tokens[p9.id]).toBeUndefined();
      expect(ph.movements).toHaveLength(0);
    }
    expect(after.phases[2].ball.possessorId).toBeNull();
  });

  it('AT-037 a locked player cannot move or get a run', () => {
    let b = ops.createBoard();
    const p9 = byNum(b, 'A', 9);
    b = ok(ops.updatePlayer(b, p9.id, { locked: true }));
    expect(ops.moveSelection(b, 0, { players: [p9.id], ball: false }, 50, 0)).toBeNull();
    expect(ops.addMovement(b, 0, { subject: player(p9.id), type: 'run', tip: { x: 600, y: 300 } })).toBeNull();
  });

  it('AT-038 a group moves by one offset', () => {
    const b = ops.createBoard({ format: '11v11' });
    const back = [2, 5, 6, 3].map((n) => byNum(b, 'A', n).id);
    const after = ok(ops.moveSelection(b, 0, { players: back, ball: false }, 50, 0));
    for (const id of back) expect(after.phases[0].tokens[id].x).toBe(b.phases[0].tokens[id].x + 50);
  });

  it('AT-039 duplicate: next free number, +30 u offset, every phase', () => {
    let b = ops.createBoard();
    b = ok(ops.addPhase(b, 0));
    const p = byNum(b, 'A', 5);
    const r = ops.duplicatePlayer(b, p.id)!;
    const after = ok(r.board);
    expect(ops.playerById(after, r.playerId)!.number).toBe(2);
    for (const ph of after.phases) expect(ph.tokens[r.playerId]).toEqual({ x: ph.tokens[p.id].x + 30, y: ph.tokens[p.id].y + 30 });
  });

  it('AT-040 to AT-042 possession: drop, follow, release', () => {
    let b = ops.createBoard();
    const p = byNum(b, 'A', 5); // at (190, 320); ball at (500, 320)
    b = ok(ops.moveSelection(b, 0, { players: [], ball: true }, -300, 0, { snapU: 40 }));
    expect(b.phases[0].ball.possessorId).toBe(p.id);
    expect(dist(b.phases[0].ball, b.phases[0].tokens[p.id])).toBeCloseTo(22, 5);
    const moved = ok(ops.moveSelection(b, 0, { players: [p.id], ball: false }, 40, 40));
    expect(dist(moved.phases[0].ball, moved.phases[0].tokens[p.id])).toBeCloseTo(22, 5);
    const away = ok(ops.moveSelection(moved, 0, { players: [], ball: true }, 100, 0, { snapU: 40 }));
    expect(away.phases[0].ball.possessorId).toBeNull();
  });
});

describe('movement model', () => {
  const setup = () => {
    const b = ops.createBoard({ format: '11v11' });
    return { b, p9: byNum(b, 'A', 9), p7: byNum(b, 'A', 7), p6: byNum(b, 'A', 6) };
  };

  it('AT-044 a run on the last phase keeps a pending tip and adds no phase', () => {
    const { b, p9 } = setup();
    const r = ops.addMovement(b, 0, { subject: player(p9.id), type: 'run', tip: { x: 600, y: 300 } })!;
    const after = ok(r.board);
    expect(after.phases).toHaveLength(1);
    expect(mv(after, 0, r.movementId).pendingTip).toEqual({ x: 600, y: 300 });
  });

  it('AT-045 add phase binds runs and the pass', () => {
    let { b } = setup();
    const p9 = byNum(b, 'A', 9);
    const p7 = byNum(b, 'A', 7);
    b = ok(ops.addMovement(b, 0, { subject: player(p9.id), type: 'run', tip: { x: 600, y: 300 } })!.board);
    b = ok(ops.addMovement(b, 0, { subject: player(p7.id), type: 'run', tip: { x: 500, y: 560 } })!.board);
    b = ok(ops.addMovement(b, 0, { subject: ball, type: 'pass', tip: { x: 600, y: 300 }, receiverId: p9.id })!.board);
    b = ok(ops.addPhase(b, 0));
    expect(b.phases[1].tokens[p9.id]).toEqual({ x: 600, y: 300 });
    expect(b.phases[1].tokens[p7.id]).toEqual({ x: 500, y: 560 });
    expect(b.phases[1].ball.possessorId).toBe(p9.id);
    expect(dist(b.phases[1].ball, b.phases[1].tokens[p9.id])).toBeCloseTo(22, 1);
    expect(b.phases[0].movements).toHaveLength(3);
    expect(b.phases[0].movements.every((m) => m.pendingTip === null)).toBe(true);
    expect(b.phases[1].name).toBe('Phase 2');
  });

  it('AT-046 and AT-047 the tip and the next-phase position stay equal', () => {
    let { b, p9 } = setup();
    const r = ops.addMovement(b, 0, { subject: player(p9.id), type: 'run', tip: { x: 600, y: 300 } })!;
    b = ok(ops.addPhase(r.board, 0));
    b = ok(ops.moveSelection(b, 1, { players: [p9.id], ball: false }, 50, -20));
    expect(ops.tipOf(b, 0, mv(b, 0, r.movementId))).toEqual({ x: 650, y: 280 });
    b = ok(ops.setMovementTip(b, 0, r.movementId, { x: 700, y: 100 }));
    expect(b.phases[1].tokens[p9.id]).toEqual({ x: 700, y: 100 });
  });

  it('AT-048 a run drawn before an existing phase moves the player there', () => {
    let { b, p7 } = setup();
    b = ok(ops.addPhase(b, 0));
    const r = ops.addMovement(b, 0, { subject: player(p7.id), type: 'run', tip: { x: 480, y: 500 } })!;
    expect(r.movedInNext).toBe(true);
    expect(ok(r.board).phases[1].tokens[p7.id]).toEqual({ x: 480, y: 500 });
  });

  it('AT-049 and AT-051 a linked pass follows its receiver', () => {
    let { b, p9 } = setup();
    b = ok(ops.addPhase(b, 0));
    const land = ops.landingPoint(b, 0, p9.id);
    const r = ops.addMovement(b, 0, { subject: ball, type: 'pass', tip: land, receiverId: p9.id })!;
    b = ok(r.board);
    expect(mv(b, 0, r.movementId).receiverId).toBe(p9.id);
    expect(b.phases[1].ball.possessorId).toBe(p9.id);
    b = ok(ops.moveSelection(b, 1, { players: [p9.id], ball: false }, 60, 60));
    expect(dist(b.phases[1].ball, b.phases[1].tokens[p9.id])).toBeCloseTo(22, 1);
    expect(dist(ops.tipOf(b, 0, mv(b, 0, r.movementId)), b.phases[1].ball)).toBe(0);
  });

  it('AT-052 a carry moves player and ball together', () => {
    let { b, p6 } = setup();
    b = ok(ops.setPossession(b, 0, p6.id));
    b = ok(ops.addPhase(b, 0));
    const r = ops.addMovement(b, 0, { subject: player(p6.id), type: 'carry', tip: { x: 400, y: 300 } })!;
    b = ok(r.board);
    expect(b.phases[0].movements.map((m) => m.type)).toEqual(['carry', 'carry']);
    expect(b.phases[1].ball.possessorId).toBe(p6.id);
    const mid = sceneInTransition(b, 0, 0.5);
    expect(dist(mid.ball, mid.tokens[p6.id])).toBeCloseTo(22, 1);
  });

  it('4.3 a carry without possession becomes a run', () => {
    const { b, p6 } = setup();
    const r = ops.addMovement(b, 0, { subject: player(p6.id), type: 'carry', tip: { x: 400, y: 300 } })!;
    expect(mv(ok(r.board), 0, r.movementId).type).toBe('run');
  });

  it('AT-053 and AT-060 a static line moves nothing', () => {
    let { b } = setup();
    b = ok(ops.addPhase(b, 0));
    const tokens = JSON.stringify(b.phases.map((p) => [p.tokens, p.ball]));
    b = ok(ops.addAnnotation(b, 0, ops.makeLine('pass', { x: 100, y: 100 }, { x: 400, y: 400 })));
    expect(JSON.stringify(b.phases.map((p) => [p.tokens, p.ball]))).toBe(tokens);
  });

  it('AT-055 a second movement replaces the first', () => {
    let { b, p9 } = setup();
    b = ok(ops.addMovement(b, 0, { subject: player(p9.id), type: 'run', tip: { x: 600, y: 300 } })!.board);
    const r = ops.addMovement(b, 0, { subject: player(p9.id), type: 'run', tip: { x: 620, y: 100 } })!;
    expect(r.replaced).not.toBeNull();
    expect(ok(r.board).phases[0].movements).toHaveLength(1);
  });

  it('AT-056 and AT-057 delete line, with and without keeping the player in place', () => {
    let { b, p9 } = setup();
    const r = ops.addMovement(b, 0, { subject: player(p9.id), type: 'run', tip: { x: 600, y: 300 } })!;
    b = ok(ops.addPhase(r.board, 0));
    const plain = ok(ops.deleteMovement(b, 0, r.movementId));
    expect(plain.phases[0].movements).toHaveLength(0);
    expect(plain.phases[1].tokens[p9.id]).toEqual({ x: 600, y: 300 });
    const kept = ok(ops.deleteMovement(b, 0, r.movementId, true));
    expect(kept.phases[1].tokens[p9.id]).toEqual(kept.phases[0].tokens[p9.id]);
  });

  it('AT-121 a shot leaves the ball with nobody', () => {
    let { b, p9 } = setup();
    b = ok(ops.setPossession(b, 0, p9.id));
    b = ok(ops.addPhase(b, 0));
    expect(b.phases[1].ball.possessorId).toBe(p9.id);
    b = ok(ops.addMovement(b, 0, { subject: ball, type: 'shot', tip: { x: 1000, y: 320 } })!.board);
    expect(b.phases[1].ball).toMatchObject({ x: 1000, y: 320, possessorId: null });
  });

  it('AT-128 run to carry needs possession', () => {
    const { b, p9 } = setup();
    const r = ops.addMovement(b, 0, { subject: player(p9.id), type: 'run', tip: { x: 600, y: 300 } })!;
    expect(ops.updateMovement(r.board, 0, r.movementId, { type: 'carry' })).toBeNull();
  });

  it('LIN-010 unlink clears the receiver and next-phase possession', () => {
    let { b, p9 } = setup();
    b = ok(ops.addPhase(b, 0));
    const r = ops.addMovement(b, 0, { subject: ball, type: 'pass', tip: b.phases[1].tokens[p9.id], receiverId: p9.id })!;
    const at = { ...r.board.phases[1].ball };
    const after = ok(ops.unlinkReceiver(r.board, 0, r.movementId));
    expect(mv(after, 0, r.movementId).receiverId).toBeNull();
    expect(after.phases[1].ball).toMatchObject({ x: at.x, y: at.y, possessorId: null });
  });
});

describe('phases', () => {
  it('AT-068 and AT-141 a phase inserted between two phases takes over the run tip', () => {
    let b = ops.createBoard({ format: '11v11' });
    const p9 = byNum(b, 'A', 9);
    const r = ops.addMovement(b, 0, { subject: player(p9.id), type: 'run', tip: { x: 600, y: 300 } })!;
    b = ok(ops.addPhase(r.board, 0)); // A, B
    b = ok(ops.moveSelection(b, 1, { players: [byNum(b, 'A', 4).id], ball: false }, 30, 30));
    const ins = ok(ops.addPhase(b, 0)); // A, new, B
    expect(ins.phases).toHaveLength(3);
    expect(ins.phases[1].name).toBe('Phase 3');
    expect(ins.phases[1].tokens[p9.id]).toEqual({ x: 600, y: 300 });
    expect(ops.tipOf(ins, 0, mv(ins, 0, r.movementId))).toEqual({ x: 600, y: 300 });
    expect(ins.phases[1].movements).toHaveLength(0);
  });

  it('AT-069 add phase with drawings copies annotations with new IDs', () => {
    let b = ops.createBoard();
    b = ok(ops.addAnnotation(b, 0, ops.makeZone('rect', { x: 100, y: 100 }, { x: 300, y: 300 })));
    b = ok(ops.addPhase(b, 0, true));
    expect(b.phases[1].annotations).toHaveLength(1);
    expect(b.phases[1].annotations[0].id).not.toBe(b.phases[0].annotations[0].id);
  });

  it('AT-062 a zone under 30 by 30 u is not created', () => {
    const b = ops.createBoard();
    expect(ops.addAnnotation(b, 0, ops.makeZone('rect', { x: 100, y: 100 }, { x: 120, y: 120 }))).toBeNull();
  });

  it('AT-070 an empty phase name is rejected', () => {
    const b = ops.createBoard();
    expect(ops.renamePhase(b, 0, '   ')).toBeNull();
  });

  it('AT-071 reorder re-points runs and drops zero-length ones', () => {
    let b = ops.createBoard({ format: '11v11' });
    const p9 = byNum(b, 'A', 9);
    const p7 = byNum(b, 'A', 7);
    const r9 = ops.addMovement(b, 0, { subject: player(p9.id), type: 'run', tip: { x: 600, y: 300 } })!;
    const r7 = ops.addMovement(r9.board, 0, { subject: player(p7.id), type: 'run', tip: { x: 500, y: 500 } })!;
    b = ok(ops.addPhase(r7.board, 0)); // A, B
    b = ok(ops.addPhase(b, 1)); // A, B, C
    // In C, #9 goes back to where it started in A and #7 moves on.
    b = ok(ops.moveSelection(b, 2, { players: [p9.id], ball: false }, b.phases[0].tokens[p9.id].x - 600, b.phases[0].tokens[p9.id].y - 300));
    b = ok(ops.moveSelection(b, 2, { players: [p7.id], ball: false }, 100, 0));
    const res = ops.movePhase(b, 2, 1)!; // A, C, B
    const after = ok(res.board);
    expect(res.removed).toBe(1); // #9's run is now zero-length
    expect(res.updated).toBe(1);
    expect(ops.tipOf(after, 0, mv(after, 0, r7.movementId))).toEqual(after.phases[1].tokens[p7.id]);
  });

  it('AT-072 and AT-073 delete phase: last one is protected, tips become pending', () => {
    let b = ops.createBoard({ format: '11v11' });
    expect(ops.deletePhase(b, 0)).toBeNull();
    const p9 = byNum(b, 'A', 9);
    b = ok(ops.addPhase(b, 0));
    const r = ops.addMovement(b, 1, { subject: player(p9.id), type: 'run', tip: { x: 640, y: 250 } })!;
    b = ok(ops.addPhase(r.board, 1)); // A, B, C; B has a bound run
    expect(mv(b, 1, r.movementId).pendingTip).toBeNull();
    const after = ok(ops.deletePhase(b, 2)!.board);
    expect(mv(after, 1, r.movementId).pendingTip).toEqual({ x: 640, y: 250 });
  });

  it('PHS-009 thirty phases is the limit', () => {
    let b = ops.createBoard();
    for (let k = 0; k < 29; k++) b = ops.addPhase(b, k)!;
    expect(ok(b).phases).toHaveLength(30);
    expect(ops.addPhase(b, 29)).toBeNull();
  });

  it('AT-067 clear drawings keeps positions', () => {
    let b = ops.createBoard();
    const p9 = byNum(b, 'A', 9);
    b = ok(ops.addMovement(b, 0, { subject: player(p9.id), type: 'run', tip: { x: 600, y: 300 } })!.board);
    b = ok(ops.addAnnotation(b, 0, ops.makeZone('ellipse', { x: 100, y: 100 }, { x: 300, y: 300 })));
    b = ok(ops.addAnnotation(b, 0, ops.makeText({ x: 400, y: 400 }, 'Cross')));
    expect(ops.drawingCounts(b.phases[0])).toEqual({ lines: 1, zones: 1, labels: 1, total: 3 });
    const after = ok(ops.clearDrawings(b, 0));
    expect(ops.drawingCounts(after.phases[0]).total).toBe(0);
    expect(after.phases[0].tokens).toEqual(b.phases[0].tokens);
  });
});

describe('playback', () => {
  it('AT-079 per-movement timing', () => {
    let b = ops.createBoard({ format: '11v11' });
    const p9 = byNum(b, 'A', 9);
    b = ok(ops.updateBoard(b, { settings: { holdMs: 0 } }));
    b = ok(ops.setTransition(b, 0, { easing: 'linear' }));
    const run = ops.addMovement(b, 0, { subject: player(p9.id), type: 'run', tip: { x: 700, y: 320 } })!;
    const pass = ops.addMovement(run.board, 0, { subject: ball, type: 'pass', tip: { x: 800, y: 100 } })!;
    b = ok(ops.updateMovement(pass.board, 0, run.movementId, { start: 0, end: 0.7 }));
    b = ok(ops.updateMovement(b, 0, pass.movementId, { start: 0.5, end: 1 }));
    b = ok(ops.addPhase(b, 0));
    const tl = buildTimeline(b);
    expect(tl.total).toBe(1500);
    const at750 = frameAt(b, tl, 750).scene;
    expect(at750.ball).toMatchObject({ x: 500, y: 320 });
    const at1050 = frameAt(b, tl, 1050).scene;
    expect(dist(at1050.tokens[p9.id], { x: 700, y: 320 })).toBeLessThan(0.01);
  });

  it('AT-120 implied movement is a straight line over the whole transition', () => {
    let b = ops.createBoard({ format: '11v11' });
    const p4 = byNum(b, 'A', 4);
    b = ok(ops.setTransition(b, 0, { easing: 'linear' }));
    b = ok(ops.addPhase(b, 0));
    b = ok(ops.moveSelection(b, 1, { players: [p4.id], ball: false }, 100, -50));
    const a = b.phases[0].tokens[p4.id];
    expect(sceneInTransition(b, 0, 0.5).tokens[p4.id]).toEqual({ x: a.x + 50, y: a.y - 25 });
  });

  it('AT-122 a curved run travels at constant speed along the arc', () => {
    let b = ops.createBoard({ format: '11v11' });
    const p9 = byNum(b, 'A', 9);
    b = ok(ops.setTransition(b, 0, { easing: 'linear' }));
    const r = ops.addMovement(b, 0, { subject: player(p9.id), type: 'run', tip: { x: 700, y: 320 }, bend: 0.5 })!;
    b = ok(ops.addPhase(r.board, 0));
    const mid = pointAtFraction(makePath(b.phases[0].tokens[p9.id], { x: 700, y: 320 }, 0.5, 400), 0.5);
    expect(dist(sceneInTransition(b, 0, 0.5).tokens[p9.id], mid)).toBeLessThan(2);
  });

  it('AT-123 ball arrives before the runner', () => {
    let b = ops.createBoard({ format: '11v11' });
    const p9 = byNum(b, 'A', 9);
    b = ok(ops.addMovement(b, 0, { subject: player(p9.id), type: 'run', tip: { x: 600, y: 300 } })!.board);
    const pass = ops.addMovement(b, 0, { subject: ball, type: 'pass', tip: { x: 600, y: 300 }, receiverId: p9.id })!;
    b = ok(ops.updateMovement(pass.board, 0, pass.movementId, { end: 0.5 }));
    expect(passArrivesEarly(b.phases[0], mv(b, 0, pass.movementId))).toBe(true);
  });

  it('AT-080 timeline length is holds plus transitions; AT-083 playback reads only', () => {
    let b = ops.createBoard();
    b = ok(ops.addPhase(b, 0));
    b = ok(ops.addPhase(b, 1));
    const snap = JSON.stringify(b);
    const tl = buildTimeline(b);
    expect(tl.total).toBe(3 * 400 + 2 * 1500);
    for (let ms = 0; ms <= tl.total; ms += 100) frameAt(b, tl, ms);
    expect(JSON.stringify(b)).toBe(snap);
  });
});

describe('views and labels', () => {
  it('AT-013 and AT-014 attacking third follows the attack direction', () => {
    let b = ops.createBoard();
    expect(cropX(b, 'third-att').map(Math.round)).toEqual([667, 1000]);
    expect(viewLabel(b, 'third-att')).toBe('Attacking third · HOME');
    const tokens = JSON.stringify(b.phases[0].tokens);
    b = ok(ops.updateBoard(b, { teamAAttacks: 'left' }));
    expect(cropX(b, 'third-att').map(Math.round)).toEqual([0, 333]);
    expect(JSON.stringify(b.phases[0].tokens)).toBe(tokens);
  });

  it('AT-140 metres readout', () => {
    const b = ops.createBoard();
    expect(metresReadout(b, { x: 300, y: 160 }).text).toBe('30.0 m from own goal line, 16.0 m from left touchline');
  });
});

describe('import and export', () => {
  const typical = () => {
    let b = ops.createBoard({ format: '11v11', title: 'Build-up' });
    const p9 = byNum(b, 'A', 9);
    b = ops.addMovement(b, 0, { subject: player(p9.id), type: 'run', tip: { x: 600, y: 300 }, bend: 0.2 })!.board;
    b = ops.addMovement(b, 0, { subject: ball, type: 'pass', tip: { x: 600, y: 300 }, receiverId: p9.id })!.board;
    b = ops.addAnnotation(b, 0, ops.makeZone('rect', { x: 250, y: 220 }, { x: 400, y: 420 }))!;
    b = ops.addAnnotation(b, 0, ops.makeText({ x: 400, y: 100 }, '<script>alert(1)</script>'))!;
    b = ops.addPhase(b, 0)!;
    b = ops.addMovement(b, 1, { subject: player(p9.id), type: 'carry', tip: { x: 800, y: 320 } })!.board;
    return ok(b);
  };

  it('AT-097 project round trip is lossless', () => {
    const b = typical();
    const r = parseProject(serializeProject(b));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.board).toEqual(b);
  });

  it('DAT-023 the file holds every player whatever the view', () => {
    const b = typical();
    const file = JSON.parse(serializeProject(b));
    expect(file.board.roster).toHaveLength(22);
    expect(Object.keys(file.board.phases[0].tokens)).toHaveLength(22);
  });

  it('AT-098 a missing position is rejected and named', () => {
    const b = typical();
    const file = JSON.parse(serializeProject(b));
    const pid = file.board.roster[3].id;
    delete file.board.phases[1].tokens[pid];
    const r = parseProject(JSON.stringify(file));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toBe(`Phase 2: player ${pid} has no position`);
  });

  it('AT-099 a newer schema version is refused', () => {
    const file = JSON.parse(serializeProject(typical()));
    file.schemaVersion = 2;
    const r = parseProject(JSON.stringify(file));
    expect(r).toMatchObject({ ok: false, reason: 'newer' });
  });

  it('AT-100 a __proto__ key is rejected', () => {
    const text = serializeProject(typical()).replace('"title"', '"__proto__": {"x": 1}, "title"');
    expect(parseProject(text)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('SEC-002 unknown keys, bad bounds and oversize files are rejected', () => {
    const file = JSON.parse(serializeProject(typical()));
    file.board.url = 'https://example.com';
    expect(parseProject(JSON.stringify(file)).ok).toBe(false);
    const f2 = JSON.parse(serializeProject(typical()));
    f2.board.phases[0].ball.x = 1200;
    expect(parseProject(JSON.stringify(f2)).ok).toBe(false);
    expect(parseProject('{}', 3 * 1024 * 1024)).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('Appendix D sample file is valid', () => {
    const sample = {
      schemaVersion: 1,
      appVersion: '1.0.0',
      board: {
        id: '6f1c2a9e-4b7d-4e2a-9c3f-1a2b3c4d5e6f',
        title: 'Build-up vs high press',
        format: '5v5',
        pitchTemplate: '5v5',
        pitchTheme: 'grass',
        teams: [
          { id: 't_home', slot: 'A', name: 'HOME', color: 'team-1', marker: 'solid' },
          { id: 't_away', slot: 'B', name: 'AWAY', color: 'team-2', marker: 'outlined' },
        ],
        primaryTeamId: 't_home',
        teamAAttacks: 'right',
        roster: [
          { id: 'p_h1', teamId: 't_home', number: 1, name: '', role: 'GK', isGoalkeeper: true, locked: false },
          { id: 'p_h5', teamId: 't_home', number: 5, name: 'Rafi', role: 'CB', isGoalkeeper: false, locked: false },
          { id: 'p_a9', teamId: 't_away', number: 9, name: '', role: 'ST', isGoalkeeper: false, locked: false },
        ],
        phases: [
          {
            id: 'ph_1',
            name: 'Starting shape',
            caption: 'GK plays out to the CB',
            tokens: { p_h1: { x: 40, y: 320 }, p_h5: { x: 190, y: 320 }, p_a9: { x: 300, y: 300 } },
            ball: { x: 62, y: 320, visible: true, possessorId: 'p_h1' },
            movements: [
              { id: 'm_1', subject: { kind: 'player', playerId: 'p_h5' }, type: 'run', bend: 0.2, start: 0, end: 0.6, receiverId: null, carrierId: null, label: '', pendingTip: null },
              { id: 'm_2', subject: { kind: 'ball' }, type: 'pass', bend: 0, start: 0.4, end: 1, receiverId: 'p_h5', carrierId: null, label: '', pendingTip: null },
            ],
            annotations: [{ id: 'a_1', kind: 'zone', shape: 'rect', x: 250, y: 220, w: 150, h: 200, fill: 'note-1', opacity: 0.25, outline: 'dashed', label: 'Press trigger' }],
            transition: { durationMs: 1500, easing: 'easeInOut' },
          },
          {
            id: 'ph_2',
            name: 'First line broken',
            caption: '',
            tokens: { p_h1: { x: 40, y: 320 }, p_h5: { x: 200, y: 520 }, p_a9: { x: 260, y: 380 } },
            ball: { x: 187.5, y: 501.9, visible: true, possessorId: 'p_h5' },
            movements: [],
            annotations: [],
            transition: { durationMs: 1500, easing: 'easeInOut' },
          },
        ],
        settings: { showNames: false, showImplied: false, linesDuringPlayback: 'fade', holdMs: 400, loop: false, exportMark: true },
        createdAt: '2026-11-11T07:00:00Z',
        updatedAt: '2026-11-11T07:12:30Z',
        revision: 14,
      },
    };
    const r = parseProject(JSON.stringify(sample));
    expect(r).toMatchObject({ ok: true });
  });
});

describe('example board', () => {
  it('builds a valid 4-phase board with linked movements and captions', async () => {
    const { createSampleBoard } = await import('../src/domain/sample');
    const b = ok(createSampleBoard());
    expect(b.phases).toHaveLength(4);
    expect(b.phases.every((p) => p.name.length > 0)).toBe(true);
    const passes = b.phases.flatMap((p) => p.movements).filter((m) => m.type === 'pass');
    expect(passes).toHaveLength(2);
    expect(passes.every((m) => m.receiverId)).toBe(true);
    expect(b.phases[1].movements.some((m) => m.type === 'carry')).toBe(true);
    // Round-trips through the project file format.
    const parsed = parseProject(serializeProject(b));
    expect(parsed.ok).toBe(true);
    expect(buildTimeline(b).total).toBeGreaterThan(4000);
  });
});
