/**
 * docx.js — .docx 包与 Block 文档模型的互转
 *
 * 只依赖同目录的 `xml.js`（迷你 XML 读写）与 `zip.js`（JSZip 包读写），
 * 不使用 DOMParser / XMLSerializer / document / window，因此浏览器与 Node 行为一致
 * （Node 侧才能跑「生成 -> 回读」的结构校验）。
 *
 * Block 契约（视图层按此假设，字段名不可改）：
 * ```
 * {
 *   kind: "paragraph" | "heading",
 *   level: 1 | 2 | 3 | null,
 *   text: string,               // 块内换行存 \n
 *   bold: boolean, italic: boolean, underline: boolean, strike: boolean,
 *   align: "left"|"center"|"right"|"justify"|null,
 *   indent: number,             // 0..8，1 级 = 420 twip，写进 w:ind/@w:left
 *   font: string | null,        // 中文字体名，写进 w:rFonts
 *   size: number | null,        // 磅值 pt，写进 w:sz 时 *2（半磅制）
 *   color: string | null,       // "#RRGGBB"，写进 w:color/@w:val（不带 #）
 *   highlight: string | null,   // "#RRGGBB"，写进 w:shd/@w:fill
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
 * 本迭代的已知降级：
 * - **块内混排不保留**：一个 Block 只有一组字符格式；段落内部分加粗/斜体/字号/颜色时，
 *   取「有正文的 run 里的多数票」（无正文 run 时退化为对全部 run 取多数票，平票取先出现的）。
 * - **样式继承不解析**：只读 `w:pPr` / `w:rPr` 上**显式**写出的属性。靠 styles.xml
 *   （docDefaults / Normal / Heading1..3）继承来的字体字号不会变成 Block 字段；反过来，
 *   Block 上的 null 就表示「跟随样式」，往返时不会被补成具体值。
 * - 表格降级：`w:tbl` 内的段落展开成普通段落，非首单元格的段落文本前加一个制表符（空段落不加）。
 * - 忽略列表编号、图片、脚注/尾注/批注/书签、超链接的目标地址（只取其文本）、
 *   文本框、分节符细节与域代码。
 * - 对齐只认 `w:jc`：`start`/`end`/`both`/`distribute` 归一成 left/right/justify；
 *   缩进只认 `w:ind/@w:left` 的 twip，中文文档里 Word 另写的 `@w:leftChars`（按字符数）不参与计算。
 * - 换行统一降级为 `\n`：`w:br`/`w:cr` 读成 `\n`；生成时 `\r\n`/`\r` 先归一为 `\n`。
 * - 生成包只写 Normal 与 Heading1..3 样式，原文档的其余字符样式/主题不保留。
 */

import { escapeXml, parseXml, children, allText, findAll, localNameOf, firstChild } from "./xml.js";
import { unzipXmlParts, zipParts } from "./zip.js";

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
};

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/* --------------------------------------------------------------- 顺序常量模板 --------------------------------------------------------------- */

/**
 * `w:pPr` / `w:rPr` 的子元素在 OOXML 里是 **xsd:sequence**（先后顺序属于 schema 本身），
 * 交换两个子元素 Word 就会报「文件已损坏、无法打开」。所以写入端不许在业务分支里随手拼接，
 * 一律把片段按名字塞进 frag，再由 `emitInOrder()` 按下面两条常量模板顺序落笔。
 *
 * - `PPR_ORDER`：本模块可能写出的 `w:pPr` 子元素顺序（`word/styles.xml` 的 `w:pPrDefault`
 *   用的是同一条序列，所以也走这个模板）。`numPr` / `spacing` / `rPr`
 *   只是模板里按 schema 摆好的空槽，本模块当前不写它们。
 * - `RPR_ORDER`：run 字符属性顺序。`bCs` / `iCs` / `szCs` 是 Complex Script 变体
 *   （中文、阿拉伯文那套字形），Word 对中文文档常把主属性与 Cs 变体成对写出、
 *   历史文档里甚至只剩 Cs 那一侧，故写入时成对写、读取时任一侧命中即算生效（见 `flagWithCs()`）。
 */
const PPR_ORDER = ["pStyle", "numPr", "spacing", "ind", "jc", "rPr"];
// CT_RPr 的真实序列（ECMA-376 §17.3.2.28）：… strike → color → sz → szCs → highlight → u → bdr → shd …
// 我们只写其中这些键，顺序必须照抄，否则 Word 直接判文件损坏。
const RPR_ORDER = ["rFonts", "b", "bCs", "i", "iCs", "strike", "color", "sz", "szCs", "u", "shd"];

/* ------------------------------------------------------------------ 值域常量 ------------------------------------------------------------------ */

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

/** 字号合法区间（磅）。越界即视为脏数据 -> null（跟随样式） */
const SIZE_MIN_PT = 1;
const SIZE_MAX_PT = 400;

/** `#RRGGBB`：color / highlight 只认这一种形状（读取端先把不带 # 的补上） */
const HEX_COLOR_RE = /^#([0-9a-fA-F]{6})$/;

/** 字体名长度上限（正常中文字体名远小于此），超限视为脏数据 */
const FONT_NAME_MAX = 64;

/* ------------------------------------------------------------------ 对外 API ------------------------------------------------------------------ */

/**
 * 读一个 .docx 包为文档模型。
 * @param {ArrayBuffer|Uint8Array} bytes 包字节
 * @returns {Promise<{blocks: Array<object>}>} Block 列表，字段见文件头契约
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

    const blocks = [];
    for (const node of children(body)) {
        const ln = localNameOf(node);
        if (ln === "p") blocks.push(readParagraph(node));
        else if (ln === "tbl") readTable(node, blocks);
        // 其余块级元素（sectPr / bookmarkStart / 图片容器等）跳过
    }
    return { blocks };
}

/**
 * 写一个 .docx 包。
 * @param {Array<object|string>} blocks 文档模型（缺字段或非法值只规整，不抛错）
 * @returns {Promise<Uint8Array>} 合法的 .docx 包字节
 */
export async function buildDocx(blocks) {
    if (!Array.isArray(blocks)) {
        throw new Error("buildDocx 需要 Block 数组，收到的是 " + (blocks === null ? "null" : typeof blocks));
    }
    const list = blocks.map(normalizeBlock);
    return zipParts({
        "[Content_Types].xml": contentTypesXml(),
        "_rels/.rels": rootRelsXml(),
        "word/document.xml": documentXml(list),
        "word/_rels/document.xml.rels": documentRelsXml(),
        "word/styles.xml": stylesXml(),
        "docProps/core.xml": coreXml(),
        "docProps/app.xml": appXml(),
    });
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
 * 空文档模型：一个字段齐全的空段落。
 * @returns {{blocks: Array<object>}} 可直接交给 buildDocx
 */
export function emptyDocx() {
    return { blocks: [normalizeBlock({})] };
}

/* ------------------------------------------------------------------ 读取 ------------------------------------------------------------------ */

/**
 * 解包并把失败转成中文可读错误。
 * @param {ArrayBuffer|Uint8Array} bytes 包字节
 * @returns {Promise<Map<string, string|null>>} 部件表
 */
async function readParts(bytes) {
    const empty =
        bytes === null || bytes === undefined ||
        (bytes instanceof ArrayBuffer ? bytes.byteLength === 0 : bytes instanceof Uint8Array ? bytes.length === 0 : false);
    if (empty) throw new Error("不是有效的 .docx 文件：内容为空");
    try {
        return await unzipXmlParts(bytes);
    } catch (err) {
        const reason = err && err.message ? String(err.message) : "未知原因";
        throw new Error("不是有效的 .docx 文件：无法解开压缩包（" + reason + "）");
    }
}

/**
 * 段落 -> Block：`w:pPr` 给层级/对齐/缩进，run 的多数票给正文与字符格式。
 * @param {object} p `w:p` 节点
 * @returns {object} Block
 */
function readParagraph(p) {
    const pPr = firstChild(p, "pPr");
    const styleNode = pPr ? firstChild(pPr, "pStyle") : null;
    const level = headingLevelOf(styleNode ? styleNode.attrs["w:val"] : "");
    const runs = findAll(p, "r").map(readRun);
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
    };
}

/**
 * 表格降级：把表内段落按行、单元格顺序展开成 Block，非首单元格的段落文本前加一个制表符
 * （同一单元格内的多段都带同一前缀，空段落不加，免得只剩一个孤零零的制表符）。
 * @param {object} tbl `w:tbl` 节点
 * @param {object[]} out 收集结果的数组
 */
function readTable(tbl, out) {
    for (const row of findAll(tbl, "tr")) {
        const cells = children(row).filter((c) => localNameOf(c) === "tc");
        cells.forEach((cell, cellIndex) => {
            for (const p of children(cell)) {
                if (localNameOf(p) !== "p") continue;
                const block = readParagraph(p);
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

/* ------------------------------------------------------------------ 规整 ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ 写入 ------------------------------------------------------------------ */

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
 * @param {object[]} blocks 规范 Block 列表
 * @returns {string} XML 文本
 */
function documentXml(blocks) {
    const body = blocks.map(blockXml).join("") + sectPrXml();
    return `${XML_DECL}<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;
}

/**
 * 一个 Block -> `w:p`：块级属性写在 `w:pPr` 上，顺序走 PPR_ORDER。
 * @param {object} b 规范 Block
 * @returns {string} XML 片段
 */
function blockXml(b) {
    const pPr = emitInOrder(PPR_ORDER, {
        pStyle: b.kind === "heading" ? `<w:pStyle w:val="Heading${b.level}"/>` : "",
        ind: b.indent > 0 ? `<w:ind w:left="${b.indent * INDENT_TWIP_PER_LEVEL}"/>` : "",
        jc: b.align ? `<w:jc w:val="${JC_FROM_MODEL[b.align]}"/>` : "",
    });
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runXml(b)}</w:p>`;
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

/** 结尾 `w:sectPr`：A4 页面（twip 单位） */
function sectPrXml() {
    return '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        + '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>';
}

/** `[Content_Types].xml`：Default 覆盖 rels/xml，Override 覆盖各具体部件 */
function contentTypesXml() {
    return `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
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

/** 文档级关系：只指向 styles.xml */
function documentRelsXml() {
    return relationshipsXml([{ Type: RT.styles, Target: "styles.xml" }]);
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
