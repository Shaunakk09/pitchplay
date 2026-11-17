// Export sheet (EXP-001 to EXP-017). Exports read the in-memory board and never change it or its save status.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Board } from '../domain/types';
import { VIDEO_MAX_MS } from '../domain/params';
import * as ops from '../domain/ops';
import { serializeProject } from '../domain/validate';
import { lineTypesUsed } from '../render/draw';
import { Cancelled, animationLength, canShareFiles, exportGif, exportImage, exportStoryboard, exportVideo, exportZip, pickVideoMime, renderPhaseCanvas, shareFile, type AnimOpts, type FrameOpts } from '../export/render';
import { Modal, Segmented, Select, Switch, download, safeName } from './kit';
import { devicePref, setDevicePref, type Editor } from './useEditor';
import { trackEvent } from '../store/analytics';

type Kind = 'image' | 'storyboard' | 'zip' | 'video' | 'gif' | 'project';
const KINDS: { value: Kind; label: string }[] = [
  { value: 'image', label: 'Image' },
  { value: 'storyboard', label: 'Storyboard' },
  { value: 'zip', label: 'Images (ZIP)' },
  { value: 'video', label: 'Video' },
  { value: 'gif', label: 'GIF' },
  { value: 'project', label: 'Project file' },
];
const ASPECTS: Record<string, [number, number]> = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350] };

interface Saved {
  kind: Kind;
  area: 'view' | 'whole';
  title: boolean;
  phaseName: boolean;
  caption: boolean;
  twoX: boolean;
  aspect: string;
  titleCard: boolean;
  gifWidth: number;
}
const DEFAULTS: Saved = { kind: 'image', area: 'whole', title: true, phaseName: true, caption: true, twoX: false, aspect: '16:9', titleCard: false, gifWidth: 720 };

const pad2 = (n: number) => String(n).padStart(2, '0');

export function projectBlob(board: Board): Blob {
  return new Blob([serializeProject(board)], { type: 'application/json' });
}

export function ExportSheet({ ed }: { ed: Editor }) {
  // EXP-002, EXP-009: the export uses the revision current when the sheet opened it.
  const board = ed.board;
  const view = ed.view;
  const cam = ed.camRef.current;
  const last = ops.lastIdx(board);
  const saved = useMemo(() => ({ ...DEFAULTS, ...devicePref<Partial<Saved>>('export', {}) }), []);
  const [kind, setKind] = useState<Kind>(saved.kind);
  const [area, setArea] = useState(saved.area);
  const [bothTeams, setBothTeams] = useState(false);
  const [portrait, setPortrait] = useState(cam?.portrait ?? false);
  const [title, setTitle] = useState(saved.title);
  const [phaseName, setPhaseName] = useState(saved.phaseName);
  const [caption, setCaption] = useState(saved.caption);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(last);
  const usedTypes = lineTypesUsed(board, Array.from({ length: board.phases.length }, (_, k) => k));
  const [legend, setLegend] = useState(usedTypes.length >= 2);
  const [mark, setMark] = useState(board.settings.exportMark);
  const [twoX, setTwoX] = useState(saved.twoX);
  const [aspect, setAspect] = useState(saved.aspect);
  const [speed, setSpeed] = useState(1);
  const [holdMs, setHoldMs] = useState(board.settings.holdMs);
  const [titleCard, setTitleCard] = useState(saved.titleCard);
  const [gifWidth, setGifWidth] = useState(saved.gifWidth);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; name: string; seconds: number } | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const save = async (blob: Blob, name: string) => {
    setSaveNote(null);
    const out = await download(blob, name);
    if (out === 'declined') setSaveNote('Not saved. Use Download to try again.');
    else if (out === 'unavailable') setSaveNote('Saving files is not available in this view. Open PitchPlay in its own tab to download.');
  };
  const [previewUrl, setPreviewUrl] = useState('');
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    setDevicePref('export', { kind, area, title, phaseName, caption, twoX, aspect, titleCard, gifWidth } satisfies Saved); // EXP-001
  }, [kind, area, title, phaseName, caption, twoX, aspect, titleCard, gifWidth]);
  useEffect(() => () => abort.current?.abort(), []);

  const screenAspect = cam ? cam.W / cam.H : null;
  const frame: FrameOpts = { area, bothTeams: bothTeams || view.focus === 'both', portrait, title, phaseName, caption, legend, mark, showLines: true };
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const animated = kind === 'video' || kind === 'gif';
  const [vw, vh] = ASPECTS[aspect];
  const gifH = Math.round((gifWidth * vh) / vw / 2) * 2;
  const anim: AnimOpts = { ...frame, from: lo, to: hi, speed, holdMs, titleCard, W: kind === 'gif' ? gifWidth : vw, H: kind === 'gif' ? gifH : vh };
  const lengthMs = animationLength(board, anim);
  const seconds = Math.round(lengthMs / 1000);
  const videoMime = pickVideoMime();
  const gifMb = (Math.ceil((lengthMs / 1000) * 15) * gifWidth * gifH * 0.09) / 1e6;

  let blocked: string | null = null;
  if (kind === 'gif' && lengthMs > 30000) blocked = 'GIFs can be up to 30 seconds. Shorten the range or raise the speed.'; // EXP-012
  else if (kind === 'video' && lengthMs > VIDEO_MAX_MS) blocked = 'Videos can be up to 3 minutes. Shorten the range or raise the speed.'; // EXP-013
  else if (kind === 'video' && !videoMime) blocked = 'This browser cannot record video. Make a GIF instead.'; // EXP-010
  else if (animated && hi === lo) blocked = 'Pick a range of at least two phases to animate.';

  // EXP-005: live preview of the image.
  useEffect(() => {
    if (kind !== 'image' && kind !== 'zip') return;
    const t = setTimeout(() => {
      try {
        setPreviewUrl(renderPhaseCanvas(board, view, frame, ed.phaseIdx, 720, screenAspect).toDataURL('image/png'));
      } catch {
        setPreviewUrl('');
      }
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, area, bothTeams, portrait, title, phaseName, caption, legend, mark, board, ed.phaseIdx]);

  const base = safeName(board.title);
  const run = async () => {
    setError(null);
    setResult(null);
    setBusy(0);
    const t0 = performance.now();
    abort.current = new AbortController();
    try {
      let blob: Blob;
      let name: string;
      if (kind === 'project') {
        blob = projectBlob(board);
        name = `${base}.pitchplay`; // EXP-016 (saved as .pitchplay.json inside a claude.ai page)
      } else if (kind === 'image') {
        blob = await exportImage(board, view, frame, ed.phaseIdx, twoX, screenAspect);
        name = `${base}-${pad2(ed.phaseIdx + 1)}-${safeName(board.phases[ed.phaseIdx].name)}.png`;
      } else if (kind === 'storyboard') {
        blob = await exportStoryboard(board, view, frame, lo, hi, screenAspect);
        name = `${base}-storyboard.png`;
      } else if (kind === 'zip') {
        blob = await exportZip(board, view, frame, lo, hi, screenAspect, (i) => `${base}-${pad2(i + 1)}-${safeName(board.phases[i].name)}.png`);
        name = `${base}-images.zip`;
      } else if (kind === 'video') {
        const r = await exportVideo(board, view, anim, setBusy, abort.current.signal);
        blob = r.blob;
        name = `${base}.${r.ext}`;
      } else {
        blob = await exportGif(board, view, anim, setBusy, abort.current.signal);
        name = `${base}.gif`;
      }
      const secs = (performance.now() - t0) / 1000;
      setResult({ blob, name, seconds: secs });
      trackEvent('export_completed','editor',kind);
      ed.announce(`Export ready: ${name}`);
      if (!canShareFiles()) void save(blob, name); // EXP-015: Download is always available
    } catch (e) {
      if (!(e instanceof Cancelled)) {
        const cause = e instanceof Error ? e.message : 'unknown cause';
        setError(`Export failed: ${cause}. Your board is unchanged.`); // EXP-017
        ed.announce('Export failed');
      }
    } finally {
      setBusy(null);
    }
  };

  const phaseOptions = board.phases.map((p, i) => ({ value: String(i), label: `${i + 1}. ${p.name}` }));
  return (
    <Modal
      title="Export"
      onClose={() => ed.setDialog(null)}
      wide
      footer={
        busy !== null ? (
          <>
            <div className="progress" role="progressbar" aria-valuenow={Math.round(busy * 100)} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${Math.round(busy * 100)}%` }} />
              <em>{Math.round(busy * 100)}%</em>
            </div>
            <button type="button" className="btn" onClick={() => abort.current?.abort()} disabled={!animated}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={() => ed.setDialog(null)}>
              Close
            </button>
            <button type="button" className="btn primary" disabled={!!blocked} onClick={() => void run()}>
              {error ? 'Retry' : kind === 'project' ? 'Export project file' : `Export ${KINDS.find((k) => k.value === kind)!.label.toLowerCase()}`}
            </button>
          </>
        )
      }
    >
      <Segmented label="Type" value={kind} options={KINDS} onChange={(k) => (setKind(k), setResult(null), setError(null))} />
      {kind === 'project' ? (
        <p className="note">An editable .pitchplay file with both teams, every player, phase, line and drawing. Open it on any device with "Open file".</p>
      ) : (
        <div className="export-grid">
          <div>
            <Segmented
              label="Area"
              value={area}
              options={[
                { value: 'whole', label: 'Whole pitch' },
                { value: 'view', label: 'Current view' },
              ]}
              onChange={setArea}
            />
            <Segmented
              label="Pitch orientation"
              value={portrait ? 'portrait' : 'landscape'}
              options={[
                { value: 'landscape', label: 'Landscape' },
                { value: 'portrait', label: 'Portrait' },
              ]}
              onChange={(v) => setPortrait(v === 'portrait')}
            />
            {view.focus !== 'both' && <Switch label="Both teams" checked={bothTeams} onChange={setBothTeams} />}
            {(kind === 'storyboard' || kind === 'zip' || animated) && (
              <div className="grid2">
                <Select label="From" value={String(from)} options={phaseOptions} onChange={(v) => setFrom(Number(v))} />
                <Select label="To" value={String(to)} options={phaseOptions} onChange={(v) => setTo(Number(v))} />
              </div>
            )}
            {animated && (
              <>
                <Segmented label="Aspect" value={aspect} options={Object.keys(ASPECTS).map((a) => ({ value: a, label: a }))} onChange={setAspect} />
                <div className="grid2">
                  <Select label="Speed" value={String(speed)} options={['0.5', '1', '1.5', '2'].map((s) => ({ value: s, label: `${s}x` }))} onChange={(v) => setSpeed(Number(v))} />
                  <Select label="Hold per phase" value={String(holdMs)} options={[0, 200, 400, 800, 1200, 2000, 3000].concat([board.settings.holdMs]).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b).map((h) => ({ value: String(h), label: `${(h / 1000).toFixed(1)} s` }))} onChange={(v) => setHoldMs(Number(v))} />
                </div>
                {kind === 'gif' && <Select label="Width" value={String(gifWidth)} options={[480, 600, 720, 960].map((w) => ({ value: String(w), label: `${w} px` }))} onChange={(v) => setGifWidth(Number(v))} />}
                <Switch label="Title card (1.5 s)" checked={titleCard} onChange={setTitleCard} />
              </>
            )}
            {kind === 'image' && <Switch label="Double size (3840 px)" checked={twoX} onChange={setTwoX} />}
          </div>
          <div>
            <Switch label="Title" checked={title} onChange={setTitle} />
            {kind !== 'storyboard' && <Switch label="Phase name" checked={phaseName} onChange={setPhaseName} />}
            <Switch label="Caption" checked={caption} onChange={setCaption} />
            <Switch label="Legend" checked={legend} onChange={setLegend} />
            <Switch label={'"Made with PitchPlay" mark'} checked={mark} onChange={setMark} />
            {(kind === 'image' || kind === 'zip') && previewUrl && <img className="export-preview" src={previewUrl} alt="Preview of the exported image" />}
            {animated && !blocked && (
              <p className="note">
                {kind === 'video'
                  ? `${anim.W} by ${anim.H}, 30 fps, about ${seconds} s. Recording takes as long as the animation: about ${seconds} s. Keep this tab in front while it records.`
                  : `${anim.W} by ${anim.H}, 15 fps, about ${seconds} s and ${gifMb.toFixed(1)} MB.`}
              </p>
            )}
            {kind === 'gif' && !blocked && gifMb > 15 && <p className="warn-box">This GIF may be larger than 15 MB. A smaller width or a shorter range keeps it easy to share.</p>}
          </div>
        </div>
      )}
      {blocked && (
        <p className="field-error" role="alert">
          {blocked}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="export-result" role="status">
          <span>
            Ready: <b>{result.name}</b> ({(result.blob.size / 1e6).toFixed(2)} MB, {result.seconds.toFixed(1)} s)
          </span>
          <button type="button" className="btn" onClick={() => void save(result.blob, result.name)}>
            Download
          </button>
          {canShareFiles() && (
            <button type="button" className="btn primary" onClick={() => void shareFile(result.blob, result.name)}>
              Share
            </button>
          )}
          {saveNote && <span className="note">{saveNote}</span>}
        </div>
      )}
    </Modal>
  );
}
