// Dialogs opened from the editor: settings, formation, format change, versions, objects, roster, shortcuts.
import { useEffect, useState } from 'react';
import type { Board, Format, Theme } from '../domain/types';
import { FORMATS, FORMAT_SIZE, HOLD_MAX, LEN, TEAM_TOKENS, teamLimit } from '../domain/params';
import * as ops from '../domain/ops';
import { PRESETS } from '../domain/presets';
import { centreOn, isVisible } from '../render/camera';
import { teamMode, type HitRef } from '../render/draw';
import { describeHit } from '../render/hit';
import { TEAM_COLORS, THEME_NAMES } from '../render/themes';
import { addVersion, deleteVersion, listVersions, type VersionRecord } from '../store/db';
import { Confirm, Modal, Range, Segmented, Select, Swatches, Switch, TextField } from './kit';
import { PhaseThumb } from './PhaseRail';
import type { Editor } from './useEditor';

export function teamColorOptions(board: Pick<Board, 'teams'>, teamId: string) {
  const other = board.teams.find((t) => t.id !== teamId)!;
  // BRD-007: the other team's color is disabled and labelled.
  return TEAM_TOKENS.map((t) => ({ value: t, hex: TEAM_COLORS[t].hex, name: TEAM_COLORS[t].name, disabled: t === other.color, note: t === other.color ? `Used by ${other.name}` : undefined }));
}

export function SettingsDialog({ ed }: { ed: Editor }) {
  const { board } = ed;
  const close = () => ed.setDialog(null);
  const upd = (patch: ops.BoardPatch, label: string) => ed.commit(ops.updateBoard(ed.boardRef.current, patch), label);
  const set = (s: Partial<Board['settings']>, label: string) => upd({ settings: s }, label);
  return (
    <Modal title="Board settings" onClose={close} wide>
      <fieldset disabled={!!ed.readOnly} className="plain">
        <section className="group">
          <h3>General</h3>
          <TextField label="Title" value={board.title} maxLength={LEN.title} onCommit={(v) => upd({ title: v }, 'rename board')} />
          <div className="grid2">
            <Select label="Format" value={board.format} options={FORMATS.map((f) => ({ value: f, label: f }))} onChange={(f) => f !== board.format && ed.setDialog({ kind: 'format', format: f })} />
            <Select label="Pitch markings" value={board.pitchTemplate} options={FORMATS.map((f) => ({ value: f, label: f }))} onChange={(f) => upd({ pitchTemplate: f }, 'change pitch markings')} />
          </div>
          <Segmented label="Theme" value={board.pitchTheme} options={(Object.keys(THEME_NAMES) as Theme[]).map((t) => ({ value: t, label: THEME_NAMES[t] }))} onChange={(t) => upd({ pitchTheme: t }, 'change theme')} />
        </section>
        <section className="group">
          <h3>Teams</h3>
          {board.teams.map((t) => (
            <div key={t.id} className="team-block">
              <TextField label={`Team ${t.slot} name`} value={t.name} maxLength={LEN.team} onCommit={(v) => ed.commit(ops.updateTeam(ed.boardRef.current, t.id, { name: v }), 'rename team')} />
              <Swatches label="Color" value={t.color} options={teamColorOptions(board, t.id)} onChange={(v) => ed.commit(ops.updateTeam(ed.boardRef.current, t.id, { color: v }), 'change team color')} />
              <Segmented
                label="Marker"
                value={t.marker}
                options={[
                  { value: 'solid', label: 'Solid' },
                  { value: 'outlined', label: 'Outlined' },
                ]}
                onChange={(v) => ed.commit(ops.updateTeam(ed.boardRef.current, t.id, { marker: v }), 'swap team markers')}
              />
            </div>
          ))}
          <Segmented label="Primary team (labels follow it)" value={board.primaryTeamId} options={board.teams.map((t) => ({ value: t.id, label: t.name }))} onChange={(v) => upd({ primaryTeamId: v }, 'change primary team')} />
          <Segmented
            label={`${board.teams[0].name} attacks`}
            value={board.teamAAttacks}
            options={[
              { value: 'right', label: 'Right' },
              { value: 'left', label: 'Left' },
            ]}
            onChange={(v) => upd({ teamAAttacks: v }, 'change attack direction')}
          />
          <button type="button" className="btn" onClick={() => ed.setDialog({ kind: 'formation' })}>
            Apply formation
          </button>
        </section>
        <section className="group">
          <h3>Display</h3>
          <Switch label="Show names under players" checked={board.settings.showNames} onChange={(v) => set({ showNames: v }, 'toggle names')} />
          <Switch label="Show implied movement" checked={board.settings.showImplied} onChange={(v) => set({ showImplied: v }, 'toggle implied movement')} />
        </section>
        <section className="group">
          <h3>Playback</h3>
          <Range label="Hold at each phase" value={board.settings.holdMs} min={0} max={HOLD_MAX} step={100} format={(v) => `${(v / 1000).toFixed(1)} s`} onCommit={(v) => set({ holdMs: v }, 'change hold')} />
          <Segmented
            label="Lines during playback"
            value={board.settings.linesDuringPlayback}
            options={[
              { value: 'fade', label: 'Fade' },
              { value: 'keep', label: 'Keep' },
              { value: 'trail', label: 'Trail' },
            ]}
            onChange={(v) => set({ linesDuringPlayback: v }, 'change lines during playback')}
          />
          <Switch label="Loop" checked={board.settings.loop} onChange={(v) => set({ loop: v }, 'toggle loop')} />
        </section>
        <section className="group">
          <h3>Export</h3>
          <Switch label={'Add "Made with PitchPlay" by default'} checked={board.settings.exportMark} onChange={(v) => set({ exportMark: v }, 'toggle export mark')} />
        </section>
      </fieldset>
    </Modal>
  );
}

export function FormationDialog({ ed }: { ed: Editor }) {
  const { board, phaseIdx } = ed;
  const [who, setWho] = useState<string>(board.primaryTeamId);
  const [preset, setPreset] = useState(PRESETS[board.format][0].name);
  const [scope, setScope] = useState<'this' | 'all'>('this');
  const close = () => ed.setDialog(null);
  const teamIds = who === 'both' ? board.teams.map((t) => t.id) : [who];
  const target = ops.applyFormation(board, teamIds, preset, phaseIdx, scope === 'all');
  return (
    <Modal
      title="Apply formation"
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!target}
            onClick={() => {
              ed.commit(target, `apply ${preset}`);
              close();
            }}
          >
            Apply
          </button>
        </>
      }
    >
      <Segmented label="Team" value={who} options={[...board.teams.map((t) => ({ value: t.id, label: t.name })), { value: 'both', label: 'Both' }]} onChange={setWho} />
      <Segmented label="Formation" value={preset} options={PRESETS[board.format].map((p) => ({ value: p.name, label: p.name }))} onChange={setPreset} />
      <Segmented
        label="Scope"
        value={scope}
        options={[
          { value: 'this', label: 'This phase' },
          { value: 'all', label: 'All phases' },
        ]}
        onChange={setScope}
      />
      <div className="preview-thumb">
        <PhaseThumb board={target ?? board} index={phaseIdx} w={300} h={194} />
      </div>
      <p className="note">Preview of the result. Locked players and players without a matching spot stay where they are.</p>
    </Modal>
  );
}

// FRM-004 to FRM-008
export function FormatDialog({ ed, format }: { ed: Editor; format: Format }) {
  const { board } = ed;
  const plan = ops.planFormatChange(board, format);
  const [remove, setRemove] = useState<Set<string>>(() => new Set(plan.perTeam.flatMap((t) => t.removeDefault)));
  const [markings, setMarkings] = useState(true);
  const close = () => ed.setDialog({ kind: 'settings' });
  const down = FORMAT_SIZE[format] < FORMAT_SIZE[board.format];
  const tooMany = board.teams.some((t) => ops.teamPlayers(board, t.id).filter((p) => !remove.has(p.id)).length > teamLimit(format));
  const links = ops.playerLinks(board, [...remove]);
  return (
    <Modal
      title={`Change to ${format}`}
      onClose={close}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={tooMany}
            onClick={async () => {
              await addVersion(ed.boardRef.current, 'auto').catch(() => undefined); // FRM-007
              ed.commit(ops.changeFormat(ed.boardRef.current, format, [...remove], markings), `change format to ${format}`);
              ed.setDialog(null);
            }}
          >
            Confirm
          </button>
        </>
      }
    >
      {plan.perTeam.map((tp) => {
        const team = ops.teamById(board, tp.teamId);
        const players = ops.teamPlayers(board, tp.teamId);
        const removing = players.filter((p) => remove.has(p.id)).length;
        return (
          <section key={tp.teamId} className="group">
            <h3>{team.name}</h3>
            {down ? (
              <>
                <p>
                  Going to {format} removes {removing} {team.name} {removing === 1 ? 'player' : 'players'}. Choose who stays.
                </p>
                <div className="checks">
                  {players.map((p) => (
                    <label key={p.id} className={p.locked ? 'disabled' : ''}>
                      <input
                        type="checkbox"
                        checked={!remove.has(p.id)}
                        disabled={p.locked}
                        onChange={(e) => {
                          const next = new Set(remove);
                          if (e.target.checked) next.delete(p.id);
                          else next.add(p.id);
                          setRemove(next);
                        }}
                      />
                      {ops.playerLabel(p)} {p.role} {p.locked ? '(locked)' : ''}
                    </label>
                  ))}
                </div>
              </>
            ) : (
              <p>
                Adds {tp.add.length} {tp.add.length === 1 ? 'player' : 'players'} in the {tp.preset}: {tp.add.map((a) => `#${a.number} ${a.role}`).join(', ') || 'none'}. Existing players keep their positions in every phase.
              </p>
            )}
          </section>
        );
      })}
      {down && remove.size > 0 && (
        <p className="note">
          {links.lines} movement {links.lines === 1 ? 'line' : 'lines'} and {links.ballLinks} ball {links.ballLinks === 1 ? 'link' : 'links'} go with the removed players.
        </p>
      )}
      {tooMany && <p className="field-error">Each team can keep at most {teamLimit(format)} players in {format}.</p>}
      <Switch label={`Switch pitch markings to ${format}`} checked={markings} onChange={setMarkings} />
      <p className="note">The current board is saved as a version first. One undo brings it back.</p>
    </Modal>
  );
}

const timeLabel = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function VersionsDialog({ ed }: { ed: Editor }) {
  const [list, setList] = useState<VersionRecord[] | null>(null);
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<VersionRecord | null>(null);
  const [confirm, setConfirm] = useState<VersionRecord | null>(null);
  const boardId = ed.board.id;
  const refresh = () => void listVersions(boardId).then(setList);
  useEffect(refresh, [boardId]);
  const close = () => ed.setDialog(null);
  const restore = async (v: VersionRecord) => {
    const cur = ed.boardRef.current;
    await addVersion(cur, 'auto').catch(() => undefined); // PST-014
    ed.commit({ ...v.board, id: cur.id, revision: cur.revision + 1, updatedAt: new Date().toISOString() }, 'restore version');
    close();
  };
  return (
    <Modal title="Version history" onClose={close} wide>
      <div className="field row">
        <input value={name} maxLength={LEN.versionName} placeholder="Name this version" aria-label="Version name" onChange={(e) => setName(e.target.value)} />
        <button
          type="button"
          className="btn primary"
          disabled={!name.trim() || !!ed.readOnly}
          onClick={async () => {
            const done = await addVersion(ed.boardRef.current, 'named', name.trim());
            if (!done) ed.toast('20 named versions is the limit. Delete one first.');
            setName('');
            refresh();
          }}
        >
          Save version
        </button>
      </div>
      {list === null ? (
        <p className="note">Loading versions.</p>
      ) : list.length === 0 ? (
        <p className="note">No versions yet. PitchPlay keeps one when you start editing and every 10 minutes after that.</p>
      ) : (
        <ul className="versions">
          {list.map((v) => (
            <li key={v.id}>
              <div>
                <strong>{v.kind === 'named' ? v.name : 'Automatic'}</strong>
                <span>
                  {timeLabel(v.at)} · {v.board.phases.length} {v.board.phases.length === 1 ? 'phase' : 'phases'}
                </span>
              </div>
              <button type="button" className="btn small" onClick={() => setPreview(preview?.id === v.id ? null : v)}>
                {preview?.id === v.id ? 'Hide' : 'Preview'}
              </button>
              <button type="button" className="btn small" disabled={!!ed.readOnly} onClick={() => setConfirm(v)}>
                Restore
              </button>
              {v.kind === 'named' && (
                <button type="button" className="btn small danger-text" onClick={() => v.id !== undefined && void deleteVersion(v.id).then(refresh)}>
                  Delete
                </button>
              )}
              {preview?.id === v.id && (
                <div className="version-preview">
                  {v.board.phases.slice(0, 8).map((p, i) => (
                    <figure key={p.id}>
                      <PhaseThumb board={v.board} index={i} w={150} h={97} />
                      <figcaption>
                        {i + 1}. {p.name}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirm && (
        <Confirm
          title="Restore this version?"
          body={`The board goes back to ${timeLabel(confirm.at)}. Your current board is saved as a version first, and one undo brings it back.`}
          confirm="Restore"
          onConfirm={() => void restore(confirm)}
          onClose={() => setConfirm(null)}
        />
      )}
    </Modal>
  );
}

// PLY-024: every object on the canvas is reachable here (ACC-001).
export function ObjectsDialog({ ed }: { ed: Editor }) {
  const { board, phaseIdx, view, sel } = ed;
  const ph = board.phases[phaseIdx];
  const close = () => ed.setDialog(null);
  const pick = (ref: HitRef, at: { x: number; y: number } | null) => {
    ed.selectRef(ref);
    const cam = ed.camRef.current;
    if (cam && at && !isVisible(cam, at, 10)) ed.setView(centreOn(ed.viewRef.current, board, cam, at)); // PIT-009
    ed.setInspectorOpen(true);
    close();
  };
  return (
    <Modal title="Objects" onClose={close}>
      <button type="button" className="btn" onClick={() => ed.setDialog({ kind: 'roster' })}>
        Edit roster
      </button>
      {board.teams.map((t) => {
        const mode = teamMode(board, view.focus, t.id);
        return (
          <section key={t.id} className="group">
            <h3>
              {t.name} {mode !== 'show' && <span className="chip">{mode === 'ghost' ? 'ghost' : 'hidden'}</span>}
            </h3>
            <ul className="objects">
              {ops
                .teamPlayers(board, t.id)
                .sort((a, b) => a.number - b.number)
                .map((p) => (
                  <li key={p.id}>
                    <button type="button" disabled={mode !== 'show'} aria-pressed={sel.players.includes(p.id)} onClick={() => pick({ kind: 'player', id: p.id }, ph.tokens[p.id])}>
                      <b>#{p.number}</b> {p.name || 'No name'} <span>{p.role}</span>
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        );
      })}
      <section className="group">
        <h3>This phase</h3>
        <ul className="objects">
          <li>
            <button type="button" aria-pressed={sel.ball} onClick={() => pick({ kind: 'ball' }, ph.ball)}>
              <b>Ball</b> {ph.ball.visible ? '' : '(hidden)'}
            </button>
          </li>
          {ph.movements
            .filter((m) => !(m.subject.kind === 'ball' && m.type === 'carry'))
            .map((m) => (
              <li key={m.id}>
                <button type="button" aria-pressed={sel.movementId === m.id} onClick={() => pick({ kind: 'movement', id: m.id }, ops.tipOf(board, phaseIdx, m))}>
                  {describeHit(board, phaseIdx, { kind: 'movement', id: m.id })}
                </button>
              </li>
            ))}
          {ph.annotations.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                aria-pressed={sel.annotationId === a.id}
                onClick={() => pick({ kind: 'annotation', id: a.id, sub: a.kind }, a.kind === 'line' ? a.from : a.kind === 'zone' ? { x: a.x + a.w / 2, y: a.y + a.h / 2 } : a)}
              >
                {describeHit(board, phaseIdx, { kind: 'annotation', id: a.id, sub: a.kind })}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </Modal>
  );
}

export function RosterDialog({ ed }: { ed: Editor }) {
  const { board } = ed;
  const patch = (id: string, x: Parameters<typeof ops.updatePlayer>[2], label: string) => ed.commit(ops.updatePlayer(ed.boardRef.current, id, x), label);
  return (
    <Modal title="Edit roster" onClose={() => ed.setDialog({ kind: 'objects' })} wide>
      <fieldset disabled={!!ed.readOnly} className="plain">
        {board.teams.map((t) => (
          <section key={t.id} className="group">
            <h3>{t.name}</h3>
            <div className="roster-table">
              {ops
                .teamPlayers(board, t.id)
                .sort((a, b) => a.number - b.number)
                .map((p) => (
                  <div key={p.id} className="roster-row">
                    <TextField
                      label="No."
                      value={String(p.number)}
                      inputMode="numeric"
                      maxLength={3}
                      validate={(v) => (ops.validNumber(Number(v)) && /^\d+$/.test(v.trim()) ? null : 'Use a number from 1 to 99.')}
                      warn={ops.duplicateNumber(board, p.id, p.number) ? `${t.name} already has a #${p.number}` : null}
                      onCommit={(v) => patch(p.id, { number: Number(v) }, `renumber #${p.number}`)}
                    />
                    <TextField label="Name" value={p.name} maxLength={LEN.playerName} onCommit={(v) => patch(p.id, { name: v }, `rename #${p.number}`)} />
                    <TextField label="Role" value={p.role} maxLength={LEN.role} onCommit={(v) => patch(p.id, { role: v }, `edit #${p.number}`)} />
                  </div>
                ))}
            </div>
          </section>
        ))}
      </fieldset>
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  ['V, H, P', 'Select, Pan, Player'],
  ['R, S, C, X, A', 'Run, Pass, Carry, Shot, Arrow'],
  ['Z, T, E', 'Zone, Text, Erase'],
  ['Space + drag', 'Pan'],
  ['K', 'Play or pause'],
  ['[ and ]', 'Previous and next phase'],
  ['Ctrl/Cmd + Enter', 'Add phase'],
  ['Ctrl/Cmd + Z', 'Undo'],
  ['Ctrl/Cmd + Shift + Z, Ctrl + Y', 'Redo'],
  ['Delete, Backspace', 'Delete selection'],
  ['Arrow keys', 'Nudge 0.5 m (Shift: 2.5 m)'],
  ['Ctrl/Cmd + D', 'Duplicate selected player'],
  ['Ctrl/Cmd + A', 'Select all players and the ball'],
  ['Enter', 'Open inspector, or edit a selected label'],
  ['Escape', 'Close, cancel, then clear selection'],
  ['0, +, -', 'Fit view, zoom in, zoom out'],
  ['F', 'Present mode'],
  ['?', 'This list'],
];

export function ShortcutsDialog({ ed }: { ed: Editor }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={() => ed.setDialog(null)}>
      <dl className="shortcuts">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
