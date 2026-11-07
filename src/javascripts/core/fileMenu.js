/**
 * core/fileMenu.js — 桌面与访达共用的内建文件右键菜单（provider 模型的内建 provider）。
 *
 * 条目集合与顺序对齐 macOS（见 reports/plan/存储与访达重构方案.md §5.1）：
 * 选中项：打开 / 打开方式 ▸ / 移到废纸篓 ─ 显示简介 / 重命名 / 压缩… / 复制 / 快速查看 ─
 * 空白处：新建文件夹 ─ 显示简介 ─ 整理方式·排序方式 ▸ / 整理 ─ 更改墙纸…（仅桌面）
 *
 * 界面差异不进本模块：动作全部经 hooks 注入（桌面给真实现，访达后期切换时复用）：
 *   hooks = {
 *     open(items),                 // 「打开」：文件夹导航 / 文件默认应用（调用方路由）
 *     quickLook(items),            // 缺省或未接时「快速查看」置灰（第 3 期接上）
 *     rename(item),                // 单选重命名（行内编辑由界面层实现）
 *     newFolder(withItems),        // 新建文件夹；多选时「用所选项目新建文件夹」
 *     sortBy(field),               // 排序方式子菜单选择回调（缺省则该子菜单不出现）
 *     getSort(),                   // 当前排序字段（勾选标记用）
 *     cleanUp(),                   // 「整理」：清空自由坐标回网格
 *     changeWallpaper(),           // 仅桌面空白处菜单出现
 *     refresh(),                   // 动作完成后刷新（移废纸篓/复制/压缩后）
 *   }
 */

import { i18n } from "../i18n.js";
import { FS } from "../fs/index.js";
import { zipStore } from "../fs/zip.js";
import { moveToTrash } from "../trash.js";
import { openApp } from "../plugin-manager.js";
import { listApps } from "../app-registry.js";
import { acceptingApps, normalizeExtension } from "./appFormats.js";
import * as defaultApps from "../default-apps.js";

const t = (key, fallback) => i18n.t(key, fallback);

/* ── 打开方式 ── */

/**
 * 该扩展名宣称能打开它的全部应用（manifest formats），默认应用排第一并打勾。
 * 判定统一走 core/appFormats.js：与「未知类型选择器」「拖到程序坞」共用同一口径。
 * 导出供 core/openWith.js 复用（同一条候选列表，不再各写一份 formats 判定）。
 */
export function appsForExtension(ext) {
    const bare = normalizeExtension(ext);
    if (!bare) return [];
    const hit = acceptingApps(listApps(), bare);
    const defaultAppId = defaultApps.get(bare);
    hit.sort((a, b) => (a.appId === defaultAppId ? -1 : 0) - (b.appId === defaultAppId ? -1 : 0));
    return hit.map((rec) => ({ appId: rec.appId, name: rec.name || rec.appId, isDefault: rec.appId === defaultAppId }));
}

/** 「打开方式」子菜单条目（⌥ 按下时整项换成「始终以此方式打开」）。 */
function openWithSubItems(sel, hooks, always) {
    const file = sel.items[0];
    const ext = (file.name.match(/\.([^.]+)$/) || [])[1] || "";
    const apps = appsForExtension(ext);
    if (!apps.length) return [{ label: t("menu.openWithNone", "没有可用应用"), disabled: true }];
    return apps.map((app) => ({
        label: app.name + (app.isDefault && !always ? t("menu.openWithDefaultSuffix", "（默认）") : ""),
        action: async () => {
            if (always) {
                try { defaultApps.set(ext, app.appId); }
                catch (err) { console.warn("[fileMenu] 默认应用改绑失败：", err); return; }
            }
            await openApp(app.appId, { file: file.path }).catch((err) => {
                console.warn("[fileMenu] 打开失败：", file.path, err);
            });
            hooks.refresh && hooks.refresh();
        },
    }));
}

/* ── 压缩（ZIP store，Q3：只做「压缩」，替身/共享不出现） ── */

async function zipEntriesFor(items) {
    const entries = [];
    for (const item of items) {
        if (item.type === "folder") {
            const walkIn = async (dir, prefix) => {
                const children = await FS.list(dir);
                if (!children.length) entries.push({ name: `${prefix}/`, data: new Uint8Array(0) });
                for (const child of children) {
                    if (child.type === "folder") await walkIn(child.path, `${prefix}/${child.name}`);
                    else entries.push({ name: `${prefix}/${child.name}`, data: new Uint8Array(await (await FS.read(child.path)).arrayBuffer()) });
                }
            };
            await walkIn(item.path, item.name);
        } else {
            entries.push({ name: item.name, data: new Uint8Array(await (await FS.read(item.path)).arrayBuffer()) });
        }
    }
    return entries;
}

async function compressItems(sel, hooks) {
    const first = sel.items[0];
    const dir = FS.parentOf(first.path);
    const base = sel.items.length === 1 ? first.name.replace(/\.[^.]+$/, "") : t("menu.archiveBase", "归档");
    let name = `${base}.zip`;
    for (let i = 2; await FS.exists(FS.joinPath(dir, name)); i++) name = `${base} ${i}.zip`;
    const bytes = zipStore(await zipEntriesFor(sel.items));
    await FS.write(FS.joinPath(dir, name), bytes);
    hooks.refresh && hooks.refresh();
}

/** 原地复制：a.txt → a 副本.txt（重名顺延 (2)），与 macOS「复制」同语义。 */
async function duplicateItems(sel, hooks) {
    for (const item of sel.items) {
        const dir = FS.parentOf(item.path);
        const dot = item.name.lastIndexOf(".");
        const stem = dot > 0 && item.type !== "folder" ? item.name.slice(0, dot) : item.name;
        const ext = dot > 0 && item.type !== "folder" ? item.name.slice(dot) : "";
        const suffix = t("menu.duplicateSuffix", " 副本");
        let name = `${stem}${suffix}${ext}`;
        for (let i = 2; await FS.exists(FS.joinPath(dir, name)); i++) name = `${stem}${suffix} ${i}${ext}`;
        await FS.copy(item.path, FS.joinPath(dir, name));
    }
    hooks.refresh && hooks.refresh();
}

/* ── 选中项菜单（5.1 表） ── */

function buildSelectionItems(sel, hooks) {
    const multi = sel.items.length > 1;
    const single = sel.items[0];
    const fileOnly = sel.items.every((i) => i.type !== "folder");
    const ext = single && single.type !== "folder" ? (single.name.match(/\.([^.]+)$/) || [])[1] || "" : "";
    const openWithEnabled = sel.items.length === 1 && single.type !== "folder" && appsForExtension(ext).length > 0;

    return [
        { id: "open", label: t("menu.open", "打开"), action: () => hooks.open && hooks.open(sel.items) },
        {
            id: "openWith",
            label: t("menu.openWith", "打开方式"),
            disabled: !openWithEnabled,
            hasSubmenu: openWithEnabled,
            action: (x, y) => import("../core/menuProviders.js").then(({ MenuProviders }) =>
                MenuProviders.show(x, y, sel, openWithSubItems(sel, hooks, false))),
            // ⌥：始终以此方式打开（选中即改绑并打开）
            alt: {
                label: t("menu.alwaysOpenWith", "始终以此方式打开"),
                action: (x, y) => import("../core/menuProviders.js").then(({ MenuProviders }) =>
                    MenuProviders.show(x, y, sel, openWithSubItems(sel, hooks, true))),
            },
        },
        {
            id: "trash",
            label: multi ? t("menu.trashMulti", "移到废纸篓") : t("menu.trash", "移到废纸篓"),
            action: async () => {
                for (const item of sel.items) await moveToTrash(item.path).catch((err) => console.warn("[fileMenu] 移废纸篓失败：", item.path, err));
                hooks.refresh && hooks.refresh();
            },
        },
        { type: "separator" },
        {
            id: "getInfo",
            label: t("menu.getInfo", "显示简介"),
            disabled: !hooks.getInfo,
            action: () => hooks.getInfo && hooks.getInfo(sel.items),
        },
        { id: "rename", label: t("menu.rename", "重命名"), disabled: multi || !hooks.rename, action: () => hooks.rename && hooks.rename(single) },
        {
            id: "compress",
            label: multi ? t("menu.compressMulti", `压缩 ${sel.items.length} 项`) : t("menu.compress", `压缩“${single.name}”`),
            action: () => compressItems(sel, hooks).catch((err) => console.warn("[fileMenu] 压缩失败：", err)),
        },
        { id: "duplicate", label: t("menu.duplicate", "复制"), action: () => duplicateItems(sel, hooks).catch((err) => console.warn("[fileMenu] 复制失败：", err)) },
        { id: "quickLook", label: t("menu.quickLook", "快速查看"), disabled: !fileOnly || !hooks.quickLook, action: () => hooks.quickLook && hooks.quickLook(sel.items) },
    ];
}

/* ── 空白处菜单 ── */

function buildBackgroundItems(sel, hooks) {
    const items = [];
    // 「新建」：桌面给了 newFile 能力时升级为子菜单（文件夹/文本/文稿/表格/演示），
    // 否则保持单项「新建文件夹」（访达就是这条路径）
    if (hooks.newFile) {
        items.push({
            id: "new",
            label: t("menu.new", "新建"),
            hasSubmenu: true,
            action: (x, y) => import("../core/menuProviders.js").then(({ MenuProviders }) =>
                MenuProviders.show(x, y, sel, [
                    { id: "new.folder", label: t("menu.newFolder", "新建文件夹"), action: () => hooks.newFolder && hooks.newFolder([]) },
                    { id: "new.txt", label: t("menu.newText", "新建文本文件"), action: () => hooks.newFile("txt") },
                    { type: "separator" },
                    { id: "new.docx", label: t("menu.newDoc", "新建文稿"), action: () => hooks.newFile("docx") },
                    { id: "new.xlsx", label: t("menu.newSheet", "新建表格"), action: () => hooks.newFile("xlsx") },
                    { id: "new.pptx", label: t("menu.newSlides", "新建演示"), action: () => hooks.newFile("pptx") },
                ])),
        });
    } else {
        items.push({ id: "newFolder", label: t("menu.newFolder", "新建文件夹"), disabled: !hooks.newFolder, action: () => hooks.newFolder && hooks.newFolder([]) });
    }
    // 空白处不出现「显示简介」（macOS 同款：无选中项时没有可简介的对象）
    items.push({ type: "separator" });
    if (hooks.sortBy) {
        const current = hooks.getSort ? hooks.getSort() : "name";
        const fields = [
            ["none", "menu.sortNone", "无"],
            ["name", "menu.sortName", "名称"],
            ["date", "menu.sortDate", "修改日期"],
            ["size", "menu.sortSize", "大小"],
            ["kind", "menu.sortKind", "种类"],
        ];
        items.push({ type: "separator" });
        items.push({
            id: "sortBy",
            label: t("menu.sortBy", "排序方式"),
            hasSubmenu: true,
            action: (x, y) => import("../core/menuProviders.js").then(({ MenuProviders }) =>
                MenuProviders.show(x, y, sel, fields.map(([field, key, fb]) => ({
                    label: t(key, fb),
                    checked: current === field,
                    action: () => hooks.sortBy(field),
                })))),
        });
        if (hooks.cleanUp) {
            items.push({ id: "cleanUp", label: t("menu.cleanUp", "整理"), disabled: current !== "none", action: () => hooks.cleanUp() });
        }
    }
    if (hooks.changeWallpaper) {
        items.push({ type: "separator" });
        items.push({ id: "changeWallpaper", label: t("menu.changeWallpaper", "更改墙纸…"), action: () => hooks.changeWallpaper() });
    }
    return items;
}

/**
 * 内建条目入口：按 sel 形状（空白/选中）分发。
 * @param {object} sel 见 menuProviders.js 文件头
 * @param {object} hooks 见文件头
 */
export function buildFileMenuItems(sel, hooks = {}) {
    return sel.isBackground ? buildBackgroundItems(sel, hooks) : buildSelectionItems(sel, hooks);
}
