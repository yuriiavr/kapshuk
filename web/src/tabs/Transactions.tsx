// Операції місяця з Monobank і вручну: кошик кожної можна виправити, і Капшук запам'ятає магазин
import { useEffect, useMemo, useState } from 'react';
import { api, type Tx, type TxBucket } from '../api.ts';
import { dayKey, dayTitle, money, time, TX_BUCKETS } from '../format.ts';
import { Empty, Field, Icon, MoneyField, Segmented, Sheet, Switch, useApp } from '../ui.tsx';

type Filter = TxBucket | 'all';
const FILTERS: [Filter, string][] = [['all', 'Усі'], ['needs', 'Потреби'], ['wants', 'На себе'], ['savings', 'Заощадження'], ['income', 'Дохід'], ['internal', 'Свої'], ['ignore', 'Не рахую']];

export function Transactions() {
  const { month, version, act } = useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [list, setList] = useState<Tx[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<Tx | null>(null);
  const [cash, setCash] = useState(false);

  useEffect(() => {
    let live = true;
    api.get<Tx[]>(`/api/transactions?month=${month}${filter === 'all' ? '' : `&bucket=${filter}`}`)
      .then((l) => live && (setList(l), setError(null)))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [month, filter, version]);

  const days = useMemo(() => {
    const groups: { key: string; title: string; items: Tx[] }[] = [];
    for (const t of list ?? []) {
      const key = dayKey(t.time);
      if (groups.at(-1)?.key !== key) groups.push({ key, title: dayTitle(t.time), items: [] });
      groups.at(-1)!.items.push(t);
    }
    return groups;
  }, [list]);

  return (
    <section>
      <div className="chips" role="radiogroup" aria-label="Кошик">
        {FILTERS.map(([k, title]) => (
          <button key={k} role="radio" aria-checked={filter === k} className={`chip-btn ${k} ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{title}</button>
        ))}
      </div>
      <div className="row-actions">
        <button className="add" onClick={() => setCash(true)}><Icon name="cash" />Готівка чи інше</button>
        <button className="add" onClick={() => act(() => api.post('/api/sync'))} title="Monobank дозволяє один запит на хвилину"><Icon name="sync" />Оновити з банку</button>
      </div>
      {error && <p className="warn">{error}</p>}
      {list && list.length === 0 && <Empty>Операцій {filter === 'all' ? '' : 'в цьому кошику '}за місяць ще немає.</Empty>}
      {days.map((d) => (
        <div key={d.key} className="day">
          <h4>{d.title}</h4>
          <ul className="list tx">
            {d.items.map((t) => (
              <li key={t.id}>
                <button className="row-main" onClick={() => setEdit(t)}>
                  <span className="t">{t.description || 'Без опису'}{t.hold ? <i className="chip">очікує</i> : null}</span>
                  <small>{[time(t.time), t.member, t.source === 'manual' ? 'вручну' : t.account].filter(Boolean).join(' · ')}</small>
                </button>
                <span className={`amt ${t.amount > 0 ? 'pos' : ''}`}>
                  {money(t.amount, { exact: true, sign: true })}
                  <i className={`tag ${t.bucket} ${t.bucket_source === 'auto' ? 'auto' : ''}`}>{TX_BUCKETS[t.bucket].title}</i>
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
  const { act } = useApp();
  const [bucket, setBucket] = useState<TxBucket>(tx.bucket);
  const [remember, setRemember] = useState(tx.source === 'mono');

  const save = async () => {
    if (await act(() => api.put(`/api/transactions/${tx.id}/bucket`, { bucket, remember }))) onClose();
  };

  return (
    <Sheet title={tx.description || 'Операція'} onClose={onClose}>
      <p className="tx-big">{money(tx.amount, { exact: true, sign: true })}</p>
      <p className="hint">{[dayTitle(tx.time), time(tx.time), tx.member, tx.account, tx.mcc ? `MCC ${tx.mcc}` : null].filter(Boolean).join(' · ')}</p>
      {tx.comment && <p className="hint">«{tx.comment}»</p>}
      <div className="bucket-grid" role="radiogroup" aria-label="Кошик">
        {(Object.keys(TX_BUCKETS) as TxBucket[]).map((k) => (
          <button key={k} role="radio" aria-checked={bucket === k} className={`bucket-opt ${k} ${bucket === k ? 'on' : ''}`} onClick={() => setBucket(k)}>
            <b>{TX_BUCKETS[k].title}</b><small>{TX_BUCKETS[k].hint}</small>
          </button>
        ))}
      </div>
      {tx.source === 'mono' && (
        <Switch on={remember} onChange={setRemember} title={`Запам'ятати для «${tx.description}»`} hint="Такі самі операції — і минулі, і нові — підуть сюди ж" />
      )}
      <div className="actions">
        {tx.source === 'manual' && <button className="btn danger" onClick={() => act(() => api.del(`/api/transactions/${tx.id}`)).then((ok) => ok && onClose())}><Icon name="trash" />Видалити</button>}
        <button className="btn primary" onClick={save}>Зберегти</button>
      </div>
    </Sheet>
  );
}

function CashSheet({ onClose }: { onClose: () => void }) {
  const { act } = useApp();
  const [amount, setAmount] = useState<number | null>(null);
  const [description, setDescription] = useState('');
  const [bucket, setBucket] = useState<'needs' | 'wants' | 'savings' | 'income'>('needs');

  const save = async () => {
    if (await act(() => api.post('/api/transactions', { amount, description, bucket }))) onClose();
  };

  return (
    <Sheet title="Готівка чи інша операція" onClose={onClose}>
      <MoneyField label="Сума" value={amount} onChange={setAmount} autoFocus />
      <Field label="Що це"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ринок, перукарня, зарплата готівкою…" /></Field>
      <Field label="Кошик">
        <Segmented label="Кошик" value={bucket} onChange={setBucket}
          options={[['needs', 'Потреби'], ['wants', 'На себе'], ['savings', 'Відкладено'], ['income', 'Дохід']]} />
      </Field>
      <div className="actions">
        <button className="btn primary" disabled={!amount} onClick={save}>Записати</button>
      </div>
    </Sheet>
  );
}
