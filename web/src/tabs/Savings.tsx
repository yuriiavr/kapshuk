// Заощадження: банки Monobank, відкладене за місяць і перерозподіл між кошиками
import { useState } from 'react';
import { api } from '../api.ts';
import { BUCKETS, money, monthIn } from '../format.ts';
import { Empty, Field, Icon, MoneyField, Progress, Segmented, Sheet, Switch, useApp } from '../ui.tsx';

type B = 'needs' | 'wants' | 'savings';
const FROM: Record<B, string> = { needs: 'З потреб', wants: 'З «на себе»', savings: 'Із заощаджень' };
const TO: Record<B, string> = { needs: 'у потреби', wants: 'на себе', savings: 'у заощадження' };

export function Savings({ openSettings }: { openSettings: () => void }) {
  const { data, month, act } = useApp();
  const s = data.summary;
  const [move, setMove] = useState(false);
  const connected = data.members.some((m) => m.connected);
  const uahJars = s.jars.filter((j) => j.currency === 980);

  return (
    <section>
      <div className="sum">
        <span>Відкладено в {monthIn(month)} <b>{money(s.buckets.savings.spent)}</b> з {money(s.buckets.savings.allocated)}</span>
        {uahJars.length > 0 && <span>у банках <b>{money(uahJars.reduce((sum, j) => sum + j.balance, 0))}</b></span>}
      </div>

      <h3>Банки Monobank</h3>
      {s.jars.length === 0 ? (
        <Empty>
          {connected ? 'У підключених людей поки немає банок.' : 'Підключи Monobank — тут будуть видні банки й скільки в них накопичено.'}
          {!connected && <> <button className="link" onClick={openSettings}>Підключити</button></>}
        </Empty>
      ) : (
        <ul className="jars">
          {s.jars.map((j) => (
            <li key={j.id}>
              <span className="jar-head"><b>{j.title}</b><small>{j.member}</small></span>
              <span className="jar-sum">
                <b>{money(j.balance, { currency: j.currency })}</b>
                {j.goal ? <small>з {money(j.goal, { currency: j.currency })} · {Math.floor((j.balance / j.goal) * 100)}%</small> : <small>без цілі</small>}
              </span>
              {j.goal ? <Progress value={j.balance} max={j.goal} kind="savings" /> : null}
            </li>
          ))}
        </ul>
      )}

      <h3>Перерозподіл на {monthIn(month)}</h3>
      {s.moves.length === 0 ? (
        <Empty>Не вкладаєтесь чи треба разово більше? Перекинь суму між кошиками лише на цей місяць — напр., 12 500 із заощаджень на погашення кредиту.</Empty>
      ) : (
        <ul className="list">
          {s.moves.map((m) => (
            <li key={m.id}>
              <span className="lead"><Icon name="arrow" size={18} /></span>
              <span className="row-main static">
                <span className="t">{FROM[m.from]} {TO[m.to]}</span>
                {m.note && <small>{m.note}{m.need_id ? ' · разовий платіж у потребах' : ''}</small>}
              </span>
              <span className="amt">{money(m.amount)}</span>
              <button className="icon-btn" aria-label="Скасувати перерозподіл" onClick={() => act(() => api.del(`/api/moves/${m.id}`))}><Icon name="trash" size={18} /></button>
            </li>
          ))}
        </ul>
      )}
      <button className="add" onClick={() => setMove(true)}><Icon name="plus" />Перерозподілити</button>
      {move && <MoveSheet onClose={() => setMove(false)} />}
    </section>
  );
}

function MoveSheet({ onClose }: { onClose: () => void }) {
  const { data, month, act } = useApp();
  const [from, setFrom] = useState<B>('savings');
  const [to, setTo] = useState<B>('needs');
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [asNeed, setAsNeed] = useState(true);
  const left = data.summary.buckets[from].allocated;
  const options = (Object.keys(BUCKETS) as B[]).map((k): [B, string] => [k, BUCKETS[k].short]);

  const save = async () => {
    const ok = await act(() => api.post('/api/moves', { month, from, to, amount, note, as_need: to === 'needs' && asNeed }));
    if (ok) onClose();
  };

  return (
    <Sheet title={`Перерозподіл на ${monthIn(month)}`} onClose={onClose}>
      <Field label="Звідки"><Segmented label="Звідки" value={from} onChange={(v) => { setFrom(v); if (v === to) setTo(v === 'needs' ? 'wants' : 'needs'); }} options={options} /></Field>
      <Field label="Куди"><Segmented label="Куди" value={to} onChange={(v) => { setTo(v); if (v === from) setFrom(v === 'savings' ? 'needs' : 'savings'); }} options={options} /></Field>
      <MoneyField label="Сума" value={amount} onChange={setAmount} hint={`У кошику «${BUCKETS[from].short}» на цей місяць ${money(left)}`} />
      <Field label="На що"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Погашення кредиту" /></Field>
      {to === 'needs' && (
        <Switch on={asNeed} onChange={setAsNeed} title="Додати разовим платежем у потреби" hint="З'явиться в списку потреб лише цього місяця, з галочкою «сплачено»" />
      )}
      <div className="actions">
        <button className="btn primary" disabled={!amount || from === to} onClick={save}>Перерозподілити</button>
      </div>
    </Sheet>
  );
}
