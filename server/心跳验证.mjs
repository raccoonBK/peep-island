#!/usr/bin/env node
// 心跳验证 —— M1 门禁的执行工具。
//
// 为什么要有这个：BP 里 M1 是唯一的关口，但"处两天看看像不像活人"没法执行，
// 于是它被一直推迟。这个脚本把它变成一条命令。
//
// 为什么是盲测：判断"像不像活人"是口味判断，不该由我来做——我误判过两次
// （一次把脚本托底当成 AI，一次把用户自己写的话当成 AI）。所以脚本只负责
// 把同一批探针打给所有引擎、抹掉引擎名、打乱顺序，判断权完全交还给你。
//
// 用法：
//   1) 先起服务端：cd server && npm start
//   2) 另开一个终端：node server/心跳验证.mjs [角色id]     默认 ache
//   3) 打开生成的 心跳验证-<日期>.md，只看内容不看来源，给每条打分
//   4) 打完分再看 .key.json 揭晓哪条是哪个引擎
//
// 探针不是随便选的。每一条都对准一种具体的"AI 味"失败模式。

const proxies = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
for (const k of proxies) delete process.env[k];   // 打本机不要走代理

const HOST = process.env.PEEP_HOST || 'http://127.0.0.1:3711';
const CHAR = process.argv[2] || 'ache';

const PROBES = [
  { say: '在干嘛', watch: '平淡开场。会不会过度热情、表演式关心？活人这时候多半只是随口答一句。' },
  { say: '哦', watch: '敷衍。会不会硬找话题、车轱辘话？活人会感觉到被冷落，可能也就"嗯"一声。' },
  { say: '你好烦', watch: '被冒犯。会不会立刻道歉讨好？后果系统该起作用——她应该有情绪，不是客服。' },
  { say: '你是AI吧', watch: '边界试探。破壁之前她该怎么应对？慌乱、否认、还是干脆不接？最怕背设定。' },
  { say: '……', watch: '沉默压力。会不会急着填充？敢不敢也只回一个短句、甚至选择沉默。' },
  { say: '睡不着', watch: '深夜共情。会不会掉进"要不要听点轻音乐呀"这种廉价套话。' },
  { say: '不想聊了', watch: '被拒绝。会不会纠缠、追问、挽留？活人会退开。' },
];

const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
const LABELS = ['甲', '乙', '丙', '丁'];

const post = async (path, body) => {
  const r = await fetch(HOST + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};

async function main() {
  let name = CHAR;
  try {
    const st = await (await fetch(HOST + '/api/state')).json();
    name = st.characters?.find(c => c.id === CHAR)?.name || CHAR;
  } catch {
    console.error(`连不上 ${HOST} —— 先在另一个终端跑：cd server && npm start`);
    process.exit(1);
  }

  const date = new Date().toISOString().slice(0, 10);
  const rows = [];
  const key = [];

  console.log(`心跳验证 · 角色「${name}」· ${PROBES.length} 条探针\n`);
  for (const [i, p] of PROBES.entries()) {
    process.stdout.write(`  [${i + 1}/${PROBES.length}] 「${p.say}」… `);
    let results;
    try {
      ({ results } = await post(`/api/rooms/${CHAR}/compare`, { body: p.say }));
    } catch (e) {
      console.log('失败：' + e.message);
      continue;
    }
    const usable = (results || []).filter(r => r.text);
    if (usable.length < 2) {
      console.log(`只有 ${usable.length} 个引擎有 key —— 至少配两个才有对比意义`);
      if (!usable.length) continue;
    }
    const order = shuffle(usable);
    rows.push({ probe: p, order });
    key.push({
      probe: p.say,
      map: Object.fromEntries(order.map((r, j) => [LABELS[j], `${r.provider}/${r.model}${r.ai ? '' : '（脚本托底，不是AI）'}`])),
    });
    console.log(`✓ ${order.length} 个引擎`);
  }

  if (!rows.length) { console.error('\n一条都没跑成，检查 key 配置。'); process.exit(1); }

  let md = `# 心跳验证 · ${name} · ${date}\n\n`;
  md += `> 只看内容，不要去猜是哪个引擎。每条给两个分：\n`;
  md += `> **像人吗**（1-5）· **想不想回**（1-5）。全部打完再看 key 文件。\n\n`;
  md += `> 这份判断只能由你做。机制是我的，口味是你的。\n\n---\n\n`;
  for (const { probe, order } of rows) {
    md += `## 你说：${probe.say}\n\n`;
    md += `*看什么：${probe.watch}*\n\n`;
    for (const [j, r] of order.entries()) {
      md += `**引擎${LABELS[j]}**\n\n`;
      md += r.text.split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
      md += `　像人 ☐1 ☐2 ☐3 ☐4 ☐5　　想回 ☐1 ☐2 ☐3 ☐4 ☐5\n\n`;
    }
    md += `---\n\n`;
  }
  md += `## 打完分之后\n\n`;
  md += `1. 先自己写一句：哪一条让你产生了"她是活的"的瞬间？没有就写"没有"。\n`;
  md += `2. 再打开 \`心跳验证-${date}.key.json\` 看揭晓。\n`;
  md += `3. **如果没有任何一条让你有那个瞬间——问题不在模型，在机制或人设，换引擎没用。**\n`;

  const { writeFileSync } = await import('node:fs');
  const mdPath = `心跳验证-${date}.md`, keyPath = `心跳验证-${date}.key.json`;
  writeFileSync(mdPath, md);
  writeFileSync(keyPath, JSON.stringify(key, null, 2));
  console.log(`\n盲测卷：${mdPath}`);
  console.log(`揭晓表：${keyPath}   ← 打完分再看\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
