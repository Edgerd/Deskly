/**
 * siri-orb-v3-metrics.mjs — 第三版光球的离线光栅化与量化（无需浏览器）。
 *
 * 直接 import orb-renderer.js 的纯计算与停点表，在 CPU 上按 Canvas 2D 的合成顺序
 * （光晕 → 底色 → 流体层(遮罩) → 高光层）逐像素复现一帧，然后统计：
 *   · 色相分布：30° 桶直方图、可辨色相段数、四目标色相覆盖率、色相跨度
 *   · 边缘过渡带：CSS 像素宽度、最暗像素与背景的亮度/通道差、向外是否单调变亮
 *   · 核心最大通道值（含高光叠加后，确认没有钳白）
 *   · 每帧 drawImage 次数
 * 并输出 PPM 预览（temp/ 下，可用 Pillow 转 PNG）。
 *
 * 注意：这里用 premultiplied sRGB 线性插值模拟渐变（Chrome 的画布渐变语义），
 * 8 位量化和抖动不参与计算——抖动只影响 ±1.6/255 的噪声，不改变色相分段。
 *
 * 用法：node dev/siri-orb-v3-metrics.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import {
  ORB_THEME,
  geometryFor,
  buildBaseStops,
  buildHaloStops,
  buildSheenStops,
  buildSpecularStops,
  buildBlobStops,
  buildFrameModel,
} from "../mods/siri/orb-renderer.js";

const RGBA = /rgba\((\d+), (\d+), (\d+), ([0-9.]+)\)/;

/** 把 rgba 字符串停点表解析为 [offset, r, g, b, a(0..1)]，按数组引用缓存。 */
const parsedCache = new WeakMap();
function parsed(stops) {
  let out = parsedCache.get(stops);
  if (out) return out;
  out = stops.map((stop) => {
    const m = stop.color.match(RGBA);
    if (!m) throw new Error(`无法解析颜色：${stop.color}`);
    return [stop.offset, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  });
  parsedCache.set(stops, out);
  return out;
}

/**
 * 在停点表上按 t 取样，alpha 在 premultiplied 空间插值（与 Canvas 渐变一致）。
 * @returns {[number, number, number, number]} r,g,b 0..255，a 0..1
 */
function sample(stops, t) {
  const s = parsed(stops);
  const tt = Math.min(1, Math.max(0, t));
  let i = 1;
  while (i < s.length - 1 && tt > s[i][0]) i += 1;
  const a = s[i - 1];
  const b = s[i];
  const span = (b[0] - a[0]) || 1;
  const k = Math.min(1, Math.max(0, (tt - a[0]) / span));
  const aa = a[4];
  const ab = b[4];
  const alpha = aa + (ab - aa) * k;
  if (alpha <= 1e-6) return [0, 0, 0, 0];
  return [
    (a[1] * aa + (b[1] * ab - a[1] * aa) * k) / alpha,
    (a[2] * aa + (b[2] * ab - a[2] * aa) * k) / alpha,
    (a[3] * aa + (b[3] * ab - a[3] * aa) * k) / alpha,
    alpha,
  ];
}

/** source-over 合成：src 盖在 dst 上。dst/src = [r,g,b,a]。 */
function over(dst, src) {
  const sa = src[3];
  if (sa <= 1e-6) return dst;
  const da = dst[3];
  const oa = sa + da * (1 - sa);
  return [
    (src[0] * sa + dst[0] * da * (1 - sa)) / oa,
    (src[1] * sa + dst[1] * da * (1 - sa)) / oa,
    (src[2] * sa + dst[2] * da * (1 - sa)) / oa,
    oa,
  ];
}

function luminance(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function hueOf(rgb) {
  const r = rgb[0];
  const g = rgb[1];
  const b = rgb[2];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-6) return null;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, sat: d / max, val: max / 255 };
}

/** 流体层径向遮罩 alpha：0.70R 内实心，(solid+fade)/2 处 0.55，到 0.86R 归零。 */
function maskAlpha(t) {
  const solid = ORB_THEME.flowMask.solid;
  const fade = ORB_THEME.flowMask.fade;
  const mid = (solid + fade) / 2;
  if (t <= solid) return 1;
  if (t <= mid) return 1 + (0.55 - 1) * ((t - solid) / (mid - solid));
  if (t >= fade) return 0;
  return 0.55 * (1 - (t - mid) / (fade - mid));
}

const FRAME_BG = [245, 245, 247];

/** 复现一帧里单个像素的最终颜色；返回 [r,g,b,覆盖率 alpha]。 */
function renderPixel(x, y, geo, model, assets, bg = FRAME_BG) {
  let px = [bg[0], bg[1], bg[2], 1];
  let cov = 0;
  const add = (src) => {
    if (src[3] <= 1e-6) return;
    cov = src[3] + cov * (1 - src[3]);
    px = over(px, src);
  };
  const dx = x - geo.cx;
  const dy = y - geo.cy;
  const r = Math.hypot(dx, dy);

  // 1) 外圈光晕（在底色下面）
  if (r <= geo.haloR) add(sample(assets.halo, r / geo.haloR));

  // 2) 球体底色
  if (r <= geo.bodyR) add(sample(assets.base, r / geo.bodyR));

  // 3) 流体层：5 个精灵 source-over，再乘径向遮罩
  if (r <= geo.bodyR) {
    let flow = null;
    for (const item of model) {
      const def = ORB_THEME.blobs[item.index];
      const offX = item.nx * geo.bodyR;
      const offY = item.ny * geo.bodyR;
      const spriteR = geo.bodyR * ORB_THEME.blobSpriteRadius * item.scale;
      const d = Math.hypot(dx - offX, dy - offY);
      if (d >= spriteR) continue;
      const alpha = sample(assets.blobs[item.index], d / spriteR)[3] * item.alpha;
      if (alpha <= 1e-6) continue;
      const src = [def.color[0], def.color[1], def.color[2], alpha];
      flow = flow ? over(flow, src) : src;
    }
    if (flow) {
      flow = [flow[0], flow[1], flow[2], flow[3] * maskAlpha(r / geo.bodyR)];
      add(flow);
    }
  }

  // 4) 左上椭圆柔光 + 热核
  const sheen = ORB_THEME.sheen;
  const sx = dx - sheen.dx * geo.bodyR;
  const sy = dy - sheen.dy * geo.bodyR;
  const cos = Math.cos(sheen.rotation);
  const sin = Math.sin(sheen.rotation);
  const u = sx * cos + sy * sin;
  const v = -sx * sin + sy * cos;
  const sr = Math.hypot(u / (geo.bodyR * sheen.rx), v / (geo.bodyR * sheen.ry));
  if (sr <= 1) add(sample(assets.sheen, sr));

  const spec = ORB_THEME.specular;
  const sd = Math.hypot(dx - spec.dx * geo.bodyR, dy - spec.dy * geo.bodyR);
  const st = sd / (geo.bodyR * spec.radius);
  if (st <= 1) add(sample(assets.specular, st));

  return [px[0], px[1], px[2], cov];
}

function buildAssets() {
  return {
    base: buildBaseStops(),
    halo: buildHaloStops(true),
    sheen: buildSheenStops(),
    specular: buildSpecularStops(),
    blobs: ORB_THEME.blobs.map((def) => buildBlobStops(def.color)),
  };
}

/** 把 PPM (P6) 渲染到 480×480 设备像素（240 CSS @ dpr2）。 */
function writePreview(geo, model, assets, file) {
  const w = geo.deviceSize;
  const h = geo.deviceSize;
  const buf = Buffer.alloc(w * h * 3);
  let i = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = renderPixel(x + 0.5, y + 0.5, geo, model, assets);
      buf[i++] = Math.round(px[0]);
      buf[i++] = Math.round(px[1]);
      buf[i++] = Math.round(px[2]);
    }
  }
  const header = Buffer.from(`P6\n${w} ${h}\n255\n`);
  writeFileSync(file, Buffer.concat([header, buf]));
}

/* ─────────────────────────── 统计 ─────────────────────────── */

const TARGET_HUES = [
  { name: "青", hue: 192 },
  { name: "蓝", hue: 220 },
  { name: "紫", hue: 272 },
  { name: "粉", hue: 320 },
];

function hueMetrics(geo, model, assets, frameSeconds) {
  const samples = [];
  const step = 1;
  const limit = geo.bodyR * 0.76;
  for (let y = 0; y < geo.deviceSize; y += step) {
    for (let x = 0; x < geo.deviceSize; x += step) {
      const dx = x + 0.5 - geo.cx;
      const dy = y + 0.5 - geo.cy;
      if (Math.hypot(dx, dy) > limit) continue;
      const px = renderPixel(x + 0.5, y + 0.5, geo, model, assets);
      const hsv = hueOf(px);
      if (!hsv || hsv.sat < 0.25 || hsv.val < 0.30) continue;
      samples.push(hsv.h);
    }
  }
  if (!samples.length) return { frameSeconds, valid: 0, buckets: [], segments: 0, span: 0, targets: [], p5: 0, p95: 0 };

  const buckets = new Array(12).fill(0);
  for (const h of samples) buckets[Math.floor((h % 360) / 30)] += 1;

  const targets = TARGET_HUES.map((t) => {
    let count = 0;
    for (const h of samples) {
      let d = Math.abs(h - t.hue);
      if (d > 180) d = 360 - d;
      if (d <= 24) count += 1;
    }
    return { ...t, pct: count / samples.length };
  });

  const sorted = samples.slice().sort((a, b) => a - b);
  const p5 = sorted[Math.floor(sorted.length * 0.05)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const segments = buckets.filter((c) => c >= samples.length * 0.03).length;

  return {
    frameSeconds,
    valid: samples.length,
    buckets: buckets.map((c) => (c / samples.length * 100)),
    segments,
    span: p95 - p5,
    targets,
    p5,
    p95,
  };
}

function edgeMetrics(geo, model, assets) {
  const dirs = 24;
  const steps = Math.ceil(geo.haloR) + 2;
  const profiles = [];
  for (let d = 0; d < dirs; d++) {
    const a = (d / dirs) * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const rows = [];
    for (let ri = 0; ri <= steps; ri++) {
      const x = geo.cx + cos * ri;
      const y = geo.cy + sin * ri;
      rows.push({ r: ri, px: renderPixel(x, y, geo, model, assets) });
    }
    profiles.push(rows);
  }

  // 平均径向 profile：覆盖面 alpha 与亮度
  const avgAlpha = [];
  const avgLum = [];
  for (let ri = 0; ri <= steps; ri++) {
    let a = 0;
    let l = 0;
    for (const rows of profiles) {
      a += rows[ri].px[3];
      l += luminance(rows[ri].px);
    }
    avgAlpha.push(a / dirs);
    avgLum.push(l / dirs);
  }

  // 过渡带起点：由内向外最后一个覆盖面 alpha ≥ 0.80 的半径
  let start = 0;
  for (let ri = 0; ri <= steps; ri++) {
    if (avgAlpha[ri] >= 0.80) start = ri;
  }
  let end = steps;
  for (let ri = steps; ri >= 0; ri--) {
    if (avgAlpha[ri] >= 0.02) {
      end = ri;
      break;
    }
  }

  const bandStart = start;
  const bandEnd = Math.min(steps, Math.ceil(geo.haloR));
  let minLum = Infinity;
  let minLumAt = 0;
  let minChannel = 255;
  let dips = 0;
  let maxDip = 0;
  for (let ri = bandStart; ri <= bandEnd; ri++) {
    const l = avgLum[ri];
    if (l < minLum) {
      minLum = l;
      minLumAt = ri;
    }
    if (ri > bandStart) {
      const prev = avgLum[ri - 1];
      if (prev - l > 0.5) {
        dips += 1;
        maxDip = Math.max(maxDip, prev - l);
      }
    }
  }
  for (const rows of profiles) {
    for (let ri = bandStart; ri <= bandEnd; ri++) {
      const p = rows[ri].px;
      minChannel = Math.min(minChannel, p[0], p[1], p[2]);
    }
  }

  return {
    widthCss: (end - start) / geo.dpr,
    definedCss: (ORB_THEME.haloRadius - ORB_THEME.bodyFadeStart * ORB_THEME.bodyRadius) * geo.size,
    bodyFadeCss: (1 - ORB_THEME.bodyFadeStart) * ORB_THEME.bodyRadius * geo.size,
    minLum,
    minLumCssR: minLumAt / geo.dpr,
    minChannel,
    dips,
    maxDip,
    bgLum: luminance(FRAME_BG),
  };
}

function coreMetrics(geo, model, assets) {
  let maxChannel = 0;
  let maxAt = null;
  let core = null;
  const limit = geo.bodyR * 0.6;
  for (let y = 0; y < geo.deviceSize; y++) {
    for (let x = 0; x < geo.deviceSize; x++) {
      const dx = x + 0.5 - geo.cx;
      const dy = y + 0.5 - geo.cy;
      if (Math.hypot(dx, dy) > limit) continue;
      const px = renderPixel(x + 0.5, y + 0.5, geo, model, assets);
      const m = Math.max(px[0], px[1], px[2]);
      if (m > maxChannel) {
        maxChannel = m;
        maxAt = { x, y, r: Math.hypot(dx, dy) / geo.bodyR, rgb: px.slice(0, 3) };
      }
      if (x === Math.floor(geo.cx) && y === Math.floor(geo.cy)) core = px.slice(0, 3);
    }
  }
  const spec = ORB_THEME.specular;
  const sx = geo.cx + spec.dx * geo.bodyR - 0.5;
  const sy = geo.cy + spec.dy * geo.bodyR - 0.5;
  const specPx = renderPixel(sx, sy, geo, model, assets).slice(0, 3);
  return { maxChannel, maxAt, core, specPx };
}

/* ─────────────────────────── 运行 ─────────────────────────── */

const assets = buildAssets();
const geo = geometryFor(120, 2);       // 实机面板 120 CSS @ dpr2
const model = buildFrameModel(0);
const frames = [0, 2, 3.5, 5];

console.log("─ 第三版参数 ─");
console.log(`球体直径 ${geo.bodyDiameterCss} CSS px（120 面板）；底色淡出起点 ${ORB_THEME.bodyFadeStart}R；` +
  `精灵半径 ${ORB_THEME.blobSpriteRadius}R；色相锚点 ${ORB_THEME.blobs.map((b) => `${(b.angle * 180 / Math.PI).toFixed(0)}°`).join(" / ")}`);
console.log(`每帧 drawImage = 1 底图 + ${ORB_THEME.blobs.length} 精灵 + 1 遮罩 + 1 高光 = ${ORB_THEME.blobs.length + 3}`);

console.log("\n─ 色相分布（r ≤ 0.76R，sat ≥ 0.25，val ≥ 0.30）─");
for (const t of frames) {
  const m = buildFrameModel(t);
  const r = hueMetrics(geo, m, assets, t);
  const targetText = r.targets.map((x) => `${x.name} ${(x.pct * 100).toFixed(1)}%`).join("  ");
  const bucketText = r.buckets
    .map((pct, i) => `${String(i * 30).padStart(3)}°:${pct.toFixed(1)}`)
    .filter((s) => !s.endsWith(":0.0"))
    .join(" ");
  console.log(`t=${t.toFixed(1)}s  有效像素 ${r.valid}  段数 ${r.segments}  跨度 ${r.span.toFixed(0)}° (P5 ${r.p5.toFixed(0)}° → P95 ${r.p95.toFixed(0)}°)`);
  console.log(`        目标覆盖 ${targetText}`);
  console.log(`        30° 桶 ${bucketText}`);
}

const edge = edgeMetrics(geo, model, assets);
console.log("\n─ 边缘过渡带（24 方向平均，背景 #F5F5F7）─");
console.log(`定义过渡带：底色淡出 ${edge.bodyFadeCss.toFixed(2)} CSS px（0.86R→R）+ 光晕 ${(edge.definedCss - edge.bodyFadeCss).toFixed(2)} CSS px，合计 ${edge.definedCss.toFixed(2)} CSS px`);
console.log(`实测可见带（覆盖 alpha 0.80 → 0.02）：${edge.widthCss.toFixed(2)} CSS px`);
console.log(`过渡带最暗亮度 ${edge.minLum.toFixed(2)} / 背景 ${edge.bgLum.toFixed(2)}，差 ${(edge.minLum - edge.bgLum).toFixed(2)}（位置 r=${edge.minLumCssR.toFixed(1)} CSS px）`);
console.log(`过渡带最小通道值 ${edge.minChannel.toFixed(0)}/255；向外亮度回落 >0.5 的次数 ${edge.dips}，最大 ${edge.maxDip.toFixed(2)}`);

const core = coreMetrics(geo, model, assets);
console.log("\n─ 核心亮度 ─");
console.log(`核心最大通道 ${core.maxChannel.toFixed(0)}/255（r=${core.maxAt.r.toFixed(2)}R, rgb ${core.maxAt.rgb.map((v) => v.toFixed(0)).join(",")}）`);
console.log(`球心 rgb ${core.core.map((v) => v.toFixed(0)).join(",")}；热核中心 rgb ${core.specPx.map((v) => v.toFixed(0)).join(",")}`);

mkdirSync("temp/siri-orb-v3", { recursive: true });
const previewGeo = geometryFor(240, 2); // 480×480 预览（2 倍于默认面板）
const previewModel = buildFrameModel(0);
writePreview(previewGeo, previewModel, assets, "temp/siri-orb-v3/orb-480.ppm");
const actualGeo = geometryFor(120, 2); // 240×240：默认 120 CSS 面板的真实设备像素
writePreview(actualGeo, previewModel, assets, "temp/siri-orb-v3/orb-240.ppm");
console.log("\n预览：temp/siri-orb-v3/orb-480.ppm（480×480，240 CSS @ dpr2）");
console.log("      temp/siri-orb-v3/orb-240.ppm（240×240，120 CSS @ dpr2，默认面板实际像素）");
