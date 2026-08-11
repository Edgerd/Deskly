import { updateMenu } from "./finderbar.js";
import { create, bringToFront } from "./window.js";
import { getTrashIcon } from "./trashIcon.js";
import { createContextMenu } from "./ui/contextMenu.js";
import { isNativeContextMenuEnabled } from "./contextMenuSettings.js";
import { enableSortable } from "./sortable.js";
import { PLUGIN_ICON, getIcon as getPluginIconPath, resolveName, GENERIC_APP_ICON } from "./plugin-manager.js";
const tip = document.querySelector("body > div.tip");

// 统一派发 dock 设置变更事件（detail 为 "on" / "off"）
const emitDock = (name, on) => window.dispatchEvent(new CustomEvent(name, { detail: on ? "on" : "off" }));

// 程序坞固定收藏项（默认值，不含废纸篓与分隔线；下载为文件夹栈）
const FAVORITE_DEFAULTS = ["访达", "启动台", "Safari浏览器", "系统设置", "App Store", "下载"];
const TRASH = "废纸篓";
// 程序坞受保护应用：禁止用户从程序坞移除（右键菜单不显示「从程序坞中移除」，拖出程序坞区域也不移除）
const DOCK_PROTECTED = ["访达", "启动台"];
// 程序坞布局缓存键：保存用户拖拽排序后的收藏图标顺序（仅收藏区持久化）
const DOCK_ORDER_KEY = "webstartos_dock_order";
// 最近使用的 App 缓存键
const RECENTS_KEY = "webstartos_dock_recents";

// 应用名 → 插件 id 映射（图标统一从 PLUGIN_ICON / assets/icons 加载）
const appToPlugin = {
    "访达": "finder",
    "启动台": "launchpad",
    "系统设置": "system-settings",
    "App Store": "app-store",
    "计算器": "calculator",
    "关于本机": "about",
    "照片": "photos",
    "记事本": "notepad",
};

// 新版图标映射：中文逻辑名 → 图标文件名（PNG）；文件夹类图标位于 folder/ 子目录
const iconMap = {
    "访达": "Finder",
    "启动台": "Launchpad",
    "Safari浏览器": "Safari",
    "系统设置": "Réglages système",
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
    "天气": "Météo",
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

// 根据应用逻辑名获取新版图标资源路径；废纸篓使用可切换的 trash 图标
export function getIcon(app) {
    if (app === TRASH) return getTrashIcon();
    const pluginId = appToPlugin[app];
    if (pluginId) {
        return PLUGIN_ICON[pluginId] || `./mods/${pluginId}/icon.png`;
    }
    // 自定义插件：按显示名从插件注册表解析 pluginId，复用与启动台一致的图标源
    const manifest = resolveName(app);
    if (manifest && manifest.id) {
        return getPluginIconPath(manifest.id);
    }
    return `./assets/icons/${iconMap[app] || app}.png`;
}

// ===== 程序坞状态（以 localStorage 为唯一事实来源） =====
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
// 程序坞图标大小（像素）
let dockSize = parseInt(localStorage.getItem("dock-size"), 10) || 50;
if (dockSize < 32 || dockSize > 128) dockSize = 50;
// 程序坞位置：bottom / left / right
let dockPosition = localStorage.getItem("dock-position") || "bottom";
if (!["bottom", "left", "right"].includes(dockPosition)) dockPosition = "bottom";
// 放大程度（最大缩放倍数）
let dockZoomAmount = parseFloat(localStorage.getItem("dock-zoom-amount")) || 1.8;
if (dockZoomAmount < 1.1 || dockZoomAmount > 3) dockZoomAmount = 1.8;
// 是否显示运行指示灯
let showIndicators = localStorage.getItem("dock-show-indicators") !== "off";
// 是否在程序坞中显示「最近使用的 App」
let showRecentApps = localStorage.getItem("dock-show-recent") !== "off";

let hideTimer = null;
const DOCK_TRANSITION = "transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)";
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
    imgs = Array.from(dock.querySelectorAll(".container img"));
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
function openApp(img, light, app) {
    // 启动台使用独立的开关状态机（window.__launchpad），彻底解耦，
    // 避免依赖 appStatus 的偶然同步导致"二次打开被拦截"或"仅有小圆点无界面"。
    if (img.alt === "启动台" && window.__launchpad) {
        if (window.__launchpad.isOpen()) window.__launchpad.close();
        else window.__launchpad.open(light);
        return;
    }
    if (appStatus[img.alt] == true) {
        if (!doClose.includes(img.alt)) {
            const win = document.getElementById(img.alt);
            // 若窗口处于最小化状态，先从程序坞还原
            if (win && win._minimized && window.__dock && window.__dock.restoreFromDock) {
                window.__dock.restoreFromDock(win, img.alt);
            } else {
                bringToFront(win, img.alt);
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
            light.classList.remove("on");
            appStatus[img.alt] = false;
        }
    } else {
        if (!noAnimation.includes(img.alt)) {
            img.classList.add("opening");
            setTimeout(() => {
                img.classList.remove("opening");
                launchApp(img, light, app);
            }, 2980);
        } else {
            launchApp(img, light, app);
        }
        // 点击即清空白 Badge
        if (window.__dock) window.__dock.setBadge(img.alt, 0);
    }
}

// 真正创建并启动应用：写状态、点亮指示灯、刷新菜单与运行区（动画分支与即时分支共用）
function launchApp(img, light, app) {
    create("./assets/apps/" + app + ".html", img.alt, light, app === "计算器");
    appStatus[img.alt] = true;
    light.classList.add("on");
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
        if (win && win._closeWindow) {
            win._closeWindow();
        } else if (window.specialCloses[altName]) {
            window.specialCloses[altName]();
        }
    } catch (e) {
        console.warn("[dock] 强制退出异常：", altName, e);
        if (win) win.remove();
    }
    light.classList.remove("on");
    appStatus[altName] = false;
    onAppClosed(altName);
}

// 退出应用：关闭对应窗口（特殊应用走专用关闭逻辑）
function quitApp(img, light, altName) {
    if (window.specialCloses[altName]) {
        window.specialCloses[altName]();
        light.classList.remove("on");
        appStatus[altName] = false;
        onAppClosed(altName);
    } else {
        const win = document.getElementById(altName);
        if (win && win._closeWindow) {
            win._closeWindow();
            onAppClosed(altName);
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
    }
    if (appStatus[altName]) {
        if (window.specialCloses[altName]) {
            window.specialCloses[altName]();
        } else {
            const win = document.getElementById(altName);
            if (win && win._closeWindow) win._closeWindow();
        }
    }
    refreshSeparators();
}

// 在程序坞中保留：将当前运行（非收藏）应用加入收藏项并持久化
function keepInDock(altName) {
    if (!favorites.includes(altName) && altName !== TRASH) {
        favorites.push(altName);
        saveFavorites();
        // 将该应用从运行区迁移到收藏区
        const runContainer = runningEl.querySelector(`.container img[alt="${cssEscape(altName)}"]`);
        if (runContainer) {
            const c = runContainer.closest(".container");
            runningEl.removeChild(c);
            favoritesEl.appendChild(c);
            refreshSeparators();
        }
    }
}

// 打开系统设置
function openSettings() {
    const light = document.querySelector(`#dock img[alt="系统设置"]`)?.parentElement.querySelector(".light") || null;
    create("./assets/apps/系统设置.html", "系统设置", light, false);
    if (light) light.classList.add("on");
    appStatus["系统设置"] = true;
    onAppOpened("系统设置", "系统设置");
}

// 切换程序坞自动隐藏
function toggleAutoHide() {
    autoHide = !autoHide;
    localStorage.setItem("dock-autohide", autoHide ? "on" : "off");
    emitDock("dock-autohide-change", autoHide);
}

// ===== 构建单个容器（应用图标 / 文件夹栈 / 废纸篓） =====
function makeContainer(app, opts = {}) {
    const container = document.createElement("div");
    container.classList.add("container");
    container.dataset.app = app;

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
    if (app === TRASH) trashImg = img;
    container.appendChild(img);

    const light = document.createElement("div");
    light.classList.add("light");
    if (appStatus[app] === true) light.classList.add("on");
    container.appendChild(light);

    // 红色标记（Badge）容器
    const badge = document.createElement("div");
    badge.className = "badge";
    badge.style.display = "none";
    container.appendChild(badge);

    if (!showIndicators) container.classList.add("no-indicator");

    bindClickEvent(img, light, app);
    bindDropOpen(container, app);
    return container;
}

// 绑定应用图标的点击与右键菜单
function bindClickEvent(img, light, app) {
    img.addEventListener("mouseup", (e) => {
        if (e.button !== 0) return; // 仅左键触发打开
        if (isDragging) return;
        if (img.dataset.folder) {
            openStack(app, img);
            return;
        }
        openApp(img, light, app);
    });
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
    container.addEventListener("drop", (e) => {
        container.classList.remove("drop-target");
        if (internalDnD) return;
        if (!hasFiles(e)) return;
        e.preventDefault();
        const label = e.dataTransfer.files?.[0]?.name || e.dataTransfer.getData("text/plain") || "";
        if (!label) return;
        // 打开对应应用，并提示带入的文件（演示性）
        const img = container.querySelector("img");
        if (img) openApp(img, img.parentElement.querySelector(".light"), app);
        if (tip) {
            tip.textContent = `用 ${app} 打开 ${label}`;
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

function imgIsFolder(container) {
    const img = container.querySelector("img");
    return !!(img && img.dataset.folder);
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
            items.push({ label: "退出", action: () => quitApp(img, light, altName) });
        } else {
            items.push({ label: "打开", action: () => openApp(img, light, app) });
        }
        const isProtected = DOCK_PROTECTED.includes(altName);
        if (isProtected) {
            // 受保护应用（访达 / 启动台）：禁止从程序坞移除，不显示移除 / 保留项，仅保留分区分隔
            items.push({ type: "separator" });
        } else {
            items.push({ type: "separator" });
            if (favorites.includes(altName)) {
                items.push({ label: "从程序坞中移除", action: () => removeFromDock(img, altName) });
            } else if (altName !== TRASH) {
                items.push({ label: "在程序坞中保留", action: () => keepInDock(altName) });
            }
            items.push({ type: "separator" });
        }
        if (running) {
            items.push({ label: "强制退出", action: () => forceQuit(img, light, altName) });
            items.push({ type: "separator" });
        }
        items.push({
            label: "选项",
            action: (x, y) => {
                const sub = [
                    {
                        label: showRecentApps ? "隐藏“最近使用的应用程序”" : "显示“最近使用的应用程序”",
                        action: () => {
                            showRecentApps = !showRecentApps;
                            localStorage.setItem("dock-show-recent", showRecentApps ? "on" : "off");
                            emitDock("dock-show-recent-change", showRecentApps);
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
            { label: "打开系统设置", action: () => openSettings() },
            { type: "separator" },
            { label: autoHide ? "显示程序坞" : "隐藏程序坞", action: () => toggleAutoHide() },
        ];
        createContextMenu(e.clientX, e.clientY, items);
    });
}

function bindTipEvent(img) {
    // 悬浮提示统一由 bindGlobalTip 在 document 上驱动，避免程序坞被窗口
    // 遮挡时收不到 img 的 mouseover/mouseout 而丢失提示。此处仅登记图标。
    img.dataset.tipApp = img.alt || "";
}

let tipListenerBound = false;
let tipRafId = null; // 悬浮提示位置跟随循环句柄（全局唯一，避免 rAF 堆积）

function hideTip() {
    currentImg = null;
    if (tipRafId) { cancelAnimationFrame(tipRafId); tipRafId = null; }
    if (tip) {
        tip.style.display = "none";
        tip.style.visibility = "visible";
        tip.style.opacity = ""; // 清理拖放/菜单操作残留的透明度，避免下一次显示异常
    }
}

// 跟随当前图标实时位置：放大动画期间图标矩形不断变化，每帧重算保证提示始终贴住图标。
// 每次调用先取消旧帧再排新帧，无论触发多少次都只存在一条循环，杜绝 rAF 堆积。
function updateTipPosition() {
    if (tipRafId) { cancelAnimationFrame(tipRafId); tipRafId = null; }
    if (!currentImg || !tip || dock.classList.contains("hidden")) return;
    const rect = currentImg.getBoundingClientRect();
    if (dockPosition === "left" || dockPosition === "right") {
        // 侧边程序坞：提示紧贴图标旁（间距 8px），垂直居中于图标
        tip.style.left = (dockPosition === "left" ? rect.right + 8 : rect.left - tip.offsetWidth - 8) + "px";
        tip.style.top = rect.top + rect.height / 2 - tip.offsetHeight / 2 + "px";
    } else {
        // 底部程序坞：提示紧贴图标上方（间距 8px），利用实测高度避免箭头压住图标
        tip.style.left = rect.left + rect.width / 2 - tip.offsetWidth / 2 + "px";
        tip.style.top = rect.top - tip.offsetHeight - 8 + "px";
    }
    tipRafId = requestAnimationFrame(updateTipPosition);
}

// 在 document 上统一驱动程序坞悬浮提示：窗口（z-index 高于程序坞）覆盖程序坞
// 区域时会截走 dock 内 img 的 mouseover/mouseout，导致提示失效。document 级
// 监听不受遮挡影响，始终能根据鼠标命中目标判断并显示对应应用名的提示。
function bindGlobalTip() {
    if (tipListenerBound) return;
    tipListenerBound = true;
    document.addEventListener("mousemove", (e) => {
        if (!tip || dock.classList.contains("hidden")) { hideTip(); return; }
        const r = dock.getBoundingClientRect();
        const overDock = e.clientX >= r.left && e.clientX <= r.right &&
            e.clientY >= r.top && e.clientY <= r.bottom;
        if (!overDock) { hideTip(); return; }
        // 几何命中：遍历程序坞图标，判断鼠标是否落在某图标矩形内。
        // 不依赖 e.target —— 当窗口（z-index 高于程序坞）覆盖程序坞区域时，
        // e.target 为窗口元素，closest 失效导致提示丢失；改用几何判断始终命中图标。
        let hit = null;
        const icons = dock.querySelectorAll(".container img");
        for (const img of icons) {
            const rect = img.getBoundingClientRect();
            if (e.clientX >= rect.left && e.clientX <= rect.right &&
                e.clientY >= rect.top && e.clientY <= rect.bottom) {
                hit = img;
                break;
            }
        }
        if (hit) {
            // 切换到新图标：更新应用名并显示；同一图标仅持续跟随位置（循环已运行）。
            // 文本变化会使 tip 宽度变化，故每次都重定位一次，避免水平位置错位。
            if (currentImg !== hit) {
                currentImg = hit;
                tip.textContent = hit.alt;
                tip.style.display = "block";
                tip.style.visibility = "visible";
                tip.style.opacity = "";
            }
            updateTipPosition();
        } else {
            hideTip();
        }
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

function saveFavorites() {
    try {
        localStorage.setItem(DOCK_ORDER_KEY, JSON.stringify(favorites));
    } catch (e) { /* 忽略存储失败 */ }
}

// ===== 运行区 =====
// 构造应用图标容器、挂入父区并登记悬浮提示（渲染收藏 / 运行 / 最近使用区共用）
function appendAppIcon(parent, app) {
    const container = makeContainer(app);
    parent.appendChild(container);
    bindTipEvent(container.querySelector("img"));
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
    // 仅统计真实存在且非关闭动画中的窗口（避免动画结束前的误判）
    const openWins = Array.from(document.querySelectorAll(".window"))
        .filter(w => w.id && !w.classList.contains("closing"));
    const openIds = new Set(openWins.map(w => w.id));

    // 1) 收藏项指示灯：窗口存在则点亮，否则熄灭
    favorites.forEach(fav => {
        const l = favoritesEl.querySelector(`.container[data-app="${cssEscape(fav)}"] .light`);
        if (!l) return;
        const on = openIds.has(fav);
        l.classList.toggle("on", on);
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
        if (!lastSyncIds.has(id)) updateRecents(id); // 仅在首次出现时记录最近使用
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
    favoritesEl.querySelector('.container[data-app="启动台"] .light')?.classList.toggle("on", lpRunning);
    appStatus["启动台"] = lpRunning;

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

function saveRecents() {
    try {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(recentApps));
    } catch (e) { /* 忽略 */ }
}

function updateRecents(altName) {
    if (favorites.includes(altName) || altName === TRASH) return;
    recentApps = recentApps.filter(a => a !== altName);
    recentApps.unshift(altName);
    if (recentApps.length > 3) recentApps = recentApps.slice(0, 3);
    saveRecents();
    if (showRecentApps) renderRecents();
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
    bindTipEvent(container.querySelector("img"));
    const light = container.querySelector(".light");
    bindHrContextMenu(trashEl); // 废纸篓区域右键同分割线菜单
}

// 应用大小 / 位置 / 指示灯 等视觉设置
function applyDockSize() {
    dock.style.setProperty("--dock-size", dockSize + "px");
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

    buildSections();
    loadFavorites();
    loadRecents();
    renderFavorites();
    renderTrash();
    renderRecents();
    applyDockSize();
    applyDockPosition();
    applyIndicators();
    refreshSeparators();
    refreshIconList();

    dock.addEventListener("animationend", () => {
        dock.style.animation = "none";
        dock.style.transition = DOCK_TRANSITION;
        if (autoHide) dock.classList.add("autohide");
    }, { once: true });

    window.addEventListener("dock-autohide-change", (e) => {
        autoHide = e.detail === "on";
        clearTimeout(hideTimer);
        hideTimer = null;
        updateDockVisibility();
    });
    window.addEventListener("dock-zoom-change", (e) => {
        dockZoom = e.detail === "on";
    });
    window.addEventListener("dock-size-change", (e) => {
        dockSize = parseInt(e.detail, 10) || 50;
        applyDockSize();
        // 同步放大动画基准：清除放大动画残留的 inline 尺寸，图标立即采用新 --dock-size
        dock.querySelectorAll(".container img").forEach(img => {
            img.currentWidth = img.targetWidth = dockSize;
            img.style.width = img.style.height = "";
        });
    });
    window.addEventListener("dock-position-change", (e) => {
        dockPosition = e.detail;
        applyDockPosition();
    });
    window.addEventListener("dock-zoom-amount-change", (e) => {
        dockZoomAmount = parseFloat(e.detail) || 1.8;
    });
    window.addEventListener("dock-show-indicators-change", (e) => {
        showIndicators = e.detail === "on";
        applyIndicators();
    });
    window.addEventListener("dock-show-recent-change", (e) => {
        showRecentApps = e.detail === "on";
        renderRecents();
    });
    window.addEventListener("trash-icon-change", () => {
        if (trashImg) trashImg.src = getTrashIcon();
    });
    if (!autoHide) {
        setTimeout(() => { dock.style.transition = DOCK_TRANSITION; }, 1000);
    }

    // 收藏区拖拽排序：排序期间屏蔽应用打开，松手后保存收藏顺序
    dock.addEventListener("dragstart", () => { isDragging = true; });
    dock.addEventListener("dragend", () => { isDragging = false; });
    enableSortable(favoritesEl, {
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
            }
        }
    });

    bindKeyboardNav();
    bindGlobalTip();
    bindAppleMenuRecent();

    // 观察 body 顶层子节点的增删（窗口的注入 / 移除均发生在 body 顶层），
    // 让程序坞实时「检测正在运行的程序」并刷新运行区与指示灯。
    let dockSyncScheduled = false;
    const dockSyncObserver = new MutationObserver(() => {
        if (dockSyncScheduled) return;
        dockSyncScheduled = true;
        Promise.resolve().then(() => {
            dockSyncScheduled = false;
            syncRunningApps();
        });
    });
    dockSyncObserver.observe(document.body, { childList: true });

    // 首次对账：根据实际已打开的窗口初始化运行区与指示灯
    syncRunningApps();

    DockAutoHide();
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
    setTimeout(tipSetup, 500);
}

// ===== 自动隐藏 =====
function DockAutoHide() {
    document.addEventListener("mousemove", (e) => {
        if (!autoHide) return;
        const isAtEdge = isNearDockEdge(e.clientX, e.clientY);
        if (isAtEdge) {
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
            if (dock.classList.contains("hidden")) {
                dock.classList.remove("hidden");
                dock.classList.add("show");
                dock.style.transform = shownTransform();
            } else if (!dock.classList.contains("show")) {
                dock.classList.add("show");
            }
        } else {
            if (dock.classList.contains("show") && !dock.classList.contains("hidden") && !hideTimer) {
                hideTimer = setTimeout(() => {
                    dock.classList.remove("show");
                    dock.classList.add("hidden");
                    dock.style.transform = hiddenTransform();
                    hideTip(); // 程序坞隐藏时同步收起悬浮提示，避免鼠标静止时残留
                    hideTimer = null;
                }, 600);
            }
        }
    });
}

function isNearDockEdge(x, y) {
    if (dockPosition === "left") return x < 30;
    if (dockPosition === "right") return window.innerWidth - x < 30;
    return window.innerHeight - y < 30;
}

function hiddenTransform() {
    if (dockPosition === "left") return "translateX(-150%)";
    if (dockPosition === "right") return "translateX(150%)";
    return "translateY(150%)";
}
function shownTransform() {
    if (dockPosition === "left" || dockPosition === "right") return "translateX(0)";
    return "translateY(0)";
}

function updateDockVisibility() {
    dock.style.transition = DOCK_TRANSITION;
    dock.style.animation = "none";
    if (autoHide) {
        dock.classList.add("autohide", "hidden");
        dock.classList.remove("show");
        dock.style.transform = hiddenTransform();
        hideTip(); // 程序坞隐藏时同步收起悬浮提示
    } else {
        dock.classList.remove("autohide", "hidden", "show");
        dock.style.transform = shownTransform();
    }
}

function tipSetup() {
    imgs.forEach(img => bindTipEvent(img));
}

// ===== 放大动画（跟随设置的大小与放大程度） =====
function DockAnimation() {
    const mouseRange = 200;
    const lerpSpeed = 0.3;
    const isSide = () => dockPosition === "left" || dockPosition === "right";
    // 每帧收集存活图标：新增 / 移除图标后列表始终正确，放大不会作用在已移除的节点上
    const collectIcons = () => Array.from(dock.querySelectorAll(".container img"));
    const isOverDock = (e) => {
        const r = dock.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right &&
            e.clientY >= r.top && e.clientY <= r.bottom;
    };
    // 放大效果改为在 document 上监听鼠标移动：窗口（z-index 高于程序坞）覆盖
    // 程序坞区域时会截走 dock 的 mousemove，导致悬浮放大失效。document 级监听
    // 不受遮挡影响，始终能根据鼠标位置计算放大，恢复程序坞悬浮放大效果。
    const initSize = (img, base) => {
        if (typeof img.currentWidth === 'undefined') img.currentWidth = base;
        if (typeof img.targetWidth === 'undefined') img.targetWidth = base;
    };
    document.addEventListener("mousemove", (e) => {
        // 每次取最新设置，避免闭包捕获旧尺寸 / 旧放大程度
        const baseWidth = dockSize;
        const maxScale = dockZoomAmount;
        const icons = collectIcons();
        // 未开启放大或鼠标不在程序坞范围内：复位所有图标尺寸
        if (!dockZoom || !isOverDock(e)) {
            icons.forEach((img) => { img.targetWidth = baseWidth; });
            return;
        }
        // 底部程序坞按水平距离、侧边程序坞按垂直距离计算放大
        const mouse = isSide() ? e.clientY : e.clientX;
        icons.forEach((img) => {
            initSize(img, baseWidth);
            const rect = img.getBoundingClientRect();
            const center = isSide() ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
            const distance = Math.abs(mouse - center);
            if (distance < mouseRange) {
                const distanceRatio = distance / mouseRange;
                const scale = 1 + (maxScale - 1) * Math.sin((1 - distanceRatio) * Math.PI / 2);
                img.targetWidth = baseWidth * scale;
            } else {
                img.targetWidth = baseWidth;
            }
        });
    });
    // 缓存 Dock 完全静止时的真实尺寸（在 !anyZoomed 时每帧持续刷新），
    // 放大开始时直接用此缓存锁定背景，避免"边放大边测量"导致值偏大。
    function animation() {
        const baseWidth = dockSize;
        const icons = collectIcons();
        icons.forEach(img => {
            initSize(img, baseWidth);
            if (!dockZoom) img.targetWidth = baseWidth;
            const diff = img.targetWidth - img.currentWidth;
            if (Math.abs(diff) > 0.1) {
                img.currentWidth += diff * lerpSpeed;
                img.style.width = `${img.currentWidth}px`;
                img.style.height = `${img.currentWidth}px`;
            }
        });
        requestAnimationFrame(animation);
    }
    animation();
}

// ===== 文件夹栈（Stacks）：点击下载图标展开文件网格 =====
function openStack(app, img) {
    closeStack();
    const stack = document.createElement("div");
    stack.className = "dock-stack";
    const header = document.createElement("div");
    header.className = "dock-stack-header";
    header.textContent = "下载";
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

    // 点击空白处关闭
    setTimeout(() => {
        document.addEventListener("click", closeStackOnOutside, true);
    }, 0);
}

function closeStackOnOutside(e) {
    if (activeStack && !activeStack.contains(e.target) && !e.target.dataset.folder) {
        closeStack();
    }
}

function closeStack() {
    if (activeStack) {
        activeStack.remove();
        activeStack = null;
        document.removeEventListener("click", closeStackOnOutside, true);
    }
}

function loadStackItems(grid) {
    // 动态引入 VFS，尝试列出下载文件夹真实文件
    import("./vfs.js").then(({ VFS }) => {
        VFS.init().then(() => {
            let files = [];
            try {
                const r = VFS.listFiles ? VFS.listFiles("download") : [];
                // 防御：若返回 Promise 或异常结构，一律降级为占位
                files = (r && typeof r.then === "function") ? [] : (r || []);
            } catch (_) {
                files = [];
            }
            if (Array.isArray(files) && files.length) {
                files.slice(0, 9).forEach(f => grid.appendChild(makeStackItem(f.name || f, f)));
            } else {
                grid.appendChild(makeStackItem("下载文件夹为空或尚未授权", null, true));
            }
        }).catch(() => grid.appendChild(makeStackItem("下载文件夹不可用", null, true)));
    }).catch(() => {
        grid.appendChild(makeStackItem("下载文件夹不可用", null, true));
    });
}

function makeStackItem(name, file, disabled) {
    const item = document.createElement("div");
    item.className = `dock-stack-item${disabled ? " disabled" : ""}`;
    const icon = document.createElement("img");
    icon.src = "./assets/icons/folder/Download.png";
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
        // Control+F3（含 Fn+Control+F3 在多数浏览器即 Control+F3）进入程序坞导航
        if (e.key === "F3" && (e.ctrlKey || e.metaKey) && !e.altKey) {
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
    return Array.from(dock.querySelectorAll(".container:not(.no-indicator-fake) img"));
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
    const logoMenu = document.querySelector('div.menu[menu="logo"]');
    if (!logoMenu) return;
    const item = Array.from(logoMenu.querySelectorAll("p"))
        .find(p => p.textContent.includes("最近使用的项目"));
    if (!item) return;
    item.style.cursor = "pointer";
    item.addEventListener("click", (e) => {
        e.stopPropagation();
        const items = [];
        if (recentApps.length === 0) {
            items.push({ label: "（无最近使用的项目）", disabled: true });
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

// 最小化窗口吸入程序坞（缩放淡出兜底过渡）
function minimizeToDock(winEl, appName) {
    const iconEl = getDockIconImg(appName);
    winEl._minimized = true;
    // 运行指示灯保持点亮
    const light = iconEl ? iconEl.parentElement.querySelector(".light") : null;
    if (light) light.classList.add("on");
    // 缩放淡出兜底：保证所有路径都有视觉过渡，绝不瞬间消失
    fallBackFadeOut(winEl);
}

// 从程序坞还原窗口（直接显示 + 置顶）
function restoreFromDock(winEl, appName) {
    winEl._minimized = false;
    winEl.style.display = "";
    winEl.classList.remove("minimized");
    bringToFront(winEl, appName);
}

// 兜底缩放淡出：保证所有路径都有视觉过渡，绝不瞬间消失。
// 注意：之前 transition 中加入 transform 会让 .window 进入 GPU 合成层，强烈破坏
// 其内部的 backdrop-filter 效果（亚克力闪烁/失效/颜色不一致）。这里只保留 opacity
// 过渡，由 .window.minimized 类（window.css）完成 0 → 1 → 0 的淡出，不再叠加 transform。
function fallBackFadeOut(winEl) {
    const saved = winEl.style.transition;
    winEl.style.transition = "opacity 0.35s ease";
    winEl.classList.add("minimized");
    // display:none 等淡出结束再设，避免动画被截断
    setTimeout(() => {
        winEl.style.display = "none";
        winEl.style.transition = saved;
    }, 360);
}

// 设置红色标记（Badge）：count<=0 隐藏
function setBadge(app, count) {
    const img = getDockIconImg(app);
    if (!img) return;
    const badge = img.parentElement.querySelector(".badge");
    if (!badge) return;
    if (!count || count <= 0) {
        badge.style.display = "none";
        badge.textContent = "";
    } else {
        badge.style.display = "";
        badge.textContent = count > 99 ? "99+" : String(count);
    }
}

window.__dock = {
    minimizeToDock,
    restoreFromDock,
    getDockIconImg,
    setBadge,
    addToDock,
    updateRecents,
    syncRunningApps,
};

init();
