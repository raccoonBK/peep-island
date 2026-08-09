#!/usr/bin/env node
// 百轮压测 —— 客观健康度检查，不是口味判断。
//
// 两条原则：
// 1) 输入不是我编的。从 Tatoeba（公开人写句子库，CC BY 2.0 FR）随机取，
//    过滤成简体短句、对话式。我编的探针只能测出"我以为的人类说话方式"。
// 2) 我只统计能客观测量的东西：剥空率、沉默率、失败率、模板化重复、
//    破设定命中、颜文字/感叹号密度、长度分布。
//    "像不像活人"不在其中——那个判断只能你来做，所以末尾附原始样本。
//
// 用法：先 cd server && npm start，另开终端在项目根目录跑：
//   NODE_USE_ENV_PROXY=1 node server/百轮压测.mjs [轮数]
// （Node 默认不读 HTTP_PROXY，取语料要出网，所以这个变量不能省）

// 取语料要出网（可能得走代理），打本机接口不能走代理。
// 所以不是删掉代理变量，而是把本机加进 NO_PROXY。
process.env.NO_PROXY = ['127.0.0.1', 'localhost', process.env.NO_PROXY].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;

const HOST = process.env.PEEP_HOST || 'http://127.0.0.1:3711';
const ROUNDS = Number(process.argv[2] || 100);
const CONCURRENCY = 3;

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
  // 并行抓，串行抓 40 页要几分钟
  for (let batch = 0; batch < 10 && pool.size < need; batch++) {
    const pages = await Promise.all(
      Array.from({ length: 8 }, (_, k) => page(batch * 8 + k + 1)));
    for (const json of pages) {
      if (!json) continue;
      for (const s of json.results || []) {
        if (s.script && s.script !== 'Hans') continue;          // 只要简体
        const t = String(s.text || '').trim();
        if (t.length < 2 || t.length > 28) continue;            // 聊天不会是长句
        if (!/[你我吗吧呢啊么吧嘛]/.test(t) && t.length > 8) continue;  // 要对话式或够短，不要第三人称叙述
        if (/[「」《》【】0-9A-Za-z]/.test(t)) continue;          // 去掉带书名号/拉丁字母的翻译腔
        pool.add(t);
      }
    }
  }
  return [...pool];
}

const say = async (charId, body) => {
  const r = await fetch(`${HOST}/api/rooms/${charId}/compare`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()).results || [];
};

// ---------- 客观指标 ----------
const PATTERNS = {
  破设定: /作为(一个)?(AI|人工智能|语言模型)|我是(一个)?(AI|人工智能|语言模型)|我没有(真实的)?(情感|身体)/,
  颜文字波浪: /[~～♡❤️♥(\^][\^_o0]|[~～]$|o\(|\(\^/,
  括号动作: /（[^）]*）|\([^)]*\)/,          // 后处理本该剥掉，还在=执法漏网
  他人台词: /【[^】]{1,24}】/,               // 同上
  感叹号: /[!！]/,
};

async function main() {
  console.log(`取语料中…`);
  const corpus = await fetchCorpus(ROUNDS);
  if (corpus.length < 20) { console.error('语料不够，Tatoeba 可能连不上'); process.exit(1); }
  console.log(`拿到 ${corpus.length} 条真实句子，跑 ${ROUNDS} 轮\n`);

  let chars = ['ache', 'yuanzi', 'xiaobei'];
  try {
    const st = await (await fetch(HOST + '/api/state')).json();
    if (st.characters?.length) chars = st.characters.map(c => c.id);
  } catch { console.error(`连不上 ${HOST}`); process.exit(1); }

  const jobs = Array.from({ length: ROUNDS }, (_, i) => ({
    i, charId: chars[i % chars.length], input: corpus[Math.floor(Math.random() * corpus.length)],
  }));

  const log = [];
  let done = 0;
  const worker = async () => {
    while (jobs.length) {
      const job = jobs.shift();
      try {
        const results = await say(job.charId, job.input);
        for (const r of results) log.push({ ...job, provider: r.provider, text: r.text, ai: r.ai });
      } catch (e) {
        log.push({ ...job, provider: 'ERR', text: '', ai: false, err: e.message });
      }
      done++;
      if (done % 10 === 0) process.stdout.write(`  ${done}/${ROUNDS}\n`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // ---------- 统计 ----------
  const byProv = {};
  for (const r of log) (byProv[r.provider] ||= []).push(r);

  let md = `# 百轮压测 · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}\n\n`;
  md += `输入取自 Tatoeba 随机简体短句（CC BY 2.0 FR），共 ${ROUNDS} 轮，非人工编写。\n\n`;
  md += `> 下面全是**可客观测量**的指标。"像不像活人"不在其中——见文末原始样本，那个只能你判断。\n\n`;

  for (const [prov, rows] of Object.entries(byProv)) {
    const n = rows.length;
    const err = rows.filter(r => r.provider === 'ERR').length;
    const empty = rows.filter(r => /选择了沉默|输出被剥空/.test(r.text)).length;
    const lens = rows.filter(r => r.text && !/选择了沉默/.test(r.text)).map(r => r.text.length).sort((a, b) => a - b);
    const med = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
    const avg = lens.length ? (lens.reduce((s, v) => s + v, 0) / lens.length).toFixed(1) : 0;
    const counts = {};
    for (const r of rows) counts[r.text] = (counts[r.text] || 0) + 1;
    const dupes = Object.entries(counts).filter(([t, c]) => c > 1 && t && !/选择了沉默/.test(t))
      .sort((a, b) => b[1] - a[1]);
    md += `## ${prov}（${n} 条）\n\n`;
    md += `| 指标 | 值 | 说明 |\n|---|---|---|\n`;
    md += `| 调用失败 | ${err} (${(err / n * 100).toFixed(1)}%) | 网络或接口错误 |\n`;
    md += `| 空回复／被剥空 | ${empty} (${(empty / n * 100).toFixed(1)}%) | 角色凭空变哑巴，越低越好 |\n`;
    md += `| 平均字数 | ${avg} | |\n`;
    md += `| 中位字数 | ${med} | 中位远小于平均＝偶发长篇大论 |\n`;
    md += `| 最长 | ${lens[lens.length - 1] || 0} | 超过 60 字基本就是在讲道理 |\n`;
    for (const [k, re] of Object.entries(PATTERNS)) {
      const hit = rows.filter(r => r.text && re.test(r.text)).length;
      md += `| ${k} | ${hit} (${(hit / n * 100).toFixed(1)}%) | ${k === '破设定' ? '出现一次就是致命的' : k === '括号动作' || k === '他人台词' ? '后处理漏网' : ''} |\n`;
    }
    md += `| 完全重复的回复 | ${dupes.length} 组 | 模板化程度 |\n\n`;
    if (dupes.length) {
      md += `重复最多的几条：\n\n`;
      for (const [t, c] of dupes.slice(0, 5)) md += `- ×${c}　${t.replace(/\n/g, ' / ').slice(0, 60)}\n`;
      md += `\n`;
    }
  }

  md += `---\n\n## 原始样本（随机 24 条，供你判断口味）\n\n`;
  const sample = log.filter(r => r.text && !/选择了沉默/.test(r.text))
    .sort(() => Math.random() - 0.5).slice(0, 24);
  for (const r of sample) {
    md += `**你说：** ${r.input}\n\n`;
    md += r.text.split('\n').map(l => `> ${l}`).join('\n') + `\n\n`;
    md += `　像人 ☐1 ☐2 ☐3 ☐4 ☐5\n\n`;
  }

  const { writeFileSync } = await import('node:fs');
  const f = `百轮压测-${new Date().toISOString().slice(0, 10)}.md`;
  writeFileSync(f, md);
  writeFileSync(f.replace('.md', '.jsonl'), log.map(r => JSON.stringify(r)).join('\n'));
  console.log(`\n报告：${f}\n全量：${f.replace('.md', '.jsonl')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
