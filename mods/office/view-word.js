/**
 * view-word.js — 文稿视图（Office 2016 功能区形态）：块级 contenteditable + A4 纸张。
 * 模型与 docx 编解码共用 Block 契约（本模块不 import，只按字段名读写）：
 *   Block = { kind:"paragraph"|"heading"|"image", level, text, bold, italic, underline, strike,
 *             align, indent, font, size, color, highlight,
 *             lineSpacing:number|null, spaceBefore:number, spaceAfter:number,
 *             list:"none"|"bullet"|"number",
 *             src:"data:image/…", width:px, height:px, alt:string }   // 后四项仅 image 块有
 * 要点：格式字段全写块的 `data-*`，标题用 <p data-kind="heading"> + role="heading" 而非 <h1>
 * （换标签要重建元素，会丢焦点与光标）；可枚举字段走 CSS 属性选择器，任意值（字体/磅值/色值/
 * 缩进级）走行内 style；文本读取自遍历子节点，不用 innerText（它按布局归一空白，模型会漂）；
 * Enter/退格/方向键的结构变动靠 Range 接管并 preventDefault（否则浏览器往块里塞 <div>/<br>）。
 */

import { el, useStyle } from "./view-style.js";
import { t } from "./t.js";
import { pickImage } from "./office-io.js";

/* ───────────────────────── 模型常量与规整 ───────────────────────── */

const HEADING = "heading";
const PARAGRAPH = "paragraph";
/** 四个字符开关：data-* 与 CSS 属性选择器一一同名 */
const FLAGS = ["bold", "italic", "underline", "strike"];
const ALIGN_VALUES = ["left", "center", "right", "justify"];
/** 显式指定字体时补齐的西文/兜底栈，别让中文块里的数字变成宋体衬线 */
const FONT_FALLBACK = "-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";

const MERGE_MS = 400;
/** 撤销栈上限：必须 ≥50，外壳的撤销按钮与功能区撤销要能一路退回空白文档 */
const HISTORY_MAX = 60;
const INDENT_MAX = 8;
/** 一级缩进的像素宽度（与 docx 的 420 twip/级大致同量级，只做视觉近似） */
const INDENT_PX = 22;
const SIZE_MIN_PT = 1;
const SIZE_MAX_PT = 400;
/** size 为 null 表示「跟随正文样式」，正文样式就是五号 10.5pt；下拉需要一个可对位的显示值 */
const SIZE_FALLBACK_PT = 10.5;
const ZOOM_MIN = 75;
const ZOOM_MAX = 150;
/** 图片缺失尺寸时的兜底（px），与 office-io 取自然尺寸失败时的兜底一致 */
const IMAGE_FALLBACK_W = 200;
const IMAGE_FALLBACK_H = 150;
const WIDTH_CLASSES = {
    narrow: "word-width-narrow",
    standard: "word-width-standard",
    wide: "word-width-wide",
};

/** 按背景亮度选文字色：亮底用深字，暗底用浅字（自定义页面底色时用） */
function pickTextColor(color) {
    const m = /^#([0-9a-fA-F]{6})$/.exec(String(color || ""));
    if (!m) return "#24252a";
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#24252a" : "#f2f2f5";
}

/** 纸张尺寸（CSS px，96dpi；与 docx 的 twip 值同一组预设） */
const PAGE_SIZES = {
    a4: { w: 794, h: 1122 },
    letter: { w: 816, h: 1056 },
    a5: { w: 559, h: 794 },
};
const PAGE_SIZE_ORDER = ["a4", "letter", "a5"];
/** 页面设置缺省值：A4、无自定义底色（跟随主题）、无页眉页脚文本、四边 72pt 页边距 */
const MARGIN_DEFAULT_PT = 72;
const MARGIN_MAX_PT = 288;
const MARGIN_MIN_PT = 0;
const DEFAULT_MARGINS = { top: MARGIN_DEFAULT_PT, right: MARGIN_DEFAULT_PT, bottom: MARGIN_DEFAULT_PT, left: MARGIN_DEFAULT_PT };
const DEFAULT_PAGE = { size: "a4", background: null, header: "", footer: "", margins: DEFAULT_MARGINS };
/** pt -> CSS px：纸张按 96dpi 布局，页边距/段前段后都用这个换算 */
const PT_TO_PX = 96 / 72;
const pageSizeOptions = () => [
    { label: "A4", value: "a4" },
    { label: "Letter", value: "letter" },
    { label: t("word.pageSizeA5", "A5"), value: "a5" },
];
const pageBgOptions = () => [
    { label: t("word.pageBgNone", "无（跟随主题）"), value: "" },
    { label: t("word.pageBgWhite", "白"), value: "#FFFFFF" },
    { label: t("word.pageBgCream", "米色"), value: "#FFF8E7" },
    { label: t("word.pageBgGray", "浅灰"), value: "#F2F2F7" },
    { label: t("word.pageBgBlue", "浅蓝"), value: "#DEEAF6" },
    { label: t("word.pageBgGreen", "浅绿"), value: "#E2EFDA" },
];

/** 字体族菜单：「默认」是界面标签（要翻译），字体名是要写进 data-font 的数据（不翻译） */
const fontOptions = () => [
    { label: t("word.fontDefault", "默认"), value: "" },
    { label: "微软雅黑", value: "微软雅黑" },
    { label: "宋体", value: "宋体" },
    { label: "楷体", value: "楷体" },
    { label: "黑体", value: "黑体" },
    { label: "Arial", value: "Arial" },
    { label: "Georgia", value: "Georgia" },
];
const SIZE_OPTIONS = [10.5, 12, 14, 18, 24, 36].map((pt) => ({ label: String(pt), value: String(pt) }));
/** 行距三档：1 / 1.5 / 2（模型空值 = 单倍，下拉仍显示 1） */
const LINE_SPACING_OPTIONS = [
    { label: t("word.lineSpacing1", "1 倍"), value: "1" },
    { label: t("word.lineSpacing15", "1.5 倍"), value: "1.5" },
    { label: t("word.lineSpacing2", "2 倍"), value: "2" },
];
/** 段前/段后可选磅值 */
const SPACE_PT_OPTIONS = [0, 6, 12, 18, 24, 36, 48, 72];
const spaceOptions = () => SPACE_PT_OPTIONS.map((pt) => ({ label: `${pt} ${t("word.spaceUnit", "磅")}`, value: String(pt) }));
/** 字色「自动」= 模型里的 null（跟随纸张前景色）；标签是界面文案，色值是数据 */
const colorOptions = () => [
    { label: t("word.colorAuto", "自动"), value: "" },
    { label: t("word.colorRed", "红"), value: "#FF0000" },
    { label: t("word.colorOrange", "橙"), value: "#ED7D31" },
    { label: t("word.colorYellow", "黄"), value: "#FFC000" },
    { label: t("word.colorGreen", "绿"), value: "#70AD47" },
    { label: t("word.colorBlue", "蓝"), value: "#0070C0" },
    { label: t("word.colorPurple", "紫"), value: "#7030A0" },
];
/** 突出显示（底纹）：「无」= null；色值走 `w:shd/@w:fill`，见 codecs/docx.js 头部说明 */
const highlightOptions = () => [
    { label: t("word.hlNone", "无"), value: "" },
    { label: t("word.hlYellow", "黄"), value: "#FFFF00" },
    { label: t("word.hlGreen", "绿"), value: "#92D050" },
    { label: t("word.hlCyan", "青"), value: "#00B0F0" },
    { label: t("word.hlPink", "粉"), value: "#FF99CC" },
];
const ZOOM_OPTIONS = [75, 100, 125, 150].map((z) => ({ label: z + "%", value: String(z) }));
const widthOptions = () => [
    { label: t("word.widthNarrow", "窄"), value: "narrow" },
    { label: t("word.widthStandard", "标准"), value: "standard" },
    { label: t("word.widthWide", "宽"), value: "wide" },
];

/** 样式组大按钮：命令 id -> 段式目标 */
const STYLE_TARGETS = {
    "word.styleNormal": { kind: PARAGRAPH, level: null },
    "word.styleH1": { kind: HEADING, level: 1 },
    "word.styleH2": { kind: HEADING, level: 2 },
    "word.styleH3": { kind: HEADING, level: 3 },
};
/** 对齐组：四个互斥 toggle 共用一个 align 字段，天然互斥 */
const ALIGN_COMMANDS = {
    "word.alignLeft": "left",
    "word.alignCenter": "center",
    "word.alignRight": "right",
    "word.alignJustify": "justify",
};

/** 标签页与控件声明：结构固定，但标签/提示随语言即时计算，故每次调用现建（语言切换即时生效） */
const buildTabs = () => [
    {
        id: "home",
        label: t("word.tabHome", "开始"),
        groups: [
            {
                label: t("word.groupUndo", "撤销"),
                items: [
                    { id: "word.undo", label: t("word.undo", "撤销"), icon: "undo", title: t("word.undoTip", "撤销上一步（⌘Z）") },
                    { id: "word.redo", label: t("word.redo", "重做"), icon: "redo", title: t("word.redoTip", "重做（⌘⇧Z）") },
                ],
            },
            {
                label: t("word.groupFont", "字体"),
                items: [
                    { id: "word.font", label: t("word.font", "字体"), type: "menu", options: fontOptions() },
                    { id: "word.size", label: t("word.size", "字号"), type: "menu", options: SIZE_OPTIONS },
                    { id: "word.bold", label: t("word.bold", "粗体"), icon: "bold", size: "large", type: "toggle", title: t("word.boldTip", "整块加粗（⌘B）") },
                    { id: "word.italic", label: t("word.italic", "斜体"), icon: "italic", size: "large", type: "toggle", title: t("word.italicTip", "整块倾斜（⌘I）") },
                    { id: "word.underline", label: t("word.underline", "下划线"), icon: "underline", size: "large", type: "toggle", title: t("word.underlineTip", "整块下划线（⌘U）") },
                    { id: "word.strike", label: t("word.strike", "删除线"), icon: "strike", size: "large", type: "toggle" },
                    { id: "word.color", label: t("word.color", "字色"), type: "menu", options: colorOptions() },
                    { id: "word.highlight", label: t("word.highlight", "突出显示"), type: "menu", options: highlightOptions() },
                    { id: "word.clear", label: t("word.clear", "清除格式"), icon: "clear", size: "large", title: t("word.clearTip", "把该块的段式与字符格式全部恢复默认（文字保留）") },
                ],
            },
            {
                label: t("word.groupParagraph", "段落"),
                items: [
                    { id: "word.alignLeft", label: t("word.alignLeft", "左对齐"), icon: "alignLeft", type: "toggle" },
                    { id: "word.alignCenter", label: t("word.alignCenter", "居中"), icon: "alignCenter", type: "toggle" },
                    { id: "word.alignRight", label: t("word.alignRight", "右对齐"), icon: "alignRight", type: "toggle" },
                    { id: "word.alignJustify", label: t("word.alignJustify", "两端"), icon: "alignJustify", type: "toggle" },
                    { id: "word.sepSpacing", separator: true },
                    { id: "word.lineSpacing", label: t("word.lineSpacing", "行距"), type: "menu", options: LINE_SPACING_OPTIONS },
                    { id: "word.spaceBefore", label: t("word.spaceBefore", "段前"), type: "menu", options: spaceOptions() },
                    { id: "word.spaceAfter", label: t("word.spaceAfter", "段后"), type: "menu", options: spaceOptions() },
                    { id: "word.sepList", separator: true },
                    { id: "word.listBullet", label: t("word.listBullet", "项目符号"), icon: "listBullet", title: t("word.listBulletTip", "切换当前段落的项目符号") },
                    { id: "word.listNumber", label: "1.", title: t("word.listNumberTip", "切换当前段落的编号（同列表连续序号）") },
                    { id: "word.sepIndent", separator: true },
                    { id: "word.indentInc", label: t("word.indentInc", "增加缩进"), icon: "increase", title: t("word.indentIncTip", "整块右移一级（最多 8 级）") },
                    { id: "word.indentDec", label: t("word.indentDec", "减少缩进"), icon: "decrease", title: t("word.indentDecTip", "整块左移一级（最少 0 级）") },
                ],
            },
            {
                label: t("word.groupStyle", "样式"),
                items: [
                    { id: "word.styleNormal", label: t("word.styleNormal", "正文"), icon: "page", size: "large" },
                    { id: "word.styleH1", label: t("word.styleH1", "标题 1"), size: "large" },
                    { id: "word.styleH2", label: t("word.styleH2", "标题 2"), size: "large" },
                    { id: "word.styleH3", label: t("word.styleH3", "标题 3"), size: "large" },
                ],
            },
            {
                label: t("word.groupDisplay", "显示"),
                items: [
                    { id: "word.marks", label: t("word.marks", "段落标记"), type: "toggle", title: t("word.marksTip", "显示 ¶ 与制表符位置") },
                ],
            },
        ],
    },
    {
        id: "insert",
        label: t("word.tabInsert", "插入"),
        groups: [
            {
                label: t("word.groupText", "文本"),
                items: [
                    { id: "word.date", label: t("word.date", "日期"), icon: "page", size: "large", title: t("word.dateTip", "在光标处插入「YYYY年M月D日」") },
                    { id: "word.tab", label: t("word.tabChar", "制表符"), size: "small", title: t("word.tabTip", "在光标处插入制表符（也可直接按 Tab）") },
                    { id: "word.newline", label: t("word.newline", "块内换行"), size: "small", title: t("word.newlineTip", "在同一块内换行（也可直接按 Shift+Enter）") },
                ],
            },
            {
                label: t("word.groupParagraph", "段落"),
                items: [
                    { id: "word.blankBelow", label: t("word.blankBelow", "下方空块"), icon: "slide", size: "large", title: t("word.blankBelowTip", "在当前块下方插入一个空块（沿用其对齐与缩进）") },
                ],
            },
            {
                label: t("word.groupImage", "图片"),
                items: [
                    { id: "word.insertImage", label: t("insertImage", "插入图片"), icon: "image", size: "large", title: t("insertImageTip", "从本地选择 PNG/JPEG/GIF/WebP 图片，插到当前块之后") },
                ],
            },
        ],
    },
    {
        id: "view",
        label: t("word.tabView", "视图"),
        groups: [
            {
                label: t("word.groupZoom", "显示比例"),
                items: [{ id: "word.zoom", label: t("word.zoom", "缩放"), type: "menu", options: ZOOM_OPTIONS }],
            },
            {
                label: t("word.groupLayout", "版式"),
                items: [{ id: "word.width", label: t("word.width", "页宽"), type: "menu", options: widthOptions() }],
            },
            {
                label: t("word.groupPage", "页面"),
                items: [
                    { id: "word.pageSize", label: t("word.pageSize", "纸张大小"), type: "menu", options: pageSizeOptions() },
                    { id: "word.pageBg", label: t("word.pageBg", "页面背景"), type: "menu", options: pageBgOptions() },
                    { id: "word.margins", label: t("word.margins", "页边距"), icon: "page", title: t("word.marginsTip", "设置纸张四边页边距（0–288 pt）") },
                    { id: "word.header", label: t("word.header", "页眉"), icon: "header", size: "large", title: t("word.headerTip", "编辑页眉文本（每行一段，存进文件并在重新打开时回读）") },
                    { id: "word.footer", label: t("word.footer", "页脚"), icon: "footer", size: "large", title: t("word.footerTip", "编辑页脚文本（每行一段，存进文件并在重新打开时回读）") },
                ],
            },
        ],
    },
];

/**
 * 标题层级归一：非 1..3 一律按正文。
 * @param {number|string|null} value 原始层级
 * @returns {number} 0 表示正文
 */
function levelOf(value) {
    const n = Number(value);
    return n === 1 || n === 2 || n === 3 ? n : 0;
}

/**
 * 对齐：只认枚举值（容忍大小写与空白），其余（含空串）为 null。
 * @param {unknown} value 原始值
 * @returns {string|null} ALIGN_VALUES 之一或 null
 */
function normAlign(value) {
    if (typeof value !== "string") return null;
    const key = value.trim().toLowerCase();
    return ALIGN_VALUES.includes(key) ? key : null;
}

/**
 * 缩进级数：非数字 -> 0，小数四舍五入，夹到 0..8（与编解码同口径）。
 * @param {unknown} value 原始值
 * @returns {number} 0..8
 */
function normIndent(value) {
    if (typeof value === "boolean") return 0;
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.min(INDENT_MAX, Math.max(0, Math.round(n)));
}

/**
 * 行距：空值/非数字/<=0 -> null（单倍、不写 XML）；其它按最接近的 1 / 1.5 / 2 档（与编解码同口径）。
 * @param {unknown} value 原始值
 * @returns {number|null} 1 | 1.5 | 2 | null
 */
function normLineSpacing(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "boolean") return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const options = [1, 1.5, 2];
    return options.reduce((best, v) => (Math.abs(v - n) < Math.abs(best - n) ? v : best), options[0]);
}

/**
 * 段前/段后：pt，非数字或负数归 0，四舍五入并夹到 0..72。
 * @param {unknown} value 原始值
 * @returns {number} 0..72
 */
function normSpacePt(value) {
    if (typeof value === "boolean") return 0;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(72, Math.round(n));
}

/**
 * 列表类型：只认 bullet / number，其它归 "none"。
 * @param {unknown} value 原始值
 * @returns {"none"|"bullet"|"number"}
 */
function normList(value) {
    if (typeof value !== "string") return "none";
    const key = value.trim().toLowerCase();
    return key === "bullet" || key === "number" ? key : "none";
}

/**
 * 单边页边距：非数字/负数回落 72pt，超过 288 夹到 288（与编解码同口径）。
 * @param {unknown} value 原始值（pt）
 * @returns {number} 0..288
 */
function normMarginPt(value) {
    if (typeof value === "boolean") return MARGIN_DEFAULT_PT;
    const n = Number(value);
    if (!Number.isFinite(n) || n < MARGIN_MIN_PT) return MARGIN_DEFAULT_PT;
    return Math.min(MARGIN_MAX_PT, n);
}

/**
 * 四边页边距规整：缺字段各自回落默认 72pt。
 * @param {object|null} raw 原始 margins
 * @returns {{top: number, right: number, bottom: number, left: number}}
 */
function normMargins(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    return {
        top: normMarginPt(src.top),
        right: normMarginPt(src.right),
        bottom: normMarginPt(src.bottom),
        left: normMarginPt(src.left),
    };
}

/**
 * 页面设置深拷贝：margins 是嵌套对象，进出撤销栈/read() 时不能共享引用。
 * @param {object} value 页面设置
 * @returns {object} 副本
 */
function clonePage(value) {
    const src = value && typeof value === "object" ? value : DEFAULT_PAGE;
    return { ...src, margins: { ...(src.margins || DEFAULT_MARGINS) } };
}

/**
 * 字体名：非空字符串、去空白、不含控制字符（会让行内 style 失效），否则 null。
 * @param {unknown} value 原始值
 * @returns {string|null} 字体名或 null
 */
function normFont(value) {
    if (typeof value !== "string") return null;
    const name = value.trim();
    if (name === "" || name.length > 64) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f<>]/.test(name)) return null;
    return name;
}

/**
 * 磅值：超出 1..400 或非数字 -> null（跟随样式），合法值归一到半磅精度。
 * @param {unknown} value 原始值
 * @returns {number|null} 磅值或 null
 */
function normSize(value) {
    if (typeof value === "boolean") return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < SIZE_MIN_PT || n > SIZE_MAX_PT) return null;
    return Math.round(n * 2) / 2;
}

/**
 * 图片像素尺寸：非数字/非正数用兜底值，其余四舍五入成整数 px。
 * @param {unknown} value 原始值
 * @param {number} fallback 兜底 px
 * @returns {number} 像素值
 */
function normImgPx(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(1, Math.round(n));
}

/**
 * 颜色：只认 `#RRGGBB`（大小写容忍，输出统一大写），其余（`auto`、`red`、空串）一律 null。
 * @param {unknown} value 原始值
 * @returns {string|null} `#RRGGBB` 或 null
 */
function normHex(value) {
    if (typeof value !== "string") return null;
    const raw = value.trim();
    if (/^auto$/i.test(raw)) return null;
    const m = /^#([0-9a-fA-F]{6})$/.exec(raw);
    return m ? "#" + m[1].toUpperCase() : null;
}

/* ───────────────────────── 纯文本工具 ───────────────────────── */

/** 当前日期，形如 `2026年10月5日`（月日不补零，与 Word 的中文日期域一致） */
function chineseDate(now = new Date()) {
    return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
}

/** 把行尾归一成 \n（Windows 剪贴板与 contenteditable 都可能给 \r\n） */
function normalizeEol(text) {
    return String(text === undefined || text === null ? "" : text).replace(/\r\n?/g, "\n");
}

/**
 * 建一个文稿视图。
 * @param {HTMLElement} viewEl 宿主容器（外壳的 `.office-view`）
 * @param {{onInput?: () => void, onSelectionChange?: () => void}} [opts] 内容变化 / 选区变化回调
 * @returns {object} 视图句柄（load/read/clear/focus/dispose/metric/ribbon/command/state/canUndo/canRedo/undo/redo/applyEdit）
 */
export function createView(viewEl, opts = {}) {
    useStyle(import.meta.url, "view-word.css");

    const onInput = typeof opts.onInput === "function" ? opts.onInput : () => {};
    const onSelection = typeof opts.onSelectionChange === "function" ? opts.onSelectionChange : () => {};

    let blocks = [];
    /** 最近聚焦过的块：ribbon 按钮点下来时选区已经跑掉了，靠它认「当前块」 */
    let activeNode = null;
    /** 失焦前记住的光标位置，让「插入」类命令仍能落在原来的光标处 */
    let caretNode = null;
    let caretPos = 0;
    let disposed = false;

    /* 视图态（不属于文档内容，因此不进撤销栈） */
    let zoom = 100;
    let widthPreset = "standard";
    let marksOn = false;
    /** 页面设置：纸张尺寸、底色与四边页边距。属于文档内容（存进文件、重新打开还原），不走撤销栈 */
    let page = clonePage(DEFAULT_PAGE);

    /* 历史：undoStack 存「改动前」的快照，redoStack 存「改动后」的快照 */
    let undoStack = [];
    let redoStack = [];
    /** 与上面两栈一一对应的页面设置快照（页眉/页脚改动也走撤销） */
    let undoPages = [];
    let redoPages = [];
    /** 上一次同步出来的模型：输入类改动的「改动前」基准（DOM 在 input 到达时已经变了） */
    let lastModel = [];
    /** 当前可合并的输入帧标记（null 表示不合并） */
    let mergeKey = null;
    /** 400ms 空闲即结束合并窗口，dispose 必须清掉 */
    let mergeTimer = null;
    /** 打字路径上的高度补偿节流：每帧最多一次，0 表示没有挂起的帧 */
    let zoomRaf = 0;

    /* ── 骨架：stage > layer > paper（layer 专门承接缩放后的高度补偿） ── */

    const stage = el("div", "word-stage");
    const layer = el("div", "word-zoom-layer");
    const paper = el("div", "word-paper");
    /* paper 内再分「页眉 / 正文 / 页脚」三段，正文段才是块的容器（块逻辑一律看 bodyBox） */
    const pageHeader = el("div", "word-header");
    const bodyBox = el("div", "word-body");
    const pageFooter = el("div", "word-footer");
    pageHeader.contentEditable = "false";
    pageFooter.contentEditable = "false";
    paper.append(pageHeader, bodyBox, pageFooter);
    layer.append(paper);
    stage.append(layer);
    viewEl.classList.add("word-view");
    viewEl.classList.add(WIDTH_CLASSES.standard);
    viewEl.textContent = "";
    viewEl.append(stage);

    /* 轻量页眉/页脚对话框：常驻 DOM、默认隐藏，只用 is-open 切换，避免反复增删监听；
       两个多行输入同时在窗，一次确定同时写回 header 与 footer */
    const pageDialog = el("div", "word-page-dialog");
    const pageDialogTitle = el("div", "word-page-dialog-title");
    const pageDialogHeaderInput = el("textarea", "word-page-dialog-input");
    const pageDialogFooterInput = el("textarea", "word-page-dialog-input");
    const pageDialogActions = el("div", "word-page-dialog-actions");
    const pageDialogCancel = el("button", "word-page-dialog-cancel");
    const pageDialogOk = el("button", "word-page-dialog-ok");
    pageDialogCancel.type = "button";
    pageDialogOk.type = "button";
    pageDialogActions.append(pageDialogCancel, pageDialogOk);
    pageDialog.append(pageDialogTitle, pageDialogHeaderInput, pageDialogFooterInput, pageDialogActions);
    viewEl.append(pageDialog);
    /** 点击的是哪个按钮（只有聚焦用途；null = 未打开） */
    let pageDialogField = null;

    /* 页边距对话框：四个数字输入（pt），确定时整体写回 page.margins 并进撤销栈 */
    const marginDialog = el("div", "word-page-dialog word-margin-dialog");
    const marginDialogTitle = el("div", "word-page-dialog-title");
    const marginDialogFields = el("div", "word-margin-dialog-fields");
    const marginDialogActions = el("div", "word-page-dialog-actions");
    const marginDialogCancel = el("button", "word-page-dialog-cancel word-margin-dialog-cancel");
    const marginDialogOk = el("button", "word-page-dialog-ok word-margin-dialog-ok");
    marginDialogCancel.type = "button";
    marginDialogOk.type = "button";
    const MARGIN_FIELDS = [
        { key: "top", label: () => t("word.marginTop", "上") },
        { key: "right", label: () => t("word.marginRight", "右") },
        { key: "bottom", label: () => t("word.marginBottom", "下") },
        { key: "left", label: () => t("word.marginLeft", "左") },
    ];
    const marginLabels = {};
    const marginInputs = {};
    MARGIN_FIELDS.forEach(({ key }) => {
        const field = el("label", "word-margin-dialog-field");
        const labelNode = el("span");
        const input = el("input", "word-margin-dialog-input");
        input.type = "number";
        input.min = String(MARGIN_MIN_PT);
        input.max = String(MARGIN_MAX_PT);
        input.step = "1";
        marginLabels[key] = labelNode;
        marginInputs[key] = input;
        field.append(labelNode, input);
        marginDialogFields.append(field);
    });
    marginDialogActions.append(marginDialogCancel, marginDialogOk);
    marginDialog.append(marginDialogTitle, marginDialogFields, marginDialogActions);
    viewEl.append(marginDialog);

    /* ── 块的构造与读取 ── */

    /**
     * 规范一个外来 Block（缺字段按默认值补，非法值规整，绝不抛错）。
     * @param {object} raw 原始块
     * @returns {object} 字段齐全且值域合法的块
     */
    function normalizeBlock(raw) {
        const src = raw || {};
        const level = src.kind === HEADING ? levelOf(src.level) : 0;
        if (src.kind === "image") {
            return {
                kind: "image",
                level: null,
                text: "",
                bold: false,
                italic: false,
                underline: false,
                strike: false,
                align: null,
                indent: 0,
                font: null,
                size: null,
                color: null,
                highlight: null,
                lineSpacing: null,
                spaceBefore: 0,
                spaceAfter: 0,
                list: "none",
                src: typeof src.src === "string" ? src.src : "",
                width: normImgPx(src.width, IMAGE_FALLBACK_W),
                height: normImgPx(src.height, IMAGE_FALLBACK_H),
                alt: typeof src.alt === "string" ? src.alt : "",
            };
        }
        return {
            kind: level ? HEADING : PARAGRAPH,
            level: level || null,
            text: normalizeEol(src.text),
            bold: !!src.bold,
            italic: !!src.italic,
            underline: !!src.underline,
            strike: !!src.strike,
            align: normAlign(src.align),
            indent: normIndent(src.indent),
            font: normFont(src.font),
            size: normSize(src.size),
            color: normHex(src.color),
            highlight: normHex(src.highlight),
            lineSpacing: normLineSpacing(src.lineSpacing),
            spaceBefore: normSpacePt(src.spaceBefore),
            spaceAfter: normSpacePt(src.spaceAfter),
            list: normList(src.list),
        };
    }

    /** @returns {object} 空白块（全默认值） */
    function blankBlock() {
        return normalizeBlock({});
    }

    /**
     * 把块的模型字段写进 `data-*`（文本不动）。空串代表该字段的默认值，
     * 这样 DOM 上永远有属性可读，`readBlock()` 不必区分「没写过」和「写成了默认」。
     * @param {HTMLElement} node 块元素
     * @param {object} block 块模型
     * @returns {void}
     */
    function writeBlockData(node, block) {
        const b = normalizeBlock(block);
        const isHeading = b.kind === HEADING;
        node.dataset.kind = isHeading ? HEADING : PARAGRAPH;
        node.dataset.level = isHeading ? String(b.level) : "0";
        FLAGS.forEach((flag) => { node.dataset[flag] = b[flag] ? "true" : "false"; });
        node.dataset.align = b.align || "";
        node.dataset.indent = String(b.indent);
        node.dataset.font = b.font || "";
        node.dataset.size = b.size === null ? "" : String(b.size);
        node.dataset.color = b.color || "";
        node.dataset.highlight = b.highlight || "";
        node.dataset.lineSpacing = b.lineSpacing === null ? "" : String(b.lineSpacing);
        node.dataset.spaceBefore = String(b.spaceBefore);
        node.dataset.spaceAfter = String(b.spaceAfter);
        node.dataset.list = b.list;
        node.dataset.placeholder = isHeading ? t("word.placeholderHeading", "输入标题…") : t("word.placeholderBody", "输入正文…");
        if (isHeading) {
            node.setAttribute("role", "heading");
            node.setAttribute("aria-level", String(b.level));
        } else {
            node.removeAttribute("role");
            node.removeAttribute("aria-level");
        }
    }

    /**
     * 把不能枚举的字段落成行内 style（字体名、磅值、色值、缩进级数、行距、段前段后）。
     * @param {HTMLElement} node 块元素
     * @returns {void}
     */
    function paintBlock(node) {
        const d = node.dataset;
        node.style.fontFamily = d.font ? String(d.font) + ", " + FONT_FALLBACK : "";
        node.style.fontSize = d.size ? String(d.size) + "pt" : "";
        node.style.color = d.color ? String(d.color) : "";
        node.style.backgroundColor = d.highlight ? String(d.highlight) : "";
        const indent = normIndent(d.indent);
        node.style.paddingLeft = indent > 0 ? String(indent * INDENT_PX) + "px" : "";
        const spacing = normLineSpacing(d.lineSpacing);
        node.style.lineHeight = spacing === null ? "" : String(spacing);
        const before = normSpacePt(d.spaceBefore);
        const after = normSpacePt(d.spaceAfter);
        node.style.marginTop = before > 0 ? `${Math.round(before * PT_TO_PX)}px` : "";
        node.style.marginBottom = after > 0 ? `${Math.round(after * PT_TO_PX)}px` : "";
    }

    /**
     * 改当前块的若干字段后重新落属性与样式（其余字段原样保留）。
     * @param {HTMLElement} node 块元素
     * @param {object} changes 要覆盖的字段
     * @returns {void}
     */
    function patchBlock(node, changes) {
        writeBlockData(node, { ...readBlock(node), ...changes });
        paintBlock(node);
    }

    /**
     * 按模型建一个块元素（文本一律走文本节点，换行建 `<br>`、制表符建 `.word-tab`，不拼 innerHTML）。
     * @param {object} block 块模型
     * @param {number} index 文档序号
     * @returns {HTMLElement} 块元素
     */
    function makeBlock(block, index) {
        const b = normalizeBlock(block);
        if (b.kind === "image") {
            const node = el("p", "word-block word-image");
            node.contentEditable = "false";
            node.tabIndex = 0;
            node.dataset.blockIndex = String(index);
            node.dataset.kind = "image";
            node.dataset.src = b.src;
            node.dataset.width = String(b.width);
            node.dataset.height = String(b.height);
            node.dataset.alt = b.alt;
            const img = el("img");
            img.src = b.src;
            img.alt = b.alt;
            img.draggable = false;
            // 存储尺寸为基准，纸宽由 CSS 的 max-width:100% 兜住
            img.style.width = String(b.width) + "px";
            img.style.height = "auto";
            node.append(img);
            return node;
        }
        const node = el("p", "word-block");
        node.contentEditable = "true";
        node.spellcheck = false;
        node.dataset.blockIndex = String(index);
        writeBlockData(node, b);
        paintBlock(node);
        fillText(node, b.text);
        return node;
    }

    /**
     * 从 `data-*` 读回 Block（文本走 DOM 遍历）。字段名与编解码一致。
     * @param {HTMLElement} node 块元素
     * @returns {object} 块模型
     */
    function readBlock(node) {
        const d = node.dataset;
        const level = levelOf(d.level);
        const isHeading = d.kind === HEADING && level > 0;
        const flags = {};
        FLAGS.forEach((flag) => { flags[flag] = d[flag] === "true"; });
        if (d.kind === "image") {
            return {
                kind: "image",
                level: null,
                text: "",
                bold: false,
                italic: false,
                underline: false,
                strike: false,
                align: null,
                indent: 0,
                font: null,
                size: null,
                color: null,
                highlight: null,
                lineSpacing: null,
                spaceBefore: 0,
                spaceAfter: 0,
                list: "none",
                src: d.src || "",
                width: normImgPx(d.width, IMAGE_FALLBACK_W),
                height: normImgPx(d.height, IMAGE_FALLBACK_H),
                alt: d.alt || "",
            };
        }
        return {
            kind: isHeading ? HEADING : PARAGRAPH,
            level: isHeading ? level : null,
            text: textOf(node),
            ...flags,
            align: normAlign(d.align),
            indent: normIndent(d.indent),
            font: normFont(d.font),
            size: normSize(d.size),
            color: normHex(d.color),
            highlight: normHex(d.highlight),
            lineSpacing: normLineSpacing(d.lineSpacing),
            spaceBefore: normSpacePt(d.spaceBefore),
            spaceAfter: normSpacePt(d.spaceAfter),
            list: normList(d.list),
        };
    }

    /**
     * 清空块并按 `\n` 重填：`\n` 建 `<br>`，连续换行之间补一个空格文本节点顶住行高。
     * @param {HTMLElement} node 块元素
     * @param {string} text 文本
     * @returns {void}
     */
    function fillText(node, text) {
        node.textContent = "";
        const lines = normalizeEol(text).split("\n");
        lines.forEach((line, i) => {
            if (i) node.append(document.createElement("br"));
            if (line === "" && i < lines.length - 1) node.append(document.createTextNode(" "));
            else appendTabbedText(node, line);
        });
        markEmpty(node);
    }

    /**
     * 追加一段文本，其中的 `\t` 拆成 `.word-tab` 元素：
     * 文本内容仍是制表符本身（`textOf` 读得回来）， marks 模式下才有东西可以被可视化高亮。
     * @param {HTMLElement} parent 目标节点
     * @param {string} text 不含换行的文本
     * @returns {void}
     */
    function appendTabbedText(parent, text) {
        String(text).split("\t").forEach((part, i) => {
            if (i) parent.append(el("span", "word-tab", "\t"));
            if (part) parent.append(document.createTextNode(part));
        });
    }

    /**
     * 块的纯文本：自己遍历子节点，`<br>` 记 `\n`、其它元素继续下钻。
     * 不用 `innerText`：它会按布局归一空白，制表符可能被折成空格，模型就开始漂。
     * @param {HTMLElement} node 块元素
     * @returns {string} 文本
     */
    function textOf(node) {
        let out = "";
        const walk = (cur) => {
            for (const child of Array.from(cur.childNodes || [])) {
                if (child.nodeType === Node.TEXT_NODE) out += String(child.textContent || "");
                else if (child.nodeName === "BR") out += "\n";
                else {
                    // 浏览器偶尔会塞 <div>（例如拖拽插入）：块级元素补一个换行再下钻
                    if (child.nodeName === "DIV" || child.nodeName === "P") out += "\n";
                    walk(child);
                }
            }
        };
        walk(node);
        return normalizeEol(out).replace(/\n+$/, "");
    }

    /**
     * 块内可见字符数（`<br>` 记 1，与光标偏移同一套口径）。
     * @param {HTMLElement} node 块元素
     * @returns {number} 长度
     */
    function leafLength(node) {
        let n = 0;
        for (const child of Array.from(node.childNodes)) n += leafLengthOf(child);
        return n;
    }

    /**
     * 任意子节点的可见长度。
     * @param {Node} child 子节点
     * @returns {number} 长度
     */
    function leafLengthOf(child) {
        if (child.nodeType === Node.TEXT_NODE) return String(child.textContent || "").length;
        if (child.nodeName === "BR") return 1;
        return leafLength(child);
    }

    /**
     * 维护 data-empty（空块占位提示用）。剥尾部空白时不含制表符：
     * marks 模式要显示它，Word 也认为「只有制表符」的段落不是空段落。
     * @param {HTMLElement} node 块元素
     * @returns {void}
     */
    function markEmpty(node) {
        if (node.dataset.kind === "image") {
            node.dataset.empty = "false";
            return;
        }
        node.dataset.empty = node.textContent.replace(/[\n\r  ]+$/, "") === "" ? "true" : "false";
    }

    /** @returns {HTMLElement[]} 纸张里的块（DOM 顺序即文档顺序） */
    function blockNodes() {
        return Array.from(bodyBox.children);
    }

    /**
     * 找事件目标（或选区锚点）所属的块。
     * 顺序不能颠倒：文本节点**没有** `closest()`，先判 `typeof closest` 会让「光标落在文本里」
     * 这一最常见的情况直接返回 null，功能区命令就再也认不出选区在哪一块了
     * （桩里文本节点同样没有 closest，所以掩盖不到真实浏览器以外）。
     * @param {EventTarget|Node|null} target 事件目标或 `Selection.anchorNode`
     * @returns {HTMLElement|null} 块元素
     */
    function closestBlock(target) {
        if (!target) return null;
        const node = target.nodeType === Node.TEXT_NODE ? target.parentElement : target;
        return node && typeof node.closest === "function" ? node.closest(".word-block") : null;
    }

    /** 纸被删空时补一个空段：模型永不为空 */
    function ensureBlocks() {
        if (bodyBox.children.length) return;
        bodyBox.append(makeBlock(blankBlock(), 0));
    }

    /**
     * 从 DOM 反推模型，并重排 data-blockIndex。
     * 顺手把 `lastModel` 钉在「这次读到的样子」上：input 事件到达时 DOM 已被浏览器改过，
     * 撤销帧的「改动前」基准只能取上次同步时的模型。
     */
    function syncFromDom() {
        ensureBlocks();
        blocks = blockNodes().map((node, i) => {
            node.dataset.blockIndex = String(i);
            return readBlock(node);
        });
        lastModel = blocks.map((b) => ({ ...b }));
    }

    /**
     * 当前功能区作用的目标块：优先选区所在块，其次最近聚焦的块，最后首块。
     * @returns {HTMLElement|null} 块元素
     */
    function currentBlock() {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
            // isConnected 这一道不能省：撤销/重做后旧块元素会脱离文档，而它身上仍带 .word-block，
            // closest() 从脱管子树上一样能命中，命中的话命令就打在「纸面之外」的节点上了
            const found = closestBlock(sel.anchorNode);
            if (found && found.isConnected) return found;
        }
        if (activeNode && activeNode.isConnected) return activeNode;
        return blockNodes()[0] || null;
    }

    /** @returns {object} 当前块的模型快照（功能区状态与命令的基准） */
    function currentModel() {
        const node = currentBlock();
        return node ? readBlock(node) : blankBlock();
    }

    /* ── 光标 ── */

    /**
     * 光标在块内的偏移（`<br>` 与 `\t` 各记 1）。光标不在该块时为 -1。
     * @param {HTMLElement} node 块元素
     * @returns {number} 偏移
     */
    function caretOffset(node) {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return -1;
        const { startContainer, startOffset } = sel.getRangeAt(0);
        if (!node.contains(startContainer)) return -1;
        if (startContainer === node) {
            let at = 0;
            for (let i = 0; i < startOffset && i < node.childNodes.length; i++) at += leafLengthOf(node.childNodes[i]);
            return at;
        }
        let total = 0;
        let hit = false;
        const walk = (cur) => {
            if (hit) return;
            if (cur === startContainer) {
                total += cur.nodeType === Node.TEXT_NODE ? startOffset : 0;
                hit = true;
                return;
            }
            if (cur.nodeType === Node.TEXT_NODE) { total += String(cur.textContent || "").length; return; }
            if (cur.nodeName === "BR") { total += 1; return; }
            for (const child of Array.from(cur.childNodes)) {
                walk(child);
                if (hit) return;
            }
        };
        walk(node);
        return hit ? total : -1;
    }

    /**
     * 命令可用的光标偏移：选区还在该块就用实时偏移；
     * 已经被 ribbon 按钮抢走焦点时，用失焦前记住的位置；都没有就落到块尾。
     * @param {HTMLElement} node 块元素
     * @returns {number} 偏移
     */
    function caretIn(node) {
        const live = caretOffset(node);
        if (live >= 0) {
            caretNode = node;
            caretPos = live;
            return live;
        }
        if (caretNode === node) return Math.min(caretPos, leafLength(node));
        return leafLength(node);
    }

    /**
     * 光标是否在该块末尾。
     * @param {HTMLElement} node 块元素
     * @returns {boolean} 是否在末尾
     */
    function caretAtEnd(node) {
        const at = caretOffset(node);
        return at >= 0 && at >= leafLength(node);
    }

    /**
     * 以当前光标为基点扩选到目标块的首/尾（Shift 跨块扩选用）。
     * `Selection.setBaseAndExtent` 允许反向选区，Range 不行，所以这里不用 Range。
     * @param {Node} base 基点节点
     * @param {number} baseOffset 基点偏移
     * @param {Node} extent 新光标位置节点
     * @param {number} extentOffset 新光标偏移
     * @returns {void}
     */
    function extendSelection(base, baseOffset, extent, extentOffset) {
        const sel = window.getSelection();
        if (!sel) return;
        sel.setBaseAndExtent(base, baseOffset, extent, extentOffset);
    }

    /**
     * 把「块内可见偏移」换算成 DOM 点（Range 用的容器与偏移）。
     * @param {HTMLElement} node 块元素
     * @param {number} want 目标偏移
     * @returns {{target: Node, offset: number}} DOM 点
     */
    function resolvePoint(node, want) {
        let target = node;
        let offset = 0;
        let remain = Math.max(0, want);
        let done = false;
        const walk = (cur) => {
            if (done) return;
            if (cur.nodeType === Node.TEXT_NODE) {
                if (remain <= cur.textContent.length) {
                    target = cur;
                    offset = remain;
                    done = true;
                    return;
                }
                remain -= cur.textContent.length;
                return;
            }
            if (cur.nodeName === "BR") {
                if (remain === 0) {
                    target = cur.parentNode;
                    offset = Array.prototype.indexOf.call(cur.parentNode.childNodes, cur);
                    done = true;
                    return;
                }
                remain -= 1;
                return;
            }
            for (const child of Array.from(cur.childNodes)) {
                walk(child);
                if (done) return;
            }
        };
        walk(node);
        if (!done) {
            target = node;
            offset = node.childNodes.length;
        }
        return { target, offset };
    }

    /**
     * 把光标放到块内指定偏移。
     * @param {HTMLElement} node 块元素
     * @param {number} want 目标偏移
     * @returns {void}
     */
    function placeCaret(node, want) {
        const point = resolvePoint(node, want);
        const range = document.createRange();
        range.setStart(point.target, point.offset);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        caretNode = node;
        // 目标偏移可能落在最后一个字符之后，按可见长度夹一下再存，免得失焦后插入点越界
        caretPos = Math.min(Math.max(0, want), leafLength(node));
    }

    /**
     * 选中块内一段文本（查找命中的高亮用），并让该块滚进可视区。
     * @param {HTMLElement} node 块元素
     * @param {number} start 起始偏移
     * @param {number} length 长度
     * @returns {void}
     */
    function selectRange(node, start, length) {
        const a = resolvePoint(node, start);
        const b = resolvePoint(node, start + length);
        const range = document.createRange();
        range.setStart(a.target, a.offset);
        range.setEnd(b.target, b.offset);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        node.focus();
        activeNode = node;
        caretNode = node;
        caretPos = Math.min(start + length, leafLength(node));
        if (typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
    }

    /**
     * 查找导航（外壳「上一个 / 下一个」）：从当前光标位置向前 / 向后循环找下一处命中，
     * 找到就选中并返回 true，整篇没有命中返回 false。大小写敏感，与替换口径一致。
     * @param {string} query 查找串
     * @param {number} dir 1 向下，-1 向上
     * @returns {boolean} 是否命中
     */
    function seek(query, dir) {
        const q = String(query || "");
        if (!q || disposed) return false;
        syncFromDom();
        const nodes = blockNodes();
        if (!nodes.length) return false;
        const forward = dir !== -1;
        const cur = currentBlock();
        const bi = Math.max(0, nodes.indexOf(cur));
        const base = cur ? caretIn(cur) : 0;
        for (let step = 0; step < nodes.length; step++) {
            const idx = ((bi + (forward ? step : -step)) % nodes.length + nodes.length) % nodes.length;
            const text = blocks[idx].text || "";
            let hit = -1;
            if (step === 0) {
                // 当前块：向下从光标后开始，向上找光标前的最后一处
                hit = forward ? text.indexOf(q, base) : (base > 0 ? text.lastIndexOf(q, base - 1) : -1);
            } else {
                hit = forward ? text.indexOf(q) : text.lastIndexOf(q);
            }
            if (hit < 0) continue;
            selectRange(nodes[idx], hit, q.length);
            onSelection();
            return true;
        }
        return false;
    }

    /**
     * 聚焦某块并把光标放到指定偏移（省略则按 atEnd 决定首/尾）。
     * @param {HTMLElement} node 块元素
     * @param {{offset?: number, atEnd?: boolean}} [pos] 光标位置
     * @returns {void}
     */
    function focusBlock(node, pos = {}) {
        node.focus();
        activeNode = node;
        if (typeof pos.offset === "number") placeCaret(node, pos.offset);
        else if (pos.atEnd) placeCaret(node, leafLength(node));
        else placeCaret(node, 0);
    }

    /**
     * 聚焦图片块：只把焦点交给块本身（不可编辑，别往里塞 Range）。
     * @param {HTMLElement} node 图片块
     * @returns {void}
     */
    function focusImageBlock(node) {
        node.focus();
        activeNode = node;
    }

    /**
     * 在选中块之后插入一个图片块（单独成帧，可撤销）。
     * @param {{src: string, width: number, height: number}} image 图片
     * @returns {boolean} 是否插入
     */
    function insertImageBlock(image) {
        if (disposed || !image || !image.src) return false;
        const node = currentBlock();
        if (!node || !node.isConnected) return false;
        beforeChange(null);
        const next = insertAfter(node, {
            kind: "image",
            src: image.src,
            width: image.width,
            height: image.height,
            alt: "",
        });
        syncFromDom();
        applyZoom();
        focusImageBlock(next);
        onInput();
        onSelection();
        return true;
    }

    /**
     * 整块删除图片（退格/删除与点击后按删除同一条路径），焦点落到相邻块。
     * @param {HTMLElement} node 图片块
     * @returns {void}
     */
    function removeImageBlock(node) {
        if (disposed || !node || !node.isConnected) return;
        beforeChange(null);
        const prev = node.previousElementSibling;
        const next = node.nextElementSibling;
        node.remove();
        ensureBlocks();
        syncFromDom();
        applyZoom();
        const target = prev || next || bodyBox.firstElementChild;
        if (target) {
            if (target.dataset.kind === "image") focusImageBlock(target);
            else focusBlock(target, prev ? { atEnd: true } : { offset: 0 });
        }
        onInput();
        onSelection();
    }

    /* ── 撤销栈 ── */

    /** @returns {object[]} 当前模型快照（深一层，字段全是标量，浅拷贝即可） */
    function snapshot() {
        syncFromDom();
        return blocks.map((b) => ({ ...b }));
    }

    /**
     * 改模型前调用：压入「改动前」的快照。
     * @param {string|null} mergeId 输入帧标记；同一次连续输入（间隔 <400ms）只留第一帧，
     *                              命令 / 粘贴 / applyEdit 传 null 表示「必须单独成帧」
     * @returns {void}
     */
    function beforeChange(mergeId) {
        if (mergeId !== null && mergeKey === mergeId && mergeTimer) {
            // 同一段连续输入：栈顶已经是这轮的起点，只把合并窗口往后推
            clearTimeout(mergeTimer);
            mergeTimer = setTimeout(endMerge, MERGE_MS);
            redoStack.length = 0;
            redoPages.length = 0;
            return;
        }
        if (mergeId === null) {
            // 命令 / 粘贴 / Enter 都在这一步之前不动 DOM，所以 DOM 读出来的就是「改动前」
            syncFromDom();
            undoStack.push(blocks.map((b) => ({ ...b })));
            undoPages.push(clonePage(page));
        } else {
            // 打字：浏览器已经改过 DOM，只能用上次同步的模型当「改动前」
            undoStack.push(lastModel.map((b) => ({ ...b })));
            undoPages.push(clonePage(page));
        }
        if (undoStack.length > HISTORY_MAX) {
            undoStack.shift();
            undoPages.shift();
        }
        redoStack.length = 0;
        redoPages.length = 0;
        mergeKey = mergeId;
        clearTimeout(mergeTimer);
        mergeTimer = mergeId === null ? null : setTimeout(endMerge, MERGE_MS);
    }

    /** 400ms 没再输入：结束本轮合并，下一次按键开新帧（定时器一并摘掉，dispose 靠这里对账） */
    function endMerge() {
        clearTimeout(mergeTimer);
        mergeTimer = null;
        mergeKey = null;
    }

    /** @returns {boolean} 是否可撤销 */
    function canUndo() {
        return undoStack.length > 0;
    }

    /** @returns {boolean} 是否可重做 */
    function canRedo() {
        return redoStack.length > 0;
    }

    /**
     * 渲染一组块（不动历史栈），并把缩放容器高度同步好。
     * @param {object[]} list 块模型数组
     * @returns {void}
     */
    function renderBlocks(list) {
        blocks = (list && list.length ? list : [blankBlock()]).map(normalizeBlock);
        bodyBox.textContent = "";
        bodyBox.append(...blocks.map((block, i) => makeBlock(block, i)));
        if (activeNode && !activeNode.isConnected) activeNode = null;
        caretNode = null;
        // 以 DOM 为准回读一次：lastModel 与 read() 必须同源，否则撤销会退到「纸面上没有」的模型
        syncFromDom();
        applyZoom();
    }

    /** @returns {boolean} 是否真的撤销了一步 */
    function undo() {
        if (!canUndo()) return false;
        redoStack.push(snapshot());
        redoPages.push(clonePage(page));
        const prevPage = undoPages.pop();
        if (prevPage) {
            page = prevPage;
            applyPage();
        }
        renderBlocks(undoStack.pop());
        endMerge();
        onInput();
        onSelection();
        return true;
    }

    /** @returns {boolean} 是否真的重做了一步 */
    function redo() {
        if (!canRedo()) return false;
        undoStack.push(snapshot());
        undoPages.push(clonePage(page));
        const nextPage = redoPages.pop();
        if (nextPage) {
            page = nextPage;
            applyPage();
        }
        renderBlocks(redoStack.pop());
        endMerge();
        onInput();
        onSelection();
        return true;
    }

    /**
     * 外壳（查找替换）批量改模型的唯一入口：mutate 就地改草稿，改动照样压一帧。
     * @param {(model: {blocks: object[]}) => void} mutate 就地修改模型
     * @returns {void}
     */
    function applyEdit(mutate) {
        if (typeof mutate !== "function") return;
        const depth = undoStack.length;
        beforeChange(null);
        const draft = { blocks: snapshot().map((b) => ({ ...b })) };
        try {
            mutate(draft);
        } catch (err) {
            // 改坏了就把刚压的那帧退回去，别留一条「什么都没变」的历史
            while (undoStack.length > depth) undoStack.pop();
            while (undoPages.length > depth) undoPages.pop();
            throw err;
        }
        renderBlocks(draft.blocks);
        onInput();
        onSelection();
    }

    /* ── 结构编辑（Enter / 退格 / 粘贴） ── */

    /**
     * 在当前块之后插入一个新块。
     * @param {HTMLElement} node 参考块
     * @param {object} flags 新块的格式字段
     * @returns {HTMLElement} 新块
     */
    function insertAfter(node, flags) {
        const next = makeBlock({ ...blankBlock(), ...flags, text: "" }, 0);
        node.after(next);
        return next;
    }

    /**
     * Enter：在光标处把当前块切成两块（当前块之后新建）。
     * @param {HTMLElement} node 当前块
     * @returns {void}
     */
    function splitBlock(node) {
        const block = readBlock(node);
        // 标题里回车接一个正文段（不带标题格式），正文里回车沿用同一段式与全部字符格式
        const inherit = block.kind === HEADING ? {} : { ...block, kind: PARAGRAPH, level: null };
        const sel = window.getSelection();
        const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
        const next = insertAfter(node, { kind: PARAGRAPH, level: null, ...inherit });
        if (range && node.contains(range.commonAncestorContainer)) {
            if (!range.collapsed) range.deleteContents();
            const tail = range.cloneRange();
            tail.setEnd(node, node.childNodes.length);
            next.append(tail.extractContents());
        }
        trimBreaks(node);
        trimBreaks(next);
        markEmpty(node);
        markEmpty(next);
        syncFromDom();
        focusBlock(next, { offset: 0 });
        applyZoom();
        onInput();
        onSelection();
    }

    /** 去掉块首尾多余的 `<br>`：拆块后两侧都可能留下空行 */
    function trimBreaks(node) {
        while (node.firstChild && node.firstChild.nodeName === "BR") node.firstChild.remove();
        while (node.lastChild && node.lastChild.nodeName === "BR") node.lastChild.remove();
    }

    /**
     * 块首退格：与上一块合并，光标停在接缝处（沿用上一块的格式，与 Word 的段落合并一致）。
     * @param {HTMLElement} node 当前块
     * @returns {void}
     */
    function mergeIntoPrevious(node) {
        const prev = node.previousElementSibling;
        if (!prev) return;
        const head = textOf(prev);
        fillText(prev, head + textOf(node));
        node.remove();
        ensureBlocks();
        syncFromDom();
        focusBlock(prev, { offset: head.length });
        applyZoom();
        onInput();
        onSelection();
    }

    /**
     * 粘贴纯文本：按行拆成多块（行内制表符保留成 `.word-tab`）。
     * @param {HTMLElement} node 当前块
     * @param {string} raw 剪贴板文本
     * @returns {void}
     */
    function pasteText(node, raw) {
        const lines = normalizeEol(raw).split("\n");
        const block = readBlock(node);
        // 粘贴的第一行接在原光标处，其余行各起一块，块格式沿用当前块
        insertAtCaret(node, lines[0] || "");
        let cur = node;
        for (let i = 1; i < lines.length; i++) {
            cur = insertAfter(cur, { ...block, text: "" });
            insertAtCaret(cur, lines[i] || "");
        }
        syncFromDom();
        if (lines.length > 1) focusBlock(cur, {});
        applyZoom();
        onInput();
        onSelection();
    }

    /**
     * 在块内光标处插入文本（`\n` 建 `<br>`、`\t` 建 `.word-tab`）：
     * 走「读文本 → 拼接 → 重填 → 放光标」，避免 Range 拆分文本节点时把 `.word-tab` 结构写坏。
     * @param {HTMLElement} node 块元素
     * @param {string} text 要插入的文本
     * @returns {void}
     */
    function insertAtCaret(node, text) {
        if (!text) {
            markEmpty(node);
            return;
        }
        const base = textOf(node);
        const cut = Math.max(0, Math.min(base.length, caretIn(node)));
        fillText(node, base.slice(0, cut) + text + base.slice(cut));
        placeCaret(node, cut + String(text).length);
    }

    /* ── 功能区命令实现 ── */

    /**
     * 功能区命令的唯一出口：压一帧（命令不合并）→ 改当前块 → 同步模型与视图 → 通知外壳。
     * @param {(node: HTMLElement) => void} mutate 就地改块元素
     * @returns {boolean} 有没有目标块可改
     */
    function editCurrentBlock(mutate) {
        const node = currentBlock();
        if (!node || !node.isConnected) return false;
        // 图片块不承载文字格式：字符/段落命令一律不作用，避免 writeBlockData 把它改回普通段落
        if (node.dataset.kind === "image") return false;
        beforeChange(null);
        mutate(node);
        paintBlock(node);
        markEmpty(node);
        syncFromDom();
        onInput();
        onSelection();
        return true;
    }

    /**
     * 写当前块的某个字段（null/undefined 落成空串 = 该字段默认值）。
     * @param {string} name 字段名（与 data-* 同名）
     * @param {string|null|undefined} value 值
     * @returns {boolean} 是否执行
     */
    function setField(name, value) {
        return editCurrentBlock((node) => {
            patchBlock(node, { [name]: value === undefined || value === null ? "" : value });
        });
    }

    /**
     * 翻转当前块的某个字符开关。
     * @param {string} flag bold/italic/underline/strike 之一
     * @returns {boolean} 是否执行
     */
    function toggleFlag(flag) {
        return editCurrentBlock((node) => {
            patchBlock(node, { [flag]: node.dataset[flag] !== "true" });
        });
    }

    /**
     * 翻转当前块的项目符号/编号：已是目标类型就回到 none。
     * @param {"bullet"|"number"} kind 列表类型
     * @returns {boolean} 是否执行
     */
    function toggleList(kind) {
        return editCurrentBlock((node) => {
            patchBlock(node, { list: normList(node.dataset.list) === kind ? "none" : kind });
        });
    }

    /**
     * 设置对齐：点当前生效的那个再点一次 = 回到「跟随默认」（align 归 null）。
     * @param {string} value left/center/right/justify
     * @returns {boolean} 是否执行
     */
    function setAlign(value) {
        return editCurrentBlock((node) => {
            patchBlock(node, { align: normAlign(node.dataset.align) === value ? null : value });
        });
    }

    /**
     * 缩进增减（0..8 夹紧；到边界就只是「命令已识别，值不变」）。
     * @param {number} delta +1 / -1
     * @returns {boolean} 是否执行
     */
    function bumpIndent(delta) {
        return editCurrentBlock((node) => {
            patchBlock(node, { indent: normIndent(normIndent(node.dataset.indent) + delta) });
        });
    }

    /**
     * 段落样式：正文 / 标题 1..3。
     * @param {string} kind 块类型
     * @param {number|null} level 标题层级
     * @returns {boolean} 是否执行
     */
    function applyStyle(kind, level) {
        return editCurrentBlock((node) => {
            patchBlock(node, { kind, level });
        });
    }

    /**
     * 清除当前块的全部格式（文字保留），回到正文 + 全默认。
     * @returns {boolean} 是否执行
     */
    function clearFormatting() {
        return editCurrentBlock((node) => {
            writeBlockData(node, blankBlock());
        });
    }

    /**
     * 在当前块光标处插入一段文本（插入类命令共用，各自单独成帧）。
     * @param {string} text 文本
     * @returns {boolean} 是否执行
     */
    function insertTextCommand(text) {
        const node = currentBlock();
        if (!node || !node.isConnected) return false;
        beforeChange(null);
        insertAtCaret(node, text);
        markEmpty(node);
        syncFromDom();
        onInput();
        onSelection();
        return true;
    }

    /**
     * 视图缩放：CSS 变量驱动 `.word-paper` 的 `transform: scale()`，再手动同步滚动容器
     * （`.word-zoom-layer`）高度成缩放后的视觉高度。
     * 不用 CSS `zoom`：跨引擎语义不一致（Firefox 长期不支持）；会重取整布局值（边框、行高、
     * 字号），纸张排版不再等于 docx 磅值；与 getBoundingClientRect / 滚动位置组合会算错。
     * scale() 只改视觉、走合成层不掉帧，打印样式里一句即可归零回 1:1。
     * @param {number} level 百分比（75..150）
     * @returns {boolean} 是否执行
     */
    function setZoom(level) {
        const next = Math.round(Number(level));
        if (!Number.isFinite(next)) return false;
        zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
        applyZoom();
        return true;
    }

    /**
     * 页宽预设（窄 / 标准 / 宽）：切成 CSS 类，让 `max-width` 由样式表决定。
     * @param {string} preset narrow|standard|wide
     * @returns {boolean} 是否执行
     */
    function setWidth(preset) {
        const cls = WIDTH_CLASSES[preset];
        if (!cls) return false;
        widthPreset = preset;
        Object.keys(WIDTH_CLASSES).forEach((key) => viewEl.classList.toggle(WIDTH_CLASSES[key], key === preset));
        applyZoom();
        return true;
    }

    /**
     * 纸张大小（A4 / Letter / A5）：写进文档模型，保存后随文件带回。
     * @param {string} size 尺寸键
     * @returns {boolean} 是否执行
     */
    function setPageSize(size) {
        if (!PAGE_SIZE_ORDER.includes(size)) return false;
        page.size = size;
        applyPage();
        applyZoom();
        onInput();
        return true;
    }

    /**
     * 页面背景色：`""` 表示跟随主题；其余写 `#RRGGBB`。
     * @param {string} value 颜色或空串
     * @returns {boolean} 是否执行
     */
    function setPageBg(value) {
        const color = String(value || "").trim() === "" ? null : normHex(value);
        if (String(value || "").trim() !== "" && !color) return false;
        page.background = color;
        applyPage();
        onInput();
        return true;
    }

    /**
     * 打开页眉/页脚对话框：两个输入都预填当前文本，点击哪个按钮就聚焦哪一栏。
     * @param {"header"|"footer"} field 被点击的字段（只决定聚焦）
     * @returns {boolean} 是否执行
     */
    function openPageDialog(field) {
        if (field !== "header" && field !== "footer") return false;
        pageDialogField = field;
        pageDialogTitle.textContent = `${t("word.header", "页眉")} / ${t("word.footer", "页脚")}`;
        pageDialogHeaderInput.placeholder = t("word.headerPlaceholder", "输入页眉文本，每行一段");
        pageDialogFooterInput.placeholder = t("word.footerPlaceholder", "输入页脚文本，每行一段");
        pageDialogHeaderInput.value = page.header;
        pageDialogFooterInput.value = page.footer;
        pageDialogCancel.textContent = t("cancel", "取消");
        pageDialogOk.textContent = t("ok", "确定");
        pageDialog.classList.add("is-open");
        const target = field === "header" ? pageDialogHeaderInput : pageDialogFooterInput;
        if (typeof target.focus === "function") target.focus();
        return true;
    }

    /** 关闭对话框（不改模型）。@returns {void} */
    function closePageDialog() {
        pageDialogField = null;
        pageDialog.classList.remove("is-open");
    }

    /**
     * 确定：两栏换行统一成 \n，有变化才写回 page 并重绘/标脏（一次撤销帧）；没变就只关窗。
     * @returns {boolean} 是否执行
     */
    function confirmPageDialog() {
        if (!pageDialogField) return false;
        const header = String(pageDialogHeaderInput.value ?? "").replace(/\r\n?/g, "\n");
        const footer = String(pageDialogFooterInput.value ?? "").replace(/\r\n?/g, "\n");
        if (header !== page.header || footer !== page.footer) {
            beforeChange(null);
            page.header = header;
            page.footer = footer;
            applyPage();
            onInput();
        }
        closePageDialog();
        return true;
    }

    /**
     * 打开页边距对话框：四个输入预填当前四边（pt），确定时整页重绘并进撤销栈。
     * @returns {boolean} 是否执行
     */
    function openMarginDialog() {
        marginDialogTitle.textContent = t("word.margins", "页边距");
        MARGIN_FIELDS.forEach(({ key, label }) => {
            marginLabels[key].textContent = label();
            marginInputs[key].value = String(page.margins[key]);
            marginInputs[key].placeholder = String(MARGIN_DEFAULT_PT);
        });
        marginDialogCancel.textContent = t("cancel", "取消");
        marginDialogOk.textContent = t("ok", "确定");
        marginDialog.classList.add("is-open");
        if (typeof marginInputs.top.focus === "function") marginInputs.top.focus();
        return true;
    }

    /** 关闭页边距对话框（不改模型）。@returns {void} */
    function closeMarginDialog() {
        marginDialog.classList.remove("is-open");
    }

    /**
     * 确定页边距：四边各自规整（非数字/负数 -> 72，>288 -> 288），有变化才写回并重绘/标脏。
     * @returns {boolean} 是否执行
     */
    function confirmMarginDialog() {
        const next = normMargins({
            top: marginInputs.top.value,
            right: marginInputs.right.value,
            bottom: marginInputs.bottom.value,
            left: marginInputs.left.value,
        });
        const changed = ["top", "right", "bottom", "left"].some((key) => next[key] !== page.margins[key]);
        if (changed) {
            beforeChange(null);
            page = { ...page, margins: next };
            applyPage();
            onInput();
        }
        closeMarginDialog();
        return true;
    }

    /** 把缩放值落成 CSS 变量 + 容器高度。
     * 读取 `offsetHeight`（未缩放的布局高度）会触发一次回流，但只在结构性改动后发生，
     * 打字路径上每帧一次，成本与 contenteditable 自身的重排相比可以忽略。
     * @returns {void}
     */
    function applyZoom() {
        if (disposed) return;
        const ratio = zoom / 100;
        viewEl.style.setProperty("--word-zoom", String(ratio));
        // 行内 transform 与 CSS 变量二选一地写清楚，ribbon 上改缩放不会重建 DOM
        paper.style.transform = "scale(" + ratio + ")";
        paper.style.transformOrigin = "top left";
        const natural = paper.offsetHeight || paper.getBoundingClientRect().height || 0;
        layer.style.height = Math.round(natural * ratio) + "px";
    }

    /**
     * 打字路径专用：把 applyZoom 折到下一帧。offsetHeight 会强制回流，
     * 逐键同步读等于每敲一字都重排整篇文档；同一帧内的多次调用只保留最后一次。
     * 桩里没有 rAF 时退回同步调用（行为不变，只是不省那次回流）。
     */
    function scheduleZoom() {
        if (disposed || zoomRaf) return;
        if (typeof requestAnimationFrame !== "function") { applyZoom(); return; }
        zoomRaf = requestAnimationFrame(() => {
            zoomRaf = 0;
            applyZoom();
        });
    }

    /**
     * 段落标记与制表符可视化：只切一个类，文本节点一个字都不动（`.word-tab` 本来就带着 `\t`）。
     * @returns {boolean} 是否执行
     */
    function toggleMarks() {
        marksOn = !marksOn;
        viewEl.classList.toggle("show-marks", marksOn);
        return true;
    }

    /* ── 监听 ── */

    function onKeydown(e) {
        const node = closestBlock(e.target);
        if (!node) return;
        // 输入法拼音未上屏时一律放行，否则 Enter / Backspace 会打断候选词
        if (e.isComposing || e.keyCode === 229) return;
        const mod = e.ctrlKey || e.metaKey;
        if (node.dataset.kind === "image") {
            // 图片块不可编辑：退格/删除整块移除；上下键按块移动焦点；其余按键不作用
            if (e.key === "Backspace" || e.key === "Delete") {
                e.preventDefault();
                removeImageBlock(node);
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                const target = e.key === "ArrowDown" ? node.nextElementSibling : node.previousElementSibling;
                if (target) {
                    e.preventDefault();
                    if (target.dataset.kind === "image") focusImageBlock(target);
                    else focusBlock(target, e.key === "ArrowDown" ? { offset: 0 } : { atEnd: true });
                    onSelection();
                }
            }
            return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            beforeChange(null);
            splitBlock(node);
            return;
        }
        // Shift+Enter：块内换行交给浏览器插 <br>，textOf() 认得它（`\n` 记 1 字符）；
        // 撤销帧不用在这里补 —— 紧随其后的 input 会把「插 <br> 之前」的模型压进栈
        if (e.key === "Enter" && e.shiftKey) return;
        if (e.key === "Tab") {
            e.preventDefault();
            insertTextCommand("\t");
            return;
        }
        // 退格合并与上下方向键的判据用实时光标（caretIn 会在选区跑掉时退到块尾，这里要的是精确位置）
        if (e.key === "Backspace" && !mod && !e.altKey && caretOffset(node) === 0 && node.previousElementSibling) {
            e.preventDefault();
            beforeChange(null);
            mergeIntoPrevious(node);
            return;
        }
        if (mod && (e.key === "b" || e.key === "B")) {
            e.preventDefault();
            toggleFlag("bold");
            return;
        }
        if (mod && (e.key === "i" || e.key === "I")) {
            e.preventDefault();
            toggleFlag("italic");
            return;
        }
        if (mod && (e.key === "u" || e.key === "U")) {
            // 下划线现在在 Block 里了：挡掉浏览器插 <u> 标签，改成块级开关
            e.preventDefault();
            toggleFlag("underline");
            return;
        }
        if (e.key === "ArrowDown" && !e.shiftKey && !mod && caretAtEnd(node) && node.nextElementSibling) {
            e.preventDefault();
            focusBlock(node.nextElementSibling, { offset: 0 });
            onSelection();
            return;
        }
        if (e.key === "ArrowUp" && !e.shiftKey && !mod && caretOffset(node) === 0 && node.previousElementSibling) {
            e.preventDefault();
            focusBlock(node.previousElementSibling, { atEnd: true });
            onSelection();
            return;
        }
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.shiftKey && !mod) {
            const target = e.key === "ArrowDown" ? node.nextElementSibling : node.previousElementSibling;
            if (!target) return;
            e.preventDefault();
            const sel = window.getSelection();
            const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
            if (!range) return;
            // 基点留在原光标，光标扩到相邻块的首/尾（选区不在块内时退回块起点）
            const inside = node.contains(range.startContainer) ? range.startContainer : node;
            const at = node.contains(range.startContainer) ? range.startOffset : 0;
            if (e.key === "ArrowDown") extendSelection(inside, at, target, target.childNodes.length);
            else extendSelection(inside, at, target, 0);
            activeNode = target;
            onSelection();
            return;
        }
        if (e.key === "Delete" && !e.shiftKey && !mod && !node.nextElementSibling && textOf(node) === "") {
            // 末块已空：再按删除无处可删，挡掉浏览器补 <br> 的默认动作
            e.preventDefault();
        }
    }

    function onInputEvent(e) {
        const node = closestBlock(e.target);
        if (!node) return;
        // 打字属于同一段连续输入：400ms 内合并成一帧（见 beforeChange）
        beforeChange("type");
        markEmpty(node);
        syncFromDom();
        scheduleZoom();
        onInput();
    }

    function onPaste(e) {
        const node = closestBlock(e.target);
        if (!node) return;
        e.preventDefault();
        const clip = e.clipboardData || window.clipboardData;
        const raw = clip ? clip.getData("text/plain") : "";
        // 粘贴是一步结构性改动，必须单独成帧，否则撤销会把「粘贴前的旧文本」留在同一帧里
        beforeChange(null);
        pasteText(node, String(raw || ""));
    }

    /**
     * 点图片块：把焦点交给它（后续 Backspace/Delete 才能整块删除），不往块内塞光标。
     * @param {MouseEvent} e 点击事件
     * @returns {void}
     */
    function onPaperClick(e) {
        const node = closestBlock(e.target);
        if (!node || node.dataset.kind !== "image") return;
        e.preventDefault();
        focusImageBlock(node);
        onSelection();
    }

    function onFocusIn(e) {
        const node = closestBlock(e.target);
        if (!node) return;
        activeNode = node;
        onSelection();
    }

    function onFocusOut(e) {
        const node = closestBlock(e.target);
        if (node) {
            markEmpty(node);
            // 选区即将跑到 ribbon 按钮上：把当前位置记下来，插入类命令才还落得准
            const at = caretOffset(node);
            if (at >= 0) {
                caretNode = node;
                caretPos = at;
            }
        }
        syncFromDom();
    }

    /** 光标在同一块内移动也要让功能区跟上（外壳靠它刷 toggle 按下态） */
    function onDocumentSelectionChange() {
        const node = currentBlock();
        if (!node) return;
        const at = caretOffset(node);
        if (at >= 0) {
            caretNode = node;
            caretPos = at;
        }
        activeNode = node;
        onSelection();
    }

    paper.addEventListener("keydown", onKeydown);
    paper.addEventListener("click", onPaperClick);
    paper.addEventListener("input", onInputEvent);
    paper.addEventListener("paste", onPaste);
    paper.addEventListener("focusin", onFocusIn);
    paper.addEventListener("focusout", onFocusOut);
    document.addEventListener("selectionchange", onDocumentSelectionChange);
    pageDialogOk.addEventListener("click", confirmPageDialog);
    pageDialogCancel.addEventListener("click", closePageDialog);
    marginDialogOk.addEventListener("click", confirmMarginDialog);
    marginDialogCancel.addEventListener("click", closeMarginDialog);

    /* ── 对外 API ── */

    /**
     * 规整页面设置：未知尺寸回落 A4，非法底色回落 null，页眉页脚只认字符串，
     * 页边距四边各自规整（默认 72pt，0..288）。
     * @param {unknown} raw 原始页面设置
     * @returns {{size: string, background: string|null, header: string, footer: string, margins: object}}
     */
    function normPage(raw) {
        const src = raw && typeof raw === "object" ? raw : {};
        const size = PAGE_SIZE_ORDER.includes(src.size) ? src.size : DEFAULT_PAGE.size;
        return {
            size,
            background: normHex(src.background),
            header: typeof src.header === "string" ? src.header : "",
            footer: typeof src.footer === "string" ? src.footer : "",
            margins: normMargins(src.margins),
        };
    }

    /**
     * 把页眉页脚落到纸张顶/底：空串隐藏（data-empty），非空按原文换行显示。
     * @returns {void}
     */
    function applyPageChrome() {
        pageHeader.textContent = page.header;
        pageHeader.dataset.empty = page.header ? "false" : "true";
        pageFooter.textContent = page.footer;
        pageFooter.dataset.empty = page.footer ? "false" : "true";
    }

    /**
     * 把页面设置落到 CSS 变量上：纸张宽高 + 四边页边距（pt -> px）+ 自定义底色（含配套的文字/分隔线对比色）。
     * 不设底色时移除行内变量，交回主题（浅色白纸 / 深色灰纸）。
     * @returns {void}
     */
    function applyPage() {
        const size = PAGE_SIZES[page.size] || PAGE_SIZES.a4;
        viewEl.style.setProperty("--word-page-width", `${size.w}px`);
        viewEl.style.setProperty("--word-page-height", `${size.h}px`);
        const m = page.margins;
        viewEl.style.setProperty("--word-margin-top", `${Math.round(m.top * PT_TO_PX)}px`);
        viewEl.style.setProperty("--word-margin-right", `${Math.round(m.right * PT_TO_PX)}px`);
        viewEl.style.setProperty("--word-margin-bottom", `${Math.round(m.bottom * PT_TO_PX)}px`);
        viewEl.style.setProperty("--word-margin-left", `${Math.round(m.left * PT_TO_PX)}px`);
        applyPageChrome();
        if (!page.background) {
            ["--word-page", "--word-page-text", "--word-page-border", "--word-placeholder",
                "--word-rule", "--word-soft", "--word-focus-ring", "--word-mark"].forEach((name) => {
                viewEl.style.removeProperty(name);
            });
            return;
        }
        const dark = pickTextColor(page.background) === "#f2f2f5";
        viewEl.style.setProperty("--word-page", page.background);
        viewEl.style.setProperty("--word-page-text", pickTextColor(page.background));
        viewEl.style.setProperty("--word-page-border", dark ? "rgba(255, 255, 255, 0.12)" : "rgba(0, 0, 0, 0.07)");
        viewEl.style.setProperty("--word-placeholder", dark ? "rgba(255, 255, 255, 0.32)" : "rgba(0, 0, 0, 0.28)");
        viewEl.style.setProperty("--word-rule", dark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.08)");
        viewEl.style.setProperty("--word-soft", dark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.05)");
        viewEl.style.setProperty("--word-focus-ring", dark ? "rgba(255, 255, 255, 0.04)" : "rgba(0, 0, 0, 0.035)");
        viewEl.style.setProperty("--word-mark", dark ? "rgba(255, 255, 255, 0.4)" : "rgba(0, 0, 0, 0.34)");
    }

    /**
     * 渲染模型（整体替换纸张；换文档即换历史，栈清空）。
     * @param {{blocks?: object[], page?: {size?: string, background?: string|null, header?: string, footer?: string, margins?: object}}} model 文档模型
     * @returns {void}
     */
    function load(model) {
        if (disposed) return;
        const src = model && Array.isArray(model.blocks) && model.blocks.length ? model.blocks : [blankBlock()];
        undoStack = [];
        redoStack = [];
        undoPages = [];
        redoPages = [];
        endMerge();
        activeNode = null;
        caretNode = null;
        page = normPage(model && model.page);
        applyPage();
        renderBlocks(src);
    }

    /**
     * 从 DOM 反推当前模型（字段齐全，可直接交给 docx 编码器）。
     * @returns {{blocks: object[], page: {size: string, background: string|null, header: string, footer: string, margins: object}}} 文档模型
     */
    function read() {
        if (disposed) return { blocks: blocks.map((b) => ({ ...b })), page: clonePage(page) };
        syncFromDom();
        return { blocks: blocks.map((b) => ({ ...b })), page: clonePage(page) };
    }

    /**
     * 装入空白模型并渲染。
     * @returns {void}
     */
    function clear() {
        load({ blocks: [blankBlock()] });
    }

    /**
     * 焦点落到第一个可编辑块。
     * @returns {void}
     */
    function focus() {
        const first = bodyBox.firstElementChild;
        if (!first) return;
        focusBlock(first, { offset: 0 });
    }

    /**
     * 状态栏文本。
     * @returns {string} 形如 `123 字`
     */
    function metric() {
        const text = read().blocks.map((b) => b.text).join("\n");
        const count = (text.match(/\S/g) || []).length;
        return t("word.wordCount", "{n} 字").replace("{n}", String(count));
    }

    /**
     * 标签页与控件声明。
     * @returns {Array<{id: string, label: string, groups: Array<{label: string, items: object[]}>}>} 功能区结构
     */
    function ribbon() {
        return buildTabs();
    }

    /**
     * 控件状态：以当前块为准，key 与控件 id 完全一致。
     * 刻意不写 `"!word.undo"` 之类的禁用位 —— ribbon.update() 只会把 disabled 置真、
     * 不会还原，第一帧（还没改动时）置灰就会永久灰掉；标题栏 QAT 已经如实反映 canUndo/canRedo。
     * @returns {object} id -> 值
     */
    function state() {
        const b = currentModel();
        return {
            "word.font": b.font || "",
            "word.size": String(b.size === null ? SIZE_FALLBACK_PT : b.size),
            "word.bold": !!b.bold,
            "word.italic": !!b.italic,
            "word.underline": !!b.underline,
            "word.strike": !!b.strike,
            "word.color": b.color || "",
            "word.highlight": b.highlight || "",
            "word.alignLeft": b.align === "left",
            "word.alignCenter": b.align === "center",
            "word.alignRight": b.align === "right",
            "word.alignJustify": b.align === "justify",
            "word.lineSpacing": b.lineSpacing === null ? "1" : String(b.lineSpacing),
            "word.spaceBefore": String(b.spaceBefore),
            "word.spaceAfter": String(b.spaceAfter),
            "word.list": b.list,
            "word.listBullet": b.list === "bullet",
            "word.listNumber": b.list === "number",
            "word.marks": marksOn,
            "word.zoom": String(zoom),
            "word.width": widthPreset,
            "word.pageSize": page.size,
            "word.pageBg": page.background || "",
            "word.margins": false,
        };
    }

    /**
     * 执行一条功能区命令。三态返回：
     * - `true` —— 已执行（到边界的缩进、重复设同一个对齐也算执行，只是值不变）
     * - `false` —— 本视图不认这个 id / 这次没有可作用的块（外壳据此提示「未实现的命令」）
     * @param {string} id 命令 id
     * @param {string|undefined} value 下拉控件的取值
     * @returns {boolean} 是否处理
     */
    function command(id, value) {
        switch (id) {
            case "word.undo":
                undo();
                return true;
            case "word.redo":
                redo();
                return true;
            case "word.bold":
                return toggleFlag("bold");
            case "word.italic":
                return toggleFlag("italic");
            case "word.underline":
                return toggleFlag("underline");
            case "word.strike":
                return toggleFlag("strike");
            case "word.font":
                return setField("font", normFont(value));
            case "word.size": {
                const pt = normSize(value);
                return setField("size", pt === null ? "" : String(pt));
            }
            case "word.color":
                return setField("color", normHex(value));
            case "word.highlight":
                return setField("highlight", normHex(value));
            case "word.lineSpacing":
                return setField("lineSpacing", normLineSpacing(value));
            case "word.spaceBefore":
                return setField("spaceBefore", normSpacePt(value));
            case "word.spaceAfter":
                return setField("spaceAfter", normSpacePt(value));
            case "word.listBullet":
                return toggleList("bullet");
            case "word.listNumber":
                return toggleList("number");
            case "word.clear":
                return clearFormatting();
            case "word.indentInc":
                return bumpIndent(1);
            case "word.indentDec":
                return bumpIndent(-1);
            case "word.marks":
                return toggleMarks();
            case "word.zoom":
                return setZoom(value);
            case "word.width":
                return setWidth(value);
            case "word.pageSize":
                return setPageSize(value);
            case "word.pageBg":
                return setPageBg(value);
            case "word.margins":
                return openMarginDialog();
            case "word.header":
                return openPageDialog("header");
            case "word.footer":
                return openPageDialog("footer");
            case "word.date":
                return insertTextCommand(chineseDate());
            case "word.tab":
                return insertTextCommand("\t");
            case "word.newline":
                return insertTextCommand("\n");
            case "word.insertImage":
            case "insertImage":
                void pickImage().then((image) => {
                    if (image) insertImageBlock(image);
                });
                return true;
            case "word.blankBelow": {
                const node = currentBlock();
                if (!node || !node.isConnected) return false;
                beforeChange(null);
                const cur = readBlock(node);
                // 新块沿用当前块的对齐与缩进（Word 的「下方插入段落」行为），段式回到正文
                const next = insertAfter(node, { ...cur, kind: PARAGRAPH, level: null });
                focusBlock(next, { offset: 0 });
                syncFromDom();
                applyZoom();
                onInput();
                onSelection();
                return true;
            }
            default:
                if (ALIGN_COMMANDS[id]) return setAlign(ALIGN_COMMANDS[id]);
                if (STYLE_TARGETS[id]) return applyStyle(STYLE_TARGETS[id].kind, STYLE_TARGETS[id].level);
                return false;
        }
    }

    /**
     * 解除本视图的一切监听并摘掉自己塞进容器的节点。
     * 对账：paper 6 个（keydown/click/input/paste/focusin/focusout）+ document 1 个（selectionchange）
     * + 页眉页脚对话框 2 个（确定/取消）+ 页边距对话框 2 个（确定/取消）+ 1 个合并定时器，
     * 注册几个就摘几个。
     * @returns {void}
     */
    function dispose() {
        if (disposed) return;
        paper.removeEventListener("keydown", onKeydown);
        paper.removeEventListener("click", onPaperClick);
        paper.removeEventListener("input", onInputEvent);
        paper.removeEventListener("paste", onPaste);
        paper.removeEventListener("focusin", onFocusIn);
        paper.removeEventListener("focusout", onFocusOut);
        document.removeEventListener("selectionchange", onDocumentSelectionChange);
        pageDialogOk.removeEventListener("click", confirmPageDialog);
        pageDialogCancel.removeEventListener("click", closePageDialog);
        pageDialog.remove();
        marginDialogOk.removeEventListener("click", confirmMarginDialog);
        marginDialogCancel.removeEventListener("click", closeMarginDialog);
        marginDialog.remove();
        clearTimeout(mergeTimer);
        mergeTimer = null;
        mergeKey = null;
        if (zoomRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(zoomRaf);
        zoomRaf = 0;
        undoStack = [];
        redoStack = [];
        undoPages = [];
        redoPages = [];
        blocks = [];
        lastModel = [];
        viewEl.classList.remove("word-view");
        viewEl.classList.remove("show-marks");
        Object.keys(WIDTH_CLASSES).forEach((key) => viewEl.classList.remove(WIDTH_CLASSES[key]));
        viewEl.style.removeProperty("--word-zoom");
        ["--word-page-width", "--word-page-height", "--word-margin-top", "--word-margin-right",
            "--word-margin-bottom", "--word-margin-left"].forEach((name) => viewEl.style.removeProperty(name));
        viewEl.textContent = "";
        activeNode = null;
        caretNode = null;
        disposed = true;
    }

    clear();
    applyZoom();

    return {
        load,
        read,
        clear,
        focus,
        dispose,
        metric,
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
