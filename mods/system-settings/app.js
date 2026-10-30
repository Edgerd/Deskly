/**
 * app.js — 系统设置外壳：侧栏、搜索、前进/后退历史、面板装载与生命周期
 *
 * 本模块与入口的关系决定了它的写法（改动前先读完这段）：
 * script.js 每次打开都带全新 URL 重新执行，而 app.js / ui.js / registry.js 的说明符是稳定的，
 * 整个会话只有一份实例。因此这里的所有 document/window 级监听都必须「先摘掉再挂」，
 * 并由 plugin-unload 统一释放；否则开 N 次窗口就有 N 份监听，还各自拖着一份已卸载的 DOM。
 * （旧版正是这样：每个下拉框在 document 上挂一个永不摘除的点击监听。）
 *
 * 界面装配规则：
 * - 侧栏只渲染 registry 里 `implemented: true` 的面板，未实现项不进 DOM 也不被 import；
 * - 面板按需 `import("./panes/<module>.js")`，失败就在面板区给出可读的错误行 + 重试，绝不留空白面板；
 * - 每次切换先 ui.disposeAll() 摘掉上一个面板的全部订阅，再调它的 destroy()（若有）；
 * - 文案一律 t(key, 中文fallback)：面板自带语言包由这里注册进 i18n，注册不上也只是退回中文；
 * - 语言切换后重建当前面板：选项标签（浅色/深色、滚动条三档……）是构建时算出来的，
 *   不重建就会永远冻在切换前那门语言里（旧版 bug）。
 *
 * 面板内子视图导航协议（为什么外壳要知道这件事）：
 * 「App」这类面板在自己的页面里有二级视图（列表 → 应用详情），而工具栏的前进/后退
 * 原本只走「跨面板」历史栈。若外壳不认识子视图，用户在详情页点后退会直接跳出面板，
 * 详情视图等于白做。外壳不关心任何具体面板的视图结构，只约定可选导出：
 * canGoBack()/canGoForward() 说「这个方向我还有子视图可走」，onBack()/onForward() 返回 true
 * 表示「这一步被子视图吃掉了」。两个条件同时成立才算消费，历史栈与游标都不动。
 * onBack/onForward 消费后面板要调 ctx.syncNav() 让按钮可用态跟上新状态；
 * ctx.reason 告诉面板这次重建来自哪里（目前只有 "language"），面板据此决定子视图是否跨重建保留；
 * ctx.params 是深链带进来的参数（?pane=plugins&app=calculator 里的 app），面板据此直开详情页。
 */

import { i18n } from "../../src/javascripts/i18n.js";
import { log } from "../../src/javascripts/log.js";
import { openApp } from "../../src/javascripts/plugin-manager.js";
import { el, t, disposeAll, actionRow } from "./ui.js";
import { sidebarGroups, findPane, matchPanes } from "./registry.js";

/** 插件 id：plugin-unload 的 detail.id 与日志来源都用它。 */
const PLUGIN_ID = "system-settings";

/** 深链全局名：外部（聚焦搜索、通知、面板互跳）用它指定要打开的面板。 */
const PENDING_KEY = "__pendingSettingsPane";

/**
 * 外壳自带文案：侧栏分组、搜索、工具栏、错误提示，以及本组 7 个面板的标题。
 * 其余面板的标题写在各自模块的 messages 里，被 import 之后由 refreshSidebarLabels() 补上；
 * 在那之前显示 registry 的中文 label 作为回退。
 */
const SHELL_MESSAGES = {
    "zh-CN": {
        ss: {
            shell: {
                sidebar: "设置边栏", search: "搜索设置项", clearSearch: "清除搜索",
                noResult: "没有匹配的设置项", back: "返回上一个面板", forward: "前进到下一个面板",
                loadFailed: "面板加载失败", loadFailedHint: "这个面板的模块没能载入，可以重试一次。",
                notImplemented: "该面板尚未提供",
                notImplementedHint: "注册表里这个面板还没有实现，界面不再为它留占位页。",
                unknownPane: "没有这个面板", retry: "重试",
            },
            group: {
                account: "账户", general: "通用", personalize: "个性化", attention: "提醒",
                security: "安全", services: "服务", input: "输入", advanced: "高级",
            },
        },
    },
    en: {
        ss: {
            shell: {
                sidebar: "Settings sidebar", search: "Search settings", clearSearch: "Clear search",
                noResult: "No matching settings", back: "Back to previous pane", forward: "Forward to next pane",
                loadFailed: "Pane failed to load",
                loadFailedHint: "This pane's module could not be loaded. You can try again.",
                notImplemented: "Pane not available",
                notImplementedHint: "This pane is not implemented yet, so no placeholder is shown.",
                unknownPane: "Unknown pane", retry: "Try again",
            },
            group: {
                account: "Account", general: "General", personalize: "Personalization", attention: "Alerts",
                security: "Security", services: "Services", input: "Input", advanced: "Advanced",
            },
        },
    },
    "ja-JP": {
        ss: {
            shell: {
                sidebar: "設定サイドバー", search: "設定を検索", clearSearch: "検索を消去",
                noResult: "一致する設定がありません", back: "前のパネルへ戻る", forward: "次のパネルへ進む",
                loadFailed: "パネルを読み込めませんでした",
                loadFailedHint: "このパネルのモジュールの読み込みに失敗しました。もう一度お試しください。",
                notImplemented: "このパネルは未提供です",
                notImplementedHint: "レジストリ上で未実装のため、プレースホルダーは表示されません。",
                unknownPane: "パネルが見つかりません", retry: "再試行",
            },
            group: {
                account: "アカウント", general: "一般", personalize: "個人設定", attention: "通知",
                security: "セキュリティ", services: "サービス", input: "入力", advanced: "詳細",
            },
        },
    },
    cat: {
        ss: {
            shell: {
                sidebar: "主人的設定邊欄喵", search: "主人要找哪個設定喵", clearSearch: "幫主人擦掉喵~",
                noResult: "沒有相符的設定項喵~", back: "退回去看上一個喵~", forward: "往前跳一個喵~",
                loadFailed: "這個面板打不開喵~",
                loadFailedHint: "主人的面板載入失敗了，再試一次好喵~",
                notImplemented: "這個面板還沒做喵~",
                notImplementedHint: "註冊表裡還沒有這個面板，喵星人不留空位喵~",
                unknownPane: "找不到這個面板喵~", retry: "再來一次喵~",
            },
            group: {
                account: "主人帳戶喵", general: "通用喵", personalize: "個性化喵", attention: "提醒喵",
                security: "安全喵", services: "服務喵", input: "輸入喵", advanced: "進階喵",
            },
        },
    },
};

/** 外壳运行态：窗口关闭 / 重新打开时整体重建。 */
const shell = {
    root: null, list: null, empty: null, search: null, clear: null,
    title: null, back: null, forward: null, host: null,
    rows: new Map(), groups: [],
    paneId: "", module: null,
    history: [], cursor: -1, ticket: 0,
};

/** 外壳级（跨面板常驻）释放句柄，与 ui.js 的面板级列表分开。 */
let shellDisposers = [];

/** 语言变更的重建合流标记：onChange 与 languagechange 同时到达也只重建一次。 */
let languageQueued = false;

/** 面板消息注册能力探测结果（缺失时只提示一次，不每次切面板都刷日志）。 */
let warnedRegister = false;

/**
 * 把面板自带语言包注册进 i18n。
 * registerMessagesAll 由内核侧提供；没有就退回逐语言的 registerMessages，
 * 两者都没有时什么都不做 —— 所有调用点都带中文回退，界面不会因此变成空白。
 * @param {object} messages {语言代号: 嵌套词条}
 * @returns {void}
 */
function registerMessages(messages) {
    if (!messages || typeof messages !== "object") return;
    try {
        if (typeof i18n.registerMessagesAll === "function") {
            i18n.registerMessagesAll(messages);
            return;
        }
        if (typeof i18n.registerMessages === "function") {
            Object.entries(messages).forEach(([lang, dict]) => i18n.registerMessages(lang, dict));
            return;
        }
    } catch (err) {
        log.warn("plugin/system-settings", "注册面板语言包失败", err);
        return;
    }
    if (!warnedRegister) {
        warnedRegister = true;
        log.info("plugin/system-settings", "i18n 未提供 registerMessagesAll，界面文案退回中文默认值");
    }
}

/** 摘掉外壳级全局监听（与 attachGlobals 成对，保证任何时刻只有一份）。 */
function detachGlobals() {
    shellDisposers.forEach((off) => {
        try { off(); } catch (err) { log.warn("plugin/system-settings", "释放外壳监听失败", err); }
    });
    shellDisposers = [];
}

/**
 * 挂载外壳级监听：卸载通知、深链跳转、语言变更。
 * 每次都先 detachGlobals()，所以重复 boot（重复打开窗口）不会叠加监听。
 * @returns {void}
 */
function attachGlobals() {
    detachGlobals();

    const onUnload = (e) => {
        if (!e.detail || e.detail.id !== PLUGIN_ID) return;
        shutdown();
        log.info("plugin/system-settings", "系统设置已关闭：面板订阅、全局监听与历史栈全部释放");
    };
    document.addEventListener("plugin-unload", onUnload);
    shellDisposers.push(() => document.removeEventListener("plugin-unload", onUnload));

    const onOpenPane = (e) => {
        const id = e.detail && (e.detail.pane || e.detail.paneId || e.detail.id);
        if (!id) return;
        // detail.app 是深链给面板的参数（目前只有 App 面板的详情页用），原样转发。
        // 带参数时必须 force：面板已经停在当前面板时 selectPane 会短路，参数就没人读了，
        // 「聚搜里点某个 App 的设置」会变成一次毫无反应的点击。
        const app = e.detail && e.detail.app;
        selectPane(id, app ? { params: { app }, force: true } : {});
    };
    document.addEventListener("system-settings-open-pane", onOpenPane);
    shellDisposers.push(() => document.removeEventListener("system-settings-open-pane", onOpenPane));

    const onLanguage = () => scheduleLanguageRebuild();
    if (typeof i18n.onChange === "function") {
        const off = i18n.onChange(onLanguage);
        if (typeof off === "function") shellDisposers.push(off);
    }
    // languagechange 是 i18n.setLanguage 的稳定行为（在 document 上派发且冒泡）。
    // 与 onChange 并存不会重建两次：scheduleLanguageRebuild 做了合流。
    document.addEventListener("languagechange", onLanguage);
    shellDisposers.push(() => document.removeEventListener("languagechange", onLanguage));
}

/** 语言变更后重建侧栏与当前面板：选项标签是构建时算出来的，不重建就停在旧语言。 */
function scheduleLanguageRebuild() {
    if (languageQueued) return;
    languageQueued = true;
    queueMicrotask(() => {
        languageQueued = false;
        if (!shell.root || !shell.root.isConnected) return;
        renderSidebar();
        applyFilter(shell.search ? shell.search.value : "");
        markActive(shell.paneId);
        // reason:"language" 告诉面板这次重建来自语言切换，子视图是否保留由面板自己定夺。
        selectPane(shell.paneId || "general", { force: true, record: false, reason: "language" });
    });
}

/** 装配侧栏：按 registry 的分组顺序生成，只含有已实现面板的分组。 */
function renderSidebar() {
    shell.rows.clear();
    shell.groups = [];
    shell.list.textContent = "";
    sidebarGroups().forEach(({ group, panes }) => {
        // 原版（macOS 系统设置）侧栏**不显示分组标题**，只靠簇与簇之间的空隙分组。
        // 这里保留元素本身：它同时是「这一组被过滤空了就整组收掉」的挂载点（见 applyFilter），
        // 并且 aria-hidden 后屏幕阅读器仍会按条目顺序读出面板名，不损失可访问性。
        const title = el("p", { class: "ss-sidebar__group", attrs: { "aria-hidden": "true" } });
        const body = el("div", { class: "ss-sidebar__body", dataset: { group: group.id } });
        const rows = panes.map((entry) => {
            const row = itemRow(entry);
            body.append(row);
            return row;
        });
        shell.list.append(title, body);
        shell.groups.push({ title, body, rows });
    });
}

/**
 * 一个侧栏条目：data-pane + 图标 + 本地化标题。
 * 用 <button> 而不是 <div>：窗口拖拽的排除清单里有 button，条目因此不会被拖窗劫持。
 * @param {object} entry registry 面板条目
 * @returns {HTMLElement} 条目元素
 */
function itemRow(entry) {
    const row = el("button", {
        class: "ss-item",
        attrs: { type: "button" },
        dataset: { pane: entry.id },
    },
        el("img", { class: "ss-item__icon", attrs: { src: entry.icon, alt: "" } }),
        el("span", { class: "ss-item__label", text: paneLabel(entry) }));
    row.addEventListener("click", () => selectPane(entry.id));
    shell.rows.set(entry.id, row);
    return row;
}

/**
 * 面板标题：优先各面板注册进 i18n 的词条，缺失时用 registry 的中文 label。
 * @param {object} entry 面板条目
 * @returns {string} 标题文本
 */
function paneLabel(entry) {
    return t(entry.i18nKey, entry.label);
}

/** 已 import 过某面板后补一次侧栏标题：别组面板的词条是那时才进的语言包。 */
function refreshSidebarLabels() {
    shell.rows.forEach((row, id) => {
        const entry = findPane(id);
        const label = row.querySelector(".ss-item__label");
        if (entry && label) label.textContent = paneLabel(entry);
    });
    const current = findPane(shell.paneId);
    if (current && shell.title) shell.title.textContent = paneLabel(current);
}

/**
 * 侧栏搜索过滤：隐藏不命中的条目与空分组，清空时全部还原。
 * @param {string} query 输入文本
 * @returns {void}
 */
function applyFilter(query) {
    const text = String(query || "").trim();
    const matched = text ? new Set(matchPanes(text).map((p) => p.id)) : null;
    let visible = 0;
    shell.groups.forEach(({ title, body, rows }) => {
        let shown = 0;
        rows.forEach((row) => {
            const hit = !matched || matched.has(row.dataset.pane);
            row.hidden = !hit;
            if (hit) shown += 1;
        });
        title.hidden = shown === 0;
        body.hidden = shown === 0;
        visible += shown;
    });
    shell.empty.hidden = visible !== 0;
    if (shell.clear) shell.clear.hidden = !text;
}

/**
 * 记录历史并刷新前进/后退按钮可用态。
 * @param {string} id 面板 id
 * @returns {void}
 */
function recordHistory(id) {
    if (shell.history.length - 1 > shell.cursor) shell.history = shell.history.slice(0, shell.cursor + 1);
    if (shell.history[shell.cursor] === id) return;
    shell.history.push(id);
    shell.cursor = shell.history.length - 1;
    syncNavButtons();
}

/**
 * 调用当前面板的可选导航钩子（子视图协议，见文件头注释）。
 * 外壳不认识任何具体面板的视图结构：钩子缺位与钩子抛错一律按「面板未消费」处理，
 * 坏掉的面板绝不能把后退按钮按死 —— 所以抛错只记 warn 并返回 false。
 * 返回按真值判断而不是 === true：面板把 canGoBack 写成 `() => stack.length` 也算数，
 * 否则子视图明明还在、按钮却会退回按历史栈算出来的状态。
 * @param {string} name 钩子名：canGoBack / onBack / canGoForward / onForward
 * @returns {boolean} 面板是否接住了这次询问/导航
 */
function paneNav(name) {
    const mod = shell.module;
    if (!mod || typeof mod[name] !== "function") return false;
    try {
        return Boolean(mod[name]());
    } catch (err) {
        log.warn("plugin/system-settings", `面板 ${shell.paneId} 的 ${name}() 抛错，按未消费处理`, err);
        return false;
    }
}

/**
 * 按历史栈位置与面板子视图状态，更新两个导航按钮的可用态。
 * 启用条件是「面板能往这边走」或「历史栈还能走」，两者取或 —— 子视图协议只是加在
 * 既有历史逻辑上的一层，没有导出的面板行为与从前完全一致。
 * 本函数在 boot 早期（还没有任何模块被 import、按钮尚未就位）就会被调用，所以两侧都要判空。
 */
function syncNavButtons() {
    if (shell.back) shell.back.disabled = !paneNav("canGoBack") && shell.cursor <= 0;
    if (shell.forward) shell.forward.disabled = !paneNav("canGoForward") && shell.cursor >= shell.history.length - 1;
}

/**
 * 切换面板：释放上一个 -> 动态 import -> 注册语言包 -> build -> 挂载。
 * 任何一步失败都在面板区给出可读的错误行，并写一条 plugin/system-settings 错误日志。
 * @param {string} id 面板 id
 * @param {object} [opts] {record:false 不写历史；force:true 同面板也重建（语言切换用）；
 *                         reason: 重建来源（如 "language"）；params: 深链参数，原样交给面板 build()}
 * @returns {Promise<void>} 装载结束
 */
async function selectPane(id, opts = {}) {
    const entry = findPane(id);
    if (!entry) {
        shell.paneId = "";
        showError(t("ss.shell.unknownPane", "没有这个面板"),
            t("ss.shell.notImplementedHint", "注册表里这个面板还没有实现，界面不再为它留占位页。"));
        return;
    }
    if (!entry.implemented) {
        shell.paneId = entry.id;
        markActive(entry.id);
        shell.title.textContent = paneLabel(entry);
        showError(paneLabel(entry), t("ss.shell.notImplementedHint", "注册表里这个面板还没有实现，界面不再为它留占位页。"));
        return;
    }
    if (!opts.force && shell.paneId === entry.id) {
        markActive(entry.id);
        return;
    }

    const ticket = ++shell.ticket;
    releasePane();
    shell.paneId = entry.id;
    markActive(entry.id);
    shell.title.textContent = paneLabel(entry);
    if (opts.record !== false) recordHistory(entry.id);

    let mod = null;
    try {
        mod = await import(`./panes/${entry.module}.js`);
    } catch (err) {
        log.error("plugin/system-settings", `面板 ${entry.id} 的模块 ./panes/${entry.module}.js 加载失败`, err);
        if (ticket === shell.ticket && shell.host && shell.host.isConnected) {
            showError(paneLabel(entry), String((err && err.message) || err), entry.id);
        }
        return;
    }
    if (ticket !== shell.ticket || !shell.host || !shell.host.isConnected) return;

    registerMessages(mod.messages);

    let node = null;
    try {
        node = mod.build(makeContext(entry.id, opts));
    } catch (err) {
        log.error("plugin/system-settings", `面板 ${entry.id} 构建失败`, err);
        showError(paneLabel(entry), String((err && err.message) || err), entry.id);
        return;
    }
    if (ticket !== shell.ticket || !shell.host || !shell.host.isConnected) return;
    if (!node || !(node instanceof Node)) {
        showError(paneLabel(entry), t("ss.shell.loadFailedHint", "这个面板的模块没能载入，可以重试一次。"), entry.id);
        return;
    }
    shell.module = mod;
    shell.host.append(node);
    refreshSidebarLabels();
    // releasePane() 已把旧模块置空，recordHistory 时按钮只能按历史栈算；
    // 新模块就位后必须再同步一次，否则切完面板后退/前进按钮停在旧状态。
    syncNavButtons();
}

/**
 * 生成交给面板的上下文：切面板、跳面板、取译文、子视图导航。
 * @param {string} paneId 当前面板 id
 * @param {object} [opts] 透传给本面板 selectPane 的选项 {reason, params}
 * @returns {{paneId:string, selectPane:Function, openPane:Function, syncNav:Function, reason:string, params:object, t:Function}} 上下文
 */
function makeContext(paneId, opts = {}) {
    return {
        paneId,
        selectPane: (target) => selectPane(target),
        openPane: (target, params) => openPane(target, params),
        // 面板进出内嵌子视图后调用：让外壳按 canGoBack/canGoForward 重算按钮可用态。
        syncNav: () => syncNavButtons(),
        // 本次 build 的重建来源："" 常规切换，"language" 语言切换重建（面板可据此保留子视图）。
        reason: opts.reason || "",
        // 深链参数（如 {app:"calculator"}），由 initialPaneId / openPane / open-pane 事件带入。
        params: opts.params || {},
        t,
    };
}

/**
 * 供其它应用/面板请求打开某个面板：先落深链全局，再按当前窗口是否存活决定切换或唤起。
 * @param {string} id 面板 id
 * @param {object} [params] 可选深链参数（如 {app:"calculator"}）；窗口未开时并入 PENDING_KEY 交接
 * @returns {Promise<HTMLElement>|void} 需要唤起应用时返回 openApp 的结果
 */
function openPane(id, params) {
    const hasParams = params && Object.keys(params).length > 0;
    globalThis[PENDING_KEY] = hasParams ? { pane: id, ...params } : id;
    if (shell.root && shell.root.isConnected) {
        // force 只在带参数时加：面板已经停在当前面板时不重建就没人去读 params，深链等于没生效。
        // 单参数调用（既有调用方）不带 force，行为与改动前逐字一致。
        const result = selectPane(id, hasParams ? { params, force: true } : {});
        delete globalThis[PENDING_KEY];
        return result;
    }
    return openApp("系统设置");
}

/** 标记侧栏选中态（用类名与 aria-current，不依赖旧版的 .selection.focus）。 */
function markActive(id) {
    shell.rows.forEach((row, key) => {
        const on = key === id;
        row.classList.toggle("ss-item--on", on);
        if (on) row.setAttribute("aria-current", "page");
        else row.removeAttribute("aria-current");
    });
}

/** 释放当前面板：ui.js 的订阅/监听 + 面板自己的 destroy()。 */
function releasePane() {
    const mod = shell.module;
    shell.module = null;
    disposeAll();
    if (mod && typeof mod.destroy === "function") {
        try { mod.destroy(); } catch (err) { log.warn("plugin/system-settings", `${shell.paneId} 面板的 destroy 抛错`, err); }
    }
    if (shell.host) shell.host.textContent = "";
}

/**
 * 面板区的失败页：标题 + 说明 + 重试按钮（动态文本走 textContent，不拼 HTML）。
 * @param {string} title 标题（面板名或本地化的失败标题）
 * @param {string} detail 说明文本
 * @param {string} [retryId] 要重试的面板 id，缺省则不给重试按钮
 * @returns {void}
 */
function showError(title, detail, retryId) {
    if (!shell.host) return;
    shell.host.textContent = "";
    const rows = [el("p", { class: "ss-note", text: detail || t("ss.shell.loadFailedHint", "这个面板的模块没能载入，可以重试一次。") })];
    if (retryId) {
        rows.push(actionRow({
            label: t("ss.shell.loadFailed", "面板加载失败"),
            buttonText: t("ss.shell.retry", "重试"),
            tone: "accent",
            onAction: () => selectPane(retryId, { force: true }),
        }));
    }
    shell.host.append(el("div", { class: "ss-pane-error" }, el("h3", { class: "ss-heading", text: title }), ...rows));
}

/** 外壳一次性接线：搜索框、清除按钮、前进/后退，并写入本地化文案。 */
function wireShell() {
    shell.search.addEventListener("input", () => applyFilter(shell.search.value));
    shell.search.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { shell.search.value = ""; applyFilter(""); }
    });
    shell.clear.addEventListener("click", () => {
        shell.search.value = "";
        applyFilter("");
        shell.search.focus();
    });
    shell.back.addEventListener("click", () => navigate(-1));
    shell.forward.addEventListener("click", () => navigate(1));
    // 外壳文案由 t() 写入；不给这些标签挂 data-i18n（见 index.html 顶部说明）
    shell.search.placeholder = t("ss.shell.search", "搜索设置项");
    shell.search.setAttribute("aria-label", t("ss.shell.search", "搜索设置项"));
    shell.clear.setAttribute("aria-label", t("ss.shell.clearSearch", "清除搜索"));
    shell.back.setAttribute("aria-label", t("ss.shell.back", "返回上一个面板"));
    shell.forward.setAttribute("aria-label", t("ss.shell.forward", "前进到下一个面板"));
    shell.empty.textContent = t("ss.shell.noResult", "没有匹配的设置项");
    const sidebar = shell.root.querySelector(".ss-sidebar");
    if (sidebar) sidebar.setAttribute("aria-label", t("ss.shell.sidebar", "设置边栏"));
}

/**
 * 历史栈导航：先问面板要不要消费（子视图出栈/入栈），面板未消费才走跨面板历史。
 * @param {number} delta -1 后退 / +1 前进
 * @returns {void}
 */
function navigate(delta) {
    const dir = delta < 0 ? "Back" : "Forward";
    // 两步都要成立：canGo*(面板这个方向还有子视图) 且 on*(它真的接住了这一步)。
    // 只认 on* 的话，一个把 onBack 写成恒真的面板会把后退永远关在这个面板里。
    if (paneNav(`canGo${dir}`) && paneNav(`on${dir}`)) {
        // 面板消费了这次导航：历史栈与游标都不动，只把按钮可用态对齐子视图的新状态。
        syncNavButtons();
        return;
    }
    const next = shell.cursor + delta;
    if (next < 0 || next >= shell.history.length) return;
    shell.cursor = next;
    syncNavButtons();
    selectPane(shell.history[next], { record: false });
}

/**
 * 取本次打开要显示的面板与深链参数：深链 > ?pane= > 第一个已实现面板。
 * PENDING_KEY 兼容两种形态：裸面板 id 字符串（debug.js 等既有写入方）与
 * `{pane, app}` 对象（openPane 带参唤起时写入）；`?pane=` 同样支持可选的 `?app=`。
 * @returns {{id:string, params:object}} 面板 id 与交给面板 build() 的参数
 */
function initialPaneId() {
    const pending = globalThis[PENDING_KEY];
    if (pending) {
        delete globalThis[PENDING_KEY];
        const raw = typeof pending === "string" ? { pane: pending } : pending;
        const { pane, ...params } = raw;
        const entry = findPane(pane);
        if (entry && entry.implemented) return { id: entry.id, params };
        log.warn("plugin/system-settings", `深链面板 ${pane} 不可用，退回默认面板`);
    }
    try {
        const query = new URLSearchParams(location.search);
        const entry = findPane(query.get("pane"));
        if (entry && entry.implemented) {
            // 除 pane 以外的查询键全部作为深链参数交给面板（?pane=plugins&app=calculator → {app:"calculator"}）；
            // 参数名由面板自取，外壳不认任何具体键名，将来加参数不必改这里。
            const params = {};
            query.forEach((value, key) => { if (key !== "pane") params[key] = value; });
            return { id: entry.id, params };
        }
    } catch (err) {
        log.debug("plugin/system-settings", "?pane= 解析失败，忽略", err);
    }
    const groups = sidebarGroups();
    const first = groups[0] && groups[0].panes[0];
    return { id: first ? first.id : "", params: {} };
}

/** 释放一切：面板订阅、外壳监听、历史与运行态。关窗与重新打开前都走这里。 */
function shutdown() {
    shell.ticket += 1;
    releasePane();
    detachGlobals();
    shell.rows.clear();
    shell.groups = [];
    shell.history = [];
    shell.cursor = -1;
    shell.paneId = "";
    shell.root = null;
    shell.list = null;
    shell.empty = null;
    shell.search = null;
    shell.clear = null;
    shell.title = null;
    shell.back = null;
    shell.forward = null;
    shell.host = null;
}

/**
 * 打开窗口时装配外壳（由 script.js 每次调用）。
 * 先 shutdown() 再装配，保证「入口脚本每次重跑」不会把上一份外壳的监听留下。
 * @returns {void}
 */
export function boot() {
    shutdown();

    const root = document.getElementById("系统设置") || document.querySelector(".settings.window");
    if (!root || !root.isConnected) {
        log.error("plugin/system-settings", "找不到 .settings.window 根元素，系统设置无法装配");
        return;
    }
    shell.root = root;
    shell.list = root.querySelector(".ss-sidebar__list");
    shell.empty = root.querySelector(".ss-sidebar__empty");
    shell.search = root.querySelector(".ss-search");
    shell.clear = root.querySelector(".ss-search__clear");
    shell.title = root.querySelector(".ss-toolbar__title");
    shell.back = root.querySelector(".ss-nav__btn--back");
    shell.forward = root.querySelector(".ss-nav__btn--forward");
    shell.host = root.querySelector(".ss-panes");

    if (!shell.list || !shell.host || !shell.search) {
        log.error("plugin/system-settings", "index.html 外壳缺少侧栏或面板容器，装配中止");
        return;
    }

    registerMessages(SHELL_MESSAGES);
    wireShell();
    renderSidebar();
    applyFilter("");
    syncNavButtons();
    attachGlobals();

    const first = initialPaneId();
    if (!first.id) {
        showError(t("ss.shell.loadFailed", "面板加载失败"),
            t("ss.shell.notImplementedHint", "注册表里这个面板还没有实现，界面不再为它留占位页。"));
        return;
    }
    selectPane(first.id, { params: first.params });
    log.debug("plugin/system-settings", `外壳已装配，默认面板 ${first.id}`);
}

export { openPane, selectPane, shutdown };
