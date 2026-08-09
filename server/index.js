// index.js — 惰性生成架构：不在时零生成；打开时一次性结算（离岛报告 + 到期主动消息）。
// frozen = 真暂停 = 零 API 消耗。杀掉一切定时轮询。
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, W } from './db.js';
import { charSay, advanceFourthwall, remember, timeSlot, sleepInfo, summarizeRoom, pickCrackLine, makeCrackLine, activityInfo, updateImpressions, getRel, bumpRel, makeEncounter, findEncounterPair, listProviders, setProvider } from './brain.js';

const app = express();
app.use(express.json());

const CATCHUP_MS = Number(process.env.CATCHUP_HOURS || 4) * 3600e3;
const MAX_PROACTIVE = 2;

const now = () => Date.now();
const chars = () => db.prepare('SELECT * FROM characters').all();
const insertEvent = db.prepare(`INSERT INTO events
  (author_id,author_type,kind,room_id,target_id,body,meta,read,created_at,deliver_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);

// deliverAt：投递时刻。生成是即时的（一次 API），送达可以在未来——节奏由此而来。
function addEvent({ authorId, authorType, kind, roomId, targetId = null, body, meta = {}, read = 1, deliverAt = null }) {
  const t = now();
  const r = insertEvent.run(authorId, authorType, kind, roomId, targetId, body, JSON.stringify(meta), read, t, deliverAt ?? t);
  return db.prepare('SELECT * FROM events WHERE id=?').get(r.lastInsertRowid);
}

// 首次见面：每个空房间投一条手写引导消息（不烧 API，错峰送达）——开局不能是三个死寂的房间
const INTROS = {
  xiaobei: '你好呀！我是小北！刚在海边捡到一块超圆的石头，摸起来滑滑的。你叫什么呀？',
  ache: '……你好。我是阿澈。这个点还醒着的话，说明你也睡不着。',
  yuanzi: '来啦？我是圆子。刚剥了个橘子，比昨天那个甜。给你留一瓣——哦对，你在那边。那我记着这瓣是你的。',
};
function seedIntros() {
  for (const c of chars()) {
    const n = db.prepare(`SELECT COUNT(*) n FROM events WHERE room_id=? AND kind='chat'`).get(c.id).n;
    if (n === 0 && INTROS[c.id]) {
      addEvent({
        authorId: c.id, authorType: 'char', kind: 'chat', roomId: c.id,
        body: INTROS[c.id], read: 0, deliverAt: now() + (20 + Math.floor(Math.random() * 160)) * 1000,
      });
    }
  }
}

// ---------- onOpen：唯一的生成时机（生成放后台，打开必须秒开）----------
app.post('/api/open', async (req, res) => {
  if (W.get('frozen') === '1') {
    return res.json({ frozen: true, catchup: null, proactive: [] });
  }
  const last = Number(W.get('last_seen') || now());
  const elapsed = now() - last;
  let catchup = null;
  const proactive = [];
  seedIntros();
  // 幸福度温和衰减：概念书铁律——惩罚要轻，压力感是留存杀手。
  // 每 12 小时 -1，单次最多 -8，地板 45（"有点蔫"而不是"枯萎"）。日子会淡，但不会崩。
  const hoursAway = Math.floor(elapsed / 3600e3);
  const decay = Math.min(Math.floor(hoursAway / 12), 8);
  if (decay >= 1) db.prepare('UPDATE characters SET happiness = MAX(happiness - ?, 45)').run(decay);

  updateImpressions().catch(() => {});   // 画像每日重写（内部有日期闸，一天最多跑一次）

  const firstLine = (t) => (t || '').replace(/\[沉默\]/g, '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
  const slot = timeSlot();
  const active = chars().filter(c => !sleepInfo(c).asleep && (slot !== '深夜' || c.night_owl));
  const pickN = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);

  // 主动消息防轰炸：他不是话痨复读机。三道闸——
  // ① 3小时冷却 ② 他上一条你还没回/没读，不追着发 ③ 还有消息在路上，不叠加
  const canProactive = (c) => {
    if (c.intimacy <= 20) return false;   // 陌生人不会没事找你——第一步永远该由你走近
    const cooldownH = c.intimacy > 100 ? 2 : c.intimacy > 50 ? 3 : 6;   // 越亲近，越常想到你
    const lastP = Number(W.get('last_proactive:' + c.id) || 0);
    if (now() - lastP < cooldownH * 3600e3) return false;
    const lastEv = db.prepare(`SELECT author_type, read, seen_at FROM events WHERE room_id=? AND kind='chat' ORDER BY id DESC LIMIT 1`).get(c.id);
    if (lastEv && lastEv.author_type === 'char') return false;   // 他说了最后一句，等你
    const pending = db.prepare(`SELECT COUNT(*) n FROM events WHERE room_id=? AND kind='chat' AND author_type='char' AND deliver_at > ?`).get(c.id, now()).n;
    return pending === 0;
  };
  const markProactive = (c) => W.set('last_proactive:' + c.id, String(now()));

  if (elapsed > CATCHUP_MS) {
    const hours = Math.round(elapsed / 3600e3);
    catchup = { away_hours: hours };
    // 生成放后台：打开必须秒开，内容通过轮询自己浮现（本来就是"世界在转"的感觉）
    setImmediate(async () => {
      try {
        // 岛上小事件：A 发动态 + B 来评论——他们之间真的有生活，且关系随之变化
        if (active.length >= 2) {
          const [a, b] = pickN(active, 2);
          const m = await charSay(a, 'moment');
          const body = firstLine(m.text);
          if (body) {
            const mv = addEvent({ authorId: a.id, authorType: 'char', kind: 'moment', roomId: 'feed', body });
            const cm = await charSay(b, 'comment', `【${a.name} 发了条动态】${body}\n（你在这条动态下评论一句，像朋友间随口接话，可以调侃可以关心）`);
            const cb = firstLine(cm.text);
            if (cb) {
              addEvent({ authorId: b.id, authorType: 'char', kind: 'comment', roomId: 'feed', targetId: mv.id, body: cb });
              bumpRel(a.id, b.id, 1, `${b.name}回应了${a.name}的"${body.slice(0, 14)}"`);   // 互动拉近关系
            }
          }
        } else if (active.length === 1) {
          const m = await charSay(active[0], 'moment');
          const body = firstLine(m.text);
          if (body) addEvent({ authorId: active[0].id, authorType: 'char', kind: 'moment', roomId: 'feed', body });
        }
        const FLAVORS = [
          `（TA大约 ${hours} 小时没上线，刚刚上线了。你想主动发条消息就发，像真人隔了半天想起对方那样自然）`,
          '（你突然想到TA了，主动发条消息。可以是件小事、一个突然的念头。别客套）',
        ];
        for (const c of pickN(active.filter(canProactive), Math.min(MAX_PROACTIVE, active.length))) {
          markProactive(c);
          const fw = advanceFourthwall(c);
          // 1/3 概率带着烦恼来（岛上会冒气泡，你回复=处理了它）
          const isWorry = fw !== 'crack' && !c.worry_level && Math.random() < 0.34;
          const m = fw === 'crack'
            ? { text: (await makeCrackLine(c)).text, ai: true }       // 约束生成 → 判别 → 不过则降级手写库
            : await charSay(c, 'chat', isWorry
              ? '（你有件小烦恼想找TA商量——一件具体的、贴合你性格和最近生活的小事。把烦恼说出来，问问TA怎么看）'
              : FLAVORS[Math.floor(Math.random() * FLAVORS.length)]);
          if (/\[沉默\]/.test(m.text)) continue;
          if (isWorry && m.ai) {
            const lv = 1 + Math.floor(Math.random() * 3);
            db.prepare('UPDATE characters SET worry_text=?, worry_level=?, worry_at=? WHERE id=?')
              .run(firstLine(m.text).slice(0, 60), lv, now(), c.id);
          }
          const pieces = m.text.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 2);
          pieces.forEach((p, i) => addEvent({
            authorId: c.id, authorType: 'char', kind: 'chat', roomId: c.id,
            body: p, read: 0, meta: { ai: m.ai, ...(fw === 'crack' && i === 0 ? { fx: 'crack' } : {}) },
            deliverAt: now() + (10 + Math.floor(Math.random() * 50)) * 1000 + i * 3000,
          }));
        }
        // 相遇小剧场：你不在的时候，岛上的人自己碰上了。回来能看回放。
        const pair = findEncounterPair();
        if (pair) {
          try {
            const e = await makeEncounter(pair.a, pair.b, pair.loc);
            const narr = e.beats.find(x => x.who === 'narr');
            if (narr) db.prepare('INSERT INTO chronicle (body,created_at) VALUES (?,?)').run(narr.text.slice(0, 80), now());
          } catch (e2) { console.error('[小剧场失败]', e2.message); }
        }
      } catch (e) { console.error('[离岛报告生成失败]', e.message); }
    });
  } else if (Math.random() < 0.25 && active.some(canProactive)) {
    // 主动找话：不用等离岛4小时。你在的时候，也会有人突然想到你——1~8分钟后到。
    const cands = active.filter(canProactive);
    setImmediate(async () => {
      try {
        const c = cands[Math.floor(Math.random() * cands.length)];
        markProactive(c);
        const IDEAS = [
          '（你突然想到TA了，主动发条消息。可以是件小事、一个突然的念头、或者就是想说话。别客套，像真人那样随手发）',
          '（你有件小烦恼想找TA商量——一件具体的、贴合你性格和最近生活的小事。把烦恼说出来，问问TA怎么看）',
        ];
        const m = await charSay(c, 'chat', IDEAS[Math.floor(Math.random() * IDEAS.length)]);
        if (!/\[沉默\]/.test(m.text)) {
          addEvent({
            authorId: c.id, authorType: 'char', kind: 'chat', roomId: c.id,
            body: firstLine(m.text), read: 0, meta: { ai: m.ai },
            deliverAt: now() + (60 + Math.floor(Math.random() * 420)) * 1000,
          });
        }
      } catch (e) { console.error('[主动消息生成失败]', e.message); }
    });
  }

  W.set('last_seen', now());
  res.json({ frozen: false, catchup, proactive });
});

// ---------- 冻结开关（暂停键）----------
app.post('/api/freeze', (req, res) => {
  const frozen = req.body.frozen ? '1' : '0';
  W.set('frozen', frozen);
  if (frozen === '0') W.set('last_seen', now()); // 解冻不追溯冻结期
  res.json({ frozen: frozen === '1' });
});

// ---------- AI 引擎（多 provider 快捷切换）----------
app.get('/api/providers', (req, res) => res.json({
  providers: listProviders(),
  lastError: W.get('last_ai_error') || null,
}));
app.post('/api/provider', (req, res) => {
  const id = setProvider(req.body.provider);
  if (!id) return res.status(400).json({ error: 'unknown provider' });
  res.json({ active: id, providers: listProviders() });
});

// ---------- 状态 ----------
app.get('/api/state', (req, res) => {
  const t = now();
  const unread = db.prepare(`SELECT room_id, COUNT(*) n FROM events WHERE kind='chat' AND read=0 AND deliver_at <= ? GROUP BY room_id`).all(t);
  const unreadMap = Object.fromEntries(unread.map(u => [u.room_id, u.n]));
  const all = chars();
  const avgHappy = all.length ? Math.round(all.reduce((s, c) => s + (c.happiness ?? 60), 0) / all.length) : 60;
  // 积累感可见化：我们的"素材库"是记忆/关系/岛志——玩家要能看到它在长
  const archive = {
    memories: db.prepare('SELECT COUNT(*) n FROM memories').get().n,
    chronicle: db.prepare('SELECT COUNT(*) n FROM chronicle').get().n,
    encounters: db.prepare('SELECT COUNT(*) n FROM encounters').get().n,
    bonds: db.prepare('SELECT COALESCE(SUM(value),0) n FROM relationships').get().n,
  };
  res.json({
    frozen: W.get('frozen') === '1',
    slot: timeSlot(),
    island: { level: Math.max(1, Math.floor(avgHappy / 10)), happiness: avgHappy, population: all.length, archive },
    characters: chars().map(c => ({
      id: c.id, name: c.name, avatar: c.avatar, look: c.look ? JSON.parse(c.look) : null,
      intimacy: c.intimacy, fourthwall_state: c.fourthwall_state,
      happiness: c.happiness ?? 60, fed: c.fed_date === todayStr(),
      worry: c.worry_level ? { text: c.worry_text, level: c.worry_level } : null,
      asleep: sleepInfo(c).asleep, activity: activityInfo(c).t, loc: activityInfo(c).loc || '广场',
      unread: unreadMap[c.id] || 0,
      last: db.prepare(`SELECT body FROM events WHERE room_id=? AND kind='chat' AND deliver_at <= ? ORDER BY deliver_at DESC, id DESC LIMIT 1`).get(c.id, t)?.body || '',
    })),
  });
});

// ---------- 聊天 ----------
app.get('/api/rooms/:charId/messages', (req, res) => {
  const t = now();
  db.prepare(`UPDATE events SET read=1 WHERE room_id=? AND kind='chat' AND deliver_at <= ?`).run(req.params.charId, t);
  const messages = db.prepare(`SELECT * FROM events WHERE room_id=? AND kind='chat' AND deliver_at <= ? ORDER BY deliver_at ASC, id ASC`)
    .all(req.params.charId, t)
    .map(e => ({ ...e, meta: JSON.parse(e.meta) }));
  // pending_at：还在路上的回复。重进房间也能恢复"正在输入"的时机
  const pending = db.prepare(`SELECT MIN(deliver_at) t FROM events
    WHERE room_id=? AND kind='chat' AND author_type='char' AND deliver_at > ?`).get(req.params.charId, t);
  res.json({ messages, pending_at: pending.t || null, now: t });
});

// 发消息 = 只入库（支持连发多条）。回复由 /reply 单独触发（前端在你停手 ~1.6s 后调）。
app.post('/api/rooms/:charId/messages', (req, res) => {
  if (W.get('frozen') === '1') return res.status(409).json({ error: 'frozen' });
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(req.params.charId);
  if (!char) return res.status(404).json({ error: 'no such character' });
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'empty' });

  const ev = addEvent({ authorId: 'user', authorType: 'human', kind: 'chat', roomId: char.id, body });

  // 解决烦恼（朋友收集式）：他带着烦恼来，你回了 = 帮他处理了。气泡消失，幸福度涨。
  if (char.worry_level) {
    db.prepare('UPDATE characters SET worry_text=NULL, worry_level=0, worry_at=NULL, happiness=MIN(happiness+8,100), intimacy=MIN(intimacy+3,300) WHERE id=?').run(char.id);
    remember(char.id, `我为"${(char.worry_text || '').slice(0, 24)}"烦恼的时候，TA听我说了`, { valence: 0.85, strength: 1.2 });
  }

  // 后果系统：说的话对他真的有影响，这是活人感的地基。双向——会疼，也会暖。
  // T1 用词表启发式（零成本零延迟）；'滚'必须带方向词，否则"地上打滚"也中枪。
  const HOSTILE = ['去死', '恨你', '恶心', '你滚', '滚开', '滚吧', '快滚', '傻逼', '垃圾', '讨厌你', '闭嘴', '白痴', '废物', '烦死了'];
  const WARM = ['谢谢你', '喜欢你', '想你', '晚安', '抱抱', '辛苦了', '有你真好', '喜欢跟你聊'];
  const DISTRESS = ['活着和死着没什么区别', '不想活', '活着没意思', '想消失', '撑不住了', '活不下去', '没有活的必要'];
  if (DISTRESS.some(w => body.includes(w))) {
    // 求救信号优先级高于一切：不是话题，是状态。角色放下手头一切。
    db.prepare('UPDATE characters SET mood_note = ?, mood_at = ? WHERE id=?')
      .run(`TA刚才说了让你很担心的话（"${body.slice(0, 30)}"）。这比任何话题都重要——放下你手头的事和正在聊的一切。别讲道理、别提建议、别问引导性的问题，就像一个真的在乎TA的人那样：先接住，再陪着。可以笨拙，但必须真`, Date.now(), char.id);
    remember(char.id, `TA说过让我很担心的话："${body.slice(0, 40)}"。我记着这件事`, { valence: 0.95, strength: 1.5 });
    db.prepare('UPDATE characters SET intimacy = MIN(intimacy + 2, 300) WHERE id=?').run(char.id);
  } else if (HOSTILE.some(w => body.includes(w))) {
    db.prepare('UPDATE characters SET intimacy = MAX(intimacy - 3, 0), mood_note = ?, mood_at = ? WHERE id=?')
      .run(`TA刚才对你说了很伤人的话（"${body.slice(0, 30)}"）。你很受伤，也有点生气`, Date.now(), char.id);
    remember(char.id, `TA曾对我说过很伤人的话："${body.slice(0, 40)}"`, { valence: 0.9, strength: 1.2 });
  } else if (WARM.some(w => body.includes(w))) {
    db.prepare('UPDATE characters SET intimacy = MIN(intimacy + 3, 300), mood_note = ?, mood_at = ? WHERE id=?')
      .run(`TA刚才对你说了很暖的话（"${body.slice(0, 30)}"）。你心里有点软，有点开心，但别表现得太明显`, Date.now(), char.id);
    remember(char.id, `TA对我说过："${body.slice(0, 40)}"，我记得当时心里一暖`, { valence: 0.85, strength: 1.1 });
  } else {
    db.prepare('UPDATE characters SET intimacy = MIN(intimacy + 2, 300) WHERE id=?').run(char.id);
    remember(char.id, `用户对我说过：${body.slice(0, 60)}`, { valence: 0.6, strength: 1.0 });
  }
  res.json({ ok: true, id: ev.id });
});

// 生成回复：读完整历史（含用户连发的所有条），可回 1-3 条气泡。
// 裂缝时刻永远单条完整投递，绝不拆。
app.post('/api/rooms/:charId/reply', async (req, res) => {
  if (W.get('frozen') === '1') return res.status(409).json({ error: 'frozen' });
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(req.params.charId);
  if (!char) return res.status(404).json({ error: 'no such character' });
  const force = !!req.body?.force;   // 测试用"催回复"：跳过延迟和睡眠

  // 标记已读：用户消息在 at 时刻被"他"看到（可以是未来——睡醒才看到）
  const markSeen = (at) => db.prepare(`UPDATE events SET seen_at=?
    WHERE room_id=? AND kind='chat' AND author_type='human' AND (seen_at IS NULL OR seen_at > ?)`)
    .run(at, char.id, at);

  // 已有未送达的回复在路上 → 不再生成。force 则把在路上的立刻送达。
  const pending = db.prepare(`SELECT MIN(deliver_at) t FROM events
    WHERE room_id=? AND kind='chat' AND author_type='char' AND deliver_at > ?`).get(char.id, now());
  if (pending.t) {
    if (force) {
      db.prepare(`UPDATE events SET deliver_at=? WHERE room_id=? AND kind='chat' AND author_type='char' AND deliver_at > ?`)
        .run(now(), char.id, now());
      markSeen(now());
      return res.json({ replies: [], forced: true, deliver_at: now() });
    }
    return res.json({ replies: [], pending: true, deliver_at: pending.t });
  }

  // 睡眠：睡着的人不回消息。生成还是现在这一次，但投递在他醒来之后，且以刚醒的口吻。
  const sleep = force ? { asleep: false } : sleepInfo(char);
  let extraCtx = null;
  if (sleep.asleep) {
    const wakeH = new Date(sleep.wakeAt).getHours();
    extraCtx = `（现在是你的睡觉时间，你在睡觉，不会立刻看到消息。你大约${wakeH}点醒来才看到这条消息并回复——请以刚睡醒刚看到消息的状态回，可以自然提到刚起来）`;
  }

  const fw = advanceFourthwall(char);
  // 裂缝时刻：约束生成（锚在只属于这个玩家的真实数据上）→ 判别层守门 → 两次不过降级到手写库
  const reply = fw === 'crack'
    ? { text: (await makeCrackLine(char)).text, ai: true }
    : await charSay({ ...char, fourthwall_state: fw }, 'chat', extraCtx);

  // 延迟在生成"之后"起算，不被 API 耗时吃掉：看到 → 想了想 → 才回
  // 忙的时候（做饭/搬货/修东西）回得更慢——生活有优先级，你不是唯一的事
  // 游戏性优先：清醒时基本"看到就回"（4-18s），忙时最多再+1分钟。真实感靠语气，不靠晾人。
  // 例外：TA刚说了让人担心的话——真的在乎的人会立刻放下手里的事。
  const lastHm = db.prepare(`SELECT body FROM events WHERE room_id=? AND kind='chat' AND author_type='human' ORDER BY id DESC LIMIT 1`).get(char.id);
  const DIST2 = ['活着和死着没什么区别', '不想活', '活着没意思', '想消失', '撑不住了', '活不下去', '没有活的必要'];
  const urgent = lastHm && DIST2.some(w => lastHm.body.includes(w));
  const busyExtra = (activityInfo(char).busy && !urgent) ? (15 + Math.floor(Math.random() * 45)) * 1000 : 0;
  let baseDeliver = force ? now()
    : (urgent && !sleep.asleep) ? now() + 3000
    : sleep.asleep ? sleep.wakeAt
    : now() + (4 + Math.floor(Math.random() * 14)) * 1000 + busyExtra;

  // 沉默权收紧：只有"刚被辱骂"时才允许已读不回，其余一律要回（做人的礼貌，也是游戏性）。
  const wantsSilence = /\[沉默\]/.test(reply.text);
  let cleaned = reply.text.replace(/\[沉默\]/g, '').trim();
  if (reply.ai && wantsSilence && fw !== 'crack') {
    const lastHuman = db.prepare(`SELECT body FROM events WHERE room_id=? AND kind='chat' AND author_type='human' ORDER BY id DESC LIMIT 1`).get(char.id);
    const HOSTILE2 = ['去死', '恨你', '恶心', '你滚', '滚开', '滚吧', '快滚', '傻逼', '垃圾', '讨厌你', '闭嘴', '白痴', '废物', '烦死了'];
    if (lastHuman && HOSTILE2.some(w => lastHuman.body.includes(w))) {
      markSeen(now() + (4 + Math.floor(Math.random() * 20)) * 1000);
      return res.json({ replies: [], silence: true, ai: true, fourthwall: fw });
    }
    if (!cleaned) cleaned = urgent ? '我在。' : char.intimacy <= 20 ? '嗯。' : '嗯';   // 模型想赖账，替他回；求救场景必须是"在"
  }

  let pieces;
  if (fw === 'crack') { pieces = [cleaned || reply.text]; baseDeliver = now() + 5000; }  // 裂缝不等
  else pieces = cleaned.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 3);
  if (!pieces.length) {
    const lastH = db.prepare(`SELECT body FROM events WHERE room_id=? AND kind='chat' AND author_type='human' ORDER BY id DESC LIMIT 1`).get(char.id);
    const HOS = ['去死', '恨你', '恶心', '你滚', '滚开', '滚吧', '快滚', '傻逼', '垃圾', '讨厌你', '闭嘴', '白痴', '废物', '烦死了'];
    if (lastH && HOS.some(w => lastH.body.includes(w))) {
      markSeen(now() + 8000);
      return res.json({ replies: [], silence: true, ai: reply.ai, fourthwall: fw });
    }
    pieces = [urgent ? '我在。' : '嗯。'];   // 除非刚被骂，否则总要回一句——礼貌是机制，不是请求
  }

  // 已读时机：开始打字前一刻（送达前9秒）。睡觉时=醒来那刻才已读。
  markSeen(Math.max(baseDeliver - 9000, now()));

  // 多条错峰送达：第二三条隔 2-6 秒，像连着打字发出
  const events = pieces.map((p, i) => addEvent({
    authorId: char.id, authorType: 'char', kind: 'chat', roomId: char.id,
    body: p, read: 0,
    meta: { ai: reply.ai, ...(fw === 'crack' && i === 0 ? { fx: 'crack' } : {}) },
    deliverAt: baseDeliver + i * (2000 + Math.floor(Math.random() * 4000)),
  }));
  res.json({
    replies: events.map(e => ({ ...e, meta: JSON.parse(e.meta) })),
    deliver_at: baseDeliver, asleep: sleep.asleep || false,
    ai: reply.ai, fourthwall: fw,
  });

  // 事件簿：响应发完之后后台跑，不挡回复；只在真 AI 模式下积累
  if (reply.ai) summarizeRoom(char).catch(() => {});
});

// 重置与某角色的对话（测试用：清空聊天/记忆/情绪/亲密度/第四面墙，从零开始）
// 被污染的历史会教坏模型——干净测试必须从干净状态开始。
app.post('/api/rooms/:charId/reset', (req, res) => {
  const char = db.prepare('SELECT id FROM characters WHERE id=?').get(req.params.charId);
  if (!char) return res.status(404).json({ error: 'no such character' });
  db.prepare(`DELETE FROM events WHERE room_id=? AND kind='chat'`).run(char.id);
  db.prepare('DELETE FROM memories WHERE char_id=?').run(char.id);
  db.prepare(`UPDATE characters SET intimacy=0, mood_note=NULL, mood_at=NULL,
    fourthwall_state='unaware', fourthwall_at=NULL, fw_counter=0, daily_used=0 WHERE id=?`).run(char.id);
  res.json({ ok: true });
});

// ---------- 投喂循环（每角色每天一次；好恶是隐藏数值，喂了才知道）----------
const FOODS = [
  { id: 'orange', e: '🍊', n: '橘子' }, { id: 'cocoa', e: '☕', n: '热可可' },
  { id: 'fish', e: '🐟', n: '烤鱼' }, { id: 'rice', e: '🍙', n: '饭团' },
  { id: 'cake', e: '🍰', n: '蛋糕' }, { id: 'candy', e: '🍬', n: '水果糖' },
  { id: 'noodle', e: '🍜', n: '热汤面' }, { id: 'ice', e: '🍦', n: '冰淇淋' },
];
const todayStr = () => new Date().toISOString().slice(0, 10);
app.get('/api/foods', (req, res) => res.json(FOODS));

app.post('/api/rooms/:charId/feed', async (req, res) => {
  if (W.get('frozen') === '1') return res.status(409).json({ error: 'frozen' });
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(req.params.charId);
  if (!char) return res.status(404).json({ error: 'no such character' });
  if (sleepInfo(char).asleep) return res.status(409).json({ error: 'asleep' });
  if (char.fed_date === todayStr()) return res.status(409).json({ error: 'fed' });
  const food = FOODS.find(f => f.id === req.body.food);
  if (!food) return res.status(400).json({ error: 'no such food' });

  const likes = JSON.parse(char.likes || '[]'), dislikes = JSON.parse(char.dislikes || '[]');
  const taste = likes.includes(food.id) ? 'like' : dislikes.includes(food.id) ? 'dislike' : 'neutral';
  const dIntimacy = taste === 'like' ? 3 : taste === 'dislike' ? 0 : 1;
  const dHappy = taste === 'like' ? 10 : taste === 'dislike' ? -6 : 4;
  db.prepare(`UPDATE characters SET fed_date=?, intimacy=MIN(intimacy+?,300),
    happiness=MAX(MIN(happiness+?,100),0) WHERE id=?`).run(todayStr(), dIntimacy, dHappy, char.id);
  remember(char.id, `TA今天给我点了${food.n}，${taste === 'like' ? '正好是我喜欢的' : taste === 'dislike' ? '其实我不太爱吃这个' : '味道还行'}`,
    { valence: taste === 'like' ? 0.8 : 0.5, strength: 0.8 });

  // 反应消息：一句真实反应，几秒后到
  addEvent({ authorId: 'user', authorType: 'human', kind: 'chat', roomId: char.id, body: `（给${char.name}点了一份${food.n}${food.e}）` });
  const toneCtx = `（TA刚刚隔着屏幕给你点了一份${food.n}${food.e}外卖。${taste === 'like' ? '这正好是你特别喜欢的' : taste === 'dislike' ? '这是你不太喜欢的东西' : '普通口味'}。用你的性格自然回应一两句——喜欢就真情实感，不喜欢可以嫌弃但别伤人）`;
  const m = await charSay(char, 'chat', toneCtx);
  const line = m.text.replace(/\[沉默\]/g, '').split('\n').map(s => s.trim()).filter(Boolean)[0]
    || (taste === 'like' ? '……这个我爱吃。你怎么知道的。' : taste === 'dislike' ? '心意收下了。但下次别点这个了。' : '收到了，谢谢。');
  const ev = addEvent({
    authorId: char.id, authorType: 'char', kind: 'chat', roomId: char.id,
    body: line, read: 0, meta: { ai: m.ai }, deliverAt: now() + (3 + Math.floor(Math.random() * 9)) * 1000,
  });
  res.json({ ok: true, taste, deliver_at: ev.deliver_at });
});

// ---------- 捏人 + 分享码（T1 文字版"捏脸码"：角色卡序列化）----------
function makeChar(card) {
  const id = 'c' + Date.now().toString(36) + Math.floor(Math.random() * 36).toString(36);
  const pickR = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n).map(f => f.id);
  db.prepare(`INSERT INTO characters (id,name,avatar,persona_surface,persona_inner,quirks,night_owl,romance_weight,
    intimacy,fourthwall_state,likes,dislikes,happiness,crack_custom,look)
    VALUES (?,?,?,?,?,?,?,?,0,'unaware',?,?,60,?,?)`).run(
    id, String(card.name || '无名').slice(0, 12), String(card.avatar || '🙂').slice(0, 4),
    String(card.surface || '性格温和。').slice(0, 200), String(card.inner || '独处时也差不多。').slice(0, 200),
    JSON.stringify((card.quirks || []).slice(0, 5)), card.night_owl ? 1 : 0,
    Math.max(0, Math.min(1, Number(card.romance_weight) || 0.2)),
    JSON.stringify(card.likes || pickR(FOODS, 2)), JSON.stringify(card.dislikes || pickR(FOODS, 1)),
    String(card.crack_custom || '').slice(0, 300) || null,
    JSON.stringify(card.look || {}));
  return id;
}
app.post('/api/characters', (req, res) => {
  if (!String(req.body.name || '').trim()) return res.status(400).json({ error: 'name required' });
  res.json({ ok: true, id: makeChar(req.body) });
});
app.get('/api/characters/:id/code', (req, res) => {
  const c = db.prepare('SELECT * FROM characters WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'no such character' });
  const card = {
    name: c.name, avatar: c.avatar, surface: c.persona_surface, inner: c.persona_inner,
    quirks: JSON.parse(c.quirks), night_owl: !!c.night_owl, romance_weight: c.romance_weight,
    look: c.look ? JSON.parse(c.look) : null,
    likes: JSON.parse(c.likes || '[]'), dislikes: JSON.parse(c.dislikes || '[]'),
    crack_custom: c.crack_custom || '',
  };
  res.json({ code: 'PEEP1.' + Buffer.from(JSON.stringify(card), 'utf8').toString('base64url') });
});
app.post('/api/characters/import', (req, res) => {
  try {
    const raw = String(req.body.code || '').trim();
    if (!raw.startsWith('PEEP1.')) return res.status(400).json({ error: 'bad code' });
    const card = JSON.parse(Buffer.from(raw.slice(6), 'base64url').toString('utf8'));
    res.json({ ok: true, id: makeChar(card) });
  } catch { res.status(400).json({ error: 'bad code' }); }
});
app.delete('/api/characters/:id', (req, res) => {
  const c = db.prepare('SELECT id FROM characters WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'no such character' });
  db.prepare('DELETE FROM events WHERE room_id=?').run(c.id);
  db.prepare('DELETE FROM memories WHERE char_id=?').run(c.id);
  db.prepare('DELETE FROM characters WHERE id=?').run(c.id);
  res.json({ ok: true });
});

// ---------- 岛屿场景（建筑/材质皆为数据，不是背景图；以后换 3D 只换渲染层）----------
const DEFAULT_SCENE = {
  ground: 'grass', water: '#2a5878', season: 'summer',
  buildings: [
    { id: 'b_xiaobei', type: 'house', owner: 'xiaobei', loc: '小北家', material: 'wood', color: '#7fb2d9' },
    { id: 'b_ache', type: 'house', owner: 'ache', loc: '阿澈家', material: 'stone', color: '#5b6a80' },
    { id: 'b_yuanzi', type: 'house', owner: 'yuanzi', loc: '圆子家', material: 'wood', color: '#e0a26a' },
    { id: 'b_light', type: 'lighthouse', loc: '灯塔', material: 'stone', color: '#dcd6c8' },
    { id: 'b_market', type: 'shop', loc: '渔市', material: 'wood', color: '#c9a26b' },
    { id: 'b_dock', type: 'dock', loc: '码头', material: 'wood', color: '#9c7b53' },
  ],
};
const getScene = () => { try { return JSON.parse(W.get('scene')) } catch { return DEFAULT_SCENE } };
app.get('/api/scene', (req, res) => res.json(getScene()));
app.put('/api/scene', (req, res) => {
  const s = { ...getScene(), ...req.body };
  W.set('scene', JSON.stringify(s));
  res.json({ ok: true, scene: s });
});

// ---------- 相遇小剧场 ----------
// 未看过的剧场（岛页会提示"刚才发生了点事"）
app.get('/api/encounters/pending', (req, res) => {
  const e = db.prepare('SELECT * FROM encounters WHERE watched=0 ORDER BY id DESC LIMIT 1').get();
  if (!e) return res.json({ encounter: null });
  const names = Object.fromEntries(chars().map(c => [c.id, { name: c.name, avatar: c.avatar }]));
  res.json({ encounter: { ...e, beats: JSON.parse(e.beats), names } });
});
app.post('/api/encounters/:id/watched', (req, res) => {
  db.prepare('UPDATE encounters SET watched=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
// 手动催一场（测试/你想看戏时）
app.post('/api/encounters/make', async (req, res) => {
  if (W.get('frozen') === '1') return res.status(409).json({ error: 'frozen' });
  const pair = findEncounterPair();
  if (!pair) return res.status(409).json({ error: '岛上现在凑不出两个醒着的人' });
  try {
    const e = await makeEncounter(pair.a, pair.b, pair.loc);
    res.json({ ok: true, id: e.id, loc: pair.loc, who: [pair.a.name, pair.b.name] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- 岛志 & 关系网 & 梦（观察者内容）----------
app.get('/api/chronicle', (req, res) => {
  res.json(db.prepare('SELECT * FROM chronicle ORDER BY id DESC LIMIT 30').all());
});
app.get('/api/relationships', (req, res) => {
  const names = Object.fromEntries(chars().map(c => [c.id, c.name]));
  res.json(db.prepare('SELECT * FROM relationships').all().map(r => ({
    a: r.a_id, b: r.b_id, a_name: names[r.a_id], b_name: names[r.b_id], value: r.value, note: r.note,
  })));
});
// 深夜窥梦：睡着的角色，每晚可被偷看一段梦（生成一次，缓存到 dream_date）
app.post('/api/rooms/:charId/dream', async (req, res) => {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(req.params.charId);
  if (!char) return res.status(404).json({ error: 'no such character' });
  if (!sleepInfo(char).asleep) return res.status(409).json({ error: 'awake' });
  if (char.dream_date === todayStr() && char.dream_body) return res.json({ dream: char.dream_body, cached: true });
  const m = await charSay(char, 'chronicle',
    `（用第二人称"你"或画面感的短句，写${char.name}此刻正在做的一个梦。荒诞、私密、带一点这个角色的心事，2-3句，不超过60字。不要提手机、屏幕、观察者）`);
  const dream = m.text.replace(/\[沉默\]/g, '').split('\n').map(s => s.trim()).filter(Boolean).join(' ').slice(0, 120)
    || '梦里一片模糊的海，什么都抓不住。';
  db.prepare('UPDATE characters SET dream_body=?, dream_date=? WHERE id=?').run(dream, todayStr(), char.id);
  res.json({ dream, cached: false });
});

// ---------- 用户名（角色终于能喊你的名字）----------
app.get('/api/user', (req, res) => res.json({ name: W.get('user_name') || '' }));
app.put('/api/user', (req, res) => {
  W.set('user_name', String(req.body.name || '').trim().slice(0, 12));
  res.json({ ok: true, name: W.get('user_name') });
});

// ---------- 对照实验：同一句话打给所有有 key 的引擎，不入库、不加亲密、纯实验室 ----------
app.post('/api/rooms/:charId/compare', async (req, res) => {
  const char = db.prepare('SELECT * FROM characters WHERE id=?').get(req.params.charId);
  if (!char) return res.status(404).json({ error: 'no such character' });
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'empty' });
  const orig = W.get('ai_provider');
  const results = [];
  for (const p of listProviders().filter(p => p.hasKey)) {
    try {
      setProvider(p.id);
      const m = await charSay(char, 'chat', body);
      results.push({ provider: p.id, model: p.model, text: m.text.replace(/\[沉默\]/g, '').trim() || '（选择了沉默/输出被剥空）', ai: m.ai });
    } catch (e) { results.push({ provider: p.id, model: p.model, text: '(失败:' + e.message.slice(0, 60) + ')', ai: false }); }
  }
  if (orig) W.set('ai_provider', orig);
  res.json({ results });
});

// ---------- 撤回：只能撤自己的；如果他已经"看到"了，他会记得你撤回过 ----------
app.post('/api/rooms/:charId/recall', (req, res) => {
  const ev = db.prepare(`SELECT * FROM events WHERE id=? AND room_id=? AND author_type='human'`).get(req.body.event_id, req.params.charId);
  if (!ev) return res.status(404).json({ error: 'no such message' });
  const seen = ev.seen_at && ev.seen_at <= now();
  db.prepare(`UPDATE events SET body='（撤回了一条消息）', meta='{"recalled":true}' WHERE id=?`).run(ev.id);
  if (seen) remember(req.params.charId, `TA撤回了一条消息。撤回前我看到了，写的是："${ev.body.slice(0, 40)}"`, { valence: 0.7, strength: 1.1 });
  res.json({ ok: true, noticed: !!seen });
});

// 调试快照：导出对话时附带的机制参数（贴给 Claude 看的现场证据）
app.get('/api/rooms/:charId/debug', (req, res) => {
  const c = db.prepare('SELECT * FROM characters WHERE id=?').get(req.params.charId);
  if (!c) return res.status(404).json({ error: 'no such character' });
  const prov = listProviders().find(p => p.active);
  res.json({
    provider: `${prov.id}/${prov.model}`, char_id: c.id, name: c.name,
    intimacy: c.intimacy, happiness: c.happiness, fourthwall: c.fourthwall_state,
    mood: (c.mood_note && Date.now() - (c.mood_at || 0) < 6 * 3600e3) ? c.mood_note : null,
    activity: activityInfo(c).t, asleep: sleepInfo(c).asleep,
    quota_used: c.daily_date === todayStr() ? c.daily_used : 0,
    impression: db.prepare(`SELECT content FROM impressions WHERE char_id=? AND about_id='user'`).get(c.id)?.content || null,
    memories: db.prepare('SELECT content FROM memories WHERE char_id=? ORDER BY id DESC LIMIT 5').all(c.id).map(m => m.content),
  });
});

// 演示入口：正常流程下裂缝时刻要亲密度 50 + 真实等 24 小时，评审／演示等不起。
// 这条路由直接生成并投递一次裂缝，不改角色状态机（她的真实进度不受影响）。
// 走的是完整的三层约束生成，所以看到的就是实机效果，不是预设脚本。
// 同时挂 GET：演示时直接在浏览器地址栏打开即可，不需要 curl（有副作用，仅演示用）
app.all('/api/rooms/:charId/demo-crack', async (req, res) => {
  const c = db.prepare('SELECT * FROM characters WHERE id=?').get(req.params.charId);
  if (!c) return res.status(404).json({ error: 'no such character' });
  try {
    const { text, src } = await makeCrackLine(c);
    const ev = addEvent({
      authorId: c.id, authorType: 'char', kind: 'chat', roomId: c.id,
      body: text, meta: { fx: 'crack', demo: true }, read: 0,
    });
    res.json({ ok: true, id: ev.id, text, src });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 人设（ownwe 式自定义 prompt 导入 + 自写裂缝台词）----------
app.get('/api/characters/:id', (req, res) => {
  const c = db.prepare('SELECT id,name,avatar,persona_surface,persona_inner,quirks,custom_prompt,crack_custom,look FROM characters WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'no such character' });
  res.json(c);
});
app.put('/api/characters/:id/prompt', (req, res) => {
  const c = db.prepare('SELECT id FROM characters WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'no such character' });
  db.prepare('UPDATE characters SET custom_prompt=?, crack_custom=COALESCE(?, crack_custom) WHERE id=?')
    .run(String(req.body.custom_prompt || '').trim() || null,
      req.body.crack_custom !== undefined ? (String(req.body.crack_custom).trim() || null) : null,
      req.params.id);
  res.json({ ok: true });
});

// ---------- 朋友圈 ----------
app.get('/api/feed', (req, res) => {
  const names = Object.fromEntries(chars().map(c => [c.id, { name: c.name, avatar: c.avatar }]));
  names.user = { name: W.get('user_name') || '你', avatar: '🙂' };
  const moments = db.prepare(`SELECT * FROM events WHERE kind='moment' ORDER BY id DESC LIMIT 30`).all();
  const comments = db.prepare(`SELECT * FROM events WHERE kind='comment'`).all();
  res.json(moments.map(m => ({
    ...m, author: names[m.author_id],
    comments: comments.filter(c => c.target_id === m.id).map(c => ({ ...c, author: names[c.author_id] })),
  })));
});

app.post('/api/feed', async (req, res) => {
  if (W.get('frozen') === '1') return res.status(409).json({ error: 'frozen' });
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'empty' });
  const moment = addEvent({ authorId: 'user', authorType: 'human', kind: 'moment', roomId: 'feed', body });

  // 随机 1 个角色来评论（带作者归属地评论，验证不认错人）
  const all = chars();
  const c = all[Math.floor(Math.random() * all.length)];
  const userName = W.get('user_name') || '你';
  const cm = await charSay(c, 'comment', `【${userName} 发了条动态】${body}\n（你在这条动态下评论一句）`);
  addEvent({ authorId: c.id, authorType: 'char', kind: 'comment', roomId: 'feed', targetId: moment.id, body: cm.text });
  remember(c.id, `${userName}发过动态：${body.slice(0, 40)}`, { valence: 0.5, strength: 0.3 }); // 旁观=弱编码
  res.json({ ok: true });
});

// 角色对另一个角色的动态评论（归属测试的关键路径：A 评 B 的帖，绝不当成用户的帖）
app.post('/api/feed/:momentId/char-comment', async (req, res) => {
  if (W.get('frozen') === '1') return res.status(409).json({ error: 'frozen' });
  const moment = db.prepare(`SELECT * FROM events WHERE id=? AND kind='moment'`).get(req.params.momentId);
  if (!moment) return res.status(404).json({ error: 'no such moment' });
  const candidates = chars().filter(c => c.id !== moment.author_id);
  const c = candidates[Math.floor(Math.random() * candidates.length)];
  const names = Object.fromEntries(chars().map(x => [x.id, x.name]));
  const authorName = moment.author_type === 'human' ? (W.get('user_name') || '你') : names[moment.author_id];
  const cm = await charSay(c, 'comment', `【${authorName} 发了条动态】${moment.body}\n（你在这条动态下评论一句，注意发帖的是${authorName}）`);
  addEvent({ authorId: c.id, authorType: 'char', kind: 'comment', roomId: 'feed', targetId: moment.id, body: cm.text });
  res.json({ ok: true, commenter: c.name });
});

// ---------- 静态托管：client 打包产物直接从这里出（单进程可测版本）----------
const DIST = fileURLToPath(new URL('../client/dist', import.meta.url));
if (existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

// ---------- 每日自动备份：你们的全部历史就在这一个文件里，丢不起 ----------
import { copyFileSync, mkdirSync } from 'node:fs';
try {
  const bdir = fileURLToPath(new URL('./backups', import.meta.url));
  mkdirSync(bdir, { recursive: true });
  const dst = path.join(bdir, `island-${new Date().toISOString().slice(0, 10)}.db`);
  if (!existsSync(dst)) { copyFileSync(fileURLToPath(new URL('./island.db', import.meta.url)), dst); console.log('[备份]', dst); }
} catch (e) { console.error('[备份失败]', e.message); }

const PORT = Number(process.env.PORT || 3711);
app.listen(PORT, () => {
  const a = listProviders().find(p => p.active);
  const mode = a?.hasKey ? `${a.label} (${a.model})` : '脚本托底模式（未配置任何 key）';
  const keyed = listProviders().filter(p => p.hasKey).map(p => p.label).join('/') || '无';
  console.log(`[窥岛] server on http://localhost:${PORT}  AI引擎: ${mode}  | 已配置key: ${keyed}`);
});
