/**
 * script.js — 办公套件外壳（多应用插件，Office 2016 Ribbon 形态）：生命周期、Ribbon 装配与命令路由、
 * 文件（Backstage）页、新建 / 打开 / 保存 / 下载 / 打印 / 最近打开、查找替换、快捷键、状态栏。
 * 视图模块（view-*.js）管文档渲染与编辑（ribbon() / command(id, value) / state() / 撤销重做栈）；
 * 编解码（codecs/*.js）管模型 ↔ 文件字节。
 * 约定：视图与编解码首次打开该应用时才 dynamic import（ZIP 整包 0.9MB，视图 + 编解码占大头）；
 * 未知命令先问视图（command 返回 false 才落到外壳），外壳不猜格式语义；
 * 保存默认原地回写来源路径，只有没有来源或格式改变时才落根目录 /文档（文本与 OOXML 同一内核通道），
 * 浏览器下载仅作显式「导出副本」，权限没批如实报「需要重新授权」。
 * 多窗：manifest.multiWindow 放行后，同一应用可开多扇窗口，实例按窗口元素归属（instances 以 win 为键）。
 */

import { useStyle } from "./view-style.js";
import { createRibbon } from "./ribbon.js";
import { confirmDiscardIfDirty } from "./dirty-guard.js";
import { KIND, kindOf, extOf, baseOf, fileName, pickFile, readVfsFile, toBytes, download, saveDocumentFile, rememberRecent, listRecent } from "./office-io.js";
import { TEMPLATES, templateLabel, buildTemplate } from "./templates.js";
import { t } from "./t.js";
import { iconSvg } from "./icons.js";
import { i18n } from "../../src/javascripts/i18n.js";
// Quick Look 预览 provider 注册（只挂注册表，编解码器首次预览时才载入）
import "./quicklook-provider.js";

/** 内核只自动翻 data-i18n（文本），标题栏按钮的 title / aria-label 由这里补一遍。 */
function applyChromeI18n(win) {
    win.querySelectorAll("[data-i18n]").forEach((el) => {
        el.textContent = i18n.t(el.getAttribute("data-i18n"), el.getAttribute("data-i18n-fallback") || el.textContent);
    });
    win.querySelectorAll("[data-i18n-title]").forEach((el) => {
        el.setAttribute("title", i18n.t(el.getAttribute("data-i18n-title"), el.getAttribute("title") || ""));
    });
    win.querySelectorAll("[data-i18n-aria]").forEach((el) => {
        el.setAttribute("aria-label", i18n.t(el.getAttribute("data-i18n-aria"), el.getAttribute("aria-label") || ""));
    });
}

// 功能区与浮层样式由外壳统一装载（manifest 只注入 style.css）
useStyle(import.meta.url, "ribbon.css");

const PLUGIN_ID = "office";
const MENU_KEYS = [
    "officeNewWindow", "officeNewDocument", "officeOpenDocument", "officeSaveDocument", "officeSaveAsDocument",
    "officePrintDocument", "officeFindDocument", "officeUndoDocument", "officeRedoDocument",
];

/** 三个应用的装配配方（blankName 存中文源文，blankKey 供运行时按当前语言取名，切语言不会拿旧值） */
const APPS = {
    "office.word": {
        kind: KIND.DOCX,
        blankName: "未命名文稿", blankKey: "blankWord",
        accepts: [".docx", ".txt"],
        view: () => import("./view-word.js"),
        codec: () => import("./codecs/docx.js"),
    },
    "office.excel": {
        kind: KIND.XLSX,
        blankName: "未命名表格", blankKey: "blankExcel",
        accepts: [".xlsx", ".csv"],
        view: () => import("./view-excel.js"),
        codec: () => import("./codecs/xlsx.js"),
    },
    "office.ppt": {
        kind: KIND.PPTX,
        blankName: "未命名演示", blankKey: "blankPpt",
        accepts: [".pptx"],
        view: () => import("./view-ppt.js"),
        codec: () => import("./codecs/pptx.js"),
    },
};

/** 某应用「新建」时的默认文档主干名（按当前语言取）。 */
const blankNameFor = (appId) => t(APPS[appId].blankKey, APPS[appId].blankName);

/** 窗口元素 -> 实例；同一 appId 可多开，实例必须按窗口归属，不能按 appId 互相覆盖 */
const instances = new Map();
/** appId -> 最近绑定的窗口元素（顶栏菜单命令按应用定位用） */
const lastWindow = new Map();
/** appId -> 装配中的窗口待打开文件队列（多窗时按窗口装配顺序逐个消费） */
const pending = new Map();

/* ───────────────────────── 编解码适配 ───────────────────────── */

/**
 * 把三种格式的差异收敛成 parse / build / blank 三个动作。
 * @param {string} appId 应用 id
 * @param {string} kind 格式种类
 * @returns {Promise<{saveKind:string, blank:Function, parse:Function, build:Function}>} 适配器
 */
async function adapter(appId, kind) {
    const codec = await APPS[appId].codec();
    if (appId === "office.excel") {
        const asCsv = kind === KIND.CSV;
        return {
            saveKind: asCsv ? KIND.CSV : KIND.XLSX,
            blank: () => codec.emptySheet(),
            parse: asCsv ? (bytes, text) => codec.parseCsv(text)[0] : (bytes) => codec.parseXlsx(bytes).then((w) => w.sheets[0]),
            build: asCsv ? (model) => codec.buildCsv(model) : (model) => codec.buildXlsx([model]),
        };
    }
    if (appId === "office.word") {
        const asText = kind === KIND.TXT;
        return {
            saveKind: asText ? KIND.TXT : KIND.DOCX,
            blank: () => codec.emptyDocx(),
            parse: asText
                ? (bytes, text) => ({ blocks: text.split(/\r?\n/).map((line) => ({ kind: "paragraph", text: line })) })
                : (bytes) => codec.parseDocx(bytes),
            build: asText ? (model) => model.blocks.map((b) => b.text).join("\n") : (model) => codec.buildDocx(model.blocks || model, model.page),
        };
    }
    return {
        saveKind: KIND.PPTX,
        blank: () => ({ slides: [codec.emptySlide()], page: { size: "16:9" } }),
        parse: (bytes) => codec.parsePptx(bytes),
        build: (model) => codec.buildPptx(model.slides || model, model.page),
    };
}

/** 下载用 MIME */
const MIME = {
    [KIND.DOCX]: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    [KIND.XLSX]: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    [KIND.PPTX]: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    [KIND.CSV]: "text/csv",
    [KIND.TXT]: "text/plain",
};

/* ───────────────────────── 实例装配 ───────────────────────── */

/**
 * 装配一个应用窗口：视图 → 功能区 → 命令路由 → 快捷键。
 * @param {HTMLElement} win 窗口根元素
 * @param {string} appId 应用 id
 * @returns {Promise<void>}
 */
async function bindApp(win, appId) {
    const recipe = APPS[appId];
    if (!recipe) return;
    applyChromeI18n(win);

    const inst = {
        appId,
        win,
        name: blankNameFor(appId),
        /** 当前文档的来源 VFS 路径：保存时写回这里；空串表示没有可回写的来源（本地选择器 / 新建） */
        path: "",
        kind: recipe.kind,
        dirty: false,
        view: null,
        ribbon: null,
        find: null,
        listeners: [],
        titleEl: win.querySelector(".office-doctitle"),
        dirtyEl: win.querySelector(".office-dirty"),
        fileEl: win.querySelector('[data-role="filename"]'),
        metricEl: win.querySelector('[data-role="metric"]'),
        noteEl: win.querySelector('[data-role="note"]'),
        viewEl: win.querySelector('[data-role="view"]'),
        ribbonEl: win.querySelector('[data-role="ribbon"]'),
        qat: win.querySelector(".office-qat"),
    };

    // 快速访问工具栏换成与功能区同一套 Material Symbols 图标；
    // HTML 里的文本字形只作脚本失效时的兜底，注入成功后清掉避免叠字
    if (inst.qat) {
        inst.qat.querySelectorAll("[data-qat]").forEach((btn) => {
            const svg = iconSvg(btn.dataset.qat);
            if (!svg) return;
            btn.textContent = "";
            btn.appendChild(svg);
        });
    }

    const module = await recipe.view();
    inst.view = module.createView(inst.viewEl, {
        onInput: () => { setDirty(inst, true); syncRibbon(inst); },
        onSelectionChange: () => syncRibbon(inst),
    });

    inst.ribbon = createRibbon(inst.ribbonEl, {
        onCommand: (id, value) => runCommand(inst, id, value),
        onTabChange: () => syncRibbon(inst),
        getFileTab: () => ({ label: t("fileTab", "文件"), items: fileTabItems(inst) }),
    });

    on(inst, inst.qat, "click", (e) => {
        const btn = e.target.closest("[data-qat]");
        if (!btn) return;
        runCommand(inst, "file:" + btn.dataset.qat, undefined);
    });
    on(inst, inst.win, "keydown", (e) => onShortcut(inst, e));

    instances.set(win, inst);
    lastWindow.set(appId, win);
    await newDocument(inst);
    syncRibbon(inst);

    // 多窗时每个新窗口消费一个待打开文件；窗口装配与文件事件是异步并行的
    const queued = pending.get(appId);
    if (queued && queued.length) {
        const file = queued.shift();
        if (!queued.length) pending.delete(appId);
        openByPath(inst, file);
    }
}

/** 在实例生命周期内注册监听，dispose 时统一摘除 */
function on(inst, node, type, handler) {
    node.addEventListener(type, handler);
    inst.listeners.push({ node, type, handler });
}

/* ───────────────────────── 命令路由 ───────────────────────── */

/**
 * 执行一条命令：先给视图（格式化类），视图不认的再走外壳（文件类）。
 * @param {object} inst 实例
 * @param {string} id 命令 id
 * @param {string|undefined} value 下拉控件的取值
 * @returns {void}
 */
function runCommand(inst, id, value) {
    if (!inst.view) return;
    if (id.startsWith("file:")) {
        handleFileCommand(inst, id.slice(5), value);
        return;
    }
    let handled = false;
    try {
        handled = inst.view.command(id, value) !== false;
    } catch (err) {
        note(inst, t("statusCommandFail", "命令失败：{error}").replace("{error}", err && err.message ? err.message : String(err)));
        console.warn(`[office] ${inst.appId} 命令 ${id} 失败`, err);
    }
    if (!handled) {
        note(inst, t("statusCommandUnimpl", "未实现的命令：{id}").replace("{id}", id));
        return;
    }
    // 脏标记只认真改动：内容 / 格式改动由各视图经 onInput 上报，缩放、段落标记、
    // 冻结行列、放映这类视图态命令不该把文档标脏（选区变化走 onSelectionChange，也不算改动）
    syncRibbon(inst);
}

/** 文件（Backstage）标签项：固定动作 + 模板 + 最近打开 */
function fileTabItems(inst) {
    const items = [
        { id: "file:new", label: t("fileNew", "新建"), hint: "⌘N" },
        { id: "file:newWindow", label: t("fileNewWindow", "新建窗口"), hint: "" },
    ];
    (TEMPLATES[inst.appId] || []).forEach((tp) => {
        items.push({ id: "file:template", label: t("fileNewFromTemplate", "新建自模板：{name}").replace("{name}", templateLabel(inst.appId, tp.id)), value: tp.id });
    });
    items.push(
        { id: "file:open", label: t("fileOpen", "打开…"), hint: "⇧⌘O" },
        { id: "file:save", label: t("fileSave", "保存"), hint: "⌘S" },
        { id: "file:download", label: t("fileDownload", "下载副本"), hint: "⇧⌘S" },
        { id: "file:print", label: t("filePrint", "打印 / 导出 PDF"), hint: "⌘P" },
        { id: "file:find", label: t("fileFind", "查找与替换"), hint: "⌘F" },
    );
    listRecent(inst.appId).slice(0, 5).forEach((r, i) => {
        if (r.path) items.push({ id: "file:recent", label: r.name, hint: r.path, value: String(i) });
    });
    items.push({ id: "file:close", label: t("fileClose", "关闭窗口"), hint: "⌘W" });
    return items;
}

/** 文件类命令实现 */
function handleFileCommand(inst, action, value) {
    switch (action) {
        case "new": guard(inst, () => newDocument(inst)); break;
        case "newWindow": guard(inst, () => openNewWindow(inst.appId)); break;
        case "template": guard(inst, () => applyTemplate(inst, value)); break;
        case "open": openByPicker(inst); break;
        case "save": guard(inst, () => saveDocument(inst)); break;
        case "download": guard(inst, () => downloadDocument(inst)); break;
        case "print": printDocument(inst); break;
        case "find": toggleFind(inst); break;
        case "undo": doUndo(inst); break;
        case "redo": doRedo(inst); break;
        case "close": if (typeof inst.win._closeWindow === "function") inst.win._closeWindow(); break;
        case "recent": {
            const rec = listRecent(inst.appId)[Number(value) || 0];
            if (rec && rec.path) openByPath(inst, rec.path);
            break;
        }
        default: note(inst, t("statusFileCmdUnknown", "未知的文件命令：{action}").replace("{action}", action));
    }
}

/**
 * 另开一个本应用窗口。必须走内核 Deskly.apps.launch 的多窗准入闸（manifest.multiWindow:true），
 * 插件不自己造窗口：未声明时内核会以信封 ok:false 拒绝，这里如实报到状态栏。
 * @param {string} appId 应用 id
 * @returns {Promise<void>}
 */
async function openNewWindow(appId) {
    const api = window.Deskly;
    if (!api || !api.apps || typeof api.apps.launch !== "function") throw new Error("窗口服务未就绪");
    const env = await api.apps.launch(appId, { newWindow: true });
    if (env && env.ok === false) throw new Error(env.reason || "窗口系统拒绝新窗口");
}

/** 快捷键：浏览器保留键（⌘W / ⌘M）不拦，其余按 Office 习惯 */
function onShortcut(inst, e) {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = (e.key || "").toLowerCase();
    const shift = e.shiftKey;
    const map = {
        s: shift ? "download" : "save",
        p: "print",
        f: "find",
        n: "new",
        o: shift ? "open" : null,
        z: shift ? "redo" : "undo",
        y: "redo",
    };
    const action = map[key];
    if (!action) return;
    e.preventDefault();
    handleFileCommand(inst, action);
}

/* ───────────────────────── 状态与绘制 ───────────────────────── */

/** 刷新标题栏、状态栏与 QAT 可用态 */
function paint(inst) {
    if (inst.titleEl) inst.titleEl.textContent = baseOf(inst.name) || t("unnamed", "未命名");
    if (inst.dirtyEl) inst.dirtyEl.hidden = !inst.dirty;
    if (inst.fileEl) {
        inst.fileEl.hidden = false;
        inst.fileEl.textContent = `${inst.name}（${extOf(inst.name) || t("newLabel", "新建")}）`;
    }
    if (inst.metricEl) inst.metricEl.textContent = inst.view ? inst.view.metric() : "";
    if (inst.qat) {
        const undoBtn = inst.qat.querySelector('[data-qat="undo"]');
        const redoBtn = inst.qat.querySelector('[data-qat="redo"]');
        if (undoBtn) undoBtn.disabled = !(inst.view && inst.view.canUndo && inst.view.canUndo());
        if (redoBtn) redoBtn.disabled = !(inst.view && inst.view.canRedo && inst.view.canRedo());
    }
}

/** 把视图声明的标签页与控件状态灌进功能区 */
function syncRibbon(inst) {
    if (!inst.ribbon || !inst.view) return;
    const tabs = typeof inst.view.ribbon === "function" ? inst.view.ribbon() : [];
    const state = typeof inst.view.state === "function" ? inst.view.state() : {};
    inst.ribbon.render(tabs, state);
    inst.ribbon.update(state);
}

/** 标记脏 / 干净并重绘 */
function setDirty(inst, dirty) {
    inst.dirty = dirty;
    paint(inst);
}

/** 状态栏提示 */
function note(inst, text) {
    if (inst.noteEl) inst.noteEl.textContent = text;
}

/* ───────────────────────── 文档动作 ───────────────────────── */

/**
 * 覆盖性入口的公共闸：当前文档有未保存改动时先三选（保存并继续 / 不保存 / 取消），
 * 取消或保存失败都返回 false —— 调用方必须原样中止，留在当前文档。
 * @param {object} inst 实例
 * @returns {Promise<boolean>} true = 可以继续覆盖
 */
function confirmDiscard(inst) {
    return confirmDiscardIfDirty(inst, () => saveDocument(inst));
}

/** 新建空白文档 */
async function newDocument(inst) {
    if (!(await confirmDiscard(inst))) return;
    const ad = await adapter(inst.appId, APPS[inst.appId].kind);
    inst.kind = ad.saveKind;
    inst.name = fileName(inst.kind, blankNameFor(inst.appId));
    inst.path = "";
    inst.view.clear();
    inst.dirty = false;
    note(inst, t("statusBlank", "空白文档"));
    paint(inst);
    inst.view.focus();
}

/**
 * 新建自模板：装入模板初始模型，按模板名命名（仍是未保存的新文档，与「新建」同口径）。
 * @param {object} inst 实例
 * @param {string} templateId 模板 id
 * @returns {Promise<void>}
 */
async function applyTemplate(inst, templateId) {
    const model = buildTemplate(inst.appId, templateId);
    if (!model) return;
    if (!(await confirmDiscard(inst))) return;
    const ad = await adapter(inst.appId, APPS[inst.appId].kind);
    inst.kind = ad.saveKind;
    inst.name = fileName(inst.kind, templateLabel(inst.appId, templateId));
    inst.path = "";
    openFindGuard(inst);
    inst.view.load(model);
    inst.dirty = false;
    note(inst, t("statusTemplate", "已按模板新建：{name}").replace("{name}", templateLabel(inst.appId, templateId)));
    paint(inst);
    syncRibbon(inst);
    inst.view.focus();
}

/** 解析字节并载入 */
async function openBytes(inst, bytes, name, path) {
    const kind = kindOf(name);
    if (kind === KIND.UNKNOWN) throw new Error(t("statusUnsupportedType", "不支持的文件类型：{ext}").replace("{ext}", `.${extOf(name) || name}`));
    const ad = await adapter(inst.appId, kind);
    const text = kind === KIND.TXT || kind === KIND.CSV ? new TextDecoder("utf-8").decode(bytes) : null;
    const model = await ad.parse(bytes, text);
    inst.kind = ad.saveKind;
    inst.name = name;
    inst.path = path || "";
    inst.view.load(model);
    inst.dirty = false;
    note(inst, path ? t("statusOpened", "已打开 {path}").replace("{path}", path) : t("statusOpenedLocal", "已打开本地文件"));
    paint(inst);
    syncRibbon(inst);
    if (name) rememberRecent(inst.appId, { name, path: path || "", kind: inst.kind });
}

/** 工具栏「打开…」：系统文件选择器 */
async function openByPicker(inst) {
    if (!(await confirmDiscard(inst))) return;
    const file = await pickFile(APPS[inst.appId].accepts);
    if (!file) return;
    await guard(inst, async () => { openFindGuard(inst); await openBytes(inst, await toBytes(file), file.name, ""); });
}

/** 访达「打开方式」递进来的内核路径 */
async function openByPath(inst, path) {
    if (!(await confirmDiscard(inst))) return;
    await guard(inst, async () => {
        const file = await readVfsFile(path);
        if (!file) {
            note(inst, t("statusReadFail", "读不到文件（不存在或已移动）：{path}").replace("{path}", path));
            return;
        }
        await openBytes(inst, await toBytes(file), file.name || path.split("/").pop(), path);
    });
}

/**
 * 保存当前文档。
 * @param {object} inst 实例
 * @returns {Promise<boolean>} 是否真正落盘（确认闸「保存并继续」靠它决定能不能往下走：
 *   false = 留在当前文档，调用方不得继续覆盖性操作）
 */
async function saveDocument(inst) {
    let saved = false;
    await guard(inst, async () => { saved = await persistDocument(inst); });
    return saved;
}

/** 实际写盘一次：失败原因进状态栏并返回 false，不假装成功 */
async function persistDocument(inst) {
    const ad = await adapter(inst.appId, inst.kind);
    const data = await ad.build(inst.view.read());
    const name = fileName(inst.kind, baseOf(inst.name));
    const result = await saveDocumentFile(name, data, inst.kind, inst.path);
    if (!result.ok) {
        note(inst, result.reauth
            ? t("statusSaveReauth", "保存失败：根目录权限需要重新授权")
            : t("statusSaveFail", "保存失败：{error}").replace("{error}", result.error || t("statusUnknownError", "未知错误")));
        return false;
    }
    inst.name = name;
    // 落点即新的文档来源：原地回写后与打开路径一致，落到 /文档后指向那份副本
    inst.path = result.path || "";
    setDirty(inst, false);
    note(inst, result.inPlace
        ? t("statusSaved", "已保存：{path}").replace("{path}", result.path)
        : t("statusSavedCopy", "已保存到「文档」：{path}（原文件未改动）").replace("{path}", result.path));
    rememberRecent(inst.appId, { name, path: inst.path, kind: inst.kind });
    return true;
}

/** 下载一份副本（不改当前文档名） */
async function downloadDocument(inst) {
    await guard(inst, async () => {
        const ad = await adapter(inst.appId, inst.kind);
        const data = await ad.build(inst.view.read());
        const name = fileName(inst.kind, baseOf(inst.name));
        download(name, data, MIME[inst.kind]);
        note(inst, t("statusExported", "已导出副本（浏览器下载）：{name}").replace("{name}", name));
    });
}

/**
 * 打印 / 导出 PDF：给 <html> 挂打印标记，只留目标窗口的文档区在纸上。
 * @param {object} inst 实例
 * @returns {void}
 */
function printDocument(inst) {
    const root = document.documentElement;
    const cleanup = () => {
        root.classList.remove("office-printing");
        inst.win.classList.remove("office-print-target");
        window.removeEventListener("afterprint", cleanup);
    };
    root.classList.add("office-printing");
    inst.win.classList.add("office-print-target");
    window.addEventListener("afterprint", cleanup);
    // afterprint 在部分环境不触发：留一个兜底，别把打印类永久留在文档上
    setTimeout(cleanup, 4000);
    window.print();
}

/** 撤销 / 重做（视图持有栈） */
function doUndo(inst) {
    if (inst.view.canUndo && inst.view.canUndo()) { inst.view.undo(); setDirty(inst, true); syncRibbon(inst); }
}
function doRedo(inst) {
    if (inst.view.canRedo && inst.view.canRedo()) { inst.view.redo(); setDirty(inst, true); syncRibbon(inst); }
}

/* ───────────────────────── 查找与替换 ───────────────────────── */

/**
 * 打开 / 关闭查找替换浮层。
 * @param {object} inst 实例
 * @returns {void}
 */
function toggleFind(inst) {
    if (inst.find) { closeFind(inst); return; }
    const box = document.createElement("div");
    box.className = "office-find";

    const mkRow = () => { const r = document.createElement("div"); r.className = "office-find-row"; box.appendChild(r); return r; };
    const mkInput = (placeholder) => { const i = document.createElement("input"); i.placeholder = placeholder; return i; };
    const mkBtn = (label, handler, cls = "rb-btn") => { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = label; b.addEventListener("click", handler); return b; };

    const findRow = mkRow();
    const findInput = mkInput(t("findPlaceholder", "查找"));
    const countEl = document.createElement("span");
    countEl.className = "office-find-count";
    findRow.append(findInput, countEl);

    const replRow = mkRow();
    const replInput = mkInput(t("replacePlaceholder", "替换为"));
    replRow.append(replInput, mkBtn(t("replaceAll", "替换全部"), () => doReplace(findInput, replInput, inst, countEl)));

    const actionRow = mkRow();
    actionRow.append(mkBtn(t("findPrev", "上一个"), () => doSeek(findInput, inst, countEl, -1)));
    actionRow.append(mkBtn(t("findNext", "下一个"), () => doSeek(findInput, inst, countEl, 1)));
    actionRow.append(mkBtn(t("count", "计数"), () => countMatches(findInput, inst, countEl)));
    actionRow.append(mkBtn(t("close", "关闭"), () => closeFind(inst)));

    findInput.addEventListener("input", () => countMatches(findInput, inst, countEl));
    box.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { closeFind(inst); return; }
        // 查找框里回车 = 下一个，Shift+回车 = 上一个（与 Office / 浏览器查找一致）
        if (e.key === "Enter" && e.target === findInput) {
            e.preventDefault();
            doSeek(findInput, inst, countEl, e.shiftKey ? -1 : 1);
        }
    });

    inst.win.appendChild(box);
    inst.find = { box, findInput };
    findInput.focus();
    countMatches(findInput, inst, countEl);
}

/** 关闭浮层 */
function closeFind(inst) {
    if (!inst.find) return;
    inst.find.box.remove();
    inst.find = null;
}

/** 打开新文档前收掉浮层，避免计数指向旧模型 */
function openFindGuard(inst) { closeFind(inst); }

/**
 * 在模型里统计命中数（不依赖视图实现搜索）。
 * @param {HTMLInputElement} findInput 查找输入
 * @param {object} inst 实例
 * @param {HTMLElement} out 计数显示元素
 * @returns {void}
 */
function countMatches(findInput, inst, out) {
    const q = findInput.value;
    if (!q) { out.textContent = ""; return; }
    let hits = 0;
    const model = inst.view.read();
    walkText(inst.appId, model, (text) => { hits += countOccurrences(text, q); return text; });
    out.textContent = q ? t("matches", "{n} 处").replace("{n}", String(hits)) : "";
}

/**
 * 查找导航：交给视图的 seek()（各视图自己决定怎么定位与选中），
 * 老视图没有 seek 时退化为只计数，不报错。
 * @param {HTMLInputElement} findInput 查找输入
 * @param {object} inst 实例
 * @param {HTMLElement} out 计数显示元素
 * @param {number} dir 1 向下，-1 向上
 * @returns {void}
 */
function doSeek(findInput, inst, out, dir) {
    const q = findInput.value;
    if (!q || !inst.view || typeof inst.view.seek !== "function") return;
    const hit = inst.view.seek(q, dir);
    out.textContent = hit ? "" : t("noMatch", "无匹配");
}

/** 替换全部命中 */
function doReplace(findInput, replInput, inst, out) {
    const q = findInput.value;
    if (!q) return;
    let changed = 0;
    inst.view.applyEdit((model) => {
        walkText(inst.appId, model, (text) => {
            const n = countOccurrences(text, q);
            changed += n;
            return text.split(q).join(replInput.value);
        });
    });
    out.textContent = t("replaced", "{n} 处已替换").replace("{n}", String(changed));
    setDirty(inst, true);
    syncRibbon(inst);
}

/** 统计一段文本里子串出现次数（区分大小写，逐字扫描不做正则转义问题） */
function countOccurrences(text, needle) {
    if (!text || !needle) return 0;
    let n = 0;
    let i = String(text).indexOf(needle);
    while (i !== -1) { n++; i = String(text).indexOf(needle, i + needle.length); }
    return n;
}

/**
 * 遍历三种模型里所有可编辑文本，就地替换。
 * 视图负责结构，外壳只认这份模型形状约定（与编解码一致）。
 * @param {string} appId 应用 id
 * @param {object} model 文档模型
 * @param {(text: string) => string} fn 文本映射
 * @returns {void}
 */
function walkText(appId, model, fn) {
    if (appId === "office.word") {
        (model.blocks || []).forEach((b) => { b.text = fn(b.text || ""); });
        return;
    }
    if (appId === "office.excel") {
        (model.rows || []).forEach((row) => row.forEach((cell, i) => { row[i] = fn(cell == null ? "" : String(cell)); }));
        return;
    }
    (model.slides || []).forEach((s) => {
        s.title = fn(s.title || "");
        s.bullets = (s.bullets || []).map((t) => fn(t));
        if (Array.isArray(s.bulletsRight)) s.bulletsRight = s.bulletsRight.map((t) => fn(t));
    });
}

/** 统一异常出口：错误进状态栏，不冒泡成未捕获异常 */
async function guard(inst, fn) {
    try {
        await fn();
    } catch (err) {
        console.warn(`[office] ${inst.appId} 操作失败：`, err);
        note(inst, t("statusFail", "失败：{error}").replace("{error}", err && err.message ? err.message : String(err)));
    }
}

/** 取目标实例：菜单命令带 appId 时用该应用最近绑定的窗口（多窗下即最靠后打开的那扇），否则用最后打开的 */
function targetInstance(appId) {
    const win = appId ? lastWindow.get(appId) : null;
    const inst = win ? instances.get(win) : null;
    if (inst) return inst;
    const all = Array.from(instances.values());
    return all[all.length - 1];
}

/* ───────────────────────── 顶栏菜单命令 ───────────────────────── */

const commands = {
    officeNewWindow: (appId) => { const id = appId || (targetInstance() || {}).appId; if (id) openNewWindow(id).catch((err) => console.warn("[office] 新建窗口失败：", err)); },
    officeNewDocument: (appId) => { const i = targetInstance(appId); if (i) guard(i, () => newDocument(i)); },
    officeOpenDocument: (appId) => { const i = targetInstance(appId); if (i) openByPicker(i); },
    officeSaveDocument: (appId) => { const i = targetInstance(appId); if (i) guard(i, () => saveDocument(i)); },
    officeSaveAsDocument: (appId) => { const i = targetInstance(appId); if (i) guard(i, () => downloadDocument(i)); },
    officePrintDocument: (appId) => { const i = targetInstance(appId); if (i) printDocument(i); },
    officeFindDocument: (appId) => { const i = targetInstance(appId); if (i) toggleFind(i); },
    officeUndoDocument: (appId) => { const i = targetInstance(appId); if (i) doUndo(i); },
    officeRedoDocument: (appId) => { const i = targetInstance(appId); if (i) doRedo(i); },
};

/* ───────────────────────── 生命周期 ───────────────────────── */

function onAppLoad(e) {
    const { id, appId, el } = e.detail || {};
    if (id !== PLUGIN_ID || !el || instances.has(el)) return;
    bindApp(el, appId).catch((err) => console.warn("[office] 装配应用失败：", appId, err));
}

function onAppOpen(e) {
    const { id, appId, file } = e.detail || {};
    if (id !== PLUGIN_ID || !file) return;
    const inst = targetInstance(appId);
    if (!inst) {
        const queue = pending.get(appId) || [];
        queue.push(file);
        pending.set(appId, queue);
        return;
    }
    openFindGuard(inst);
    openByPath(inst, file);
}

/**
 * 内核按 appId 广播卸载，而同一应用可能有多扇窗口：关闭的那扇此刻已从 DOM 摘除，
 * 因而按「不再连接」精准释放它自己的实例，其余窗口与外壳都不受影响（NW-7）。
 */
function onAppUnload(e) {
    const { id } = e.detail || {};
    if (id !== PLUGIN_ID) return;
    instances.forEach((inst, win) => {
        if (win.isConnected === false) {
            disposeInstance(inst);
            instances.delete(win);
            if (lastWindow.get(inst.appId) === win) lastWindow.delete(inst.appId);
        }
    });
}

function disposeInstance(inst) {
    inst.listeners.forEach(({ node, type, handler }) => node.removeEventListener(type, handler));
    inst.listeners = [];
    closeFind(inst);
    if (inst.ribbon) inst.ribbon.destroy();
    inst.ribbon = null;
    if (inst.view) {
        if (inst.view.dispose) inst.view.dispose();
        inst.view = null;
    }
}

function onUnload(e) {
    if ((e.detail || {}).id !== PLUGIN_ID) return;
    instances.forEach((inst, win) => {
        disposeInstance(inst);
        instances.delete(win);
    });
    lastWindow.clear();
    pending.clear();
    document.removeEventListener("plugin-app-load", onAppLoad);
    document.removeEventListener("plugin-app-open", onAppOpen);
    document.removeEventListener("plugin-app-unload", onAppUnload);
    document.removeEventListener("plugin-unload", onUnload);
    document.removeEventListener("languagechange", onLanguageChange);
    MENU_KEYS.forEach((key) => {
        if (window.__menuActions && window.__menuActions[key] === commands[key]) delete window.__menuActions[key];
    });
}

/** 切换语言：外壳文案即时重绘（标题栏、状态栏、功能区标签/分组）。 */
function onLanguageChange() {
    instances.forEach((inst) => {
        applyChromeI18n(inst.win);
        paint(inst);
        if (inst.ribbon) inst.ribbon.rebuild();   // id 结构没变但标签变了，作废结构缓存逼一次全量重画
        syncRibbon(inst);
    });
}

document.addEventListener("plugin-app-load", onAppLoad);
document.addEventListener("plugin-app-open", onAppOpen);
document.addEventListener("plugin-app-unload", onAppUnload);
document.addEventListener("plugin-unload", onUnload);
document.addEventListener("languagechange", onLanguageChange);
window.__menuActions = window.__menuActions || {};
MENU_KEYS.forEach((key) => { window.__menuActions[key] = commands[key]; });
