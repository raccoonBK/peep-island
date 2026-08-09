import React, { useEffect, useRef, useState } from 'react';

// 参数化头像：图层组装，不是贴图。
// 每一层（发/眼/嘴/衣）都是一个可替换的渲染函数——以后换成你的美术资源时，
// 只替换这里的 path/形状，look 数据结构和捏脸码都不用动。
export const LOOK_DEFAULT = {
  skin: '#f6d9bd', hair: '#3a2f2a', hairStyle: 0, eyes: 0, mouth: 0,
  outfit: '#5fa8d3', outfitStyle: 0, height: 1.0, blush: 0,
};
export const HAIR_STYLES = 6, EYE_STYLES = 5, MOUTH_STYLES = 5, OUTFIT_STYLES = 4;

// 发型层：0短 1中分 2马尾 3长直 4丸子 5卷
function Hair({ s, c }) {
  const p = [
    <path d="M12.5 30c0-11 6-17 13.5-17s13.5 6 13.5 17c0-8-5-11-13.5-11s-13.5 3-13.5 11z" fill={c} />,
    <path d="M12 31c0-12 6.5-18 14-18s14 6 14 18c-1.5-9-4.5-11.5-8-11.5l-6 6-6-6c-3.5 0-6.5 2.5-8 11.5z" fill={c} />,
    <><path d="M12.5 30c0-11 6-17 13.5-17s13.5 6 13.5 17c0-8-5-11-13.5-11s-13.5 3-13.5 11z" fill={c} /><ellipse cx="42" cy="28" rx="5.5" ry="9" fill={c} /></>,
    <path d="M12 31c0-12 6.5-18 14-18s14 6 14 18v20c-2.5 2-4.5 1-4.5-2V27c0-4.5-4.5-7-9.5-7s-9.5 2.5-9.5 7v22c0 3-2 4-4.5 2z" fill={c} />,
    <><path d="M12.5 30c0-11 6-17 13.5-17s13.5 6 13.5 17c0-8-5-11-13.5-11s-13.5 3-13.5 11z" fill={c} /><circle cx="26" cy="9" r="6.5" fill={c} /></>,
    <><path d="M12.5 30c0-11 6-17 13.5-17s13.5 6 13.5 17c0-8-5-11-13.5-11s-13.5 3-13.5 11z" fill={c} /><circle cx="12.5" cy="29" r="5.5" fill={c} /><circle cx="39.5" cy="29" r="5.5" fill={c} /></>,
  ][s % HAIR_STYLES];
  return p;
}

// 眼睛层：0圆 1弯(笑) 2细长 3困 4大
function Eyes({ s }) {
  const k = '#1e232b';
  return [
    <><circle cx="20" cy="30" r="2.6" fill={k} /><circle cx="32" cy="30" r="2.6" fill={k} /></>,
    <><path d="M17 31q3-4 6 0" stroke={k} strokeWidth="1.8" fill="none" strokeLinecap="round" /><path d="M29 31q3-4 6 0" stroke={k} strokeWidth="1.8" fill="none" strokeLinecap="round" /></>,
    <><rect x="17" y="29" width="6" height="1.8" rx=".9" fill={k} /><rect x="29" y="29" width="6" height="1.8" rx=".9" fill={k} /></>,
    <><path d="M17 30q3 3 6 0" stroke={k} strokeWidth="1.8" fill="none" strokeLinecap="round" /><path d="M29 30q3 3 6 0" stroke={k} strokeWidth="1.8" fill="none" strokeLinecap="round" /></>,
    <><ellipse cx="20" cy="30" rx="3.2" ry="3.6" fill={k} /><ellipse cx="32" cy="30" rx="3.2" ry="3.6" fill={k} /><circle cx="21" cy="29" r="1" fill="#fff" /><circle cx="33" cy="29" r="1" fill="#fff" /></>,
  ][s % EYE_STYLES];
}

// 嘴层：0微笑 1开心 2一条线 3小圆 4撇嘴
function Mouth({ s }) {
  const k = '#8a4b40';
  return [
    <path d="M23 38q3 2.5 6 0" stroke={k} strokeWidth="1.6" fill="none" strokeLinecap="round" />,
    <path d="M22 37q4 5 8 0z" fill={k} />,
    <rect x="23" y="38" width="6" height="1.5" rx=".7" fill={k} />,
    <circle cx="26" cy="38.5" r="1.8" fill={k} />,
    <path d="M23 39q3-2.5 6 0" stroke={k} strokeWidth="1.6" fill="none" strokeLinecap="round" />,
  ][s % MOUTH_STYLES];
}

// 衣服层：0圆领 1连帽 2围裙 3衬衫
function Outfit({ s, c }) {
  return [
    <path d="M13 62c0-8 6-12 13-12s13 4 13 12v6H13z" fill={c} />,
    <><path d="M13 62c0-8 6-12 13-12s13 4 13 12v6H13z" fill={c} /><path d="M18 50q8 7 16 0" stroke="#00000030" strokeWidth="2" fill="none" /></>,
    <><path d="M13 62c0-8 6-12 13-12s13 4 13 12v6H13z" fill={c} /><rect x="20" y="52" width="12" height="16" rx="2" fill="#ffffff55" /></>,
    <><path d="M13 62c0-8 6-12 13-12s13 4 13 12v6H13z" fill={c} /><path d="M26 50v18" stroke="#00000025" strokeWidth="1.5" /></>,
  ][s % OUTFIT_STYLES];
}

export default function Avatar({ look, size = 28, speaking = false }) {
  const L = { ...LOOK_DEFAULT, ...(look || {}) };
  const h = Math.max(0.85, Math.min(1.15, L.height || 1));
  return (
    <svg width={size} height={size * 1.3} viewBox="0 0 52 70" style={{ display: 'block', overflow: 'visible' }}>
      <g transform={`translate(26 ${70 - 70 * h}) scale(${h}) translate(-26 0)`}>
        <Outfit s={L.outfitStyle} c={L.outfit} />
        <ellipse cx="26" cy="32" rx="13.5" ry="14.5" fill={L.skin} />
        {L.blush ? <><ellipse cx="15.5" cy="35" rx="2.6" ry="1.6" fill="#ff9d9d" opacity=".55" /><ellipse cx="36.5" cy="35" rx="2.6" ry="1.6" fill="#ff9d9d" opacity=".55" /></> : null}
        <Eyes s={L.eyes} />
        <Mouth s={speaking ? 1 : L.mouth} />
        <Hair s={L.hairStyle} c={L.hair} />
      </g>
    </svg>
  );
}


// ================= 像素化渲染 =================
// 问题：CSS 滤镜没法把"活的 DOM"变成真像素画——image-rendering: pixelated
// 只对位图生效，对矢量和文字无效。所以要真像素，必须先栅格化。
//
// 做法：把参数化 Avatar 序列化成 SVG → 画进一张很小的 canvas（关掉平滑，
// 于是是最近邻点采样、边缘是硬的）→ 再用 CSS 放大回原尺寸。
// 低分辨率是真的被"采样"掉的，不是模拟出来的。
//
// 好处是捏脸系统一点不用改：look JSON 照旧，只是最后多走一道栅格化。
// 以后换成真正的像素纸娃娃图集时，替换的也只是这一层。
export function PixelAvatar({ look, size = 28, res = 22, speaking = false }) {
  const hidden = useRef(null);
  const canvas = useRef(null);
  const [ready, setReady] = useState(false);
  const h = Math.round(res * 1.3);

  useEffect(() => {
    const svgEl = hidden.current?.querySelector('svg');
    const cv = canvas.current;
    if (!svgEl || !cv) return;
    let dead = false;
    const src = 'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(new XMLSerializer().serializeToString(svgEl));
    const img = new Image();
    img.onload = () => {
      if (dead) return;
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingEnabled = false;      // 最近邻：这一步决定了边缘是硬的
      ctx.clearRect(0, 0, res, h);
      ctx.drawImage(img, 0, 0, res, h);
      setReady(true);
    };
    img.src = src;
    return () => { dead = true; };
  }, [JSON.stringify(look), res, h]);

  return (
    <>
      {/* 隐藏的矢量原件，只用来序列化，不参与显示 */}
      <div ref={hidden} style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden', opacity: 0 }} aria-hidden>
        <Avatar look={look} size={64} />
      </div>
      <canvas
        ref={canvas} width={res} height={h}
        className={'pixel-avatar' + (speaking ? ' speaking' : '')}
        style={{
          width: size, height: size * 1.3, display: 'block',
          imageRendering: 'pixelated', opacity: ready ? 1 : 0,
        }}
      />
    </>
  );
}
