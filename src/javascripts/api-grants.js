/**
 * api-grants.js — 插件 API 的授权账本与运行时激活
 *
 * 两层机制，缺一不可：
 * 1. 安装时（内置插件在注册表建好时、ZIP 在落库前）读 manifest.permissions 展示清单，
 *    用户确认后 grantAll 记一条 granted 账；
 * 2. 运行时第一次调用某条 API 时，敏感权限再弹一次「拒绝 / 仅这次 / 始终允许」激活，
 *    选「始终允许」后落盘，之后无感通行。
 *
 * 命名注意：本文件**不是** permissions.js。`permissions.js` 是浏览器 Permissions API
 * （通知/定位/摄像头/剪贴板）的只读状态查询方，与本模块毫无关系；
 * os-api.md 里已经专门警告过别把 `window.__permissions` 当成 API 授权。
 *
 * 边界，必须先说明白：插件与内核跑在同一个 document 里（见 devdoc/architecture.md
 * 「运行模型」），插件可以绕过本模块直接 `import { OSFS } from "../osfs.js"`、
 * 直接读写 localStorage 与 IndexedDB。所以这套账本是**同意与记账机制**，
 * 不是安全沙箱；真正的硬边界只有 MV3 的 `script-src 'self'`。
 *
 * 模块顶层保持纯净（不碰 indexedDB、不碰 DOM、不注册监听）：
 * dev/static-check.mjs 要在 Node 里 import 本文件校验权限名表，
 * 与 app-registry.js 同一条契约。所有副作用都在 initGrants() 里发生。
 */

import { callerFromStack, currentCaller } from "./caller-context.js";

const DB_NAME = "webstartos-grants";
const DB_VERSION = 1;
const STORE = "grants";

/** 全量权限名，与 底层API改造分段提示词.md §二 一一对应，弹窗与帮助文档同源。 */
const PERMISSION_NAMES = [
    "apps:launch",
    "default-apps:read",
    "default-apps:write",
    "widgets",
    "dynamic-icons",
    "window-style:self",
    "window-style:others",
    "theme:apply",
    "files:read",
    "files:write",
    "system-patch:dock",
    "system-patch:finderbar",
    "system-patch:desktop",
    "system-patch:wallpaper",
    "system-patch:menu",
];

/** 权限名 -> 人类可读描述。弹窗正文、安装清单、帮助文档三处共用这一张表。 */
const PERMISSION_LABELS = {
    "apps:launch": ["启动应用", "打开本机其它插件提供的应用"],
    "default-apps:read": ["读取默认应用", "查询某扩展名/协议当前由哪个应用打开"],
    "default-apps:write": ["修改默认应用", "把扩展名或协议改绑到别的应用，含 http:/https: 协议接管"],
    "widgets": ["桌面小组件", "在桌面创建、更新、移除小组件并收发事件"],
    "dynamic-icons": ["动态图标", "推送应用图标的替换图，dock / 启动台 / 应用商店 / 访达同步刷新"],
    "window-style:self": ["自身窗口样式", "改自己窗口的标题栏色、圆角、毛玻璃、深浅色"],
    "window-style:others": ["跨应用窗口样式", "改别的应用窗口样式（主题包类能力，激活一次覆盖后续全部调用）"],
    "theme:apply": ["应用主题包", "整套切换窗口与界面配色"],
    "files:read": ["读取文件", "读自己 AppData 目录内的文件"],
    "files:write": ["写入文件", "写文件；写到自己的 AppData 之外时逐次确认"],
    "system-patch:dock": ["程序坞补丁", "给 dock 插入或替换内容"],
    "system-patch:finderbar": ["顶栏补丁", "给顶部菜单栏插入或替换内容"],
    "system-patch:desktop": ["桌面补丁", "给桌面层插入或替换内容"],
    "system-patch:wallpaper": ["壁纸补丁", "给壁纸层插入或替换内容"],
    "system-patch:menu": ["菜单补丁", "给顶栏菜单项插入或替换内容"],
};

/**
 * 敏感权限：运行时首次调用要真弹确认框。
 * 判据是「会不会影响别人」或「会不会丢数据」——跨应用样式、系统组件补丁、
 * 默认应用改写、写文件。读文件、启动应用、小组件、动态图标、自身样式这些
 * 装了就该能用的，安装时一次性授权后静默激活，不再打扰。
 * 不这么做的话开机 14 个内置插件会各自弹一轮，用户只会一路点拒绝。
 */
const SENSITIVE = new Set([
    "default-apps:write",
    "window-style:others",
    "theme:apply",
    "files:write",
]);

/** 带通配的敏感前缀：system-patch:* 全部敏感。 */
const SENSITIVE_PREFIXES = ["system-patch:"];

/** 账本内存镜像：pluginId -> { pluginId, grants: [{permission, granted, activated}] } */
const ledger = new Map();

/** 本次会话内「仅这次」的选择：`${pluginId}|${permission}` -> true */
const sessionOnce = new Set();

let dbPromise = null;
let promptTail = Promise.resolve();

/* ── IndexedDB：形状照 osfs.js 的 openDb/tx，全仓唯一 version-change 安全的写法 ── */

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: "pluginId" });
            }
        };
        req.onblocked = () => {
            // 与 osfs.js:97-102 / sw.js:144-147 同一写法：被别的连接挡住时 open 既不 success
            // 也不 error，不清缓存就会把这个永久 pending 的 Promise 一直用下去 ——
            // initGrants() 永不 resolve，bootstrap 的 await 卡死，整个桌面起不来。
            dbPromise = null;
            reject(new Error("账本升级被其它连接阻塞"));
        };
        req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => { db.close(); dbPromise = null; };
            db.onclose = () => { dbPromise = null; };
            resolve(db);
        };
        req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
}

function runTx(mode, op) {
    return openDb().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = op(t.objectStore(STORE));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
    }));
}

const putRow = (row) => runTx("readwrite", (os) => os.put(row));
const getAllRows = () => runTx("readonly", (os) => os.getAll());
const deleteRow = (pluginId) => runTx("readwrite", (os) => os.delete(pluginId));

function log(level, message, data) {
    const api = window.__log;
    if (api && typeof api[level] === "function") api[level]("api-grants", message, data);
}

/* ── 权限名判定 ── */

/** 是否合法权限名。 */
function isKnownPermission(permission) {
    return PERMISSION_NAMES.includes(permission);
}

/** 是否敏感（需要运行时确认）。 */
function isSensitive(permission) {
    if (SENSITIVE.has(permission)) return true;
    return SENSITIVE_PREFIXES.some((prefix) => String(permission).startsWith(prefix));
}

/**
 * 权限名匹配：账本里记的是具体名，调用方可能传 `system-patch:dock` 这种具体值，
 * 也可能有插件只声明了粗粒度意图。这里只做精确匹配，不做前缀放行 ——
 * 前缀放行等于声明 `files:read` 就能写文件，读写分离（设计决策 2）当场作废。
 */
function matches(granted, required) {
    return granted === required;
}

/** 权限中文名 + 描述，缺表时退回原始英文名，保证弹窗不会出现 undefined。 */
function describe(permission) {
    const entry = PERMISSION_LABELS[permission];
    return entry ? { label: entry[0], hint: entry[1] } : { label: permission, hint: "" };
}

/* ── 调用者识别 ── */

/**
 * 从调用栈里认出「是哪个插件在调」。实现在 caller-context.js，供 settings.js
 * 与本模块共用（订阅时也要认一次归属），避免两份正则各自漂移。
 *
 * @returns {string|null} 插件 id；null = 栈里没有插件帧
 */
function getCallerPluginId() {
    return callerFromStack();
}

/**
 * 取调用者 id。
 *
 * 顺序：**内核显式声明的归属** → 栈解析 → null。
 *
 * 早先的第三个来源是 `window.__currentPluginId`（plugin-manager 注入时写的提示）：
 * 只要 `ledger.has(hint)` 就采信。这条必须去掉 —— 那是个普通全局，插件自己就能写，
 * 写成一个有权限的插件 id 就完成了身份冒用；而 `ledger.has()` 只能证明「账本里有这个
 * 插件」，证明不了「这次调用是它发的」。参数保留是为了不破坏调用点签名，但不再使用。
 *
 * @returns {string|null} 插件 id；null = 认不出
 */
function resolveCaller() {
    const declared = currentCaller();
    if (declared) return declared;
    return getCallerPluginId();
}

/* ── 账本核心 ── */

function rowOf(pluginId) {
    let row = ledger.get(pluginId);
    if (!row) {
        row = { pluginId, grants: [] };
        ledger.set(pluginId, row);
    }
    return row;
}

function entryOf(pluginId, permission) {
    return rowOf(pluginId).grants.find((g) => matches(g.permission, permission));
}

/** 已授权（安装时确认过清单）。 */
function isGranted(pluginId, permission) {
    const e = entryOf(pluginId, permission);
    return Boolean(e && e.granted);
}

/** 已激活（可以直接调用）。同步读内存镜像，权限检查不引入异步等待。 */
function isActivated(pluginId, permission) {
    if (!isSensitive(permission)) {
        const e = entryOf(pluginId, permission);
        return Boolean(e && e.granted);
    }
    if (sessionOnce.has(`${pluginId}|${permission}`)) return true;
    const e = entryOf(pluginId, permission);
    return Boolean(e && e.granted && e.activated);
}

/**
 * 安装时全量授权：并集合并，**绝不撤销**已有条目。
 * ZIP 覆盖安装会用新的 manifest 再走一次这里，若改成覆盖，
 * 用户上次「始终允许」的记录会静默消失，下次调用又弹一遍。
 * 非敏感权限直接 activated=true（装时就完成激活），敏感权限留给运行时弹窗。
 * @param {string} pluginId 插件 id
 * @param {Array<string>} permissions manifest.permissions 声明的权限名
 * @returns {Promise<boolean>} 是否落盘成功（内存镜像总是先更新）
 */
async function grantAll(pluginId, permissions) {
    const names = Array.isArray(permissions) ? permissions : [];
    const row = rowOf(pluginId);
    for (const permission of names) {
        if (!isKnownPermission(permission)) {
            log("warn", `插件 ${pluginId} 声明了未知权限：${permission}`);
            continue;
        }
        const existing = entryOf(pluginId, permission);
        if (existing) {
            existing.granted = true;
            if (!isSensitive(permission)) existing.activated = true;
        } else {
            row.grants.push({
                permission,
                granted: true,
                activated: !isSensitive(permission),
                grantedAt: Date.now(),
            });
        }
    }
    try {
        await putRow({ ...row, grants: row.grants.map((g) => ({ ...g })) });
        return true;
    } catch (err) {
        log("error", `插件 ${pluginId} 授权写入失败，本次会话内仍生效：`, err);
        return false;
    }
}

/**
 * 激活一条权限。
 * @param {string} pluginId 插件 id
 * @param {string} permission 权限名
 * @param {("once"|"always")} mode once 只进会话，always 落盘
 */
async function activate(pluginId, permission, mode = "always") {
    if (mode === "once") {
        sessionOnce.add(`${pluginId}|${permission}`);
        return true;
    }
    // 只允许激活已授权（granted）的条目。ensurePermission 本来就先查过这一层，
    // 但 activate 是导出的，内核里任何一处误用都不该把「没声明的能力」写成已授权。
    if (!isGranted(pluginId, permission)) {
        log("warn", `拒绝激活未声明的能力：${pluginId} ${permission}`);
        return false;
    }
    const row = rowOf(pluginId);
    const existing = entryOf(pluginId, permission);
    if (existing) {
        existing.activated = true;
        existing.granted = true;
        existing.activatedAt = Date.now();
    } else {
        row.grants.push({
            permission, granted: true, activated: true,
            grantedAt: Date.now(), activatedAt: Date.now(),
        });
    }
    try {
        await putRow({ ...row, grants: row.grants.map((g) => ({ ...g })) });
    } catch (err) {
        log("error", `权限激活落盘失败（本次会话可用，刷新后要重弹）：${pluginId} ${permission}`, err);
    }
    return true;
}

/** 记一次拒绝：activated 归 false，下一次调用仍会询问（计划要求「拒绝」不封顶）。 */
async function deny(pluginId, permission) {
    const existing = entryOf(pluginId, permission);
    if (existing) existing.activated = false;
    log("info", `插件 ${pluginId} 拒绝使用「${describe(permission).label}」`);
    return false;
}

/**
 * 取一次权限：已激活直接放行，否则串行弹窗。
 *
 * 串行是必须的：ui/alert.js 的 pendingSettle 会强制结算上一个弹窗（同一时刻只允许
 * 一个系统对话框），两个插件同时申请时后一个会把前一个的 Promise 吞成 dismissValue。
 * @param {string|null} pluginId null = 内核自身调用，放行
 * @param {string} permission 权限名
 * @returns {Promise<boolean>}
 */
async function ensurePermission(pluginId, permission) {
    if (!pluginId) return true;
    if (isActivated(pluginId, permission)) return true;
    if (!isGranted(pluginId, permission)) {
        log("warn", `插件 ${pluginId} 调用了未在 manifest 声明的能力：${permission}`);
        return false;
    }
    if (!isSensitive(permission)) return activate(pluginId, permission, "always");

    const ask = async () => {
        const { showMessageBox } = await import("./ui/alert.js");
        const { getPlugin } = await import("./app-registry.js");
        const manifest = getPlugin(pluginId);
        const { label, hint } = describe(permission);
        const title = `${manifest && manifest.name ? manifest.name : pluginId} 想要使用「${label}」`;
        const value = await showMessageBox({
            title,
            message: hint || "是否允许该插件使用这项能力？",
            buttons: [
                { label: "拒绝", value: "deny", style: "destructive" },
                { label: "仅这次", value: "once", style: "secondary" },
                { label: "始终允许", value: "always", style: "primary" },
            ],
            dismissValue: "deny",
        });
        if (value === "always") return activate(pluginId, permission, "always");
        if (value === "once") return activate(pluginId, permission, "once");
        return deny(pluginId, permission);
    };
    const next = promptTail.then(ask, ask);
    // 队列尾巴只关心「别并发弹窗」，不让某一次的失败传染给后续申请
    promptTail = next.then(() => undefined, () => undefined);
    return next;
}

/** 卸载/删除插件时清账。 */
async function clearGrants(pluginId) {
    ledger.delete(pluginId);
    for (const key of Array.from(sessionOnce)) {
        if (key.startsWith(`${pluginId}|`)) sessionOnce.delete(key);
    }
    try {
        await deleteRow(pluginId);
    } catch (err) {
        log("error", `清除 ${pluginId} 授权记录失败：`, err);
    }
}

/** 诊断用：某插件的授权条目副本。 */
function listGrants(pluginId) {
    const row = ledger.get(pluginId);
    return row ? row.grants.map((g) => ({ ...g })) : [];
}

/** 诊断用：账本里的插件 id。 */
function grantIds() {
    return Array.from(ledger.keys());
}

/**
 * 安装时的权限清单面板（ZIP 安装流程调用）。
 * @param {object} manifest 待安装插件清单
 * @returns {Promise<boolean>} 用户是否确认「安装并授权」
 */
async function showPermissionChecklist(manifest) {
    const { showMessageBox } = await import("./ui/alert.js");
    const names = Array.isArray(manifest.permissions) ? manifest.permissions.filter(isKnownPermission) : [];
    const rows = names.length
        ? names.map((p) => {
            const { label, hint } = describe(p);
            return `<li><b>${escapeHtml(label)}</b><span class="ag-hint">${escapeHtml(hint)}</span></li>`;
        }).join("")
        : "<li>不需要任何额外能力</li>";
    const html = `<p>${escapeHtml(manifest.name || manifest.id)}（版本 ${escapeHtml(String(manifest.version || "?"))}）请求以下权限：</p><ul class="ag-list">${rows}</ul><p class="ag-note">标记为敏感的能力在第一次使用时还会再确认一次。</p>`;
    const value = await showMessageBox({
        title: "安装并授权",
        message: html,
        html: true,
        buttons: [
            { label: "取消", value: "cancel", style: "secondary" },
            { label: "安装并授权", value: "ok", style: "primary" },
        ],
        dismissValue: "cancel",
    });
    return value === "ok";
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    ));
}

/**
 * 启动时读回账本，并接上注册表现有的生命周期广播。
 *
 * 授权写入挂在 `plugin-registered` 上而不是改 registerPlugin 内部：内置插件
 * （plugin-manager.js init 拉 manifest）与 ZIP 插件（store-api.js 安装）最终都走
 * app-registry.js registerPlugin 这一个调用点，挂广播就天然同漏斗，
 * 而注册表本身保持纯数据层。
 * @returns {Promise<boolean>} 账本是否成功读回（失败时内存为空表，不阻塞启动）
 */
async function initGrants() {
    try {
        const rows = await getAllRows();
        for (const row of Array.isArray(rows) ? rows : []) {
            if (!row || !row.pluginId) continue;
            ledger.set(row.pluginId, {
                pluginId: row.pluginId,
                grants: Array.isArray(row.grants) ? row.grants.map((g) => ({ ...g })) : [],
            });
        }
    } catch (err) {
        log("error", "授权账本读取失败，本次会话所有敏感能力会重新询问：", err);
    }

    document.addEventListener("plugin-registered", (event) => {
        const manifest = event.detail;
        if (!manifest || !manifest.id) return;
        grantAll(manifest.id, Array.isArray(manifest.permissions) ? manifest.permissions : []);
    });
    document.addEventListener("plugin-unregistered", (event) => {
        const id = event.detail && event.detail.id;
        if (id) clearGrants(id);
    });

    return true;
}

// 全局只放**只读**诊断面。grantAll / activate / ensurePermission / clearGrants 一旦全局可达，
// 任何插件都能 `__grants.grantAll(自己, ["files:write", "system-patch:dock"])` 自我提权，
// 或 `__grants.clearGrants(别人)` 把别人的授权打回弹窗 —— 账本作为「同意机制」就只剩自愿遵守。
// 写入口只保留 module 导出，由内核调用点显式 import（bootstrap / 商店安装链）。
globalThis.__grants = {
    PERMISSION_NAMES, PERMISSION_LABELS, SENSITIVE,
    isGranted, isActivated, isSensitive, isKnownPermission, describe,
    listGrants, grantIds, getCallerPluginId, resolveCaller,
};

export {
    PERMISSION_NAMES,
    PERMISSION_LABELS,
    SENSITIVE,
    initGrants,
    grantAll,
    activate,
    deny,
    ensurePermission,
    isGranted,
    isActivated,
    isSensitive,
    isKnownPermission,
    describe,
    listGrants,
    grantIds,
    clearGrants,
    showPermissionChecklist,
    getCallerPluginId,
    resolveCaller,
};
