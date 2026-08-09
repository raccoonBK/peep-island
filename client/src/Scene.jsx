import React, { useState } from 'react';

// ================= 岛屿场景：地块渲染 =================
// 为什么是地块而不是一张整岛图：
//   整岛图 = 1 张图 1 座岛，改一个建筑要重画整张，而建筑本来是 /api/scene 里的数据。
//   地块 = 十几张图拼无限座岛，加一种地形等于加一张图，岛变大不用重画。
//   这是加法和乘法的区别。
//
// 美术接入方式：把 32×32 的 PNG 丢进 client/public/tiles/，文件名对上 TILE_ART 即可。
//   没有图片时自动回落到程序色块（background-color 垫底，background-image 404 不影响），
//   所以这套东西在零美术资源的情况下就能跑，图片到位后不用改一行代码。
const GRID = { cols: 11, rows: 14 };

// 地形图。一个字符一格，改岛就是改这张表——不用碰代码。
//   ~ 深水   . 沙滩   g 草地   p 土路   s 石板
const TERRAIN = [
  '~~~~~~~~~~~',
  '~~~.ggg.~~~',
  '~~.gggggg.~',
  '~.ggggggg.~',
  '~.ggggggg.~',
  '~.gggggggg~',
  '~.gggppggg~',
  '.ggggpgggg~',
  '.gggggggg.~',
  '~.ggggggg.~',
  '~..ggggg..~',
  '~~..ggg..~~',
  '~~~...~~~~~',
  '~~~~~~~~~~~',
];

// 地块的程序色（没有美术资源时的样子）与对应图片名
const TILE_ART = {
  '~': { fill: '#3f6b86', art: 'water_deep' },
  '.': { fill: '#d9c393', art: 'sand' },
  'g': { fill: '#7ca86c', art: 'grass' },      // 有 grass_1/2/3 三个变体时随位置轮换
  'p': { fill: '#b39a72', art: 'path_dirt' },
  's': { fill: '#9aa0a6', art: 'stone' },
};

// —— 地点名 → 格子。日程表里的 loc 必须保持是"渔市""天台"这样的名字，
//    因为 prompt 里得能说"她在渔市"，不能说"她在 (6,8)"。格子只是它的坐标投影。
export const CELLS = {
  码头: [8, 10], 海滩: [3, 11], 渔市: [6, 8], 西崖: [1, 7],
  小北家: [2, 4], 阿澈家: [7, 3], 天台: [8, 2], 圆子家: [5, 4],
  圆子院: [4, 5], 广场: [5, 7], 灯塔: [9, 5], 家: [5, 3],
};

// 格子 → 百分比（格心）。角色走位、建筑摆放、相遇判定共用这一套坐标。
export const cellPct = ([c, r]) => [
  ((c + 0.5) / GRID.cols) * 100,
  ((r + 0.5) / GRID.rows) * 100,
];
export const LOCS = Object.fromEntries(
  Object.entries(CELLS).map(([name, cell]) => [name, cellPct(cell)]),
);
// 两个地点是否相邻（含对角）。相遇判定从"同一个地点字符串"升级成"挨着"，
// 触发更自然也更频繁——这是格子化最直接的玩法收益。
export const adjacent = (a, b) => {
  const A = CELLS[a], B = CELLS[b];
  if (!A || !B) return false;
  return Math.abs(A[0] - B[0]) <= 1 && Math.abs(A[1] - B[1]) <= 1;
};

// 建筑占地（格）。占多格之后建筑才不像贴纸。
const FOOTPRINT = { house: [2, 2], shop: [2, 2], lighthouse: [1, 3], dock: [2, 1] };

const MATERIALS = {
  wood: { roof: '#8a5a3b', wall: '#c9a26b', edge: '#6b4326' },
  stone: { roof: '#6d7686', wall: '#aeb6c2', edge: '#4c545f' },
  brick: { roof: '#8d4a3e', wall: '#c9705c', edge: '#5f2f27' },
};

function House({ m, color }) {
  const mat = MATERIALS[m] || MATERIALS.wood;
  return (
    <g>
      <rect x="-30" y="-14" width="60" height="34" rx="3" fill={mat.wall} stroke={mat.edge} strokeWidth="2" />
      <path d="M-36 -14 L0 -40 L36 -14 Z" fill={color || mat.roof} stroke={mat.edge} strokeWidth="2" />
      <rect x="-9" y="0" width="18" height="20" rx="2" fill={mat.edge} opacity=".75" />
      <rect x="-24" y="-6" width="11" height="10" rx="1.5" fill="#ffe9b0" opacity=".85" />
      <rect x="13" y="-6" width="11" height="10" rx="1.5" fill="#ffe9b0" opacity=".85" />
    </g>
  );
}
function Lighthouse({ m, color }) {
  const mat = MATERIALS[m] || MATERIALS.stone;
  return (
    <g>
      <path d="M-14 20 L-9 -34 L9 -34 L14 20 Z" fill={color || mat.wall} stroke={mat.edge} strokeWidth="2" />
      <rect x="-11" y="-16" width="22" height="8" fill={mat.edge} opacity=".55" />
      <rect x="-11" y="-2" width="22" height="8" fill={mat.edge} opacity=".55" />
      <rect x="-11" y="-46" width="22" height="12" rx="2" fill="#ffe9b0" stroke={mat.edge} strokeWidth="2" />
      <path d="M-9 -46 L0 -56 L9 -46 Z" fill={mat.edge} />
    </g>
  );
}
function Shop({ m, color }) {
  const mat = MATERIALS[m] || MATERIALS.wood;
  return (
    <g>
      <rect x="-32" y="-16" width="64" height="36" rx="3" fill={mat.wall} stroke={mat.edge} strokeWidth="2" />
      <rect x="-36" y="-24" width="72" height="9" rx="2" fill={color || mat.roof} stroke={mat.edge} strokeWidth="2" />
      <path d="M-32 -15 h64 v7 h-64 z" fill="#ffffff30" />
      <rect x="-10" y="2" width="20" height="18" rx="2" fill={mat.edge} opacity=".7" />
    </g>
  );
}
function Dock({ m }) {
  const mat = MATERIALS[m] || MATERIALS.wood;
  return (
    <g>
      <rect x="-34" y="-4" width="68" height="8" rx="2" fill={mat.wall} stroke={mat.edge} strokeWidth="2" />
      <rect x="-26" y="4" width="5" height="14" fill={mat.edge} />
      <rect x="-3" y="4" width="5" height="14" fill={mat.edge} />
      <rect x="20" y="4" width="5" height="14" fill={mat.edge} />
    </g>
  );
}
const SHAPES = { house: House, shop: Shop, lighthouse: Lighthouse, dock: Dock };

// 建筑：优先用 /buildings/<type>.png（灰度白模，运行时染色）；
// 图片不存在时静默回落到上面的矢量形状。美术到位前后都能跑。
function Building({ b, cell }) {
  const [noArt, setNoArt] = useState(false);
  const [fw, fh] = FOOTPRINT[b.type] || [2, 2];
  const [x, y] = cellPct(cell);
  const w = (fw / GRID.cols) * 100, h = (fh / GRID.rows) * 100;
  const style = { left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` };
  if (!noArt) {
    return (
      <img className="bld bld-art" style={{ ...style, ...(b.color ? { '--tint': b.color } : {}) }}
        src={`/buildings/${b.type}.png`} alt="" onError={() => setNoArt(true)} />
    );
  }
  const P = SHAPES[b.type] || House;
  return (
    <svg className="bld" style={style} viewBox="-40 -60 80 90" preserveAspectRatio="xMidYMax meet">
      <P m={b.material} color={b.color} />
    </svg>
  );
}

// 单个地块。background-color 垫底 + background-image 覆盖：
// 图片 404 时浏览器保留底色，所以"有图用图、没图用色"不需要任何判断逻辑。
function Tile({ ch, c, r }) {
  const t = TILE_ART[ch] || TILE_ART.g;
  // 草地有三个变体时按位置轮换，打散重复感（AI 生图做不出无缝，靠变体掩盖）
  const name = t.art === 'grass' ? `grass_${((c * 7 + r * 3) % 3) + 1}` : t.art;
  return (
    <i className="tile" style={{
      backgroundColor: t.fill,
      backgroundImage: `url(/tiles/${name}.png)`,
    }} />
  );
}

export default function Scene({ scene }) {
  if (!scene) return null;
  return (
    <>
      <div className="tile-grid" style={{
        gridTemplateColumns: `repeat(${GRID.cols}, 1fr)`,
        gridTemplateRows: `repeat(${GRID.rows}, 1fr)`,
      }}>
        {TERRAIN.flatMap((row, r) =>
          [...row].map((ch, c) => <Tile key={`${c},${r}`} ch={ch} c={c} r={r} />))}
      </div>
      {(scene.buildings || []).map(b => {
        const cell = CELLS[b.loc];
        return cell ? <Building key={b.id} b={b} cell={cell} /> : null;
      })}
    </>
  );
}
