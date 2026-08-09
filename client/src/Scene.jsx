import React from 'react';

// 岛屿场景渲染：建筑和材质都是数据驱动的，不是背景图。
// 换成你的 3D 岛/美术时，只替换这里的形状函数；scene JSON 结构不变。
const MATERIALS = {
  wood: { roof: '#8a5a3b', wall: '#c9a26b', edge: '#6b4326' },
  stone: { roof: '#6d7686', wall: '#aeb6c2', edge: '#4c545f' },
  brick: { roof: '#8d4a3e', wall: '#c9705c', edge: '#5f2f27' },
};
const GROUNDS = {
  grass: ['rgba(112,158,104,.62)', 'rgba(78,120,88,.5)'],
  sand: ['rgba(214,190,140,.62)', 'rgba(180,155,110,.5)'],
  snow: ['rgba(224,232,240,.66)', 'rgba(176,192,210,.5)'],
};

function House({ x, y, m, color }) {
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
function Lighthouse({ x, y, m, color }) {
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
function Shop({ x, y, m, color }) {
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
function Dock({ x, y, m }) {
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

export default function Scene({ scene, locs }) {
  if (!scene) return null;
  const g = GROUNDS[scene.ground] || GROUNDS.grass;
  const SZ = { house: 46, shop: 50, lighthouse: 40, dock: 48 };
  return (
    <>
      <div className="ground-layer" style={{
        background: `radial-gradient(75% 70% at 50% 48%, ${g[0]} 0%, ${g[1]} 55%, rgba(60,90,110,.15) 72%, transparent 78%)`,
      }} />
      {(scene.buildings || []).map(b => {
        const p = locs[b.loc];
        if (!p) return null;
        const P = b.type === 'lighthouse' ? Lighthouse : b.type === 'shop' ? Shop : b.type === 'dock' ? Dock : House;
        const w = SZ[b.type] || 46;
        return (
          <svg key={b.id} className="bld" width={w} height={w}
            viewBox="-40 -60 80 90"
            style={{ left: `${p[0]}%`, top: `${p[1]}%` }}>
            <P x={0} y={0} m={b.material} color={b.color} />
          </svg>
        );
      })}
    </>
  );
}
