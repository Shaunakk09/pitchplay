// Inspector: edits for whatever is selected. Every drag on the canvas has an alternative here (INT-009).
import { useEffect, useRef, useState } from 'react';
import type { Annotation, LineAnn, Movement, MoveType, Player, TextAnn, ZoneAnn } from '../domain/types';
import { DURATION_MAX, DURATION_MIN, DURATION_STEP, LEN, NOTE_TOKENS, PITCH_H, PITCH_W, TIMING_STEP } from '../domain/params';
import * as ops from '../domain/ops';
import { metresReadout, selectionTitle } from '../domain/labels';
import { ballHiddenOnMove, passArrivesEarly } from '../domain/playback';
import { centreOn, isVisible } from '../render/camera';
import { teamMode } from '../render/draw';
import { NOTE_NAMES, noteHex } from '../render/themes';
import { Range, Segmented, Select, Swatches, Switch, TextField } from './kit';
import type { Editor } from './useEditor';

const cap = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`;

export function inspectorTitle(ed: Editor): string {
  const { board, sel, phaseIdx } = ed;
  const ph = board.phases[phaseIdx];
  const count = sel.players.length + (sel.ball ? 1 : 0);
  if (count > 1) return `${count} selected`;
  if (sel.players.length === 1) return selectionTitle(board, sel.players[0]);
  if (sel.ball) return 'Ball';
  if (sel.movementId) {
    const m = ph.movements.find((x) => x.id === sel.movementId);
    return m ? `${cap(m.type)} from ${ops.subjectName(board, m.subject)}` : 'Line';
  }
  if (sel.annotationId) {
    const a = ph.annotations.find((x) => x.id === sel.annotationId);
    return a ? (a.kind === 'line' ? `${cap(a.lineType)} line` : a.kind === 'zone' ? 'Zone' : 'Label') : 'Drawing';
  }
  return `Phase ${phaseIdx + 1}: ${ph.name}`;
}

export function Inspector({ ed }: { ed: Editor }) {
  const { board, sel, phaseIdx } = ed;
  const ph = board.phases[phaseIdx];
  const invalid = useRef<string | null>(null);
  const firstPhase = useRef(phaseIdx);

  // PLY-015: an invalid field reverts when the phase changes, with a hint.
  useEffect(() => {
    if (firstPhase.current !== phaseIdx && invalid.current) ed.toast('Not saved: number must be 1 to 99.');
    firstPhase.current = phaseIdx;
    invalid.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phaseIdx]);

  const count = sel.players.length + (sel.ball ? 1 : 0);
  let body: React.ReactNode;
  if (count > 1) body = <MultiPanel ed={ed} />;
  else if (sel.players.length === 1) {
    const p = ops.playerById(board, sel.players[0]);
    body = p ? <PlayerPanel key={`${p.id}-${phaseIdx}`} ed={ed} p={p} invalid={invalid} /> : null;
  } else if (sel.ball) body = <BallPanel ed={ed} />;
  else if (sel.movementId) {
    const m = ph.movements.find((x) => x.id === sel.movementId);
    body = m ? <MovementPanel key={m.id} ed={ed} m={m} /> : null;
  } else if (sel.annotationId) {
    const a = ph.annotations.find((x) => x.id === sel.annotationId);
    body = a ? <AnnotationPanel key={a.id} ed={ed} a={a} /> : null;
  } else body = <PhasePanel key={ph.id} ed={ed} />;

  return (
    <div className="inspector-body">
      {ed.readOnly && <p className="note">This tab is read-only.</p>}
      <fieldset disabled={!!ed.readOnly || ed.locked} className="plain">
        {body}
      </fieldset>
    </div>
  );
}

function OutsideView({ ed, at }: { ed: Editor; at: { x: number; y: number } }) {
  const cam = ed.camRef.current;
  if (!cam || isVisible(cam, at, 6)) return null;
  // PIT-008, PIT-009
  return (
    <div className="chip-row">
      <span className="chip warn">Outside view</span>
      <button type="button" className="btn small" onClick={() => ed.setView(centreOn(ed.viewRef.current, ed.boardRef.current, cam, at))}>
        Show
      </button>
    </div>
  );
}

function PlayerPanel({ ed, p, invalid }: { ed: Editor; p: Player; invalid: React.MutableRefObject<string | null> }) {
  const { board, phaseIdx } = ed;
  const ph = board.phases[phaseIdx];
  const at = ph.tokens[p.id];
  const patch = (x: Partial<Player>, label: string) => ed.commit(ops.updatePlayer(ed.boardRef.current, p.id, x), label);
  const tag = `#${p.number}`;
  const otherTeam = board.teams.find((t) => t.id !== p.teamId)!;
  return (
    <>
      <OutsideView ed={ed} at={at} />
      <div className="grid2">
        <TextField
          label="Number"
          value={String(p.number)}
          inputMode="numeric"
          maxLength={3}
          validate={(v) => (ops.validNumber(Number(v)) && /^\d+$/.test(v.trim()) ? null : 'Use a number from 1 to 99.')}
          warn={ops.duplicateNumber(board, p.id, p.number) ? `${ops.teamById(board, p.teamId).name} already has a #${p.number}` : null}
          onInvalidChange={(e) => (invalid.current = e)}
          onCommit={(v) => patch({ number: Number(v) }, `renumber ${tag}`)}
        />
        <TextField label="Role" value={p.role} maxLength={LEN.role} onCommit={(v) => patch({ role: v }, `edit ${tag}`)} />
      </div>
      <TextField label="Name" value={p.name} maxLength={LEN.playerName} onCommit={(v) => patch({ name: v }, `rename ${tag}`)} />
      <Select
        label="Team"
        value={p.teamId}
        options={board.teams.map((t) => ({ value: t.id, label: t.name, disabled: t.id !== p.teamId && ops.teamIsFull(board, t.id) }))}
        onChange={(v) => patch({ teamId: v }, `move ${tag} to ${otherTeam.name}`)}
      />
      <Switch label="Goalkeeper" checked={p.isGoalkeeper} onChange={(v) => patch({ isGoalkeeper: v }, `edit ${tag}`)} />
      <Switch label="Locked" checked={p.locked} onChange={(v) => patch({ locked: v }, `${v ? 'lock' : 'unlock'} ${tag}`)} />
      <p className="readout">{metresReadout(board, at).text}</p>
      <div className="actions">
        <button type="button" className="btn" disabled={p.locked} aria-pressed={ed.moveMode} onClick={() => ed.setMoveMode(!ed.moveMode)}>
          {ed.moveMode ? 'Tap a destination' : 'Move'}
        </button>
        <button type="button" className="btn" disabled={ph.ball.possessorId === p.id} onClick={() => ed.commit(ops.setPossession(ed.boardRef.current, phaseIdx, p.id), `give ball to ${tag}`)}>
          Give ball
        </button>
        <button
          type="button"
          className="btn"
          disabled={ops.teamIsFull(board, p.teamId)}
          onClick={() => {
            const r = ops.duplicatePlayer(ed.boardRef.current, p.id);
            if (r && ed.commit(r.board, `duplicate ${tag}`)) ed.selectRef({ kind: 'player', id: r.playerId });
          }}
        >
          Duplicate
        </button>
        <button type="button" className="btn danger-text" disabled={p.locked} onClick={() => ed.deleteRefs([{ kind: 'player', id: p.id }])}>
          Delete
        </button>
      </div>
    </>
  );
}

function MultiPanel({ ed }: { ed: Editor }) {
  const { sel } = ed;
  return (
    <>
      <p className="note">
        {sel.players.length} {sel.players.length === 1 ? 'player' : 'players'}
        {sel.ball ? ' and the ball' : ''}. Drag any of them, or use the arrow keys, to move the group.
      </p>
      <div className="actions">
        <button type="button" className="btn" aria-pressed={ed.moveMode} onClick={() => ed.setMoveMode(!ed.moveMode)}>
          {ed.moveMode ? 'Tap a destination' : 'Move'}
        </button>
        <button type="button" className="btn danger-text" disabled={!sel.players.length} onClick={() => ed.deleteSelection()}>
          Delete players
        </button>
      </div>
    </>
  );
}

function BallPanel({ ed }: { ed: Editor }) {
  const { board, phaseIdx, view } = ed;
  const ph = board.phases[phaseIdx];
  const options = [
    { value: '', label: 'None' },
    ...board.roster
      .filter((p) => teamMode(board, view.focus, p.teamId) !== 'hide')
      .map((p) => ({ value: p.id, label: `${ops.teamById(board, p.teamId).name} ${ops.playerLabel(p)}` })),
  ];
  return (
    <>
      <OutsideView ed={ed} at={ph.ball} />
      <Switch label="Visible in this phase" checked={ph.ball.visible} onChange={(v) => ed.commit(ops.setBallVisible(ed.boardRef.current, phaseIdx, v), v ? 'show ball' : 'hide ball')} />
      <Select label="Possession" value={ph.ball.possessorId ?? ''} options={options} onChange={(v) => ed.commit(ops.setPossession(ed.boardRef.current, phaseIdx, v || null), 'change possession')} />
      <p className="readout">{metresReadout(board, ph.ball).text}</p>
      <div className="actions">
        <button type="button" className="btn" aria-pressed={ed.moveMode} onClick={() => ed.setMoveMode(!ed.moveMode)}>
          {ed.moveMode ? 'Tap a destination' : 'Move'}
        </button>
      </div>
      <p className="note">Drop the ball on a player to give them possession. Draw a pass or a shot from the ball.</p>
    </>
  );
}

function MovementPanel({ ed, m }: { ed: Editor; m: Movement }) {
  const { board, phaseIdx } = ed;
  const ph = board.phases[phaseIdx];
  const upd = (patch: ops.MovementPatch, label: string) => ed.commit(ops.updateMovement(ed.boardRef.current, phaseIdx, m.id, patch), label);
  const isBall = m.subject.kind === 'ball';
  const playerId = m.subject.kind === 'player' ? m.subject.playerId : null;
  const hasBall = playerId !== null && ph.ball.possessorId === playerId;
  // LIN-009: only the types allowed for the subject.
  const types: { value: MoveType; label: string; disabled?: boolean; title?: string }[] = isBall
    ? m.type === 'carry'
      ? [{ value: 'carry', label: 'Carry' }]
      : [
          { value: 'pass', label: 'Pass' },
          { value: 'shot', label: 'Shot' },
        ]
    : [
        { value: 'run', label: 'Run' },
        { value: 'carry', label: 'Carry', disabled: !hasBall && m.type !== 'carry', title: hasBall ? undefined : 'Give this player the ball first' },
      ];
  const receiver = m.receiverId ? ops.playerById(board, m.receiverId) : null;
  const subjectPlayer = playerId ? ops.playerById(board, playerId) : null;
  const early = passArrivesEarly(ph, m);
  const hidden = ballHiddenOnMove(board, phaseIdx, m);
  return (
    <>
      <Segmented label="Type" value={m.type} options={types} onChange={(v) => upd({ type: v }, `change line to ${v}`)} />
      <TextField label="Label" value={m.label} maxLength={LEN.lineLabel} placeholder="Cross, 1-2 ..." onCommit={(v) => upd({ label: v }, 'label line')} />
      {m.type === 'pass' && (
        <div className="field row">
          <span className="field-label">Receiver: {receiver ? ops.playerLabel(receiver) : 'none'}</span>
          {receiver && (
            <button type="button" className="btn small" onClick={() => ed.commit(ops.unlinkReceiver(ed.boardRef.current, phaseIdx, m.id), 'unlink receiver')}>
              Unlink receiver
            </button>
          )}
        </div>
      )}
      {early && receiver && (
        <p className="warn-box" role="status">
          Ball arrives before #{receiver.number} does.
        </p>
      )}
      {hidden && (
        <p className="warn-box" role="status">
          The ball is hidden at the start or end of this {m.type}.
        </p>
      )}
      <Range label="Curve" value={m.bend} min={-1} max={1} step={0.05} format={(v) => v.toFixed(2)} onCommit={(v) => upd({ bend: v }, 'bend line')} />
      <div className="grid2">
        <Range label="Starts at" value={m.start} min={0} max={0.9} step={TIMING_STEP} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => upd({ start: v }, 'change timing')} />
        <Range label="Ends at" value={m.end} min={0.1} max={1} step={TIMING_STEP} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => upd({ end: v }, 'change timing')} />
      </div>
      <p className="note">Timing is a share of this phase's transition ({(ph.transition.durationMs / 1000).toFixed(2)} s).</p>
      <div className="actions">
        <button type="button" className="btn danger-text" onClick={() => ed.commit(ops.deleteMovement(ed.boardRef.current, phaseIdx, m.id), 'delete line')}>
          Delete line
        </button>
        {phaseIdx < ops.lastIdx(board) && (
          <button type="button" className="btn danger-text" onClick={() => ed.commit(ops.deleteMovement(ed.boardRef.current, phaseIdx, m.id, true), 'delete line')}>
            Delete line and keep {subjectPlayer ? `#${subjectPlayer.number}` : 'the ball'} in place
          </button>
        )}
      </div>
    </>
  );
}

function colorOptions(theme: Parameters<typeof noteHex>[1]) {
  return NOTE_TOKENS.map((t) => ({ value: t, hex: noteHex(t, theme), name: NOTE_NAMES[t] }));
}

function AnnotationPanel({ ed, a }: { ed: Editor; a: Annotation }) {
  const { board, phaseIdx } = ed;
  const upd = (patch: Partial<Annotation>, label: string) => ed.commit(ops.updateAnnotation(ed.boardRef.current, phaseIdx, a.id, patch), label);
  const del = (
    <button type="button" className="btn danger-text" onClick={() => ed.commit(ops.deleteAnnotation(ed.boardRef.current, phaseIdx, a.id), 'delete drawing')}>
      Delete
    </button>
  );
  if (a.kind === 'line') {
    const l = a as LineAnn;
    return (
      <>
        <p className="note">A static {l.lineType} line. It explains; it never moves a player or the ball.</p>
        <TextField label="Label" value={l.label} maxLength={LEN.lineLabel} onCommit={(v) => upd({ label: v }, 'label line')} />
        <Swatches label="Color" value={l.color} options={colorOptions(board.pitchTheme)} onChange={(v) => upd({ color: v }, 'color line')} />
        <Range label="Curve" value={l.bend} min={-1} max={1} step={0.05} format={(v) => v.toFixed(2)} onCommit={(v) => upd({ bend: v }, 'bend line')} />
        <div className="actions">{del}</div>
      </>
    );
  }
  if (a.kind === 'zone') {
    const z = a as ZoneAnn;
    const metre = (label: string, key: 'x' | 'y' | 'w' | 'h', max: number) => (
      <TextField
        label={`${label} (m)`}
        value={(z[key] / 10).toFixed(1)}
        inputMode="numeric"
        validate={(v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= max / 10 ? null : `Use 0 to ${max / 10}.`)}
        onCommit={(v) => upd({ [key]: Number(v) * 10 } as Partial<ZoneAnn>, 'resize zone')}
      />
    );
    return (
      <>
        <Segmented
          label="Shape"
          value={z.shape}
          options={[
            { value: 'rect', label: 'Rectangle' },
            { value: 'ellipse', label: 'Ellipse' },
          ]}
          onChange={(v) => upd({ shape: v }, 'change zone shape')}
        />
        <Swatches label="Fill" value={z.fill} options={colorOptions(board.pitchTheme)} onChange={(v) => upd({ fill: v }, 'color zone')} />
        <Range label="Opacity" value={z.opacity} min={0.1} max={0.5} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => upd({ opacity: v }, 'change zone opacity')} />
        <Segmented
          label="Outline"
          value={z.outline}
          options={[
            { value: 'dashed', label: 'Dashed' },
            { value: 'solid', label: 'Solid' },
            { value: 'none', label: 'None' },
          ]}
          onChange={(v) => upd({ outline: v }, 'change zone outline')}
        />
        <TextField label="Label" value={z.label} maxLength={LEN.lineLabel} onCommit={(v) => upd({ label: v }, 'label zone')} />
        <div className="grid2">
          {metre('From goal line', 'x', PITCH_W)}
          {metre('From touchline', 'y', PITCH_H)}
          {metre('Length', 'w', PITCH_W)}
          {metre('Width', 'h', PITCH_H)}
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={() => ed.commit(ops.reorderAnnotation(ed.boardRef.current, phaseIdx, a.id, 'front'), 'bring zone to front')}>
            Bring to front
          </button>
          <button type="button" className="btn" onClick={() => ed.commit(ops.reorderAnnotation(ed.boardRef.current, phaseIdx, a.id, 'back'), 'send zone to back')}>
            Send to back
          </button>
          {del}
        </div>
      </>
    );
  }
  const t = a as TextAnn;
  return (
    <>
      <div className="field">
        <span className="field-label">Text</span>
        <p className="text-preview">{t.text}</p>
        <button type="button" className="btn small" onClick={() => ed.setTextEdit({ id: t.id, at: { x: t.x, y: t.y }, text: t.text })}>
          Edit text
        </button>
      </div>
      <Segmented
        label="Size"
        value={t.size}
        options={[
          { value: 's', label: 'S' },
          { value: 'm', label: 'M' },
          { value: 'l', label: 'L' },
        ]}
        onChange={(v) => upd({ size: v }, 'resize label')}
      />
      <Swatches label="Color" value={t.color} options={colorOptions(board.pitchTheme)} onChange={(v) => upd({ color: v }, 'color label')} />
      <Switch label="Background" checked={t.background} onChange={(v) => upd({ background: v }, 'change label background')} />
      <Segmented
        label="Align"
        value={t.align}
        options={[
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Centre' },
        ]}
        onChange={(v) => upd({ align: v }, 'align label')}
      />
      <div className="actions">{del}</div>
    </>
  );
}

// TRN-013: one lane per movement, a bar from start to end, both ends draggable in 0.05 steps.
function Lane({ ed, m }: { ed: Editor; m: Movement }) {
  const { board, phaseIdx } = ed;
  const ph = board.phases[phaseIdx];
  const [s, setS] = useState(m.start);
  const [e, setE] = useState(m.end);
  useEffect(() => {
    setS(m.start);
    setE(m.end);
  }, [m.start, m.end]);
  const snap = (v: number) => Math.round(v / TIMING_STEP) * TIMING_STEP;
  const commit = () => {
    if (s !== m.start || e !== m.end) ed.commit(ops.updateMovement(ed.boardRef.current, phaseIdx, m.id, { start: s, end: e }), 'change timing');
  };
  const name = `${cap(m.type)} ${ops.subjectName(board, m.subject)}`;
  const early = passArrivesEarly(ph, m);
  const receiver = m.receiverId ? ops.playerById(board, m.receiverId) : null;
  return (
    <div className="lane">
      <button type="button" className="lane-name" title="Select this line" onClick={() => ed.selectRef({ kind: 'movement', id: m.id })}>
        {name}
      </button>
      <span className="lane-val">
        {Math.round(s * 100)} to {Math.round(e * 100)}%
      </span>
      <div className="lane-track">
        <span className={`lane-bar ${early ? 'warn' : ''}`} style={{ left: `${s * 100}%`, width: `${(e - s) * 100}%` }} />
        <input
          type="range"
          className="lane-thumb"
          aria-label={`${name} starts at`}
          min={0}
          max={1}
          step={TIMING_STEP}
          value={s}
          onChange={(ev) => setS(Math.min(snap(Number(ev.target.value)), snap(e - 0.1)))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <input
          type="range"
          className="lane-thumb"
          aria-label={`${name} ends at`}
          min={0}
          max={1}
          step={TIMING_STEP}
          value={e}
          onChange={(ev) => setE(Math.max(snap(Number(ev.target.value)), snap(s + 0.1)))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
      </div>
      {early && receiver && (
        <span className="lane-warn" role="status">
          Ball arrives before #{receiver.number} does.
        </span>
      )}
    </div>
  );
}

function PhasePanel({ ed }: { ed: Editor }) {
  const { board, phaseIdx } = ed;
  const ph = board.phases[phaseIdx];
  const last = phaseIdx === ops.lastIdx(board);
  return (
    <>
      <TextField
        label="Phase name"
        value={ph.name}
        maxLength={LEN.phase}
        validate={(v) => (v.trim() ? null : 'A phase needs a name.')}
        onCommit={(v) => ed.commit(ops.renamePhase(ed.boardRef.current, phaseIdx, v), 'rename phase')}
      />
      <TextField label="Caption" value={ph.caption} maxLength={LEN.caption} multiline placeholder="Shown in present mode and exports" onCommit={(v) => ed.commit(ops.setCaption(ed.boardRef.current, phaseIdx, v), 'edit caption')} />
      {!last && (
        <>
          <Range
            label="Transition to the next phase"
            value={ph.transition.durationMs}
            min={DURATION_MIN}
            max={DURATION_MAX}
            step={DURATION_STEP}
            format={(v) => `${(v / 1000).toFixed(2)} s`}
            onCommit={(v) => ed.commit(ops.setTransition(ed.boardRef.current, phaseIdx, { durationMs: v }), 'change transition')}
          />
          <Segmented
            label="Easing"
            value={ph.transition.easing}
            options={[
              { value: 'easeInOut', label: 'Ease in-out' },
              { value: 'linear', label: 'Linear' },
            ]}
            onChange={(v) => ed.commit(ops.setTransition(ed.boardRef.current, phaseIdx, { easing: v }), 'change easing')}
          />
        </>
      )}
      {ph.movements.length > 0 && !last && (
        <div className="field">
          <span className="field-label">Movement timing</span>
          <div className="lanes">
            {ph.movements
              .filter((m) => !(m.subject.kind === 'ball' && m.type === 'carry'))
              .map((m) => (
                <Lane key={m.id} ed={ed} m={m} />
              ))}
          </div>
          <p className="note">Drag the ends of a bar to set when each movement starts and ends inside the transition.</p>
        </div>
      )}
      <p className="note">Nothing is selected. Tap a player, the ball or a drawing to edit it.</p>
    </>
  );
}
