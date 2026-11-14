// Phase rail (PHS) and playback controls (TRN).
import { useEffect, useRef, useState } from 'react';
import type { Board } from '../domain/types';
import { LEN, SPEEDS, THUMB_REFRESH_MS } from '../domain/params';
import * as ops from '../domain/ops';
import { phaseStart, sceneAtPhase } from '../domain/playback';
import { FULL_REGION, camFor } from '../render/camera';
import { drawScene } from '../render/draw';
import { Icon, IconButton } from './kit';
import type { Editor } from './useEditor';

export function PhaseThumb({ board, index, w = 108, h = 70 }: { board: Board; index: number; w?: number; h?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const paint = () => {
      const c = ref.current;
      if (!c || !board.phases[index]) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = w * dpr;
      c.height = h * dpr;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      drawScene(ctx, { board, phaseIdx: index, scene: sceneAtPhase(board, index), cam: camFor(FULL_REGION, w, h, false), dpr, focus: 'both', showLines: true, editor: null, thumb: true });
    };
    if (first.current) {
      first.current = false;
      paint();
      return;
    }
    const t = setTimeout(paint, Math.min(250, THUMB_REFRESH_MS)); // PHS-010
    return () => clearTimeout(t);
  }, [board, index, w, h]);
  return <canvas ref={ref} style={{ width: w, height: h }} aria-hidden="true" />;
}

export function PhaseRail({ ed }: { ed: Editor }) {
  const { board, phaseIdx } = ed;
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameErr, setRenameErr] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const editable = !ed.readOnly;

  // PHS-001: the rail scrolls the selected card into view.
  useEffect(() => {
    railRef.current?.querySelector<HTMLElement>(`[data-phase="${phaseIdx}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [phaseIdx, board.phases.length]);

  const restructure = (res: ops.RestructureResult | null, label: string, selectIdx: number) => {
    if (!res) return;
    ed.stop();
    if (!ed.commit(res.board, label)) return;
    ed.setPhase(selectIdx);
    if (res.updated || res.removed) {
      // MOV-008
      const parts = [];
      if (res.updated) parts.push(`${res.updated} ${res.updated === 1 ? 'line' : 'lines'} updated`);
      if (res.removed) parts.push(`${res.removed} removed`);
      ed.toast(`${parts.join(', ')}.`, { label: 'Undo', run: () => ed.undo() });
    }
  };
  const move = (from: number, to: number) => {
    const res = ops.movePhase(ed.boardRef.current, from, to);
    // PHS-006: when lines will re-point or drop, show the counts before committing.
    if (res && (res.updated || res.removed)) ed.setDialog({ kind: 'reorder', from, to });
    else restructure(res, 'reorder phases', to);
  };

  const openMenu = (i: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const only = board.phases.length <= 1;
    const full = ops.phasesFull(board);
    ed.setMenu({
      x: r.left,
      y: r.top - 8,
      title: `Phase ${i + 1}: ${board.phases[i].name}`,
      items: [
        { label: 'Rename', run: () => setRenaming(i) },
        {
          label: 'Caption and timing',
          run: () => {
            ed.setPhase(i);
            ed.clearSel();
            ed.setInspectorOpen(true);
          },
        },
        {
          label: 'Add phase with drawings',
          disabled: full,
          hint: full ? '30 phases is the limit.' : undefined,
          run: () => {
            ed.setPhase(i);
            ed.addPhase(true);
          },
        },
        { label: 'Move left', disabled: i === 0, run: () => move(i, i - 1) },
        { label: 'Move right', disabled: i === ops.lastIdx(board), run: () => move(i, i + 1) },
        { label: 'Clear drawings', disabled: !ops.drawingCounts(board.phases[i]).total, run: () => ed.setDialog({ kind: 'clearDrawings', index: i }) },
        { label: 'Delete phase', danger: true, disabled: only, hint: only ? 'A board needs at least one phase.' : undefined, run: () => ed.setDialog({ kind: 'deletePhase', index: i }) },
      ],
    });
  };

  const commitRename = (i: number, value: string) => {
    if (!value.trim()) {
      setRenameErr(true); // PHS-004
      return;
    }
    ed.commit(ops.renamePhase(ed.boardRef.current, i, value), 'rename phase');
    setRenaming(null);
    setRenameErr(false);
  };

  const full = ops.phasesFull(board);
  return (
    <div className="phase-rail" ref={railRef} role="list" aria-label="Phases">
      {board.phases.map((ph, i) => (
        <div
          key={ph.id}
          role="listitem"
          data-phase={i}
          className={`phase-card ${i === phaseIdx ? 'current' : ''} ${dragFrom !== null && dragFrom !== i ? 'drop-ok' : ''}`}
          draggable={editable && renaming === null}
          onDragStart={(e) => {
            setDragFrom(i);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => dragFrom !== null && e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (dragFrom !== null && dragFrom !== i) move(dragFrom, i);
            setDragFrom(null);
          }}
          onDragEnd={() => setDragFrom(null)}
        >
          <button type="button" className="phase-pick" aria-current={i === phaseIdx ? 'true' : undefined} aria-label={`Phase ${i + 1} of ${board.phases.length}, ${ph.name}`} onClick={() => ed.setPhase(i)}>
            <PhaseThumb board={board} index={i} />
            <span className="phase-index">{i + 1}</span>
          </button>
          <div className="phase-meta">
            {renaming === i ? (
              <span className="phase-rename">
                <input
                  autoFocus
                  defaultValue={ph.name}
                  maxLength={LEN.phase}
                  aria-label="Phase name"
                  aria-invalid={renameErr}
                  onBlur={(e) => (e.target.value.trim() ? commitRename(i, e.target.value) : (setRenaming(null), setRenameErr(false)))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(i, (e.target as HTMLInputElement).value);
                    else if (e.key === 'Escape') {
                      setRenaming(null);
                      setRenameErr(false);
                      e.stopPropagation();
                    }
                  }}
                />
                {renameErr && (
                  <span className="field-error" role="alert">
                    A phase needs a name.
                  </span>
                )}
              </span>
            ) : (
              <span className="phase-name" title={ph.name} onDoubleClick={() => editable && setRenaming(i)}>
                {ph.name}
              </span>
            )}
            {editable && (
              <button type="button" className="phase-menu" aria-label={`Actions for phase ${i + 1}`} onClick={(e) => openMenu(i, e.currentTarget)}>
                <Icon name="more" size={18} />
              </button>
            )}
          </div>
        </div>
      ))}
      {editable && (
        <button type="button" className="phase-add" disabled={full} title={full ? '30 phases is the limit.' : 'Add phase (Ctrl+Enter)'} onClick={() => ed.addPhase(false)}>
          <Icon name="plus" />
          <span>Add phase</span>
        </button>
      )}
    </div>
  );
}

export function Playback({ ed, compact }: { ed: Editor; compact?: boolean }) {
  const { board, phaseIdx, timeline } = ed;
  const one = board.phases.length < 2;
  const value = ed.cursor ?? phaseStart(timeline, phaseIdx);
  const midway = ed.cursor !== null && !ed.playing;
  const settle = (el: HTMLInputElement) => ed.seek(Number(el.value), true);
  return (
    <div className={`playback ${compact ? 'compact' : ''}`} role="group" aria-label="Playback">
      <IconButton icon="restart" label="Restart" onClick={() => ed.setPhase(0)} disabled={one} />
      <IconButton icon="prev" label="Previous phase" kbd="[" onClick={() => ed.setPhase(phaseIdx - 1)} disabled={phaseIdx === 0} />
      <button
        type="button"
        className="play-btn"
        aria-label={ed.playing ? 'Pause' : 'Play'}
        title={one ? 'Add a phase to play a sequence.' : ed.playing ? 'Pause (K)' : 'Play (K)'}
        disabled={one}
        onClick={() => (ed.playing ? ed.pause() : ed.play())}
      >
        <Icon name={ed.playing ? 'pause' : 'play'} size={22} />
      </button>
      <IconButton icon="next" label="Next phase" kbd="]" onClick={() => ed.setPhase(phaseIdx + 1)} disabled={phaseIdx >= ops.lastIdx(board)} />
      <div className="scrub">
        <input
          type="range"
          aria-label="Timeline"
          min={0}
          max={Math.max(1, timeline.total)}
          step={10}
          value={Math.min(value, timeline.total)}
          disabled={one}
          onChange={(e) => ed.seek(Number(e.target.value), false)}
          onPointerUp={(e) => settle(e.currentTarget)}
          onKeyUp={(e) => settle(e.currentTarget)}
        />
        <div className="ticks" aria-hidden="true">
          {timeline.segs
            .filter((s) => s.kind === 'hold')
            .map((s) => (
              <span key={s.phase} className={s.phase === phaseIdx ? 'on' : ''} style={{ left: `${timeline.total ? (s.t0 / timeline.total) * 100 : 0}%` }} />
            ))}
        </div>
      </div>
      {midway && (
        <button type="button" className="btn small" onClick={() => ed.nearestPhase()}>
          Go to nearest phase
        </button>
      )}
      <label className="speed">
        <span className="sr-only">Speed</span>
        <select value={ed.speed} onChange={(e) => ed.setSpeed(Number(e.target.value))} aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
      </label>
      <IconButton
        icon="loop"
        label="Loop"
        pressed={board.settings.loop}
        onClick={() => ed.commit(ops.updateBoard(ed.boardRef.current, { settings: { loop: !board.settings.loop } }), 'toggle loop')}
        disabled={!!ed.readOnly}
      />
      {ed.reducedMotion && (
        <label className="motion-toggle">
          <input type="checkbox" checked={ed.fullMotion} onChange={(e) => ed.setFullMotion(e.target.checked)} /> Play animation
        </label>
      )}
    </div>
  );
}
