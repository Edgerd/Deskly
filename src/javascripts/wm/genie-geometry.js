/**
 * wm/genie-geometry.js — 「神奇效果」条带形变的纯几何（不碰 DOM、不持状态）
 *
 * 模型来自 macOS 最小化 genie 的两阶段网格形变，参考实现：
 *   - SquarePants1991/MagicalTransition（Metal 顶点着色器：0.4 捏颈 + 余程倾倒，
 *     收口宽度 = 0.5·0.98·cos(π·f + π) + 0.5 + 0.01，位移全程刚性平移）；
 *   - daniate《细说如何完美实现 macOS 中的神奇效果》（片元着色器同型模型，
 *     左右边界 = A·sin(π·v ± π/2) + D，与上式的余弦收口等价）。
 *
 * 把着色器的逐顶点位移翻译成「条带矩形」后，用 Canvas 2D 逐帧 drawImage 即可
 * 复现同一形变：条带沿缩放轴向 gather 点收拢，整体沿移动轴刚性平移进程序坞，
 * 越靠近坞线的条带按余弦曲线收得越窄。相对参考实现刻意做了两处取舍：
 *   1) 滑过坞线的条带不再像 shader 那样重新展宽（反正被坞条遮住），改为线性淡出，
 *      视觉上「没入坞内」；
 *   2) 阶段内加入缓动（捏颈 easeOutCubic、倾倒 easeInCubic）——shader 是线性，
 *      但 60fps 的 DOM 世界里线性前段读起来像卡住（0.2.55 的教训）。
 *
 * 坐标系约定与 wm/frame.js 一致：全部为视口像素（getBoundingClientRect 语义）。
 * 这里只算矩形，绝不给 .window 写 transform —— 带 backdrop-filter 的窗口一旦被
 * 提升为合成层亚克力就废（window.css 固化禁忌），形变永远画在独立覆盖层上，
 * 真实窗口只负责显隐。
 */

/** 第一阶段（捏颈）占总时长的比例。参考实现取 0.4。 */
export const GENIE_STAGE_SPLIT = 0.4;

/** 吸入全程时长（ms）。macOS 实测约 0.5s，略放慢让两阶段都读得清。 */
export const GENIE_MS = 620;

/** 条带基准厚度（px）。越小曲线越顺滑、drawImage 越多；8px 对 4K 窗口也只有一百余次。 */
export const GENIE_BAND_SIZE = 8;

/** 条带越过坞线后残余可见的距离（px）：这段里透明度线性归零。 */
export const GENIE_FADE_PX = 26;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 收口宽度比：f=0（贴着坞线）→ 收成一条缝，f=1（远端）→ 原宽。
 * 即参考实现的 scaleEnd = 0.5·0.98·cos(π·f + π) + 0.5 + 0.01。
 * @param {number} f 条带到坞线的实时距离与总程之比（调用方保证已钳到 [0,1]）
 * @returns {number} (0.02, 1]
 */
export function pinchScale(f) {
  return 0.51 - 0.49 * Math.cos(Math.PI * clamp01(f));
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInCubic = (t) => t * t * t;

/**
 * 构建一次形变动画的模型（窗口矩形、坞向、条带划分、行程），供逐帧 genieBands 复用。
 * @param {{x:number,y:number,w:number,h:number}} rect 窗口矩形（视口 px）
 * @param {{x:number,y:number}} gather 吸入锚点（底部坞取图标中心，侧坞取坞内缘线 + 图标中心纵坐标）
 * @param {"bottom"|"left"|"right"} dockSide 程序坞方位
 * @returns {object|null} 模型；几何不成立（窗口与坞线无行程等）时返回 null，调用方走兜底
 */
export function buildGenieModel(rect, gather, dockSide) {
  if (!rect || !gather) return null;
  if (!(rect.w >= 8 && rect.h >= 8)) return null;

  if (dockSide === "left" || dockSide === "right") {
    // 横向条带：缩放轴 = Y，移动轴 = X。left 坞向左倒（dir −1），right 坞向右倒。
    const dir = dockSide === "left" ? -1 : 1;
    const travel = dockSide === "left"
      ? rect.x + rect.w - gather.x
      : gather.x - rect.x;
    if (!(travel > 24)) return null;
    return {
      axis: "h", rect, gather, dockSide, travel, dir,
      dockLine: gather.x,
      distSign: dockSide === "right" ? -1 : 1,
      bands: splitBands(rect.w),
    };
  }

  // 底部程序坞（默认）：缩放轴 = X，移动轴 = Y（向下倒）。
  // 行程 = 窗口顶缘（远端）到坞线的距离 —— 倾倒结束时顶缘恰好贴到坞线，
  // 底部条带早已滑过坞线淡出；distSign=−1 即「距离 = 坞线 − 当前位置」。
  const travel = gather.y - rect.y;
  if (!(travel > 24)) return null;
  return {
    axis: "v", rect, gather, dockSide: "bottom", travel,
    dir: 1,
    dockLine: gather.y,
    distSign: -1,
    bands: splitBands(rect.h),
  };
}

function splitBands(span) {
  return Math.max(12, Math.min(120, Math.ceil(span / GENIE_BAND_SIZE)));
}

/**
 * 计算某进度下所有条带的目标矩形。
 * @param {object} model buildGenieModel 的产物
 * @param {number} progress 原始进度 [0,1]，内部做两阶段缓动
 * @returns {Array<{sx:number,sy:number,sw:number,sh:number,dx:number,dy:number,dw:number,dh:number,alpha:number}>}
 *          sx..sh 为快照采样区（窗口原始位置），dx..dh 为本帧绘制区，alpha 为该条带透明度
 */
export function genieBands(model, progress) {
  const p = clamp01(progress);
  const { rect, gather, travel, dir, dockLine, distSign } = model;
  const n = model.bands;
  const alongSpan = model.axis === "v" ? rect.h : rect.w;
  const thick = alongSpan / n;
  const out = [];

  for (let i = 0; i < n; i++) {
    const along0 = (model.axis === "v" ? rect.y : rect.x) + i * thick;
    const dist0 = distSign > 0 ? along0 - dockLine : dockLine - along0;
    const f0 = clamp01(dist0 / travel);

    let sc;
    // dist = 条带到坞线的实时距离（起点为 dist0，随倾倒线性递减；两坞向的
    // 符号差已在 dist0 里归一，正方向恒为「靠近坞线」）。
    let dist = dist0;
    if (p <= GENIE_STAGE_SPLIT) {
      sc = 1 + (pinchScale(f0) - 1) * easeOutCubic(p / GENIE_STAGE_SPLIT);
    } else {
      const pour = easeInCubic((p - GENIE_STAGE_SPLIT) / (1 - GENIE_STAGE_SPLIT));
      dist = dist0 - travel * pour;
      sc = pinchScale(clamp01(dist / travel));
    }
    const alpha = dist < 0 ? 1 - clamp01(-dist / GENIE_FADE_PX) : 1;
    const moved = dist0 - dist;

    const band = {
      sx: rect.x, sy: rect.y,
      sw: rect.w, sh: rect.h,
      dx: rect.x, dy: rect.y,
      dw: rect.w, dh: rect.h,
      alpha,
    };
    if (model.axis === "v") {
      band.sx = rect.x; band.sy = along0; band.sh = thick + 0.5;
      band.dx = gather.x + (rect.x - gather.x) * sc;
      band.dy = along0 + moved * dir;
      band.dw = rect.w * sc;
      band.dh = thick + 0.5;
    } else {
      band.sy = rect.y; band.sx = along0; band.sw = thick + 0.5;
      band.dy = gather.y + (rect.y - gather.y) * sc;
      band.dx = along0 + moved * dir;
      band.dh = rect.h * sc;
      band.dw = thick + 0.5;
    }
    out.push(band);
  }
  return out;
}
