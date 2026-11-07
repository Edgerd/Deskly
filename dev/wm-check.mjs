/**
 * dev/wm-check.mjs — 窗口系统重写的 Node 探针（无浏览器，磁盘 + 迷你 DOM 即权威）
 *
 * 覆盖第一阶段交付的硬性验收点：
 *   WAPI-01  configure() 不再把窗拽回中央（_wmPlaced 统一落元素）
 *   WAPI-02  能力位真拦截（maximizable/minimizable:false 时操作直接拒绝）
 *   WAPI-03  window:* 事件序列（open/focus/minimize/restore/zoom/fullscreen/tile/level-change/close）
 *   WAPI-04  母子窗：跟随、级联最小化/恢复/关闭、模态拦截、Dock 过滤标记
 *   WAPI-05  nextWindowId 实例后缀（多窗准入的内核侧）
 *   WAPI-07  data-window 解析器（minWidth:600 / min-width / camelCase 三种写法）
 *   WAPI-09  红绿灯能力位双向（熄了能复亮）
 *   NW-2     dragAxis / dragBounds / fixed（含视口重排豁免）
 *   NW-3     resizeAxis 边带过滤 / aspectRatio
 *   NW-4     层级分带（normal / floating / modal 子窗）
 *   NW-9     onClose 返回 false 中止关闭；抛错视为放行
 *   绿键语义  单击 = 全屏、⌥单击 = 缩放（TL-03 / FS-01）
 *
 * 用法：`node dev/wm-check.mjs`（有问题退出码 1 并逐条列出）
 */

import assert from "node:assert/strict";

// ── 迷你 DOM：只实现窗口内核真正摸到的那一面 ──────────────────────────────

class ClassList {
    constructor(el) { this.el = el; this.set = new Set(); }
    add(...names) { names.forEach((n) => this.set.add(n)); }
    remove(...names) { names.forEach((n) => this.set.delete(n)); }
    toggle(name, force) {
        const want = force === undefined ? !this.set.has(name) : !!force;
        if (want) this.set.add(name); else this.set.delete(name);
        return want;
    }
    contains(name) { return this.set.has(name); }
}

/** 简单选择器匹配：tag / .cls / [attr] / [attr="v"] 的组合（不支持空格与 > 的单段）。 */
function matchSimple(el, simple) {
    if (!el || el.nodeType !== 1) return false;
    let s = simple.trim();
    if (!s) return false;
    const tag = s.match(/^[a-zA-Z][\w-]*/);
    if (tag && el.tagName !== tag[0].toUpperCase()) return false;
    s = s.slice(tag ? tag[0].length : 0);
    const re = /(\.[\w-]+)|(\[[\w-]+(?:="[^"]*")?\])|(\[[\w-]+\])/g;
    let m;
    let consumed = "";
    while ((m = re.exec(s))) {
        consumed += m[0];
        const part = m[0];
        if (part.startsWith(".")) {
            if (!el.classList.contains(part.slice(1))) return false;
        } else {
            const inner = part.slice(1, -1);
            const eq = inner.indexOf("=");
            if (eq < 0) { if (!el.hasAttribute(inner)) return false; }
            else if (el.getAttribute(inner.slice(0, eq)) !== inner.slice(eq + 2, -1)) return false;
        }
    }
    return consumed.length === s.length;
}

/** 命中「后代链」：parts 以 > 或空格分隔，从右往左回溯。 */
function matchSelector(el, selector) {
    const parts = selector.split(/\s*(>|(?=\S))\s+/).filter((p) => p && p !== ">");
    // 简化：把 "a > b" / "a b" 一律按「祖先链须依序出现」处理（内核用的选择器都满足）
    const chain = selector.split(/\s*>\s*|\s+/).filter(Boolean);
    if (!chain.length) return false;
    if (chain[0] === ":scope") chain.shift();
    if (!matchSimple(el, chain[chain.length - 1])) return false;
    let cur = el.parentElement;
    for (let i = chain.length - 2; i >= 0; i -= 1) {
        while (cur && !matchSimple(cur, chain[i])) cur = cur.parentElement;
        if (!cur) return false;
        cur = cur.parentElement;
    }
    return true;
}

let uid = 0;
class El {
    constructor(tag) {
        this.nodeType = 1;
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.attrs = {};
        // dataset 与 data-* 属性同一份账（真 DOM 的映射关系）
        this.dataset = new Proxy({}, {
            get: (t, k) => this.attrs["data-" + String(k).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())],
            set: (t, k, v) => { this.attrs["data-" + String(k).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())] = String(v); return true; },
        });
        this.style = {};
        this.classList = new ClassList(this);
        this._listeners = {};
        this.id = "";
        this._uid = ++uid;
    }
    get className() { return [...this.classList.set].join(" "); }
    set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get firstChild() { return this.children[0] || null; }
    get isConnected() {
        let n = this;
        while (n) { if (n === document.body) return true; n = n.parentElement; }
        return false;
    }
    get offsetWidth() { return parseFloat(this.style.width) || 0; }
    get offsetHeight() { return parseFloat(this.style.height) || 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") this.id = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    toggleAttribute(k, force) {
        const want = force === undefined ? !this.hasAttribute(k) : !!force;
        if (want) this.setAttribute(k, ""); else this.removeAttribute(k);
        return want;
    }
    set hidden(v) { this.toggleAttribute("hidden", !!v); }
    get hidden() { return this.hasAttribute("hidden"); }
    appendChild(c) { if (c.parentElement) c.parentElement.removeChild(c); c.parentElement = this; this.children.push(c); return c; }
    insertBefore(c, ref) {
        if (c.parentElement) c.parentElement.removeChild(c);
        const i = ref ? this.children.indexOf(ref) : -1;
        c.parentElement = this;
        if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
        return c;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentElement = null; return c; }
    remove() { if (this.parentElement) this.parentElement.removeChild(this); }
    _walk(out = []) { this.children.forEach((c) => { if (c.nodeType !== 1) return; out.push(c); c._walk(out); }); return out; }
    querySelector(sel) {
        if (sel.startsWith(":scope")) return this.querySelectorAll(sel)[0] || null;
        return this._walk().find((c) => matchSelector(c, sel)) || null;
    }
    querySelectorAll(sel) {
        if (sel.startsWith(":scope")) {
            const rest = sel.replace(/^:scope\s*>\s*/, "");
            return this.children.filter((c) => matchSimple(c, rest));
        }
        return this._walk().filter((c) => matchSelector(c, sel));
    }
    closest(sel) { let n = this; while (n) { if (matchSelector(n, sel)) return n; n = n.parentElement; } return null; }
    matches(sel) { return matchSelector(this, sel); }
    contains(el) { let n = el; while (n) { if (n === this) return true; n = n.parentElement; } return false; }
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { const l = this._listeners[t]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }
    dispatchEvent(e) {
        if (!e.target) e.target = this;
        (this._listeners[e.type] || []).slice().forEach((fn) => fn(e));
        if (e.bubbles && this.parentElement) this.parentElement.dispatchEvent(e);
        return true;
    }
    getBoundingClientRect() {
        const x = parseFloat(this.style.left) || 0;
        const y = parseFloat(this.style.top) || 0;
        const w = parseFloat(this.style.width) || 0;
        const h = parseFloat(this.style.height) || 0;
        return { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y };
    }
}

/** 自相似兜底桩：finderbar 等模块顶层 init 摸 DOM 时不会炸（它拿不到真结构就会短路）。 */
function makeStub() {
    return {
        nodeType: 1,
        classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
        dataset: {}, style: {},
        setAttribute() { }, getAttribute: () => null, hasAttribute: () => false, removeAttribute() { }, toggleAttribute() { },
        appendChild: (c) => c, insertBefore: (c) => c, remove() { }, addEventListener() { }, removeEventListener() { },
        querySelector: () => makeStub(), querySelectorAll: () => [], closest: () => null, matches: () => false,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
        isConnected: false, textContent: "", id: "",
    };
}

const docListeners = {};
const htmlEl = new El("html");
const bodyEl = new El("body");
htmlEl.appendChild(bodyEl);
// finderbar 模块顶层会真跑 init：给它一个真实元素，init 会在它内部建菜单结构
const finderbarEl = new El("div");
finderbarEl.id = "finderbar";
bodyEl.appendChild(finderbarEl);

globalThis.document = {
    documentElement: htmlEl,
    body: bodyEl,
    head: new El("head"),
    createElement: (t) => new El(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), parentElement: null }),
    createDocumentFragment: () => new El("frag"),
    getElementById: (id) => bodyEl._walk().find((c) => c.id === id) || makeStub(),
    querySelector: (sel) => {
        // 菜单/总览这类「不存在即 null」的查询必须给真 null，否则下游 if 判空全被桩骗过
        const hit = bodyEl.querySelector(sel);
        if (hit) return hit;
        if (/menu|overview|contextmenu/.test(sel)) return null;
        return makeStub();
    },
    querySelectorAll: (sel) => {
        if (sel === "body > .window") return bodyEl.children.filter((c) => c.classList.contains("window"));
        return bodyEl.querySelectorAll(sel);
    },
    getElementsByClassName: () => [],
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { const l = docListeners[t]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } },
    dispatchEvent: (e) => { (docListeners[e.type] || []).slice().forEach((fn) => fn(e)); return true; },
    visibilityState: "visible",
};

globalThis.window = {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener() { }, removeEventListener() { },
    matchMedia: () => ({ matches: false, addEventListener() { } }),
    getComputedStyle: (el) => ({
        minWidth: el.style.minWidth || "", minHeight: el.style.minHeight || "",
        maxWidth: el.style.maxWidth || "", maxHeight: el.style.maxHeight || "",
        overflowX: "", overflowY: "",
        getPropertyValue: () => "",
    }),
};
globalThis.getComputedStyle = globalThis.window.getComputedStyle;
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true, writable: true });
globalThis.localStorage = { getItem: () => null, setItem() { }, removeItem() { }, clear() { } };
globalThis.MutationObserver = class { observe() { } disconnect() { } };
globalThis.CustomEvent = class { constructor(t, o = {}) { this.type = t; this.detail = o.detail; this.bubbles = !!o.bubbles; } };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.self = globalThis;
htmlEl.dataset.reduceMotion = "on";

const sleep = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ── 内核装载（facade 求值即完成全部注入接线） ─────────────────────────────

const wm = await import("../src/javascripts/window-manager.js");
const relationsForProbe = await import("../src/javascripts/wm/relations.js");
const { setTrafficLightsEnabled, getTrafficLights } = await import("../src/javascripts/ui/trafficLights.js");

const problems = [];
const probe = (name, fn) => {
    try { fn(); console.log(`  ✓ ${name}`); }
    catch (err) { problems.push(`${name}: ${err.message}`); console.log(`  ✗ ${name}: ${err.message}`); }
};

function makeWindow(id, decl = "", size = { w: 400, h: 300 }) {
    const el = new El("div");
    el.classList.add("window");
    el.id = id;
    if (decl) el.setAttribute("data-window", decl);
    el.style.width = `${size.w}px`;
    el.style.height = `${size.h}px`;
    el.style.left = "100px";
    el.style.top = "80px";
    bodyEl.appendChild(el);
    return el;
}
const frame = (el) => wm.stateOf(el).frame;
const fireAnimEnd = (el) => el.dispatchEvent({ type: "animationend", target: el });

// ── WAPI-07：data-window 解析器 ────────────────────────────────────────────

probe("WAPI-07 minWidth:600 与 min-width 写法都被解析", () => {
    const a = makeWindow("t-parse-a", "minWidth:600 minHeight:440");
    const b = makeWindow("t-parse-b", "min-width:610 maxWidth:1200");
    const ca = wm.readDeclaration(a);
    const cb = wm.readDeclaration(b);
    assert.equal(ca.minWidth, 600);
    assert.equal(ca.minHeight, 440);
    assert.equal(cb.minWidth, 610);
    assert.equal(cb.maxWidth, 1200);
});

probe("WAPI-07 新键（role/dragAxis/resizeAxis/aspectRatio/snap/fixed）解析", () => {
    const el = makeWindow("t-parse-c", "role:child parent:主窗 dragAxis:x resizeAxis:y aspectRatio:16:9 snap:edges fixed:true dragBounds:10,20,500,400");
    const c = wm.readDeclaration(el);
    assert.equal(c.role, "child");
    assert.equal(c.parent, "主窗");
    assert.equal(c.dragAxis, "x");
    assert.equal(c.resizeAxis, "y");
    assert.equal(c.aspectRatio, "16:9");
    assert.equal(c.snap, "edges");
    assert.equal(c.fixed, true);
    assert.deepEqual(c.dragBounds, { x: 10, y: 20, w: 500, h: 400 });
});

// ── WAPI-01：configure() 不再回中 ──────────────────────────────────────────

await (async () => {
    const el = makeWindow("t-wapi01", "width:400 height:300 centered:true");
    wm.manage(el, {});
    await sleep();
    await sleep();
    const first = frame(el);
    wm.setGeometry(el, { x: 123, y: 77 });
    wm.configure(el, { width: 420 });
    const after = frame(el);
    probe("WAPI-01 configure 后位置不回中", () => {
        assert.equal(after.x, 123);
        assert.equal(after.y, 77);
        assert.equal(after.w, 420);
        assert.ok(el._wmPlaced === true);
    });
})();

// ── WAPI-02：能力位真拦截 ──────────────────────────────────────────────────

{
    const el = makeWindow("t-wapi02", "maximizable:false");
    wm.manage(el, {});
    const before = frame(el);
    probe("WAPI-02 maximizable:false 时 setZoom/setFullscreen/tile 全被拦", () => {
        assert.equal(wm.setZoom(el), false);
        assert.equal(wm.setFullscreen(el), false);
        assert.equal(wm.tile(el, "left"), false);
        assert.deepEqual(frame(el), before);
    });
    const el2 = makeWindow("t-wapi02b", "minimizable:false");
    wm.manage(el2, {});
    probe("WAPI-02 minimizable:false 时 setMinimized 被拦", () => {
        wm.setMinimized(el2, true);
        assert.equal(wm.isMinimized(el2), false);
    });
}

// ── WAPI-03：window:* 事件序列 ─────────────────────────────────────────────

await (async () => {
    const seen = [];
    const details = {};
    const topics = ["open", "focus", "minimize", "restore", "zoom", "fullscreen", "tile", "level-change", "close"];
    topics.forEach((t) => document.addEventListener(`window:${t}`, (e) => {
        seen.push(`${t}:${e.detail.id}`);
        if (!details[t]) details[t] = e.detail;
    }));

    const el = makeWindow("t-events");
    wm.manage(el, {});
    wm.prepareOpen(el);
    wm.revealOpen(el);
    await sleep(60);
    if (!seen.some((s) => s.startsWith("open:"))) {
        console.log(`[debug] open 未发：pending=${el._wmOpenPending} revealing=${el._wmOpenRevealing} connected=${el.isConnected}`);
        await sleep(300);
    }
    wm.focusWindow(el);
    wm.setMinimized(el, true);
    wm.restore(el);
    wm.setZoom(el);
    wm.setZoom(el, { on: false });
    wm.setFullscreen(el);
    wm.setFullscreen(el, { on: false });
    wm.tile(el, "left");
    wm.untile(el);
    wm.setLevel(el, "floating");
    wm.close(el);
    fireAnimEnd(el);

    probe("WAPI-03 事件序列完整且 detail 形状正确", () => {
        ["open", "focus", "minimize", "restore", "zoom", "fullscreen", "tile", "level-change", "close"].forEach((t) => {
            assert.ok(seen.includes(`${t}:t-events`), `缺 window:${t}（实收 ${seen.join(",")}）`);
        });
    });
    probe("WAPI-03 detail 含 id/appId/pluginId/frame/state", () => {
        const d = details.focus;
        assert.ok(d && "id" in d && "appId" in d && "pluginId" in d && "frame" in d && "state" in d);
        assert.equal(typeof d.frame.w, "number");
        assert.equal(d.state.role, "normal");
    });
})();

// ── WAPI-04 / NW-1：母子窗联动 ─────────────────────────────────────────────

{
    const parent = makeWindow("t-parent", "", { w: 500, h: 400 });
    const child = makeWindow("t-child", "", { w: 240, h: 160 });
    wm.manage(parent, {});
    wm.manage(child, {});
    const st = wm.attach(child, { parent });
    probe("NW-1 attach 落地 + Dock 过滤标记", () => {
        assert.ok(st && st.parent === parent);
        assert.equal(child.dataset.wmRole, "child");
        assert.deepEqual(wm.childrenOf(parent), [child]);
        assert.equal(wm.parentOf(child), parent);
    });
    probe("NW-1 聚焦母窗时子窗紧随其后（恒在母上一层）", () => {
        wm.focusWindow(parent);
        const zp = parseInt(parent.style.zIndex, 10);
        const zc = parseInt(child.style.zIndex, 10);
        assert.ok(zc > zp, `子窗 z ${zc} 应 > 母窗 z ${zp}`);
    });
    probe("NW-1 子窗随母窗最小化 / 恢复", () => {
        wm.setMinimized(parent, true);
        assert.ok(wm.isMinimized(parent) && wm.isMinimized(child));
        wm.restore(parent);
        assert.ok(!wm.isMinimized(parent) && !wm.isMinimized(child));
    });
    probe("NW-1 跟随移动（保持相对偏移）", () => {
        const c0 = frame(child);
        // 拖动的几何结果等价物：母窗先落位，followMove 带子窗同步位移
        wm.setGeometry(parent, { x: 140, y: 110 });
        relationsForProbe.followMove(parent, 40, 30);
        const c1 = frame(child);
        assert.deepEqual([c1.x - c0.x, c1.y - c0.y], [40, 30]);
    });
    probe("NW-1 母窗关闭级联子窗关闭", () => {
        wm.close(parent);
        assert.ok(parent.classList.contains("closing"));
        assert.ok(child.classList.contains("closing"));
        fireAnimEnd(parent);
        fireAnimEnd(child);
        assert.ok(!parent.isConnected && !child.isConnected);
    });
}

// ── NW-1 模态：母窗 inert、关闭/最小化被拦、模态层级 ───────────────────────

{
    const parent = makeWindow("t-modal-p", "", { w: 500, h: 400 });
    const sheet = makeWindow("t-modal-c", "", { w: 240, h: 160 });
    wm.manage(parent, {});
    wm.manage(sheet, {});
    wm.attach(sheet, { parent, modal: true });
    probe("NW-1 模态：母窗 inert + 子窗 modal 层级（7500+）", () => {
        assert.equal(parent.inert, true);
        assert.ok(parseInt(sheet.style.zIndex, 10) >= 7500, `模态子窗 z=${sheet.style.zIndex}`);
        assert.equal(wm.stateOf(sheet).level, "modal");
    });
    probe("NW-1 模态：母窗关闭/最小化被拦到模态关闭后", () => {
        wm.close(parent);
        assert.ok(!parent.classList.contains("closing"));
        wm.setMinimized(parent, true);
        assert.ok(!wm.isMinimized(parent));
    });
    probe("NW-1 模态：模态关闭后母窗解禁", () => {
        wm.close(sheet);
        fireAnimEnd(sheet);
        assert.equal(parent.inert, false);
        wm.close(parent);
        assert.ok(parent.classList.contains("closing"));
        fireAnimEnd(parent);
    });
}

// ── NW-9：可取消的关闭 ─────────────────────────────────────────────────────

{
    const el = makeWindow("t-nw9");
    wm.manage(el, {});
    probe("NW-9 onClose 返回 false 中止关闭", () => {
        wm.setWindowOnClose(el, () => false);
        wm.close(el);
        assert.ok(!el.classList.contains("closing"));
    });
    probe("NW-9 handler 抛错视为放行", () => {
        wm.setWindowOnClose(el, () => { throw new Error("boom"); });
        wm.close(el);
        assert.ok(el.classList.contains("closing"));
        fireAnimEnd(el);
    });
}

// ── NW-2：拖动约束 ─────────────────────────────────────────────────────────

{
    const el = makeWindow("t-nw2", "dragAxis:x dragBounds:0,0,500,400", { w: 200, h: 100 });
    wm.manage(el, {});
    probe("NW-2 dragAxis:x 锁定纵坐标", () => {
        const r = wm.applyDragConstraints(el, 300, 250, { w: 200, h: 100 }, { x: 100, y: 80 });
        assert.equal(r.y, 80);
    });
    probe("NW-2 dragBounds 硬区域钳制", () => {
        const r = wm.applyDragConstraints(el, 999, 80, { w: 200, h: 100 }, { x: 100, y: 80 });
        assert.equal(r.x, 300); // bounds.x + bounds.w - w
    });
    const fixed = makeWindow("t-nw2f", "fixed:true", { w: 200, h: 100 });
    fixed.style.left = "1380px";
    wm.manage(fixed, {});
    probe("NW-2 fixed 不可拖 + 视口重排不回拉（WAPI-13）", () => {
        assert.equal(fixed.dataset.wmDraggable, "false");
        assert.equal(wm.inDragZone({ el: fixed }, { target: fixed, clientX: 1400, clientY: 90 }), false);
        const before = frame(fixed);
        wm.relayoutOnResize();
        assert.deepEqual(frame(fixed), before);
    });
}

// ── NW-3：缩放轴与宽高比 ───────────────────────────────────────────────────

{
    const el = makeWindow("t-nw3", "resizeAxis:x aspectRatio:16:9");
    wm.manage(el, {});
    probe("NW-3 resizeAxis:x 时只留 e/w 边带", () => {
        const bands = el.querySelectorAll(":scope > .wm-edge").map((b) => b.dataset.wmEdge).sort();
        assert.deepEqual(bands, ["e", "w"]);
    });
    probe("NW-3 aspectRatio 常驻锁定", () => {
        assert.ok(Math.abs(el._wmAspect - 16 / 9) < 1e-9);
    });
    const both = makeWindow("t-nw3b");
    wm.manage(both, {});
    probe("NW-3 缺省八向边带不变（兼容）", () => {
        assert.equal(both.querySelectorAll(":scope > .wm-edge").length, 8);
    });
}

// ── NW-4：层级分带 ─────────────────────────────────────────────────────────

{
    const a = makeWindow("t-nw4-a");
    const b = makeWindow("t-nw4-b");
    wm.manage(a, {});
    wm.manage(b, {});
    probe("NW-4 floating 带恒在 normal 之上", () => {
        wm.setLevel(b, "floating");
        const za = parseInt(a.style.zIndex, 10);
        const zb = parseInt(b.style.zIndex, 10);
        assert.ok(za >= 2050 && za <= 4499, `normal z=${za}`);
        assert.ok(zb >= 4500 && zb <= 5999, `floating z=${zb}`);
        assert.equal(wm.stateOf(b).level, "floating");
    });
    probe("NW-4 modal 档不开放直接声明", () => {
        assert.equal(wm.setLevel(a, "modal"), false);
    });
}

// ── WAPI-05 / NW-7：多窗实例后缀 ───────────────────────────────────────────

{
    const a = makeWindow("文稿");
    const b = makeWindow("文稿#2");
    probe("NW-7 nextWindowId：基名空闲用基名，被占加 #N", () => {
        assert.equal(wm.nextWindowId("全新应用"), "全新应用");
        assert.equal(wm.nextWindowId("文稿"), "文稿#3");
    });
}

// ── WAPI-09：红绿灯能力位双向 ──────────────────────────────────────────────

{
    const el = makeWindow("t-wapi09");
    wm.manage(el, {});
    const lights = getTrafficLights(el);
    probe("WAPI-09 熄灭后复亮", () => {
        assert.ok(lights, "红绿灯应已挂载");
        setTrafficLightsEnabled(el, { zoom: false });
        assert.ok(lights.hasAttribute("no-zoom"));
        setTrafficLightsEnabled(el, { zoom: true });
        assert.ok(!lights.hasAttribute("no-zoom"));
    });
}

// ── 绿键语义（TL-03 / FS-01）：单击 = 全屏，⌥单击 = 缩放 ───────────────────

{
    const el = makeWindow("t-green", "", { w: 400, h: 300 });
    wm.manage(el, {});
    probe("绿键单击 = 全屏", () => {
        el.dispatchEvent({ type: "deskly:window-action", detail: { action: "zoom", altKey: false }, bubbles: true });
        assert.ok(wm.stateOf(el).fullscreen, "单击后应进入全屏");
    });
    probe("绿键 ⌥单击 = 缩放（填充可视区）", () => {
        el.dispatchEvent({ type: "deskly:window-action", detail: { action: "zoom", altKey: true }, bubbles: true });
        const st = wm.stateOf(el);
        assert.ok(!st.fullscreen, "⌥单击应已退出全屏");
        el.dispatchEvent({ type: "deskly:window-action", detail: { action: "zoom", altKey: true }, bubbles: true });
        assert.ok(wm.stateOf(el).zoomed, "⌥单击应进入缩放态");
    });
}

// ── 第二阶段：空间 / 分屏 / 台前调度 / 总览 ────────────────────────────────

// 第一阶段遗留的托管窗口统一关掉，避免污染空间/分组的断言
wm.getWindows().slice().forEach((w) => { wm.close(w); fireAnimEnd(w); });

const spaces = await import("../src/javascripts/wm/spaces.js");
const overviewMod = await import("../src/javascripts/wm/overview.js");
const stageMod = await import("../src/javascripts/wm/stage-manager.js");
const keyEvent = (init) => Object.assign({ type: "keydown", preventDefault() { }, stopPropagation() { } }, init);

// FS-02：全屏伪空间 —— 焦点离全屏，全屏窗隐藏且菜单栏外壳摘除；再聚焦复原
{
    const a = makeWindow("t-space-a");
    const b = makeWindow("t-space-b");
    wm.manage(a, {});
    wm.manage(b, {});
    wm.setFullscreen(a);
    probe("FS-02 进入全屏：html.deskly-fullscreen 挂上、另一窗不压顶", () => {
        assert.ok(htmlEl.classList.contains("deskly-fullscreen"));
        assert.ok(wm.stateOf(a).fullscreen);
        assert.ok(!b.classList.contains("wm-space-hidden"));
    });
    probe("FS-02 焦点移到普通窗 = 离开空间：全屏窗隐藏、外壳摘除", () => {
        wm.focusWindow(b);
        assert.ok(a.classList.contains("wm-space-hidden"));
        assert.ok(!htmlEl.classList.contains("deskly-fullscreen"));
        assert.ok(!wm.getVisibleWindows().includes(a));
    });
    probe("FS-02 再聚焦全屏窗 = 回到空间", () => {
        wm.focusWindow(a);
        assert.ok(!a.classList.contains("wm-space-hidden"));
        assert.ok(htmlEl.classList.contains("deskly-fullscreen"));
        assert.equal(wm.getTopWindow(), a);
    });
    probe("FS-02 Esc 退出全屏，几何与层级恢复", () => {
        const normal = wm.stateOf(a).normal;
        document.dispatchEvent(keyEvent({ key: "Escape" }));
        assert.ok(!wm.stateOf(a).fullscreen);
        const f = frame(a);
        assert.deepEqual([f.x, f.y, f.w, f.h], [normal.x, normal.y, normal.w, normal.h]);
        assert.ok(!htmlEl.classList.contains("deskly-fullscreen"));
    });
    wm.close(a); fireAnimEnd(a);
    wm.close(b); fireAnimEnd(b);
}

// FS-03：多全屏窗口 ⌃←/⌃→ 轮换
{
    const a = makeWindow("t-cyc-a");
    const b = makeWindow("t-cyc-b");
    wm.manage(a, {});
    wm.manage(b, {});
    wm.setFullscreen(a);
    wm.setFullscreen(b);
    probe("FS-03 ⌃→ 轮换到另一个全屏空间", () => {
        wm.focusWindow(a);
        document.dispatchEvent(keyEvent({ key: "ArrowRight", ctrlKey: true }));
        assert.ok(htmlEl.classList.contains("deskly-fullscreen"));
        assert.ok(a.classList.contains("wm-space-hidden"));
        assert.ok(!b.classList.contains("wm-space-hidden"));
    });
    wm.close(a); fireAnimEnd(a);
    wm.close(b); fireAnimEnd(b);
}

// FS-04：分屏浏览状态机
{
    const a = makeWindow("t-split-a", "", { w: 400, h: 300 });
    const b = makeWindow("t-split-b", "", { w: 420, h: 320 });
    wm.manage(a, {});
    wm.manage(b, {});
    probe("FS-04 进入分屏：选侧 + 选另一侧 + 各占半屏", () => {
        assert.equal(spaces.enterSplit(a, "left"), true);
        assert.equal(spaces.chooseSplitPartner(b), true);
        assert.ok(htmlEl.classList.contains("deskly-fullscreen"));
        const dW = 1440;
        assert.equal(Math.round(frame(a).w), Math.round((dW - 6) * 0.5));
        assert.equal(frame(b).x, Math.round((dW - 6) * 0.5) + 6);
    });
    probe("FS-04 分隔条改占比（夹进 0.2–0.8）", () => {
        spaces.setSplitRatio(0.7);
        assert.equal(Math.round(frame(a).w), Math.round((1440 - 6) * 0.7));
        spaces.setSplitRatio(0.95);
        assert.equal(spaces.splitState().ratio, 0.8);
    });
    probe("FS-04 退出一侧：本侧回用户框，另一侧升独占全屏", () => {
        const normalA = wm.stateOf(a).normal;
        spaces.exitSplit(a);
        assert.equal(spaces.splitState(), null);
        const fa = frame(a);
        assert.deepEqual([fa.x, fa.y, fa.w, fa.h], [normalA.x, normalA.y, normalA.w, normalA.h]);
        assert.ok(wm.stateOf(b).fullscreen);
    });
    wm.close(a); fireAnimEnd(a);
    wm.close(b); fireAnimEnd(b);
}

// FS-05：台前调度状态机
{
    const a = makeWindow("t-sm-a1");
    const b = makeWindow("t-sm-a2");
    const c = makeWindow("t-sm-c");
    a.dataset.appId = "app.one"; b.dataset.appId = "app.one"; c.dataset.appId = "app.two";
    wm.manage(a, {});
    wm.manage(b, {});
    wm.manage(c, {});
    wm.focusWindow(c);
    // 开启是两段的：先拍缩略图再收起非舞台组（隐藏后的窗口拍出来是空白），
    // 所以断言前让出一次事件循环，等 applyStage 落地。
    stageMod.setEnabled(true);
    await new Promise((r) => setTimeout(r, 0));
    probe("FS-05 开启：当前组上舞台，其余组挂 wm-shelved", () => {
        assert.ok(stageMod.isEnabled());
        assert.ok(!c.classList.contains("wm-shelved"));
        assert.ok(a.classList.contains("wm-shelved") && b.classList.contains("wm-shelved"));
    });
    probe("FS-05 点缩略图切舞台（按应用分组）", () => {
        stageMod.activateSet("app.one");
        assert.ok(!a.classList.contains("wm-shelved") && !b.classList.contains("wm-shelved"));
        assert.ok(c.classList.contains("wm-shelved"));
    });
    probe("FS-05 缩略图：标题=窗口显示名、按实际宽高比等比、命中区为整张按钮", () => {
        const thumb = document.getElementById("deskly-stage-shelf")
            .querySelector('.sm-thumb[data-set-key="app.two"]');
        assert.ok(thumb && thumb.tagName === "BUTTON");
        const caption = thumb.querySelector(".sm-caption");
        assert.equal(caption.textContent, "t-sm-c");
        const shot = thumb.querySelector(".sm-shot");
        // 比例按数值写（已夹进 0.55–2.6），c 是 400×300 -> 1.333
        const ratio = parseFloat(shot.style.aspectRatio || "");
        assert.ok(ratio > 0.55 && ratio <= 2.6, `aspectRatio=${shot.style.aspectRatio}`);
        assert.ok(Math.abs(ratio - 4 / 3) < 0.02, `aspectRatio=${ratio}`);
    });
    probe("FS-05 最小化的窗口不顶在组的门面位置", () => {
        // app.one 有 a/b 两窗：把 anchor 窗最小化，门面应让给存活成员
        wm.focusWindow(a);
        wm.setMinimized(a, true);
        const st = stageMod.stageState();
        const setA = st.sets.find((s) => s.key === "app.one");
        assert.equal(setA.anchor, "t-sm-a2");
        wm.restore(a);
    });
    probe("FS-05 开启期间分屏被拒（互斥闸）", () => {
        assert.equal(spaces.enterSplit(a, "left"), false);
    });
    probe("FS-05 关闭：全部摘除、停靠条移除", () => {
        stageMod.setEnabled(false);
        assert.ok(!a.classList.contains("wm-shelved") && !b.classList.contains("wm-shelved") && !c.classList.contains("wm-shelved"));
        assert.equal(document.getElementById("deskly-stage-shelf").id === "deskly-stage-shelf" && document.getElementById("deskly-stage-shelf").isConnected, false);
    });
    wm.close(a); fireAnimEnd(a);
    wm.close(b); fireAnimEnd(b);
    wm.close(c); fireAnimEnd(c);
}

// FS-06：⌃↑ 窗口总览
{
    const a = makeWindow("t-ov-a");
    const b = makeWindow("t-ov-b");
    wm.manage(a, {});
    wm.manage(b, {});
    probe("FS-06 ⌃↑ 打开总览：卡片数 = 可见窗口数", () => {
        document.dispatchEvent(keyEvent({ key: "ArrowUp", ctrlKey: true }));
        assert.ok(overviewMod.isOverviewOpen());
        const cards = document.getElementById("deskly-overview").querySelectorAll(".ov-card");
        assert.ok(cards.length >= 2, `cards=${cards.length}`);
    });
    probe("FS-06 方向键移动 + Enter 聚焦对应窗口并关闭", () => {
        document.dispatchEvent(keyEvent({ key: "ArrowRight" }));
        document.dispatchEvent(keyEvent({ key: "Enter" }));
        assert.ok(!overviewMod.isOverviewOpen());
    });
    probe("FS-06 Esc 关闭总览", () => {
        overviewMod.toggle();
        assert.ok(overviewMod.isOverviewOpen());
        document.dispatchEvent(keyEvent({ key: "Escape" }));
        assert.ok(!overviewMod.isOverviewOpen());
    });
    wm.close(a); fireAnimEnd(a);
    wm.close(b); fireAnimEnd(b);
}

// ── 首帧门控（FOUC）：隐藏标记先于绘制、兜底不抢跑 ─────────────────────────
// 用户看到的两类中间态都源于「还没就绪就已经可见」：
// 1) 窗口插入后第一帧就按无样式/默认几何画出来，再跳到真实状态；
// 2) 系统设置切面板先清空宿主，等动态 import 完成再填内容（空白帧）。
// 这里能机器守住的是「显示标记的设置顺序」与「兜底不得抢在冷加载之前」；
// 亚克力/观感本身仍需真机确认。

{
    const el = makeWindow("t-first-frame");
    wm.manage(el, {});
    wm.prepareOpen(el);
    const hiddenAtPrepare = el.classList.contains("wm-preparing");
    const pendingAtPrepare = el._wmOpenPending === true;
    wm.revealOpen(el);
    // revealOpen 只是启动逐帧收敛，调用当帧绝不能把窗口显示出来（否则就有一帧中间态）
    const hiddenBeforeSettle = el.classList.contains("wm-preparing");
    await new Promise((r) => setTimeout(r, 50));
    probe("首帧：插入后同帧隐藏，reveal 当帧不显示、落稳后一次性显示", () => {
        assert.ok(hiddenAtPrepare, "prepareOpen 必须立刻加上 .wm-preparing");
        assert.ok(pendingAtPrepare, "prepareOpen 必须挂起开窗标记");
        assert.ok(hiddenBeforeSettle, "revealOpen 在调用当帧就把窗口显示出来了");
        assert.ok(!el.classList.contains("wm-preparing"), "几何稳定后仍未显示");
        assert.equal(el._wmOpenPending, false, "落稳后应清掉开窗挂起标记");
    });
    wm.close(el); fireAnimEnd(el);

    const late = makeWindow("t-first-frame-fallback");
    wm.manage(late, {});
    wm.prepareOpen(late);
    // 旧的 250ms 兜底会在冷加载（样式表往返 + 插件入口脚本 init）完成前就显示骨架；
    // 这里按 400ms 抽查：只要还没到兜底，窗口必须仍不可见。
    await new Promise((r) => setTimeout(r, 400));
    const stillHidden = late.classList.contains("wm-preparing");
    const stillPending = late._wmOpenPending === true;
    wm.cancelOpenAnimation(late);
    probe("首帧：开窗兜底不抢在冷加载之前（400ms 内不显示骨架）", () => {
        assert.ok(stillHidden, "兜底早于 400ms 就显示了窗口，插件初始化完成前会露出半成品");
        assert.ok(stillPending, "兜底提前清掉了开窗挂起标记");
    });
    wm.close(late); fireAnimEnd(late);
}

// ── 输出 ───────────────────────────────────────────────────────────────────

if (problems.length) {
    console.log(`\n发现 ${problems.length} 个探针失败：`);
    problems.forEach((p) => console.log("  ✗ " + p));
    process.exit(1);
}
console.log("\nwm-check: WAPI-01~05 修复、NW-1~9 内核语义、绿键口径全部通过 ✓");
// finderbar 的时钟 setInterval 会吊住事件循环，显式退场
process.exit(0);
