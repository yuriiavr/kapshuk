// На себе: покупки для сім'ї, заплановані на місяць, і вішліст — бажане без дати
import { useState } from 'react';
import { api, type Want } from '../api.ts';
import { money, monthIn } from '../format.ts';
import { Check, Empty, Field, Icon, MoneyField, Segmented, Sheet, useApp } from '../ui.tsx';

const safeUrl = (u: string | null) => (u && /^https?:\/\//i.test(u) ? u : null);

export function Wants() {
  const { data, month, act } = useApp();
  const s = data.summary;
  const [edit, setEdit] = useState<{ want: Want | null; wish: boolean } | null>(null);
  const free = s.buckets.wants.left - s.wants_plan.left;

  return (
    <section>
      <div className="sum">
        <span>Витрачено <b>{money(s.buckets.wants.spent)}</b> з {money(s.buckets.wants.allocated)}</span>
        <span>заплановано ще <b>{money(s.wants_plan.left)}</b></span>
        <span>вільно <b className={free < 0 ? 'neg' : ''}>{money(free)}</b></span>
      </div>

      <h3>Заплановано в {monthIn(month)}</h3>
      {s.wants.length === 0 ? (
        <Empty>Що хочете купити цього місяця для себе чи для дому? Додай сюди або перенеси з вішліста.</Empty>
      ) : (
        <ul className="list">
          {s.wants.map((w) => (
            <li key={w.id} className={w.bought ? 'done' : ''}>
              <Check checked={w.bought} label={`${w.title}: куплено`} color="var(--wants)"
                onChange={(bought) => act(() => api.patch(`/api/wants/${w.id}`, { bought }))} />
              <button className="row-main" onClick={() => setEdit({ want: w, wish: false })}>
                <span className="t">{w.title}</span>
                {w.note && <small>{w.note}</small>}
              </button>
              {safeUrl(w.url) && <a className="icon-btn" href={safeUrl(w.url)!} target="_blank" rel="noopener noreferrer" aria-label="Відкрити посилання"><Icon name="link" size={18} /></a>}
              <span className="amt">{money(w.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      <button className="add" onClick={() => setEdit({ want: null, wish: false })}><Icon name="plus" />Запланувати покупку</button>

      <h3>Вішліст <small>{data.wishlist.length || ''}</small></h3>
      {data.wishlist.length === 0 ? (
        <Empty>Бажане без дати: побачили — додали з ціною й посиланням, а коли буде змога, перенесли в план місяця.</Empty>
      ) : (
        <ul className="list">
          {data.wishlist.map((w) => (
            <li key={w.id}>
              <span className="lead"><Icon name="heart" size={18} /></span>
              <button className="row-main" onClick={() => setEdit({ want: w, wish: true })}>
                <span className="t">{w.title}</span>
                <small>{[w.amount != null && money(w.amount), w.note].filter(Boolean).join(' · ')}</small>
              </button>
              {safeUrl(w.url) && <a className="icon-btn" href={safeUrl(w.url)!} target="_blank" rel="noopener noreferrer" aria-label="Відкрити посилання"><Icon name="link" size={18} /></a>}
              <button className="pill" onClick={() => act(() => api.patch(`/api/wants/${w.id}`, { month }))}>У план</button>
            </li>
          ))}
        </ul>
      )}
      <button className="add" onClick={() => setEdit({ want: null, wish: true })}><Icon name="plus" />Додати бажане</button>

      {edit && <WantSheet want={edit.want} wish={edit.wish} onClose={() => setEdit(null)} />}
    </section>
  );
}

function WantSheet({ want, wish, onClose }: { want: Want | null; wish: boolean; onClose: () => void }) {
  const { month, act } = useApp();
  const [title, setTitle] = useState(want?.title ?? '');
  const [amount, setAmount] = useState<number | null>(want?.amount ?? null);
  const [url, setUrl] = useState(want?.url ?? '');
  const [note, setNote] = useState(want?.note ?? '');
  const [where, setWhere] = useState<'month' | 'wish'>(wish ? 'wish' : 'month');
  const badUrl = url.trim() !== '' && !/^https?:\/\/\S+$/i.test(url.trim());

  const save = async () => {
    const body = { title, amount, url, note, month: where === 'month' ? (want?.month ?? month) : null };
    if (await act(() => (want ? api.patch(`/api/wants/${want.id}`, body) : api.post('/api/wants', body)))) onClose();
  };

  return (
    <Sheet title={want ? want.title : where === 'wish' ? 'Бажане' : 'Покупка на місяць'} onClose={onClose}>
      <Field label="Що купити"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Пилосос, черевики малому…" /></Field>
      <MoneyField label="Ціна" value={amount} onChange={setAmount} optional />
      <Field label="Посилання" hint={badUrl ? 'Посилання має починатися з https://' : undefined}>
        <input type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… (необов'язково)" />
      </Field>
      <Field label="Примітка"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="розмір, колір, для кого" /></Field>
      <Segmented label="Куди" value={where} onChange={setWhere} options={[['month', `У план на ${monthIn(want?.month ?? month)}`], ['wish', 'У вішліст']]} />
      <div className="actions">
        {want && <button className="btn danger" onClick={() => act(() => api.del(`/api/wants/${want.id}`)).then((ok) => ok && onClose())}><Icon name="trash" />Видалити</button>}
        <button className="btn primary" disabled={!title.trim() || badUrl} onClick={save}>{want ? 'Зберегти' : 'Додати'}</button>
      </div>
    </Sheet>
  );
}
