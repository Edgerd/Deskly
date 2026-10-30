/**
 * script.js — App Store 插件界面
 *
 * 分层：本文件只做界面与交互，数据与动作全部来自 `src/javascripts/store-api.js`。
 * 之前是反过来的 —— 宿主 `src/javascripts/app-store.js` 伸手进本 mod 的 DOM 画卡片，
 * 我们再拿 MutationObserver 往别人的卡片上补卸载按钮、按显示名回查 manifest。
 * 现在商店的 DOM 只由这里生成，宿主不认识商店的界面，商店也不碰宿主的内部状态。
 *
 * 界面三段：侧栏（分类 + 记录）→ 卡片列表 → 详情页。
 * 详情页的内容来自插件自己声明的 `manifest.store`（见 plugin-format.md），
 * 没声明的区块就不渲染，不编文案。
 */

import { openApp, whenReady } from '../../src/javascripts/plugin-manager.js';
import {
    getEntry,
    categories,
    filterEntries,
    history,
    installZip,
    uninstall,
    uninstallPreview,
    verifyInstall,
    swStatus,
    versionDiff,
    setEnabled,
    PLACEHOLDER_ICON,
} from '../../src/javascripts/store-api.js';

// 窗口根元素：整份脚本只服务这一个窗口。
const win = document.querySelector(".appstore.window");

// 视图状态：模块级可变，init() 复位（窗口关闭再打开时重新执行本脚本）
let category = "all";
let keyword = "";
let currentId = null;   // 详情页对应的插件 id；null 表示在列表
let mode = "list";      // list | detail | history

function $(role) { return win.querySelector(`[data-role="${role}"]`); }

/** 建元素：文本一律走 textContent，清单里的字段是不可信输入，不能拼 HTML。 */
function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
}

/** 图片一律禁掉原生拖拽：否则按住拖会变成浏览器在拖一个图片文件，还留半透明拖影。 */
function pic(src, alt, cls) {
    const el = h("img", cls);
    el.src = src;
    el.alt = alt || "";
    el.draggable = false;
    return el;
}

/** 分组小标题 + 内容块 */
function section(title, rows) {
    const box = h("section", "dblock");
    box.appendChild(h("h3", null, title));
    rows.forEach((r) => box.appendChild(r));
    return box;
}

/**
 * 清单没写 `store` 时 store-api 返回 null（用来区分「没声明」与「声明了但为空」）。
 * 详情页按字段逐个判空，所以这里补一份全空骨架：不补的话读 `store.features.length`
 * 会在任何未声明 store 的插件上抛 undefined。
 */
function normalizeStore(store) {
    return Object.assign(
        { category: "", tagline: "", summary: "", features: [], usage: "", updated: "", homepage: "", author: "", screenshots: [] },
        store || {},
    );
}

function init() {
    category = "all";
    keyword = "";
    currentId = null;
    mode = "list";

    const search = $("search");
    search.value = "";
    search.addEventListener("input", () => {
        keyword = search.value.trim();
        // 输入即回到结果列表：停在详情页/记录里改搜索词会「输了没反应」
        showList();
    });

    $("back").addEventListener("click", showList);
    $("history").addEventListener("click", showHistory);

    const file = $("file");
    $("pick").addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
        const f = file.files && file.files[0];
        file.value = "";
        if (f) install(f);
    });

    bindDrop();

    // 注册表变化实时对账：安装/卸载/启用都会重画当前视图
    const touched = () => refresh();
    document.addEventListener("plugin-registered", touched);
    document.addEventListener("plugin-unregistered", touched);
    document.addEventListener("plugin-enabled-change", touched);
    window.addEventListener("plugins-ready", touched);
    win._storeCleanup = () => {
        document.removeEventListener("plugin-registered", touched);
        document.removeEventListener("plugin-unregistered", touched);
        document.removeEventListener("plugin-enabled-change", touched);
        window.removeEventListener("plugins-ready", touched);
    };

    win.addEventListener("keydown", onKeynav);

    // 兜底：将来任何动态加的 img 也不许被拖出窗口（拖出去会变成浏览器在拖文件）
    win.addEventListener("dragstart", (ev) => {
        if (ev.target instanceof Element && ev.target.closest("img")) ev.preventDefault();
    });

    // 窗口宽度变了，截图条的可滚范围跟着变
    const onResize = () => { if (activeNavSync) activeNavSync(); };
    window.addEventListener("resize", onResize);
    const offResize = () => window.removeEventListener("resize", onResize);
    const prevCleanup = win._storeCleanup;
    win._storeCleanup = () => { prevCleanup(); offResize(); };

    whenReady().then(refresh);
    renderSwStatus();
}

function refresh() {
    renderCats();
    if (mode === "detail" && currentId) renderDetail(currentId);
    else if (mode === "history") renderHistory();
    else renderList();
}

/* ───────────────────────── 侧栏 ───────────────────────── */

function renderCats() {
    const box = $("cats");
    box.innerHTML = "";
    categories().forEach((c) => {
        const btn = h("button", "cat" + (mode === "list" && c.key === category ? " active" : ""), c.label);
        btn.type = "button";
        btn.appendChild(h("span", "n", String(c.count)));
        btn.addEventListener("click", () => {
            category = c.key;
            showList();
        });
        box.appendChild(btn);
    });
    $("history").classList.toggle("active", mode === "history");
}

/** 资源代理状态：ZIP 插件的资源全靠 SW 从 IndexedDB 回源，没接管就装不了。 */
async function renderSwStatus() {
    const foot = $("sw");
    foot.innerHTML = "";
    const { controlled, registered } = await swStatus();
    const dot = h("i", "dot " + (controlled ? "on" : "off"));
    foot.appendChild(dot);
    foot.appendChild(h("span", null,
        controlled ? "资源代理已接管" : registered ? "资源代理未接管（无法安装 ZIP）" : "资源代理未注册（无法安装 ZIP）"));
    foot.title = controlled
        ? "已安装插件的资源由 Service Worker 从本地库返回"
        : "页面未被 Service Worker 接管，ZIP 安装无法生效。刷新一次页面通常可恢复。";
}

/* ───────────────────────── 列表 ───────────────────────── */

function showList() {
    closeLightbox();
    activeNavSync = null;
    mode = "list";
    currentId = null;
    $("detail").hidden = true;
    $("list").hidden = false;
    $("back").hidden = true;
    renderCats();
    renderList();
}

function renderList() {
    const list = filterEntries(category, keyword);
    const cat = categories().find((c) => c.key === category);
    setHeading(cat ? cat.label : "全部", list.length ? `${list.length} 个应用` : "");

    const grid = $("grid");
    grid.innerHTML = "";
    if (!list.length) {
        grid.appendChild(h("div", "empty", keyword ? `没有匹配「${keyword}」的应用` : "这里还没有应用"));
        return;
    }
    list.forEach((e) => grid.appendChild(card(e)));
}

/** 工具条标题：列表显示分类名，详情 / 记录显示当前对象，避免「停在详情里还写着全部 14 个应用」 */
function setHeading(title, count) {
    $("cat-title").textContent = title;
    $("count").textContent = count || "";
}

function card(e) {
    const el = h("article", "card" + (e.enabled ? "" : " off"));
    el.dataset.id = e.id;
    el.tabIndex = 0;

    const icon = pic(e.icon || PLACEHOLDER_ICON, e.name, "icon");
    icon.addEventListener("error", () => { icon.src = PLACEHOLDER_ICON; }, { once: true });
    el.appendChild(icon);

    el.appendChild(h("h4", "name", e.name));
    el.appendChild(h("p", "tag", (e.store && e.store.tagline) || e.description || ""));

    const meta = h("p", "meta");
    meta.appendChild(h("span", "ver", e.version ? `v${e.version}` : "v—"));
    meta.appendChild(h("span", "src", e.source === "installed" ? "已安装" : "内置"));
    if (!e.enabled) meta.appendChild(h("span", "chip disabled", "已禁用"));
    el.appendChild(meta);

    const btn = h("button", "cta", e.enabled ? "打开" : "启用");
    btn.type = "button";
    btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (e.enabled) openEntry(e.id);
        else enable(e.id, true);
    });
    el.appendChild(btn);

    el.addEventListener("click", () => showDetail(e.id));
    return el;
}

/* ───────────────────────── 详情 ───────────────────────── */

function showDetail(id) {
    closeLightbox();
    mode = "detail";
    currentId = id;
    $("list").hidden = true;
    $("detail").hidden = false;
    $("back").hidden = false;
    renderCats();
    renderDetail(id);
}

function showHistory() {
    closeLightbox();
    activeNavSync = null;
    mode = "history";
    currentId = null;
    // 记录与详情共用右侧同一块面板（data-role="detail"），切换视图即切它的内容
    $("list").hidden = true;
    $("detail").hidden = false;
    $("back").hidden = false;
    renderCats();
    renderHistory();
}

function renderDetail(id) {
    const e = getEntry(id);
    const box = $("detail");
    box.innerHTML = "";
    if (!e) {
        box.appendChild(h("p", "empty", "这个应用已经不在了。"));
        return;
    }
    const store = normalizeStore(e.store);
    setHeading(e.name, store.category || (e.source === "installed" ? "已安装" : "系统内置"));

    // 头部：图标 + 名称 + 一句话 + 操作
    const hero = h("header", "hero");
    const icon = pic(e.icon || PLACEHOLDER_ICON, e.name, "heroicon");
    icon.addEventListener("error", () => { icon.src = PLACEHOLDER_ICON; }, { once: true });
    hero.appendChild(icon);

    const info = h("div", "hero-info");
    info.appendChild(h("h2", null, e.name));
    info.appendChild(h("p", "tagline", store.tagline || e.description || ""));
    const byline = h("p", "byline");
    [
        e.version ? `版本 ${e.version}` : "",
        store.category || (e.source === "installed" ? "已安装" : "系统内置"),
        store.author ? `开发者 ${store.author}` : "",
        e.apps.length ? `${e.apps.length} 个应用` : "1 个应用",
    ].filter(Boolean).forEach((t, i) => {
        if (i) byline.appendChild(h("span", "sep", "·"));
        byline.appendChild(h("span", null, t));
    });
    info.appendChild(byline);
    hero.appendChild(info);

    const acts = h("div", "hero-acts");
    const openBtn = h("button", "cta", e.enabled ? "打开" : "启用");
    openBtn.type = "button";
    openBtn.addEventListener("click", () => openEntry(e.id));
    acts.appendChild(openBtn);
    if (e.enabled) {
        const off = h("button", "ghost", "禁用");
        off.type = "button";
        off.addEventListener("click", () => enable(e.id, false));
        acts.appendChild(off);
    }
    if (e.source === "installed") {
        const check = h("button", "ghost", "校验资源");
        check.type = "button";
        check.addEventListener("click", () => verify(e.id));
        acts.appendChild(check);
        const del = h("button", "danger", "卸载");
        del.type = "button";
        del.addEventListener("click", () => doUninstall(e.id));
        acts.appendChild(del);
    }
    hero.appendChild(acts);
    box.appendChild(hero);

    // 截图：清单声明了才显示；某张取不到就把那一格摘掉（不摆占位图骗人）
    if (e.screenshots.length) box.appendChild(section("界面", [shotsCarousel(e)]));

    const summary = store.summary || e.description;
    if (summary) box.appendChild(section("简介", [h("p", "para", summary)]));
    if (store.features.length) {
        const ul = h("ul", "feats");
        store.features.forEach((f) => ul.appendChild(h("li", null, f)));
        box.appendChild(section("能力", [ul]));
    }
    if (store.usage) box.appendChild(section("使用方法", [h("p", "para", store.usage)]));

    // 多应用套件：逐个列出可单独打开的应用
    if (e.apps.length) {
        const row = h("div", "apps");
        e.apps.forEach((a) => {
            const chip = h("button", "appchip");
            chip.type = "button";
            const img = pic(a.icon || PLACEHOLDER_ICON, a.name);
            img.addEventListener("error", () => { img.src = PLACEHOLDER_ICON; }, { once: true });
            chip.append(img, h("span", null, a.name));
            chip.addEventListener("click", () => openApp(a.appId));
            row.appendChild(chip);
        });
        box.appendChild(section("包含的应用", [row]));
    }

    // 权限取自 manifest.permissions（与授权账本同源），不是商店文案
    const perms = h("ul", "perms");
    if (!e.permissions.length) {
        perms.appendChild(h("li", "none", "不需要任何额外能力"));
    } else {
        e.permissions.forEach((p) => {
            const li = h("li");
            li.appendChild(h("b", null, p.label));
            li.appendChild(h("span", "hint", p.hint));
            if (p.sensitive) li.appendChild(h("span", "chip sensitive", "敏感"));
            perms.appendChild(li);
        });
    }
    box.appendChild(section("权限", [perms]));

    const kv = h("dl", "kv");
    const put = (k, v) => {
        if (!v) return;
        kv.appendChild(h("dt", null, k));
        kv.appendChild(h("dd", null, v));
    };
    put("标识", e.id);
    put("来源", e.source === "installed" ? `ZIP 安装（${e.from || "本地包"}）` : "系统内置");
    if (e.installedAt) put("安装时间", new Date(e.installedAt).toLocaleString());
    if (e.bytes) put("占用", `${(e.bytes / 1024).toFixed(0)} KB · ${e.fileCount} 个文件`);
    if (store.updated) put("更新时间", store.updated);
    box.appendChild(section("信息", [kv]));

    if (store.homepage) {
        const a = h("a", "homepage", store.homepage);
        a.href = store.homepage;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        box.appendChild(section("主页", [a]));
    }
}

/* ───────────────────────── 界面截图：翻页与大图 ───────────────────────── */

/**
 * 截图条：一条横向滚动带，配左右箭头 + 滚轮横滑 + 方向键，点任意一张开大图。
 * 230px 高的卡片在窄面板里一屏放不下两张，没有箭头时鼠标用户根本没法翻（触控板能横滑）。
 */
function shotsCarousel(entry) {
    const wrap = h("div", "shots-wrap");
    const row = h("div", "shots");
    row.tabIndex = 0;
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "应用截图：滚轮或方向键翻页，点任意一张看大图");

    entry.screenshots.forEach((url, i) => {
        const fig = h("figure", "shot");
        const im = pic(url, `${entry.name} 截图 ${i + 1}`);
        im.loading = "lazy";
        im.addEventListener("load", () => sync());
        im.addEventListener("error", () => { fig.remove(); sync(); }, { once: true });
        fig.appendChild(im);
        fig.addEventListener("click", () => openLightbox(row, entry.name, fig));
        row.appendChild(fig);
    });

    const prev = h("button", "shots-nav shots-nav--prev", "‹");
    const next = h("button", "shots-nav shots-nav--next", "›");
    prev.type = "button";
    next.type = "button";
    prev.setAttribute("aria-label", "向前翻一页");
    next.setAttribute("aria-label", "向后翻一页");

    const maxScroll = () => row.scrollWidth - row.clientWidth;
    function sync() {
        const max = maxScroll();
        wrap.classList.toggle("has-nav", max > 2);
        prev.disabled = row.scrollLeft <= 1;
        next.disabled = row.scrollLeft >= max - 1;
    }
    const page = (dir) => row.scrollBy({ left: dir * Math.max(200, row.clientWidth * 0.86), behavior: "smooth" });
    prev.addEventListener("click", () => page(-1));
    next.addEventListener("click", () => page(1));
    row.addEventListener("scroll", () => requestAnimationFrame(sync));

    // 竖滚轮在这里改成横滑；到头 / 到底就放行，让详情页继续上下滚（不抢滚动）
    row.addEventListener("wheel", (ev) => {
        const max = maxScroll();
        if (max <= 2) return;
        const delta = Math.abs(ev.deltaY) > Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;
        if (!delta) return;
        if ((delta < 0 && row.scrollLeft <= 0) || (delta > 0 && row.scrollLeft >= max - 1)) return;
        ev.preventDefault();
        row.scrollLeft += delta;
    }, { passive: false });

    row.addEventListener("keydown", (ev) => {
        if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
        ev.preventDefault();
        page(ev.key === "ArrowLeft" ? -1 : 1);
    });

    wrap.append(prev, row, next);
    requestAnimationFrame(sync);
    activeNavSync = sync;
    return wrap;
}

let lightboxEl = null;
let lightboxKeys = null;
let activeNavSync = null;

/** 大图查看：窗口内模态，Esc / 点背景 / 关闭键退出，←/→ 翻页。 */
function openLightbox(row, name, target) {
    const figs = [...row.querySelectorAll(".shot")];
    const urls = figs.map((f) => f.querySelector("img")).filter(Boolean).map((im) => im.src);
    if (!urls.length) return;
    let index = Math.max(0, figs.indexOf(target));

    closeLightbox();
    const overlay = h("div", "lightbox");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", `${name} 截图`);
    overlay.tabIndex = -1;

    const stage = h("div", "lightbox__stage");
    const im = pic(urls[index], `${name} 截图 ${index + 1}`, "lightbox__img");
    stage.appendChild(im);

    const count = h("span", "lightbox__count", `${index + 1} / ${urls.length}`);
    const close = h("button", "lightbox__btn lightbox__close", "✕");
    const prev = h("button", "lightbox__btn lightbox__nav lightbox__nav--prev", "‹");
    const next = h("button", "lightbox__btn lightbox__nav lightbox__nav--next", "›");
    [close, prev, next].forEach((b) => { b.type = "button"; });
    close.setAttribute("aria-label", "关闭大图");
    prev.setAttribute("aria-label", "上一张");
    next.setAttribute("aria-label", "下一张");

    const go = (dir) => {
        index = (index + dir + urls.length) % urls.length;
        im.src = urls[index];
        im.alt = `${name} 截图 ${index + 1}`;
        count.textContent = `${index + 1} / ${urls.length}`;
    };
    prev.addEventListener("click", (ev) => { ev.stopPropagation(); go(-1); });
    next.addEventListener("click", (ev) => { ev.stopPropagation(); go(1); });
    close.addEventListener("click", closeLightbox);
    if (urls.length < 2) { prev.hidden = true; next.hidden = true; }

    overlay.addEventListener("click", (ev) => {
        if (ev.target === overlay || ev.target === stage) closeLightbox();
    });
    // 键位挂在窗口上并走捕获：焦点跑到别处（比如点了图）也还能 Esc / 翻页
    lightboxKeys = (ev) => {
        if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeLightbox(); return; }
        if (ev.key === "ArrowLeft") { ev.preventDefault(); ev.stopPropagation(); go(-1); return; }
        if (ev.key === "ArrowRight") { ev.preventDefault(); ev.stopPropagation(); go(1); }
    };
    win.addEventListener("keydown", lightboxKeys, true);

    overlay.append(stage, count, prev, next, close);
    win.appendChild(overlay);
    lightboxEl = overlay;
    close.focus();
}

function closeLightbox() {
    if (lightboxKeys) { win.removeEventListener("keydown", lightboxKeys, true); lightboxKeys = null; }
    if (!lightboxEl) return;
    lightboxEl.remove();
    lightboxEl = null;
}

/* ───────────────────────── 安装记录 ───────────────────────── */

function renderHistory() {
    const box = $("detail");
    box.innerHTML = "";
    const list = history();
    setHeading("安装记录", list.length ? `${list.length} 条` : "");
    if (!list.length) {
        box.appendChild(h("p", "empty", "还没有安装过插件。把 .zip 拖到窗口里，或点右上角「安装 ZIP…」。"));
        return;
    }
    const table = h("div", "hist");
    list.forEach((r) => {
        const row = h("div", "hrow");
        row.appendChild(h("span", "hwhen", new Date(r.at).toLocaleString()));
        row.appendChild(h("span", "hwhat", `${r.name || r.id}${r.version ? ` v${r.version}` : ""}`));
        row.appendChild(h("span", "hkind", r.action === "uninstall" ? "已卸载" : r.replaced ? "已覆盖" : "已安装"));
        row.appendChild(h("span", "hsiz", r.bytes ? `${(r.bytes / 1024).toFixed(0)} KB` : ""));
        table.appendChild(row);
    });
    box.appendChild(table);
}

/* ───────────────────────── 动作 ───────────────────────── */

function dialog() { return window.__dialog || null; }

function status(text) {
    const bar = $("status");
    bar.textContent = text || "";
    bar.hidden = !text;
}

function openEntry(id) {
    const e = getEntry(id);
    if (!e) return;
    if (!e.enabled) {
        const d = dialog();
        if (d) d.alert("应用已禁用", `「${e.name}」处于禁用状态，先在详情页点「启用」。`);
        return;
    }
    openApp(id);
}

function enable(id, on) {
    const res = setEnabled(id, on);
    if (!res.ok) {
        const d = dialog();
        if (d) d.alert("无法禁用", res.reason);
        return;
    }
    status(on ? "已启用" : "已禁用 —— 启动台与程序坞里不再出现，双击其格式的文件也不会打开它");
    refresh();
}

async function verify(id) {
    status("正在逐个回读清单声明的资源…");
    const r = await verifyInstall(id);
    status("");
    const d = dialog();
    const optional = r.optionalMissing && r.optionalMissing.length
        ? `\n详情图取不到（不影响使用）：\n${r.optionalMissing.join("\n")}`
        : "";
    if (r.ok) {
        if (d) d.alert("资源完整", "清单声明的入口、样式、脚本与图标都能从本地库取到。" + optional);
        return;
    }
    const lines = r.problems.map((p) => `${p.file} —— ${p.reason}`).join("\n");
    if (d) d.error("资源不完整", `有 ${r.problems.length} 项取不到：\n${lines}${optional}`);
}

async function doUninstall(id) {
    const e = getEntry(id);
    const prev = uninstallPreview(id) || { name: e ? e.name : id, files: 0, bytes: 0 };
    const d = dialog();
    if (d) {
        const detail = prev.bytes
            ? `将删除 ${prev.files} 个文件、约 ${(prev.bytes / 1024).toFixed(0)} KB。重装需要重新拖入安装包。`
            : "将注销这个插件。重装需要重新拖入安装包。";
        if (!(await d.confirm("卸载插件", `确定卸载「${prev.name}」吗？${detail}`))) return;
    }
    status("正在卸载…");
    // 先关窗口再摘记录：关闭流程需要注册表还在（按 manifest 判断入口类型、拆外壳）
    closeWindowsOf(id);
    const r = await uninstall(id);
    if (!r.ok) {
        status("");
        if (d) d.error("卸载失败", r.reason);
        return;
    }
    showList();
    status(`已卸载 ${prev.name}${r.freed ? `，释放 ${(r.freed / 1024).toFixed(0)} KB` : ""}`);
}

/**
 * 卸载后收掉该插件还开着的窗口。
 * 必须走窗口自己的关闭流程（_closeWindow），而不是直接 remove：
 * 直接删 DOM 会让 appStatus 停在 true，程序坞留下「有小圆点没界面」的钉子户。
 * @param {string} id 插件 id
 */
function closeWindowsOf(id) {
    const esc = (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(id) : id;
    document.querySelectorAll(`.window[data-plugin-id="${esc}"]`).forEach((w) => {
        if (typeof w._closeWindow === "function") w._closeWindow();
        else w.remove();
    });
}

/**
 * 安装一个 ZIP：解包 → 权限确认 → 落库 → 逐个回读校验，任一步失败都不留半成品。
 * 同 id 已安装时先问是否覆盖（带版本差异），再走同一套流程。
 */
async function install(file, overwrite) {
    const d = dialog();
    const at = (_stage, text) => status(text);
    let res = await installZip(file, { overwrite: !!overwrite, onProgress: at });

    if (!res.ok && res.reason === "already-installed") {
        status("");
        const id = (res.detail && res.detail.id) || "";
        const diff = versionDiff(id, (res.detail && res.detail.nextVersion) || "");
        const name = (res.detail && res.detail.name) || id;
        if (!d || !(await d.confirm("已安装过这个插件",
            `「${name}」已在本地库里（当前 ${diff.current || "未知"} → 新包 ${diff.next || "未知"}）。用这个包覆盖安装吗？`))) {
            return;
        }
        res = await installZip(file, { overwrite: true, onProgress: at });
    }

    status("");
    if (res.ok) {
        showList();
        const shots = res.warnings && res.warnings.length ? `（详情图缺 ${res.warnings.length} 张，可在详情页「校验资源」查看）` : "";
        status(`已安装 ${res.name}（${(res.bytes / 1024).toFixed(0)} KB · ${res.fileCount} 个文件）${shots}`);
        renderSwStatus();
        return;
    }
    if (res.reason === "cancelled") {
        status("已取消安装（未授权）");
        return;
    }
    const extra = res.detail && Array.isArray(res.detail.problems)
        ? `\n${res.detail.problems.map((p) => `${p.file} —— ${p.reason}`).join("\n")}`
        : "";
    if (d) d.error("安装失败", `${res.reason}${extra}`);
    else status(`安装失败：${res.reason}`);
}

/* ───────────────────────── 拖放 ───────────────────────── */

function bindDrop() {
    const veil = $("veil");
    let depth = 0;
    const isZip = (f) => /\.zip$/i.test((f && f.name) || "");
    // 只认真正的 zip 名：dragover 阶段 files 在部分内核里拿不到名字，退回 items 的 type
    const hasZip = (dt) => Array.from((dt && dt.files) || []).some(isZip)
        || Array.from((dt && dt.items) || []).some((it) => it.kind === "file"
            && (/\.zip$/i.test(it.name || "") || it.type === "application/zip"));
    win.addEventListener("dragenter", (e) => {
        if (!hasZip(e.dataTransfer)) return;
        e.preventDefault();
        depth++;
        veil.hidden = false;
    });
    win.addEventListener("dragover", (e) => {
        if (!hasZip(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
    });
    win.addEventListener("dragleave", () => {
        depth = Math.max(0, depth - 1);
        if (!depth) veil.hidden = true;
    });
    win.addEventListener("drop", (e) => {
        e.preventDefault();
        depth = 0;
        veil.hidden = true;
        const zip = Array.from(e.dataTransfer.files || []).find((f) => /\.zip$/i.test(f.name || ""));
        if (zip) install(zip);
        else status("拖进来的不是 .zip 插件包");
    });
}

/* ───────────────────────── 键盘 ───────────────────────── */

function onKeynav(e) {
    if (lightboxEl) return;   // 大图打开时键盘归浮层自己处理
    if (e.key === "Escape") {
        if (mode !== "list") showList();
        return;
    }
    if (mode !== "list") return;
    const grid = $("grid");
    const cards = Array.from(grid.querySelectorAll(".card"));
    if (!cards.length) return;
    const at = cards.indexOf(document.activeElement);
    if (e.key === "Enter") {
        if (at >= 0) cards[at].click();
        return;
    }
    let step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 0, ArrowUp: 0 }[e.key];
    if (step === undefined) return;
    if (step === 0) {
        // 行跨度按实测列数算：网格是 auto-fill，列数随窗口宽度变，不能写死
        const per = Math.max(1, Math.round(grid.clientWidth / (cards[0].offsetWidth + 14)));
        step = e.key === "ArrowDown" ? per : -per;
    }
    e.preventDefault();
    const next = at < 0 ? 0 : Math.min(cards.length - 1, Math.max(0, at + step));
    cards[next].focus();
    cards[next].scrollIntoView({ block: "nearest" });
}

/* ───────────────────────── 顶栏菜单命令 ───────────────────────── */

// manifest.menus 里声明的「显示」组靠这几个命令驱动（见 menuCommands.js：
// 命令只能是 注册表键名 + 至多一个字符串实参，CSP 下不能求值任意代码）。
const MENU_KEYS = ["storeShowCategory", "storeShowHistory", "storePickZip", "storeVerifyCurrent"];
const menuCommands = {
    storeShowCategory(key) {
        category = key || "all";
        showList();
    },
    storeShowHistory() { showHistory(); },
    storePickZip() { $("file").click(); },
    storeVerifyCurrent() {
        if (mode === "detail" && currentId) { verify(currentId); return; }
        status("先打开某个应用的详情页，再校验它声明的资源");
    },
};
window.__menuActions = window.__menuActions || {};
MENU_KEYS.forEach((key) => { window.__menuActions[key] = menuCommands[key]; });

// 资源释放：卸载时摘掉挂在 window/document 上的监听（插件脚本重复注入会叠加监听）
const onAppStoreUnload = (e) => {
    if (e.detail.id !== "app-store") return;
    window.removeEventListener("plugin-unload", onAppStoreUnload);
    if (win._storeCleanup) win._storeCleanup();
    // 只摘自己注册的那份：重载后新脚本实例已经覆盖了同名键，误删会让菜单命令失踪
    MENU_KEYS.forEach((key) => {
        if (window.__menuActions && window.__menuActions[key] === menuCommands[key]) delete window.__menuActions[key];
    });
};
window.addEventListener("plugin-unload", onAppStoreUnload);

/* ───────────────────────── 启动 ─────────────────────────
   必须放在所有模块级状态与函数声明之后：init() 会给 category / mode 等 `let` 赋值，
   早于声明执行会撞 TDZ（ReferenceError），整个商店界面就不会初始化。 */
if (!win) {
    console.warn("[app-store] 未找到窗口根元素，跳过初始化");
} else {
    init();
}
