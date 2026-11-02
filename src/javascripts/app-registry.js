/**
 * app-registry.js — 应用/插件注册表（纯数据层，无加载副作用）
 *
 * 职责单一：维护 id -> manifest 的注册表、就绪状态与生命周期事件广播，
 * 并回答「现在有哪些应用、按名 / id 怎么查」。
 *
 * 冷加载引擎（load / unload / init）与 ZIP 持久化仍留在 plugin-manager.js；
 * 本模块把它们依赖的注册表状态抽出来，让 dock / finderbar / launchpad 等核心
 * 模块查询应用时依赖「注册表」这一稳定契约，而非「插件加载器」本身。
 *
 * 模块顶层只做纯数据初始化（Map / 标志 / Promise / 设置项定义），不 fetch、不碰 DOM 之外的
 * document 事件监听——因为它是全局单例，被 window.js 等多处 import，绝不能有
 * 加载副作用。
 *
 * 依赖 `settings.js` 只为存「用户禁用哪些插件」这一个意图（`store.disabled`）：
 * 读方横跨启动台、程序坞与加载器，谁都不该为了它去 import 商店模块。
 */

import { settings } from "./settings.js";
import { i18n } from "./i18n.js";
import { brandLabel, getBrandPack } from "./office-brand.js";

// 显示名 memo：(语言, 品牌包, appId, 中文原名) -> 结果。
// 每个应用的名字对同一组入参是纯函数，但 listApps 每次重建都会逐条重跑 i18n 字典查找；
// 语言与品牌包直接进键，切换语言或换办公品牌包后自然命中新键，不必再挂变更监听。
// 品牌包只影响 office.*，非办公应用不为此多读一次设置。
const displayNameCache = new Map();

/**
 * 应用显示名的 i18n 解析：内核身份永远是清单里的 `name`（中文、跨语言不变，
 * 被 window DOM id / appStatus / data-app / 已持久化的 dock 顺序与启动台布局当键用），
 * 这里只额外算一个「给用户看」的本地化名。查不到就用中文原名兜底，绝不返回 undefined。
 *
 * 键位：单应用 `apps.<id>`（字符串）；多应用套件的子应用 `apps.<id>.<app>`（字符串），
 * 套件自身名走 `apps.<id>.name`（因为 `apps.<id>` 此时是个对象，取它会拿到对象而非字符串）。
 * @param {string} appId 应用 id（单应用=插件 id；多应用=插件id.appId；套件级=插件 id）
 * @param {string} canonical 清单里的中文原名（兜底 + 身份）
 * @returns {string} 当前语言的显示名
 */
function displayAppName(appId, canonical) {
    const office = String(appId || "").startsWith("office.");
    const key = `${i18n.getLanguage()}\u0000${office ? getBrandPack() : ""}\u0000${appId}\u0000${canonical}`;
    if (displayNameCache.has(key)) return displayNameCache.get(key);
    // 办公子应用可被品牌包改名（iWork ↔ Microsoft Office）；返回 null 时沿用 i18n。
    const branded = office ? brandLabel(appId) : null;
    let name;
    if (branded) {
        name = branded;
    } else {
        const direct = i18n.t(`apps.${appId}`, null);
        if (typeof direct === "string" && direct) name = direct;
        else {
            const named = i18n.t(`apps.${appId}.name`, null);
            name = (typeof named === "string" && named) ? named : canonical;
        }
    }
    displayNameCache.set(key, name);
    return name;
}

/**
 * 给「手上只有身份串」的渲染方（dock 的 img.alt、finderbar 的 app 名、spotlight 结果）用：
 * 传 appId / 插件 id / 中文原名，返回当前语言的显示名；解析不到就原样返回入参。
 * 只用于「显示」，调用方继续拿原始串当身份即可。
 * @param {string} nameOrId
 * @returns {string}
 */
export function displayNameFor(nameOrId) {
    const rec = resolveAppRecord(nameOrId);
    return rec ? rec.displayName : String(nameOrId || "");
}

// 插件注册表：id -> manifest 对象
const registry = new Map();

// listApps 的视图缓存与索引：启动期 dock / 启动台 / 访达 / 聚焦会反复问同一份注册表，
// 每次重建数组并逐条跑 i18n 是纯浪费。注册表一变就整体置空、下次查询按需重建 ——
// 比维护「增量更新哪几条」简单得多，也避免漏更新。
let appsCache = null;
let byAppId = null;      // appId -> 应用级记录（getApp / resolveAppRecord 第一级）
let byPluginId = null;   // 插件 id -> 插件级记录（resolveAppRecord 第二级）

// 是否已完成初始化 + 就绪 Promise：bootstrap/launchpad 等需要在注册表建好后才能查询插件
let ready = false;
let resolveReady;
const readyPromise = new Promise((resolve) => { resolveReady = resolve; });

// 暴露全局钩子，供 window.js 等非模块脚本通过名称解析插件（复用 resolveName，避免重复遍历）
// __getAppByName 同样按名称解析，但返回应用级记录（含 manifest.apps 里的子应用），
// 供 finderbar 取应用级菜单、其它模块按 appId 打开应用。
window.__getPluginByName = resolveName;
window.__getAppByName = resolveAppRecord;
window.__pluginManagerReady = whenReady;

/**
 * 广播插件生命周期事件。
 * 在 document 上派发并允许冒泡：监听方有的挂在 window、有的挂在 document，
 * 只在 window 上派发且不冒泡时 document 监听者永远收不到（历史缺陷）。
 * @param {string} type 事件名
 * @param {*} detail 事件数据
 */
export function broadcast(type, detail) {
    document.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
}

// 插件 id 的合法形态：仅允许单层标识，禁止路径分隔符与 ..
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 注册一个插件到注册表。
 * @param {object} manifest 插件清单（含 id/name/version/type/entry/main/style/script/icon 等）
 * @returns {boolean} 是否注册成功
 */
export function registerPlugin(manifest) {
    if (!manifest || !manifest.id) return false;
    // id 会被拼进 ./mods/<id>/ 路径与 script[plugin="<id>"] 选择器，
    // 未校验时恶意 ZIP 可用 "../x" 或带引号的 id 越界读取/选择器注入。
    const id = String(manifest.id);
    if (!SAFE_ID.test(id) || id.includes("..")) {
        console.warn(`[app-registry] 插件 id 不合法，已拒绝注册：${id}`);
        return false;
    }
    manifest.id = id;
    // 多应用清单同样要校验：app.id 会拼进 appId，app.main 会拼进 ./mods/<id>/<main> 资源路径，
    // 未校验的 ZIP 清单可用 "../x" 跳出插件目录读取包内任意文件。
    if (Array.isArray(manifest.apps)) {
        manifest.apps = manifest.apps.filter((a) => {
            const appId = a && typeof a === "object" ? String(a.id || "") : "";
            if (!SAFE_ID.test(appId) || appId.includes("..")) {
                console.warn(`[app-registry] 插件 ${id} 的应用 id 不合法，已忽略该应用：${appId}`);
                return false;
            }
            a.id = appId;
            return true;
        });
    }
    registry.set(id, manifest);
    // 先失效再广播：监听者在事件里查 listApps 时必须看到新清单。
    invalidateIndex();
    broadcast("plugin-registered", manifest);
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
        invalidateIndex();
        broadcast("plugin-unregistered", { id });
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
 * 注册表中是否存在某 id。
 * @param {string} id 插件 id
 * @returns {boolean}
 */
export function hasPlugin(id) {
    return registry.has(id);
}

/**
 * 是否已就绪（已完成清单注册）。
 * @returns {boolean}
 */
export function isReady() {
    return ready;
}

/**
 * 标记注册表就绪（由 plugin-manager.init() 在拉完清单并还原已安装插件后调用）。
 */
export function markReady() {
    ready = true;
    resolveReady();
}

/**
 * 等待注册表就绪。冷加载是异步的，启动瞬间的「打开应用」点击会在
 * registry 仍为空时落到 window.js 的旧版 fetch 分支，取一个不存在的路径并报 404。
 * @returns {Promise<boolean>}
 */
export function whenReady() {
    return readyPromise;
}

/**
 * 由插件显示名解析到插件对象（如「访达」→ finder 插件）。
 * 多应用插件的子应用显示名（如「文稿」→ office 插件）同样在此解析，
 * 否则 window.js / dock / finderbar 这些「按显示名查插件」的老调用方会认不出子应用，
 * 表现为点 Dock 图标没有反应、顶栏菜单落回默认集。
 * 先完整匹配插件名，再匹配子应用名：同名时插件自身优先。
 * @param {string} name 插件或应用的显示名
 * @returns {object|undefined} 插件清单
 */
export function resolveName(name) {
    for (const manifest of registry.values()) {
        // 中文原名（身份）与本地化显示名都能命中：内部调用方多传原名，界面回传的多是显示名
        if (manifest.name === name || displayAppName(manifest.id, manifest.name) === name) return manifest;
    }
    for (const rec of listApps()) {
        if (rec.app && (rec.name === name || rec.windowName === name || rec.displayName === name)) return rec.manifest;
    }
    return undefined;
}

/**
 * 插件级记录（app 为 null）：多应用套件在 listApps 里只有子应用记录，
 * 「套件整体」这条记录只在这里现造一次，供 resolveAppRecord 第二级命中。
 * @param {object} manifest 插件清单
 * @returns {object} 插件级应用记录
 */
function pluginRecord(manifest) {
    const name = manifest.name;
    return {
        appId: manifest.id,
        id: manifest.id,
        app: null,
        manifest,
        name,
        windowName: manifest.windowName || name,
        displayName: displayAppName(manifest.id, name),
    };
}

/**
 * 重建 listApps 视图与索引。
 * byAppId 对重复 appId 保留第一条：原实现是线性扫描、先到先得，索引不能变成后到先得。
 * 记录对象跨调用共享（调用方只读），不做拷贝。
 */
function rebuildIndex() {
    const apps = [];
    const appIndex = new Map();
    const pluginIndex = new Map();
    for (const m of registry.values()) {
        if (Array.isArray(m.apps) && m.apps.length) {
            for (const a of m.apps) {
                const name = a.name || m.name;
                const appId = `${m.id}.${a.id}`;
                const rec = {
                    appId,
                    id: m.id,
                    app: a,
                    manifest: m,
                    name,
                    windowName: a.windowName || name,
                    displayName: displayAppName(appId, name),
                };
                apps.push(rec);
                if (!appIndex.has(appId)) appIndex.set(appId, rec);
            }
            pluginIndex.set(m.id, pluginRecord(m));
        } else {
            const rec = {
                appId: m.id,
                id: m.id,
                app: null,
                manifest: m,
                name: m.name,
                windowName: m.windowName || m.name,
                displayName: displayAppName(m.id, m.name),
            };
            apps.push(rec);
            if (!appIndex.has(rec.appId)) appIndex.set(rec.appId, rec);
            pluginIndex.set(m.id, rec);
        }
    }
    appsCache = apps;
    byAppId = appIndex;
    byPluginId = pluginIndex;
}

/** 注册表 / 启用态变化后的统一失效入口：置空即可，下次查询按需重建。 */
function invalidateIndex() {
    appsCache = null;
    byAppId = null;
    byPluginId = null;
}

/** 确保索引可用（空数组也是有效结果，所以用 null 而不是长度做哨兵）。 */
function ensureIndex() {
    if (!appsCache) rebuildIndex();
}

/**
 * 展开为应用级（appId）记录。
 * 单应用插件：appId === 插件 id；
 * 多应用插件（manifest.apps: [{id,name,...}]）：appId = 插件id.appId，逐条展开。
 * @returns {Array<{appId,id,app,manifest,name,windowName}>}
 */
export function listApps() {
    ensureIndex();
    return appsCache;
}

/**
 * 按 appId 获取应用记录。
 * @param {string} appId 应用 id（插件 id 或 插件id.appId）
 * @returns {object|undefined}
 */
export function getApp(appId) {
    ensureIndex();
    return byAppId.get(appId);
}

/**
 * 按任意可识别输入（显示名 / 窗口名 / 插件 id / appId）获取应用记录。
 * 三级优先，顺序不能调：
 * 1) 精确 appId（`office.word`）；
 * 2) 套件级 —— 插件 id 或插件显示名命中时返回**插件级记录**（`app` 为 null）。
 *    不分这一层的话，按插件名取图标/查菜单会拿到该套件第一个应用的声明
 *    （`getIconForName("office")` 返回 Word 图标就是这个坑）；
 * 3) 子应用显示名 / 窗口名（「文稿」→ office.word）。
 * @param {string} nameOrId 可识别输入
 * @returns {object|undefined}
 */
export function resolveAppRecord(nameOrId) {
    ensureIndex();
    // 一次建索引、三处复用：不再每级都遍历一次 listApps()。
    const direct = byAppId.get(nameOrId);
    if (direct) return direct;
    // 套件级：多应用插件在 listApps 里只有子应用记录，按插件 id / 插件名命中时
    // 要返回一条 app 为 null 的插件级记录，否则图标与菜单会跟着错位。
    let manifest = registry.get(nameOrId);
    if (!manifest) {
        for (const m of registry.values()) {
            if (m.name === nameOrId || displayAppName(m.id, m.name) === nameOrId) { manifest = m; break; }
        }
    }
    if (manifest) return byPluginId.get(manifest.id) || pluginRecord(manifest);
    for (const rec of appsCache) {
        if (rec.app && (rec.name === nameOrId || rec.windowName === nameOrId || rec.displayName === nameOrId)) return rec;
    }
    return undefined;
}

/**
 * 将显示名 / 插件 id / appId 归一解析为 appId。
 * @param {string} nameOrId 任意可识别输入
 * @returns {string|undefined}
 */
export function resolveAppId(nameOrId) {
    const rec = resolveAppRecord(nameOrId);
    return rec ? rec.appId : undefined;
}

/* ───────────────────────── 启用 / 禁用 ───────────────────────── */

// 禁用是**用户意图**，必须比注册表活得久，所以落在设置中枢而不是内存 Set。
// 内置插件同样可以禁用（只是不能卸载），故与「已安装/内置」的来源概念正交。
settings.define({ key: "store.disabled", type: "json", default: [], owner: "store" });

// disabledIds 会被 isPluginEnabled 在「逐个应用」的循环里调用；settings.get 已缓存解码结果，
// 但每次仍要过滤一遍数组。这里按内容签名复用上一次的结果：settings 返回的是缓存值的浅拷贝，
// 数组引用每次都变，只有内容签名稳定；raw 一变内容就变，签名也就自动失配。
let disabledSignature = null;
let disabledList = [];

/**
 * 被禁用的插件 id 列表。
 * @returns {string[]} id 列表
 */
export function disabledIds() {
    const list = settings.get("store.disabled", []);
    const signature = JSON.stringify(Array.isArray(list) ? list : null);
    if (signature === disabledSignature) return disabledList;
    disabledSignature = signature;
    disabledList = Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
    return disabledList;
}

/**
 * 插件是否处于启用态（未注册一律 false）。
 * @param {string} id 插件 id
 * @returns {boolean} 启用态
 */
export function isPluginEnabled(id) {
    return registry.has(id) && !disabledIds().includes(id);
}

/**
 * 启用 / 禁用一个插件，并广播 `plugin-enabled-change` 让界面（启动台/程序坞/商店）同步。
 * @param {string} id 插件 id
 * @param {boolean} on 是否启用
 * @returns {boolean} 变更后的启用态
 */
export function setPluginEnabled(id, on) {
    const set = new Set(disabledIds());
    if (on) set.delete(id);
    else set.add(id);
    settings.set("store.disabled", [...set], { source: "store" });
    // 启用态本身不进 listApps 的字段，但变更后界面会整批重查；统一走同一个失效入口，
    // 免得以后有人给索引加了「按启用态过滤」却漏改这里。
    invalidateIndex();
    broadcast("plugin-enabled-change", { id, enabled: !set.has(id) });
    return !set.has(id);
}

/**
 * 按文件扩展名找到声明能打开它的应用。
 * 访达双击文件、桌面图标打开都从这里问路：插件不必内置，装了就能接管自己的格式；
 * 没有命中时调用方保留原有行为（Quick Look 预览）。
 * 扩展名大小写不敏感，`formats` 里写 `".docx"` 或 `"docx"` 都接受。
 *
 * 优先问 extensionResolver（default-apps.js 注入）：用户在「系统设置 → 通用 → 默认应用」
 * 里改绑过的类型必须压过清单声明，否则改绑永远不生效。钩子是赋值进来的而不是
 * import 回来的，注册表因此不必反向依赖默认应用模块（同 resolveName 的思路）。
 * @param {string} ext 扩展名（可带点，可空）
 * @returns {object|undefined} 应用记录
 */
export function getAppByExtension(ext) {
    const want = normalizeExt(ext);
    if (!want) return undefined;
    if (extensionResolver) {
        const hit = extensionResolver(want);
        // 解析器命中也可能来自被禁用的插件（用户先改绑、后禁用），放行会让双击变成静默失败
        if (hit && isPluginEnabled(hit.id)) return hit;
    }
    for (const rec of listApps()) {
        if (!isPluginEnabled(rec.id)) continue;
        // 多应用插件读 apps[].formats；单应用插件的 formats 写在根级——以前只读前者，
        // 导致 mods/notepad/manifest.json 的根级 formats 一直是死代码。
        const formats = (rec.app && rec.app.formats) || (!rec.app && rec.manifest && rec.manifest.formats);
        if (!Array.isArray(formats)) continue;
        if (formats.some((f) => normalizeExt(f) === want)) return rec;
    }
    return undefined;
}

/** 扩展名解析钩子（由 default-apps.js 在初始化时注入）。 */
let extensionResolver = null;

/**
 * 注册扩展名解析钩子。传 null 可撤销。
 * @param {(bareExt: string) => (object|undefined)} fn 收到已去点的扩展名，返回应用记录
 */
export function setExtensionResolver(fn) {
    extensionResolver = typeof fn === "function" ? fn : null;
}

/** 扩展名规范化：去掉前导点与小写 */
function normalizeExt(ext) {
    return String(ext || "").trim().toLowerCase().replace(/^\./, "");
}
