/** Optional Supabase cloud playbook. Safe guest-only fallback when not configured.
 * Auth and session handling are delegated to the official supabase-js UMD client.
 * Only a publishable key can be placed in public/cloud-config.js.
 */
import type { Board } from '../domain/types';
import { isValidStoredBoard } from '../domain/validate';

export type CloudUser = { id: string; email?: string };
export type CloudState = 'guest' | 'syncing' | 'saved' | 'offline' | 'conflict';

type Query = { select: (...args: any[]) => any; eq: (...args: any[]) => any; order: (...args: any[]) => any; limit: (...args: any[]) => any; maybeSingle: () => Promise<any>; single: () => Promise<any> };
type Client = {
  auth: {
    getSession(): Promise<{ data: { session: { user: CloudUser } | null }; error: any }>;
    onAuthStateChange(cb: (event: string, session: { user: CloudUser } | null) => void): unknown;
    signInWithPassword(args: { email: string; password: string }): Promise<{ error: any }>;
    signUp(args: { email: string; password: string; options: { emailRedirectTo: string } }): Promise<{ data: { session: unknown }; error: any }>;
    resetPasswordForEmail(email: string, opts: { redirectTo: string }): Promise<{ error: any }>;
    updateUser(args: { password: string }): Promise<{ error: any }>;
    signOut(): Promise<{ error: any }>;
  };
  from(table: string): { select: (...args: any[]) => Query; insert: (...args: any[]) => Query; update: (...args: any[]) => Query; delete: (...args: any[]) => Query };
};

declare global {
  interface Window {
    PITCHPLAY_CONFIG?: { supabaseUrl?: string; supabasePublishableKey?: string };
    supabase?: { createClient: (url: string, key: string, options: unknown) => Client };
  }
}

const config = window.PITCHPLAY_CONFIG ?? {};
const url = config.supabaseUrl?.trim() || '';
const key = config.supabasePublishableKey?.trim() || '';
export const cloudConfigured = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url) && /^(sb_publishable_[\w-]+|eyJ[\w.-]+)$/.test(key);
let client: Client | null = null;
let user: CloudUser | null = null;
let onAuth: ((account: CloudUser | null) => void) | null = null;
let onPasswordRecovery: (() => void) | null = null;
let onCloudState: ((state: CloudState) => void) | null = null;
const cloudVersions = new Map<string, { remote: number; local: number }>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<string>();
let accountEpoch = 0;
let suppressWrites = false;

export const currentUser = () => user;
export const onCloudStatus = (callback: (state: CloudState) => void) => { onCloudState = callback; };
const status = (s: CloudState) => onCloudState?.(s);
const versionsKey = (id: string) => 'pitchplay_cloud_versions:' + id;
function saveVersions() {
  if (!user) return;
  try { localStorage.setItem(versionsKey(user.id), JSON.stringify([...cloudVersions.entries()])); } catch { /* offline work survives */ }
}
function readVersions() {
  cloudVersions.clear();
  try {
    const v: unknown = JSON.parse(localStorage.getItem(versionsKey(user!.id)) || '[]');
    if (Array.isArray(v)) for (const item of v) if (Array.isArray(item) && typeof item[0] === 'string' && item[1]?.remote > 0) cloudVersions.set(item[0], item[1]);
  } catch { /* no cloud cursor */ }
}
async function sdk() {
  if (!cloudConfigured) throw Error('Cloud accounts are not configured yet. Guest mode still works.');
  if (client) return client;
  if (!window.supabase?.createClient) {
    await new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0';
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('The sign-in library could not load. Try again online.'));
      document.head.append(el);
    });
  }
  if (!window.supabase?.createClient) throw Error('The sign-in library is not available.');
  client = window.supabase.createClient(url.replace(/\/$/, ''), key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' } });
  return client;
}
export async function startCloud(onChange: (account: CloudUser | null) => void, onRecover: () => void) {
  onAuth = onChange; onPasswordRecovery = onRecover;
  if (!cloudConfigured) { onChange(null); return; }
  const c = await sdk();
  const { data, error } = await c.auth.getSession();
  if (error) throw error;
  applyUser(data.session?.user ?? null);
  c.auth.onAuthStateChange((event, session) => {
    queueMicrotask(() => { applyUser(session?.user ?? null); if (event === 'PASSWORD_RECOVERY') onPasswordRecovery?.(); });
  });
}
function applyUser(next: CloudUser | null) {
  if (user?.id === next?.id) return;
  accountEpoch++;
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear(); inFlight.clear(); user = next;
  if (user) readVersions(); else cloudVersions.clear();
  status(user ? 'syncing' : 'guest');
  onAuth?.(next);
}
function fail(e: any): never { throw new Error(e?.message || 'Cloud request failed'); }
export async function signIn(email: string, password: string) { const { error } = await (await sdk()).auth.signInWithPassword({ email, password }); if (error) fail(error); }
export async function signUp(email: string, password: string) { const { data, error } = await (await sdk()).auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }); if (error) fail(error); return !!data.session; }
export async function resetPassword(email: string) { const { error } = await (await sdk()).auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }); if (error) fail(error); }
export async function updatePassword(password: string) { const { error } = await (await sdk()).auth.updateUser({ password }); if (error) fail(error); }
export async function signOut() { const { error } = await (await sdk()).auth.signOut(); if (error) fail(error); }

// Module hooks deliberately avoid a cyclic dependency on the IndexedDB store.
export function queueCloudSave(board: Board) {
  if (!user || suppressWrites) return;
  const account = user.id, epoch = accountEpoch;
  const old = pending.get(board.id); if (old) clearTimeout(old);
  status('syncing');
  const timer = setTimeout(() => {
    pending.delete(board.id);
    if (accountEpoch !== epoch || user?.id !== account) return;
    void upload(board, account, epoch).catch((e) => { console.error('PitchPlay cloud save', e); status('offline'); });
  }, 900);
  pending.set(board.id, timer);
}
async function upload(board: Board, owner: string, epoch: number) {
  if (inFlight.has(board.id)) { queueCloudSave(board); return; }
  if (JSON.stringify(board).length > 1500000) throw Error('Board is too large for cloud sync');
  inFlight.add(board.id);
  try {
    const remote = cloudVersions.get(board.id);
    if (remote && remote.local >= board.revision) return;
    const c = await sdk();
    const result = remote
      ? await c.from('pitchplay_tactics').update({ title: board.title, board, revision: remote.remote + 1, updated_at: new Date().toISOString() }).eq('id', board.id).eq('user_id', owner).eq('revision', remote.remote).select('revision').maybeSingle()
      : await c.from('pitchplay_tactics').insert({ id: board.id, user_id: owner, title: board.title, board, revision: 1 }).select('revision').maybeSingle();
    if (epoch !== accountEpoch || owner !== user?.id) return;
    if (result.error?.code === '23505' || (!result.data && !result.error)) { status('conflict'); return; }
    if (result.error) fail(result.error);
    cloudVersions.set(board.id, { remote: result.data.revision, local: board.revision }); saveVersions();
  } finally { inFlight.delete(board.id); if (pending.size === 0 && user?.id === owner) status('saved'); }
}
export async function syncCloudLibrary(listLocal: () => Promise<Board[]>, putLocal: (board: Board) => Promise<void>) {
  if (!user) return;
  const account = user.id, epoch = accountEpoch;
  const { data, error } = await (await sdk()).from('pitchplay_tactics').select('id,board,revision').limit(200);
  if (error) fail(error);
  if (epoch !== accountEpoch || user?.id !== account) return;
  const local = new Map((await listLocal()).map((b) => [b.id, b]));
  for (const row of (data || []) as { id: string; board: Board; revision: number }[]) {
    if (!isValidStoredBoard(row.board) || row.id !== row.board.id) continue;
    const existing = local.get(row.id), prev = cloudVersions.get(row.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(row.board) && (!prev || existing.revision !== prev.local)) {
      // Preserve unsynced work with a separate UUID, never silently overwrite.
      const copy = { ...existing, id: crypto.randomUUID(), title: existing.title.slice(0, 63) + ' (local copy)' };
      suppressWrites = true; try { await putLocal(copy); } finally { suppressWrites = false; }
      queueCloudSave(copy);
    }
    suppressWrites = true; try { await putLocal(row.board); } finally { suppressWrites = false; }
    cloudVersions.set(row.id, { remote: row.revision, local: row.board.revision });
    local.delete(row.id);
  }
  // Only upload newly created local boards. Existing server boards are never auto-deleted.
  for (const b of local.values()) if (!cloudVersions.has(b.id)) queueCloudSave(b);
  saveVersions(); status(pending.size ? 'syncing' : 'saved');
}
export async function cloudDelete(boardId: string) {
  if (!user || !cloudVersions.has(boardId)) return;
  const rev = cloudVersions.get(boardId)!;
  const { data, error } = await (await sdk()).from('pitchplay_tactics').delete().eq('id', boardId).eq('revision', rev.remote).select('id');
  if (error) fail(error);
  if (!data?.length) throw Error('Cloud copy changed on another device. Sync before deleting.');
  cloudVersions.delete(boardId); saveVersions();
}
