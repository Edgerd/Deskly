/**
 * cursor.js — 鼠标光标自定义（尺寸 / 阴影）
 *
 * 背景：浏览器无法缩放 .cur 光标，且 macOS pointers 包的 .cur 在 Chrome 下
 * 按 128px 原生尺寸渲染，过大。本模块改用「运行时生成的 SVG data-URI」承载
 * 默认光标（default），按用户设定尺寸缩放，热点按比例换算；
 * 阴影通过 SVG 内 feDropShadow 实现，可单独开关。beachball 保留原生 .ani
 * （保留 Windows 下旋转动画），不受尺寸控制。
 *
 * 说明：默认光标以 CSS 自定义属性 `--deskly-cursor` 暴露给全站，作者样式里的
 * `cursor: default` 与原生表单控件的 UA 光标都改引用它，从而在悬浮各类控件时
 * 仍显示自定义 macOS 箭头，而不是回落到宿主机默认光标。曾同时生成 pointer /
 * copy 两种光标并注入 `body * { cursor: … !important }`；全仓确认没有任何代码给
 * body 挂 cursor-pointer / cursor-copy 类，且 `body *` 强覆盖会压掉 Dock grab、
 * 菜单 pointer、输入框 text 等元素级光标。现已删除那套死分支，改用变量方案。
 *
 * 但「让作者写 var()」只能约束本仓库改得到的样式：ZIP 第三方插件的 CSS 一定写
 * `cursor: pointer` / `cursor: default`，类选择器还比下面注入的标签选择器更具体，
 * 指针落上去就回落成系统手型/箭头。所以本模块还有一层**样式补丁**（见下方
 * 「样式补丁」段）：在样式表、内联 style、shadow DOM 三个入口把这类关键字就地
 * 改写成引用上述变量的声明，插件无需配合，指针路径上也没有任何 JS。
 *
 * 由 bootstrap.js 在启动时调用 initCursor() 应用已保存设置；
 * 系统设置「鼠标」页拖动滑块 / 切换开关时调用 setCursorSize / setCursorShadow
 * 实时生效，并广播 cursor-change 事件。
 */

// 源图：macos_pointers 包的 128x128 PNG 导出，热点比例（x,y 占图宽高比）。
// default=箭头、pointer=手指（“手指那个”）、copy=拷贝。三张都用 SVG data-URI
// 承载，按用户设定尺寸等比缩放 + 阴影；beachball（等待）用原生 .ani 保留旋转。
const SRC = {
    default: { url: new URL("../../assets/cursors/src_default.png", import.meta.url), hx: 0.375, hy: 0.273 },
    pointer: { url: new URL("../../assets/cursors/src_pointer.png", import.meta.url), hx: 0.30, hy: 0.20 },
    copy: { url: new URL("../../assets/cursors/src_copy.png", import.meta.url), hx: 0.30, hy: 0.20 },
};

const LS = { size: "cursor-size", shadow: "cursor-shadow" };
const DEFAULT_SIZE = 28;
const MIN = 16;
const MAX = 64;

const _assetCache = {};   // name -> dataURL
const _lastURI = {};      // name -> 最近一次生成的 cursor url() 值（供预览）
let _styleEl = null;

// 自定义光标：设置里上传/选择后写入 localStorage（键 cursor.custom.<role>），
// 值为 {format:'png'|'cur'|'ani', dataUrl, hotX, hotY}；hotX/hotY 为 0..1 比例，随尺寸缩放。
// png 走与内置一致的 SVG 等比缩放+阴影；cur/ani 无法再缩放，直接 url() 引用。
const CUSTOM_PREFIX = "cursor.custom.";
function getCustomCursor(role) {
    try {
        const raw = localStorage.getItem(CUSTOM_PREFIX + role);
        if (!raw) return null;
        const o = JSON.parse(raw);
        return o && o.dataUrl && o.format ? o : null;
    } catch { return null; }
}

/**
 * 安全写入 localStorage：配额超限 / 存储被禁用时只记 warn，不让异常冒泡回
 * 设置面板的点击处理器（同 appearance.js / contextMenuSettings.js 的处理）。
 * 光标这两项是几字节的开关值，真写不进时设置在本次会话内照样生效，只是刷新后回退。
 * 日志优先走 window.__log（可按 kernel/cursor 检索），日志模块未就绪时退回 console
 * —— 站内 console.* 已被 log.js 接管，两条路最终都会进同一份运行记录。
 * @param {string} key 存储键
 * @param {string} value 存储值
 * @returns {boolean} 是否写入成功
 */
function safeSetItem(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (err) {
        if (window.__log) window.__log.warn("kernel/cursor", `写入 localStorage 失败（${key}）：`, err);
        else console.warn(`[cursor] 写入 localStorage 失败（${key}）：`, err);
        return false;
    }
}

function clampSize(n) {
    n = parseInt(n, 10);
    if (isNaN(n)) return DEFAULT_SIZE;
    return Math.max(MIN, Math.min(MAX, n));
}

/** 当前光标尺寸（像素），存储缺失或非法时取默认 28 并钳进 16..64。 */
export function getCursorSize() {
    return clampSize(localStorage.getItem(LS.size));
}

/** 光标阴影是否开启：默认开启，只有显式写入 "off" 才关闭。 */
export function getCursorShadow() {
    return localStorage.getItem(LS.shadow) !== "off";
}

/** 最近一次生成的 cursor CSS 值（供设置界面做悬浮预览），未生成时为空串。 */
export function getCursorURI(name) {
    return _lastURI[name] || "";
}

async function loadAsset(name) {
    if (_assetCache[name]) return _assetCache[name];
    const res = await fetch(SRC[name].url);
    const blob = await res.blob();
    const dataUrl = await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.readAsDataURL(blob);
    });
    _assetCache[name] = dataUrl;
    return dataUrl;
}

/**
 * 生成单个光标的 CSS cursor 值（含 SVG data-URI 与缩放后的热点坐标）。
 * 值末尾一定带语义关键字：CSS 的 cursor 图像列表必须以兜底关键字收尾
 * （`url(…) 8 6` 这种缺关键字的串会被 Chrome 直接判为非法声明而丢弃），
 * 而这串还要被内联样式与设置面板预览直接使用，所以在这里补全，不留给调用方拼。
 * @returns {{value:string, hx:number, hy:number}}
 */
function buildCursor(name, size, shadow) {
    const custom = getCustomCursor(name);
    const keyword = SRC[name] ? name : "default";
    // .cur / .ani：浏览器无法对 .cur 再缩放，直接 url() 引用，按其原生尺寸与内嵌热点渲染。
    if (custom && (custom.format === "cur" || custom.format === "ani")) {
        return { value: `url("${custom.dataUrl}"), ${keyword}`, hx: 0, hy: 0 };
    }
    // 内置 PNG 或自定义 PNG：统一走 SVG 等比缩放 + 阴影，热点比例随尺寸换算。
    const href = custom ? custom.dataUrl : _assetCache[name];
    const hxr = custom ? custom.hotX : (SRC[name] ? SRC[name].hx : 0.375);
    const hyr = custom ? custom.hotY : (SRC[name] ? SRC[name].hy : 0.273);
    const hx = Math.round(hxr * size);
    const hy = Math.round(hyr * size);

    // 阴影偏移 / 模糊以像素为单位，换算到 128 视图坐标（随尺寸等比缩放）。
    const offPx = shadow ? 2.5 : 0;
    const blurPx = shadow ? 2 : 0;
    const offV = (offPx * 128 / size).toFixed(2);
    const blurV = (blurPx * 128 / size).toFixed(2);

    const defs = shadow
        ? `<defs><filter id='sh' x='-50%' y='-50%' width='200%' height='200%'>` +
          `<feDropShadow dx='0' dy='${offV}' stdDeviation='${blurV}' flood-color='#000' flood-opacity='0.45'/></filter></defs>`
        : "";
    const imgAttr = shadow ? ` filter='url(#sh)'` : "";

    const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 128 128'>` +
        defs +
        `<image href='${href}' x='0' y='0' width='128' height='128'${imgAttr}/>` +
        `</svg>`;

    const value = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hx} ${hy}, ${keyword}`;
    return { value, hx, hy };
}

function buildCSS(size, shadow) {
    const d = buildCursor("default", size, shadow);
    const p = buildCursor("pointer", size, shadow);
    const c = buildCursor("copy", size, shadow);
    _lastURI.default = d.value;
    _lastURI.pointer = p.value;
    _lastURI.copy = c.value;

    // 「完美覆盖」的基准层：作者样式全部交给下面的样式补丁改写，这里只补样式补丁
    // 碰不到的那一类——UA（浏览器默认）样式表声明的光标。CSS 读不到也改不了 UA 表，
    // 只能按标签 / role 把最常见的可点击元素接上手指图：
    //   default（箭头）→ html/body，全站继承基准；
    //   pointer（手指）→ a / button / role=button / 勾选框 / 下拉 等 UA 就给手型的元素；
    // 文本 I 束、移动 / 抓取 / 缩放等语义光标保留原形状（没有对应素材，强行换更错）。
    return [
        `:root {`,
        `  --deskly-cursor: ${d.value};`,
        `  --deskly-cursor-pointer: ${p.value};`,
        `  --deskly-cursor-copy: ${c.value};`,
        `}`,
        `html, body, body.cursor-default { cursor: var(--deskly-cursor); }`,
        `a, button, summary, label, select,`,
        `input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"],`,
        `[role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"],`,
        `.clickable, .item, .menu p, .ss-nav__btn, .swift-button { cursor: var(--deskly-cursor-pointer); }`,
        `body.cursor-none { cursor: none !important; }`,
    ].join("\n");
}

function injectStyle(css) {
    if (!_styleEl) {
        _styleEl = document.getElementById("cursor-custom");
        if (!_styleEl) {
            _styleEl = document.createElement("style");
            _styleEl.id = "cursor-custom";
            document.head.appendChild(_styleEl);
        }
    }
    _styleEl.textContent = css;
}

/** 临时放大指针的定时器（同一时刻只允许一次，避免连续晃动把计时器叠起来）。 */
let _pulseTimer = null;

/**
 * 短暂放大指针（macOS「晃动以查找指针」的视觉反馈）。
 *
 * 只改注入样式里的 CSS 变量，不写用户设置：放大结束后立刻按当前设置重建，
 * 因此拖动滑块改过尺寸也不会被覆盖。自定义 .cur / .ani 本身无法缩放，
 * buildCursor 会原样返回，此时该函数等于空操作。
 * @param {number} [ms=1200] 放大的持续时间
 * @returns {void}
 */
export function pulseCursor(ms = 1200) {
    if (_pulseTimer) return;
    const base = getCursorSize();
    const boosted = clampSize(Math.round(base * 1.8));
    if (boosted <= base) return;
    injectStyle(buildCSS(boosted, getCursorShadow()));
    _pulseTimer = setTimeout(() => {
        _pulseTimer = null;
        injectStyle(buildCSS(getCursorSize(), getCursorShadow()));
    }, ms);
}

/**
 * 样式补丁：把「任何来源声明的语义光标关键字」就地改写成引用上面三个变量的声明。
 *
 * 为什么不在指针事件里做：CSS 没法按「计算出来的光标」选中元素，插件样式表里的
 * `cursor: pointer` / `cursor: default`（类选择器，比注入的标签选择器更具体）因此总是赢。
 * 上一版走的是「pointerover 读计算值 → 给命中元素贴内联 !important」，实测每次跨元素
 * 都会先画一帧浏览器已经命中的系统光标——沿 Dock / 工具栏移动就是一闪一闪；贴上去的
 * !important 还会把 `.x:hover { cursor: grab }` 这类 hover 态光标永久压掉。改成改声明
 * 本身：一次改对，浏览器每帧解析出来的就是自定义图，指针路径上没有 JS，不可能闪。
 * 补进去的值引用 CSS 变量，所以用户调大小 / 阴影只换 :root 上那几个变量，
 * 全部已打补丁的规则自动跟随，不需要重扫任何样式表。
 *
 * 三个入口（CSS 能表达的位置全覆盖）：
 * ① 样式表——含 @media / @supports / @layer / @import 嵌套，插件的 <link> 等 load 就绪；
 * ② 元素内联 style——innerHTML 塞进来的走 childList 扫描；MutationObserver 在绘制前
 *    就跑完，所以这条路也不闪（dock.js 的 item.style.cursor = "pointer" 由此接管）；
 * ③ shadow DOM 里的样式表——在 attachShadow 这一步拿到根，闭开的根（closed）也只有
 *    这里进得去，用了自定义元素的第三方插件因此同样覆盖。
 *
 * 不接管：auto（Blink 会把可选中文本上的 auto 解析成 I 束，换成箭头是倒退）、
 * text / move / grab / *resize（没有对应素材，换成箭头比保留浏览器形状更错）、
 * none（应用刻意隐藏指针，应当听它的）、以及任何含 url() 的值（已自带自定义图，
 * 含用户上传的 .cur / .ani）。补丁是幂等的：改完再读回来是 var(...)，不再匹配。
 */
const CURSOR_VAR = {
    default: "var(--deskly-cursor, default)",
    pointer: "var(--deskly-cursor-pointer, pointer)",
    copy: "var(--deskly-cursor-copy, copy)",
    alias: "var(--deskly-cursor-copy, alias)",
};

let _patchOn = false;
const _seenRoots = new WeakSet();
const OBSERVE_OPTS = { subtree: true, childList: true, attributeFilter: ["style"], characterData: true };

/** 改写一条 cursor 声明：只有整条恰好是一个可替换关键字时才动，别的形状一律放行。 */
function patchCursorDecl(style) {
    if (!style) return;
    const mapped = CURSOR_VAR[(style.getPropertyValue("cursor") || "").trim().toLowerCase()];
    if (!mapped) return;
    style.setProperty("cursor", mapped, style.getPropertyPriority("cursor"));
}

function patchRules(rules) {
    if (!rules) return;
    for (const rule of rules) {
        patchCursorDecl(rule.style);
        if (rule.cssRules) patchRules(rule.cssRules);      // @media / @supports / @layer
        if (rule.styleSheet) patchSheet(rule.styleSheet);  // @import 引到的表
    }
}

function patchSheet(sheet) {
    if (!sheet) return;
    try {
        patchRules(sheet.cssRules);
    } catch (err) {
        // 跨源样式表读不到规则（CORS），内核改不了它，也不该改
        if (window.__log) window.__log.warn("kernel/cursor", "样式表打补丁失败（跨源？）", err);
    }
}

/**
 * 内联 style 只走属性视图（`el.style.setProperty`），绝不用 setAttribute 拼文本。
 * 浏览器会把视图改动同步回 style 属性文本，因而多出一次观察记录——但补完的值读回来
 * 是 var(...)，不再匹配关键字表，所以只会多跑一趟就收敛（实测空闲时记录数为 0）。
 * 改成 setAttribute 写法就会变成真正的写回环，别动。
 * @param {Element} el
 */
function patchInlineCursor(el) {
    if (el && el.nodeType === 1 && el.style) patchCursorDecl(el.style);
}

/** <link> 的样式表要等下载完才存在；load 事件仍在首帧绘制之前，不会露出系统光标。 */
function hookSheet(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.sheet) patchSheet(el.sheet);
    else if (el.tagName === "LINK") el.addEventListener("load", () => patchSheet(el.sheet), { once: true });
}

/** 一个根（document 或 shadow root）里的全部样式表。 */
function patchRootSheets(root) {
    if (!root) return;
    if (root.adoptedStyleSheets) for (const sheet of root.adoptedStyleSheets) patchSheet(sheet);
    if (root.querySelectorAll) root.querySelectorAll("style, link[rel=stylesheet]").forEach(hookSheet);
}

/** 新插入的节点：样式表本身、子树里的内联光标与样式表、以及 <style> 的文本节点。 */
function patchAddedNode(node) {
    if (node.nodeType === 3) {
        // `styleEl.textContent = css` 是一次 childList 变更，样式表到这一刻才有规则
        const host = node.parentElement;
        if (host && host.tagName === "STYLE") hookSheet(host);
        return;
    }
    if (node.nodeType !== 1) return;
    patchInlineCursor(node);
    // 插件的 <link> / <style> 就是被插进 head 的那个节点本身，不是它的后代——
    // 只扫后代的话，整张插件样式表都会漏掉（这正是系统手型回来的地方）。
    if (node.tagName === "STYLE" || node.tagName === "LINK") hookSheet(node);
    if (!node.querySelectorAll) return;
    node.querySelectorAll("[style]").forEach(patchInlineCursor);
    node.querySelectorAll("style, link[rel=stylesheet]").forEach(hookSheet);
}

function applyPatches(records) {
    for (const r of records) {
        if (r.type === "attributes") { patchInlineCursor(r.target); continue; }
        if (r.type === "characterData") {
            // 逐字改写 <style> 文本（appendData 之类）的情况，同上补一次
            const parent = r.target.parentElement;
            if (parent && parent.tagName === "STYLE") hookSheet(parent);
            continue;
        }
        r.addedNodes.forEach(patchAddedNode);
    }
}

/** 每个 shadow 根挂一个观察器：根内的注入在 document 观察器的视野之外。 */
function observeShadowRoot(root) {
    if (!root || _seenRoots.has(root)) return;
    _seenRoots.add(root);
    patchRootSheets(root);
    new MutationObserver(applyPatches).observe(root, OBSERVE_OPTS);
}

/** 装一次：先全量扫已有的，之后全靠观察器。 */
function enableCursorPatches() {
    if (_patchOn || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    _patchOn = true;
    patchRootSheets(document);
    document.querySelectorAll("[style]").forEach(patchInlineCursor);
    new MutationObserver(applyPatches).observe(document, OBSERVE_OPTS);
    // 组件的 shadow 根从 attachShadow 这一步接管（trafficLights 之外的插件组件也在此列）
    const native = Element.prototype.attachShadow;
    if (native && !native.__desklyCursorPatch) {
        const hooked = function (init) {
            const root = native.call(this, init);
            // 根里的 <style> 通常紧跟 attachShadow 同步注入，微任务时补一次最省
            queueMicrotask(() => observeShadowRoot(root));
            return root;
        };
        hooked.__desklyCursorPatch = true;
        Element.prototype.attachShadow = hooked;
    }
}

/** 应用当前尺寸 / 阴影设置（实时）。 */
export async function applyCursor() {
    const size = getCursorSize();
    const shadow = getCursorShadow();
    await Promise.all(Object.keys(SRC).map(loadAsset));
    injectStyle(buildCSS(size, shadow));
    // 补丁后的规则引用的是变量：换尺寸只换 :root 上那几个变量，全站随之生效，无需重扫
    window.dispatchEvent(new CustomEvent("cursor-change", { detail: { size, shadow } }));
}

export async function initCursor() {
    // 补丁同步装，且排在等光标资源解码之前：早一帧装上，插件样式就不会有一帧系统光标
    enableCursorPatches();
    await applyCursor();
}

/**
 * 设置光标大小：先钳到 16..64，再落盘并实时重建光标。
 * 写入失败不抛异常（见 safeSetItem），返回值始终是本次真正生效的尺寸。
 * @param {number|string} n 期望尺寸（像素）
 * @returns {Promise<number>} 实际生效的尺寸
 */
export async function setCursorSize(n) {
    const v = clampSize(n);
    safeSetItem(LS.size, String(v));
    await applyCursor();
    return v;
}

/**
 * 设置光标阴影开关。
 * 关闭态的判定与读取侧 `getCursorShadow()` 的「!== 'off' 即开」保持一致：
 * false / "off" / "false" / "0" / 空值都算关，其余（含 "on"、true、1）算开。
 * @param {boolean|string|number} on 是否开启
 * @returns {Promise<boolean>} 实际生效的开关
 */
export async function setCursorShadow(on) {
    const enabled = Boolean(on) && on !== "off" && on !== "false" && on !== "0";
    safeSetItem(LS.shadow, enabled ? "on" : "off");
    await applyCursor();
    return enabled;
}

/** 可供自定义的光标角色 + 中文名（设置面板据此渲染每一项的上传/预览控件）。 */
export function getCursorRoles() {
    return [
        { role: "default", label: "默认箭头" },
        { role: "pointer", label: "可点击 / 手指" },
        { role: "copy", label: "拷贝" },
    ];
}

/** 读取某角色当前自定义光标（无则 null），供设置面板回显。 */
export { getCustomCursor as getCursorImage };

/**
 * 设置某角色的自定义光标图片。
 * @param {string} role default / pointer / copy
 * @param {{format:string, dataUrl:string, hotX?:number, hotY?:number}} img
 *        format：'png'（走 SVG 等比缩放+阴影）或 'cur'/'ani'（浏览器原生渲染，不可缩放）；
 *        dataUrl：文件转成的 data: URL；hotX/hotY：热点比例（0..1，仅 png 生效）。
 * @returns {Promise<boolean>} 是否保存成功（localStorage 配额失败时 false，本次会话仍生效）
 */
export async function setCursorImage(role, img) {
    if (!role || !img || !img.dataUrl || !img.format) return false;
    const entry = {
        format: img.format,
        dataUrl: img.dataUrl,
        hotX: Number(img.hotX) || 0.375,
        hotY: Number(img.hotY) || 0.273,
    };
    const ok = safeSetItem(CUSTOM_PREFIX + role, JSON.stringify(entry));
    await applyCursor(); // 即便落盘失败，本次会话也实时生效
    return ok;
}

/** 清除某角色的自定义光标，恢复内置。 */
export async function clearCursorImage(role) {
    localStorage.removeItem(CUSTOM_PREFIX + role);
    await applyCursor();
}
