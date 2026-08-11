/**
 * script.js — 启动台插件逻辑
 * 从插件注册表读取应用（type=app 的 window 插件 + Safari），
 * 点击启动插件走 pluginManager.load 冷加载。
 */

import { getPlugins, load as loadPlugin, getIcon as getPluginIcon } from '../../src/javascripts/plugin-manager.js';
import { updateMenu } from '../../src/javascripts/finderbar.js';
import { addToDock, getIcon } from '../../src/javascripts/dock.js';
import { wallpaper } from '../../src/javascripts/wallpaper.js';

// 取最后一个 .launchpad（最新注入的实例），避免 reopen 时 DOM 中仍残留旧实例导致引用错位
const _allLaunchpads = document.querySelectorAll(".launchpad");
const launchpad = _allLaunchpads[_allLaunchpads.length - 1];
const bg = launchpad.querySelector(".bg");
const containers = launchpad.querySelector(".containers");
const searchbar = launchpad.querySelector(".searchbar");
const searchInput = launchpad.querySelector(".search-input");

// 启动台布局缓存键：保存用户拖拽排序后的应用顺序
const LAUNCHPAD_ORDER_KEY = "webstartos_launchpad_order";
// 拖拽排序进行中标志，避免松手时误触发应用启动
let isDragging = false;

// 跨多次打开共享的关闭锁状态：每次打开都会注入新的 script 模块实例，
// 模块级变量无法跨实例共享，故将 isClosing 提升到 window 上，避免旧实例
// 把状态"困住"导致后续无法再次关闭/打开。
const LP_STATE = (window.__lpState = window.__lpState || { isClosing: false });

// 同步启动台在程序坞的运行指示灯（小圆点）；仅操作启动台收藏项，不影响其它应用
function setDockLight(on) {
    const light = document.querySelector('#dock .container[data-app="启动台"] .light');
    if (light) light.classList.toggle("on", on);
}

// 获取程序坞中对应名称的应用图标，不存在则先加入程序坞再查找（createApp 与 Safari 启动逻辑共用）
function getDockImg(name) {
    let img = document.querySelector(`#dock img[alt="${name}"]`);
    if (!img) {
        addToDock(name);
        img = document.querySelector(`#dock img[alt="${name}"]`);
    }
    return img;
}

// 读取缓存中的启动台应用顺序；无缓存或解析失败时返回 null
function getLaunchpadOrder() {
    try {
        const saved = JSON.parse(localStorage.getItem(LAUNCHPAD_ORDER_KEY));
        if (Array.isArray(saved) && saved.length) return saved;
    } catch (e) { /* 忽略损坏的缓存 */ }
    return null;
}

// 将当前启动台应用顺序持久化到缓存
function saveLaunchpadOrder(names) {
    try {
        localStorage.setItem(LAUNCHPAD_ORDER_KEY, JSON.stringify(names));
    } catch (e) { /* 忽略存储失败 */ }
}

// 为启动台图标绑定拖拽排序（网格场景采用交换位置方式）
function bindDrag(div) {
    div.draggable = true;
    let draggingEl = null;
    div.addEventListener("dragstart", (e) => {
        draggingEl = div;
        isDragging = true;
        div.classList.add("sortable-dragging");
        e.dataTransfer.effectAllowed = "move";
    });
    div.addEventListener("dragover", (e) => {
        if (!draggingEl || draggingEl === div) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
    });
    div.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!draggingEl || draggingEl === div) return;
        // 交换被拖拽项与目标项的位置
        const placeholder = document.createElement("div");
        containers.insertBefore(placeholder, div);
        containers.insertBefore(div, draggingEl);
        containers.insertBefore(draggingEl, placeholder);
        placeholder.remove();
        draggingEl.classList.remove("sortable-dragging");
        draggingEl = null;
        const names = Array.from(containers.children).map((c) => c.querySelector("p")?.textContent).filter((t) => t != null);
        saveLaunchpadOrder(names);
    });
    div.addEventListener("dragend", () => {
        div.classList.remove("sortable-dragging");
        draggingEl = null;
        // 延迟清除标志，避免 drop 后紧随的 click 误触发应用启动
        setTimeout(() => { isDragging = false; }, 80);
    });
}

// 组装应用列表：插件（entry=window）+ Safari 浏览器
function getAppList() {
    const plugins = getPlugins().filter((m) => m.type === "app" && m.entry === "window");
    const apps = plugins.map((m) => ({
        name: m.name,
        icon: getPluginIcon(m.id),
        pluginId: m.id,
        centered: !!(m.window && m.window.centered),
    }));
    // Safari 保持非插件方式
    apps.push({ name: "Safari浏览器", icon: getIcon("Safari浏览器"), pluginId: null, centered: false });
    return apps;
}

function createApp(app) {
    let div = document.createElement("div");
    let img = document.createElement("img");
    let p = document.createElement("p");

    img.addEventListener("error", () => {
        img.src = getIcon("系统设置");
    });

    img.src = app.icon;
    p.textContent = app.name;
    div.classList.add("container");
    div.appendChild(img);
    div.appendChild(p);
    containers.appendChild(div);
    bindDrag(div);

    img.addEventListener("click", () => {
        if (isDragging) return; // 拖拽排序中不触发启动
        const name = app.name;
        if (window.appStatus[name]) {
            // 已打开：插件置顶，Safari 走原逻辑
            if (app.pluginId) {
                loadPlugin(app.pluginId);
            } else {
                createLegacySafari(name);
            }
        } else {
            if (app.pluginId) {
                const dockImg = getDockImg(name);
                const light = dockImg ? dockImg.parentElement.querySelector(".light") : null;
                loadPlugin(app.pluginId, { light, centered: app.centered });
                window.appStatus[name] = true;
                updateMenu(name);
            } else {
                openLegacySafari(name);
            }
        }
        closeLaunchpad();
    });
}

// Safari 非插件启动逻辑（保留原行为）
function openLegacySafari(name) {
    const dockImg = getDockImg(name);
    if (dockImg) {
        dockImg.classList.add("openingwithscale");
        setTimeout(() => {
            dockImg.classList.remove("openingwithscale");
            const light = dockImg.parentElement.querySelector(".light");
            if (light) light.classList.add("on");
            createLegacySafari(name, light);
            window.appStatus[name] = true;
            updateMenu(name);
        }, 2980);
    } else {
        createLegacySafari(name);
        window.appStatus[name] = true;
        updateMenu(name);
    }
}

function createLegacySafari(name, light = null) {
    import("../../src/javascripts/window.js").then(({ create }) => {
        create("./assets/apps/Safari浏览器.html", name, light, false);
    });
}

/**
 * 将当前壁纸设置同步到启动台背景层。
 * 读取 wallpaper 模块的配置，设置 .bg 元素的背景图。
 */
function syncWallpaper() {
    const config = wallpaper.getWallpaperConfig();
    if (config && config.url) {
        bg.style.backgroundImage = `url("${config.url}")`;
    }
}

function init() {
    // 清理上一实例可能残留的启动台 DOM、遗留关闭计时器与旧脚本，
    // 避免重复实例叠加、状态错乱，以及旧脚本残留导致本次打开的界面拿不到事件绑定
    document.querySelectorAll(".launchpad").forEach((el) => {
        if (el === launchpad) return;
        if (el._closeTimer) { clearTimeout(el._closeTimer); el._closeTimer = null; }
        el.remove();
    });
    document.querySelectorAll("script[plugin=launchpad]").forEach((s) => s.remove());

    // 先注册关闭入口与打开状态，确保即使后续步骤异常也不会缺失关闭能力或卡在"已打开"状态
    window.specialCloses["启动台"] = closeLaunchpad;
    window.appStatus["启动台"] = true;
    // 打开即复位关闭锁，避免上一轮关闭动画遗留的 isClosing 把本次打开"卡死"
    LP_STATE.isClosing = false;
    setDockLight(true);

    // 同步当前壁纸到启动台背景（异常不影响整体打开）
    try {
        syncWallpaper();
        window.addEventListener("wallpaper-change", syncWallpaper);
    } catch (e) {
        console.warn("[launchpad] 同步壁纸失败：", e);
    }

    // 资源释放：启动台关闭时移除自身注册的全局监听，避免常驻内存
    const onLaunchpadUnload = (e) => {
        if (e.detail.id !== "launchpad") return;
        window.removeEventListener("plugin-unload", onLaunchpadUnload);
        window.removeEventListener("wallpaper-change", syncWallpaper);
    };
    window.addEventListener("plugin-unload", onLaunchpadUnload);

    const apps = getAppList();
    // 按缓存顺序恢复启动台布局；新应用或未知应用排到末尾
    const order = getLaunchpadOrder();
    if (order) {
        apps.sort((a, b) => {
            const ia = order.indexOf(a.name);
            const ib = order.indexOf(b.name);
            return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
        });
    }
    apps.forEach((app) => createApp(app));
}

// 搜索过滤：根据输入的关键词实时显示匹配的应用
function initSearch() {
    if (!searchInput) return;
    searchInput.addEventListener("input", () => {
        const keyword = searchInput.value.trim().toLowerCase();
        containers.querySelectorAll(".container").forEach(container => {
            const name = container.querySelector("p")?.textContent?.toLowerCase() || "";
            container.style.display = name.includes(keyword) ? "" : "none";
        });
    });
}

// 关闭状态锁，避免关闭动画期间重复触发关闭导致计时器叠加。
// 注意：isClosing 实际存放在 LP_STATE（见文件顶部）以支持跨实例共享。

function closeLaunchpad() {
    if (LP_STATE.isClosing) return;
    // 若启动台 DOM 已被移除（如被新实例清理），直接复位状态即可，无需再做动画
    if (!launchpad || !launchpad.isConnected) {
        window.appStatus["启动台"] = false;
        setDockLight(false);
        LP_STATE.isClosing = false;
        return;
    }
    LP_STATE.isClosing = true;
    // 同步复位打开状态：关闭动画期间不应再被判定为"已打开"，
    // 否则用户在关闭动画过程中再次点击会触发 doClose 而非重新打开，造成二次打开被拦截
    window.appStatus["启动台"] = false;
    setDockLight(false);

    // 启动关闭动画（反向播放进入动画）
    bg.style.animation = "fade 0.3s ease-out forwards reverse";
    containers.style.animation = "animation 0.3s ease-in-out forwards reverse";
    searchbar.style.animation = "fade 0.3s ease-out forwards reverse";

    // 将关闭计时器挂到 DOM 上，便于新实例打开时取消遗留关闭，避免误删新实例
    launchpad._closeTimer = setTimeout(() => {
        launchpad._closeTimer = null;
        const script = document.querySelector("script[plugin=launchpad]");
        if (script) script.remove();
        // 移除启动台样式表，释放 CSSOM，避免常驻内存
        const style = document.getElementById("plugin-style-launchpad");
        if (style) style.remove();
        // 通知插件清理全局监听（如壁纸变更）
        window.dispatchEvent(new CustomEvent("plugin-unload", { detail: { id: "launchpad" } }));
        if (launchpad && launchpad.isConnected) launchpad.remove();
        LP_STATE.isClosing = false;
    }, 360);
}

/**
 * 重新打开（重显）已存在的启动台实例：专门用于"关闭动画尚未结束就被再次唤起"、
 * 或"界面仍残留但状态被复位"的场景。
 * 取消遗留退出计时器、清除反向退出动画遗留的内联样式，恢复进入动画与可见性，
 * 确保每次点击都能稳定重新显示界面，不再出现"仅有小圆点而无界面"。
 * @returns {boolean} 是否成功重显
 */
export function reopenLaunchpad() {
    const lp = document.querySelector(".launchpad");
    if (!lp || !lp.isConnected) return false;
    // 取消可能的遗留退出计时器（避免它随后把刚重显的界面删掉）
    if (lp._closeTimer) { clearTimeout(lp._closeTimer); lp._closeTimer = null; }
    LP_STATE.isClosing = false;
    window.appStatus["启动台"] = true;
    setDockLight(true);
    // 清除反向退出动画遗留的内联样式，恢复进入动画与可见性
    const b = lp.querySelector(".bg");
    const c = lp.querySelector(".containers");
    const s = lp.querySelector(".searchbar");
    [b, c, s].forEach((el) => { if (el) el.style.animation = ""; });
    lp.style.display = "";
    return true;
}

// 暴露统一控制入口给程序坞等调用方，彻底解耦启动台的开关状态机，
// 使其不再依赖 appStatus 的偶然同步，保证任意次数点击都能稳定开关且圆点与界面一致。
window.__launchpad = {
    open: (light) => { loadPlugin("launchpad", { light: light || null, centered: false }); },
    close: closeLaunchpad,
    reopen: reopenLaunchpad,
    isOpen: () => {
        const lp = document.querySelector(".launchpad");
        return !!(lp && lp.isConnected);
    },
};
launchpad.addEventListener("click", (event) => {
    if (!event.target.closest(".container") && !event.target.closest(".searchbar"))
        closeLaunchpad();
});

init();
initSearch();