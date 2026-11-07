/**
 * dev/desktop-interaction-check.mjs — 桌面交互专项探针（第 2 期补测）。
 *
 * 两类断言：
 *  1) 运行时断言：简介面板的纯函数（大小/日期/种类/多选汇总）与内建右键菜单装配
 *     （「新建」子菜单存在、⌘I 条目可用性随 hooks 变化）。
 *  2) 源码级断言：双击链路的契约——mousedown 期间不得改动 DOM（否则 dblclick 合不成）、
 *     拖动必须越过 4px 阈值、dblclick 必须调 openItems、键盘覆盖清单齐全、
 *     打开文件夹必须派发 finder-command{navigate}。
 *     「第一次点击不重建节点」这类时序证据是源码契约 + 真机抓事件序列才能完全证明，
 *     本探针给出可量化的一半；剩余部分标注「需真机确认」。
 *
 * 用法：`node dev/desktop-interaction-check.mjs`
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ── 最小环境替身（只为 import 链站起来，不测界面渲染） ── */

globalThis.indexedDB = {
    open() {
        const map = new Map();
        const db = {
            objectStoreNames: { contains: () => false },
            createObjectStore: () => ({ put() {}, get() {}, getAll() {}, delete() {} }),
            close() {},
            transaction() {
                const tx = { error: null, objectStore: () => ({ put() {}, get() {}, getAll() {}, delete() {} }) };
                queueMicrotask(() => tx.oncomplete?.());
                return tx;
            },
        };
        const req = { result: db };
        queueMicrotask(() => req.onsuccess?.());
        return req;
    },
};
class FakeObserver {
    observe() {} disconnect() {} unobserve() {} takeRecords() { return []; }
}
globalThis.MutationObserver = FakeObserver;
globalThis.ResizeObserver = FakeObserver;
globalThis.IntersectionObserver = FakeObserver;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.window = {
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    location: { href: "http://localhost/", origin: "http://localhost" },
    navigator: { userAgent: "node" },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
/** 通用假元素：够 import 链与防御性 init 用，不承担真实渲染。 */
function makeEl() {
    const el = {
        style: {}, dataset: {}, hidden: false, innerHTML: "", textContent: "",
        children: [],
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        appendChild(child) { el.children.push(child); return child; },
        append() {}, remove() {}, setAttribute() {}, getAttribute: () => null,
        querySelector: () => null, querySelectorAll: () => [],
        closest: () => null, focus() {}, blur() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
    };
    return el;
}
const fakeRoot = makeEl();
globalThis.document = {
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    getElementById: () => fakeRoot,
    createElement: () => makeEl(),
    querySelector: () => null, querySelectorAll: () => [],
    body: makeEl(),
    documentElement: makeEl(),
};
const LS = new Map();
globalThis.localStorage = {
    getItem: (k) => (LS.has(k) ? LS.get(k) : null),
    setItem: (k, v) => LS.set(k, v),
    removeItem: (k) => LS.delete(k),
};

let fails = 0;
let count = 0;
const eq = (label, got, want) => {
    count++;
    const a = JSON.stringify(got), b = JSON.stringify(want);
    if (a !== b) { fails++; console.log(`FAIL ${label}\n  got  ${a}\n  want ${b}`); }
};
const ok = (label, cond) => {
    count++;
    if (!cond) { fails++; console.log(`FAIL ${label}`); }
};

/* ══ 一、简介面板纯函数 ══ */

const { formatSize, formatDate, describeKind, summarize } = await import("../src/javascripts/core/getInfo.js");

eq("formatSize 0", formatSize(0), "0 字节");
eq("formatSize 999", formatSize(999), "999 字节");
eq("formatSize 1000", formatSize(1000), "1.0 KB");
eq("formatSize 1500", formatSize(1500), "1.5 KB");
eq("formatSize 1.5MB", formatSize(1500000), "1.5 MB");
eq("formatSize 空值", formatSize(null), "—");
eq("formatDate 0", formatDate(0), "—");
ok("formatDate 正常值格式", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(formatDate(1700000000000)));
eq("describeKind 文件夹", describeKind({ type: "folder", name: "a" }), "文件夹");
ok("describeKind docx", describeKind({ type: "file", name: "a.docx" }).includes("Word"));
ok("describeKind 未知扩展名", describeKind({ type: "file", name: "a.zzz" }).includes("ZZZ"));

const oneFolder = summarize([{ name: "abc", type: "folder", path: "/桌面/abc", size: null, modified: null }]);
eq("summarize 单选 title", oneFolder.title, "abc");
eq("summarize 单选 size", oneFolder.size, "—");
eq("summarize 单选 where", oneFolder.where, "/桌面");
eq("summarize 单选 mod", oneFolder.mod, "—");

const three = summarize([
    { name: "a.txt", type: "file", path: "/桌面/a.txt", size: 1000, modified: 1 },
    { name: "b.txt", type: "file", path: "/桌面/b.txt", size: 2000, modified: 1 },
    { name: "c.txt", type: "file", path: "/桌面/c.txt", size: 3000, modified: 1 },
]);
eq("summarize 多选 title", three.title, "3 个项目");
eq("summarize 多选 size", three.size, "6.0 KB");
eq("summarize 多选 where", three.where, "/桌面");

/* ══ 二、内建右键菜单（新建子菜单 / 显示简介可点） ══ */

const { buildFileMenuItems } = await import("../src/javascripts/core/fileMenu.js");

const selOne = { location: "desktop", items: [{ name: "a.txt", type: "file", path: "/桌面/a.txt" }], isBackground: false };
let infoCalled = 0;
const items = buildFileMenuItems(selOne, { getInfo: () => { infoCalled++; } });
const infoItem = items.find((i) => i.id === "getInfo");
ok("选中态显示简介条目存在", !!infoItem);
eq("有 hooks 时简介可用", infoItem.disabled, false);
infoItem.action();
eq("简介 action 被调用", infoCalled, 1);

const noHooks = buildFileMenuItems(selOne, {});
eq("无 hooks 时简介置灰", noHooks.find((i) => i.id === "getInfo").disabled, true);

const bg = { location: "desktop", items: [], isBackground: true };
const bgItems = buildFileMenuItems(bg, { newFolder: () => {}, newFile: () => {} });
eq("桌面空白第一项是「新建」", bgItems[0].id, "new");
eq("「新建」是子菜单", bgItems[0].hasSubmenu, true);
const bgNoFile = buildFileMenuItems(bg, { newFolder: () => {} });
eq("无 newFile 时退回单项新建文件夹", bgNoFile[0].id, "newFolder");

/* ══ 三、源码级契约（双击链路 / 拖动阈值 / 键盘覆盖） ══ */

const desktopSrc = readFileSync(join(ROOT, "src/javascripts/desktop.js"), "utf8");

/** 截取函数体（按第一个 { 起配平括号）。 */
function bodyOf(src, signature) {
    const start = src.indexOf(signature);
    if (start < 0) return "";
    const open = src.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    return "";
}

const beginDragBody = bodyOf(desktopSrc, "function beginDrag(e, entry)");
ok("beginDrag 存在", beginDragBody.length > 0);
ok("beginDrag 不重建节点（无 appendChild）", !beginDragBody.includes("appendChild"));
ok("beginDrag 不写 position（按下不动 DOM）", !beginDragBody.includes(".style.position"));

ok("拖动阈值 4px 存在", desktopSrc.includes("Math.hypot(dx, dy) > 4"));
ok("阈值判断先于 DOM 改动", desktopSrc.indexOf("Math.hypot(dx, dy) > 4") < desktopSrc.indexOf('it.el.style.position = "absolute"'));
ok("纯点击（未移动）不拖动，但排队慢速重命名", desktopSrc.includes("if (!current.moved) { armPendingRename(); return; }"));

const dblBody = bodyOf(desktopSrc, 'document.addEventListener("dblclick"');
ok("dblclick 监听存在", dblBody.length > 0);
ok("dblclick 调 openItems", dblBody.includes("openItems([entry])"));

const openFolderBody = bodyOf(desktopSrc, "function openFolder(path)");
ok("打开文件夹派发 finder-command", openFolderBody.includes('"finder-command"'));
ok("navigate 参数带路径", openFolderBody.includes('command: "navigate", args: { path }'));

// 键盘覆盖清单：每条都要求源码里出现对应的 key 判定
const keyboardCases = [
    ["⌘A 全选", ['e.key === "a" || e.key === "A"']],
    ["方向键", ['"ArrowLeft"', '"ArrowDown"']],
    ["⌘Z 撤销", ['e.key === "z" || e.key === "Z"']],
    ["⌘C", ['e.key === "c" || e.key === "C"']],
    ["⌘X", ['e.key === "x" || e.key === "X"']],
    ["⌘V", ['e.key === "v" || e.key === "V"']],
    ["⌘D", ['e.key === "d" || e.key === "D"']],
    ["⌘O", ['e.key === "o" || e.key === "O"']],
    ["⌘I", ['e.key === "i" || e.key === "I"']],
    ["⌘↑", ['e.key === "ArrowUp"']],
    ["Enter 重命名", ['e.key === "Enter"']],
    ["Delete 进废纸篓", ['e.key === "Backspace" || e.key === "Delete"']],
    ["⇧⌘Delete 清倒", ["e.shiftKey && (e.key"]],
    ["空格预览", ['e.key === " "']],
];
for (const [label, needles] of keyboardCases) {
    ok(`键盘覆盖：${label}`, needles.some((n) => desktopSrc.includes(n)));
}

// 非法字符正则不得含不可见控制字符（曾因 \u001f 导致 Range out of order）
const regexLine = desktopSrc.split("\n").find((l) => l.startsWith("const ILLEGAL_NAME_CHARS"));
ok("非法字符正则行存在", !!regexLine);
ok("非法字符正则无控制字符", ![...regexLine].some((ch) => ch.charCodeAt(0) < 0x20));
eq("非法字符正则内容", regexLine.trim(), 'const ILLEGAL_NAME_CHARS = /[\\\\/:*?"<>|]/;');

// 新建条目：立即可重命名 + 不重叠（唯一名与选中后进重命名）
ok("新建后立即进入重命名", desktopSrc.includes("startRename(entry)"));
ok("新建走唯一名顺延", desktopSrc.includes("uniquePathIn(DESKTOP_PATH"));
ok("新建落位避开已有图标", desktopSrc.includes("async function placeNewItem") && desktopSrc.includes("if (!overlaps(box))"));
ok("新建落位写 .DS_Store 坐标", desktopSrc.includes("DSStore.setPosition(DESKTOP_PATH"));

// 复制粘贴 / 制作副本：重名一律加「副本」后缀，不落 (1)
ok("粘贴重名用副本命名", desktopSrc.includes("uniqueDuplicatePath(DESKTOP_PATH, item.name, item.type)"));
ok("副本后缀默认「副本」", desktopSrc.includes('i18n.t("desktop.duplicateSuffix", "副本")'));
ok("副本顺延带序号", desktopSrc.includes("index > 1 ? ` ${index}`"));

// 选择/框选/删除/重命名的行为契约
ok("框选矩形用 desktop-lasso", desktopSrc.includes('"desktop-lasso"'));
ok("框选支持 ⌘ 追加", desktopSrc.includes("additive: e.metaKey || e.ctrlKey"));
ok("拖到废纸篓进回收站", desktopSrc.includes('"#dock-trash"') && desktopSrc.includes("moveToTrash"));
ok("⌥ 拖拽复制", desktopSrc.includes("e.altKey"));
ok("拖放目标高亮", desktopSrc.includes("highlightDropTarget"));
ok("重命名 Esc 取消不回写", desktopSrc.includes("finish(false)"));
ok("删除确认可被设置关闭", desktopSrc.includes('settings.get("desktop.confirmDelete", true)'));
ok("撤销覆盖重命名与废纸篓", desktopSrc.includes('action.type === "rename"') && desktopSrc.includes('action.type === "trash"'));
ok("键盘不抢应用窗口里的按键", desktopSrc.includes('e.target.closest(".window")'));

/* ══ 三·补、四项收尾（未知类型选择器 / 拖到程序坞 / 撤销新建 / 慢速二次单击） ══ */

/* 1) 扩展名判定单一口径（纯函数） */
const { normalizeExtension, formatsOf, acceptsExtension, acceptsItems, acceptingApps } =
    await import("../src/javascripts/core/appFormats.js");
eq("扩展名归一 .TXT", normalizeExtension(".TXT"), "txt");
eq("formatsOf 多应用插件", formatsOf({ app: { formats: [".txt", ".MD"] } }), ["txt", "md"]);
eq("formatsOf 单应用根级声明", formatsOf({ app: null, manifest: { formats: ["docx"] } }), ["docx"]);
eq("formatsOf 无声明", formatsOf({}), []);
ok("acceptsExtension 命中（忽略点与大小写）", acceptsExtension({ app: { formats: [".txt"] } }, "TXT"));
ok("acceptsExtension 未命中", !acceptsExtension({ app: { formats: [".txt"] } }, "md"));
ok("acceptsItems 文件夹一律不接受", !acceptsItems({ app: { formats: ["txt"] } }, [
    { name: "a.txt", type: "file" }, { name: "dir", type: "folder" },
]));
ok("acceptsItems 空列表不接受", !acceptsItems({ app: { formats: ["txt"] } }, []));
eq("acceptingApps 只留声明命中的", acceptingApps([
    { appId: "a", app: { formats: ["txt"] } },
    { appId: "b", app: { formats: ["md"] } },
], "txt").map((r) => r.appId), ["a"]);

/* 2) 「打开方式」选择器：候选、单例、勾选写默认应用 */
const { OpenWith, candidatesFor } = await import("../src/javascripts/core/openWith.js");
const { appsForExtension } = await import("../src/javascripts/core/fileMenu.js");
eq("未知扩展名在无插件时无候选", candidatesFor("zzz"), []);
eq("空扩展名无候选", candidatesFor(""), []);
eq("打开方式子菜单与选择器同一候选口径", appsForExtension(".zzz"), []);
const openWithSrc = readFileSync(join(ROOT, "src/javascripts/core/openWith.js"), "utf8");
ok("选择器有「始终用」勾选框", openWithSrc.includes('type="checkbox"'));
ok("勾选写 default-apps", openWithSrc.includes("defaultApps.set(currentExt, appId)"));
ok("选择器单例复用面板", openWithSrc.includes("if (!panel)") && openWithSrc.includes("panel.root.hidden = false"));
ok("选择器 Esc 关闭", openWithSrc.includes('e.key === "Escape"'));
ok("选择器打开期间压住桌面快捷键", openWithSrc.includes("e.stopPropagation()"));

const openItemsBody = bodyOf(desktopSrc, "function openItems(items)");
ok("未知类型双击弹选择器", openItemsBody.includes("OpenWith.open(item.path)"));
ok("未知类型走选择器而不是预览", openItemsBody.indexOf("OpenWith.open(item.path)") > openItemsBody.indexOf("const rec = getAppByExtension"));
ok("Quick Look 只保留快捷方式损坏时的回退", openItemsBody.indexOf("QuickLook.open") < openItemsBody.indexOf("const rec = getAppByExtension"));
ok("已知类型仍走关联应用", openItemsBody.includes("getAppByExtension"));
const menuSrc = readFileSync(join(ROOT, "src/javascripts/core/fileMenu.js"), "utf8");
ok("右键「打开方式」复用 appsForExtension", menuSrc.includes("export function appsForExtension"));
ok("打开方式候选走统一 formats 判定", menuSrc.includes("acceptingApps(listApps()"));

/* 3) 拖到程序坞应用图标：可接受才高亮/打开，拒绝给轻提示 */
const highlightBody = bodyOf(desktopSrc, "function highlightDropTarget(e)");
ok("高亮判定含程序坞应用图标", highlightBody.includes('"#dock .container[data-app]"'));
ok("高亮前先看应用是否接受", highlightBody.includes("dockVerdict("));
const dropBody = bodyOf(desktopSrc, "async function handleDrop(e, current)");
ok("松手时按应用接受度打开", dropBody.includes("dockVerdict(") && dropBody.includes("openApp(verdict.appId"));
ok("拒绝时给一次轻提示（不静默）", dropBody.includes("flashHint(verdict.reason)"));
const verdictBody = bodyOf(desktopSrc, "function dockVerdict(appName, items)");
ok("接受度判定走 acceptsItems", verdictBody.includes("acceptsItems(rec, list)"));
ok("文件夹拖到应用被拒", verdictBody.includes('item.type === "folder"'));
ok("废纸篓判定先于程序坞空白兜底", dropBody.indexOf('"#dock-trash"') < dropBody.indexOf('over.closest("#dock")) return'));
ok("轻提示是一次性气泡（有自动淡出）", desktopSrc.includes('hintEl.className = "desktop-hint"') && desktopSrc.includes("2400"));

/* 4) 撤销「新建」：压栈两次 + 非递归删除 + 渲染回收坐标 */
eq("新建压栈次数（文件夹 + 文件）", (desktopSrc.match(/pushUndo\(\{ type: "create", path \}\)/g) || []).length, 2);
const undoBody = bodyOf(desktopSrc, "async function undo()");
ok("撤销新建分支存在", undoBody.includes('action.type === "create"'));
ok("撤销删除不递归（非空拒绝）", undoBody.includes("recursive: false"));
ok("撤销成功后再渲染（触发 DSStore.prune）", undoBody.includes("await render();"));
ok("撤销失败如实提示", undoBody.includes("desktop.undoCreateBusy"));
ok("⌘Z 不依赖选中项（撤掉新建后还能继续撤）", desktopSrc.indexOf('e.key === "z"') < desktopSrc.indexOf("if (!selected.size) return;"));

/* 5) 慢速二次单击重命名：可配置时间窗 + 与双击不打架 */
ok("时间窗是设置项", desktopSrc.includes('key: "desktop.slowClickRenameMs"'));
ok("默认 500ms", desktopSrc.includes('default: 500, owner: "desktop"'));
ok("间隔比较用时间窗", desktopSrc.includes("gap >= slowClickMs()"));
ok("要求同一项且原已选中", desktopSrc.includes("wasSelected && sameItem"));
ok("仅唯一选中项才改名", desktopSrc.includes("selected.size !== 1"));
ok("dblclick 取消排队重命名", dblBody.includes("cancelPendingRename()"));
ok("延迟先让 dblclick 到达", desktopSrc.includes("const RENAME_ARM_DELAY_MS = 150;"));

/* 6) 样式与入口接线 */
ok("选择器样式已接入 index.html", readFileSync(join(ROOT, "index.html"), "utf8").includes("openwith.css"));
ok("轻提示样式存在", readFileSync(join(ROOT, "assets/stylesheets/main/desktop-view.css"), "utf8").includes(".desktop-hint"));

/* ══ 四、插件收口：三个插件不得直连引擎 ══ */

const ENGINE_IMPORT = /from\s+['"][^'"]*(osfs|vfs|trash|quicklook|menuProviders|fs\/index|fs\/zip|fs\/dsstore|fs\/errors)[^'"]*['"]/;
const filesOf = (dir) => {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...filesOf(p));
        else if (name.endsWith(".js")) out.push(p);
    }
    return out;
};
for (const plugin of ["finder", "office", "photos"]) {
    const offenders = filesOf(join(ROOT, "mods", plugin)).filter((p) => ENGINE_IMPORT.test(readFileSync(p, "utf8")));
    ok(`插件 ${plugin} 不直连引擎模块`, offenders.length === 0);
    if (offenders.length) console.log("  违规：", offenders.map((p) => p.replace(ROOT + "\\", "")));
}

/* ══ 结果 ══ */

console.log(`\n${count - fails}/${count} 通过`);
process.exit(fails ? 1 : 0);
