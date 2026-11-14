// Import (IMP). The file is validated into a temporary model; no stored board changes before a choice.
import { useEffect, useState } from 'react';
import type { Board } from '../domain/types';
import { teamPlayers } from '../domain/ops';
import { parseProject, type ParseResult } from '../domain/validate';
import { Modal } from './kit';

export function pickProjectFile(onFile: (f: File) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pitchplay,.json,application/json';
  input.onchange = () => input.files?.[0] && onFile(input.files[0]);
  input.click();
}

export function ImportDialog(props: { file: File; onClose: () => void; onOpenNew: (b: Board) => Promise<void> | void; onReplace?: (b: Board) => void }) {
  const [res, setRes] = useState<ParseResult | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      // PARAM-29: size is checked before the text is read.
      if (props.file.size > 2 * 1024 * 1024) return live && setRes({ ok: false, reason: 'too-large', problems: [] });
      const text = await props.file.text();
      if (live) setRes(parseProject(text, props.file.size));
    })();
    return () => {
      live = false;
    };
  }, [props.file]);

  if (!res) {
    return (
      <Modal title="Open file" onClose={props.onClose}>
        <p>Checking {props.file.name}.</p>
      </Modal>
    );
  }
  if (!res.ok) {
    const lead =
      res.reason === 'too-large'
        ? 'This file is larger than 2 MB, the limit. Your current board has not changed.'
        : res.reason === 'newer'
          ? 'This project was made with a newer PitchPlay format. Update PitchPlay or ask for an older export. Your current board has not changed.'
          : "This file can't be opened. Your current board has not changed.";
    return (
      <Modal
        title="Open file"
        onClose={props.onClose}
        footer={
          <button type="button" className="btn primary" data-autofocus onClick={props.onClose}>
            OK
          </button>
        }
      >
        <p role="alert">{lead}</p>
        {res.problems.length > 0 && (
          <ul className="problems">
            {res.problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
      </Modal>
    );
  }
  const b = res.board;
  const count = (kind: string) => b.phases.reduce((n, p) => n + p.annotations.filter((a) => a.kind === kind).length, 0);
  const lines = b.phases.reduce((n, p) => n + p.movements.length, 0) + count('line');
  const open = async () => {
    try {
      await props.onOpenNew(b);
    } catch {
      setFailed('The board could not be stored. Nothing was changed.'); // IMP-008
    }
  };
  return (
    <Modal
      title="Open file"
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          {props.onReplace &&
            (confirmReplace ? (
              <button type="button" className="btn danger" onClick={() => props.onReplace!(b)}>
                Yes, replace it
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => setConfirmReplace(true)}>
                Replace current board
              </button>
            ))}
          <button type="button" className="btn primary" data-autofocus onClick={() => void open()}>
            {failed ? 'Retry' : 'Open as new board'}
          </button>
        </>
      }
    >
      <dl className="summary">
        <div>
          <dt>File</dt>
          <dd>{props.file.name}</dd>
        </div>
        <div>
          <dt>Title</dt>
          <dd>{b.title}</dd>
        </div>
        <div>
          <dt>Format</dt>
          <dd>{b.format}</dd>
        </div>
        <div>
          <dt>Phases</dt>
          <dd>{b.phases.length}</dd>
        </div>
        <div>
          <dt>Players</dt>
          <dd>{b.teams.map((t) => `${t.name} ${teamPlayers(b, t.id).length}`).join(', ')}</dd>
        </div>
        <div>
          <dt>Drawings</dt>
          <dd>
            {plural(lines, 'line')}, {plural(count('zone'), 'zone')}, {plural(count('text'), 'label')}
          </dd>
        </div>
        <div>
          <dt>File format</dt>
          <dd>Version {b.schemaVersion}</dd>
        </div>
      </dl>
      {confirmReplace && <p className="warn-box">Replacing swaps the whole content of the board you have open. A version is saved first and one undo brings it back.</p>}
      {failed && (
        <p className="field-error" role="alert">
          {failed}
        </p>
      )}
    </Modal>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
