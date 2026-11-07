/**
 * view-ppt.js — 演示视图：左侧缩略图列 + 右侧幻灯片纸面 + Office 2016 功能区（ribbon/command/state 契约）。
 * 页模型与 codecs/pptx.js 同一形状（本模块不 import，只按字段读写）：
 *   Slide = { title, bullets: string[], bulletsRight: string[],
 *             layout: "titleContent"|"titleOnly"|"blank"|"twoColumn",
 *             background/color/titleColor: "#RRGGBB"|null, size: number|null,
 *             images: Array<{src: string, width: number, height: number, x: number, y: number}>,
 *             notes: string, transition: "none"|"fade"|"push"|"wipe" }
 * 草稿与模型分离：编辑态允许空行，read()/切页/结构变更时才经 normalizeBullets() 压回模型。
 * 放映为窗口内只读覆盖层（不用浏览器全屏 API），键盘翻页，全程不写模型。
 * 文案一律走 t('ppt.键', '中文原句') 且只在调用时现取（模块级常量只存 [键, 原句]），切语言即时生效。
 */

import { el, useStyle } from "./view-style.js";
import { t } from "./t.js";
import { pickImage } from "./office-io.js";

/**
 * 把文案里的 `{name}` 占位符换成实际值：内核 i18n 只回字符串，插值在这一层做。
 * 语言包漏配时中文原句同样带着 `{name}`，所以两种情况都能填。
 * @param {string} text 当前语言文案
 * @param {Object} values 占位符取值
 * @returns {string} 填好的文案
 */
function fill(text, values) {
    const map = values || {};
    return String(text).replace(/\{(\w+)\}/g, (whole, name) => (
        Object.prototype.hasOwnProperty.call(map, name) ? String(map[name]) : whole
    ));
}

/* ══════════════ 不依赖 DOM 的导出纯函数（探针脚本直接 import 校验） ══════════════ */

/**
 * 要点数组规范化：按换行拆成多条、逐条去掉首尾空白、丢掉全空条目。
 * 内部空格保留，只吃首尾。
 * @param {Array<*>} raw 原始条目（容忍 null / 非字符串）
 * @returns {string[]} 规范化后的条目
 */
export function normalizeBullets(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    for (const item of list) {
        for (const piece of String(item == null ? "" : item).split(/\r?\n/)) {
            const line = piece.trim();
            if (line) out.push(line);
        }
    }
    return out;
}

/**
 * 数组项移动：返回新数组，越界（含非整数）时顺序不动，原数组不被修改。
 * @param {Array<*>} arr 原数组
 * @param {number} from 源下标
 * @param {number} to 目标下标
 * @returns {Array<*>} 移动后的副本
 */
export function moveItem(arr, from, to) {
    const out = Array.isArray(arr) ? arr.slice() : [];
    const n = out.length;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return out;
    if (from < 0 || from >= n || to < 0 || to >= n) return out;
    if (from === to) return out;
    const [item] = out.splice(from, 1);
    out.splice(to, 0, item);
    return out;
}

/** 版式取值（与 codecs/pptx.js 的 LAYOUT_SHAPE 同名） */
const LAYOUT_IDS = ["titleContent", "titleOnly", "blank", "twoColumn"];

/**
 * 版式迁移：把一页搬到下一版式，返回新对象（不修改入参）。规则：
 * 1. **要点永不删除**——没有正文占位符的版式（titleOnly / blank）也原样留着 `bullets`，
 *    只是纸面不渲染、编辑区隐藏，切回 titleContent / twoColumn 时字还在。
 *    导出时编解码按 `LAYOUT_SHAPE` 丢弃无正文占位符的要点，与 PowerPoint 一致。
 * 2. **进双栏**：把当前要点顺序平分——前半（奇数时左栏多一条，即 `Math.ceil(n/2)`）
 *    进左栏 `bullets`，后半进右栏 `bulletsRight`，先后顺序不变。
 * 3. **出双栏**：左右按「左栏 + 右栏」拼回 `bullets`，`bulletsRight` 清空
 *    （编解码侧 `bulletsRight` 也只在 twoColumn 下保留，两边口径一致）。
 * 4. 同版式互切（含重复选同一个）不动内容，只回一份副本：双栏 → 双栏**保留手工分好的
 *    左右两栏**，不再重新均分；只有**离开**双栏（并回左栏）或**从别处进**双栏才重分。
 * 5. title / background / color / titleColor / size / images / notes / transition 原样带走。
 * @param {object} slide 当前页
 * @param {string} nextLayout 目标版式
 * @returns {{title: string, bullets: string[], bulletsRight: string[], layout: string,
 *            background: string|null, color: string|null, titleColor: string|null, size: number|null}} 新页
 */
export function migrateLayout(slide, nextLayout) {
    const src = slide || {};
    const from = LAYOUT_IDS.indexOf(src.layout) >= 0 ? src.layout : "titleContent";
    const to = LAYOUT_IDS.indexOf(nextLayout) >= 0 ? nextLayout : from;
    const left = normalizeBullets(src.bullets);
    const right = normalizeBullets(src.bulletsRight);
    // 源是双栏时先把两栏并回去，保证任何方向都不会丢条目
    const all = from === "twoColumn" ? left.concat(right) : left;
    // 双栏 → 双栏（含重复选同一个版式）＝已经分好栏了，原样留着 left / right，不再重新均分
    const staysInTwo = from === "twoColumn" && to === "twoColumn";
    let bullets = staysInTwo ? left : all;
    let bulletsRight = staysInTwo ? right : [];
    if (to === "twoColumn" && !staysInTwo) {
        const half = Math.ceil(all.length / 2);
        bullets = all.slice(0, half);
        bulletsRight = all.slice(half);
    }
    return {
        title: String(src.title == null ? "" : src.title),
        bullets,
        bulletsRight,
        layout: to,
        background: src.background == null ? null : src.background,
        color: src.color == null ? null : src.color,
        titleColor: src.titleColor == null ? null : src.titleColor,
        size: src.size == null ? null : src.size,
        images: normalizeViewImages(src.images),
        notes: typeof src.notes === "string" ? src.notes : "",
        transition: normalizeTransition(src.transition),
    };
}

/** 切换效果枚举；未知/缺省一律 none（与 codecs/pptx.js 同口径） */
const TRANSITIONS = ["none", "fade", "push", "wipe"];

/** 切换效果规整 */
function normalizeTransition(value) {
    return TRANSITIONS.includes(value) ? value : "none";
}

/** 切换效果下拉的 `[取值, 语言包键, 中文原句]` */
const TRANSITION_TEXT = [
    ["none", "ppt.transitionNone", "无"],
    ["fade", "ppt.transitionFade", "淡出"],
    ["push", "ppt.transitionPush", "推进"],
    ["wipe", "ppt.transitionWipe", "擦除"],
];

/** 切换效果下拉：标签每次现取，切语言即时生效 */
function transitionOptions() {
    return TRANSITION_TEXT.map(([value, key, zh]) => ({ value, label: t(key, zh) }));
}

/** 亮度阈值：加权和低于它判为深色背景（见 pickTextColor 注释） */
const DARK_LUMA = 150;
/** 深色背景上的文字色 */
const TEXT_ON_DARK = "#FFFFFF";
/** 浅色背景上的文字色 */
const TEXT_ON_LIGHT = "#1D1D1F";

/**
 * 背景 "#RRGGBB" → [r,g,b]（0..255）；非法输入返回 null。
 * @param {string|null} hex 背景色
 * @returns {number[]|null} 三分量
 */
function hexToRgb(hex) {
    if (typeof hex !== "string") return null;
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 对比度派生：给定背景色，挑一个读得清的前景色。
 * 亮度用 ITU-R BT.601 / YIQ 加权和 `L = 0.299R + 0.587G + 0.114B`（0..255 标度），
 * **阈值取 150**（不是中点 128）：留出中灰以上那一段余量，
 * 于是 白 #FFFFFF(255) / 米黄 #FFF2CC(242) / 浅灰 #EDEDED(237) / 浅蓝 #DEEAF6(232)
 * 稳定走深字 #1D1D1F，深灰 #404040(64) / 黑 #000000(0) 走白字 #FFFFFF。
 * 背景为 null 或不是 #RRGGBB 时返回 null（= 不派生，交回主题色）。
 * @param {string|null} bgHex 页面背景
 * @returns {string|null} "#RRGGBB" 前景色，或 null
 */
export function pickTextColor(bgHex) {
    const rgb = hexToRgb(bgHex);
    if (!rgb) return null;
    const luma = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    return luma < DARK_LUMA ? TEXT_ON_DARK : TEXT_ON_LIGHT;
}

/* ══════════════ 控件取值表 ══════════════ */

/**
 * 版式名的原料表：只存 `[语言包键, 中文原句]`，文案由 layoutLabel() 每次现取。
 * 常量里不存译好的字符串，切语言后缩略图角标 / 状态栏才会跟着变。
 */
const LAYOUT_TEXT = {
    titleContent: ["ppt.layoutTitleContent", "标题和内容"],
    titleOnly: ["ppt.layoutTitleOnly", "仅标题"],
    blank: ["ppt.layoutBlank", "空白"],
    twoColumn: ["ppt.layoutTwoColumn", "双栏"],
};

/**
 * 取一个版式的显示名（每次调用都重新查语言包，未知版式回空串）。
 * @param {string} layout 版式 id
 * @returns {string} 当前语言下的版式名
 */
function layoutLabel(layout) {
    const text = LAYOUT_TEXT[layout];
    return text ? t(text[0], text[1]) : "";
}

/** 版式下拉：功能区每次重画都重新生成，标签跟着语言走 */
function layoutOptions() {
    return LAYOUT_IDS.map((v) => ({ value: v, label: layoutLabel(v) }));
}

/** 正文字号档位（磅）；模型里存数字，导出时编解码按 6..200 取值 */
const SIZE_VALUES = [14, 18, 24, 32];

/** 字号下拉：档位数字不动，只有「{n} 磅」这个单位文案要翻 */
function sizeOptions() {
    return SIZE_VALUES.map((v) => ({ value: v, label: fill(t("ppt.sizePoints", "{n} 磅"), { n: v }) }));
}

/** 前景色取值：`[色值, 键, 中文原句]`；"" = 回到"自动（不写色，继承主题）"，即模型里的 null */
const COLOR_SWATCHES = [
    ["", "ppt.colorAuto", "自动"],
    ["#1D1D1F", "ppt.colorCharcoal", "深灰黑"],
    ["#404040", "ppt.colorDarkGray", "深灰"],
    ["#2B579A", "ppt.colorBlue", "蓝"],
    ["#E2762C", "ppt.colorPresentOrange", "演示橙"],
    ["#1F9E5A", "ppt.colorGreen", "绿"],
    ["#C00000", "ppt.colorRed", "红"],
    ["#FFFFFF", "ppt.colorWhite", "白"],
];

/** 前景色下拉（正文色 / 标题色共用） */
function colorOptions() {
    return COLOR_SWATCHES.map(([value, key, zh]) => ({ value, label: t(key, zh) }));
}

/** 背景取值：六档预设写 #RRGGBB，"" 表示清成 null（继承主题） */
const BACKGROUND_SWATCHES = [
    ["", "ppt.bgNone", "无（继承主题）"],
    ["#FFFFFF", "ppt.bgWhite", "白"],
    ["#FFF2CC", "ppt.bgCream", "米黄"],
    ["#EDEDED", "ppt.bgLightGray", "浅灰"],
    ["#DEEAF6", "ppt.bgLightBlue", "浅蓝"],
    ["#404040", "ppt.bgDarkGray", "深灰"],
    ["#000000", "ppt.bgBlack", "黑"],
];

/** 背景下拉 */
function backgroundOptions() {
    return BACKGROUND_SWATCHES.map(([value, key, zh]) => ({ value, label: t(key, zh) }));
}

/**
 * 字号换算：纸面 / 放映画面的宽度就是幻灯片宽度（13.333in = 960pt），
 * 于是 1pt = 100/960 cqw，模型里的磅数按容器宽度等比缩放（窗口再窄也只是变小，不裁字）。
 */
const CQW_PER_PT = 100 / 960;
/**
 * 正文字号的行内取值：没选字号就回 CSS 默认（= 继承版式，返回空串不覆盖），
 * 选了就把磅数等比换算成 cqw（14 / 18 / 24 / 32 磅各档都如实反映在纸面上），
 * 只留一个 11px 的屏显兜底防止窗口极窄时看不见；模型里的磅数原样进出。
 * @param {number|null} size 模型里的磅数
 * @returns {string} CSS font-size 值（空串 = 不覆盖）
 */
function bodyFontSize(size) {
    const pt = Number(size);
    if (!Number.isFinite(pt) || pt <= 0) return "";
    return "max(11px, " + (pt * CQW_PER_PT).toFixed(3) + "cqw)";
}

const HISTORY_MAX = 60;
const TEXT_COALESCE_MS = 400;

/* ══════════════ 模型洗数据 ══════════════ */

/**
 * 颜色字段归一：只认 #RRGGBB，其余（含空串）一律 null。
 * @param {*} value 原始值
 * @returns {string|null} "#RRGGBB"（大写）或 null
 */
function normalizeColorField(value) {
    const rgb = hexToRgb(value);
    if (!rgb) return null;
    return String(value).trim().toUpperCase();
}

/**
 * 字号归一：非 6..200 的数（编解码同口径）落回 null = 继承版式。
 * @param {*} value 原始值
 * @returns {number|null} 磅数
 */
function normalizeSize(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 6 && n <= 200 ? Math.round(n) : null;
}

/** 图片缺失尺寸时的兜底（px），与 office-io 取自然尺寸失败时的兜底一致 */
const IMAGE_FALLBACK_W = 200;
const IMAGE_FALLBACK_H = 150;
/** 图片坐标基准画布（px，96dpi）：与 codecs/pptx.js 的 960×540 同口径 */
const IMAGE_CANVAS_W = 960;
const IMAGE_CANVAS_H = 540;
/** 旧图缺 x/y 时的默认排布：x=40，y=120 + 索引*16 */
const IMAGE_DEFAULT_X = 40;
const IMAGE_DEFAULT_Y = 120;
const IMAGE_DEFAULT_STEP = 16;

/** 坐标规整：非有限数用兜底值，再夹到 [0, max] */
function normalizeViewCoord(value, fallback, max) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : fallback;
}

/**
 * 规整页内图片数组：坏项丢弃、宽高兜底、缺 x/y 给默认排布；
 * 缺省/非数组一律 []（兼容旧文档）。
 * @param {unknown} list 原始数组
 * @returns {Array<{src: string, width: number, height: number, x: number, y: number}>} 图片项
 */
function normalizeViewImages(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
        const img = raw || {};
        if (typeof img.src !== "string" || !img.src) continue;
        const w = Number(img.width);
        const h = Number(img.height);
        const width = Number.isFinite(w) && w > 0 ? Math.max(1, Math.round(w)) : IMAGE_FALLBACK_W;
        const height = Number.isFinite(h) && h > 0 ? Math.max(1, Math.round(h)) : IMAGE_FALLBACK_H;
        out.push({
            src: img.src,
            width: Math.min(IMAGE_CANVAS_W, width),
            height: Math.min(IMAGE_CANVAS_H, height),
            x: normalizeViewCoord(img.x, IMAGE_DEFAULT_X, IMAGE_CANVAS_W),
            y: normalizeViewCoord(img.y, IMAGE_DEFAULT_Y + out.length * IMAGE_DEFAULT_STEP, IMAGE_CANVAS_H),
        });
    }
    return out;
}

/**
 * 把一页洗成视图内部形态（缺字段补默认，未知版式退回 titleContent，颜色 / 字号只认约定值）。
 * @param {object} raw 外来页
 * @returns {object} 内部页
 */
function normalizeSlide(raw) {
    const s = raw || {};
    const layout = LAYOUT_IDS.indexOf(s.layout) >= 0 ? s.layout : "titleContent";
    return {
        title: String(s.title == null ? "" : s.title),
        bullets: normalizeBullets(s.bullets),
        // 右栏条目只在双栏下有意义（与编解码同口径）
        bulletsRight: layout === "twoColumn" ? normalizeBullets(s.bulletsRight) : [],
        layout,
        background: normalizeColorField(s.background),
        color: normalizeColorField(s.color),
        titleColor: normalizeColorField(s.titleColor),
        size: normalizeSize(s.size),
        images: normalizeViewImages(s.images),
        notes: typeof s.notes === "string" ? s.notes : "",
        transition: normalizeTransition(s.transition),
    };
}

/** 空白文档：只有一页，标题与要点都空 */
function blankModel() {
    return { slides: [normalizeSlide({})] };
}

/**
 * 把外来模型洗成视图内部形态（深拷贝，编辑不污染调用方）。
 * @param {object} m 外来模型
 * @returns {{ slides: object[] }} 内部模型
 */
function cloneModel(m) {
    const slides = ((m || {}).slides || []).map(normalizeSlide);
    return { slides: slides.length ? slides : blankModel().slides };
}

/** 版式有没有正文占位符（要点行有没有地方放） */
function layoutHasBody(slide) {
    const layout = (slide || {}).layout;
    return layout === "titleContent" || layout === "twoColumn";
}

/**
 * 建一个演示视图。
 * @param {HTMLElement} viewEl 外壳给的容器（`.office-canvas > .office-view`）
 * @param {{ onInput?: () => void, onSelectionChange?: () => void }} [opts] 内容变化 / 选中变化回调
 * @returns {{load: Function, read: Function, clear: Function, focus: Function, dispose: Function,
 *            metric: Function, ribbon: Function, command: Function, state: Function,
 *            canUndo: Function, canRedo: Function, undo: Function, redo: Function, applyEdit: Function}} 视图句柄
 */
export function createView(viewEl, opts) {
    useStyle(import.meta.url, "view-ppt.css");

    const hooks = opts || {};
    const onInput = typeof hooks.onInput === "function" ? hooks.onInput : () => {};
    const onSelectionChange = typeof hooks.onSelectionChange === "function" ? hooks.onSelectionChange : () => {};
    const doc = viewEl.ownerDocument || (typeof document !== "undefined" ? document : null);

    /* 监听登记表：注册与 dispose 逐条对账用，全部只注册一次（行 / 缩略图走事件委托） */
    const bound = [];
    const listen = (node, type, handler, options) => {
        node.addEventListener(type, handler, options);
        bound.push([node, type, handler, options]);
    };

    let model = blankModel();
    let index = 0;
    let draft = { title: "", bullets: [], bulletsRight: [] };
    /** 纸张尺寸（16:9 / 4:3）：属于文档内容，随文件保存、重新打开还原 */
    let pageSize = "16:9";
    /** 放映层句柄（{ layer, stage, count, hint, exitBtn, page, bound, saved, canvas, prevFocus }），没在放映时为 null */
    let present = null;
    let disposed = false;

    /* ── 骨架 ── */
    const root = el("div", "ppt");
    const side = el("div", "ppt-side");
    const tools = el("div", "ppt-tools");
    const thumbList = el("div", "ppt-thumbs");
    const main = el("div", "ppt-main");
    const sheet = el("div", "ppt-sheet");
    const titleInput = el("input", "ppt-title");
    titleInput.type = "text";
    /** 纸面图片层：铺满纸面，按模型 x/y/宽高绝对定位，每张可拖动、带删除按钮 */
    const picsBox = el("div", "ppt-pics");
    const bodyBox = el("div", "ppt-body");
    const bulletsBox = el("div", "ppt-bullets");
    const rightBox = el("div", "ppt-bullets ppt-bullets-right");
    bodyBox.append(bulletsBox, rightBox);
    const addBullet = el("button", "ppt-addbullet");
    addBullet.type = "button";
    const addBulletRight = el("button", "ppt-addbullet ppt-addbullet-right");
    addBulletRight.type = "button";
    const bodyNote = el("p", "ppt-note");
    /** 演讲者备注：纸面下方的纯文本编辑区，随当前页切换，内容写进 slide.notes 并持久化 */
    const notesBox = el("div", "ppt-notes");
    const notesLabel = el("label", "ppt-notes-label");
    const notesInput = el("textarea", "ppt-notes-input");
    notesLabel.append(notesInput);
    notesBox.append(notesLabel);
    const stage = el("div", "ppt-stage");
    stage.append(sheet, notesBox);

    const mkTool = (act) => {
        const btn = el("button", "ppt-tool");
        btn.type = "button";
        btn.dataset.act = act;
        return btn;
    };
    const addPageBtn = mkTool("add");
    const delPageBtn = mkTool("del");
    const upBtn = mkTool("up");
    const downBtn = mkTool("down");

    tools.append(addPageBtn, delPageBtn, upBtn, downBtn);
    side.append(tools, thumbList);
    sheet.append(titleInput, picsBox, bodyBox, addBullet, addBulletRight, bodyNote);
    main.append(stage);
    root.append(side, main);

    /**
     * 视图自己那批「不在功能区上」的文案重新赋值（占位符、侧栏按钮、要点按钮、提示条、放映条）。
     * 一律现场 `t(...)` 取值，所以切换语言后调一次就整体换成当前语言。
     * 已存在的要点行只改 title / 占位符，不重建行——重建会打断正在输入的焦点。
     */
    function syncChrome() {
        titleInput.placeholder = t("ppt.titlePlaceholder", "点击输入标题");
        addBullet.textContent = t("ppt.btnAddBullet", "+ 添加要点");
        addBulletRight.textContent = t("ppt.btnAddBulletRight", "+ 右栏要点");
        bodyNote.textContent = t("ppt.noBodyNote", "该版式没有正文占位符，要点内容已保留（切回「标题和内容」或「双栏」即恢复显示）");
        notesLabel.textContent = t("ppt.notes", "演讲者备注");
        notesInput.placeholder = t("ppt.notesPlaceholder", "输入演讲者备注，随文件保存并在重新打开时回读");
        notesInput.title = t("ppt.notesTip", "备注只保存文本，不参与放映画面");
        addPageBtn.textContent = t("ppt.toolAddPage", "添加页");
        delPageBtn.textContent = t("ppt.toolDeletePage", "删除当前页");
        upBtn.textContent = t("ppt.toolMoveUp", "上移");
        downBtn.textContent = t("ppt.toolMoveDown", "下移");
        const delTip = t("ppt.deleteBulletTip", "删除该要点");
        Array.from(bodyBox.querySelectorAll(".ppt-rowdel")).forEach((btn) => { btn.title = delTip; });
        const tips = [t("ppt.bulletPlaceholder", "点击输入要点"), t("ppt.rightBulletPlaceholder", "右栏要点")];
        [[bulletsBox, 0], [rightBox, 1]].forEach(([box, which]) => {
            Array.from(box.querySelectorAll(".ppt-bullet")).forEach((input, i) => {
                if (i === 0) input.placeholder = tips[which];
            });
        });
        // 缩略图就地改那三处视图自己的字样（无标题 / 空 / 版式角标），不重建整列：
        // 重建会把缩略图的滚动位置和选中态一起抖掉
        Array.from(thumbList.children).forEach((card, i) => {
            const slide = model.slides[i];
            if (!card || !slide || typeof card.querySelector !== "function") return;
            const tag = card.querySelector(".ppt-thumb-layout");
            if (tag) tag.textContent = layoutLabel(slide.layout);
            const name = card.querySelector(".ppt-thumb-title");
            if (name && !slide.title) name.textContent = t("ppt.untitledThumb", "（无标题）");
            const lines = card.querySelector(".ppt-thumb-lines");
            const hasPoints = normalizeBullets(slide.bullets).concat(normalizeBullets(slide.bulletsRight)).length > 0;
            if (lines && lines.children.length === 1 && !hasPoints) lines.children[0].textContent = t("ppt.thumbEmpty", "（空）");
        });
        if (present) {
            present.layer.setAttribute("aria-label", t("ppt.presentAriaLabel", "幻灯片放映"));
            present.hint.textContent = t("ppt.presentHint", "→ ↓ 空格 PgDn 下一页 · ← ↑ PgUp 上一页 · Home End 首页 末页 · Esc 退出");
            present.exitBtn.textContent = t("ppt.exitPresent", "退出放映");
            present.exitBtn.title = t("ppt.exitPresentTip", "退出放映 (Esc)");
        }
    }
    syncChrome();

    const current = () => model.slides[index];
    const colOf = (input) => (input.dataset && input.dataset.col === "r" ? "right" : "left");
    const draftOf = (col) => (col === "right" ? draft.bulletsRight : draft.bullets);
    const boxOf = (col) => (col === "right" ? rightBox : bulletsBox);
    const rowInputs = () => Array.from(bodyBox.querySelectorAll(".ppt-bullet"));
    /** 用类名控制显隐：CSS 里 display 会盖过 hidden 属性，所以不用 hidden */
    const show = (node, on) => node.classList.toggle("ppt-hide", !on);

    /* ── 渲染 ── */
    /**
     * 填一张缩略图：页码 + 标题 + 前 3 行要点摘要 + 版式名，背景跟着页面走。
     * @param {HTMLElement} card 卡片
     * @param {object} slide 页数据
     * @param {number} i 页下标
     */
    function fillThumb(card, slide, i) {
        card.textContent = "";
        card.dataset.ix = String(i);
        const derived = pickTextColor(slide.background);
        card.classList.toggle("ppt-on-dark", derived === TEXT_ON_DARK);
        card.style.background = slide.background || "";
        card.appendChild(el("span", "ppt-thumb-no", String(i + 1)));
        const title = el("span", "ppt-thumb-title", slide.title || t("ppt.untitledThumb", "（无标题）"));
        if (slide.titleColor || derived) title.style.color = slide.titleColor || derived;
        card.appendChild(title);
        const lines = el("div", "ppt-thumb-lines");
        if (derived || slide.color) lines.style.color = slide.color || derived;
        const all = normalizeBullets(slide.bullets).concat(normalizeBullets(slide.bulletsRight));
        all.slice(0, 3).forEach((b) => lines.appendChild(el("span", null, b)));
        if (!lines.children.length) lines.appendChild(el("span", null, t("ppt.thumbEmpty", "（空）")));
        card.appendChild(lines);
        card.appendChild(el("span", "ppt-thumb-layout", layoutLabel(slide.layout)));
    }

    function renderThumbs() {
        thumbList.textContent = "";
        model.slides.forEach((slide, i) => {
            const card = el("div", i === index ? "ppt-thumb ppt-active" : "ppt-thumb");
            fillThumb(card, slide, i);
            thumbList.appendChild(card);
        });
        addPageBtn.disabled = false;
        delPageBtn.disabled = model.slides.length <= 1;
        upBtn.disabled = index <= 0;
        downBtn.disabled = index >= model.slides.length - 1;
    }

    /**
     * 渲染一栏要点行（行文本一律走 input.value，不拼 innerHTML）。
     * @param {HTMLElement} box 容器
     * @param {string[]} list 该栏草稿
     * @param {"l"|"r"} col 栏标识
     * @param {string} firstPlaceholder 首行占位符
     */
    function renderColumn(box, list, col, firstPlaceholder) {
        box.textContent = "";
        list.forEach((text, i) => {
            const row = el("div", "ppt-row");
            const input = el("input", "ppt-bullet");
            input.type = "text";
            input.value = text;
            input.placeholder = i === 0 ? firstPlaceholder : "";
            input.dataset.ix = String(i);
            input.dataset.col = col;
            const del = el("button", "ppt-rowdel", "−");
            del.type = "button";
            del.dataset.ix = String(i);
            del.dataset.col = col;
            del.title = t("ppt.deleteBulletTip", "删除该要点");
            row.append(input, del);
            box.appendChild(row);
        });
    }

    function renderRows() {
        renderColumn(bulletsBox, draft.bullets, "l", t("ppt.bulletPlaceholder", "点击输入要点"));
        renderColumn(rightBox, draft.bulletsRight, "r", t("ppt.rightBulletPlaceholder", "右栏要点"));
    }

    /**
     * 把版式 / 配色 / 字号刷到纸面上。
     * 对比度：背景写进模型，文字色**不写模型**——由 pickTextColor(background) 按亮度阈值
     * 派生，同时给纸面容器加派生类 `ppt-on-dark`（深色底时换掉占位符、项目圆点、
     * 行删按钮、添加按钮这些纸面 chrome 的颜色）。
     */
    function paintSheet() {
        const slide = current() || {};
        const two = slide.layout === "twoColumn";
        const hasBody = layoutHasBody(slide);
        const derived = pickTextColor(slide.background);

        root.classList.toggle("ppt-ratio43", pageSize === "4:3");
        sheet.classList.toggle("ppt-on-dark", derived === TEXT_ON_DARK);
        sheet.style.background = slide.background || "";

        titleInput.style.color = slide.titleColor || derived || "";
        show(bodyBox, hasBody);
        show(bulletsBox, hasBody);
        show(rightBox, two);
        show(addBullet, hasBody);
        show(addBulletRight, two);
        show(bodyNote, !hasBody);
        bodyBox.classList.toggle("ppt-two", two);
        // 两栏各自的文字色：用户显式选的颜色优先，否则用派生色（没背景色就交回主题）
        const bodyColor = slide.color || derived || "";
        // 文字色写在正文容器上，两栏与行内 input 一起继承（.ppt-bullet 用 color: inherit）
        bodyBox.style.color = bodyColor;
        const fs = bodyFontSize(slide.size);
        // 字号是"整页正文"的属性，写在容器上由两栏一起继承
        bodyBox.style.fontSize = fs;
    }

    /** 把图片模型坐标（960×540 基准）刷成百分比绝对定位，随纸面缩放 */
    function paintPic(box, image) {
        box.style.left = `${(image.x / IMAGE_CANVAS_W) * 100}%`;
        box.style.top = `${(image.y / IMAGE_CANVAS_H) * 100}%`;
        box.style.width = `${(image.width / IMAGE_CANVAS_W) * 100}%`;
        box.style.height = `${(image.height / IMAGE_CANVAS_H) * 100}%`;
    }

    /**
     * 画纸面图片层：按 x/y/宽高绝对定位在幻灯片容器内；删除按钮直接改模型并进撤销栈。
     * @returns {void}
     */
    function renderPics() {
        picsBox.replaceChildren();
        const slide = current();
        const list = slide && Array.isArray(slide.images) ? slide.images : [];
        show(picsBox, list.length > 0);
        list.forEach((image, i) => {
            const box = el("div", "ppt-pic");
            box.dataset.ix = String(i);
            paintPic(box, image);
            const pic = el("img", "ppt-pic-img");
            pic.src = image.src;
            pic.alt = t("ppt.imageAlt", "幻灯片图片 {n}").replace("{n}", String(i + 1));
            pic.draggable = false;
            const del = el("button", "ppt-pic-del", "×");
            del.type = "button";
            del.title = t("ppt.deleteImage", "删除这张图片");
            del.setAttribute("aria-label", t("ppt.deleteImage", "删除这张图片"));
            del.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const cur = current();
                if (!cur || !Array.isArray(cur.images)) return;
                cur.images.splice(i, 1);
                structural();
            });
            box.append(pic, del);
            picsBox.append(box);
        });
    }

    /* ── 图片拖动：按预览缩放比换算回 960×540 基准 ── */
    /** 当前拖动会话（{node, image, startX, startY, originX, originY, sx, sy, nextX, nextY, moved}） */
    let dragPic = null;

    const onPicDown = (e) => {
        const box = e.target && e.target.closest ? e.target.closest(".ppt-pic") : null;
        if (!box || (e.target.closest(".ppt-pic-del"))) return;
        const slide = current();
        const i = Number(box.dataset.ix);
        const image = slide && Array.isArray(slide.images) ? slide.images[i] : null;
        if (!image) return;
        const rect = sheet.getBoundingClientRect ? sheet.getBoundingClientRect() : null;
        const sx = rect && rect.width ? rect.width / IMAGE_CANVAS_W : 1;
        const sy = rect && rect.height ? rect.height / IMAGE_CANVAS_H : 1;
        dragPic = {
            node: box, image,
            startX: Number(e.clientX) || 0, startY: Number(e.clientY) || 0,
            originX: image.x, originY: image.y,
            nextX: image.x, nextY: image.y,
            sx, sy, moved: false,
        };
        box.classList.add("ppt-dragging");
        if (e.pointerId !== undefined && picsBox.setPointerCapture) picsBox.setPointerCapture(e.pointerId);
        if (e.preventDefault) e.preventDefault();
    };

    const onPicMove = (e) => {
        if (!dragPic) return;
        const dx = (Number(e.clientX) || 0) - dragPic.startX;
        const dy = (Number(e.clientY) || 0) - dragPic.startY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragPic.moved = true;
        dragPic.nextX = Math.min(IMAGE_CANVAS_W, Math.max(0, Math.round(dragPic.originX + dx / dragPic.sx)));
        dragPic.nextY = Math.min(IMAGE_CANVAS_H, Math.max(0, Math.round(dragPic.originY + dy / dragPic.sy)));
        paintPic(dragPic.node, { ...dragPic.image, x: dragPic.nextX, y: dragPic.nextY });
        if (e.preventDefault) e.preventDefault();
    };

    const onPicUp = (e) => {
        if (!dragPic) return;
        const session = dragPic;
        dragPic = null;
        session.node.classList.remove("ppt-dragging");
        if (e.pointerId !== undefined && picsBox.releasePointerCapture) {
            try { picsBox.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放或未捕获 */ }
        }
        if (!session.moved) return;
        session.image.x = session.nextX;
        session.image.y = session.nextY;
        changed();
    };

    function renderEdit() {
        const slide = current();
        draft.title = slide ? slide.title : "";
        draft.bullets = slide ? slide.bullets.slice() : [];
        draft.bulletsRight = slide ? slide.bulletsRight.slice() : [];
        titleInput.value = draft.title;
        notesInput.value = slide ? slide.notes : "";
        renderRows();
        renderPics();
        paintSheet();
    }

    /* ── 草稿 ↔ 模型 ── */
    /** 把输入框里的当前文本收回草稿（防止未经 input 事件的改动漏掉） */
    function harvest() {
        rowInputs().forEach((input) => {
            const list = draftOf(colOf(input));
            const i = Number(input.dataset.ix);
            if (Number.isInteger(i) && i >= 0 && i < list.length) list[i] = input.value;
        });
    }

    /** 草稿压回模型：标题去首尾空白，要点按换行拆分并丢掉空条目 */
    function pushDraft() {
        const slide = current();
        if (!slide) return;
        harvest();
        slide.title = draft.title.trim();
        slide.bullets = normalizeBullets(draft.bullets);
        // 非双栏时不留右栏条目：并回左栏由 migrateLayout 负责，这里只保证模型自洽
        slide.bulletsRight = slide.layout === "twoColumn" ? normalizeBullets(draft.bulletsRight) : [];
    }

    /* ── 撤销 / 重做栈 ── */
    let history = [];
    let hIndex = -1;
    let lastStep = { key: null, at: 0 };

    /** 当前模型快照（深拷贝，含当前页下标） */
    function snapshot() {
        return {
            index,
            slides: model.slides.map((s) => ({
                ...s,
                bullets: s.bullets.slice(),
                bulletsRight: s.bulletsRight.slice(),
                images: normalizeViewImages(s.images),
            })),
        };
    }

    /**
     * 提交一次可撤销的变更。
     * @param {string} [key] 合并键：同键且距上次提交不足 TEXT_COALESCE_MS 时只覆盖栈顶
     *                       （连续打字算一步），不传键则一律新开一步（结构变更、命令）
     */
    function commit(key) {
        const snap = snapshot();
        const now = Date.now();
        const merged = !!key && key === lastStep.key && now - lastStep.at < TEXT_COALESCE_MS;
        lastStep = { key: key || null, at: now };
        if (merged && hIndex >= 0) {
            history[hIndex] = snap;
            return;
        }
        history.length = Math.max(0, hIndex + 1);
        history.push(snap);
        // 超出上限只丢最老的一步，栈深始终 ≥ 50
        if (history.length > HISTORY_MAX) history.shift();
        hIndex = history.length - 1;
    }

    /** 换文档：栈重置为「只有当前这一态」 */
    function resetHistory() {
        history = [snapshot()];
        hIndex = 0;
        lastStep = { key: null, at: 0 };
    }

    /** 把一个快照装回模型并重画（放映中的话放映层跟着回显，但不写模型） */
    function restore(snap) {
        model = { slides: snap.slides.map(normalizeSlide) };
        index = Math.max(0, Math.min(snap.index, model.slides.length - 1));
        renderThumbs();
        renderEdit();
        if (present) showPresent(present.page);
    }

    function canUndo() {
        return !disposed && hIndex > 0;
    }

    function canRedo() {
        return !disposed && hIndex >= 0 && hIndex < history.length - 1;
    }

    /** @returns {boolean} 是否真的撤销了一步 */
    function undo() {
        if (!canUndo()) return false;
        hIndex -= 1;
        lastStep = { key: null, at: 0 };
        restore(history[hIndex]);
        return true;
    }

    /** @returns {boolean} 是否真的重做了一步 */
    function redo() {
        if (!canRedo()) return false;
        hIndex += 1;
        lastStep = { key: null, at: 0 };
        restore(history[hIndex]);
        return true;
    }

    /**
     * 外部（外壳查找替换）直接改模型：改完重画并进栈。
     * @param {(m: {slides: object[]}) => void} mutate 就地修改函数
     */
    function applyEdit(mutate) {
        if (disposed) return;
        pushDraft();
        if (typeof mutate === "function") mutate(model);
        const cleaned = (Array.isArray(model.slides) ? model.slides : []).map(normalizeSlide);
        model = { slides: cleaned.length ? cleaned : blankModel().slides };
        index = Math.max(0, Math.min(index, model.slides.length - 1));
        renderThumbs();
        renderEdit();
        commit();
        onSelectionChange();
    }

    /** 一次文本变化：同步模型 + 同步该页缩略图 + 通知外壳 */
    function changed(key) {
        pushDraft();
        const card = thumbList.children[index];
        if (card) fillThumb(card, model.slides[index], index);
        commit(key);
        onInput();
    }

    /** 结构变化（增删页 / 换版式 / 改样式）后统一重画并开新的撤销步 */
    function structural() {
        renderThumbs();
        renderEdit();
        commit();
        onInput();
        onSelectionChange();
    }

    /**
     * 聚焦某行要点并把光标落到行尾
     * @param {number} i 行下标
     * @param {"l"|"r"} [col] 栏，缺省左栏
     */
    function focusRow(i, col) {
        const list = draftOf(col === "right" ? "right" : "left");
        const box = boxOf(col === "right" ? "right" : "left");
        const input = Array.from(box.querySelectorAll(".ppt-bullet"))[i];
        if (!input) return;
        input.focus();
        const end = String(list[i] == null ? input.value : list[i]).length;
        if (typeof input.setSelectionRange === "function") input.setSelectionRange(end, end);
    }

    /**
     * 切到某一页：先把当前编辑内容吸回模型，再换页
     * @param {number} i 目标页下标
     */
    function gotoPage(i) {
        if (!Number.isInteger(i) || i < 0 || i >= model.slides.length || i === index) return;
        pushDraft();
        index = i;
        renderThumbs();
        renderEdit();
        onSelectionChange();
    }

    /* ── 事件（全部委托，注册一次） ── */
    const onTitleInput = () => {
        draft.title = titleInput.value;
        changed("text");
    };

    const onNotesInput = () => {
        const slide = current();
        if (!slide) return;
        slide.notes = notesInput.value;
        changed("notes");
    };

    const onBulletInput = (e) => {
        const input = e.target.closest(".ppt-bullet");
        if (!input) return;
        const list = draftOf(colOf(input));
        const i = Number(input.dataset.ix);
        if (!(i >= 0 && i < list.length)) return;
        list[i] = input.value;
        changed("text");
    };

    const onBulletKeydown = (e) => {
        const input = e.target.closest(".ppt-bullet");
        if (!input) return;
        const col = colOf(input);
        const list = draftOf(col);
        const i = Number(input.dataset.ix);
        if (e.key === "Enter") {
            e.preventDefault();
            list[i] = input.value;
            list.splice(i + 1, 0, "");
            renderRows();
            changed("text");
            focusRow(i + 1, col);
            return;
        }
        // 空行才响应 Backspace（有内容交给原生退格）；首行没有"上一行"可聚焦，留着它
        if (e.key === "Backspace") {
            if (i === 0 || input.value !== "") return;
            e.preventDefault();
            list.splice(i, 1);
            renderRows();
            changed("text");
            focusRow(i - 1, col);
        }
    };

    const onBulletClick = (e) => {
        const del = e.target.closest(".ppt-rowdel");
        if (!del) return;
        const col = colOf(del);
        const list = draftOf(col);
        const i = Number(del.dataset.ix);
        if (!(i >= 0 && i < list.length)) return;
        harvest();
        list.splice(i, 1);
        renderRows();
        changed();
        focusRow(Math.min(i, list.length - 1), col);
    };

    const onBulletPaste = (e) => {
        const input = e.target.closest(".ppt-bullet");
        if (!input) return;
        const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
        if (!/\r?\n/.test(text)) return;
        e.preventDefault();
        const col = colOf(input);
        const list = draftOf(col);
        const parts = normalizeBullets([text]);
        if (!parts.length) return;
        const i = Number(input.dataset.ix);
        if (!(Number.isInteger(i) && i >= 0 && i < list.length)) return;
        list[i] = input.value;
        if (String(list[i]).trim()) {
            // 当前行有字：粘出来的条目接在它后面（浏览器语义是"在光标处插入"，这里按整段处理）
            list.splice(i + 1, 0, ...parts);
        } else {
            // 当前行是空的就让它承接第一段，避免留下会被丢掉的空行
            list.splice(i, 1, ...parts);
        }
        renderRows();
        changed();
        focusRow(i + parts.length - 1, col);
    };

    const onAddBullet = () => addBulletRow("l");
    const onAddBulletRight = () => addBulletRow("r");

    /**
     * 加一条要点（视图内的 `+ 添加要点` 按钮与 `ppt.addBullet*` 命令共用）。
     * @param {"l"|"r"} col 目标栏
     * @returns {boolean} 是否真的加了
     */
    function addBulletRow(col) {
        const slide = current();
        if (!slide) return false;
        const right = col === "r" || col === "right";
        if (right && slide.layout !== "twoColumn") return false;
        if (!right && !layoutHasBody(slide)) return false;
        harvest();
        const list = draftOf(right ? "right" : "left");
        list.push("");
        renderRows();
        changed();
        focusRow(list.length - 1, right ? "right" : "left");
        return true;
    }

    /* ── 页级结构动作（侧栏工具条与功能区命令共用） ── */
    function insertSlide() {
        pushDraft();
        model.slides.splice(index + 1, 0, normalizeSlide({}));
        index += 1;
        structural();
        titleInput.focus();
    }

    /** 复制当前页：深拷贝插到本页之后并切过去（要点数组也要拷，不然两页共用一份） */
    function duplicateSlide() {
        const slide = current();
        if (!slide) return;
        pushDraft();
        const copy = normalizeSlide({
            ...slide,
            bullets: slide.bullets.slice(),
            bulletsRight: slide.bulletsRight.slice(),
        });
        model.slides.splice(index + 1, 0, copy);
        index += 1;
        structural();
    }

    function removeSlide() {
        if (model.slides.length <= 1) return;
        pushDraft();
        model.slides.splice(index, 1);
        index = Math.max(0, Math.min(index, model.slides.length - 1));
        structural();
    }

    /**
     * 当前页上移 / 下移一格。
     * @param {number} delta -1 上移，1 下移
     */
    function shiftSlide(delta) {
        const to = index + delta;
        if (to < 0 || to >= model.slides.length) return;
        pushDraft();
        model.slides = moveItem(model.slides, index, to);
        index = to;
        structural();
    }

    const onToolClick = (e) => {
        const btn = e.target.closest(".ppt-tool");
        if (!btn || btn.disabled) return;
        const act = btn.dataset.act;
        if (act === "add") insertSlide();
        else if (act === "del") removeSlide();
        else if (act === "up") shiftSlide(-1);
        else if (act === "down") shiftSlide(1);
    };

    const onThumbClick = (e) => {
        const card = e.target.closest(".ppt-thumb");
        if (card) gotoPage(Number(card.dataset.ix));
    };

    /* ── 放映层（只读：全程不写模型） ── */
    /**
     * 放映页面上的一条要点列表。
     * @param {string[]} items 要点
     * @param {string} color 文字色（空串 = 继承）
     * @returns {HTMLElement} 列表容器
     */
    function showLines(items, color) {
        const box = el("div", "ppt-show-lines");
        if (color) box.style.color = color;
        normalizeBullets(items).forEach((text) => box.appendChild(el("p", null, text)));
        return box;
    }

    /** 重画放映页面（读当前模型，不写） */
    function renderPresent() {
        if (!present) return;
        const slide = model.slides[present.page] || {};
        const derived = pickTextColor(slide.background);
        present.stage.textContent = "";
        present.stage.className = "ppt-show-stage"
            + (pageSize === "16:9" ? "" : " ppt-ratio43")
            + (derived === TEXT_ON_DARK ? " ppt-on-dark" : "");
        present.stage.style.background = slide.background || "";

        const page = el("div", "ppt-show-page");
        const animClass = {
            fade: "ppt-anim-fade",
            push: "ppt-anim-push",
            wipe: "ppt-anim-wipe",
        }[normalizeTransition(slide.transition)];
        if (present.anim && animClass) page.classList.add(animClass);
        if (slide.layout !== "blank") {
            const heading = el("h2", "ppt-show-title", slide.title || "");
            if (slide.titleColor || derived) heading.style.color = slide.titleColor || derived;
            page.appendChild(heading);
        }
        if (layoutHasBody(slide)) {
            const cols = el("div", "ppt-show-cols");
            // 字号写在正文容器上（它是 .ppt-show-page 这个查询容器的子节点），两栏一起继承
            cols.style.fontSize = bodyFontSize(slide.size);
            if (slide.layout === "twoColumn") cols.classList.add("ppt-two");
            const bodyColor = slide.color || derived || "";
            cols.appendChild(showLines(slide.bullets, bodyColor));
            if (slide.layout === "twoColumn") cols.appendChild(showLines(slide.bulletsRight, bodyColor));
            page.appendChild(cols);
        }
        present.stage.appendChild(page);
        present.count.textContent = `${present.page + 1} / ${model.slides.length}`;
    }

    /**
     * 跳到放映的第 i 页（越界自动夹到首 / 末页）
     * @param {number} i 页下标
     * @param {boolean} [animate] 是否按目标页 transition 施加入场动画（翻页时为真，进入 / 重绘时不加）
     */
    function showPresent(i, animate = false) {
        if (!present) return;
        const want = Number.isInteger(i) ? i : 0;
        const from = present.page;
        present.page = Math.max(0, Math.min(want, model.slides.length - 1));
        present.anim = !!animate && present.page !== from;
        renderPresent();
        present.anim = false;
    }

    /**
     * 翻一页：到头 / 到尾时不动（放映不自动回绕，也不自动退出）
     * @param {number} delta ±1
     */
    function stepPresent(delta) {
        if (!present) return;
        showPresent(present.page + delta, true);
    }

    const onPresentKey = (e) => {
        if (!present) return;
        const k = e.key;
        if (k === "Escape") {
            e.preventDefault();
            stopPresent();
            return;
        }
        if (k === "ArrowRight" || k === "ArrowDown" || k === " " || k === "Spacebar" || k === "PageDown") {
            e.preventDefault();
            stepPresent(1);
            return;
        }
        if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp") {
            e.preventDefault();
            stepPresent(-1);
            return;
        }
        if (k === "Home") {
            e.preventDefault();
            showPresent(0, true);
            return;
        }
        if (k === "End") {
            e.preventDefault();
            showPresent(model.slides.length - 1, true);
        }
    };

    const onPresentClick = (e) => {
        if (!present) return;
        if (e.target.closest(".ppt-show-exit")) {
            e.preventDefault();
            stopPresent();
            return;
        }
        // 信息条上的其它区域不翻页，只有画面本身翻页
        if (e.target.closest(".ppt-show-bar")) return;
        stepPresent(1);
    };

    /**
     * 进入放映：在窗口根（`.office`）上覆盖一层，从 from 页开始。
     * 监听登记到 present.bound，退出时逐条对账摘除。
     * @param {number} from 起始页下标
     * @returns {boolean} 是否进入了放映
     */
    function startPresent(from) {
        if (disposed || !doc) return false;
        pushDraft();
        if (!model.slides.length) return false;
        if (present) stopPresent();

        const layer = el("div", "ppt-show");
        layer.tabIndex = -1;
        layer.setAttribute("role", "dialog");
        layer.setAttribute("aria-label", t("ppt.presentAriaLabel", "幻灯片放映"));
        const bar = el("div", "ppt-show-bar");
        const count = el("span", "ppt-show-count");
        const hint = el("span", "ppt-show-hint", t("ppt.presentHint", "→ ↓ 空格 PgDn 下一页 · ← ↑ PgUp 上一页 · Home End 首页 末页 · Esc 退出"));
        const exitBtn = el("button", "ppt-show-exit", t("ppt.exitPresent", "退出放映"));
        exitBtn.type = "button";
        exitBtn.title = t("ppt.exitPresentTip", "退出放映 (Esc)");
        bar.append(count, hint, exitBtn);
        const stage = el("div", "ppt-show-stage");
        layer.append(bar, stage);

        // 覆盖前记下滚动位置，退出时原样还回去（编辑视图本身没被拆，不用重建）
        const canvas = viewEl.closest(".office-canvas");
        present = {
            layer,
            stage,
            count,
            hint,
            exitBtn,
            page: 0,
            anim: false,
            bound: [],
            canvas,
            prevFocus: doc.activeElement || null,
            saved: {
                mainTop: main.scrollTop,
                mainLeft: main.scrollLeft,
                thumbTop: thumbList.scrollTop,
                canvasTop: canvas ? canvas.scrollTop : 0,
                canvasLeft: canvas ? canvas.scrollLeft : 0,
            },
        };
        const pl = (node, type, handler, options) => {
            node.addEventListener(type, handler, options);
            present.bound.push([node, type, handler, options]);
        };
        // 放映时焦点可能在编辑区的输入框上，所以键盘挂在 document 的捕获阶段
        pl(doc, "keydown", onPresentKey, true);
        pl(layer, "click", onPresentClick);

        (viewEl.closest(".office") || viewEl).appendChild(layer);
        // 编辑区整体退出 Tab 顺序（覆盖层不透明，留着只会让焦点跑到看不见的输入框里）
        show(root, false);
        showPresent(Number.isInteger(from) ? from : index);
        if (typeof layer.focus === "function") layer.focus();
        return true;
    }

    /**
     * 退出放映：摘掉放映监听、移除覆盖层、恢复编辑区与滚动位置。
     * 编辑视图从头到尾没被拆过，所以这里只把显示与滚动还回去。
     * @returns {boolean} 之前是否在放映
     */
    function stopPresent() {
        if (!present) return false;
        for (const [node, type, handler, options] of present.bound) node.removeEventListener(type, handler, options);
        present.bound.length = 0;
        const { layer, canvas, saved, prevFocus } = present;
        present = null;
        layer.remove();
        // 先让编辑区重新可见再灌回滚动位置：display:none 的元素写 scrollTop 不生效
        show(root, true);
        main.scrollTop = saved.mainTop;
        main.scrollLeft = saved.mainLeft;
        thumbList.scrollTop = saved.thumbTop;
        if (canvas) {
            canvas.scrollTop = saved.canvasTop;
            canvas.scrollLeft = saved.canvasLeft;
        }
        if (prevFocus && typeof prevFocus.focus === "function" && prevFocus.isConnected !== false) prevFocus.focus();
        return true;
    }

    /* ── 功能区命令实现 ── */
    /**
     * 插入图片：选文件 -> data URL -> 自然尺寸 -> 进当前页模型（可撤销）。
     * x/y 按旧回写排布递增（40 / 120+索引*16），用户随后可在纸面上拖动。
     * @returns {Promise<void>}
     */
    async function addImage() {
        const image = await pickImage();
        if (!image || disposed) return;
        const slide = current();
        if (!slide) return;
        pushDraft();
        slide.images.push({
            src: image.src,
            width: Math.min(IMAGE_CANVAS_W, image.width),
            height: Math.min(IMAGE_CANVAS_H, image.height),
            x: IMAGE_DEFAULT_X,
            y: IMAGE_DEFAULT_Y + slide.images.length * IMAGE_DEFAULT_STEP,
        });
        structural();
    }

    /**
     * 改当前页的某个样式字段并进撤销栈。
     * @param {string} field 字段名
     * @param {*} value 新值（已按模型口径洗过）
     */
    function setSlideField(field, value) {
        const slide = current();
        if (!slide) return;
        pushDraft();
        slide[field] = value;
        structural();
    }

    /**
     * 执行一条功能区命令。
     * @param {string} id 命令 id
     * @param {string|number|undefined} value 下拉取值
     * @returns {boolean} 认不认这条命令（false 才落到外壳）
     */
    function command(id, value) {
        switch (id) {
            case "ppt.undo":
                undo();
                return true;
            case "ppt.redo":
                redo();
                return true;
            case "ppt.size": {
                // 取值只认 14/18/24/32；"" 或 null 表示清回"继承版式"
                const n = value === "" || value == null ? null : normalizeSize(value);
                setSlideField("size", n);
                return true;
            }
            case "ppt.color":
                setSlideField("color", normalizeColorField(value));
                return true;
            case "ppt.titleColor":
                setSlideField("titleColor", normalizeColorField(value));
                return true;
            case "ppt.layout": {
                const slide = current();
                if (!slide || LAYOUT_IDS.indexOf(value) < 0) return true;
                pushDraft();
                model.slides[index] = normalizeSlide(migrateLayout(slide, value));
                structural();
                return true;
            }
            case "ppt.newSlide":
                insertSlide();
                return true;
            case "ppt.duplicateSlide":
                duplicateSlide();
                return true;
            case "ppt.deleteSlide":
                removeSlide();
                return true;
            case "ppt.moveUp":
                shiftSlide(-1);
                return true;
            case "ppt.moveDown":
                shiftSlide(1);
                return true;
            case "ppt.addBullet":
                addBulletRow("l");
                return true;
            case "ppt.addBulletRight":
                addBulletRow("r");
                return true;
            case "ppt.background":
                setSlideField("background", normalizeColorField(value));
                return true;
            case "ppt.transition":
                setSlideField("transition", normalizeTransition(value));
                return true;
            case "ppt.play":
                // 放映只读、不动模型，不调 onInput —— 脏标记只认真改动，放映不该把文档标脏
                startPresent(index);
                return true;
            case "ppt.playFromStart":
                startPresent(0);
                return true;
            case "ppt.insertImage":
            case "insertImage":
                void addImage();
                return true;
            case "ppt.fitSlide":
                // 纸张尺寸进模型（随文件落盘），因此要标脏；放映层同步重绘
                pageSize = pageSize === "16:9" ? "4:3" : "16:9";
                paintSheet();
                renderPresent();
                onInput();
                onSelectionChange();
                return true;
            default:
                return false;
        }
    }

    /**
     * 功能区标签页与控件声明（结构见 ribbon.js）。
     * 「开始」不放编辑组：要点编辑由纸面上的行内交互承担，摆个空组不如不摆。
     * @returns {object[]} 标签页数组
     */
    function ribbon() {
        return [
            {
                id: "home",
                label: t("ppt.tabHome", "开始"),
                groups: [
                    {
                        label: t("ppt.groupUndo", "撤销"),
                        items: [
                            { id: "ppt.undo", label: t("ppt.cmdUndo", "撤销"), icon: "undo", title: t("ppt.tipUndo", "撤销上一步 (⌘Z)") },
                            { id: "ppt.redo", label: t("ppt.cmdRedo", "重做"), icon: "redo", title: t("ppt.tipRedo", "重做 (⌘⇧Z)") },
                        ],
                    },
                    {
                        label: t("ppt.groupFont", "字体"),
                        items: [
                            { id: "ppt.size", label: t("ppt.ctlSize", "字号"), type: "menu", options: sizeOptions() },
                            { id: "ppt.color", label: t("ppt.ctlColor", "正文色"), type: "menu", options: colorOptions() },
                            { id: "ppt.titleColor", label: t("ppt.ctlTitleColor", "标题色"), type: "menu", options: colorOptions() },
                        ],
                    },
                    {
                        label: t("ppt.groupLayout", "版式"),
                        items: [{ id: "ppt.layout", label: t("ppt.ctlLayout", "版式"), type: "menu", options: layoutOptions() }],
                    },
                ],
            },
            {
                id: "insert",
                label: t("ppt.tabInsert", "插入"),
                groups: [
                    {
                        label: t("ppt.groupSlides", "幻灯片"),
                        items: [
                            { id: "ppt.newSlide", label: t("ppt.cmdNewSlide", "新建页"), icon: "slide", size: "large", title: t("ppt.tipNewSlide", "在当前页之后插入一页") },
                            { id: "ppt.duplicateSlide", label: t("ppt.cmdDuplicateSlide", "复制当前页"), icon: "page", size: "large", title: t("ppt.tipDuplicateSlide", "把当前页（含要点与版式）复制一份插到后面") },
                            { id: "ppt.deleteSlide", label: t("ppt.cmdDeleteSlide", "删除当前页"), icon: "clear", size: "large", title: t("ppt.tipDeleteSlide", "只剩一页时不可用") },
                            { id: "ppt.moveUp", label: t("ppt.cmdMoveUp", "上移"), icon: "decrease", size: "small", title: t("ppt.tipMoveUp", "当前页前移一位") },
                            { id: "ppt.moveDown", label: t("ppt.cmdMoveDown", "下移"), icon: "increase", size: "small", title: t("ppt.tipMoveDown", "当前页后移一位") },
                        ],
                    },
                    {
                        label: t("ppt.groupBullets", "要点"),
                        items: [
                            { id: "ppt.addBullet", label: t("ppt.cmdAddBullet", "添加要点"), icon: "listBullet", size: "large", title: t("ppt.tipAddBullet", "在当前页加一条要点") },
                            { id: "ppt.addBulletRight", label: t("ppt.cmdAddBulletRight", "右栏要点"), icon: "column", size: "large", title: t("ppt.tipAddBulletRight", "仅「双栏」版式可用") },
                        ],
                    },
                    {
                        label: t("ppt.groupImage", "图片"),
                        items: [
                            { id: "ppt.insertImage", label: t("insertImage", "插入图片"), icon: "image", size: "large", title: t("insertImageTip", "从本地选择 PNG/JPEG/GIF/WebP 图片，加到当前页") },
                        ],
                    },
                ],
            },
            {
                id: "design",
                label: t("ppt.tabDesign", "设计"),
                groups: [
                    {
                        label: t("ppt.groupBackground", "背景"),
                        items: [
                            { id: "ppt.background", label: t("ppt.ctlBackground", "页面背景"), type: "menu", options: backgroundOptions() },
                        ],
                    },
                ],
            },
            {
                id: "show",
                label: t("ppt.tabSlideShow", "幻灯片放映"),
                groups: [
                    {
                        label: t("ppt.groupTransition", "切换"),
                        items: [
                            { id: "ppt.transition", label: t("ppt.ctlTransition", "切换效果"), type: "menu", options: transitionOptions() },
                        ],
                    },
                    {
                        label: t("ppt.groupPresent", "放映"),
                        items: [
                            { id: "ppt.play", label: t("ppt.cmdPlay", "从当前页放映"), icon: "slide", size: "large", title: t("ppt.tipPlay", "窗口内覆盖一层放映视图，Esc 退出") },
                            { id: "ppt.playFromStart", label: t("ppt.cmdPlayFromStart", "从头放映"), icon: "page", size: "large", title: t("ppt.tipPlayFromStart", "从第一页开始放映") },
                        ],
                    },
                    {
                        label: t("ppt.groupRatio", "比例"),
                        items: [
                            {
                                id: "ppt.fitSlide",
                                label: t("ppt.ctlFitSlide", "4:3 显示"),
                                type: "toggle",
                                size: "large",
                                title: t("ppt.tipFitSlide", "只切换纸面与放映的显示比例，模型里没有这个字段，导出不受影响"),
                            },
                        ],
                    },
                ],
            },
        ];
    }

    /**
     * 控件状态：下拉当前值 + 按下态 + 可用态。
     * 约定（见 ribbon.js）：`state[id]` 给按下态 / 下拉值，`state["!" + id]` 为真则按钮禁用。
     * @returns {object} 状态表
     */
    function state() {
        const slide = current() || {};
        const two = slide.layout === "twoColumn";
        const hasBody = layoutHasBody(slide);
        return {
            "ppt.layout": slide.layout || "titleContent",
            // 字号不在 14/18/24/32 档位里时（例如从 pptx 读来的 20 磅）下拉视觉回落到首项，
            // 模型值不动，只有用户重新选档才改写
            "ppt.size": slide.size,
            "ppt.color": slide.color || "",
            "ppt.titleColor": slide.titleColor || "",
            "ppt.background": slide.background || "",
            "ppt.transition": slide.transition || "none",
            "ppt.fitSlide": pageSize === "4:3",
            "!ppt.undo": !canUndo(),
            "!ppt.redo": !canRedo(),
            "!ppt.deleteSlide": model.slides.length <= 1,
            "!ppt.moveUp": index <= 0,
            "!ppt.moveDown": index >= model.slides.length - 1,
            "!ppt.addBullet": !hasBody,
            "!ppt.addBulletRight": !two,
        };
    }

    listen(titleInput, "input", onTitleInput);
    listen(notesInput, "input", onNotesInput);
    listen(bodyBox, "input", onBulletInput);
    listen(bodyBox, "keydown", onBulletKeydown);
    listen(bodyBox, "click", onBulletClick);
    listen(bodyBox, "paste", onBulletPaste);
    listen(addBullet, "click", onAddBullet);
    listen(addBulletRight, "click", onAddBulletRight);
    listen(picsBox, "pointerdown", onPicDown);
    listen(picsBox, "pointermove", onPicMove);
    listen(picsBox, "pointerup", onPicUp);
    listen(tools, "click", onToolClick);
    listen(thumbList, "click", onThumbClick);

    /**
     * 切语言：外壳只重画功能区与状态栏，视图自己的字样（占位符 / 侧栏按钮 / 缩略图 / 放映条）
     * 在 syncChrome() 里补齐。languagechange 冒泡到 window，挂在 window 上不占用 document 的
     * 监听名额（放映键盘监听独占它），并由 bound 表在 dispose 时一并摘除。
     */
    const onLanguageChange = () => {
        if (disposed) return;
        syncChrome();
    };
    const langTarget = typeof window !== "undefined" && typeof window.addEventListener === "function" ? window : null;
    if (langTarget) listen(langTarget, "languagechange", onLanguageChange);

    renderThumbs();
    renderEdit();
    resetHistory();
    viewEl.appendChild(root);

    /**
     * 载入模型（丢弃当前未保存的编辑态）
     * @param {object} m { slides: [...] }
     */
    function loadModel(m) {
        if (disposed) return;
        stopPresent();
        pageSize = m && m.page && m.page.size === "4:3" ? "4:3" : "16:9";
        model = cloneModel(m);
        index = 0;
        renderThumbs();
        renderEdit();
        resetHistory();
        onSelectionChange();
    }

    /** 把键盘焦点交给视图：标题空着聚焦标题，否则聚焦正文首行 / 添加要点按钮 */
    function focusView() {
        if (present) {
            if (typeof present.layer.focus === "function") present.layer.focus();
            return;
        }
        if (titleInput.value.trim()) {
            const first = rowInputs()[0];
            if (first) first.focus();
            else addBullet.focus();
            return;
        }
        titleInput.focus();
    }

    /**
     * 查找导航（外壳「上一个 / 下一个」）：在全部页的标题与要点里循环找下一处命中，
     * 找到就切页、聚焦该行并选中命中串。大小写敏感，与替换口径一致。
     * @param {string} query 查找串
     * @param {number} dir 1 向下，-1 向上
     * @returns {boolean} 是否命中
     */
    function seek(query, dir) {
        const q = String(query || "");
        if (!q || disposed) return false;
        pushDraft();
        const forward = dir !== -1;
        // 命中点清单：标题 where=-1，要点 where=行号（左栏 0、右栏 0.5 拉开同页顺序）
        const hits = [];
        model.slides.forEach((s, i) => {
            const title = String(s.title || "");
            if (title.indexOf(q) !== -1) hits.push({ slide: i, where: -1, col: "l", at: title.indexOf(q) });
            s.bullets.forEach((text, r) => {
                const at = String(text).indexOf(q);
                if (at !== -1) hits.push({ slide: i, where: r, col: "l", at });
            });
            s.bulletsRight.forEach((text, r) => {
                const at = String(text).indexOf(q);
                if (at !== -1) hits.push({ slide: i, where: r, col: "r", at });
            });
        });
        if (!hits.length) return false;
        const order = (h) => h.slide * 10000 + (h.where + 1) + (h.col === "r" ? 0.5 : 0);
        const activeEl = doc && doc.activeElement && typeof doc.activeElement.closest === "function"
            ? doc.activeElement.closest(".ppt-bullet") : null;
        const curPos = index * 10000 + ((activeEl ? Number(activeEl.dataset.ix) : -1) + 1);
        let target = null;
        if (forward) {
            target = hits.find((h) => order(h) > curPos) || hits[0];
        } else {
            for (let i = hits.length - 1; i >= 0; i--) {
                if (order(h) < curPos) { target = hits[i]; break; }
            }
            if (!target) target = hits[hits.length - 1];
        }
        gotoPage(target.slide);
        if (target.where === -1) {
            titleInput.focus();
            if (typeof titleInput.setSelectionRange === "function") titleInput.setSelectionRange(target.at, target.at + q.length);
        } else {
            const col = target.col === "r" ? "right" : "left";
            focusRow(target.where, col);
            const input = Array.from(boxOf(col).querySelectorAll(".ppt-bullet"))[target.where];
            if (input && typeof input.setSelectionRange === "function") input.setSelectionRange(target.at, target.at + q.length);
        }
        onSelectionChange();
        return true;
    }

    return {
        /**
         * 载入模型（会丢弃当前未保存的编辑态）
         * @param {object} m { slides: [...] }
         */
        load(m) {
            loadModel(m);
        },

        /**
         * 读回模型：全空要点已过滤；空文档原样返回（仍是"一页空壳"）
         * @returns {object} { slides: [...], page: {size: string} }
         */
        read() {
            pushDraft();
            return {
                page: { size: pageSize },
                slides: model.slides.map((s) => ({
                    title: s.title,
                    bullets: s.bullets.slice(),
                    bulletsRight: s.bulletsRight.slice(),
                    layout: s.layout,
                    background: s.background,
                    color: s.color,
                    titleColor: s.titleColor,
                    size: s.size,
                    images: s.images.map((img) => ({ ...img })),
                    notes: String(s.notes || ""),
                    transition: s.transition || "none",
                })),
            };
        },

        /** 清成空白文档 */
        clear() {
            loadModel(blankModel());
            focusView();
        },

        /** 把键盘焦点交给视图 */
        focus() {
            focusView();
        },

        /** 摘掉所有监听并卸载 DOM；放映层也在这里兜底关掉；没有定时器与 rAF 需要清理 */
        dispose() {
            stopPresent();
            for (const [node, type, handler, options] of bound) node.removeEventListener(type, handler, options);
            bound.length = 0;
            history = [];
            hIndex = -1;
            disposed = true;
            root.remove();
        },

        /**
         * 状态栏指标
         * @returns {string} 形如 `3 页 · 第 2 页 · 双栏 · 16:9`
         */
        metric() {
            pushDraft();
            const slide = current() || {};
            const bits = [
                fill(t("ppt.slideCount", "{n} 页"), { n: model.slides.length }),
                fill(t("ppt.slidePosition", "第 {n} 页"), { n: index + 1 }),
                layoutLabel(slide.layout),
            ];
            if (present) bits.push(fill(t("ppt.presenting", "放映中 {cur}/{total}"), { cur: present.page + 1, total: model.slides.length }));
            bits.push(pageSize);
            return bits.filter(Boolean).join(" · ");
        },

        ribbon,
        command,
        state,
        canUndo,
        canRedo,
        undo,
        redo,
        applyEdit,
        seek,
    };
}
