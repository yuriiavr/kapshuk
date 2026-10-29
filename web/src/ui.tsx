// Спільні дрібниці інтерфейсу: контекст застосунку, іконки, вікно знизу, поля, перемикачі
import { createContext, useContext, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { State } from './api.ts';
import { moneyInput, parseMoney } from './format.ts';

export type App = {
  data: State;
  month: string;
  /** Виконати зміну на сервері, потім перечитати стан; помилку показати внизу. true — вдалося */
  act: (fn: () => Promise<unknown>) => Promise<boolean>;
  reload: () => Promise<void>;
  version: number;
};

export const AppCtx = createContext<App | null>(null);
export const useApp = () => useContext(AppCtx)!;

// ── Іконки (контурні, 24×24) ──

const paths = {
  left: 'M15 18l-6-6 6-6',
  right: 'M9 18l6-6-6-6',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  link: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  sync: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  close: 'M6 6l12 12M18 6L6 18',
  bank: 'M3 10h18M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18M12 3l9 5H3z',
  cash: 'M3 7h18v10H3zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M6 7v10M18 7v10',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v5M16 3v5',
  heart: 'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z',
} as const;

export function Icon({ name, size = 20 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

// ── Вікно знизу (на ПК — посередині) ──

export function Sheet({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('input, textarea, select, button:not(.x)')?.focus({ preventScroll: true });
    document.body.classList.add('locked');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('locked');
      prev?.focus?.({ preventScroll: true });
    };
  }, [onClose]);
  return createPortal(
    <div className="sheet-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={box}>
        <header>
          <h2 id={titleId}>{title}</h2>
          <button className="x icon-btn" onClick={onClose} aria-label="Закрити"><Icon name="close" /></button>
        </header>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ── Поля ──

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <small className="hint">{hint}</small>}
    </label>
  );
}

/** Сума в гривнях; значення — копійки або null, якщо порожньо чи не число */
export function MoneyField({ label, value, onChange, hint, autoFocus, optional }: {
  label: string; value: number | null; onChange: (kop: number | null) => void; hint?: ReactNode; autoFocus?: boolean; optional?: boolean;
}) {
  const [text, setText] = useState(() => moneyInput(value));
  useEffect(() => {
    if (parseMoney(text) !== value) setText(moneyInput(value));
    // лише коли значення змінили ззовні
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const bad = text.trim() !== '' && parseMoney(text) == null;
  return (
    <Field label={label} hint={bad ? 'Напиши суму цифрами, напр. 12 500' : hint}>
      <span className={`money ${bad ? 'bad' : ''}`}>
        <input inputMode="decimal" autoComplete="off" placeholder={optional ? 'необов\'язково' : '0'} value={text} autoFocus={autoFocus}
          onChange={(e) => {
            setText(e.target.value);
            onChange(parseMoney(e.target.value));
          }} />
        <i>₴</i>
      </span>
    </Field>
  );
}

export function Check({ checked, onChange, label, color }: { checked: boolean; onChange: (v: boolean) => void; label: string; color?: string }) {
  return (
    <button type="button" className={`check ${checked ? 'on' : ''}`} style={color ? ({ '--c': color } as CSSProperties) : undefined}
      role="checkbox" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
      <Icon name="check" size={16} />
    </button>
  );
}

export function Switch({ on, onChange, title, hint, disabled }: { on: boolean; onChange: (v: boolean) => void; title: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}>
      <span><b>{title}</b>{hint && <small>{hint}</small>}</span>
      <i className="knob" />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: [T, string][]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button type="button" key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

export function Progress({ value, max, kind }: { value: number; max: number; kind: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : value > 0 ? 100 : 0;
  return (
    <div className={`progress ${kind} ${max > 0 && value > max ? 'over' : ''}`}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
