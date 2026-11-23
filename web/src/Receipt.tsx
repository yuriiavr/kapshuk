// Фото чека → ШІ читає товари → людина перевіряє й записує до операції з банку (за сумою) чи окремим записом.
// Тут же редактор товарів — його бере й вікно операції.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, type Candidate, type Category, type ItemGroup, type Scan } from './api.ts';
import { CATEGORIES, CATEGORY_KEYS, dayShort, dayTitle, ITEM_GROUPS, money, moneyInput, parseMoney, time } from './format.ts';
import { Field, Icon, MoneyField, Sheet, useApp } from './ui.tsx';

export type EditItem = { key: string; id?: number | null; name: string; title?: string | null; group?: ItemGroup | null; qty?: number | null; amount: number | null };
let seq = 0;
export const newKey = () => `i${++seq}`;

/** Фото з телефону — до ~3,5 Мп у JPEG: розбірливо для ШІ й не завелике для мережі. Повертає base64 без префікса */
async function shrink(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => fail(new Error('Не вдалося відкрити фото — спробуй інше'));
      i.src = url;
    });
    const w = img.naturalWidth, h = img.naturalHeight;
    const k = Math.min(1, Math.sqrt(3.5e6 / (w * h)), 3000 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Кнопка «сфотографувати чек»: свій прихований вибір файлу (телефон дасть камеру або галерею) і вікно перевірки */
export function ReceiptButton({ txId, className, children, title }: { txId?: string; className?: string; children: ReactNode; title?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  return (
    <>
      <button type="button" className={className} title={title} onClick={() => input.current?.click()}>{children}</button>
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) setFile(f);
      }} />
      {file && <ReceiptSheet file={file} txId={txId} onClose={() => setFile(null)} onRetry={() => input.current?.click()} />}
    </>
  );
}

function ReceiptSheet({ file, txId, onClose, onRetry }: { file: File; txId?: string; onClose: () => void; onRetry: () => void }) {
  const { act } = useApp();
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [store, setStore] = useState('');
  const [total, setTotal] = useState<number | null>(null);
  const [items, setItems] = useState<EditItem[]>([]);
  const [target, setTarget] = useState<string>('new');
  const [category, setCategory] = useState<Category>('groceries');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setScan(null);
    setError(null);
    (async () => {
      try {
        const image = await shrink(file);
        const s = await api.post<Scan>('/api/receipts/scan', { image, mime: 'image/jpeg', tx_id: txId });
        if (!live) return;
        setScan(s);
        setStore(s.receipt.store ?? '');
        setTotal(s.receipt.total);
        setItems(s.receipt.items.map((i) => ({ ...i, key: newKey() })));
        setTarget(s.match ?? 'new');
        setCategory(s.receipt.category);
      } catch (err) {
        if (live) setError((err as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [file, txId]);

  const itemsSum = items.reduce((s, i) => s + (i.amount ?? 0), 0);
  const valid = total != null && total > 0 && items.length > 0 && items.every((i) => i.name.trim() && i.amount);

  const save = async () => {
    if (!scan) return;
    setBusy(true);
    const ok = await act(() => api.post('/api/receipts', {
      tx_id: target === 'new' ? null : target, store, time: scan.receipt.time, total, category: target === 'new' ? category : undefined,
      items: items.map(({ name, title, group, qty, amount }) => ({ name, title: title && name ? title : null, group, qty, amount })), image: scan.image,
    }));
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Sheet title={scan ? store || 'Чек' : 'Чек'} onClose={onClose} wide>
      {!scan && !error && (
        <div className="reading">
          <span className="spinner" aria-hidden="true" />
          <p>ШІ читає чек…</p>
          <small className="hint">Зазвичай 5–20 секунд</small>
        </div>
      )}
      {error && (
        <>
          <p className="warn">{error}</p>
          <div className="actions">
            <button className="btn" onClick={onClose}>Закрити</button>
            <button className="btn primary" onClick={onRetry}><Icon name="camera" />Інше фото</button>
          </div>
        </>
      )}
      {scan && (
        <>
          <div className="receipt-head">
            <Field label="Магазин"><input value={store} onChange={(e) => setStore(e.target.value)} placeholder="АТБ, Сільпо…" /></Field>
            <MoneyField label="Сума чека" value={total} onChange={setTotal} />
          </div>
          <p className="hint">
            {scan.receipt.time ? `${dayTitle(scan.receipt.time)}, ${time(scan.receipt.time)}` : 'Дату на чеку не прочитано'}
            {' · '}{items.length} {plural(items.length, 'товар', 'товари', 'товарів')} на {money(itemsSum, { exact: true })}
          </p>
          {total != null && Math.abs(itemsSum - total) > 100 && (
            <p className="warn">Товарів на {money(itemsSum, { exact: true })}, а в чеку {money(total, { exact: true })} — перевір ціни або додай пропущене.</p>
          )}
          <ItemsEditor items={items} onChange={setItems} />

          <h3>Куди записати</h3>
          <div className="targets" role="radiogroup" aria-label="Куди записати">
            {scan.candidates.map((c) => <TargetOption key={c.id} c={c} on={target === c.id} total={total} onPick={() => setTarget(c.id)} />)}
            <button type="button" role="radio" aria-checked={target === 'new'} className={`target ${target === 'new' ? 'on' : ''}`} onClick={() => setTarget('new')}>
              <span className="row-main static">
                <span className="t">Окремий запис</span>
                <small>{scan.candidates.length ? 'платили готівкою чи іншою карткою' : 'у банку такої суми не знайшлось — готівка чи інша картка'}</small>
              </span>
            </button>
          </div>
          {target === 'new' && <CategoryField value={category} onChange={setCategory} />}

          <div className="actions">
            <button className="btn primary" disabled={!valid || busy} onClick={save}>{busy ? 'Записую…' : 'Записати'}</button>
          </div>
        </>
      )}
    </Sheet>
  );
}

function TargetOption({ c, on, total, onPick }: { c: Candidate; on: boolean; total: number | null; onPick: () => void }) {
  const exact = total != null && -c.amount === total;
  return (
    <button type="button" role="radio" aria-checked={on} className={`target ${on ? 'on' : ''}`} onClick={onPick}>
      <span className="row-main static">
        <span className="t">{c.description}{exact ? <i className="chip ok-chip">та сама сума</i> : null}{c.items > 0 ? <i className="chip">уже з товарами</i> : null}</span>
        <small>{[`${dayShort(c.time)}, ${time(c.time)}`, c.member, c.account].filter(Boolean).join(' · ')}</small>
      </span>
      <span className="amt">{money(c.amount, { exact: true })}</span>
    </button>
  );
}

/** Категорія згорнута: видно поточну, список з усіма відкривається натисканням і закривається вибором */
export function CategoryField({ value, onChange }: { value: Category; onChange: (c: Category) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <CurrentKind color={CATEGORIES[value].color} title={CATEGORIES[value].title} open={open} onToggle={() => setOpen(!open)} />
      {open && <CategoryPicker value={value} onChange={(c) => { onChange(c); setOpen(false); }} />}
    </>
  );
}

export function CurrentKind({ color, title, open, onToggle, hint }: { color: string; title: string; open: boolean; onToggle: () => void; hint?: string }) {
  return (
    <button type="button" className="cat-current" style={{ '--c': color } as CSSProperties} aria-expanded={open} onClick={onToggle}>
      <span className="label">Категорія</span>
      <i className="dot" /><b>{title}</b>
      <small>{open ? 'згорнути' : hint ?? 'змінити'}</small>
    </button>
  );
}

export function CategoryPicker({ value, onChange }: { value: Category; onChange: (c: Category) => void }) {
  return (
    <div className="cat-grid" role="radiogroup" aria-label="Категорія">
      {CATEGORY_KEYS.map((k) => (
        <button type="button" key={k} role="radio" aria-checked={value === k} className={`cat-opt ${value === k ? 'on' : ''}`}
          style={{ '--c': CATEGORIES[k].color } as CSSProperties} onClick={() => onChange(k)}>
          <i className="dot" />{CATEGORIES[k].title}
        </button>
      ))}
    </div>
  );
}

/** Список товарів: назва й сума кожного, видалити, додати. Група з'являється після запису (її дає ШІ) */
export function ItemsEditor({ items, onChange }: { items: EditItem[]; onChange: (items: EditItem[]) => void }) {
  const set = (key: string, patch: Partial<EditItem>) => onChange(items.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  return (
    <div className="items-edit">
      {items.map((i) => (
        <div key={i.key} className="item-row">
          <span className="item-name">
            <input value={i.name} aria-label="Товар" placeholder="Що купили"
              onChange={(e) => set(i.key, { name: e.target.value, ...(i.id != null || i.title ? { title: null, group: null } : {}) })} />
            {i.group && i.group !== 'other' && <small>{ITEM_GROUPS[i.group]}{i.qty && i.qty !== 1 ? ` · ${formatQty(i.qty)}` : ''}</small>}
          </span>
          <AmountInput value={i.amount} onChange={(amount) => set(i.key, { amount })} />
          <button type="button" className="icon-btn" aria-label={`Прибрати ${i.name}`} onClick={() => onChange(items.filter((x) => x.key !== i.key))}><Icon name="close" size={18} /></button>
        </div>
      ))}
      <button type="button" className="add slim" onClick={() => onChange([...items, { key: newKey(), name: '', amount: null }])}><Icon name="plus" />Товар</button>
    </div>
  );
}

function AmountInput({ value, onChange }: { value: number | null; onChange: (kop: number | null) => void }) {
  const [text, setText] = useState(() => moneyInput(value));
  const bad = text.trim() !== '' && parseMoney(text) == null;
  return (
    <span className={`money item-amt ${bad ? 'bad' : ''}`}>
      <input inputMode="decimal" aria-label="Сума" placeholder="0" value={text} onChange={(e) => {
        setText(e.target.value);
        onChange(parseMoney(e.target.value));
      }} />
      <i>₴</i>
    </span>
  );
}

const formatQty = (q: number) => (Number.isInteger(q) ? `${q} шт` : `${q.toLocaleString('uk-UA', { maximumFractionDigits: 3 })} кг`);

export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
