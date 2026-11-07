/**
 * docx.js — .docx 包与 Block 文档模型的互转。
 * 只依赖同目录的 `xml.js` 与 `zip.js`，不碰 DOM，浏览器与 Node 行为一致（Node 侧才能跑「生成 -> 回读」校验）。
 *
 * Block 契约（视图层按此假设，字段名不可改）：
 * ```
 * {
 *   kind: "paragraph" | "heading" | "image",
 *   level: 1 | 2 | 3 | null,
 *   text: string,               // 块内换行存 \n
 *   bold: boolean, italic: boolean, underline: boolean, strike: boolean,
 *   align: "left"|"center"|"right"|"justify"|null,
 *   indent: number,             // 0..8，1 级 = 420 twip，写进 w:ind/@w:left
 *   font: string | null,        // 中文字体名，写进 w:rFonts
 *   size: number | null,        // 磅值 pt，写进 w:sz 时 *2（半磅制）
 *   color: string | null,       // "#RRGGBB"，写进 w:color/@w:val（不带 #）
 *   highlight: string | null,   // "#RRGGBB"，写进 w:shd/@w:fill
 *   lineSpacing: number | null, // 1 | 1.5 | 2，null = 单倍（默认，不写 w:spacing）
 *   spaceBefore: number,        // 段前 pt，0..72（默认 0，0 不写 w:spacing/@w:before）
 *   spaceAfter: number,         // 段后 pt，0..72（默认 0，0 不写 w:spacing/@w:after）
 *   list: "none"|"bullet"|"number", // 项目符号/编号，默认 "none"（w:numPr/@w:numId）
 *   // 仅 kind === "image" 有下面四项（图片块不承载文字，text 为空串）
 *   src: string,                // data:image/png;base64,…（支持 png/jpg/jpeg/gif/webp）
 *   width: number,              // 显示宽（px，96dpi；写进 XML 时 *9525 换成 EMU）
 *   height: number,             // 显示高（px）
 *   alt: string,                // 替代文本（写进 wp:docPr/@descr）
 * }
 * ```
 *
 * 关于 `highlight` 为什么走 `w:shd`：Word 的 `w:highlight` 取值是 ST_Highlight 枚举
 * （black/darkRed/yellow/cyan/… 共 16 个色名），塞不下任意 `#RRGGBB`，硬写十六进制会被判非法并丢掉。
 * 底纹 `w:shd/@w:fill` 收 ST_HexColor，所以自定义底色一律用 shd 承载，颜色才写得出去、读得回来。
 * 代价是 Word 把它显示成「字符底纹」而不是「以不同颜色突出显示文本」，位置不同但颜色一致。
 *
 * 非法输入只规整、不抛错（见 `normalizeBlock()` 与各 `norm*()`）：非数字的 indent、1..400 之外的 size、
 * 不是 `#RRGGBB` 的 color/highlight、枚举外的 align、非字符串或含控制字符的 font、越界的 level，
 * 全部落到该字段的安全默认值，绝不把脏值写进 XML 属性。
 *
 * 已知降级（刻意为之）：
 * - **块内混排不保留**：一个 Block 只有一组字符格式；段落内部分加粗/斜体/字号/颜色时，
 *   取「有正文的 run 里的多数票」（无正文 run 时退化为对全部 run 取多数票，平票取先出现的）。
 * - **样式继承不解析**：只读 `w:pPr` / `w:rPr` 上**显式**写出的属性。靠 styles.xml
 *   （docDefaults / Normal / Heading1..3）继承来的字体字号不会变成 Block 字段；反过来，
 *   Block 上的 null 就表示「跟随样式」，往返时不会被补成具体值。
 * - 表格降级：`w:tbl` 内的段落展开成普通段落，非首单元格的段落文本前加一个制表符（空段落不加）。
 * - 图片只按「一个段落一张图」建模：图文混排的段落拆成文字块 + 图片块；
 *   图片位置/环绕方式/裁剪/效果不建模，回写一律居中嵌入（wp:inline）。
 * - 忽略编号的层级语义：`w:numPr` 只按 `w:numId` 对应的 `w:abstractNum/w:numFmt` 归一成
 *   bullet / decimal 两种（其它格式与悬空 numId 都当无列表）；多级列表的 `w:ilvl` 不建模。
 * - 忽略脚注/尾注/批注/书签、超链接的目标地址（只取其文本）、
 *   文本框、分节符细节与域代码。
 * - 页面设置只有 `{size: "a4"|"letter"|"a5", background: string|null, header: string, footer: string,
 *   margins: {top, right, bottom, left}}`（margins 单位 pt，默认四边 72，写 `w:pgMar` 时 *20）；
 *   页眉页脚按「每个 `w:p` 一段、段间 \n」读写纯文本，字段/图片/表格不建模。
 * - 行距只认 `w:spacing/@w:line` + `@w:lineRule="auto"` 的 1/1.5/2 三档（其它倍数按最接近档规整）；
 *   `w:before`/`w:after` 按 twip→pt 取整。
 * - 对齐只认 `w:jc`：`start`/`end`/`both`/`distribute` 归一成 left/right/justify；
 *   缩进只认 `w:ind/@w:left` 的 twip，中文文档里 Word 另写的 `@w:leftChars`（按字符数）不参与计算。
 * - 换行统一降级为 `\n`：`w:br`/`w:cr` 读成 `\n`；生成时 `\r\n`/`\r` 先归一为 `\n`。
 * - 生成包只写 Normal 与 Heading1..3 样式，原文档的其余字符样式/主题不保留。
 */

import { escapeXml, parseXml, children, allText, findAll, localNameOf, firstChild } from "./xml.js";
import { unzipPackage, zipParts } from "./zip.js";

/** wordprocessingml 主命名空间 */
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
/** OPC 关系命名空间 */
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
/** OOXML 官方关系类型常量 */
const RT = {
    officeDocument: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
    styles: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
    coreProperties: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
    extendedProperties: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
    image: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    header: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header",
    footer: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer",
    numbering: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering",
};

/** 1px = 9525 EMU（96dpi）；读回时按同值反算 */
const EMU_PER_PX = 9525;
/** 图片扩展名 -> MIME（只支持这五种，svg 不插入） */
const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** 图片缺失尺寸时的兜底（px），与视图层插入图片的兜底一致 */
const IMAGE_FALLBACK_W = 200;
const IMAGE_FALLBACK_H = 150;

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/* 顺序常量模板 */

/**
 * `w:pPr` / `w:rPr` 的子元素在 OOXML 里是 **xsd:sequence**（先后顺序属于 schema 本身），
 * 交换两个子元素 Word 就会报「文件已损坏、无法打开」。所以写入端不许在业务分支里随手拼接，
 * 一律把片段按名字塞进 frag，再由 `emitInOrder()` 按下面两条常量模板顺序落笔。
 *
 * - `PPR_ORDER`：本模块可能写出的 `w:pPr` 子元素顺序（`word/styles.xml` 的 `w:pPrDefault`
 *   用的是同一条序列，所以也走这个模板）。`pStyle` / `numPr` / `spacing` / `ind` / `jc` 都按
 *   CT_PPr 的 sequence 摆好（numPr 在 spacing 之前），业务分支只填空槽。
 * - `RPR_ORDER`：run 字符属性顺序。`bCs` / `iCs` / `szCs` 是 Complex Script 变体
 *   （中文、阿拉伯文那套字形），Word 对中文文档常把主属性与 Cs 变体成对写出、
 *   历史文档里甚至只剩 Cs 那一侧，故写入时成对写、读取时任一侧命中即算生效（见 `flagWithCs()`）。
 */
const PPR_ORDER = ["pStyle", "numPr", "spacing", "ind", "jc", "rPr"];
// CT_RPr 的真实序列（ECMA-376 §17.3.2.28）：… strike → color → sz → szCs → highlight → u → bdr → shd …
// 我们只写其中这些键，顺序必须照抄，否则 Word 直接判文件损坏。
const RPR_ORDER = ["rFonts", "b", "bCs", "i", "iCs", "strike", "color", "sz", "szCs", "u", "shd"];

/* 值域常量 */

/** 模型层的对齐枚举；值域外一律规整成 null（跟随样式） */
const ALIGN_VALUES = ["left", "center", "right", "justify"];

/**
 * `w:jc` 的双向映射。ST_Jc 的枚举名是 start/left/center/right/end/both/distribute，
 * **没有 `justify`**：写 `w:jc w:val="justify"` 会被直接判损坏，Word 的两端对齐叫 `both`。
 * 读入时把历史写法与双向文本写法归一：start->left、end->right、both/distribute->justify；
 * 另外宽容接受已经写成 `justify` 的第三方产物（再写回时归成 `both`），免得白丢一次对齐。
 */
const JC_FROM_MODEL = { left: "left", center: "center", right: "right", justify: "both" };
const JC_TO_MODEL = {
    start: "left", left: "left", center: "center",
    end: "right", right: "right", both: "justify", distribute: "justify",
    justify: "justify",
};

/** 1 级缩进 = 420 twip（约 0.74cm，接近 Word「1 字符」的默认档）；读回时按同值反算 */
const INDENT_TWIP_PER_LEVEL = 420;
const INDENT_MAX_LEVELS = 8;

/** 纸张尺寸（twip，1 英寸 = 1440 twip）：只支持这三档，够覆盖常见文档 */
const PAGE_SIZES = {
    a4: { w: 11906, h: 16838 },
    letter: { w: 12240, h: 15840 },
    a5: { w: 8391, h: 11906 },
};
const PAGE_SIZE_ORDER = ["a4", "letter", "a5"];
/** 页边距合法区间（pt）：默认四边 72，非数字/负数回落 72，超过 4 英寸（288pt）夹到 288 */
const MARGIN_DEFAULT_PT = 72;
const MARGIN_MAX_PT = 288;
const MARGIN_TWIP_PER_PT = 20;
const DEFAULT_MARGINS = { top: MARGIN_DEFAULT_PT, right: MARGIN_DEFAULT_PT, bottom: MARGIN_DEFAULT_PT, left: MARGIN_DEFAULT_PT };
/** 页面设置缺省值：A4、无自定义底色、无页眉页脚文本、四边 72pt 页边距 */
const DEFAULT_PAGE = { size: "a4", background: null, header: "", footer: "", margins: DEFAULT_MARGINS };

/** 行距/段前段后的值域：行距只认 1 / 1.5 / 2（null=单倍）；段前段后 0..72pt */
const LINE_SPACING_OPTIONS = [1, 1.5, 2];
const SPACE_MAX_PT = 72;

/** 列表类型：numId 1 -> bullet，2 -> number（numbering.xml 内的固定分配） */
const LIST_NUM_IDS = { bullet: 1, number: 2 };

/** 字号合法区间（磅）。越界即视为脏数据 -> null（跟随样式） */
const SIZE_MIN_PT = 1;
const SIZE_MAX_PT = 400;

/** `#RRGGBB`：color / highlight 只认这一种形状（读取端先把不带 # 的补上） */
const HEX_COLOR_RE = /^#([0-9a-fA-F]{6})$/;

/** 字体名长度上限（正常中文字体名远小于此），超限视为脏数据 */
const FONT_NAME_MAX = 64;

/* 对外 API */

/**
 * 读一个 .docx 包为文档模型。
 * @param {ArrayBuffer|Uint8Array} bytes 包字节
 * @returns {Promise<{blocks: Array<object>, page: {size: string, background: string|null, header: string, footer: string}}>}
 *          Block 列表（字段见文件头契约）+ 页面设置（纸张尺寸、纯色页背景、页眉页脚文本）
 */
export async function parseDocx(bytes) {
    const parts = await readParts(bytes);
    const documentXml = parts.get("word/document.xml");
    if (typeof documentXml !== "string" || documentXml === "") {
        throw new Error("不是有效的 .docx 文件：缺少 word/document.xml");
    }
    if (!documentXml.includes("<")) {
        throw new Error("不是有效的 .docx 文件：word/document.xml 不是 XML 文本");
    }
    const root = parseXml(documentXml);
    if (!root || localNameOf(root) !== "document") {
        throw new Error("不是有效的 .docx 文件：word/document.xml 缺少 w:document 根元素");
    }
    const body = firstChild(root, "body");
    if (!body) {
        throw new Error("不是有效的 .docx 文件：word/document.xml 缺少 w:body");
    }

    const media = readImageContext(parts);
    const numbering = readNumberingMap(parts);
    const blocks = [];
    for (const node of children(body)) {
        const ln = localNameOf(node);
        if (ln === "p") pushParagraph(node, blocks, media, numbering);
        else if (ln === "tbl") readTable(node, blocks, numbering);
        // 其余块级元素（sectPr / bookmarkStart 等）跳过
    }
    return { blocks, page: readPage(root, body, parts) };
}

/**
 * 读 `word/numbering.xml`：`numId -> abstractNum -> w:numFmt` 归一成 bullet / number。
 * 缺失部件、悬空 numId、非 bullet/decimal 的格式一律不登记（读取端当 "none"），不抛错。
 * 多级列表只取 `w:ilvl=0` 的格式语义，深层编号仍归到一级。
 * @param {Map<string, string|{base64: string}|null>} parts 部件表
 * @returns {Map<string, "bullet"|"number">} numId -> 列表类型
 */
function readNumberingMap(parts) {
    const text = partTextAt(parts, "word/numbering.xml");
    const root = text ? parseXml(text) : null;
    const map = new Map();
    if (!root) return map;
    const fmtByAbstract = new Map();
    for (const abs of findAll(root, "abstractNum")) {
        const absId = attrOf(abs, "abstractNumId");
        if (absId === undefined) continue;
        const levels = children(abs).filter((node) => localNameOf(node) === "lvl");
        const lvl0 = levels.find((node) => String(attrOf(node, "ilvl") || "0") === "0") || levels[0];
        const fmtNode = lvl0 ? childOf(lvl0, "numFmt") : null;
        const fmt = fmtNode ? String(attrOf(fmtNode, "val") || "").trim().toLowerCase() : "";
        fmtByAbstract.set(String(absId), fmt === "bullet" ? "bullet" : fmt === "decimal" ? "number" : "none");
    }
    for (const num of children(root).filter((node) => localNameOf(node) === "num")) {
        const numId = attrOf(num, "numId");
        const absRef = childOf(num, "abstractNumId");
        const absId = absRef ? attrOf(absRef, "val") : undefined;
        if (numId === undefined || absId === undefined) continue;
        const fmt = fmtByAbstract.get(String(absId));
        if (fmt === "bullet" || fmt === "number") map.set(String(numId), fmt);
    }
    return map;
}

/**
 * 图片上下文：`word/_rels/document.xml.rels` 里的图片关系（rId -> 包内 media 路径）。
 * @param {Map<string, string|{base64: string}|null>} parts 部件表
 * @returns {{rels: Map<string, string>, parts: Map}} 图片关系与原始部件表
 */
function readImageContext(parts) {
    const rels = new Map();
    const relsText = parts.get("word/_rels/document.xml.rels");
    const root = typeof relsText === "string" ? parseXml(relsText) : null;
    if (root) {
        for (const node of findAll(root, "Relationship")) {
            const id = node.attrs.Id || node.attrs.id;
            const type = String(node.attrs.Type || "");
            if (id && type.endsWith("/image")) rels.set(id, joinPartPath("word", node.attrs.Target));
        }
    }
    return { rels, parts };
}

/**
 * 段落入列：有可读图片时写成图片块（纯图片段落不再产空文字块），文字与图片都保留。
 * @param {object} p `w:p` 节点
 * @param {object[]} out 收集结果的数组
 * @param {{rels: Map<string, string>, parts: Map}} media 图片上下文
 * @param {Map<string, "bullet"|"number">} numbering numId -> 列表类型
 */
function pushParagraph(p, out, media, numbering) {
    const images = readParagraphImages(p, media);
    if (!images.length) {
        out.push(readParagraph(p, numbering));
        return;
    }
    const block = readParagraph(p, numbering);
    if (block.text !== "") out.push(block);
    images.forEach((img) => out.push(img));
}

/**
 * 读段落里的 `w:drawing`：rId -> media 部件 -> data URL + 尺寸（EMU 反算 px）。
 * 关系悬空、部件缺失或不是支持的图片格式时跳过，不抛错。
 * @param {object} p `w:p` 节点
 * @param {{rels: Map<string, string>, parts: Map}} media 图片上下文
 * @returns {object[]} image Block
 */
function readParagraphImages(p, media) {
    const out = [];
    for (const drawing of findAll(p, "drawing")) {
        const blip = findAll(drawing, "blip")[0];
        if (!blip) continue;
        const rid = attrByLocal(blip, ["embed", "link"]);
        const path = rid ? media.rels.get(rid) : null;
        const base64 = path ? binaryAt(media.parts, path) : null;
        const ext = path ? imageExtOf(path) : "";
        const mime = IMAGE_MIME[ext];
        if (!base64 || !mime) continue;
        const extent = findAll(drawing, "extent")[0] || findAll(drawing, "ext")[0];
        const docPr = findAll(drawing, "docPr")[0];
        out.push(normalizeBlock({
            kind: "image",
            src: `data:${mime};base64,${base64}`,
            width: emuToPx(extent ? extent.attrs.cx : null, IMAGE_FALLBACK_W),
            height: emuToPx(extent ? extent.attrs.cy : null, IMAGE_FALLBACK_H),
            alt: docPr ? (docPr.attrs.descr !== undefined ? String(docPr.attrs.descr) : String(docPr.attrs.name || "")) : "",
        }));
    }
    return out;
}

/**
 * 取属性值（本地名匹配，兼容带/不带前缀的写法）。
 * @param {object|null} node XML 节点
 * @param {string[]} names 候选本地名
 * @returns {string|null}
 */
function attrByLocal(node, names) {
    if (!node || !node.attrs) return null;
    for (const want of names) {
        for (const key of Object.keys(node.attrs)) {
            const ix = key.indexOf(":");
            const local = (ix === -1 ? key : key.slice(ix + 1)).toLowerCase();
            if (local === want.toLowerCase()) return node.attrs[key];
        }
    }
    return null;
}

/**
 * 按包内路径取图片 base64（大小写不敏感，兼容第三方包）。
 * @param {Map} parts 部件表
 * @param {string} path 期望路径
 * @returns {string|null}
 */
function binaryAt(parts, path) {
    const exact = parts.get(path);
    if (exact && typeof exact === "object" && typeof exact.base64 === "string") return exact.base64;
    let hit = null;
    parts.forEach((value, real) => {
        if (hit || real.toLowerCase() !== path.toLowerCase()) return;
        if (value && typeof value === "object" && typeof value.base64 === "string") hit = value.base64;
    });
    return hit;
}

/**
 * 包内相对路径拼接（`word` + `media/image1.png`）。
 * @param {string} baseDir 基准目录
 * @param {string} target 关系 Target
 * @returns {string} 规整后的包内路径
 */
function joinPartPath(baseDir, target) {
    const raw = String(target || "").trim().replace(/\\/g, "/");
    const segs = raw.startsWith("/") ? [] : baseDir.split("/").filter(Boolean);
    for (const seg of raw.replace(/^\/+/, "").split("/")) {
        if (!seg || seg === ".") continue;
        if (seg === "..") segs.pop();
        else segs.push(seg);
    }
    return segs.join("/");
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
 * 读页面设置：`w:sectPr/w:pgSz` 的纸张尺寸 + `w:background/@w:color` 的纯色页背景
 * + `w:headerReference` / `w:footerReference` 指向的页眉页脚文本。
 * 尺寸按最近预设匹配（容差 40 twip，约 0.7mm）；匹配不到就回落 A4，不把自定义尺寸半途截断。
 * @param {object} root `w:document` 根节点
 * @param {object} body `w:body` 节点
 * @param {Map<string, string|{base64: string}|null>} parts 部件表（读页眉页脚部件用）
 * @returns {{size: string, background: string|null, header: string, footer: string, margins: {top: number, right: number, bottom: number, left: number}}}
 */
function readPage(root, body, parts) {
    let size = DEFAULT_PAGE.size;
    const pgSz = firstChild(body, "sectPr", "pgSz");
    if (pgSz) {
        const w = Number(attrOf(pgSz, "w"));
        const h = Number(attrOf(pgSz, "h"));
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
            const short = Math.min(w, h);
            const long = Math.max(w, h);
            const hit = PAGE_SIZE_ORDER.find((key) => {
                const s = PAGE_SIZES[key];
                return Math.abs(Math.min(s.w, s.h) - short) <= 40 && Math.abs(Math.max(s.w, s.h) - long) <= 40;
            });
            if (hit) size = hit;
        }
    }
    const bg = firstChild(root, "background");
    // OOXML 的 w:color 不带 #，而 normColor 认 #RRGGBB，补上前缀再规整
    const bgRaw = bg ? String(attrOf(bg, "color") || "").trim() : "";
    return {
        size,
        background: bgRaw && !/^auto$/i.test(bgRaw) ? normColor(`#${bgRaw}`) : null,
        header: readHeaderFooterText(parts, body, "headerReference", RT.header),
        footer: readHeaderFooterText(parts, body, "footerReference", RT.footer),
        margins: readMargins(body),
    };
}

/**
 * `w:sectPr/w:pgMar` -> 四边页边距（twip -> pt）；缺失或非法边回落默认 72pt。
 * @param {object} body `w:body` 节点
 * @returns {{top: number, right: number, bottom: number, left: number}}
 */
function readMargins(body) {
    const pgMar = firstChild(body, "sectPr", "pgMar");
    if (!pgMar) return { ...DEFAULT_MARGINS };
    return {
        top: readMarginPt(pgMar, "top"),
        right: readMarginPt(pgMar, "right"),
        bottom: readMarginPt(pgMar, "bottom"),
        left: readMarginPt(pgMar, "left"),
    };
}

/**
 * 单边页边距 twip -> pt：非数字/负数回落 72，超过 288 夹到 288。
 * @param {object} pgMar `w:pgMar` 节点
 * @param {string} attr `top` / `right` / `bottom` / `left`
 * @returns {number} 0..288
 */
function readMarginPt(pgMar, attr) {
    const twip = toFiniteNumber(attrOf(pgMar, attr));
    if (twip === null || twip < 0) return MARGIN_DEFAULT_PT;
    return Math.min(MARGIN_MAX_PT, twip / MARGIN_TWIP_PER_PT);
}

/**
 * 读 `w:sectPr` 里的页眉/页脚引用：`w:type="default"` 优先，否则取第一条；
 * 关系悬空、部件缺失或解析失败都返回 ""（不抛错，坏包仍能打开）。
 * @param {Map<string, string|{base64: string}|null>} parts 部件表
 * @param {object} body `w:body` 节点
 * @param {string} refName 本地名（headerReference / footerReference）
 * @param {string} relType 关系类型 URI
 * @returns {string} 段落文本（段落间以 \n 分隔）
 */
function readHeaderFooterText(parts, body, refName, relType) {
    const sectPr = firstChild(body, "sectPr");
    if (!sectPr) return "";
    const refs = children(sectPr).filter((node) => localNameOf(node) === refName);
    if (!refs.length) return "";
    const chosen = refs.find((node) => String(attrByLocal(node, ["type"]) || "").toLowerCase() === "default") || refs[0];
    const rid = attrByLocal(chosen, ["id"]);
    if (!rid) return "";

    const relsText = partTextAt(parts, "word/_rels/document.xml.rels");
    const relsRoot = relsText ? parseXml(relsText) : null;
    if (!relsRoot) return "";
    const rel = findAll(relsRoot, "Relationship").find((node) => {
        const id = node.attrs.Id || node.attrs.id;
        return id === rid && String(node.attrs.Type || "").endsWith(relType.slice(relType.lastIndexOf("/")));
    });
    if (!rel) return "";
    const partXml = partTextAt(parts, joinPartPath("word", rel.attrs.Target));
    if (!partXml) return "";
    const root = parseXml(partXml);
    if (!root) return "";
    return findAll(root, "p")
        .map((p) => findAll(p, "t").map((t) => t.text).join(""))
        .join("\n");
}

/**
 * 按包内路径取文本部件：缺失、或该路径上是图片（{base64}）时返回 ""。
 * ZIP 条目名大小写不一，故做一次大小写不敏感兜底。
 * @param {Map<string, string|{base64: string}|null>} parts 部件表
 * @param {string} path 包内路径
 * @returns {string} 文本内容
 */
function partTextAt(parts, path) {
    const want = String(path || "").replace(/^\/+/, "");
    if (!want) return "";
    if (typeof parts.get(want) === "string") return parts.get(want);
    const lower = want.toLowerCase();
    for (const [key, value] of parts) {
        if (String(key).toLowerCase() === lower && typeof value === "string") return value;
    }
    return "";
}

/**
 * 按本地名取属性值：Word 的 XML 属性都带 `w:` 前缀，但手写或第三方包可能不带，
 * 两种都认，取不到返回 undefined。
 * @param {object|null} node 节点
 * @param {string} local 属性本地名（w / h / color 等）
 * @returns {string|undefined} 属性值
 */
function attrOf(node, local) {
    const attrs = node && node.attrs ? node.attrs : {};
    const prefixed = `w:${local}`;
    return attrs[prefixed] === undefined ? attrs[local] : attrs[prefixed];
}

/**
 * 页面设置规整：非法尺寸回落 A4，非法颜色回落 null（无自定义底色）；
 * 页眉页脚只接受字符串，其它类型回落 ""；页边距四边各自规整（默认 72，0..288）。
 * @param {unknown} page 原始页面设置
 * @returns {{size: string, background: string|null, header: string, footer: string, margins: {top: number, right: number, bottom: number, left: number}}}
 */
function normPage(page) {
    const src = page && typeof page === "object" ? page : {};
    const size = PAGE_SIZE_ORDER.includes(src.size) ? src.size : DEFAULT_PAGE.size;
    return {
        size,
        background: normColor(src.background),
        header: typeof src.header === "string" ? src.header : "",
        footer: typeof src.footer === "string" ? src.footer : "",
        margins: {
            top: normMarginPt(src.margins && src.margins.top),
            right: normMarginPt(src.margins && src.margins.right),
            bottom: normMarginPt(src.margins && src.margins.bottom),
            left: normMarginPt(src.margins && src.margins.left),
        },
    };
}

/**
 * 单边页边距规整：非数字或负数回落 72pt，超过 288pt 夹到 288。
 * @param {unknown} value 原始值（pt）
 * @returns {number} 0..288
 */
function normMarginPt(value) {
    const n = toFiniteNumber(value);
    if (n === null || n < 0) return MARGIN_DEFAULT_PT;
    return Math.min(MARGIN_MAX_PT, n);
}

/**
 * 写一个 .docx 包。
 * @param {Array<object|string>} blocks 文档模型（缺字段或非法值只规整，不抛错）
 * @param {{size?: string, background?: string|null, header?: string, footer?: string, margins?: object}} [page] 页面设置（可省略，默认 A4 无底色、四边 72pt）
 * @returns {Promise<Uint8Array>} 合法的 .docx 包字节
 */
export async function buildDocx(blocks, page) {
    if (!Array.isArray(blocks)) {
        throw new Error("buildDocx 需要 Block 数组，收到的是 " + (blocks === null ? "null" : typeof blocks));
    }
    const list = blocks.map(normalizeBlock);
    const pageState = normPage(page);
    const media = collectImages(list);
    const hf = headerFooterRefs(pageState, media.entries.length);
    const hasNumbering = list.some((block) => block.list !== "none");
    const parts = {
        "[Content_Types].xml": contentTypesXml(media.entries, hf, hasNumbering),
        "_rels/.rels": rootRelsXml(),
        "word/document.xml": documentXml(list, pageState, media.bySrc, hf),
        "word/_rels/document.xml.rels": documentRelsXml(media.entries, hf, hasNumbering),
        "word/styles.xml": stylesXml(),
        "docProps/core.xml": coreXml(),
        "docProps/app.xml": appXml(),
    };
    // 只有存在 bullet/number 块时才产 numbering.xml；无列表文档的包结构保持原样
    if (hasNumbering) parts["word/numbering.xml"] = numberingXml();
    // 页眉页脚只在文本非空时写部件；空值不产生任何额外文件，包结构保持原样
    if (hf.header) parts["word/header1.xml"] = headerFooterXml(pageState.header, "hdr");
    if (hf.footer) parts["word/footer1.xml"] = headerFooterXml(pageState.footer, "ftr");
    // 只在实际有图时写 media 部件；无图文档的包结构保持原样
    for (const entry of media.entries) parts[entry.path] = { base64: entry.base64 };
    return zipParts(parts);
}

/**
 * 收集图片块：按 src 去重（同一张图多处引用共用一份 media），分配文件名与关系 id。
 * 非法 data URL 的图片块会被跳过（不写 media，也不写 drawing）。
 * @param {object[]} list 已规整的 Block 列表
 * @returns {{entries: Array<{src: string, path: string, ext: string, base64: string, rid: string}>, bySrc: Map<string, object>}}
 */
function collectImages(list) {
    const entries = [];
    const bySrc = new Map();
    for (const block of list) {
        if (block.kind !== "image") continue;
        const info = dataUrlImage(block.src);
        if (!info || bySrc.has(block.src)) continue;
        const name = `image${entries.length + 1}.${info.ext}`;
        const entry = {
            src: block.src,
            path: `word/media/${name}`,
            ext: info.ext,
            base64: info.base64,
            rid: `rId${entries.length + 2}`, // rId1 留给 styles
        };
        entries.push(entry);
        bySrc.set(block.src, entry);
    }
    return { entries, bySrc };
}

/**
 * 分配页眉页脚关系 id：rId1 是 styles，图片从 rId2 起连续编号，页眉页脚接在其后。
 * 文本 trim 后为空即视为「没有」，不占 id、不写部件。
 * @param {{header: string, footer: string}} page 规范页面设置
 * @param {number} imageCount 图片部件数量
 * @returns {{header: string, footer: string}} 关系 id（空串表示不写）
 */
function headerFooterRefs(page, imageCount) {
    const refs = { header: "", footer: "" };
    let next = imageCount + 2;
    if (page.header.trim()) {
        refs.header = `rId${next}`;
        next += 1;
    }
    if (page.footer.trim()) refs.footer = `rId${next}`;
    return refs;
}

/**
 * 页眉/页脚部件：根元素 `w:hdr` / `w:ftr`，每行一个 `w:p`，行内空白用 `xml:space` 保留。
 * @param {string} text 页眉页脚文本
 * @param {"hdr"|"ftr"} rootName 根元素本地名
 * @returns {string} XML 文本
 */
function headerFooterXml(text, rootName) {
    const paragraphs = String(text).split(/\r?\n/)
        .map((line) => (line === "" ? "<w:p/>" : `<w:p><w:r>${textXml(line)}</w:r></w:p>`))
        .join("");
    return `${XML_DECL}<w:${rootName} xmlns:w="${W}">${paragraphs}</w:${rootName}>`;
}

/**
 * 纯文本降级：每个 Block 一行。
 * @param {Array<{text?: string}>} blocks 文档模型
 * @returns {string} 纯文本
 */
export function docxToText(blocks) {
    const list = Array.isArray(blocks) ? blocks : [];
    return list.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n");
}

/**
 * 空文档模型：一个字段齐全的空段落 + 默认页面设置（四边 72pt 页边距）。
 * @returns {{blocks: Array<object>, page: {size: string, background: string|null, header: string, footer: string, margins: object}}} 可直接交给 buildDocx
 */
export function emptyDocx() {
    return { blocks: [normalizeBlock({})], page: { ...DEFAULT_PAGE, margins: { ...DEFAULT_MARGINS } } };
}

/* 读取 */

/**
 * 解包并把失败转成中文可读错误。
 * @param {ArrayBuffer|Uint8Array} bytes 包字节
 * @returns {Promise<Map<string, string|{base64: string}|null>>} 部件表（图片部件带 base64）
 */
async function readParts(bytes) {
    const empty =
        bytes === null || bytes === undefined ||
        (bytes instanceof ArrayBuffer ? bytes.byteLength === 0 : bytes instanceof Uint8Array ? bytes.length === 0 : false);
    if (empty) throw new Error("不是有效的 .docx 文件：内容为空");
    try {
        return await unzipPackage(bytes);
    } catch (err) {
        const reason = err && err.message ? String(err.message) : "未知原因";
        throw new Error("不是有效的 .docx 文件：无法解开压缩包（" + reason + "）");
    }
}

/**
 * 段落 -> Block：`w:pPr` 给层级/对齐/缩进，run 的多数票给正文与字符格式。
 * @param {object} p `w:p` 节点
 * @param {Map<string, "bullet"|"number">} numbering numId -> 列表类型
 * @returns {object} Block
 */
function readParagraph(p, numbering) {
    const pPr = firstChild(p, "pPr");
    const styleNode = pPr ? firstChild(pPr, "pStyle") : null;
    const level = headingLevelOf(styleNode ? styleNode.attrs["w:val"] : "");
    const runs = findAll(p, "r").map(readRun);
    const spacing = readSpacing(pPr);
    return {
        kind: level ? "heading" : "paragraph",
        level,
        text: runs.map((r) => r.text).join(""),
        bold: majority(runs, "bold"),
        italic: majority(runs, "italic"),
        underline: majority(runs, "underline"),
        strike: majority(runs, "strike"),
        align: readAlign(pPr),
        indent: readIndent(pPr),
        font: majorityValue(runs, "font"),
        size: majorityValue(runs, "size"),
        color: majorityValue(runs, "color"),
        highlight: majorityValue(runs, "highlight"),
        ...spacing,
        list: readList(pPr, numbering),
    };
}

/**
 * 表格降级：把表内段落按行、单元格顺序展开成 Block，非首单元格的段落文本前加一个制表符
 * （同一单元格内的多段都带同一前缀，空段落不加，免得只剩一个孤零零的制表符）。
 * @param {object} tbl `w:tbl` 节点
 * @param {object[]} out 收集结果的数组
 * @param {Map<string, "bullet"|"number">} numbering numId -> 列表类型
 */
function readTable(tbl, out, numbering) {
    for (const row of findAll(tbl, "tr")) {
        const cells = children(row).filter((c) => localNameOf(c) === "tc");
        cells.forEach((cell, cellIndex) => {
            for (const p of children(cell)) {
                if (localNameOf(p) !== "p") continue;
                const block = readParagraph(p, numbering);
                if (cellIndex > 0 && block.text !== "") block.text = "\t" + block.text;
                out.push(block);
            }
        });
    }
}

/**
 * run 的正文与字符格式。值字段（字体/字号/颜色/底纹）在读的一刻就规整，脏数据不参与投票。
 * @param {object} r `w:r` 节点
 * @returns {object} 含 text 与各格式字段的 run 记录
 */
function readRun(r) {
    const rPr = firstChild(r, "rPr");
    return {
        text: runText(r),
        bold: flagWithCs(rPr, "b", "bCs"),
        italic: flagWithCs(rPr, "i", "iCs"),
        underline: flagOn(childOf(rPr, "u")),
        strike: flagOn(childOf(rPr, "strike")),
        font: readFontName(rPr),
        size: readSizePt(rPr),
        color: readHexColor(rPr, "color", "w:val"),
        highlight: readHexColor(rPr, "shd", "w:fill"),
    };
}

/**
 * 取 run 直接子元素的正文：`w:t` 拼接、`w:br`/`w:cr` 换行、`w:tab` 制表符。
 * @param {object} r `w:r` 节点
 * @returns {string} 正文
 */
function runText(r) {
    let out = "";
    for (const c of children(r)) {
        const ln = localNameOf(c);
        if (ln === "t") out += allText(c);
        else if (ln === "br" || ln === "cr") out += "\n";
        else if (ln === "tab") out += "\t";
        // instrText / delText / drawing 等忽略
    }
    return out;
}

/**
 * 取容器（`w:rPr` 等）下第一个指定本地名的直接子元素。
 * @param {object|null} node 容器节点
 * @param {string} ln 本地名
 * @returns {object|null} 子节点或 null
 */
function childOf(node, ln) {
    return node ? children(node).find((c) => localNameOf(c) === ln) || null : null;
}

/**
 * `w:b`/`w:i`/`w:u`/`w:strike` 之类的开关：无 `w:val` 视为真，`0`/`false`/`off`/`none` 视为假。
 * 线型也走这里：`w:u w:val="none"` -> 假，`single`/`double`/`dotted` 等任一其它线型 -> 真。
 * @param {object|null} node 开关节点
 * @returns {boolean} 是否开启
 */
function flagOn(node) {
    if (!node) return false;
    const val = node.attrs["w:val"];
    if (val === undefined) return true;
    return !/^(0|false|off|none)$/i.test(String(val).trim());
}

/**
 * 主属性与它的 Complex Script 变体任一开启即算开启。
 * Word 写中文时把 `w:b`/`w:bCs`、`w:i`/`w:iCs` 成对写出，历史文档里可能只剩 Cs 那一侧；
 * 只看主属性会把中文加粗读成普通。
 * @param {object|null} rPr `w:rPr` 节点
 * @param {string} main 主属性本地名（`b`/`i`）
 * @param {string} cs 变体本地名（`bCs`/`iCs`）
 * @returns {boolean} 是否开启
 */
function flagWithCs(rPr, main, cs) {
    return flagOn(childOf(rPr, main)) || flagOn(childOf(rPr, cs));
}

/**
 * `w:rFonts`：中文排版优先取 `@w:eastAsia`，没有再退 `@w:ascii`。
 * @param {object|null} rPr `w:rPr` 节点
 * @returns {string|null} 字体名
 */
function readFontName(rPr) {
    const node = childOf(rPr, "rFonts");
    if (!node) return null;
    return normFont(node.attrs["w:eastAsia"]) || normFont(node.attrs["w:ascii"]);
}

/**
 * `w:sz` 是半磅制，读回除 2 成 pt。
 * @param {object|null} rPr `w:rPr` 节点
 * @returns {number|null} 磅值
 */
function readSizePt(rPr) {
    const node = childOf(rPr, "sz");
    if (!node) return null;
    const half = Number(node.attrs["w:val"]);
    return Number.isFinite(half) ? normSize(half / 2) : null;
}

/**
 * 取十六进制颜色：`w:color/@w:val`（字色）与 `w:shd/@w:fill`（自定义底色/高亮）。
 * OOXML 里存的是不带 `#` 的六位十六进制，`auto` 表示跟随默认。
 * @param {object|null} rPr `w:rPr` 节点
 * @param {string} tag 子元素本地名
 * @param {string} attr 属性名（含前缀）
 * @returns {string|null} `#RRGGBB` 或 null
 */
function readHexColor(rPr, tag, attr) {
    const node = childOf(rPr, tag);
    if (!node) return null;
    const raw = String(node.attrs[attr] === undefined ? "" : node.attrs[attr]).trim();
    if (raw === "" || /^auto$/i.test(raw)) return null;
    return normColor(raw.startsWith("#") ? raw : "#" + raw);
}

/**
 * `w:pPr/w:jc/@w:val` -> 模型对齐值；没有 `w:jc` 就是 null（跟随样式）。
 * @param {object|null} pPr `w:pPr` 节点
 * @returns {string|null} left|center|right|justify 或 null
 */
function readAlign(pPr) {
    const jc = childOf(pPr, "jc");
    if (!jc) return null;
    const val = String(jc.attrs["w:val"] === undefined ? "" : jc.attrs["w:val"]).trim().toLowerCase();
    return JC_TO_MODEL[val] || null;
}

/**
 * `w:pPr/w:ind/@w:left` 的 twip 反算成级：四舍五入后夹到 0..8，非数字与负数都归 0。
 * @param {object|null} pPr `w:pPr` 节点
 * @returns {number} 缩进级数
 */
function readIndent(pPr) {
    const ind = childOf(pPr, "ind");
    if (!ind) return 0;
    const twip = Number(ind.attrs["w:left"]);
    if (!Number.isFinite(twip)) return 0;
    return clampIndent(Math.round(twip / INDENT_TWIP_PER_LEVEL));
}

/**
 * `w:pPr/w:spacing` -> 行距与段前段后：`w:line` 按 240 为 1 倍、只认 1/1.5/2（其它按最接近档），
 * `w:before`/`w:after` 由 twip 反算 pt 四舍五入并夹到 0..72；缺失一律默认（null / 0 / 0）。
 * @param {object|null} pPr `w:pPr` 节点
 * @returns {{lineSpacing: number|null, spaceBefore: number, spaceAfter: number}}
 */
function readSpacing(pPr) {
    const node = childOf(pPr, "spacing");
    if (!node) return { lineSpacing: null, spaceBefore: 0, spaceAfter: 0 };
    const line = toFiniteNumber(attrOf(node, "line"));
    return {
        lineSpacing: line === null || line <= 0 ? null : nearestLineSpacing(line / 240),
        spaceBefore: readSpacePt(node, "before"),
        spaceAfter: readSpacePt(node, "after"),
    };
}

/**
 * 段落间距 twip -> pt：四舍五入后夹到 0..72（非数字/负数归 0）。
 * @param {object} node `w:spacing` 节点
 * @param {string} attr `before` / `after`
 * @returns {number} 0..72
 */
function readSpacePt(node, attr) {
    const twip = toFiniteNumber(attrOf(node, attr));
    if (twip === null || twip <= 0) return 0;
    return Math.min(SPACE_MAX_PT, Math.round(twip / MARGIN_TWIP_PER_PT));
}

/**
 * 行距倍数按最接近的 1 / 1.5 / 2 档规整（等距时取小档，保证 1.25 归 1）。
 * @param {number} mult 倍数
 * @returns {number} 1 | 1.5 | 2
 */
function nearestLineSpacing(mult) {
    return LINE_SPACING_OPTIONS.reduce((best, v) => (Math.abs(v - mult) < Math.abs(best - mult) ? v : best), LINE_SPACING_OPTIONS[0]);
}

/**
 * `w:pPr/w:numPr` -> 列表类型：只看 `w:numId` 指向的 numFmt（忽略 `w:ilvl` 的层级）。
 * 无部件 / 悬空 numId / 非 bullet/decimal -> "none"。
 * @param {object|null} pPr `w:pPr` 节点
 * @param {Map<string, "bullet"|"number">} numbering numId -> 列表类型
 * @returns {"none"|"bullet"|"number"}
 */
function readList(pPr, numbering) {
    const numPr = childOf(pPr, "numPr");
    if (!numPr) return "none";
    const numIdNode = childOf(numPr, "numId");
    const numId = numIdNode ? attrOf(numIdNode, "val") : undefined;
    if (numId === undefined) return "none";
    return numbering.get(String(numId)) || "none";
}

/**
 * 段落级取多数 run 的开关：只在有正文的 run 上投票，全空时退化为对全部 run 投票。
 * @param {Array<{text: string}>} runs run 列表
 * @param {string} key 开关名
 * @returns {boolean} 多数结果
 */
function majority(runs, key) {
    const basis = runs.filter((r) => r.text !== "");
    const src = basis.length ? basis : runs;
    if (!src.length) return false;
    return src.filter((r) => r[key]).length * 2 > src.length;
}

/**
 * 段落级取多数 run 的「值」字段（字体/字号/字色/底色）：同样只让有正文的 run 投票，
 * 平票取先出现的，全为空即 null（跟随样式）。
 * @param {Array<{text: string}>} runs run 列表
 * @param {string} key 字段名
 * @returns {string|number|null} 多数结果
 */
function majorityValue(runs, key) {
    const basis = runs.filter((r) => r.text !== "");
    const values = (basis.length ? basis : runs).map((r) => r[key]).filter((v) => v !== null && v !== undefined);
    if (!values.length) return null;
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    // Map 保持插入顺序，所以「平票取先出现的」天然成立
    let best = values[0];
    let bestCount = 0;
    for (const [value, count] of counts) {
        if (count > bestCount) { best = value; bestCount = count; }
    }
    return best;
}

/**
 * `w:pStyle` 的样式 id -> 标题层级（`Title` 与 `1`/`Heading1`/`heading 1` 等归一到 1..3）。
 * @param {string} val 样式 id
 * @returns {1|2|3|null} 层级；非标题为 null
 */
function headingLevelOf(val) {
    const id = String(val === undefined || val === null ? "" : val).trim().toLowerCase().replace(/\s+/g, " ");
    if (id === "" || id === "normal") return null;
    const m = /^heading ([1-3])$/.exec(id) || /^heading([1-3])$/.exec(id) || /^([1-3])$/.exec(id);
    if (m) return Number(m[1]);
    if (id === "title") return 1;
    return null;
}

/* 规整 */

/**
 * 补齐 Block 缺失字段、把非法值规整成安全默认值，并把行尾归一为 `\n`。
 * @param {object|string} raw 原始 Block（也接受纯文本字符串）
 * @returns {object} 字段齐全且值域合法的 Block
 */
function normalizeBlock(raw) {
    const b = typeof raw === "string" ? { text: raw } : (raw || {});
    const rawLevel = toFiniteNumber(b.level);
    const level = rawLevel === null ? NaN : Math.round(rawLevel);
    const isHeading = b.kind === "heading" && level >= 1 && level <= 3;
    if (b.kind === "image") {
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
            src: typeof b.src === "string" ? b.src.trim() : "",
            width: normImagePx(b.width, IMAGE_FALLBACK_W),
            height: normImagePx(b.height, IMAGE_FALLBACK_H),
            alt: typeof b.alt === "string" ? b.alt : "",
        };
    }
    return {
        kind: isHeading ? "heading" : "paragraph",
        level: isHeading ? level : null,
        text: String(b.text === undefined || b.text === null ? "" : b.text).replace(/\r\n?/g, "\n"),
        bold: !!b.bold,
        italic: !!b.italic,
        underline: !!b.underline,
        strike: !!b.strike,
        align: normAlign(b.align),
        indent: normIndent(b.indent),
        font: normFont(b.font),
        size: normSize(b.size),
        color: normColor(b.color),
        highlight: normColor(b.highlight),
        lineSpacing: normLineSpacing(b.lineSpacing),
        spaceBefore: normSpacePt(b.spaceBefore),
        spaceAfter: normSpacePt(b.spaceAfter),
        list: normList(b.list),
    };
}

/**
 * 只承认「真能解析成有限数字」的值：布尔与 null 直接拒（`Number(true) === 1` 这种巧合不算格式值），
 * 其余交给 Number()，所以输入框里的字符串数字照常可用。
 * @param {unknown} value 原始值
 * @returns {number|null} 有限数字或 null
 */
function toFiniteNumber(value) {
    if (typeof value === "boolean" || value === null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/**
 * 对齐：容忍大小写与首尾空白，枚举之外（含非字符串）一律 null。
 * @param {unknown} value 原始值
 * @returns {string|null} ALIGN_VALUES 之一或 null
 */
function normAlign(value) {
    if (typeof value !== "string") return null;
    const key = value.trim().toLowerCase();
    return ALIGN_VALUES.includes(key) ? key : null;
}

/**
 * 缩进级数：非数字 -> 0；小数四舍五入；负数与超过 8 级夹回边界。
 * @param {unknown} value 原始值
 * @returns {number} 0..8
 */
function normIndent(value) {
    const n = toFiniteNumber(value);
    if (n === null) return 0;
    return clampIndent(Math.round(n));
}

/**
 * @param {number} n 级数
 * @returns {number} 夹到 0..INDENT_MAX_LEVELS
 */
function clampIndent(n) {
    return Math.min(INDENT_MAX_LEVELS, Math.max(0, n));
}

/**
 * 行距：null/非数字/<=0 -> null（单倍且不写 XML）；其它按最接近的 1 / 1.5 / 2 档规整。
 * @param {unknown} value 原始值
 * @returns {number|null} 1 | 1.5 | 2 | null
 */
function normLineSpacing(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = toFiniteNumber(value);
    if (n === null || n <= 0) return null;
    return nearestLineSpacing(n);
}

/**
 * 段前/段后：pt，四舍五入并夹到 0..72；非数字或负数归 0。
 * @param {unknown} value 原始值（pt）
 * @returns {number} 0..72
 */
function normSpacePt(value) {
    const n = toFiniteNumber(value);
    if (n === null || n < 0) return 0;
    return Math.min(SPACE_MAX_PT, Math.round(n));
}

/**
 * 列表类型：只认 bullet / number，其余（含大小写外的值）归 "none"。
 * @param {unknown} value 原始值
 * @returns {"none"|"bullet"|"number"}
 */
function normList(value) {
    if (typeof value !== "string") return "none";
    const key = value.trim().toLowerCase();
    return key === "bullet" || key === "number" ? key : "none";
}

/**
 * 字体名：必须是非空字符串，去空白后不含控制字符或尖括号（这类值会撑坏属性），
 * 长度不超过 FONT_NAME_MAX，否则 null。引号可以留，写属性时统一转义。
 * @param {unknown} value 原始值
 * @returns {string|null} 字体名或 null
 */
function normFont(value) {
    if (typeof value !== "string") return null;
    const name = value.trim();
    if (name === "" || name.length > FONT_NAME_MAX) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f<>]/.test(name)) return null;
    return name;
}

/**
 * 磅值：非数字或超出 1..400 -> null（跟随样式）。
 * 合法值再归一到半磅精度（`Math.round(n * 2) / 2`），因为 `w:sz` 只能是整数十半磅；
 * 不归一就会出现 12.3 -> 25（=12.5）这样的往返漂移。
 * @param {unknown} value 原始值
 * @returns {number|null} 磅值
 */
function normSize(value) {
    const n = toFiniteNumber(value);
    if (n === null || n < SIZE_MIN_PT || n > SIZE_MAX_PT) return null;
    return Math.round(n * 2) / 2;
}

/**
 * 图片像素尺寸：非数字/非正数用兜底值，其余四舍五入成整数 px。
 * @param {unknown} value 原始值
 * @param {number} fallback 兜底 px
 * @returns {number}
 */
function normImagePx(value, fallback) {
    const n = toFiniteNumber(value);
    if (n === null || n <= 0) return fallback;
    return Math.max(1, Math.round(n));
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

/**
 * 颜色：只认 `#RRGGBB`（容忍大小写与首尾空白，输出统一大写），
 * 其余（`red`、`#FFF`、少 `#`、`auto`、非字符串）一律 null。
 * @param {unknown} value 原始值
 * @returns {string|null} `#RRGGBB` 或 null
 */
function normColor(value) {
    if (typeof value !== "string") return null;
    const raw = value.trim();
    if (/^auto$/i.test(raw)) return null;
    const m = HEX_COLOR_RE.exec(raw);
    return m ? "#" + m[1].toUpperCase() : null;
}

/* 写入 */

/**
 * 按常量模板输出片段：frag 里没有值的槽跳过，有值的严格按 order 的先后落笔。
 * 顺序是 schema 硬约束，这里是唯一出口，业务代码不得绕过。
 * @param {string[]} order PPR_ORDER 或 RPR_ORDER
 * @param {Record<string, string>} frag 子元素本地名 -> XML 片段
 * @returns {string} 拼接结果
 */
function emitInOrder(order, frag) {
    return order.map((name) => frag[name] || "").join("");
}

/**
 * `word/document.xml`。
 * `w:background` 是 `w:document` 的直接子元素、且必须排在 `w:body` 之前（schema 顺序），
 * 所以单独拼在根下，不进 body。
 * @param {object[]} blocks 规范 Block 列表
 * @param {{size: string, background: string|null, header: string, footer: string}} page 规范页面设置
 * @param {Map<string, object>} bySrc 图片 src -> media 登记
 * @param {{header: string, footer: string}} hf 页眉页脚关系 id（空串表示不写）
 * @returns {string} XML 文本
 */
function documentXml(blocks, page, bySrc, hf) {
    const body = blocks.map((b, i) => blockXml(b, bySrc, i + 1)).join("") + sectPrXml(page, hf);
    const bg = page.background ? `<w:background w:color="${page.background.slice(1)}"/>` : "";
    // 图片需要 wp/a/pic 与 r 关系前缀；无图文档多声明几个命名空间是合法的，故始终写齐
    return `${XML_DECL}<w:document xmlns:w="${W}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"`
        + ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`
        + ` xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`
        + ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
        + `${bg}<w:body>${body}</w:body></w:document>`;
}

/**
 * 一个 Block -> `w:p`：块级属性写在 `w:pPr` 上，顺序走 PPR_ORDER；图片块改写成内嵌 drawing 段落。
 * @param {object} b 规范 Block
 * @param {Map<string, object>} bySrc 图片 src -> media 登记（图片块用）
 * @param {number} docPrId 本文档内唯一且非 0 的 drawing 编号
 * @returns {string} XML 片段（图片无法落盘时返回空串）
 */
function blockXml(b, bySrc, docPrId) {
    if (b.kind === "image") {
        const ref = bySrc ? bySrc.get(b.src) : null;
        return ref ? imageParagraphXml(b, ref, docPrId) : "";
    }
    const pPr = emitInOrder(PPR_ORDER, {
        pStyle: b.kind === "heading" ? `<w:pStyle w:val="Heading${b.level}"/>` : "",
        numPr: listNumPrXml(b.list),
        spacing: spacingXml(b),
        ind: b.indent > 0 ? `<w:ind w:left="${b.indent * INDENT_TWIP_PER_LEVEL}"/>` : "",
        jc: b.align ? `<w:jc w:val="${JC_FROM_MODEL[b.align]}"/>` : "",
    });
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runXml(b)}</w:p>`;
}

/**
 * `w:pPr/w:numPr`：一级列表固定 `w:ilvl=0`，numId 按 LIST_NUM_IDS 分配（bullet=1 / number=2）。
 * @param {"none"|"bullet"|"number"} list 列表类型
 * @returns {string} XML 片段（none 返回空串，不写 numPr）
 */
function listNumPrXml(list) {
    const numId = LIST_NUM_IDS[list];
    if (!numId) return "";
    return `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`;
}

/**
 * `w:pPr/w:spacing`：只写非默认项——`lineSpacing` 为 null 不写 `w:line`，
 * 段前段后为 0 不写 `w:before`/`w:after`；有行距时固定 `w:lineRule="auto"`。
 * @param {object} b 规范 Block
 * @returns {string} XML 片段（全默认时返回空串）
 */
function spacingXml(b) {
    const attrs = [];
    if (b.lineSpacing !== null) attrs.push(`w:line="${Math.round(b.lineSpacing * 240)}"`, 'w:lineRule="auto"');
    if (b.spaceBefore > 0) attrs.push(`w:before="${Math.round(b.spaceBefore * MARGIN_TWIP_PER_PT)}"`);
    if (b.spaceAfter > 0) attrs.push(`w:after="${Math.round(b.spaceAfter * MARGIN_TWIP_PER_PT)}"`);
    return attrs.length ? `<w:spacing ${attrs.join(" ")}/>` : "";
}

/**
 * 图片 Block -> 段落内的标准 `w:drawing/wp:inline`（居中嵌入，不写环绕/裁剪/效果）。
 * 结构按 ECMA-376：wp:inline → wp:extent → wp:docPr → wp:cNvGraphicFramePr →
 * a:graphic/a:graphicData/pic:pic（nvPicPr → blipFill → spPr）。
 * @param {object} b 规范图片 Block
 * @param {{path: string, ext: string, rid: string}} ref media 登记
 * @param {number} docPrId 文档内唯一且非 0 的编号
 * @returns {string} `w:p` XML
 */
function imageParagraphXml(b, ref, docPrId) {
    const cx = Math.round(b.width * EMU_PER_PX);
    const cy = Math.round(b.height * EMU_PER_PX);
    const alt = escapeXml(b.alt || "");
    return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>`
        + `<wp:inline distT="0" distB="0" distL="0" distR="0">`
        + `<wp:extent cx="${cx}" cy="${cy}"/>`
        + `<wp:docPr id="${docPrId}" name="图片 ${docPrId}" descr="${alt}"/>`
        + `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`
        + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
        + `<pic:pic><pic:nvPicPr><pic:cNvPr id="${docPrId}" name="图片 ${docPrId}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>`
        + `<pic:blipFill><a:blip r:embed="${ref.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
        + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
        + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
        + `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/**
 * Block -> 单个 `w:r`（块内样式一致，故一个 run 足够）。
 * @param {object} b 规范 Block
 * @returns {string} XML 片段（空段落返回空串）
 */
function runXml(b) {
    const props = emitInOrder(RPR_ORDER, runPrFrag(b));
    const rPr = props ? `<w:rPr>${props}</w:rPr>` : "";
    const inner = [];
    for (const [lineIndex, line] of String(b.text).split("\n").entries()) {
        if (lineIndex > 0) inner.push("<w:br/>");
        for (const [tabIndex, segment] of line.split("\t").entries()) {
            if (tabIndex > 0) inner.push("<w:tab/>");
            if (segment !== "") inner.push(textXml(segment));
        }
    }
    if (!inner.length && !rPr) return "";
    return `<w:r>${rPr}${inner.join("")}</w:r>`;
}

/**
 * Block -> run 属性 frag 表（交给 `emitInOrder(RPR_ORDER, …)` 定序）。
 * @param {object} b 规范 Block
 * @returns {Record<string, string>} frag 表
 */
function runPrFrag(b) {
    const font = b.font ? escapeXml(b.font) : "";
    // 半磅制：12pt -> 24，10.5pt -> 21（normSize 已保证值是半磅整数倍）
    const halfPoints = b.size === null ? "" : String(Math.round(b.size * 2));
    return {
        rFonts: font ? `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>` : "",
        b: b.bold ? "<w:b/>" : "",
        bCs: b.bold ? "<w:bCs/>" : "",
        i: b.italic ? "<w:i/>" : "",
        iCs: b.italic ? "<w:iCs/>" : "",
        strike: b.strike ? "<w:strike/>" : "",
        u: b.underline ? '<w:u w:val="single"/>' : "",
        color: b.color ? `<w:color w:val="${b.color.slice(1)}"/>` : "",
        // 自定义底色走 shd 而不是 highlight，理由见文件头注释（枚举色名装不下 #RRGGBB）
        shd: b.highlight ? `<w:shd w:val="clear" w:color="auto" w:fill="${b.highlight.slice(1)}"/>` : "",
        sz: halfPoints ? `<w:sz w:val="${halfPoints}"/>` : "",
        szCs: halfPoints ? `<w:szCs w:val="${halfPoints}"/>` : "",
    };
}

/**
 * `w:t`：首尾有空白、或有连续空白时补 `xml:space="preserve"`，否则这些空白会被 Word 折叠掉。
 * @param {string} segment 不含换行与制表符的文本
 * @returns {string} XML 片段
 */
function textXml(segment) {
    const preserve = /^\s|\s$|\s{2,}/.test(segment) ? ' xml:space="preserve"' : "";
    return `<w:t${preserve}>${escapeXml(segment)}</w:t>`;
}

/**
 * 结尾 `w:sectPr`：页眉页脚引用（schema 要求排在 `w:pgSz` 之前）+ 纸张尺寸（twip 单位）
 * + 四边页边距（`w:pgMar` 紧随 `w:pgSz`；只写 top/right/bottom/left，不写 header/footer/gutter）。
 * @param {{size: string, background: string|null, header: string, footer: string, margins: object}} page 规范页面设置
 * @param {{header: string, footer: string}} hf 页眉页脚关系 id（空串表示不写）
 * @returns {string} XML 片段
 */
function sectPrXml(page, hf) {
    const s = PAGE_SIZES[page.size] || PAGE_SIZES.a4;
    const refs = (hf.header ? `<w:headerReference w:type="default" r:id="${hf.header}"/>` : "")
        + (hf.footer ? `<w:footerReference w:type="default" r:id="${hf.footer}"/>` : "");
    const m = page.margins;
    const pgMar = [["top", m.top], ["right", m.right], ["bottom", m.bottom], ["left", m.left]]
        .map(([key, pt]) => `w:${key}="${Math.round(pt * MARGIN_TWIP_PER_PT)}"`)
        .join(" ");
    return `<w:sectPr>${refs}<w:pgSz w:w="${s.w}" w:h="${s.h}"/><w:pgMar ${pgMar}/></w:sectPr>`;
}

/**
 * `word/numbering.xml`：两个 abstractNum（0=bullet 用 `w:numFmt="bullet"` + `w:lvlText="•"`，
 * 1=decimal 用 `w:numFmt="decimal"` + `w:lvlText="%1."`），各配一个 `w:num`
 * （numId 1 -> abstract 0，numId 2 -> abstract 1，与 LIST_NUM_IDS 对齐）。
 * @returns {string} XML 文本
 */
function numberingXml() {
    const level = (fmt, text) =>
        '<w:lvl w:ilvl="0"><w:start w:val="1"/>'
        + `<w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>`
        + '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>';
    return `${XML_DECL}<w:numbering xmlns:w="${W}">`
        + `<w:abstractNum w:abstractNumId="0">${level("bullet", "•")}</w:abstractNum>`
        + `<w:abstractNum w:abstractNumId="1">${level("decimal", "%1.")}</w:abstractNum>`
        + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
        + '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
        + "</w:numbering>";
}

/**
 * `[Content_Types].xml`：Default 覆盖 rels/xml/图片扩展名，Override 覆盖各具体部件。
 * @param {Array<{ext: string}>} [images] 需要登记 Default 的图片（按扩展名去重）
 * @param {{header: string, footer: string}} [hf] 页眉页脚关系 id（非空才写对应 Override）
 * @param {boolean} [hasNumbering] 是否写了 `word/numbering.xml`
 * @returns {string} XML 文本
 */
function contentTypesXml(images = [], hf = { header: "", footer: "" }, hasNumbering = false) {
    const exts = [];
    for (const img of images) if (img.ext && !exts.includes(img.ext)) exts.push(img.ext);
    const imageDefaults = exts
        .map((ext) => `<Default Extension="${ext}" ContentType="${IMAGE_MIME[ext] || "application/octet-stream"}"/>`)
        .join("");
    const hfOverrides = (hf.header
        ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
        : "")
        + (hf.footer
            ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
            : "");
    const numberingOverride = hasNumbering
        ? '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
        : "";
    return `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + imageDefaults
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        + numberingOverride
        + hfOverrides
        + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        + "</Types>";
}

/**
 * `<Relationships/>` 通用写出。
 * @param {Array<{Type: string, Target: string}>} rels 关系列表（Id 按顺序生成）
 * @returns {string} XML 文本
 */
function relationshipsXml(rels) {
    const body = rels
        .map((r, i) => `<Relationship Id="rId${i + 1}" Type="${r.Type}" Target="${escapeXml(r.Target)}"/>`)
        .join("");
    return `${XML_DECL}<Relationships xmlns="${REL_NS}">${body}</Relationships>`;
}

/** 包级关系：文档主体 + 两组文档属性 */
function rootRelsXml() {
    return relationshipsXml([
        { Type: RT.officeDocument, Target: "word/document.xml" },
        { Type: RT.coreProperties, Target: "docProps/core.xml" },
        { Type: RT.extendedProperties, Target: "docProps/app.xml" },
    ]);
}

/**
 * 文档级关系：rId1 指向 styles.xml，其后按顺序写图片关系（与 collectImages 的 rid 对齐），
 * 最后追加页眉页脚关系（与 headerFooterRefs 的编号对齐），再追加 numbering 关系。
 * @param {Array<{path: string}>} [images] media 登记
 * @param {{header: string, footer: string}} [hf] 页眉页脚关系 id
 * @param {boolean} [hasNumbering] 是否写了 `word/numbering.xml`
 * @returns {string} XML 文本
 */
function documentRelsXml(images = [], hf = { header: "", footer: "" }, hasNumbering = false) {
    return relationshipsXml([
        { Type: RT.styles, Target: "styles.xml" },
        ...images.map((img) => ({ Type: RT.image, Target: img.path.replace(/^word\//, "") })),
        ...(hf.header ? [{ Type: RT.header, Target: "header1.xml" }] : []),
        ...(hf.footer ? [{ Type: RT.footer, Target: "footer1.xml" }] : []),
        ...(hasNumbering ? [{ Type: RT.numbering, Target: "numbering.xml" }] : []),
    ]);
}

/**
 * `word/styles.xml`：docDefaults + Normal + Heading1..3。
 *
 * docDefaults 描述「Block 字段取默认值（null / false / 0）时」文档应有的外观，逐条对齐
 * `normalizeBlock()` 的默认值：无下划线、无删除线、字色 auto、底纹 fill auto、缩进 0 级、
 * 对齐 left、字号 21 半磅（10.5pt）、字体 Calibri / 宋体。
 * 这样 Normal 不会与块属性打架：块属性一律作为**直接格式**写进 `w:pPr`/`w:rPr`，
 * Word 里直接格式的优先级高于样式，而我们的读取端也只认这两处、不回读样式继承。
 *
 * 顺序同样走常量模板：`w:pPrDefault` 内的 `w:pPr` 用 PPR_ORDER（ind 在 jc 之前），
 * `w:rPrDefault` 内的 `w:rPr` 用 RPR_ORDER；docDefaults 本身 `w:pPrDefault` 必须先于
 * `w:rPrDefault`（CT_DocDefaults 的 sequence）。
 * @returns {string} XML 文本
 */
function stylesXml() {
    const heading = (n, size) =>
        `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/>`
        + '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
        + `<w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="${n - 1}"/></w:pPr>`
        + `<w:rPr><w:b/><w:bCs/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
    const defaultRPr = emitInOrder(RPR_ORDER, {
        rFonts: '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Calibri"/>',
        u: '<w:u w:val="none"/>',
        color: '<w:color w:val="auto"/>',
        shd: '<w:shd w:val="clear" w:color="auto" w:fill="auto"/>',
        sz: '<w:sz w:val="21"/>',
        szCs: '<w:szCs w:val="21"/>',
    });
    const defaultPPr = emitInOrder(PPR_ORDER, {
        ind: '<w:ind w:left="0" w:right="0" w:firstLine="0" w:leftChars="0" w:firstLineChars="0"/>',
        jc: '<w:jc w:val="left"/>',
    });
    return `${XML_DECL}<w:styles xmlns:w="${W}">`
        + "<w:docDefaults>"
        + `<w:pPrDefault><w:pPr>${defaultPPr}</w:pPr></w:pPrDefault>`
        + `<w:rPrDefault><w:rPr>${defaultRPr}</w:rPr></w:rPrDefault>`
        + "</w:docDefaults>"
        + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
        + heading(1, 32) + heading(2, 28) + heading(3, 24)
        + "</w:styles>";
}

/** `docProps/core.xml`：最小属性集 */
function coreXml() {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    return `${XML_DECL}<cp:coreProperties`
        + ' xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
        + ' xmlns:dc="http://purl.org/dc/elements/1.1/"'
        + ' xmlns:dcterms="http://purl.org/dc/terms/"'
        + ' xmlns:dcmitype="http://purl.org/dc/dcmitype/"'
        + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        + "<dc:creator>Deskly Office</dc:creator>"
        + "<dc:title>Deskly Document</dc:title>"
        + "<cp:lastModifiedBy>Deskly Office</cp:lastModifiedBy>"
        + "<cp:revision>1</cp:revision>"
        + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>`
        + `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`
        + "</cp:coreProperties>";
}

/** `docProps/app.xml` */
function appXml() {
    return `${XML_DECL}<Properties`
        + ' xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"'
        + ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        + "<Application>Deskly Office</Application>"
        + "<DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>"
        + "<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>"
        + "<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion>"
        + "</Properties>";
}
