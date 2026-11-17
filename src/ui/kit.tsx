// Small shared UI pieces: icons, modal, menu, fields.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { saveFile, type SaveOutcome } from '../host';

const ICONS: Record<string, string> = {
  back: 'M15 5l-7 7 7 7',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M8 5v14M16 5v14',
  prev: 'M18 5v14l-9-7zM6 5v14',
  next: 'M6 5v14l9-7zM18 5v14',
  restart: 'M4 4v6h6M4.5 15a8 8 0 101.6-8.3L4 10',
  loop: 'M17 2l4 4-4 4M3 11V9a3 3 0 013-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 01-3 3H3',
  plus: 'M12 5v14M5 12h14',
  select: 'M5 3l14 8-6 2-2 6z',
  player: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  run: 'M4 18h2M9 15l2-2M14 10l2-2M15 5h5v5',
  pass: 'M4 20L20 4M12 4h8v8',
  carry: 'M3 19c2-3 3 1 5-2s3 1 5-2 3 1 5-2M15 5h5v5',
  shot: 'M4 20L15 9M10 6h8v8M19 5m-2 0a2 2 0 104 0 2 2 0 10-4 0',
  arrow: 'M5 19L19 5M11 5h8v8',
  zone: 'M4 6h16v12H4z',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  erase: 'M4 16l9-9 6 6-6 6H8zM13 7l6 6M3 20h18',
  pan: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3',
  present: 'M3 5h18v11H3zM8 21h8M12 16v5',
  export: 'M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4',
  close: 'M6 6l12 12M18 6L6 18',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 018 0v3',
  ball: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 8l4 3-1.5 4.5h-5L8 11z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  help: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9a2.5 2.5 0 114 2c-1 .7-1.5 1.2-1.5 2.5M12 17h.01',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  check: 'M5 12l5 5 9-10',
  share: 'M18 8a3 3 0 100-6 3 3 0 000 6zM6 15a3 3 0 100-6 3 3 0 000 6zM18 22a3 3 0 100-6 3 3 0 000 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  formation: 'M12 5m-2 0a2 2 0 104 0 2 2 0 10-4 0M5 13m-2 0a2 2 0 104 0 2 2 0 10-4 0M19 13m-2 0a2 2 0 104 0 2 2 0 10-4 0M12 19m-2 0a2 2 0 104 0 2 2 0 10-4 0',
  timing: 'M4 7h9M4 12h14M9 17h11',
  chart: 'M3 3v18h18M7 17v-5M12 17V8M17 17V5',
};

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name] ?? ''} />
    </svg>
  );
}

export function IconButton(props: { icon: string; label: string; onClick?: () => void; disabled?: boolean; pressed?: boolean; title?: string; className?: string; kbd?: string }) {
  return (
    <button
      type="button"
      className={`iconbtn ${props.className ?? ''}`}
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={props.title ?? (props.kbd ? `${props.label} (${props.kbd})` : props.label)}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
    </button>
  );
}

function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus], button, input, select, textarea, [tabindex]');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select, textarea, [tabindex="0"]')];
        if (!items.length) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          items[items.length - 1].focus();
        } else if (!e.shiftKey && i === items.length - 1) {
          e.preventDefault();
          items[0].focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return ref;
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; sheet?: boolean; className?: string }) {
  const ref = useFocusTrap(true, props.onClose);
  const id = useId();
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div ref={ref} className={`modal ${props.wide ? 'wide' : ''} ${props.sheet ? 'as-sheet' : ''} ${props.className ?? ''}`} role="dialog" aria-modal="true" aria-labelledby={id}>
        <header className="modal-head">
          <h2 id={id}>{props.title}</h2>
          <IconButton icon="close" label="Close" onClick={props.onClose} />
        </header>
        <div className="modal-body">{props.children}</div>
        {props.footer && <footer className="modal-foot">{props.footer}</footer>}
      </div>
    </div>
  );
}

export function Confirm(props: { title: string; body: ReactNode; confirm: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${props.danger ? 'danger' : 'primary'}`}
            data-autofocus
            onClick={() => {
              props.onConfirm();
              props.onClose();
            }}
          >
            {props.confirm}
          </button>
        </>
      }
    >
      <p>{props.body}</p>
    </Modal>
  );
}

export interface MenuItem {
  label: string;
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}
export interface MenuState {
  x: number;
  y: number;
  title?: string;
  items: MenuItem[];
  onDismiss?: () => void;
}

// Chooser, quick actions and context menus (INT-012, PLY-013). Works with touch and keyboard.
export function Menu({ menu, onClose }: { menu: MenuState; onClose: (picked: boolean) => void }) {
  const ref = useFocusTrap(true, () => onClose(false));
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);
  return (
    <div className="menu-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose(false)}>
      <div ref={ref} className="menu" role="menu" style={pos} aria-label={menu.title ?? 'Actions'}>
        {menu.title && <div className="menu-title">{menu.title}</div>}
        {menu.items.map((it, i) => (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={it.danger ? 'danger' : ''}
            disabled={it.disabled}
            title={it.hint}
            onClick={() => {
              onClose(true);
              it.run();
            }}
          >
            {it.label}
            {it.disabled && it.hint && <small>{it.hint}</small>}
          </button>
        ))}
      </div>
    </div>
  );
}

// Text field that commits on Enter or blur and restores on Escape (PLY-014).
export function TextField(props: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  maxLength?: number;
  validate?: (v: string) => string | null;
  warn?: string | null;
  inputMode?: 'numeric' | 'text';
  placeholder?: string;
  onInvalidChange?: (invalid: string | null) => void;
  multiline?: boolean;
}) {
  const [v, setV] = useState(props.value);
  const [err, setErr] = useState<string | null>(null);
  const id = useId();
  useEffect(() => {
    setV(props.value);
    setErr(null);
  }, [props.value]);
  const commit = () => {
    const e = props.validate?.(v) ?? null;
    setErr(e);
    props.onInvalidChange?.(e);
    if (!e && v !== props.value) props.onCommit(v);
  };
  const common = {
    id,
    value: v,
    maxLength: props.maxLength,
    placeholder: props.placeholder,
    'aria-invalid': !!err,
    'aria-describedby': err || props.warn ? `${id}-msg` : undefined,
    onBlur: commit,
  };
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      {props.multiline ? (
        <textarea
          {...common}
          rows={2}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setV(props.value);
              setErr(null);
              e.stopPropagation();
            }
          }}
        />
      ) : (
        <input
          {...common}
          inputMode={props.inputMode}
          onChange={(e) => {
            setV(e.target.value);
            if (err) {
              const ne = props.validate?.(e.target.value) ?? null;
              setErr(ne);
              props.onInvalidChange?.(ne);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') {
              setV(props.value);
              setErr(null);
              props.onInvalidChange?.(null);
              e.stopPropagation();
              (e.target as HTMLElement).blur();
            }
          }}
        />
      )}
      {(err || props.warn) && (
        <div id={`${id}-msg`} className={err ? 'field-error' : 'field-warn'} role={err ? 'alert' : undefined}>
          {err ?? props.warn}
        </div>
      )}
    </div>
  );
}

export function Switch(props: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="field row">
      <label htmlFor={id}>{props.label}</label>
      <input id={id} type="checkbox" role="switch" className="switch" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
    </div>
  );
}

export function Select<T extends string>(props: { label: string; value: T; options: { value: T; label: string; disabled?: boolean }[]; onChange: (v: T) => void }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <select id={id} value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Segmented<T extends string>(props: { label: string; value: T; options: { value: T; label: string; disabled?: boolean; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="field">
      <span className="field-label">{props.label}</span>
      <div className="segmented" role="group" aria-label={props.label}>
        {props.options.map((o) => (
          <button key={o.value} type="button" aria-pressed={props.value === o.value} disabled={o.disabled} title={o.title} onClick={() => props.onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Swatches(props: { label: string; value: string; options: { value: string; hex: string; name: string; disabled?: boolean; note?: string }[]; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <span className="field-label">{props.label}</span>
      <div className="swatches" role="group" aria-label={props.label}>
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            className="swatch"
            style={{ background: o.hex }}
            aria-label={o.note ? `${o.name}, ${o.note}` : o.name}
            title={o.note ?? o.name}
            aria-pressed={props.value === o.value}
            disabled={o.disabled}
            onClick={() => props.onChange(o.value)}
          >
            {o.disabled && <span className="swatch-x" />}
          </button>
        ))}
      </div>
      {props.options.some((o) => o.disabled && o.note) && <div className="field-warn">{props.options.find((o) => o.disabled)?.note}</div>}
    </div>
  );
}

export function Range(props: { label: string; value: number; min: number; max: number; step: number; onCommit: (v: number) => void; format?: (v: number) => string }) {
  const [v, setV] = useState(props.value);
  const id = useId();
  useEffect(() => setV(props.value), [props.value]);
  return (
    <div className="field">
      <label htmlFor={id}>
        {props.label} <output>{(props.format ?? String)(v)}</output>
      </label>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={v}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={() => v !== props.value && props.onCommit(v)}
        onKeyUp={() => v !== props.value && props.onCommit(v)}
        onBlur={() => v !== props.value && props.onCommit(v)}
      />
    </div>
  );
}

// Saves a file: a normal browser download, or the host's save prompt inside a claude.ai page.
export const download = (blob: Blob, name: string): Promise<SaveOutcome> => saveFile(blob, name);

export const safeName = (s: string) =>
  s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'board';
