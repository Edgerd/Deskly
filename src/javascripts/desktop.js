/**
 * desktop.js — 桌面 = /桌面 目录的文件系统视图（第 2 期）。
 *
 * 不再是「本次会话拖进来的图标集合」：启动即渲染 FS.list('/桌面')，
 * 靠 fs-changed 事件与其它写入方（访达/废纸篓/插件）保持同步。
 *
 * 交互对齐 macOS（reports/plan/存储与访达重构方案.md §5）：
 * - 单击选中、⌘/Ctrl 切换、Shift 范围选、空白拖出框选；
 * - 双击打开（文件夹→访达，文件→默认应用）；
 * - 拖动：落在文件夹图标上=移入该文件夹，落在程序坞废纸篓=移到废纸篓，
 *   落在空白=自由摆放（坐标写 .DS_Store，见 fs/dsstore.js）；
 * - 右键：已选项上保持多选，未选项=单选后开菜单；菜单经
 *   core/menuProviders.js 装配（内建 provider + 插件 provider）；
 * - 重命名行内完成，写回 FS.rename（失败如实提示，不静默吞）。
 *
 * 自由坐标与网格：sortBy=none 时坐标生效（拖动后落库），
 * sortBy≠none 时按字段排进网格列（macOS 同名行为：排序开启后图标吸回网格）。
 */

import { isNativeContextMenuEnabled } from "./contextMenuSettings.js";
import { i18n } from "./i18n.js";
import { FOLDER_ICON, GENERIC_DOC_ICON } from "./paths.js";
import { OSFS } from "./osfs.js";
import { FS } from "./fs/index.js";
import { DSStore } from "./fs/dsstore.js";
import { MenuProviders } from "./core/menuProviders.js";
import { buildFileMenuItems } from "./core/fileMenu.js";
import { moveToTrash } from "./trash.js";
import { settings } from "./settings.js";
import { getAppByExtension, openApp, getIconForName, resolveAppRecord } from "./plugin-manager.js";
import { QuickLook } from "./core/quicklook.js";
import { GetInfo } from "./core/getInfo.js";
import { OpenWith } from "./core/openWith.js";
import { acceptsItems } from "./core/appFormats.js";
import { Shortcuts } from "./core/shortcuts.js";

const desktop = document.getElementById("desktop");
const DESKTOP_PATH = OSFS.TOP.desktop.path;

settings.define({ key: "desktop.sortBy", type: "string", default: "none", owner: "desktop" });
// 慢速二次单击进入重命名的时间窗（毫秒）：两次按下间隔小于它按双击处理（交给 dblclick 打开），
// 大于等于它才认为是「先选中、后想改名」。默认 500ms，接近 macOS 的观感；做成设置项便于按机器调试。
settings.define({ key: "desktop.slowClickRenameMs", type: "number", default: 500, owner: "desktop" });
/** 判定成形后的延迟：留给浏览器先发 dblclick（慢速双击在系统里仍可能合成为双击），收到 dblclick 即取消。 */
const RENAME_ARM_DELAY_MS = 150;

/* ── 状态 ── */

/** @type {Array<{path:string,name:string,type:string,modified:number|null,size:number|null}>} */
let entries = [];
/** @type {Map<string, HTMLElement>} path → 图标元素 */
let itemEls = new Map();
/** @type {Set<string>} 选中项路径 */
const selected = new Set();
/** 自由坐标（name → {x,y}） */
let positions = {};
/** Shift 范围选的锚点（渲染序索引） */
let anchorIndex = -1;
/** 拖拽 / 重命名进行中：期间 fs-changed 触发的重渲染要压住，不然 DOM 被抽走 */
let interacting = false;

/* ── 工具 ── */

const IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"]);
const extOf = (name) => (String(name).match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || "";

function sortEntries(list) {
    const mode = settings.get("desktop.sortBy", "none");
    if (mode === "none") return list;
    const sorted = [...list].sort((a, b) => {
        let cmp = 0;
        if (mode === "name") cmp = a.name.localeCompare(b.name, "zh-CN", { numeric: true });
        else if (mode === "date") cmp = (a.modified || 0) - (b.modified || 0);
        else if (mode === "size") cmp = (a.size ?? -1) - (b.size ?? -1);
        else if (mode === "kind") cmp = extOf(a.name).localeCompare(extOf(b.name));
        return cmp;
    });
    // macOS 网格排序同样文件夹前置
    sorted.sort((a, b) => (a.type === "folder" ? 0 : 1) - (b.type === "folder" ? 0 : 1));
    return sorted;
}

/* ── 渲染 ── */

let renderTimer = 0;
function scheduleRender() {
    if (interacting) return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => { render().catch((err) => console.warn("[desktop] 渲染失败：", err)); }, 120);
}

async function render() {
    if (!desktop) return;
    const [list, store] = await Promise.all([FS.list(DESKTOP_PATH), DSStore.read(DESKTOP_PATH)]);
    entries = sortEntries(list);
    positions = store.positions;
    // 顺带清理死坐标（条目已删除/改名），外来 sidecar 不写（DSStore 内部判定）
    const liveNames = new Set(entries.map((e) => e.name));
    if (!store.foreign && Object.keys(positions).some((name) => !liveNames.has(name))) {
        DSStore.prune(DESKTOP_PATH, [...liveNames]).catch(() => {});
    }
    // 选中集剔除已消失项
    for (const p of [...selected]) {
        if (!entries.some((e) => e.path === p)) selected.delete(p);
    }

    desktop.innerHTML = "";
    itemEls = new Map();
    const container = document.createElement("div");
    container.className = "container";
    desktop.appendChild(container);

    entries.forEach((entry, index) => {
        const el = buildItem(entry);
        const pos = positions[entry.name];
        if (pos && settings.get("desktop.sortBy", "none") === "none") {
            el.style.position = "absolute";
            el.style.left = `${pos.x}px`;
            el.style.top = `${pos.y}px`;
            el.style.margin = "0";
            desktop.appendChild(el);
        } else {
            container.appendChild(el);
        }
        if (selected.has(entry.path)) el.classList.add("selected");
        el.dataset.index = String(index);
        itemEls.set(entry.path, el);
    });
}

function buildItem(entry) {
    const el = document.createElement("div");
    el.className = "item";
    el.dataset.path = entry.path;
    const img = document.createElement("img");
    img.draggable = false;
    const label = document.createElement("p");
    el.append(img, label);

    if (entry.type === "folder") {
        label.textContent = entry.name;
        img.src = FOLDER_ICON;
    } else if (Shortcuts.isShortcutName(entry.name)) {
        // 桌面快捷方式：显示名剥掉 .webloc.json，图标取目标应用图标
        label.textContent = entry.name.slice(0, -Shortcuts.EXT.length);
        img.src = GENERIC_DOC_ICON;
        Shortcuts.read(entry.path).then((parsed) => {
            if (!parsed || !el.isConnected) return;
            const icon = getIconForName(parsed.appId);
            if (icon) img.src = icon;
        }).catch(() => {});
    } else {
        label.textContent = entry.name;
        if (IMG_EXTS.has(extOf(entry.name))) {
            // 图片缩略图：读文件转 objectURL；失败退回通用图标
            FS.read(entry.path).then((file) => {
                if (!file || !el.isConnected) return;
                const url = URL.createObjectURL(file);
                img.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
                img.src = url;
            }).catch(() => { img.src = GENERIC_DOC_ICON; });
        }
        img.src = GENERIC_DOC_ICON;
    }
    return el;
}

/* ── 选中 ── */

function selectOnly(path) {
    selected.clear();
    if (path) selected.add(path);
    syncSelectionDom();
}

function syncSelectionDom() {
    for (const [path, el] of itemEls) el.classList.toggle("selected", selected.has(path));
}

function entryIndex(path) {
    return entries.findIndex((e) => e.path === path);
}

/* ── 慢速二次单击 → 重命名 ── */

let lastItemClickPath = null;
let lastItemClickAt = 0;
let pendingRenamePath = null;
let renameArmTimer = 0;

/** 可配置时间窗（毫秒）；设置值非法时回落到 500。 */
function slowClickMs() {
    const value = Number(settings.get("desktop.slowClickRenameMs", 500));
    return Number.isFinite(value) && value > 0 ? value : 500;
}

function cancelPendingRename() {
    pendingRenamePath = null;
    if (renameArmTimer) { clearTimeout(renameArmTimer); renameArmTimer = 0; }
}

/** 鼠标松开（且没变成拖拽）后才启动：先让浏览器有机会发 dblclick，收到即取消。 */
function armPendingRename() {
    const path = pendingRenamePath;
    pendingRenamePath = null;
    if (!path) return;
    if (renameArmTimer) clearTimeout(renameArmTimer);
    renameArmTimer = setTimeout(() => {
        renameArmTimer = 0;
        // 延迟期间选择可能已变（点了别处 / 多选），只对唯一选中项重命名
        if (!selected.has(path) || selected.size !== 1) return;
        const entry = entries.find((en) => en.path === path);
        if (entry) startRename(entry);
    }, RENAME_ARM_DELAY_MS);
}

function onItemMouseDown(e, entry) {
    if (e.button === 2) return;   // 右键交给 contextmenu
    const isToggle = e.metaKey || e.ctrlKey;
    // 慢速二次单击进入重命名：先记下「这次按下之前是否已选中」与两次按下的间隔。
    // 小于时间窗 = 双击序列（交给 dblclick 打开）；大于等于 = 用户想改名。
    const wasSelected = selected.has(entry.path);
    const gap = Date.now() - lastItemClickAt;
    const sameItem = lastItemClickPath === entry.path;
    lastItemClickAt = Date.now();
    lastItemClickPath = entry.path;
    cancelPendingRename();
    if (!isToggle && !e.shiftKey && !e.altKey && wasSelected && sameItem && gap >= slowClickMs()) {
        pendingRenamePath = entry.path;
    }
    if (isToggle) {
        if (selected.has(entry.path)) selected.delete(entry.path);
        else { selected.add(entry.path); anchorIndex = entryIndex(entry.path); }
        syncSelectionDom();
        return;
    }
    if (e.shiftKey && anchorIndex >= 0) {
        const to = entryIndex(entry.path);
        const [a, b] = anchorIndex < to ? [anchorIndex, to] : [to, anchorIndex];
        selected.clear();
        entries.slice(a, b + 1).forEach((en) => selected.add(en.path));
        syncSelectionDom();
        return;
    }
    // 无修饰：已选中就保持多选（等拖动/双击判定），未选中则单选
    if (!selected.has(entry.path)) {
        selectOnly(entry.path);
        anchorIndex = entryIndex(entry.path);
    }
}

/* ── 打开 ── */

function openItems(items) {
    for (const item of items) {
        if (item.type === "folder") { openFolder(item.path); continue; }
        if (Shortcuts.isShortcutName(item.name)) {
            // 快捷方式：打开目标应用；内容损坏时按普通文件回退预览
            Shortcuts.read(item.path).then((parsed) => {
                if (parsed) openApp(parsed.appId).catch((err) => console.warn("[desktop] 打开应用失败：", parsed.appId, err));
                else QuickLook.open([item.path]).catch(() => {});
            });
            continue;
        }
        const rec = getAppByExtension(extOf(item.name));
        if (rec) {
            openApp(rec.appId, { file: item.path }).catch((err) => console.warn("[desktop] 打开失败：", item.path, err));
        } else {
            // 无默认应用：弹「打开方式」选择器（macOS 同款），不再退回预览 ——
            // 预览会让用户误以为文件「打不开」，而选择器直接给出可选项与「始终用」开关。
            OpenWith.open(item.path).catch((err) => console.warn("[desktop] 打开方式选择器失败：", item.path, err));
        }
    }
}

/** 打开文件夹 = 让访达导航过去（与 dock 废纸篓点击同一通路：冷启动轮询重发）。 */
function openFolder(path) {
    const actions = window.__menuActions || {};
    if (typeof actions.openAppByName === "function") actions.openAppByName("访达");
    let tries = 0;
    const send = () => {
        const win = document.getElementById("访达");
        if (win) {
            win.dispatchEvent(new CustomEvent("finder-command", {
                detail: { command: "navigate", args: { path } },
                bubbles: true,
            }));
        }
        if (++tries < 25) setTimeout(send, 200);
    };
    setTimeout(send, 0);
}

/* ── 重命名 ── */

/** 非法字符检查（与 sanitizeName 同一口径）：命中时给用户明说，不静默改名。 */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/;

function startRename(entry) {
    const el = itemEls.get(entry.path);
    const nameEl = el && el.querySelector("p");
    if (!nameEl) return;
    interacting = true;
    const oldName = entry.name;
    nameEl.contentEditable = "true";
    nameEl.focus();
    // macOS：文件进入重命名时默认只选中主干，扩展名不涂蓝
    const sel = window.getSelection();
    const range = document.createRange();
    const textNode = nameEl.firstChild;
    if (textNode && entry.type !== "folder") {
        const dot = oldName.lastIndexOf(".");
        range.setStart(textNode, 0);
        range.setEnd(textNode, dot > 0 ? dot : oldName.length);
    } else {
        range.selectNodeContents(nameEl);
    }
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = async (commit) => {
        nameEl.contentEditable = "false";
        interacting = false;
        const newName = nameEl.textContent.trim();
        if (!commit || !newName || newName === oldName) { nameEl.textContent = oldName; return; }
        if (ILLEGAL_NAME_CHARS.test(newName)) {
            nameEl.textContent = oldName;
            const dialog = window.__dialog;
            if (dialog) dialog.alert(i18n.t("desktop.renameFailed", "重命名失败"), i18n.t("desktop.renameIllegal", "名称不能包含 \\ / : * ? \" < > | 这些字符。"));
            return;
        }
        try {
            const renamed = await FS.rename(entry.path, newName);
            if (renamed && renamed !== entry.path) pushUndo({ type: "rename", from: entry.path, to: renamed });
        } catch (err) {
            nameEl.textContent = oldName;
            const dialog = window.__dialog;
            if (dialog) dialog.alert(i18n.t("desktop.renameFailed", "重命名失败"), err.message || String(err));
        }
    };
    nameEl.addEventListener("blur", () => finish(true), { once: true });
    nameEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); nameEl.blur(); }
        if (e.key === "Escape") { e.preventDefault(); nameEl.removeEventListener("blur", finish); finish(false); }
    });
}

/* ── 新建文件夹 / 新建条目的落位 ── */

/**
 * 给新建条目找一个不与现有图标重叠的空位（自由摆放模式下才写坐标）。
 * 单元格尺寸取自新图标自身外框，不写死数值：图标尺寸会随设置变化。
 * 找不到空位就留在网格里（由容器流式排布），不强行覆盖别人的位置。
 * @returns {Promise<boolean>} 是否写入了自由坐标
 */
async function placeNewItem(path) {
    if (settings.get("desktop.sortBy", "none") !== "none") return false;
    const el = itemEls.get(path);
    if (!el || !desktop) return false;
    const self = el.getBoundingClientRect();
    const unitW = (self.width || 84) + 18;
    const unitH = (self.height || 96) + 18;
    const deskRect = desktop.getBoundingClientRect();
    const padX = 16;
    const padY = 16;
    const cols = Math.max(1, Math.floor((deskRect.width - padX * 2) / unitW));
    // 现有图标的绝对外框（含已落位与网格内的），不把新条目自己算进去
    const occupied = [...itemEls.entries()]
        .filter(([p]) => p !== path)
        .map(([, node]) => node.getBoundingClientRect());
    const overlaps = (box) => occupied.some((r) =>
        r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top);
    for (let row = 0; row < 30; row++) {
        for (let col = 0; col < cols; col++) {
            const left = deskRect.left + padX + col * unitW;
            const top = deskRect.top + padY + row * unitH;
            const box = { left, top, right: left + self.width, bottom: top + self.height };
            if (!overlaps(box)) {
                const name = entries.find((e) => e.path === path)?.name;
                if (!name) return false;   // 条目已被别处删除：不留死坐标
                await DSStore.setPosition(DESKTOP_PATH, name, {
                    x: left - deskRect.left,
                    y: top - deskRect.top,
                });
                return true;
            }
        }
    }
    return false;
}

async function newFolder() {
    const base = i18n.t("desktop.newFolderDefault", "未命名文件夹");
    let name = base;
    for (let i = 2; await FS.exists(FS.joinPath(DESKTOP_PATH, name)); i++) name = `${base} ${i}`;
    const path = await FS.mkdir(FS.joinPath(DESKTOP_PATH, name));
    pushUndo({ type: "create", path });   // ⌘Z 可撤掉刚新建的空文件夹（含 .DS_Store 坐标回收）
    await render();
    if (await placeNewItem(path)) await render();
    const entry = entries.find((e) => e.path === path);
    if (entry) {
        selectOnly(path);
        startRename(entry);
    }
}

/* ── 拖动（多选拖动 + 落点判定 + 自由坐标 + ⌥ 复制） ── */

let drag = null;   // { items:[{entry,el,startX,startY}], originX, originY, moved }

document.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.originX;
    const dy = e.clientY - drag.originY;
    // 越过阈值才动 DOM：按下即转 absolute 会在双击的第一、二次点击之间触发重渲染，
    // 第二次点击落在新元素上，浏览器永远合不成 dblclick（双击打不开的根因）
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
        drag.moved = true;
        interacting = true;
        const deskRect = desktop.getBoundingClientRect();
        drag.items.forEach((it) => {
            const rect = it.el.getBoundingClientRect();
            it.startX = rect.left - deskRect.left;
            it.startY = rect.top - deskRect.top;
            it.el.style.position = "absolute";
            it.el.style.margin = "0";
            it.el.style.left = `${it.startX}px`;
            it.el.style.top = `${it.startY}px`;
            desktop.appendChild(it.el);
            it.el.classList.add("drag-ghost");
        });
    }
    if (!drag.moved) return;
    drag.items.forEach(({ el, startX, startY }) => {
        el.style.left = `${startX + dx}px`;
        el.style.top = `${startY + dy}px`;
    });
    highlightDropTarget(e);
});

document.addEventListener("mouseup", (e) => {
    if (!drag) return;
    const current = drag;
    drag = null;
    clearDropHighlight();
    if (!current.moved) { armPendingRename(); return; }   // 纯点击：DOM 从头到尾没动过，只可能是「慢速二次单击→重命名」
    interacting = false;
    current.items.forEach(({ el }) => el.classList.remove("drag-ghost"));
    handleDrop(e, current)
        .catch((err) => console.warn("[desktop] 拖放失败：", err))
        .finally(() => scheduleRender());   // 废纸篓等不走 fs-changed 的落点也要刷新
});

let dropHighlighted = null;
function highlightDropTarget(e) {
    clearDropHighlight();
    const over = document.elementFromPoint(e.clientX, e.clientY);
    // 程序坞应用图标：只有目标应用声明能打开当前拖拽的全部文件时才高亮（否则不误导用户松手）
    const dockApp = over && over.closest ? over.closest("#dock .container[data-app]") : null;
    if (dockApp) {
        const verdict = dockVerdict(dockApp.dataset.app, drag.items.map(({ entry }) => entry));
        if (verdict.ok) {
            dockApp.classList.add("drop-target");
            dropHighlighted = dockApp;
        }
        return;
    }
    const folderEl = over && over.closest ? over.closest(".item") : null;
    if (folderEl && !drag.items.some(({ el }) => el === folderEl)) {
        const entry = entries.find((en) => en.path === folderEl.dataset.path);
        if (entry && entry.type === "folder") { folderEl.classList.add("drop-target"); dropHighlighted = folderEl; return; }
    }
    const trash = over && over.closest ? over.closest("#dock-trash") : null;
    if (trash) { trash.classList.add("drop-target"); dropHighlighted = trash; }
}
function clearDropHighlight() {
    if (dropHighlighted) { dropHighlighted.classList.remove("drop-target"); dropHighlighted = null; }
}

/**
 * 拖到程序坞应用图标：按应用清单声明的 formats 判定能否接受。
 * 文件夹一律不接受（没有应用声明目录格式），避免「看起来能放、松手没反应」。
 * @param {string} appName 程序坞条目的身份名（container.dataset.app）
 * @param {Array<object>} items 拖拽条目
 * @returns {{ok:boolean, appId?:string, reason?:string}}
 */
function dockVerdict(appName, items) {
    const rec = resolveAppRecord(appName);
    const list = (items || []).filter(Boolean);
    if (!rec) return { ok: false, reason: i18n.t("desktop.dropUnknownApp", `“${appName}”无法打开所选项目`) };
    if (list.some((item) => item.type === "folder")) {
        return { ok: false, reason: i18n.t("desktop.dropFolder", "应用不能直接打开文件夹") };
    }
    if (!acceptsItems(rec, list)) {
        return { ok: false, reason: i18n.t("desktop.dropRejected", `“${appName}”无法打开该类型的文件`) };
    }
    return { ok: true, appId: rec.appId || appName };
}

/* 轻提示：一次性气泡，不弹模态框、也不静默失败 */
let hintEl = null;
let hintTimer = 0;
function flashHint(message) {
    if (!message) return;
    if (!hintEl) {
        hintEl = document.createElement("div");
        hintEl.className = "desktop-hint";
        hintEl.setAttribute("role", "status");
        document.body.appendChild(hintEl);
    }
    hintEl.textContent = message;
    hintEl.classList.add("visible");
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { if (hintEl) hintEl.classList.remove("visible"); }, 2400);
}

async function handleDrop(e, current) {
    const over = document.elementFromPoint(e.clientX, e.clientY);
    // 程序坞应用图标：能接受则在此松手即打开（等同双击），不能接受给一次轻提示，不静默失败
    const dockApp = over && over.closest ? over.closest("#dock .container[data-app]") : null;
    if (dockApp) {
        const verdict = dockVerdict(dockApp.dataset.app, current.items.map(({ entry }) => entry));
        if (!verdict.ok) { flashHint(verdict.reason); return; }
        for (const { entry } of current.items) {
            await openApp(verdict.appId, { file: entry.path }).catch((err) => {
                console.warn("[desktop] 拖到程序坞打开失败：", entry.path, err);
            });
        }
        return;
    }
    const folderEl = over && over.closest ? over.closest(".item") : null;
    // 落在文件夹上：整组移入（⌥ = 复制）
    if (folderEl && !current.items.some(({ el }) => el === folderEl)) {
        const target = entries.find((en) => en.path === folderEl.dataset.path);
        if (target && target.type === "folder") {
            for (const { entry } of current.items) {
                const dest = FS.joinPath(target.path, entry.name);
                if (e.altKey) {
                    await FS.copy(entry.path, await uniquePathIn(target.path, entry.name)).catch((err) => {
                        console.warn("[desktop] ⌥ 复制失败：", entry.path, err);
                    });
                    continue;
                }
                await FS.move(entry.path, dest).catch((err) => {
                    if (err.code === "EEXIST") return;   // 同名冲突跳过该项（不覆盖，与 macOS 弹确认前的安全缺省一致）
                    throw err;
                });
            }
            return;
        }
    }
    // 落在程序坞废纸篓
    if (over && over.closest && over.closest("#dock-trash")) {
        const trashPaths = [];
        for (const { entry } of current.items) {
            const r = await moveToTrash(entry.path);
            if (r && r.ok && r.path) trashPaths.push(r.path);
        }
        if (trashPaths.length) pushUndo({ type: "trash", trashPaths });
        return;
    }
    // 程序坞空白处（既不是应用也不是废纸篓）：原地放下不动，不把图标坐标写到屏幕底边
    if (over && over.closest && over.closest("#dock")) return;
    // 落在空白：⌥ = 原地复制；否则自由坐标落库
    if (e.altKey) {
        for (const { entry } of current.items) {
            await FS.copy(entry.path, await uniquePathIn(DESKTOP_PATH, duplicateName(entry.name, entry.type))).catch((err) => {
                console.warn("[desktop] ⌥ 复制失败：", entry.path, err);
            });
        }
        return;
    }
    if (settings.get("desktop.sortBy", "none") === "none") {
        for (const { entry, el } of current.items) {
            positions[entry.name] = { x: el.offsetLeft, y: el.offsetTop };
            await DSStore.setPosition(DESKTOP_PATH, entry.name, positions[entry.name]);
        }
    }
    scheduleRender();
}

function beginDrag(e, entry) {
    const group = selected.has(entry.path) ? [...selected] : [entry.path];
    // 只记录候选，不碰 DOM：转换发生在第一次真正移动时（见 mousemove）
    const items = group.map((path) => {
        const el = itemEls.get(path);
        return el ? { entry: entries.find((en) => en.path === path), el, startX: 0, startY: 0 } : null;
    }).filter(Boolean);
    drag = { items, originX: e.clientX, originY: e.clientY, moved: false };
}

/* ── 命名工具 ── */

/** 目录内唯一落点名：name.ext → name (1).ext 顺延。 */
async function uniquePathIn(dir, name) {
    const stem = name.replace(/\.[^.]+$/, "");
    const ext = name.match(/\.[^.]+$/)?.[0] || "";
    let candidate = FS.joinPath(dir, name);
    for (let i = 1; await FS.exists(candidate); i++) candidate = FS.joinPath(dir, `${stem} (${i})${ext}`);
    return candidate;
}

/** 「副本」命名：a.txt → a 副本.txt，重名继续 a 副本 2.txt / a 副本 3.txt… */
function duplicateName(name, type, index = 1) {
    const dot = type === "folder" ? -1 : name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    const suffix = i18n.t("desktop.duplicateSuffix", "副本");
    return `${stem} ${suffix}${index > 1 ? ` ${index}` : ""}${ext}`;
}

/** 目录内唯一的「副本」落点名（复制/粘贴/制作副本共用同一套重名规则）。 */
async function uniqueDuplicatePath(dir, name, type) {
    for (let i = 1; i <= 999; i++) {
        const candidate = FS.joinPath(dir, duplicateName(name, type, i));
        if (!(await FS.exists(candidate))) return candidate;
    }
    throw new Error(i18n.t("desktop.duplicateFailed", "副本数量过多，无法继续创建"));
}

/* ── 撤销（⌘Z：覆盖重命名与移入废纸篓） ── */

const undoStack = [];
const UNDO_LIMIT = 20;

function pushUndo(action) {
    undoStack.push(action);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

async function undo() {
    const action = undoStack.pop();
    if (!action) return;
    try {
        if (action.type === "create") {
            // 撤销「新建」：刚建的空文件夹/文件整个移除，坐标由 render() 里的 DSStore.prune 回收。
            // 文件夹已装进东西或文件被占用时如实提示，不为了撤销去删用户后来放进来的数据。
            if (!(await FS.exists(action.path))) return;
            try {
                await FS.remove(action.path, { recursive: false });
            } catch (err) {
                flashHint(i18n.t("desktop.undoCreateBusy", "无法撤销：新建的项目已有内容或已被占用"));
                return;
            }
            await render();
            return;
        }
        if (action.type === "rename") {
            await FS.rename(action.to, FS.baseName(action.from));
        } else if (action.type === "trash") {
            const { putBack } = await import("./trash.js");
            for (const trashPath of action.trashPaths) await putBack(trashPath);
        }
    } catch (err) {
        console.warn("[desktop] 撤销失败：", action.type, err);
    }
}

/* ── 删除（Delete / ⌘Delete / ⇧⌘Delete，确认可被设置关闭） ── */

settings.define({ key: "desktop.confirmDelete", type: "boolean", default: true, owner: "desktop" });

async function confirmDelete(title, message) {
    if (!settings.get("desktop.confirmDelete", true)) return true;
    const dialog = window.__dialog;
    // 删除 / 立即删除都不可逆：初始焦点交给「取消」，回车不会误删
    if (dialog && typeof dialog.confirm === "function") return dialog.confirm(title, message, { danger: true });
    return true;
}

/** Delete：移到废纸篓（可放回原处，可撤销）。 */
async function deleteToTrash(items) {
    if (!items.length) return;
    const names = items.length > 1 ? `${items.length} 个项目` : `“${items[0].name}”`;
    if (!(await confirmDelete(i18n.t("desktop.trashTitle", "移到废纸篓"), i18n.t("desktop.trashConfirm", `${names} 会被移到废纸篓，可从废纸篓恢复。`)))) return;
    const trashPaths = [];
    for (const item of items) {
        const r = await moveToTrash(item.path);
        if (r && r.ok && r.path) trashPaths.push(r.path);
    }
    if (trashPaths.length) pushUndo({ type: "trash", trashPaths });
}

/** ⌘Delete：直接删除（不进废纸篓，不可撤销，必须先确认）。 */
async function deleteDirectly(items) {
    if (!items.length) return;
    const names = items.length > 1 ? `${items.length} 个项目` : `“${items[0].name}”`;
    const ok = await confirmDelete(
        i18n.t("desktop.deleteTitle", "立即删除"),
        i18n.t("desktop.deleteConfirm", `${names} 将立即删除，不经过废纸篓，无法撤销。`)
    );
    if (!ok) return;
    for (const item of items) {
        await FS.remove(item.path, { recursive: true }).catch((err) => console.warn("[desktop] 删除失败：", item.path, err));
    }
}

/* ── 剪贴板（⌘C / ⌘X / ⌘V / ⌘D） ── */

let clipboard = null;   // { mode: 'copy'|'cut', items: [{path,name,type}] }

async function pasteClipboard() {
    if (!clipboard || !clipboard.items.length) return;
    for (const item of clipboard.items) {
        try {
            if (clipboard.mode === "cut") {
                await FS.move(item.path, await uniquePathIn(DESKTOP_PATH, item.name));
            } else {
                await FS.copy(item.path, await uniqueDuplicatePath(DESKTOP_PATH, item.name, item.type));
            }
        } catch (err) {
            console.warn("[desktop] 粘贴失败：", item.path, err);
        }
    }
    // macOS 语义：剪切一次性，粘贴后清空；复制可反复粘贴
    if (clipboard.mode === "cut") clipboard = null;
}

async function duplicateSelection() {
    const items = entries.filter((en) => selected.has(en.path));
    for (const item of items) {
        await FS.copy(item.path, await uniqueDuplicatePath(DESKTOP_PATH, item.name, item.type)).catch((err) => {
            console.warn("[desktop] 制作副本失败：", item.path, err);
        });
    }
}

/* ── 新建文件（右键「新建」子菜单） ── */

async function createUniqueFile(stem, ext, data) {
    const clean = FS.sanitizeName(stem, i18n.t("desktop.untitled", "未命名"));
    const path = await uniquePathIn(DESKTOP_PATH, `${clean}.${ext}`);
    await FS.write(path, data);
    pushUndo({ type: "create", path });   // ⌘Z 可撤掉刚新建的空文件（含 .DS_Store 坐标回收）
    await render();
    if (await placeNewItem(path)) await render();
    const entry = entries.find((e) => e.path === path);
    if (entry) {
        selectOnly(path);
        startRename(entry);
    }
}

const TEMPLATE_BY_KIND = { docx: "empty.docx", xlsx: "empty.xlsx", pptx: "empty.pptx" };

async function newFile(kind) {
    if (kind === "txt") {
        await createUniqueFile(i18n.t("desktop.untitled", "未命名"), "txt", "");
        return;
    }
    // office 空模板：构建期由 office 编解码器生成（dev/gen-empty-templates.mjs），
    // 运行时只 fetch 资产，内核不反向依赖插件代码
    const asset = TEMPLATE_BY_KIND[kind];
    if (!asset) return;
    const res = await fetch(`./assets/templates/${asset}`);
    if (!res.ok) throw new Error(`模板缺失：${asset}（请运行 dev/gen-empty-templates.mjs）`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const stems = { docx: "desktop.newDoc", xlsx: "desktop.newSheet", pptx: "desktop.newSlides" };
    const fallbacks = { docx: "未命名文稿", xlsx: "未命名表格", pptx: "未命名演示" };
    await createUniqueFile(i18n.t(stems[kind], fallbacks[kind]), kind, bytes);
}

/* ── 框选 ── */

let lasso = null;   // { startX, startY, rectEl, additive }

document.addEventListener("mousemove", (e) => {
    if (!lasso) return;
    const x = Math.min(e.clientX, lasso.startX);
    const y = Math.min(e.clientY, lasso.startY);
    const w = Math.abs(e.clientX - lasso.startX);
    const h = Math.abs(e.clientY - lasso.startY);
    Object.assign(lasso.rectEl.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    if (w < 3 && h < 3) return;
    lasso.moved = true;
    const deskRect = desktop.getBoundingClientRect();
    const box = { left: x - deskRect.left, top: y - deskRect.top, right: x - deskRect.left + w, bottom: y - deskRect.top + h };
    if (!lasso.additive) selected.clear();
    for (const [path, el] of itemEls) {
        const r = { left: el.offsetLeft, top: el.offsetTop, right: el.offsetLeft + el.offsetWidth, bottom: el.offsetTop + el.offsetHeight };
        if (r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top) selected.add(path);
    }
    syncSelectionDom();
});

document.addEventListener("mouseup", () => {
    if (!lasso) return;
    lasso.rectEl.remove();
    lasso = null;
});

function isDesktopBackground(target) {
    // .container 是桌面图标格的类名，启动台磁贴也复用它：必须确认这一格真的属于桌面。
    // 否则在启动台里按下图标会被当成「点空白」，拖拽全程在磨砂背景后面画出桌面框选矩形
    // （拖拽结束还会留下被选中的桌面图标，透过启动台背景闪一下）。
    const inDesktop = (el) => !!desktop && desktop.contains(el);
    return target === desktop ||
        (target.classList && (
            (target.classList.contains("container") && inDesktop(target)) ||
            target.classList.contains("wallpaper") ||
            target.classList.contains("desktop")
        )) ||
        (target.closest && target.closest(".dockcontainer") && !target.closest(".dock")) ||
        target === document.body;
}

/* ── 事件绑定 ── */

document.addEventListener("mousedown", (e) => {
    if (!desktop || e.button !== 0) return;
    const itemEl = e.target.closest && e.target.closest(".item");
    if (itemEl && desktop.contains(itemEl)) {
        const entry = entries.find((en) => en.path === itemEl.dataset.path);
        if (!entry) return;
        // 重命名编辑中的点击不触发选中/拖动
        if (e.target.closest("[contenteditable=\"true\"]")) return;
        onItemMouseDown(e, entry);
        if (selected.has(entry.path)) beginDrag(e, entry);
        return;
    }
    if (isDesktopBackground(e.target)) {
        cancelPendingRename();
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey) selectOnly(null);
        const rectEl = document.createElement("div");
        rectEl.className = "desktop-lasso";
        desktop.appendChild(rectEl);
        lasso = { startX: e.clientX, startY: e.clientY, rectEl, additive: e.metaKey || e.ctrlKey, moved: false };
    }
});

document.addEventListener("dblclick", (e) => {
    // 慢速二次单击曾排队的重命名：浏览器仍合成双击时以「打开」为准
    cancelPendingRename();
    const itemEl = e.target.closest && e.target.closest(".item");
    if (!itemEl || !desktop.contains(itemEl)) return;
    if (e.target.closest("[contenteditable=\"true\"]")) return;
    const entry = entries.find((en) => en.path === itemEl.dataset.path);
    if (entry) openItems([entry]);
});

/* ── 键盘 ── */

/** 方向键导航：按元素中心点的方位距离选最近邻（网格与自由摆放通用）。 */
function navigateByArrow(key) {
    if (!entries.length) return;
    const currentPath = [...selected][0] || null;
    const currentEl = currentPath ? itemEls.get(currentPath) : null;
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
    if (!dir) return;
    if (!currentEl) {
        // 无焦点：选渲染序第一项
        selectOnly(entries[0].path);
        return;
    }
    const cur = currentEl.getBoundingClientRect();
    const cx = cur.left + cur.width / 2;
    const cy = cur.top + cur.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const [path, el] of itemEls) {
        if (path === currentPath) continue;
        const r = el.getBoundingClientRect();
        const dx = r.left + r.width / 2 - cx;
        const dy = r.top + r.height / 2 - cy;
        const dot = dx * dir[0] + dy * dir[1];
        if (dot <= 4) continue;   // 不在该方向上
        // 主轴距离 + 横轴惩罚：斜对角的候选排在正方向之后
        const cross = Math.abs(dx * dir[1] - dy * dir[0]);
        const score = dot + cross * 2;
        if (score < bestScore) { bestScore = score; best = path; }
    }
    if (best) selectOnly(best);
}

document.addEventListener("keydown", (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) return;
    // 焦点在任意应用窗口里时不抢桌面快捷键（否则访达里按 ⌘A/⌘I 会同时操作背后的桌面）
    if (e.target && typeof e.target.closest === "function" && e.target.closest(".window")) return;
    const meta = e.metaKey || e.ctrlKey;
    const selItems = entries.filter((en) => selected.has(en.path));

    // ⌘A 全选（不需要选中项）
    if (meta && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        selected.clear();
        entries.forEach((en) => selected.add(en.path));
        syncSelectionDom();
        return;
    }

    // 方向键移动焦点（不需要已选中：从无焦点进第一项）
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) && !meta && !QuickLook.isOpen()) {
        // Quick Look 开着时方向键归它翻页（它走捕获阶段先拦，这里双保险）
        e.preventDefault();
        navigateByArrow(e.key);
        return;
    }

    // ⌘Z 撤销（新建 / 重命名 / 移入废纸篓）：不依赖当前是否有选中项（macOS 同样如此）
    if (meta && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        undo().catch(() => {});
        return;
    }

    if (!selected.size) return;

    // ⌘I 显示简介（与访达/插件共用 core/getInfo.js 的单例面板）
    if (meta && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        GetInfo.open(selItems);
        return;
    }
    // ⌘↑ 打开上级目录（桌面的上级是根目录，与访达「前往」一致）
    if (meta && e.key === "ArrowUp") {
        e.preventDefault();
        openFolder("/");
        return;
    }
    // ⌘C / ⌘X / ⌘V / ⌘D
    if (meta && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        clipboard = { mode: "copy", items: selItems.map((en) => ({ path: en.path, name: en.name, type: en.type })) };
        return;
    }
    if (meta && (e.key === "x" || e.key === "X")) {
        e.preventDefault();
        clipboard = { mode: "cut", items: selItems.map((en) => ({ path: en.path, name: en.name, type: en.type })) };
        return;
    }
    if (meta && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        pasteClipboard().catch(() => {});
        return;
    }
    if (meta && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        duplicateSelection().catch(() => {});
        return;
    }
    // ⌘O / ⌘↓ 打开
    if (meta && (e.key === "o" || e.key === "O" || e.key === "ArrowDown")) {
        e.preventDefault();
        openItems(selItems);
        return;
    }
    // 回车 = 重命名（macOS 语义；打开是 ⌘O/⌘↓）
    if (e.key === "Enter" && selItems.length === 1 && !meta) {
        e.preventDefault();
        startRename(selItems[0]);
        return;
    }
    // ⇧⌘Delete 清空废纸篓（先确认）
    if (meta && e.shiftKey && (e.key === "Backspace" || e.key === "Delete")) {
        e.preventDefault();
        confirmDelete(i18n.t("desktop.emptyTrashTitle", "清倒废纸篓"), i18n.t("desktop.emptyTrashConfirm", "废纸篓里的项目将被永久删除，无法撤销。"))
            .then(async (ok) => {
                if (!ok) return;
                const { emptyTrash } = await import("./trash.js");
                await emptyTrash();
            });
        return;
    }
    // ⌘Delete 直接删除（不进废纸篓）
    if (meta && (e.key === "Backspace" || e.key === "Delete")) {
        e.preventDefault();
        deleteDirectly(selItems).catch(() => {});
        return;
    }
    // Delete 移到废纸篓
    if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        deleteToTrash(selItems).catch(() => {});
        return;
    }
    // 空格：快速查看选中项（Quick Look 开着时由它自己接管空格关闭，见 core/quicklook.js 捕获）
    if (e.key === " " && !QuickLook.isOpen()) {
        e.preventDefault();
        if (selItems.length) QuickLook.open(selItems.map((en) => en.path)).catch(() => {});
    }
});

/* ── 右键菜单 ── */

document.addEventListener("contextmenu", (e) => {
    if (isNativeContextMenuEnabled()) return;
    const itemEl = e.target.closest && e.target.closest(".item");
    if (itemEl && desktop.contains(itemEl)) {
        e.preventDefault();
        e.stopPropagation();
        const entry = entries.find((en) => en.path === itemEl.dataset.path);
        if (!entry) return;
        // macOS：右键已选中项保持多选；右键未选中项=单选它
        if (!selected.has(entry.path)) selectOnly(entry.path);
        const selItems = entries.filter((en) => selected.has(en.path));
        const sel = { location: "desktop", items: selItems, isBackground: false };
        MenuProviders.show(e.clientX, e.clientY, sel, buildFileMenuItems(sel, menuHooks));
        return;
    }
    if (isDesktopBackground(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        selectOnly(null);
        const sel = { location: "desktop", items: [], isBackground: true };
        MenuProviders.show(e.clientX, e.clientY, sel, buildFileMenuItems(sel, menuHooks));
    }
});

const menuHooks = {
    open: (items) => openItems(items),
    quickLook: (items) => QuickLook.open(items.map((en) => en.path)).catch(() => {}),
    getInfo: (items) => GetInfo.open(items),
    rename: (item) => startRename(item),
    newFolder: () => newFolder().catch((err) => console.warn("[desktop] 新建文件夹失败：", err)),
    newFile: (kind) => newFile(kind).catch((err) => {
        console.warn("[desktop] 新建文件失败：", kind, err);
        const dialog = window.__dialog;
        if (dialog) dialog.alert(i18n.t("desktop.newFileFailed", "新建文件失败"), err.message || String(err));
    }),
    sortBy: (field) => { settings.set("desktop.sortBy", field, { source: "desktop" }); scheduleRender(); },
    getSort: () => settings.get("desktop.sortBy", "none"),
    cleanUp: () => { DSStore.clear(DESKTOP_PATH).then(() => scheduleRender()); },
    changeWallpaper: () => { openApp("系统设置").catch(() => {}); },
    refresh: () => scheduleRender(),
};

/* ── 外部文件拖入桌面（浏览器原生拖放 → 写入 /桌面） ── */

["dragenter", "dragleave", "dragend", "dragover"].forEach((ev) =>
    document.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); }));

document.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const items = event.dataTransfer && event.dataTransfer.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind !== "file") continue;
        const file = item.getAsFile && item.getAsFile();
        if (file) persistDroppedFile(file);
    }
});

/** 同名顺延写入 /桌面；图标由 fs-changed 驱动的渲染自动出现。 */
async function persistDroppedFile(file) {
    try {
        const name = OSFS.sanitizeName(file.name, "未命名");
        let dest = FS.joinPath(DESKTOP_PATH, name);
        for (let i = 1; await FS.exists(dest); i++) {
            const stem = name.replace(/\.[^.]+$/, "");
            const ext = name.match(/\.[^.]+$/)?.[0] || "";
            dest = FS.joinPath(DESKTOP_PATH, `${stem} (${i})${ext}`);
        }
        await FS.write(dest, file);
    } catch (err) {
        if (err.code === "EREAUTH") return;   // 权限待补：访达里会提示重新授权
        console.warn("[desktop] 拖入文件写入失败：", file.name, err);
    }
}

/* ── 启动 ── */

FS.watch(DESKTOP_PATH, () => scheduleRender());
OSFS.init().then(() => render()).catch((err) => console.warn("[desktop] 初始化失败：", err));
