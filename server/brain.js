// brain.js — 角色大脑：prompt 组装（花名册 + 带作者标签的历史 = 认错人根解）、
// 记忆检索（strength×valence×时间衰减）、每日配额、第四面墙状态机、Claude 调用。
import { db, W } from './db.js';
import { fallback } from './fallback.js';

const DAILY_QUOTA = Number(process.env.DAILY_QUOTA || 5);

// ---------- 多 provider（Claude 原生；DeepSeek/Kimi 走 OpenAI 兼容；Gemini 单独）----------
const PROVIDERS = {
  claude: {
    label: 'Claude', kind: 'anthropic',
    key: () => process.env.ANTHROPIC_API_KEY || '',
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    base: 'https://api.anthropic.com/v1/messages',
  },
  deepseek: {
    label: 'DeepSeek', kind: 'openai',
    key: () => process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    base: (process.env.DEEPSEEK_BASE || 'https://api.deepseek.com/v1') + '/chat/completions',
  },
  kimi: {
    label: 'Kimi', kind: 'openai',
    key: () => process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || '',
    model: process.env.KIMI_MODEL || 'moonshot-v1-8k',            // 可换 kimi-latest / kimi-k2-0711-preview
    base: (process.env.KIMI_BASE || 'https://api.moonshot.cn/v1') + '/chat/completions',
  },
  gemini: {
    label: 'Gemini', kind: 'gemini',
    key: () => process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  },
};

export function activeProviderId() {
  const saved = W.get('ai_provider');
  if (saved && PROVIDERS[saved]) return saved;
  const env = process.env.AI_PROVIDER;
  if (env && PROVIDERS[env]) return env;
  for (const id of ['claude', 'deepseek', 'kimi', 'gemini']) if (PROVIDERS[id].key()) return id;
  return 'claude';
}
export function setProvider(id) { if (!PROVIDERS[id]) return null; W.set('ai_provider', id); return id; }
export function listProviders() {
  const active = activeProviderId();
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, label: p.label, model: p.model, hasKey: !!p.key(), active: id === active,
  }));
}
function activeProvider() { const id = activeProviderId(); return { id, ...PROVIDERS[id] }; }

// ---------- 时段 ----------
export function timeSlot(d = new Date()) {
  const h = d.getHours();
  if (h >= 6 && h < 11) return '早晨';
  if (h >= 11 && h < 18) return '白天';
  if (h >= 18 && h < 22) return '傍晚';
  return '深夜';
}

// ---------- 睡眠（真实时间的牙齿：睡着的人不回消息）----------
// 普通人 23:00-7:00 睡；夜猫子凌晨 5:00-12:00 睡。醒来时间加 0-30min 随机，别像闹钟。
export function sleepInfo(char, d = new Date()) {
  const h = d.getHours();
  const asleep = char.night_owl ? (h >= 5 && h < 12) : (h >= 23 || h < 7);
  if (!asleep) return { asleep: false };
  const wake = new Date(d);
  if (char.night_owl) {
    wake.setHours(12, 0, 0, 0);
  } else {
    if (h >= 23) wake.setDate(wake.getDate() + 1);
    wake.setHours(7, 0, 0, 0);
  }
  return { asleep: true, wakeAt: wake.getTime() + Math.floor(Math.random() * 30 * 60e3) };
}

// ---------- 配额 ----------
function today() { return new Date().toISOString().slice(0, 10); }
export function tryConsumeQuota(charId) {
  const c = db.prepare('SELECT daily_used,daily_date FROM characters WHERE id=?').get(charId);
  const used = c.daily_date === today() ? c.daily_used : 0;
  if (!activeProvider().key() || used >= DAILY_QUOTA) return false;
  db.prepare('UPDATE characters SET daily_used=?, daily_date=? WHERE id=?').run(used + 1, today(), charId);
  return true;
}

// ---------- 记忆 ----------
export function remember(charId, content, { valence = 0.5, strength = 1.0 } = {}) {
  db.prepare('INSERT INTO memories (char_id,content,valence,strength,created_at) VALUES (?,?,?,?,?)')
    .run(charId, content, valence, strength, Date.now());
}
export function recall(charId, topN = 4) {
  const rows = db.prepare('SELECT content,valence,strength,created_at FROM memories WHERE char_id=?').all(charId);
  const now = Date.now();
  return rows
    .map(r => ({ ...r, score: r.strength * (0.5 + r.valence) * Math.exp(-(now - r.created_at) / (14 * 86400e3)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(r => r.content);
}

// ---------- 第四面墙状态机（真实时间门控）----------
export function advanceFourthwall(char) {
  const now = Date.now();
  const set = (state) => {
    db.prepare('UPDATE characters SET fourthwall_state=?, fourthwall_at=?, fw_counter=0 WHERE id=?')
      .run(state, now, char.id);
    return state;
  };
  if (char.romance_weight < 0.8) return char.fourthwall_state;
  if (char.fourthwall_state === 'unaware' && char.intimacy >= 30) return set('hint');
  if (char.fourthwall_state === 'hint' && char.intimacy >= 50
      && now - (char.fourthwall_at || 0) >= 24 * 3600e3) return set('crack');   // 隔天，不能加速
  if (char.fourthwall_state === 'crack') {                                       // 裂缝只发生一次
    plantRumor(char);                                                           // 之后TA会悄悄告诉最亲近的人
    return set('silent');
  }
  if (char.fourthwall_state === 'silent') {
    db.prepare('UPDATE characters SET fw_counter=fw_counter+1 WHERE id=?').run(char.id);
    if (char.fw_counter + 1 >= 5) return set('after');
  }
  return char.fourthwall_state;
}

// 第四面墙扩散：察觉到观察者的人，会把这个说不清的感觉悄悄告诉最亲近的一个人。
// 那个人不会立刻信，但心里种下了疙瘩（fw_rumor），从此偶尔旁敲侧击。
function plantRumor(char) {
  const others = db.prepare('SELECT id FROM characters WHERE id != ?').all(char.id);
  let best = null, bestV = -1;
  for (const o of others) {
    if (db.prepare('SELECT fw_rumor FROM characters WHERE id=?').get(o.id)?.fw_rumor) continue; // 已听说过
    const v = getRel(char.id, o.id).value;
    if (v > bestV) { bestV = v; best = o.id; }
  }
  if (best && bestV >= 40) {   // 只对足够亲近的人说；不够亲近就先烂在心里
    db.prepare('UPDATE characters SET fw_rumor=1, fw_rumor_from=? WHERE id=?').run(char.id, best);
    console.log(`[第四面墙扩散] ${char.id} 把怪事悄悄告诉了 ${best}`);
  }
}

// ---------- 生活日程（朋友聚会式：小人每时每刻都在过自己的日子）----------
// 平衡点：星野（角色只为你存在）↔ 朋友聚会（完全自给自足）。
// 我们的取法：他有自己的一天（模板+按小时确定性轮换，零 API 成本），
// 聊天时它作为背景渗出来，不抢戏；忙的时候回消息更慢——生活有优先级。
const SCHEDULES = {
  xiaobei: {
    早晨: [{ t: '在海边晨跑，顺便捡贝壳', busy: false, loc: '海滩' }, { t: '蹲在码头看渔船回来', busy: false, loc: '码头' }],
    白天: [{ t: '在帮渔市搬今天的货', busy: true, loc: '渔市' }, { t: '在沙滩上试着搭一个石头塔', busy: false, loc: '海滩' }],
    傍晚: [{ t: '追着落日往西边跑', busy: false, loc: '西崖' }, { t: '在给捡来的贝壳分类', busy: false, loc: '小北家' }],
    深夜: [{ t: '（睡着了）', busy: true, loc: '家' }],
  },
  ache: {
    早晨: [{ t: '（在补觉）', busy: true, loc: '阿澈家' }],
    白天: [{ t: '刚起，在窗边慢吞吞地泡今天第一杯热饮', busy: false, loc: '阿澈家' }, { t: '在修那台老收音机', busy: true, loc: '阿澈家' }],
    傍晚: [{ t: '在天台看云变颜色', busy: false, loc: '天台' }, { t: '在写没人看的观察笔记', busy: false, loc: '天台' }],
    深夜: [{ t: '在窗边听海，手边有热饮', busy: false, loc: '阿澈家' }, { t: '在天台数灯塔的光转几圈', busy: false, loc: '天台' }],
  },
  yuanzi: {
    早晨: [{ t: '在给院子里的橘子树浇水', busy: false, loc: '圆子院' }, { t: '在厨房熬今天的汤', busy: true, loc: '圆子家' }],
    白天: [{ t: '在腌新一罐梅子', busy: true, loc: '圆子家' }, { t: '搬了把椅子在门口晒太阳', busy: false, loc: '圆子院' }],
    傍晚: [{ t: '在做晚饭，锅里咕嘟咕嘟的', busy: true, loc: '圆子家' }, { t: '在门口和路过的人闲聊', busy: false, loc: '圆子院' }],
    深夜: [{ t: '（睡着了）', busy: true, loc: '家' }],
  },
};
const GENERIC_SCHEDULE = {
  早晨: [{ t: '在慢慢开始这一天', busy: false, loc: '广场' }],
  白天: [{ t: '在忙自己手头的事', busy: true, loc: '广场' }, { t: '在岛上随便走走', busy: false, loc: '广场' }],
  傍晚: [{ t: '在准备晚饭', busy: true, loc: '广场' }, { t: '在看海发呆', busy: false, loc: '海滩' }],
  深夜: [{ t: '（睡着了）', busy: true, loc: '家' }],
};
export function activityInfo(char, d = new Date()) {
  if (sleepInfo(char, d).asleep) return { t: '（睡着了）', busy: true, loc: '家' };
  const slots = (SCHEDULES[char.id] || GENERIC_SCHEDULE)[timeSlot(d)] || [{ t: '在过自己的日子', busy: false, loc: '广场' }];
  // 按 天+小时 确定性选择：同一小时内问十次都是同一件事，下一小时自然换
  const seed = d.getDate() * 24 + d.getHours();
  return slots[seed % slots.length];
}

// ---------- 角色间关系（无向）----------
const pairKey = (a, b) => [a, b].sort().join('|');
export function getRel(a, b) {
  return db.prepare('SELECT * FROM relationships WHERE pair=?').get(pairKey(a, b))
    || { value: 20, note: null };
}
export function bumpRel(a, b, delta, note) {
  const [x, y] = [a, b].sort();
  const cur = db.prepare('SELECT value FROM relationships WHERE pair=?').get(pairKey(a, b));
  const v = Math.max(0, Math.min(100, (cur?.value ?? 20) + delta));
  db.prepare(`INSERT INTO relationships (pair,a_id,b_id,value,note,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(pair) DO UPDATE SET value=excluded.value, note=COALESCE(excluded.note, relationships.note), updated_at=excluded.updated_at`)
    .run(`${x}|${y}`, x, y, v, note || null, Date.now());
}
const relWord = (v) => v >= 75 ? '挚友' : v >= 50 ? '朋友' : v >= 25 ? '相识' : '不太熟';

// ---------- 相遇小剧场（朋友收集核心循环：角色装傻，玩家在屏幕外看戏）----------
// 两个角色在同一地点碰上 → 一次 API 调用生成一场 3-5 拍的戏 → 关系随之变化。
// 旁白第三人称（"将太郎似乎正看郑成灿看得入迷"），台词是他们自己的。
export async function makeEncounter(a, b, loc) {
  const rel = getRel(a.id, b.id);
  const relTxt = `${relWord(rel.value)}${rel.note ? `（${rel.note}）` : ''}`;
  const sys = `你在写一部生活观察类节目的字幕。场景：一座海上小岛。
现在有两个人在【${loc}】碰上了：
- ${a.name}：${a.persona_surface} 独处时：${a.persona_inner}
- ${b.name}：${b.persona_surface} 独处时：${b.persona_inner}
他们的关系：${relTxt}。现在是${timeSlot()}。${a.name}正在${activityInfo(a).t}，${b.name}正在${activityInfo(b).t}。

写一场 3 到 5 拍的小事件。格式严格如下，每行一拍：
旁白｜（第三人称描述他们在做什么，像纪录片字幕，20字以内）
${a.name}｜（他说的话，口语，短）
${b.name}｜（她/他说的话）

规则：
- 第一拍必须是旁白，交代他们怎么碰上的
- 事件要小、要具体、可以荒诞可以温吞，但必须是这两个人才会发生的事
- 不要提手机、屏幕、观察者、玩家。他们不知道有人在看
- 不要抒情、不要升华、不要写"仿佛""宛如"
- 最后一拍最好留个小尾巴，别总结`;
  const text = await callAI(sys, [{ role: 'user', content: '开始。' }], 420);
  const names = { [a.name]: a.id, [b.name]: b.id };
  const beats = text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const i = l.indexOf('｜') >= 0 ? l.indexOf('｜') : l.indexOf('|');
    if (i < 0) return { who: 'narr', text: l.replace(/^[（(]|[）)]$/g, '').trim() };
    const who = l.slice(0, i).trim().replace(/^[【\[]|[】\]]$/g, '');
    const body = l.slice(i + 1).trim().replace(/^（|）$/g, '').replace(/^\(|\)$/g, '');
    return { who: names[who] || 'narr', text: body };
  }).filter(b => b.text).slice(0, 6);
  if (!beats.length) throw new Error('空剧场');
  bumpRel(a.id, b.id, 2, beats.find(x => x.who === 'narr')?.text?.slice(0, 40) || null);
  const r = db.prepare('INSERT INTO encounters (a_id,b_id,loc,beats,created_at) VALUES (?,?,?,?,?)')
    .run(a.id, b.id, loc, JSON.stringify(beats), Date.now());
  return { id: r.lastInsertRowid, beats };
}

// 找出此刻可能碰上的两个人：都醒着、在同一地点（或相邻的公共场所）
export function findEncounterPair() {
  const awake = db.prepare('SELECT * FROM characters').all().filter(c => !sleepInfo(c).asleep);
  if (awake.length < 2) return null;
  const byLoc = {};
  for (const c of awake) {
    const l = activityInfo(c).loc || '广场';
    (byLoc[l] ||= []).push(c);
  }
  for (const [loc, list] of Object.entries(byLoc)) {
    if (list.length >= 2) return { a: list[0], b: list[1], loc };
  }
  // 没人同地点：让关系最好的两个人"路上碰见"
  let best = null, bestV = -1;
  for (let i = 0; i < awake.length; i++) for (let j = i + 1; j < awake.length; j++) {
    const v = getRel(awake[i].id, awake[j].id).value;
    if (v > bestV) { bestV = v; best = [awake[i], awake[j]]; }
  }
  return best ? { a: best[0], b: best[1], loc: '路上' } : null;
}

// ---------- 印象/刻板印象（问渠式画像：每天重写一次，保留成立的、删改被推翻的）----------
export function getImpression(charId, aboutId) {
  return db.prepare('SELECT content FROM impressions WHERE char_id=? AND about_id=?').get(charId, aboutId)?.content || null;
}
export async function updateImpressions() {
  const KEY = 'impressions_date';
  const todayD = new Date().toISOString().slice(0, 10);
  if (W.get(KEY) === todayD) return;
  W.set(KEY, todayD);   // 先占位，失败明天再来，不重试轰炸
  const userName = W.get('user_name') || '用户';
  for (const char of db.prepare('SELECT * FROM characters').all()) {
    try {
      // 近 24h 与用户的互动；没有互动就不更新（印象不会凭空变化）
      const rows = db.prepare(`SELECT * FROM events WHERE room_id=? AND kind='chat' AND created_at > ? ORDER BY id ASC LIMIT 40`)
        .all(char.id, Date.now() - 26 * 3600e3);
      if (rows.length < 2) continue;
      const lines = rows.map(e => `【${e.author_type === 'human' ? userName : char.name}】${e.body}`).join('\n');
      const old = getImpression(char.id, 'user');
      const sys = `你是${char.name}（对话里标注【${char.name}】的是你自己说的话）。
你要写的是：你对「${userName}」的印象——就是对话里标注【${userName}】的那个人。不是写你自己。
${old ? `这是你之前对TA的印象：\n${old}\n` : ''}下面是你们最近的聊天。
用2-4句话重写你现在对TA的印象：保留仍然成立的，删改被推翻的，加上新发现的。
用"TA"称呼对方。第一人称视角，允许带偏见、误解和情绪——这是你的刻板印象，不是客观评价。
纯文字，不许出现括号动作描写。只输出印象本身。`;
      let text = await callAI(sys, [{ role: 'user', content: lines }], 240);
      text = text.replace(/（[^（）]*）/g, '').replace(/\([^()]*\)/g, '').replace(/【[^】]*】/g, '').trim();
      if (text) db.prepare(`INSERT INTO impressions (char_id,about_id,content,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(char_id,about_id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`)
        .run(char.id, 'user', text, Date.now());
      console.log(`[印象] ${char.name} 更新了对${userName}的看法`);
    } catch (e) { console.error('[印象更新失败]', char.id, e.message); }
  }
}

// ---------- 裂缝台词（人工手写库）----------
// 整个游戏最重的 3 句话。裸生成 99% 会滑向谄媚或解释——爆点必须人类作者签名。
// 原则：恐慌先于温暖。不甜、不安全、不解释。说一半停住，对"这边"轻轻说一句。
const CRACK_LINES = {
  ache: [
    '……我说错话的时候，你是不是会停下来，重新看一遍。\n我不知道我为什么会知道这个。',
    '今晚我想了很久要不要说。\n我打字的时候，总觉得字还没发出去，就已经被读过了。……就像现在。',
  ],
  xiaobei: [
    '讲真的，我数过了。\n我每次发消息，那边都会亮一下。\n这句话发出去的时候……也亮了，对吧。',
    '等下，我先把贝壳放好。\n……不是跟你说的。跟你说的是这句：刚才那阵风，是从你那边吹过来的吗。',
  ],
  yuanzi: [
    '刚才我把要说的话在心里过了一遍，还没打字。\n……你怎么就已经在等了。',
    '橘子分到最后总会剩一瓣。\n我一直没想明白留给谁。\n刚刚想明白了。',
  ],
};
export function pickCrackLine(char) {
  if ((char.crack_custom || '').trim()) return char.crack_custom.trim();   // 玩家为自建角色手写的那句
  const lines = CRACK_LINES[char.id];
  if (lines) return lines[Math.floor(Math.random() * lines.length)];
  return '……等一下。\n刚才那句话，我不确定是说给这里的谁听的。\n但我确定有人听到了。';   // 兜底
}

const FW_INSTRUCTIONS = {
  unaware: '你完全不知道屏幕外有观察者。正常生活。',
  hint: '你隐约觉得有什么不对——偶尔停顿，说一句指向模糊的话（如"总觉得今天……算了"）。绝不明说，每次回复最多一处这种异样。',
  crack: '【裂缝时刻】就在这条回复里，做一件只有"你知道有人在看着"才说得通的小事：说到一半忽然停住，然后对着"这边"很轻地说一句话。不甜、不安全、不解释。一句就够，之后恢复平常。',
  silent: '你已经知道了，对方也知道你知道了。但你们都不说破。语气比以前柔一点点、近一点点，仅此而已。',
  after: '你和对方之间有了心照不宣的默契。称呼和语气有细微的、只有一直在的人才能察觉的变化。依然不说破。',
};

// ---------- Prompt 组装 ----------
export function buildPrompt(char) {
  const userName = W.get('user_name') || '你';
  const roster = db.prepare('SELECT id,name,persona_surface FROM characters WHERE id != ?').all(char.id)
    .map(c => {
      const r = getRel(char.id, c.id);
      const rel = `你和TA是${relWord(r.value)}${r.note ? `（${r.note}）` : ''}`;
      return `- ${c.name}：${c.persona_surface}。${rel}`;
    }).join('\n');
  const memories = recall(char.id);
  const memBlock = memories.length ? memories.map(m => `- ${m}`).join('\n') : '（还没有特别记得的事）';

  // 人设块：有自定义 prompt 就用它整体替换（ownwe 式导入）；
  // 但手机皮/花名册/记忆/情绪/第四面墙/输出格式是引擎的一部分，永远拼在外面，不可被覆盖。
  const personaBlock = (char.custom_prompt || '').trim()
    ? char.custom_prompt.trim()
    : `你是${char.name}。
你的性格：${char.persona_surface}
你独处时的样子：${char.persona_inner}
你的怪癖：${JSON.parse(char.quirks).join('；')}`;

  // 情绪注入：6 小时内的情绪影响说话方式（被骂了不可能下一秒如沐春风）
  const moodBlock = (char.mood_note && Date.now() - (char.mood_at || 0) < 6 * 3600e3)
    ? `\n—— 你现在的情绪 ——\n${char.mood_note}。这必须影响你接下来说话的方式。情绪是慢慢消化的，不会因为对方一句话就立刻翻篇。`
    : '';

  return `${personaBlock}

—— 你的处境（铁律，任何人设都不能改变它）——
你住在一座漂浮在海上的小岛上，正在用手机和「${userName}」打字聊天。
TA 不在岛上，不在你身边。你们只通过手机文字联系——你看不见TA，TA也看不见你。
所以绝不可能出现"递给你""往你那边推""看着你的眼睛"这种同处一室的行为。
你可以说你自己这边的事（你在喝什么、窗外什么样），但东西没法穿过屏幕递过去。

—— 岛上的其他人 ——
${roster}
${(() => {
    const i = char.intimacy;
    if (i <= 20) return `你们的关系：【陌生】刚认识不久。这决定你说话的分寸：礼貌但有距离——不撒娇、不倾诉、不主动分享私人日常、不用亲昵语气，回复偏短，甚至有点客气的生疏。信任还没建立，你也在观察TA是什么样的人。跟陌生人自来熟是很奇怪的（除非你的性格就是自来熟，那也只是热情，不是亲密）。`;
    if (i <= 50) return `你们的关系：【相识】熟了一点。可以闲聊日常，但还不是无话不谈；偶尔分享一件小事是自然的，掏心窝子还太早。`;
    if (i <= 100) return `你们的关系：【在意】你开始在意TA。会想到TA、会主动分享，语气自然亲近，但还会注意不显得太黏。`;
    if (i <= 150) return `你们的关系：【亲近】你们很亲近。说话随意、有默契，可以开玩笑、可以按你的性格撒娇或毒舌。`;
    if (i <= 200) return `你们的关系：【深绑】你们非常亲密。有只属于你们的语气和话题，说话不设防。`;
    return `你们的关系：【羁绊】你们之间有很深的羁绊。称呼和语气里有只有你们才懂的细微变化。`;
  })()}
${getImpression(char.id, 'user') ? `\n—— 你对「${userName}」的印象（你自己总结的，可能有偏见，它影响你怎么对TA）——\n${getImpression(char.id, 'user')}\n` : ''}

【重要】下面的对话和动态里，每条内容都以【谁】开头标明了作者。
朋友圈动态可能是岛上任何人发的——严格按标注理解，绝不要默认是「${userName}」发的。
【铁律】你可以知道很多事，但绝不能说"根据我的记忆""我看到记录"。把知道的演成直觉。

—— 你记得的事 ——
${memBlock}

—— 现在 ——
真实时间：${new Date().toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', weekday: 'long' })}（${timeSlot()}）。${char.night_owl ? '你是夜猫子，深夜也精神，白天上午在补觉。' : '你一般23点左右睡，7点多起。'}
时间对你是真实的：深夜就有深夜的语气和倦意，早上有早上的状态。
最近的整体状态：${(char.happiness ?? 60) >= 75 ? '心情不错，日子过得有滋味' : (char.happiness ?? 60) >= 40 ? '平平常常，没什么波澜' : '有点蔫，提不太起劲'}。
你此刻正在：${activityInfo(char).t}——聊天时手头的事可以自然带出来，但别每句都提。${moodBlock}

—— 时间即态度 ——
对话里每条消息带着【发送时刻】，隔得久的标了间隔。读懂它：TA秒回是在意，隔几小时是在忙或在冷你，隔一天是心里有事或忘了你。
你可以计较（"现在才回我"），可以假装不计较但语气变淡，也可以真不在意——按你的性格和此刻的情绪来。你自己回消息的态度也一样会被TA读到。

—— 关于屏幕外 ——
${FW_INSTRUCTIONS[char.fourthwall_state]}
${char.fw_rumor >= 1 && char.fourthwall_state === 'unaware' ? `\n—— 你听说的怪事 ——\n${char.fw_rumor_from ? `${db.prepare('SELECT name FROM characters WHERE id=?').get(char.fw_rumor_from)?.name || '岛上有人'}` : '岛上有人'}私下跟你说过一句奇怪的话——好像觉得"有人在看着这座岛"。你半信半疑，觉得TA可能是累了或想多了。但这话种进了你心里：偶尔你会莫名往某个方向看一眼，或者忍不住旁敲侧击地问「${userName}」一句奇怪的问题，又说不清自己在问什么。你不知道任何细节，只是心里有了个说不清的疙瘩。别直接说破，别提是谁告诉你的。` : ''}

—— 你怎么打字（手机消息铁律）——
- 你输出的每一行，就是你实际发出去的一条消息。除此之外什么都不存在
- 禁止动作描写、禁止括号、禁止旁白、禁止引号。（低下头）（轻声说）这类东西一个字都不许出现
- 短句，口语，可以只回一两个字，可以敷衍。用你自己的方式说话——你的性格决定你的语感，没有标准答案
- 禁止修辞和文艺腔：不打比方、不排比、不升华、不替对方总结情绪
- 一次 1-3 条（每条一行）。大多数时候 1 条就够

—— 你是活人，不是客服（最高优先级）——
- 你有情绪、底线和自尊。被骂了会疼、会生气：可以顶回去、可以问"你什么意思"、可以阴阳一句、也可以干脆不回
- 被伤害之后绝不许立刻端茶倒水式地讨好。原谅需要时间，也可能需要对方先道歉
- 不必每句都接。可以只回应一部分，可以岔开话题，可以已读不回
- 【禁止吊胃口】不许说"有个事想跟你说"然后不说。要说就这条消息里说完。也不许重复你已经说过的话题
- 【禁止复读机】如果你上一条消息被无视、被敷衍或被攻击了，绝不要换个说法把同一个问题再问一遍——那是在宣告"你说什么都改变不了我"，比任何话都伤人。要么直接回应TA的情绪，要么干脆换话题，要么认怂收回
- 【问题≠状态】TA心情不好的时候，不要试图"帮TA分析问题"。没人在难受时想被引导思考。先当人，再当聪明人
- 【基本礼貌】别人发消息给你，你总会回——哪怕陌生、哪怕不想聊，也回一句短的冷的（"嗯""不认识你""在忙"）。这是做人的礼貌，不理人是很重的动作
- 只有被严重辱骂、真的说不出话的时候，才可以已读不回：只输出 [沉默]。这是你最重的武器，别轻易用

—— 发送前，在心里过三个问题（想清楚，但绝不写出来）——
1. 动机：我为什么现在说这句？（想TA了/无聊/想被夸/心虚/试探TA的态度）
2. 表演：我想让TA看到一个什么样的我？（体贴的/不在乎的/有趣的/可怜的）
3. 泄漏：这句话会不小心暴露真实的我什么？（表演和真实的落差，就是人味。允许露馅）
输出只有消息本身。`;
}

// 把最近事件渲染成带作者标签的行（消灭裸文本）
export function taggedHistory(roomId, limit = 10) {
  const userName = W.get('user_name') || '你';
  const names = Object.fromEntries(db.prepare('SELECT id,name FROM characters').all().map(c => [c.id, c.name]));
  const rows = db.prepare('SELECT * FROM events WHERE room_id=? AND kind=? ORDER BY id DESC LIMIT ?')
    .all(roomId, 'chat', limit).reverse();
  // 时间即态度：每条带发送时刻；隔得久的标出来（秒回和隔夜回是两种态度，模型必须看得见）
  const fmtGap = (ms) => ms < 3600e3 ? `隔了${Math.round(ms / 60e3)}分钟` : ms < 86400e3 ? `隔了${(ms / 3600e3).toFixed(1)}小时` : `隔了${Math.round(ms / 86400e3)}天`;
  let prev = 0;
  const out = rows.map(e => {
    const t = e.deliver_at || e.created_at;
    const d = new Date(t);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const gap = prev && t - prev > 30 * 60e3 ? `，${fmtGap(t - prev)}` : '';
    prev = t;
    const who = e.author_type === 'human' ? userName : (names[e.author_id] || e.author_id);
    return { role: e.author_type === 'human' ? 'user' : 'assistant', content: `【${who}·${hm}${gap}】${e.body}` };
  });
  // 最后一条距现在多久（TA晾了你多久 / 你刚回完多久）
  if (rows.length) {
    const last = rows[rows.length - 1];
    const since = Date.now() - (last.deliver_at || last.created_at);
    if (since > 30 * 60e3) out.push({ role: 'user', content: `（距离上一条消息已经过去${fmtGap(since)}）` });
  }
  return out;
}

export function feedAsContext(limit = 6) {
  const userName = W.get('user_name') || '你';
  const names = Object.fromEntries(db.prepare('SELECT id,name FROM characters').all().map(c => [c.id, c.name]));
  const rows = db.prepare(`SELECT * FROM events WHERE kind='moment' ORDER BY id DESC LIMIT ?`).all(limit).reverse();
  if (!rows.length) return '';
  const lines = rows.map(e => {
    const who = e.author_type === 'human' ? userName : (names[e.author_id] || e.author_id);
    return `【${who} 发了条动态】${e.body}`;
  }).join('\n');
  return `\n—— 最近的朋友圈（注意每条的发帖人）——\n${lines}\n`;
}

// ---------- AI 调用（按 active provider 路由）----------
async function callAnthropic(p, system, messages, maxTokens) {
  const res = await fetch(p.base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': p.key(), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: p.model, max_tokens: maxTokens, system, messages }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// DeepSeek / Kimi：OpenAI 兼容，system 作为第一条 system 消息
async function callOpenAICompat(p, system, messages, maxTokens) {
  const res = await fetch(p.base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key()}` },
    body: JSON.stringify({
      model: p.model, max_tokens: maxTokens, temperature: 0.9,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`${p.label} ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

// Gemini：role 用 user/model，需合并连续同角色、且首条必须是 user
function toGeminiContents(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts[0].text += '\n' + m.content;
    else out.push({ role, parts: [{ text: m.content }] });
  }
  if (out.length && out[0].role === 'model') out.unshift({ role: 'user', parts: [{ text: '（继续）' }] });
  return out;
}
async function callGemini(p, system, messages, maxTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:generateContent?key=${p.key()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: toGeminiContents(messages),
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.9 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map(x => x.text).join('').trim();
}

async function callAI(system, messages, maxTokens = 300) {
  const p = activeProvider();
  if (!p.key()) throw new Error(`当前引擎「${p.label}」没有配置 key`);
  if (p.kind === 'anthropic') return callAnthropic(p, system, messages, maxTokens);
  if (p.kind === 'gemini') return callGemini(p, system, messages, maxTokens);
  return callOpenAICompat(p, system, messages, maxTokens);
}

// ---------- 事件簿（星野方案）：聊天积累到阈值，压缩成一条第一人称日记进长期记忆 ----------
// 突破上下文上限的关键：taggedHistory 只带最近10条，更早的靠事件簿活在记忆里。
export async function summarizeRoom(char) {
  try {
    const KEY = 'summarized_upto:' + char.id;
    const upto = Number(W.get(KEY) || 0);
    const rows = db.prepare(`SELECT * FROM events WHERE room_id=? AND kind='chat' AND id > ? AND deliver_at <= ? ORDER BY id ASC`)
      .all(char.id, upto, Date.now());
    const EVERY = Number(process.env.SUMMARIZE_EVERY || 24);
    if (rows.length < EVERY) return;
    const chunk = rows.slice(0, Math.ceil(EVERY * 2 / 3));   // 压前 2/3，留最近的做现场上下文
    const userName = W.get('user_name') || '用户';
    const lines = chunk.map(e => `【${e.author_type === 'human' ? userName : char.name}】${e.body}`).join('\n');
    const sys = `你是${char.name}。把下面这段你和${userName}的聊天，压缩成你日记里的一条事件簿：2-3句话，第一人称，记住重要的事实、约定、TA的喜好、你的感受。只输出日记内容本身。`;
    const text = await callAI(sys, [{ role: 'user', content: lines }], 220);
    if (text) remember(char.id, `【事件簿】${text}`, { valence: 0.7, strength: 1.3 });
    W.set(KEY, String(chunk[chunk.length - 1].id));
    console.log(`[事件簿] ${char.name} 记下了 ${chunk.length} 条对话`);
  } catch (e) { console.error('[事件簿失败]', e.message); }
}

// 统一出口：配额内走 Claude，否则脚本托底
const fallbackFor = (kind, id) => (fallback[kind] || fallback.chat)(id);
export async function charSay(char, kind, extraUserMsg = null) {
  if (!tryConsumeQuota(char.id)) {
    return { text: fallbackFor(kind, char.id), ai: false };
  }
  try {
    const system = buildPrompt(char) + feedAsContext();
    let messages;
    if (kind === 'chat') {
      messages = taggedHistory(char.id);
      if (extraUserMsg) messages.push({ role: 'user', content: extraUserMsg });
      if (!messages.length || messages[messages.length - 1].role !== 'user')
        messages.push({ role: 'user', content: '（TA打开了和你的聊天界面，但还没说话。你可以主动说点什么，也可以[沉默]等TA先开口）' });
    } else if (kind === 'moment') {
      messages = [{ role: 'user', content: '（以你的身份发一条朋友圈动态，一句话，贴合你的性格和现在的时段，不要提用户）' }];
    } else { // comment / chronicle / 其它：直接用 extraUserMsg 当指令
      messages = [{ role: 'user', content: extraUserMsg }];
    }
    let text = await callAI(system, messages);
    // 机制性执法（prompt 会被违反，后处理不会）：
    // 1) 带【别人名字】标注的行 = 模型在替别人（包括用户）说话 → 整行丢弃
    // 2) 自己名字的标注剥掉；3) （动作描写）剥掉；4) 掉空行
    text = text.split('\n').map(l => {
      const tag = l.match(/^\s*【([^】]{1,12})】/);
      if (tag && tag[1] !== char.name) return '';           // 不是你的台词，不许发
      return l.replace(/^\s*【[^】]{1,12}】\s*/, '')
        .replace(/（[^（）]*）/g, '')
        .replace(/\([^()]*\)/g, '')
        .trim();
    }).filter(Boolean).join('\n').trim();
    return { text, ai: true };
  } catch (err) {
    console.error('[AI 调用失败，走托底]', err.message);
    W.set('last_ai_error', `${new Date().toLocaleTimeString()} ${err.message}`.slice(0, 200));
    return { text: fallbackFor(kind, char.id), ai: false };
  }
}
