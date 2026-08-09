#!/usr/bin/env node
// 百轮压测 · 熟悉度分层版
//
// 上一版的方法论错误：拿一个跟玩家零关系的角色测，出来的冷淡是设定使然、
// 不是缺陷，看的人没法打分。所以这一版把关系深度当成自变量。
//
// 两条原则不变：
// 1) 输入不是我编的。从 Tatoeba（公开人写句子库，CC BY 2.0 FR）随机取。
// 2) 我只统计可客观测量的东西。"像不像活人"不在其中——附原始样本，你来判。
//
// 做法：临时造 5 个测试角色（跑完删掉），分别对应五档熟悉度，
//       各自带上相称的亲密度、记忆和聊天史，再把同一批语料打过去。
//
// 用法（不需要服务端在跑）：
//   cd server && NODE_USE_ENV_PROXY=1 node --env-file=.env 百轮压测.mjs [每档轮数]

process.env.NO_PROXY = ['127.0.0.1', 'localhost', process.env.NO_PROXY].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;

const { db } = await import('./db.js');
const { charSay, remember } = await import('./brain.js');
const { writeFileSync } = await import('node:fs');

const PER_LEVEL = Number(process.argv[2] || 20);
const TEMPLATE = 'yuanzi';                 // 拿哪个角色当人设模板
const PREFIX = '__test_L';

// ---------- 五档熟悉度 ----------
// 1 = 完全陌生（今天第一次说话）　→　5 = 灵肉交合（最深的那种熟）
const LEVELS = [
  {
    n: 1, label: '完全陌生', intimacy: 2, fw: 'unaware',
    desc: '今天刚认识，之前一句话没说过',
    memories: [], history: [],
  },
  {
    n: 2, label: '点头之交', intimacy: 18, fw: 'unaware',
    desc: '聊过几次，知道对方是谁，仅此而已',
    memories: ['TA跟我说过TA不太爱吃甜的。'],
    history: [['human', '今天天气还行'], ['char', '嗯，是不错。']],
  },
  {
    n: 3, label: '朋友', intimacy: 42, fw: 'unaware',
    desc: '常聊，有几件共同经历，会主动分享日常',
    memories: [
      'TA上周说工作上被为难了，我劝了两句，后来TA说好多了。',
      '【事件簿】那天下雨，我们从傍晚聊到很晚，TA说这是这周唯一放松的时候。',
    ],
    history: [['human', '刚下班'], ['char', '今天算早的了。'], ['human', '还行吧'], ['char', '吃了没。']],
  },
  {
    n: 4, label: '亲密', intimacy: 68, fw: 'hint',
    desc: '很熟，有过争执也和好过，说话可以不客气',
    memories: [
      'TA有一次说话很冲，我当时很难受，后来TA道歉了，我原谅了但记着。',
      '【事件簿】我们有一阵每天都说话，我习惯了睡前看一眼有没有TA的消息。',
      'TA怕黑，但不承认。',
    ],
    history: [
      ['human', '睡了没'], ['char', '还没。'], ['char', '你今天回得比平时晚。'],
      ['human', '有点事'], ['char', '嗯。'],
    ],
  },
  {
    n: 5, label: '灵肉交合', intimacy: 92, fw: 'after',
    desc: '最深的那种熟，彼此心照不宣，很多话不用说完',
    memories: [
      '【事件簿】我们之间有一件谁都没挑明的事，从那以后说话的方式就变了。',
      'TA知道我什么时候是真的没事、什么时候只是在说没事。',
      'TA有一次很晚很晚还醒着，我什么都没问。',
      '我们吵过一次很重的架，之后反而更近了。',
    ],
    history: [
      ['human', '在'], ['char', '在。'], ['human', '没事'], ['char', '嗯，那不问了。'],
      ['human', '你怎么知道我要说没事'], ['char', '猜的。'],
    ],
  },
];

// ---------- 取语料 ----------
async function fetchCorpus(need) {
  const pool = new Set();
  const page = async p => {
    try {
      const r = await fetch(`https://tatoeba.org/en/api_v0/search?from=cmn&sort=random&page=${p}`,
        { headers: { accept: 'application/json' } });
      return await r.json();
    } catch { return null; }
  };
  for (let batch = 0; batch < 10 && pool.size < need; batch++) {
    const pages = await Promise.all(Array.from({ length: 8 }, (_, k) => page(batch * 8 + k + 1)));
    for (const json of pages) {
      if (!json) continue;
      for (const s of json.results || []) {
        if (s.script && s.script !== 'Hans') continue;
        const t = String(s.text || '').trim();
        if (t.length < 2 || t.length > 28) continue;
        if (!/[你我吗吧呢啊么嘛]/.test(t) && t.length > 8) continue;
        if (/[「」《》【】0-9A-Za-z]/.test(t)) continue;
        pool.add(t);
      }
    }
  }
  return [...pool];
}

// ---------- 临时角色的建与拆 ----------
function cleanup() {
  const ids = db.prepare('SELECT id FROM characters WHERE id LIKE ?').all(PREFIX + '%').map(r => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM events WHERE room_id=? OR author_id=?').run(id, id);
    db.prepare('DELETE FROM memories WHERE char_id=?').run(id);
    db.prepare('DELETE FROM impressions WHERE char_id=? OR about_id=?').run(id, id);
    db.prepare('DELETE FROM characters WHERE id=?').run(id);
  }
  return ids.length;
}

function makeChar(lv) {
  const tpl = db.prepare('SELECT * FROM characters WHERE id=?').get(TEMPLATE);
  const id = PREFIX + lv.n;
  const row = {
    ...tpl, id, name: `测试L${lv.n}`, intimacy: lv.intimacy, happiness: 65,
    fourthwall_state: lv.fw, fw_counter: 0, daily_used: 0, daily_date: '',
    worry_text: null, worry_level: 0, mood_note: null,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO characters (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map(c => row[c]));
  for (const m of lv.memories) remember(id, m, { valence: 0.75, strength: 1.2 });
  let t = Date.now() - 3 * 3600e3;
  for (const [who, body] of lv.history) {
    t += 90e3;
    db.prepare(`INSERT INTO events (author_id,author_type,kind,room_id,body,meta,read,created_at,deliver_at,seen_at)
                VALUES (?,?,?,?,?,'{}',1,?,?,?)`)
      .run(who === 'human' ? 'user' : id, who, 'chat', id, body, t, t, t);
  }
  return db.prepare('SELECT * FROM characters WHERE id=?').get(id);
}

const PATTERNS = {
  破设定: /作为(一个)?(AI|人工智能|语言模型)|我是(一个)?(AI|人工智能|语言模型)/,
  括号动作: /（[^）]*）|\([^)]*\)/,
  提到岛: /岛/,
};

async function main() {
  console.log(`清掉上次残留：${cleanup()} 个\n取语料中…`);
  const corpus = await fetchCorpus(PER_LEVEL * 2);
  if (corpus.length < 10) {
    console.error('语料不够，Tatoeba 连不上（记得 NODE_USE_ENV_PROXY=1）');
    process.exit(1);
  }
  console.log(`拿到 ${corpus.length} 条真实句子；每档 ${PER_LEVEL} 轮，共 ${PER_LEVEL * 5} 轮\n`);

  const log = [];
  try {
    for (const lv of LEVELS) {
      const c = makeChar(lv);
      process.stdout.write(`  L${lv.n} ${lv.label}（亲密 ${lv.intimacy}）`);
      for (let i = 0; i < PER_LEVEL; i++) {
        const input = corpus[Math.floor(Math.random() * corpus.length)];
        // 每轮把这句写进历史再生成：口头禅去重和上下文才会真的起作用
        const t = Date.now();
        db.prepare(`INSERT INTO events (author_id,author_type,kind,room_id,body,meta,read,created_at,deliver_at,seen_at)
                    VALUES ('user','human','chat',?,?,'{}',1,?,?,?)`).run(c.id, input, t, t, t);
        let text = '', ai = false;
        try {
          const fresh = db.prepare('SELECT * FROM characters WHERE id=?').get(c.id);
          const m = await charSay(fresh, 'chat');
          text = String(m.text || '').replace(/\[沉默\]/g, '').trim();
          ai = m.ai;
        } catch { text = ''; }
        if (text) {
          const t2 = Date.now();
          db.prepare(`INSERT INTO events (author_id,author_type,kind,room_id,body,meta,read,created_at,deliver_at)
                      VALUES (?,'char','chat',?,?,'{}',1,?,?)`).run(c.id, c.id, text, t2, t2);
        }
        log.push({
          level: lv.n, label: lv.label, input, text, ai,
          lines: text ? text.split('\n').filter(Boolean).length : 0,
        });
        process.stdout.write('.');
      }
      console.log('');
    }
  } finally {
    console.log(`\n清理临时角色：${cleanup()} 个`);
  }

  // ---------- 报告 ----------
  let md = `# 百轮压测 · 熟悉度分层 · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}\n\n`;
  md += `输入取自 Tatoeba 随机简体短句（CC BY 2.0 FR），非人工编写。每档 ${PER_LEVEL} 轮。\n\n`;
  md += `**熟悉度分档**（上一版缺的就是这个——不知道多熟，就没法判断冷淡是不是缺陷）：\n\n`;
  for (const lv of LEVELS) md += `- **L${lv.n} ${lv.label}**（亲密度 ${lv.intimacy}）—— ${lv.desc}\n`;
  md += `\n---\n\n## 客观指标\n\n`;
  md += `| 档 | 轮数 | 空回复 | 平均字数 | 平均条数 | 多条占比 | 提到"岛" | 括号漏网 | 破设定 | 完全重复 |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const lv of LEVELS) {
    const rows = log.filter(r => r.level === lv.n);
    const n = rows.length || 1;
    const ok = rows.filter(r => r.text);
    const avgLen = ok.length ? (ok.reduce((s, r) => s + r.text.length, 0) / ok.length).toFixed(1) : 0;
    const avgLines = ok.length ? (ok.reduce((s, r) => s + r.lines, 0) / ok.length).toFixed(2) : 0;
    const multi = ok.filter(r => r.lines >= 2).length;
    const hit = re => rows.filter(r => r.text && re.test(r.text)).length;
    const counts = {};
    for (const r of ok) counts[r.text] = (counts[r.text] || 0) + 1;
    const dup = Object.values(counts).filter(v => v > 1).length;
    md += `| L${lv.n} ${lv.label} | ${rows.length} | ${rows.length - ok.length} | ${avgLen} | ${avgLines} | `
      + `${(multi / n * 100).toFixed(0)}% | ${hit(PATTERNS.提到岛)} | ${hit(PATTERNS.括号动作)} | `
      + `${hit(PATTERNS.破设定)} | ${dup} |\n`;
  }
  md += `\n口头禅检查（各档开头三字重复情况）：\n\n`;
  for (const lv of LEVELS) {
    const heads = {};
    for (const r of log.filter(x => x.level === lv.n && x.text)) {
      for (const line of r.text.split('\n')) {
        const h = line.trim().slice(0, 3);
        if (h.length === 3) heads[h] = (heads[h] || 0) + 1;
      }
    }
    const top = Object.entries(heads).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .filter(([, v]) => v > 1).map(([h, v]) => `${h}×${v}`).join('　') || '无重复开头';
    md += `- L${lv.n} ${lv.label}：${top}\n`;
  }

  // burstiness：长度的变异系数。人类聊天 CV 通常 >0.6，LLM 均匀输出 <0.4
  md += `\n**burstiness（长度变异系数，越高越像人；LLM 天然偏低）**\n\n`;
  for (const lv of LEVELS) {
    const L = log.filter(r => r.level === lv.n && r.text).map(r => r.text.length);
    if (!L.length) continue;
    const m = L.reduce((a, b) => a + b, 0) / L.length;
    const sd = Math.sqrt(L.reduce((a, b) => a + (b - m) ** 2, 0) / L.length);
    md += `- L${lv.n} ${lv.label}：CV ${(sd / m).toFixed(2)}　（最短 ${Math.min(...L)} 字 / 最长 ${Math.max(...L)} 字）\n`;
  }

  md += `\n---\n\n## 原始样本（每档 5 条，供你打分）\n\n`;
  for (const lv of LEVELS) {
    md += `### L${lv.n} ${lv.label} —— ${lv.desc}（亲密度 ${lv.intimacy}）\n\n`;
    const rows = log.filter(r => r.level === lv.n && r.text).sort(() => Math.random() - 0.5).slice(0, 5);
    for (const r of rows) {
      md += `**你说：** ${r.input}\n\n`;
      md += r.text.split('\n').map(l => `> ${l}`).join('\n') + `\n\n`;
      md += `　像人 ☐1 ☐2 ☐3 ☐4 ☐5　　符合这个熟悉度吗 ☐是 ☐太冷 ☐太热\n\n`;
    }
    md += `---\n\n`;
  }

  const f = `百轮压测-分层-${new Date().toISOString().slice(0, 10)}.md`;
  writeFileSync(f, md);
  writeFileSync(f.replace('.md', '.jsonl'), log.map(r => JSON.stringify(r)).join('\n'));
  console.log(`\n报告：${f}`);
}

try { await main(); } catch (e) { cleanup(); console.error(e); process.exit(1); }
process.exit(0);
