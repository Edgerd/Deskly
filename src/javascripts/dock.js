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
import { getTrashIcon, getTrashKey, getTrashIconForFullness } from "./trashIcon.js";
import { createContextMenu } from "./ui/contextMenu.js";
import { isNativeContextMenuEnabled } from "./contextMenuSettings.js";
import { enableSortable } from "./sortable.js";
import { getIcon as getPluginIconPath, resolveName, getIconForName, isPluginEnabled, GENERIC_APP_ICON } from "./plugin-manager.js";
import { displayNameFor } from "./app-registry.js";
import { assetIcon, DOWNLOAD_ICON, legacyAppHtml } from "./paths.js";
const tip = document.querySelector("body > div.tip");

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

// 应用名 → 插件 id 映射（图标统一走 plugin-manager 的 getIconForName / getIcon）
const appToPlugin = {
    "访达": "finder",
    "启动台": "launchpad",
    "系统设置": "system-settings",
    "App Store": "app-store",
    "计算器": "calculator",
    "关于本机": "about",
    "照片": "photos",
    "记事本": "notepad",
    "Safari浏览器": "safari",
    "VS Code": "vs_code",
    "Siri": "siri",
};

// 新版图标映射：中文逻辑名 → 图标文件名（PNG）；文件夹类图标位于 folder/ 子目录
const iconMap = {
    "访达": "Finder",
    "启动台": "Launchpad",
    "Safari浏览器": "Safari",
    "系统设置": "Reglages systeme",
    "下载": "folder/Download",
    "App Store": "App Store",
    "邮件": "Mail",
    "通讯录": "Contacts",
    "日历": "Calendrier",
    "提醒事项": "Rappels",
    "记事本": "TextEdit",
    "FaceTime通话": "FaceTime",
    "信息": "Messages",
    "地图": "Plans",
    "查找": "Localiser",
    "Photo Booth": "Photo Booth",
    "照片": "Photos",
    "音乐": "Musique",
    "博客": "Podcasts",
    "视频": "TV",
    "语音备忘录": "Dictaphone",
    "天气": "Meteo",
    "股市": "Bourse",
    "图书": "Livres",
    "时钟": "Horloge",
    "计算器": "Calculatrice",
    "无边记": "Freeform",
    "家庭": "Maison",
    "Siri": "Siri",
    "iPhone镜像": "Recopie de l'iPhone",
    "密码": "Mots de passe",
    "其他": "folder/System"
};

// 根据应用逻辑名获取图标资源路径；废纸篓使用可切换的 trash 图标。
// 插件图标一律走 plugin-manager（manifest.icon → 目录内 icon.png → GENERIC_APP_ICON），
// 此处不再复制其回退逻辑，避免两处对「图标到底从哪读」的理解漂移。
export function getIcon(app) {
    if (app === TRASH) return getTrashIcon();
    // 先按「应用名」整体解析：多应用插件的子应用名（文稿 / 表格 / 演示）会命中
    // app 级 icon，拿不到再退回插件级映射，避免三颗图标都显示成套件的图。
    const fromName = getIconForName(app);
    if (fromName) return fromName;
    const pluginId = appToPlugin[app] || resolveName(app)?.id;
    if (pluginId) return getPluginIconPath(pluginId);
    // 仅当逻辑名在 iconMap 里有对应 macOS 图标时才拼 assets/icons 路径；
    // 否则（未注册 / 清单未就绪 / 已卸载残留）用占位图兜底，不再拼
    // ./assets/icons/<名称>.png —— 那是一张必然 404 的图（清单就绪后
    // refreshIconsFromRegistry 会用 getIconForName 校准回真图标）。
    return iconMap[app] ? assetIcon(iconMap[app]) : GENERIC_APP_ICON;
}

// ===== 程序坞状态（以 localStorage 为唯一事实来源） =====
// 视觉布局项（大小 / 位置 / 放大倍数 …）的写入方是设置中枢：它按定义表校验后
// 落盘，再按 event 名补发下面这些 dock-*-change 事件。事件 detail 是外部可伪造的
// 入口（历史上往 dock-size-change 塞 detail=500 就真能得到 500px 程序坞），
// 所以每个监听器都再校验一遍，取值不合法就地钳制或回退默认。
const SIZE_MIN = 32, SIZE_MAX = 128, SIZE_DEFAULT = 50;
const ZOOM_MIN = 1.1, ZOOM_MAX = 3, ZOOM_DEFAULT = 1.8;
const POSITIONS = ["left", "bottom", "right"];
const POSITION_DEFAULT = "bottom";

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

let autoHide = localStorage.getItem("dock-autohide") === "on";
// 放大默认开启（符合用户预期：鼠标悬浮程序坞即放大）；仅当存储显式为 "off" 时关闭
let dockZoom = localStorage.getItem("dock-zoom") !== "off";
// 程序坞图标大小（像素）：越界读数按同一套边界钳制，与监听器共用常量
let dockSize = readNumber(localStorage.getItem("dock-size"), SIZE_MIN, SIZE_MAX, SIZE_DEFAULT);
// 程序坞位置：bottom / left / right
let dockPosition = readEnum(localStorage.getItem("dock-position"), POSITIONS, POSITION_DEFAULT);
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
let currentImg = null;
// 拖拽排序进行中标志，避免松手时误触发应用打开
let isDragging = false;
// 程序坞内部排序拖拽标志，用于与"拖文件打开"区分
let internalDnD = false;
// 当前程序坞所有图标（用于放大动画与悬停提示）
let imgs = [];
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

// 重新校准所有程序坞图标的 src：在 plugin-manager 完成注册后调用，
// 把先前因 registry 未就绪被 error 兜底的图标切回正确的 ./mods/<id>/icon.png。
function refreshIconsFromRegistry() {
    dock.querySelectorAll(".container img").forEach((img) => {
        const app = img.alt;
        if (!app) return;
        const newSrc = getIcon(app);
        if (newSrc && newSrc !== img.src) {
            // 清除兜底标记以便重新尝试加载；若新 src 仍失败，error 回调会再次兜底
            img.dataset.iconFallback = "";
            img.src = newSrc;
        }
    });
    pruneStaleRecents();
    pruneStaleFavorites();
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
    if (typeof getIconForName === "function" && getIconForName(name)) return true;
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
        renderRecents();
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
        renderFavorites();
        refreshIconList();
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
// 收藏区排序句柄（{destroy}），供重新初始化时释放旧 MutationObserver
let favoritesSortable = null;
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

function openApp(img, light, app) {
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
        const actions = window.__menuActions || {};
        if (typeof actions.openAppByName === "function") actions.openAppByName("访达");
        // 冷加载时访达脚本晚于窗口出现（fetch + 注入），固定等两帧会把导航命令丢在
        // 监听器挂上之前。这里轮询活动标签的 data-path：到达 /废纸篓 即停，最多重试 5 秒。
        let tries = 0;
        const sendTrashNav = () => {
            const win = document.getElementById("访达");
            const tab = win && win.querySelector(".tab.active");
            if (tab && tab.dataset.path === "/废纸篓") return;
            if (win) {
                win.dispatchEvent(new CustomEvent("finder-command", {
                    detail: { command: "navigate", args: { path: "/废纸篓" } },
                    bubbles: true,
                }));
            }
            if (++tries < 25) setTimeout(sendTrashNav, 200);
        };
        setTimeout(sendTrashNav, 0);
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
    create(legacyAppHtml(app), img.alt, light, app === "计算器");
    appStatus[img.alt] = true;
    // light 可能为 null（openSettings 就显式传 null），无判空就是一记 TypeError，
    // 而它发生在 create() 之后 —— 窗口已注入、状态却停在半途。
    if (light) light.classList.add("on");
    if (!noMenuChanging.includes(img.alt)) updateMenu(app);
    onAppOpened(app, img.alt);
}

// 应用启动后的联动：运行区补齐、最近使用更新
function onAppOpened(app, altName) {
    if (!favorites.includes(altName) && altName !== TRASH) {
        addToRunning(altName);
    }
    updateRecents(altName);
}

// 应用关闭后的联动：运行区移除
function onAppClosed(altName) {
    removeFromRunning(altName);
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

// 从程序坞中移除应用图标（同时关闭其已打开的窗口）；收藏项一并取消固定
function removeFromDock(img, altName) {
    const container = img.closest(".container");
    if (container) container.remove();
    // 从收藏项移除（取消在程序坞中保留）
    const idx = favorites.indexOf(altName);
    if (idx >= 0) {
        favorites.splice(idx, 1);
        saveFavorites();
    } else {
        // 运行区/最近区图标同样要写回数据源：只删 DOM 的话，
        // 下一次 renderRecents()（任何一次开关应用都会触发）会把它重新画回来。
        const rIdx = recentApps.indexOf(altName);
        if (rIdx >= 0) {
            recentApps.splice(rIdx, 1);
            saveRecents();
        }
    }
    if (appStatus[altName]) {
        if (window.specialCloses[altName]) {
            window.specialCloses[altName]();
        } else {
            const win = document.getElementById(altName);
            if (win) closeWindow(win);
        }
    }
    refreshSeparators();
    // imgs 缓存必须跟着 DOM 一起收：留着已摘除的 img，checkTipHit 每帧仍对它做
    // getBoundingClientRect()（全 0，永不命中），而 DockAnimation 那边的同名缓存
    // 早已加了 isConnected 复核 —— 两套缓存不能一套修过一套没修。
    refreshIconList();
}

// 在程序坞中保留：将当前运行（非收藏）应用加入收藏项并持久化
function keepInDock(altName) {
    if (favorites.includes(altName) || altName === TRASH) return;
    favorites.push(altName);
    saveFavorites();
    // 旧实现只在「图标此刻正躺在运行区」时搬那一个 DOM 节点，两个区都不重画。
    // 应用未运行时它的图标其实在最近区（或压根不在 Dock 上），于是搬运动作整个落空：
    // 收藏区不出现新图标、最近区那份还留着 —— 数据说已固定，界面完全看不出来。
    // 改成「改数据 + 全量重画」，各区归属由 favorites / appStatus 决定，不靠手工搬。
    renderFavorites();
    renderRecents();
    refreshSeparators();
    refreshIconList();
}

// 打开系统设置
function openSettings() {
    const light = document.querySelector(`#dock img[alt="系统设置"]`)?.parentElement.querySelector(".light") || null;
    create(legacyAppHtml("系统设置"), "系统设置", light, false);
    if (light) light.classList.add("on");
    appStatus["系统设置"] = true;
    onAppOpened("系统设置", "系统设置");
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

// ===== 构建单个容器（应用图标 / 文件夹栈 / 废纸篓） =====
/** 语言切换后刷新已渲染容器的人读名字；只改 aria-label，身份 data-app / img.alt 保持中文原名不动。 */
function refreshDockLabels() {
    document.querySelectorAll(".dock .container[data-app]").forEach((c) => {
        c.setAttribute("aria-label", displayNameFor(c.dataset.app));
    });
}
function makeContainer(app, opts = {}) {
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
    img.addEventListener("error", () => {
        // 兜底：图标加载失败时降级为通用应用占位图标，
        // 避免被错误地显示成"系统设置"齿轮（误让用户以为系统设置异常）
        if (img.dataset.iconFallback) return;
        img.dataset.iconFallback = "1";
        img.src = GENERIC_APP_ICON;
    });
    if (app === "下载") {
        img.src = getIcon("下载");
        img.alt = "下载";
        img.dataset.folder = "1";
    } else {
        img.src = getIcon(app);
        img.alt = app;
    }
    // 名称已经由容器的 aria-label 读出，图片本身对读屏不再是独立信息；
    // 但 alt 仍是本模块的**主键**（refreshIconsFromRegistry / syncRunningApps /
    // getIcon 全靠 img.alt 反查应用名），所以只清可及性、不动属性值。
    img.setAttribute("aria-hidden", "true");
    if (app === TRASH) trashImg = img;
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

// 绑定应用图标的点击与右键菜单
function bindClickEvent(img, light, app, container) {
    const host = container || img.parentElement;
    const open = () => {
        if (isDragging) return;
        if (img.dataset.folder) {
            openStack(app, img);
            return;
        }
        openApp(img, light, app);
    };
    img.addEventListener("mouseup", (e) => {
        if (e.button !== 0) return; // 仅左键触发打开
        open();
    });
    // 键盘通路：挂了 tabindex 不等于能激活。Chrome 不会给非 <button> 元素
    // 自动合成 click，所以 Enter / Space 要自己接（Space 还要拦住页面滚动）。
    if (host) {
        host.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
                e.preventDefault();
                open();
            }
        });
    }
    bindAppContextMenu(img, light, app);
}

// 拖文件到图标上打开：仅接受来自操作系统/桌面的真实文件（Files 类型）拖放，
// 排除程序坞内部排序（internalDnD）以免松手时误触发打开
function bindDropOpen(container, app) {
    container.addEventListener("dragover", (e) => {
        if (internalDnD) return;
        if (hasFiles(e)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            container.classList.add("drop-target");
        }
    });
    container.addEventListener("dragleave", () => container.classList.remove("drop-target"));
    container.addEventListener("drop", async (e) => {
        container.classList.remove("drop-target");
        if (internalDnD) return;
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

// 应用图标右键菜单：打开/退出、强制退出、在程序坞中保留/移除、选项
function bindAppContextMenu(img, light, app) {
    img.addEventListener("contextmenu", (e) => {
        if (isNativeContextMenuEnabled()) return;
        e.preventDefault();
        e.stopPropagation();
        const altName = img.alt;
        const running = appStatus[altName] == true;
        const items = [];
        if (running) {
            items.push({ label: i18n.t("dock.quit", "退出"), action: () => quitApp(img, light, altName) });
        } else {
            items.push({ label: i18n.t("common.open", "打开"), action: () => openApp(img, light, app) });
        }
        const isProtected = DOCK_PROTECTED.includes(altName);
        if (isProtected) {
            // 受保护应用（访达 / 启动台）：禁止从程序坞移除，不显示移除 / 保留项，仅保留分区分隔
            items.push({ type: "separator" });
        } else {
            items.push({ type: "separator" });
            if (favorites.includes(altName)) {
                items.push({ label: i18n.t("dock.removeFromDock", "从程序坞中移除"), action: () => removeFromDock(img, altName) });
            } else if (altName !== TRASH) {
                items.push({ label: i18n.t("dock.keepInDock", "在程序坞中保留"), action: () => keepInDock(altName) });
            }
            items.push({ type: "separator" });
        }
        if (running) {
            items.push({ label: i18n.t("dock.forceQuit", "强制退出"), action: () => forceQuit(img, light, altName) });
            items.push({ type: "separator" });
        }
        items.push({
            label: i18n.t("dock.options", "选项"),
            action: (x, y) => {
                const sub = [
                    {
                        label: showRecentApps
                            ? i18n.t("dock.hideRecentApps", "隐藏“最近使用的应用程序”")
                            : i18n.t("dock.showRecentApps", "显示“最近使用的应用程序”"),
                        action: () => {
                            writeDockFlag("dock.show.recent", "dock-show-recent", !showRecentApps, "dock-show-recent-change", (value) => {
                                showRecentApps = value;
                                renderRecents();
                            });
                        },
                    },
                ];
                createContextMenu(x, y, sub);
            },
        });
        createContextMenu(e.clientX, e.clientY, items);
    });
}

// 分割线右键菜单：打开系统设置、隐藏/显示程序坞、调整大小提示
function bindHrContextMenu(container) {
    container.addEventListener("contextmenu", (e) => {
        if (isNativeContextMenuEnabled()) return;
        e.preventDefault();
        e.stopPropagation();
        const items = [
            { label: i18n.t("dock.openSettings", "打开系统设置"), action: () => openSettings() },
            { type: "separator" },
            { label: autoHide ? i18n.t("dock.showDock", "显示程序坞") : i18n.t("dock.hideDock", "隐藏程序坞"), action: () => toggleAutoHide() },
        ];
        createContextMenu(e.clientX, e.clientY, items);
    });
}

let tipListenerBound = false;
let tipRafId = null; // 悬浮提示位置跟随循环句柄（全局唯一，避免 rAF 堆积）

function hideTip() {
    currentImg = null;
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
    if (!tip || dock.classList.contains("hidden")) { hideTip(); return; }
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

// ===== 运行区 =====
// 构造应用图标容器并挂入父区（渲染收藏 / 运行 / 最近使用区共用）；
// 悬浮提示由 bindGlobalTip 的几何命中统一驱动，无需按图标绑定。
function appendAppIcon(parent, app) {
    const container = makeContainer(app);
    parent.appendChild(container);
    return container;
}

const runningIconEl = (altName) => runningEl.querySelector(`.container img[alt="${cssEscape(altName)}"]`);

function addToRunning(altName) {
    if (favorites.includes(altName) || altName === TRASH) return;
    if (runningIconEl(altName)) return;
    appendAppIcon(runningEl, altName);
    refreshSeparators();
    refreshIconList();
}

function removeFromRunning(altName) {
    const c = runningIconEl(altName);
    if (c) {
        const container = c.closest(".container");
        if (container) container.remove();
        refreshSeparators();
        refreshIconList();
    }
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

    // 1) 收藏项指示灯：窗口存在则点亮，否则熄灭
    favorites.forEach(fav => {
        const l = favoritesEl.querySelector(`.container[data-app="${cssEscape(fav)}"] .light`);
        if (!l) return;
        const on = openIds.has(fav);
        l.classList.toggle("on", on);
        // 指示灯是 aria-hidden 的视觉件，运行状态要同步到容器的 aria-pressed，
        // 否则 makeContainer 建时写上的那一份会永远停在「按下」，对读屏说谎。
        if (on) l.parentElement.setAttribute("aria-pressed", "true");
        else l.parentElement.removeAttribute("aria-pressed");
        appStatus[fav] = on;
    });

    // 2) 清理运行区：移除已关闭、已转为收藏或废纸篓的残留项
    Array.from(runningEl.children).forEach(c => {
        const alt = c.querySelector("img")?.alt;
        if (alt && (!openIds.has(alt) || favorites.includes(alt) || alt === TRASH)) c.remove();
    });

    // 3) 新增打开的非收藏应用：写 appStatus、补入运行区与最近使用
    openIds.forEach(id => {
        if (favorites.includes(id) || id === TRASH) return;
        appStatus[id] = true;
        if (!lastSyncIds.has(id)) updateRecents(id, false); // 仅在首次出现时记录最近使用（重画交给收尾统一做）
        addToRunning(id);
    });

    // 4) 复位已关闭的非收藏应用的 appStatus
    lastSyncIds.forEach(id => {
        if (!openIds.has(id)) appStatus[id] = false;
    });
    lastSyncIds = new Set(openIds);

    // 5) 启动台专属对账：启动台根元素是 .launchpad（非 .window），上面的 .window 对账
    // 永远识别不到它，会把它误判为"未打开"并强制熄灭小圆点、复位 appStatus，造成
    // 「有小圆点无界面 / 有界面无圆点」的状态错位。这里以其 DOM 是否真实存在为准，
    // 单独同步其运行指示灯与 appStatus，保证界面与小圆点始终一致。
    const lpEl = document.querySelector(".launchpad");
    const lpRunning = !!(lpEl && lpEl.isConnected);
    const lpLight = favoritesEl.querySelector('.container[data-app="启动台"] .light');
    lpLight?.classList.toggle("on", lpRunning);
    if (lpLight) {
        if (lpRunning) lpLight.parentElement.setAttribute("aria-pressed", "true");
        else lpLight.parentElement.removeAttribute("aria-pressed");
    }
    appStatus["启动台"] = lpRunning;

    // 关闭的应用要从运行区「搬回」最近区：上面第 2 步只负责摘图标，而 renderRecents
    // 又会跳过正在运行的项 —— 于是一个非收藏应用被关闭后两个区都不在，Dock 上看起来
    // 就是点完消失、再也找不回来（数据里它还在 recentApps）。必须由对账收尾统一重画。
    if (showRecentApps) renderRecents();
    refreshSeparators();
    refreshIconList();
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
    // 对账路径会为每个新开的应用连调一次这里，每次都 innerHTML="" 重建整个最近区
    // 是白白的 DOM 抖动；交给调用方（syncRunningApps 收尾）统一画一次。
    // 对外经 window.__dock.updateRecents 调用时只传一个参数，rerender 默认 true，行为不变。
    if (rerender && showRecentApps) renderRecents();
}

function renderRecents() {
    recentEl.innerHTML = "";
    if (showRecentApps) {
        recentApps.forEach(app => {
            if (favorites.includes(app) || appStatus[app] === true) return;
            appendAppIcon(recentEl, app);
        });
    }
    refreshSeparators();
    refreshIconList();
}

// 根据各区是否有内容刷新分隔线显隐
function refreshSeparators() {
    sepRunning.style.display = runningEl.children.length ? "" : "none";
    sepRecent.style.display = (showRecentApps && recentEl.children.length) ? "" : "none";
}

// ===== 初始化渲染 =====
function buildSections() {
    dock.appendChild(favoritesEl);
    dock.appendChild(sepRunning);
    dock.appendChild(runningEl);
    dock.appendChild(sepRecent);
    dock.appendChild(recentEl);
    dock.appendChild(trashEl);
}

function renderFavorites() {
    favoritesEl.innerHTML = "";
    favorites.forEach(app => appendAppIcon(favoritesEl, app));
}

function renderTrash() {
    trashEl.innerHTML = "";
    const container = makeContainer(TRASH);
    trashEl.appendChild(container);
    bindHrContextMenu(trashEl); // 废纸篓区域右键同分割线菜单
}

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
    // 立即可见的 UI 必须同步渲染，避免首屏空窗；此部分总开销约 8ms。
    buildSections();
    loadFavorites();
    loadRecents();
    renderFavorites();
    renderTrash();
    applyDockSize();
    applyDockPosition();
    applyIndicators();
    refreshSeparators();
    refreshIconList();

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
    let trashFull = false;
    const refreshTrashFullness = async () => {
        let full = false;
        try {
            const { isTrashNotEmpty } = await import("./trash.js");
            full = await isTrashNotEmpty();
        } catch (err) { /* 权限未批时保持现图，不谎报 */ }
        trashFull = full;
        if (trashImg) trashImg.src = getTrashIconForFullness(getTrashKey(), trashFull);
    };
    window.addEventListener("trash-changed", refreshTrashFullness);
    window.addEventListener("trash-icon-change", () => {
        if (trashImg) trashImg.src = getTrashIconForFullness(getTrashKey(), trashFull);
    });
    // 首帧先按内容刷一次（图标创建后 trashImg 才有值，放渲染回调之后）
    refreshTrashFullness();
    // 不再在这里额外 setTimeout 写一次 transition：init 末尾的
    // emitDock("dock-autohide-change") 会走 updateDockVisibility()，那里已经同步写上了，
    // 这里再排一个 1 秒的定时器只是重复同一件事。

    // 收藏区拖拽排序：排序期间屏蔽应用打开，松手后保存收藏顺序。
    // 句柄留存：重新初始化时先 destroy，避免旧 MutationObserver 随实例叠加。
    dock.addEventListener("dragstart", () => { isDragging = true; });
    dock.addEventListener("dragend", () => { isDragging = false; });
    if (favoritesSortable) favoritesSortable.destroy();
    favoritesSortable = enableSortable(favoritesEl, {
        getKey: (item) => {
            const img = item.querySelector("img");
            return img ? img.alt : "hr";
        },
        onOrderChange: (keys) => {
            favorites = keys.filter(k => k !== "hr" && k !== TRASH);
            saveFavorites();
        },
    });
    // 收藏项拖出程序坞区域即移除（拖出移除手势）
    favoritesEl.addEventListener("dragend", (e) => {
        const container = e.target.closest && e.target.closest(".container");
        if (!container) return;
        const r = dock.getBoundingClientRect();
        const outside = e.clientX < r.left - 10 || e.clientX > r.right + 10 ||
            e.clientY < r.top - 10 || e.clientY > r.bottom + 10;
        if (outside) {
            const img = container.querySelector("img");
            const alt = img ? img.alt : null;
            // 受保护应用（访达 / 启动台）即使拖出程序坞区域也不移除，自动归位
            if (alt && !DOCK_PROTECTED.includes(alt)) {
                const idx = favorites.indexOf(alt);
                if (idx >= 0) favorites.splice(idx, 1);
                saveFavorites();
                container.remove();
                refreshSeparators();
                refreshIconList(); // 同 removeFromDock：图标缓存必须跟着摘掉的节点一起收
            }
        }
    });

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

    // plugin-manager 是异步 init()（拉取各插件 manifest.json），
    // 而 dock.init() 在模块顶层同步执行，会先于 registry 就绪前渲染收藏区。
    // 此时非内置应用（如 vs_code）通过 resolveName 找不到，URL 拼成 ./assets/icons/<名称>.png，
    // 404 后被 error 兜底成通用占位图。监听 plugins-ready 后重新校准图标 src，
    // 让已被占位的图标切回正确路径（仅清掉兜底标记后重设 src，失败仍兜底）。
    window.addEventListener("plugins-ready", refreshIconsFromRegistry);
    // 办公套件切换品牌包（iWork/Office）时重取图标
    window.addEventListener("deskly-brand-pack-changed", refreshIconsFromRegistry);
    document.addEventListener("languagechange", refreshDockLabels);
}

// ===== 自动隐藏 =====
// 亚克力禁忌：.dock 带 backdrop-filter，显隐禁用 transform（会提升 3D 合成层致毛玻璃退化为白色矩形），
// 只通过 .hidden / .show class 切换 opacity + visibility，Dock 位置不变、原地淡入淡出。
// mousemove 已由 bindGlobalTip 统一驱动（减少一个高频全局监听），此处仅实现判定逻辑。
function handleAutoHide(x, y) {
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
        const mouseActive = dockZoom && mouseX >= 0;
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
    winEl._minimized = true;
    // 运行指示灯保持点亮
    const light = iconEl ? iconEl.parentElement.querySelector(".light") : null;
    if (light) light.classList.add("on");
    import("./wm/genie-effect.js")
        .then((m) => m.minimizeGenie(winEl, iconEl))
        .catch(() => false)
        .then((played) => {
            // 快照是异步的：期间用户可能已把窗口还原，此时不能再补淡出，
            // 否则会把刚揭开的窗口重新按进坞里（旧版 _hideTimer 同款竞态）。
            if (!played && winEl._minimized) fallBackFadeOut(winEl);
        });
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
        winEl.style.display = "";
        winEl.classList.remove("minimized");
        bringToFront(winEl, appName);
    };
    import("./wm/genie-effect.js")
        .then((m) => m.restoreGenie(winEl, iconEl))
        .catch(() => false)
        .then((played) => {
            if (!played) reveal();
        });
}

// 兜底隐藏调度：只负责在淡出结束后补 display:none，不再自己写 transition。
// 淡出本身属于 .window.minimized（window.css）：那条规则里带 `visibility 0s linear 0.35s`，
// 而内联 transition 优先级更高，一写下去就把 visibility 延迟整段抹掉 ——
// 第一帧就不可见，本函数原本承诺的「绝不瞬间消失」反而从未成立。
// 同时早还原也不再泄漏：既然不覆盖，就没有被覆盖下去的东西需要还原
// （旧写法把还原只放在 _hideTimer 回调里，360ms 内还原会永久带着这条内联值，
// 从此 .wm-animating 的 left/top/width/height 过渡被整个盖掉）。
function fallBackFadeOut(winEl) {
    winEl.classList.add("minimized");
    // display:none 等淡出结束再设，避免动画被截断。必须可取消并复核状态：
    // 用户在 360ms 内还原窗口时，这个迟到的定时器
    // 会把刚恢复的窗口重新藏成 display:none，而 _minimized 已是 false，
    // 于是得到一个「指示灯亮着却永远点不出来」的隐形窗口。
    clearTimeout(winEl._hideTimer);
    winEl._hideTimer = setTimeout(() => {
        winEl._hideTimer = null;
        if (winEl._minimized || winEl.classList.contains("minimized")) {
            winEl.style.display = "none";
        }
    }, 360);
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
