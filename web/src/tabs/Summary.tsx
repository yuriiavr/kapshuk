// Підсумок місяця: куди пішли гроші (категорії, магазини), що саме купували (товари з чеків) і від чого можна відмовитись
import { useEffect, useState, type CSSProperties } from 'react';
import { api, type Advice, type Category, type ItemGroup, type MonthReport } from '../api.ts';
import { ago, CATEGORIES, money, monthIn } from '../format.ts';
import { Bar, Empty, Icon, Progress, useApp } from '../ui.tsx';
import { plural } from '../Receipt.tsx';

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
/** ШІ інколи все ж виділяє **так** — показуємо жирним, а не зірочками */
const rich = (text: string) => text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part.replace(/^#+\s*/gm, '')));

export function Summary({ onCategory }: { onCategory: (c: Category) => void }) {
  const { data, month, version } = useApp();
  const [report, setReport] = useState<MonthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState<ItemGroup | null>(null);

  useEffect(() => {
    let live = true;
    api.get<MonthReport>(`/api/summary?month=${month}`)
      .then((r) => live && (setReport(r), setAdvice(r.advice), setError(null)))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [month, version]);

  useEffect(() => {
    setReport(null);
    setAdvice(null);
    setOpen(null);
  }, [month]);

  const ask = async (refresh: boolean) => {
    setAsking(true);
    setError(null);
    try {
      setAdvice(await api.post<Advice>(`/api/advice?month=${month}`, { refresh }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAsking(false);
    }
  };

  const s = data.summary;
  const cats = (report?.categories ?? s.categories).filter((c) => c.total > 0);
  const catsTotal = cats.reduce((sum, c) => sum + c.total, 0);
  const it = report?.items;

  return (
    <section>
      <div className="sum">
        <span>Витрачено <b>{money(s.spent)}</b></span>
        <span>надійшло <b>{money(s.income_actual)}</b></span>
        {s.saved > 0 && <span>у банки <b>{money(s.saved)}</b></span>}
      </div>
      {error && <p className="warn">{error}</p>}

      <h3>Куди пішли гроші</h3>
      {cats.length === 0 ? <Empty>У {monthIn(month)} витрат ще немає.</Empty> : (
        <ul className="list cats">
          {cats.map((c) => (
            <li key={c.category}>
              <button className="row-main" onClick={() => onCategory(c.category)}>
                <span className="t"><i className="dot" style={{ '--c': CATEGORIES[c.category].color } as CSSProperties} />{CATEGORIES[c.category].title}</span>
                <Bar value={c.total} max={cats[0].total} color={CATEGORIES[c.category].color} />
                <small>{c.n} {plural(c.n, 'платіж', 'платежі', 'платежів')} · {pct(c.total, catsTotal)}%</small>
              </button>
              <span className="amt">{money(c.total)}</span>
            </li>
          ))}
        </ul>
      )}

      {report && report.merchants.length > 0 && (
        <>
          <h3>Де витрачали найбільше</h3>
          <ul className="list compact">
            {report.merchants.map((m) => (
              <li key={m.description}>
                <span className="row-main static">
                  <span className="t">{m.description}</span>
                  <small>{m.n} {plural(m.n, 'раз', 'рази', 'разів')}</small>
                </span>
                <span className="amt">{money(m.total)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Що купували</h3>
      {!it ? <p className="hint">Рахую…</p> : it.purchases === 0 ? (
        <Empty>Сфотографуй чек (кнопка «Чек» унизу) або відкрий операцію й допиши товари — тут буде видно, що саме купуєте й на що йде найбільше.</Empty>
      ) : (
        <>
          <div className="coverage">
            <span className="hint">По товарах розписано {money(it.covered)} з {money(it.spent)} · {it.purchases} {plural(it.purchases, 'покупка', 'покупки', 'покупок')}</span>
            <Bar value={it.covered} max={it.spent} color="var(--accent)" />
          </div>
          <ul className="list groups">
            {it.groups.map((g) => (
              <li key={g.group} className={open === g.group ? 'open' : ''}>
                <button className="row-main" aria-expanded={open === g.group} onClick={() => setOpen(open === g.group ? null : g.group)}>
                  <span className="t">{g.title}</span>
                  <small>{g.top.slice(0, 4).map((t) => t.title).join(', ')}</small>
                </button>
                <span className="amt">{money(g.total)}</span>
                {open === g.group && (
                  <ul className="sub-list">
                    {g.top.map((t) => (
                      <li key={t.title}><span>{t.title}{t.n > 1 ? <small> ×{t.n}</small> : null}</span><span>{money(t.total, { exact: true })}</span></li>
                    ))}
                    {g.n > g.top.reduce((n, t) => n + t.n, 0) && <li className="more"><span>і ще дещо</span></li>}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          {it.frequent.length > 0 && (
            <>
              <h3>Купували найчастіше</h3>
              <ul className="list compact">
                {it.frequent.map((t) => (
                  <li key={t.title}>
                    <span className="row-main static"><span className="t">{t.title}</span><small>{t.n} {plural(t.n, 'раз', 'рази', 'разів')}</small></span>
                    <span className="amt">{money(t.total)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <h3>Від чого можна відмовитись</h3>
      <div className="card advice">
        {advice ? (
          <>
            <p className="advice-text">{rich(advice.text)}</p>
            <small className="hint">Порада ШІ · {ago(advice.created_at)}</small>
          </>
        ) : (
          <p className="hint">ШІ подивиться, на що й де витрачали в {monthIn(month)}, і підкаже, що можна скоротити. Що більше чеків — то точніше.</p>
        )}
        <div className="actions">
          <button className="btn" disabled={asking || s.spent <= 0} onClick={() => ask(!!advice)}>
            <Icon name="sparkle" />{asking ? 'Думаю…' : advice ? 'Оновити пораду' : 'Спитати ШІ'}
          </button>
        </div>
      </div>

      {s.jars.length > 0 && (
        <>
          <h3>Банки Monobank</h3>
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
        </>
      )}
    </section>
  );
}
