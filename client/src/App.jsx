import React, { useEffect, useRef, useState } from 'react';
import Avatar, { PixelAvatar, LOOK_DEFAULT, HAIR_STYLES, EYE_STYLES, MOUTH_STYLES, OUTFIT_STYLES } from './Avatar.jsx';
import Scene, { LOCS, adjacent } from './Scene.jsx';

// 岛上小人用哪种渲染：普通模式走矢量，墨水屏模式走真栅格化（见 Avatar.jsx 的 PixelAvatar）。
// 之所以跟墨水屏绑在一起：低分辨率和有限灰阶是同一套视觉前提，分开开关只是徒增选项。
const AvatarFor = (pixel) => (pixel ? PixelAvatar : Avatar);

const api = async (path, body, method = 'POST') => {
  const r = await fetch(path, body && {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
};

export default function App() {
  const [tab, setTab] = useState('island');         // island | chats | feed —— 岛是主界面
  const [state, setState] = useState(null);
  const [room, setRoom] = useState(null);           // 当前聊天角色 id
  const [card, setCard] = useState(null);           // 角色卡（朋友收集式：点小人先出卡）
  const [catchup, setCatchup] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  const [dev, setDev] = useState(false);
  // 墨水屏模式：0=关 2=1bit黑白 4=四阶灰。数字就是量化的灰阶数。
  const [eink, setEink] = useState(() => Number(localStorage.getItem('eink') || 0));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => { localStorage.setItem('eink', String(eink)); }, [eink]);

  const refresh = () => api('/api/state').then(setState);

  useEffect(() => {
    api('/api/open', {}).then(r => {
      if (r.catchup) setCatchup(r.catchup);
      refresh();
    });
    const iv = setInterval(refresh, 25000);   // 未读角标 / 睡眠状态 / 主动消息浮现
    return () => clearInterval(iv);
  }, []);

  const toggleFreeze = async () => {
    await api('/api/freeze', { frozen: !state.frozen });
    refresh();
  };

  if (!state) return <div className="phone loading">上岛中…</div>;

  return (
    <div className={'phone' + (eink ? ` eink eink-${eink}` : '')}>
      {eink > 0 && <EinkFilters />}
      {eink > 0 && <div className="eink-dither" aria-hidden />}
      <header>
        <span className="hud">
          🏝 <b>窥岛</b>
          <i className="hud-chip">Lv.{state.island?.level ?? 1}</i>
          <i className="hud-chip">{state.slot}</i>
          <i className="hud-chip">{happyFace(state.island?.happiness ?? 60)} {state.island?.happiness ?? 60}</i>
        </span>
        <div className="head-actions">
          <button className={'icon-btn' + (eink ? ' on' : '')} title="墨水屏模式：关 → 四阶灰 → 纯黑白"
            onClick={() => setEink(e => {
              const next = e === 0 ? 4 : e === 4 ? 2 : 0;
              if (next) setTheme('light');   // 墨水屏是反射式的纸，没有背光——暗色主题灰度化后是一块黑纸
              return next;
            })}>
            {eink === 0 ? '🖥' : eink === 4 ? '📄' : '◧'}
          </button>
          <button className="icon-btn" title="切换明暗"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <button className={'icon-btn' + (dev ? ' on' : '')} title="AI 引擎"
            onClick={() => setDev(d => !d)}>⚙️</button>
          <button className={state.frozen ? 'freeze on' : 'freeze'} onClick={toggleFreeze}>
            {state.frozen ? '❄️ 已冻结' : '⏸ 离岛'}
          </button>
        </div>
      </header>

      {dev && <ProviderPanel onClose={() => setDev(false)} />}

      {catchup && (
        <div className="catchup" onClick={() => setCatchup(null)}>
          你离开了约 {catchup.away_hours} 小时。岛上的日子照常在过——去看看吧。（点按关闭）
        </div>
      )}

      {state.frozen && <div className="frozen-note">时间冻结中：不消耗任何 AI 额度，世界静止。</div>}

      {room
        ? <ChatRoom charId={room} chars={state.characters} onBack={() => { setRoom(null); refresh(); }} frozen={state.frozen} />
        : tab === 'island'
          ? <Island chars={state.characters} island={state.island} onPick={setCard} pixel={eink > 0} />
          : tab === 'chats'
            ? <ChatList chars={state.characters} onOpen={setRoom} onChanged={refresh} />
            : <Feed frozen={state.frozen} />}

      {card && !room && (
        <CharCard char={state.characters.find(c => c.id === card)}
          onClose={() => { setCard(null); refresh(); }}
          onChat={(id) => { setCard(null); setRoom(id); }}
          frozen={state.frozen} onChanged={refresh} />
      )}

      {!room && (
        <nav>
          <button className={tab === 'island' ? 'active' : ''} onClick={() => setTab('island')}>岛</button>
          <button className={tab === 'chats' ? 'active' : ''} onClick={() => setTab('chats')}>消息</button>
          <button className={tab === 'feed' ? 'active' : ''} onClick={() => setTab('feed')}>朋友圈</button>
        </nav>
      )}
    </div>
  );
}

function ProviderPanel({ onClose }) {
  const [list, setList] = useState([]);
  const [lastError, setLastError] = useState(null);
  const [editing, setEditing] = useState(null);   // 正在填 key 的引擎 id
  const load = () => api('/api/providers').then(d => { setList(d.providers || (Array.isArray(d) ? d : [])); setLastError(d.lastError || null); });
  useEffect(() => { load(); }, []);
  const pick = async (id) => { await api('/api/provider', { provider: id }); load(); };
  return (
    <div className="dev-panel">
      <div className="dev-title">
        <span>AI 引擎</span>
        <button className="icon-btn" onClick={onClose}>×</button>
      </div>
      <div className="dev-grid">
        {list.map(p => (
          <button key={p.id}
            className={'engine' + (p.active ? ' on' : '') + (p.hasKey ? '' : ' nokey')}
            onClick={() => (p.hasKey ? pick(p.id) : setEditing(p.id))}
            title={p.hasKey ? p.model : '点一下填 key'}>
            <b>{p.label}</b>
            <small>{p.hasKey ? p.model : '点这里填 key'}</small>
            <i className="dot" />
          </button>
        ))}
      </div>

      {/* key 直接在这里填，不用改文件也不用重启。存本地库，只回显后四位 */}
      <div className="key-list">
        {list.map(p => (
          <div key={p.id} className="key-row">
            <span className="key-name">{p.label}</span>
            {editing === p.id
              ? <KeyInput id={p.id} onDone={() => { setEditing(null); load(); }} />
              : <>
                <span className={'key-state' + (p.hasKey ? ' ok' : '')}>
                  {p.hasKey ? p.hint : '未设置'}
                  {p.hasKey && !p.fromUI && <i className="key-src">来自 .env</i>}
                </span>
                <button className="key-btn" onClick={() => setEditing(p.id)}>
                  {p.hasKey ? '更换' : '填入'}
                </button>
              </>}
          </div>
        ))}
      </div>

      <NameSetting />
      <div className="dev-hint">
        key 存在本机 <b>island.db</b> 里，不上传任何服务器，界面只回显后四位；也可以继续用 <b>server/.env</b>。
        填完即时生效，不用重启。聊天框里用 <b>//开头</b> 发消息 = 对照实验：同一句话打给所有有 key 的引擎，不入库不加亲密。
      </div>
      {lastError && <div className="dev-error">⚠ 最近一次 AI 调用失败（已走脚本托底）：{lastError}</div>}
    </div>
  );
}

function KeyInput({ id, onDone }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    await api(`/api/provider/${id}/key`, { key: v }, 'PUT');
    setV('');                                   // 不在前端留存
    onDone();
  };
  return (
    <span className="key-edit">
      <input type="password" autoFocus placeholder="粘贴 key" value={v}
        onChange={e => setV(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && save()} />
      <button className="key-btn" disabled={busy} onClick={save}>存</button>
      <button className="key-btn ghost" onClick={onDone}>取消</button>
    </span>
  );
}

function NameSetting() {
  const [name, setName] = useState('');
  const [ok, setOk] = useState(false);
  useEffect(() => { api('/api/user').then(d => setName(d.name || '')); }, []);
  const save = async () => { await api('/api/user', { name }, 'PUT'); setOk(true); setTimeout(() => setOk(false), 900); };
  return (
    <div className="form-grid" style={{ marginTop: 10 }}>
      <input placeholder="你的名字（角色会这么喊你）" value={name} onChange={e => setName(e.target.value)} />
      <button className="save-btn" onClick={save}>{ok ? '✓' : '保存'}</button>
    </div>
  );
}

function ChatList({ chars, onOpen, onChanged }) {
  const [panel, setPanel] = useState(null);   // null | 'create' | 'import'
  return (
    <main className="list">
      <div className="list-actions">
        <button className="icon-btn" onClick={() => setPanel(panel === 'create' ? null : 'create')}>＋ 捏一个人</button>
        <button className="icon-btn" onClick={() => setPanel(panel === 'import' ? null : 'import')}>⇩ 导入角色码</button>
      </div>
      {panel === 'create' && <CreateChar onDone={() => { setPanel(null); onChanged(); }} />}
      {panel === 'import' && <ImportChar onDone={() => { setPanel(null); onChanged(); }} />}
      {chars.map(c => (
        <div key={c.id} className="row" onClick={() => onOpen(c.id)}>
          <span className="avatar">{c.look ? <Avatar look={c.look} size={30} /> : c.avatar}</span>
          <div className="row-mid">
            <b>{c.name}{c.asleep ? ' 💤' : ''} <i className="stage-chip">{stageName(c.intimacy)}</i>
              <i className="activity-chip">{c.activity}</i></b>
            <small>{c.last || '……'}</small>
          </div>
          {c.unread > 0 && <span className="badge">{c.unread}</span>}
        </div>
      ))}
    </main>
  );
}

function CreateChar({ onDone }) {
  const [f, setF] = useState({ name: '', avatar: '🌸', surface: '', inner: '', quirks: '', night_owl: false, romance_weight: 0.5, crack_custom: '' });
  const [look, setLook] = useState({ ...LOOK_DEFAULT });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const cyc = (k, n) => () => setLook(l => ({ ...l, [k]: ((l[k] || 0) + 1) % n }));
  const setL = (k) => (e) => setLook(l => ({ ...l, [k]: e.target.value }));
  const submit = async () => {
    if (!f.name.trim()) return alert('起个名字');
    await api('/api/characters', {
      ...f, look, quirks: f.quirks.split(/[，,、]/).map(s => s.trim()).filter(Boolean),
      romance_weight: Number(f.romance_weight),
    });
    onDone();
  };
  return (
    <div className="persona-panel">
      <div className="dev-title"><span>捏一个人</span></div>
      <div className="maker">
        <div className="maker-preview"><Avatar look={look} size={78} /></div>
        <div className="maker-ctrl">
          <div className="maker-row">
            <button className="icon-btn" onClick={cyc('hairStyle', HAIR_STYLES)}>发型</button>
            <button className="icon-btn" onClick={cyc('eyes', EYE_STYLES)}>眼睛</button>
            <button className="icon-btn" onClick={cyc('mouth', MOUTH_STYLES)}>嘴</button>
          </div>
          <div className="maker-row">
            <button className="icon-btn" onClick={cyc('outfitStyle', OUTFIT_STYLES)}>衣服</button>
            <button className="icon-btn" onClick={() => setLook(l => ({ ...l, blush: l.blush ? 0 : 1 }))}>腮红</button>
            <button className="icon-btn" onClick={() => setLook({ ...LOOK_DEFAULT, hairStyle: Math.floor(Math.random() * HAIR_STYLES), eyes: Math.floor(Math.random() * EYE_STYLES), mouth: Math.floor(Math.random() * MOUTH_STYLES), outfitStyle: Math.floor(Math.random() * OUTFIT_STYLES), hair: `hsl(${Math.random() * 60 + 10} 40% ${20 + Math.random() * 30}%)`, outfit: `hsl(${Math.random() * 360} 55% 60%)`, blush: Math.random() < .5 ? 1 : 0 })}>🎲</button>
          </div>
          <div className="maker-row swatches">
            <label>肤<input type="color" value={look.skin} onChange={setL('skin')} /></label>
            <label>发<input type="color" value={look.hair} onChange={setL('hair')} /></label>
            <label>衣<input type="color" value={look.outfit} onChange={setL('outfit')} /></label>
            <label className="hgt">高<input type="range" min="0.85" max="1.15" step="0.01" value={look.height} onChange={setL('height')} /></label>
          </div>
        </div>
      </div>
      <div className="form-grid">
        <input placeholder="名字（必填）" value={f.name} onChange={set('name')} />
        <input placeholder="备用 emoji" value={f.avatar} onChange={set('avatar')} style={{ width: 80 }} />
      </div>
      <textarea rows={2} placeholder="表层性格：别人看到的TA（如：嘴硬心软，爱抬杠但记得每件小事）" value={f.surface} onChange={set('surface')} />
      <textarea rows={2} placeholder="内层习惯：独处时的样子（如：会对着窗台的植物说话）" value={f.inner} onChange={set('inner')} />
      <input placeholder="怪癖，用逗号分隔（最多5个）" value={f.quirks} onChange={set('quirks')} />
      <textarea rows={2} placeholder="（可选但强烈建议）TA的裂缝台词——TA发现你存在那一刻说的话。留空用通用兜底" value={f.crack_custom} onChange={set('crack_custom')} />
      <div className="form-row">
        <label><input type="checkbox" checked={f.night_owl} onChange={set('night_owl')} /> 夜猫子</label>
        <label>恋爱倾向 {Number(f.romance_weight).toFixed(1)}
          <input type="range" min="0" max="1" step="0.1" value={f.romance_weight} onChange={set('romance_weight')} />
        </label>
      </div>
      <div className="dev-hint">恋爱倾向 ≥0.8 才可能触发第四面墙。好恶随机生成——喂了才知道TA爱吃什么。</div>
      <div className="persona-actions"><span /><button className="save-btn" onClick={submit}>上岛</button></div>
    </div>
  );
}

function ImportChar({ onDone }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    const r = await api('/api/characters/import', { code: code.trim() });
    if (r.error) return setErr('码不对，检查一下');
    onDone();
  };
  return (
    <div className="persona-panel">
      <div className="dev-title"><span>导入角色码</span></div>
      <textarea rows={3} placeholder="粘贴 PEEP1. 开头的角色码" value={code} onChange={e => setCode(e.target.value)} />
      {err && <div className="dev-error">{err}</div>}
      <div className="dev-hint">正式版每天限导入 2 个（稀缺感）；测试版不限。</div>
      <div className="persona-actions"><span /><button className="save-btn" onClick={submit}>上岛</button></div>
    </div>
  );
}

const REPLY_DEBOUNCE_MS = 1600;   // 你停手 1.6s 后 TA 才开始回——像真人等你说完

// 概念书 4.6：亲密度六阶段
function stageName(i) {
  if (i <= 20) return '陌生';
  if (i <= 50) return '相识';
  if (i <= 100) return '在意';
  if (i <= 150) return '亲近';
  if (i <= 200) return '深绑';
  return '羁绊';
}
const happyFace = (h) => h >= 75 ? '😊' : h >= 40 ? '😐' : '🥀';

const fmtClock = (t) => {
  const d = new Date(t || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function fmtTime(t) {
  const d = new Date(t), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

// 微信式时间轴：间隔>5分钟插一条时间分隔线；最后一条自己的消息挂已读/未读回执
function buildTimeline(msgs) {
  const out = [];
  let prev = 0;
  const lastMineIdx = msgs.reduce((acc, m, i) => (m.author_type === 'human' ? i : acc), -1);
  msgs.forEach((m, i) => {
    const t = m.deliver_at || m.created_at || Date.now();
    if (t - prev > 5 * 60e3) out.push({ divider: true, t, id: 'd' + t + '-' + (m.id ?? i) });
    prev = t;
    const receipt = (i === lastMineIdx)
      ? (m.seen_at && m.seen_at <= Date.now() ? '已读' : '未读')
      : null;
    out.push({ ...m, receipt });
  });
  return out;
}

function ChatRoom({ charId, chars, onBack, frozen }) {
  const me = chars.find(c => c.id === charId);
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);   // “对方正在输入…”
  const [editing, setEditing] = useState(false); // 人设面板
  const [crack, setCrack] = useState(null);      // 裂缝时刻全屏演出
  const [feeding, setFeeding] = useState(false); // 投喂托盘
  const [selMode, setSelMode] = useState(false); // 导出多选
  const [sel, setSel] = useState(new Set());
  const [copied, setCopied] = useState(false);
  const [mind, setMind] = useState(false);       // 透明面板
  const [tools, setTools] = useState(false);     // 工具折叠

  // 双击自己的消息 = 撤回。他看到过的话，他会记得你撤回过。
  const recall = async (m) => {
    if (m.author_type !== 'human' || m.meta?.recalled) return;
    if (!confirm('撤回这条消息？（如果TA已经看到了，TA会记得）')) return;
    const r = await api(`/api/rooms/${charId}/recall`, { event_id: m.id });
    if (r.noticed) setTimeout(() => alert('TA已经看到过这条消息了。'), 300);
    load();
  };

  const exportSel = async () => {
    const dbg = await api(`/api/rooms/${charId}/debug`);
    const picked = msgs.filter(m => sel.has(m.id));
    const lines = picked.map(m => {
      const who = m.author_type === 'human' ? '用户' : dbg.name;
      const tag = m.author_type === 'human' ? '' : (m.meta?.ai === false ? ' ·脚本' : ' ·AI') + (m.meta?.fx ? ` ·${m.meta.fx}` : '');
      return `[${who} ${fmtTime(m.deliver_at || m.created_at)}${tag}] ${m.body}`;
    }).join('\n');
    const head = `=== 窥岛对话导出 ===\n引擎:${dbg.provider} | 角色:${dbg.name}(${dbg.char_id}) | 亲密:${dbg.intimacy} 幸福:${dbg.happiness} | 第四面墙:${dbg.fourthwall} | 今日AI:${dbg.quota_used}条\n情绪:${dbg.mood || '无'} | 正在:${dbg.activity}${dbg.asleep ? '(睡)' : ''}\n对我的印象:${dbg.impression || '尚无'}\n近期记忆:\n${dbg.memories.map(m => '  - ' + m).join('\n')}\n--- 对话(${picked.length}条) ---\n`;
    try { await navigator.clipboard.writeText(head + lines); } catch {}
    setCopied(true); setTimeout(() => { setCopied(false); setSelMode(false); setSel(new Set()); }, 900);
  };
  const seenCracks = useRef(new Set(JSON.parse(localStorage.getItem('crack_seen') || '[]')));
  const bottom = useRef(null);
  const timer = useRef(null);
  const lastPending = useRef(null);
  const inFlight = useRef(false);        // 防止并发生成两条回复
  const rescued = useRef(new Set());     // 每条消息只补救一次

  // 节奏引擎：回复是"先生成后送达"的。这里只负责在正确的时刻显示 typing 和刷新。
  const fx = useRef([]);   // 待清理的 timeout
  const clearFx = () => { fx.current.forEach(clearTimeout); fx.current = []; };
  const scheduleDelivery = (deliverAt) => {
    clearFx();
    const wait = Math.max(deliverAt - Date.now(), 0);
    // 送达前 ~7 秒才"正在输入"——他先看到、想了想、才开始打字
    fx.current.push(setTimeout(() => setTyping(true), Math.max(wait - 7000, 0)));
    fx.current.push(setTimeout(() => { setTyping(false); load(); }, wait + 400));
  };

  // 服务器是真相之源：pending_at 随消息一起返回，重进房间/轮询都能恢复 typing 时机
  const load = () => api(`/api/rooms/${charId}/messages`).then(d => {
    const list = d.messages || [];
    setMsgs(list);
    // 裂缝时刻：一生一次的演出，第一次出现时全屏接管
    const c = list.find(m => m.meta?.fx === 'crack' && !seenCracks.current.has(m.id));
    if (c) setCrack(c);
    const p = d.pending_at || null;
    if (p && p !== lastPending.current) { lastPending.current = p; scheduleDelivery(p); }
    if (!p) lastPending.current = null;
    // 死锁补救：最后一条是你的消息、他从没"看到"过、也没有回复在路上
    // （回复在路上时又发了消息 / 发完就退出房间——这两种都会把消息晾死）
    const last = list[list.length - 1];
    if (last && last.author_type === 'human' && !last.seen_at && !p
        && !inFlight.current && !rescued.current.has(last.id)) {
      rescued.current.add(last.id);
      clearTimeout(timer.current);
      timer.current = setTimeout(triggerReply, 900);
    }
  });
  useEffect(() => { load(); return () => { clearTimeout(timer.current); clearFx(); }; }, [charId]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, typing]);

  const triggerReply = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const d = await api(`/api/rooms/${charId}/reply`, {});
      if (d.deliver_at) { lastPending.current = d.deliver_at; scheduleDelivery(d.deliver_at); }
      if (d.silence) setTimeout(load, 9000);   // 已读不回：几秒后刷新出"已读"
    } catch {} finally { inFlight.current = false; }
  };

  // 测试用：催他立刻回（跳过延迟和睡眠）
  const forceReply = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setTyping(true);
    try { await api(`/api/rooms/${charId}/reply`, { force: true }); } catch {}
    finally { inFlight.current = false; }
    setTimeout(() => { setTyping(false); load(); }, 800);
  };

  // 连发：每条立即入库并显示；防抖计时器重置；停手后才让 TA 回
  // "//"开头 = 对照实验：所有有key引擎各回一条，只显示不入库
  const send = async () => {
    const body = text.trim();
    if (!body || frozen) return;
    if (body.startsWith('//')) {
      setText('');
      setMsgs(m => [...m, { id: 'lab-q' + Date.now(), author_type: 'human', body: '🧪 ' + body.slice(2), meta: {} }]);
      setTyping(true);
      const d = await api(`/api/rooms/${charId}/compare`, { body: body.slice(2) });
      setTyping(false);
      setMsgs(m => [...m, ...(d.results || []).map((r, i) => ({
        id: 'lab' + Date.now() + i, author_type: 'char',
        body: `【${r.provider}】${r.text}`, meta: { ai: r.ai },
      }))]);
      return;
    }
    setText('');
    setMsgs(m => [...m, { id: 'tmp' + Date.now(), author_type: 'human', body, meta: {} }]);
    clearTimeout(timer.current);
    await api(`/api/rooms/${charId}/messages`, { body });
    timer.current = setTimeout(triggerReply, REPLY_DEBOUNCE_MS);
  };

  // 轮询兜底：错峰的第2/3条、主动消息、跨时段送达，都靠它浮现
  useEffect(() => {
    const iv = setInterval(load, 10000);
    return () => { clearInterval(iv); clearFx(); };
  }, [charId]);

  const dismissCrack = () => {
    seenCracks.current.add(crack.id);
    localStorage.setItem('crack_seen', JSON.stringify([...seenCracks.current]));
    setCrack(null);
  };

  return (
    <main className="chatroom">
      {crack && <CrackOverlay text={crack.body} onDone={dismissCrack} />}
      <div className="room-head">
        <button onClick={onBack}>‹</button>
        <b>{me.avatar} {me.name}</b>
        {typing
          ? <small className="typing-note">对方正在输入…</small>
          : <small>{me.asleep ? '💤 ' : ''}{happyFace(me.happiness)} {stageName(me.intimacy)} · {me.intimacy}</small>}
        <button className="icon-btn" title={me.fed ? '今天已经投喂过了' : '投喂（每天一次）'}
          disabled={me.fed || me.asleep || frozen}
          onClick={() => setFeeding(f => !f)}>🍱</button>
        <button className={'icon-btn' + (tools ? ' on' : '')} title="工具" onClick={() => setTools(t => !t)}>⋯</button>
      </div>
      {tools && (
        <div className="tool-row">
          <button className={'icon-btn' + (mind ? ' on' : '')} onClick={() => { setMind(m => !m); setTools(false); }}>内心</button>
          <button className={'icon-btn' + (selMode ? ' on' : '')} onClick={() => { setSelMode(m => !m); setSel(new Set()); setTools(false); }}>导出</button>
          <button className="icon-btn" onClick={() => { forceReply(); setTools(false); }}>⚡催</button>
          <button className="icon-btn" onClick={() => { setEditing(e => !e); setTools(false); }}>人设</button>
        </div>
      )}
      {feeding && <FoodTray charId={charId} onFed={() => { setFeeding(false); load(); }} />}
      {editing && <PersonaEditor charId={charId} name={me.name} onClose={() => setEditing(false)} />}
      {mind && <MindPanel charId={charId} onClose={() => setMind(false)} />}
      <div className="bubbles">
        {buildTimeline(msgs).map(item => item.divider ? (
          <div key={item.id} className="time-divider">{fmtTime(item.t)}</div>
        ) : (
          <div key={item.id} className="bubble-wrap"
            onClick={selMode ? () => setSel(s => { const n = new Set(s); n.has(item.id) ? n.delete(item.id) : n.add(item.id); return n; }) : undefined}
            onDoubleClick={!selMode ? () => recall(item) : undefined}>
            <div className={
              'bubble ' + (item.author_type === 'human' ? 'mine' : 'theirs') + (item.meta?.fx === 'crack' ? ' crack' : '')
              + (selMode && sel.has(item.id) ? ' sel' : '')
            }>
              {item.body}
              {item.author_type === 'char' && item.meta?.ai === false && <i className="script-tag">脚本</i>}
            </div>
            <div className={'msg-meta' + (item.author_type === 'human' ? ' mine' : '')}>
              {fmtClock(item.deliver_at || item.created_at)}{item.receipt ? ` · ${item.receipt}` : ''}
            </div>
          </div>
        ))}
        {typing && <div className="bubble theirs typing"><span className="dots"><i/><i/><i/></span></div>}
        <div ref={bottom} />
      </div>
      {selMode ? (
        <div className="composer">
          <span className="dev-hint" style={{ flex: 1, alignSelf: 'center' }}>点气泡选中，已选 {sel.size} 条</span>
          <button onClick={exportSel} disabled={!sel.size}>{copied ? '已复制 ✓' : '复制导出'}</button>
        </div>
      ) : (
      <div className="composer">
        <input value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
          placeholder={frozen ? '冻结中' : `和${me.name}说点什么…（可连发）`} disabled={frozen} />
        <button onClick={send} disabled={frozen}>发送</button>
      </div>
      )}
    </main>
  );
}

// ---------- 墨水屏后处理管线 ----------
// 不是"画"出来的，是对已渲染画面的后处理，顺序严格：
//   1) 去色            —— 墨水屏没有彩色子像素（Kaleido 那种彩色滤光片是另一回事）
//   2) 提对比          —— 电子墨水的动态范围窄，中间调必须被推开
//   3) 加抖动阈值      —— 由 DOM 里的 .eink-dither 图层以 mix-blend-mode 混入，
//                         它是 .phone 的子元素，所以先合成、后进滤镜，顺序天然正确
//   4) 量化到有限灰阶  —— feComponentTransfer type="discrete"，几个值就是几阶
//   5) 映射到纸/墨颜色 —— 墨水屏的白不是 #fff（是偏暖的灰白），黑也不是 #000
// 灰阶数由调用方给：4 = 四阶灰（Carta 观感），2 = 纯黑白（1-bit，最像早期设备）
const EINK_PAPER = [0.851, 0.839, 0.800];   // #d9d6cc 反射式纸面
const EINK_INK = [0.169, 0.165, 0.157];     // #2b2a28 电泳黑，永远到不了纯黑

function EinkFilters() {
  const mk = (id, levels) => (
    <filter id={id} key={id} colorInterpolationFilters="sRGB">
      <feColorMatrix type="saturate" values="0" />
      <feComponentTransfer>
        <feFuncR type="linear" slope="1.75" intercept="-0.38" />
        <feFuncG type="linear" slope="1.75" intercept="-0.38" />
        <feFuncB type="linear" slope="1.75" intercept="-0.38" />
      </feComponentTransfer>
      <feComponentTransfer>
        <feFuncR type="discrete" tableValues={levels} />
        <feFuncG type="discrete" tableValues={levels} />
        <feFuncB type="discrete" tableValues={levels} />
      </feComponentTransfer>
      <feComponentTransfer>
        <feFuncR type="linear" slope={EINK_PAPER[0] - EINK_INK[0]} intercept={EINK_INK[0]} />
        <feFuncG type="linear" slope={EINK_PAPER[1] - EINK_INK[1]} intercept={EINK_INK[1]} />
        <feFuncB type="linear" slope={EINK_PAPER[2] - EINK_INK[2]} intercept={EINK_INK[2]} />
      </feComponentTransfer>
    </filter>
  );
  return (
    <svg className="eink-defs" width="0" height="0" aria-hidden>
      <defs>
        {mk('eink-q4', '0 0.34 0.67 1')}
        {mk('eink-q2', '0 1')}
      </defs>
    </svg>
  );
}

// ---------- 岛屿视图：观察者模式的雏形（AC/星露谷式日程驱动 + CSS 走位）----------
// 位置来自 server 的日程表 loc；小时切换时小人走向新地点（CSS transition 就是"走路"）；
// 原地每 7 秒轻微游荡一下。没有 tilemap、没有寻路——T3 换 PixiJS 壳时这里只换渲染层。
// 坐标已统一到 Scene.jsx 的格子系统：LOCS 由 CELLS 推导出来（格心的百分比）。
// 走位、建筑、相遇判定共用同一套网格；adjacent() 让"挨着"也能算相遇。
const homeOf = (id) => id === 'xiaobei' ? '小北家' : id === 'ache' ? '阿澈家' : id === 'yuanzi' ? '圆子家' : '广场';
const basePos = (c) => LOCS[c.loc === '家' ? homeOf(c.id) : c.loc] || LOCS['广场'];

// 岛 = 主界面（朋友收集式）：小人在自己的日程位置上，头顶冒气泡告诉你他需要什么。
// 点小人 → 角色卡（不是直接进聊天）。这是"观察者"的正确语法。
function Island({ chars, island, onPick, pixel = false }) {
  const Face = AvatarFor(pixel);
  const [wander, setWander] = useState({});
  const [rels, setRels] = useState([]);
  const [chron, setChron] = useState([]);
  const [enc, setEnc] = useState(null);      // 待看的小剧场
  const [playing, setPlaying] = useState(false);
  const [beat, setBeat] = useState(0);
  const [making, setMaking] = useState(false);
  const [scene, setScene] = useState(null);
  const loadEnc = () => api('/api/encounters/pending').then(d => setEnc(d.encounter));
  useEffect(() => { loadEnc(); api('/api/scene').then(setScene); }, []);
  useEffect(() => {
    api('/api/relationships').then(setRels);
    api('/api/chronicle').then(setChron);
    const iv = setInterval(() => {
      const w = {};
      chars.forEach(c => { w[c.id] = c.asleep ? [0, 0] : [(Math.random() - .5) * 6, (Math.random() - .5) * 5]; });
      setWander(w);
    }, 7000);
    return () => clearInterval(iv);
  }, [chars]);
  const posOf = (c) => {
    const base = basePos(c);
    const [dx, dy] = wander[c.id] || [0, 0];
    return { left: `${base[0] + dx}%`, top: `${base[1] + dy}%` };
  };
  // 气泡优先级：烦恼 > 未读 > 睡着(可窥梦) > 没喂
  const bubbleOf = (c) => {
    if (c.worry) return { cls: 'worry lv' + c.worry.level, icon: c.worry.level >= 3 ? '❗' : c.worry.level === 2 ? '💭' : '💬' };
    if (c.unread > 0) return { cls: 'unread', icon: '✉️' };
    if (c.asleep) return { cls: 'sleep', icon: '💤' };
    if (!c.fed) return { cls: 'hungry', icon: '🍽' };
    return null;
  };
  const byId = Object.fromEntries(chars.map(c => [c.id, c]));
  const cast = enc ? [enc.a_id, enc.b_id] : [];
  const nextBeat = async () => {
    if (beat + 1 >= enc.beats.length) {
      await api(`/api/encounters/${enc.id}/watched`, {});
      setPlaying(false); setBeat(0); setEnc(null);
      api('/api/chronicle').then(setChron);
      api('/api/relationships').then(setRels);
    } else setBeat(beat + 1);
  };
  const makeNow = async () => {
    setMaking(true);
    const r = await api('/api/encounters/make', {});
    setMaking(false);
    if (r.error) return alert(r.error);
    await loadEnc();
  };
  return (
    <main className={'island' + (playing ? ' theater' : '')}>
      <div className="island-sea" />
      <div className="island-land">
        <Scene scene={scene} />
        <svg className="rel-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
          {rels.filter(r => r.value >= 40 && byId[r.a] && byId[r.b]).map(r => {
            const p1 = basePos(byId[r.a]), p2 = basePos(byId[r.b]);
            return <line key={r.a + r.b} x1={p1[0]} y1={p1[1]} x2={p2[0]} y2={p2[1]}
              stroke="rgba(160,200,230,0.28)" strokeWidth={r.value >= 60 ? 0.5 : 0.28} strokeDasharray={r.value >= 60 ? '' : '1.5 1.5'} />;
          })}
        </svg>
        {Object.entries(LOCS).filter(([n]) => n !== '家').map(([n, [x, y]]) => (
          <span key={n} className="poi" style={{ left: `${x}%`, top: `${y}%` }}>{n}</span>
        ))}
        {chars.map(c => {
          const b = bubbleOf(c);
          const inCast = playing && cast.includes(c.id);
          const dim = playing && !inCast;
          // 演出时两位主角走到台前
          const stage = inCast ? { left: cast[0] === c.id ? '38%' : '62%', top: '46%' } : posOf(c);
          const speaking = playing && enc.beats[beat]?.who === c.id;
          return (
            <div key={c.id} className={'islander' + (c.asleep ? ' zz' : '') + (dim ? ' dim' : '') + (inCast ? ' onstage' : '') + (speaking ? ' speaking' : '')}
              style={stage} onClick={() => !playing && onPick(c.id)}>
              {!playing && b && <span className={'bub ' + b.cls}>{b.icon}</span>}
              <span className="islander-avatar">
                {c.look ? <Face look={c.look} size={inCast ? 46 : 30} speaking={speaking} /> : c.avatar}
              </span>
              <span className="islander-name">{c.name}</span>
              {!playing && <span className="islander-doing">{c.activity}</span>}
            </div>
          );
        })}
      </div>

      {enc && !playing && (
        <div className="enc-prompt" onClick={() => { setPlaying(true); setBeat(0); }}>
          📺 岛上刚才发生了点事 · {enc.names[enc.a_id]?.name} 和 {enc.names[enc.b_id]?.name}
          {enc.loc ? ` 在${enc.loc}` : ''} —— 点按看看
        </div>
      )}

      {playing && enc && (
        <div className="subtitle" onClick={nextBeat}>
          {enc.beats[beat].who !== 'narr' && (
            <b className="sub-who">{enc.names[enc.beats[beat].who]?.name}</b>
          )}
          <span className={enc.beats[beat].who === 'narr' ? 'sub-narr' : 'sub-line'}>
            {enc.beats[beat].text}
          </span>
          <i className="sub-next">{beat + 1}/{enc.beats.length} ▸</i>
        </div>
      )}
      {!playing && island?.archive && (
        <div className="archive">
          <span>🧠 记忆 {island.archive.memories}</span>
          <span>🤝 羁绊 {island.archive.bonds}</span>
          <span>🎬 剧场 {island.archive.encounters}</span>
          <span>📜 岛志 {island.archive.chronicle}</span>
        </div>
      )}
      {!playing && chron.length > 0 && (
        <div className="chronicle">
          <div className="chronicle-title">岛志 · 你不在时发生的事</div>
          {chron.slice(0, 4).map(c => <div key={c.id} className="chronicle-line">📜 {c.body}</div>)}
        </div>
      )}
      {!playing && (
        <div className="island-foot">
          <span className="dev-hint">点岛上的人，走近看看他此刻怎么样。</span>
          <button className="icon-btn" disabled={making} onClick={makeNow}>{making ? '看着…' : '👀 看看岛上'}</button>
        </div>
      )}
    </main>
  );
}

// 角色卡（朋友收集式）：他现在的状态 + 你能对他做的所有事
function CharCard({ char: c, onClose, onChat, frozen, onChanged }) {
  const [tray, setTray] = useState(false);
  const [dream, setDream] = useState(null);
  const [rels, setRels] = useState([]);
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    if (!c) return;
    api('/api/relationships').then(rs => setRels(rs.filter(r => r.a === c.id || r.b === c.id)));
    api(`/api/rooms/${c.id}/debug`).then(setDetail);
  }, [c?.id]);
  if (!c) return null;
  const peek = async () => {
    setDream({ text: null });
    const r = await api(`/api/rooms/${c.id}/dream`, {});
    setDream({ text: r.error ? '……醒了，梦散了。' : r.dream });
  };
  return (
    <div className="sheet-mask" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="card-top">
          <span className="card-avatar">{c.look ? <Avatar look={c.look} size={54} /> : c.avatar}</span>
          <div className="card-id">
            <b>{c.name} <i className="stage-chip">{stageName(c.intimacy)}</i></b>
            <small>{c.asleep ? '💤 ' : ''}{c.activity}</small>
          </div>
        </div>
        <div className="meter"><span>幸福</span><div className="bar"><i style={{ width: `${c.happiness}%` }} /></div><b>{c.happiness}</b></div>
        <div className="meter"><span>亲密</span><div className="bar"><i className="warm" style={{ width: `${Math.min(c.intimacy / 3, 100)}%` }} /></div><b>{c.intimacy}</b></div>

        {c.worry && <div className={'worry-box lv' + c.worry.level}>
          <b>{c.worry.level >= 3 ? `❗ ${c.name}有件急事` : c.worry.level === 2 ? `💭 ${c.name}有点在意的事` : `💬 ${c.name}想说件小事`}</b>
          <p>{c.worry.text}</p>
          <small>回一句，就是帮TA处理了。</small>
        </div>}

        {rels.length > 0 && <div className="card-rels">
          {rels.map(r => <span key={r.a + r.b} className="rel-chip">
            {r.a === c.id ? r.b_name : r.a_name} · {r.value >= 75 ? '挚友' : r.value >= 50 ? '朋友' : r.value >= 25 ? '相识' : '不太熟'}
          </span>)}
        </div>}

        {detail?.impression && <div className="card-impression">TA眼中的你：{detail.impression}</div>}

        <div className="card-actions">
          <button className="act" onClick={() => onChat(c.id)}>💬 说话{c.unread ? ` (${c.unread})` : ''}</button>
          <button className="act" disabled={c.fed || c.asleep || frozen} onClick={() => setTray(t => !t)}>
            {c.fed ? '🍱 今天喂过了' : '🍱 投喂'}
          </button>
          <button className="act" disabled={!c.asleep} onClick={peek}>🌙 窥梦</button>
        </div>
        {tray && <FoodTray charId={c.id} onFed={() => { setTray(false); onChanged(); }} />}
        {dream && <div className="dream-inline">{dream.text || '正在靠近……'}</div>}
      </div>
    </div>
  );
}

// 透明面板：他此刻心里有什么（试验期仪表盘，也是"他心里有我吗"的偷窥孔）
function MindPanel({ charId, onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => { api(`/api/rooms/${charId}/debug`).then(setD); }, [charId]);
  if (!d) return null;
  return (
    <div className="persona-panel">
      <div className="dev-title"><span>{d.name} 的内心</span><button className="icon-btn" onClick={onClose}>×</button></div>
      <div className="dev-hint" style={{ fontSize: 12, lineHeight: 1.7 }}>
        <b>正在：</b>{d.activity}{d.asleep ? '（睡着）' : ''}<br />
        <b>情绪：</b>{d.mood || '平静'}<br />
        <b>对你的印象：</b>{d.impression || '还没形成'}<br />
        <b>最近记得的事：</b>{d.memories.length ? '' : '（无）'}
        {d.memories.map((m, i) => <span key={i}><br />· {m}</span>)}
        <br /><b>引擎：</b>{d.provider} | 今日AI {d.quota_used} 条 | 第四面墙 {d.fourthwall}
      </div>
    </div>
  );
}

function FoodTray({ charId, onFed }) {
  const [foods, setFoods] = useState([]);
  useEffect(() => { api('/api/foods').then(setFoods); }, []);
  const feed = async (id) => {
    const r = await api(`/api/rooms/${charId}/feed`, { food: id });
    if (r.error === 'fed') alert('今天已经喂过了，明天再来');
    else if (r.error === 'asleep') alert('TA在睡觉，别喂了');
    onFed();
  };
  return (
    <div className="food-tray">
      {foods.map(f => (
        <button key={f.id} className="food" title={f.n} onClick={() => feed(f.id)}>
          <span>{f.e}</span><small>{f.n}</small>
        </button>
      ))}
      <div className="dev-hint" style={{ width: '100%' }}>每天一次。TA的好恶是隐藏的——喂了才知道。</div>
    </div>
  );
}

// 裂缝时刻演出：黑屏先沉默 1.6 秒，然后逐字浮现，标点处停顿。
// 恐慌先于温暖——不是普通对话框，是一个不该出现的瞬间。
function CrackOverlay({ text, onDone }) {
  const [shown, setShown] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    let alive = true;
    let i = 0;
    // 环境音：一声很低的、慢慢消失的嗡鸣。不是音效，是房间突然安静下来的感觉
    let ctx = null;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = 82;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 1.8);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 7);
      osc.connect(gain).connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 7.2);
    } catch { /* 自动播放被拦就算了，演出不依赖它 */ }
    const tick = () => {
      if (!alive) return;
      if (i >= text.length) { setDone(true); return; }
      i += 1;
      setShown(text.slice(0, i));
      const ch = text[i - 1];
      // 打字速度必须慢于阅读速度：让玩家被迫等她把话说完，等待本身就是演出。
      // 换行停最久——第二行是她转身说的那句日常话，停顿让它显得更冷。
      const pause = ch === '\n' ? 1400
        : '，。…！？—'.includes(ch) ? 620
          : 130 + Math.random() * 90;
      setTimeout(tick, pause);
    };
    // 黑屏之后先什么都不发生。这 2.6 秒里玩家会怀疑是不是卡了——
    // 那个"以为是 bug"的瞬间正是恐怖的来源：它模糊了游戏和系统的边界。
    const t0 = setTimeout(tick, 2600);
    return () => { alive = false; clearTimeout(t0); try { ctx && ctx.close(); } catch {} };
  }, [text]);
  return (
    <div className="crack-overlay" onClick={() => done && onDone()}>
      <div className="crack-text">{shown}{!done && <span className="caret" />}</div>
      {done && <div className="crack-hint">（点按继续）</div>}
    </div>
  );
}

function PersonaEditor({ charId, name, onClose }) {
  const [prompt, setPrompt] = useState('');
  const [crackLine, setCrackLine] = useState('');
  const [builtin, setBuiltin] = useState('');
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api(`/api/characters/${charId}`).then(c => {
      setPrompt(c.custom_prompt || '');
      setCrackLine(c.crack_custom || '');
      setBuiltin(`你是${c.name}，住在一座漂浮在海上的小岛上。\n你的性格：${c.persona_surface}\n你独处时的样子：${c.persona_inner}\n你的怪癖：${JSON.parse(c.quirks).join('；')}`);
    });
  }, [charId]);
  const save = async () => {
    await api(`/api/characters/${charId}/prompt`, { custom_prompt: prompt, crack_custom: crackLine }, 'PUT');
    setSaved(true); setTimeout(onClose, 600);
  };
  const exportCode = async () => {
    const r = await api(`/api/characters/${charId}/code`);
    setCode(r.code);
    try { await navigator.clipboard.writeText(r.code); } catch {}
  };
  return (
    <div className="persona-panel">
      <div className="dev-title"><span>{name} · 人设</span><button className="icon-btn" onClick={onClose}>×</button></div>
      <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={6}
        placeholder={`自定义人设 prompt，留空 = 用内置三层人设：\n\n${builtin}`} />
      <textarea value={crackLine} onChange={e => setCrackLine(e.target.value)} rows={3}
        placeholder={'裂缝台词（TA发现你那一刻说的话，一生一次）。\n内置角色留空用官方手写库；自建角色留空用通用兜底。\n原则：不甜、不安全、不解释。'} />
      <div className="dev-hint">人设只替换性格块；记忆、时间、第四面墙状态机由引擎注入，覆盖不掉。裂缝台词永远不走 AI 生成。</div>
      {code && <textarea readOnly rows={3} value={code} onFocus={e => e.target.select()} />}
      <div className="persona-actions">
        <button className="icon-btn" onClick={exportCode}>{code ? '已复制 ✓' : '导出角色码'}</button>
        <button className="icon-btn danger" onClick={async () => {
          if (!confirm(`重置和${name}的一切？聊天、记忆、亲密度、第四面墙进度全部清零，不可恢复。`)) return;
          await api(`/api/rooms/${charId}/reset`, {});
          location.reload();
        }}>重置对话</button>
        <button className="icon-btn danger" onClick={async () => {
          if (!confirm(`让${name}永远离开小岛？角色、聊天、记忆全部删除，不可恢复。`)) return;
          await api(`/api/characters/${charId}`, { _: 1 }, 'DELETE');
          location.reload();
        }}>送离小岛</button>
        <button className="save-btn" onClick={save}>{saved ? '已保存 ✓' : '保存'}</button>
      </div>
    </div>
  );
}

function Feed({ frozen }) {
  const [items, setItems] = useState([]);
  const [text, setText] = useState('');
  const load = () => api('/api/feed').then(setItems);
  useEffect(() => { load(); }, []);

  const post = async () => {
    const body = text.trim();
    if (!body || frozen) return;
    setText('');
    await api('/api/feed', { body });
    load();
  };
  const poke = async (id) => { await api(`/api/feed/${id}/char-comment`, {}); load(); };

  return (
    <main className="feed">
      <div className="composer">
        <input value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && post()}
          placeholder={frozen ? '冻结中' : '发条动态…'} disabled={frozen} />
        <button onClick={post} disabled={frozen}>发布</button>
      </div>
      {items.map(m => (
        <div key={m.id} className="moment">
          <div className="moment-head">
            <span className="avatar">{m.author?.avatar}</span>
            <b>{m.author?.name}</b>
            <small className="moment-time">{fmtTime(m.deliver_at || m.created_at)}</small>
            <button className="poke" onClick={() => poke(m.id)} disabled={frozen} title="让某个岛民来评论">💬</button>
          </div>
          <p>{m.body}</p>
          {m.comments.map(c => (
            <div key={c.id} className="comment"><b>{c.author?.name}：</b>{c.body}</div>
          ))}
        </div>
      ))}
    </main>
  );
}
