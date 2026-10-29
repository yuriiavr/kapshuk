// Базові потреби: один список на всі місяці, сума може змінюватись, галочка «сплачено» — на кожен місяць
import { useState } from 'react';
import { api, type Need } from '../api.ts';
import { dayShort, money, monthIn } from '../format.ts';
import { Check, Empty, Field, Icon, MoneyField, Segmented, Sheet, useApp } from '../ui.tsx';

export function Needs() {
  const { data, month, act } = useApp();
  const s = data.summary;
  const [edit, setEdit] = useState<Need | 'new' | null>(null);
  const free = s.buckets.needs.left - s.needs_plan.left;

  return (
    <section>
      <div className="sum">
        <span>Сплачено <b>{s.needs_plan.paid_count} з {s.needs_plan.count}</b></span>
        <span>ще сплатити <b>{money(s.needs_plan.left)}</b></span>
        <span>на продукти й інше <b className={free < 0 ? 'neg' : ''}>{money(free)}</b></span>
      </div>
      {s.needs.length === 0 ? (
        <Empty>Додай обов'язкові платежі: оренду, комуналку, інтернет, садочок. Список один на всі місяці — щомісяця лише ставиш галочки.</Empty>
      ) : (
        <ul className="list">
          {s.needs.map((n) => (
            <li key={n.id} className={n.paid ? 'done' : ''}>
              <Check checked={n.paid} label={`${n.title}: сплачено`} color="var(--needs)"
                onChange={(paid) => act(() => api.put(`/api/needs/${n.id}/months/${month}`, { paid }))} />
              <button className="row-main" onClick={() => setEdit(n)}>
                <span className="t">{n.title}{n.once && <i className="chip">разово</i>}</span>
                <small>
                  {n.paid
                    ? `сплачено ${n.paid_at ? dayShort(n.paid_at) : ''}${n.tx_id ? ' · з банку' : ''}${n.paid_amount != null && n.paid_amount !== n.amount ? ` · ${money(n.paid_amount)}` : ''}`
                    : n.amount !== n.default_amount ? `лише в ${monthIn(month)} · зазвичай ${money(n.default_amount)}` : n.match ? `галочка сама, коли у виписці: ${n.match}` : ''}
                </small>
              </button>
              <span className="amt">{money(n.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      <button className="add" onClick={() => setEdit('new')}><Icon name="plus" />Додати платіж</button>
      {edit && <NeedSheet need={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </section>
  );
}

function NeedSheet({ need, onClose }: { need: Need | null; onClose: () => void }) {
  const { month, act } = useApp();
  const [title, setTitle] = useState(need?.title ?? '');
  const [amount, setAmount] = useState<number | null>(need?.amount ?? null);
  const [match, setMatch] = useState(need?.match ?? '');
  const [once, setOnce] = useState<'monthly' | 'once'>(need?.once ? 'once' : 'monthly');
  const [forward, setForward] = useState<'forward' | 'month'>('forward');
  const changedAmount = need != null && amount !== need.amount;
  const valid = title.trim() !== '' && amount != null;

  const save = async () => {
    const ok = await act(async () => {
      if (!need) return api.post('/api/needs', { title, amount, match, month, once_month: once === 'once' ? month : null });
      if (title !== need.title || match !== (need.match ?? '')) await api.patch(`/api/needs/${need.id}`, { title, match });
      if (changedAmount) await api.put(`/api/needs/${need.id}/months/${month}`, { amount, forward: forward === 'forward' });
    });
    if (ok) onClose();
  };

  return (
    <Sheet title={need ? need.title : 'Новий платіж'} onClose={onClose}>
      <Field label="Назва"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Оренда, комуналка, інтернет…" /></Field>
      <MoneyField label="Сума" value={amount} onChange={setAmount} />
      {!need && (
        <Segmented label="Як часто" value={once} onChange={setOnce} options={[['monthly', 'Щомісяця'], ['once', `Лише в ${monthIn(month)}`]]} />
      )}
      {changedAmount && !need.once && (
        <Segmented label="Нова сума" value={forward} onChange={setForward} options={[['forward', 'З цього місяця й надалі'], ['month', `Лише в ${monthIn(month)}`]]} />
      )}
      <Field label="Як упізнати у виписці" hint="Слова з опису платежу в Monobank через кому, напр. «київстар, kyivstar». Тоді галочка ставиться сама.">
        <input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="необов'язково" />
      </Field>
      <div className="actions">
        {need && (
          <button className="btn danger" onClick={() => act(() => api.del(`/api/needs/${need.id}?month=${month}`)).then((ok) => ok && onClose())}>
            <Icon name="trash" />{need.once ? 'Видалити' : `Прибрати з ${monthIn(month)} і далі`}
          </button>
        )}
        <button className="btn primary" disabled={!valid} onClick={save}>{need ? 'Зберегти' : 'Додати'}</button>
      </div>
    </Sheet>
  );
}
