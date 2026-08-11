/**
 * plugin-manager.js — 插件管理器（冷加载核心引擎）
 *
 * 职责：
 * 1. 启动时仅拉取各插件 manifest.json 建立注册表（冷加载，不加载内容）。
 * 2. 提供插件注册/注销/查询/按显示名解析等 API。
 * 3. 点击启动时按需 fetch 插件 index.html / style.css / script.js 并注入主文档。
 * 4. 为 ZIP 安装预留注册接口（本迭代实现基础版）。
 *
 * 窗口控制（拖拽/缩放/关闭/全屏/置顶）仍由 window.js 负责，本模块不越界。
 * 插件主文档采用注入式运行，保留现有应用内部 document.querySelector 访问方式。
 */

// 内置插件 id 列表（冷加载时据此逐个拉取清单）
const BUILTIN_IDS = [
    "calculator",
    "finder",
    "launchpad",
    "system-settings",
    "about",
    "app-store",
    "notepad",
    "photos",
];

// 重显启动台：取消遗留退出计时器并标记运行态（启动台为 fullscreen 入口，根元素 .launchpad 无 id）
function reopenLaunchpad() {
    if (window.__launchpad && window.__launchpad.reopen) window.__launchpad.reopen();
    window.appStatus["启动台"] = true;
}

// 暴露全局钩子，供 window.js 等非模块脚本通过名称解析插件（复用 resolveName，避免重复遍历）
window.__getPluginByName = resolveName;
window.__pluginManagerReady = () => ready;

// 插件注册表：id -> manifest 对象
const registry = new Map();

// 是否已完成初始化
let ready = false;

/**
 * 启动插件管理器：逐个拉取内置插件的 manifest.json 建立注册表。
 * 仅注册清单，不加载任何界面内容（冷加载）。
 * @returns {Promise<void>}
 */
export async function init() {
    const tasks = BUILTIN_IDS.map(async (id) => {
        try {
            const res = await fetch(`./mods/${id}/manifest.json?v=${Date.now()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const manifest = await res.json();
            registerPlugin(manifest);
        } catch (err) {
            console.warn(`[plugin-manager] 加载插件清单失败: ${id}`, err);
        }
    });
    await Promise.all(tasks);

    // 还原已安装（ZIP）插件：从 IndexedDB 读取清单并注册，
    // 使其刷新/重开后仍出现在应用商店且可被打开（持久化的关键步骤）。
    try {
        for (const rec of await _getAllInstalled()) {
            if (!rec?.id) continue;
            const { files, ...manifest } = rec;
            manifest._installed = true;
            if (!registry.has(manifest.id)) registerPlugin(manifest);
        }
    } catch (err) {
        console.warn("[plugin-manager] 还原已安装插件失败", err);
    }

    ready = true;
    window.dispatchEvent(new CustomEvent("plugins-ready", { detail: { plugins: getPlugins() } }));
}

/**
 * 注册一个插件到注册表。
 * @param {object} manifest 插件清单（含 id/name/version/type/entry/main/style/script/icon 等）
 * @returns {boolean} 是否注册成功
 */
export function registerPlugin(manifest) {
    if (!manifest || !manifest.id) return false;
    registry.set(manifest.id, manifest);
    window.dispatchEvent(new CustomEvent("plugin-registered", { detail: manifest }));
    return true;
}

/**
 * 从注册表注销一个插件。
 * @param {string} id 插件 id
 * @returns {boolean} 是否注销成功
 */
export function unregisterPlugin(id) {
    const existed = registry.delete(id);
    if (existed) {
        window.dispatchEvent(new CustomEvent("plugin-unregistered", { detail: { id } }));
    }
    return existed;
}

/**
 * 获取全部已注册插件清单。
 * @returns {Array<object>} 插件清单数组
 */
export function getPlugins() {
    return Array.from(registry.values());
}

/**
 * 按 id 获取插件清单。
 * @param {string} id 插件 id
 * @returns {object|undefined} 插件清单
 */
export function getPlugin(id) {
    return registry.get(id);
}

/**
 * 是否已就绪（已完成清单注册）。
 * @returns {boolean}
 */
export function isReady() {
    return ready;
}

/**
 * 由插件显示名解析到插件对象（如「访达」→ finder 插件）。
 * @param {string} name 插件显示名
 * @returns {object|undefined} 插件清单
 */
export function resolveName(name) {
    for (const manifest of registry.values()) {
        if (manifest.name === name) return manifest;
    }
    return undefined;
}

/**
 * 插件图标集中映射（单一图标源 = assets/icons）。
 * 有对应 macOS 图标的插件直接指向 assets/icons；无对应图（如 vs_code）回退到插件自带 icon.png。
 */
const PLUGIN_ICON = {
    "about": "./assets/icons/Informations système.png",
    "app-store": "./assets/icons/App Store.png",
    "calculator": "./assets/icons/Calculatrice.png",
    "finder": "./assets/icons/Finder.png",
    "launchpad": "./assets/icons/Launchpad.png",
    "notepad": "./assets/icons/TextEdit.png",
    "system-settings": "./assets/icons/Réglages système.png",
    "photos": "./mods/photos/Photos.png",
    // vs_code 无对应 macOS 图标，保留插件自带 icon.png
};

// 供 dock / launchpad 等模块复用同一套映射，避免图标源分散
export { PLUGIN_ICON };

// 通用应用占位图标：任何插件/应用图标加载失败时的兜底目标（避免被错误地显示成系统设置齿轮）
const GENERIC_APP_ICON = "./assets/icons/folder/Applications.png";
export { GENERIC_APP_ICON };

/**
 * 返回插件图标资源路径（优先使用 PLUGIN_ICON 映射的完整路径，无对应图则回退插件目录）。
 * @param {string} id 插件 id
 * @returns {string} 图标路径
 */
export function getIcon(id) {
    return PLUGIN_ICON[id] || `./mods/${id}/icon.png`;
}

/**
 * 冷加载插件：按需 fetch 并注入 index.html / style.css / script.js。
 * 若该插件窗口已存在，则直接置顶（不重复注入）。
 * @param {string} id 插件 id
 * @param {object} opts 可选参数 { light, centered }
 * @returns {Promise<HTMLElement|null>} 插件窗口根元素（无窗口则 null）
 */
export async function load(id, opts = {}) {
    const manifest = registry.get(id);
    if (!manifest) {
        console.warn(`[plugin-manager] 插件未注册: ${id}`);
        return null;
    }

    const { light = null, centered = false } = opts;

    // 窗口名：优先用 manifest.entry 决定窗口 id 规则；沿用插件显示名作为窗口 id
    const windowName = manifest.windowName || manifest.name;

    // 若窗口已存在，直接置顶
    const existing = document.getElementById(windowName);
    if (existing) {
        // 启动台为 fullscreen 入口，根元素是 .launchpad（非 .window、无 id），
        // 上面的 id 判断对其恒为 null；这里用类名识别已存在实例并复用重显，
        // 避免每次打开都重复注入导致堆叠或空白面板。
        if (manifest.entry === "fullscreen") {
            reopenLaunchpad();
            return existing;
        }
        const { bringToFront } = await import("./window.js");
        bringToFront(existing, windowName);
        return existing;
    }
    // 启动台复用：当前文档中已存在 .launchpad 实例（可能处于退出动画中）时，
    // 直接重显而不重复注入新的 HTML/脚本，确保二次及之后每次唤起都能稳定显示界面。
    if (manifest.entry === "fullscreen") {
        const lp = document.querySelector(".launchpad");
        if (lp && lp.isConnected) {
            reopenLaunchpad();
            return lp;
        }
    }

    // 注入样式（去重：同一插件不重复注入）
    const styleId = `plugin-style-${id}`;
    if (!document.getElementById(styleId)) {
        const link = document.createElement("link");
        link.id = styleId;
        link.rel = "stylesheet";
        link.href = `./mods/${id}/${manifest.style || "style.css"}?v=${Date.now()}`;
        document.querySelector("head").appendChild(link);
    }

    // 注入 HTML
    const htmlRes = await fetch(`./mods/${id}/${manifest.main || "index.html"}?v=${Date.now()}`);
    if (!htmlRes.ok) {
        throw new Error(`加载插件 ${id} 的 index.html 失败：HTTP ${htmlRes.status}`);
    }
    const htmlText = await htmlRes.text();
    document.body.insertAdjacentHTML("beforeend", htmlText);

    // 找到新注入的窗口元素
    const wins = document.querySelectorAll(".window");
    let newWin = wins.length ? wins[wins.length - 1] : null;
    if (newWin) {
        if (!newWin.id) newWin.id = windowName;
        // 标记插件 id，供关闭时 plugin-manager.unload 精准释放该应用资源（CSS / 脚本 / 全局监听）
        newWin.dataset.pluginId = id;
    }

    // 应用 manifest.window 声明的窗口尺寸（覆盖 CSS 默认宽高，避免窗口被压缩）
    const winConf = manifest.window || {};
    if (newWin) ["width", "height"].forEach((k) => winConf[k] && (newWin.style[k] = `${winConf[k]}px`));

    // 居中处理：应用商店等入口未传 centered 时，以 manifest.window.centered 为准
    // 统一交给 window.js 的 centerWindow，排除 finderbar 与 dock 后做边界限制，
    // 避免各插件自行计算导致窗口遮挡 Dock 或被 Dock 挤压。
    const shouldCenter = centered || winConf.centered;

    // 追加逻辑脚本：先移除旧实例脚本，再注入本次脚本。
    // 关键修复：原"去重"判断（无旧脚本才注入）会在上一实例的脚本元素仍残留于 DOM 时
    // （例如启动台关闭动画尚未结束）跳过注入，导致本次新注入的界面拿不到 init() 逻辑、
    // 表现为二次打开失效。改为始终移除旧脚本后重新注入，保证每次打开都执行最新逻辑。
    // 窗口类插件在上方已通过 existing 判断走 bringToFront 提前返回，不会进入此分支，故无副作用。
    const scriptSelector = `script[plugin="${id}"]`;
    const oldScript = document.querySelector(scriptSelector);
    if (oldScript) oldScript.remove();
    const script = document.createElement("script");
    script.src = `./mods/${id}/${manifest.script || "script.js"}?v=${Date.now()}`;
    script.type = "module";
    script.setAttribute("plugin", id);
    document.body.appendChild(script);

    // 交给 window.js 绑定窗口拖拽/缩放/关闭/全屏逻辑
    const { resetWindowListeners, bringToFront, centerWindow } = await import("./window.js");
    resetWindowListeners(windowName, light);

    // 新建窗口后置顶并刷新顶栏菜单（触发 updateMenu → appMenu 切到当前应用）
    if (newWin) {
        if (shouldCenter) centerWindow(newWin);
        bringToFront(newWin, windowName);
    }

    // 通知程序坞：根据实际打开的窗口刷新运行区与指示灯
    // （应用商店卡片「打开」、openAppByName、启动台等入口均经此统一收敛）
    if (window.__dock && typeof window.__dock.syncRunningApps === "function") {
        window.__dock.syncRunningApps();
    }

    return newWin;
}

/**
 * 卸载插件并立即释放其占用的内存资源（冷加载的反向操作）。
 *
 * 在窗口关闭（红灯 / 强制退出 / 最小化到 Dock 后关闭）时由 window.js 调用，
 * 确保未激活的应用不保留任何实例、样式或脚本，降低整体内存占用：
 * 1. 派发 plugin-unload 事件，通知插件清理自身注册的全局监听 / 定时器 / 轮询；
 * 2. 移除插件窗口 DOM（fullscreen 入口根元素为 .launchpad，无 id）；
 * 3. 移除插件样式表 plugin-style-<id>（释放 CSSOM）；
 * 4. 移除插件脚本 script[plugin=<id>]（避免常驻 DOM）。
 * @param {string} id 插件 id
 * @returns {void}
 */
export function unload(id) {
    const manifest = registry.get(id);

    // 1. 通知插件自检清理（定时器、document/window 级监听等）。
    //    插件需监听 plugin-unload 事件并在回调中移除自身注册的全局资源。
    window.dispatchEvent(new CustomEvent("plugin-unload", { detail: { id } }));

    // 2. 移除窗口 DOM（fullscreen 入口根元素无 id，按类名定位）
    let win = manifest && manifest.entry === "fullscreen"
        ? document.querySelector(".launchpad")
        : document.getElementById(manifest ? (manifest.windowName || manifest.name) : id);
    if (win && win.isConnected) win.remove();

    // 3. 移除插件样式表（释放 CSSOM，避免样式规则常驻内存）
    const style = document.getElementById(`plugin-style-${id}`);
    if (style) style.remove();

    // 4. 移除插件脚本（避免脚本元素常驻 DOM）
    const script = document.querySelector(`script[plugin="${id}"]`);
    if (script) script.remove();
}

/**
 * 为 ZIP 安装预留的注册接口（基础版）。
 * 本迭代：将清单写入 IndexedDB，并合并到注册表。
 * @param {object} manifest 插件清单
 * @param {Record<string,string>} files 文件名 -> 内容映射（本迭代仅注册清单，不落盘）
 * @returns {Promise<boolean>}
 */
export async function registerInstalledPlugin(manifest, files) {
    if (!manifest || !manifest.id) return false;
    // 标记为 ZIP 安装插件，供应用商店「已安装」分类识别与还原时区分
    manifest._installed = true;
    try {
        await _tx("readwrite", (store) => store.put({ ...manifest, files }));
    } catch (err) {
        console.warn("[plugin-manager] 写入 IndexedDB 失败，仅内存注册", err);
    }
    return registerPlugin(manifest);
}

/**
 * 读取全部已安装（ZIP）插件记录，用于启动时还原。
 * @returns {Promise<Array<object>>}
 */
async function _getAllInstalled() {
    return (await _tx("readonly", (store) => store.getAll())) || [];
}

/**
 * 卸载并删除一个已安装（ZIP）插件的持久化记录（含 IndexedDB 与内存注册表）。
 * 仅删除用户安装的插件；内置插件不受影响。
 * @param {string} id 插件 id
 * @returns {Promise<boolean>}
 */
export async function unregisterInstalledPlugin(id) {
    try {
        await _tx("readwrite", (store) => store.delete(id));
    } catch (err) {
        console.warn("[plugin-manager] 删除已安装插件记录失败", err);
    }
    return unregisterPlugin(id);
}

/**
 * 打开插件安装数据库（懒加载）。
 * @returns {Promise<IDBDatabase>}
 */
function _openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open("webstartos-plugins", 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("installed")) {
                db.createObjectStore("installed", { keyPath: "id" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// 在 webstartos-plugins 库 installed 表上执行一次事务；
// action 接收 objectStore 并可返回请求，事务完成时 resolve 为请求结果（无请求则为 undefined）。
function _tx(mode, action) {
    return _openDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction("installed", mode);
        const req = action(tx.objectStore("installed"));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject((req && req.error) || tx.error);
    }));
}

// 导出常量供其它模块使用
export { BUILTIN_IDS };