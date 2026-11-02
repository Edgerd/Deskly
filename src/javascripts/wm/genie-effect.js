/**
 * wm/genie-effect.js — 「神奇效果」的快照采集、覆盖层播放与状态衔接
 *
 * 分层：genie-geometry.js 只算矩形（纯函数），genie-capture.js 负责快照与预热，
 * genie-renderer.js 负责 WebGL/Canvas 覆盖层；本模块只编排状态与播放。
 *
 * 两条铁律（违反任何一条就退回 dock.js 的 fallBackFadeOut 缩放淡出）：
 *   1) 绝不给 .window 写 transform / filter / clip-path —— backdrop-filter
 *      换 backdrop-root 后亚克力整片失效（window.css 固化禁忌）。形变全部
 *      发生在覆盖层上，真实窗口只做 display 显隐；
 *   2) 任何一步失败（快照超时 / 几何不成立 / 减少动态效果开启 / 图标缺失）
 *      都必须 resolve(false)，由调用方走兜底，绝不吞掉最小化动作本身。
 */

import { buildGenieModel, GENIE_MS } from "./genie-geometry.js";
import { cachedSnapshot, snapshotFor } from "./genie-capture.js";
import { createGenieStage } from "./genie-renderer.js";

function reduceMotionOn() {
  if (document.documentElement.getAttribute("data-reduce-motion") === "on") return true;
  // 与 drag / capture 保持同源：站内开关与系统偏好任一开启都不播逐像素动画。
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
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

/** 拆掉某窗口遗留的覆盖层。任何新动画开始前先调用，防止上一段异常退出留下孤儿 canvas。 */
function dropStage(el) {
  const stage = el && el._genieStage;
  if (!stage) return;
  el._genieStage = null;
  try { stage.dispose(); } catch { /* 已释放 */ }
}

/**
 * 播放一段形变。reverse=false 吸入（进度 0→1），true 反放（进度 1→0，还原用）。
 * shouldAbort 每帧轮询：播放期间用户把状态翻回去（快速连点 / 还原中再最小化）
 * 就立即拆层收场，宁短勿鬼影。
 * @returns {Promise<boolean>} 是否成功建立并完整播放了渲染舞台
 */
async function play(el, model, snap, reverse, shouldAbort, onStart) {
  dropStage(el);
  let stage;
  try {
    stage = createGenieStage(model, snap);
  } catch {
    return false;
  }
  if (el) el._genieStage = stage;
  return new Promise((resolve) => {
    let start = 0;
    let raf = 0;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      if (el && el._genieStage === stage) el._genieStage = null;
      try { stage.dispose(); } catch { /* 已释放 */ }
      resolve(ok);
    };
    try {
      stage.draw(reverse ? 1 : 0);
      if (onStart) onStart();
    } catch {
      // 建层成功但首帧/隐藏步骤抛错：必须立刻拆层并 resolve(false)，
      // 否则覆盖层留在屏幕上、调用方又以为播放完成。
      finish(false);
      return;
    }
    const tick = (now) => {
      if (shouldAbort && shouldAbort()) return finish(false);
      if (stage.isLost && stage.isLost()) return finish(false);
      if (!start) start = now;
      const raw = Math.min((now - start) / GENIE_MS, 1);
      stage.draw(reverse ? 1 - raw : raw);
      if (raw >= 1) finish(true);
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

  const snap = await snapshotFor(el, rect);
  // 快照是异步的：期间用户可能把窗口还原 / 关掉，状态翻回去就别再抢屏幕。
  if (!snap || !el._minimized || !el.isConnected) return false;

  return play(
    el,
    model,
    snap,
    false,
    () => !el._minimized,
    () => {
      el.classList.add("minimized");
      el.style.display = "none";
    },
  );
}

/**
 * 还原：从 Dock 图标反向吐出。复用最小化时缓存的快照（最小化期间内容的变化
 * 不追拍 —— 动画只有 0.6s，落点之后真窗立即可见）。
 * 调用方约定：播放期间保持窗口隐藏，resolve(true) 后再把真窗揭开置顶；
 * resolve(false) 时立即走「直接显示 + 置顶」的老路径。
 * @returns {Promise<boolean>}
 */
export async function restoreGenie(el, iconEl) {
  if (!el || !iconEl || reduceMotionOn()) return false;
  const rect = targetRectOf(el);
  if (!rect) return false;
  const snap = cachedSnapshot(el, rect);
  if (!snap) return false;
  const side = dockSideOf();
  const model = buildGenieModel(rect, gatherOf(iconEl, side), side);
  if (!model) return false;

  return play(
    el,
    model,
    snap,
    true,
    () => el._minimized,
    () => { el.style.display = "none"; },
  );
}
