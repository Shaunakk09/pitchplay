// Library and create sheet (BRD-001 to BRD-013).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Board, Format, Slot } from '../domain/types';
import { BOARD_DELETE_UNDO_MS, FORMATS, LEN, TEAM_TOKENS } from '../domain/params';
import * as ops from '../domain/ops';
import { PRESETS } from '../domain/presets';
import { createSampleBoard } from '../domain/sample';
import { TEAM_COLORS } from '../render/themes';
import { deleteBoard, listBoards, listVersions, putBoard, restoreVersions, storageAvailable, storageNearlyFull, type VersionRecord } from '../store/db';
import { projectBlob } from './ExportSheet';
import { ImportDialog, pickProjectFile } from './ImportDialog';
import { Confirm, Icon, Menu, Modal, Segmented, Select, Swatches, TextField, download, safeName, type MenuState } from './kit';
import { PhaseThumb } from './PhaseRail';
import { devicePref, setDevicePref } from './useEditor';

const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

export function Library(props: { sessionBoards: Map<string, Board>; onOpen: (id: string, initial?: Board) => void }) {
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [nearlyFull, setNearlyFull] = useState(false);
  const [bannerOff, setBannerOff] = useState(false);
  const [previewNoteOff, setPreviewNoteOffState] = useState(() => devicePref('previewNoteSeen', false));
  const setPreviewNoteOff = (v: boolean) => {
    setPreviewNoteOffState(v);
    setDevicePref('previewNoteSeen', v);
  };
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<Board | null>(null);
  const [deleting, setDeleting] = useState<Board | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [snack, setSnack] = useState<{ board: Board; versions: VersionRecord[] } | null>(null);
  const pendingDelete = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  const refresh = useCallback(async () => {
    const ok = await storageAvailable();
    setAvailable(ok);
    const list = ok ? await listBoards().catch(() => []) : [...props.sessionBoards.values()];
    setBoards(list.filter((b) => b.id !== pendingDelete.current?.id));
    setNearlyFull(await storageNearlyFull());
  }, [props.sessionBoards]);
  useEffect(() => void refresh(), [refresh]);

  // BRD-012: the board leaves the list at once and is deleted when the undo window closes.
  const finishDelete = useCallback(() => {
    const p = pendingDelete.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingDelete.current = null;
    void deleteBoard(p.id);
    setSnack(null);
  }, []);
  useEffect(() => () => finishDelete(), [finishDelete]);

  const store = async (b: Board) => {
    if (available) await putBoard(b, null);
    else props.sessionBoards.set(b.id, b);
  };

  const create = async (spec: ops.CreateSpec) => {
    const b = ops.createBoard(spec);
    await store(b).catch(() => props.sessionBoards.set(b.id, b)); // BRD-008: saved at once
    props.onOpen(b.id, available ? undefined : b);
  };

  // A ready-made board for first-time visitors.
  const openExample = async () => {
    const b = createSampleBoard();
    await store(b).catch(() => props.sessionBoards.set(b.id, b));
    props.onOpen(b.id, available ? undefined : b);
  };

  const duplicate = async (b: Board) => {
    const copy = ops.copyBoard(b, `${b.title} (copy)`); // BRD-011
    await store(copy);
    setHighlight(copy.id);
    await refresh();
  };

  const remove = async (b: Board) => {
    finishDelete();
    if (!available) {
      props.sessionBoards.delete(b.id);
      return void refresh();
    }
    const versions = await listVersions(b.id);
    pendingDelete.current = { id: b.id, timer: setTimeout(finishDelete, BOARD_DELETE_UNDO_MS) };
    setSnack({ board: b, versions });
    setBoards((list) => (list ?? []).filter((x) => x.id !== b.id));
  };
  const undoDelete = async () => {
    const p = pendingDelete.current;
    if (!p || !snack) return;
    clearTimeout(p.timer);
    pendingDelete.current = null;
    setSnack(null);
    await refresh(); // nothing was deleted yet, so the board and its versions are intact
    void restoreVersions([]);
  };

  const importAsNew = async (b: Board) => {
    // IMP-004: a new ID; " (2)" when the title is taken.
    const titles = new Set((boards ?? []).map((x) => x.title));
    const copy = ops.copyBoard(b, titles.has(b.title) ? `${b.title.slice(0, LEN.title - 4)} (2)` : b.title);
    await store(copy);
    setImportFile(null);
    props.onOpen(copy.id, available ? undefined : copy);
  };

  const shown = (boards ?? []).filter((b) => b.title.toLowerCase().includes(query.trim().toLowerCase())); // BRD-003
  const openMenu = (b: Board, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({
      x: r.right - 200,
      y: r.bottom + 4,
      title: b.title,
      items: [
        { label: 'Open', run: () => props.onOpen(b.id, available ? undefined : b) },
        { label: 'Rename', run: () => setRenaming(b) },
        { label: 'Duplicate', run: () => void duplicate(b) },
        { label: 'Export project file', run: () => download(projectBlob(b), `${safeName(b.title)}.pitchplay`) },
        { label: 'Delete', danger: true, run: () => setDeleting(b) },
      ],
    });
  };

  return (
    <div
      className={`library ${dropping ? 'dropping' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        const f = e.dataTransfer.files[0];
        if (f) setImportFile(f); // IMP-001
      }}
    >
      <header className="lib-head">
        <h1 className="wordmark">
          Pitch<span>Play</span>
        </h1>
        <div className="lib-actions">
          <button type="button" className="btn hide-narrow" onClick={() => void openExample()}>
            Example
          </button>
          <button type="button" className="btn" onClick={() => pickProjectFile(setImportFile)}>
            <Icon name="file" size={18} /> Open file
          </button>
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={18} /> New board
          </button>
        </div>
      </header>

      {!available && (
        <div className="banner" role="alert">
          <span>This browser is not keeping boards right now. Export a project file before you close this tab.</span>
        </div>
      )}
      {nearlyFull && !bannerOff && (
        <div className="banner" role="status">
          <span>Storage is almost full. Export boards you no longer edit, then delete them.</span>
          <button type="button" className="btn small" onClick={() => setBannerOff(true)}>
            Dismiss
          </button>
        </div>
      )}

      {!previewNoteOff && (
        <div className="preview-note" role="note">
          <span>
            <b>Early preview.</b> Boards are kept in this browser only. Export a project file to keep a copy or move it to another device.
          </span>
          <button type="button" className="btn small ghost" onClick={() => setPreviewNoteOff(true)}>
            Got it
          </button>
        </div>
      )}

      {boards === null ? (
        <p className="center-note">Loading boards.</p>
      ) : boards.length === 0 && !snack ? (
        <div className="empty">
          <div className="empty-pitch" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <p className="empty-line">Build a tactic, play it, share it.</p>
          <p className="empty-sub">Set up both teams, draw runs and passes, add phases and watch the move play out. Export it as an image, a storyboard or a video.</p>
          <div className="lib-actions">
            <button type="button" className="btn primary big" onClick={() => setCreating(true)}>
              New board
            </button>
            <button type="button" className="btn big" onClick={() => void openExample()}>
              See an example
            </button>
          </div>
          <button type="button" className="linkbtn" onClick={() => pickProjectFile(setImportFile)}>
            Or open a .pitchplay file
          </button>
        </div>
      ) : (
        <>
          <label className="search">
            <Icon name="search" size={18} />
            <input type="search" placeholder="Search boards" aria-label="Search boards by title" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {shown.length === 0 ? (
            <p className="center-note">No board title matches "{query}".</p>
          ) : (
            <ul className="board-list">
              {shown.map((b) => (
                <li key={b.id} className={`board-card ${highlight === b.id ? 'fresh' : ''}`}>
                  <button type="button" className="board-open" onClick={() => props.onOpen(b.id, available ? undefined : b)} aria-label={`Open ${b.title}, ${b.format}, ${b.phases.length} ${b.phases.length === 1 ? 'phase' : 'phases'}`}>
                    <PhaseThumb board={b} index={0} w={264} h={170} />
                    <span className="board-title">{b.title}</span>
                    <span className="board-meta">
                      {b.format} · {b.phases.length} {b.phases.length === 1 ? 'phase' : 'phases'} · {ago(b.updatedAt)}
                    </span>
                  </button>
                  <button type="button" className="iconbtn board-more" aria-label={`Actions for ${b.title}`} onClick={(e) => openMenu(b, e.currentTarget)}>
                    <Icon name="more" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {creating && <CreateSheet onClose={() => setCreating(false)} onCreate={(spec) => void create(spec)} />}
      {renaming && <RenameDialog board={renaming} onClose={() => setRenaming(null)} onDone={async (title) => (await store({ ...renaming, title, revision: renaming.revision + 1, updatedAt: new Date().toISOString() }), setRenaming(null), refresh())} />}
      {deleting && (
        <Confirm
          title="Delete board"
          body={`Delete '${deleting.title}'? It has ${deleting.phases.length} ${deleting.phases.length === 1 ? 'phase' : 'phases'}. You can undo for 10 seconds.`}
          confirm="Delete"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => void remove(deleting)}
        />
      )}
      {importFile && <ImportDialog file={importFile} onClose={() => setImportFile(null)} onOpenNew={importAsNew} />}
      {menu && <Menu menu={menu} onClose={() => setMenu(null)} />}
      {snack && (
        <div className="toasts" role="status">
          <div className="toast">
            <span>Deleted '{snack.board.title}'.</span>
            <button type="button" onClick={() => void undoDelete()}>
              Undo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RenameDialog({ board, onClose, onDone }: { board: Board; onClose: () => void; onDone: (title: string) => void }) {
  const [v, setV] = useState(board.title);
  return (
    <Modal
      title="Rename board"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => onDone(ops.cleanTitle(v, board.title))}>
            Rename
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="rename-board">Title</label>
        <input id="rename-board" data-autofocus value={v} maxLength={LEN.title} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onDone(ops.cleanTitle(v, board.title))} />
      </div>
    </Modal>
  );
}

// BRD-004: defaults are 5v5, the first preset per team, HOME and AWAY, colors 1 and 2, HOME primary, HOME attacks right.
function CreateSheet({ onClose, onCreate }: { onClose: () => void; onCreate: (spec: ops.CreateSpec) => void }) {
  const [title, setTitle] = useState('Untitled tactic');
  const [format, setFormat] = useState<Format>('5v5');
  const [presetA, setPresetA] = useState(PRESETS['5v5'][0].name);
  const [presetB, setPresetB] = useState(PRESETS['5v5'][0].name);
  const [nameA, setNameA] = useState('HOME');
  const [nameB, setNameB] = useState('AWAY');
  const [colorA, setColorA] = useState('team-1');
  const [colorB, setColorB] = useState('team-2');
  const [primary, setPrimary] = useState<Slot>('A');
  const [attacks, setAttacks] = useState<'right' | 'left'>('right');
  const pickFormat = (f: Format) => {
    setFormat(f);
    setPresetA(PRESETS[f][0].name);
    setPresetB(PRESETS[f][0].name);
  };
  const a = nameA.trim() || 'HOME';
  const b = nameB.trim() || 'AWAY';
  const swatches = (mine: string, theirs: string, theirName: string) =>
    TEAM_TOKENS.map((t) => ({ value: t, hex: TEAM_COLORS[t].hex, name: TEAM_COLORS[t].name, disabled: t === theirs && t !== mine, note: t === theirs ? `Used by ${theirName}` : undefined }));
  const preview = ops.createBoard({ format, presetA, presetB, colorA, colorB, teamAAttacks: attacks });
  return (
    <Modal
      title="New board"
      onClose={onClose}
      wide
      sheet
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => onCreate({ title, format, presetA, presetB, nameA: a, nameB: b, colorA, colorB, primary, teamAAttacks: attacks })}>
            Create
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="new-title">Title</label>
        <input id="new-title" value={title} maxLength={LEN.title} onChange={(e) => setTitle(e.target.value)} onFocus={(e) => e.target.select()} />
      </div>
      <Segmented label="Format" value={format} options={FORMATS.map((f) => ({ value: f, label: f }))} onChange={pickFormat} />
      <div className="preview-thumb">
        <PhaseThumb board={preview} index={0} w={300} h={194} />
      </div>
      <div className="create-teams">
        <section className="group">
          <TextField label="Team A name" value={nameA} maxLength={LEN.team} onCommit={(v) => setNameA(v.trim() || 'HOME')} />
          <Select label="Formation" value={presetA} options={PRESETS[format].map((p) => ({ value: p.name, label: p.name }))} onChange={setPresetA} />
          <Swatches label="Color" value={colorA} options={swatches(colorA, colorB, b)} onChange={setColorA} />
        </section>
        <section className="group">
          <TextField label="Team B name" value={nameB} maxLength={LEN.team} onCommit={(v) => setNameB(v.trim() || 'AWAY')} />
          <Select label="Formation" value={presetB} options={PRESETS[format].map((p) => ({ value: p.name, label: p.name }))} onChange={setPresetB} />
          <Swatches label="Color" value={colorB} options={swatches(colorB, colorA, a)} onChange={setColorB} />
        </section>
      </div>
      <div className="grid2">
        <Segmented
          label="Primary team"
          value={primary}
          options={[
            { value: 'A', label: a },
            { value: 'B', label: b },
          ]}
          onChange={setPrimary}
        />
        <Segmented
          label={`${a} attacks`}
          value={attacks}
          options={[
            { value: 'right', label: 'Right' },
            { value: 'left', label: 'Left' },
          ]}
          onChange={setAttacks}
        />
      </div>
    </Modal>
  );
}
