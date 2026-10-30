/**
 * wm/frame.js — 窗口几何原语（纯计算，不持状态）
 *
 * 为什么单独一层：窗口机制里最容易写错、也最值得单测的就是「算一个矩形」。
 * 拖动边界、八向缩放的锚点、平铺分区、边缘吸附判定全在这里一次算清，
 * window-manager.js 只负责「什么时候该调用它」。旧实现把这些散在 mousemove
 * 回调里，于是只有右下角一个手柄能缩放、左/上边缩放时锚点算反、
 * 边界钳制与 Dock 在左右侧时的可用区互相矛盾。
 *
 * 坐标系约定：全部为视口像素（与 getBoundingClientRect 一致）。
 * 框架 frame = {x, y, w, h}；写回 DOM 时一律内联 px，不用 transform ——
 * 祖先带 transform 会让 .window 内的 backdrop-filter 换 backdrop-root，
 * 亚克力当场失效（window.css / dock.css 的固化禁忌）。
 */

/** 边缘缩放感应带宽度（px）。macOS 的边框命中区约 4px，这里留出触屏余量。 */
export const EDGE_BAND = 6;
/** 四角感应带边长（px）。角比边更好抓，macOS 同样给更大容差。 */
export const CORNER_BAND = 16;
/** 拖动时触发平铺吸附的「推到边缘」距离（px）。 */
export const SNAP_TRIGGER = 14;
/** 拖动后窗口至少留在屏幕内的可见宽度（px），保证还能被点回来。 */
export const KEEP_VISIBLE = 120;

/**
 * 状态切换动画时长（ms）：.wm-animating 摘类的唯一权威值。
 * 样式表那边是 `.window.wm-animating { transition: left/top/width/height 0.3s }`
 * （windowframe.css）—— 这里比它多 20ms，是刻意留的收尾余量：摘类必须发生在
 * 过渡**完成之后**，早摘会把正在跑的过渡掐断在中间值上。
 * 全仓只此一份，window-manager.js 不再另存一个对不上号的副本。
 */
export const WM_ANIM_MS = 320;

/**
 * 程序坞此刻是否还该占用布局带。
 *
 * 自动隐藏收起态下 .dock 只改 opacity / visibility（dock.js 的亚克力禁忌：
 * 不许用 transform 滑动），布局盒还留在那儿，于是 visibleFrame 一直扣着一条
 * 约 --dock-size + 10px 宽的带：缩放态填不满、clampDrag 不许窗口进去，
 * 而那条带里的程序坞平时根本看不见 —— 用户感观就是「窗口拉不到底 /  maximizing
 * 之后屏幕底下留一条死带」，与 macOS「自动隐藏时窗口可占满」相反。
 *
 * 全屏态**必须**继续算「占位」：window-manager 的探边显隐是拿
 * vf.bottom / left / right > 0 当「这儿有个 Dock 值得探出来」的判据的，
 * 这里归零会让全屏时程序坞再也探不出来。
 * @returns {boolean}
 */
function dockReservesSpace() {
  const root = document.documentElement;
  if (root.classList.contains("deskly-fullscreen")) return true;
  const dockEl = document.getElementById("dock");
  if (!dockEl) return true;
  return !(dockEl.classList.contains("hidden") && !dockEl.classList.contains("show"));
}

/**
 * 可视桌面区：扣掉顶部菜单栏与程序坞（程序坞可能在左/右/下三侧）。
 * @returns {{top:number,left:number,right:number,bottom:number,width:number,height:number}}
 *          right/bottom 是「让出的宽度」，不是坐标；右边界 = left + width。
 */
export function visibleFrame() {
  const bar = document.getElementById("finderbar");
  const top = bar ? bar.offsetHeight : 0;
  const container = document.getElementsByClassName("dockcontainer")[0];
  let left = 0;
  let right = 0;
  let bottom = 0;
  if (container && dockReservesSpace()) {
    const inset = container.offsetWidth;
    if (container.classList.contains("pos-left")) left = inset;
    else if (container.classList.contains("pos-right")) right = inset;
    else bottom = container.offsetHeight;
  }
  return {
    top,
    left,
    right,
    bottom,
    width: Math.max(0, window.innerWidth - left - right),
    height: Math.max(0, window.innerHeight - top - bottom),
  };
}

/**
 * 读取窗口当前框架。以渲染结果为准（内联值可能缺省，尺寸也可能来自 CSS 百分比）。
 * @param {HTMLElement} el 窗口根元素
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function frameOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/**
 * 写回框架。animate=true 时挂 .wm-animating（样式表定义过渡），
 * 不写内联 transition —— 那会覆盖插件自己声明的过渡。
 * @param {HTMLElement} el 窗口根元素
 * @param {{x:number,y:number,w:number,h:number}} f 目标框架
 * @param {{animate?: boolean}} [opts]
 */
export function applyFrame(el, f, opts = {}) {
  const { animate = false } = opts;
  if (animate) {
    el.classList.add("wm-animating");
    clearTimeout(el._wmAnimTimer);
    el._wmAnimTimer = setTimeout(() => {
      el.classList.remove("wm-animating");
      el._wmAnimTimer = null;
    }, WM_ANIM_MS);
  }
  el.style.left = `${Math.round(f.x)}px`;
  el.style.top = `${Math.round(f.y)}px`;
  el.style.width = `${Math.round(f.w)}px`;
  el.style.height = `${Math.round(f.h)}px`;
}

/**
 * 解析 CSS 长度值：px 直取，% 相对参考尺寸换算，其余（auto/none）按 0 或 Infinity。
 * @param {string} raw getComputedStyle 取到的值
 * @param {number} base 百分比的参照（宽或高）
 * @param {number} fallback 无法解析时的返回值
 * @returns {number}
 */
function len(raw, base, fallback) {
  const s = String(raw || "").trim();
  if (!s || s === "auto" || s === "none") return fallback;
  if (s.endsWith("%")) {
    const pct = parseFloat(s);
    return Number.isFinite(pct) ? (pct / 100) * base : fallback;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 取窗口的尺寸约束：插件样式表里的 min/max-width|height 就是缩放的硬边界。
 * 旧实现把最小尺寸写死成 200×150，于是访达（min-width:800）被拉小后
 * 内联宽度与计算宽度分叉，看起来「缩放手柄失灵」。
 * @param {HTMLElement} el 窗口根元素
 * @returns {{minW:number,minH:number,maxW:number,maxH:number}}
 */
export function limitsOf(el) {
  const cs = window.getComputedStyle(el);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    minW: len(cs.minWidth, vw, 0),
    minH: len(cs.minHeight, vh, 0),
    maxW: len(cs.maxWidth, vw, Infinity),
    maxH: len(cs.maxHeight, vh, Infinity),
  };
}

/**
 * 把框架夹进合法范围：不小于 min、不大于 max，且不越过可视区顶边
 * （标题栏钻到菜单栏底下就再也拖不出来）。
 *
 * 尺寸被抬到 min 时刻意不动左上角：谁来锚定由调用方决定（拖动锚左上、
 * 平铺按分区锚某条边）。此前这里按「中心不变」平移了一下，于是
 * 平铺左半屏（720）遇到 min-width 800 的窗口时，窗口会往左溢出 40px、
 * 顶边也跟着上跳，看起来像「平铺把窗口甩飞了」。
 * @param {{x:number,y:number,w:number,h:number}} f 候选框架
 * @param {{minW:number,minH:number,maxW:number,maxH:number}} limits 尺寸约束
 * @param {{allowOverflow?: boolean}} [opts] allowOverflow=true 时只夹尺寸，不夹位置
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function clampFrame(f, limits, opts = {}) {
  const { allowOverflow = false } = opts;
  const vf = visibleFrame();
  const w = Math.min(Math.max(f.w, limits.minW), limits.maxW);
  const h = Math.min(Math.max(f.h, limits.minH), limits.maxH);
  let x = f.x;
  let y = f.y;
  if (!allowOverflow) {
    y = Math.max(vf.top, y);
    x = Math.min(Math.max(x, -w + KEEP_VISIBLE), window.innerWidth - KEEP_VISIBLE);
    y = Math.min(y, window.innerHeight - Math.min(h, 24));
  }
  return { x, y, w, h };
}

/**
 * 拖动后的位置钳制：标题栏不得越过菜单栏，窗口不得整扇拖出屏幕。
 * @param {number} x 期望左上角
 * @param {number} y 期望左上角
 * @param {{w:number,h:number}} size 窗口尺寸
 * @returns {{x:number,y:number}}
 */
export function clampDrag(x, y, size) {
  const vf = visibleFrame();
  const minX = KEEP_VISIBLE - size.w;
  const maxX = window.innerWidth - KEEP_VISIBLE;
  const minY = vf.top;
  const maxY = window.innerHeight - 24;
  return {
    x: Math.max(minX, Math.min(x, maxX)),
    y: Math.max(minY, Math.min(y, maxY)),
  };
}

const EDGES = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];

/**
 * 指针落在窗口的哪条缩放边/角上（视口坐标）。
 * @param {{x:number,y:number,w:number,h:number}} f 窗口框架
 * @param {number} cx 指针视口横坐标
 * @param {number} cy 指针视口纵坐标
 * @returns {string|null} EDGES 之一，命中不了返回 null
 */
export function edgeAt(f, cx, cy) {
  const dl = cx - f.x;
  const dt = cy - f.y;
  const dr = f.x + f.w - cx;
  const db = f.y + f.h - cy;
  const inL = dl >= -1 && dl <= EDGE_BAND;
  const inR = dr >= -1 && dr <= EDGE_BAND;
  const inT = dt >= -1 && dt <= EDGE_BAND;
  const inB = db >= -1 && db <= EDGE_BAND;
  // 只在对角线带内才算角：靠边优先，避免整条 6×6 角落都被判成斜向缩放
  if (inT && inL && Math.abs(dl - dt) <= CORNER_BAND) return "nw";
  if (inT && inR && Math.abs(dr - dt) <= CORNER_BAND) return "ne";
  if (inB && inL && Math.abs(dl - db) <= CORNER_BAND) return "sw";
  if (inB && inR && Math.abs(dr - db) <= CORNER_BAND) return "se";
  if (inT) return "n";
  if (inB) return "s";
  if (inL) return "w";
  if (inR) return "e";
  return null;
}

/**
 * 按缩放边与指针位移算出新框架：对侧边为锚点（macOS 行为）。
 * ⌥（keepAspect）时锁住宽高比：单边缩放改另一个维度，角缩放同步改两边。
 * @param {{x:number,y:number,w:number,h:number}} base 起始框架
 * @param {string} edge edgeAt 的结果
 * @param {{x:number,y:number}} to 指针当前位置
 * @param {{minW:number,minH:number,maxW:number,maxH:number}} limits 尺寸约束
 * @param {{keepAspect?: boolean}} [opts]
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function resizeFrame(base, edge, to, limits, opts = {}) {
  const { keepAspect = false } = opts;
  const vf = visibleFrame();
  let left = base.x;
  let top = base.y;
  let right = base.x + base.w;
  let bottom = base.y + base.h;

  if (edge.includes("w")) left = Math.min(to.x, right - limits.minW);
  if (edge.includes("e")) right = Math.max(to.x, left + limits.minW);
  if (edge.includes("n")) top = Math.min(to.y, bottom - limits.minH);
  if (edge.includes("s")) bottom = Math.max(to.y, top + limits.minH);

  // 顶边不许钻进菜单栏底下；左右下边可以越出屏幕（macOS 允许），
  // 但底边至少留 24px 在屏内，否则窗口内容彻底摸不到。
  if (edge.includes("n")) top = Math.max(vf.top, Math.min(top, bottom - limits.minH));

  let w = right - left;
  let h = bottom - top;

  if (keepAspect && base.h > 0) {
    const ratio = base.w / base.h;
    const single = edge.length === 1;
    if (single) {
      // 单边缩放时另一维度按比例跟着变，锚定对侧
      if (edge === "e" || edge === "w") h = w / ratio;
      else w = h * ratio;
    } else {
      // 角缩放：取变化更大的那个维度为准
      const byW = Math.abs(w - base.w) / Math.max(1, base.w);
      const byH = Math.abs(h - base.h) / Math.max(1, base.h);
      if (byW >= byH) h = w / ratio;
      else w = h * ratio;
    }
    // 角缩放后重新贴回锚点角：nw 锚右下、se 锚左上……
    if (edge === "nw") { left = right - w; top = bottom - h; }
    else if (edge === "ne") { top = bottom - h; }
    else if (edge === "sw") { left = right - w; }
  }

  w = Math.min(Math.max(w, limits.minW), limits.maxW);
  h = Math.min(Math.max(h, limits.minH), limits.maxH);
  if (edge.includes("w")) left = right - w;
  if (edge.includes("n")) top = bottom - h;
  if (edge === "nw") { left = right - w; top = bottom - h; }
  return { x: left, y: top, w, h };
}

/**
 * 平铺分区表：全部相对可视桌面区（扣菜单栏与 Dock）计算。
 * 用 floor 分配余数，避免奇数尺寸时右/下半各多 1px 压到 Dock。
 * @param {string} region 分区键
 * @param {{x:number,y:number,w:number,h:number}} [user] 自定义区（center 用它按 60%×70% 收）
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
export function tileFrame(region, user) {
  const r = visibleFrame();
  const halfW = Math.floor(r.width / 2);
  const halfH = Math.floor(r.height / 2);
  const restW = r.width - halfW;
  const restH = r.height - halfH;
  const TILES = {
    left: [r.left, r.top, halfW, r.height],
    right: [r.left + halfW, r.top, restW, r.height],
    top: [r.left, r.top, r.width, halfH],
    bottom: [r.left, r.top + halfH, r.width, restH],
    leftTop: [r.left, r.top, halfW, halfH],
    rightTop: [r.left + halfW, r.top, restW, halfH],
    leftBottom: [r.left, r.top + halfH, halfW, restH],
    rightBottom: [r.left + halfW, r.top + halfH, restW, restH],
    center: [
      Math.round(r.left + r.width * 0.2),
      Math.round(r.top + r.height * 0.15),
      Math.round(r.width * 0.6),
      Math.round(r.height * 0.7),
    ],
  };
  const t = TILES[region];
  if (!t) return null;
  const [x, y, w, h] = t;
  const f = { x, y, w, h };
  if (!user || !user.el) return f;
  // 分区可能比窗口声明的 min-width/min-height 更小（1440 屏的左半屏 720 < 访达的 800）。
  // 夹完尺寸必须按分区自己的锚边贴回去：左半贴左、右半贴右、上半贴顶、下半贴底。
  // 不锚的话窗口会朝两侧同时溢出，看起来像「一平铺就被甩飞了」。
  const clamped = clampFrame(f, limitsOf(user.el), { allowOverflow: true });
  const isLeft = region === "left" || region === "leftTop" || region === "leftBottom";
  const isRight = region === "right" || region === "rightTop" || region === "rightBottom";
  const isTop = region === "top" || region === "leftTop" || region === "rightTop";
  const isBottom = region === "bottom" || region === "leftBottom" || region === "rightBottom";
  if (isLeft) clamped.x = r.left;
  else if (isRight) clamped.x = r.left + r.width - clamped.w;
  else if (region === "center") clamped.x = Math.round(r.left + (r.width - clamped.w) / 2);
  if (isTop || region === "left" || region === "right") clamped.y = r.top;
  else if (isBottom) clamped.y = r.top + r.height - clamped.h;
  else if (region === "center") clamped.y = Math.round(r.top + (r.height - clamped.h) / 2);
  return clamped;
}

/** 全部可用分区键（顶栏菜单与绿键排列菜单共用一份，避免两处写歪）。 */
export const TILE_REGIONS = Object.freeze(["left", "right", "top", "bottom", "leftTop", "rightTop", "leftBottom", "rightBottom", "center"]);

/**
 * 缩放态框架：填充整个可视桌面区（macOS 的「缩放」，不是全屏）。
 * @param {HTMLElement} el 窗口根元素
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function zoomFrame(el) {
  const r = visibleFrame();
  const limits = limitsOf(el);
  return clampFrame({ x: r.left, y: r.top, w: r.width, h: r.height }, limits, { allowOverflow: true });
}

/**
 * 全屏框架：覆盖整块视口（含菜单栏位置，菜单栏由样式临时收起）。
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function displayFrame() {
  return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
}

/**
 * 拖动时按指针位置判定吸附分区（macOS「推到边缘即平铺」）。
 * 以指针为准而非窗口框：用户靠的是「顶到边」这个动作。
 * @param {number} cx 指针视口横坐标
 * @param {number} cy 指针视口纵坐标
 * @returns {{region: string, frame: {x:number,y:number,w:number,h:number}}|null}
 */
export function snapZoneAt(cx, cy) {
  const r = visibleFrame();
  const nearLeft = cx <= r.left + SNAP_TRIGGER;
  const nearRight = cx >= r.left + r.width - SNAP_TRIGGER;
  const nearTop = cy <= r.top + SNAP_TRIGGER;
  const nearBottom = cy >= r.top + r.height - SNAP_TRIGGER;
  let region = null;
  if (nearLeft && nearTop) region = "leftTop";
  else if (nearRight && nearTop) region = "rightTop";
  else if (nearLeft && nearBottom) region = "leftBottom";
  else if (nearRight && nearBottom) region = "rightBottom";
  else if (nearLeft) region = "left";
  else if (nearRight) region = "right";
  else if (nearTop) region = "zoom";
  if (!region) return null;
  const frame = region === "zoom" ? (() => ({ x: r.left, y: r.top, w: r.width, h: r.height }))() : tileFrame(region);
  return frame ? { region, frame } : null;
}

export { EDGES as RESIZE_EDGES };
