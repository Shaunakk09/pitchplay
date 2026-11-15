// Library and create sheet (BRD-001 to BRD-013).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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

export function Library(props: { sessionBoards: Map<string, Board>; onOpen: (id: string, initial?: Board) => void; accountControl?: ReactNode; cloudReady?: boolean }) {
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
        <div className="brand-lockup"><span className="brand-symbol" aria-hidden="true">P</span><div><h1 className="wordmark">pitch<span>play.</span></h1><small>TACTICAL STUDIO</small></div></div>
        <nav className="lib-actions" aria-label="Workspace actions">
          <button type="button" className="btn hide-narrow" onClick={() => void openExample()}>Explore example</button>
          <button type="button" className="btn nav-file" onClick={() => pickProjectFile(setImportFile)}><Icon name="file" size={18}/><span>Open file</span></button>
          <button type="button" className="btn primary nav-create" onClick={() => setCreating(true)}><Icon name="plus" size={18}/><span>New tactic</span></button>
          {props.accountControl}
        </nav>
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
            <b>Your tactics, your way.</b> {props.cloudReady ? 'Sign in to sync between devices, or keep working as a guest.' : 'Guest boards are saved on this device. Export a .pitchplay file to back up your work until cloud sync is enabled.'}
          </span>
          <button type="button" className="btn small ghost" onClick={() => setPreviewNoteOff(true)}>
            Got it
          </button>
        </div>
      )}

      {boards === null ? (
        <p className="center-note">Loading boards.</p>
      ) : boards.length === 0 && !snack ? (
        <div className="welcome">
          <section className="welcome-copy">
            <span className="welcome-eyebrow"><i/> YOUR NEXT PLAY STARTS HERE</span>
            <h2>See the game.<br/><em>Shape the play.</em></h2>
            <p>Turn football ideas into moments your team can see. Arrange your players, draw the runs, and watch every move unfold.</p>
            <div className="welcome-actions">
              <button type="button" className="btn primary big" onClick={() => setCreating(true)}><Icon name="plus" size={19}/> Create your first tactic</button>
              <button type="button" className="btn big" onClick={() => void openExample()}><Icon name="play" size={17}/> Explore example</button>
            </div>
            <div className="welcome-assurances"><span><Icon name="check" size={15}/> Works on mobile</span><span><Icon name="check" size={15}/> No setup required</span><span><Icon name="check" size={15}/> Free to try</span></div>
          </section>
          <div className="welcome-art">
            <div className="art-head"><span><i/> TACTICAL BOARD</span><span>01 / 03 <Icon name="play" size={14}/></span></div>
            <svg viewBox="0 0 700 465" aria-label="Football tactics pitch with a passing combination and player runs" role="img">
              <defs><linearGradient id="ppGreen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#246b48"/><stop offset="1" stopColor="#123d2b"/></linearGradient><marker id="ppArrow" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6" stroke="#cbfa8f" strokeWidth="1.8" fill="none"/></marker></defs>
              <rect x="0" y="0" width="700" height="465" rx="14" fill="url(#ppGreen)"/>
              {[1,3,5,7].map(i=><rect key={i} x={i*78} y="12" width="78" height="440" fill="#ffffff" opacity=".032"/>)}
              <g stroke="#effce9" strokeWidth="2.7" fill="none" opacity=".66"><rect x="22" y="18" width="656" height="428"/><path d="M350 18V446"/><circle cx="350" cy="232" r="59"/><path d="M22 145H130V320H22M678 145H570V320H678M22 190H66V274H22M678 190H634V274H678"/></g>
              <path d="M205 290Q319 269 434 165" stroke="#ccfa88" strokeWidth="6" strokeDasharray="12 12" fill="none" markerEnd="url(#ppArrow)"/>
              <path d="M212 191Q314 126 403 138" stroke="#eaffce" strokeWidth="3" strokeDasharray="5 9" opacity=".8" fill="none"/>
              {([[72,232,'1'],[159,156,'4'],[162,327,'3'],[282,232,'8'],[420,158,'7'],[430,334,'9']] as [number,number,string][]).map(([cx,cy,n])=><g key={'h'+n}><circle cx={cx} cy={cy} r="20" fill="#c9f783" stroke="#123d2b" strokeWidth="5"/><text x={cx} y={cy+6} textAnchor="middle" fill="#123423" fontWeight="800" fontSize="18">{n}</text></g>)}
              {([[626,232,'1'],[540,144,'2'],[543,328,'5'],[396,233,'6'],[492,235,'8']] as [number,number,string][]).map(([cx,cy,n])=><g key={'a'+n}><circle cx={cx} cy={cy} r="20" fill="#fb9f80" stroke="#46261e" strokeWidth="5"/><text x={cx} y={cy+6} textAnchor="middle" fill="#38201b" fontWeight="800" fontSize="18">{n}</text></g>)}
              <circle cx="288" cy="210" r="8" fill="#fff" stroke="#174532" strokeWidth="4"/>
            </svg>
            <div className="art-foot"><span><strong>Build-up pattern</strong><small>4–3–3 · Phase 01</small></span><span className="art-live">● READY TO PLAY</span></div>
          </div>
          <div className="welcome-features">
            <div><span className="feature-icon"><Icon name="formation" size={21}/></span><strong>Design your shape</strong><p>Set up teams from 5v5 to 11v11, in seconds.</p></div>
            <div><span className="feature-icon"><Icon name="run" size={21}/></span><strong>Animate each move</strong><p>Build runs, passing lanes and sequences.</p></div>
            <div><span className="feature-icon"><Icon name="export" size={21}/></span><strong>Show your team</strong><p>Share diagrams, clips and editable tactics.</p></div>
          </div>
        </div>
      ) : (
        <>
          <div className="collection-title"><div><span>YOUR PLAYBOOK</span><h2>All tactics <small>{boards.length}</small></h2><p>Pick a board to keep building.</p></div><button type="button" className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={17}/> New tactic</button></div>
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
  // Progressive setup prevents two narrow team cards and a preview from crowding a phone.
  const [mobileStep, setMobileStep] = useState(0);
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
    <Modal title="Create a tactic" onClose={onClose} wide sheet className="setup-modal"
      footer={<><span className="setup-tip"><Icon name="check" size={16}/> You can change these later</span>
        <button type="button" className="btn setup-cancel" onClick={onClose}>Cancel</button>
        <button type="button" className="btn mobile-step-back" disabled={mobileStep===0} onClick={() => setMobileStep(s => Math.max(0,s-1))}>Back</button>
        <button type="button" className={`btn primary mobile-step-next ${mobileStep === 2 ? 'hide-mobile-step' : ''}`} onClick={() => setMobileStep(s => Math.min(2,s+1))}>Continue <Icon name="next" size={16}/></button>
        <button type="button" className={`btn primary setup-create-submit ${mobileStep !== 2 ? 'show-desktop-only-create' : ''}`} disabled={!title.trim()} onClick={() => onCreate({title,format,presetA,presetB,nameA:a,nameB:b,colorA,colorB,primary,teamAAttacks:attacks})}>Create board <Icon name="plus" size={16}/></button></>}>
      <nav className="mobile-setup-steps" aria-label="Create board steps">
        {['Format','Teams','Preview'].map((label,i)=><button type="button" key={label} aria-current={mobileStep===i ? 'step' : undefined} onClick={() => setMobileStep(i)}><span>{i+1}</span>{label}</button>)}
      </nav>
      <div className="setup-intro"><span>{['01 / YOUR TACTIC','02 / MATCH SETUP','03 / READY TO PLAY'][mobileStep]}</span><p>{['Choose a name and playing format.','Pick your two teams and formations.','Review the pitch, then create your board.'][mobileStep]}</p></div>
      <div className="setup-layout" data-mobile-step={mobileStep}>
        <div className="setup-fields">
          <div className="field"><label htmlFor="new-title">Tactic name</label><input id="new-title" value={title} maxLength={LEN.title} onChange={e=>setTitle(e.target.value)} onFocus={e=>e.target.select()}/></div>
          <Segmented label="Players on the pitch" value={format} options={FORMATS.map(f=>({value:f,label:f}))} onChange={pickFormat}/>
          <div className="create-teams">
            <section className="setup-team">
              <div className="setup-team-head"><span className="setup-avatar" style={{background:TEAM_COLORS[colorA].hex}}>A</span><div><strong>Home team</strong><small>TEAM A</small></div></div>
              <TextField label="Team name" value={nameA} maxLength={LEN.team} onCommit={v=>setNameA(v.trim()||'HOME')}/>
              <Select label="Formation" value={presetA} options={PRESETS[format].map(p=>({value:p.name,label:p.name}))} onChange={setPresetA}/>
              <Swatches label="Kit colour" value={colorA} options={swatches(colorA,colorB,b)} onChange={setColorA}/>
            </section>
            <section className="setup-team">
              <div className="setup-team-head"><span className="setup-avatar" style={{background:TEAM_COLORS[colorB].hex}}>B</span><div><strong>Away team</strong><small>TEAM B</small></div></div>
              <TextField label="Team name" value={nameB} maxLength={LEN.team} onCommit={v=>setNameB(v.trim()||'AWAY')}/>
              <Select label="Formation" value={presetB} options={PRESETS[format].map(p=>({value:p.name,label:p.name}))} onChange={setPresetB}/>
              <Swatches label="Kit colour" value={colorB} options={swatches(colorB,colorA,a)} onChange={setColorB}/>
            </section>
          </div>
          <div className="grid2 setup-options">
            <Segmented label="Primary team" value={primary} options={[{value:'A',label:a},{value:'B',label:b}]} onChange={setPrimary}/>
            <Segmented label={a+' attacks'} value={attacks} options={[{value:'right',label:'Right'},{value:'left',label:'Left'}]} onChange={setAttacks}/>
          </div>
        </div>
        <aside className="setup-preview" aria-label="Live formation preview">
          <span className="setup-preview-kicker">● LIVE PREVIEW</span>
          <div className="setup-preview-pitch"><PhaseThumb board={preview} index={0} w={300} h={194}/></div>
          <strong>{a} <em>vs</em> {b}</strong><p>{format} · {presetA} / {presetB}</p>
          <div className="setup-preview-note"><Icon name="run" size={17}/> Create the board to draw player runs, passes and phases.</div>
        </aside>
      </div>
    </Modal>
  );
}
