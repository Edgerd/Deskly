/**
 * window-manager.js — Deskly 窗口管理核心（macOS 操作语义）
 *
 * 这一层是窗口机制的唯一实现：几何、焦点、拖动、缩放、缩放态/全屏、最小化、
 * 关闭、平铺与吸附。src/javascripts/window.js 退化为「旧式 App 装载 + 兼容门面」，
 * 不再自带第二套窗口逻辑。
 *
 * 与 macOS 的对齐点（都是有意为之，改动前先读这段）：
 * 1. 拖动只认标题栏（[data-titlebar]，没有标题栏元素的窗口退回顶部灯区带）。
 *    旧实现允许从窗口内任意非控件处拖动，看起来自由，实际让用户一碰到内容就把窗口拖走。
 * 2. 缩放命中八向边/角（macOS 的边框命中区），对侧边为锚点；⌥ 锁宽高比。
 *    旧实现只有一个右下角 .resizer，插件窗口根本没有左/上边可缩。
 * 3. 绿键 = 缩放（填充菜单栏与程序坞之间的可视区），⌥点击 = 全屏，
 *    悬停 ~0.4s 弹「窗口排列」菜单（macOS 15 的入口），右键保留同一张菜单。
 * 4. 拖动推到屏幕边缘即平铺（左/右半、四角 ¼、顶部=缩放），带预览框。
 * 5. 缩放态/平铺态下开始拖动或缩放即脱离该状态，回到用户框架 —— 与
 *    macOS 拖动一个已缩放的窗口会「脱开」的行为一致。
 * 6. 焦点是显式的：.is-active + 红绿灯灰化由焦点栈驱动，不再靠 z-index 数字猜。
 *
 * 硬约束：
 * - 动画一律走 left/top/width/height，绝不给 .window 加 transform / filter /
 *   clip-path —— 那会让带 backdrop-filter 的侧栏与内容区换 backdrop-root，
 *   亚克力当场退化成一块死白（window.css、dock.css、ui.css 三处固化禁忌）。
 * - MV3 CSP：不写内联事件、不用 innerHTML 拼可信度未知的内容。
 * - 内核模块的 import 说明符不带 ?v=（带查询串会被当作第二个模块重复求值）。
 */

import { Z } from "./zindex.js";
import { i18n } from "./i18n.js";
import { updateMenu } from "./finderbar.js";
import { createContextMenu } from "./ui/contextMenu.js";
import {
  getTrafficLights, mountTrafficLights, setTrafficLightsActive, setTrafficLightsEnabled, ACTION_EVENT,
} from "./ui/trafficLights.js";
import {
  visibleFrame, frameOf, applyFrame, limitsOf, clampFrame, clampDrag, edgeAt, resizeFrame,
  tileFrame, zoomFrame, displayFrame, snapZoneAt, WM_ANIM_MS,
} from "./wm/frame.js";
// 门面（window.js）以旧名 getDesktopRect 再导出它，这里必须把它透出到模块边界。
export { visibleFrame };
// 平铺分区表也一起透出：顶栏菜单与绿键排列菜单共用同一份键名，不在两处各写一遍。
export { TILE_REGIONS } from "./wm/frame.js";

/** 层级区间：窗口段 [WINDOW_MIN, WINDOW_MAX]，Dock 固定 9500，所以窗口永不越界。 */
export const WINDOW_Z_MIN = Z.WINDOW_MIN;
export const WINDOW_Z_MAX = Z.WINDOW_MAX;

/** 无标题栏元素时，窗口顶部可拖动的带高（= --traffic-titlebar 的 JS 侧对齐值）。 */
const TITLE_BAND = 38;
/** 没有标题栏元素、但灯区被顶得更低时，拖动带的上限。 */
const TITLE_BAND_MAX = 56;
/**
 * 绿键悬停多久弹出窗口排列菜单。
 * macOS 自己约 0.5s，这里取 900ms：本项目的红绿灯离正文与拖动区都比分家系统近，
 * 用户只是把指针扫过标题栏去抓边框，也会顺手把菜单弹出来（实测很烦）。
 * 悬停菜单是「锦上添花」，右键那一份不受这个时长影响。
 */
const HOVER_MENU_DELAY = 900;
/**
 * 缩放期间的边界余量（原来散在 startResize 里是四个裸数字）。
 * 语义各不相同，分开命名而不是合成一个：
 * - RESIZE_KEEP_GRABBABLE：左右两侧拉到底时，窗口仍要留在屏内这么多 px，否则点不到它；
 * - RESIZE_KEEP_TITLE：顶边下界用的高度 —— 标题栏至少留这么多 px 在屏内才还抓得住；
 * - RESIZE_MAX_OVERFLOW：允许比视口更宽的富余量（macOS 容许窗口拉出屏幕两侧）。
 */
const RESIZE_KEEP_GRABBABLE = 40;
const RESIZE_KEEP_TITLE = 24;
const RESIZE_MAX_OVERFLOW = 80;
/** 层叠居中时每个后续同尺寸窗口错开的位移（macOS 的 cascade 节奏）。 */
const CASCADE_STEP = 24;

/**
 * 状态切换动画时长只有一个权威值：wm/frame.js 的 WM_ANIM_MS，
 * 它由 applyFrame 在挂 / 摘 .wm-animating 时自己用，样式表那边是同名的 0.3s。
 * 这里不再留第二份常数 —— 旧 ANIM_MS = 300 全文件无人引用，且与 frame.js 实际
 * 使用的 320 还不一致，读起来像「改了它就能改动画时长」，其实改了没用。
 */

/** 关闭动画兜底：动画事件没来（禁用动画 / 元素已 detach）也要收尾。 */
const CLOSE_FALLBACK_MS = 300;

/**
 * 开窗入场：先隐藏到几何稳定，再显示并从下方 6px 处上浮。
 * 只动 top 与 opacity，绝不使用 transform / filter —— 带 backdrop-filter 的窗口
 * 一旦被提升为 3D 合成层，亚克力会退化成色块（见 ui.css / windowframe.css 的禁忌）。
 * 时长与 ui.css 的 window-fade-in 对齐，位移只是给纯淡入补一点方向感。
 *
 * OPEN_REVEAL_FALLBACK_MS 是「最迟多久必须开始显示」：插件入口脚本可能还在下载
 * （慢盘 / 首次冷加载），不能让窗口一直藏着等脚本。到点后先按当前已稳定的几何显示，
 * 脚本到位后再填充内容即可；正常路径仍由脚本 load 事件提前触发。
 */
const OPEN_REVEAL_FALLBACK_MS = 250;
const OPEN_ANIM_MS = 160;
const OPEN_RISE = 6;
/** 显示前要求连续这么多帧几何不变；最多等 12 帧（约 200ms）避免插件迟迟不收敛。 */
const OPEN_SETTLE_FRAMES = 2;
const OPEN_SETTLE_MAX_FRAMES = 12;

/** 交互类型 */
const IDLE = null;
const DRAG = "drag";
const RESIZE = "resize";

/** 窗口记录表：元素 -> 控制器状态。WeakMap 让被移除的窗口自动回收。 */
const records = new WeakMap();
/** 焦点栈：下标 0 最底、末尾最前。层级由栈序推导，不再无上限自增。 */
const stack = [];
/** 上一次分配给窗口的 z-index（仅用于对外读数与上限告警）。 */
export let zCounter = WINDOW_Z_MIN - 1;

/** 当前被托管的窗口（栈序，底 → 顶）。 */
export function getWindows() {
  return stack.filter((el) => el.isConnected);
}

/**
 * 是不是一个真窗口：带 .window 类，且不在菜单栏 / 菜单 / 程序坞 / 桌面图标层里。
 * 顶栏菜单里历史上出现过 <p class="window">，按类名全量遍历会给它挂红绿灯、
 * 绑拖动，污染成「伪窗口」并让 getElementById 命中错对象。
 * @param {Element} el
 * @returns {boolean}
 */
export function isWindowElement(el) {
  if (!el || !el.classList || !el.classList.contains("window")) return false;
  if (el.closest(".finderbar, .menu, .dockcontainer, .desktop, .launchpad")) return false;
  return true;
}

/**
 * 当前可见窗口（排除关闭中、最小化、被藏掉的），按层级从高到低。
 * @returns {HTMLElement[]}
 */
export function getVisibleWindows() {
  return stack
    .filter((el) => el.isConnected && !el.classList.contains("closing") && !isMinimized(el) && el.style.display !== "none")
    .reverse();
}

/** 最靠上的可见窗口（顶栏菜单与快捷键的作用对象）。 */
export function getTopWindow() {
  return getVisibleWindows()[0];
}

/** 最小化判定：类名 / 标记位 / dock 动画留下的 display:none 三处都可能表达它。 */
export function isMinimized(el) {
  // 判空是必需的：本函数被 dock / 菜单 / winctl 当公开读数用，
  // 传入一个已释放或查不到的元素时，读 el.classList 就是一记 TypeError。
  if (!el || !el.classList) return false;
  return !!(el._minimized || el.classList.contains("minimized") || el.style.display === "none");
}

// ─────────────────────────────────────────────────────────────
// 应用侧声明：data-window="size:900x640 min:620x440 resizable centered"
// ─────────────────────────────────────────────────────────────

/**
 * 解析窗口根元素上的 data-window 声明。
 *
 * 为什么开这条通道：尺寸与可缩放性是「这个应用长什么样」的一部分，归属应用自己，
 * 不该只能写在被内核读取的 manifest.json 里（第三方 ZIP 的 manifest 与它的 HTML
 * 分两处维护时，改尺寸要动两个文件）。现在三处都能声明，优先级：
 *   data-window（应用自己的界面）> manifest.window（内核装载时传入）> 应用 CSS 自然尺寸
 * min/max 直接落进内联样式，于是 frame.limitsOf 读到的就是声明值，缩放边界与
 * 应用样式表里的 min-width 用同一套机制，不需要第二份账。
 *
 * @param {HTMLElement} el 窗口根元素
 * @returns {object} 只包含声明到的字段
 */
export function readDeclaration(el) {
  const raw = el.getAttribute("data-window");
  if (!raw) return {};
  const conf = {};
  raw.split(/[;\s]+/).filter(Boolean).forEach((token) => {
    const [rawKey, rawVal] = token.split(":");
    const key = String(rawKey || "").trim().toLowerCase();
    const val = rawVal === undefined ? true : String(rawVal).trim();
    if (!key) return;
    if (key === "size" || key === "min" || key === "max") {
      const m = String(val).toLowerCase().match(/^(\d+)\s*x\s*(\d+)$/);
      if (!m) {
        console.warn(`[wm] data-window ${key} 需要 WxH 形式，已忽略：${val}`);
        return;
      }
      if (key === "size") { conf.width = Number(m[1]); conf.height = Number(m[2]); }
      else if (key === "min") { conf.minWidth = Number(m[1]); conf.minHeight = Number(m[2]); }
      else { conf.maxWidth = Number(m[1]); conf.maxHeight = Number(m[2]); }
      return;
    }
    const numeric = ["width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight"];
    if (numeric.includes(key)) {
      const n = parseFloat(val);
      if (Number.isFinite(n)) conf[key] = n;
      return;
    }
    const flags = ["resizable", "minimizable", "maximizable", "centered", "draggable"];
    if (flags.includes(key)) {
      conf[key] = val === true || String(val).toLowerCase() === "true";
      return;
    }
    console.warn(`[wm] data-window 未识别的字段，已忽略：${token}`);
  });
  return conf;
}

/**
 * 落实窗口声明（尺寸 / 边界 / 能力开关 / 居中），并同步红绿灯禁用态。
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

  setResizable(el, conf.resizable !== false);
  setTrafficLightsEnabled(el, {
    minimize: conf.minimizable !== false,
    zoom: conf.maximizable !== false && conf.resizable !== false,
  });
  el.dataset.wmDraggable = conf.draggable === false ? "false" : "true";
  if (conf.centered && !el._wmPlaced) center(el);
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

/** 把配置对象写回 data-window 字面量（configure 的持久化形态）。 */
function serializeDecl(conf) {
  const parts = [];
  if (Number.isFinite(conf.width) && Number.isFinite(conf.height)) parts.push(`size:${Math.round(conf.width)}x${Math.round(conf.height)}`);
  if (Number.isFinite(conf.minWidth) && Number.isFinite(conf.minHeight)) parts.push(`min:${Math.round(conf.minWidth)}x${Math.round(conf.minHeight)}`);
  if (Number.isFinite(conf.maxWidth) && Number.isFinite(conf.maxHeight)) parts.push(`max:${Math.round(conf.maxWidth)}x${Math.round(conf.maxHeight)}`);
  ["resizable", "minimizable", "maximizable", "centered", "draggable"].forEach((k) => {
    if (k in conf) parts.push(`${k}:${conf[k] ? "true" : "false"}`);
  });
  return parts.join(" ");
}

/** 按元素 / id / 显示名解析窗口（显示名可能被 CSS 选择器转义，先走 getElementById）。 */
function resolveWindow(target) {
  if (!target) return null;
  if (typeof target === "string") {
    const byId = document.getElementById(target);
    if (isWindowElement(byId)) return byId;
    return Array.from(document.querySelectorAll("body > .window"))
      .find((w) => w.dataset.appName === target || w.id === target) || null;
  }
  return isWindowElement(target) ? target : null;
}

// ─────────────────────────────────────────────────────────────
// 焦点与层级
// ─────────────────────────────────────────────────────────────

/**
 * 按焦点栈重排 z-index：栈序即层级序，值恒在 [WINDOW_MIN, WINDOW_MAX] 内。
 * 旧实现是「每次置顶 +1，逼近上限再全量重排」，窗口数远达不到上限时数字无意义，
 * 而 bringAllWindowsToFront 这类连点会白白跑一次重排。
 */
function commitStack() {
  let z = WINDOW_Z_MIN - 1;
  stack.forEach((el) => {
    z += 1;
    el.style.zIndex = String(z);
  });
  // 极端情况（同屏窗口多到溢出区间）时整体回拉到下限起，保持相对顺序不变
  if (z > WINDOW_Z_MAX) {
    z = WINDOW_Z_MIN - 1;
    stack.forEach((el) => {
      z += 1;
      el.style.zIndex = String(z);
    });
  }
  zCounter = z;
}

function pushStack(el) {
  const i = stack.indexOf(el);
  if (i >= 0) stack.splice(i, 1);
  stack.push(el);
}

/**
 * 标记活跃窗口：红绿灯灰化 + .is-active（样式表据此区分阴影强度）。
 * @param {HTMLElement|null} win
 */
export function setFocusedWindow(win) {
  document.querySelectorAll("body > .window").forEach((w) => {
    if (!isWindowElement(w)) return;
    const active = w === win;
    w.classList.toggle("is-active", active);
    setTrafficLightsActive(w, active);
  });
}

/**
 * 置顶并取焦点。
 * @param {HTMLElement} el 窗口
 * @param {string} [menuName] 顶栏菜单要切到的应用名（默认用窗口自己的名字）
 * @returns {void}
 */
export function focusWindow(el, menuName) {
  if (!el || !el.isConnected) return;
  const rec = manage(el);
  if (!rec) return;
  if (isMinimized(el)) restore(el);
  pushStack(el);
  commitStack();
  const name = menuName || rec.name || el.id;
  if (name) updateMenu(name);
  setFocusedWindow(el);
}

/** 兼容旧调用姿势：bringToFront(win, name)。 */
export function bringToFront(el, name) {
  focusWindow(el, name);
}

/** 顶栏「前置全部窗口」：按栈序自底向上置顶一遍，等价于 macOS 的窗口轮转。 */
export function bringAllWindowsToFront() {
  const visible = getVisibleWindows().slice().reverse();
  visible.forEach((el) => focusWindow(el));
}

/**
 * 逐维写回几何： undefined / 空串 表示「这个维度不动」，还原快照时靠它跳过缺项。
 * 兼容旧签名 setWindowPosition(win, left, top, width, height, zIndex)，值原样落内联样式。
 * @param {HTMLElement} el 窗口
 * @param {{x?:number|string,y?:number|string,w?:number|string,h?:number|string,z?:number|string}} g
 */
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
    el.style.zIndex = String(g.z);
    zCounter = Math.max(zCounter, parseInt(g.z, 10) || 0);
  }
  const rec = records.get(el);
  if (rec && !rec.mode) rec.normal = frameOf(el);
}

/**
 * 记录窗口当前几何（供会话快照一类的调用方存盘）。
 * @param {HTMLElement} el
 * @returns {{left:string,top:string,width:string,height:string,zIndex:string}}
 */
export function snapshotGeometry(el) {
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

/**
 * 按当前可见窗口自动切换顶栏菜单；没有可见窗口时回到「访达」。
 * @returns {void}
 */
export function updateActiveAppMenu() {
  const top = getTopWindow();
  if (!top) {
    updateMenu("访达");
    setFocusedWindow(null);
    return;
  }
  const rec = records.get(top);
  const name = (rec && rec.name) || top.id;
  if (name) updateMenu(name);
  setFocusedWindow(top);
}

// ─────────────────────────────────────────────────────────────
// 状态写入：把内部状态同步到 DOM 属性（样式与外部读取都看 DOM，不看私有字段）
// ─────────────────────────────────────────────────────────────

function syncState(el, rec) {
  el.classList.toggle("wm-zoomed", !!rec.zoomed);
  el.classList.toggle("wm-fullscreen", !!rec.fullscreen);
  el.classList.toggle("wm-tiled", !!rec.tiled);
  el.dataset.wmState = rec.fullscreen ? "fullscreen" : rec.zoomed ? "zoom" : rec.tiled ? `tile-${rec.tiled}` : "normal";
  document.documentElement.classList.toggle("deskly-fullscreen", stack.some((w) => records.get(w) && records.get(w).fullscreen));
}

/** 用户手动改了几何（拖动 / 缩放 / center / frame setter）即宣告托管状态结束。 */
function detachStates(rec, keepNormal) {
  const el = rec.el;
  if (rec.fullscreen) {
    // 全屏必须一并脱开：detachStates 的两个调用点（center 与 el.winctl.frame setter）
    // 都是「用户明确把窗口摆成普通尺寸」，漏掉这一位会留下三重错乱 ——
    // 几何已是普通尺寸、rec.fullscreen 仍为 true、.wm-fullscreen 与
    // <html>.deskly-fullscreen 都不摘（菜单栏与程序坞持续收起），
    // 而下一次 resize 一看 rec.fullscreen 就 applyFrame(displayFrame())
    // 把窗口弹回全屏。
    rec.fullscreen = false;
  }
  if (rec.zoomed || rec.tiled) {
    if (!keepNormal) rec.normal = frameOf(el);
    rec.zoomed = false;
    rec.tiled = null;
  }
  syncState(el, rec);
}

// ─────────────────────────────────────────────────────────────
// 窗口操作（对外 API）
// ─────────────────────────────────────────────────────────────

/** 当前状态快照（插件与顶栏菜单据此决定菜单项文案与禁用态）。 */
export function stateOf(target) {
  const el = resolveWindow(target);
  if (!el) return null;
  const rec = records.get(el);
  return {
    el,
    frame: frameOf(el),
    normal: rec && rec.normal ? { ...rec.normal } : frameOf(el),
    minimized: isMinimized(el),
    zoomed: !!(rec && rec.zoomed),
    fullscreen: !!(rec && rec.fullscreen),
    tiled: (rec && rec.tiled) || null,
    resizable: !el.classList.contains("no-resize"),
    active: el.classList.contains("is-active"),
  };
}

/**
 * 缩放（macOS 绿键的默认动作）：在「用户框架」与「填充可视区」之间切换。
 * @param {HTMLElement|string} target
 * @param {{animate?: boolean, on?: boolean}} [opts] on 显式指定目标态
 * @returns {boolean} 切换后的状态
 */
export function setZoom(target, opts = {}) {
  const el = resolveWindow(target);
  if (!el) return false;
  const rec = manage(el);
  const animate = opts.animate !== false;
  const want = typeof opts.on === "boolean" ? opts.on : !rec.zoomed && !rec.tiled;
  if (rec.fullscreen) {
    // 全屏窗口上点绿键只退出全屏（macOS 全屏态根本没有可用的绿键）。
    // 不提前 return 的话，退出后 want 仍为 true，会顺手再缩放到可视区 ——
    // 用户看到的是一次点击跳两格。
    exitFullscreen(el, { animate });
    return false;
  }
  if (!want) {
    if (!rec.zoomed && !rec.tiled) return false;
    const back = rec.normal || frameOf(el);
    rec.zoomed = false;
    rec.tiled = null;
    applyFrame(el, back, { animate });
    syncState(el, rec);
    return false;
  }
  if (!rec.normal) rec.normal = frameOf(el);
  rec.zoomed = true;
  rec.tiled = null;
  applyFrame(el, zoomFrame(el), { animate });
  syncState(el, rec);
  focusWindow(el);
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
}

/** 兼容旧名：⌃⌘F 与绿键 ⌥ 点击 = 全屏切换。 */
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
  const rec = manage(el);
  const f = tileFrame(region, { el });
  if (!f) return false;
  if (rec.fullscreen) exitFullscreen(el, { animate: false });
  // 只在「既不平铺也不缩放」时记用户框：已在这两种状态里就该保住最初那份普通框，
  // 连续平铺左→右再 untile 才能回到用户自己的位置，而不是回到上一个半屏。
  // （旧条件里还有一个 !rec._tileAnchor —— 那个字段全仓从未被赋值过，恒为真，
  // 是纯粹的死条件，已删。）
  if (!rec.tiled && !rec.zoomed) rec.normal = frameOf(el);
  rec.zoomed = false;
  rec.tiled = region;
  applyFrame(el, f, { animate: true });
  syncState(el, rec);
  focusWindow(el);
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
  return true;
}

/**
 * 居中放置：限制在可视桌面区内，尺寸超出时贴边而不是推到负坐标。
 * 第二个及以后的同尺寸窗口按 macOS 的层叠（cascade）错开，而不是精确压在同一处。
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
    const rec = records.get(el);
    if (rec) {
      rec.normal = frameOf(el);
      rec._wmPlaced = true;
      detachStates(rec, true);
    } else {
      el._wmPlaced = true;
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
 * 最小化到程序坞（ genie 语义：吸入该应用的 Dock 图标）。
 * @param {HTMLElement} el
 * @param {boolean} [minimize=true] false 即还原
 * @returns {void}
 */
export function setMinimized(el, minimize = true) {
  if (!el) return;
  const rec = manage(el);
  const name = (rec && rec.name) || el.id;
  const dock = window.__dock;
  if (minimize) {
    el._minimized = true;
    import("./wm/genie-capture.js")
      .then((m) => m.cancelWarmWindow(el))
      .catch(() => {});
    if (dock && dock.minimizeToDock) dock.minimizeToDock(el, name);
    else el.classList.add("minimized");
    const i = stack.indexOf(el);
    if (i >= 0) stack.splice(i, 1);
    commitStack();
    updateActiveAppMenu();
  } else {
    restore(el);
  }
}

/** 还原（从程序坞吐出）。 */
export function restore(el) {
  // setMinimized 有这道判空，还原路径此前没有：传 null 时下面直接读 el.id 就抛。
  if (!el) return;
  const rec = records.get(el);
  const name = (rec && rec.name) || el.id;
  const dock = window.__dock;
  clearTimeout(el._hideTimer);
  el._hideTimer = null;
  el._minimized = false;
  el.style.display = "";
  el.classList.remove("minimized");
  if (dock && dock.restoreFromDock) dock.restoreFromDock(el, name);
  else focusWindow(el, name);
  if (!stack.includes(el)) pushStack(el);
  commitStack();
  updateActiveAppMenu();
}

/** 兼容旧名。 */
export function toggleMinimize(el) {
  setMinimized(el, !isMinimized(el));
}

/**
 * 关闭窗口：淡出结束后摘除 DOM 并释放应用资源。
 * 幂等：红灯 / 强制退出 / 菜单命令可能叠着调用，第二次直接忽略。
 * @param {HTMLElement} el
 * @returns {void}
 */
export function close(el) {
  if (!el || !el.isConnected) return;
  // 没被接管过的窗口（插件自己注入、或注入后还没走到 resetWindowListeners）
  // 先接管再关：否则这里会静默 return，用户看到的就是「点了红灯没反应」。
  const rec = manage(el);
  if (!rec || rec.closing) return;
  rec.closing = true;
  // 关闭优先于入场：提前按停上浮并摘掉隐藏态，淡出动画才能正常跑。
  cancelOpenAnimation(el);
  import("./wm/genie-capture.js")
    .then((m) => m.cancelWarmWindow(el))
    .catch(() => {});
  if (el._wmRevealAnim) {
    el._wmRevealAnim.cancel();
    el._wmRevealAnim = null;
  }
  let done = false;
  const name = rec.name || el.id;
  const finish = () => {
    if (done) return;
    done = true;
    el.removeEventListener("animationend", onAnimEnd);
    clearTimeout(fallback);
    release(el);
    el.remove();
    commitStack();
    releaseResources(el, name, rec);
    updateActiveAppMenu();
    if (window.__dock && typeof window.__dock.syncRunningApps === "function") {
      window.__dock.syncRunningApps();
    }
  };
  const onAnimEnd = (e) => { if (e.target === el) finish(); };
  el.classList.add("closing");
  el.addEventListener("animationend", onAnimEnd);
  const fallback = setTimeout(finish, CLOSE_FALLBACK_MS);
}

/**
 * 关闭后的资源释放：插件走 plugin-manager.unloadApp（按存活窗口引用计数），
 * 旧式 App 移除其脚本与样式表。
 */
function releaseResources(el, name, rec) {
  const pid = el.dataset.pluginId;
  if (pid) {
    const appId = el.dataset.appId || pid;
    import("./plugin-manager.js").then(({ unloadApp }) => {
      try { unloadApp(pid, appId); } catch (err) { console.warn("[wm] 卸载插件失败:", pid, err); }
    }).catch((err) => console.warn("[wm] 插件管理器不可用:", err));
  } else {
    const s = document.querySelector(`script[app="${name}"]`);
    if (s) s.remove();
    const link = document.querySelector(`link[app-css="${name}"]`);
    if (link) link.remove();
  }
  if (rec.light) rec.light.classList.remove("on");
  if (window.appStatus && name) window.appStatus[name] = false;
}

// ─────────────────────────────────────────────────────────────
// 交互：拖动 / 八向缩放
// ─────────────────────────────────────────────────────────────

/** 命中即不视为标题栏空白的控件清单（沿用旧内核里踩过的坑：shadow 宿主、系统设置外壳类）。 */
const INTERACTIVE = ".wintools, .resizer, input, textarea, select, button, swift-input, swift-switch, a, label, .finder-no-drag, [contenteditable=\"true\"], .ss-switch, .ss-segmented, .ss-dropdown, .ss-menu, .ss-cards, .ss-swatches, .ss-radio, .ss-btn, .ss-input, .ss-slider, .ss-search, .ss-table";

/** 缩放键位 -> CSS 光标名（样式表负责落到 .window 与其子树）。 */
const EDGE_CURSOR = {
  n: "ns", s: "ns", e: "ew", w: "ew",
  nw: "nwse", se: "nwse", ne: "nesw", sw: "nesw",
};

/**
 * 指针是不是压在「真正在用的滚动条」上。
 * 右/下边的缩放带和滚动条是同一批像素（macOS 的边框在内容之外，这里没法照抄）：
 * 只要祖先可滚就放行缩放，会把访达列表、记事本正文的滚动条整个吃掉；
 * 反过来只要祖先可滚就拒绝缩放，又会让窗口左右两边根本缩不动
 * —— 判据必须是「指针落在该元素的滚动条槽里」，而不是「这里有滚动容器」。
 * @param {Element} target 按下命中的元素
 * @param {HTMLElement} el 窗口根
 * @param {"x"|"y"} axis 缩放方向涉及的滚动轴
 * @param {number} cx 指针视口横坐标
 * @param {number} cy 指针视口纵坐标
 * @returns {boolean}
 */
function overScrollbar(target, el, axis, cx, cy) {
  const GUTTER = 16;   //  macOS 悬浮滚动条 +  classic 滚动条的宽度上限
  let n = target;
  while (n && n !== el) {
    const cs = window.getComputedStyle(n);
    const o = axis === "y" ? cs.overflowY : cs.overflowX;
    if (o === "auto" || o === "scroll") {
      const overflow = axis === "y"
        ? n.scrollHeight > n.clientHeight + 1
        : n.scrollWidth > n.clientWidth + 1;
      if (overflow) {
        const r = n.getBoundingClientRect();
        // 垂直滚动条占元素右缘，水平滚动条占下缘
        if (axis === "y" ? cx >= r.right - GUTTER : cy >= r.bottom - GUTTER) return true;
      }
    }
    n = n.parentElement;
  }
  return false;
}

/**
 * 缩放带要让位的控件（比拖动排除表窄得多，这是有意的）。
 *
 * 缩放命中区只有边框那 6px，而 macOS 的边框在内容之外、这里没法照抄，
 * 只能做取舍：按下落在窗口最外圈 6px 时，边框赢过内容。
 * 用宽表（含 button / a / label）的后果实测就是「左右两边根本缩不动」——
 * Safari 网页内容、访达列表项正好铺到窗口边缘，缩放全部被当成点内容吃掉。
 * 留下让位的只有：真的需要按下才能输入/编辑的控件、红绿灯、插件自带的老手柄。
 */
const RESIZE_EXCLUDES = ".wintools, input, textarea, select, swift-input, swift-switch, [contenteditable=\"true\"], .ss-switch, .ss-slider, .ss-search, .ss-input, .resizer";

/** 缩放带能不能接管这次按下。 */
function resizeBlocked(target, el, edge, cx, cy) {
  // 插件自带的老式右下角手柄：它自己就是缩放控件，不能让自己的排除表把它挡掉
  if (target.closest && target.closest(".resizer")) return false;
  if (target.closest && target.closest(RESIZE_EXCLUDES)) return true;
  if (/[ns]/.test(edge) && overScrollbar(target, el, "y", cx, cy)) return true;
  if (/[ew]/.test(edge) && overScrollbar(target, el, "x", cx, cy)) return true;
  return false;
}

/**
 * 该点是否落在「真的在滚」的纵向滚动容器里。
 * 顶部带兜底要把这个手势还给内容，否则列表/正文就拖不动了。
 */
function insideScroller(target, el) {
  let n = target;
  while (n && n !== el) {
    const cs = window.getComputedStyle(n);
    if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
      if (n.scrollHeight > n.clientHeight + 1) return true;
    }
    n = n.parentElement;
  }
  return false;
}

/**
 * 拖动区判定：标题栏优先；标题栏没认领、或窗口根本没有标题栏时，
 * 退回「顶部灯区带」；声明 draggable:false 的窗口完全不可拖。
 * @param {object} rec 窗口记录
 * @param {PointerEvent} e
 * @returns {boolean}
 */
function inDragZone(rec, e) {
  const el = rec.el;
  if (el.dataset.wmDraggable === "false") return false;
  if (e.target.closest && e.target.closest(INTERACTIVE)) return false;
  // 一个窗口可以有多条标题栏（App Store 的 .as-titlebar + .as-toolbar 都算），
  // 只认 querySelector 的第一个会让第二条拖不动。
  const bars = el.querySelectorAll("[data-titlebar]");
  for (const bar of bars) {
    if (bar.contains(e.target)) return true;
  }
  // 走到这里有两种情况：窗口没有标题栏元素，或标题栏被应用自己的样式做成了
  // 不可交互的装饰条（pointer-events:none —— 系统设置的 .ss-titlebar、
  // App Store 的 .as-titlebar 都是这么写的，于是整扇窗口一点都拖不动）。
  // macOS 的观感里窗口顶部那一条本来就是标题栏，所以按顶部带兜底；
  // 真正在滚的容器把 gesture 还给内容，避免「想滚列表却把窗口拖走」。
  const f = frameOf(el);
  if (e.clientY - f.y > bandOf(el)) return false;
  return !insideScroller(e.target, el);
}

/** 顶部可拖带高：无标题栏元素的窗口用，跟着红绿灯的实际位置走。 */
function bandOf(el) {
  const lights = getTrafficLights(el);
  if (!lights) return TITLE_BAND;
  const f = frameOf(el);
  const r = lights.getBoundingClientRect();
  if (!r.height) return TITLE_BAND;
  // frame 用的是 y（不是 top）：写成 f.top 会得到 NaN，整个顶部带判定静默失效
  return Math.max(TITLE_BAND, Math.min(TITLE_BAND_MAX, r.bottom - f.y + 8));
}

/** 平铺预览层（游离元素，拖动期间才挂在 body 上）。 */
let preview = null;
function showPreview(frame, z) {
  if (!preview) {
    preview = document.createElement("div");
    preview.id = "deskly-tile-preview";
    preview.setAttribute("aria-hidden", "true");
  }
  if (!preview.isConnected) document.body.appendChild(preview);
  preview.style.zIndex = String(Math.max(WINDOW_Z_MIN - 1, z - 1));
  preview.style.left = `${Math.round(frame.x)}px`;
  preview.style.top = `${Math.round(frame.y)}px`;
  preview.style.width = `${Math.round(frame.w)}px`;
  preview.style.height = `${Math.round(frame.h)}px`;
}
function hidePreview() {
  if (preview && preview.isConnected) preview.remove();
}

/**
 * 缩放边带：窗口根上的 8 个透明 div（四边 + 四角）。
 *
 * 为什么不用「捕获阶段按坐标算命中区」那一套：Safari 的网页内容是 <iframe>，
 * 指针落在 iframe 上时，事件进的是 iframe 自己的文档，宿主页面连 pointerdown
 * 都收不到 —— 纯坐标判定的结果是 Safari 的左右两边永远缩不动（实测就是这样）。
 * 边带是宿主页面的元素，压在 iframe 之上，按下必定命中。
 *
 * 代价是边带会盖住贴边的内容（最典型是右侧滚动条），所以 hover 时做一次
 * 「底下到底是什么」的判定：滚动条槽、输入框、红绿灯在场就把这条边带让回去
 * （pointer-events:none），其余情况边框优先 —— 与 macOS 的观感一致。
 * @param {HTMLElement} el 窗口根
 */
function ensureEdgeBands(el) {
  if (el.querySelector(":scope > .wm-edge")) return;
  ["n", "s", "w", "e", "nw", "ne", "sw", "se"].forEach((key) => {
    const band = document.createElement("div");
    band.className = `wm-edge wm-edge-${key}`;
    band.dataset.wmEdge = key;
    band.setAttribute("aria-hidden", "true");
    el.appendChild(band);
  });
}

/**
 * 边带此刻该不该让位。用 elementFromPoint 取「边带底下是什么」：
 * 临时给窗口挂 .wm-peeking（样式表把所有边带 pointer-events 关掉）再取，取完摘掉。
 * @param {HTMLElement} el 窗口根
 * @param {string} edge 边带键
 * @param {number} cx 指针横坐标
 * @param {number} cy 指针纵坐标
 * @returns {boolean} true = 让位给内容
 */
function bandShouldYield(el, edge, cx, cy) {
  el.classList.add("wm-peeking");
  const under = document.elementFromPoint(cx, cy);
  el.classList.remove("wm-peeking");
  if (!under || under === el || !el.contains(under)) return false;
  return resizeBlocked(under, el, edge, cx, cy);
}

/**
 * hover 时的让位刷新。
 * 只在「进了哪条边带」变化时做一次 elementFromPoint 判定，不逐像素算：
 * 边带只有 5px 宽，进出各一次足够，逐帧探测会每帧多一次强制布局。
 * @param {object} rec 窗口记录
 * @param {number} cx 指针横坐标
 * @param {number} cy 指针纵坐标
 */
function syncBandYield(rec, cx, cy) {
  const el = rec.el;
  const edge = edgeAt(frameOf(el), cx, cy);
  if (edge === rec.hoverEdge) return;
  rec.hoverEdge = edge;
  el.querySelectorAll(":scope > .wm-edge").forEach((band) => {
    const key = band.dataset.wmEdge;
    band.classList.toggle("blocked", !!edge && edge === key && bandShouldYield(el, key, cx, cy));
  });
}

/**
 * 交互遮罩：拖动 / 缩放期间铺一层透明 div 盖住整页。
 * 没有它，指针一进内容里的 <iframe>（Safari 的整个网页面就是 iframe），
 * 事件就被那个文档吃掉，窗口拖到一半「断线」再也跟不上手。
 * 层级取「所有窗口之上、Dock 之下」（Z.MENU_FLOAT_MAX），期间的光标由它统一表达。
 */
let shield = null;
function installShield(cursorName) {
  if (!shield) {
    shield = document.createElement("div");
    shield.id = "deskly-interaction-shield";
    shield.setAttribute("aria-hidden", "true");
  }
  shield.style.cursor = cursorName ? `${cursorName}-resize` : "";
  if (!shield.isConnected) document.body.appendChild(shield);
  return shield;
}
function removeShield() {
  if (shield && shield.isConnected) shield.remove();
}

/** 交互期间挂在 <html> 上的类：拖拽锁文字选中；缩放期间光标走遮罩的 inline cursor。 */
function beginInteraction(kind, cursorName) {
  const root = document.documentElement;
  root.classList.remove("deskly-dragging", "deskly-resizing");
  root.classList.add(kind === DRAG ? "deskly-dragging" : "deskly-resizing");
  installShield(cursorName);
}

function endInteraction(rec) {
  const root = document.documentElement;
  rec.mode = null;
  rec.grab = null;
  rec.snap = null;
  rec.hoverEdge = null;
  hidePreview();
  removeShield();
  root.classList.remove("deskly-dragging", "deskly-resizing");
}

/**
 * 拖动/缩放结束后刷新快照。拖动只改位置，旧快照仍可复用；这里主要处理
 * 尺寸变化与吸附动画：原生截图可用时立即换新，不可用时重新排一次空闲预热。
 */
function refreshGenieAfterGeometry(el, delay = 0, sizeChanged = false) {
  const run = () => {
    if (!el.isConnected) return;
    import("./wm/genie-capture.js")
      .then((m) => (sizeChanged ? m.geometryChanged(el) : m.refreshWindow(el)))
      .catch(() => {});
  };
  if (delay > 0) setTimeout(run, delay);
  else requestAnimationFrame(run);
}

/**
 * 统一的按下入口：边带 → 缩放，标题栏 → 拖动，其余只置顶取焦点。
 * 缩放不再靠坐标猜（那正是 iframe 场景下失效的根因）：命中窗口自己的边带元素即算。
 * 放在捕获阶段，是为了让边框压过内容自己绑的按下处理。
 * @param {object} rec
 */
function bindInteractions(rec) {
  const el = rec.el;

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !el.isConnected || isMinimized(el)) return;
    // 入场动画期间用户先按下了窗口：立即落到最终位置，避免位移和拖动抢同一个 top。
    if (el._wmOpenAnim || el._wmOpenPending) cancelOpenAnimation(el);
    const band = e.target.closest ? e.target.closest(".wm-edge") : null;
    if (band && band.parentElement === el) {
      startResize(rec, band.dataset.wmEdge, e);
      return;
    }
    // 老插件自带的右下角 .resizer：继续当东南手柄用
    if (e.target.closest && e.target.closest(".resizer")) {
      startResize(rec, "se", e);
      return;
    }
    if (inDragZone(rec, e)) {
      // 双击标题栏 = 缩放（macOS 默认行为）。
      // 这里自己数两次按下，而不是绑 dblclick：拖动起手会 preventDefault()，
      // 兼容鼠标事件被整段抑制，dblclick 根本不会再派发（实测 dblclick 一次都不进）。
      const now = performance.now();
      const last = rec.lastTitleTap;
      const isDouble = !!last && now - last.t < 400
        && Math.abs(e.clientX - last.x) < 8 && Math.abs(e.clientY - last.y) < 8;
      rec.lastTitleTap = isDouble ? null : { t: now, x: e.clientX, y: e.clientY };
      if (isDouble) {
        focusWindow(el);
        if (!el.classList.contains("no-resize")) setZoom(el);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      startDrag(rec, e);
      return;
    }
    // 点到内容也算「用了这个窗口」：置顶 + 活跃（红绿灯随之上色）
    focusWindow(el);
  }, true);

  // hover：只在「进了哪条边带」变化时做一次让位判定（见 syncBandYield），不逐像素算
  el.addEventListener("pointermove", (e) => {
    if (rec.mode) return;
    syncBandYield(rec, e.clientX, e.clientY);
  });
  el.addEventListener("pointerleave", () => {
    if (rec.mode) return;
    rec.hoverEdge = null;
    el.querySelectorAll(":scope > .wm-edge.blocked").forEach((b) => b.classList.remove("blocked"));
  });
}

/**
 * 拖动窗口。
 * 从缩放态 / 平铺态起手时先脱开（macOS：拖一个已缩放的窗口，它会缩回用户框架并跟住指针），
 * 脱开后指针仍落在标题栏内同一相对位置，不会出现「一按就跳走」。
 */
function startDrag(rec, e) {
  const el = rec.el;
  if (rec.fullscreen) return;      // macOS：全屏窗口没有可拖的标题栏
  focusWindow(el);

  const before = frameOf(el);
  rec.grab = { dx: e.clientX - before.x, dy: e.clientY - before.y };
  rec.mode = DRAG;
  rec.moved = false;
  rec.start = { x: e.clientX, y: e.clientY };
  // 缩放态 / 平铺态先记着，等「真的开始移动」那一刻才脱开 ——
  // 在按下就还原的话，双击标题栏的第一击会把窗口缩回去，第二击又放大回去，
  // 用户看到的是「双击没反应」（macOS 只在拖动时脱开，单击不动它）。
  rec.pending = (rec.zoomed || rec.tiled) ? { normal: rec.normal || before } : null;
  beginInteraction(DRAG, "");
  e.preventDefault();
  e.stopPropagation();

  const move = (ev) => {
    if (rec.mode !== DRAG || !el.isConnected) return finish();
    if (!rec.moved && Math.abs(ev.clientX - rec.start.x) < 3 && Math.abs(ev.clientY - rec.start.y) < 3) return;
    rec.moved = true;
    if (rec.pending) {
      const normal = rec.pending.normal;
      rec.zoomed = false;
      rec.tiled = null;
      syncState(el, rec);
      // 脱开后让指针落在标题栏内同一相对位置，窗口不会「跳」到别处
      const rel = before.w > 0 ? (ev.clientX - before.x) / before.w : 0.5;
      rec.grab = {
        dx: Math.min(Math.max(normal.w * 0.12, normal.w * rel), normal.w - 20),
        dy: Math.min(ev.clientY - before.y, 20),
      };
      const pos = clampDrag(ev.clientX - rec.grab.dx, ev.clientY - rec.grab.dy, { w: normal.w, h: normal.h });
      applyFrame(el, clampFrame({ x: pos.x, y: pos.y, w: normal.w, h: normal.h }, limitsOf(el)));
      rec.pending = null;
    }
    const f = frameOf(el);
    const next = clampDrag(ev.clientX - rec.grab.dx, ev.clientY - rec.grab.dy, { w: f.w, h: f.h });
    applyFrame(el, { x: next.x, y: next.y, w: f.w, h: f.h });
    const zone = snapZoneAt(ev.clientX, ev.clientY);
    if (zone) showPreview(zone.frame, parseInt(el.style.zIndex, 10) || WINDOW_Z_MIN);
    else hidePreview();
    rec.snap = zone;
  };
  function finish() {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", finish);
    document.removeEventListener("pointercancel", finish);
    window.removeEventListener("blur", finish);
    if (rec.mode !== DRAG) return;
    hidePreview();
    const snapped = !!rec.snap;
    const changed = rec.moved || snapped;
    if (rec.snap) {
      if (rec.snap.region === "zoom") setZoom(el, { on: true });
      else tile(el, rec.snap.region);
    } else if (rec.moved) {
      rec.normal = frameOf(el);
    }
    rec.pending = null;
    rec.moved = false;
    endInteraction(rec);
    if (changed) refreshGenieAfterGeometry(el, snapped ? WM_ANIM_MS : 0, snapped);
  }
  // 监听挂在 document：拖动途中指针会跑到遮罩上、别的窗口上、甚至浏览器外面，
  // 挂在窗口自己身上会漏事件（旧实现的 mousemove 就是这么断线的）。
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
  // 在浏览器窗口外松开鼠标收不到 pointerup，不兜底就会留一只永远跟手的窗口
  window.addEventListener("blur", finish);
}

/**
 * 沿某条边 / 角缩放：对侧边为锚点（macOS 行为），⌥ 锁宽高比，
 * 尺寸边界取窗口自己的 min / max（含 data-window 声明与插件 CSS）。
 */
function startResize(rec, edge, e) {
  const el = rec.el;
  // 全屏窗口没有可缩的边框 —— 与 startDrag 同一道守卫。
  // .wm-edge 已被样式表 pointer-events:none 挡掉（windowframe.css），
  // 但插件自带的老式 .resizer 仍可达，不挡就会在「全屏」状态下被拉成普通尺寸，
  // 而 rec.fullscreen 仍挂着 —— 正是 detachStates 那条漏掉全屏的同源错乱。
  if (rec.fullscreen) return;
  focusWindow(el);
  // 手动缩放即接管框架：缩放态 / 平铺态直接结束，当前框成为新的用户框
  if (rec.zoomed || rec.tiled) {
    rec.zoomed = false;
    rec.tiled = null;
    syncState(el, rec);
  }
  const base = frameOf(el);
  const limits = limitsOf(el);
  const vf = visibleFrame();
  // 抓取偏移：按下点通常落在边带中间（离真边框 2~3px），不记这个偏移的话，
  // 一按下边缘就会瞬移到指针处，窗口会「跳」掉那两三像素。
  const anchor = {
    x: edge.includes("w") ? base.x : edge.includes("e") ? base.x + base.w : e.clientX,
    y: edge.includes("n") ? base.y : edge.includes("s") ? base.y + base.h : e.clientY,
  };
  const off = { x: e.clientX - anchor.x, y: e.clientY - anchor.y };
  rec.mode = RESIZE;
  beginInteraction(RESIZE, EDGE_CURSOR[edge]);
  e.preventDefault();
  e.stopPropagation();

  let changed = false;
  const move = (ev) => {
    if (rec.mode !== RESIZE || !el.isConnected) return finish();
    changed = true;
    const to = { x: ev.clientX - off.x, y: ev.clientY - off.y };
    const next = resizeFrame(base, edge, to, limits, { keepAspect: ev.altKey });
    // 左右下三边允许越出可视区（macOS 允许），但顶边不许钻进菜单栏底下，
    // 并且始终留 40px 在屏内，否则窗口再也点不到。
    next.x = Math.max(-next.w + RESIZE_KEEP_GRABBABLE, Math.min(next.x, window.innerWidth - RESIZE_KEEP_GRABBABLE));
    next.y = Math.max(vf.top, Math.min(next.y, window.innerHeight - RESIZE_KEEP_TITLE));
    next.w = Math.min(next.w, window.innerWidth + RESIZE_MAX_OVERFLOW);
    next.h = Math.min(next.h, window.innerHeight - next.y);
    applyFrame(el, next);
  };
  function finish() {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", finish);
    document.removeEventListener("pointercancel", finish);
    window.removeEventListener("blur", finish);
    if (rec.mode !== RESIZE) return;
    rec.normal = frameOf(el);
    endInteraction(rec);
    if (changed) refreshGenieAfterGeometry(el, 0, true);
  }
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
  window.addEventListener("blur", finish);
}

/** 绿键的「窗口排列」菜单（macOS 悬停 / 右键同一张）。 */
function windowMenuItems(rec) {
  const el = rec.el;
  const st = stateOf(el);
  return [
    { type: "header", label: i18n.t("window.arrangeHeader", "窗口排列") },
    {
      label: st.fullscreen ? i18n.t("window.exitFullscreen", "退出全屏") : i18n.t("window.enterFullscreen", "进入全屏"),
      action: () => setFullscreen(el),
    },
    {
      label: st.zoomed ? i18n.t("window.unzoom", "还原大小") : i18n.t("window.zoomFill", "缩放填充"),
      action: () => setZoom(el),
    },
    { type: "separator" },
    { label: i18n.t("window.tileLeft", "平铺到左侧"), action: () => tile(el, "left") },
    { label: i18n.t("window.tileRight", "平铺到右侧"), action: () => tile(el, "right") },
    { label: i18n.t("window.tileTop", "平铺到上方"), action: () => tile(el, "top") },
    { label: i18n.t("window.tileBottom", "平铺到下方"), action: () => tile(el, "bottom") },
    { type: "separator" },
    { label: i18n.t("window.tileLeftTop", "左上角"), action: () => tile(el, "leftTop") },
    { label: i18n.t("window.tileRightTop", "右上角"), action: () => tile(el, "rightTop") },
    { label: i18n.t("window.tileLeftBottom", "左下角"), action: () => tile(el, "leftBottom") },
    { label: i18n.t("window.tileRightBottom", "右下角"), action: () => tile(el, "rightBottom") },
    { type: "separator" },
    { label: i18n.t("window.center", "居中"), action: () => center(el) },
    {
      label: i18n.t("window.untile", "还原平铺前大小"),
      disabled: !(st.tiled || st.zoomed),
      action: () => untile(el),
    },
  ];
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
  // 悬停菜单要「移开就收」：离开灯区与菜单本体时关掉，模拟 macOS 的浮出面板
  const close = () => {
    if (rec.menu !== menu) return;
    rec.menu = null;
    if (menu.isConnected) menu.remove();
    document.removeEventListener("click", close);
  };
  menu.addEventListener("mouseleave", () => setTimeout(close, 160));
  setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
}

function bindTitleBarControls(rec) {
  const el = rec.el;
  let lights = getTrafficLights(el);
  if (!lights) lights = mountTrafficLights(el);

  // 组件形态：一颗监听接管三颗灯 + 悬停/右键排列菜单
  if (lights && !rec._lightsBound) {
    rec._lightsBound = true;
    el.addEventListener(ACTION_EVENT, (e) => {
      const detail = e.detail || {};
      if (detail.action === "close") close(el);
      else if (detail.action === "minimize") setMinimized(el, !isMinimized(el));
      else if (detail.action === "zoom") {
        if (detail.altKey || detail.metaKey) setFullscreen(el);
        else setZoom(el);
      } else if (detail.action === "arrange") {
        showWindowMenu(rec, detail.clientX, detail.clientY);
      }
    });
    // 悬停绿键 = macOS 15 的窗口排列入口。禁用位（对话框 / no-zoom）不弹。
    lights.addEventListener("pointerenter", () => {
      import("./wm/genie-capture.js")
        .then((m) => m.refreshWindow(el))
        .catch(() => {});
      const zoomOff = lights.hasAttribute("no-zoom") || lights.getAttribute("variant") === "dialog"
        || lights.classList.contains("inactive");
      if (zoomOff) return;
      clearTimeout(rec.hoverTimer);
      rec.hoverTimer = setTimeout(() => {
        if (rec.mode || rec.menu) return;
        const r = lights.getBoundingClientRect();
        showWindowMenu(rec, r.left, r.bottom + 6);
      }, HOVER_MENU_DELAY);
    });
    lights.addEventListener("pointerleave", () => {
      clearTimeout(rec.hoverTimer);
      rec.hoverTimer = null;
    });
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
    green.addEventListener("click", (e) => (e.altKey ? setFullscreen(el) : setZoom(el)));
    green.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showWindowMenu(rec, e.clientX, e.clientY);
    });
  }

  // 双击标题栏缩放的判定已上移到按下入口（bindInteractions）：
  // 拖动起手的 preventDefault() 会抑制兼容鼠标事件，绑在这里的 dblclick 永远不触发。
}

// ─────────────────────────────────────────────────────────────
// 开窗入场
// ─────────────────────────────────────────────────────────────

/**
 * 在窗口刚插入 DOM、尚未完成尺寸/居中时先藏起来。
 *
 * 调用点必须是「insertAdjacentHTML 之后、任何 await 之前」：浏览器在任务结束后
 * 就有一次绘制机会，默认 .window 的 680×570 与未居中位置会先被画出来，
 * 等 window-manager 算完真实几何再跳过去，就是用户看到的打开瞬间错位。
 * 这里加的类由 ui.css 定义为 visibility:hidden + animation:none，不改变布局。
 * @param {HTMLElement|null} el 新窗口根元素
 * @returns {void}
 */
export function prepareOpen(el) {
  if (!el || !el.classList || el.classList.contains("closing")) return;
  el._wmOpenPending = true;
  el.classList.add("wm-preparing");
  // 兜底：后面的装载步骤若抛错，窗口不能永久不可见。
  clearTimeout(el._wmOpenFallback);
  el._wmOpenFallback = setTimeout(() => revealOpen(el), OPEN_REVEAL_FALLBACK_MS);
}

/** 取消入场（用户提前操作 / 窗口被关闭时调用），立即恢复可见并停掉位移动画。 */
export function cancelOpenAnimation(el) {
  if (!el) return;
  el._wmOpenPending = false;
  el._wmOpenRevealing = false;
  clearTimeout(el._wmOpenFallback);
  el._wmOpenFallback = null;
  if (el.classList) el.classList.remove("wm-preparing");
  if (el._wmOpenAnim) {
    el._wmOpenAnim.cancel();
    el._wmOpenAnim = null;
  }
}

/**
 * 显示新窗口并播放入场。
 *
 * 不能只等固定两帧：插件脚本求值期间主线程会被占住，`center()` 的二次校准
 * 与插件的 `Deskly.windows.configure` 都可能晚于脚本 load 才落到 DOM 上。
 * 这里逐帧读几何，连续 2 帧不变（最多等 12 帧）才显示；于是计算器这类
 * 「init 时按模式复述高度」的应用不会先以基础尺寸出现再跳一次。
 * 超时仍显示，保证任何情况下窗口都不会被永久藏住。
 * @param {HTMLElement|null} el 新窗口根元素
 * @returns {void}
 */
export function revealOpen(el) {
  if (!el || !el._wmOpenPending || el._wmOpenRevealing) return;
  el._wmOpenRevealing = true;
  let last = "";
  let stable = 0;
  let frames = 0;
  const step = () => {
    if (!el._wmOpenPending || !el.isConnected) {
      el._wmOpenRevealing = false;
      return;
    }
    const f = frameOf(el);
    const sig = `${Math.round(f.x)},${Math.round(f.y)},${Math.round(f.w)},${Math.round(f.h)}`;
    stable = sig === last ? stable + 1 : 0;
    last = sig;
    frames += 1;
    if (stable < OPEN_SETTLE_FRAMES && frames < OPEN_SETTLE_MAX_FRAMES) {
      requestAnimationFrame(step);
      return;
    }
    el._wmOpenPending = false;
    el._wmOpenRevealing = false;
    clearTimeout(el._wmOpenFallback);
    el._wmOpenFallback = null;
    el.classList.remove("wm-preparing");
    playOpenMotion(el);
    // 通知程序坞：窗口这一刻才真正可见，加载弹跳到这里停（见 dock.syncRunningApps）。
    if (window.__dock && typeof window.__dock.syncRunningApps === "function") {
      window.__dock.syncRunningApps();
    }
    import("./wm/genie-capture.js")
      .then((m) => m.warmWindow(el))
      .catch(() => {});
  };
  requestAnimationFrame(step);
}

/** 实际的位移：读完最终框架后从下方 10px 起笔，结束时落回内联样式里的最终值。 */
function playOpenMotion(el) {
  // 减少动态效果：站内开关与系统偏好任一开启都不加位移，只保留 CSS 的淡入
  // （main.css 已把站内开关下的 .window animation 关掉）。
  if (document.documentElement.dataset.reduceMotion === "on") return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (typeof el.animate !== "function") return;
  const f = frameOf(el);
  const anim = el.animate(
    [{ top: `${f.y + OPEN_RISE}px` }, { top: `${f.y}px` }],
    { duration: OPEN_ANIM_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );
  el._wmOpenAnim = anim;
  anim.addEventListener("finish", () => {
    if (el._wmOpenAnim === anim) el._wmOpenAnim = null;
  }, { once: true });
}

// ─────────────────────────────────────────────────────────────
// 接管与全局初始化
// ─────────────────────────────────────────────────────────────

/**
 * 接管一个窗口（幂等）。plugin-manager 注入界面后调用，等价于旧名 resetWindowListeners。
 * @param {HTMLElement} el 窗口根元素
 * @param {{name?: string, light?: HTMLElement|null, kernel?: object}} [opts]
 * @returns {object|null} 窗口记录
 */
export function manage(el, opts = {}) {
  if (!isWindowElement(el)) return null;
  let rec = records.get(el);
  if (rec) {
    // 名字永远以窗口自己的 id 为准（本项目约定：窗口 id 就是应用显示名）。
    // 旧实现允许调用方把 name 覆写进来，多窗口场景下会把别人的窗口写成
    // 本次装载的应用名，顶栏菜单随之串台。
    if (el.id) rec.name = el.id;
    if (opts.light) rec.light = opts.light;
    return rec;
  }
  rec = {
    el,
    name: el.id || opts.name || "",
    light: opts.light || null,
    normal: null,
    zoomed: false,
    fullscreen: false,
    tiled: null,
    mode: null,
    grab: null,
    snap: null,
    closing: false,
    hoverTimer: null,
    menu: null,
  };
  records.set(el, rec);
  if (opts.kernel) el._wmKernelConf = opts.kernel;
  else if (el._wmKernelConf) opts.kernel = el._wmKernelConf;

  applyConfig(el, opts.kernel || {});
  ensureEdgeBands(el);
  bindInteractions(rec);
  bindTitleBarControls(rec);
  installElementApi(el, rec);

  if (!stack.includes(el)) pushStack(el);
  commitStack();
  syncState(el, rec);
  if (typeof el.dataset.appName !== "string" && rec.name) el.dataset.appName = rec.name;
  return rec;
}

/**
 * 释放一个窗口的托管：出栈、收掉悬停菜单、重算全屏态外壳类。
 * 调用方（关闭流程 / DOM 摘除观察器）之后自己再 commitStack，这里不动层级。
 */
export function release(el) {
  const i = stack.indexOf(el);
  if (i >= 0) stack.splice(i, 1);
  const rec = records.get(el);
  if (rec) {
    clearTimeout(rec.hoverTimer);
    rec.hoverTimer = null;
    if (rec.menu && rec.menu.isConnected) rec.menu.remove();
    rec.menu = null;
  }
  document.documentElement.classList.toggle("deskly-fullscreen", stack.some((w) => {
    const r = records.get(w);
    return r && r.fullscreen;
  }));
}

/**
 * 元素侧 API：`el.winctl.close()`。
 * 同时保留历史私有钩子（`el._closeWindow` 等）为同一批函数的别名 ——
 * 已发布的 ZIP 插件按这些名字调过窗口，删掉就是静默失效，留着也只是六行引用。
 */
function installElementApi(el, rec) {
  const ctl = {
    get state() { return stateOf(el); },
    close: () => close(el),
    minimize: () => setMinimized(el, true),
    restore: () => restore(el),
    toggleMinimize: () => setMinimized(el, !isMinimized(el)),
    zoom: (on) => setZoom(el, { on }),
    toggleZoom: () => toggleZoom(el),
    fullscreen: (on) => setFullscreen(el, { on }),
    toggleFullscreen: () => toggleFullscreen(el),
    tile: (region) => tile(el, region),
    untile: () => untile(el),
    center: (o) => center(el, o),
    focus: () => focusWindow(el),
    configure: (conf) => configure(el, conf),
    resize: (on) => setResizable(el, on !== false),
    get frame() { return frameOf(el); },
    set frame(f) {
      rec.normal = { ...f };
      detachStates(rec, true);
      applyFrame(el, clampFrame(f, limitsOf(el)), { animate: true });
    },
  };
  Object.defineProperty(el, "winctl", { value: Object.freeze(ctl), configurable: true, enumerable: false });
  el._closeWindow = ctl.close;
  el._toggleMinimizeWindow = ctl.toggleMinimize;
  el._toggleStretchWindow = ctl.toggleZoom;
  el._toggleFullscreenWindow = ctl.toggleFullscreen;
  el._tileWindow = ctl.tile;
  el._untileWindow = ctl.untile;
  el._showArrangeMenu = (x, y) => showWindowMenu(rec, x, y);
}

/** 一次性全局装配：DOM 摘除跟随、视口变化重算、快捷键。 */
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

  // 视口变化：状态窗口跟着重算框架，普通窗口拉回可视区内。
  // 必须合帧：拖浏览器边缘时 Chrome 是连续派发 resize 的，而回调里每扇窗口都要
  // frameOf()（getBoundingClientRect 读）紧跟 applyFrame()（四个内联写）——
  // 读写交织等于每帧每窗一次强制同步布局，N 扇窗口就是 N 次，这是拖窗口时
  // 最直接的掉帧来源。一个 rAF 里只重算一次。
  let resizeQueued = false;
  const relayoutOnResize = () => {
    resizeQueued = false;
    stack.forEach((el) => {
      const rec = records.get(el);
      if (!rec || !el.isConnected) return;
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
    hidePreview();
  };
  window.addEventListener("resize", () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(relayoutOnResize);
  });

  // ⌃⌘F：进入 / 退出全屏（与 macOS 一致）。
  // ⌘W / ⌘M 刻意不绑：本项目是浏览器新标签页扩展，这两个是浏览器保留快捷键，
  // 页面既收不到也拦不住 —— 真去绑会变成「关窗口的同时把标签页也关了」。
  document.addEventListener("keydown", (e) => {
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

init();
