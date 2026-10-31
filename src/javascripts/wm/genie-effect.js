/**
 * wm/genie-effect.js — 「神奇效果」的快照采集、覆盖层播放与状态衔接
 *
 * 分层：genie-geometry.js 只算矩形（纯函数），本模块负责所有会碰 DOM 的部分 ——
 * 用 modern-screenshot（assets/vendor，SVG foreignObject 管线，浏览器原生渲染，
 * 保真度高于逐属性重画的 html2canvas 一系）把窗口拍成离屏 canvas，再在一张
 * pointer-events:none 的覆盖层 canvas 上逐帧条带绘制，播完即拆。
 *
 * 两条铁律（违反任何一条就退回 dock.js 的 fallBackFadeOut 缩放淡出）：
 *   1) 绝不给 .window 写 transform / filter / clip-path —— backdrop-filter
 *      换 backdrop-root 后亚克力整片失效（window.css 固化禁忌）。形变全部
 *      发生在覆盖层上，真实窗口只做 display 显隐；
 *   2) 任何一步失败（快照超时 / 几何不成立 / 减少动态效果开启 / 图标缺失）
 *      都必须 resolve(false)，由调用方走兜底，绝不吞掉最小化动作本身。
 *
 * 快照在最小化时采集并按窗口缓存（WeakMap）：还原动画直接复用，避免「先显示
 * 再截图」的一帧闪烁；窗口内容在最小化期间发生变化则以下次最小化重新采集为准。
 */

import { domToCanvas } from "../../../assets/vendor/modern-screenshot.mjs";
import { Z } from "../zindex.js";
import { buildGenieModel, genieBands, GENIE_MS } from "./genie-geometry.js";

/** 快照硬预算：超时走兜底。正常窗口几十毫秒，给慢机留余量但不许卡住交互。 */
const SNAP_TIMEOUT_MS = 400;
/** 快照缩放上限：覆盖层动画只有 0.6s，2x 足够，省下大窗的序列化时间。 */
const SNAP_SCALE_MAX = 2;

/** 窗口 → 最近一次最小化时的快照与几何，供还原动画复用。 */
const snapshotCache = new WeakMap();

function reduceMotionOn() {
  return document.documentElement.getAttribute("data-reduce-motion") === "on";
}

function dockEl() {
  return document.getElementById("dock");
}

function dockSideOf() {
  const dock = dockEl();
  if (!dock) return "bottom";
  if (dock.classList.contains("pos-left")) return "left";
  if (dock.classList.contains("pos-right")) return "right";
  return "bottom";
}

/** 吸入锚点：底部坞取坞条顶缘 + 图标中心 x；侧坞取坞内缘线 + 图标中心 y。 */
function gatherOf(iconEl, side) {
  const r = iconEl.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  if (side !== "bottom") {
    const dockRect = (dockEl() || iconEl).getBoundingClientRect();
    return { x: side === "left" ? dockRect.right : dockRect.left, y: cy };
  }
  const dockRect = (dockEl() || iconEl).getBoundingClientRect();
  return { x: cx, y: dockRect.top };
}

/** 窗口快照；失败返回 null（modern-screenshot 的 timeout 只管媒体加载，整体再套一层竞速）。 */
async function captureWindow(el) {
  const scale = Math.min(window.devicePixelRatio || 1, SNAP_SCALE_MAX);
  try {
    const snap = await Promise.race([
      domToCanvas(el, { scale, backgroundColor: null }),
      new Promise((resolve) => setTimeout(() => resolve(null), SNAP_TIMEOUT_MS)),
    ]);
    return snap && snap.width > 0 ? snap : null;
  } catch {
    return null;
  }
}

function createOverlay() {
  const dpr = Math.min(window.devicePixelRatio || 1, SNAP_SCALE_MAX);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
  canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
  const style = canvas.style;
  style.position = "fixed";
  style.left = "0";
  style.top = "0";
  style.width = "100vw";
  style.height = "100vh";
  style.pointerEvents = "none";
  // 高于窗口与普通浮层、低于 Dock（9500）：条带滑过坞线后从坞条底下没入。
  style.zIndex = String(Z.GENIE);
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx };
}

function drawFrame(ctx, model, snap, srcScale, progress) {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  for (const b of genieBands(model, progress)) {
    if (b.alpha <= 0 || b.dw <= 0.25 || b.dh <= 0.25) continue;
    ctx.globalAlpha = b.alpha;
    ctx.drawImage(
      snap,
      b.sx * srcScale, b.sy * srcScale, b.sw * srcScale, b.sh * srcScale,
      b.dx, b.dy, b.dw, b.dh,
    );
  }
  ctx.globalAlpha = 1;
}

/**
 * 播放一段形变。reverse=false 吸入（进度 0→1），true 反放（进度 1→0，还原用）。
 * shouldAbort 每帧轮询：播放期间用户把状态翻回去（快速连点 / 还原中再最小化）
 * 就立即拆层收场，宁短勿鬼影。
 * @returns {Promise<void>} 播完（含覆盖层拆除）即 resolve
 */
function play(model, snap, srcScale, reverse, shouldAbort) {
  return new Promise((resolve) => {
    const { canvas, ctx } = createOverlay();
    const start = performance.now();
    let raf = 0;
    const finish = () => {
      cancelAnimationFrame(raf);
      canvas.remove();
      resolve();
    };
    const tick = (now) => {
      if (shouldAbort && shouldAbort()) return finish();
      const raw = Math.min((now - start) / GENIE_MS, 1);
      drawFrame(ctx, model, snap, srcScale, reverse ? 1 - raw : raw);
      if (raw >= 1) finish();
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
}

/** 还原目标矩形：窗口此刻 display:none，几何读内联 left/top/width/height（wm 的写回约定）。 */
function targetRectOf(el) {
  const x = parseFloat(el.style.left);
  const y = parseFloat(el.style.top);
  const w = parseFloat(el.style.width);
  const h = parseFloat(el.style.height);
  if (![x, y, w, h].every(Number.isFinite) || w < 8 || h < 8) return null;
  return { x, y, w, h };
}

/**
 * 最小化：吸入 iconEl 所在的 Dock 图标。
 * 快照期间真实窗口保持原样（用户看到的还是活窗口），快照就绪后由覆盖层接管像素、
 * 真窗转 display:none。任何失败 resolve(false)，调用方走缩放淡出兜底。
 * @param {HTMLElement} el 窗口根元素
 * @param {HTMLImageElement|null} iconEl Dock 图标
 * @returns {Promise<boolean>} 是否真正播放了动画
 */
export async function minimizeGenie(el, iconEl) {
  if (!el || !iconEl || reduceMotionOn()) return false;
  const box = el.getBoundingClientRect();
  const rect = { x: box.left, y: box.top, w: box.width, h: box.height };
  const side = dockSideOf();
  const model = buildGenieModel(rect, gatherOf(iconEl, side), side);
  if (!model) return false;

  const snap = await captureWindow(el);
  // 快照是异步的：期间用户可能把窗口还原 / 关掉，状态翻回去就别再抢屏幕。
  if (!snap || !el._minimized || !el.isConnected) return false;

  snapshotCache.set(el, { snap, srcScale: snap.width / rect.w });

  el.classList.add("minimized");
  el.style.display = "none";
  await play(model, snap, snap.width / rect.w, false, () => !el._minimized);
  return true;
}

/**
 * 还原：从 Dock 图标反向吐出。复用最小化时缓存的快照（最小化期间内容的变化
 * 不追拍 —— 动画只有 0.6s，落点之后真窗立即可见）。
 * 调用方约定：播放期间保持窗口隐藏，resolve(true) 后再把真窗揭开置顶；
 * resolve(false) 时立即走「直接显示 + 置顶」的老路径。
 * @returns {Promise<boolean>}
 */
export async function restoreGenie(el, iconEl) {
  const cache = snapshotCache.get(el);
  if (!el || !iconEl || !cache || reduceMotionOn()) return false;
  const rect = targetRectOf(el);
  if (!rect) return false;
  const side = dockSideOf();
  const model = buildGenieModel(rect, gatherOf(iconEl, side), side);
  if (!model) return false;

  el.style.display = "none";
  await play(model, cache.snap, cache.srcScale, true, () => el._minimized);
  return true;
}
