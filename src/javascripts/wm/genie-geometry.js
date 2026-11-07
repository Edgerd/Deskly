/**
 * wm/genie-geometry.js — 「神奇效果」条带形变的纯几何（不碰 DOM、不持状态）
 *
 * 模型来自 macOS 最小化 genie 的两阶段网格形变，参考实现：
 *   - SquarePants1991/MagicalTransition（Metal 顶点着色器：0.4 捏颈 + 余程倾倒，
 *     收口宽度 = 0.5·0.98·cos(π·f + π) + 0.5 + 0.01，位移全程刚性平移）；
 *   - daniate《细说如何完美实现 macOS 中的神奇效果》（片元着色器同型模型，
 *     左右边界 = A·sin(π·v ± π/2) + D，与上式的余弦收口等价）。
 *
 * WebGL 片元着色器按同一公式做逐像素逆映射；没有 WebGL2 时，才退回把公式翻译成
 * 「条带矩形」的 Canvas 2D 绘制。两种后端共用本模块的阶段、行程与收口参数，
 * 避免各写一套数学后漂移。条带沿缩放轴向 gather 点收拢，整体沿移动轴刚性平移
 * 进程序坞，越靠近坞线的条带按余弦曲线收得越窄。相对参考实现刻意做了两处取舍：
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

/**
 * Canvas 2D 兜底条带厚度（px）。WebGL 正常路径逐像素采样，不切条带；
 * 这条只服务于没有 WebGL2 的环境，2px 已能把阶梯压到接近一像素。
 */
export const GENIE_BAND_SIZE = 2;

/** 条带越过坞线后残余可见的距离（px）：这段里透明度线性归零。 */
export const GENIE_FADE_PX = 26;

/**
 * 材质交接段占总时长的比例（15%，约 93ms / 60fps 下 5~6 帧）。
 *
 * 为什么不能直接 display:none 切到覆盖层：真实窗口的毛玻璃是 backdrop-filter
 * 实时合成的，覆盖层画的却是一块烘焙快照（.window > .left 的模糊、内阴影、
 * 圆角、文字明度全在像素里）。两者一硬切就是「材质被抠掉」。
 *
 * 为什么也不给 .window 写 opacity 做互补淡化：opacity < 1 的祖先会为
 * backdrop-filter 建立新的 backdrop-root，`.left` 的采样范围被截到窗口内部，
 * 毛玻璃当场退化 —— 正是要修的那个现象。
 *
 * 所以交接的做法是「几何冻结 + 只淡入覆盖层」：
 *   交接段内 geomProgress 恒为 0，覆盖层画的就是真窗此刻的同一像素；
 *   同时覆盖层不透明度按材质曲线从 0 连续升到 1，压住真窗；
 *   交接结束时覆盖层已完全不透明且与真窗像素同一，再隐藏真窗看不出任何变化。
 */
export const GENIE_HANDOFF = 0.15;

/** 交接段毫秒数：覆盖层淡入所需的时间，也是动作开始前的静止窗口。 */
export const GENIE_HANDOFF_MS = Math.round(GENIE_MS * GENIE_HANDOFF);

/**
 * 材质缓动。交接段是「同一张图的交叉淡化」（几何冻结，见 geomProgress），
 * 唯一的可见变化是渲染层之间的细微色差，所以用对称 S 曲线（两端斜率 0）
 * 而不是位移那种强 ease-out：5~6 帧里每帧约 0.29，任何一帧都不会「换完」。
 */
export const MATERIAL_EASE = [0.45, 0, 0.55, 1];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 三次贝塞尔单轴求值。 */
function bezierAxis(t, c1, c2) {
  const mt = 1 - t;
  return 3 * mt * mt * t * c1 + 3 * mt * t * t * c2 + t * t * t;
}

/** 给定 x 反解参数 t 再求 y，与 CSS cubic-bezier 完全同源。 */
function cubicBezier(x, curve) {
  const [x1, y1, x2, y2] = curve;
  const cx = (t) => bezierAxis(t, x1, x2);
  const cy = (t) => bezierAxis(t, y1, y2);
  let lo = 0;
  let hi = 1;
  let t = x;
  for (let i = 0; i < 12; i += 1) {
    const v = cx(t);
    if (Math.abs(v - x) < 1e-5) break;
    if (v < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return cy(t);
}

/**
 * 覆盖层不透明度：交接段内按材质曲线 0→1，交接段之后恒为 1。
 * 两个方向共用同一条曲线 —— 还原时进度反向走，调用方传同一个 p 即可。
 * @param {number} progress 原始进度 [0,1]
 * @returns {number} [0,1] 单调不减
 */
export function materialWeight(progress) {
  return cubicBezier(clamp01(clamp01(progress) / GENIE_HANDOFF), MATERIAL_EASE);
}

/**
 * 几何进度：交接段内冻结在 0，交接结束后把剩余时长线性映射到 [0,1]。
 * 冻结是材质无缝的前提：只有覆盖层与真窗同一像素时，淡入/淡出才看不出来。
 * @param {number} progress 原始进度 [0,1]
 * @returns {number} [0,1]
 */
export function geomProgress(progress) {
  const p = clamp01(progress);
  if (p <= GENIE_HANDOFF) return 0;
  return (p - GENIE_HANDOFF) / (1 - GENIE_HANDOFF);
}

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
  return Math.max(12, Math.min(720, Math.ceil(span / GENIE_BAND_SIZE)));
}

/**
 * 两阶段进度。让渲染器与几何断言共用同一组缓动，避免两边各算一套缓动后漂移。
 * @param {number} progress 原始进度 [0,1]
 * @returns {{pinch:number,pour:number,translation:number}} pinch 为第一阶段完成度，pour 为第二阶段倾倒比例
 */
export function genieParams(model, progress) {
  const p = clamp01(progress);
  if (p <= GENIE_STAGE_SPLIT) {
    return {
      pinch: easeOutCubic(p / GENIE_STAGE_SPLIT),
      pour: 0,
      translation: 0,
    };
  }
  const pour = easeInCubic((p - GENIE_STAGE_SPLIT) / (1 - GENIE_STAGE_SPLIT));
  return { pinch: 1, pour, translation: model.travel * pour };
}

/**
 * 某进度、某源条带处的横向缩放。
 * @param {object} model buildGenieModel 的产物
 * @param {number} f0 源条带到坞线的距离比，[0,1]（未钳制）
 * @param {{pinch:number,pour:number}} stage genieParams 的产物
 * @returns {number}
 */
export function bandScale(model, f0, stage) {
  if (stage.pour > 0) return pinchScale(f0 - stage.pour);
  return 1 + (pinchScale(f0) - 1) * stage.pinch;
}

/**
 * 逆映射：由屏幕上的目标像素反算窗口快照中的源坐标。
 *
 * WebGL 片元着色器实现的是同一公式，本函数用于无浏览器的往返断言：
 * 目标像素必须能精确反推回生成它的源条带，否则边缘会漂、内容会错位。
 * @param {object} model buildGenieModel 的产物
 * @param {number} progress 原始进度 [0,1]
 * @param {number} dx 目标视口横坐标
 * @param {number} dy 目标视口纵坐标
 * @returns {{x:number,y:number,f0:number,scale:number,alpha:number,inside:boolean}}
 */
export function genieSourceAt(model, progress, dx, dy) {
  const stage = genieParams(model, progress);
  const { rect, gather, dockLine, distSign, travel, dir } = model;
  const translation = stage.translation;

  let srcX;
  let srcY;
  let f0;
  if (model.axis === "v") {
    srcY = dy - translation;
    f0 = (srcY - dockLine) * distSign / travel;
    const sc = bandScale(model, f0, stage);
    srcX = gather.x + (dx - gather.x) / sc;
  } else {
    srcX = dx - translation * dir;
    f0 = (srcX - dockLine) * distSign / travel;
    const sc = bandScale(model, f0, stage);
    srcY = gather.y + (dy - gather.y) / sc;
  }

  const dist = (f0 - stage.pour) * travel;
  const alpha = dist < 0 ? 1 - clamp01(-dist / GENIE_FADE_PX) : 1;
  const inside = srcX >= rect.x && srcX <= rect.x + rect.w
    && srcY >= rect.y && srcY <= rect.y + rect.h;
  return { x: srcX, y: srcY, f0, scale: bandScale(model, f0, stage), alpha, inside };
}

/**
 * 计算某进度下所有条带的目标矩形。
 * @param {object} model buildGenieModel 的产物
 * @param {number} progress 原始进度 [0,1]，内部做两阶段缓动
 * @returns {Array<{sx:number,sy:number,sw:number,sh:number,dx:number,dy:number,dw:number,dh:number,alpha:number}>}
 *          sx..sh 为快照采样区（窗口原始位置），dx..dh 为本帧绘制区，alpha 为该条带透明度
 */
export function genieBands(model, progress) {
  const stage = genieParams(model, progress);
  const { rect, gather, travel, dir, dockLine, distSign } = model;
  const n = model.bands;
  const alongSpan = model.axis === "v" ? rect.h : rect.w;
  const thick = alongSpan / n;
  const out = [];

  for (let i = 0; i < n; i++) {
    const along0 = (model.axis === "v" ? rect.y : rect.x) + i * thick;
    const dist0 = distSign > 0 ? along0 - dockLine : dockLine - along0;
    const f0 = dist0 / travel;
    const sc = bandScale(model, f0, stage);
    const dist = (f0 - stage.pour) * travel;
    const alpha = dist < 0 ? 1 - clamp01(-dist / GENIE_FADE_PX) : 1;
    const moved = stage.translation;

    const band = {
      sx: 0, sy: 0,
      sw: rect.w, sh: rect.h,
      dx: rect.x, dy: rect.y,
      dw: rect.w, dh: rect.h,
      alpha,
    };
    if (model.axis === "v") {
      band.sy = i * thick; band.sh = thick + 0.5;
      band.dx = gather.x + (rect.x - gather.x) * sc;
      band.dy = along0 + moved * dir;
      band.dw = rect.w * sc;
      band.dh = thick + 0.5;
    } else {
      band.sx = i * thick; band.sw = thick + 0.5;
      band.dy = gather.y + (rect.y - gather.y) * sc;
      band.dx = along0 + moved * dir;
      band.dh = rect.h * sc;
      band.dw = thick + 0.5;
    }
    out.push(band);
  }
  return out;
}
