/**
 * window-manager.js — Deskly 窗口管理门面（编排 + 对外导出聚合）
 *
 * 窗口机制的实现已按职责拆进 wm/ 子模块（本文件只做状态操作、声明解析与对外导出）：
 *   wm/stack.js        焦点栈、层级分带 commitStack（NW-4）、stateOf、focus/blur 事件
 *   wm/relations.js    母窗 / 子窗 / sheet / 模态（NW-1）
 *   wm/interactions.js 拖动 / 八向缩放 / 边带 / 吸附预览（NW-2 / NW-3 / NW-6）
 *   wm/lifecycle.js    manage / release / close / 最小化还原 / 打开入场（NW-9）
 *   wm/events.js       window:* 事件总线（NW-8）
 *   wm/frame.js        几何原语（原有）
 * src/javascripts/window.js 退化为「旧式 App 装载 + 兼容门面」，不再自带第二套窗口逻辑。
 *
 * 与 macOS 的对齐点（都是有意为之，改动前先读这段）：
 * 1. 拖动只认标题栏（[data-titlebar]，没有标题栏元素的窗口退回顶部灯区带）。
 * 2. 缩放命中八向边/角（macOS 的边框命中区），对侧边为锚点；⌥ 或 aspectRatio 声明锁宽高比。
 * 3. 绿键 = 全屏（macOS 15 口径），⌥点击 = 缩放（填充可视区），
 *    悬停 ~0.9s 弹「窗口排列」菜单（本项目有意偏差，防误触），右键保留同一张菜单。
 * 4. 拖动推到屏幕边缘即平铺（左/右半、四角 ¼、顶部=缩放），带预览框。
 * 5. 缩放态/平铺态下开始拖动或缩放即脱离该状态，回到用户框架。
 * 6. 焦点是显式的：.is-active + 红绿灯灰化由焦点栈驱动。
 *
 * 硬约束：
 * - 动画一律走 left/top/width/height，绝不给 .window 加 transform / filter /
 *   clip-path —— 那会让带 backdrop-filter 的侧栏与内容区换 backdrop-root，
 *   亚克力当场退化成一块死白（window.css、dock.css、ui.css 三处固化禁忌）。
 * - MV3 CSP：不写内联事件、不用 innerHTML 拼可信度未知的内容。
 * - 内核模块的 import 说明符不带 ?v=（带查询串会被当作第二个模块重复求值）。
 */

import { i18n } from "./i18n.js";
import { isActivated } from "./api-grants.js";
import { createContextMenu } from "./ui/contextMenu.js";
import {
  getTrafficLights, mountTrafficLights, setTrafficLightsEnabled, ACTION_EVENT,
} from "./ui/trafficLights.js";
import {
  visibleFrame, frameOf, applyFrame, clampDrag,
  tileFrame, zoomFrame, displayFrame,
} from "./wm/frame.js";
import {
  records, stack, commitStack, isWindowElement, isMinimized, resolveWindow,
  focusWindow, getTopWindow, getVisibleWindows, updateActiveAppMenu, syncState, detachStates, stateOf,
  setLevel as stackSetLevel, bindLifecycleHooks,
} from "./wm/stack.js";
import { ensureEdgeBands, bindWindowOps } from "./wm/interactions.js";
import {
  manage, release, close, setMinimized, restore,
  prepareOpen, cancelOpenAnimation, revealOpen,
  bindOps,
} from "./wm/lifecycle.js";
import { setWindowDetailProvider, emitWindowEvent } from "./wm/events.js";
import { enterSplit, exitSplit, inSplit, splitState, cycleSpaces, relayoutSplit } from "./wm/spaces.js";
import * as overview from "./wm/overview.js";
import { ZOOM_HOVER_EVENT } from "./ui/trafficLights.js";

// ── 门面再导出：导出名与旧窗口管理器逐一对齐，旧调用零破坏 ──
export { visibleFrame } from "./wm/frame.js";
// 平铺分区表也一起透出：顶栏菜单与绿键排列菜单共用同一份键名，不在两处各写一遍。
export { TILE_REGIONS } from "./wm/frame.js";
export {
  WINDOW_Z_MIN, WINDOW_Z_MAX, zCounter,
  getWindows, isWindowElement, getVisibleWindows, getTopWindow, isMinimized, resolveWindow,
  setFocusedWindow, focusWindow, bringToFront, bringAllWindowsToFront, updateActiveAppMenu,
  stateOf, syncState, detachStates,
} from "./wm/stack.js";
export {
  manage, release, close, setMinimized, restore, toggleMinimize,
  prepareOpen, cancelOpenAnimation, revealOpen,
} from "./wm/lifecycle.js";
export { attach, detach, parentOf, childrenOf } from "./wm/relations.js";
export { WINDOW_EVENTS, emitWindowEvent } from "./wm/events.js";
export { applyDragConstraints, inDragZone } from "./wm/interactions.js";
export { enterSplit, exitSplit, inSplit, splitState } from "./wm/spaces.js";
export { isOverviewOpen, toggle as toggleOverview } from "./wm/overview.js";

/** 层叠居中时每个后续同尺寸窗口错开的位移（macOS 的 cascade 节奏）。 */
const CASCADE_STEP = 24;

/**
 * 绿键悬停多久弹出窗口排列菜单。
 * macOS 自己约 0.5s，这里取 900ms：本项目的红绿灯离正文与拖动区都比分家系统近，
 * 用户只是把指针扫过标题栏去抓边框，也会顺手把菜单弹出来（实测很烦）。
 * 悬停菜单是「锦上添花」，右键那一份不受这个时长影响。
 */
const HOVER_MENU_DELAY = 900;

// ── 应用侧声明：data-window="size:900x640 min:620x440 resizable centered" ──

/**
 * data-window 声明键的统一规范化（WAPI-07）。
 * 旧解析器把键小写化后与 camelCase 白名单比对，`minWidth:600` 落入「未识别字段」
 * 被静默忽略。现在三处写法都接受：camelCase（minWidth）、kebab（min-width）、
 * 全小写（minwidth）——先去掉连字符再小写化查这张表，落回规范的 camelCase 键。
 */
const DECL_KEYS = {
  width: "width", height: "height",
  minwidth: "minWidth", minheight: "minHeight", maxwidth: "maxWidth", maxheight: "maxHeight",
  resizable: "resizable", minimizable: "minimizable", maximizable: "maximizable",
  centered: "centered", draggable: "draggable", fixed: "fixed", modal: "modal",
  multiwindow: "multiWindow",
  role: "role", parent: "parent", level: "level",
  dragaxis: "dragAxis", dragbounds: "dragBounds",
  resizeaxis: "resizeAxis", aspectratio: "aspectRatio",
  snap: "snap", titlebar: "titlebar", trafficlights: "trafficLights",
};
const DECL_NUMERIC = new Set(["width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight"]);
const DECL_FLAGS = new Set(["resizable", "minimizable", "maximizable", "centered", "draggable", "fixed", "modal", "multiWindow"]);
const DECL_STRINGS = new Set(["role", "parent", "level", "dragAxis", "resizeAxis", "snap", "titlebar", "trafficLights"]);

/**
 * 解析宽高比声明："16:9" → 16/9，"1.777" / 1.777 → 1.777。
 * @returns {number} 非法时返回 0
 */
function parseAspect(value) {
  if (typeof value === "number") return value > 0 ? value : 0;
  const s = String(value || "").trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    return a > 0 && b > 0 ? a / b : 0;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 解析窗口根元素上的 data-window 声明。
 *
 * 为什么开这条通道：尺寸与可缩放性是「这个应用长什么样」的一部分，归属应用自己，
 * 不该只能写在被内核读取的 manifest.json 里。三处都能声明，优先级：
 *   data-window（应用自己的界面）> manifest.window（内核装载时传入）> 应用 CSS 自然尺寸
 * min/max 直接落进内联样式，于是 frame.limitsOf 读到的就是声明值，缩放边界与
 * 应用样式表里的 min-width 用同一套机制，不需要第二份账。
 *
 * @param {HTMLElement} el 窗口根元素
 * @returns {object} 只包含声明到的字段（键名一律为规范 camelCase）
 */
export function readDeclaration(el) {
  const raw = el.getAttribute("data-window");
  if (!raw) return {};
  const conf = {};
  raw.split(/[;\s]+/).filter(Boolean).forEach((token) => {
    // 只按第一个冒号切：aspectRatio:16:9 这类值本身带冒号
    const colon = token.indexOf(":");
    const rawKey = colon < 0 ? token : token.slice(0, colon);
    const rawVal = colon < 0 ? undefined : token.slice(colon + 1);
    const keyNorm = String(rawKey || "").trim().toLowerCase().replace(/-/g, "");
    const val = rawVal === undefined ? true : String(rawVal).trim();
    if (!keyNorm) return;
    // size:900x640 / min:620x440 / max:1200x800 简写
    if (keyNorm === "size" || keyNorm === "min" || keyNorm === "max") {
      const m = String(val).toLowerCase().match(/^(\d+)\s*x\s*(\d+)$/);
      if (!m) {
        console.warn(`[wm] data-window ${keyNorm} 需要 WxH 形式，已忽略：${val}`);
        return;
      }
      if (keyNorm === "size") { conf.width = Number(m[1]); conf.height = Number(m[2]); }
      else if (keyNorm === "min") { conf.minWidth = Number(m[1]); conf.minHeight = Number(m[2]); }
      else { conf.maxWidth = Number(m[1]); conf.maxHeight = Number(m[2]); }
      return;
    }
    const key = DECL_KEYS[keyNorm];
    if (!key) {
      console.warn(`[wm] data-window 未识别的字段，已忽略：${token}`);
      return;
    }
    if (DECL_NUMERIC.has(key)) {
      const n = parseFloat(val);
      if (Number.isFinite(n)) conf[key] = n;
      else console.warn(`[wm] data-window ${key} 需要数字，已忽略：${val}`);
      return;
    }
    if (DECL_FLAGS.has(key)) {
      conf[key] = val === true || String(val).toLowerCase() === "true";
      return;
    }
    if (key === "aspectRatio") {
      const aspect = parseAspect(val);
      if (aspect > 0) conf.aspectRatio = String(val);
      else console.warn(`[wm] data-window aspectRatio 需要 W:H 或数值，已忽略：${val}`);
      return;
    }
    if (key === "dragBounds") {
      // "visible" 或 "x,y,w,h" 硬区域（数据属性里不能带空格，用逗号分隔）
      if (String(val).toLowerCase() === "visible") { conf.dragBounds = "visible"; return; }
      const nums = String(val).split(",").map((p) => parseFloat(p));
      if (nums.length === 4 && nums.every(Number.isFinite)) {
        conf.dragBounds = { x: nums[0], y: nums[1], w: nums[2], h: nums[3] };
      } else {
        console.warn(`[wm] data-window dragBounds 需要 visible 或 x,y,w,h，已忽略：${val}`);
      }
      return;
    }
    if (DECL_STRINGS.has(key)) {
      conf[key] = String(val);
      return;
    }
  });
  return conf;
}

/**
 * 落实窗口声明（尺寸 / 边界 / 能力开关 / 居中 / NW-1~NW-6 新键），并同步红绿灯禁用态。
 * 应用侧 data-window 覆盖内核侧 manifest.window：应用是尺寸的权威。
 * @param {HTMLElement} el 窗口根元素
 * @param {object} [kernelConf] manifest.window（或 app.window 合并结果）
 * @returns {object} 生效后的配置
 */
export function applyConfig(el, kernelConf = {}) {
  if (!isWindowElement(el)) return {};
  const declared = readDeclaration(el);
  const conf = { ...kernelConf, ...declared };

  if (Number.isFinite(conf.width)) el.style.width = `${conf.width}px`;
  if (Number.isFinite(conf.height)) el.style.height = `${conf.height}px`;
  // 边界写进内联样式：limitsOf() 只读计算样式，声明与应用 CSS 的 min/max 由此统一
  if (Number.isFinite(conf.minWidth)) el.style.minWidth = `${conf.minWidth}px`;
  if (Number.isFinite(conf.minHeight)) el.style.minHeight = `${conf.minHeight}px`;
  if (Number.isFinite(conf.maxWidth)) el.style.maxWidth = `${conf.maxWidth}px`;
  if (Number.isFinite(conf.maxHeight)) el.style.maxHeight = `${conf.maxHeight}px`;

  // NW-3：resizeAxis:"none" ≡ resizable:false，同时给时取更严者
  const resizable = conf.resizable !== false && conf.resizeAxis !== "none";
  setResizable(el, resizable);

  // NW-5：trafficLights 三态。"none" 属敏感能力（有困住用户的风险），
  // 未授权 window:chrome 的插件声明了也按 "all" 落地，而不是静默放行。
  let lightsMode = conf.trafficLights === "none" || conf.trafficLights === "close-only" ? conf.trafficLights : "all";
  if (lightsMode === "none") {
    const pid = el.dataset.pluginId;
    if (pid && !isActivated(pid, "window:chrome")) {
      console.warn(`[wm] ${pid} 未授权 window:chrome，trafficLights:"none" 已按 "all" 落地`);
      lightsMode = "all";
    }
  }
  el._wmLightsMode = lightsMode;
  setTrafficLightsEnabled(el, {
    close: lightsMode !== "none",
    minimize: conf.minimizable !== false && lightsMode === "all",
    zoom: conf.maximizable !== false && resizable && lightsMode === "all",
  });
  const host = getTrafficLights(el);
  if (host) host.toggleAttribute("hidden", lightsMode === "none");

  // NW-2：fixed = 不可拖 + 不吸附 + 视口重排不回拉 + configure 不居中
  const fixed = conf.fixed === true;
  el._wmFixed = fixed;
  el.dataset.wmDraggable = (conf.draggable === false || fixed) ? "false" : "true";
  // NW-6：吸附三态；fixed 隐含 "none"
  el._wmSnap = fixed ? "none" : (["tile", "edges", "none"].includes(conf.snap) ? conf.snap : "tile");

  // NW-3：常驻宽高比与缩放轴
  el._wmAspect = parseAspect(conf.aspectRatio);
  if (el._wmAspect && (Number.isFinite(conf.maxWidth) || Number.isFinite(conf.maxHeight))) {
    console.warn("[wm] aspectRatio 与 max 尺寸同声明：min/max 为硬边界，比例在边界内才成立");
  }
  ensureEdgeBands(el);

  // WAPI-01：居中标记统一落在元素上（旧实现写在 rec 上、读在 el 上，
  // 于是托管窗口每次 configure() 都被拽回中央）。fixed 窗不自动居中。
  if (conf.centered && !el._wmPlaced && !fixed) center(el);
  el._wmConfig = conf;
  return conf;
}

/**
 * 运行期改配置：插件用 Deskly.windows.configure(el, {width,height,resizable}) 复述尺寸。
 * @param {HTMLElement|string} target 窗口元素、窗口 id 或应用显示名
 * @param {object} conf 与 data-window 同一套字段
 * @returns {boolean} 是否命中窗口
 */
export function configure(target, conf = {}) {
  const el = resolveWindow(target);
  if (!el) return false;
  const merged = { ...(el._wmConfig || {}), ...conf };
  // 写回声明属性：下一次打开同一应用时（reload / 二次装载）声明仍在，不会退回旧尺寸
  el.setAttribute("data-window", serializeDecl(merged));
  const before = frameOf(el);
  applyConfig(el, el._wmKernelConf || {});
  // 已打开的窗口要立刻跟上：缩放态/全屏态下保留状态框，只把尺寸套进去
  const rec = records.get(el);
  if (rec && (rec.zoomed || rec.tiled)) {
    setZoom(el, true);
  } else if (rec && rec.fullscreen) {
    applyFrame(el, displayFrame(), { animate: true });
  } else if (conf.width !== undefined || conf.height !== undefined) {
    const after = frameOf(el);
    applyFrame(el, { x: before.x, y: before.y, w: after.w, h: after.h });
    if (rec) rec.normal = frameOf(el);
  }
  return true;
}

/**
 * 把配置对象写回 data-window 字面量（configure 的持久化形态）。
 * WAPI-08：逐字段写（单独 configure({width}) 也落盘，不再要求宽高成对），
 * 新增键与声明通道同名。
 */
function serializeDecl(conf) {
  const parts = [];
  ["width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight"].forEach((k) => {
    if (Number.isFinite(conf[k])) parts.push(`${k}:${Math.round(conf[k])}`);
  });
  ["resizable", "minimizable", "maximizable", "centered", "draggable", "fixed", "modal", "multiWindow"].forEach((k) => {
    if (typeof conf[k] === "boolean") parts.push(`${k}:${conf[k] ? "true" : "false"}`);
  });
  ["role", "parent", "level", "dragAxis", "resizeAxis", "snap", "titlebar", "trafficLights"].forEach((k) => {
    if (typeof conf[k] === "string" && conf[k]) parts.push(`${k}:${conf[k]}`);
  });
  if (conf.aspectRatio) parts.push(`aspectRatio:${conf.aspectRatio}`);
  if (conf.dragBounds && typeof conf.dragBounds === "object") {
    parts.push(`dragBounds:${conf.dragBounds.x},${conf.dragBounds.y},${conf.dragBounds.w},${conf.dragBounds.h}`);
  }
  return parts.join(" ");
}

// ── 能力位（WAPI-02）：熄灯只是表象，操作本身也要被拦 ──

function capsOf(el) {
  return el._wmConfig || {};
}

/** 绿键系操作（缩放 / 平铺）的能力判据：maximizable 或 resizable 关了就真不做。 */
function canZoomOrTile(el) {
  const conf = capsOf(el);
  return conf.maximizable !== false && conf.resizable !== false && conf.resizeAxis !== "none";
}

// ── 窗口操作（对外 API） ──

/**
 * 缩放（macOS ⌥点绿键的动作）：在「用户框架」与「填充可视区」之间切换。
 * @param {HTMLElement|string} target
 * @param {{animate?: boolean, on?: boolean}} [opts] on 显式指定目标态
 * @returns {boolean} 切换后的状态
 */
export function setZoom(target, opts = {}) {
  const el = resolveWindow(target);
  if (!el) return false;
  if (inSplit(el)) exitSplit(el);   // 分屏中缩放 = 先移回桌面（macOS：窗口离开分屏空间）
  const rec = manage(el);
  const animate = opts.animate !== false;
  const want = typeof opts.on === "boolean" ? opts.on : !rec.zoomed && !rec.tiled;
  if (rec.fullscreen) {
    // 全屏窗口上点绿键只退出全屏（macOS 全屏态根本没有可用的绿键）。
    exitFullscreen(el, { animate });
    return false;
  }
  if (want && !canZoomOrTile(el)) return false;   // WAPI-02：能力位真拦截
  if (!want) {
    if (!rec.zoomed && !rec.tiled) return false;
    const back = rec.normal || frameOf(el);
    rec.zoomed = false;
    rec.tiled = null;
    applyFrame(el, back, { animate });
    syncState(el, rec);
    emitWindowEvent("zoom", el);
    return false;
  }
  if (!rec.normal) rec.normal = frameOf(el);
  rec.zoomed = true;
  rec.tiled = null;
  applyFrame(el, zoomFrame(el), { animate });
  syncState(el, rec);
  focusWindow(el);
  emitWindowEvent("zoom", el);
  return true;
}

/** 兼容旧名：绿色按钮普通点击 / 双击标题栏 = 缩放切换。 */
export function toggleZoom(el, animate = true) {
  return setZoom(el, { animate });
}

/**
 * 全屏（覆盖整块视口，菜单栏与程序坞按 macOS 那样自动收起）。
 * @param {HTMLElement|string} target
 * @param {{animate?: boolean, on?: boolean}} [opts]
 * @returns {boolean} 切换后的状态
 */
export function setFullscreen(target, opts = {}) {
  const el = resolveWindow(target);
  if (!el) return false;
  const rec = manage(el);
  const want = typeof opts.on === "boolean" ? opts.on : !rec.fullscreen;
  if (want) {
    // WAPI-02：maximizable:false 的窗口连 ⌃⌘F 与菜单命令也进不了全屏
    if (capsOf(el).maximizable === false) return false;
    if (inSplit(el)) exitSplit(el);  // 分屏成员进全屏 = 离开分屏空间
    if (!rec.normal) rec.normal = frameOf(el);
    rec.fullscreen = true;
    rec.zoomed = false;
    rec.tiled = null;
    applyFrame(el, displayFrame(), { animate: opts.animate !== false });
    focusWindow(el);
  } else {
    exitFullscreen(el, opts);
  }
  syncState(el, rec);
  return rec.fullscreen;
}

function exitFullscreen(el, opts = {}) {
  const rec = records.get(el);
  if (!rec || !rec.fullscreen) return;
  rec.fullscreen = false;
  applyFrame(el, rec.normal || frameOf(el), { animate: opts.animate !== false });
  syncState(el, rec);
  emitWindowEvent("fullscreen", el);
}

/** 兼容旧名：⌃⌘F 与绿键单击 = 全屏切换。 */
export function toggleFullscreen(el, animate = true) {
  return setFullscreen(el, { animate });
}

/**
 * 平铺到指定分区。第一次平铺前记住用户框架，untile 才有得回。
 * @param {HTMLElement|string} target
 * @param {string} region left|right|top|bottom|leftTop|rightTop|leftBottom|rightBottom|center
 * @returns {boolean}
 */
export function tile(target, region) {
  const el = resolveWindow(target);
  if (!el) return false;
  if (!canZoomOrTile(el)) return false;   // WAPI-02：能力位真拦截
  if (inSplit(el)) exitSplit(el);         // 分屏成员平铺 = 先移回桌面
  const rec = manage(el);
  const f = tileFrame(region, { el });
  if (!f) return false;
  if (rec.fullscreen) exitFullscreen(el, { animate: false });
  // 只在「既不平铺也不缩放」时记用户框：保住最初那份普通框，
  // 连续平铺左→右再 untile 才能回到用户位置，而不是上一个半屏。
  if (!rec.tiled && !rec.zoomed) rec.normal = frameOf(el);
  rec.zoomed = false;
  rec.tiled = region;
  applyFrame(el, f, { animate: true });
  syncState(el, rec);
  focusWindow(el);
  emitWindowEvent("tile", el);
  return true;
}

/** 还原到平铺 / 缩放前的用户框架。 */
export function untile(target) {
  const el = resolveWindow(target);
  if (!el) return false;
  const rec = records.get(el);
  if (!rec || (!rec.tiled && !rec.zoomed) || !rec.normal) return false;
  rec.tiled = null;
  rec.zoomed = false;
  if (rec.fullscreen) exitFullscreen(el, { animate: false });
  applyFrame(el, rec.normal, { animate: true });
  syncState(el, rec);
  emitWindowEvent("tile", el);
  return true;
}

/**
 * 居中放置：限制在可视桌面区内，尺寸超出时贴边而不是推到负坐标。
 * 第二个及以后的同尺寸窗口按 macOS 的层叠（cascade）错开，而不是精确压在同一处。
 * WAPI-01：完成标记统一写 el._wmPlaced（applyConfig 读的是这里）。
 * @param {HTMLElement} el 窗口
 * @param {{animate?: boolean, cascade?: boolean}} [opts]
 */
export function center(el, opts = {}) {
  if (!el || !el.classList.contains("window")) return;
  const { animate = false } = opts;
  const set = () => {
    const r = visibleFrame();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = r.left + (r.width - w) / 2;
    let y = r.top + (r.height - h) / 2;
    if (opts.cascade !== false) {
      const step = CASCADE_STEP;
      while (stack.some((other) => other !== el && overlapsExactly(other, x, y, w, h, step))) {
        x += step;
        y += step;
      }
    }
    const clamped = clampDrag(x, y, { w, h });
    applyFrame(el, { x: clamped.x, y: clamped.y, w, h }, { animate });
    el._wmPlaced = true;
    const rec = records.get(el);
    if (rec) {
      rec.normal = frameOf(el);
      detachStates(rec, true);
    }
  };
  set();
  // 插件样式常是异步到位的：等布局稳定后再校一次，否则首帧算出来的宽高是 CSS 默认值
  requestAnimationFrame(() => requestAnimationFrame(set));
}

/** 同尺寸且左上角重合（在 step 容差内）时认为「叠在一起了」，需要错开。 */
function overlapsExactly(other, x, y, w, h, step) {
  const f = frameOf(other);
  return Math.abs(f.w - w) < 2 && Math.abs(f.h - h) < 2
    && Math.abs(f.x - x) < step && Math.abs(f.y - y) < step;
}

/** 缩放态下的旧名：填充可视区。 */
export function toggleStretch(el, animate = true) {
  return toggleZoom(el, animate);
}

/**
 * 设置可否缩放：关掉时窗口不响应八向边框，绿键也跟着禁用。
 * @param {HTMLElement} el
 * @param {boolean} resizable
 */
export function setResizable(el, resizable) {
  if (!el || !el.classList) return;
  el.classList.toggle("no-resize", !resizable);
  el.dataset.wmResizable = resizable ? "true" : "false";
}

/**
 * 逐维写回几何： undefined / 空串 表示「这个维度不动」，还原快照时靠它跳过缺项。
 * 兼容旧签名 setWindowPosition(win, left, top, width, height, zIndex)，值原样落内联样式。
 * WAPI-06：z 参数不入焦点栈、下一次 commitStack 即被覆盖，语义是虚假的 ——
 * 保留兼容但首次调用时 warn 一次，调用方应改用 focusWindow / setLevel。
 * @param {HTMLElement} el 窗口
 * @param {{x?:number|string,y?:number|string,w?:number|string,h?:number|string,z?:number|string}} g
 */
let zParamWarned = false;
export function setGeometry(el, g) {
  if (!el || !g) return;
  const put = (prop, val) => {
    if (val === undefined || val === "" || val === null) return;
    el.style[prop] = typeof val === "number" ? `${val}px` : String(val);
  };
  put("left", g.x);
  put("top", g.y);
  put("width", g.w);
  put("height", g.h);
  if (g.z !== undefined && g.z !== "" && g.z !== null) {
    if (!zParamWarned) {
      zParamWarned = true;
      console.warn("[wm] setGeometry 的 z 参数不改变焦点栈（会被 commitStack 覆盖），请改用 focusWindow / setLevel");
    }
    el.style.zIndex = String(g.z);
  }
  const rec = records.get(el);
  if (rec && !rec.mode) rec.normal = frameOf(el);
}

/**
 * 记录窗口当前几何（供会话快照一类的调用方存盘）。
 * WAPI-11：全仓零调用的死接口，下线前先发一次 deprecate warn 观察一个版本。
 */
let snapshotWarned = false;
export function snapshotGeometry(el) {
  if (!snapshotWarned) {
    snapshotWarned = true;
    console.warn("[wm] snapshotGeometry 已废弃，将在下一版本移除（请改用 stateOf(el).frame）");
  }
  const cs = window.getComputedStyle(el);
  const pick = (prop) => el.style[prop] || cs[prop];
  return {
    left: pick("left"),
    top: pick("top"),
    width: pick("width"),
    height: pick("height"),
    zIndex: pick("zIndex"),
  };
}

// ── NW-4 / NW-5 / NW-9 的内核侧入口（Deskly.windows 经 os-api 再包权限） ──

/** 设置层级（normal / floating / panel；modal 仅模态子窗自动获得）。 */
export function setLevel(el, level) {
  const target = resolveWindow(el);
  return target ? stackSetLevel(target, level) : false;
}

/** NW-5：红绿灯动作自定义回调。回调返回 false 即拦截默认动作。 */
export function setWindowActions(el, handlers = {}) {
  const rec = records.get(el);
  if (!rec) return false;
  rec.actions = { ...(rec.actions || {}), ...handlers };
  return true;
}

/** NW-9：可取消关闭的 handler 登记（null 即摘除）。 */
export function setWindowOnClose(el, handler) {
  const rec = records.get(el);
  if (!rec) return false;
  rec.onClose = typeof handler === "function" ? handler : null;
  return true;
}

/**
 * NW-7 多窗口的实例 id 分配：首个窗口用基名（Dock 对账与收藏都以它为准），
 * 基名被占时才追加 #2、#3… 实例后缀。
 * @param {string} base 应用窗口基名（manifest.windowName || 显示名）
 * @returns {string}
 */
export function nextWindowId(base) {
  // 判占用的同时核对回读 id：测试替身/异常元素不算占用（浏览器里 getElementById
  // 命中即同 id，此检查与浏览器语义等价，只多一层防御）。
  const taken = (id) => {
    const hit = document.getElementById(id);
    return !!hit && hit.id === id;
  };
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}#${n}`)) n += 1;
  return `${base}#${n}`;
}

// ── 绿键「窗口排列」菜单与红绿灯接管 ──

/**
 * 菜单平铺示意图标（受控 SVG 常量，TL-04；currentColor 跟随菜单文字色）。
 * 一律 16px viewBox，左列 16px 图标列由 contextMenu 的 .menu-icon 承担。
 */
const MENU_ICON = {
  fill: '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor"/><rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" opacity=".5"/></svg>',
  center: '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" opacity=".45"/><rect x="5" y="4" width="6" height="8" rx="1" fill="currentColor"/></svg>',
  left: '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" opacity=".45"/><rect x="2.5" y="2.5" width="5.5" height="11" rx="1" fill="currentColor"/></svg>',
  right: '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" opacity=".45"/><rect x="8" y="2.5" width="5.5" height="11" rx="1" fill="currentColor"/></svg>',
  top: '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" opacity=".45"/><rect x="2.5" y="2.5" width="11" height="5" rx="1" fill="currentColor"/></svg>',
  bottom: '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" opacity=".45"/><rect x="2.5" y="8.5" width="11" height="5" rx="1" fill="currentColor"/></svg>',
  leftTop: '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" opacity=".45"/><rect x="2.5" y="2.5" width="5.5" height="5" rx="1" fill="currentColor"/></svg>',
  rightTop: '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" opacity=".45"/><rect x="8" y="2.5" width="5.5" height="5" rx="1" fill="currentColor"/></svg>',
  leftBottom: '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" opacity=".45"/><rect x="2.5" y="8.5" width="5.5" height="5" rx="1" fill="currentColor"/></svg>',
  rightBottom: '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" opacity=".45"/><rect x="8" y="8.5" width="5.5" height="5" rx="1" fill="currentColor"/></svg>',
  fullscreen: '<svg viewBox="0 0 16 16"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" fill="none" stroke="currentColor" stroke-linecap="round"/></svg>',
  splitLeft: '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor"/><rect x="2.5" y="2.5" width="5" height="11" rx="1" fill="currentColor" opacity=".6"/></svg>',
  splitRight: '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor"/><rect x="8.5" y="2.5" width="5" height="11" rx="1" fill="currentColor" opacity=".6"/></svg>',
  arrangeLR: '<svg viewBox="0 0 16 16"><rect x="1" y="3" width="6.5" height="10" rx="1" fill="currentColor" opacity=".85"/><rect x="8.5" y="3" width="6.5" height="10" rx="1" fill="currentColor" opacity=".45"/></svg>',
  arrangeRL: '<svg viewBox="0 0 16 16"><rect x="1" y="3" width="6.5" height="10" rx="1" fill="currentColor" opacity=".45"/><rect x="8.5" y="3" width="6.5" height="10" rx="1" fill="currentColor" opacity=".85"/></svg>',
  quads: '<svg viewBox="0 0 16 16"><rect x="1" y="2" width="6.5" height="5.5" rx="1" fill="currentColor" opacity=".85"/><rect x="8.5" y="2" width="6.5" height="5.5" rx="1" fill="currentColor" opacity=".45"/><rect x="1" y="8.5" width="6.5" height="5.5" rx="1" fill="currentColor" opacity=".45"/><rect x="8.5" y="8.5" width="6.5" height="5.5" rx="1" fill="currentColor" opacity=".85"/></svg>',
};

/** NW-5：onAction 自定义回调；返回 false 即拦截默认动作。抛错视为不拦。 */
function runAction(rec, name, detail) {
  const fn = rec.actions && rec.actions[name];
  if (typeof fn !== "function") return undefined;
  try { return fn(detail); } catch (err) {
    console.warn(`[wm] onAction.${name} 抛错，按不拦截处理:`, err);
    return undefined;
  }
}

/**
 * 绿键的「窗口排列」菜单（macOS 15 三段式：移动与调整大小 / 填充与排列 / 全屏幕）。
 * 全屏幕是二级菜单（整个屏幕 / 屏幕左侧 / 屏幕右侧）；⌥ 按住时出多窗口排列项（TL-09）。
 * 分屏中的窗口只给「将窗口移到桌面」（macOS 分屏态绿键菜单语义，FS-04）。
 */
function windowMenuItems(rec) {
  const el = rec.el;
  const st = stateOf(el);
  if (st.fullscreen === false && inSplit(el)) {
    return [
      { type: "header", label: i18n.t("window.fsGroup", "全屏幕") },
      {
        label: i18n.t("window.splitToDesktop", "将窗口移到桌面"),
        icon: MENU_ICON.center,
        action: () => exitSplit(el),
      },
    ];
  }
  const splitOn = !!splitState();
  const fullscreenSub = [
    {
      label: st.fullscreen ? i18n.t("window.exitFullscreen", "退出全屏") : i18n.t("window.fsEntire", "整个屏幕"),
      icon: MENU_ICON.fullscreen,
      action: () => setFullscreen(el),
    },
    {
      label: i18n.t("window.fsLeft", "屏幕左侧"),
      icon: MENU_ICON.splitLeft,
      disabled: splitOn,
      action: () => enterSplit(el, "left"),
    },
    {
      label: i18n.t("window.fsRight", "屏幕右侧"),
      icon: MENU_ICON.splitRight,
      disabled: splitOn,
      action: () => enterSplit(el, "right"),
    },
  ];
  return [
    { type: "header", label: i18n.t("window.moveResize", "移动与调整大小") },
    { label: st.zoomed ? i18n.t("window.unzoom", "还原大小") : i18n.t("window.fill", "填充"), icon: MENU_ICON.fill, action: () => setZoom(el) },
    { label: i18n.t("window.center", "居中"), icon: MENU_ICON.center, action: () => center(el) },
    { type: "separator" },
    { label: i18n.t("window.tileLeft", "平铺到左侧"), icon: MENU_ICON.left, action: () => tile(el, "left") },
    { label: i18n.t("window.tileRight", "平铺到右侧"), icon: MENU_ICON.right, action: () => tile(el, "right") },
    { label: i18n.t("window.tileTop", "平铺到上方"), icon: MENU_ICON.top, action: () => tile(el, "top") },
    { label: i18n.t("window.tileBottom", "平铺到下方"), icon: MENU_ICON.bottom, action: () => tile(el, "bottom") },
    { label: i18n.t("window.tileLeftTop", "左上角"), icon: MENU_ICON.leftTop, action: () => tile(el, "leftTop") },
    { label: i18n.t("window.tileRightTop", "右上角"), icon: MENU_ICON.rightTop, action: () => tile(el, "rightTop") },
    { label: i18n.t("window.tileLeftBottom", "左下角"), icon: MENU_ICON.leftBottom, action: () => tile(el, "leftBottom") },
    { label: i18n.t("window.tileRightBottom", "右下角"), icon: MENU_ICON.rightBottom, action: () => tile(el, "rightBottom") },
    { type: "header", label: i18n.t("window.fillArrange", "填充与排列"), altOnly: true },
    { label: i18n.t("window.arrangeLR", "左侧与右侧"), icon: MENU_ICON.arrangeLR, altOnly: true, action: () => arrangePair(el, "left") },
    { label: i18n.t("window.arrangeRL", "右侧与左侧"), icon: MENU_ICON.arrangeRL, altOnly: true, action: () => arrangePair(el, "right") },
    { label: i18n.t("window.arrangeQuads", "四等分"), icon: MENU_ICON.quads, altOnly: true, action: () => arrangeQuads(el) },
    { type: "separator" },
    {
      label: i18n.t("window.fsGroup", "全屏幕"),
      icon: MENU_ICON.fullscreen,
      hasSubmenu: true,
      action: (x, y) => createContextMenu(x, y, fullscreenSub),
    },
    {
      label: i18n.t("window.untile", "还原平铺前大小"),
      disabled: !(st.tiled || st.zoomed),
      action: () => untile(el),
    },
  ];
}

/**
 * 「填充与排列」多窗口布局（TL-10）：取窗口栈次顶层参与排列。
 * 左侧与右侧 = 活跃窗口占指定半屏，次顶层可见窗口占另一半。
 */
function arrangePair(el, side) {
  const other = getVisibleWindows().find((w) => w !== el && w !== undefined);
  tile(el, side);
  if (other) tile(other, side === "left" ? "right" : "left");
}

/** 四等分：最近四扇可见窗口各占一角。 */
function arrangeQuads(el) {
  const wins = getVisibleWindows();
  const ordered = [el, ...wins.filter((w) => w !== el)].slice(0, 4);
  const regions = ["leftTop", "rightTop", "leftBottom", "rightBottom"];
  ordered.forEach((w, i) => tile(w, regions[i]));
}

/**
 * 在指定坐标弹出窗口排列菜单。悬停触发时贴着灯区，右键触发时用光标位置。
 * @param {object} rec
 * @param {number} x
 * @param {number} y
 */
function showWindowMenu(rec, x, y) {
  // rec.menu 可能指向一个已经被别处（下一次 createContextMenu、或菜单项自身点击）
  // 摘掉的元素：只认还挂在 DOM 上的那份，否则一次悬停之后右键就再也不出菜单了。
  if (rec.menu && rec.menu.isConnected) return;
  rec.menu = null;
  const menu = createContextMenu(x, y, windowMenuItems(rec));
  rec.menu = menu;
  // 悬停菜单要「移开就收」：离开灯区与菜单本体时关掉，模拟 macOS 的浮出面板（TL-06 收起 300ms）
  const closeMenu = () => {
    if (rec.menu !== menu) return;
    rec.menu = null;
    if (menu.isConnected) menu.remove();
    document.removeEventListener("click", closeMenu);
    document.removeEventListener("keydown", onAlt, true);
    document.removeEventListener("keyup", onAlt, true);
  };
  // TL-09：菜单打开期间按住 Option 出「填充与排列」多窗口项（实时切换，不重开菜单）
  const onAlt = (e) => {
    if (e.key !== "Alt") return;
    if (!menu.isConnected) { closeMenu(); return; }
    menu.classList.toggle("alt-down", e.type === "keydown");
  };
  document.addEventListener("keydown", onAlt, true);
  document.addEventListener("keyup", onAlt, true);
  menu.addEventListener("mouseleave", () => setTimeout(closeMenu, 300));
  setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
}

function bindTitleBarControls(rec) {
  const el = rec.el;
  const conf = capsOf(el);
  // NW-5：titlebar:"hidden" = 不挂标题栏元素、红绿灯退 overlay 悬浮、顶部带拖动保留
  if (conf.titlebar === "hidden") {
    el.querySelectorAll("[data-titlebar]").forEach((bar) => { bar.hidden = true; });
    mountTrafficLights(el, { placement: "overlay" });
  }
  let lights = getTrafficLights(el);
  if (!lights) lights = mountTrafficLights(el);
  // trafficLights:"none" 时整组隐藏（保留菜单栏与 Dock 右键的关闭入口，防困住用户）
  if (lights) lights.toggleAttribute("hidden", el._wmLightsMode === "none");

  // 组件形态：一颗监听接管三颗灯 + 悬停/右键排列菜单
  if (lights && !rec._lightsBound) {
    rec._lightsBound = true;
    el.addEventListener(ACTION_EVENT, (e) => {
      const detail = e.detail || {};
      if (detail.action === "close") {
        if (runAction(rec, "close", detail) === false) return;
        close(el);
      } else if (detail.action === "minimize") {
        if (runAction(rec, "minimize", detail) === false) return;
        setMinimized(el, !isMinimized(el));
      } else if (detail.action === "zoom") {
        if (runAction(rec, "zoom", detail) === false) return;
        // 长按已弹菜单：这一次 click 只是手指抬起，不执行默认的全屏
        if (rec.zoomPressMenu) { rec.zoomPressMenu = false; return; }
        // 分屏中点绿键 = 将窗口移到桌面（FS-04：本侧回用户框，对侧升独占全屏）
        if (inSplit(el) && !records.get(el)?.fullscreen) { exitSplit(el); return; }
        // macOS 15 口径：单击绿键 = 全屏，⌥/⌘ 单击 = 缩放（TL-03 / FS-01）
        if (detail.altKey || detail.metaKey) setZoom(el);
        else setFullscreen(el);
      } else if (detail.action === "arrange") {
        showWindowMenu(rec, detail.clientX, detail.clientY);
      }
    });
    // TL-02：悬停弹菜单的热区只有绿键（组件对 zoom dot 单独上报 ZOOM_HOVER_EVENT）。
    // TL-16：菜单锚定绿键正下方（组件上报绿键 rect）。
    el.addEventListener(ZOOM_HOVER_EVENT, (e) => {
      const hovering = !!(e.detail && e.detail.hovering);
      if (hovering) {
        import("./wm/genie-capture.js")
          .then((m) => m.refreshWindow(el))
          .catch(() => {});
        const zoomOff = lights.hasAttribute("no-zoom") || lights.getAttribute("variant") === "dialog"
          || lights.classList.contains("inactive");
        if (zoomOff) return;
        clearTimeout(rec.hoverTimer);
        rec.hoverTimer = setTimeout(() => {
          if (rec.mode || rec.menu) return;
          const r = (e.detail && e.detail.rect) || lights.getBoundingClientRect();
          showWindowMenu(rec, r.left, r.bottom + 6);
        }, HOVER_MENU_DELAY);
      } else {
        clearTimeout(rec.hoverTimer);
        rec.hoverTimer = null;
      }
    });
    // TL-16：长按绿键 ≥500ms 视同悬停，直接弹出窗口菜单；随后的 click 被吞掉，
    // 不会顺带把窗口送进全屏（macOS 的长按菜单就是「只看菜单、不执行默认动作」）。
    lights.addEventListener("pointerdown", (e) => {
      const dot = e.target && e.target.classList && e.target.classList.contains("green");
      if (!dot) return;
      if (lights.hasAttribute("no-zoom") || lights.getAttribute("variant") === "dialog"
        || lights.classList.contains("inactive")) return;
      clearTimeout(rec.pressTimer);
      rec.pressTimer = setTimeout(() => {
        rec.pressTimer = null;
        rec.zoomPressMenu = true;
        const r = lights.getBoundingClientRect();
        showWindowMenu(rec, r.left, r.bottom + 6);
      }, 500);
    });
    const cancelPress = () => {
      clearTimeout(rec.pressTimer);
      rec.pressTimer = null;
    };
    lights.addEventListener("pointerup", cancelPress);
    lights.addEventListener("pointerleave", cancelPress);
    lights.addEventListener("pointercancel", cancelPress);
  }

  // 旧标记形态（第三方 ZIP 手写 .red/.yellow/.green）继续可用
  const red = el.querySelector(".wintools .red");
  const yellow = el.querySelector(".wintools .yellow");
  const green = el.querySelector(".wintools .green");
  if (red && !rec._closeBound) {
    rec._closeBound = true;
    red.addEventListener("click", () => close(el));
  }
  if (yellow && !rec._minBound) {
    rec._minBound = true;
    yellow.addEventListener("pointerenter", () => {
      import("./wm/genie-capture.js")
        .then((m) => m.refreshWindow(el))
        .catch(() => {});
    });
    yellow.addEventListener("click", () => setMinimized(el, !isMinimized(el)));
  }
  if (green && !rec._zoomBound) {
    rec._zoomBound = true;
    // macOS 15 口径：单击 = 全屏，⌥ 单击 = 缩放（TL-03 / FS-01）
    green.addEventListener("click", (e) => (e.altKey ? setZoom(el) : setFullscreen(el)));
    green.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showWindowMenu(rec, e.clientX, e.clientY);
    });
  }

  // 双击标题栏缩放的判定已上移到按下入口（wm/interactions.js）：
  // 拖动起手的 preventDefault() 会抑制兼容鼠标事件，绑在这里的 dblclick 永远不触发。
}

// ── 一次性全局装配 ──

/**
 * 视口变化重排（init 与探针共用）：状态窗口跟着重算框架，普通窗口拉回可视区内。
 * NW-2 / WAPI-13：fixed 窗不参与强制回拉（通知窗/固定面板的语义）。
 * 必须合帧：拖浏览器边缘时 Chrome 连续派发 resize，回调里每扇窗口 frameOf() 紧跟
 * applyFrame() 等于每帧每窗一次强制同步布局 —— 一个 rAF 里只重算一次。
 */
export function relayoutOnResize() {
  stack.forEach((el) => {
    const rec = records.get(el);
    if (!rec || !el.isConnected) return;
    if (el._wmFixed) return;   // NW-2：固定定位窗豁免强制回拉
    const f = frameOf(el);
    if (rec.fullscreen) applyFrame(el, displayFrame());
    else if (rec.zoomed) applyFrame(el, zoomFrame(el));
    else if (rec.tiled) applyFrame(el, tileFrame(rec.tiled, { el }));
    else {
      const pos = clampDrag(f.x, f.y, { w: f.w, h: f.h });
      if (pos.x !== f.x || pos.y !== f.y) applyFrame(el, { ...f, ...pos });
      rec.normal = frameOf(el);
    }
  });
}

let initialized = false;
export function init() {
  if (initialized) return;
  initialized = true;

  // 窗口可能被插件自己或「强制退出」摘掉：DOM 是唯一不会说谎的账本。
  // 出栈由 release 负责，这里不再重复 splice（会误删相邻窗口）。
  const observer = new MutationObserver(() => {
    let changed = false;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (!stack[i].isConnected) {
        release(stack[i]);
        changed = true;
      }
    }
    if (changed) {
      commitStack();
      updateActiveAppMenu();
    }
  });
  observer.observe(document.body, { childList: true });

  let resizeQueued = false;
  window.addEventListener("resize", () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { relayoutOnResize(); relayoutSplit(); });
  });

  // 窗口调度快捷键族：
  // - ⌃⌘F 全屏（macOS 一致，原有）；Esc 退出全屏 / 分屏移回桌面；
  // - ⌃←/⌃→ 在全屏伪空间序列中轮换（FS-03）；
  // - ⌃↑ 窗口总览（FS-06）；
  // - ⌃⌥←/→/↑/↓ 半屏平铺、⌃⌥⏎ 填充、⌃⌥C 居中、⌃⌥R 还原（Fn-Control-* 的浏览器可落等价键，FS-10）。
  // ⌘W / ⌘M 刻意不绑：本项目是浏览器新标签页扩展，这两个是浏览器保留快捷键。
  document.addEventListener("keydown", (e) => {
    const root = document.documentElement;
    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (!root.classList.contains("deskly-fullscreen")) return;
      // 菜单开着时 Esc 归菜单（contextMenu 自己监听 Esc）
      if (document.querySelector("div.menu.contextmenu")) return;
      const top = getTopWindow();
      if (!top) return;
      const rec = records.get(top);
      if (rec && rec.fullscreen) { e.preventDefault(); setFullscreen(top, { on: false }); }
      else if (inSplit(top)) { e.preventDefault(); exitSplit(top); }
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      if (!root.classList.contains("deskly-fullscreen")) return;
      e.preventDefault();
      cycleSpaces(e.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      overview.toggle();
      return;
    }
    if (e.ctrlKey && e.altKey && !e.metaKey) {
      const top = getTopWindow();
      if (!top) return;
      const k = e.key;
      if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") {
        e.preventDefault();
        tile(top, { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "top", ArrowDown: "bottom" }[k]);
      } else if (k === "Enter") {
        e.preventDefault();
        setZoom(top, { on: true });
      } else if ((k || "").toLowerCase() === "c") {
        e.preventDefault();
        center(top);
      } else if ((k || "").toLowerCase() === "r") {
        e.preventDefault();
        untile(top);
      }
      return;
    }
    // ⌃⌘F：进入 / 退出全屏。能力位在 setFullscreen 里真拦截。
    if (!e.metaKey || !e.ctrlKey) return;
    if ((e.key || "").toLowerCase() !== "f") return;
    const top = getTopWindow();
    if (!top) return;
    e.preventDefault();
    setFullscreen(top);
  }, true);

  // 全屏时把菜单栏 / 程序坞让出来，指针顶到边缘再临时探出（macOS 行为）
  document.addEventListener("pointermove", (e) => {
    const root = document.documentElement;
    if (!root.classList.contains("deskly-fullscreen")) return;
    const vf = visibleFrame();
    root.classList.toggle("deskly-menubar-reveal", e.clientY <= 2);
    const atBottom = e.clientY >= window.innerHeight - 2;
    const atLeft = e.clientX <= 2;
    const atRight = e.clientX >= window.innerWidth - 2;
    root.classList.toggle("deskly-dock-reveal", (vf.bottom > 0 && atBottom) || (vf.left > 0 && atLeft) || (vf.right > 0 && atRight));
  });
}

// ── 求值期接线：facade → 各内核层的注入与事件 detail 契约 ──

bindLifecycleHooks({ manage, restore });
bindOps({
  applyConfig,
  bindTitleBarControls,
  setZoom,
  setFullscreen,
  tile,
  untile,
  center,
  configure,
  setResizable,
  setLevel,
  showArrangeMenu: showWindowMenu,
});
bindWindowOps({ setZoom, tile });

setWindowDetailProvider((el) => ({
  id: el.id || null,
  appId: (el.dataset && el.dataset.appId) || null,
  pluginId: (el.dataset && el.dataset.pluginId) || null,
  frame: frameOf(el),
  state: stateOf(el),
}));

// 内核侧只读引用（与 window.__dock 同一风格）：finderbar 的 FS-12/13 菜单文案
// 需要同步读顶层窗口状态，动态 import 是异步的，菜单渲染等不起。
window.__wmApi = Object.freeze({
  getTopWindow,
  stateOf,
  getVisibleWindows,
  // FS-03 补充：菜单栏「窗口」菜单要列出当前全屏空间里的窗口
  spacesList: () => stack
    .filter((w) => w.isConnected && records.get(w) && records.get(w).fullscreen)
    .map((w) => ({ id: w.id, name: records.get(w).name || w.id, focused: w === getTopWindow() })),
  focusWindowById: (id) => {
    const w = document.getElementById(id);
    if (w) focusWindow(w);
  },
});

// ── 系统动作注册（聚焦搜索可检索的窗口调度命令） ──
// 与键盘快捷键同一批执行体；已存在的 hideActiveApp / showAll 在聚焦侧保留，不重复定义。
import { registerSystemAction } from "./system-actions.js";
registerSystemAction({
  id: "window.toggleFullscreen",
  label: "进入/退出全屏幕",
  sub: "窗口",
  group: "window",
  aliases: ["fullscreen", "full screen", "全屏", "全屏幕", "⌃⌘F"],
  available: () => !!getTopWindow(),
  run: () => { const top = getTopWindow(); if (top) setFullscreen(top); },
});
registerSystemAction({
  id: "window.showOverview",
  label: "窗口总览",
  sub: "窗口",
  group: "window",
  aliases: ["overview", "mission control", "expose", "调度中心", "总览", "⌃↑"],
  available: () => getVisibleWindows().length > 0,
  run: () => overview.toggle(),
});
registerSystemAction({
  id: "window.nextSpace",
  label: "切换到下一个全屏空间",
  sub: "窗口",
  group: "window",
  aliases: ["next space", "previous space", "空间轮换", "全屏切换", "⌃→", "⌃←"],
  available: () => document.documentElement.classList.contains("deskly-fullscreen"),
  run: () => cycleSpaces(1),
});
registerSystemAction({
  id: "window.tileLeftRight",
  label: "平铺到左侧/右侧",
  sub: "窗口",
  group: "window",
  aliases: ["tile", "平铺", "分屏", "snap", "⌃⌥←", "⌃⌥→"],
  available: () => !!getTopWindow(),
  run: () => { const top = getTopWindow(); if (top) tile(top, "left"); },
});

init();
