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

import {
  buildGenieModel,
  GENIE_HANDOFF,
  GENIE_HANDOFF_MS,
  GENIE_MS,
  MATERIAL_EASE,
  geomProgress,
  materialWeight,
} from "./genie-geometry.js";
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
async function play(el, model, snap, reverse, shouldAbort, hooks = {}) {
  dropStage(el);
  let stage;
  try {
    stage = createGenieStage(model, snap);
  } catch {
    return false;
  }
  if (el) el._genieStage = stage;
  // 交接段几何是冻结的：进度换算后仍是同一个值时不必重画整帧（省掉首尾各 5~6 帧
  // 的全屏重绘），只改覆盖层不透明度。
  let lastGeom = -1;
  const drawAt = (p) => {
    const g = geomProgress(p);
    if (g === lastGeom) return;
    lastGeom = g;
    stage.draw(g);
  };
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
      if (hooks.onEnd) {
        try { hooks.onEnd(ok); } catch { /* 收尾失败不影响 resolve */ }
      }
      resolve(ok);
    };
    try {
      const first = reverse ? 1 : 0;
      // 交接段内几何冻结在起点：覆盖层画的就是真窗此刻的同一像素，
      // 只让它的不透明度连续爬升，材质因此是「渐变过去」而不是被抠掉。
      drawAt(first);
      stage.setOpacity(materialWeight(first));
      if (hooks.onStart) hooks.onStart();
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
      const p = reverse ? 1 - raw : raw;
      drawAt(p);
      stage.setOpacity(materialWeight(p));
      if (hooks.onProgress) {
        try { hooks.onProgress(p); } catch { /* 视觉回调失败不打断动画 */ }
      }
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

/** 与覆盖层材质曲线同源的 CSS 缓动串（几何与阴影都从同一个数组生成）。 */
const SHADOW_EASE = `cubic-bezier(${MATERIAL_EASE.join(", ")})`;

/**
 * 把当前 box-shadow 的颜色通道压成透明、保留几何（偏移/模糊/内阴影）。
 * 覆盖层裁的就是窗口矩形，100px 外阴影不在快照里，若不处理，隐藏真窗那一帧
 * 会有一大块暗色光环整块消失。box-shadow 是纯绘制属性，不会新建渲染层，
 * 在亚克力根上做 5~6 帧的过渡是允许的（禁止的是 filter/brightness 这类）。
 * @param {HTMLElement} el
 * @returns {string|null} 透明版阴影；没有阴影时返回 null
 */
function transparentShadow(el) {
  const shadow = getComputedStyle(el).boxShadow;
  if (!shadow || shadow === "none") return null;
  return shadow.replace(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*[\d.]+\s*)?\)/g,
    (_, r, g, b) => `rgba(${r}, ${g}, ${b}, 0)`,
  );
}

/** 收掉阴影交接的内联属性，交回主题样式表。 */
function clearShadow(el) {
  el.style.transition = "";
  el.style.boxShadow = "";
}

/**
 * 最小化：吸入 iconEl 所在的 Dock 图标。
 *
 * 材质连续性靠两件事，都不碰 `.window` 的 opacity（opacity < 1 的祖先会给
 * `.left` 的 backdrop-filter 新建 backdrop-root，毛玻璃反而被抠掉）：
 *   - 交接段几何冻结在 0，覆盖层画的是真窗此刻的同一像素；
 *   - 只让覆盖层不透明度按材质曲线连续爬升，把真窗「压」住；
 *   交接结束时覆盖层已不透明且像素同一，再把真窗 display:none —— 看不出切换。
 * 任何失败 resolve(false)，调用方走缩放淡出兜底。
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
  // DOM 快照（snapdom）同样照常播放：原生截图是机会性能力，本扩展未申请
  // activeTab / <all_urls>，captureVisibleTab 必然失败并进入 60s 冷却，
  // 此时唯一可用的就是 DOM 快照 —— 曾按「只认原生」直接 return false，
  // 结果整段神奇效果被缩放淡出兜底顶掉。
  if (!snap || !el._minimized || !el.isConnected) return false;

  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    el.classList.add("minimized");
    el.style.display = "none";
    clearShadow(el);
  };

  return play(el, model, snap, false, () => !el._minimized, {
    onStart() {
      // 阴影与覆盖层同步收尾：外阴影不在快照里，必须和材质一起淡掉，
      // 否则隐藏真窗的那一帧会有一大块暗色光环瞬灭。
      const clear = transparentShadow(el);
      if (clear) {
        el.style.transition = `box-shadow ${GENIE_HANDOFF_MS}ms ${SHADOW_EASE}`;
        el.style.boxShadow = clear;
      }
    },
    onProgress(p) {
      // 覆盖层已完全不透明（交接段收尾）才隐藏真窗，此刻两者像素同一。
      if (p >= GENIE_HANDOFF) settle();
    },
    onEnd(ok) {
      if (ok && el._minimized) settle();
      else if (!el._minimized) {
        // 中途被还原：真窗本来就没淡出过，放回来即可，不留半透明残影。
        el.style.display = "";
        el.classList.remove("minimized");
      }
      clearShadow(el);
    },
  });
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

  let revealed = false;
  // 反向交接：进度 p 退到交接段（覆盖层仍完全不透明、几何已冻结在落点矩形）时
  // 把真窗放回覆盖层之下，随后覆盖层淡出 —— 露出的正是同一像素，材质无跳变。
  // 外阴影不在快照里，所以要在这里反向补齐：先按透明阴影落地，再在剩余交接时间里
  // 抬回主题值，和覆盖层淡出同步收尾（与吸入方向完全对称）。
  const revealWindow = (p) => {
    if (revealed) return;
    revealed = true;
    const clear = transparentShadow(el);
    if (clear) {
      el.style.transition = `box-shadow ${Math.max(24, Math.round(p * GENIE_MS))}ms ${SHADOW_EASE}`;
      el.style.boxShadow = clear;
    }
    el.classList.remove("minimized");
    // 提前标记已落窗，避免 display 切换重播 window-fade-in。
    el.classList.add("wm-shown");
    el.style.display = "";
    if (clear) {
      // 先让透明阴影落地，再交回主题值，过渡才会真正发生。
      void el.offsetWidth;
      el.style.boxShadow = "";
    }
  };

  return play(el, model, snap, true, () => el._minimized, {
    onStart() { el.style.display = "none"; },
    onProgress(p) {
      if (p <= GENIE_HANDOFF) revealWindow(p);
    },
    onEnd(ok) {
      if (!revealed) revealWindow(0);
      if (!ok && el._minimized) el.style.display = "none";
      clearShadow(el);
    },
  });
}
