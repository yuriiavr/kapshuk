import { useCallback, useEffect, useRef, useState } from 'react';
import { api, AuthError, type State } from './api.ts';
import { addMonths, BUCKETS, money, monthLabel } from './format.ts';
import { AppCtx, Icon, MoneyField, Progress, Sheet, useApp, type App as AppValue } from './ui.tsx';
import { Needs } from './tabs/Needs.tsx';
import { Wants } from './tabs/Wants.tsx';
import { Savings } from './tabs/Savings.tsx';
import { Transactions } from './tabs/Transactions.tsx';
import { Settings } from './Settings.tsx';

type Tab = 'needs' | 'wants' | 'savings' | 'tx';
const TABS: [Tab, string][] = [['needs', 'Потреби'], ['wants', 'На себе'], ['savings', 'Заощадження'], ['tx', 'Операції']];
const TAB_KEY = 'kapshuk:tab';

function savedTab(): Tab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (TABS.some(([k]) => k === t)) return t as Tab;
  } catch {}
  return 'needs';
}

export function App() {
  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<State | null>(null);
  const [auth, setAuth] = useState<'loading' | 'ok' | 'need'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [tab, setTabState] = useState<Tab>(savedTab);
  const [settings, setSettings] = useState(false);
  const [plan, setPlan] = useState(false);
  const monthRef = useRef(month);
  monthRef.current = month;

  const reload = useCallback(async () => {
    try {
      const s = await api.state(monthRef.current);
      setData(s);
      setAuth('ok');
      setVersion((v) => v + 1);
      if (!monthRef.current) setMonth(s.summary.month);
    } catch (err) {
      if (err instanceof AuthError) setAuth('need');
      else setError((err as Error).message);
    }
  }, []);

  useEffect(() => void reload(), [month, reload]);

  // Банк підтягується у фоні — оновлюємо раз на хвилину й коли сторінку знову показали
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === 'visible' && void reload(), 60e3);
    const onVisible = () => document.visibilityState === 'visible' && void reload();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
      return true;
    } catch (err) {
      if (err instanceof AuthError) setAuth('need');
      else setError((err as Error).message);
      return false;
    }
  }, [reload]);

  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {}
  };

  if (auth === 'need') return <Login />;
  if (!data || !month) {
    return <div className="splash">{error ? <p>{error}</p> : <p>Відкриваю Капшук…</p>}</div>;
  }

  const ctx: AppValue = { data, month, act, reload, version };
  const s = data.summary;

  return (
    <AppCtx.Provider value={ctx}>
      <div className="page">
        <header className="top">
          <div className="months">
            <button className="icon-btn" onClick={() => setMonth(addMonths(month, -1))} aria-label="Попередній місяць"><Icon name="left" /></button>
            <h1>{monthLabel(month)}</h1>
            <button className="icon-btn" onClick={() => setMonth(addMonths(month, 1))} aria-label="Наступний місяць"><Icon name="right" /></button>
          </div>
          <div className="top-tools">
            {month !== data.today && <button className="pill" onClick={() => setMonth(data.today)}>Сьогодні</button>}
            <button className="icon-btn" onClick={() => setSettings(true)} aria-label="Налаштування"><Icon name="sliders" /></button>
          </div>
        </header>

        <button className="income-card" onClick={() => setPlan(true)}>
          <span className="income-main">
            <small>Дохід на місяць{s.custom ? ' · свій план' : ''}</small>
            <b>{s.income ? money(s.income) : 'Вкажи дохід'}</b>
          </span>
          <span className="income-side">
            <small>надійшло</small>
            <span>{money(s.income_actual)}</span>
          </span>
        </button>

        <div className="buckets">
          {(['needs', 'wants', 'savings'] as const).map((k) => {
            const bk = s.buckets[k];
            const saving = k === 'savings';
            const over = !saving && bk.left < 0;
            return (
              <button key={k} className={`bucket ${k} ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
                <span className="b-head"><span>{BUCKETS[k].short}</span><small>{bk.pct}%</small></span>
                <b className={over ? 'neg' : ''}>{money(saving ? Math.max(0, bk.left) : bk.left)}</b>
                <small className="b-sub">{saving ? (bk.left > 0 ? 'ще відкласти' : 'план виконано') : over ? 'перевитрата' : 'лишилось'}</small>
                <Progress value={bk.spent} max={bk.allocated} kind={k} />
                <small className="b-foot"><span className="word">{saving ? 'відкладено' : 'витрачено'} </span>{money(bk.spent)} з {money(bk.allocated)}</small>
              </button>
            );
          })}
        </div>

        <nav className="tabs" role="tablist">
          {TABS.map(([k, title]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {title}
              {k === 'tx' && s.unchecked > 0 && <i className="badge" title="Розкладено автоматично — перевір">{s.unchecked}</i>}
            </button>
          ))}
        </nav>

        <main>
          {tab === 'needs' && <Needs />}
          {tab === 'wants' && <Wants />}
          {tab === 'savings' && <Savings openSettings={() => setSettings(true)} />}
          {tab === 'tx' && <Transactions />}
        </main>
      </div>

      {plan && <MonthPlan onClose={() => setPlan(false)} />}
      {settings && <Settings onClose={() => setSettings(false)} />}
      {error && <div className="toast" role="alert" onClick={() => setError(null)}>{error}</div>}
    </AppCtx.Provider>
  );
}

function Login() {
  const expired = new URLSearchParams(location.search).get('login');
  return (
    <div className="splash login">
      <img src="/icon.svg" alt="" width="72" height="72" />
      <h1>Капшук</h1>
      <p>Сімейний бюджет. Відкривається з панелі Home Assistant, або увійди тут своїм входом у HA.</p>
      {expired && <p className="warn">{expired === 'expired' ? 'Посилання входу вже використане чи застаріле.' : 'Не вдалося увійти через HA.'}</p>}
      <a className="btn primary" href="/login">Увійти через Home Assistant</a>
    </div>
  );
}

/** План місяця: дохід і відсотки лише на цей місяць */
function MonthPlan({ onClose }: { onClose: () => void }) {
  const { data, month, act } = useApp();
  const s = data.summary;
  const [income, setIncome] = useState<number | null>(s.income);
  const [pct, setPct] = useState({ needs: s.buckets.needs.pct, wants: s.buckets.wants.pct, savings: s.buckets.savings.pct });
  const total = pct.needs + pct.wants + pct.savings;
  const valid = income != null && total === 100;
  const d = data.defaults;

  const save = async (asDefault: boolean) => {
    const body = { income, needs_pct: pct.needs, wants_pct: pct.wants, savings_pct: pct.savings };
    if (await act(() => (asDefault ? api.put('/api/defaults', body).then(() => api.put(`/api/months/${month}`, { reset: true })) : api.put(`/api/months/${month}`, body)))) onClose();
  };

  return (
    <Sheet title={`План: ${monthLabel(month)}`} onClose={onClose}>
      <MoneyField label="Дохід сім'ї на місяць" value={income} onChange={setIncome} hint={`Типово ${money(d.income)}. Розподіляється на кошики нижче.`} />
      <div className="pcts">
        {(['needs', 'wants', 'savings'] as const).map((k) => (
          <label key={k} className={`pct ${k}`}>
            <span>{BUCKETS[k].short}</span>
            <span className="pct-in">
              <input inputMode="numeric" value={String(pct[k])} onChange={(e) => setPct({ ...pct, [k]: Number(e.target.value.replace(/\D/g, '')) || 0 })} />%
            </span>
            <small>{money(Math.round(((income ?? 0) * pct[k]) / 100))}</small>
          </label>
        ))}
      </div>
      {total !== 100 && <p className="warn">Разом {total}% — має бути 100%</p>}
      <p className="hint">Не вкладаєтесь? Перекинути суму між кошиками на цей місяць можна в «Заощадження → Перерозподіл».</p>
      <div className="actions">
        {s.custom && <button className="btn" onClick={() => act(() => api.put(`/api/months/${month}`, { reset: true })).then((ok) => ok && onClose())}>Як типово</button>}
        <button className="btn" disabled={!valid} onClick={() => save(true)}>Зробити типовим</button>
        <button className="btn primary" disabled={!valid} onClick={() => save(false)}>Лише цей місяць</button>
      </div>
    </Sheet>
  );
}
