/**
 * plugin-manager.js — 插件管理器（冷加载核心引擎）
 *
 * 职责：
 * 1. 启动时仅拉取各插件 manifest.json 建立注册表（冷加载，不加载内容）。
 * 2. 提供插件注册/注销/查询/按显示名解析等 API。
 * 3. 点击启动时按需 fetch 插件 index.html / style.css / script.js 并注入主文档。
 * 4. 多应用插件（manifest.apps）按 appId 打开子应用：外壳只注入一份，
 *    子应用各自一个窗口，关闭时按存活窗口数引用计数拆除外壳（loadApp / unloadApp）。
 * 5. 为 ZIP 安装预留注册接口（本迭代实现基础版）。
 *
 * 窗口控制（拖拽/缩放/关闭/全屏/置顶）仍由 window.js 负责，本模块不越界。
 * 插件主文档采用注入式运行，保留现有应用内部 document.querySelector 访问方式。
 */

import { VERSION } from "./version.js";
// 资源路径统一由 paths.js 生成（./mods/<id>/… 与 assets 下的公共图标只有这一个出处）
import { GENERIC_APP_ICON, modFile, modUrl, modDateUrl } from "./paths.js";
import { brandIcon } from "./office-brand.js";
// 窗口层必须静态引入：插件界面注入后要立刻隐藏并在同一帧内完成尺寸/居中，
// 否则 `await import("./window.js")` 的网络往返会先画出一帧「默认 680×570、
// 未居中」的裸窗口，再跳到真实尺寸 —— 这正是用户看到的打开瞬间错位。
// window.js 只在函数内部动态 import 本模块，静态依赖方向是单向的，不成环。
import { bringToFront, manage, prepareOpen, revealOpen } from "./window-manager.js";
// 确保应用 HTML 注入前 <deskly-traffic-lights> 已注册（只要副作用）。
// 能力禁用态改由 window-manager.applyConfig 统一落实，本模块不再自己调。
// 说明符不带 ?v=，否则会被当作第二个模块重复求值。
import "./ui/trafficLights.js";
import {
    registerPlugin,
    unregisterPlugin,
    getPlugins,
    getPlugin,
    hasPlugin,
    isReady,
    whenReady,
    resolveName,
    broadcast,
    markReady,
    listApps,
    getApp,
    resolveAppId,
    resolveAppRecord,
    getAppByExtension,
    disabledIds,
    isPluginEnabled,
    setPluginEnabled,
} from "./app-registry.js";

// 注册表查询 API 现由 app-registry.js 提供；这里 re-export 保持既有
// import 方（dock / launchpad / app-store / bootstrap / window.js 全局钩子）不变。
export {
    registerPlugin,
    unregisterPlugin,
    getPlugins,
    getPlugin,
    isReady,
    whenReady,
    resolveName,
    broadcast,
    listApps,
    getApp,
    resolveAppId,
    resolveAppRecord,
    getAppByExtension,
    disabledIds,
    isPluginEnabled,
    setPluginEnabled,
};

// 内置插件 id 列表（冷加载时据此逐个拉取清单）
// 图片与视频的查看能力已统一收进「照片」（photos），不再单独随包发布查看器插件。
const BUILTIN_IDS = [
    "calculator",
    "finder",
    "launchpad",
    "system-settings",
    "about",
    "app-store",
    "notepad",
    "photos",
    "vs_code",
    "siri",
    "safari",
    "office",
    "manual",
];

// 重显启动台：取消遗留退出计时器并标记运行态（启动台为 fullscreen 入口，根元素 .launchpad 无 id）
function reopenLaunchpad() {
    if (window.__launchpad && window.__launchpad.reopen) window.__launchpad.reopen();
    window.appStatus["启动台"] = true;
}

// 资源名的合法形态：仅允许目录内单层文件名，禁止 . 与 / 与路径分隔符
const SAFE_ASSET = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

/**
 * 校验并返回可安全拼进 `./mods/<id>/<file>` 的资源名。
 * ZIP 插件的 manifest 属于不可信输入，未校验时 `main: "../../x.html"`
 * 会被 URL 规范化后跳出插件目录，读取包内任意文件。
 * @param {string} raw 声明的资源名
 * @param {string} fallback 缺省值
 * @param {string} id 插件 id（仅日志用）
 * @returns {string} 通过校验的资源名
 */
function safeAssetName(raw, fallback, id) {
    if (raw === undefined || raw === null || raw === "") return fallback;
    const name = String(raw).replace(/^\.\//, "");
    if (!SAFE_ASSET.test(name) || name.includes("..")) {
        console.warn(`[plugin-manager] 插件 ${id} 的资源名不合法，已回退默认值：${raw}`);
        return fallback;
    }
    return name;
}

/**
 * 样式就绪兜底时长：资源被拦截、浏览器又不派发 load/error 时，
 * 宁可让界面以当前样式打开，也不能把应用永久卡在「正在加载」。
 */
const STYLE_READY_TIMEOUT_MS = 1500;

/**
 * 等一个样式表真正可参与渲染（load / error / 超时三者取先到）。
 * @param {HTMLLinkElement} link 已插入或即将插入的 <link rel="stylesheet">
 * @returns {Promise<void>}
 */
function whenStyleReady(link) {
    if (!link) return Promise.resolve();
    try {
        // 同源样式加载完成后 sheet 非空；缓存命中时直接放行，不再多等一次事件。
        if (link.sheet) return Promise.resolve();
    } catch (err) {
        // 跨域样式表读 sheet 会抛错；本项目的插件样式都是同源资源，这里只做兜底。
    }
    return new Promise((resolve) => {
        let done = false;
        let timer = 0;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            link.removeEventListener("load", finish);
            link.removeEventListener("error", finish);
            resolve();
        };
        // 监听必须先于 append：缓存命中时 load 可能在下一个微任务之前就派发。
        link.addEventListener("load", finish, { once: true });
        link.addEventListener("error", finish, { once: true });
        timer = setTimeout(() => {
            console.warn(`[plugin-manager] 样式未在 ${STYLE_READY_TIMEOUT_MS}ms 内就绪，继续加载：${link.href}`);
            finish();
        }, STYLE_READY_TIMEOUT_MS);
    });
}

/**
 * 注入插件样式表并等它可用。
 *
 * 为什么必须等：旧实现只 append <link> 就继续 fetch / 注入 HTML。样式表是异步的，
 * 插件界面的栅格、侧栏宽度、标题栏高度都写在它里面，HTML 先到时浏览器会按
 * 无样式的块级流排版，等 CSS 到达后再整体跳一次 —— 用户看到的就是「打开第一瞬间
 * 内容错位」。同一插件的后续窗口会命中已加载的 link，直接放行。
 * @param {string} id 插件 id
 * @param {string} href 样式表地址（已带缓存参数）
 * @returns {Promise<void>}
 */
function ensurePluginStyle(id, href) {
    const styleId = `plugin-style-${id}`;
    const existing = document.getElementById(styleId);
    if (existing) return whenStyleReady(existing);
    const link = document.createElement("link");
    link.id = styleId;
    link.rel = "stylesheet";
    link.href = href;
    const ready = whenStyleReady(link);
    document.querySelector("head").appendChild(link);
    return ready;
}

/**
 * 剥离不可信插件 HTML 中的可执行内容：内联事件处理器、<script>、javascript: 链接。
 * 只做「去掉执行能力」，不改变结构，避免把插件界面改坏。
 * @param {string} html 插件 index.html 原文
 * @returns {string} 净化后的 HTML
 */
const INLINE_EVENT_ATTR = /^on[a-z]+$/;
const UNSAFE_URL_SCHEME = /^\s*(?:javascript|data)\s*:/i;
function sanitizePluginHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script").forEach((el) => el.remove());
    doc.querySelectorAll("*").forEach((el) => {
        Array.from(el.attributes).forEach((attr) => {
            if (INLINE_EVENT_ATTR.test(attr.name)) {
                el.removeAttribute(attr.name);
            } else if ((attr.name === "href" || attr.name === "src" || attr.name === "srcdoc")
                && UNSAFE_URL_SCHEME.test(attr.value)) {
                el.removeAttribute(attr.name);
            }
        });
    });
    return doc.body.innerHTML;
}

/**
 * 解析 manifest.icon 为可用路径。
 * 规则（按仓库既有约定消歧，避免同一份声明被解析成两个不同文件）：
 *   - `assets/…`（可带 `./` 前缀）一律视为站点根相对；
 *   - 其它值相对插件目录 `./mods/<id>/` 解析（兼容文档规定的裸文件名与历史的
 *     `../../assets/icons/X.png` 写法）；
 *   - 只接受最终落在 `./mods/<id>/` 或 `./assets/` 内的结果，其它一律回退。
 * @param {object} manifest 插件清单
 * @param {string} id 插件 id
 * @returns {string|null}
 */
function resolveManifestIcon(manifest, id) {
    if (!manifest.icon || typeof manifest.icon !== "string") return null;
    try {
        // 以文档所在目录为基准（document.baseURI 可能指向 index.html 本身）
        const base = new URL("./", document.baseURI).href;
        const raw = manifest.icon.trim().replace(/^\.\//, "");
        const modDir = new URL(`mods/${id}/`, base).href;
        // `assets/…` 直接相对站点根，但仍要走同一套越界校验：
        // 否则 `assets/../../mods/other/x.png` 这类带 .. 的写法会被原样拼进 URL，
        // 由浏览器规范化后跳出 assets/ 目录。
        const target = /^assets\//.test(raw)
            ? new URL(raw, base)
            : new URL(raw, modDir);
        const allowed = [modDir, `${base}assets/`];
        return allowed.some((prefix) => target.href.startsWith(prefix))
            ? `./${target.href.slice(base.length)}`
            : null;
    } catch (err) {
        return null;
    }
}

/**
 * 启动插件管理器：逐个拉取内置插件的 manifest.json 建立注册表。
 * 仅注册清单，不加载任何界面内容（冷加载）。
 * @returns {Promise<void>}
 */
export async function init() {
    const tasks = BUILTIN_IDS.map(async (id) => {
        try {
            const res = await fetch(modUrl(id, "manifest.json", VERSION));
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
            if (!hasPlugin(manifest.id)) registerPlugin(manifest);
        }
    } catch (err) {
        console.warn("[plugin-manager] 还原已安装插件失败", err);
    }

    markReady();
    broadcast("plugins-ready", { plugins: getPlugins() });
}

// 注册表读写（registerPlugin / unregisterPlugin / getPlugins / getPlugin /
// isReady / whenReady / resolveName / broadcast / markReady）已抽到 app-registry.js，
// 本文件顶部 re-export 上述符号以兼容既有 import 方，这里不再重复定义。

// 占位图标定义在 paths.js（唯一来源），这里 re-export 给 dock / launchpad / app-store。
export { GENERIC_APP_ICON };

/**
 * 返回插件图标资源路径。
 * 顺序：manifest.icon（插件自己的声明，唯一权威来源）→ 插件目录 icon.png
 * → 由调用方的 img.onerror 落到 GENERIC_APP_ICON。
 * 中间那份 PLUGIN_ICON 人工映射已删：它存在的唯一理由是内置插件不写 manifest.icon，
 * 而现在 14 个内置插件全部把图标带在自己目录里（ZIP 安装要求插件目录自包含，
 * 把图标留在 assets/ 就成了包外依赖），映射表本身再没人读过。
 * @param {string} id 插件 id
 * @returns {string} 图标路径
 */
export function getIcon(id) {
    const manifest = getPlugin(id);
    // 未注册（清单还没就绪，Dock 收藏项在此之前就已渲染）时直接给占位图：
    // 拼 ./mods/<id>/icon.png 是一张必然 404 的图，还会先闪一下占位再被换回真图标。
    // 清单就绪后 dock 的 refreshIconsFromRegistry() 会用正确的 src 重新校准。
    if (!manifest) return GENERIC_APP_ICON;
    return resolveManifestIcon(manifest, id) || modFile(id, "icon.png");
}

/**
 * 按显示名 / appId 取图标，多应用插件优先用 app 级 icon。
 * Dock 运行区与启动台手里只有「应用名」（窗口 id），单靠插件 id 会让
 * 文稿 / 表格 / 演示三颗图标全显示成同一个套件的图。
 * @param {string} nameOrId 显示名、插件 id 或 appId
 * @returns {string|null} 图标路径；无法解析时返回 null 交回调用方兜底
 */
export function getIconForName(nameOrId) {
    const rec = resolveAppRecord(nameOrId);
    if (!rec) return null;
    // 办公子应用按品牌包取图标（MS 图标缺失时 brandIcon 自动回退 iWork）。
    if (String(rec.appId || "").startsWith("office.")) {
        const branded = brandIcon(rec.appId);
        if (branded) return branded;
    }
    if (!rec.app) return getIcon(rec.id);
    return resolveManifestIcon(rec.app, rec.id) || getIcon(rec.id);
}

// 正在加载中的插件：id -> Promise。
// 旧实现只按 getElementById 判断窗口是否存在，而窗口 id 要等 fetch 完成后才写入，
// 因此连点两次「打开」会同时通过判断、注入两份界面与两个脚本实例。
const loadingMap = new Map();

// 多应用插件（manifest.apps）专用状态：
// - liveShells：已注入「样式 + 逻辑脚本」外壳且仍被至少一个应用窗口使用的插件 id。
//   外壳只注入一次，后续 appId 只补注入该应用自己的 HTML 片段；模块脚本带
//   ?v=Date.now() 每次注入都会重新求值，重复注入等于把同一份全局监听挂两遍。
// - appLoading：appId -> Promise，与 loadingMap 同理，防连点重复注入。
const liveShells = new Set();
const appLoading = new Map();

/**
 * 该插件是否声明了多个应用（manifest.apps 非空）。
 * @param {object} manifest 插件清单
 * @returns {boolean}
 */
function isMultiApp(manifest) {
    return Array.isArray(manifest.apps) && manifest.apps.length > 0;
}

/**
 * 落实 manifest.window 声明（尺寸 / 禁缩放 / 红绿灯禁用态 / 居中）。
 * 单应用与多应用两条注入路径共用。
 *
 * 这里只把清单值交给窗口管理器，不再自己写内联样式：尺寸与可缩放性的权威是
 * 应用自己界面上的 data-window 声明（插件作者改尺寸只动一个文件），manifest.window
 * 降格为「应用没声明时的缺省」。真正的优先级合并与落地在 window-manager.applyConfig。
 * @param {HTMLElement|null} newWin 本次新增的窗口根元素
 * @param {object} winConf manifest.window（或 app.window 覆盖后的合并结果）
 */
function applyWindowChrome(newWin, winConf) {
    if (!newWin) return;
    newWin._wmKernelConf = { ...(newWin._wmKernelConf || {}), ...(winConf || {}) };
}

/**
 * 通知程序坞按实际打开的窗口刷新运行区与指示灯。
 * @returns {void}
 */
function syncDock() {
    if (window.__dock && typeof window.__dock.syncRunningApps === "function") {
        window.__dock.syncRunningApps();
    }
}

/**
 * 把「要打开的文件」交给插件。
 * 走独立事件而不是塞进 plugin-app-load 的 detail：同一个应用窗口可能反复接收
 * 不同文件（访达里双击第二个 docx 时窗口已经存在），插件只需要实现一个
 * `plugin-app-open` 回调就能同时覆盖「开新窗带文件」和「复用旧窗换文件」两种情形。
 * @param {string} id 插件 id
 * @param {string} appId 应用 id
 * @param {string} windowName 窗口元素 id
 * @param {string|null} file 文件路径（VFS 路径），未传即本次打开不带文件
 * @returns {void}
 */
function announceFile(id, appId, windowName, file) {
    if (!file) return;
    broadcast("plugin-app-open", { id, appId, windowName, file: String(file) });
}

/**
 * 冷加载插件：按需 fetch 并注入 index.html / style.css / script.js。
 * 若该插件窗口已存在，则直接置顶（不重复注入）。
 * 多应用插件没有「插件级窗口」，转到其第一个应用（App Store 卡片「打开」等
 * 只知道插件 id 的调用方由此得到一个确定的落点）。
 * @param {string} id 插件 id
 * @param {object} opts 可选参数 { light, centered }
 * @returns {Promise<HTMLElement|null>} 插件窗口根元素（无窗口则 null）
 */
export function load(id, opts = {}) {
    const manifest = getPlugin(id);
    if (!manifest) {
        console.warn(`[plugin-manager] 插件未注册: ${id}`);
        return Promise.resolve(null);
    }
    // 禁用是用户意图，必须拦住所有入口：启动台/程序坞只是不显示，但访达双击文件、
    // 顶栏菜单、深链这些路径还认得这个插件，放行就等于「禁用无效」。
    if (!isPluginEnabled(id)) {
        console.warn(`[plugin-manager] 插件已被禁用: ${id}`);
        return Promise.resolve(null);
    }
    if (isMultiApp(manifest)) return loadApp(`${id}.${manifest.apps[0].id}`, opts);
    if (!loadingMap.has(id)) {
        const task = doLoad(id, manifest, opts).finally(() => loadingMap.delete(id));
        loadingMap.set(id, task);
    } else if (opts.file) {
        // 首次装载期间又收到带文件的打开请求：等本次装载完成后补一次文件事件，
        // 否则第二次双击的路径会被 loadingMap 的复用静默吞掉。
        const windowName = manifest.windowName || manifest.name;
        loadingMap.get(id).then((win) => {
            if (win) announceFile(id, id, windowName, opts.file);
        });
    }
    return loadingMap.get(id);
}

/**
 * 按 appId 加载多应用插件中的一个应用实例。
 * 外壳（样式 + 脚本）只在首个应用打开时注入，之后每个 appId 仅注入
 * 自己的 HTML 片段并派发 plugin-app-load，界面初始化由插件在该回调里完成。
 * @param {string} appId 应用 id（插件id.appId）
 * @param {object} opts 可选参数 { light, centered }
 * @returns {Promise<HTMLElement|null>} 该应用的窗口根元素
 */
export function loadApp(appId, opts = {}) {
    const rec = getApp(appId);
    if (!rec || !rec.app) {
        console.warn(`[plugin-manager] 应用未注册: ${appId}`);
        return Promise.resolve(null);
    }
    if (!isPluginEnabled(rec.id)) {
        console.warn(`[plugin-manager] 插件已被禁用: ${rec.id}`);
        return Promise.resolve(null);
    }
    if (!appLoading.has(appId)) {
        const task = doLoadApp(appId, rec, opts).finally(() => appLoading.delete(appId));
        appLoading.set(appId, task);
    }
    return appLoading.get(appId);
}

/**
 * 统一打开入口：按显示名 / 插件 id / appId 解析并加载。
 * Dock、启动台、应用商店、顶栏菜单等调用方只需给出应用名，
 * 不必知道它是单应用插件还是多应用插件里的一个子应用。
 * @param {string} nameOrId 显示名 / 插件 id / appId
 * @param {object} opts 可选参数 { light, centered }
 * @returns {Promise<HTMLElement|null>}
 */
export function openApp(nameOrId, opts = {}) {
    const appId = resolveAppId(nameOrId);
    const rec = appId ? getApp(appId) : undefined;
    if (rec && rec.app) return loadApp(rec.appId, opts);
    return load(appId || nameOrId, opts);
}

async function doLoadApp(appId, rec, opts) {
    const { light = null, centered = false, file = null } = opts;
    const { id, app, manifest } = rec;
    const stamp = manifest._installed ? Date.now() : VERSION;
    const windowName = rec.windowName;

    // 同一 appId 的窗口已存在则置顶复用（与单应用路径同一套去重语义）。
    // 必须校验 data-app-id：两个应用同名时按 id 命中别人的窗口会把它误当自己。
    const existing = document.getElementById(windowName);
    if (existing && existing.classList.contains("window") && existing.dataset.appId === appId) {
        bringToFront(existing, windowName);
        announceFile(id, appId, windowName, file);
        return existing;
    }

    // 同 load()：按「body > .window 的集合差」取本次新增窗口，理由见那里。
    const preWins = new Set(document.querySelectorAll("body > .window"));
    let htmlText;
    try {
        // 外壳（样式 + 脚本）：首个应用打开时注入，脚本必须等它执行完，
        // 否则紧随的 plugin-app-load 事件会派发到还没监听的状态。
        await ensureShell(id, manifest, stamp);
        const htmlRes = await fetch(modUrl(id, safeAssetName(app.main, `${app.id}.html`, id), stamp));
        if (!htmlRes.ok) throw new Error(`加载应用 ${appId} 的界面失败：HTTP ${htmlRes.status}`);
        htmlText = await htmlRes.text();
    } catch (err) {
        // 注入界面之前任一步失败：若此刻该插件没有任何存活窗口，回滚外壳，
        // 否则 liveShells / 样式 / 脚本永久残留，unloadApp 再也不会触发，该套件再也打不开。
        teardownShellIfOrphan(id);
        throw err;
    }
    if (manifest._installed) htmlText = sanitizePluginHtml(htmlText);
    document.body.insertAdjacentHTML("beforeend", htmlText);

    const addedWins = Array.from(document.querySelectorAll("body > .window"))
        .filter((w) => !preWins.has(w));
    const newWin = addedWins.length ? addedWins[addedWins.length - 1] : null;
    if (newWin) {
        // 先隐藏再量尺寸：HTML 一旦进入 DOM 就有一次绘制机会，默认 .window 是
        // 680×570 且未居中；等 window-manager 算完真实尺寸再显示，避免首帧错位。
        prepareOpen(newWin);
        // 多应用一律按 app 声明强制命名：同一份 HTML 被复制成多个窗口时，
        // 保留插件名会让第二个应用与第一个撞 id，去重判断就此失效。
        newWin.id = windowName;
        newWin.dataset.pluginId = id;
        newWin.dataset.appId = appId;
    }

    const winConf = { ...(manifest.window || {}), ...(app.window || {}) };
    // centered 有两个来源：本次调用参数（应用商店/启动台）与清单声明，合并后一起交给窗口管理器，
    // 免得「applyConfig 一次、centerWindow 再一次」两套居中逻辑各算各的。
    applyWindowChrome(newWin, { ...winConf, centered: centered || winConf.centered });

    if (newWin) {
        // 必须在同一帧内完成接管与居中：动态 import 会多一次网络往返，
        // 那段时间足够浏览器先画出默认尺寸的裸窗口（错位根因）。
        manage(newWin, { name: windowName, light });
        bringToFront(newWin, windowName);
    }

    broadcast("plugin-app-load", { id, appId, windowName, el: newWin });
    announceFile(id, appId, windowName, file);
    syncDock();
    // 几何与外壳都稳定后再显示，动画从最终位置开始（见 window-manager.revealOpen）。
    revealOpen(newWin);
    return newWin;
}

/**
 * 注入多应用插件的外壳（样式 + 逻辑脚本），同一插件只注入一次。
 * 与单应用路径的差别：单应用每次打开都重注入脚本（顶层 init 依赖全新 URL），
 * 多应用的脚本要跨应用实例常驻，因此靠 liveShells 保证只有一份。
 * @param {string} id 插件 id
 * @param {object} manifest 插件清单
 * @param {string|number} stamp 样式缓存参数（发布版本或安装时间戳）
 * @returns {Promise<void>}
 */
async function ensureShell(id, manifest, stamp) {
    if (liveShells.has(id)) return;

    // 外壳样式是各子应用窗口的共同排版基础：等它可用再注入任何 HTML。
    await ensurePluginStyle(id, modUrl(id, safeAssetName(manifest.style, "style.css", id), stamp));

    const old = document.querySelector(`script[plugin="${id}"]`);
    if (old) old.remove();
    const script = document.createElement("script");
    script.src = modDateUrl(id, safeAssetName(manifest.script, "script.js", id));
    script.type = "module";
    script.setAttribute("plugin", id);
    // 并列提示当前正在注入哪个插件，供 os-api.js 的调用者识别兜底用。
    // 权威判据是调用栈里的 mods/<id>/ 帧：注入是 await 的，两个插件可能交错，
    // 这个值只能当提示，不能当权限依据（api-grants.js getCallerPluginId 注释说明了边界）。
    window.__currentPluginId = id;
    await new Promise((resolve, reject) => {
        script.addEventListener("load", () => {
            if (window.__currentPluginId === id) window.__currentPluginId = null;
            resolve();
        }, { once: true });
        script.addEventListener("error", () => {
            if (window.__currentPluginId === id) window.__currentPluginId = null;
            reject(new Error(`加载插件 ${id} 的脚本失败`));
        }, { once: true });
        document.body.appendChild(script);
    });
    liveShells.add(id);
}

/**
 * 打开失败时的外壳回滚：仅当该插件此刻没有任何存活窗口时，才移除其样式/脚本并清
 * liveShells 标记。用于 loadApp/doLoad 在「注入界面之前」出错的分支——若不回滚，
 * liveShells 会卡在 true、样式与脚本残留，unloadApp 永不触发，该插件此后再也打不开。
 * @param {string} id 插件 id
 */
function teardownShellIfOrphan(id) {
    if (document.querySelector(`.window[data-plugin-id="${id}"]`)) return; // 兄弟窗口还在，保留共享外壳
    liveShells.delete(id);
    const link = document.getElementById(`plugin-style-${id}`);
    if (link) link.remove();
    const script = document.querySelector(`script[plugin="${id}"]`);
    if (script) script.remove();
}


async function doLoad(id, manifest, opts) {
    const { light = null, centered = false, file = null } = opts;
    // 已安装（ZIP）插件的资源可被同 id 覆盖安装，按打开时刻失效缓存；
    // 内置插件按发布版本号，同一发布内可复用 HTTP 缓存。
    const stamp = manifest._installed ? Date.now() : VERSION;

    // 窗口名：优先用 manifest.entry 决定窗口 id 规则；沿用插件显示名作为窗口 id
    const windowName = manifest.windowName || manifest.name;

    // 已存在实例的复用判断必须按入口类型分流：
    // - fullscreen（启动台）：根元素是 .launchpad（非 .window、无 id），只能用类名识别。
    //   若误用 getElementById(windowName) 查「启动台」，会命中页面上被误写 id 的其他元素
    //   （如顶栏「窗口」菜单 <p class="window">），导致只调 reopen 而不注入界面，
    //   表现为二次唤起永久失败。故 fullscreen 一律走 .launchpad 类名，绝不按 id 查。
    // - 普通 window 插件：按窗口 id 判断是否存在并置顶。
    if (manifest.entry === "fullscreen") {
        const lp = document.querySelector(".launchpad");
        if (lp && lp.isConnected) {
            reopenLaunchpad();
            return lp;
        }
    } else {
        const existing = document.getElementById(windowName);
        if (existing) {
            bringToFront(existing, windowName);
            // 单应用插件（如照片）同样要把「用哪个文件唤起」告诉已存在的窗口。
            announceFile(id, id, windowName, file);
            return existing;
        }
    }

    // 注入样式（去重：同一插件不重复注入）并等它可用。
    // 缓存参数用发布版本号而非 Date.now()：Date.now() 让每次打开都重新下载整份 CSS，
    // 而按版本缓存既能随发布失效、又能在同一次发布内复用。
    await ensurePluginStyle(id, modUrl(id, safeAssetName(manifest.style, "style.css", id), stamp));

    // 注入前记录「真窗口」集合，注入后取本次新增的那一个。
    // 两条都不能省：
    // ① 选择器必须是 body > .window —— 页面上存在把 .window 当样式类误用的元素
    //   （顶栏「窗口」菜单历史上就有 <p class="window">），一旦被当成新窗口写入
    //   id / data-plugin-id 并绑上窗口逻辑，污染后还会被 getElementById 命中，
    //   表现为二次打开失效。这正是窗口层 isWindowElement 存在的原因。
    // ② 必须按「集合差集」而不是「数量差 + 最后一个」取 —— 后者在新窗口不是文档
    //   里最后一个 .window 时会取错元素（插件自带嵌套 .window、或注入片段带尾部节点）。
    //   window.js:182-188 早已改成差集法，这里是没跟上的第二、第三处。
    const preWins = new Set(document.querySelectorAll("body > .window"));

    // 注入 HTML
    const htmlRes = await fetch(modUrl(id, safeAssetName(manifest.main, "index.html", id), stamp));
    if (!htmlRes.ok) {
        throw new Error(`加载插件 ${id} 的 index.html 失败：HTTP ${htmlRes.status}`);
    }
    let htmlText = await htmlRes.text();
    // 用户安装的 ZIP 属于不可信输入：insertAdjacentHTML 不会执行 <script>，
    // 但会执行 <img onerror=...> 这类内联事件处理器，因此先剥离。内置插件是我们自己的代码，不处理。
    if (manifest._installed) htmlText = sanitizePluginHtml(htmlText);
    document.body.insertAdjacentHTML("beforeend", htmlText);

    // 找到新注入的窗口元素（仅本次新增的真窗口，fullscreen 入口无 .window 时为 null）
    const added = Array.from(document.querySelectorAll("body > .window"))
        .filter((w) => !preWins.has(w));
    let newWin = added.length ? added[added.length - 1] : null;
    if (newWin) {
        // 与多应用路径同一理由：先隐藏，等真实尺寸/居中落实后再显示。
        prepareOpen(newWin);
        if (!newWin.id) newWin.id = windowName;
        // 标记插件 id，供关闭时 plugin-manager.unload 精准释放该应用资源（CSS / 脚本 / 全局监听）
        newWin.dataset.pluginId = id;
        // 单应用插件的 appId 等于插件 id，一并打标：window.js 关闭时走同一条引用计数路径
        newWin.dataset.appId = id;
    }

    // 应用 manifest.window 声明的窗口尺寸（覆盖 CSS 默认宽高，避免窗口被压缩）
    const winConf = manifest.window || {};
    // 居中来源同上（调用参数 + 清单声明），统一由 window-manager 在接管时落实
    applyWindowChrome(newWin, { ...winConf, centered: centered || winConf.centered });

    // 追加逻辑脚本：先移除旧实例脚本，再注入本次脚本。
    // 关键修复：原"去重"判断（无旧脚本才注入）会在上一实例的脚本元素仍残留于 DOM 时
    // （例如启动台关闭动画尚未结束）跳过注入，导致本次新注入的界面拿不到 init() 逻辑、
    // 表现为二次打开失效。改为始终移除旧脚本后重新注入，保证每次打开都执行最新逻辑。
    // 窗口类插件在上方已通过 existing 判断走 bringToFront 提前返回，不会进入此分支，故无副作用。
    const scriptSelector = `script[plugin="${id}"]`;
    const oldScript = document.querySelector(scriptSelector);
    if (oldScript) oldScript.remove();
    const script = document.createElement("script");
    // 入口脚本必须每次打开都用全新 URL：插件都在脚本顶层执行 init()，
    // 稳定 URL 会让 ES module 缓存命中、第二次打开不再运行任何逻辑。
    // 副作用是模块表不会回收旧实例 —— 因此插件必须在 plugin-unload 里自清全局监听。
    script.src = modDateUrl(id, safeAssetName(manifest.script, "script.js", id));
    script.type = "module";
    script.setAttribute("plugin", id);
    // 与 ensureShell 同一套并列提示：模块求值发生在 appendChild 之后，
    // 所以只能在 load 回调里清，不能在下一行同步清。
    window.__currentPluginId = id;
    script.addEventListener("load", () => {
        if (window.__currentPluginId === id) window.__currentPluginId = null;
        // 单应用插件的脚本在窗口 HTML 注入之后才求值：等 load 再派发文件事件，
        // 插件注册在模块顶层的 plugin-app-open 监听才能收到。
        announceFile(id, id, windowName, file);
        // 模块脚本的 load 在求值之后触发：插件在 init 里用 Deskly.windows.configure
        // 复述尺寸（如计算器按模式算高）时，此时已经落到窗口上。等它再显示，
        // 用户就不会先看到基础尺寸、随后又跳一次的「打开瞬间错位」。
        revealOpen(newWin);
    }, { once: true });
    script.addEventListener("error", () => revealOpen(newWin), { once: true });
    document.body.appendChild(script);

    // 交给 window-manager 绑定窗口拖动/缩放/关闭/全屏/红绿灯逻辑（接管时按声明居中）。
    // 仅真实注入了 .window 时才执行：fullscreen（启动台）无窗口控件，
    // 若无条件调用会遍历页面所有 .window（含顶栏「窗口」菜单等非窗口元素）重复绑定事件。
    if (newWin) {
        // 静态 import 的 manage 与居中在同一帧完成，不会先画出默认几何；
        // 只接管本次新增窗口，不重复遍历整页（旧 resetWindowListeners 的副作用）。
        manage(newWin, { name: windowName, light });

        // 新建窗口后置顶并刷新顶栏菜单（触发 updateMenu → appMenu 切到当前应用）
        bringToFront(newWin, windowName);
    }

    // 通知程序坞：根据实际打开的窗口刷新运行区与指示灯
    // （应用商店卡片「打开」、openAppByName、启动台等入口均经此统一收敛）
    syncDock();
    // 入场由上面的脚本 load 触发；脚本卡住时 prepareOpen 的 1.2s 兜底会显示窗口。
    return newWin;
}

/**
 * 卸载多应用插件中的一个应用实例，并按引用计数决定是否整体拆除插件外壳。
 *
 * 引用计数以 DOM 为准（`.window[data-plugin-id=<id>]` 的存活数量）而不是内部账本：
 * 关闭动画中的窗口已由 window.js 摘除，窗口也可能被插件自身或强制退出移除，
 * 任何账本都会与真实 DOM 漂移，而选择器不会。
 * @param {string} id 插件 id
 * @param {string} appId 应用 id（单应用插件等于插件 id）
 * @returns {void}
 */
export function unloadApp(id, appId) {
    broadcast("plugin-app-unload", { id, appId });
    const survivors = Array.from(document.querySelectorAll(`.window[data-plugin-id="${id}"]`))
        .filter((w) => !w.classList.contains("closing"));
    if (survivors.length) return;
    unload(id);
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
    const manifest = getPlugin(id);

    // 1. 通知插件自检清理（定时器、document/window 级监听等）。
    //    插件需监听 plugin-unload 事件并在回调中移除自身注册的全局资源。
    broadcast("plugin-unload", { id });
    liveShells.delete(id);

    // 2. 移除窗口 DOM。多应用插件可能同时存在多个窗口，按 data-plugin-id 一次清干净
    //    （fullscreen 入口根元素无 id，按类名定位）。
    if (manifest && manifest.entry === "fullscreen") {
        const lp = document.querySelector(".launchpad");
        if (lp && lp.isConnected) lp.remove();
    } else {
        document.querySelectorAll(`.window[data-plugin-id="${id}"]`).forEach((w) => w.remove());
        // 兜底：窗口在打标之前就被注入（历史/第三方写法）时按显示名再清一次
        const legacy = document.getElementById(manifest ? (manifest.windowName || manifest.name) : id);
        if (legacy && legacy.isConnected && !legacy.dataset.pluginId) legacy.remove();
    }

    // 3. 移除插件样式表（释放 CSSOM，避免样式规则常驻内存）
    const style = document.getElementById(`plugin-style-${id}`);
    if (style) style.remove();

    // 4. 移除插件脚本（避免脚本元素常驻 DOM）
    const script = document.querySelector(`script[plugin="${id}"]`);
    if (script) script.remove();
}

/**
 * 通知页面 Service Worker：已安装清单变了，丢掉它的 id 缓存，并**等它确认**。
 *
 * 为什么必须有：sw.js 为了不再对每个内置插件的资源都查一次 IndexedDB，在 SW 里缓存了
 * 「已安装 id 集合」。页面这边写库它看不见 —— 不通知的话，刚装好的插件第一次被请求时
 * 会被当成磁盘插件透传到网络，404 之后安装校验失败并回滚，表现为「装完打不开」。
 *
 * 为什么必须等 ack：postMessage 是异步投递，而 store-api 的 verifyInstall 就在
 * registerInstalledPlugin 之后立刻回读资源。只发不等 = 缓存还没失效就去查，
 * 会变成偶发失败（冷启动时恰好没建过集合就正常，反倒是更难查的那种）。
 * @returns {Promise<void>} SW 确认（或超时兜底）后 resolve
 */
function notifyInstalledChanged() {
    try {
        if (typeof navigator === "undefined" || !navigator.serviceWorker) return Promise.resolve();
        const ack = navigator.serviceWorker.ready
            .then((reg) => new Promise((resolve) => {
                const sw = reg.active || reg.waiting || reg.installing;
                if (!sw) { resolve(); return; }
                const channel = new MessageChannel();
                channel.port1.onmessage = () => resolve();
                sw.postMessage({ type: "installed-changed" }, [channel.port2]);
            }))
            .catch(() => { });
        // 兜底超时必须在外层：ready 在没有 SW 的上下文里永不 resolve，
        // 把它放在 .then 里面就等于没放，await 会一直挂着（安装链直接卡死）。
        return Promise.race([ack, new Promise((resolve) => setTimeout(resolve, 300))]);
    } catch (err) {
        /* Node 侧校验脚本没有 navigator，忽略 */
        return Promise.resolve();
    }
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
    await notifyInstalledChanged();
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
    await notifyInstalledChanged();
    return unregisterPlugin(id);
}

/**
 * 打开插件安装数据库（懒加载 + 连接复用）。
 *
 * 形状必须与 osfs.js:84 / api-grants.js:93 / sw.js 一致 —— 同一个库
 * （webstartos-plugins v1）现在有四处的读写方，各自 indexedDB.open、又从不 close
 * 的写法会攒下一把常驻连接，并且让版本变更互相阻塞。
 * @returns {Promise<IDBDatabase>}
 */
let _dbPromise = null;
function _openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open("webstartos-plugins", 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("installed")) {
                db.createObjectStore("installed", { keyPath: "id" });
            }
        };
        // 被别的连接挡住时 open 不会 success 也不会 error：不清缓存就永久挂死。
        req.onblocked = () => { _dbPromise = null; reject(new Error("IndexedDB 升级被其它连接阻塞")); };
        req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => { db.close(); _dbPromise = null; };
            db.onclose = () => { _dbPromise = null; };
            resolve(db);
        };
        req.onerror = () => { _dbPromise = null; reject(req.error); };
    });
    return _dbPromise;
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