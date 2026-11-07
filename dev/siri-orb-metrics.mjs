/**
 * siri-orb-metrics.mjs — Siri 光球的静态量化（无需浏览器）。
 *
 * 直接 import orb-renderer.js 里的纯计算部分，输出：
 *   · 各面板尺寸 / dpr 下的设备像素、球体与光晕直径、边缘过渡宽度
 *   · 每条渐变的停点数与最大相邻色阶差（8 位）
 *   · 最坏情况下核心叠加后的 RGB（证明不会钳白）
 *   · 每帧绘制调用数与像素规模
 *
 * 用法：node dev/siri-orb-metrics.mjs
 */

import {
  ORB_THEME,
  geometryFor,
  buildBaseStops,
  buildBackdropStops,
  buildHaloStops,
  buildBlobStops,
  buildSheenStops,
  buildSpecularStops,
  buildFrameModel,
} from "../mods/siri/orb-renderer.js";

const RGBA = /rgba\((\d+), (\d+), (\d+), ([0-9.]+)\)/;

function parseStops(stops) {
  return stops.map((stop) => {
    const match = stop.color.match(RGBA);
    if (!match) throw new Error(`无法解析颜色：${stop.color}`);
    return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]) * 255];
  });
}

function maxDelta(stops) {
  const values = parseStops(stops);
  const delta = [0, 0, 0, 0];
  for (let i = 1; i < values.length; i++) {
    for (let c = 0; c < 4; c++) {
      delta[c] = Math.max(delta[c], Math.abs(values[i][c] - values[i - 1][c]));
    }
  }
  return delta.map((v) => v.toFixed(1));
}

/** 在 8 位停点表上按 t 线性插值出 alpha（0..255）。 */
function sampleAlpha(stops, t) {
  const values = parseStops(stops);
  const offsets = stops.map((s) => s.offset);
  for (let i = 1; i < values.length; i++) {
    if (t <= offsets[i] || i === values.length - 1) {
      const span = offsets[i] - offsets[i - 1] || 1;
      const k = Math.min(1, Math.max(0, (t - offsets[i - 1]) / span));
      return values[i - 1][3] + (values[i][3] - values[i - 1][3]) * k;
    }
  }
  return 0;
}

/** 沿半径按 1 设备像素取样，返回 alpha 每像素最大跳变与"低于 1 级/像素"的区段长度。 */
function pixelSlope(stops, radiusDevice) {
  const count = Math.max(2, Math.round(radiusDevice));
  let maxStep = 0;
  let flatSteps = 0;
  for (let i = 0; i < count; i++) {
    const a0 = sampleAlpha(stops, i / count);
    const a1 = sampleAlpha(stops, (i + 1) / count);
    const step = Math.abs(a1 - a0);
    maxStep = Math.max(maxStep, step);
    if (step < 1) flatSteps += 1;
  }
  return { maxStep, flatSteps, count };
}


console.log("─ 几何 / 分辨率 ─");
for (const size of [64, 120, 240]) {
  for (const dpr of [1, 2, 3]) {
    const geo = geometryFor(size, dpr);
    console.log(
      `size=${String(size).padStart(3)} dpr=${dpr}  canvas=${geo.deviceSize}px  ` +
      `球体=${geo.bodyDiameterCss.toFixed(1)}px(画布内 ${(geo.bodyR * 2).toFixed(0)}px)  ` +
      `光晕=${geo.haloDiameterCss.toFixed(1)}px  ` +
      `球体边缘过渡=${geo.bodyFadeCss.toFixed(2)}css/${geo.bodyFadeDevice.toFixed(1)}dev  ` +
      `光晕环带=${((ORB_THEME.haloRadius - ORB_THEME.bodyRadius) * size).toFixed(1)}px`
    );
  }
}

console.log("\n─ 渐变停点与最大相邻色阶差（8 位，含 alpha）─");
const base = buildBaseStops();
const backdrop = buildBackdropStops();
const halo = buildHaloStops(true);
const blob = buildBlobStops([34, 216, 255]);
const sheen = buildSheenStops();
const spec = buildSpecularStops();
for (const [name, stops, mode] of [
  ["base", base, "mode=1"],
  ["backdrop", backdrop, "mode=1"],
  ["halo", halo, "mode=1"],
  ["blob sprite", blob, "mode=1"],
  ["sheen", sheen, "mode=1"],
  ["specular", spec, "mode=1"],
]) {
  const [dr, dg, db, da] = maxDelta(stops);
  console.log(`${name.padEnd(12)} stops=${String(stops.length).padStart(2)}  max ΔR/ΔG/ΔB/ΔA = ${dr}/${dg}/${db}/${da}  (${mode})`);
}
console.log("\n─ 每设备像素的 alpha 跳变（真正的色带指标）─");
for (const [size, dpr] of [[120, 2], [240, 3]]) {
  const geo = geometryFor(size, dpr);
  const halo = pixelSlope(buildHaloStops(true), geo.haloR);
  const backdrop = pixelSlope(buildBackdropStops(), geo.backdropR);
  const body = pixelSlope(buildBaseStops(), geo.bodyR);
  console.log(
    `size=${size} dpr=${dpr}: 光晕 最大 ${halo.maxStep.toFixed(2)}/px，` +
    `其中 ${halo.flatSteps}/${halo.count} 个采样点 < 1 级/px；` +
    `压层 最大 ${backdrop.maxStep.toFixed(2)}/px（${backdrop.flatSteps}/${backdrop.count} 段 < 1 级/px）；` +
    `球体 最大 ${body.maxStep.toFixed(2)}/px`
  );
}
console.log(`抖动幅度 ±${ORB_THEME.ditherLevels}/255：低于 1 级/像素的平坦段由逐像素噪声打散`);
console.log(`dither = 确定性 LCG，seed=0x${ORB_THEME.ditherSeed.toString(16)}，烘焙期执行，运行期零像素读写`);

console.log("\n─ 最坏情况：全部色块在同一个中心点叠加（不含高光层）─");
let rgb = [52, 22, 132];
for (const blobDef of ORB_THEME.blobs) {
  const a = blobDef.alpha;
  rgb = rgb.map((v, i) => v * (1 - a) + blobDef.color[i] * a);
}
console.log(`普通叠加后 rgb = (${rgb.map((v) => Math.round(v)).join(", ")})`);
console.log(`最大通道 = ${Math.round(Math.max(...rgb))}/255（<255 即核心不会被钳成纯白）`);

console.log("\n─ 每帧成本 ─");
console.log(`色块精灵 = ${ORB_THEME.blobs.length} 个（固定 ${ORB_THEME.spriteResolution}px 纹理）`);
console.log(`drawImage = 1 底图 + ${ORB_THEME.blobs.length} 精灵 + 1 遮罩合成 + 1 高光层 = ${ORB_THEME.blobs.length + 3} 次`);
console.log(`帧率封顶 ${(1000 / ORB_THEME.frameInterval).toFixed(0)}fps；关闭面板立即停表；减少动态效果时只画 1 帧`);
const model = buildFrameModel(0);
const maxTravel = Math.max(...model.map((m) => Math.hypot(m.nx, m.ny)));
console.log(`t=0 色块离中心最远 ${maxTravel.toFixed(3)}R（精灵半径 ${ORB_THEME.blobSpriteRadius}R，始终覆盖球心）`);
