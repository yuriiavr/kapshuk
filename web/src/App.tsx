import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, AuthError, type Category, type State } from './api.ts';
import { addMonths, CATEGORIES, money, monthIn, monthLabel } from './format.ts';
import { AppCtx, Icon, type App as AppValue } from './ui.tsx';
import { plural, ReceiptButton } from './Receipt.tsx';
import { Needs } from './tabs/Needs.tsx';
import { Wants } from './tabs/Wants.tsx';
import { Summary } from './tabs/Summary.tsx';
import { Transactions } from './tabs/Transactions.tsx';
import { Settings } from './Settings.tsx';

type Tab = 'tx' | 'sum' | 'needs' | 'wants';
const TABS: [Tab, string][] = [['tx', 'Витрати'], ['sum', 'Підсумок'], ['needs', 'Платежі'], ['wants', 'Хочу купити']];
const TAB_KEY = 'kapshuk:tab:v2';

function savedTab(): Tab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (TABS.some(([k]) => k === t)) return t as Tab;
  } catch {}
  return 'tx';
}

export function App() {
  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<State | null>(null);
  const [auth, setAuth] = useState<'loading' | 'ok' | 'need'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [tab, setTabState] = useState<Tab>(savedTab);
  const [category, setCategory] = useState<Category | null>(null);
  const [settings, setSettings] = useState(false);
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
  const showCategory = (c: Category) => {
    setCategory(c);
    setTab('tx');
  };

  if (auth === 'need') return <Login />;
  if (!data || !month) {
    return <div className="splash">{error ? <p>{error}</p> : <p>Відкриваю Капшук…</p>}</div>;
  }

  const ctx: AppValue = { data, month, act, reload, version };
  const s = data.summary;
  const cats = s.categories.filter((c) => c.total > 0);
  const legend = cats.slice(0, 5);

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

        <div className="spent-card">
          <div className="spent-head">
            <span className="spent-main">
              <small>Витрачено в {monthIn(month)}</small>
              <b>{money(s.spent)}</b>
            </span>
            <span className="spent-side">
              <small>надійшло</small>
              <span className="pos">{money(s.income_actual)}</span>
              {s.saved > 0 && <><small>у банки</small><span>{money(s.saved)}</span></>}
            </span>
          </div>
          {cats.length > 0 && (
            <>
              <div className="stack" aria-hidden="true">
                {cats.map((c) => <i key={c.category} style={{ flexGrow: c.total, background: CATEGORIES[c.category].color }} />)}
              </div>
              <div className="legend">
                {legend.map((c) => (
                  <button key={c.category} className={category === c.category && tab === 'tx' ? 'on' : ''} style={{ '--c': CATEGORIES[c.category].color } as CSSProperties}
                    onClick={() => (category === c.category && tab === 'tx' ? setCategory(null) : showCategory(c.category))}>
                    <i className="dot" /><span>{CATEGORIES[c.category].title}</span><b>{money(c.total)}</b>
                  </button>
                ))}
                {cats.length > legend.length && (
                  <button className="more" onClick={() => setTab('sum')}>
                    <span>Ще {cats.length - legend.length} {plural(cats.length - legend.length, 'категорія', 'категорії', 'категорій')}</span>
                    <b>{money(cats.slice(legend.length).reduce((sum, c) => sum + c.total, 0))}</b><Icon name="right" size={14} />
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <nav className="tabs" role="tablist">
          {TABS.map(([k, title]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {title}
              {k === 'needs' && s.needs_plan.count - s.needs_plan.paid_count > 0 && month === data.today && (
                <i className="badge" title="Ще не сплачено">{s.needs_plan.count - s.needs_plan.paid_count}</i>
              )}
            </button>
          ))}
        </nav>

        <main>
          {tab === 'tx' && <Transactions category={category} setCategory={setCategory} />}
          {tab === 'sum' && <Summary onCategory={showCategory} />}
          {tab === 'needs' && <Needs />}
          {tab === 'wants' && <Wants />}
        </main>
      </div>

      <ReceiptButton className="fab" title="Сфотографувати чек"><Icon name="camera" size={22} />Чек</ReceiptButton>
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
      <p>Витрати сім'ї: що, де й за скільки купуємо. Відкривається з панелі Home Assistant, або увійди тут своїм входом у HA.</p>
      {expired && <p className="warn">{expired === 'expired' ? 'Посилання входу вже використане чи застаріле.' : 'Не вдалося увійти через HA.'}</p>}
      <a className="btn primary" href="/login">Увійти через Home Assistant</a>
    </div>
  );
}
