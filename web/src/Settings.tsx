// Налаштування: сім'я з Monobank, запам'ятані магазини
import { useEffect, useState } from 'react';
import { api, type Category, type Member, type TxBucket } from './api.ts';
import { ago, CATEGORIES, KINDS, money } from './format.ts';
import { Field, Icon, Sheet, Switch, useApp } from './ui.tsx';

export function Settings({ onClose }: { onClose: () => void }) {
  const { data, act } = useApp();
  const [adding, setAdding] = useState(false);

  return (
    <Sheet title="Налаштування" onClose={onClose} wide>
      <h3>Сім'я та Monobank</h3>
      <p className="hint">Кожен підключає свій Monobank сам: картки й банки підтягуються кожні кілька хвилин. Перекази між вами не рахуються витратами.</p>
      <div className="members">
        {data.members.map((m) => <MemberCard key={m.id} m={m} />)}
      </div>
      {adding ? <AddMember onDone={() => setAdding(false)} /> : <button className="add" onClick={() => setAdding(true)}><Icon name="plus" />Додати людину</button>}

      <Rules />

      <div className="actions spread">
        <button className="btn" onClick={() => act(() => api.post('/api/sync'))}><Icon name="sync" />Оновити з банку зараз</button>
        <button className="btn" onClick={() => api.logout().then(() => location.reload())}>Вийти</button>
      </div>
    </Sheet>
  );
}

function TokenHint() {
  return (
    <>
      Відкрий <a href="https://api.monobank.ua/" target="_blank" rel="noopener noreferrer">api.monobank.ua</a>, підтверди вхід у застосунку
      Monobank і скопіюй токен сюди. Токен дає лише перегляд балансу й виписки — переказувати гроші з ним не можна. Зберігається тільки на ноутбуці вдома.
    </>
  );
}

function AddMember({ onDone }: { onDone: () => void }) {
  const { act } = useApp();
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const ok = await act(() => api.post('/api/members', { name, token: token.trim() || undefined }));
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <div className="card form">
      <Field label="Ім'я"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Юра" /></Field>
      <Field label="Токен Monobank" hint={<TokenHint />}>
        <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="можна додати пізніше" />
      </Field>
      <div className="actions">
        <button className="btn" onClick={onDone}>Скасувати</button>
        <button className="btn primary" disabled={!name.trim() || busy} onClick={save}>{busy ? 'Перевіряю токен…' : 'Додати'}</button>
      </div>
    </div>
  );
}

function MemberCard({ m }: { m: Member }) {
  const { act } = useApp();
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cards = m.accounts.filter((a) => a.kind === 'card');
  const jars = m.accounts.filter((a) => a.kind === 'jar');

  const saveToken = async () => {
    setBusy(true);
    const ok = await act(() => api.patch(`/api/members/${m.id}`, { token }));
    setBusy(false);
    if (ok) {
      setTokenOpen(false);
      setToken('');
    }
  };

  return (
    <div className="card member">
      <div className="member-head">
        <span><b>{m.name}</b>{m.mono_name && <small>{m.mono_name}</small>}</span>
        <small className={m.last_error ? 'warn' : m.connected ? 'ok' : ''}>
          {m.last_error ? m.last_error : m.connected ? `Monobank · оновлено ${ago(m.info_at)}` : 'без банку'}
        </small>
      </div>
      {cards.length > 0 && (
        <div className="accounts">
          {cards.map((a) => (
            <Switch key={a.id} on={a.include} disabled={a.currency !== 980} title={a.title}
              hint={a.currency !== 980 ? 'Валютні картки не рахуються' : `${money(a.balance, { currency: a.currency })} · ${a.include ? 'рахується' : 'не рахується'}`}
              onChange={(include) => act(() => api.patch(`/api/accounts/${encodeURIComponent(a.id)}`, { include }))} />
          ))}
          {jars.map((a) => (
            <Switch key={a.id} on={a.include} title={`Банка «${a.title}»`} hint={`${money(a.balance, { currency: a.currency })}${a.goal ? ` з ${money(a.goal, { currency: a.currency })}` : ''} · ${a.include ? 'показую' : 'сховано'}`}
              onChange={(include) => act(() => api.patch(`/api/accounts/${encodeURIComponent(a.id)}`, { include }))} />
          ))}
        </div>
      )}
      {tokenOpen && (
        <Field label={m.connected ? 'Новий токен Monobank' : 'Токен Monobank'} hint={<TokenHint />}>
          <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
        </Field>
      )}
      <div className="actions">
        {tokenOpen ? (
          <>
            <button className="btn" onClick={() => setTokenOpen(false)}>Скасувати</button>
            <button className="btn primary" disabled={!token.trim() || busy} onClick={saveToken}>{busy ? 'Перевіряю…' : 'Підключити'}</button>
          </>
        ) : confirmDelete ? (
          <>
            <button className="btn" onClick={() => setConfirmDelete(false)}>Ні</button>
            <button className="btn danger" onClick={() => act(() => api.del(`/api/members/${m.id}`))}>Так, прибрати {m.name}</button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => setTokenOpen(true)}>{m.connected ? 'Новий токен' : 'Підключити Monobank'}</button>
            {m.connected && <button className="btn" onClick={() => act(() => api.patch(`/api/members/${m.id}`, { disconnect: true }))}>Відключити банк</button>}
            <button className="btn danger" onClick={() => setConfirmDelete(true)}><Icon name="trash" />Прибрати</button>
          </>
        )}
      </div>
    </div>
  );
}

function Rules() {
  const { version, act } = useApp();
  const [rules, setRules] = useState<{ pattern: string; bucket: TxBucket; category: Category | null }[]>([]);
  useEffect(() => {
    api.get<typeof rules>('/api/rules').then(setRules).catch(() => {});
  }, [version]);
  if (!rules.length) return null;
  return (
    <>
      <h3>Запам'ятані магазини</h3>
      <ul className="list compact">
        {rules.map((r) => (
          <li key={r.pattern}>
            <span className="row-main static"><span className="t">{r.pattern}</span><small>→ {ruleTitle(r)}</small></span>
            <button className="icon-btn" aria-label={`Забути ${r.pattern}`} onClick={() => act(() => api.del(`/api/rules?pattern=${encodeURIComponent(r.pattern)}`))}><Icon name="trash" size={18} /></button>
          </li>
        ))}
      </ul>
    </>
  );
}

function ruleTitle(r: { bucket: TxBucket; category: Category | null }) {
  if (r.bucket !== 'spend') return KINDS[r.bucket]?.title ?? r.bucket;
  return r.category ? CATEGORIES[r.category]?.title ?? r.category : 'витрата (категорія з банку)';
}
