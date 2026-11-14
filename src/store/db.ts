// Local persistence (PST). IndexedDB, one record per board, written whole in one transaction per save.
import type { Board } from '../domain/types';
import { AUTOSAVE_MAX_MS, AUTOSAVE_MS, SAVE_RETRY_S, VERSIONS_AUTO, VERSIONS_NAMED } from '../domain/params';
import { isValidStoredBoard } from '../domain/validate';
import { queueCloudSave, cloudDelete } from './cloud';

let DB_NAME = 'pitchplay';
// Different logged-in accounts must never share the same IndexedDB library.
export function setAccountStorage(userId: string | null) {
  const name = userId ? 'pitchplay-user-' + userId : 'pitchplay';
  if (name === DB_NAME) return;
  void dbPromise?.then((db) => db?.close());
  dbPromise = null; DB_NAME = name;
}
const DB_VERSION = 1;

export interface VersionRecord {
  id?: number;
  boardId: string;
  kind: 'auto' | 'named';
  name: string;
  at: string;
  board: Board;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

export function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('boards')) db.createObjectStore('boards', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('versions')) db.createObjectStore('versions', { keyPath: 'id', autoIncrement: true }).createIndex('boardId', 'boardId');
        if (!db.objectStoreNames.contains('prefs')) db.createObjectStore('prefs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // PST-007: storage unavailable
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Storage error'));
    tx.onabort = () => reject(tx.error ?? new Error('Storage write was aborted'));
  });
const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export const storageAvailable = async () => (await openDb()) !== null;

export async function listBoards(): Promise<Board[]> {
  const db = await openDb();
  if (!db) return [];
  const all = (await req(db.transaction('boards').objectStore('boards').getAll())) as Board[];
  return all.filter((b) => b && typeof b.id === 'string' && Array.isArray(b.phases)).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function getRawBoard(id: string): Promise<unknown> {
  const db = await openDb();
  if (!db) return undefined;
  return req(db.transaction('boards').objectStore('boards').get(id));
}

export interface LoadResult {
  board: Board;
  restoredFrom: string | null; // PST-011: time of the version that replaced a damaged record
  damaged: unknown;
}

export async function loadBoard(id: string): Promise<LoadResult | null> {
  const raw = await getRawBoard(id);
  if (raw === undefined) return null;
  if (isValidStoredBoard(raw)) return { board: raw, restoredFrom: null, damaged: null };
  const versions = await listVersions(id);
  const good = versions.find((v) => isValidStoredBoard(v.board));
  if (!good) return null;
  return { board: { ...good.board, revision: good.board.revision + 1 }, restoredFrom: good.at, damaged: raw };
}

export class ConflictError extends Error {}

// Test hook for AT-090: lets a test force writes to fail.
export const debug = { failWrites: false };

// PST-003: the transaction reads the stored revision first and aborts when it is newer than this tab's base.
export async function putBoard(board: Board, baseRevision: number | null): Promise<void> {
  const db = await openDb();
  if (!db) throw new Error('Storage is not available');
  if (debug.failWrites) throw new Error('Storage is full');
  const tx = db.transaction('boards', 'readwrite');
  const store = tx.objectStore('boards');
  const finished = done(tx);
  const existing = (await req(store.get(board.id))) as Board | undefined;
  if (baseRevision !== null && existing && typeof existing.revision === 'number' && existing.revision > baseRevision) {
    tx.abort();
    await finished.catch(() => undefined);
    throw new ConflictError('This board changed in another tab');
  }
  store.put(board);
  await finished;
  queueCloudSave(board);
}

export async function deleteBoard(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction(['boards', 'versions', 'prefs'], 'readwrite');
  tx.objectStore('boards').delete(id);
  tx.objectStore('prefs').delete(`view:${id}`);
  const idx = tx.objectStore('versions').index('boardId');
  const keys = await req(idx.getAllKeys(id));
  for (const k of keys) tx.objectStore('versions').delete(k);
  await done(tx);
  void cloudDelete(id).catch((e) => console.warn("Cloud delete needs retry",e));
}

export async function listVersions(boardId: string): Promise<VersionRecord[]> {
  const db = await openDb();
  if (!db) return [];
  const all = (await req(db.transaction('versions').objectStore('versions').index('boardId').getAll(boardId))) as VersionRecord[];
  return all.sort((a, b) => (a.at < b.at ? 1 : -1));
}

// PST-012, PST-013: the last 20 automatic versions are kept; named versions are never pruned.
export async function addVersion(board: Board, kind: 'auto' | 'named', name = ''): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  const existing = await listVersions(board.id);
  if (kind === 'named' && existing.filter((v) => v.kind === 'named').length >= VERSIONS_NAMED) return false;
  const tx = db.transaction('versions', 'readwrite');
  const store = tx.objectStore('versions');
  store.add({ boardId: board.id, kind, name, at: new Date().toISOString(), board } satisfies VersionRecord);
  if (kind === 'auto') {
    const autos = existing.filter((v) => v.kind === 'auto');
    for (const v of autos.slice(VERSIONS_AUTO - 1)) if (v.id !== undefined) store.delete(v.id);
  }
  await done(tx);
  return true;
}

export async function deleteVersion(id: number): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction('versions', 'readwrite');
  tx.objectStore('versions').delete(id);
  await done(tx);
}

export async function restoreVersions(records: VersionRecord[]): Promise<void> {
  const db = await openDb();
  if (!db || !records.length) return;
  const tx = db.transaction('versions', 'readwrite');
  for (const { id: _id, ...rest } of records) tx.objectStore('versions').add(rest);
  await done(tx);
}

export async function getPref<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return req(db.transaction('prefs').objectStore('prefs').get(key)) as Promise<T | undefined>;
}

export async function setPref(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction('prefs', 'readwrite');
    tx.objectStore('prefs').put(value, key);
    await done(tx);
  } catch {
    // Preferences are a convenience; a failed write never blocks editing.
  }
}

// BRD-013
export async function storageNearlyFull(): Promise<boolean> {
  try {
    const est = await navigator.storage?.estimate?.();
    return !!est && !!est.quota && (est.usage ?? 0) / est.quota >= 0.8;
  } catch {
    return false;
  }
}

export type SaveStatus = 'saved' | 'saving' | 'failed' | 'session' | 'conflict' | 'readonly';

// Save queue for one open board (PST-002 to PST-006, PARAM-15, PARAM-16).
export class Saver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private firstUnsavedAt = 0;
  private pending: Board | null = null;
  private running: Promise<boolean> | null = null;
  private retries = 0;
  private askedPersist = false;
  status: SaveStatus;
  persisted: number;

  constructor(
    private onStatus: (s: SaveStatus) => void,
    persistedRevision: number,
    available: boolean,
  ) {
    this.persisted = persistedRevision;
    this.status = available ? 'saved' : 'session';
  }

  private set(s: SaveStatus) {
    if (this.status !== s) {
      this.status = s;
      this.onStatus(s);
    }
  }

  get dirty() {
    return this.pending !== null || this.running !== null;
  }

  schedule(board: Board) {
    if (this.status === 'session' || this.status === 'conflict' || this.status === 'readonly') {
      this.pending = board;
      return;
    }
    const now = Date.now();
    if (!this.pending) this.firstUnsavedAt = now;
    this.pending = board;
    if (this.status !== 'failed') this.set('saving');
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(AUTOSAVE_MS, this.firstUnsavedAt + AUTOSAVE_MAX_MS - now));
    this.timer = setTimeout(() => void this.flush(), wait);
  }

  async flush(): Promise<boolean> {
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = this.retryTimer = null;
    if (this.running) await this.running;
    if (!this.pending) return this.status === 'saved';
    if (this.status === 'session' || this.status === 'conflict' || this.status === 'readonly') return false;
    const board = this.pending;
    this.pending = null;
    this.running = putBoard(board, this.persisted).then(
      () => {
        this.persisted = board.revision;
        this.retries = 0;
        // DAT-021: "Saved" only when the persisted revision is the current one.
        if (!this.pending) this.set('saved');
        if (!this.askedPersist) {
          this.askedPersist = true;
          void navigator.storage?.persist?.().catch(() => undefined); // PST-008
        }
        return true;
      },
      (err) => {
        this.pending ??= board; // kept in memory (PST-006)
        if (err instanceof ConflictError) this.set('conflict');
        else {
          this.set('failed');
          const s = SAVE_RETRY_S[Math.min(this.retries, SAVE_RETRY_S.length - 1)];
          this.retries++;
          this.retryTimer = setTimeout(() => void this.flush(), s * 1000);
        }
        return false;
      },
    );
    const okNow = await this.running;
    this.running = null;
    if (okNow && this.pending) return this.flush();
    return okNow;
  }

  // After "Load latest" or "Save mine as a copy" the queue starts clean.
  reset(persistedRevision: number) {
    this.pending = null;
    this.persisted = persistedRevision;
    this.retries = 0;
    this.set('saved');
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }
}
