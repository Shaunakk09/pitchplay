// A ready-made example board so first-time visitors see the whole idea in one click:
// three phases, runs, a pass with a receiver, a carry, a zone and captions.
// Built only through ops, so every data invariant holds exactly as for a hand-made board.
import type { Board, MoveType, Pt, Subject } from './types';
import * as ops from './ops';

export const SAMPLE_TITLE = 'Example: playing out against a high press';

export function createSampleBoard(): Board {
  let b = ops.createBoard({ title: SAMPLE_TITLE, format: '11v11', presetA: '4-3-3', presetB: '4-4-2', nameA: 'HOME', nameB: 'AWAY' });
  const home = ops.teamBySlot(b, 'A').id;
  const away = ops.teamBySlot(b, 'B').id;
  const id = (team: string, n: number) => b.roster.find((p) => p.teamId === team && p.number === n)!.id;
  const step = <T,>(next: T | null | undefined, what: string): T => {
    if (!next) throw new Error(`Example board: ${what} failed`);
    return next;
  };
  const place = (i: number, playerId: string, to: Pt) => {
    const at = b.phases[i].tokens[playerId];
    b = step(ops.moveSelection(b, i, { players: [playerId], ball: false }, to.x - at.x, to.y - at.y), `place ${playerId}`);
  };
  const move = (i: number, subject: Subject, type: MoveType, tip: Pt, extra: { receiverId?: string; bend?: number; start?: number; end?: number; label?: string } = {}) => {
    const r = step(ops.addMovement(b, i, { subject, type, tip, bend: extra.bend, receiverId: extra.receiverId ?? null }), `${type} line`);
    b = r.board;
    if (extra.start !== undefined || extra.end !== undefined || extra.label) {
      b = step(ops.updateMovement(b, i, r.movementId, { start: extra.start, end: extra.end, label: extra.label }), 'timing');
    }
  };
  const player = (playerId: string): Subject => ({ kind: 'player', playerId });

  // Phase 1: goal kick, AWAY presses high with both strikers and both wide midfielders.
  place(0, id(away, 9), { x: 250, y: 400 });
  place(0, id(away, 10), { x: 250, y: 240 });
  place(0, id(away, 7), { x: 330, y: 110 });
  place(0, id(away, 11), { x: 330, y: 530 });
  b = step(ops.setPossession(b, 0, id(home, 1)), 'give the ball to the goalkeeper');
  b = step(ops.renamePhase(b, 0, 'Goal kick under pressure'), 'rename');
  b = step(ops.setCaption(b, 0, 'The centre backs split wide to stretch the two pressing strikers.'), 'caption');
  b = step(ops.addAnnotation(b, 0, ops.makeZone('rect', { x: 200, y: 200 }, { x: 300, y: 440 })), 'zone');
  move(0, player(id(home, 5)), 'run', { x: 120, y: 520 }, { bend: 0.25, end: 0.7 });
  move(0, player(id(home, 4)), 'run', { x: 120, y: 120 }, { bend: -0.25, end: 0.7 });
  move(0, player(id(home, 6)), 'run', { x: 230, y: 320 }, { end: 0.7 });
  move(0, player(id(home, 2)), 'run', { x: 330, y: 600 }, { bend: 0.15 });
  move(0, { kind: 'ball' }, 'pass', { x: 120, y: 520 }, { receiverId: id(home, 5), start: 0.45 });

  // Phase 2: the right centre back has the ball wide; the press follows.
  b = step(ops.addPhase(b, 0), 'add phase 2');
  b = step(ops.renamePhase(b, 1, 'Centre back carries'), 'rename');
  b = step(ops.setCaption(b, 1, '#5 carries into the space the striker left. The full back goes high.'), 'caption');
  place(1, id(away, 9), { x: 200, y: 470 });
  place(1, id(away, 11), { x: 300, y: 590 });
  move(1, player(id(home, 5)), 'carry', { x: 260, y: 500 }, { bend: -0.1 });
  move(1, player(id(home, 2)), 'run', { x: 470, y: 600 }, { bend: 0.1 });
  move(1, player(id(home, 7)), 'run', { x: 520, y: 470 }, { bend: -0.2, start: 0.2 });

  // Phase 3: the line is broken with a pass into the winger's run.
  b = step(ops.addPhase(b, 1), 'add phase 3');
  b = step(ops.renamePhase(b, 2, 'First line broken'), 'rename');
  b = step(ops.setCaption(b, 2, 'Pass inside the full back. Two pressers are now behind the ball.'), 'caption');
  move(2, { kind: 'ball' }, 'pass', { x: 520, y: 470 }, { receiverId: id(home, 7), start: 0.1 });
  b = step(ops.addPhase(b, 2), 'add phase 4');
  b = step(ops.renamePhase(b, 3, 'Attack the space'), 'rename');
  return { ...b, revision: 0 };
}
