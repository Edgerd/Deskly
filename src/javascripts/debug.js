/**
 * debug.js — 「调试」菜单的命令后端与运行诊断
 *
 * 为什么单独成文件：运行记录、设置自检、层级体检这类能力过去散在 console.log 里，
 * 用户看不到、插件作者也够不着。这里把它们收成一组**可从顶栏菜单点到的**命令，
 * 与 dev/settings-harness.mjs 是同一套断言的应用内版本（差别只在这里能读到真实存储）。
 *
 * 三条契约：
 * 1. **不做任何代码求值**：MV3 CSP 为 `script-src 'self'`，把字符串当代码执行的写法在打包
 *    环境里会被直接拒绝。本模块只做一件事——把实现合并进 `globalThis.__menuActions`，
 *    菜单里写的是注册表键名（分发见 ui/menuCommands.js），菜单表本身不含函数。
 * 2. **只自带一项设置**：`debug.developerMode`（控制「调试」菜单是否出现在顶栏）。
 *    `debug.logLevel` / `captureConsole` / `captureErrors` / `bufferSize` / `persist` /
 *    `persistCount` 由 log.js 自己注册，本模块不重复声明，避免两份默认值互相覆盖。
 * 3. **一切输出走 window.__log**（来源 `kernel/debug`），刷新后仍能在运行记录里查到。
 *
 * 对外 API：
 *   initDebug()                 注册设置项与菜单命令（finderbar 在初始化时调用一次）
 *   openSettingsPane(paneId)    跳到系统设置的某个面板（设置面板与聚焦搜索共用）
 *   DEBUG_MENU_ITEMS            「调试」子菜单项（只含 label / i18nKey / cmd）
 *   其余同名函数即菜单命令本身，也可被插件直接调用。
 */

import { settings } from "./settings.js";
import { i18n } from "./i18n.js";
import { Z } from "./zindex.js";
import { assetIcon } from "./paths.js";

/** 日志来源（log.js 的内核模块白名单里已有 debug）。 */
const SOURCE = "kernel/debug";

/** 系统设置窗口与打开后的面板定位事件。 */
const SETTINGS_WINDOW_SELECTOR = '.window[data-plugin-id="system-settings"]';
const SETTINGS_APP_NAME = "系统设置";
const OPEN_PANE_EVENT = "system-settings-open-pane";

/** 自检写入的来源标识，便于在运行记录里区分「用户改的」与「自检改的」。 */
const SELFTEST_SOURCE = "selftest";

/**
 * 自检时不改动其值的键。
 * 切语言会把整个界面重排两遍（换过去再换回来），自检不该造成这种闪烁；
 * 该键仍会被读写校验，只是探针值固定为当前值（同值写入同样走完校验 -> 落盘 -> 回读）。
 */
// 自检静默名单：apply 有网络/视觉副作用的键不能探——探针取反会真实触发一次
// Bing 拉取并换壁纸（BUG-36），切语言会整页重渲染（general.language 原有）。
const SELFTEST_QUIET_KEYS = new Set(["general.language", "wallpaper.autoBing"]);

/**
 * 统一日志出口：log.js 早于本模块求值（bootstrap 的第一行 import），
 * 独立加载本模块时也能降级到 console（console 已被 log.js 接管归档）。
 * @param {"debug"|"info"|"warn"|"error"} level 级别
 * @param {string} message 文本
 * @param {*} [data] 附加上下文
 */
function writeLog(level, message, data) {
    const logger = globalThis.__log;
    if (logger && typeof logger[level] === "function") logger[level](SOURCE, message, data);
    else (console[level] || console.log).call(console, `[debug] ${message}`, data);
}

/** 取一条用户可见文案（键缺失时用中文原文兜底）。 */
function text(key, fallback, vars) {
    let value = i18n.t(key, fallback);
    Object.keys(vars || {}).forEach((name) => {
        value = value.replace(`{${name}}`, String(vars[name]));
    });
    return value;
}

/** 轻提示：优先系统通知，通知被关掉 / 被勿扰拦下时退回模态弹窗。 */
function report(title, body) {
    const shown = globalThis.__notify?.show?.({ icon: assetIcon("Console"), title, text: body });
    if (shown) return;
    globalThis.__dialog?.alert?.(title, body, { icon: assetIcon("Console") });
}

/* ── 设置项：调试菜单的可见性开关 ── */

/** 「调试」菜单当前是否应当出现。 */
export function isDeveloperMode() {
    return settings.get("debug.developerMode", true) !== false;
}

/**
 * 注册本模块自带的设置项。
 * apply 只做一件事：广播可见性变更，顶栏据此重建菜单（谁订阅谁负责，不反向 import）。
 */
function defineSettings() {
    settings.define({
        key: "debug.developerMode", type: "boolean", default: true,
        label: "调试菜单",
        control: "switch", pane: "debug", group: "调试", owner: "system", order: 5,
        apply: () => window.dispatchEvent(new CustomEvent("debug-menu-visibility-change")),
    });
}

/* ── 命令实现 ── */

/**
 * 跳到系统设置的某个面板：已开着的窗口用事件直达，没开过就先开应用。
 * 目标面板同时写进 `globalThis.__pendingSettingsPane`，供设置侧在挂载时自行读取——
 * 事件只在窗口已存在时才有接收方，冷启动那一次打开靠这个全局变量交接。
 * @param {string} paneId 面板 id（如 "debug"、"keyboard"）
 * @returns {Promise<boolean>} 是否已把设置带到该面板
 */
export async function openSettingsPane(paneId) {
    globalThis.__pendingSettingsPane = paneId;
    const existing = document.querySelector(SETTINGS_WINDOW_SELECTOR);
    if (existing) {
        document.dispatchEvent(new CustomEvent(OPEN_PANE_EVENT, { detail: { pane: paneId }, bubbles: true }));
        const { bringToFront } = await import("./window.js");
        bringToFront(existing, existing.id || SETTINGS_APP_NAME);
        writeLog("info", `已切到系统设置「${paneId}」面板`);
        return true;
    }
    try {
        const manager = await import("./plugin-manager.js");
        const win = await manager.openApp(SETTINGS_APP_NAME, { centered: true });
        writeLog("info", `已打开系统设置并定位到「${paneId}」面板`, { opened: Boolean(win) });
        return Boolean(win);
    } catch (err) {
        writeLog("error", "打开系统设置失败", err);
        return false;
    }
}

/** 「调试 → 查看运行记录」：跳到设置「调试」面板（记录本体就在那一屏）。 */
export async function openLogViewer() {
    writeLog("info", `打开运行记录：当前 ${globalThis.__log?.count?.() ?? 0} 条`);
    return openSettingsPane("debug");
}

/** 「调试 → 清空运行记录」。 */
export function clearLog() {
    const before = globalThis.__log?.count?.() ?? 0;
    globalThis.__log?.clear?.();
    // clear 会抹掉缓冲，所以这条汇总写在清空之后
    writeLog("info", `运行记录已清空（原先 ${before} 条）`);
    report(i18n.t("debug.title", "调试"), text("debug.log.cleared", "运行记录已清空。"));
}

/** 「调试 → 导出日志文件」：交给 log.js 的下载实现。 */
export function exportLogFile() {
    const ok = globalThis.__log?.download?.();
    writeLog(ok ? "info" : "error", ok ? "已发起运行记录文件下载" : "运行记录导出失败");
    report(
        i18n.t("debug.title", "调试"),
        ok
            ? text("debug.log.exported", "日志文件已开始下载。")
            : text("debug.log.exportFailed", "日志导出失败，详情见运行记录。"),
    );
    return Boolean(ok);
}

/**
 * 「调试 → 复制日志到剪贴板」。
 * 剪贴板是异步且可能被权限拒绝的，结果必须回给用户，不能静默失败。
 * @returns {Promise<boolean>} 是否复制成功
 */
export async function copyLogToClipboard() {
    const logger = globalThis.__log;
    if (!logger) return false;
    const count = logger.count();
    let ok = false;
    try {
        ok = await logger.copy();
    } catch (err) {
        writeLog("error", "复制运行记录时抛错", err);
    }
    writeLog(ok ? "info" : "warn", `复制运行记录到剪贴板${ok ? "成功" : "失败"}`, { count });
    report(
        i18n.t("debug.title", "调试"),
        ok
            ? text("debug.clipboard.copied", `已复制 ${count} 条运行记录到剪贴板。`, { count })
            : text("debug.clipboard.failed", "复制失败：浏览器拒绝了剪贴板访问。"),
    );
    return ok;
}

/**
 * 「调试 → 切换开发者模式」：翻转设置项，菜单重建由 apply 广播的事件驱动。
 * @returns {boolean} 切换后的状态
 */
export function toggleDeveloperMode() {
    const next = !isDeveloperMode();
    settings.set("debug.developerMode", next, { source: "debug-menu" });
    writeLog("info", `开发者模式已${next ? "开启" : "关闭"}`);
    return next;
}

/**
 * 「调试 → 重载当前插件」：取最靠上的可见窗口，按 data-plugin-id 先卸再装。
 * 冷加载的反向操作会派发 plugin-unload，插件应在那里清掉自己的全局监听与定时器。
 * @returns {Promise<boolean>} 是否完成一次重载
 */
export async function reloadActivePlugin() {
    const { getTopWindow } = await import("./window.js");
    const win = getTopWindow();
    const id = win && win.dataset ? win.dataset.pluginId : "";
    if (!id) {
        writeLog("warn", "重载插件：前台没有带 data-plugin-id 的可见窗口");
        report(i18n.t("debug.title", "调试"), text("debug.log.reloadNoWindow", "没有可重载的前台插件窗口。"));
        return false;
    }
    writeLog("info", `准备重载插件「${id}」`, {
        // 判据与窗口层一致（body > .window）：按类名全量数会把顶栏菜单里的
        // 伪 .window 也算进来，那会让这组 before/after 差值永远对不上真相，
        // 而它正是「重载后到底有没有注入出窗口」的唯一现场读数。
        beforeWindows: document.querySelectorAll("body > .window").length,
        entries: globalThis.__log?.count?.() ?? 0,
    });
    try {
        const { unload, load } = await import("./plugin-manager.js");
        unload(id);
        await load(id);
        writeLog("info", `插件「${id}」已重载`, { afterWindows: document.querySelectorAll("body > .window").length });
        report(i18n.t("debug.title", "调试"), text("debug.log.reloadDone", `插件「${id}」已重载。`, { id }));
        return true;
    } catch (err) {
        writeLog("error", `插件「${id}」重载失败`, err);
        report(i18n.t("debug.title", "调试"), text("debug.log.reloadFailed", `插件「${id}」重载失败：${err && err.message}`, { id, error: String(err && err.message) }));
        return false;
    }
}

/**
 * 「调试 → 输出设置表到控制台」：整张定义表（含当前值）+ 运行记录统计。
 * 控制台已被 log.js 归档，所以这份快照刷新前也能在运行记录里回看。
 * @returns {{total:number, nonDefault:number, entries:number}} 计数摘要
 */
export function dumpSettingsToConsole() {
    const list = settings.list();
    const table = list.map((def) => ({
        key: def.key,
        value: def.value,
        type: def.type,
        owner: def.owner || "-",
        pane: def.pane || "-",
        group: def.group || "-",
        isDefault: settings.isDefault(def.key),
    }));
    const stats = globalThis.__log?.stats?.() || null;
    const nonDefault = table.filter((row) => !row.isDefault).length;
    console.info("[debug] 设置表", table);
    console.info("[debug] 运行记录统计", stats);
    writeLog("info", `设置 ${table.length} 项（非默认 ${nonDefault} 项），运行记录 ${stats ? stats.total : 0} 条`, {
        nonDefaultKeys: table.filter((row) => !row.isDefault).map((row) => row.key),
        capacity: stats ? stats.capacity : undefined,
        dropped: stats ? stats.dropped : undefined,
    });
    return { total: table.length, nonDefault, entries: stats ? stats.total : 0 };
}

/**
 * 「调试 → 输出层级表」：只读体检，把可见元素的实际 z-index 与 `Z` 表逐一对照。
 * 层级只能取自 zindex.js（全站唯一来源），这里负责抓出写死的越界值（例如盖过会话遮罩的浮层）。
 * @returns {Array<object>} 逐元素摘要（按 z-index 降序）
 */
export function dumpZLayers() {
    const tokenNames = Object.entries(Z);
    const rows = [];
    Array.from(document.body.querySelectorAll("*")).forEach((el) => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const z = parseInt(style.zIndex, 10);
        if (!Number.isFinite(z)) return;
        const tokens = tokenNames.filter(([, value]) => value === z).map(([name]) => name);
        const classes = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
        rows.push({
            z,
            element: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${classes ? `.${classes}` : ""}`,
            token: tokens.join("/") || "非层级表取值",
        });
    });
    rows.sort((a, b) => b.z - a.z);
    console.info("[debug] 可见元素层级 vs Z 表", rows.slice(0, 60));
    const overCeiling = rows.filter((row) => row.z > Z.SESSION);
    const offTable = rows.filter((row) => row.token === "非层级表取值");
    writeLog(overCeiling.length || offTable.length ? "warn" : "info",
        `层级体检：可见且显式设了 z-index 的元素 ${rows.length} 个，越过 Z.SESSION(${Z.SESSION}) 的 ${overCeiling.length} 个，取值不在层级表里的 ${offTable.length} 个`,
        {
            highest: rows.length ? rows[0] : null,
            overCeiling: overCeiling.map((row) => row.element),
            offTable: offTable.map((row) => `${row.element}@${row.z}`).slice(0, 20),
        });
    return rows;
}

/**
 * 「调试 → 记录门槛」：四个入口共用一条实现，走设置中枢以与设置面板保持双向同步。
 * @param {"debug"|"info"|"warn"|"error"} level 门槛级别
 * @returns {boolean} 是否生效
 */
function applyLogLevel(level) {
    const ok = Boolean(globalThis.__log?.setLevel?.(level));
    writeLog("info", `记录门槛已设为 ${level}`, { before: globalThis.__log?.getLevel?.(), ok });
    report(i18n.t("debug.title", "调试"), text("debug.log.levelChanged", `记录门槛已设为 ${level}。`, { level }));
    return ok;
}

/** 「调试 → 记录门槛：Debug」。 */
export function setLogLevelDebug() { return applyLogLevel("debug"); }
/** 「调试 → 记录门槛：Info」。 */
export function setLogLevelInfo() { return applyLogLevel("info"); }
/** 「调试 → 记录门槛：Warn」。 */
export function setLogLevelWarn() { return applyLogLevel("warn"); }
/** 「调试 → 记录门槛：Error」。 */
export function setLogLevelError() { return applyLogLevel("error"); }

/** 直接读存储槽原始文本，确认写入真的落到了存储而不是只活在内存替身里。 */
function rawSlot(key, degraded) {
    if (degraded) return undefined;
    try {
        return globalThis.localStorage.getItem(settings.slot(key));
    } catch {
        return undefined;
    }
}

/**
 * 为一个设置项挑「已知合法」的探针值。
 * 优先取与当前值不同的合法值，这样才真的走完 校验 -> 落盘 -> 生效 -> 回读 整条链路；
 * 没有第二个合法取值时才退回当前值（同值写入依然会 encode / 写槽 / 调 apply）。
 * @param {object} def 设置定义
 * @param {*} current 当前值
 * @returns {*} 探针值
 */
function probeValueFor(def, current) {
    if (SELFTEST_QUIET_KEYS.has(def.key)) return current;
    if (def.type === "boolean") return !current;
    if (Array.isArray(def.values)) {
        const alternative = def.values.find((option) => String(option) !== String(current));
        return alternative === undefined ? current : alternative;
    }
    if (def.type === "number") {
        const base = Number.isFinite(def.default) ? def.default : Number(current) || 0;
        const step = def.step || 1;
        const candidates = [base, Number(current) + step, base + step, base - step];
        const picked = candidates.find((n) => JSON.stringify(n) !== JSON.stringify(current));
        return picked === undefined ? current : picked;
    }
    return JSON.stringify(def.default) !== JSON.stringify(current) ? def.default : current;
}

/**
 * 单个设置项的往返自检：写入合法值 -> 回读比对 -> 判定 isDefault -> 还原用户原值。
 * 每一步都重新读存储，任何一步不符都算失败（不猜、不默认通过）。
 * @param {object} def 设置定义（含当前 value）
 * @param {boolean} degraded 存储是否已降级（降级时跳过存储槽断言，否则会误报）
 * @returns {{key:string, pass:boolean, reason?:string, restored:boolean}} 结果
 */
function selfTestOne(def, degraded) {
    const key = def.key;
    const before = settings.get(key);
    const probe = probeValueFor(def, before);
    try {
        const write = settings.set(key, probe, { source: SELFTEST_SOURCE });
        if (!write.ok) return { key, pass: false, reason: write.reason || "写入被拒绝", restored: false };

        const readBack = settings.get(key);
        if (JSON.stringify(readBack) !== JSON.stringify(write.value)) {
            return { key, pass: false, reason: `回读值 ${JSON.stringify(readBack)} 与写入结果 ${JSON.stringify(write.value)} 不一致`, restored: false };
        }

        const slotText = rawSlot(key, degraded);
        if (slotText !== undefined && slotText === null) {
            return { key, pass: false, reason: `写入成功但存储槽 ${settings.slot(key)} 仍为空`, restored: false };
        }

        const shouldBeDefault = JSON.stringify(write.value) === JSON.stringify(def.default);
        if (settings.isDefault(key) !== shouldBeDefault) {
            return { key, pass: false, reason: `isDefault 应为 ${shouldBeDefault}，实得 ${settings.isDefault(key)}`, restored: false };
        }

        const restore = settings.set(key, before, { source: `${SELFTEST_SOURCE}-restore` });
        const sameAgain = JSON.stringify(settings.get(key)) === JSON.stringify(before);
        if (!restore.ok || !sameAgain) {
            return {
                key,
                pass: false,
                reason: `写入与回读正常，但还原失败：${restore.reason || (sameAgain ? "" : "还原后取值与自检前不一致")}`,
                restored: false,
            };
        }
        return { key, pass: true, restored: true };
    } catch (err) {
        return { key, pass: false, reason: `抛错：${(err && err.message) || err}`, restored: false };
    }
}

/**
 * 「调试 → 运行设置自检」：逐项写入合法值、回读比对、再还原用户原值。
 * 与 dev/settings-harness.mjs 同一套断言，区别是这里跑在真实存储与真实 owner 生效函数上。
 * 注意：自检期间各项设置会被短暂改成合法探针值再改回，界面可能闪一下。
 * @returns {{total:number, pass:number, fail:number, failures:Array}} 结果摘要
 */
export function runSelfTest() {
    const defs = settings.list();
    const degraded = settings.storage().degraded;
    const results = defs.map((def) => selfTestOne(def, degraded));
    const failures = results.filter((row) => !row.pass);
    const pass = results.length - failures.length;
    const summary = text("debug.selfTest.summary", `共 {total} 项设置：通过 {pass} 项，失败 {fail} 项。`, { total: results.length, pass, fail: failures.length });

    writeLog(failures.length ? "warn" : "info", `设置自检：${summary}`);
    failures.forEach((row) => writeLog("error", `自检失败 ${row.key}`, { reason: row.reason }));

    const lines = failures.slice(0, 10).map((row) => text("debug.selfTest.failLine", "✗ {key}：{reason}", { key: row.key, reason: row.reason }));
    const detail = [
        summary,
        lines.length ? lines.join("\n") : text("debug.selfTest.allPass", "全部通过：校验、落盘、回读与生效函数都正常。"),
        text("debug.selfTest.restored", "已完成的写入都还原为你原来的设置。"),
    ].join("\n");

    const dialog = globalThis.__dialog;
    if (dialog && typeof dialog.messageBox === "function") {
        dialog.messageBox({
            icon: assetIcon(failures.length ? "Terminal" : "Console"),
            title: text("debug.selfTest.title", "设置自检结果"),
            message: detail,
            dismissValue: "ok",
            buttons: failures.length
                ? [
                    { label: i18n.t("common.close", "关闭"), value: "ok", style: "secondary" },
                    { label: i18n.t("debug.selfTest.viewLog", "查看运行记录"), value: "log", style: "primary" },
                ]
                : [{ label: i18n.t("common.ok", "好"), value: "ok", style: "primary" }],
        }).then((value) => {
            if (value === "log") openLogViewer();
        });
    }
    return { total: results.length, pass, fail: failures.length, failures };
}

/* ── 菜单表与注册表 ── */

/**
 * 「调试」子菜单项。
 * 只放 { label, i18nKey, cmd }（外加一条分隔线），实现全在下面的注册表里 ——
 * 静态表带函数就等于把行为写死在菜单层，finderbar 因此可以保持纯声明式渲染。
 * 不写 shortcut：本菜单的命令没有对应的按键绑定，写了就是个假提示。
 */
export const DEBUG_MENU_ITEMS = [
    { label: "查看运行记录", i18nKey: "finderbar.debugItems.logViewer", cmd: "openLogViewer" },
    { label: "清空运行记录", i18nKey: "finderbar.debugItems.clearLog", cmd: "clearLog" },
    { label: "导出日志文件", i18nKey: "finderbar.debugItems.exportLog", cmd: "exportLogFile" },
    { label: "复制日志到剪贴板", i18nKey: "finderbar.debugItems.copyLog", cmd: "copyLogToClipboard" },
    { separator: true },
    { label: "记录门槛：Debug", i18nKey: "finderbar.debugItems.levelDebug", cmd: "setLogLevelDebug" },
    { label: "记录门槛：Info", i18nKey: "finderbar.debugItems.levelInfo", cmd: "setLogLevelInfo" },
    { label: "记录门槛：Warn", i18nKey: "finderbar.debugItems.levelWarn", cmd: "setLogLevelWarn" },
    { label: "记录门槛：Error", i18nKey: "finderbar.debugItems.levelError", cmd: "setLogLevelError" },
    { separator: true },
    { label: "重载当前插件", i18nKey: "finderbar.debugItems.reloadPlugin", cmd: "reloadActivePlugin" },
    { label: "输出设置表到控制台", i18nKey: "finderbar.debugItems.dumpSettings", cmd: "dumpSettingsToConsole" },
    { label: "输出层级体检报告", i18nKey: "finderbar.debugItems.dumpZLayers", cmd: "dumpZLayers" },
    { label: "运行设置自检", i18nKey: "finderbar.debugItems.selfTest", cmd: "runSelfTest" },
    { separator: true },
    { label: "切换开发者模式", i18nKey: "finderbar.debugItems.toggleDeveloperMode", cmd: "toggleDeveloperMode" },
];

/** 命令名 -> 实现：与 DEBUG_MENU_ITEMS 的 cmd 一一对应。 */
const DEBUG_ACTIONS = {
    openLogViewer,
    clearLog,
    exportLogFile,
    copyLogToClipboard,
    toggleDeveloperMode,
    reloadActivePlugin,
    dumpSettingsToConsole,
    dumpZLayers,
    runSelfTest,
    setLogLevelDebug,
    setLogLevelInfo,
    setLogLevelWarn,
    setLogLevelError,
};

/**
 * initDebug 幂等守卫。
 * finderbar.js 顶层已经调用一次，bootstrap.js 的可选模块表又会再调一次 —— 没有守卫时
 * settings.define 与 __menuActions 的命令会被注册两遍（同一项设置两份定义、菜单动作
 * 表被重复写入），纯属重复工作。用模块级布尔短路，重复调用只返回同一份摘要。
 */
let debugInitialized = false;

/**
 * 初始化调试后端：注册设置项，并把命令合并进 window.__menuActions。
 * 合并而非整体赋值：finderbar.js 也往同一张表里写，两侧都用合并才不管谁先求值都不丢命令。
 * @returns {{commands:number, developerMode:boolean}} 注册结果摘要
 */
export function initDebug() {
    const commands = Object.keys(DEBUG_ACTIONS).length;
    if (debugInitialized) return { commands, developerMode: isDeveloperMode() };
    debugInitialized = true;
    defineSettings();
    const table = globalThis.__menuActions || (globalThis.__menuActions = {});
    const names = Object.keys(DEBUG_ACTIONS);
    names.forEach((name) => { table[name] = DEBUG_ACTIONS[name]; });
    writeLog("info", `调试后端就绪：注册命令 ${names.length} 条，开发者模式${isDeveloperMode() ? "开" : "关"}`, {
        commands: names,
    });
    return { commands: names.length, developerMode: isDeveloperMode() };
}
