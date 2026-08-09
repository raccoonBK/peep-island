// db.js — SQLite schema + seed. 一切内容都是带作者归属的 event（认错人问题的根解）。
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

// 用 fileURLToPath 而非 .pathname：后者保留百分号编码，非 ASCII 路径（如中文目录名）会开库失败
export const db = new Database(fileURLToPath(new URL('./island.db', import.meta.url)));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,                       -- emoji 头像，T1 够用
  persona_surface TEXT NOT NULL,     -- 表层性格
  persona_inner TEXT NOT NULL,       -- 内层习惯
  quirks TEXT NOT NULL,              -- JSON 数组
  night_owl INTEGER DEFAULT 0,       -- 夜猫子：深夜也活跃
  romance_weight REAL DEFAULT 0.2,   -- 恋爱倾向权重（第四面墙候选）
  intimacy INTEGER DEFAULT 0,
  fourthwall_state TEXT DEFAULT 'unaware',  -- unaware|hint|crack|silent|after
  fourthwall_at INTEGER,             -- 上次状态跃迁时间（真实时间门控用）
  fw_counter INTEGER DEFAULT 0,      -- silent 期间的互动计数
  daily_used INTEGER DEFAULT 0,      -- 今日已用 AI 配额
  daily_date TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id TEXT NOT NULL,           -- 角色 id 或 'user'
  author_type TEXT NOT NULL,         -- 'human' | 'char'
  kind TEXT NOT NULL,                -- 'chat' | 'moment' | 'comment'
  room_id TEXT NOT NULL,             -- chat: 对方角色 id；moment/comment: 'feed'
  target_id INTEGER,                 -- comment 指向的 moment event id
  body TEXT NOT NULL,
  meta TEXT DEFAULT '{}',            -- JSON：{fx:'crack'} 等特殊演出标记
  read INTEGER DEFAULT 1,            -- 0 = 用户未读
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  char_id TEXT NOT NULL,
  content TEXT NOT NULL,
  valence REAL DEFAULT 0.5,          -- 情绪强度 0-1
  strength REAL DEFAULT 1.0,         -- 编码强度：参与=1，旁观=0.3
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS world (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS impressions (
  char_id TEXT NOT NULL,             -- 谁的印象
  about_id TEXT NOT NULL,            -- 对谁的印象（'user' 或其他角色 id）
  content TEXT NOT NULL,             -- 第一人称、可带偏见的"刻板印象"
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (char_id, about_id)
);

-- 角色之间的关系（无向，pair = 两个id排序后拼接）。岛是社会，不是三个客服窗口。
CREATE TABLE IF NOT EXISTS relationships (
  pair TEXT PRIMARY KEY,             -- 'ache|xiaobei'
  a_id TEXT NOT NULL, b_id TEXT NOT NULL,
  value INTEGER DEFAULT 30,          -- 0-100：陌生→相识→朋友→挚友
  note TEXT,                         -- 最近他们之间发生的事（一句话）
  updated_at INTEGER
);

-- 相遇小剧场：两个角色在同一地点碰上，演一场戏。你在屏幕外看，字幕条逐句播。
CREATE TABLE IF NOT EXISTS encounters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  a_id TEXT NOT NULL, b_id TEXT NOT NULL,
  loc TEXT, beats TEXT NOT NULL,     -- JSON: [{who:'narr'|char_id, text}]
  watched INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 岛志：角色之间发生的事，第三人称、观察者视角（森友会式"世界在转"的证据）
CREATE TABLE IF NOT EXISTS chronicle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// 迁移：第四面墙扩散（听说岛上有怪事的角色；rumor_from = 从谁那听来的）
try { db.exec('ALTER TABLE characters ADD COLUMN fw_rumor INTEGER DEFAULT 0'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE characters ADD COLUMN fw_rumor_from TEXT'); } catch { /* 已存在 */ }
// 迁移：外貌参数（捏人的"脸"。参数化组装，不是贴图——玩家捏的人必须能被渲染和分享）
// 现在用 SVG 图层渲染，以后换成美术资源时只替换每层的渲染器，数据结构不动。
try { db.exec('ALTER TABLE characters ADD COLUMN look TEXT'); } catch { /* 已存在 */ }
const DEFAULT_LOOKS = {
  xiaobei: { skin: '#f6d9bd', hair: '#3a2f2a', hairStyle: 2, eyes: 1, mouth: 1, outfit: '#5fa8d3', outfitStyle: 0, height: 1.0, blush: 1 },
  ache: { skin: '#efd3b8', hair: '#1f2733', hairStyle: 0, eyes: 3, mouth: 3, outfit: '#3f4a5c', outfitStyle: 1, height: 1.06, blush: 0 },
  yuanzi: { skin: '#fadfc4', hair: '#6b4226', hairStyle: 4, eyes: 0, mouth: 0, outfit: '#e8985a', outfitStyle: 2, height: 0.94, blush: 1 },
};
for (const [id, lk] of Object.entries(DEFAULT_LOOKS)) {
  db.prepare('UPDATE characters SET look=COALESCE(look,?) WHERE id=?').run(JSON.stringify(lk), id);
}

// 迁移：烦恼（朋友收集式气泡：白=轻微 黄=中等 红=紧急；你回复即视为处理）
try { db.exec('ALTER TABLE characters ADD COLUMN worry_text TEXT'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE characters ADD COLUMN worry_level INTEGER DEFAULT 0'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE characters ADD COLUMN worry_at INTEGER'); } catch { /* 已存在 */ }
// 迁移：梦（深夜睡着时可被"窥"到的一段梦；每晚一次）
try { db.exec('ALTER TABLE characters ADD COLUMN dream_body TEXT'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE characters ADD COLUMN dream_date TEXT'); } catch { /* 已存在 */ }

// 迁移：自定义人设 prompt（导入自己的 AI prompt；只替换人设块，第四面墙/记忆机制不可覆盖）
try { db.exec('ALTER TABLE characters ADD COLUMN custom_prompt TEXT'); } catch { /* 已存在 */ }
// 迁移：情绪状态（被伤害/被感动会留下几小时的情绪，影响说话方式——后果感是活人感的地基）
try { db.exec('ALTER TABLE characters ADD COLUMN mood_note TEXT'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE characters ADD COLUMN mood_at INTEGER'); } catch { /* 已存在 */ }
// 迁移：延迟投递（先生成后送达。活人感=节奏：秒回是客服，隔一会儿才回是人）
try {
  db.exec('ALTER TABLE events ADD COLUMN deliver_at INTEGER');
  db.exec('UPDATE events SET deliver_at = created_at WHERE deliver_at IS NULL');
} catch { /* 已存在 */ }
// 迁移：已读时刻（用户消息何时被"他"看到。null=未读。已读不回也是一种回应）
try {
  db.exec('ALTER TABLE events ADD COLUMN seen_at INTEGER');
  db.exec(`UPDATE events SET seen_at = created_at WHERE seen_at IS NULL AND author_type='human'`);
} catch { /* 已存在 */ }
// 迁移：投喂循环（幸福度 + 好恶 + 每日一次）与自定义裂缝台词
try { db.exec('ALTER TABLE characters ADD COLUMN happiness INTEGER DEFAULT 60'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE characters ADD COLUMN likes TEXT'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE characters ADD COLUMN dislikes TEXT'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE characters ADD COLUMN fed_date TEXT'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE characters ADD COLUMN crack_custom TEXT'); } catch { /* 已存在 */ }
// 种子角色的好恶（隐藏数值：玩家只能靠喂了才知道）
const seedTastes = {
  xiaobei: { likes: ['candy', 'ice'], dislikes: ['cocoa'] },
  ache: { likes: ['cocoa', 'noodle'], dislikes: ['candy'] },
  yuanzi: { likes: ['orange', 'cake'], dislikes: ['fish'] },
};
for (const [id, t] of Object.entries(seedTastes)) {
  db.prepare('UPDATE characters SET likes=COALESCE(likes,?), dislikes=COALESCE(dislikes,?) WHERE id=?')
    .run(JSON.stringify(t.likes), JSON.stringify(t.dislikes), id);
}
// 种子三人的初始关系（他们本来就住在一个岛上，彼此相识）
const seedRels = [
  ['ache', 'xiaobei', 42, '小北老爱拉阿澈出门，阿澈嘴上嫌弃但每次都去'],
  ['ache', 'yuanzi', 55, '圆子常给阿澈送吃的，阿澈会默默把碗洗干净还回去'],
  ['xiaobei', 'yuanzi', 48, '小北总来蹭圆子的饭，圆子嘴上骂手里盛'],
];
for (const [a, b, v, note] of seedRels) {
  const [x, y] = [a, b].sort();
  db.prepare(`INSERT OR IGNORE INTO relationships (pair,a_id,b_id,value,note,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(`${x}|${y}`, x, y, v, note, Date.now());
}

const seedChars = [
  {
    id: 'xiaobei', name: '小北', avatar: '🌊',
    persona_surface: '外向开朗，说话直接，喜欢用感叹号，对什么都好奇。',
    persona_inner: '其实很怕安静，一个人的时候会对着海自言自语。',
    quirks: JSON.stringify(['见到猫必须蹲下来打招呼', '口头禅是"讲真的"', '记不住日期但记得住味道']),
    night_owl: 0, romance_weight: 0.2,
  },
  {
    id: 'ache', name: '阿澈', avatar: '🌙',
    persona_surface: '内敛温和，话不多但每句都想过，观察力很强。',
    persona_inner: '深夜会在窗边坐很久，有一本不给任何人看的本子。',
    quirks: JSON.stringify(['睡前一定要喝热饮', '走路总看脚下', '会突然说一句莫名其妙的冷笑话']),
    night_owl: 1, romance_weight: 0.9,   // 第四面墙候选
  },
  {
    id: 'yuanzi', name: '圆子', avatar: '🍊',
    persona_surface: '慢性子，爱吃，情绪稳定，是岛上大家的树洞。',
    persona_inner: '固执地认为食物能解决大部分烦恼，失眠时会烤东西。',
    quirks: JSON.stringify(['形容一切都用食物比喻', '囤橘子', '打哈欠会传染给自己']),
    night_owl: 0, romance_weight: 0.4,
  },
];

const insChar = db.prepare(`INSERT OR IGNORE INTO characters
  (id,name,avatar,persona_surface,persona_inner,quirks,night_owl,romance_weight)
  VALUES (@id,@name,@avatar,@persona_surface,@persona_inner,@quirks,@night_owl,@romance_weight)`);
for (const c of seedChars) insChar.run(c);

const setW = db.prepare(`INSERT OR IGNORE INTO world (key,value) VALUES (?,?)`);
setW.run('frozen', '0');
setW.run('last_seen', String(Date.now()));
setW.run('user_name', '你');

export const W = {
  get: (k) => db.prepare('SELECT value FROM world WHERE key=?').get(k)?.value,
  set: (k, v) => db.prepare('INSERT INTO world (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v)),
};
