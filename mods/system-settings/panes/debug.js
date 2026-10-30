/**
 * panes/debug.js — 「系统设置 › 调试」面板（运行记录查看器）
 *
 * 与 log.js 的关系：门槛、捕获开关、缓冲条数、留存策略都是 debug.* 设置项，写它们会立刻
 * 改到 log.js 的内存 config（定义的 apply 就在 log.js 里）；下面的列表则是 log.query()
 * 的直接投影 —— 新记录经 log.subscribe 进来，用 requestAnimationFrame 合并成一次重绘，
 * 绝不在每条日志上做同步 DOM 写入（那会把日志系统自己拖慢）。
 *
 * 三条硬约束：
 * 1. 列表行、来源名、消息文本一律 textContent，插件写的东西不当标签解析。
 * 2. 只渲染最近 RENDER_CAP 条，缓冲再大也不会一次造几千个节点。
 * 3. 不读 localStorage：留存状态从 log.stats().persisting 取，快照从 settings.snapshot() 取。
 */

import { settings } from "../../../src/javascripts/settings.js";
import { log } from "../../../src/javascripts/log.js";
import { VERSION, APP_NAME } from "../../../src/javascripts/version.js";
import {
    t, el, group, controlSwitch, controlDropdown, controlSlider, actionRow, statusRow, usePaneStyle, track,
} from "../ui.js";

export const paneId = "debug";

/** 一次渲染的日志条数上限（缓冲区可以更大，界面只画最近这些）。 */
const RENDER_CAP = 300;

/** 四语言文案。 */
export const messages = {
    "zh-CN": {
        ss: {
            debug: {
                controlsGroup: "记录",
                level: "记录级别",
                levelDebug: "调试",
                levelInfo: "信息",
                levelWarn: "警告",
                levelError: "错误",
                captureConsole: "console 输出",
                captureErrors: "捕获未处理异常",
                bufferSize: "缓冲区容量",
                unitEntries: "条",
                persist: "刷新后保留",
                persistCount: "保留上限",
                developerMode: "菜单栏显示调试菜单",
                actionsGroup: "操作",
                clear: "清空运行记录",
                clearHint: "清空后无法恢复。",
                clearBtn: "清空",
                export: "导出运行记录",
                exportBtn: "导出",
                copy: "复制到剪贴板",
                copyBtn: "复制",
                flush: "立即保存",
                flushBtn: "保存",
                snapshot: "复制设置快照",
                snapshotBtn: "复制快照",
                lastAction: "上次操作结果",
                copyDone: "已复制 {n} 项。",
                copyFallback: "已选中文本，按 Ctrl/⌘+C。",
                cleared: "记录已清空。",
                exported: "已开始导出。",
                exportFailed: "导出失败。",
                flushed: "已保存。",
                bodyGroup: "运行记录",
                allSources: "全部来源",
                searchPlaceholder: "搜索记录",
                filterSource: "来源",
                filterSearch: "关键词",
                autoScroll: "自动滚动到最新",
                sourceCount: "{source}（{count}）",
                empty: "没有匹配的记录。",
                statsTotal: "总计",
                statsDebug: "调试",
                statsInfo: "信息",
                statsWarn: "警告",
                statsError: "错误",
                statsDropped: "已丢弃",
                statsCapacity: "缓冲上限",
                statsRestored: "上次带入",
                statsPersisting: "留存",
                persistOn: "开",
                persistOff: "关",
                footerGroup: "诊断",
                footerVersion: "版本",
                footerPlugins: "App 数",
                footerSettings: "设置项数",
                footerStorage: "设置占用",
                footerKeys: "设置键数",
                unitBytes: "字节",
            },
        },
    },
    "en": {
        ss: {
            debug: {
                controlsGroup: "Logging",
                level: "Log level",
                levelDebug: "Debug",
                levelInfo: "Info",
                levelWarn: "Warning",
                levelError: "Error",
                captureConsole: "Record console output",
                captureErrors: "Capture unhandled errors",
                bufferSize: "Buffer size",
                unitEntries: "entries",
                persist: "Keep across reloads",
                persistCount: "Retention limit",
                developerMode: "Show Debug Menu in Menu Bar",
                actionsGroup: "Actions",
                clear: "Clear log",
                clearHint: "Can't be undone.",
                clearBtn: "Clear",
                export: "Export log",
                exportBtn: "Export",
                copy: "Copy to clipboard",
                copyBtn: "Copy",
                flush: "Save now",
                flushBtn: "Save",
                snapshot: "Copy settings snapshot",
                snapshotBtn: "Copy snapshot",
                lastAction: "Last action",
                copyDone: "Copied {n} items.",
                copyFallback: "Text selected — press Ctrl/⌘+C.",
                cleared: "Log cleared.",
                exported: "Export started.",
                exportFailed: "Export failed.",
                flushed: "Saved.",
                bodyGroup: "Log",
                allSources: "All sources",
                searchPlaceholder: "Search the log",
                filterSource: "Source",
                filterSearch: "Keyword",
                autoScroll: "Auto-scroll to newest",
                sourceCount: "{source} ({count})",
                empty: "No matching entries.",
                statsTotal: "Total",
                statsDebug: "Debug",
                statsInfo: "Info",
                statsWarn: "Warning",
                statsError: "Error",
                statsDropped: "Dropped",
                statsCapacity: "Capacity",
                statsRestored: "From last session",
                statsPersisting: "Retention",
                persistOn: "on",
                persistOff: "off",
                footerGroup: "Diagnostics",
                footerVersion: "Version",
                footerPlugins: "Apps",
                footerSettings: "Settings",
                footerStorage: "Storage used",
                footerKeys: "Keys currently set",
                unitBytes: "bytes",
            },
        },
    },
    "ja-JP": {
        ss: {
            debug: {
                controlsGroup: "記録",
                level: "記録レベル",
                levelDebug: "デバッグ",
                levelInfo: "情報",
                levelWarn: "警告",
                levelError: "エラー",
                captureConsole: "console を記録",
                captureErrors: "未処理の例外を取得",
                bufferSize: "バッファ容量",
                unitEntries: "件",
                persist: "リロード後も保持",
                persistCount: "保持上限",
                developerMode: "メニューバーにデバッグメニューを表示",
                actionsGroup: "操作",
                clear: "記録を消去",
                clearHint: "消去すると復元できません。",
                clearBtn: "消去",
                export: "記録を書き出す",
                exportBtn: "書き出し",
                copy: "クリップボードへコピー",
                copyBtn: "コピー",
                flush: "いま保存",
                flushBtn: "保存",
                snapshot: "設定スナップショットをコピー",
                snapshotBtn: "スナップショット",
                lastAction: "直前の操作結果",
                copyDone: "{n} 件コピーしました。",
                copyFallback: "テキストを選択しました。Ctrl/⌘+C を。",
                cleared: "記録を消去しました。",
                exported: "書き出しを開始しました。",
                exportFailed: "書き出しに失敗しました。",
                flushed: "保存しました。",
                bodyGroup: "実行記録",
                allSources: "すべての発生源",
                searchPlaceholder: "記録を検索",
                filterSource: "発生源",
                filterSearch: "語句",
                autoScroll: "最新へ自動スクロール",
                sourceCount: "{source}（{count}）",
                empty: "該当する記録はありません。",
                statsTotal: "合計",
                statsDebug: "デバッグ",
                statsInfo: "情報",
                statsWarn: "警告",
                statsError: "エラー",
                statsDropped: "破棄",
                statsCapacity: "上限",
                statsRestored: "前回分",
                statsPersisting: "保持",
                persistOn: "入",
                persistOff: "切",
                footerGroup: "診断",
                footerVersion: "バージョン",
                footerPlugins: "App 数",
                footerSettings: "設定項目",
                footerStorage: "設定の占有",
                footerKeys: "設定キー数",
                unitBytes: "バイト",
            },
        },
    },
    "cat": {
        ss: {
            debug: {
                controlsGroup: "怎么记喵",
                level: "记到哪一级",
                levelDebug: "碎碎念",
                levelInfo: "平常话",
                levelWarn: "要留意",
                levelError: "出事了",
                captureConsole: "把 console 的话也记下来",
                captureErrors: "把没人接的错也接住",
                bufferSize: "心里记几条",
                unitEntries: "条喵",
                persist: "刷新了还记得",
                persistCount: "想留住几条",
                developerMode: "菜单栏摆个调试菜单",
                actionsGroup: "动手喵",
                clear: "把记录清空",
                clearHint: "倒空就找不回来啦喵。",
                clearBtn: "倒空",
                export: "导出运行记录喵",
                exportBtn: "导出喵",
                copy: "复制到剪贴板",
                copyBtn: "复制喵",
                flush: "现在就存",
                flushBtn: "存起来",
                snapshot: "复制设置快照",
                snapshotBtn: "复制快照",
                lastAction: "刚才那下的结果",
                copyDone: "复制了 {n} 项喵。",
                copyFallback: "帮主人选好了，按 Ctrl/⌘+C 喵。",
                cleared: "记录倒空啦喵。",
                exported: "开始导出喵。",
                exportFailed: "导不出来喵。",
                flushed: "存好了喵。",
                bodyGroup: "运行记录喵",
                allSources: "所有来源",
                searchPlaceholder: "搜搜说了什么",
                filterSource: "来源",
                filterSearch: "关键词",
                autoScroll: "自己滚到最新",
                sourceCount: "{source}（{count} 条）",
                empty: "没啥可看的喵。",
                statsTotal: "一共",
                statsDebug: "碎碎念",
                statsInfo: "平常话",
                statsWarn: "要留意",
                statsError: "出事了",
                statsDropped: "忘掉了",
                statsCapacity: "能记多少",
                statsRestored: "上次带过来",
                statsPersisting: "留得住吗",
                persistOn: "留",
                persistOff: "不留",
                footerGroup: "体检表喵",
                footerVersion: "版本号",
                footerPlugins: "App 数喵",
                footerSettings: "设置定义数",
                footerStorage: "设置占地",
                footerKeys: "现有设置键数",
                unitBytes: "字节",
            },
        },
    },
};

const CSS = `
.ss-debug .ss-debug__stats { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 10px; }
.ss-debug__chip { display: inline-flex; gap: 6px; align-items: baseline; padding: 3px 9px; border-radius: 999px;
  font-size: 11px; background: rgba(120,120,128,.14); }
.ss-debug__chip b { font-weight: 600; font-variant-numeric: tabular-nums; }
.ss-debug .ss-debug__filter { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.ss-debug .ss-debug__filter select { flex: 0 0 12em; }
.ss-debug .ss-debug__filter input[type="search"] { flex: 1 1 auto; }
.ss-debug .ss-debug__scroll { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; white-space: nowrap; }
.ss-debug .ss-debug__list { max-height: 46vh; overflow: auto; border-radius: 10px; padding: 4px;
  background: rgba(120,120,128,.10); font: 11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
.ss-debug__line { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 4px; border-radius: 6px; cursor: pointer; }
.ss-debug__line:hover { background: rgba(120,120,128,.14); }
.ss-debug__line .ss-debug__data { flex: 1 0 100%; white-space: pre-wrap; word-break: break-all; opacity: .75; padding-left: 1em; }
.ss-debug__line--debug { opacity: .6; }
.ss-debug__line--warn { color: #b25000; }
.ss-debug__line--error { color: #d9251c; }
.ss-debug__time, .ss-debug__level { opacity: .65; }
.ss-debug__source { color: var(--accent, #0a84ff); }
`;

/**
 * 构建调试面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    usePaneStyle(paneId, CSS);

    const list = el("div", { class: "ss-debug__list", attrs: { role: "log", "aria-live": "off" } });
    const emptyLine = el("p", { class: "ss-debug__empty", text: t("ss.debug.empty", "没有匹配的记录。") });
    emptyLine.hidden = true;

    const sourceSelect = el("select", { class: "ss-select", attrs: { "aria-label": t("ss.debug.filterSource", "来源") } });
    const searchInput = el("input", {
        class: "ss-input",
        attrs: { type: "search", placeholder: t("ss.debug.searchPlaceholder", "搜索记录"), "aria-label": t("ss.debug.filterSearch", "关键词") },
    });
    const autoScroll = localSwitch(true);

    let lastSourceSignature = "";

    /** 用当前筛选条件重绘列表与统计（合并到每帧一次）。 */
    function render() {
        const opts = currentFilter(sourceSelect, searchInput);
        const all = log.query(opts);
        const shown = all.slice(-RENDER_CAP);
        const levels = levelLabelMap();
        list.textContent = "";
        shown.forEach((entry) => list.append(lineFor(entry, levels)));
        emptyLine.hidden = shown.length > 0;
        list.append(emptyLine);
        if (autoScroll.isOn()) list.scrollTop = list.scrollHeight;
        paintStats();
        resyncSources();
    }

    /** 来源下拉按 stats().sources 重建；名单没变就不动，避免打断用户的选择。 */
    function resyncSources() {
        const sources = log.stats().sources || [];
        const signature = sources.map((item) => `${item.source}:${item.count}`).join("|");
        if (signature === lastSourceSignature) return;
        lastSourceSignature = signature;
        const selected = sourceSelect.value;
        sourceSelect.textContent = "";
        sourceSelect.append(el("option", { attrs: { value: "" }, text: t("ss.debug.allSources", "全部来源") }));
        sources.forEach((item) => sourceSelect.append(el("option", {
            attrs: { value: item.source },
            text: t("ss.debug.sourceCount", "{source}（{count}）")
                .replace("{source}", String(item.source))
                .replace("{count}", String(item.count)),
        })));
        if ([...sourceSelect.options].some((option) => option.value === selected)) sourceSelect.value = selected;
    }

    const statsBox = el("div", { class: "ss-debug__stats" });

    /** 头部统计条：总量 / 分级 / 丢弃 / 上限 / 带入 / 留存。 */
    function paintStats() {
        const stats = log.stats();
        const chips = [
            [t("ss.debug.statsTotal", "总计"), stats.total],
            [t("ss.debug.statsDebug", "调试"), stats.byLevel.debug || 0],
            [t("ss.debug.statsInfo", "信息"), stats.byLevel.info || 0],
            [t("ss.debug.statsWarn", "警告"), stats.byLevel.warn || 0],
            [t("ss.debug.statsError", "错误"), stats.byLevel.error || 0],
            [t("ss.debug.statsDropped", "已丢弃"), stats.dropped],
            [t("ss.debug.statsCapacity", "缓冲上限"), stats.capacity],
            [t("ss.debug.statsRestored", "上次带入"), stats.restored],
            [t("ss.debug.statsPersisting", "留存"), stats.persisting ? t("ss.debug.persistOn", "开") : t("ss.debug.persistOff", "关")],
        ];
        statsBox.textContent = "";
        chips.forEach(([label, value]) => statsBox.append(el("span", { class: "ss-debug__chip" },
            el("span", { text: `${label} ` }), el("b", { text: String(value) }))));
    }

    sourceSelect.addEventListener("change", () => render());
    searchInput.addEventListener("input", () => render());

    const actionStatus = statusRow({ label: t("ss.debug.lastAction", "上次操作结果"), value: "—" });

    /**
     * 把一次动作的结果写到状态行。
     * @param {{ok:boolean, count:number}} outcome copyText 的结果
     * @param {string} [fixed] 不给数量、直接给出的结论文案
     * @returns {void}
     */
    function report(outcome, fixed) {
        if (fixed) { actionStatus.setValue(fixed); return; }
        actionStatus.setValue(outcome.ok
            ? t("ss.debug.copyDone", "已复制 {n} 项。").replace("{n}", String(outcome.count))
            : t("ss.debug.copyFallback", "已选中文本，按 Ctrl/⌘+C。"));
    }

    const body = group([
        statsBox,
        el("div", { class: "ss-debug__filter" },
            sourceSelect,
            searchInput,
            el("div", { class: "ss-debug__scroll" }, autoScroll.node, el("span", { text: t("ss.debug.autoScroll", "自动滚动到最新") }))),
        list,
    ], { title: t("ss.debug.bodyGroup", "运行记录") });

    // ---- 日志增量 -> 合并到一帧 ----
    let frame = 0;
    const scheduleRender = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => { frame = 0; render(); });
    };
    const unsubscribeLog = log.subscribe(scheduleRender);
    const unsubscribeSettings = settings.subscribe((detail) => {
        if (detail && String(detail.key).startsWith("debug.")) scheduleRender();
    });
    track(() => unsubscribeLog());
    track(() => unsubscribeSettings());
    track(() => { if (frame) cancelAnimationFrame(frame); });

    render();

    return el("div", { class: "ss-pane ss-debug" },
        group([
            controlDropdown("debug.logLevel", {
                label: t("ss.debug.level", "记录级别"),
                options: levelOptions(),
            }),
            controlSwitch("debug.captureConsole", { label: t("ss.debug.captureConsole", "console 输出") }),
            controlSwitch("debug.captureErrors", { label: t("ss.debug.captureErrors", "捕获未处理异常") }),
            controlSlider("debug.bufferSize", {
                label: t("ss.debug.bufferSize", "缓冲区容量"),
                min: 100, max: 5000, step: 100,
                units: t("ss.debug.unitEntries", "条"),
            }),
            controlSwitch("debug.persist", { label: t("ss.debug.persist", "刷新后保留") }),
            controlSlider("debug.persistCount", {
                label: t("ss.debug.persistCount", "保留上限"),
                min: 0, max: 500, step: 10,
                units: t("ss.debug.unitEntries", "条"),
            }),
            controlSwitch("debug.developerMode", { label: t("ss.debug.developerMode", "菜单栏显示调试菜单") }),
        ], { title: t("ss.debug.controlsGroup", "记录") }),

        group([
            actionRow({
                label: t("ss.debug.clear", "清空运行记录"),
                hint: t("ss.debug.clearHint", "清空后无法恢复。"),
                buttonText: t("ss.debug.clearBtn", "清空"),
                tone: "danger",
                onAction: async () => {
                    log.clear();
                    scheduleRender();
                    report({ ok: true, count: 0 }, t("ss.debug.cleared", "记录已清空。"));
                },
            }),
            actionRow({
                label: t("ss.debug.export", "导出运行记录"),
                buttonText: t("ss.debug.exportBtn", "导出"),
                onAction: async () => {
                    const started = log.download(`deskly-log-${Date.now()}.log`, currentFilter(sourceSelect, searchInput));
                    actionStatus.setValue(started
                        ? t("ss.debug.exported", "已开始导出。")
                        : t("ss.debug.exportFailed", "导出失败。"));
                },
            }),
            actionRow({
                label: t("ss.debug.copy", "复制到剪贴板"),
                buttonText: t("ss.debug.copyBtn", "复制"),
                onAction: async () => report(await copyText(log.exportText(currentFilter(sourceSelect, searchInput)))),
            }),
            actionRow({
                label: t("ss.debug.flush", "立即保存"),
                buttonText: t("ss.debug.flushBtn", "保存"),
                onAction: async () => {
                    log.flush();
                    scheduleRender();
                    report({ ok: true, count: 0 }, t("ss.debug.flushed", "已保存。"));
                },
            }),
            actionRow({
                label: t("ss.debug.snapshot", "复制设置快照"),
                buttonText: t("ss.debug.snapshotBtn", "复制快照"),
                onAction: async () => report(await copyText(JSON.stringify(settings.snapshot(), null, 2))),
            }),
            actionStatus,
        ], { title: t("ss.debug.actionsGroup", "操作") }),

        body,

        group(diagnosticRows(), { title: t("ss.debug.footerGroup", "诊断") })
    );
}

/**
 * 单行日志：时间 + 级别 + 来源 + 消息，带上下文的行点开多出的一行；全部 textContent。
 * @param {object} entry log.query() 的记录
 * @param {Map<string,string>} levels 级别名 -> 显示文案（整屏共用一份，别每行重算）
 * @returns {HTMLElement} 行元素
 */
function lineFor(entry, levels) {
    const line = el("div", { class: `ss-debug__line ss-debug__line--${entry.level}` });
    line.append(
        el("span", { class: "ss-debug__time", text: stampOf(entry.time) }),
        el("span", { class: "ss-debug__level", text: levels.get(entry.level) || String(entry.level) }),
        el("span", { class: "ss-debug__source", text: entry.source }),
        el("span", { class: "ss-debug__msg", text: entry.msg })
    );
    if (entry.restored) line.append(el("span", { class: "ss-debug__tag", text: "↩" }));
    if (entry.data) {
        const data = el("div", { class: "ss-debug__data", text: entry.data });
        data.hidden = true;
        line.append(data);
        line.addEventListener("click", () => {
            data.hidden = !data.hidden;
            line.classList.toggle("ss-debug__line--open", !data.hidden);
        });
    }
    return line;
}

/**
 * 当前筛选条件：来源（子串匹配）+ 关键词，一次最多取 RENDER_CAP * 4 条避免无界拷贝。
 * @param {HTMLSelectElement} sourceSelect 来源下拉
 * @param {HTMLInputElement} searchInput 关键词输入
 * @returns {object} log.query 的选项
 */
function currentFilter(sourceSelect, searchInput) {
    const source = sourceSelect.value || undefined;
    const contains = searchInput.value.trim() || undefined;
    return { source, contains, limit: RENDER_CAP * 4 };
}

/**
 * 级别下拉候选：取值表来自 log.levels()，标签走语言包。
 * @returns {Array<{value:string, label:string}>} 选项
 */
function levelOptions() {
    const labels = {
        debug: t("ss.debug.levelDebug", "调试"),
        info: t("ss.debug.levelInfo", "信息"),
        warn: t("ss.debug.levelWarn", "警告"),
        error: t("ss.debug.levelError", "错误"),
    };
    const names = typeof log.levels === "function" ? log.levels() : Object.keys(labels);
    return names.map((name) => ({ value: name, label: labels[name] || name }));
}

/**
 * 级别名到显示文案的表（每次重绘取一份，避免逐行重复调用 t()）。
 * @returns {Map<string,string>} 级别标签
 */
function levelLabelMap() {
    return new Map(levelOptions().map((option) => [option.value, option.label]));
}

/**
 * 记录时间戳（本地时分秒）。
 * @param {number} time 毫秒时间戳
 * @returns {string} 文本
 */
function stampOf(time) {
    const date = new Date(time);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 复制文本到剪贴板，失败时回退为选中文本方案。
 * @param {string} text 待复制文本
 * @returns {Promise<{ok:boolean, count:number}>} 是否成功与条目数（成功即视为可显示）
 */
async function copyText(text) {
    const count = countItems(text);
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return { ok: true, count };
        }
    } catch {
        /* 继续走选中文本 */
    }
    const area = el("textarea", { attrs: { readonly: "" } });
    area.value = text;
    area.style.cssText = "position:fixed;left:-9999px;top:0;";
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return { ok, count };
}

/**
 * 快照文本里数得出多少个槽位；非 JSON 文本（例如日志）按行数计。
 * @param {string} text 复制的文本
 * @returns {number} 数量
 */
function countItems(text) {
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return Object.keys(parsed).length;
    } catch {
        /* 不是 JSON，按行计 */
    }
    return String(text).split("\n").filter(Boolean).length;
}

/**
 * 页脚诊断行：版本、插件在册数、设置定义数、设置占用字节、当前键数。
 * @returns {Array<HTMLElement>} 行元素
 */
function diagnosticRows() {
    const storage = settings.storage();
    const plugins = typeof log.plugins === "function" ? log.plugins() : [];
    return [
        statusLine(t("ss.debug.footerVersion", "版本"), `${APP_NAME} ${VERSION}`),
        statusLine(t("ss.debug.footerPlugins", "App 数"), String(plugins.length)),
        statusLine(t("ss.debug.footerSettings", "设置项数"), String(settings.list().length)),
        statusLine(t("ss.debug.footerStorage", "设置占用"), `${storage.bytes} ${t("ss.debug.unitBytes", "字节")}`),
        statusLine(t("ss.debug.footerKeys", "设置键数"), String(Object.keys(settings.all()).length)),
    ];
}

/**
 * 一条只读诊断行。
 * @param {string} label 标签
 * @param {string} value 值
 * @returns {HTMLElement} 行元素
 */
function statusLine(label, value) {
    return el("div", { class: "ss-row" },
        el("div", { class: "ss-row__main" }, el("p", { class: "ss-row__label", text: label })),
        el("div", { class: "ss-row__control" }, el("span", { class: "ss-status__value", text: value }))
    );
}

/**
 * 一个不绑设置键的本地开关（用于「自动滚动」这种纯界面偏好，不该写进设置中枢）。
 * @param {boolean} initial 初值
 * @returns {{node:HTMLElement, isOn:Function}} 开关
 */
function localSwitch(initial) {
    let on = Boolean(initial);
    const knob = el("span", { class: "ss-switch__knob" });
    const node = el("button", { class: "ss-switch", attrs: { type: "button", role: "switch" } }, knob);
    const paint = () => {
        node.dataset.on = on ? "true" : "false";
        node.setAttribute("aria-checked", on ? "true" : "false");
    };
    node.addEventListener("click", () => { on = !on; paint(); });
    paint();
    return { node, isOn: () => on };
}

/** 列表与订阅句柄都登记在 ui.js 的释放列表里，切面板时 rAF、订阅一并回收。 */
export function destroy() { }
