// Витрати місяця з Monobank і вручну: що й де купили. Категорію кожної можна виправити (Капшук запам'ятає магазин),
// а до операції — дописати товари чи сфотографувати чек
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api, type Category, type Tx, type TxBucket, type TxItems } from '../api.ts';
import { CATEGORIES, dayKey, dayTitle, KINDS, money, time } from '../format.ts';
import { Empty, Field, Icon, MoneyField, Segmented, Sheet, Switch, useApp } from '../ui.tsx';
import { CategoryField, CategoryPicker, CurrentKind, ItemsEditor, newKey, plural, ReceiptButton, type EditItem } from '../Receipt.tsx';

type Filter = TxBucket | 'all';
const FILTERS: [Filter, string][] = [['all', 'Усі'], ['spend', 'Витрати'], ['income', 'Дохід'], ['internal', 'Свої'], ['savings', 'У банку'], ['ignore', 'Не рахую']];
const KIND_OPTIONS: [TxBucket, string][] = [['spend', 'Витрата'], ['income', 'Дохід'], ['internal', 'Свої'], ['savings', 'У банку'], ['ignore', 'Не рахувати']];

export const kindTitle = (t: Pick<Tx, 'bucket' | 'category'>) =>
  t.bucket === 'spend' ? CATEGORIES[t.category ?? 'other'].title : KINDS[t.bucket].title;
const kindColor = (t: Pick<Tx, 'bucket' | 'category'>) =>
  t.bucket === 'spend' ? CATEGORIES[t.category ?? 'other'].color : t.bucket === 'income' || t.bucket === 'savings' ? 'var(--income)' : 'var(--muted)';

export function Transactions({ category, setCategory }: { category: Category | null; setCategory: (c: Category | null) => void }) {
  const { month, version, act } = useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [list, setList] = useState<Tx[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<Tx | null>(null);
  const [cash, setCash] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ month });
    if (category) q.set('category', category);
    else if (filter !== 'all') q.set('bucket', filter);
    if (query) q.set('search', query);
    api.get<Tx[]>(`/api/transactions?${q}`)
      .then((l) => live && (setList(l), setError(null)))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [month, filter, category, query, version]);

  const days = useMemo(() => {
    const groups: { key: string; title: string; spent: number; items: Tx[] }[] = [];
    for (const t of list ?? []) {
      const key = dayKey(t.time);
      if (groups.at(-1)?.key !== key) groups.push({ key, title: dayTitle(t.time), spent: 0, items: [] });
      const g = groups.at(-1)!;
      g.items.push(t);
      if (t.bucket === 'spend') g.spent -= t.amount;
    }
    return groups;
  }, [list]);
  const shownSpent = (list ?? []).filter((t) => t.bucket === 'spend').reduce((s, t) => s - t.amount, 0);

  return (
    <section>
      <div className="row-actions">
        <button className="add" onClick={() => setCash(true)}><Icon name="cash" />Готівка чи інше</button>
        <button className="add" onClick={() => act(() => api.post('/api/sync'))} title="Monobank дозволяє один запит на хвилину"><Icon name="sync" />Оновити з банку</button>
      </div>
      <label className="search">
        <Icon name="search" size={18} />
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Пошук: магазин чи товар" aria-label="Пошук" />
      </label>
      <div className="chips" role="radiogroup" aria-label="Що показати">
        {category ? (
          <button className="chip-btn on cat" style={{ '--c': CATEGORIES[category].color } as CSSProperties} onClick={() => setCategory(null)}>
            <i className="dot" />{CATEGORIES[category].title}<Icon name="close" size={14} />
          </button>
        ) : FILTERS.map(([k, title]) => (
          <button key={k} role="radio" aria-checked={filter === k} className={`chip-btn ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{title}</button>
        ))}
      </div>
      {(category || query) && list && list.length > 0 && <p className="hint">Знайдено {list.length} · витрачено {money(shownSpent)}</p>}
      {error && <p className="warn">{error}</p>}
      {list && list.length === 0 && <Empty>{query ? `Нічого не знайшлось за «${query}».` : 'Операцій за місяць ще немає.'}</Empty>}
      {days.map((d) => (
        <div key={d.key} className="day">
          <h4><span>{d.title}</span>{d.spent > 0 && <span>{money(d.spent)}</span>}</h4>
          <ul className="list tx">
            {d.items.map((t) => (
              <li key={t.id}>
                <button className="row-main" onClick={() => setEdit(t)}>
                  <span className="t">{t.description || 'Без опису'}{t.hold ? <i className="chip">очікує</i> : null}</span>
                  <small>{[time(t.time), t.member, t.source === 'manual' ? 'вручну' : t.account].filter(Boolean).join(' · ')}</small>
                  {t.items_text && <small className="items-line"><Icon name="receipt" size={13} />{t.items_text}{t.items > 6 ? '…' : ''}</small>}
                </button>
                <span className={`amt ${t.amount > 0 ? 'pos' : ''}`}>
                  {money(t.amount, { exact: true, sign: true })}
                  <i className={`tag ${t.bucket_source === 'auto' ? 'auto' : ''}`} style={{ '--c': kindColor(t) } as CSSProperties}>{kindTitle(t)}</i>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {edit && <TxSheet tx={edit} onClose={() => setEdit(null)} />}
      {cash && <CashSheet onClose={() => setCash(false)} />}
    </section>
  );
}

function TxSheet({ tx, onClose }: { tx: Tx; onClose: () => void }) {
  const { act, version } = useApp();
  const [bucket, setBucket] = useState<TxBucket>(tx.bucket);
  const [category, setCategory] = useState<Category>(tx.category ?? 'other');
  const [remember, setRemember] = useState(tx.source === 'mono');
  const [loaded, setLoaded] = useState<TxItems | null>(null);
  const [items, setItems] = useState<EditItem[]>([]);
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  // Перечитуємо й після запису чека з цього вікна (version зміниться)
  useEffect(() => {
    let live = true;
    api.get<TxItems>(`/api/transactions/${tx.id}/items`).then((r) => {
      if (!live) return;
      setLoaded(r);
      setItems(r.items.map((i) => ({ ...i, key: newKey() })));
    }).catch(() => live && setLoaded({ items: [], receipt: null }));
    return () => {
      live = false;
    };
  }, [tx.id, version]);

  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo);
  }, [photo]);

  const kindChanged = bucket !== tx.bucket || (bucket === 'spend' && category !== (tx.category ?? 'other'));
  const itemsChanged = loaded != null && JSON.stringify(items.map((i) => [i.id ?? null, i.name, i.amount])) !== JSON.stringify(loaded.items.map((i) => [i.id, i.name, i.amount]));
  const itemsValid = items.every((i) => i.name.trim() && i.amount);
  const itemsSum = items.reduce((s, i) => s + (i.amount ?? 0), 0);

  const save = async () => {
    setBusy(true);
    const ok = await act(async () => {
      if (kindChanged) await api.put(`/api/transactions/${tx.id}/kind`, { bucket, category, remember: tx.source === 'mono' && remember });
      if (itemsChanged) await api.put(`/api/transactions/${tx.id}/items`, { items: items.map(({ id, name, amount, qty }) => ({ id, name, amount, qty })) });
    });
    setBusy(false);
    if (ok) onClose();
  };

  const showPhoto = () => {
    if (!loaded?.receipt) return;
    api.image(`/api/receipts/${loaded.receipt.id}/image`).then(setPhoto).catch(() => {});
  };

  return (
    <Sheet title={tx.description || 'Операція'} onClose={onClose}>
      <p className="tx-big">{money(tx.amount, { exact: true, sign: true })}</p>
      <p className="hint">{[dayTitle(tx.time), time(tx.time), tx.member, tx.account, tx.mcc ? `MCC ${tx.mcc}` : null].filter(Boolean).join(' · ')}</p>
      {tx.comment && <p className="hint">«{tx.comment}»</p>}

      <CurrentKind color={kindColor({ bucket, category })} title={kindTitle({ bucket, category })} open={picking} onToggle={() => setPicking(!picking)}
        hint={tx.bucket_source === 'auto' && !kindChanged ? 'авто · змінити' : undefined} />
      {picking && (
        <>
          <div className="chips wrap" role="radiogroup" aria-label="Що це">
            {KIND_OPTIONS.map(([k, title]) => (
              <button key={k} type="button" role="radio" aria-checked={bucket === k} className={`chip-btn ${bucket === k ? 'on' : ''}`}
                onClick={() => { setBucket(k); if (k !== 'spend') setPicking(false); }}>{title}</button>
            ))}
          </div>
          {bucket === 'spend' && <CategoryPicker value={category} onChange={(c) => { setCategory(c); setPicking(false); }} />}
        </>
      )}
      {bucket !== 'spend' && <p className="hint">{KINDS[bucket].hint} — у витрати не йде</p>}
      {tx.source === 'mono' && kindChanged && (
        <Switch on={remember} onChange={setRemember} title={`Запам'ятати для «${tx.description}»`} hint="Такі самі операції — і минулі, і нові — підуть сюди ж" />
      )}

      {bucket === 'spend' && (
        <>
          <h3 className="sub">Що купили{items.length > 0 && <small>{items.length} {plural(items.length, 'товар', 'товари', 'товарів')} · {money(itemsSum, { exact: true })}</small>}</h3>
          {loaded == null ? <p className="hint">Завантажую…</p> : <ItemsEditor items={items} onChange={setItems} />}
          {items.length > 0 && tx.amount < 0 && Math.abs(itemsSum + tx.amount) > 100 && (
            <p className="hint">Розписано {money(itemsSum, { exact: true })} з {money(-tx.amount, { exact: true })}.</p>
          )}
          <div className="row-actions">
            <ReceiptButton txId={tx.id} className="add"><Icon name="camera" />{loaded?.receipt ? 'Інший чек' : 'Фото чека'}</ReceiptButton>
            {loaded?.receipt?.has_image ? <button className="add" onClick={showPhoto}><Icon name="image" />Показати чек</button> : null}
          </div>
          {photo && <img className="receipt-photo" src={photo} alt="Фото чека" />}
        </>
      )}

      <div className="actions">
        {tx.source === 'manual' && <button className="btn danger" onClick={() => act(() => api.del(`/api/transactions/${tx.id}`)).then((ok) => ok && onClose())}><Icon name="trash" />Видалити</button>}
        <button className="btn primary" disabled={busy || !itemsValid || (!kindChanged && !itemsChanged)} onClick={save}>{busy ? 'Зберігаю…' : 'Зберегти'}</button>
      </div>
    </Sheet>
  );
}

function CashSheet({ onClose }: { onClose: () => void }) {
  const { act } = useApp();
  const [amount, setAmount] = useState<number | null>(null);
  const [description, setDescription] = useState('');
  const [bucket, setBucket] = useState<'spend' | 'income' | 'savings'>('spend');
  const [category, setCategory] = useState<Category>('groceries');

  const save = async () => {
    if (await act(() => api.post('/api/transactions', { amount, description, bucket, category: bucket === 'spend' ? category : null }))) onClose();
  };

  return (
    <Sheet title="Готівка чи інша операція" onClose={onClose}>
      <MoneyField label="Сума" value={amount} onChange={setAmount} autoFocus />
      <Field label="Що це"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ринок, перукарня, зарплата готівкою…" /></Field>
      <Segmented label="Що це" value={bucket} onChange={setBucket} options={[['spend', 'Витрата'], ['income', 'Дохід'], ['savings', 'Відклали']]} />
      {bucket === 'spend' && <CategoryField value={category} onChange={setCategory} />}
      <p className="hint">Товари можна дописати потім — відкрий запис у списку. Є чек — краще кнопка «Чек»: ШІ все випише сам.</p>
      <div className="actions">
        <button className="btn primary" disabled={!amount} onClick={save}>Записати</button>
      </div>
    </Sheet>
  );
}
