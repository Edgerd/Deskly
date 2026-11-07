/**
 * pptx.js — PPTX（OOXML 演示文稿）编解码。
 * 只依赖同目录的 `xml.js` 与 `zip.js`，不碰 DOM，能在 Node 里直接 import，
 * 从而做「生成 → 解包 → 逐条结构断言」的自校验。
 *
 * 数据契约（与 UI 层约定，勿改形状）：
 * ```js
 * Slide = {
 *   title: string,                 // 标题（可多行，行内以 \n 分隔）
 *   bullets: string[],             // 正文要点（恒为字符串数组，视图层依赖这点）
 *   layout: "titleContent" | "titleOnly" | "blank" | "twoColumn",  // 默认 titleContent
 *   background: string | null,     // "#RRGGBB" 纯色页背景；null = 继承主题
 *   color: string | null,          // 正文色 "#RRGGBB"
 *   titleColor: string | null,     // 标题色 "#RRGGBB"
 *   size: number | null,           // 正文字号（pt，6..200）；null = 继承版式
 *   bulletsRight: string[],        // 仅 twoColumn 有右栏要点，其它版式恒为 []
 *   images: Array<{src: string, width: number, height: number, x: number, y: number}>, // 图片（src 为 data URL，宽高与 x/y 均为 px）
 *   notes: string,                 // 演讲者备注（段间 \n）；空串 = 无备注、不写备注部件
 *   transition: "none" | "fade" | "push" | "wipe", // 切页切换效果；默认 "none"
 * }
 * ```
 * 图片 x/y 是相对 960×540 基准画布左上角的 px（96dpi），写 `a:off`、回读 `a:off`；
 * 旧包没有 `a:off` 时按 `x=40, y=120+索引*16` 补默认值，保证旧文档照旧打开。
 * 承载力有限的字段（写不出也就读不回，故 normalize 时主动裁剪，保证 build↔parse 幂等）：
 * `color`/`size` 需要正文占位符存在（titleOnly / blank 置 null）；`titleColor`/`title` 需要标题占位符存在（blank 置 null/空串）；
 * `bullets` 需要正文占位符（titleOnly / blank 置空表）；`bulletsRight` 只在 twoColumn 下保留。
 * `notes` 是演讲者备注纯文本（段间 \n），空串表示没有备注、不写备注部件。
 *
 * 有意忽略的内容（契约里没有承载处，读写都不处理）：
 * 母版/版式的版式细节、表格、图表、SmartArt、动画与时序、超链接关系。
 * 图片只支持 png/jpg/jpeg/gif/webp：读 `p:pic` 的 blip + `a:xfrm/a:off`、`a:xfrm/a:ext`，
 * 回写 x/y 与宽高；环绕/裁剪/旋转不建模（已知降级），
 * 且 `p:pic` 不是 `p:sp` 序列成员，不塞进 ORDER_SP——spTree 子元素本身无序。
 * 读取只认占位符里的文字；生成固定产出一套最小但结构完整的母版 + 版式 + 主题。
 * 版式差异落在**页内形状**上：四种版式各自写/不写标题与正文占位符，twoColumn 用两个
 * `type="body"` 形状靠 `p:ph/@idx` 区分，位置一律由页内 `a:off`/`a:ext` 显式给出，
 * 因此不依赖多套 slideLayout 部件（包内仍只有一张 `type="title"` 版式）。
 */

import { escapeXml, parseXml, children, allText, findAll, localNameOf, firstChild } from "./xml.js";
import { unzipPackage, zipParts } from "./zip.js";

/* 官方 URI 常量（不可自造：PowerPoint 认不出自定义 URI，会判损坏） */

/** PresentationML / DrawingML / 关系命名空间：pml 部件根元素三个都要声明齐 */
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** OPC 包层：rels 与 [Content_Types].xml 用 package 命名空间，和上面的 NS_R 不是同一个 URI */
const NS_PR = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const NS_CP = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const NS_DC = "http://purl.org/dc/elements/1.1/";
const NS_DCT = "http://purl.org/dc/terms/";
const NS_DMI = "http://purl.org/dc/dcmitype/";
const NS_XSI = "http://www.w3.org/2001/XMLSchema-instance";
const NS_EP = "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
const NS_VT = "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";

/** 关系类型 URI */
const RT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const REL = {
    officeDocument: RT + "officeDocument",
    slide: RT + "slide",
    slideMaster: RT + "slideMaster",
    slideLayout: RT + "slideLayout",
    theme: RT + "theme",
    presProps: RT + "presProps",
    viewProps: RT + "viewProps",
    tableStyles: RT + "tableStyles",
    core: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
    app: RT + "extended-properties",
    image: RT + "image",
    notesSlide: RT + "notesSlide",
    notesMaster: RT + "notesMaster",
};

/** 1px = 9525 EMU（96dpi）；读回时按同值反算 */
const EMU_PER_PX = 9525;
/** 图片扩展名 -> MIME（只支持这五种，svg 不插入） */
const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** 图片缺失尺寸时的兜底（px），与视图层插入图片的兜底一致 */
const IMAGE_FALLBACK_W = 200;
const IMAGE_FALLBACK_H = 150;
/** 图片坐标基准画布（px，96dpi）：x/y/宽高都以这块 960×540 画布为参照 */
const IMAGE_CANVAS_W = 960;
const IMAGE_CANVAS_H = 540;
/** 旧包没有 a:off 时的默认排布：x=40，y=120 + 索引*16（与历史回写排布兼容） */
const IMAGE_DEFAULT_X = 40;
const IMAGE_DEFAULT_Y = 120;
const IMAGE_DEFAULT_STEP = 16;

/** 部件内容类型：除 rels/xml 走 Default，其余部件必须有对应的 Override */
const CT = {
    presentation: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    slide: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
    slideMaster: "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
    slideLayout: "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
    notesSlide: "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml",
    notesMaster: "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml",
    presProps: "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml",
    viewProps: "application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml",
    tableStyles: "application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml",
    theme: "application/vnd.openxmlformats-officedocument.theme+xml",
    core: "application/vnd.openxmlformats-package.core-properties+xml",
    app: "application/vnd.openxmlformats-officedocument.extended-properties+xml",
};

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
/** pml 部件根元素统一带上三个命名空间（个别部件用不到某个前缀，留着无害） */
const NS3 = `xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"`;
const LANG = "zh-CN";

/** 16:9 尺寸（EMU）：PowerPoint screen16x9 预设值；备注页尺寸是必需元素，给传统 4:3 */
const SLIDE_CX = 12192000;
const SLIDE_CY = 6858000;
const NOTES_CX = 6858000;
const NOTES_CY = 9144000;

/** 纸张（页）尺寸两档：16:9 宽屏与 4:3 标准；高度相同，只改宽度 */
const SLIDE_SIZES = {
    "16:9": { cx: SLIDE_CX, cy: SLIDE_CY, type: "screen16x9" },
    "4:3": { cx: 9144000, cy: SLIDE_CY, type: "screen4x3" },
};
const SLIDE_SIZE_ORDER = ["16:9", "4:3"];
const DEFAULT_SLIDE_SIZE = "16:9";

/** 占位符分类（取舍理由见 slideFromXml） */
const TITLE_PH = ["title", "ctrTitle"];
const BODY_PH = ["body", "obj"];

/**
 * 页版式枚举（契约里的字符串）。写进两处、且两处必须自洽：
 *  1) `p:cSld/@name` —— schema 里是可选 `xsd:string`，这里固定装版式 token（读取优先认它）；
 *  2) `p:sp/@name` —— 以版式 token 开头（PowerPoint 选择窗格显示的就是它，读不回也不影响结构）。
 * `p:ph/@type` 一律用小写枚举值 `title` / `body`（XML 枚举大小写敏感，写成清单上的 `TITLE` 会判非法）。
 */
const LAYOUTS = ["titleContent", "titleOnly", "blank", "twoColumn"];
const DEFAULT_LAYOUT = "titleContent";

/** 各版式要不要标题 / 正文占位符（唯一真源，读写两侧都按它分派） */
const LAYOUT_SHAPE = {
    titleContent: { title: true, body: true, columns: 1 },
    titleOnly: { title: true, body: false, columns: 1 },
    twoColumn: { title: true, body: true, columns: 2 },
    blank: { title: false, body: false, columns: 0 },
};

/* 页面几何（EMU；914400 EMU = 1 英寸）。twoColumn 用 xfrm 显式覆盖版式继承，各占半宽。 */
const SIDE_MARGIN = 457200; // 0.5"
const TITLE_OFF_Y = 365125;
const TITLE_CY = 1320830;
const BODY_OFF_Y = 1673225;
const BODY_CY = 4673599;
const CONTENT_CX = SLIDE_CX - SIDE_MARGIN * 2; // 11277600
const COLUMN_GUTTER = 365760; // 0.4"
const COLUMN_CX = (CONTENT_CX - COLUMN_GUTTER) / 2; // 5455920
const RIGHT_OFF_X = SIDE_MARGIN + COLUMN_CX + COLUMN_GUTTER; // 6278880

/**
 * 下面这组常量把 schema 规定的**子元素顺序**钉成可读的形式（顺序错一处 PowerPoint 就判损坏）。
 * 依据 ECMA-376 第一版（DrawingML / PresentationML）的 complexType 定义。
 */
/** CT_Shape：p:nvSpPr → p:spPr →（p:style）→ p:txBody */
const ORDER_SP = ["nvSpPr", "spPr", "style", "txBody"];
/** CT_ShapeNonVisual：p:cNvPr → p:cNvSpPr → p:nvPr */
const ORDER_NVSPPR = ["cNvPr", "cNvSpPr", "nvPr"];
/** CT_GroupShapeProperties：a:xfrm →（几何）→（填充）→ a:ln →（效果）→ a:scene3d → a:sp3d → a:extLst */
const ORDER_SP_PR = ["xfrm", "custGeom", "prstGeom", "noFill", "solidFill", "gradFill", "blipFill",
    "pattFill", "grpFill", "ln", "effectLst", "effectDag", "scene3d", "sp3d", "extLst"];
/** CT_TextBody：a:bodyPr →（a:lstStyle）→ a:p+ */
const ORDER_TXBODY = ["bodyPr", "lstStyle", "p"];
/** CT_TextParagraph：a:pPr →（a:r / a:br / a:fld 任意次序）→ a:endParaRPr */
const ORDER_PARA = ["pPr", "r", "br", "fld", "endParaRPr"];
/** CT_TextParagraphProperties：…buClr → buSz → buFont → buChar → tabLst → defRPr → extLst */
const ORDER_PPR = ["lnSpc", "spcBef", "spcAft", "buClr", "buClrTx", "buSzPct", "buSzPts", "buSzTx",
    "buFont", "buFontTx", "buNone", "buAutoNum", "buChar", "tabLst", "defRPr", "extLst"];
/**
 * CT_TextCharacterProperties（a:rPr / a:defRPr / a:endParaRPr 同一个类型）子元素顺序：
 * a:ln → 填充 → 效果 → a:highlight → a:uLn(Tx) → a:uFill(Tx) → a:latin/ea/cs/sym → a:hlink* → a:rtl → a:extLst
 */
const ORDER_RPR = ["ln", "noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill",
    "effectLst", "effectDag", "highlight", "uLnTx", "uLn", "uFillTx", "uFill",
    "latin", "ea", "cs", "sym", "hlinkClick", "hlinkMouseOver", "rtl", "extLst"];
/** CT_TextCharacterProperties 的属性书写序（XML 属性本身无序，但按 schema 声明序写才与 PowerPoint 产物一致） */
const ORDER_RPR_ATTR = ["lang", "sz", "b", "i", "u", "strike", "kern", "cap", "spc", "normalizeH",
    "baseline", "noProof", "dirty", "err", "smtClean", "uFillTx", "uFill", "latin", "ea", "cs", "sym"];
/** CT_CommonSlideData：p:bg → p:spTree →（p:custDataLst）→（p:controls）；背景必须在形状树之前 */
const ORDER_CSLD = ["bg", "spTree", "custDataLst", "controls"];
/** p:bg 的内容 CT_BackgroundProperties：填充 →（a:effectLst / a:effectDag）→ a:extLst */
const ORDER_BGPR = ["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill",
    "effectLst", "effectDag", "extLst"];
/** p:sld（CT_Slide）：cSld → clrMapOvr →（transition）→（timing）→ extLst；动画一律不写 */
const ORDER_SLD = ["cSld", "clrMapOvr", "transition", "timing", "extLst"];

/**
 * 按 schema 顺序表拼片段：pieces 的键是本地名，值是片段（空串/缺失即跳过）。
 * 存在的理由：顺序是 PowerPoint 判文档损坏的硬条件，把顺序集中在上面那几张表里，
 * 以后加片段（比如 a:ln 或 a:highlight）时只会往表里插一项，不会在手写的模板串里插错位置。
 * @param {string[]} order ORDER_* 表
 * @param {Record<string, string>} pieces 本地名 -> 片段
 * @returns {string} 按序拼接的结果
 */
function ordered(order, pieces) {
    return order.filter((name) => !!pieces[name]).map((name) => pieces[name]).join("");
}

/**
 * 按 schema 声明序拼属性（同上，值 undefined/null 即不写）。
 * @param {string[]} order ORDER_RPR_ATTR 表
 * @param {Record<string, string|number|undefined|null>} values 属性名 -> 值
 * @returns {string} ` lang="…" sz="…"` 形式的前缀串（自带前导空格）
 */
function attrsInOrder(order, values) {
    return order
        .filter((name) => values[name] !== undefined && values[name] !== null && values[name] !== "")
        .map((name) => ` ${name}="${values[name]}"`)
        .join("");
}

/* 契约辅助 */

/**
 * 空幻灯片（新建时的初始值）：默认版式、配色全部继承主题。
 * 键序即契约序，别调换——探针与视图层都按这个顺序做深比较。
 * @returns {{title: string, bullets: string[], layout: string, background: null,
 *   color: null, titleColor: null, size: null, bulletsRight: string[], images: object[],
 *   notes: string, transition: string}} 空白页
 */
export function emptySlide() {
    return {
        title: "",
        bullets: [],
        layout: DEFAULT_LAYOUT,
        background: null,
        color: null,
        titleColor: null,
        size: null,
        bulletsRight: [],
        images: [],
        notes: "",
        transition: "none",
    };
}

/**
 * 把幻灯片列表摊成纯文本大纲：每页「标题一行 + 各要点一行」，页与页之间空一行。
 * 标题为空时不占行，免得页首出现无意义空行。
 * twoColumn 的右栏接在左栏之后（文本里没有「栏」这个维度，只能顺序摊平）。
 * @param {Array<{title?: string, bullets?: string[], bulletsRight?: string[]}>} slides 幻灯片列表
 * @returns {string} 纯文本
 */
export function pptxToText(slides) {
    const list = Array.isArray(slides) ? slides : [];
    return list.map((raw) => {
        const slide = raw || {};
        const lines = [];
        const title = String(slide.title ?? "");
        if (title) lines.push(title);
        const bullets = Array.isArray(slide.bullets) ? slide.bullets : [];
        bullets.forEach((b) => lines.push(String(b ?? "")));
        const right = Array.isArray(slide.bulletsRight) ? slide.bulletsRight : [];
        if (slide.layout === "twoColumn") right.forEach((b) => lines.push(String(b ?? "")));
        return lines.join("\n");
    }).join("\n\n");
}

/** `#RRGGBB` 的合法形式；十六进制大小写都收，原样保留（写进 srgbClr 的 @val，读回来一字不差） */
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/**
 * 颜色规整：只认 `#RRGGBB`，其余（null /  undefined / `red` / `#abc` / `#GGHHII`）一律 null。
 * @param {unknown} value 任意输入
 * @returns {string|null} 规整后的 `#RRGGBB` 或 null
 */
function normalizeColor(value) {
    if (typeof value !== "string") return null;
    return HEX_COLOR_RE.test(value) ? value : null;
}

/**
 * 字号规整：6..200（pt）之外的数、非数、布尔、字符串都算非法 → null（= 继承版式）。
 * 落盘用百分磅制（1800 = 18pt，ST_TextSize 是整数），故这里按 0.01pt 取整，保证往返幂等。
 * @param {unknown} value 任意输入
 * @returns {number|null} 规整后的字号或 null
 */
function normalizeSize(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    if (value < 6 || value > 200) return null;
    return Math.round(value * 100) / 100;
}

/** 字符串数组规整：非数组退空表，元素一律转字符串（null/undefined 退空串） */
function normalizeStrings(value) {
    return (Array.isArray(value) ? value : []).map((b) => String(b ?? ""));
}

/**
 * 坐标规整：非有限数用兜底值，再夹到 [0, max]。
 * @param {unknown} value 原始值
 * @param {number} fallback 兜底
 * @param {number} max 上限
 * @returns {number} 规整后的 px
 */
function normalizeCoord(value, fallback, max) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : fallback;
}

/**
 * 规整单张图片：src 非 data URL 时丢弃（null），宽高非正数用兜底值；
 * 缺 x/y 时按索引给默认排布，超出 960×540 画布一律夹回。
 * @param {object} raw 原始图片项
 * @param {number} index 图片在页内的序号（决定 y 默认值）
 * @returns {{src: string, width: number, height: number, x: number, y: number}|null}
 */
function normalizeImage(raw, index = 0) {
    const img = raw || {};
    const src = typeof img.src === "string" ? img.src.trim() : "";
    if (!dataUrlImage(src)) return null;
    const w = Number(img.width);
    const h = Number(img.height);
    const width = Number.isFinite(w) && w > 0 ? Math.max(1, Math.round(w)) : IMAGE_FALLBACK_W;
    const height = Number.isFinite(h) && h > 0 ? Math.max(1, Math.round(h)) : IMAGE_FALLBACK_H;
    return {
        src,
        width: Math.min(IMAGE_CANVAS_W, width),
        height: Math.min(IMAGE_CANVAS_H, height),
        x: normalizeCoord(img.x, IMAGE_DEFAULT_X, IMAGE_CANVAS_W),
        y: normalizeCoord(img.y, IMAGE_DEFAULT_Y + index * IMAGE_DEFAULT_STEP, IMAGE_CANVAS_H),
    };
}

/**
 * 规整图片数组：去坏项，缺省/非数组一律 []（旧文档无 images 字段也能安全加载）。
 * @param {unknown} list 原始数组
 * @returns {Array<{src: string, width: number, height: number, x: number, y: number}>}
 */
function normalizeImages(list) {
    if (!Array.isArray(list)) return [];
    return list.map((raw, i) => normalizeImage(raw, i)).filter(Boolean);
}

/**
 * 解析图片 data URL（只认 png/jpeg/gif/webp 的 base64 形式）。
 * @param {unknown} src data URL
 * @returns {{mime: string, ext: string, base64: string}|null}
 */
function dataUrlImage(src) {
    const m = /^data:image\/(png|jpe?g|gif|webp);base64,([\s\S]+)$/i.exec(String(src || "").trim());
    if (!m) return null;
    const kind = m[1].toLowerCase();
    const mime = kind === "jpg" || kind === "jpeg" ? "image/jpeg" : `image/${kind}`;
    return { mime, ext: kind === "jpeg" ? "jpg" : kind, base64: m[2].replace(/\s/g, "") };
}

/** 版式规整：不在枚举里（含 undefined、大小写不符、`Title` 之类）一律退回 titleContent */
function normalizeLayout(value) {
    return LAYOUTS.includes(value) ? value : DEFAULT_LAYOUT;
}

/** 切换效果枚举；未知值一律退回 none（旧包没有 p:transition 也是 none） */
const TRANSITIONS = ["none", "fade", "push", "wipe"];
const DEFAULT_TRANSITION = "none";

/** 切换效果规整：未知/缺省 → none */
function normalizeTransition(value) {
    return TRANSITIONS.includes(value) ? value : DEFAULT_TRANSITION;
}

/**
 * 读页内的 p:transition：取第一个子元素的本地名映射到 fade/push/wipe，其余 → none。
 * @param {object|null} root p:sld 根节点
 * @returns {"none"|"fade"|"push"|"wipe"} 切换效果
 */
function readSlideTransition(root) {
    const trans = root ? firstChild(root, "transition") : null;
    if (!trans) return DEFAULT_TRANSITION;
    const first = children(trans)[0];
    const name = first ? localNameOf(first) : "";
    return TRANSITIONS.includes(name) ? name : DEFAULT_TRANSITION;
}

/**
 * 单页规整成契约形状（旧形状只给 title/bullets 时补齐其余 6 个字段）。
 * 顺手做「承载力裁剪」：版式里没有对应占位符的字段直接置 null，
 * 这样 build 写不出来的东西 normalize 后也不会假装存在，round-trip 才幂等。
 * @param {unknown} raw 任意单页输入
 * @returns {{title: string, bullets: string[], layout: string, background: string|null,
 *   color: string|null, titleColor: string|null, size: number|null, bulletsRight: string[],
 *   images: object[], notes: string, transition: string}} 规整后的页
 */
function normalizeSlide(raw) {
    const slide = raw || {};
    const layout = normalizeLayout(slide.layout);
    const shape = LAYOUT_SHAPE[layout];
    const hasBody = layout === "twoColumn";
    return {
        title: shape.title ? String(slide.title ?? "") : "",
        bullets: shape.body ? normalizeStrings(slide.bullets) : [],
        layout,
        background: normalizeColor(slide.background),
        color: shape.body ? normalizeColor(slide.color) : null,
        titleColor: shape.title ? normalizeColor(slide.titleColor) : null,
        size: shape.body ? normalizeSize(slide.size) : null,
        bulletsRight: hasBody ? normalizeStrings(slide.bulletsRight) : [],
        images: normalizeImages(slide.images),
        notes: typeof slide.notes === "string" ? slide.notes : "",
        transition: normalizeTransition(slide.transition),
    };
}

/**
 * 把任意输入规整成契约形状（非数组退回空表，缺字段/非字符串退回空值，版式与配色补默认值）。
 * @param {unknown} slides 任意输入
 * @returns {Array<ReturnType<typeof normalizeSlide>>} 规整后的列表
 */
function normalizeSlides(slides) {
    if (!Array.isArray(slides)) return [];
    return slides.map(normalizeSlide);
}

/* 包内路径与关系读写 */

/** 路径规整：反斜杠转正斜杠、去掉 `.` 与 `..`，用于比对包内键名 */
function normalizePath(path) {
    const out = [];
    for (const seg of String(path).replace(/\\/g, "/").split("/")) {
        if (!seg || seg === ".") continue;
        if (seg === "..") out.pop();
        else out.push(seg);
    }
    return out.join("/");
}

/** 源部件所在目录（rels 的 Target 相对它解析） */
function dirOf(partPath) {
    const ix = partPath.lastIndexOf("/");
    return ix === -1 ? "" : partPath.slice(0, ix);
}

/** 源部件路径 -> 它的 rels 部件路径（`ppt/presentation.xml` -> `ppt/_rels/presentation.xml.rels`） */
function relsPathOf(partPath) {
    const dir = dirOf(partPath);
    const file = partPath.slice(dir ? dir.length + 1 : 0);
    return `${dir ? dir + "/" : ""}_rels/${file}.rels`;
}

/**
 * rels 的 Target -> 包内部件路径。
 * Target 相对源部件所在目录；以 `/` 开头是包根绝对；也可能带 `../`。
 * @param {string} sourcePart 拥有该 rels 的部件路径
 * @param {string} target Relationship 的 Target 属性
 * @returns {string} 规整后的包内部件路径
 */
function resolveTarget(sourcePart, target) {
    const raw = String(target || "");
    if (raw.startsWith("/")) return normalizePath(raw);
    const dir = dirOf(sourcePart);
    return normalizePath((dir ? dir + "/" : "") + raw);
}

/**
 * 取「带前缀的关系属性」值，如 `r:id`。
 * 前缀理论上可自定义，故先认 `r:id`，再兜 `任意前缀:id`；
 * 绝不认裸 `id`：`p:sldId` 同时有必需的 `id` 与关系的 `r:id`，按本地名取会拿错。
 * @param {object|null} node XML 节点
 * @returns {string|null} 关系 id；没有则 null
 */
function relIdOf(node) {
    if (!node) return null;
    if (node.attrs["r:id"]) return node.attrs["r:id"];
    for (const key of Object.keys(node.attrs)) {
        if (/^[A-Za-z_][A-Za-z0-9_.\-]*:id$/.test(key)) return node.attrs[key];
    }
    return null;
}

/**
 * 解一个 rels 部件为关系数组。
 * @param {string|null} xml rels 部件文本
 * @returns {Array<{id: string, type: string, target: string, external: boolean}>} 关系列表
 */
function parseRels(xml) {
    if (!xml) return [];
    const root = parseXml(xml);
    if (!root) return [];
    return children(root)
        .filter((c) => localNameOf(c) === "Relationship")
        .map((c) => ({
            id: c.attrs.Id || "",
            type: c.attrs.Type || "",
            target: c.attrs.Target || "",
            external: String(c.attrs.TargetMode || "").toLowerCase() === "external",
        }));
}

/** 生成 rels 部件文本（Id/Type/Target 全按官方常量给） */
function relsXml(list) {
    const body = list.map((r) => `<Relationship Id="${escapeXml(r.id)}" Type="${escapeXml(r.type)}"`
        + ` Target="${escapeXml(r.target)}"${r.external ? ' TargetMode="External"' : ""}/>`).join("");
    return `${DECL}<Relationships xmlns="${NS_PR}">${body}</Relationships>`;
}

/**
 * 生成 [Content_Types].xml：rels/xml/图片扩展名走 Default，其余部件逐个 Override（缺 Override 会被判损坏）。
 * @param {Array<{part: string, type: string}>} overrides Override 列表
 * @param {Array<{ext: string}>} [images] 图片登记（按扩展名去重写 Default）
 * @returns {string} XML 文本
 */
function contentTypesXml(overrides, images = []) {
    const exts = [];
    for (const img of images) if (img.ext && !exts.includes(img.ext)) exts.push(img.ext);
    const imageDefaults = exts
        .map((ext) => `<Default Extension="${ext}" ContentType="${IMAGE_MIME[ext] || "application/octet-stream"}"/>`)
        .join("");
    const body = overrides.map((o) => `<Override PartName="${escapeXml("/" + normalizePath(o.part))}"`
        + ` ContentType="${escapeXml(o.type)}"/>`).join("");
    return `${DECL}<Types xmlns="${NS_CT}">`
        + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
        + `<Default Extension="xml" ContentType="application/xml"/>${imageDefaults}${body}</Types>`;
}

/* 解析：.pptx -> Slide[] */

/**
 * 取一个 `a:p` 的文本：`a:t` 拼接、`a:tab` 记制表符、`a:br` 记换行。
 * 这里不能图省事用 `allText` 整段取：本解析器把元素之间的混排文本并进父节点的 `text`，
 * 拼接顺序变成「父文本 + 各子节点」，`a:br`/`a:tab` 夹在第几个运行之间就丢了，故按文档顺序自己走。
 * @param {object|null} para `a:p` 节点
 * @returns {string} 段落文本
 */
function paragraphText(para) {
    let out = "";
    const walk = (node) => {
        for (const c of children(node)) {
            const ln = localNameOf(c);
            if (ln === "t") out += allText(c);
            else if (ln === "br") out += "\n";
            else if (ln === "tab") out += "\t";
            // 纯属性载体、不含文字，跳过（endParaRPr 的文本恒空，跳过更清楚）
            else if (ln === "pPr" || ln === "rPr" || ln === "defRPr" || ln === "endParaRPr") continue;
            else walk(c);
        }
    };
    if (para) walk(para);
    return out;
}

/** 取一个 `p:txBody` 下各段落的文本（保持文档顺序） */
function paragraphsOf(txBody) {
    if (!txBody) return [];
    return children(txBody).filter((c) => localNameOf(c) === "p").map(paragraphText);
}

/**
 * `a:solidFill` 里取十六进制色。
 * 只认 `a:srgbClr/@val`；`a:schemeClr`（主题色）与 `a:sysClr` 没有稳定的 RGB 对应，
 * 契约里也只有一个 `#RRGGBB` 字段，读不出来就当继承主题（null），不猜。
 * @param {object|null} fill `a:solidFill` 节点
 * @returns {string|null} `#RRGGBB` 或 null
 */
function colorOfFill(fill) {
    const clr = firstChild(fill, "srgbClr");
    if (!clr) return null;
    return normalizeColor(`#${String(clr.attrs.val || "")}`);
}

/**
 * 一个字符属性载体（`a:rPr` / `a:defRPr` / `a:endParaRPr`）里的字号与颜色。
 * `@sz` 是百分磅制（1800 = 18pt）；`@b` 之类契约里没有承载处，忽略但不报错。
 * @param {object|null} node 字符属性节点
 * @returns {{color: string|null, size: number|null}} 取到的字段（取不到为 null）
 */
function propsOfCharNode(node) {
    const out = { color: null, size: null };
    if (!node) return out;
    out.color = colorOfFill(firstChild(node, "solidFill"));
    const raw = node.attrs.sz;
    if (raw !== undefined && raw !== "") {
        const pt = Number(raw) / 100;
        if (Number.isFinite(pt)) out.size = pt; // 越界交给 normalizeSize 裁成 null
    }
    return out;
}

/**
 * 一个 `a:p` 的字符属性：先取 run（`a:r`/`a:fld`）上的 `a:rPr`，
 * run 缺失或没写属性时回落到 `a:pPr/a:defRPr`（PowerPoint 常把版式级字号/颜色只放在 defRPr）。
 * @param {object|null} para `a:p` 节点
 * @returns {{color: string|null, size: number|null}} 该段落首个给出该属性的载体
 */
function propsOfParagraph(para) {
    const out = { color: null, size: null };
    let defRPr = null;
    for (const c of children(para)) {
        const ln = localNameOf(c);
        if (ln === "r" || ln === "fld") {
            const got = propsOfCharNode(firstChild(c, "rPr"));
            if (out.color === null) out.color = got.color;
            if (out.size === null) out.size = got.size;
        } else if (ln === "pPr" && !defRPr) {
            defRPr = firstChild(c, "defRPr");
        }
    }
    if (out.color === null || out.size === null) {
        const got = propsOfCharNode(defRPr);
        if (out.color === null) out.color = got.color;
        if (out.size === null) out.size = got.size;
    }
    return out;
}

/**
 * 一个 `p:txBody` 的正文色与字号：按段落顺序取第一个写了该属性的段落。
 * @param {object|null} txBody `p:txBody` 节点
 * @returns {{color: string|null, size: number|null}} 形状级属性
 */
function propsOfShape(txBody) {
    const out = { color: null, size: null };
    if (!txBody) return out;
    for (const para of children(txBody).filter((c) => localNameOf(c) === "p")) {
        const got = propsOfParagraph(para);
        if (out.color === null) out.color = got.color;
        if (out.size === null) out.size = got.size;
        if (out.color !== null && out.size !== null) break;
    }
    return out;
}

/** `p:ph/@idx`：整数才认，缺失/非数退 null（null 与 1 都算左栏，与 PowerPoint 的默认一致） */
function idxOfPh(ph) {
    if (!ph || ph.attrs.idx === undefined) return null;
    const n = Number(ph.attrs.idx);
    return Number.isInteger(n) ? n : null;
}

/**
 * 收集 `p:spTree` 下每个形状的「占位符类型 + idx + 段落文本 + 字符属性」。
 * `p:ph` 在规范里挂在 `p:nvSpPr/p:nvPr` 下（清单写的 `p:nvSpPr/p:ph` 是简写），两种位置都认；
 * `p:ph` 缺 `type` 时按 PML 默认视作内容占位符（`obj`）；缺 `idx` 时按 null（左栏）。
 * 用 findAll 而不是只取 spTree 的直接子元素，这样编组 `p:grpSp` 里的形状文字也能取到。
 * @param {object|null} spTree `p:spTree` 节点
 * @returns {Array<{type: string|null, idx: number|null, paras: string[], color: string|null, size: number|null}>}
 */
function shapesOf(spTree) {
    if (!spTree) return [];
    return findAll(spTree, "sp").map((sp) => {
        const nvSpPr = firstChild(sp, "nvSpPr");
        const ph = nvSpPr ? (firstChild(nvSpPr, "nvPr", "ph") || firstChild(nvSpPr, "ph")) : null;
        const txBody = firstChild(sp, "txBody");
        const props = propsOfShape(txBody);
        return {
            type: ph ? String(ph.attrs.type || "obj") : null,
            idx: idxOfPh(ph),
            paras: paragraphsOf(txBody),
            color: props.color,
            size: props.size,
        };
    });
}

/** 标题：段落按行拼回字符串，并丢掉尾部空段（真实文件常在标题后多一个空段，留着会变成行尾换行） */
function titleText(paras) {
    const list = paras.slice();
    while (list.length > 1 && !list[list.length - 1].trim()) list.pop();
    return list.join("\n");
}

/** 把若干形状的段落摊成要点：只收非空段落（空行与纯空白段落过滤掉） */
function bulletsOf(shapes) {
    const out = [];
    for (const s of shapes) {
        for (const p of s.paras) {
            if (p.trim()) out.push(p);
        }
    }
    return out;
}

/**
 * 页背景：`p:cSld/p:bg` 里的纯色填充。
 * 正规写法是 `p:bg/p:bgPr/a:solidFill/a:srgbClr`，个别生成器直接把 `a:solidFill` 挂在 `p:bg` 下，两处都认；
 * `p:bgRef`（主题/渐变引用）没有可逆的 RGB，退 null = 继承主题。
 * @param {object|null} cSld `p:cSld` 节点
 * @returns {string|null} `#RRGGBB` 或 null
 */
function backgroundOf(cSld) {
    const bg = firstChild(cSld, "bg");
    if (!bg) return null;
    const fill = firstChild(bg, "bgPr", "solidFill") || firstChild(bg, "solidFill")
        || findAll(bg, "solidFill")[0] || null;
    return colorOfFill(fill);
}

/**
 * 版式判定：`p:cSld/@name` 装了合法版式 token 时优先用它（我方写的包一律带，恢复得最准）；
 * 否则按形状结构推断——右栏（`type="body"` 且 `idx>=2`）存在即 twoColumn，
 * 有标题无正文即 titleOnly，一个形状都没有才是 blank，其余（含第三方只画文本框的页）算 titleContent。
 * 推断规则刻意**不看**「有几个正文占位符」而看有没有 `idx>=2`：第三方 `obj idx="2"` 之外的多正文页不至于被误判成分栏。
 * @param {object|null} cSld `p:cSld` 节点
 * @param {{titleShape: object|null, bodyShapes: object[], rightShapes: object[], shapes: object[]}} info 形状分派结果
 * @returns {string} 四种版式之一
 */
function layoutOf(cSld, info) {
    const marked = cSld ? String(cSld.attrs.name || "") : "";
    if (LAYOUTS.includes(marked)) return marked;
    if (info.rightShapes.length) return "twoColumn";
    if (info.titleShape) return info.bodyShapes.length ? "titleContent" : "titleOnly";
    return info.shapes.length ? "titleContent" : "blank";
}

/**
 * 单页 `slideN.xml` -> Slide。
 * 正常路径：标题占位符（`title`/`ctrTitle`）的文字是标题；正文占位符（`body`/`obj`）的每个非空段落是一个要点；
 * 同为正文占位符时 `p:ph/@idx >= 2` 归右栏（`bulletsRight`），缺失或 1 归左栏（`bullets`）；
 * 其它类型占位符（`sub`/`ftr`/`dt`/`sldNum`/`hdr` 等）与无 `p:ph` 的普通形状忽略。
 * 退化路径：一个标题占位符都没有时，取第一个含文字的 shape 当标题，其余含文字 shape 的段落进要点。
 * 配色/字号：标题色取标题形状、正文色与字号取左栏第一个正文形状（run 的 `a:rPr` 优先，回落 `a:pPr/a:defRPr`）。
 * 末尾统一走 normalizeSlide，所以旧文件（只有标题/要点）读回来是补齐了 6 个默认字段的完整页。
 * @param {string} xmlText slide 部件文本
 * @param {string} partPath slide 部件路径（用于定位 rels 与 media）
 * @param {Map} parts 包内部件表
 * @returns {ReturnType<typeof normalizeSlide>} 一页
 */
function slideFromXml(xmlText, partPath, parts) {
    const root = parseXml(xmlText);
    const cSld = root ? firstChild(root, "cSld") : null;
    const spTree = firstChild(cSld, "spTree");
    const shapes = shapesOf(spTree);
    const titleShape = shapes.find((s) => s.type && TITLE_PH.includes(s.type)) || null;
    const bodyShapes = shapes.filter((s) => s.type && BODY_PH.includes(s.type));
    const isRight = (s) => s.idx !== null && s.idx >= 2;
    const rightShapes = bodyShapes.filter(isRight);
    const leftShapes = bodyShapes.filter((s) => !isRight(s));

    let title = "";
    let bullets = [];
    let bulletsRight = [];
    let titleCarrier = titleShape;
    let bodyCarrier = leftShapes[0] || null;
    if (titleShape) {
        title = titleText(titleShape.paras);
        bullets = bulletsOf(leftShapes);
        bulletsRight = bulletsOf(rightShapes);
        if (!bodyCarrier) bodyCarrier = rightShapes[0] || null;
    } else {
        const withText = shapes.filter((s) => s.paras.some((p) => p.trim()));
        title = withText.length ? titleText(withText[0].paras) : "";
        bullets = bulletsOf(withText.slice(1));
        titleCarrier = withText[0] || null;
        bodyCarrier = withText[1] || null;
    }

    // 版式与内容对不上时以「留得住内容」为准，别因为第三方把 name 当备注写就把文字读丢
    const layout = carriedLayout(layoutOf(cSld, { titleShape, bodyShapes, rightShapes, shapes }), title, bullets);
    return normalizeSlide({
        title,
        bullets,
        bulletsRight,
        layout,
        background: backgroundOf(cSld),
        color: bodyCarrier ? bodyCarrier.color : null,
        titleColor: titleCarrier ? titleCarrier.color : null,
        size: bodyCarrier ? bodyCarrier.size : null,
        images: readSlideImages(partPath, parts, spTree),
        notes: readSlideNotes(partPath, parts),
        transition: readSlideTransition(root),
    });
}

/**
 * 读演讲者备注：slide rels 里 `notesSlide` 关系 -> 备注页部件 -> 所有 `a:p` 内的 `a:t`。
 * 关系悬空、部件缺失或解析失败一律返回 ""（不抛错）。
 * @param {string} partPath slide 部件路径
 * @param {Map} parts 包内部件表
 * @returns {string} 备注文本（段落间以 \n 分隔）
 */
function readSlideNotes(partPath, parts) {
    const relsText = parts.get(relsPathOf(partPath));
    const rel = parseRels(typeof relsText === "string" ? relsText : null)
        .find((item) => !item.external && item.type.endsWith("/notesSlide"));
    if (!rel) return "";
    const notePath = resolveTarget(partPath, rel.target);
    const xmlText = textAt(parts, notePath);
    if (!xmlText) return "";
    const root = parseXml(xmlText);
    if (!root) return "";
    return findAll(root, "p")
        .map((p) => findAll(p, "t").map((t) => t.text).join(""))
        .join("\n");
}

/**
 * 按包内路径取文本部件（大小写不敏感兜底）；缺失或该路径是二进制时返回 ""。
 * @param {Map} parts 包内部件表
 * @param {string} path 包内路径
 * @returns {string}
 */
function textAt(parts, path) {
    const exact = parts.get(path);
    if (typeof exact === "string") return exact;
    const want = String(path || "").toLowerCase();
    let hit = "";
    parts.forEach((value, real) => {
        if (!hit && String(real).toLowerCase() === want && typeof value === "string") hit = value;
    });
    return hit;
}

/**
 * 读页内图片：`findAll(spTree, "pic")` -> `p:blipFill/a:blip` 的 r:embed -> slide rels ->
 * media 二进制 -> data URL；尺寸取 `p:spPr/a:xfrm/a:ext`（EMU -> px）。
 * 关系悬空、缺部件、非支持格式一律跳过，不抛错。
 * @param {string} partPath slide 部件路径
 * @param {Map} parts 包内部件表
 * @param {object|null} spTree `p:spTree` 节点
 * @returns {Array<{src: string, width: number, height: number}>} 图片项
 */
function readSlideImages(partPath, parts, spTree) {
    if (!spTree) return [];
    const relsText = parts.get(relsPathOf(partPath));
    const byId = new Map();
    for (const rel of parseRels(typeof relsText === "string" ? relsText : null)) {
        if (!rel.external) byId.set(rel.id, resolveTarget(partPath, rel.target));
    }
    const out = [];
    for (const pic of findAll(spTree, "pic")) {
        const blip = findAll(pic, "blip")[0];
        if (!blip) continue;
        const rid = relAttrOf(blip, "embed");
        const mediaPath = rid ? byId.get(rid) : null;
        const base64 = mediaPath ? binaryAt(parts, mediaPath) : null;
        const ext = mediaPath ? imageExtOf(mediaPath) : "";
        const mime = IMAGE_MIME[ext];
        if (!base64 || !mime) continue;
        const spPr = firstChild(pic, "spPr");
        const xfrm = spPr ? firstChild(spPr, "xfrm") : null;
        const offNode = (xfrm && firstChild(xfrm, "off")) || findAll(pic, "off")[0];
        const extNode = (xfrm && firstChild(xfrm, "ext")) || findAll(pic, "ext")[0];
        out.push(normalizeImage({
            src: `data:${mime};base64,${base64}`,
            width: emuToPx(extNode ? extNode.attrs.cx : null, IMAGE_FALLBACK_W),
            height: emuToPx(extNode ? extNode.attrs.cy : null, IMAGE_FALLBACK_H),
            x: offNode ? emuToPxCoord(offNode.attrs.x) : undefined,
            y: offNode ? emuToPxCoord(offNode.attrs.y) : undefined,
        }, out.length));
    }
    return out.filter(Boolean);
}

/**
 * 取带前缀的关系属性（如 `r:embed`），不认裸同名属性。
 * @param {object|null} node XML 节点
 * @param {string} name 关系属性名（embed / link / id）
 * @returns {string|null} 属性值
 */
function relAttrOf(node, name) {
    if (!node) return null;
    if (node.attrs[`r:${name}`]) return node.attrs[`r:${name}`];
    for (const key of Object.keys(node.attrs)) {
        if (/^[A-Za-z_][A-Za-z0-9_.\-]*:/.test(key) && key.slice(key.indexOf(":") + 1) === name) return node.attrs[key];
    }
    return null;
}

/**
 * 按包内路径取图片 base64（大小写不敏感）。
 * @param {Map} parts 包内部件表
 * @param {string} path 期望路径
 * @returns {string|null} base64
 */
function binaryAt(parts, path) {
    const exact = parts.get(path);
    if (exact && typeof exact === "object" && typeof exact.base64 === "string") return exact.base64;
    let hit = null;
    parts.forEach((value, real) => {
        if (hit || String(real).toLowerCase() !== String(path).toLowerCase()) return;
        if (value && typeof value === "object" && typeof value.base64 === "string") hit = value.base64;
    });
    return hit;
}

/**
 * 图片扩展名（小写，不带点）。
 * @param {string} path 部件路径
 * @returns {string}
 */
function imageExtOf(path) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(path || ""));
    return m ? m[1].toLowerCase() : "";
}

/**
 * EMU -> px（四舍五入，至少 1）；非数字用兜底值。
 * @param {*} raw EMU 数值
 * @param {number} fallback 兜底 px
 * @returns {number}
 */
function emuToPx(raw, fallback) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(1, Math.round(n / EMU_PER_PX));
}

/**
 * EMU -> px 坐标（0 合法）；非数字/负数返回 undefined，交给 normalizeImage 补索引默认值。
 * @param {*} raw EMU 数值
 * @returns {number|undefined}
 */
function emuToPxCoord(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.round(n / EMU_PER_PX);
}

/**
 * 版式声明与页面内容冲突时让步给内容：
 * 标了 `blank` 却写着标题或要点、标了 `titleOnly` 却有正文——这两种版式没有承载处，
 * 照声明读就会把文字静默丢掉，所以退成 `titleContent`（版式认错，内容不丢）。
 * @param {string} declared layoutOf 的判定结果
 * @param {string} title 已读到的标题
 * @param {string[]} bullets 已读到的要点
 * @returns {string} 实际可用的版式
 */
function carriedLayout(declared, title, bullets) {
    if (declared === "blank" && (title || bullets.length)) return DEFAULT_LAYOUT;
    if (declared === "titleOnly" && bullets.length) return DEFAULT_LAYOUT;
    return declared;
}

/**
 * 解析 .pptx 字节。
 *
 * 页序取自 `p:sldIdLst`：先用 `ppt/_rels/presentation.xml.rels` 把 r:id 映射到 slide 部件路径，
 * 再**严格按 `p:sldIdLst` 的文档顺序**读页——被手工调过页序的包，文件名数字与真实页序不一致，按名字排就错了。
 * 母版、版式、表格、图表一律不读；页内图片按 blip + media 还原（见文件头说明）。
 * @param {ArrayBuffer|Uint8Array} bytes .pptx 文件字节
 * @returns {Promise<{slides: Array<ReturnType<typeof normalizeSlide>>, page: {size: string}}>}
 *          幻灯片列表 + 页面设置（16:9 / 4:3）
 * @throws {Error} 不是有效的 .pptx（非 zip 包、缺关键部件）时抛中文错误
 */
export async function parsePptx(bytes) {
    let parts;
    try {
        parts = await unzipPackage(bytes);
    } catch (err) {
        throw new Error(`不是有效的 .pptx 文件：压缩包打不开（${(err && err.message) || "字节不是 zip 格式"}）`);
    }
    if (!parts || typeof parts.get !== "function" || !parts.size) {
        throw new Error("不是有效的 .pptx 文件：压缩包是空的");
    }

    const PRES = "ppt/presentation.xml";
    if (!parts.has(PRES)) throw new Error("不是有效的 .pptx 文件：缺少 ppt/presentation.xml");
    const relsText = parts.get(relsPathOf(PRES));
    if (typeof relsText !== "string") {
        throw new Error("不是有效的 .pptx 文件：缺少 ppt/_rels/presentation.xml.rels");
    }

    const byId = new Map();
    for (const rel of parseRels(relsText)) {
        // 外链关系（TargetMode="External"）不指向包内部件，不可能是页来源，跳过
        if (!rel.external) byId.set(rel.id, resolveTarget(PRES, rel.target));
    }

    const root = parseXml(parts.get(PRES));
    const page = readSlideSize(root);
    const sldIdLst = root ? firstChild(root, "sldIdLst") : null;
    const entries = sldIdLst ? children(sldIdLst).filter((c) => localNameOf(c) === "sldId") : [];
    if (!sldIdLst || !entries.length) return { slides: [], page }; // 合法但零页的包：不算错误

    const slides = [];
    for (const entry of entries) {
        const id = relIdOf(entry);
        const partPath = id ? byId.get(id) : null;
        // 关系指向的部件不在包里（包被截断或被外部工具写坏）：跳过坏页，其余照读
        if (!partPath || typeof parts.get(partPath) !== "string") continue;
        slides.push(slideFromXml(parts.get(partPath), partPath, parts));
    }
    return { slides, page };
}

/**
 * 读 `p:sldSz` 的页面比例：宽高比接近 4:3 判为 4:3，其余（含未知尺寸）按 16:9。
 * @param {object|null} root `p:presentation` 根节点
 * @returns {{size: string}} 页面设置
 */
function readSlideSize(root) {
    const sldSz = root ? firstChild(root, "sldSz") : null;
    if (sldSz) {
        const cx = Number(sldSz.attrs?.cx);
        const cy = Number(sldSz.attrs?.cy);
        if (Number.isFinite(cx) && Number.isFinite(cy) && cy > 0) {
            const ratio = cx / cy;
            // 4:3 = 1.333、16:9 = 1.778；取中点 1.55 作分界，容忍对端写入的 1.333 / 1.25 等历史值
            if (ratio < 1.55) return { size: "4:3" };
        }
    }
    return { size: DEFAULT_SLIDE_SIZE };
}

/* 生成：Slide[] -> .pptx */

/**
 * 文本 -> `a:r` / `a:br` 序列。
 * 换行拆成兄弟元素 `a:br`（`a:p` 下 `a:r` 与 `a:br` 同级，把 `a:br` 塞进 `a:r` 里不过 schema）；
 * 制表符等其余字符原样留在 `a:t`。
 * 已知降级点：DrawingML 不吃 `xml:space="preserve"`（按约定不加该属性），
 * 首尾空格按原文写进 `a:t`，对端（PowerPoint/WPS）读回时可能被 trim。
 * @param {string} text 原文
 * @param {string} rPr 运行属性片段（可为空串）
 * @returns {string} XML 片段（全文为空串时返回空串）
 */
function runsXml(text, rPr) {
    const lines = String(text ?? "").split("\n");
    const out = [];
    lines.forEach((line, i) => {
        if (i > 0) out.push("<a:br/>");
        if (line === "") return; // 空行只留 `a:br` 作分隔，不写空 run
        out.push(`<a:r>${rPr}<a:t>${escapeXml(line)}</a:t></a:r>`);
    });
    return out.join("");
}

/**
 * 文本数组 -> `a:p` 序列。空数组也至少产出一个 `a:p`（`p:txBody` 要求 min 1）。
 * 段落没有 run 时写 `a:endParaRPr` 占位，保证 `a:p` 不含零内容。
 * 子元素位置由 ORDER_PARA 决定：`a:pPr` 在最前，run 序列居中，`a:endParaRPr` 恒在最后。
 * @param {string[]} texts 各段原文
 * @param {object} [opt] `pPrInner`：`a:pPr` 的内容（空串则整个 `a:pPr` 省略）；`rPr`：运行属性片段
 * @returns {string} XML 片段
 */
function parasXml(texts, opt = {}) {
    const { pPrInner = "", rPr = "" } = opt;
    const list = texts.length ? texts : [""];
    return list.map((t) => {
        const runs = runsXml(t, rPr);
        return `<a:p>${ordered(ORDER_PARA, {
            pPr: pPrInner ? `<a:pPr>${pPrInner}</a:pPr>` : "",
            r: runs,
            endParaRPr: runs ? "" : `<a:endParaRPr lang="${LANG}"/>`,
        })}</a:p>`;
    }).join("");
}

/** spTree 的组属性：`p:nvGrpSpPr` → `p:grpSpPr` 顺序固定，组自身占 `p:cNvPr id="1"` */
const GRP_SP_PR = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>`
    + `<p:grpSpPr><a:xfrm rot="0"><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>`
    + `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;

/**
 * `#RRGGBB` -> `a:solidFill`（`a:srgbClr/@val` 不带 `#`，schema 要的是 6 位十六进制）。
 * 调用方传进来的十六进制一律已由 normalizeColor 验过形，这里只兜一下 `#`。
 */
const solidFillXml = (hex) => `<a:solidFill><a:srgbClr val="${escapeXml(String(hex).replace(/^#/, ""))}"/></a:solidFill>`;

/**
 * 字符属性载体：`a:rPr`（写在 run 上）与 `a:defRPr`（写在 `a:pPr` 末尾）。
 * 顺序依据 ORDER_RPR_ATTR / ORDER_RPR：属性只写 `lang`（第一）→ `sz`（第二）→ `dirty`（在 b/i/u/… 之后），
 * 子元素只写 `a:solidFill`，它在 CT_TextCharacterProperties 的 sequence 里排在 `a:ln` 之后、效果/highlight 之前，
 * 这里没有那两个兄弟，所以放最前面即合法。
 * @param {"rPr"|"defRPr"} tag 载体标签名
 * @param {{size?: number|null, color?: string|null}} props 字号（pt）与颜色（#RRGGBB），null 不写
 * @returns {string} XML 片段（无属性可写时退成自闭合的 lang 版本）
 */
function charPropsXml(tag, props) {
    const { size = null, color = null } = props || {};
    // 属性按 ORDER_RPR_ATTR 的声明序出：lang(1) → sz(2) → dirty(13)，中间那串（b/i/u/strike/…）契约里没有承载处
    const attrs = attrsInOrder(ORDER_RPR_ATTR, {
        lang: LANG,
        sz: size === null ? null : Math.round(size * 100), // 百分磅制：18pt -> 1800
        dirty: "0",
    });
    const inner = ordered(ORDER_RPR, { solidFill: color ? solidFillXml(color) : "" });
    return inner ? `<a:${tag}${attrs}>${inner}</a:${tag}>` : `<a:${tag}${attrs}/>`;
}

/** `a:xfrm`：CT_Transform2D 里 `a:off` 在 `a:ext` 之前，两者之外还有 chOff/chExt（形状不用） */
const xfrmXml = (box) => `<a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>`;
/** `a:prstGeom`：属性 prst 必需，子元素只有可选的 `a:avLst` */
const PRST_GEOM = `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`;

/**
 * `p:spPr`（CT_ShapeProperties）的内容顺序：`a:xfrm` → 几何 → 填充 → `a:ln` →（效果）→ `a:extLst`（见 ORDER_SP_PR）。
 * 页内形状一律给显式 `a:xfrm` + `a:prstGeom`（twoColumn 的半宽靠它，不靠版式继承）；
 * 母版/版式的占位符不给几何（`<p:spPr/>`），位置由继承链给，与 PowerPoint 的最小产物一致。
 * @param {{x: number, y: number, cx: number, cy: number}|null} box 位置与尺寸（EMU），null 则写空 spPr
 * @returns {string} `p:spPr` XML
 */
const spPrXml = (box) => `<p:spPr>${ordered(ORDER_SP_PR, {
    xfrm: box ? xfrmXml(box) : "",
    prstGeom: box ? PRST_GEOM : "",
})}</p:spPr>`;

/**
 * 一个占位符形状：`p:sp` 子元素顺序固定为 `p:nvSpPr` → `p:spPr` →（`p:style`）→ `p:txBody`（见 ORDER_SP）；
 * `p:nvSpPr` 内是 `p:cNvPr` → `p:cNvSpPr` → `p:nvPr`（见 ORDER_NVSPPR）；
 * `p:txBody` 内是 `a:bodyPr` → `a:lstStyle` → `a:p`+（见 ORDER_TXBODY）。
 * `p:cNvPr` 的 `id`/`name` 都是必需属性（name 可为空串）；id 由调用方保证同部件内唯一且非 0，
 * 重复或 0 会让 PowerPoint 判损坏。
 * @param {object} opt `id`/`name`/`phXml`/`paras`/`box`
 * @returns {string} `p:sp` XML
 */
function placeholderSp(opt) {
    const { id, name, phXml, paras, box = null } = opt;
    const nvSpPr = `<p:nvSpPr>${ordered(ORDER_NVSPPR, {
        cNvPr: `<p:cNvPr id="${id}" name="${escapeXml(name)}"/>`,
        cNvSpPr: `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>`,
        nvPr: `<p:nvPr>${phXml}</p:nvPr>`,
    })}</p:nvSpPr>`;
    const txBody = `<p:txBody>${ordered(ORDER_TXBODY, {
        bodyPr: "<a:bodyPr/>", lstStyle: "<a:lstStyle/>", p: paras,
    })}</p:txBody>`;
    return `<p:sp>${ordered(ORDER_SP, { nvSpPr, spPr: spPrXml(box), txBody })}</p:sp>`;
}

/**
 * 标题占位符（母版/版式/幻灯片三处 `p:ph/@type` 一致，占位符继承链才匹配得上；值是小写枚举 `title`）。
 * @param {string} paras `a:p` 串
 * @param {number} [id] 本页唯一 cNvPr id
 * @param {string} [name] 形状名（页内为「<版式> Title」，与 p:cSld/@name 对齐）
 * @param {object|null} [box] 页内几何
 * @returns {string} `p:sp` XML
 */
const titleSp = (paras, id = 2, name = "标题 1", box = null) =>
    placeholderSp({ id, name, phXml: '<p:ph type="title"/>', paras, box });

/**
 * 正文占位符（`type="body"`；`idx` 用来区分左右两栏，缺省与 1 都是左栏）。
 * @param {string} paras `a:p` 串
 * @param {number} [id] 本页唯一 cNvPr id
 * @param {string} [name] 形状名
 * @param {object|null} [box] 页内几何
 * @param {number} [idx] `p:ph/@idx`
 * @returns {string} `p:sp` XML
 */
const bodySp = (paras, id = 3, name = "内容占位符 2", box = null, idx = 1) =>
    placeholderSp({ id, name, phXml: `<p:ph type="body" idx="${idx}"/>`, paras, box });

/**
 * 内容段落的项目符号（拆成两件是因为要按 ORDER_PPR 的槽位排：buFont → buChar → defRPr）。
 */
const BU_FONT = `<a:buFont typeface="Arial"/>`;
const BU_CHAR = `<a:buChar char="•"/>`;

/**
 * 要点列表 -> 正文段落串。
 * 每个非空 bullet 各自成一个 `a:p`（拼成单段会读回成一条要点）；空 bullet 不落盘；
 * 一条要点都没有时写一个只含 `a:endParaRPr` 的空段，满足 `p:txBody` 的最少一段——
 * `a:pPr` 仍照写（里面带 `a:defRPr` 的色与字号），所以零要点的页也能把配色读回来。
 * @param {string[]} list 已过滤的要点
 * @param {{size?: number|null, color?: string|null}} props 正文属性
 * @returns {string} `a:p` 串
 */
function bodyParasXml(list, props) {
    const pPrInner = ordered(ORDER_PPR, {
        buFont: BU_FONT, buChar: BU_CHAR, defRPr: charPropsXml("defRPr", props),
    });
    return parasXml(list.length ? list : [""], { pPrInner, rPr: charPropsXml("rPr", props) });
}

/**
 * 页内图片 `p:pic`：nvPicPr（cNvPr + cNvPicPr + nvPr）→ blipFill（a:blip r:embed）→ spPr（a:xfrm + rect）。
 * 只写矩形图片；裁剪/旋转/滤镜/环绕都不写（已知降级）。
 * @param {{entry: {path: string}, width: number, height: number, x: number, y: number}} ref 图片登记
 * @param {string} rid 页内关系 id
 * @param {number} id 页内形状编号
 * @param {(v: number) => number} sx 横向缩放函数
 * @returns {string} `p:pic` XML
 */
function picXml(ref, rid, id, sx) {
    const offX = sx(Math.round(ref.x * EMU_PER_PX));
    const offY = Math.round(ref.y * EMU_PER_PX);
    const cx = sx(Math.round(ref.width * EMU_PER_PX));
    const cy = Math.round(ref.height * EMU_PER_PX);
    return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="图片 ${id}"/>`
        + `<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
        + `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
        + `<p:spPr><a:xfrm><a:off x="${offX}" y="${offY}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
        + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

/**
 * 切页切换效果：fade/push/wipe 各写一个 p:* 子元素；none 返回空串（旧包零新增元素）。
 * @param {string} transition 切换效果
 * @returns {string} `p:transition` 串或空串
 */
function transitionXml(transition) {
    const inner = {
        fade: "<p:fade/>",
        push: `<p:push dir="l"/>`,
        wipe: `<p:wipe dir="l"/>`,
    }[normalizeTransition(transition)];
    return inner ? `<p:transition>${inner}</p:transition>` : "";
}

/**
 * 一页 `slideN.xml`。
 * 版式决定写哪些占位符（见 LAYOUT_SHAPE）：titleContent 标题+整宽正文；twoColumn 标题+两个半宽正文
 * （都用 `type="body"`，靠 `idx="1"`/`idx="2"` 区分）；titleOnly 只有标题；blank 一个形状都不写（可以只有背景）。
 * 子元素顺序：`p:sld` → `p:cSld`（`p:bg` 必须在 `p:spTree` 之前，见 ORDER_CSLD）→ `p:clrMapOvr`
 * →（`p:transition`，仅非 none 时写）→（`p:timing`，本实现不写）。
 * `p:cSld/@name` 装版式 token，`p:sp/@name` 以同一 token 开头，两处一致化，读侧优先按它恢复版式。
 * @param {ReturnType<typeof normalizeSlide>} slide 已规整的页
 * @param {number} [scaleX] 横向几何缩放（4:3 时 <1，缺省 1）
 * @param {Array<{entry: object, width: number, height: number, x: number, y: number}>} [refs] 该页图片登记
 * @returns {string} slide 部件文本
 */
function slideXml(slide, scaleX = 1, refs = []) {
    // 横向几何统一过这个缩放：16:9 时 scaleX=1（Math.round 不改变整数），4:3 时压到 10 英寸页宽
    const sx = (v) => Math.round(v * scaleX);
    const shape = LAYOUT_SHAPE[slide.layout] || LAYOUT_SHAPE[DEFAULT_LAYOUT];
    const titleProps = { color: slide.titleColor };
    const bodyProps = { size: slide.size, color: slide.color };
    const shapes = [];
    let id = 2;
    if (shape.title) {
        const paras = parasXml(String(slide.title || "").split("\n"), {
            pPrInner: charPropsXml("defRPr", titleProps),
            rPr: charPropsXml("rPr", titleProps),
        });
        shapes.push(titleSp(paras, id++, `${slide.layout} Title`,
            { x: sx(SIDE_MARGIN), y: TITLE_OFF_Y, cx: sx(CONTENT_CX), cy: TITLE_CY }));
    }
    if (shape.body) {
        const two = shape.columns === 2;
        const left = { x: sx(SIDE_MARGIN), y: BODY_OFF_Y, cx: sx(two ? COLUMN_CX : CONTENT_CX), cy: BODY_CY };
        shapes.push(bodySp(bodyParasXml(slide.bullets.filter((b) => b.trim() !== ""), bodyProps),
            id++, `${slide.layout} Content 1`, left, 1));
        if (two) {
            const right = { x: sx(RIGHT_OFF_X), y: BODY_OFF_Y, cx: sx(COLUMN_CX), cy: BODY_CY };
            shapes.push(bodySp(bodyParasXml(slide.bulletsRight.filter((b) => b.trim() !== ""), bodyProps),
                id++, `${slide.layout} Content 2`, right, 2));
        }
    }
    // 图片按模型 x/y 定位；p:pic 不是 p:sp 序列成员，单独拼接
    refs.forEach((ref, i) => {
        shapes.push(picXml(ref, `rId${i + 2}`, id++, sx));
    });
    // p:bg 的内容按 ORDER_BGPR：填充在前、a:effectLst 在后（PowerPoint 自己的产物也带空的 effectLst）
    const bg = slide.background
        ? `<p:bg><p:bgPr>${ordered(ORDER_BGPR, {
            solidFill: solidFillXml(slide.background), effectLst: "<a:effectLst/>",
        })}</p:bgPr></p:bg>`
        : "";
    // ORDER_CSLD：p:bg 必须在 p:spTree 之前；ORDER_SLD：p:cSld 之后才是 p:clrMapOvr
    const spTree = `<p:spTree>${GRP_SP_PR}${shapes.join("")}</p:spTree>`;
    const cSld = `<p:cSld name="${escapeXml(slide.layout)}">${
        ordered(ORDER_CSLD, { bg, spTree })}</p:cSld>`;
    return `${DECL}<p:sld ${NS3}>${ordered(ORDER_SLD, {
        cSld,
        clrMapOvr: `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>`,
        transition: transitionXml(slide.transition),
    })}</p:sld>`;
}

/**
 * `ppt/slideMasters/slideMaster1.xml`：`p:cSld/p:spTree` + `p:clrMap`（12 个映射全写）+ `p:sldLayoutIdLst`。
 * 子元素顺序固定 cSld → clrMap → sldLayoutIdLst →（transition/timing）→ txStyles；动画一律不写。
 * @returns {string} 母版部件文本
 */
function slideMasterXml() {
    const emptyPara = parasXml([""], {});
    return `${DECL}<p:sldMaster ${NS3}><p:cSld name="Office 主题"><p:spTree>${GRP_SP_PR}`
        + titleSp(emptyPara) + bodySp(emptyPara)
        + `</p:spTree></p:cSld>`
        + `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"`
        + ` accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6"`
        + ` hlink="hlink" folHlink="folHlink"/>`
        + `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>`
        + `<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400" b="1"/></a:lvl1pPr></p:titleStyle>`
        + `<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:defRPr sz="2800"/></a:lvl1pPr></p:bodyStyle>`
        + `<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles>`
        + `</p:sldMaster>`;
}

/**
 * `ppt/slideLayouts/slideLayout1.xml`：清单写的 `type="TITLE"` 在 PML 里是小写枚举值 `title`
 * （XML 枚举大小写敏感，写成大写会判非法并触发修复提示）；
 * 版式里放 title 与 body 两个占位符，类型与幻灯片完全一致，占位符继承链才对得上。
 * `p:cSld/@name` 用版式 token `titleContent`：包内这一张版式承载的就是 titleContent 的骨架，
 * 页内 `p:cSld/@name` 与 `p:sp/@name` 也用同一 token，三处名字一致化。
 * 其余三种版式不另建版式部件——页内形状自带 `a:off`/`a:ext`，位置不走版式继承。
 * @returns {string} 版式部件文本
 */
function slideLayoutXml() {
    const emptyPara = parasXml([""], {});
    return `${DECL}<p:sldLayout ${NS3} type="title" preserve="1"><p:cSld name="${DEFAULT_LAYOUT}">`
        + `<p:spTree>${GRP_SP_PR}${titleSp(emptyPara)}${bodySp(emptyPara)}</p:spTree></p:cSld>`
        + `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

/** 主题里的一档纯色填充（fill 组的成员，`a:tint` 等必须嵌在 `a:schemeClr` 里面） */
const solidPh = (adj = "") => `<a:solidFill><a:schemeClr val="phClr">${adj}</a:schemeClr></a:solidFill>`;
const lineStyle = (w) => `<a:ln w="${w}" cap="rnd"><a:solidFill>`
    + `<a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill>`
    + `<a:prstDash val="solid"/><a:round/></a:ln>`;

/**
 * `ppt/theme/theme1.xml`：最小但完整。
 * `a:themeElements` 下顺序固定 clrScheme → fontScheme → fmtScheme；
 * clrScheme 的 12 个子元素顺序固定（dk1/lt1 只能是 sysClr 或 srgbClr，不能是 schemeClr）；
 * fmtScheme 是填充/线条/效果/背景填充**四**组各 3 档——背景那组清单没提，但 schema 里必需，缺了判损坏。
 * @returns {string} 主题部件文本
 */
function themeXml() {
    const colors = [
        ["dk1", '<a:sysClr val="windowText" lastClr="000000"/>'],
        ["lt1", '<a:sysClr val="window" lastClr="FFFFFF"/>'],
        ["dk2", '<a:srgbClr val="44546A"/>'],
        ["lt2", '<a:srgbClr val="E7E6E6"/>'],
        ["accent1", '<a:srgbClr val="4472C4"/>'],
        ["accent2", '<a:srgbClr val="ED7D31"/>'],
        ["accent3", '<a:srgbClr val="A5A5A5"/>'],
        ["accent4", '<a:srgbClr val="FFC000"/>'],
        ["accent5", '<a:srgbClr val="5B9BD5"/>'],
        ["accent6", '<a:srgbClr val="70AD47"/>'],
        ["hlink", '<a:srgbClr val="0563C1"/>'],
        ["folHlink", '<a:srgbClr val="954F72"/>'],
    ].map(([name, value]) => `<a:${name}>${value}</a:${name}>`).join("");

    const fonts = (major) => `<a:latin typeface="${major ? "Calibri Light" : "Calibri"}"/>`
        + `<a:ea typeface="${major ? "等线 Light" : "等线"}"/><a:cs typeface=""/>`;

    return `${DECL}<a:theme xmlns:a="${NS_A}" name="Deskly 主题"><a:themeElements>`
        + `<a:clrScheme name="Deskly">${colors}</a:clrScheme>`
        + `<a:fontScheme name="Deskly"><a:majorFont>${fonts(true)}</a:majorFont>`
        + `<a:minorFont>${fonts(false)}</a:minorFont></a:fontScheme>`
        + `<a:fmtScheme name="Deskly">`
        + `<a:fillStyleLst>${solidPh()}${solidPh('<a:lumMod val="60000"/><a:tint val="75000"/>')}`
        + `${solidPh('<a:lumMod val="60000"/><a:tint val="90000"/>')}</a:fillStyleLst>`
        + `<a:lnStyleLst>${lineStyle(6350)}${lineStyle(12700)}${lineStyle(19050)}</a:lnStyleLst>`
        + `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>`
        + `<a:effectStyle><a:effectLst/></a:effectStyle>`
        + `<a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="20000" dir="5400000" rotWithShape="0">`
        + `<a:srgbClr val="000000"><a:alpha val="38000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>`
        + `</a:effectStyleLst>`
        + `<a:bgFillStyleLst>${solidPh()}${solidPh('<a:tint val="95000"/>')}`
        + `${solidPh('<a:satMod val="105000"/><a:lumMod val="80000"/><a:tint val="80000"/>')}`
        + `</a:bgFillStyleLst></a:fmtScheme></a:themeElements>`
        + `<a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

/**
 * `ppt/notesMasters/notesMaster1.xml`：最小但合法（cSld/spTree + clrMap），主题关系另见 rels。
 * @returns {string} 备注母版部件文本
 */
function notesMasterXml() {
    return `${DECL}<p:notesMaster ${NS3}><p:cSld><p:spTree>${GRP_SP_PR}</p:spTree></p:cSld>`
        + `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"`
        + ` accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6"`
        + ` hlink="hlink" folHlink="folHlink"/></p:notesMaster>`;
}

/**
 * `ppt/notesSlides/notesSlideN.xml`：spTree 里一个 body 占位符承载备注文本，
 * 末尾 `p:clrMapOvr/a:masterClrMapping` 继承母版配色。
 * @param {string} notes 备注文本（段间 \n）
 * @returns {string} 备注页部件文本
 */
function notesSlideXml(notes) {
    return `${DECL}<p:notes ${NS3}><p:cSld><p:spTree>${GRP_SP_PR}`
        + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="备注占位符 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>`
        + `<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>`
        + `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${notesParasXml(notes)}</p:txBody></p:sp>`
        + `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

/**
 * 备注文本 -> `a:p` 序列：每行一段，行内非空时一个 run；空行写自闭合段落。
 * @param {string} notes 备注文本
 * @returns {string} XML 片段
 */
function notesParasXml(notes) {
    return String(notes).split(/\r?\n/)
        .map((line) => (line === ""
            ? "<a:p/>"
            : `<a:p><a:r><a:rPr lang="${LANG}" dirty="0"/>${textRun(line)}</a:r></a:p>`))
        .join("");
}

/**
 * `a:t`：首尾有空白时补 `xml:space="preserve"`，避免 PowerPoint 折叠空白。
 * @param {string} text 文本
 * @returns {string} XML 片段
 */
function textRun(text) {
    const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
    return `<a:t${preserve}>${escapeXml(text)}</a:t>`;
}

/** `docProps/core.xml`：DC 术语的日期必须带 xsi:type；用户文本一律过 escapeXml */
function coreXml(title) {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    return `${DECL}<cp:coreProperties xmlns:cp="${NS_CP}" xmlns:dc="${NS_DC}" xmlns:dcterms="${NS_DCT}"`
        + ` xmlns:dcmitype="${NS_DMI}" xmlns:xsi="${NS_XSI}">`
        + `<dc:title>${escapeXml(title)}</dc:title><dc:subject></dc:subject>`
        + `<dc:creator>Deskly Office</dc:creator><cp:keywords></cp:keywords>`
        + `<dc:description></dc:description><cp:lastModifiedBy>Deskly Office</cp:lastModifiedBy>`
        + `<cp:revision>1</cp:revision>`
        + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>`
        + `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`
        + `</cp:coreProperties>`;
}

/**
 * `docProps/app.xml`：`Slides` 与实际页数一致；
 * 清单要求的 `NotesPresent` 在 PowerPoint 自己的产物里写作 `Notes`，这里两个都写且值一致
 * （扩展属性是宽松的键值包，对端忽略不认识的元素）。
 * @param {Array<{title: string}>} slides 页列表
 * @returns {string} app 部件文本
 */
function appXml(slides) {
    const titles = slides.map((s) => s.title.split("\n")[0].trim());
    const noteCount = slides.filter((s) => String(s.notes || "").trim()).length;
    const vector = titles.length
        ? `<vt:vector size="${titles.length}" baseType="lpstr">`
        + `${titles.map((t) => `<vt:lpstr>${escapeXml(t)}</vt:lpstr>`).join("")}</vt:vector>`
        : `<vt:vector size="0" baseType="lpstr"/>`;
    return `${DECL}<Properties xmlns="${NS_EP}" xmlns:vt="${NS_VT}">`
        + `<Application>Deskly Office</Application><PresentationFormat>宽屏(16 x 9)</PresentationFormat>`
        + `<Slides>${slides.length}</Slides><Notes>${noteCount}</Notes><NotesPresent>0</NotesPresent>`
        + `<HiddenSlides>0</HiddenSlides><MMClips>0</MMClips>`
        + `<HeadingPairs><vt:vector size="2" baseType="variant">`
        + `<vt:variant><vt:lpstr>Slides</vt:lpstr></vt:variant>`
        + `<vt:variant><vt:i4>${slides.length}</vt:i4></vt:variant></vt:vector></HeadingPairs>`
        + `<TitlesOfParts>${vector}</TitlesOfParts>`
        + `<Company>Deskly</Company></Properties>`;
}

/**
 * 生成 .pptx 字节。
 *
 * 部件清单（缺一不可，PowerPoint 对缺件零容忍）：
 * `[Content_Types].xml`、`_rels/.rels`（officeDocument + core + app）、`ppt/presentation.xml` 及其 rels、
 * `ppt/slideMasters/slideMaster1.xml` 及其 rels、`ppt/slideLayouts/slideLayout1.xml` 及其 rels、
 * `ppt/theme/theme1.xml`、每页 `ppt/slides/slideN.xml` 及其 rels、
 * `ppt/presProps.xml` / `ppt/viewProps.xml` / `ppt/tableStyles.xml`、`docProps/core.xml` / `docProps/app.xml`。
 * 关系 id：rId1 母版、rId2 主题、rId3~5 演示/视图/表格样式属性、rId6 起为各页，
 * `p:sldIdLst` 每页一个 `r:id` 与之对应；`p:sldId/@id` 从 256 起（规范下限），母版 id 从 2147483648 起。
 * @param {Array<{title?: string, bullets?: string[]}>} slides 幻灯片列表
 * @param {{size?: string}} [page] 页面设置（16:9 / 4:3，缺省 16:9）
 * @returns {Promise<Uint8Array>} .pptx 包字节
 */
export async function buildPptx(slides, page) {
    const list = normalizeSlides(slides);
    const media = collectSlideImages(list);
    const sizeKey = page && SLIDE_SIZE_ORDER.includes(page.size) ? page.size : DEFAULT_SLIDE_SIZE;
    const dims = SLIDE_SIZES[sizeKey];
    // 4:3 只改宽度：把 16:9 的横向坐标/宽按同一比例压到 4:3 页宽，纵向不变
    const scaleX = dims.cx / SLIDE_CX;
    const parts = {};

    const slideRelId = (i) => `rId${i + 6}`;
    const slidePath = (i) => `ppt/slides/slide${i + 1}.xml`;
    // 只有非空备注才建备注页：notesSlide 按「有备注的页」从 1 顺序编号，无备注旧包不产生任何备注部件
    const noted = [];
    list.forEach((slide, i) => {
        if (slide.notes.trim()) noted.push({ slide: i, k: noted.length + 1 });
    });
    const hasNotes = noted.length > 0;
    const notesMasterRelId = `rId${6 + list.length}`;

    // OPC 惯例：`[Content_Types].xml` 与包根 `_rels/.rels` 放在包最前面（JSZip 按插入顺序写条目）
    parts["[Content_Types].xml"] = contentTypesXml([
        { part: "ppt/presentation.xml", type: CT.presentation },
        { part: "ppt/slideMasters/slideMaster1.xml", type: CT.slideMaster },
        { part: "ppt/slideLayouts/slideLayout1.xml", type: CT.slideLayout },
        { part: "ppt/theme/theme1.xml", type: CT.theme },
        { part: "ppt/presProps.xml", type: CT.presProps },
        { part: "ppt/viewProps.xml", type: CT.viewProps },
        { part: "ppt/tableStyles.xml", type: CT.tableStyles },
        { part: "docProps/core.xml", type: CT.core },
        { part: "docProps/app.xml", type: CT.app },
    ].concat(list.map((_, i) => ({ part: slidePath(i), type: CT.slide })))
        .concat(noted.map((n) => ({ part: `ppt/notesSlides/notesSlide${n.k}.xml`, type: CT.notesSlide })))
        .concat(hasNotes ? [{ part: "ppt/notesMasters/notesMaster1.xml", type: CT.notesMaster }] : []),
    media.entries);

    parts["_rels/.rels"] = relsXml([
        { id: "rId1", type: REL.officeDocument, target: "ppt/presentation.xml" },
        { id: "rId2", type: REL.core, target: "docProps/core.xml" },
        { id: "rId3", type: REL.app, target: "docProps/app.xml" },
    ]);

    parts["ppt/presentation.xml"] = `${DECL}<p:presentation ${NS3}>`
        + `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>`
        + (hasNotes ? `<p:notesMasterIdLst><p:notesMasterId r:id="${notesMasterRelId}"/></p:notesMasterIdLst>` : "")
        + `<p:sldIdLst>${list.map((_, i) => `<p:sldId id="${256 + i}" r:id="${slideRelId(i)}"/>`).join("")}</p:sldIdLst>`
        + `<p:sldSz cx="${dims.cx}" cy="${dims.cy}" type="${dims.type}"/>`
        + `<p:notesSz cx="${NOTES_CX}" cy="${NOTES_CY}"/></p:presentation>`;

    parts[relsPathOf("ppt/presentation.xml")] = relsXml([
        { id: "rId1", type: REL.slideMaster, target: "slideMasters/slideMaster1.xml" },
        { id: "rId2", type: REL.theme, target: "theme/theme1.xml" },
        { id: "rId3", type: REL.presProps, target: "presProps.xml" },
        { id: "rId4", type: REL.viewProps, target: "viewProps.xml" },
        { id: "rId5", type: REL.tableStyles, target: "tableStyles.xml" },
    ].concat(list.map((_, i) => ({ id: slideRelId(i), type: REL.slide, target: `slides/slide${i + 1}.xml` }))
        .concat(hasNotes ? [{ id: notesMasterRelId, type: REL.notesMaster, target: "notesMasters/notesMaster1.xml" }] : [])));

    parts["ppt/slideMasters/slideMaster1.xml"] = slideMasterXml();
    parts[relsPathOf("ppt/slideMasters/slideMaster1.xml")] = relsXml([
        { id: "rId1", type: REL.slideLayout, target: "../slideLayouts/slideLayout1.xml" },
        { id: "rId2", type: REL.theme, target: "../theme/theme1.xml" },
    ]);

    parts["ppt/slideLayouts/slideLayout1.xml"] = slideLayoutXml();
    parts[relsPathOf("ppt/slideLayouts/slideLayout1.xml")] = relsXml([
        { id: "rId1", type: REL.slideMaster, target: "../slideMasters/slideMaster1.xml" },
    ]);

    parts["ppt/theme/theme1.xml"] = themeXml();
    // 这三件的子元素全是可选，故写空根元素：PowerPoint 自己的产物更丰富，空的我方也能正常读
    parts["ppt/presProps.xml"] = `${DECL}<p:presentationPr ${NS3}/>`;
    parts["ppt/viewProps.xml"] = `${DECL}<p:viewPr ${NS3}/>`;
    parts["ppt/tableStyles.xml"] = `${DECL}<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`;

    list.forEach((slide, i) => {
        const refs = media.slides[i];
        const note = noted.find((n) => n.slide === i);
        parts[slidePath(i)] = slideXml(slide, scaleX, refs);
        parts[relsPathOf(slidePath(i))] = relsXml([
            { id: "rId1", type: REL.slideLayout, target: "../slideLayouts/slideLayout1.xml" },
            ...refs.map((ref, j) => ({
                id: `rId${j + 2}`,
                type: REL.image,
                target: `../${ref.entry.path.replace(/^ppt\//, "")}`,
            })),
            // 备注关系排在图片之后，id 接着图片连续编号
            ...(note ? [{ id: `rId${refs.length + 2}`, type: REL.notesSlide, target: `../notesSlides/notesSlide${note.k}.xml` }] : []),
        ]);
        if (note) {
            parts[`ppt/notesSlides/notesSlide${note.k}.xml`] = notesSlideXml(slide.notes);
            parts[relsPathOf(`ppt/notesSlides/notesSlide${note.k}.xml`)] = relsXml([
                { id: "rId1", type: REL.slide, target: `../slides/slide${i + 1}.xml` },
                { id: "rId2", type: REL.notesMaster, target: "../notesMasters/notesMaster1.xml" },
            ]);
        }
    });
    if (hasNotes) {
        parts["ppt/notesMasters/notesMaster1.xml"] = notesMasterXml();
        parts[relsPathOf("ppt/notesMasters/notesMaster1.xml")] = relsXml([
            { id: "rId1", type: REL.theme, target: "../theme/theme1.xml" },
        ]);
    }
    // 图片部件只在有图时写，无图演示文稿的包结构保持原样
    for (const entry of media.entries) parts[entry.path] = { base64: entry.base64 };

    parts["docProps/core.xml"] = coreXml(list.length ? list[0].title.split("\n")[0] : "");
    parts["docProps/app.xml"] = appXml(list);

    return zipParts(parts);
}

/**
 * 收集各页图片：按 src 去重（跨页共用 media），每页保留一份引用（含宽高与 x/y）。
 * @param {ReturnType<typeof normalizeSlide>[]} list 已规整的页
 * @returns {{entries: Array<{src: string, path: string, ext: string, base64: string}>, slides: Array<Array<{entry: object, width: number, height: number, x: number, y: number}>>}}
 */
function collectSlideImages(list) {
    const entries = [];
    const bySrc = new Map();
    const slides = list.map((slide) => {
        const refs = [];
        for (const img of slide.images) {
            const info = dataUrlImage(img.src);
            if (!info) continue;
            let entry = bySrc.get(img.src);
            if (!entry) {
                entry = {
                    src: img.src,
                    path: `ppt/media/image${entries.length + 1}.${info.ext}`,
                    ext: info.ext,
                    base64: info.base64,
                };
                entries.push(entry);
                bySrc.set(img.src, entry);
            }
            refs.push({ entry, width: img.width, height: img.height, x: img.x, y: img.y });
        }
        return refs;
    });
    return { entries, slides };
}
