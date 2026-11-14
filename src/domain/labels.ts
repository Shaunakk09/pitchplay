// Team-relative labels and readouts (GEO-009 to GEO-011, ACC-003).
import type { Board, Player, Pt } from './types';
import { PITCH_H, PITCH_W } from './params';
import { attacksOf, playerById, primaryTeam, teamById } from './ops';

export type ViewPreset = 'full' | 'half-own' | 'half-opp' | 'third-def' | 'third-mid' | 'third-att';

// PIT-003: own and attacking follow the primary team's direction.
export function cropX(board: Board, preset: ViewPreset): [number, number] {
  const right = attacksOf(board, board.primaryTeamId) === 'right';
  const third = PITCH_W / 3;
  switch (preset) {
    case 'half-own':
      return right ? [0, 500] : [500, 1000];
    case 'half-opp':
      return right ? [500, 1000] : [0, 500];
    case 'third-def':
      return right ? [0, third] : [2 * third, 1000];
    case 'third-mid':
      return [third, 2 * third];
    case 'third-att':
      return right ? [2 * third, 1000] : [0, third];
    default:
      return [0, PITCH_W];
  }
}

const PRESET_NAMES: Record<ViewPreset, string> = {
  full: 'Full pitch',
  'half-own': 'Own half',
  'half-opp': 'Opponent half',
  'third-def': 'Defensive third',
  'third-mid': 'Middle third',
  'third-att': 'Attacking third',
};

// GEO-009: labels always name the primary team.
export function viewLabel(board: Board, preset: ViewPreset): string {
  return preset === 'full' ? PRESET_NAMES.full : `${PRESET_NAMES[preset]} · ${primaryTeam(board).name}`;
}
export const presetName = (p: ViewPreset) => PRESET_NAMES[p];

// GEO-011: metres from the primary team's own goal line and from its left touchline.
export function metresReadout(board: Board, p: Pt): { fromGoal: number; fromLeft: number; text: string } {
  const right = attacksOf(board, board.primaryTeamId) === 'right';
  const fromGoal = (right ? p.x : PITCH_W - p.x) / 10;
  const fromLeft = (right ? p.y : PITCH_H - p.y) / 10;
  return { fromGoal, fromLeft, text: `${fromGoal.toFixed(1)} m from own goal line, ${fromLeft.toFixed(1)} m from left touchline` };
}

const ROLE_WORDS: Record<string, string> = {
  GK: 'goalkeeper',
  CB: 'centre back',
  RB: 'right back',
  LB: 'left back',
  RWB: 'right wing back',
  LWB: 'left wing back',
  DM: 'defensive midfielder',
  CM: 'central midfielder',
  RM: 'right midfielder',
  LM: 'left midfielder',
  CAM: 'attacking midfielder',
  RAM: 'right attacking midfielder',
  LAM: 'left attacking midfielder',
  RW: 'right winger',
  LW: 'left winger',
  RF: 'right forward',
  LF: 'left forward',
  ST: 'striker',
};

// ACC-003: "HOME, number 6, Rafi, centre back, own half, left side".
export function tokenLabel(board: Board, player: Player, at: Pt): string {
  const team = teamById(board, player.teamId);
  const right = attacksOf(board, player.teamId) === 'right';
  const ownHalf = right ? at.x <= 500 : at.x >= 500;
  const leftSide = right ? at.y < PITCH_H / 2 : at.y > PITCH_H / 2;
  const parts = [team.name, `number ${player.number}`];
  if (player.name) parts.push(player.name);
  if (player.role) parts.push(ROLE_WORDS[player.role.toUpperCase()] ?? player.role);
  parts.push(ownHalf ? 'own half' : 'opponent half', Math.abs(at.y - PITCH_H / 2) < 40 ? 'centre' : leftSide ? 'left side' : 'right side');
  return parts.join(', ');
}

export function selectionTitle(board: Board, playerId: string): string {
  const p = playerById(board, playerId);
  if (!p) return '';
  return `#${p.number}${p.name ? ` ${p.name}` : ''} · ${teamById(board, p.teamId).name}`;
}
