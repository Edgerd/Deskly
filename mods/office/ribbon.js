/**
 * ribbon.js — Office 2016 风格功能区（Ribbon）框架
 *
 * 外壳只负责「画功能区 + 把点击转成命令 + 回灌控件状态」，**不知道任何格式语义**：
 * 每个视图模块自己声明 `ribbon()`（标签页与控件）、`command(id, value)`（执行）、
 * `state()`（当前按下态 / 下拉当前值）。这样文稿 / 表格 / 演示三套命令不会互相污染，
 * 也让新增控件只改一个视图文件。
 *
 * 三条实现约定：
 * 1. 结构只在 tabs 变化时重建，状态变化只改 class/value —— 打字时每敲一键都重建
 *    几十个节点会明显掉帧。
 * 2. 事件全部委托在容器上（一个 click + 一个 change），控件不设独立监听，
 *    重建时无需逐个摘除，`destroy()` 只要拆容器和这两个委托。
 * 3. 图标不用任何图标字体或第三方库：用 `createElementNS` 现画少量几何形状
 *    （对齐、缩进、列表、边框、填充），其余用文本符号。仓内不允许为外观引入新依赖。
 */

import { t } from "./t.js";

const NS = "http://www.w3.org/2000/svg";
/** 文本型符号（B/I/U 这类正是 Office 自己的画法） */
const GLYPH = {
    bold: "B", italic: "I", underline: "U", strike: "S",
    fontColor: "A", fill: "▧", clear: "⌫", undo: "↶", redo: "↷",
    find: "⌕", increase: "→▍", decrease: "←▍", page: "▤", slide: "▥",
};

/** 几何型图标：只画必需几种，键名即 `icon` 取值 */
const SHAPE = {
    alignLeft: [[0, 1, 12], [0, 2.6, 8], [0, 4.2, 12], [0, 5.8, 7]],
    alignCenter: [[2, 1, 12], [0, 2.6, 8], [2, 4.2, 12], [4, 5.8, 7]],
    alignRight: [[4, 1, 12], [0, 2.6, 8], [0, 4.2, 12], [0, 5.8, 7]],
    alignJustify: [[0, 1, 12], [0, 2.6, 12], [0, 4.2, 12], [0, 5.8, 12]],
    listBullet: [[0, 1, 2], [4, 1, 8], [0, 3.2, 2], [4, 3.2, 8], [0, 5.4, 2], [4, 5.4, 8]],
    listNumber: [[0, 1, 2], [4, 1, 8], [0, 3.2, 2], [4, 3.2, 8], [0, 5.4, 2], [4, 5.4, 8]],
    wrap: [[0, 1, 12], [0, 3, 9], [0, 5, 12]],
    border: [[0, 0, 12, 6]],
    row: [[0, 1, 12], [0, 3.4, 12], [0, 5.8, 12], [3, 0, 0.6, 7], [8, 0, 0.6, 7]],
    column: [[1, 0, 10], [3.4, 0, 10], [5.8, 0, 10], [0, 3, 0.6, 12]],
    sortAsc: [[0, 6, 2], [3, 4, 2], [6, 2, 2], [9.5, 0, 0.6, 8]],
    sortDesc: [[0, 2, 2], [3, 4, 2], [6, 6, 2], [9.5, 0, 0.6, 8]],
};

/**
 * 画一个图标节点。
 * @param {string} name GLYPH 或 SHAPE 的键
 * @returns {HTMLElement} 图标容器
 */
function makeIcon(name) {
    const wrap = document.createElement("span");
    wrap.className = "rb-icon";
    if (SHAPE[name]) {
        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("viewBox", "0 0 12 7");
        for (const bar of SHAPE[name]) {
            const rect = document.createElementNS(NS, "rect");
            rect.setAttribute("x", String(bar[0]));
            rect.setAttribute("y", String(bar[1]));
            if (bar.length === 4) {
                rect.setAttribute("width", String(bar[2]));
                rect.setAttribute("height", String(bar[3]));
            } else {
                rect.setAttribute("width", String(bar[2]));
                rect.setAttribute("height", "1.2");
            }
            svg.appendChild(rect);
        }
        wrap.appendChild(svg);
    } else {
        wrap.classList.add("rb-icon-text");
        wrap.textContent = GLYPH[name] || name || "·";
    }
    return wrap;
}

/**
 * 建一个带类名的元素。
 * @param {string} tag 标签
 * @param {string} cls 类名
 * @param {string} [text] 文本
 * @returns {HTMLElement} 元素
 */
function node(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
}

/**
 * 画一个控件。
 * @param {object} item 控件声明
 * @param {object} state 当前状态（id -> 值）
 * @returns {HTMLElement} 控件元素
 */
function buildControl(item, state) {
    if (item.separator) return node("span", "rb-sep");

    const id = item.id;
    const type = item.type || "button";
    const size = item.size || "small";
    const root = node("div", `rb-ctl rb-${size} rb-type-${type}`);
    root.dataset.cmd = id;

    if (type === "menu") {
        const select = document.createElement("select");
        select.className = "rb-select";
        select.dataset.cmd = id;
        for (const opt of item.options || []) {
            const o = document.createElement("option");
            o.value = opt.value === undefined ? opt.label : String(opt.value);
            o.textContent = opt.label;
            select.appendChild(o);
        }
        const cur = state[id];
        if (cur !== undefined && cur !== null) select.value = String(cur);
        if (item.label) root.appendChild(node("span", "rb-select-label", item.label));
        root.appendChild(select);
        return root;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rb-btn";
    btn.dataset.cmd = id;
    if (item.icon) btn.appendChild(makeIcon(item.icon));
    btn.appendChild(node("span", "rb-label", item.label || ""));
    if (item.title) btn.title = item.title;
    if (type === "toggle" && state[id]) btn.classList.add("is-on");
    if (item.disabled || state[`!${id}`]) btn.disabled = true;
    root.appendChild(btn);
    return root;
}

/**
 * 创建功能区实例。
 * @param {HTMLElement} container `[data-role=ribbon]` 容器
 * @param {{onCommand: Function, onTabChange?: Function, getFileTab?: () => {label: string, items: object[]}}} opts
 *        命令回调、标签切换回调，以及「文件」标签的即时取值函数（最近打开会变，必须每次现取而不是建实例时固化）
 * @returns {{render:Function, update:Function, setActiveTab:Function, currentTab:Function, destroy:Function}} 功能区接口
 */
export function createRibbon(container, opts) {
    const { onCommand, onTabChange, getFileTab } = opts || {};
    const fileLabel = () => (getFileTab ? getFileTab().label : t("fileTab", "文件"));
    let tabs = [];
    let activeId = null;
    const strip = node("div", "rb-tabs");
    const body = node("div", "rb-body");
    container.classList.add("office-ribbon");
    container.append(strip, body);

    /** 标签页结构签名：只在结构变化时重建 DOM */
    const structureKey = () => activeId + "|" + tabs.map((t) => `${t.id}:${(t.groups || []).map((g) => (g.items || []).map((i) => `${i.id}=${i.type}=${(i.options || []).length}`).join(",")).join(";")}`).join("#");
    let lastKey = "";

    function render(nextTabs, state = {}) {
        tabs = nextTabs || [];
        // "__file" 不属于视图标签页数组，不能被这段守卫当成失效标签重置掉
        if (activeId !== "__file" && !tabs.some((t) => t.id === activeId)) activeId = tabs[0] ? tabs[0].id : null;
        const key = structureKey();
        // 选中态变化时外壳也会调 render：结构没变就只刷状态，别把几十个节点重建一遍
        if (key === lastKey && activeId !== "__file") {
            drawTabs(state);
            update(state);
            return;
        }
        lastKey = key;
        drawTabs(state);
        drawBody(state);
    }

    function drawTabs(state) {
        strip.textContent = "";
        const file = node("button", "rb-tab rb-tab-file" + (activeId === "__file" ? " is-active" : ""));
        file.type = "button";
        file.dataset.tab = "__file";
        file.textContent = fileLabel();
        strip.appendChild(file);
        for (const t of tabs) {
            const el = node("button", "rb-tab" + (t.id === activeId ? " is-active" : ""));
            el.type = "button";
            el.dataset.tab = t.id;
            el.textContent = t.label;
            strip.appendChild(el);
        }
        void state;
    }

    function drawBody(state) {
        body.textContent = "";
        if (activeId === "__file") {
            const back = node("div", "rb-backstage");
            back.appendChild(node("p", "rb-backstage-title", fileLabel()));
            const list = node("div", "rb-backstage-list");
            const items = (getFileTab ? getFileTab().items : []) || [];
            for (const item of items) {
                const btn = node("button", "rb-backstage-item");
                btn.type = "button";
                btn.dataset.cmd = item.id;
                if (item.value !== undefined) btn.dataset.value = String(item.value);
                btn.appendChild(node("span", "rb-label", item.label));
                if (item.hint) btn.appendChild(node("span", "rb-hint", item.hint));
                list.appendChild(btn);
            }
            back.appendChild(list);
            body.appendChild(back);
            return;
        }
        const tab = tabs.find((t) => t.id === activeId);
        if (!tab) return;
        for (const group of tab.groups || []) {
            const g = node("div", "rb-group");
            const items = node("div", "rb-group-items");
            for (const item of group.items || []) items.appendChild(buildControl(item, state));
            g.appendChild(items);
            g.appendChild(node("span", "rb-group-label", group.label || ""));
            body.appendChild(g);
        }
    }

    /** 只刷新按下态与下拉值，不重建结构 */
    function update(state = {}) {
        for (const btn of body.querySelectorAll(".rb-type-toggle .rb-btn")) {
            const id = btn.dataset.cmd;
            btn.classList.toggle("is-on", !!state[id]);
            if (state[`!${id}`]) btn.disabled = true;
        }
        for (const select of body.querySelectorAll(".rb-select")) {
            const cur = state[select.dataset.cmd];
            if (cur !== undefined && cur !== null && String(cur) !== select.value) select.value = String(cur);
        }
    }

    function handleClick(e) {
        // 下拉的取值走 change，点它不该顺带触发一次命令：控件根也带 data-cmd，必须在这里排除
        if (e.target instanceof HTMLSelectElement || e.target.closest(".rb-select")) return;
        const ctl = e.target.closest("[data-cmd]") || e.target.closest("[data-tab]");
        if (!ctl) return;
        if (ctl.dataset.tab) {
            activeId = ctl.dataset.tab;
            lastKey = "";
            render(tabs, {});
            if (typeof opts.onTabChange === "function") opts.onTabChange(activeId);
            return;
        }
        onCommand(ctl.dataset.cmd, ctl.dataset.value);
    }

    function handleChange(e) {
        const select = e.target.closest(".rb-select");
        if (!select) return;
        const item = flattenControls().find((c) => c.id === select.dataset.cmd);
        onCommand(select.dataset.cmd, item ? resolveOptionValue(item, select.value) : select.value);
    }

    function flattenControls() {
        const out = [];
        for (const t of tabs) for (const g of t.groups || []) out.push(...(g.items || []));
        return out;
    }

    /** 选项可能是 {value,label} 也可能只有 label：label 型控件把 label 当值 */
    function resolveOptionValue(item, raw) {
        const opt = (item.options || []).find((o) => String(o.value === undefined ? o.label : o.value) === raw);
        if (!opt) return raw;
        return opt.value === undefined ? opt.label : opt.value;
    }

    container.addEventListener("click", handleClick);
    container.addEventListener("change", handleChange);

    return {
        render,
        update,
        setActiveTab(id) { activeId = id; lastKey = ""; render(tabs, {}); },
        currentTab: () => activeId,
        /** 作废结构缓存，强制下一次 render 重画分组/控件标签（语言切换时用，标签变了但 id 结构没变）。 */
        rebuild() { lastKey = ""; },
        destroy() {
            container.removeEventListener("click", handleClick);
            container.removeEventListener("change", handleChange);
            container.textContent = "";
            lastKey = "";
        },
    };
}
