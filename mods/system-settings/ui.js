/**
 * ui.js — 系统设置的控件层（设置接口 <-> 界面 的唯一绑定通道）
 *
 * 三条硬性约定，全部为了「一切设置更改都走接口」：
 * 1. 控件**只读** `settings.get()`、只写 `settings.set()`，本文件里不出现任何
 *    `localStorage` 字面量，也不再复制键名 —— 键的权威在 settings-definitions.js。
 * 2. 每个控件都订阅 `settings-changed`，所以「控制中心拨了亮度」「另一个面板改了
 *    同一项」「插件自己 set 了」都会即时回灌到界面，不需要重开面板。
 * 3. 所有订阅与 document 级监听都登记在 dispose 列表里，切换面板 / 关闭窗口时统一
 *    释放。旧版每个下拉框挂一个 document 监听且从不摘除，开 N 次窗口就累积 N 份
 *    （且它们还拖着已卸载的 DOM），这里一次性收口。
 *
 * 界面文案一律 `t(key, 中文fallback)`，插件自带语言包由 app.js 注册进 i18n。
 */

import { settings } from "../../src/javascripts/settings.js";
import { i18n } from "../../src/javascripts/i18n.js";
import { log } from "../../src/javascripts/log.js";
import { openPopover, closeAllPopovers } from "../../src/javascripts/ui/popover.js";

/** 释放句柄列表：每项是一个无参清理函数。 */
let disposers = [];

/**
 * 登记一个清理函数，`disposeAll()` 时统一执行。
 * @param {Function} fn 清理函数
 * @returns {Function} 原样返回，便于链式使用
 */
export function track(fn) {
    disposers.push(fn);
    return fn;
}

/** 释放当前面板登记的全部订阅与监听（切换面板、关闭窗口时调用）。 */
export function disposeAll() {
    disposers.forEach((fn) => {
        try { fn(); } catch (err) { log.warn("system-settings", "清理句柄失败", err); }
    });
    disposers = [];
    closeAllPopovers();
}

/** 取译文：优先插件自带语言包，缺失时用调用方给的中文回退。 */
export function t(key, fallback = "") {
    return i18n.t(key, fallback);
}

/**
 * 建元素的小工具，避免每处写三行 createElement。
 * @param {string} tag 标签名
 * @param {object} [props] {class, id, text, dataset, attrs, style, aria, i18n} —— 文本一律走
 *                         textContent：设置面板不接收 HTML 形态的内容，避免插件文案被当标签解析
 * @param {Array<Node|string>} [children] 子节点
 * @returns {HTMLElement} 元素
 */
export function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    if (props.class) node.className = props.class;
    if (props.id) node.id = props.id;
    if (props.text !== undefined) node.textContent = props.text;
    if (props.style) node.style.cssText = props.style;
    if (props.dataset) Object.entries(props.dataset).forEach(([k, v]) => { node.dataset[k] = v; });
    if (props.attrs) Object.entries(props.attrs).forEach(([k, v]) => {
        if (v === false || v === null || v === undefined) return;
        node.setAttribute(k, v === true ? "" : String(v));
    });
    if (props.i18n) node.setAttribute("data-i18n", props.i18n);
    if (props.aria) Object.entries(props.aria).forEach(([k, v]) => node.setAttribute(`aria-${k}`, String(v)));
    (children || []).flat(3).forEach((child) => {
        if (child === null || child === undefined || child === false) return;
        node.append(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
}

/**
 * 把控件接到设置键上：读初值 -> 订阅变更 -> 提供写回。
 * @param {string} key 设置键
 * @param {Function} paint paint(value) 负责把值反映到界面
 * @returns {{read:Function, write:Function, off:Function, key:string}} 绑定句柄
 */
export function bind(key, paint) {
    const write = (value) => {
        const result = settings.set(key, value, { source: "system-settings" });
        if (!result.ok) {
            log.warn("system-settings", `${key} 写入被拒绝：${result.reason}`);
            paint(settings.get(key));
            return result;
        }
        if (!result.persisted) {
            log.warn("system-settings", `${key} 本次未能保存（本地存储空间不足），刷新后会回退`);
        }
        paint(result.value);
        return result;
    };
    paint(settings.get(key));
    const off = settings.subscribe((detail) => { if (detail.key === key) paint(detail.value); });
    track(off);
    return { read: () => settings.get(key), write, off, key };
}

/** 说明性段落（灰字）。仅留给真正的空态与风险/条件提示，不要拿它写「为什么这样设计」。 */
export function note(textKey, fallback) {
    return el("p", { class: "ss-note", text: t(textKey, fallback) });
}

/** 分节的唯一构造：标题（已译好的文本）+ 内容。group(rows,{title}) 与 section(key,兜底,box) 都走它。 */
function sectioned(titleText, box) {
    return el("section", { class: "ss-section" }, el("h4", { class: "ss-section__title", text: titleText }), box);
}

/**
 * 分节：一行小标题 + 一块内容（通常是 group() 出来的卡片）。
 * 每页的骨架就这一种，面板不要再自己拼 .ss-section / .ss-section__title。
 * 标题在装配时就已定、内容要晚点才填进去的场合用它；能一次成型就用 group(rows, { title })。
 * @param {string} textKey 标题译文键
 * @param {string} fallback 中文兜底
 * @param {HTMLElement} box 被标题领着的容器
 * @returns {HTMLElement} section 元素
 */
export function section(textKey, fallback, box) {
    return sectioned(t(textKey, fallback), box);
}

/**
 * 依据定义里的 `requires` 把本行依附到另一个设置项上。
 *
 * 为什么由组件层统一做而不是各面板自己写：着色浓度 / 色调偏移这类子参数，在主开关
 * （允许墙纸着色）关掉时**完全不生效**。界面不禁用的话，用户拨了半天没反应，
 * 就是一个新的假设置。依赖变化同样要登记释放，否则切面板后会留下悬空订阅。
 * @param {HTMLElement} root 行元素
 * @param {string} key 本行的设置键
 * @returns {void}
 */
function wireRequires(root, key) {
    const def = settings.info(key);
    const dep = def && def.requires;
    if (!dep) return;
    const apply = () => {
        const enabled = Boolean(settings.get(dep));
        root.classList.toggle("ss-row--disabled", !enabled);
        root.querySelectorAll("input, button, select, textarea").forEach((el) => { el.disabled = !enabled; });
    };
    apply();
    track(settings.on(dep, apply));
}

/**
 * 一行「左文案 / 右控件」的通用行。
 * @param {object} spec {label, hint, control, stack, id, key} —— 传 `key` 时按定义里的
 *                      `requires` 自动做依附禁用（见 wireRequires）
 * @returns {HTMLElement} 行元素
 */
export function row(spec) {
    const main = el("div", { class: "ss-row__main" });
    if (spec.label) main.append(el("p", { class: "ss-row__label", text: spec.label }));
    if (spec.hint) main.append(el("p", { class: "ss-row__hint", text: spec.hint }));
    const parts = [main];
    if (!spec.stack && spec.control) parts.push(el("div", { class: "ss-row__control" }, spec.control));
    if (spec.stack && spec.control) parts.push(el("div", { class: "ss-row__stack" }, spec.control));
    const root = el("div", { class: `ss-row${spec.stack ? " ss-row--stack" : ""}`, id: spec.id }, ...parts);
    if (spec.key) wireRequires(root, spec.key);
    return root;
}

/**
 * 圆角卡片分组：若干行共用一个背景，与 macOS 偏好设置一致。
 * @param {Array<HTMLElement>} rows 行元素
 * @param {object} [opts] {title, tone} tone: "plain" 时不加内边距（用于列表）
 * @returns {HTMLElement} 分组元素
 */
export function group(rows = [], opts = {}) {
    const box = el("div", { class: `ss-group${opts.tone ? ` ss-group--${opts.tone}` : ""}` }, ...rows);
    // 有标题就套一层 .ss-section —— 与 section() 共用同一个构造，全站只有一种分节形状。
    return opts.title ? sectioned(opts.title, box) : box;
}

/** 数值显示格式化：percent 按 0-1 显示整数百分比，其余保留原值加单位。 */
function formatValue(value, spec) {
    if (spec.format === "percent") return `${Math.round(Number(value) * 100)}%`;
    // 毫秒值存的是 ms，但界面上写「5.5 秒」——原版从不让用户读 5500 这种数。
    if (spec.format === "ms") {
        const seconds = Number(value) / 1000;
        return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`;
    }
    if (spec.format === "fixed1") return Number(value).toFixed(1);
    return `${value}${spec.units ? ` ${spec.units}` : ""}`;
}

/**
 * 开关行（复用全站 `<swift-switch>` 外观，值以设置接口为唯一权威）。
 * @param {string} key 设置键
 * @param {object} spec {label, hint, disabled}
 * @returns {HTMLElement} 行元素
 */
export function controlSwitch(key, spec = {}) {
    const sw = el("button", {
        class: "ss-switch",
        aria: { role: "switch", label: spec.label || key },
        attrs: { type: "button" },
    });
    sw.append(el("span", { class: "ss-switch__knob" }));
    const link = bind(key, (value) => {
        sw.dataset.on = value ? "true" : "false";
        sw.setAttribute("aria-checked", value ? "true" : "false");
    });
    sw.addEventListener("click", () => { if (!sw.disabled) link.write(!link.read()); });
    if (spec.disabled) sw.disabled = true;
    return row({ label: spec.label, hint: spec.hint, control: sw, id: spec.id, key });
}

/**
 * 滑块行：拖动即时生效，松手才落盘（沿用控制中心的高频写入节流做法）。
 * @param {string} key 设置键
 * @param {object} spec {label, hint, min, max, step, units, format, live}
 * @returns {HTMLElement} 行元素
 */
export function controlSlider(key, spec = {}) {
    const def = settings.info(key) || {};
    const min = spec.min ?? def.min ?? 0;
    const max = spec.max ?? def.max ?? 100;
    const step = spec.step ?? def.step ?? 1;
    // format / units 也优先取定义：min/max/step 已经按定义走，显示口径却只认调用方传参，
    // 同一个键在两个面板就会一个显示「85%」一个显示「0.85」。
    const display = { format: def.format, units: def.units, ...spec };
    const valueLabel = el("span", { class: "ss-slider__value" });
    const input = el("input", {
        class: "ss-slider",
        attrs: { type: "range", min: String(min), max: String(max), step: String(step), "aria-label": display.label || key },
    });
    const link = bind(key, (value) => {
        input.value = String(value);
        valueLabel.textContent = formatValue(value, display);
    });
    input.addEventListener("input", () => {
        valueLabel.textContent = formatValue(Number(input.value), display);
        if (display.live === false) return;
        link.write(Number(input.value));
    });
    input.addEventListener("change", () => link.write(Number(input.value)));
    const control = el("div", { class: "ss-slider__wrap" }, input, valueLabel);
    return row({ label: display.label, hint: display.hint, control, stack: true, id: display.id, key });
}

// ---- 浮层菜单 ----

/**
 * 收起全部下拉浮层（选中一项、切换面板时调用）。
 * 「点浮层之外 / 按 Esc / 触发元素消失」这些关闭时机由 src/javascripts/ui/popover.js
 * 统一负责：本模块不再自己挂 document 监听，也不再维护 openMenus —— 旧版每个下拉
 * 各挂一个 document 捕获监听且从不摘除，而且菜单被窗口裁住、根本伸不出去。
 */
function hideAllMenus() {
    closeAllPopovers();
}

/**
 * 给「按钮 + 菜单」这对控件接上浮出层。
 * controlDropdown 与「默认应用」面板自绘的选应用下拉共用它，避免出现第二套
 * 开合逻辑（那两个下拉的类名本来就沿用同一套）。
 * @param {HTMLElement} button 触发按钮
 * @param {HTMLElement} list 菜单节点：打开时被搬进浮出层，关闭后送回原父级
 * @param {object} [opts] {align, gap, matchWidth}
 * @returns {{close:Function, isOpen:Function}} 句柄
 */
export function wireDropdown(button, list, opts = {}) {
    let handle = null;
    const setExpanded = (on) => {
        button.setAttribute("aria-expanded", on ? "true" : "false");
        if (!on) handle = null;
    };
    button.addEventListener("click", (e) => {
        e.stopPropagation();
        if (handle && handle.isOpen()) return handle.close();
        hideAllMenus();
        handle = openPopover({
            anchor: button,
            content: list,
            align: opts.align || "end",
            gap: Number.isFinite(opts.gap) ? opts.gap : 4,
            matchWidth: opts.matchWidth !== false,
            onDismiss: () => setExpanded(false),
        });
        setExpanded(true);
    });
    return { close: () => { if (handle) handle.close(); }, isOpen: () => Boolean(handle && handle.isOpen()) };
}

/**
 * 下拉选择行：触发按钮 + 浮层列表，选项由 `values` 或 `options` 给出。
 * @param {string} key 设置键
 * @param {object} spec {label, hint, options:[{value,label}], colorPreview}
 * @returns {HTMLElement} 行元素
 */
export function controlDropdown(key, spec = {}) {
    const options = normalizeOptions(spec, key);
    const current = el("span", { class: "ss-dropdown__value" });
    const swatch = el("i", { class: "ss-dropdown__swatch", attrs: { hidden: "" } });
    const button = el("button", {
        class: "ss-dropdown", attrs: { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" },
    }, swatch, current, el("i", { class: "ss-dropdown__chev" }));
    const list = el("div", { class: "ss-menu", attrs: { role: "listbox", hidden: "" } });
    const wrap = el("div", { class: "ss-dropdown__wrap" }, button, list);

    options.forEach((opt) => {
        const item = el("button", {
            class: "ss-menu__item", attrs: { type: "button", role: "option" }, dataset: { value: String(opt.value) },
        }, opt.color ? el("i", { class: "ss-swatch__dot", style: `background:${opt.color}` }) : null, el("span", { text: opt.label }));
        item.addEventListener("click", () => {
            link.write(opt.value);
            hideAllMenus();
        });
        list.append(item);
    });
    const link = bind(key, (value) => {
        const hit = options.find((o) => String(o.value) === String(value)) || options[0];
        current.textContent = hit ? hit.label : String(value);
        list.querySelectorAll(".ss-menu__item").forEach((item) => {
            item.classList.toggle("ss-menu__item--active", item.dataset.value === String(value));
            item.setAttribute("aria-selected", item.dataset.value === String(value) ? "true" : "false");
        });
        if (hit && hit.color) {
            swatch.hidden = false;
            swatch.style.background = hit.color;
        } else {
            swatch.hidden = true;
        }
    });
    wireDropdown(button, list);
    return row({ label: spec.label, hint: spec.hint, control: wrap, id: spec.id, key });
}

/**
 * 分段控件行（少量互斥取值，全部可见）。
 * @param {string} key 设置键
 * @param {object} spec {label, hint, options}
 * @returns {HTMLElement} 行元素
 */
export function controlSegmented(key, spec = {}) {
    const options = normalizeOptions(spec, key);
    const seg = el("div", { class: "ss-segmented", attrs: { role: "radiogroup", "aria-label": spec.label || key } });
    const buttons = options.map((opt) => {
        const btn = el("button", { class: "ss-segmented__item", attrs: { type: "button", role: "radio" }, text: opt.label });
        btn.addEventListener("click", () => link.write(opt.value));
        seg.append(btn);
        return { btn, value: opt.value };
    });
    const link = bind(key, (value) => buttons.forEach((b) => {
        const on = String(b.value) === String(value);
        b.btn.classList.toggle("ss-segmented__item--on", on);
        b.btn.setAttribute("aria-checked", on ? "true" : "false");
    }));
    return row({ label: spec.label, hint: spec.hint, control: seg, stack: spec.stack !== false, id: spec.id, key });
}

/**
 * 单选按钮行（macOS 偏好设置里的纵向单选组）。
 * @param {string} key 设置键
 * @param {object} spec {label, hint, options, columns}
 * @returns {HTMLElement} 行元素
 */
export function controlRadio(key, spec = {}) {
    const options = normalizeOptions(spec, key);
    const box = el("div", {
        class: `ss-radio${spec.columns ? ` ss-radio--${spec.columns}` : ""}`,
        attrs: { role: "radiogroup", "aria-label": spec.label || key },
    });
    const items = options.map((opt) => {
        const dot = el("i", { class: "ss-radio__dot" });
        const label = el("span", { class: "ss-radio__text", text: opt.label });
        const item = el("button", { class: "ss-radio__item", attrs: { type: "button", role: "radio" } }, dot, label);
        item.addEventListener("click", () => link.write(opt.value));
        box.append(item);
        return { item, value: opt.value };
    });
    const link = bind(key, (value) => items.forEach((it) => {
        const on = String(it.value) === String(value);
        it.item.classList.toggle("ss-radio__item--on", on);
        it.item.setAttribute("aria-checked", on ? "true" : "false");
    }));
    return row({ label: spec.label, hint: spec.hint, control: box, stack: true, id: spec.id, key });
}

/**
 * 图形卡片选择行（外观 浅色/深色/自动、废纸篓图标这类带缩略图的选项）。
 * @param {string} key 设置键
 * @param {object} spec {label, hint, options:[{value,label,image,caption}]}
 * @returns {HTMLElement} 行元素
 */
export function controlCards(key, spec = {}) {
    const options = spec.options || [];
    const grid = el("div", { class: "ss-cards", attrs: { role: "radiogroup", "aria-label": spec.label || key } });
    const cards = options.map((opt) => {
        const img = el("img", { attrs: { src: opt.image, alt: opt.label || "" }, class: "ss-cards__img" });
        img.addEventListener("error", () => { img.classList.add("ss-cards__img--missing"); });
        const card = el("button", { class: "ss-cards__item", attrs: { type: "button", role: "radio" } },
            img, el("span", { class: "ss-cards__label", text: opt.label }));
        card.addEventListener("click", () => link.write(opt.value));
        grid.append(card);
        return { card, value: opt.value };
    });
    const link = bind(key, (value) => cards.forEach((c) => {
        const on = String(c.value) === String(value);
        c.card.classList.toggle("ss-cards__item--on", on);
        c.card.setAttribute("aria-checked", on ? "true" : "false");
    }));
    // 原版把预览卡放在**标签同一行的右侧**（Appearance 一行里三个缩略图），不是标题在上、
    // 卡片铺满下一行；需要竖排的场景显式传 stack:true。
    return row({ label: spec.label, hint: spec.hint, control: grid, stack: spec.stack === true, id: spec.id, key });
}

/**
 * 色点选择行（强调色一类的小圆点组）。
 * @param {string} key 设置键
 * @param {object} spec {label, hint, colors:[{value,color,name}], multicolor:boolean}
 * @returns {HTMLElement} 行元素
 */
export function controlSwatches(key, spec = {}) {
    const dots = el("div", { class: "ss-swatches", attrs: { role: "radiogroup", "aria-label": spec.label || key } });
    const name = el("p", { class: "ss-swatches__name" });
    const items = (spec.colors || []).map((entry) => {
        const style = entry.multicolor
            ? "background:conic-gradient(#ff3b30,#ff9500,#ffcc00,#34c759,#0a84ff,#af52de,#ff375f,#ff3b30)"
            : `background:${entry.color}`;
        const dot = el("button", {
            class: "ss-swatches__dot", attrs: { type: "button", role: "radio", title: entry.name || entry.value, "aria-label": entry.name || entry.value },
            style,
        });
        dot.addEventListener("click", () => link.write(entry.value));
        dots.append(dot);
        return { dot, value: entry.value, name: entry.name || entry.value };
    });
    const link = bind(key, (value) => items.forEach((it) => {
        const on = String(it.value) === String(value);
        it.dot.classList.toggle("ss-swatches__dot--on", on);
        it.dot.setAttribute("aria-checked", on ? "true" : "false");
        // 当前值名写在色点下方（原版如此）；一个值都没有时不留空行
        if (on) name.textContent = it.name;
    }));
    if (!name.textContent && items.length) name.textContent = items[0].name;
    return row({
        label: spec.label, hint: spec.hint, stack: spec.stack !== false, id: spec.id, key,
        control: items.length ? el("div", { class: "ss-swatches__col" }, dots, name) : dots,
    });
}

/**
 * 文本输入 + 动作按钮行（如自定义壁纸地址）。
 * @param {object} spec {label, hint, placeholder, buttonText, defaultValue, onSubmit(value)}
 * @returns {HTMLElement} 行元素，附 `input` 句柄
 */
export function controlText(spec) {
    const input = el("input", { class: "ss-input", attrs: { type: "text", placeholder: spec.placeholder || "", "aria-label": spec.label || "输入" } });
    const button = el("button", { class: "ss-btn", attrs: { type: "button" }, text: spec.buttonText || "应用" });
    const run = () => Promise.resolve(spec.onSubmit(input.value.trim(), input)).catch((err) => {
        log.error("system-settings", `${spec.label || "输入项"} 执行失败`, err);
        throw err;
    });
    button.addEventListener("click", run);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
    if (spec.defaultValue) input.value = spec.defaultValue;
    const line = el("div", { class: "ss-input__wrap" }, input, button);
    const root = row({ label: spec.label, hint: spec.hint, control: line, stack: true, id: spec.id });
    root.input = input;
    root.button = button;
    return root;
}

/**
 * 动作按钮行（恢复默认、授权文件夹、导出日志等无固定值的操作）。
 * @param {object} spec {label, hint, buttonText, onAction, tone:"danger"|"accent"}
 * @returns {HTMLElement} 行元素
 */
export function actionRow(spec) {
    const button = el("button", { class: `ss-btn${spec.tone ? ` ss-btn--${spec.tone}` : ""}`, attrs: { type: "button" }, text: spec.buttonText });
    let busy = false;
    button.addEventListener("click", async () => {
        if (busy) return;
        busy = true;
        const original = button.textContent;
        button.disabled = true;
        button.textContent = spec.busyText || "处理中…";
        try {
            await spec.onAction(button);
        } catch (err) {
            log.error("system-settings", `${spec.buttonText} 执行失败`, err);
        } finally {
            busy = false;
            button.disabled = false;
            button.textContent = original;
        }
    });
    return row({ label: spec.label, hint: spec.hint, control: button, id: spec.id });
}

/**
 * 只读信息行（诊断、版本号、占用大小）。
 * @param {object} spec {label, value, hint, copyable}
 * @returns {HTMLElement} 行元素，附 `setValue(v)` 句柄可实时刷新
 */
export function statusRow(spec) {
    const value = el("span", { class: "ss-status__value", text: spec.value ?? "—" });
    const root = row({ label: spec.label, hint: spec.hint, control: value, id: spec.id });
    root.setValue = (text) => { value.textContent = text == null ? "—" : String(text); };
    return root;
}

/**
 * 表格区（快捷键总表、权限列表、日志列表都走它）。
 * @param {object} spec {columns:[{key,label,width}], rows:[obj], class, rowClass}
 * @returns {HTMLElement} 表格元素，附 `setRows(rows)` 可整体替换
 */
export function table(spec) {
    const thead = el("tr", { class: "ss-table__head" }, ...(spec.columns || []).map((c) => el("th", { text: c.label, style: c.width ? `width:${c.width}` : "" })));
    const body = el("tbody");
    const root = el("table", { class: `ss-table ${spec.class || ""}` }, el("thead", {}, thead), body);
    const render = (rows = []) => {
        body.textContent = "";
        rows.forEach((data) => {
            const tr = el("tr", { class: spec.rowClass ? spec.rowClass(data) : "" });
            (spec.columns || []).forEach((c) => {
                const cell = el("td");
                const value = typeof c.render === "function" ? c.render(data) : data[c.key];
                if (value instanceof Node) cell.append(value);
                else cell.textContent = value == null ? "" : String(value);
                tr.append(cell);
            });
            if (spec.onRowClick) tr.addEventListener("click", () => spec.onRowClick(data));
            body.append(tr);
        });
        if (!rows.length && spec.empty) body.append(el("tr", { class: "ss-table__empty" }, el("td", { attrs: { colspan: String((spec.columns || []).length || 1) }, text: spec.empty })));
    };
    render(spec.rows);
    root.setRows = render;
    return root;
}

/**
 * 注入面板自带样式（同 cursor.js 的 `<style id="cursor-custom">` 写法，
 * 扩展页 CSP 只禁脚本不禁样式节点）。
 *
 * 为什么不让各面板去改 style.css：插件目录里 style.css 只有一份，多个面板同时改它
 * 必然互相覆盖；面板私有样式跟着面板模块走，才谈得上「源码全部自包含在插件目录」。
 * 同一个 paneId 重复调用只更新内容，不会叠加多个 style 节点。
 * @param {string} paneId 面板 id
 * @param {string} css 样式文本
 * @returns {void}
 */
export function usePaneStyle(paneId, css) {
    const id = `ss-style-${paneId}`;
    let node = document.getElementById(id);
    if (!node) {
        node = document.createElement("style");
        node.id = id;
        node.setAttribute("data-ss-pane", paneId);
        document.head.append(node);
    }
    node.textContent = css;
}

/**
 * 完全依据设置定义自动生成的行 —— 「插件」面板与新注册设置靠它零代码获得界面。
 * @param {object} def settings.info(key) 返回的定义（含 control / label / values 等）
 * @param {object} [overrides] 覆盖用参数（如临时改 label）
 * @returns {HTMLElement|null} 行元素；定义标记 hidden 时返回 null
 */
export function autoRow(def, overrides = {}) {
    if (!def || def.hidden) return null;
    const spec = { label: def.label || def.key, hint: def.hint || "", id: `ss-${def.key}`, key: def.key, ...overrides };
    switch (def.control) {
        case "switch": return controlSwitch(def.key, spec);
        case "slider": return controlSlider(def.key, { ...spec, min: def.min, max: def.max, step: def.step, units: def.units, format: def.format });
        case "dropdown": case "radio": case "segmented": {
            const factory = def.control === "dropdown" ? controlDropdown : def.control === "radio" ? controlRadio : controlSegmented;
            return factory(def.key, { ...spec, options: optionsFromDef(def) });
        }
        case "swatches": return controlSwatches(def.key, { ...spec, colors: optionsFromDef(def).map((o) => ({ ...o })) });
        case "cards": return controlCards(def.key, { ...spec, options: optionsFromDef(def) });
        default: return null;
    }
}

/** 由定义生成选项表：优先 valuesLabel，其次 values，最后 spec.options。 */
function normalizeOptions(spec, key) {
    if (spec.options) return spec.options;
    return optionsFromDef(settings.info(key) || {});
}

function optionsFromDef(def) {
    const values = def.values || [];
    const labels = def.valuesLabel || [];
    const names = def.valuesName || {};
    return values.map((value, index) => ({
        value,
        label: labels[index] ?? names[value] ?? String(value),
        color: def.valueColors ? def.valueColors[value] : undefined,
        image: def.valueImages ? def.valueImages[value] : undefined,
    }));
}
