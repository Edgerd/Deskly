/**
 * dock.js — 程序坞（Dock）：渲染、交互与布局设置的应用方
 *
 * 职责：按存储的布局项（大小 / 位置 / 放大 / 指示灯 / 最近使用）渲染收藏区、
 * 运行区、最近使用区与废纸篓区，处理打开 / 退出 / 强制退出 / 拖拽排序 / 文件夹栈 /
 * 悬浮提示 / 键盘导航，并把「正在运行的窗口」对账成运行区图标与指示灯。
 *
 * 与设置中枢的分工（见 settings.js）：
 * - 7 个视觉布局项的**写入方是设置中枢**：它按定义表校验后落盘，再按 `event` 名补发
 *   `dock-*-change`。本模块的监听器仍对 `detail` 再校验一遍（钳制 / 枚举回退），
 *   因为事件是外部可伪造的入口 —— 历史上 `detail:"500"` 就真能得到 500px 的程序坞。
 * - 本模块自己发起的两处写入（自动隐藏、显示最近使用）经 `settings.set()` 走，
 *   不再 `localStorage.setItem` + 手工补发事件。
 * - 收藏顺序与「最近使用」是数组形态的业务数据，落盘在本模块（配额安全写入），
 *   设置中枢只登记 `dock.order` / `dock.recents` 供「恢复默认顺序」与存储诊断使用。
 */

import { updateMenu } from "./finderbar.js";
import { i18n } from "./i18n.js";
import { create, bringToFront, closeWindow, isMinimized, isWindowElement } from "./window.js";
import { getTrashKey, getTrashIconForFullness } from "./trashIcon.js";
import { createContextMenu } from "./ui/contextMenu.js";
import { isNativeContextMenuEnabled } from "./contextMenuSettings.js";
import {
    appToPlugin,
    iconMap,
    getIcon,
    staticIconFor,
    isIconPending,
    rememberIcon,
    forgetIcon,
    pruneIconHints,
    invalidateIconCache,
} from "./dock/icons.js";
import { createDockDrag } from "./dock/drag.js";
import { buildAppMenuItems, buildDockMenuItems } from "./dock/menu.js";
import {
    openApp as openPluginApp,
    prefetchApp,
    resolveAppRecord,
    isPluginEnabled,
    GENERIC_APP_ICON,
} from "./plugin-manager.js";
import { displayNameFor } from "./app-registry.js";
import { DOWNLOAD_ICON, legacyAppHtml } from "./paths.js";
const tip = document.querySelector("body > div.tip");
if (tip) {
    // 拖出被拒等即时提示只出现 1.4s，读屏软件默认会漏掉，需要 live region。
    tip.setAttribute("role", "status");
    tip.setAttribute("aria-live", "polite");
}

/** 统一派发 dock 设置变更事件（detail 为 "on" / "off"） */
const emitDock = (name, on) => window.dispatchEvent(new CustomEvent(name, { detail: on ? "on" : "off" }));

/**
 * dock 侧的告警出口：优先写运行记录（可按 kernel/dock 检索），日志模块未就绪时退回
 * console —— 站内 console.* 已被 log.js 接管，两条路最终都进同一份运行记录。
 * @param {string} message 说明文本
 * @param {*} [data] 附加上下文（通常是抛出的异常）
 * @returns {void}
 */
function logDock(message, data) {
    if (window.__log) window.__log.warn("kernel/dock", message, data);
    else console.warn(`[dock] ${message}`, data);
}

/**
 * 安全写入 localStorage（同 cursor.js / appearance.js 的写法）：
 * 配额超限（站内已知情形：上传的大图 base64 把 5MB 占满）时记一条 warn 并返回 false。
 * 程序坞这些键存的只是顺序与开关，写不进只影响「下次开机回到旧排序」，
 * 但异常若冒泡回拖拽 / 点击处理器会让本次 DOM 停在半途，所以必须兜住。
 * @param {string} key 存储键
 * @param {string} value 存储值
 * @returns {boolean} 是否写入成功
 */
function safeSetItem(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (err) {
        logDock(`写入 ${key} 失败（配额或权限）：`, err);
        return false;
    }
}

/**
 * 写一个程序坞布尔开关：优先交给设置中枢（校验 -> 落盘 -> 按 event 名补发变更事件），
 * 中枢不可用时退回「自己落盘 + 自己补发」，功能不缺。
 * 无论走哪条路，最后都用 apply 把新值就地应用到本模块状态：存储值与内存值
 * 偶发不同步（隐私模式、事件未派发）时界面也一定跟着用户的点击动。
 * @param {string} key 设置键（如 "dock.autohide"）
 * @param {string} slot 存储槽名（如 "dock-autohide"）
 * @param {boolean} next 新值
 * @param {string} event 旧事件名（如 "dock-autohide-change"）
 * @param {Function} apply 把新值应用到模块状态并刷界面
 * @returns {boolean} 新值
 */
function writeDockFlag(key, slot, next, event, apply) {
    const api = window.__settings;
    // 中枢注册过该键才交给它（布尔会按站内既有的 on/off 形态落盘）；
    // 未注册时它会把布尔写成 "true"/"false"，与 owner 的 === "on" 读法不兼容，
    // 所以那种情况下走本地兜底：自己按 on/off 落盘并补发旧事件。
    if (api && typeof api.set === "function" && typeof api.has === "function" && api.has(key)) {
        api.set(key, next, { source: "dock" });
    } else {
        safeSetItem(slot, next ? "on" : "off");
        emitDock(event, next);
    }
    apply(next);
    return next;
}

// 程序坞固定收藏项（默认值，不含废纸篓与分隔线；下载为文件夹栈）
const FAVORITE_DEFAULTS = ["访达", "启动台", "Safari浏览器", "系统设置", "App Store", "下载"];
const TRASH = "废纸篓";
// 程序坞受保护应用：禁止用户从程序坞移除（右键菜单不显示「从程序坞中移除」，拖出程序坞区域也不移除）
const DOCK_PROTECTED = ["访达", "启动台"];
// 程序坞布局缓存键：保存用户拖拽排序后的收藏图标顺序（仅收藏区持久化）
const DOCK_ORDER_KEY = "webstartos_dock_order";
// 最近使用的 App 缓存键
const RECENTS_KEY = "webstartos_dock_recents";

// 图标解析统一在 dock/icons.js：静态内置表先行（首屏不出现通用占位图），
// 清单就绪后再按 manifest.icon 校准；这里不再维护第二份映射或回退链。

// ===== 程序坞状态（以 localStorage 为唯一事实来源） =====
// 视觉布局项（大小 / 位置 / 放大倍数 …）的写入方是设置中枢：它按定义表校验后
// 落盘，再按 event 名补发下面这些 dock-*-change 事件。事件 detail 是外部可伪造的
// 入口（历史上往 dock-size-change 塞 detail=500 就真能得到 500px 程序坞），
// 所以每个监听器都再校验一遍，取值不合法就地钳制或回退默认。
const SIZE_MIN = 32, SIZE_MAX = 128, SIZE_DEFAULT = 50;
const ZOOM_MIN = 1.1, ZOOM_MAX = 3, ZOOM_DEFAULT = 1.8;
const POSITIONS = ["left", "bottom", "right"];
const POSITION_DEFAULT = "bottom";
const MINIMIZE_EFFECTS = ["genie", "scale"];
const MINIMIZE_EFFECT_DEFAULT = "genie";

/** 数字读数：非法回退默认，再钳进 [min,max]。 */
function readNumber(detail, min, max, fallback) {
    const n = typeof detail === "number" ? detail : parseFloat(detail);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/** 枚举读数：不在候选值内回退默认。 */
function readEnum(detail, allowed, fallback) {
    return allowed.includes(detail) ? detail : fallback;
}

/** 布尔读数：只认 on/true/1 为真，其余按关（缺值即默认）。 */
function readFlag(detail, defaultValue = false) {
    if (detail === undefined || detail === null || detail === "") return defaultValue;
    return detail === "on" || detail === true || detail === "true" || detail === 1 || detail === "1";
}

let noAnimation = ["启动台", "访达"];
let noMenuChanging = ["启动台"];
let doClose = ["启动台"];
let appStatus = { "访达": false };
window.appStatus = appStatus;
let trashImg = null;
export const dock = document.getElementById("dock");

// 收藏区 / 运行区 / 最近使用区 / 废纸篓区 四个分段容器
const mkBox = (id, cls) => {
    const el = document.createElement("div");
    el.className = cls;
    el.id = id;
    return el;
};
const favoritesEl = mkBox("dock-favorites", "dock-section");
const runningEl = mkBox("dock-running", "dock-section");
const recentEl = mkBox("dock-recent", "dock-section");
const trashEl = mkBox("dock-trash", "dock-section");
const sepRunning = mkBox("dock-sep-running", "dock-sep");
const sepRecent = mkBox("dock-sep-recent", "dock-sep");
const sepTrash = mkBox("dock-sep-trash", "dock-sep");

let autoHide = localStorage.getItem("dock-autohide") === "on";
// 放大默认开启（符合用户预期：鼠标悬浮程序坞即放大）；仅当存储显式为 "off" 时关闭
let dockZoom = localStorage.getItem("dock-zoom") !== "off";
// 程序坞图标大小（像素）：越界读数按同一套边界钳制，与监听器共用常量
let dockSize = readNumber(localStorage.getItem("dock-size"), SIZE_MIN, SIZE_MAX, SIZE_DEFAULT);
// 程序坞位置：bottom / left / right
let dockPosition = readEnum(localStorage.getItem("dock-position"), POSITIONS, POSITION_DEFAULT);
// 最小化样式：genie = 神奇效果；scale = 纯淡出（不碰真实窗口 transform）
let minimizeEffect = readEnum(localStorage.getItem("dock-minimize-effect"), MINIMIZE_EFFECTS, MINIMIZE_EFFECT_DEFAULT);
// 放大程度（最大缩放倍数）
let dockZoomAmount = readNumber(localStorage.getItem("dock-zoom-amount"), ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT);
// 是否显示运行指示灯
let showIndicators = localStorage.getItem("dock-show-indicators") !== "off";
// 是否在程序坞中显示「最近使用的 App」
let showRecentApps = localStorage.getItem("dock-show-recent") !== "off";

let hideTimer = null;
// 必须与 .dock 类规则（dock.css）的 transition 完全同构，含 visibility 那一段：
// 这里写内联值会整条覆盖类规则，少了 visibility 段就等于 .hidden 的
// `visibility:hidden` 第一帧立即生效 —— 程序坞瞬间消失，0.4s 淡出从未成立。
const DOCK_TRANSITION = "opacity 0.4s cubic-bezier(0.25, 1, 0.5, 1), visibility 0.4s ease";
// 与 .window.minimized 的 opacity 过渡一致；隐藏定时器再留一点收尾余量。
const MINIMIZE_FADE_MS = 240;
let currentImg = null;
// 拖拽进行中标志：抑制打开、悬浮提示、自动隐藏与放大动画
let isDragging = false;
// 当前程序坞所有图标（用于放大动画与悬停提示）
let imgs = [];
// 图标容器缓存：应用身份 → .container。各区渲染只搬动同一批节点，
// 不重建 <img>，已解码的图标不会因为一次对账重新加载、闪回占位图。
const iconNodes = new Map();
// 运行区顺序（未固定的运行应用，按首次出现顺序追加）
let runningOrder = [];
// 程序坞拖拽控制器句柄
let dockDrag = null;
// 放大动画的唤醒函数（DockAnimation 内注册，拖拽状态变化时用来立即校准一帧）
let requestDockFrame = null;
// 渲染合帧：一次对账 / 设置变化只重排一次 DOM
let renderScheduled = false;
// 拖拽期间延后渲染，松手后统一补一次，避免节点在影子拖拽途中被搬走
let renderPendingWhileDragging = false;
// 废纸篓是否非空（决定满/空图标）
let trashFull = false;
// 刷新程序坞图标列表；原实现无限递归自身，每次调用直接栈溢出，
// 导致 init() 中断、放大动画与悬浮提示均未注册。现改为收集存活图标。
function refreshIconList() {
    imgs = Array.from(dock.querySelectorAll(".container img")).filter((img) => img.isConnected);
    // 图标数量是回缩上限的输入，数量一变就必须立刻重算尺寸。
    // 这一步不能省到调用方去做：init 阶段 1 的顺序是 applyDockSize() 在前、
    // refreshIconList() 在后，那时 imgs 还是空数组，首屏就完全不会回缩。
    applyDockSize();
}

/**
 * 当前真正能用的图标边长（px）。
 *
 * 为什么不直接给 .dock 加 overflow-x:auto 让它滚动：那样会把放大时向上溢出的图标
 * 一起裁掉 —— overflow-x 非 visible 时 overflow-y 会被计算成 auto，而「图标溢出底栏
 * 盒子」正是这套放大的前提（玻璃面板早已下沉到 .dock::before 就是为了不裁剪它）。
 * 也不能靠 .dockcontainer 的滚动：body/html 是 overflow:hidden（main.css:37），
 * 超出的部分今天是被直接裁掉的，连滚动条都不出现，而被切掉的恰好是
 * DOCK_PROTECTED 里移不掉的访达与启动台 —— 用户就此打不开访达。
 * 所以让它**回缩**而不是溢出：可用带宽除以图标数，再扣掉间隙与 hover 余量。
 * @returns {number}
 */
function effectiveDockSize() {
    const count = Math.max(imgs.length || 1, 1);
    // 侧边程序坞是垂直排布，可用带宽换成视口高度
    const span = dockPosition === "left" || dockPosition === "right"
        ? window.innerHeight : window.innerWidth;
    // 10px：容器内边距 + 图标间距的下限；再留 5% 给放大动画的横向余量
    const fitting = Math.floor((span * 0.95 - 20) / count) - 10;
    return Math.max(SIZE_MIN, Math.min(dockSize, fitting));
}
// 空闲调度工具：将非关键初始化拆到主线程空闲期执行，避免页面加载时被长任务阻塞。
// requestIdleCallback 优先（带 timeout 兜底保证最终执行）；不支持时退化为双 rAF（下一帧后）。
function scheduleIdle(fn, timeout = 800) {
    if (typeof requestIdleCallback === "function") {
        requestIdleCallback(fn, { timeout });
    } else {
        requestAnimationFrame(() => requestAnimationFrame(fn));
    }
}

// 图标校准合帧定时器：单个 ZIP 插件安装 / 卸载会连续广播事件，合并成一次。
let iconRefreshTimer = 0;

// 重新校准所有程序坞图标的 src：在 plugin-manager 完成注册后调用。
// 静态表已经给出内置应用的真实路径，这里只对「真实路径与当前不同」的图标重设；
// ZIP 插件则从占位骨架切换到清单里的图标。
function refreshIconsFromRegistry() {
    // 直接校准优先于排队中的批量校准：清掉定时器，避免同一次注册跑两遍。
    if (iconRefreshTimer) {
        clearTimeout(iconRefreshTimer);
        iconRefreshTimer = 0;
    }
    invalidateIconCache();
    // 先剪掉已卸载 / 改名的条目，再校准图标：被剪掉的图标不再去解析成
    // 通用占位图，避免「卸载一个插件」时先闪一下占位图再消失。
    pruneStaleRecents();
    pruneStaleFavorites();
    const keepApps = collectDockApps();
    iconNodes.forEach((container, app) => {
        if (app === TRASH || !keepApps.has(app)) return; // 废纸篓由 fullness / 变体事件单独维护
        const img = container.querySelector("img");
        if (!img) return;
        // 兜底去重：同一个启动过程里 plugins-ready / 品牌包切换 / 插件装删会多次广播，
        // 校准也只对 src 真的变了的图标动手 —— 否则重复触发时会把已解码的图标重设为
        // 同一路径（二次请求 + 二次布局），正是首屏要避免的抖动。
        const next = getIcon(app);
        if (!next || img.src === absoluteIconSrc(next)) return;
        updateIconSrc(app, img);
    });
    pruneIconHints(keepApps);
    scheduleRender();
}

// 单个 ZIP 插件安装 / 卸载会连续广播事件；合并成一次校准，避免每个事件都全量刷图标。
function scheduleIconRefresh() {
    if (iconRefreshTimer) return;
    iconRefreshTimer = setTimeout(() => {
        iconRefreshTimer = 0;
        refreshIconsFromRegistry();
    }, 80);
}

// 注册表就绪后调用：剔除「最近使用」里已无法解析到任何已知应用的条目
// （典型来源：卸载了 ZIP 插件、或改名后旧显示名残留）。这类条目会以
// ./assets/icons/<名称>.png 兜底拼路径 → 每次渲染 404。已知应用 = 已注册插件
// 或其中的子应用（getIconForName 覆盖多应用套件名，如 文稿/表格/演示）、
// appToPlugin / iconMap / 收藏项 / 下载 / 废纸篓。据此过滤，误删风险为零。
/**
 * 名称能否解析到任何已知应用。刻意**不含**「它自己在收藏列表里」这条自证 ——
 * 拿带自证的版本去过滤收藏列表，每个收藏项都会因为「它就在那份列表里」而通过，
 * 剪枝就成了空操作。
 * 已知应用 = 已注册插件或其中的子应用（getIconForName 覆盖多应用套件名，
 * 如 文稿/表格/演示）、appToPlugin / iconMap / 下载 / 废纸篓。
 */
function isResolvableApp(name) {
    if (!name || name === TRASH || name === "下载") return true;
    if (appToPlugin[name] || iconMap[name]) return true;
    if (resolveAppRecord(name)) return true;
    return typeof window.__getPluginByName === "function" && !!window.__getPluginByName(name);
}
function isKnownApp(name) {
    return isResolvableApp(name) || favorites.includes(name);
}
function pruneStaleRecents() {
    const kept = recentApps.filter(isKnownApp);
    if (kept.length !== recentApps.length) {
        recentApps = kept;
        saveRecents();
        scheduleRender();
    }
}
// 收藏项剪枝：与 pruneStaleRecents 同一必要。卸载 / 改名一个 ZIP 插件后，它的旧显示名
// 会永久留在 webstartos_dock_order 里，点它就走进 window.js 的旧式装载分支 ——
// assets/apps/ 已清空（paths.js 自己注明「走到那里必然 404 并弹提示」），
// 于是每次点击都弹一个「未找到该应用的界面模板」错误框。
// **只能在注册表就绪后跑**：boot 瞬间插件还没注册，此刻剪枝会把全部插件收藏项一次清光。
function pruneStaleFavorites() {
    const kept = favorites.filter(isResolvableApp);
    if (kept.length !== favorites.length) {
        favorites = kept;
        saveFavorites();
        scheduleRender();
    }
    // 受保护项（访达 / 启动台）不参与剪枝：万一某次注册表异常让它们查不到，
    // 也要按默认位置补回来，否则用户面对的是一条移不掉的图标凭空消失。
    ensureProtectedFavorites();
}
// 最近使用的 App（最多 3 个，alt 名）
let recentApps = [];
// 收藏项顺序（alt 名）
let favorites = [];
// 栈弹层当前实例
let activeStack = null;
// 上一次对账时的运行应用 id 集合（用于检测「新打开」以记录最近使用）
let lastSyncIds = new Set();

// ===== 打开 / 聚焦 / 关闭应用：鼠标点击与右键菜单共用 =====

/**
 * 该显示名对应的插件是否被用户禁用。
 * 只认「注册表里查得到的应用」——废纸篓、下载栈、启动台这些非插件条目一律返回 false，
 * 不能因为查不到记录就当成禁用（那会把系统自带图标全钉死）。
 * @param {string} name 图标显示名 / 逻辑名
 * @returns {boolean} 是否已禁用
 */
function isDisabledApp(name) {
    if (!name) return false;
    const rec = typeof window.__getAppByName === "function" ? window.__getAppByName(name) : null;
    return !!(rec && rec.id && !isPluginEnabled(rec.id));
}

/**
 * 让访达导航到指定路径（废纸篓点击 / 「在访达中显示」下载共用）。
 * 冷加载时访达脚本晚于窗口出现（fetch + 注入），固定等几帧会把导航命令丢在
 * 监听器挂上之前；这里轮询活动标签的 data-path，到达即停，最多重试 5 秒。
 * @param {string} path VFS 路径
 */
function navigateFinderTo(path) {
    const actions = window.__menuActions || {};
    if (typeof actions.openAppByName === "function") actions.openAppByName("访达");
    let tries = 0;
    const send = () => {
        const win = document.getElementById("访达");
        const tab = win && win.querySelector(".tab.active");
        if (tab && tab.dataset.path === path) return;
        if (win) {
            win.dispatchEvent(new CustomEvent("finder-command", {
                detail: { command: "navigate", args: { path } },
                bubbles: true,
            }));
        }
        if (++tries < 25) setTimeout(send, 200);
    };
    setTimeout(send, 0);
}

function openApp(img, light, app) {
    // 文件夹栈（下载）：右键「打开」与左键点击走同一条展开逻辑，
    // 不能把它当普通应用交给 launchApp，否则会去加载不存在的旧模板。
    if (img && img.dataset && img.dataset.folder) {
        openStack(app, img);
        return;
    }
    // 禁用拦截：程序坞条目是持久化的，在商店里禁用插件并不会把图标摘下来。
    // 放行会让 launchApp 先点亮指示灯、再发现窗口没注入，把应用钉成「有小圆点没界面」。
    if (isDisabledApp(img.alt || app)) {
        const dialog = window.__dialog;
        if (dialog) dialog.alert("应用已禁用", `「${img.alt || app}」已在 App Store 中禁用，请先在商店里重新启用。`);
        return;
    }
    // 启动台使用独立的开关状态机（window.__launchpad），彻底解耦，
    // 避免依赖 appStatus 的偶然同步导致"二次打开被拦截"或"仅有小圆点无界面"。
    if (img.alt === "启动台" && window.__launchpad) {
        if (window.__launchpad.isOpen()) window.__launchpad.close();
        else window.__launchpad.open(light);
        return;
    }
    // 启动台现在把程序坞抬到自己的上面（原版是「隐藏菜单栏、保留程序坞」）。
    // 从程序坞点其它应用时，先让启动台退出，否则窗口会开在它背后、看起来点了没反应。
    if (img.alt !== "启动台" && window.__launchpad && window.__launchpad.isOpen()) {
        window.__launchpad.close();
    }
    // 废纸篓：不是可启动应用（P0-4）——点它打开访达的 /废纸篓 目录，
    // 不再走进 launchApp 的「未找到该应用」分支。
    if (img.alt === TRASH || app === TRASH) {
        navigateFinderTo("/废纸篓");
        return;
    }
    if (appStatus[img.alt] == true) {
        if (!doClose.includes(img.alt)) {
            const win = document.getElementById(img.alt);
            if (win && !win.classList.contains("closing")) {
                if (isMinimized(win) && window.__dock && window.__dock.restoreFromDock) {
                    window.__dock.restoreFromDock(win, img.alt);
                } else {
                    bringToFront(win, img.alt);
                }
            } else {
                // 标记为运行但窗口已不存在 / 正在关闭（加载失败，或关闭动画里又点一次）：
                // 复位状态并按「重新打开」处理，避免对 null 或垂死窗口调用 bringToFront 把应用钉死。
                if (light) light.classList.remove("on");
                appStatus[img.alt] = false;
                launchApp(img, light, app);
            }
        } else {
            try {
                if (typeof window.specialCloses[img.alt] === "function") {
                    window.specialCloses[img.alt]();
                } else {
                    const stray = document.querySelector(".launchpad");
                    if (stray) stray.remove();
                }
            } catch (e) {
                console.warn("[dock] 关闭应用异常：", app, e);
            }
            if (light) light.classList.remove("on");
            appStatus[img.alt] = false;
            // 摘掉 .launchpad 不会走 window-manager.close()，对账不会被窗口移除触发，
            // 这里主动收一次，避免运行区与指示灯停在半途。
            syncRunningApps();
        }
    } else {
        if (!noAnimation.includes(img.alt)) {
            if (img.classList.contains("opening")) return; // 弹跳进行中：忽略重复点击，避免 N 次点击排入 N 个 launchApp
            img.classList.add("opening");
            // 先启动，再让图标自己弹完这一轮。旧写法是等 2980ms 才 launchApp：
            // 用户看到图标连弹三下、三秒后应用才开始加载（parabola 是 1s infinite，
            // 2980 也不是它的整数倍），而且上面那道守卫会把这三秒里的重复点击全部吞掉，
            // 看起来就是「点了没反应」。macOS 的语义是立刻启动 + 同时弹跳作反馈。
            // 动画本身已改为单次；animationend 与超时双兜底摘类，主线程再忙也不会
            // 留下无限弹跳的图标（syncRunningApps 在窗口出现时还会提前摘一次）。
            let openingTimer = 0;
            const stopOpening = () => {
                img.classList.remove("opening");
                img.removeEventListener("animationend", onOpeningEnd);
                clearTimeout(openingTimer);
            };
            const onOpeningEnd = (e) => {
                if (e.animationName === "parabola") stopOpening();
            };
            img.addEventListener("animationend", onOpeningEnd);
            openingTimer = setTimeout(stopOpening, 1100);
            launchApp(img, light, app);
        } else {
            launchApp(img, light, app);
        }
        // 点击即清空白 Badge
        if (window.__dock) window.__dock.setBadge(img.alt, 0);
    }
}

// 真正创建并启动应用：写状态、点亮指示灯、刷新菜单与运行区（动画分支与即时分支共用）
function launchApp(img, light, app) {
    const altName = img.alt;
    appStatus[altName] = true;
    if (light) light.classList.add("on");
    if (!noMenuChanging.includes(altName)) updateMenu(app);
    // 先在内存里补入运行区顺序；真实窗口出现后 syncRunningApps 会以 DOM 为准收敛。
    if (altName !== TRASH && !favorites.includes(altName) && !runningOrder.includes(altName)) {
        runningOrder.push(altName);
    }
    scheduleRender();

    const resetOpening = () => {
        img.classList.remove("opening");
        if (light) light.classList.remove("on");
        appStatus[altName] = false;
        syncRunningApps();
    };

    // 已注册插件直接走插件加载器：省掉 window.js 的一次动态 import 与旧模板路径判断。
    // 只有未注册 / 注册表还没就绪的条目才回退到旧式 create()。
    if (resolveAppRecord(app)) {
        openPluginApp(app, { light, centered: app === "计算器" })
            .then((win) => { if (!win) resetOpening(); })
            .catch((err) => {
                console.warn("[dock] 启动应用失败：", app, err);
                resetOpening();
            });
        return;
    }
    create(legacyAppHtml(app), altName, light, app === "计算器");
}

// 应用关闭后的联动：运行区移除
function onAppClosed(altName) {
    runningOrder = runningOrder.filter((name) => name !== altName);
    scheduleRender();
}

// 强制退出：忽略常规关闭流程，直接移除窗口并复位状态
function forceQuit(img, light, altName) {
    const win = document.getElementById(altName);
    try {
        if (win) {
            closeWindow(win);
        } else if (window.specialCloses[altName]) {
            window.specialCloses[altName]();
        }
    } catch (e) {
        console.warn("[dock] 强制退出异常：", altName, e);
        if (win) win.remove();
    }
    if (light) light.classList.remove("on");
    appStatus[altName] = false;
    onAppClosed(altName);
    // 兜底对账：上面按 getElementById 只关得掉同 id 的第一扇窗口，
    // 显示名冲突时（window.js:238-240 承认会发生）其余同插件窗口要靠对账收敛。
    syncRunningApps();
}

// 退出应用：关闭对应窗口（特殊应用走专用关闭逻辑）
function quitApp(img, light, altName) {
    if (window.specialCloses[altName]) {
        window.specialCloses[altName]();
        if (light) light.classList.remove("on");
        appStatus[altName] = false;
        onAppClosed(altName);
    } else {
        const win = document.getElementById(altName);
        if (win) {
            closeWindow(win);
            onAppClosed(altName);
        } else {
            // 标记为运行却已经没有窗口了（加载失败残留 / 关闭动画里又退出）：
            // 旧写法在这里什么都不做，于是 appStatus 永远停在 true、小圆点永远亮着，
            // 而这正是「有小圆点没界面」的那个老症状。就地复位并交给对账收敛。
            if (light) light.classList.remove("on");
            appStatus[altName] = false;
            onAppClosed(altName);
            syncRunningApps();
        }
    }
}

/**
 * 从程序坞取消固定（右键「从程序坞中移除」/ 拖出隐藏共用）。
 * 不再关闭已打开的窗口：macOS 的语义是「从程序坞移除」只撤图标，应用继续运行；
 * 运行中的应用会自然落到运行区，下次点它仍在。
 * @param {HTMLElement|null} img 图标（保留参数以兼容既有调用）
 * @param {string} altName 应用身份名
 */
function removeFromDock(img, altName) {
    if (DOCK_PROTECTED.includes(altName) || altName === TRASH) return;
    const idx = favorites.indexOf(altName);
    if (idx >= 0) favorites.splice(idx, 1);
    const rIdx = recentApps.indexOf(altName);
    if (rIdx >= 0) recentApps.splice(rIdx, 1);
    if (idx >= 0) saveFavorites();
    if (rIdx >= 0) saveRecents();
    // 让运行区重新按真实窗口收敛：取消固定的运行中应用会出现在运行区末尾。
    syncRunningApps();
}

// 在程序坞中保留：将当前运行（非收藏）应用加入收藏项并持久化
function keepInDock(altName) {
    if (favorites.includes(altName) || altName === TRASH) return;
    favorites.push(altName);
    runningOrder = runningOrder.filter((name) => name !== altName);
    saveFavorites();
    syncRunningApps();
}

// 打开系统设置（优先复用程序坞里的图标状态；不在程序坞时直接启动插件）
function openSettings() {
    const img = getDockIconImg("系统设置");
    if (img) {
        openApp(img, img.parentElement.querySelector(".light"), "系统设置");
        return;
    }
    if (resolveAppRecord("系统设置")) {
        if (!noMenuChanging.includes("系统设置")) updateMenu("系统设置");
        openPluginApp("系统设置", { light: null, centered: false });
        return;
    }
    if (!noMenuChanging.includes("系统设置")) updateMenu("系统设置");
    create(legacyAppHtml("系统设置"), "系统设置", null, false);
}

// 切换程序坞自动隐藏（写入走设置中枢，dock.js 不再自己 setItem）
function toggleAutoHide() {
    writeDockFlag("dock.autohide", "dock-autohide", !autoHide, "dock-autohide-change", (value) => {
        autoHide = value;
        clearTimeout(hideTimer);
        hideTimer = null;
        updateDockVisibility();
    });
}

/** 显示 / 隐藏「最近使用的应用程序」（右键菜单选项） */
function toggleRecentApps() {
    writeDockFlag("dock.show.recent", "dock-show-recent", !showRecentApps, "dock-show-recent-change", (value) => {
        showRecentApps = value;
        scheduleRender();
    });
}

/** 切换程序坞位置：设置中枢可用时走它，否则按旧事件形态落盘并补发。 */
function setDockPosition(pos) {
    if (!POSITIONS.includes(pos)) return;
    const api = window.__settings;
    if (api && typeof api.set === "function" && typeof api.has === "function" && api.has("dock.position")) {
        api.set("dock.position", pos, { source: "dock" });
    } else {
        safeSetItem("dock-position", pos);
        window.dispatchEvent(new CustomEvent("dock-position-change", { detail: pos }));
    }
    // 事件监听器也会应用一次；这里直接应用保证隐私模式 / 事件异常时界面仍然跟随。
    dockPosition = pos;
    applyDockPosition();
    applyDockSize();
}

/** 切换程序坞放大 */
function toggleDockZoom() {
    writeDockFlag("dock.zoom", "dock-zoom", !dockZoom, "dock-zoom-change", (value) => {
        dockZoom = value;
    });
}

/** 切换运行指示灯 */
function toggleDockIndicators() {
    writeDockFlag("dock.show.indicators", "dock-show-indicators", !showIndicators, "dock-show-indicators-change", (value) => {
        showIndicators = value;
        applyIndicators();
    });
}

// ===== 构建单个容器（应用图标 / 文件夹栈 / 废纸篓） =====
/** 语言切换后刷新已渲染容器的人读名字；只改 aria-label，身份 data-app / img.alt 保持中文原名不动。 */
function refreshDockLabels() {
    document.querySelectorAll(".dock .container[data-app]").forEach((c) => {
        c.setAttribute("aria-label", displayNameFor(c.dataset.app));
    });
}
/** 图标加载完成：清掉骨架态并记住路径，供下次冷启动在清单就绪前直接使用。 */
function markIconLoaded(app, img) {
    img.classList.remove("is-pending", "is-loading");
    img.classList.add("is-loaded");
    const src = img.getAttribute("src");
    if (src) rememberIcon(app, src);
}

/**
 * 图标路径 → 绝对 URL。
 * img.src 读回的是浏览器解析后的绝对地址，拿 `./mods/...` 这类相对路径与它比较
 * 永远不相等，会把「本来就是同一张图」误判成需要重设，于是同一位置二次请求、
 * 已解码的图标被打回加载态。统一走这里解析，两处比较才有同一个基准。
 * @param {string} src 图标路径
 * @returns {string} 绝对 URL（无法解析时原样返回，交给 img 自己处理）
 */
function absoluteIconSrc(src) {
    if (!src) return "";
    try {
        return new URL(src, document.baseURI).href;
    } catch (err) {
        return src;
    }
}

/**
 * 设置图标 src，并维护「骨架 → 已加载」的视觉状态。
 * - 清单未就绪且没有静态 / 缓存路径时保持无 src 的骨架，不显示通用占位图；
 * - 绝对 URL 相同则不重设，避免一次对账就把已解码的图标打回加载态。
 * @param {string} app 应用身份名
 * @param {HTMLImageElement} img 图标
 * @param {string} src 目标路径
 * @param {{force?: boolean}} [opts] force=true 时忽略 URL 相同判断（错误降级用）
 */
function setIconSrc(app, img, src, opts = {}) {
    if (!src) return;
    const absolute = absoluteIconSrc(src);
    if (!opts.force && img.src === absolute) {
        // 缓存命中 / 预加载完成时不会再派发 load，直接补上已加载态。
        if (img.complete && img.naturalWidth > 0) markIconLoaded(app, img);
        return;
    }
    const pending = isIconPending(app, src);
    img.dataset.iconFallback = "";
    img.classList.toggle("is-pending", pending);
    img.classList.toggle("is-loading", !pending);
    img.classList.remove("is-loaded");
    if (pending) {
        // 不设置 src：空 src 会被解析成文档地址并触发一次无意义的请求。
        img.removeAttribute("src");
        return;
    }
    img.src = src;
    if (img.complete && img.naturalWidth > 0) markIconLoaded(app, img);
}

/** 按当前注册表 / 静态表重新解析并设置某图标的 src。 */
function updateIconSrc(app, img, opts = {}) {
    setIconSrc(app, img, getIcon(app), opts);
}

/**
 * 取（必要时创建）某个应用的图标容器。
 * 同一应用在所有区（收藏 / 运行 / 最近 / 废纸篓）共用同一个节点，
 * 跨区移动只搬 DOM，不重新创建 <img>，因此不会重新下载或解码图标。
 * @param {string} app 应用身份名
 * @returns {HTMLElement}
 */
function ensureIcon(app) {
    let container = iconNodes.get(app);
    if (container) return container;
    container = makeContainer(app);
    iconNodes.set(app, container);
    return container;
}

function makeContainer(app) {
    const container = document.createElement("div");
    container.classList.add("container");
    container.dataset.app = app;
    // 可及性：程序坞项本质是一个按钮，此前只是一个挂了 mouseup 的 <img> ——
    // 读屏只念得出 alt 文本、没有「按钮」语义，Tab 也走不到它。
    // 现在容器自己成为可聚焦的按钮，<img> 退回纯装饰（alt 清空，避免重复朗读图标名）。
    container.setAttribute("role", "button");
    container.setAttribute("tabindex", "0");
    // aria-label 是给人/读屏看的显示名，跟随语言；container.dataset.app 仍是跨语言不变的身份主键
    container.setAttribute("aria-label", displayNameFor(app));

    const img = document.createElement("img");
    img.alt = app;
    img.draggable = false;
    // 程序坞首屏必在视口内，懒加载只会把请求推后、拖慢首帧，所以明确 eager；
    // 解码放到异步线程，避免图标解码占住主线程的首屏预算。
    img.loading = "eager";
    img.decoding = "async";
    if (app === "下载") img.dataset.folder = "1";
    if (app === TRASH) trashImg = img;
    img.addEventListener("load", () => markIconLoaded(app, img));
    img.addEventListener("error", () => {
        // 错误降级：先尝试静态内置 / macOS 资源库路径，最后才落到通用占位图。
        // 缓存里指向已卸载插件的旧路径也会走到这里，随后 plugins-ready 的校准
        // 会把它换回真实图标或由剪枝移除整个条目。
        const failed = img.getAttribute("src") || "";
        if (img.dataset.iconFallback === "2") {
            img.classList.remove("is-loading");
            return;
        }
        const staticSrc = staticIconFor(app);
        if (staticSrc && staticSrc !== failed) {
            img.dataset.iconFallback = "1";
            setIconSrc(app, img, staticSrc, { force: true });
            return;
        }
        if (failed !== GENERIC_APP_ICON) {
            img.dataset.iconFallback = "2";
            forgetIcon(app);
            setIconSrc(app, img, GENERIC_APP_ICON, { force: true });
            return;
        }
        img.classList.remove("is-loading");
    });
    // 首轮图标：getIcon 先问注册表（已就绪时直接拿到清单里的真实路径，内置应用还能
    // 命中静态表），再退上次缓存；两者都没有才由 isIconPending 停在无 src 的骨架上。
    // 因此注册表就绪时首帧就是真图标，未就绪时也只会出现骨架而不会先请求占位图，
    // 后续 plugins-ready 的校准再按 src 是否变化决定要不要重设。
    updateIconSrc(app, img);
    // 名称已经由容器的 aria-label 读出，图片本身对读屏不再是独立信息；
    // 但 alt 仍是本模块的**主键**（对账 / 菜单 / getIcon 全靠 img.alt 反查应用名）。
    img.setAttribute("aria-hidden", "true");
    container.appendChild(img);

    const light = document.createElement("div");
    light.classList.add("light");
    light.setAttribute("aria-hidden", "true");
    if (appStatus[app] === true) light.classList.add("on");
    container.appendChild(light);
    // 运行状态得让读屏听得见：aria-hidden 的指示灯只是视觉表达。
    if (appStatus[app] === true) container.setAttribute("aria-pressed", "true");

    // 红色标记（Badge）容器
    const badge = document.createElement("div");
    badge.className = "badge";
    badge.style.display = "none";
    badge.setAttribute("aria-hidden", "true");
    container.appendChild(badge);

    if (!showIndicators) container.classList.add("no-indicator");

    bindClickEvent(img, light, app, container);
    bindDropOpen(container, app);
    return container;
}

/** 该应用此刻是否算「运行中」（窗口存在或已标记运行；启动台是 fullscreen 特例）。 */
function isAppRunning(app) {
    if (!app || app === TRASH) return false;
    if (app === "启动台") return appStatus[app] === true;
    return appStatus[app] === true || !!document.getElementById(app);
}

/**
 * 右键菜单上下文：把当前状态与动作打包给 dock/menu.js。
 * 每次打开菜单时现场读取，避免菜单项缓存旧状态。
 */
function makeMenuContext(app, img, light) {
    return {
        state: {
            running: isAppRunning(app),
            favorite: favorites.includes(app),
            protected: DOCK_PROTECTED.includes(app),
            showRecentApps,
            autoHide,
            dockZoom,
            showIndicators,
            dockPosition,
        },
        actions: {
            open: () => openApp(img, light, app),
            quit: () => quitApp(img, light, app),
            forceQuit: () => forceQuit(img, light, app),
            remove: () => removeFromDock(img, app),
            keep: () => keepInDock(app),
            emptyTrash: () => window.__menuActions?.emptyTrash?.(),
            openDownloads: () => navigateFinderTo("/下载"),
            openSettings: () => openSettings(),
            toggleRecents: () => toggleRecentApps(),
            setPosition: (pos) => setDockPosition(pos),
            toggleZoom: () => toggleDockZoom(),
            toggleIndicators: () => toggleDockIndicators(),
            toggleAutoHide: () => toggleAutoHide(),
            resetLayout: () => resetDockLayout(),
        },
    };
}

// 绑定应用图标的键盘激活与右键菜单；鼠标左键激活由 dock/drag.js 统一处理。
function bindClickEvent(img, light, app, container) {
    const open = () => {
        if (isDragging) return;
        if (img.dataset.folder) {
            openStack(app, img);
            return;
        }
        openApp(img, light, app);
    };
    // 供 dock/drag.js 在「按下 → 松开且未拖动」时调用，避免它自己再理解打开逻辑。
    container._dockOpen = open;
    // 键盘通路：挂了 tabindex 不等于能激活。Chrome 不会给非 <button> 元素
    // 自动合成 click，所以 Enter / Space 要自己接（Space 还要拦住页面滚动）。
    container.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
            e.preventDefault();
            open();
        }
    });
    container.addEventListener("contextmenu", (e) => {
        if (isNativeContextMenuEnabled() || isDragging) return;
        e.preventDefault();
        e.stopPropagation();
        hideTip();
        createContextMenu(e.clientX, e.clientY, buildAppMenuItems(app, makeMenuContext(app, img, light)));
    });
}

// 拖文件到图标上打开：仅接受来自操作系统/桌面的真实文件（Files 类型）拖放。
// 程序坞内部排序已改为 Pointer Events，不会再产生 HTML5 drag 事件。
function bindDropOpen(container, app) {
    container.addEventListener("dragover", (e) => {
        if (hasFiles(e)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            container.classList.add("drop-target");
        }
    });
    container.addEventListener("dragleave", () => container.classList.remove("drop-target"));
    container.addEventListener("drop", async (e) => {
        container.classList.remove("drop-target");
        if (!hasFiles(e)) return;
        e.preventDefault();
        // P0-4 废纸篓专属分支：拖 OS 文件进废纸篓 = 把内容写进 /废纸篓（真落库，
        // 图标随内容变满，访达可见、可清倒），而不是「用废纸篓打开」。
        if (app === TRASH) {
            const files = Array.from(e.dataTransfer.files || []);
            if (!files.length) return;
            const { dropFileToTrash } = await import("./trash.js");
            let okCount = 0;
            for (const f of files) {
                try { const r = await dropFileToTrash(f); if (r.ok) okCount++; } catch (err) { /* 权限未批：静默跳过，图标态刷新会如实反映 */ }
            }
            if (tip) {
                tip.textContent = i18n.t("dock.trashMoved", "已移入废纸篓（{n} 项）").replace("{n}", String(okCount));
                tip.style.display = "block";
                tip.style.opacity = "1";
                setTimeout(hideTip, 1400);
            }
            return;
        }
        const label = e.dataTransfer.files?.[0]?.name || e.dataTransfer.getData("text/plain") || "";
        if (!label) return;
        // 打开对应应用，并提示带入的文件（演示性：文件未真正交给应用，P1-16 再接）
        const img = container.querySelector("img");
        if (img) openApp(img, img.parentElement.querySelector(".light"), app);
        if (tip) {
            tip.textContent = i18n.t("dock.openWith", "用 {app} 打开 {name}（演示：文件尚未真正交给应用）")
                .replace("{app}", app).replace("{name}", label);
            tip.style.display = "block";
            tip.style.opacity = "1";
            // 定时后统一走 hideTip：停止位置跟随循环并清理透明度，
            // 避免残留 opacity 与后续悬浮提示互相干扰
            setTimeout(hideTip, 1400);
        }
    });
}

function hasFiles(e) {
    const dt = e.dataTransfer;
    if (!dt) return false;
    return Array.from(dt.types || []).includes("Files");
}

// 右键菜单已拆到 dock/menu.js；容器与空白区的绑定在 makeContainer / init 中完成。

let tipListenerBound = false;
let tipRafId = null; // 悬浮提示位置跟随循环句柄（全局唯一，避免 rAF 堆积）
let transientTipTimer = 0;
let transientTipUntil = 0;

/**
 * 在拖放落点附近短暂显示一条说明（如「运行中的应用不能从程序坞移除」）。
 * 复用 Dock 的 .tip 气泡，不改动全局鼠标跟随状态。
 * @param {string} text 文案
 * @param {number} x 视口横坐标
 * @param {number} y 视口纵坐标
 */
function showTransientTip(text, x, y) {
    if (!tip) return;
    hideTip();
    clearTimeout(transientTipTimer);
    tip.textContent = text;
    tip.style.display = "block";
    tip.style.visibility = "visible";
    tip.style.opacity = "1";
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    tip.style.left = `${Math.max(8, Math.min(x - width / 2, window.innerWidth - width - 8))}px`;
    tip.style.top = `${Math.max(8, y - height - 12)}px`;
    transientTipUntil = Date.now() + 1400;
    transientTipTimer = setTimeout(hideTip, 1400);
}

function hideTip() {
    currentImg = null;
    clearTimeout(transientTipTimer);
    transientTipTimer = 0;
    transientTipUntil = 0;
    if (tipRafId) { cancelAnimationFrame(tipRafId); tipRafId = null; }
    if (tipCheckRafId) { cancelAnimationFrame(tipCheckRafId); tipCheckRafId = null; }
    if (tip) {
        tip.style.display = "none";
        tip.style.visibility = "visible";
        tip.style.opacity = ""; // 清理拖放/菜单操作残留的透明度，避免下一次显示异常
    }
}

// 跟随当前图标实时位置：放大动画期间图标矩形不断变化，每帧重算保证提示始终贴住图标。
// 每次调用先取消旧帧再排新帧，无论触发多少次都只存在一条循环，杜绝 rAF 堆积。
//
// 成本要点：tip.offsetWidth / offsetHeight 是布局读取，写在它们之前会强制同步布局。
// 旧写法「读 offsetWidth → 写 left → 读 offsetHeight → 写 top」把读写交织了四轮，
// 等于每帧两次强制布局；而指针静止、图标也早已停住放大时，这个循环仍在逐帧跑。
// 现在：① 提示条尺寸只在文本变化时重新量一次（缓存）；② 全部几何读完才写样式；
// ③ 位置没变就不写；④ 标签页不可见时不排帧（同 surface.js scheduleRefresh 的处理，
// 隐藏页里 rAF 会被暂停，续帧等于空转）。
let tipMeasuredW = -1, tipMeasuredH = -1, tipMeasuredFor = null;
let tipLastX = null, tipLastY = null;
function updateTipPosition() {
    if (tipRafId) { cancelAnimationFrame(tipRafId); tipRafId = null; }
    if (!currentImg || !tip || dock.classList.contains("hidden")) return;
    const rect = currentImg.getBoundingClientRect();
    // 文本一变，提示条宽度就变（"访达" 与 "Safari浏览器" 差好几倍），此时必须重量
    const label = tip.textContent;
    if (tipMeasuredFor !== label) {
        tipMeasuredW = tip.offsetWidth;
        tipMeasuredH = tip.offsetHeight;
        tipMeasuredFor = label;
    }
    let nextLeft;
    let nextTop;
    if (dockPosition === "left" || dockPosition === "right") {
        // 侧边程序坞：提示紧贴图标旁（间距 8px），垂直居中于图标
        nextLeft = dockPosition === "left" ? rect.right + 8 : rect.left - tipMeasuredW - 8;
        nextTop = rect.top + rect.height / 2 - tipMeasuredH / 2;
    } else {
        // 底部程序坞：提示紧贴图标上方（间距 8px），利用实测高度避免箭头压住图标
        nextLeft = rect.left + rect.width / 2 - tipMeasuredW / 2;
        nextTop = rect.top - tipMeasuredH - 8;
    }
    if (nextLeft !== tipLastX || nextTop !== tipLastY) {
        tip.style.left = nextLeft + "px";
        tip.style.top = nextTop + "px";
        tipLastX = nextLeft;
        tipLastY = nextTop;
    }
    if (document.hidden) return;   // 隐藏页里 rAF 不派发，续帧只是把句柄空挂一帧
    tipRafId = requestAnimationFrame(updateTipPosition);
}

// 鼠标位置缓存：mousemove 只记录坐标，几何命中判断在 rAF 内执行（读写批处理防 FSL）
let tipMouseX = 0, tipMouseY = 0;
let tipCheckRafId = null;

// 悬浮提示几何命中（每帧至多一次，由 bindGlobalTip 的 rAF 调度驱动）
function checkTipHit() {
    tipCheckRafId = null;
    // 拖出被拒绝时显示的说明气泡有固定停留时间，不被下一次鼠标移动立刻顶掉。
    if (transientTipUntil && Date.now() < transientTipUntil) return;
    if (isDragging || !tip || dock.classList.contains("hidden")) { hideTip(); return; }
    // 右键菜单打开期间不显示 Dock 悬浮提示：菜单可能盖住程序坞，几何命中会
    // 把「指针在菜单上」误判成「悬停在图标上」，提示条（9999）会压在菜单（9620）上。
    if (document.querySelector("div.menu.contextmenu")) { hideTip(); return; }
    const r = dock.getBoundingClientRect();
    const overDock = tipMouseX >= r.left && tipMouseX <= r.right &&
        tipMouseY >= r.top && tipMouseY <= r.bottom;
    if (!overDock) { hideTip(); return; }
    // 几何命中：遍历程序坞图标，判断鼠标是否落在某图标矩形内。
    // 不依赖 e.target —— 当窗口（z-index 高于程序坞）覆盖程序坞区域时，
    // e.target 为窗口元素，closest 失效导致提示丢失；改用几何判断始终命中图标。
    // 复用 refreshIconList 维护的 imgs 缓存，避免每次鼠标移动都全量 querySelectorAll。
    let hit = null;
    for (const img of imgs) {
        const rect = img.getBoundingClientRect();
        if (tipMouseX >= rect.left && tipMouseX <= rect.right &&
            tipMouseY >= rect.top && tipMouseY <= rect.bottom) {
            hit = img;
            break;
        }
    }
    if (hit) {
        // 切换到新图标：更新应用名并显示；同一图标仅持续跟随位置（循环已运行）。
        // 文本变化会使 tip 宽度变化，故每次都重定位一次，避免水平位置错位。
        if (currentImg !== hit) {
            currentImg = hit;
            tip.textContent = displayNameFor(hit.alt);   // img.alt 是身份，提示显示当前语言名
            tip.style.display = "block";
            tip.style.visibility = "visible";
            tip.style.opacity = "";
            // 悬停即预取该应用的 HTML / CSS / 入口脚本，点击时启动更快。
            prefetchApp(hit.alt);
        }
        updateTipPosition();
    } else {
        hideTip();
    }
}

// 程序坞范围内**唯一**的 document 级 mousemove 监听。
// 在 document 上统一驱动：窗口（z-index 高于程序坞）覆盖程序坞区域时会截走
// dock 内 img 的 mouseover/mouseout，导致提示失效；document 级监听不受遮挡影响。
// 自动隐藏判定、悬浮提示、放大动画三者都挂在这一个监听上，各自只「记坐标 + 唤醒一帧」，
// 计算全部留在 rAF 里 —— 曾经放大动画自己另加了一个 document mousemove，
// 与这里的注释「合并到同一 mousemove，减少一个高频全局监听」自相矛盾，现已真合并。
const pointerMoveHooks = [];
function bindGlobalTip() {
    if (tipListenerBound) return;
    tipListenerBound = true;
    document.addEventListener("mousemove", (e) => {
        const x = e.clientX;
        const y = e.clientY;
        tipMouseX = x;
        tipMouseY = y;
        if (tipCheckRafId == null) tipCheckRafId = requestAnimationFrame(checkTipHit);
        if (autoHide) handleAutoHide(x, y);
        for (let i = 0; i < pointerMoveHooks.length; i += 1) pointerMoveHooks[i](x, y);
    });
}

// 供启动台调用：确保应用出现在程序坞（运行区）；已存在则忽略
export function addToDock(app) {
    const altName = app.endsWith("_Folder") ? app.split("_")[0] : app;
    if (document.querySelector(`#dock img[alt="${cssEscape(altName)}"]`)) return;
    if (favorites.includes(altName)) return;
    addToRunning(altName);
}

function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
}

// ===== 收藏项顺序读写 =====
function loadFavorites() {
    try {
        const saved = JSON.parse(localStorage.getItem(DOCK_ORDER_KEY));
        if (Array.isArray(saved) && saved.length) {
            favorites = saved
                .map(k => (k === "下载_Folder" ? "下载" : k))
                .filter(k => k !== "hr" && k !== TRASH);
            ensureProtectedFavorites();
            return;
        }
    } catch (e) { /* 忽略损坏缓存 */ }
    favorites = [...FAVORITE_DEFAULTS];
    ensureProtectedFavorites();
}

// 确保受保护应用（访达 / 启动台）始终驻留收藏区：
// 若用户曾在旧版本将其移除（已持久化进 localStorage 的收藏顺序），加载时自动补回默认相对位置，
// 并重新 saveFavorites() 持久化，避免每次加载都重复发现缺失。
function ensureProtectedFavorites() {
    let changed = false;
    DOCK_PROTECTED.forEach((app) => {
        if (favorites.includes(app)) return;
        const defIdx = FAVORITE_DEFAULTS.indexOf(app);
        if (defIdx < 0) return; // 受保护项不在默认集合则跳过（理论上不会发生）
        // 按 FAVORITE_DEFAULTS 的相对顺序插入：找到当前收藏里第一个默认位置更靠后的项，插到它前面
        let insertAt = favorites.length;
        for (let i = 0; i < favorites.length; i++) {
            const curDefIdx = FAVORITE_DEFAULTS.indexOf(favorites[i]);
            if (curDefIdx >= 0 && curDefIdx > defIdx) {
                insertAt = i;
                break;
            }
        }
        favorites.splice(insertAt, 0, app);
        changed = true;
    });
    if (changed) saveFavorites();
}

/**
 * 持久化收藏顺序（配额安全写入，理由见 safeSetItem）。
 * @returns {boolean} 是否写入成功
 */
function saveFavorites() {
    return safeSetItem(DOCK_ORDER_KEY, JSON.stringify(favorites));
}

// ===== 渲染：收藏 / 运行 / 最近使用 / 废纸篓共用同一批图标节点 =====
/**
 * 当前程序坞需要保留图标缓存的应用集合（用于 localStorage 提示剪枝）。
 * @returns {Set<string>}
 */
function collectDockApps() {
    return new Set([...favorites, ...recentApps, ...runningOrder, TRASH]);
}

/** 收集尚未被任何区引用、且已脱离文档的图标缓存，避免 Map 随运行历史无限增长。 */
function pruneIconNodes() {
    const keep = collectDockApps();
    iconNodes.forEach((container, app) => {
        if (keep.has(app)) return;
        if (container.isConnected) return;
        iconNodes.delete(app);
    });
}

/** 按 appStatus / 真实窗口刷新所有图标的运行指示灯与 aria-pressed。 */
function updateLights() {
    iconNodes.forEach((container, app) => {
        if (!container.isConnected) return;
        const light = container.querySelector(".light");
        if (light) light.classList.toggle("on", isAppRunning(app));
        if (isAppRunning(app)) container.setAttribute("aria-pressed", "true");
        else container.removeAttribute("aria-pressed");
        container.classList.toggle("no-indicator", !showIndicators);
    });
}

/**
 * 只有子节点序列真的变了才 replaceChildren。
 * 全量替换即使节点复用也会先摘再插，触发一次布局并打断 CSS 过渡。
 */
function syncSection(parent, nodes) {
    const kids = parent.children;
    if (kids.length === nodes.length) {
        let same = true;
        for (let i = 0; i < nodes.length; i += 1) {
            if (kids[i] !== nodes[i]) { same = false; break; }
        }
        if (same) return;
    }
    parent.replaceChildren(...nodes);
}

/**
 * 全量重排：只搬动已缓存的容器节点，不重建 <img>。
 * 各区归属完全由 favorites / runningOrder / recentApps / appStatus 决定，
 * 不再依赖「上一次哪个区有节点」这种手工搬运状态。
 */
function renderAll() {
    if (isDragging) {
        renderPendingWhileDragging = true;
        return;
    }
    renderScheduled = false;
    renderPendingWhileDragging = false;

    const running = runningOrder.filter((name) =>
        name !== TRASH && !favorites.includes(name) && isAppRunning(name)
    );
    runningOrder = running;

    syncSection(favoritesEl, favorites.map(ensureIcon));

    const runningSet = new Set(running);
    syncSection(runningEl, running.map(ensureIcon));

    const recents = showRecentApps
        ? recentApps
            .filter((name) => name !== TRASH && !favorites.includes(name) && !runningSet.has(name))
            .slice(0, 3)
        : [];
    syncSection(recentEl, recents.map(ensureIcon));

    syncSection(trashEl, [ensureIcon(TRASH)]);

    updateLights();
    refreshSeparators();
    refreshIconList();
    pruneIconNodes();
}

/** 合帧渲染：一次事件循环内的多次数据变化只重排一次 DOM。 */
function scheduleRender() {
    if (isDragging) {
        renderPendingWhileDragging = true;
        return;
    }
    if (renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(() => {
        if (!renderScheduled) return;
        if (isDragging) {
            renderScheduled = false;
            renderPendingWhileDragging = true;
            return;
        }
        renderAll();
    });
}

/**
 * 把应用补进运行区顺序并重绘。
 * 真实运行态仍由 syncRunningApps 以窗口为准收敛，这里只负责即时反馈。
 * @param {string} altName 应用身份名
 */
function addToRunning(altName) {
    if (favorites.includes(altName) || altName === TRASH) return;
    if (!runningOrder.includes(altName)) runningOrder.push(altName);
    scheduleRender();
}

// ===== 运行区 / 指示灯的唯一事实来源：按真实打开的窗口对账 =====
// 任何打开 / 关闭窗口的路径（程序坞收藏、启动台、应用商店卡片、菜单 openAppByName 等）
// 最终都落到这里，确保「程序坞检测当前运行的程序并显示」这一行为始终一致。
export function syncRunningApps() {
    // 仅统计真实存在且非关闭动画中的窗口（避免动画结束前的误判）。
    // 判据必须与窗口层同一份：isWindowElement 明确排除 .finderbar / .menu /
    // .dockcontainer / .desktop / .launchpad 里的伪 .window（window-manager.js 的注释
    // 记录过顶栏菜单里出现过 <p class="window">）。按类名全量遍历会把伪窗口
    // 认成运行中的应用：凭空点亮一个小圆点、写进 appStatus，点它又毫无反应。
    const openWins = Array.from(document.querySelectorAll("body > .window"))
        .filter(w => w.id && isWindowElement(w) && !w.classList.contains("closing"));
    const openIds = new Set(openWins.map(w => w.id));

    // 窗口真正显示（摘掉 wm-preparing）后才停止加载弹跳：窗口还在隐藏着量尺寸时
    // 继续跳是用户能看到的唯一「正在打开」反馈。显示时 window-manager 会再调一次
    // syncRunningApps，因此这里不会漏掉；动画本身的单次上限仍是失败兜底。
    const shownIds = new Set(openWins
        .filter(w => !w.classList.contains("wm-preparing"))
        .map(w => w.id));
    dock.querySelectorAll(".container img.opening").forEach(img => {
        if (shownIds.has(img.alt)) img.classList.remove("opening");
    });

    // 1) 收藏项运行状态：窗口存在即运行
    favorites.forEach(fav => {
        appStatus[fav] = openIds.has(fav);
    });

    // 2) 运行区顺序：保留既有相对顺序，新打开的应用追加到末尾；
    //    同时剔除已关闭 / 已转为收藏 / 废纸篓的条目。
    const nextRunning = [];
    runningOrder.forEach(id => {
        if (openIds.has(id) && !favorites.includes(id) && id !== TRASH) nextRunning.push(id);
    });
    openIds.forEach(id => {
        if (!favorites.includes(id) && id !== TRASH && !nextRunning.includes(id)) nextRunning.push(id);
    });
    runningOrder = nextRunning;

    // 3) 所有打开中的应用标记为运行态
    openIds.forEach(id => {
        if (id) appStatus[id] = true;
    });

    // 4) 首次出现的非收藏应用写进「最近使用」；重画交给收尾统一做。
    openIds.forEach(id => {
        if (!lastSyncIds.has(id) && !favorites.includes(id) && id !== TRASH) updateRecents(id, false);
    });

    // 5) 复位已关闭的非收藏应用的 appStatus
    lastSyncIds.forEach(id => {
        if (!openIds.has(id)) appStatus[id] = false;
    });
    lastSyncIds = new Set(openIds);

    // 6) 启动台专属对账：启动台根元素是 .launchpad（非 .window），上面的 .window 对账
    // 永远识别不到它，会把它误判为"未打开"并强制熄灭小圆点、复位 appStatus，造成
    // 「有小圆点无界面 / 有界面无圆点」的状态错位。这里以其 DOM 是否真实存在为准，
    // 单独同步其运行指示灯与 appStatus，保证界面与小圆点始终一致。
    const lpEl = document.querySelector(".launchpad");
    appStatus["启动台"] = !!(lpEl && lpEl.isConnected);

    // 7) 统一重排：关闭的应用会从运行区回到最近区，反之亦然。
    scheduleRender();
}

// ===== 最近使用的 App =====
function loadRecents() {
    try {
        const saved = JSON.parse(localStorage.getItem(RECENTS_KEY));
        if (Array.isArray(saved)) {
            recentApps = saved.filter(a => a !== TRASH && !favorites.includes(a));
            return;
        }
    } catch (e) { /* 忽略 */ }
    recentApps = [];
}

/**
 * 持久化「最近使用」列表（配额安全写入，理由见 safeSetItem）。
 * @returns {boolean} 是否写入成功
 */
function saveRecents() {
    return safeSetItem(RECENTS_KEY, JSON.stringify(recentApps));
}

function updateRecents(altName, rerender = true) {
    if (favorites.includes(altName) || altName === TRASH) return;
    recentApps = recentApps.filter(a => a !== altName);
    recentApps.unshift(altName);
    if (recentApps.length > 3) recentApps = recentApps.slice(0, 3);
    saveRecents();
    // 对账路径会为每个新开的应用连调一次这里，合并到一次微任务重排即可，
    // 不再每次 innerHTML="" 重建整个最近区。
    if (rerender) scheduleRender();
}

function renderRecents() {
    scheduleRender();
}

// 根据各区是否有内容刷新分隔线显隐（右键菜单的分隔符清理在 ui/contextMenu.js，
// 这里只负责程序坞分段之间的视觉分隔线）。
function refreshSeparators() {
    sepRunning.style.display = runningEl.children.length ? "" : "none";
    sepRecent.style.display = (showRecentApps && recentEl.children.length) ? "" : "none";
    // 废纸篓始终存在；分隔线也始终显示（macOS 同样用一条分隔线把废纸篓隔开）。
    sepTrash.style.display = trashEl.children.length ? "" : "none";
}

// ===== 初始化渲染 =====
function buildSections() {
    dock.appendChild(favoritesEl);
    dock.appendChild(sepRunning);
    dock.appendChild(runningEl);
    dock.appendChild(sepRecent);
    dock.appendChild(recentEl);
    dock.appendChild(sepTrash);
    dock.appendChild(trashEl);
}

function renderFavorites() {
    scheduleRender();
}

// 废纸篓容器由 renderAll 统一创建/挂载，不再单独渲染与绑定右键。

// 应用大小 / 位置 / 指示灯 等视觉设置
function applyDockSize() {
    // 写的是「回缩后的实际边长」，不是用户设定的 dockSize：
    // visibleFrame() 读的就是这条带的高度，两处必须同一个数。
    dock.style.setProperty("--dock-size", effectiveDockSize() + "px");
}

function applyDockPosition() {
    const pos = "pos-" + dockPosition;
    dock.classList.remove("pos-bottom", "pos-left", "pos-right");
    dock.classList.add(pos);
    const container = dock.parentElement; // .dockcontainer
    if (container) {
        container.classList.remove("pos-bottom", "pos-left", "pos-right");
        container.classList.add(pos);
    }
}

function applyIndicators() {
    dock.querySelectorAll(".container").forEach(c => c.classList.toggle("no-indicator", !showIndicators));
}

function init() {
    // 防止模块因 URL 缓存戳不一致（index.html 带 ?v= 而内部 import 不带）
    // 被浏览器当作两个模块重复执行，导致 Dock 被渲染两份。
    if (dock.dataset.initialized === "1") {
        console.warn("[dock] 已初始化过，跳过重复初始化");
        return;
    }
    dock.dataset.initialized = "1";

    // —— 阶段 1（同步）：骨架、核心收藏区 / 废纸篓、视觉设置 ——
    // 立即可见的 UI 必须同步渲染，避免首屏空窗；图标路径来自静态表，
    // 首帧就是真实 PNG，不会先显示通用占位图。
    buildSections();
    loadFavorites();
    loadRecents();
    renderAll();
    applyDockPosition();
    applyIndicators();

    // —— 阶段 2（空闲调度）：非关键渲染与首次窗口对账 ——
    // renderRecents 与 syncRunningApps 涉及多次 querySelectorAll + DOM 构建，
    // 是 init 长任务的主要来源，改到主线程空闲期执行；
    // renderRecents 内部自带刷新分割线 / 图标列表，不依赖阶段 1 的 refresh* 结果。
    scheduleIdle(() => {
        renderRecents();
        syncRunningApps();
    });

    // —— 阶段 3（同步注册）：事件监听与交互系统 ——
    // addEventListener 本身开销极小，同步注册保证交互立即可用。

    dock.addEventListener("animationend", () => {
        dock.style.animation = "none";
        dock.style.transition = DOCK_TRANSITION;
    }, { once: true });

    window.addEventListener("dock-autohide-change", (e) => {
        autoHide = readFlag(e.detail, false);
        clearTimeout(hideTimer);
        hideTimer = null;
        updateDockVisibility();
    });
    window.addEventListener("dock-zoom-change", (e) => {
        dockZoom = readFlag(e.detail, true);
    });
    window.addEventListener("dock-size-change", (e) => {
        // 事件 detail 是外部入口：500 这样的值先钳到 128 再上屏
        dockSize = readNumber(e.detail, SIZE_MIN, SIZE_MAX, SIZE_DEFAULT);
        applyDockSize();
        // 同步放大动画基准：清除放大动画残留的 inline 尺寸，图标立即采用新 --dock-size
        const base = effectiveDockSize();
        dock.querySelectorAll(".container img").forEach(img => {
            setIconSize(img, base);
            img.style.width = img.style.height = "";
        });
    });
    window.addEventListener("dock-position-change", (e) => {
        dockPosition = readEnum(e.detail, POSITIONS, POSITION_DEFAULT);
        applyDockPosition();
        // 换边即换可用带的轴向（横向视口宽 → 纵向视口高），回缩上限要跟着重算
        applyDockSize();
    });
    window.addEventListener("dock-minimize-effect-change", (e) => {
        minimizeEffect = readEnum(e.detail, MINIMIZE_EFFECTS, MINIMIZE_EFFECT_DEFAULT);
    });
    window.addEventListener("dock-zoom-amount-change", (e) => {
        dockZoomAmount = readNumber(e.detail, ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT);
    });
    window.addEventListener("dock-show-indicators-change", (e) => {
        showIndicators = readFlag(e.detail, true);
        applyIndicators();
    });
    window.addEventListener("dock-show-recent-change", (e) => {
        showRecentApps = readFlag(e.detail, true);
        renderRecents();
    });
    // 收藏顺序 / 最近使用列表：设置中枢先落盘再按事件名广播（系统设置的
    // 「恢复程序坞默认顺序」就走这条路），这里以存储为事实来源重新加载并重绘。
    window.addEventListener("dock-order-change", () => {
        loadFavorites();
        renderFavorites();
        syncRunningApps();
    });
    window.addEventListener("dock-recents-change", () => {
        loadRecents();
        renderRecents();
        syncRunningApps();
    });
    // P0-4：满/空态由 /废纸篓 内容驱动（内核 trash.js 广播 trash-changed）
    const refreshTrashFullness = async () => {
        let full = false;
        try {
            const { isTrashNotEmpty } = await import("./trash.js");
            full = await isTrashNotEmpty();
        } catch (err) { /* 权限未批时保持现图，不谎报 */ }
        trashFull = full;
        if (trashImg) {
            setIconSrc(TRASH, trashImg, getTrashIconForFullness(getTrashKey(), trashFull));
        }
    };
    window.addEventListener("trash-changed", refreshTrashFullness);
    window.addEventListener("trash-icon-change", () => {
        if (trashImg) {
            setIconSrc(TRASH, trashImg, getTrashIconForFullness(getTrashKey(), trashFull));
        }
    });
    // 首帧先按内容刷一次（图标创建后 trashImg 才有值，放渲染回调之后）
    refreshTrashFullness();
    // 不再在这里额外 setTimeout 写一次 transition：init 末尾的
    // emitDock("dock-autohide-change") 会走 updateDockVisibility()，那里已经同步写上了，
    // 这里再排一个 1 秒的定时器只是重复同一件事。

    // 指针拖拽：收藏区重排 + 拖出隐藏（仅未运行且非受保护应用）。
    // 不再依赖 HTML5 Drag & Drop —— 原生拖拽无法稳定显示普通箭头光标。
    if (dockDrag) dockDrag.destroy();
    dockDrag = createDockDrag({
        dock,
        favoritesEl,
        getPosition: () => dockPosition,
        canDrag: (app) => app !== TRASH,
        canHide: (app) => app !== TRASH && !DOCK_PROTECTED.includes(app) && !isAppRunning(app),
        onReorder: (keys) => {
            const next = keys.filter((key) => key && key !== TRASH);
            if (next.length === favorites.length && next.every((key, i) => key === favorites[i])) return;
            favorites = next;
            saveFavorites();
        },
        // 运行区 / 最近使用的图标拖回收藏区 = 固定到程序坞（macOS 的常见手势）。
        onPin: (app) => keepInDock(app),
        onHide: (app) => removeFromDock(null, app),
        onHideRejected: (app, x, y) => {
            showTransientTip(i18n.t("dock.runningCannotRemove", "正在运行的应用不能从程序坞移除"), x, y);
        },
        onActivate: (container) => {
            if (typeof container._dockOpen === "function") container._dockOpen();
        },
        onDragStateChange: (active) => {
            isDragging = active;
            if (active) {
                hideTip();
                closeStack();
                // 自动隐藏开启时，拖出程序坞不能让它同时淡出。
                if (autoHide) {
                    dock.classList.remove("hidden");
                    dock.classList.add("show");
                }
            } else if (renderPendingWhileDragging) {
                renderAll();
            }
            // 拖拽期间放大动画按基准尺寸收敛；结束 / 开始时立即校准一帧。
            requestDockFrame?.();
        },
    });

    // 程序坞空白处 / 分隔线右键菜单（容器自身的 contextmenu 会 stopPropagation）
    dock.addEventListener("contextmenu", (e) => {
        if (isNativeContextMenuEnabled() || isDragging) return;
        if (e.target.closest?.(".container")) return;
        e.preventDefault();
        e.stopPropagation();
        hideTip();
        createContextMenu(e.clientX, e.clientY, buildDockMenuItems(makeMenuContext("", null, null)));
    });

    // 废纸篓分段的空白区域（图标之外的 padding）也按废纸篓菜单处理
    trashEl.addEventListener("contextmenu", (e) => {
        if (isNativeContextMenuEnabled() || isDragging) return;
        if (e.target.closest?.(".container")) return;
        e.preventDefault();
        e.stopPropagation();
        hideTip();
        const container = ensureIcon(TRASH);
        const img = container.querySelector("img");
        const light = container.querySelector(".light");
        createContextMenu(e.clientX, e.clientY, buildAppMenuItems(TRASH, makeMenuContext(TRASH, img, light)));
    });

    // 键盘聚焦同样触发预取，保证只用键盘启动应用也能享受预热。
    dock.addEventListener("focusin", (e) => {
        const container = e.target.closest?.(".container[data-app]");
        if (container) prefetchApp(container.dataset.app);
    });

    // 键盘重排：聚焦收藏图标后 Alt + 方向键在收藏区内前后移动，顺序与鼠标拖拽同源持久化。
    dock.addEventListener("keydown", (e) => {
        if (isDragging || !e.altKey) return;
        const container = e.target.closest?.(".container[data-app]");
        if (!container || container.parentElement !== favoritesEl) return;
        const vertical = dockPosition === "left" || dockPosition === "right";
        const back = vertical ? "ArrowUp" : "ArrowLeft";
        const forward = vertical ? "ArrowDown" : "ArrowRight";
        if (e.key !== back && e.key !== forward) return;
        const app = container.dataset.app;
        const index = favorites.indexOf(app);
        if (index < 0) return;
        const target = index + (e.key === forward ? 1 : -1);
        if (target < 0 || target >= favorites.length) return;
        e.preventDefault();
        e.stopPropagation();
        favorites.splice(index, 1);
        favorites.splice(target, 0, app);
        saveFavorites();
        renderAll();
        // renderAll 会摘挂节点，焦点会掉回 body：下一帧还回同一容器。
        queueMicrotask(() => {
            if (container.isConnected) {
                try { container.focus({ preventScroll: true }); } catch (err) { /* 不可聚焦 */ }
            }
        });
    });

    // 预热形变模块，避免首次最小化时才动态 import 三个文件（点击→首帧多出一次模块加载）。
    const warmGenie = () => { import("./wm/genie-effect.js").catch(() => {}); };
    if (typeof requestIdleCallback === "function") requestIdleCallback(warmGenie, { timeout: 2500 });
    else setTimeout(warmGenie, 1200);

    bindKeyboardNav();
    bindGlobalTip();
    bindAppleMenuRecent();

    // 视口变窄时重算回缩上限（图标数量没变、可用带宽变了，同样会溢出）。
    // rAF 合帧：拖浏览器边缘时 Chrome 连续派发 resize，逐次全量写内联尺寸是白干的活。
    let dockResizeQueued = false;
    window.addEventListener("resize", () => {
        if (dockResizeQueued) return;
        dockResizeQueued = true;
        requestAnimationFrame(() => {
            dockResizeQueued = false;
            applyDockSize();
        });
    });

    // 观察 body 顶层子节点的增删（窗口的注入 / 移除均发生在 body 顶层），
    // 让程序坞实时「检测正在运行的程序」并刷新运行区与指示灯。
    //
    // 必须按 record 过滤，不能一有增删就全量对账：body 上增删的东西远不止窗口 ——
    // 拖动预览框 #deskly-tile-preview 与交互遮罩 #deskly-interaction-shield 都是在拖动
    // 过程中反复挂 / 摘到 body 上的（window-manager.js 的 showPreview / installShield），
    // 右键菜单、弹层 portal、文件夹栈同理。不过滤的话，拖一扇窗口划过几个吸附区就会
    // 触发同等次数的全量对账（若干次 querySelectorAll + 每个收藏项一次 querySelector +
    // 重建最近区），跟放大动画抢同一批帧。
    let dockSyncScheduled = false;
    const touchesWindow = (node) => node.nodeType === 1
        && (node.classList.contains("window") || !!node.querySelector(".window"));
    const dockSyncObserver = new MutationObserver((records) => {
        const relevant = records.some((r) => {
            for (let i = 0; i < r.addedNodes.length; i += 1) {
                if (touchesWindow(r.addedNodes[i])) return true;
            }
            for (let i = 0; i < r.removedNodes.length; i += 1) {
                if (touchesWindow(r.removedNodes[i])) return true;
            }
            return false;
        });
        if (!relevant || dockSyncScheduled) return;
        dockSyncScheduled = true;
        Promise.resolve().then(() => {
            dockSyncScheduled = false;
            syncRunningApps();
        });
    });
    dockSyncObserver.observe(document.body, { childList: true });

    DockAnimation();
    // 启动时按真实存储状态同步放大效果，避免硬编码强制开启导致与设置页开关状态不一致
    emitDock("dock-autohide-change", autoHide);
    emitDock("dock-zoom-change", dockZoom);

    // 内置应用首帧已经由 dock/icons.js 的静态表命中真实 PNG；这里在注册表就绪后
    // 统一校准一次（ZIP 插件从骨架切到清单图标、品牌包切换、清单路径变化）。
    window.addEventListener("plugins-ready", refreshIconsFromRegistry);
    // ZIP 插件在运行期安装 / 卸载同样要校准图标（合并成一次，避免连续广播重复刷）。
    document.addEventListener("plugin-registered", scheduleIconRefresh);
    document.addEventListener("plugin-unregistered", scheduleIconRefresh);
    // 办公套件切换品牌包（iWork/Office）时重取图标
    window.addEventListener("deskly-brand-pack-changed", refreshIconsFromRegistry);
    document.addEventListener("languagechange", refreshDockLabels);
}

// ===== 自动隐藏 =====
// 亚克力禁忌：.dock 带 backdrop-filter，显隐禁用 transform（会提升 3D 合成层致毛玻璃退化为白色矩形），
// 只通过 .hidden / .show class 切换 opacity + visibility，Dock 位置不变、原地淡入淡出。
// mousemove 已由 bindGlobalTip 统一驱动（减少一个高频全局监听），此处仅实现判定逻辑。
function handleAutoHide(x, y) {
    // 拖拽中不能让程序坞自动收起：用户正把图标拖出 / 拖回，收起会让落点失效。
    if (isDragging) return;
    const isAtEdge = isNearDockEdge(x, y);
    if (isAtEdge) {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        if (dock.classList.contains("hidden")) {
            dock.classList.remove("hidden");
            dock.classList.add("show");
        } else if (!dock.classList.contains("show")) {
            dock.classList.add("show");
        }
    } else {
        if (dock.classList.contains("show") && !dock.classList.contains("hidden") && !hideTimer) {
            hideTimer = setTimeout(() => {
                dock.classList.remove("show");
                dock.classList.add("hidden");
                hideTip(); // 程序坞隐藏时同步收起悬浮提示，避免鼠标静止时残留
                hideTimer = null;
            }, 600);
        }
    }
}

function isNearDockEdge(x, y) {
    if (dockPosition === "left") return x < 30;
    if (dockPosition === "right") return window.innerWidth - x < 30;
    return window.innerHeight - y < 30;
}

function updateDockVisibility() {
    dock.style.transition = DOCK_TRANSITION;
    dock.style.animation = "none";
    if (autoHide) {
        dock.classList.add("hidden");
        dock.classList.remove("show");
        hideTip(); // 程序坞隐藏时同步收起悬浮提示
    } else {
        dock.classList.remove("hidden", "show");
    }
}

// ===== 放大动画（跟随设置的大小与放大程度） =====
// 尺寸状态存放在 WeakMap 而非元素属性上：HTMLImageElement.currentWidth 是只读属性，
// 在严格模式（ES Module）下写入会抛 TypeError，一次写入即中断整条动画链。
const iconSizes = new WeakMap();

function setIconSize(img, width) {
    iconSizes.set(img, { width, target: width });
}

function DockAnimation() {
    const mouseRange = 200;
    const lerpSpeed = 0.3;
    const isSide = () => dockPosition === "left" || dockPosition === "right";
    // 图标缓存：Dock 图标数量不变时复用数组，避免动画帧内反复 querySelectorAll + 数组分配
    let iconsCache = [];
    const collectIcons = () => {
        const cur = dock.querySelectorAll(".container img");
        // 数量相等也可能是整体替换（关掉一个应用的同时打开另一个），
        // 只比长度会让缓存继续指向已脱离文档的节点，那些图标从此不再跟随指针。
        if (cur.length !== iconsCache.length || iconsCache.some((img) => !img.isConnected)) {
            iconsCache = Array.from(cur);
        }
        return iconsCache;
    };
    const getSize = (img, base) => {
        let size = iconSizes.get(img);
        if (!size) {
            size = { width: base, target: base };
            iconSizes.set(img, size);
        }
        return size;
    };
    // 鼠标坐标：mousemove 只记录，布局读取与尺寸写入统一在动画帧内完成（读写批处理防 FSL）
    let mouseX = -1, mouseY = -1;
    let frameId = null;
    const resetPointer = () => {
        mouseX = -1;
        mouseY = -1;
        requestFrame();
    };
    const requestFrame = () => {
        if (frameId == null) frameId = requestAnimationFrame(animation);
    };
    requestDockFrame = requestFrame;
    // 放大效果的鼠标坐标：不再自己另加一个 document mousemove，而是挂进
    // bindGlobalTip 那一个全局监听（见 pointerMoveHooks）。窗口覆盖程序坞时
    // document 级监听同样不受遮挡影响，行为不变，少一条高频监听。
    pointerMoveHooks.push((x, y) => {
        mouseX = x;
        mouseY = y;
        requestFrame(); // 仅唤醒动画循环，计算留到帧内执行
    });
    // 指针离开文档或窗口失焦时不再有 mousemove，需主动归位，否则图标停留在放大态
    document.addEventListener("mouseleave", resetPointer);
    window.addEventListener("blur", resetPointer);
    // 设置变化（开关 / 尺寸 / 放大程度）时唤醒一帧校准
    window.addEventListener("dock-zoom-change", requestFrame);
    window.addEventListener("dock-size-change", requestFrame);
    window.addEventListener("dock-zoom-amount-change", requestFrame);

    function animation() {
        frameId = null;
        // 每次取最新设置，避免闭包捕获旧尺寸 / 旧放大程度。
        // 基准边长必须走 effectiveDockSize()：这里是**内联**写 img 的 width/height，
        // 内联优先级高于 --dock-size，若按未回缩的 dockSize 写就把回缩整个作废、
        // 图标再次溢出到 body 的 overflow:hidden 外面。
        const baseWidth = effectiveDockSize();
        const maxScale = dockZoomAmount;
        const icons = collectIcons();
        const mouseActive = dockZoom && mouseX >= 0 && !isDragging;
        // 1) 目标尺寸计算（读 rect；所有读取完成后才进入写阶段，避免读写交织触发强制同步布局）
        // 命中区沿溢出方向外扩一个最大放大余量：图标超出底栏盒子后仍算"悬在程序坞上"，
        // 否则鼠标移到悬出部分会立刻判定离开→图标缩回→命中区消失，边缘反复抖动。
        const slack = baseWidth * (maxScale - 1);
        const overDock = mouseActive && (() => {
            const r = dock.getBoundingClientRect();
            let left = r.left, right = r.right, top = r.top;
            if (!isSide()) top -= slack;              // 底部程序坞：图标向上溢出
            else if (dockPosition === "left") right += slack; // 左侧：图标向右溢出
            else left -= slack;                       // 右侧：图标向左溢出
            return mouseX >= left && mouseX <= right && mouseY >= top && mouseY <= r.bottom;
        })();
        const mouse = isSide() ? mouseY : mouseX;
        icons.forEach((img) => {
            const size = getSize(img, baseWidth);
            if (!overDock) { size.target = baseWidth; return; }
            // 底部程序坞按水平距离、侧边程序坞按垂直距离计算放大
            const rect = img.getBoundingClientRect();
            const center = isSide() ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
            const distance = Math.abs(mouse - center);
            if (distance < mouseRange) {
                const distanceRatio = distance / mouseRange;
                const scale = 1 + (maxScale - 1) * Math.sin((1 - distanceRatio) * Math.PI / 2);
                size.target = baseWidth * scale;
            } else {
                size.target = baseWidth;
            }
        });
        // 2) 插值写入（写 style）：全部图标到位后停止循环，杜绝 rAF 空转与每帧数组分配
        let animating = false;
        icons.forEach((img) => {
            const size = getSize(img, baseWidth);
            const diff = size.target - size.width;
            if (Math.abs(diff) > 0.1) {
                size.width += diff * lerpSpeed;
                img.style.width = `${size.width}px`;
                img.style.height = `${size.width}px`;
                animating = true;
            }
        });
        if (animating) requestFrame();
    }
    requestFrame(); // 初始校准一帧（让刚注入的图标尺寸与当前设置一致）
}

// ===== 文件夹栈（Stacks）：点击下载图标展开文件网格 =====
let activeStackApp = null; // 当前栈对应的图标名，用于锚点二次点击收起
function openStack(app, img) {
    // 锚点再点一次 = 收起。原实现无条件"先关后开"，且全局关闭监听挂在捕获阶段
    // 先于图标自身处理，点图标永远是"关了又开"，栈无法用自己的图标关闭
    // （与 datetime_popover 的 _attachGlobalClose 同一问题模式、同一修法）。
    if (activeStack && activeStackApp === app) {
        closeStack();
        return;
    }
    closeStack();
    const stack = document.createElement("div");
    stack.className = "dock-stack";
    const header = document.createElement("div");
    header.className = "dock-stack-header";
    header.textContent = i18n.t("dock.downloads", "下载");
    stack.appendChild(header);
    const grid = document.createElement("div");
    grid.className = "dock-stack-grid";
    stack.appendChild(grid);

    // 尝试读取真实下载文件夹内容；失败则降级为占位
    loadStackItems(grid);

    document.body.appendChild(stack);
    const rect = img.getBoundingClientRect();
    const stackW = 280;
    const left = Math.max(10, Math.min(rect.left + rect.width / 2 - stackW / 2, window.innerWidth - stackW - 10));
    stack.style.left = (dockPosition === "left" ? rect.right + 12
        : dockPosition === "right" ? rect.left - stackW - 12 : left) + "px";
    stack.style.bottom = (window.innerHeight - rect.top + 12) + "px";
    activeStack = stack;
    activeStackApp = app;

    // 点击空白处关闭
    setTimeout(() => {
        document.addEventListener("click", closeStackOnOutside, true);
    }, 0);
}

function closeStackOnOutside(e) {
    // 捕获阶段先于图标自身的 mouseup/click：必须放过锚点图标上的点击，
    // 否则点图标会"先关（本回调）再开（mouseup 里 openStack）"，永远收不起。
    if (e.target.closest && e.target.closest("[data-folder]")) return;
    if (activeStack && !activeStack.contains(e.target)) {
        closeStack();
    }
}

function closeStack() {
    if (activeStack) {
        activeStack.remove();
        activeStack = null;
        activeStackApp = null;
    }
    // removeEventListener 幂等：即使栈已丢也解绑一次，杜绝监听残留
    document.removeEventListener("click", closeStackOnOutside, true);
}

function loadStackItems(grid) {
    // 下载堆栈读根目录下的下载夹：路径取自 VFS.TOP_FOLDERS，不在这里写字面量。
    // VFS 导出的是 list(path)，此前写的 listFiles("download") 不存在，三元守卫使堆栈永远只显示占位项。
    import("./vfs.js")
        .then(({ VFS }) => VFS.init().then(() => VFS.list(VFS.TOP_FOLDERS.downloads.path)))
        .then((files) => {
            const list = Array.isArray(files) ? files : [];
            if (!list.length) {
                grid.appendChild(makeStackItem(i18n.t("dock.stackEmpty", "下载文件夹为空或尚未授权"), null, true));
                return;
            }
            list.slice(0, 9).forEach((f) => grid.appendChild(makeStackItem(f.name || f, f)));
        })
        .catch((err) => {
            console.warn("[dock] 下载堆栈读取失败:", err);
            grid.appendChild(makeStackItem(i18n.t("dock.stackUnavailable", "下载文件夹不可用"), null, true));
        });
}

function makeStackItem(name, file, disabled) {
    const item = document.createElement("div");
    item.className = `dock-stack-item${disabled ? " disabled" : ""}`;
    const icon = document.createElement("img");
    icon.src = DOWNLOAD_ICON;
    // 栈项只在弹出时创建且立即可见，同样不需要懒加载；解码保持异步。
    icon.loading = "eager";
    icon.decoding = "async";
    icon.style.width = "36px";
    icon.style.height = "36px";
    const label = document.createElement("span");
    label.textContent = String(name);
    item.appendChild(icon);
    item.appendChild(label);
    if (!disabled) {
        item.addEventListener("click", () => {
            // 最佳努力：用访达打开该文件所在路径
            if (window.__menuActions && window.__menuActions.openAppByName) {
                window.__menuActions.openAppByName("访达");
            }
            closeStack();
        });
    }
    return item;
}

// ===== 键盘导航（Fn+Control+F3 进入程序坞） =====
let dockNavActive = false;
let dockNavItems = [];
let dockNavIndex = 0;

function bindKeyboardNav() {
    document.addEventListener("keydown", (e) => {
        // ⌃⌘F3 进入程序坞键盘导航：⌃F3 与 ⌘F3 都可能被系统/浏览器占用，改成双修饰键，
        // 与 keyboard.js 的键位表保持一致（F-22 的键位归属调整）。
        if (e.key === "F3" && e.ctrlKey && e.metaKey && !e.altKey) {
            e.preventDefault();
            enterDockNav();
            return;
        }
        if (!dockNavActive) return;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
            e.preventDefault();
            moveDockNav(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
            e.preventDefault();
            moveDockNav(-1);
        } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activateDockNav();
        } else if (e.key === "Escape") {
            e.preventDefault();
            exitDockNav();
        }
    });
    // 任意鼠标点击退出导航
    document.addEventListener("mousedown", () => { if (dockNavActive) exitDockNav(); }, true);
}

function collectNavItems() {
    return Array.from(dock.querySelectorAll(".container img"));
}

function enterDockNav() {
    dockNavActive = true;
    dockNavItems = collectNavItems();
    if (!dockNavItems.length) return;
    dockNavIndex = 0;
    highlightDockNav();
}

function moveDockNav(dir) {
    if (!dockNavItems.length) return;
    dockNavIndex = (dockNavIndex + dir + dockNavItems.length) % dockNavItems.length;
    highlightDockNav();
}

function highlightDockNav() {
    dockNavItems.forEach(i => i.parentElement.classList.remove("dock-focused"));
    const img = dockNavItems[dockNavIndex];
    if (img) {
        img.parentElement.classList.add("dock-focused");
        img.scrollIntoView({ block: "nearest", inline: "nearest" });
        // 自造高亮类不能替代真实焦点：不 focus 的话读屏仍停在页面顶部，
        // 且浏览器自己的 Tab 顺序与这套高亮是两套状态，退出导航后焦点会跳回原点。
        if (typeof img.parentElement.focus === "function") img.parentElement.focus();
    }
}

function activateDockNav() {
    const img = dockNavItems[dockNavIndex];
    if (img) {
        const light = img.parentElement.querySelector(".light");
        if (img.dataset.folder) openStack(img.alt === "下载" ? "下载" : img.alt, img);
        else openApp(img, light, img.alt);
    }
    exitDockNav();
}

function exitDockNav() {
    dockNavActive = false;
    dockNavItems.forEach(i => i.parentElement.classList.remove("dock-focused"));
    dockNavItems = [];
}

// ===== Apple 菜单「最近使用的项目」子菜单 =====
function bindAppleMenuRecent() {
    // 用稳定的 data-action 定位，而不是匹配可见文本：
    // 文本一旦随语言变化（i18n.t），这个绑定就静默失效。
    const item = document.querySelector('.menu[menu="logo"] p[data-action="recent-items"]');
    if (!item) return;
    item.style.cursor = "pointer";
    item.addEventListener("click", (e) => {
        e.stopPropagation();
        const items = [];
        if (recentApps.length === 0) {
            items.push({ label: i18n.t("dock.noRecentItems", "（无最近使用的项目）"), disabled: true });
        } else {
            recentApps.forEach(app => {
                items.push({
                    label: app,
                    action: () => {
                        if (window.__menuActions && window.__menuActions.openAppByName) {
                            window.__menuActions.openAppByName(app);
                        }
                    },
                });
            });
        }
        createContextMenu(e.clientX, e.clientY, items);
    });
}

// ===== 对外暴露的程序坞桥接接口（供 window.js 最小化动画等调用） =====
function getDockIconImg(app) {
    return dock.querySelector(`.container img[alt="${cssEscape(app)}"]`);
}

// 最小化窗口吸入程序坞。
// 优先走「神奇效果」（wm/genie-effect.js：快照 + 覆盖层条带形变，绝不碰窗口
// 自身的 transform）；快照超时 / 几何不成立 / 减少动态效果开启时 resolve(false)，
// 统一落回缩放淡出兜底 —— 兜底路径必须始终可达，绝不让窗口瞬间消失。
function minimizeToDock(winEl, appName) {
    const iconEl = getDockIconImg(appName);
    if (winEl._wmRevealAnim) {
        winEl._wmRevealAnim.cancel();
        winEl._wmRevealAnim = null;
    }
    winEl._minimized = true;
    // 运行指示灯保持点亮
    const light = iconEl ? iconEl.parentElement.querySelector(".light") : null;
    if (light) light.classList.add("on");
    if (minimizeEffect === "scale") {
        fallBackFadeOut(winEl);
        return;
    }
    import("./wm/genie-effect.js")
        .then((m) => m.minimizeGenie(winEl, iconEl))
        .catch(() => false)
        .then((played) => {
            // 快照是异步的：期间用户可能已把窗口还原，此时不能再补淡出，
            // 否则会把刚揭开的窗口重新按进坞里（旧版 _hideTimer 同款竞态）。
            if (!played && winEl._minimized) fallBackFadeOut(winEl);
        });
}

/** 缩放样式的还原淡入：160ms、前段快速拉起，只动 opacity，不碰亚克力窗口的 transform。 */
function playQuickReveal(winEl) {
    if (document.documentElement.getAttribute("data-reduce-motion") === "on") return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof winEl.animate !== "function") return;
    if (winEl._wmRevealAnim) winEl._wmRevealAnim.cancel();
    const anim = winEl.animate(
        [
            { opacity: 0 },
            { opacity: 0.94, offset: 0.55 },
            { opacity: 1 },
        ],
        { duration: 160, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    winEl._wmRevealAnim = anim;
    anim.addEventListener("finish", () => {
        if (winEl._wmRevealAnim === anim) winEl._wmRevealAnim = null;
    }, { once: true });
}

// 从程序坞还原窗口。
// 有缓存快照时反向播放神奇效果（播放期间保持隐藏，播完揭开置顶）；
// 没有快照 / 动画失败则立即显示 —— 兜底永远是「直接显示 + 置顶」。
function restoreFromDock(winEl, appName) {
    winEl._minimized = false;
    // 取消尚未执行的隐藏定时器（见 fallBackFadeOut）
    clearTimeout(winEl._hideTimer);
    winEl._hideTimer = null;
    // 先按住：genie 模块若是本次会话首次动态 import，取模块有网络延迟，
    // 不预隐藏会在覆盖层接管前闪出一帧真窗；播不成就由 reveal() 立即揭开。
    winEl.style.display = "none";
    const iconEl = getDockIconImg(appName);
    const reveal = () => {
        // 播放期间可能又被最小化：状态翻回去了就不抢显隐权
        if (winEl._minimized) return;
        // 先关掉 CSS 自动重播的入场动画：神奇效果已经把它送到落点，不再补第二个
        // 淡入；缩放样式则由下面显式播放一次 160ms 的快速淡入。
        winEl.classList.add("wm-shown");
        winEl.style.display = "";
        winEl.classList.remove("minimized");
        if (minimizeEffect !== "genie") playQuickReveal(winEl);
        bringToFront(winEl, appName);
    };
    if (minimizeEffect !== "genie") {
        reveal();
        return;
    }
    import("./wm/genie-effect.js")
        .then((m) => m.restoreGenie(winEl, iconEl))
        .catch(() => false)
        .then(reveal);
}

// 兜底隐藏调度：只负责在淡出结束后补 display:none，不再自己写 transition。
// 淡出本身属于 .window.minimized（window.css）：那条规则里带 `visibility 0s linear 0.24s`，
// 而内联 transition 优先级更高，一写下去就把 visibility 延迟整段抹掉 ——
// 第一帧就不可见，本函数原本承诺的「绝不瞬间消失」反而从未成立。
// 同时早还原也不再泄漏：既然不覆盖，就没有被覆盖下去的东西需要还原
// （旧写法把还原只放在 _hideTimer 回调里，淡出期间还原会永久带着这条内联值，
// 从此 .wm-animating 的 left/top/width/height 过渡被整个盖掉）。
function fallBackFadeOut(winEl) {
    winEl.classList.add("minimized");
    // display:none 等淡出结束再设，避免动画被截断。必须可取消并复核状态：
    // 用户在淡出期间还原窗口时，这个迟到的定时器
    // 会把刚恢复的窗口重新藏成 display:none，而 _minimized 已是 false，
    // 于是得到一个「指示灯亮着却永远点不出来」的隐形窗口。
    clearTimeout(winEl._hideTimer);
    winEl._hideTimer = setTimeout(() => {
        winEl._hideTimer = null;
        if (winEl._minimized || winEl.classList.contains("minimized")) {
            winEl.style.display = "none";
        }
    }, MINIMIZE_FADE_MS + 20);
}

// 设置红色标记（Badge）：count<=0 隐藏
function setBadge(app, count) {
    const img = getDockIconImg(app);
    if (!img) return;
    const host = img.parentElement;
    const badge = host.querySelector(".badge");
    if (!badge) return;
    if (!count || count <= 0) {
        badge.style.display = "none";
        badge.textContent = "";
        badge.removeAttribute("id");
        host.removeAttribute("aria-describedby");
    } else {
        badge.style.display = "";
        badge.textContent = count > 99 ? "99+" : String(count);
        // badge 本身是 aria-hidden 的纯视觉标记：数字要靠容器上的 aria-describedby
        // 才带得出去，否则读屏用户永远不知道图标上挂着 5 条未读。
        // 不动容器的 aria-label（那是应用名，覆盖掉就把应用名念没了）。
        badge.id = `dock-badge-${host.dataset.app}`;
        host.setAttribute("aria-describedby", badge.id);
    }
}

// ===== 恢复默认布局（系统设置「恢复程序坞默认顺序」调用） =====
/**
 * 把收藏顺序恢复成出厂列表并清空「最近使用」。
 * 写入一律经设置中枢（它是唯一的设置写入方，落盘后按 dock-order-change /
 * dock-recents-change 广播）；定义未注册时退回直接落盘 + 自行补发事件。
 * 两条路径最后都在本函数内重新渲染，调用方不必再画一遍。
 * @returns {Array<string>} 恢复后的收藏顺序
 */
export function resetDockLayout() {
    const order = [...FAVORITE_DEFAULTS];
    const api = window.__settings;
    if (api && typeof api.set === "function" && typeof api.has === "function" && api.has("dock.order")) {
        api.set("dock.order", order, { source: "dock" });
        api.set("dock.recents", [], { source: "dock" });
    } else {
        safeSetItem(DOCK_ORDER_KEY, JSON.stringify(order));
        safeSetItem(RECENTS_KEY, JSON.stringify([]));
        // 兜底路径按设置中枢的 json 约定补发（detail 为数组本身，不是 on/off）
        window.dispatchEvent(new CustomEvent("dock-order-change", { detail: order }));
        window.dispatchEvent(new CustomEvent("dock-recents-change", { detail: [] }));
    }
    favorites = order;
    recentApps = [];
    renderFavorites();
    renderRecents();
    syncRunningApps();
    return favorites.slice();
}

/**
 * 当前程序坞布局快照，供「调试 / 诊断」面板显示与断言（只读，返回副本）。
 * `protectedNames` 一并给出，界面才能解释「为什么访达 / 启动台移不掉」。
 * @returns {{favorites: Array<string>, recents: Array<string>, protectedNames: Array<string>}} 布局快照
 */
export function getDockLayoutSnapshot() {
    return {
        favorites: favorites.slice(),
        recents: recentApps.slice(),
        protectedNames: DOCK_PROTECTED.slice(),
    };
}

window.__dock = {
    minimizeToDock,
    restoreFromDock,
    getDockIconImg,
    setBadge,
    addToDock,
    updateRecents,
    syncRunningApps,
    resetDockLayout,
    getDockLayoutSnapshot,
};

init();
