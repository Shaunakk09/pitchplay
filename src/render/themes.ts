// Palettes and pitch themes (GEO-012). Editor and exports share these tokens (EXP-019).
import type { Theme } from '../domain/types';

export const TEAM_COLORS: Record<string, { hex: string; name: string }> = {
  'team-1': { hex: '#1F5FD1', name: 'Blue' },
  'team-2': { hex: '#D8342B', name: 'Red' },
  'team-3': { hex: '#F2C230', name: 'Yellow' },
  'team-4': { hex: '#F4F4F0', name: 'White' },
  'team-5': { hex: '#1B1D22', name: 'Black' },
  'team-6': { hex: '#F07A1C', name: 'Orange' },
  'team-7': { hex: '#5CB8F0', name: 'Sky' },
  'team-8': { hex: '#7A3FC4', name: 'Purple' },
  'team-9': { hex: '#1E9E5A', name: 'Green' },
  'team-10': { hex: '#8C1D3F', name: 'Maroon' },
};

export const NOTE_NAMES: Record<string, string> = {
  'note-1': 'Yellow',
  'note-2': 'Red',
  'note-3': 'Cyan',
  'note-4': 'Pink',
  'note-5': 'Orange',
  'note-6': 'Neutral',
};

const NOTE_ON_DARK: Record<string, string> = {
  'note-1': '#FFD23F',
  'note-2': '#FF6A5E',
  'note-3': '#4FD6FF',
  'note-4': '#F08CFF',
  'note-5': '#FFA24A',
  'note-6': '#FFFFFF',
};
const NOTE_ON_LIGHT: Record<string, string> = {
  'note-1': '#9A7000',
  'note-2': '#C62B20',
  'note-3': '#0A7FA8',
  'note-4': '#9A2BB8',
  'note-5': '#C25E00',
  'note-6': '#22272E',
};

export interface ThemeColors {
  pitch: string;
  stripe: string;
  line: string;
  margin: string;
  neutral: string; // ball movement lines and neutral text
  outline: string; // hairline around tokens, so every team color reads on the pitch
  halo: string; // behind text drawn on the pitch
  tokenBase: string;
}

export const THEMES: Record<Theme, ThemeColors> = {
  grass: { pitch: '#3C9A62', stripe: '#37915B', line: '#F4FAF5', margin: '#2F7F50', neutral: '#FFFFFF', outline: '#0C2417', halo: 'rgba(12,36,23,0.78)', tokenBase: '#FFFFFF' },
  dark: { pitch: '#1B222C', stripe: '#1E2631', line: '#AEBBCB', margin: '#11161D', neutral: '#F2F5F8', outline: '#05080C', halo: 'rgba(5,8,12,0.8)', tokenBase: '#FFFFFF' },
  print: { pitch: '#FFFFFF', stripe: '#FFFFFF', line: '#22272E', margin: '#FFFFFF', neutral: '#22272E', outline: '#22272E', halo: 'rgba(255,255,255,0.88)', tokenBase: '#FFFFFF' },
};

export const THEME_NAMES: Record<Theme, string> = { grass: 'Grass', dark: 'Dark', print: 'Print' };

export const teamHex = (token: string) => TEAM_COLORS[token]?.hex ?? '#888888';
export const noteHex = (token: string, theme: Theme) => (theme === 'print' ? NOTE_ON_LIGHT : NOTE_ON_DARK)[token] ?? '#FFD23F';

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
export const inkOn = (hex: string) => (luminance(hex) > 0.36 ? '#14201A' : '#FFFFFF');

export const ACCENT = '#FF7A1A';
export const NUMBER_FONT = '"Inter", "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif';
export const TEXT_FONT = '"Inter", "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif';
