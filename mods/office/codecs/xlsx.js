/**
 * xlsx.js — 电子表格编解码（.xlsx 读写 + .csv 读写）
 *
 * 与 `word.js`/`pptx.js` 同层：只依赖同目录的 `xml.js`（迷你 XML 读写）与
 * `zip.js`（OOXML 包读写），不用 DOMParser / XMLSerializer / document / window，
 * 所以浏览器和 Node 都能跑（Node 里跑才能做「生成 → 回读」的结构自校验）。
 *
 * 数据契约（UI 层依赖，勿改签名）：
 *   Sheet     = { name: string, rows: string[][], styles: CellStyle[][] }
 *   CellStyle = { bold, italic, underline, strike, color, fill, align, wrap, format } | null
 *   - rows 全是字符串（数字也存成字符串），且一定是**矩形**：每行等长，长度 = 该表的最大列数，空格子为 ""。
 *   - styles 与 rows **同矩形**（行列下标一一对应）：无格式的格子为 null，入参缺位补 null、多位裁掉，
 *     csv 没有样式也必须给出同矩形的 null，否则视图按下标取值时会崩。
 *   - color/fill 是 "#RRGGBB"（写出成 ARGB 八位，读回只认 rgb 属性）；align 是
 *     'left'|'center'|'right'|null；wrap 是布尔；format 是 Excel 数字格式串，null = General。
 *   - 值以 `=` 开头即公式：写 `<f>公式</f><v>缓存值</v>`。
 *
 * 已知降级点（刻意为之，注释里写明）：
 *   - 公式**不求值**（求值在视图层做）：写出时缓存值未知，统一 `<v>0</v>` 占位（缺 `<v>` 会让
 *     Excel 在重算前显示空白，占位 0 最安全）。回读规则：有 `<f>` 且 `<v>` 缺失或正是占位 0
 *     时还原成 `=公式`；有非占位缓存值（Excel 算好的）时按缓存值原文返回，保持历史行为
 *     （`<f>A1*2</f><v>24</v>` 读成 "24"）。不支持数组公式/共享公式（不写 `t="array"`、不写 `si`）。
 *   - 日期/时间不换算序列号：按 `<v>` 原始数字字符串返回（如 45352.5），只把 numFmt 的
 *     格式串搬到 `format`，由视图层决定怎么显示。
 *   - 布尔按原文返回（"1"/"0"），不翻译成「真/假」。
 *   - 样式只搬模型这九项：主题色/indexed 色/渐变填充/边框/字体名字号/vertical 对齐/indent/
 *     阅读顺序/cellStyles/dxfs/条件格式一律忽略；`<u>` 不区分单双波浪（模型只有一个布尔）。
 *   - numFmt 内置编号用**视图层（Ribbon 格式菜单）契约表**：`0%`=10、`0.00%`=11，与 ECMA-376
 *     的 9/10/11 差一位；读写都用这张表故自己的文件往返一致，读外部文件时再用 ID_FMT_ALIAS
 *     兜住 ECMA 常见编号（兜到的串不在契约表里，回写会落自定义编号 >=164，Excel 接受）。
 *   - 生成时不用 sharedStrings（一律 inlineStr），避免共享字符串表与索引的一致性风险。
 *   - 生成时**空格子也会写出 `<c r="A1"/>`**：这样「空尾列 / 空行」在 build → parse
 *     后行数列数分毫不差（往返保真优先于包体积）。
 *   - 解析按最大 `@r` 展开成矩形：若来源文件把格式刷到了第 1048576 行，会真的分配
 *     一百来万行（不做截断，宁慢不丢）。
 */

import { escapeXml, parseXml, children, allText, localNameOf, firstChild } from "./xml.js";
import { unzipXmlParts, zipParts } from "./zip.js";

/** 纯数字判定：命中即按数值单元格写出，否则按文本写出 */
const NUM_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/** 颜色判定：模型里 color/fill 只接受 #RRGGBB，其余（red/#FFF/rgb(...)/数字）规整为 null */
const HEX6_RE = /^#[0-9a-fA-F]{6}$/;
/** ARGB 八位或 RGB 六位（OOXML 里写的是八位 ARGB，个别产物写六位） */
const ARGB_RE = /^[0-9a-fA-F]{8}$|^[0-9a-fA-F]{6}$/;

/** 对齐枚举：视图层只认这三种，其它（general/justify/fill/distributed）规整为 null */
const ALIGN_VALUES = new Set(["left", "center", "right"]);
/** 读回时 horizontal -> 枚举：只认三种，general 等一律 null */
const ALIGN_READ = new Map([["left", "left"], ["center", "center"], ["right", "right"]]);

/**
 * 内置数字格式契约表：格式串 -> numFmtId（General 不在表里，恒为 0/null）。
 * 这是视图层 Ribbon 格式菜单用的编号，与 ECMA-376 的百分比编号差一位
 * （ECMA：9=`0%`、10=`0.00%`、11=科学计数）。为了菜单项与文件里的 numFmtId 一一对应，
 * 读写都以此表为准；读外部文件时另有 ID_FMT_ALIAS 兜 ECMA 编号。
 */
const FMT_ID = new Map([["0.00", 2], ["#,##0", 3], ["#,##0.00", 4], ["0%", 10], ["0.00%", 11], ["yyyy-mm-dd", 14]]);
/** FMT_ID 的反查表（numFmtId -> 格式串）：自己产出的文件靠它保证往返一致 */
const ID_FMT = new Map(Array.from(FMT_ID, ([code, id]) => [id, code]));
/** 只在「读外部文件」时用上的 ECMA 常见内置编号；写出时它们都落自定义编号 */
const ID_FMT_ALIAS = new Map([[1, "0"], [5, "#,##0"], [6, "#,##0.00"], [9, "0%"], [20, "0.00E+00"], [22, "m/d/yy h:mm"], [45, "mm:ss"], [46, "[h]:mm:ss"]]);
/** 自定义 numFmt 的起始编号（0~163 归内置） */
const CUSTOM_FMT_FIRST_ID = 164;
/** Excel 约定 fills 的 0 位是 none、1 位是 gray125，缺了会被判样式异常 */
const DEFAULT_FILL_MARKERS = [null, "gray125"];

/** 电子表格命名空间 */
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
/** 关系命名空间（r:id 用） */
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/** OPC 关系命名空间 */
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

const CT_REL = "application/vnd.openxmlformats-package.relationships+xml";
const CT_XML = "application/xml";
const CT_SHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const CT_WORKSHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
const CT_STYLES = "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml";
const CT_CORE = "application/vnd.openxmlformats-package.core-properties+xml";
const CT_APP = "application/vnd.openxmlformats-officedocument.spreadsheetml.extended-properties+xml";

/* ============================ 对外 API ============================ */

/**
 * 造一个空白工作表。
 * @param {string} name 表名
 * @returns {{name: string, rows: string[][], styles: Array<Array<object|null>>}} 1x1 空格子、无格式的工作表
 */
export function emptySheet(name = "工作表1") {
    return { name, rows: [[""]], styles: [[null]] };
}

/**
 * 解析 .xlsx 字节，取出全部工作表（顺序与 workbook.xml 一致）。
 * styles 与 rows 同矩形；无样式部件 / `s` 缺失或越界的格子给 null。
 * @param {ArrayBuffer|Uint8Array} bytes .xlsx 文件字节
 * @returns {Promise<{sheets: Array<{name: string, rows: string[][], styles: Array<Array<object|null>>}>}>}
 * @throws {Error} 中文错误：不是 zip 包 / 缺 workbook.xml
 */
export async function parseXlsx(bytes) {
    let parts;
    try {
        parts = await unzipXmlParts(bytes);
    } catch (err) {
        throw new Error(`不是有效的 .xlsx 文件：压缩包无法解出部件（${err && err.message ? err.message : String(err)}）`);
    }
    const index = buildPartIndex(parts);
    const wbText = pickPart(parts, index, "xl/workbook.xml");
    if (wbText == null) throw new Error("不是有效的 .xlsx 文件：缺少 xl/workbook.xml 工作簿部件");

    const shared = readSharedStrings(pickPart(parts, index, "xl/sharedStrings.xml"));
    // styles.xml 缺失或读不出时 xfs 为空数组：所有格子的样式都按 null 处理，不影响取值
    const xfs = readCellXfs(pickPart(parts, index, "xl/styles.xml"));
    const wb = parseXml(wbText);
    const sheetsNode = firstChild(wb, "sheets");
    const sheetNodes = sheetsNode ? kids(sheetsNode, "sheet") : [];
    const rels = readRels(pickPart(parts, index, "xl/_rels/workbook.xml.rels"), "xl/_rels/workbook.xml.rels");

    const sheets = [];
    sheetNodes.forEach((node, i) => {
        const name = node.attrs.name || `工作表${i + 1}`;
        const text = resolveSheetText(parts, index, rels, node, i);
        // 部件找不到时给空表而不是炸：真实产物里偶有悬空引用，表格能开比报错有用
        if (text == null) sheets.push({ name, rows: [], styles: [] });
        else sheets.push(Object.assign({ name }, readSheet(text, shared, xfs)));
    });
    if (!sheets.length) sheets.push(emptySheet());
    return { sheets };
}

/**
 * 由工作表数组生成 .xlsx 字节（单表/多表都支持）。
 * 全簿共用一张样式表：相同 CellStyle 共用一个 cellXfs 下标（去重），
 * 被引用的 font/fill/numFmt 都会真实建进对应集合，count 与长度严格一致。
 * @param {Array<{name?: string, rows?: string[][], styles?: Array<Array<object|null>>}>} sheets 工作表数组
 * @returns {Promise<Uint8Array>} .xlsx 包字节
 */
export async function buildXlsx(sheets) {
    const list = normalizeSheetList(sheets);
    const reg = collectStyles(list); // 顺带给每个 sheet 补上 styleIds（cellXfs 下标矩阵）
    const parts = {};
    const overrides = [
        { part: "/xl/workbook.xml", type: CT_SHEET },
        ...list.map((_, i) => ({ part: `/xl/worksheets/sheet${i + 1}.xml`, type: CT_WORKSHEET })),
        { part: "/xl/styles.xml", type: CT_STYLES },
        { part: "/docProps/core.xml", type: CT_CORE },
        { part: "/docProps/app.xml", type: CT_APP },
    ];

    parts["[Content_Types].xml"] = contentTypesXml(overrides);
    parts["_rels/.rels"] = rootRelsXml();
    parts["xl/workbook.xml"] = workbookXml(list);
    parts["xl/_rels/workbook.xml.rels"] = workbookRelsXml(list.length);
    parts["xl/styles.xml"] = stylesXml(reg);
    parts["docProps/core.xml"] = coreXml();
    parts["docProps/app.xml"] = appXml(list);
    list.forEach((sheet, i) => {
        parts[`xl/worksheets/sheet${i + 1}.xml`] = worksheetXml(sheet);
    });
    return zipParts(parts);
}

/**
 * 解析 CSV 文本（RFC4180 子集：只认逗号分隔）。
 * 支持引号包裹、引号内的逗号/换行/`""` 转义、`\r\n` 与 `\n` 与 `\r`、BOM 剥离；
 * 文首的 BOM 会被剥掉，文末连续的空行不产生空行（中间的空白行保留）。
 * 注意：`["a",""]` 这类**含逗号**的行能安全往返；只有「整行没有任何内容」的尾行会被削掉。
 * csv 不带样式，但 styles 仍给出与 rows 同矩形的 null（视图层按下标取值，缺位会崩）。
 * @param {string} text CSV 文本
 * @returns {Array<{name: string, rows: string[][], styles: Array<Array<object|null>>}>} 单元素数组
 */
export function parseCsv(text) {
    const rows = rectangleFromGrid(csvGrid(text));
    return [{ name: "工作表1", rows, styles: rectangleStyleGrid(null, rows.length, colsOf(rows)) }];
}

/**
 * 生成 CSV 文本：含逗号/引号/换行的字段加引号并把 `"` 翻倍，行以 `\r\n` 结尾。
 * 只看值：csv 承载不了样式与公式缓存，styles 入参被忽略（公式仍按 `=原文` 写进字段）。
 * @param {{name?: string, rows?: string[][]}} sheet 工作表
 * @returns {string} CSV 文本
 */
export function buildCsv(sheet) {
    const rows = (sheet && sheet.rows) || [];
    if (!rows.length) return "";
    return rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/**
 * 工作表转 TSV（供复制到剪贴板，粘进 Excel/WPS 即成表格）。
 * 单元格内的制表符与换行会被压成空格，否则剪贴板分列会错位。
 * @param {{rows?: string[][]}} sheet 工作表
 * @returns {string} 行以 `\n` 分隔、列以 `\t` 分隔的文本
 */
export function sheetToTsv(sheet) {
    const rows = (sheet && sheet.rows) || [];
    return rows
        .map((row) => row.map((v) => String(v === undefined || v === null ? "" : v).replace(/[\t\r\n]+/g, " ")).join("\t"))
        .join("\n");
}

/* ============================ xlsx 读取 ============================ */

/**
 * 部件名大小写索引：不同厂商写法（`xl/SharedStrings.xml`）都能命中。
 * @param {Map<string, string>} parts 解压结果
 * @returns {Map<string, string>} 小写路径 -> 真实路径
 */
function buildPartIndex(parts) {
    const index = new Map();
    parts.forEach((_v, path) => index.set(path.toLowerCase(), path));
    return index;
}

/**
 * 按路径取部件文本（大小写不敏感），取不到或非文本部件返回 null。
 * @param {Map<string, string|null>} parts 解压结果
 * @param {Map<string, string>} index 小写索引
 * @param {string} path 期望路径
 * @returns {string|null} 部件文本
 */
function pickPart(parts, index, path) {
    const real = index.get(String(path).toLowerCase());
    if (real === undefined) return null;
    const text = parts.get(real);
    return typeof text === "string" ? text : null;
}

/**
 * 读 `<Relationship>` 列表。
 * @param {string|null} text rels 部件文本
 * @param {string} relsPath rels 部件路径（用于相对 Target 的定位基准）
 * @returns {Map<string, {target: string, type: string, external: boolean}>} rId -> 关系
 */
function readRels(text, relsPath) {
    const out = new Map();
    if (!text) return out;
    const root = parseXml(text);
    const list = root ? kids(root, "Relationship") : [];
    list.forEach((node) => {
        const id = node.attrs.Id || node.attrs.id;
        if (!id) return;
        out.set(id, {
            target: node.attrs.Target || "",
            type: node.attrs.Type || "",
            external: String(node.attrs.TargetMode || "").toLowerCase() === "external",
            relsPath,
        });
    });
    return out;
}

/**
 * 取属性（按属性本地名），用于 `r:id` 这类前缀不固定的属性。
 * @param {object} node XML 节点
 * @param {string[]} localNames 候选本地名（按优先级）
 * @returns {string|null}
 */
function attrByLocal(node, localNames) {
    if (!node || !node.attrs) return null;
    for (const want of localNames) {
        for (const key of Object.keys(node.attrs)) {
            const ix = key.indexOf(":");
            const local = (ix === -1 ? key : key.slice(ix + 1)).toLowerCase();
            if (local === want) return node.attrs[key];
        }
    }
    return null;
}

/**
 * 目录部分：`xl/_rels/workbook.xml.rels` -> `xl/_rels`。
 * @param {string} path 部件路径
 * @returns {string} 所在目录（无目录时为空串）
 */
function dirname(path) {
    const ix = path.lastIndexOf("/");
    return ix === -1 ? "" : path.slice(0, ix);
}

/**
 * 相对路径拼接并折叠 `..` 与 `.`。
 * @param {string} dir 基准目录
 * @param {string} rel 相对路径
 * @returns {string} 规范化后的包内路径
 */
function joinPath(dir, rel) {
    const segs = dir ? dir.split("/").filter(Boolean) : [];
    for (const seg of rel.split("/")) {
        if (!seg || seg === ".") continue;
        if (seg === "..") segs.pop();
        else segs.push(seg);
    }
    return segs.join("/");
}

/**
 * 把 relationship 的 Target 规范化成包内部件路径候选（按优先级）。
 *
 * 这是 xlsx 解析最容易错的一步：Target 按 OPC 规范应相对**源部件所在目录**
 * （workbook 即 `xl/`），但不少产物（WPS/老 Excel/自研导出）写成相对 `_rels`
 * 目录，于是出现 `../worksheets/sheet1.xml`；也有写成绝对 `/xl/worksheets/...` 的。
 * 这里把几种解释都列成候选，由调用方挑包里真实存在的那条。
 * @param {string} rawTarget 关系里的原始 Target
 * @param {string} relsPath rels 部件路径
 * @returns {string[]} 候选路径（已去重）
 */
function targetCandidates(rawTarget, relsPath) {
    const raw = String(rawTarget || "").trim();
    const cleaned = raw.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!cleaned) return [];
    if (raw.startsWith("/")) return [cleaned]; // 绝对路径：去头斜杠即包内路径
    const relsDir = dirname(relsPath);        // xl/_rels
    const partDir = dirname(relsDir);         // xl
    const out = [];
    const push = (p) => { if (p && !out.includes(p)) out.push(p); };
    push(joinPath(partDir, cleaned));         // 规范解释
    push(joinPath(relsDir, cleaned));         // 相对 _rels 的常见误写
    return out;
}

/**
 * Target 的尾段片段（最后两级），用于「既不符合规范也不像误写」时的包内兜底搜索。
 * @param {string} rawTarget 关系里的原始 Target
 * @returns {string} 片段
 */
function targetSuffix(rawTarget) {
    return String(rawTarget || "").trim().replace(/\\/g, "/").replace(/^\/+/, "").split("/").slice(-2).join("/");
}

/**
 * 在包索引里按尾部片段搜索部件路径。
 * @param {Map<string, string>} index 小写索引
 * @param {string} tail 片段（如 `worksheets/sheet1.xml`）
 * @returns {string[]} 命中的真实路径
 */
function findBySuffix(index, tail) {
    const needle = tail.toLowerCase();
    const hits = [];
    index.forEach((real, lower) => {
        if (lower === needle || lower.endsWith("/" + needle)) hits.push(real);
    });
    return hits;
}

/**
 * 定位第 i 个 sheet 节点对应的 worksheet 部件文本。
 * @param {Map<string, string|null>} parts 解压结果
 * @param {Map<string, string>} index 小写索引
 * @param {Map} rels workbook.xml.rels 的关系表
 * @param {object} node `<sheet>` 节点
 * @param {number} i sheet 序号（0 起）
 * @returns {string|null} worksheet 部件文本
 */
function resolveSheetText(parts, index, rels, node, i) {
    const relsPath = "xl/_rels/workbook.xml.rels";
    const rid = attrByLocal(node, ["id", "relid", "relationshipid"]);
    const candidates = [];
    const rel = rid ? rels.get(rid) : null;
    if (rel && !rel.external) {
        targetCandidates(rel.target, relsPath).forEach((p) => candidates.push(p));
        // 两种解释都不命中时按尾段搜（`../xl/worksheets/sheet1.xml` 之类写法）
        findBySuffix(index, targetSuffix(rel.target)).forEach((p) => candidates.push(p));
    }
    // 没有 rels 或关系悬空时按位置猜：xl/worksheets/sheetN.xml
    candidates.push(`xl/worksheets/sheet${i + 1}.xml`);
    for (const cand of candidates) {
        const text = pickPart(parts, index, cand);
        if (text != null) return text;
    }
    return null;
}

/**
 * 按本地名取直接子元素（`<c>` 与 `<x:c>` 都能命中）。
 * SpreadsheetML 主流产物用默认命名空间，但少数导出器会带前缀，故一律按本地名匹配。
 * @param {object} node 父节点
 * @param {string} localName 标签本地名
 * @returns {object[]} 子节点数组
 */
function kids(node, localName) {
    if (!node) return [];
    return children(node).filter((c) => localNameOf(c) === localName);
}

/**
 * 读 sharedStrings：`<si>` 可能是富文本（多个 `<r><t>`），要按顺序拼全部 `<t>`；
 * `<rPh>` 注音 run 里的 `<t>` 不属于正文，跳过。
 * @param {string|null} text 部件文本（可能缺失）
 * @returns {string[]} 索引表
 */
function readSharedStrings(text) {
    if (!text) return [];
    const root = parseXml(text);
    if (!root) return [];
    return kids(root, "si").map((si) => collectRunText(si));
}

/**
 * 拼接节点下全部 `<t>` 文本（跳过 `<rPh>`）。
 * @param {object} node 起点节点
 * @returns {string} 文本
 */
function collectRunText(node) {
    let out = "";
    const walk = (cur) => {
        for (const child of children(cur)) {
            const local = localNameOf(child);
            if (local === "rPh") continue;
            if (local === "t") out += allText(child);
            else walk(child);
        }
    };
    walk(node);
    return out;
}

/**
 * 列字母 -> 1 起列号（`A`->1，`B7` 取 `B`->2）。
 * @param {string} ref 单元格地址或纯列字母
 * @returns {number} 列号；无法识别时 0
 */
function colFromRef(ref) {
    const m = /^([A-Za-z]+)/.exec(String(ref || ""));
    if (!m) return 0;
    let n = 0;
    for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
}

/**
 * 1 起列号 -> 列字母（1->A, 26->Z, 27->AA）。
 * @param {number} col 列号
 * @returns {string} 列字母
 */
function colLetter(col) {
    let n = Math.max(1, Math.floor(col));
    let out = "";
    while (n > 0) {
        const rem = (n - 1) % 26;
        out = String.fromCharCode(65 + rem) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}

/**
 * 读一个 worksheet 部件的全部格子：按 `@r` 定位，稀疏格子补位，rows 与 styles 一起矩形化。
 * @param {string} text worksheet 部件文本
 * @param {string[]} shared 共享字符串表
 * @param {Array<object|null>} xfs cellXfs 归一化结果（下标即 `<c s="i">` 的 i）
 * @returns {{rows: string[][], styles: Array<Array<object|null>>}} 同矩形的值网格与样式网格
 */
function readSheet(text, shared, xfs) {
    const root = parseXml(text);
    const sheetData = root ? firstChild(root, "sheetData") : null;
    const rowNodes = sheetData ? kids(sheetData, "row") : [];
    const grid = [];
    let maxRow = 0;
    let maxCol = 0;

    rowNodes.forEach((rowNode, i) => {
        const rAttr = parseInt(rowNode.attrs.r, 10);
        const rowNum = Number.isFinite(rAttr) && rAttr > 0 ? rAttr : i + 1;
        const cellNodes = kids(rowNode, "c");
        let autoCol = 0;
        cellNodes.forEach((cell, j) => {
            const cAttr = cell.attrs.r ? colFromRef(cell.attrs.r) : 0;
            const colNum = cAttr > 0 ? cAttr : autoCol + 1;
            autoCol = colNum;
            if (rowNum > maxRow) maxRow = rowNum;
            if (colNum > maxCol) maxCol = colNum;
            grid.push({ row: rowNum, col: colNum, value: cellValue(cell, shared), style: styleOf(cell, xfs) });
        });
    });

    const rows = [];
    const styles = [];
    if (maxRow === 0 || maxCol === 0) return { rows, styles };
    for (let r = 0; r < maxRow; r++) {
        rows.push(new Array(maxCol).fill(""));
        styles.push(new Array(maxCol).fill(null));
    }
    for (const cell of grid) {
        rows[cell.row - 1][cell.col - 1] = cell.value;
        styles[cell.row - 1][cell.col - 1] = cell.style;
    }
    return { rows, styles };
}

/**
 * 取单元格样式：`s` 是 cellXfs 下标，缺失、非整数或越界一律 null（不抛错）。
 * @param {object} cell `<c>` 节点
 * @param {Array<object|null>} xfs cellXfs 归一化结果
 * @returns {object|null} CellStyle
 */
function styleOf(cell, xfs) {
    const idx = parseInt(cell.attrs.s, 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= xfs.length) return null;
    return xfs[idx] || null;
}

/**
 * 取单元格文本值。
 * `t="s"` 查共享字符串；`t="inlineStr"` 取 `<is>`；`t="str"`/`t="b"`/`t="e"`/无 `t`
 * 一律取 `<v>` 原文（数字与日期因此保持原始数字字符串，不做格式还原）。
 * 公式单元格按「缓存值优先」取：Excel 算好的非零缓存值原样返回（历史行为）；
 * 缓存值缺失或正好是我们写出的占位 0 时还原成 `=公式`，交给视图层求值。
 * @param {object} cell `<c>` 节点
 * @param {string[]} shared 共享字符串表
 * @returns {string} 单元格文本（永远不为 null）
 */
function cellValue(cell, shared) {
    const t = String(cell.attrs.t || "");
    if (t === "inlineStr") {
        const is = firstChild(cell, "is");
        return is ? collectRunText(is) : allText(cell);
    }
    const vNode = cell.children.find((c) => localNameOf(c) === "v") || null;
    if (t === "s") {
        if (!vNode) return "";
        const idx = parseInt(allText(vNode), 10);
        if (!Number.isFinite(idx) || idx < 0 || idx >= shared.length) return "";
        return shared[idx];
    }
    const raw = vNode ? allText(vNode) : "";
    const formula = formulaOf(cell);
    if (formula && (raw === "" || raw === "0")) return "=" + formula;
    return raw;
}

/**
 * 取 `<f>` 里的公式原文（不含前导 `=`）；非公式单元格返回空串。
 * 只认普通公式：`t="array"`/`si`（共享公式）的额外语义不支持，公式文本照样取得到。
 * @param {object} cell `<c>` 节点
 * @returns {string} 公式文本或 ""
 */
function formulaOf(cell) {
    const f = firstChild(cell, "f");
    return f ? allText(f).trim() : "";
}

/* ============================ 样式表读取（xl/styles.xml） ============================ */

/**
 * 读 cellXfs：逐个 `<xf>` 用 fontId/fillId/numFmtId 反查 fonts/fills/numFmts，
 * 对齐看 `<xf>` 的内联 `<alignment>`（OOXML 没有独立的 alignments 集合，
 * 所谓 alignmentId 反查就落在这个子元素上），最后归一化成 CellStyle（全默认 -> null）。
 * 部件缺失、没有 cellXfs、属性越界都只给 null，不影响取值。
 * @param {string|null} text styles 部件文本
 * @returns {Array<object|null>} 下标即 `<c s="i">` 的 i
 */
function readCellXfs(text) {
    if (!text) return [];
    const root = parseXml(text);
    const holder = root ? firstChild(root, "cellXfs") : null;
    if (!holder) return [];
    const fonts = kids(firstChild(root, "fonts"), "font").map(readFontRecord);
    const fills = kids(firstChild(root, "fills"), "fill").map(readFillRecord);
    const custom = readNumFmts(root);
    return kids(holder, "xf").map((xf) => readXfStyle(xf, fonts, fills, custom));
}

/**
 * 读一个 `<font>`：`<b/>`/`<i/>`/`<strike/>` 看有无子元素（显式 val="0"/"false" 算关），
 * `<u>` 只要不是 val="none" 就算有下划线，颜色只认 rgb 属性。
 * @param {object} node `<font>` 节点
 * @returns {{bold: boolean, italic: boolean, underline: boolean, strike: boolean, color: string|null}}
 */
function readFontRecord(node) {
    return {
        bold: onFlag(node, "b"),
        italic: onFlag(node, "i"),
        strike: onFlag(node, "strike"),
        underline: underlined(node),
        color: colorOf(firstChild(node, "color")),
    };
}

/**
 * `<b/>` `<i/>` `<strike/>` 这类开关子元素：缺失 false，val 为 0/false 也 false。
 * @param {object} node 父节点
 * @param {string} localName 开关子元素的本地名
 * @returns {boolean}
 */
function onFlag(node, localName) {
    const child = firstChild(node, localName);
    if (!child) return false;
    return !isOff(child.attrs.val);
}

/** `<u val="none"/>` 之外的 `<u>` 都算下划线（单双波浪不区分） */
function underlined(node) {
    const u = firstChild(node, "u");
    if (!u) return false;
    return String(u.attrs.val === undefined ? "single" : u.attrs.val).trim().toLowerCase() !== "none";
}

/** 开关属性值判定：0 / false 视为关，其余（含缺失）视为开 */
function isOff(raw) {
    const v = String(raw === undefined || raw === null ? "" : raw).trim().toLowerCase();
    return v === "0" || v === "false";
}

/** 开关属性值判定（正向）：1 / true 才算开 */
function isOn(raw) {
    const v = String(raw === undefined || raw === null ? "" : raw).trim().toLowerCase();
    return v === "1" || v === "true";
}

/**
 * `<color>` -> `#RRGGBB`；theme/auto/indexed/tinted 一律 null（不做主题解析）。
 * @param {object|null} node `<color>` 节点
 * @returns {string|null}
 */
function colorOf(node) {
    if (!node) return null;
    return argbToHex(node.attrs.rgb);
}

/**
 * ARGB(`FFFF0000`) / RGB(`FF0000`) / 带井号的写法 -> `#RRGGBB`（大写），其余 null。
 * @param {*} raw 颜色属性原文
 * @returns {string|null}
 */
function argbToHex(raw) {
    const s = String(raw === undefined || raw === null ? "" : raw).trim().replace(/^#/, "");
    if (!ARGB_RE.test(s)) return null;
    return normColor("#" + (s.length === 8 ? s.slice(2) : s));
}

/**
 * 读一个 `<fill>` -> 填充色 `#RRGGBB` 或 null。
 * 实心填充的颜色按 OOXML 惯例在 `<fgColor>`；none 与 gray125（Excel 的默认底纹）都算无填充。
 * @param {object} node `<fill>` 节点
 * @returns {string|null}
 */
function readFillRecord(node) {
    const pf = firstChild(node, "patternFill");
    if (!pf) return null;
    const type = String(pf.attrs.patternType === undefined ? "none" : pf.attrs.patternType).trim().toLowerCase();
    if (type === "none" || type === "gray125") return null;
    return colorOf(firstChild(pf, "fgColor")) || colorOf(firstChild(pf, "bgColor")) || null;
}

/**
 * 读 `<numFmts>`：自定义编号 -> 格式串。
 * @param {object} root `<styleSheet>` 根节点
 * @returns {Map<number, string>}
 */
function readNumFmts(root) {
    const out = new Map();
    kids(firstChild(root, "numFmts"), "numFmt").forEach((node) => {
        const id = parseInt(node.attrs.numFmtId, 10);
        const code = normFormat(node.attrs.formatCode);
        if (Number.isFinite(id) && code) out.set(id, code);
    });
    return out;
}

/**
 * numFmtId -> 格式串：自定义表优先，再查本模块契约表（读写同表保证往返一致），
 * 再兜 ECMA 常见编号；0（General）与不认识的编号给 null。
 * @param {number} id numFmtId
 * @param {Map<number, string>} custom 自定义编号表
 * @returns {string|null}
 */
function numFmtCode(id, custom) {
    if (custom.has(id)) return custom.get(id);
    if (ID_FMT.has(id)) return ID_FMT.get(id);
    if (ID_FMT_ALIAS.has(id)) return ID_FMT_ALIAS.get(id);
    return null;
}

/**
 * 一个 `<xf>` -> CellStyle。fontId/fillId 越界或缺失按默认字体/无填充处理，
 * numFmtId 缺失即 0（General）。
 * @param {object} xf `<xf>` 节点
 * @param {Array<object>} fonts fonts 集合
 * @param {Array<string|null>} fills fills 集合
 * @param {Map<number, string>} custom 自定义 numFmt 表
 * @returns {object|null}
 */
function readXfStyle(xf, fonts, fills, custom) {
    const font = fonts[inRangeIndex(xf.attrs.fontId, fonts.length)];
    const fill = fills[inRangeIndex(xf.attrs.fillId, fills.length)];
    const numFmtId = parseInt(xf.attrs.numFmtId, 10);
    const alignNode = firstChild(xf, "alignment");
    return sanitizeStyle({
        bold: font ? font.bold : false,
        italic: font ? font.italic : false,
        underline: font ? font.underline : false,
        strike: font ? font.strike : false,
        color: font ? font.color : null,
        fill: fill === undefined ? null : fill,
        align: alignNode ? ALIGN_READ.get(String(alignNode.attrs.horizontal || "").trim().toLowerCase()) || null : null,
        wrap: alignNode ? isOn(alignNode.attrs.wrapText) : false,
        format: numFmtCode(Number.isFinite(numFmtId) && numFmtId >= 0 ? numFmtId : -1, custom),
    });
}

/**
 * 取集合下标：属性缺失、非整数或越界时返回 -1（让调用方拿到 undefined 走默认值）。
 * @param {*} raw 属性原文
 * @param {number} length 集合长度
 * @returns {number}
 */
function inRangeIndex(raw, length) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 && n < length ? n : -1;
}

/* ============================ xlsx 写出 ============================ */

/**
 * 规范入参：确保是 `{name, rows, styles}` 数组，行矩形化、值转字符串、样式与行同矩形、
 * 表名合规且唯一。
 * @param {*} sheets 用户传入的工作表数组
 * @returns {Array<{name: string, rows: string[][], styles: Array<Array<object|null>>}>}
 */
function normalizeSheetList(sheets) {
    const list = Array.isArray(sheets) ? sheets.filter(Boolean) : [];
    const names = new Set();
    const out = list.map((sheet, i) => {
        const name = uniqueSheetName(sheet.name || `工作表${i + 1}`, names);
        const rows = rectangleFromGrid(sheet.rows);
        // 样式网格以 rows 的矩形为准：缺位补 null，多出来的行列裁掉
        return { name, rows, styles: rectangleStyleGrid(sheet.styles, rows.length, colsOf(rows)) };
    });
    return out.length ? out : [{ name: "工作表1", rows: [], styles: [] }];
}

/**
 * 清洗并去重表名：Excel 限制 31 字符且禁用 `[]:*?/\`。
 * @param {string} raw 原始表名
 * @param {Set<string>} used 已用名集合（会被补充）
 * @returns {string} 可用表名
 */
function uniqueSheetName(raw, used) {
    let name = String(raw || "").replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "工作表";
    if (used.has(name.toLowerCase())) {
        let n = 2;
        while (used.has((name.slice(0, 28) + "(" + n + ")").toLowerCase())) n++;
        name = name.slice(0, 28) + "(" + n + ")";
    }
    used.add(name.toLowerCase());
    return name;
}

/**
 * 把任意二维数组矩形化：非字符串转字符串、缺格补 ""、行等长。
 * @param {*} grid 原始二维数组（可为 null/稀疏）
 * @returns {string[][]} 矩形网格
 */
function rectangleFromGrid(grid) {
    const raw = Array.isArray(grid) ? grid : [];
    const maxCols = raw.reduce((m, row) => Math.max(m, Array.isArray(row) ? row.length : 0), 0);
    return raw.map((row) => {
        const cells = Array.isArray(row) ? row : [];
        const out = new Array(maxCols);
        for (let c = 0; c < maxCols; c++) {
            const v = cells[c];
            out[c] = v === undefined || v === null ? "" : String(v);
        }
        return out;
    });
}

/**
 * 矩形网格的列数（空表为 0；rectangleFromGrid 已保证各行等长）。
 * @param {Array<Array<unknown>>} rows 矩形网格
 * @returns {number} 列数
 */
function colsOf(rows) {
    return rows.length ? rows[0].length : 0;
}

/**
 * 样式网格矩形化：与已矩形化的 rows **同矩形**（行列下标一一对应）。
 * 缺位、非对象（null/数字/字符串）都归一成 null，多余的行列削掉，
 * 每一项再过一遍 sanitizeStyle 把非法值规整成合法 CellStyle。
 * @param {*} grid 原始样式二维数组（可为 null/稀疏/参差）
 * @param {number} rowCount rows 的行数
 * @param {number} colCount rows 的列数
 * @returns {Array<Array<object|null>>} 规整后的样式矩形网格
 */
function rectangleStyleGrid(grid, rowCount, colCount) {
    const raw = Array.isArray(grid) ? grid : [];
    const out = [];
    for (let r = 0; r < rowCount; r++) {
        const src = Array.isArray(raw[r]) ? raw[r] : [];
        const row = new Array(colCount).fill(null);
        for (let c = 0; c < colCount; c++) row[c] = sanitizeStyle(src[c]);
        out.push(row);
    }
    return out;
}

/**
 * 规整一条单元格样式：九项字段齐全、非法值降级而不抛错。
 * 布尔项（bold/italic/underline/strike/wrap）非 true 一律 false；
 * color/fill 非 `#RRGGBB` 一律 null（大小写归一为大写）；align 不在枚举内一律 null；
 * format 非字符串 / 空串 / "General" 一律 null。
 * 全默认（等价于无格式）返回 null，省得视图区分「空对象」与「无」。
 * @param {*} raw 原始样式对象
 * @returns {object|null} 规整后的 CellStyle
 */
function sanitizeStyle(raw) {
    if (!raw || typeof raw !== "object") return null;
    const style = {
        bold: raw.bold === true,
        italic: raw.italic === true,
        underline: raw.underline === true,
        strike: raw.strike === true,
        color: normColor(raw.color),
        fill: normColor(raw.fill),
        align: normAlign(raw.align),
        wrap: raw.wrap === true,
        format: normFormat(raw.format),
    };
    return isBlankStyle(style) ? null : style;
}

/**
 * 是否等价于「无格式」（决定能不能复用 cellXfs 的 0 号默认样式）。
 * @param {*} style CellStyle 或 null
 * @returns {boolean}
 */
function isBlankStyle(style) {
    if (!style) return true;
    return !style.bold && !style.italic && !style.underline && !style.strike
        && !style.color && !style.fill && !style.align && !style.wrap && style.format === null;
}

/**
 * 颜色规整：`#RRGGBB` 原样（转大写），`red`/`#FFF`/`rgb(..)`/数字/null 都成 null。
 * @param {*} raw 原始颜色
 * @returns {string|null}
 */
function normColor(raw) {
    if (typeof raw !== "string") return null;
    const s = raw.trim();
    return HEX6_RE.test(s) ? "#" + s.slice(1).toUpperCase() : null;
}

/**
 * 水平对齐规整：只认 'left'|'center'|'right'，其余（含 'justify'/大写/非字符串）成 null。
 * @param {*} raw 原始对齐
 * @returns {string|null}
 */
function normAlign(raw) {
    return typeof raw === "string" && ALIGN_VALUES.has(raw) ? raw : null;
}

/**
 * 数字格式规整：非字符串/空串/General 都成 null（=General），其余按 trim 后的原样保留。
 * @param {*} raw 原始格式串
 * @returns {string|null}
 */
function normFormat(raw) {
    if (typeof raw !== "string") return null;
    const s = raw.trim();
    if (!s || s.toLowerCase() === "general") return null;
    return s;
}

/* ============================ 样式表写出（去重建索引） ============================ */

/**
 * 建全簿共用的样式登记簿：把每格 CellStyle 折进 fonts/fills/numFmts/cellXfs 四张表，
 * **相同样式共用一个 cellXfs 下标**（去重靠 numFmtId|fontId|fillId|align|wrap 组合键），
 * 并把下标矩阵写回 `sheet.styleIds` 供 worksheetXml 用。
 * 三条硬约束（Excel 判损坏的头号原因就是这几处不一致）：
 *   - 每张表的 count 由 stylesXml 按数组实际长度写，绝不写死；
 *   - xf 引用的 fontId/fillId 一定是刚建进集合的真实下标，numFmtId 要么是 0/契约内置值，
 *     要么在 numFmts 里有条目；
 *   - 0 号 xf 恒为默认样式，fonts[0] 恒为默认字体，fills[0]/[1] 恒为 none/gray125。
 * @param {Array<{rows: string[][], styles: Array<Array<object|null>>}>} list 已矩形化的工作表
 * @returns {{fonts: Array<object>, fills: Array<string|null>, xfs: Array<object>, customNumFmts: Array<{id: number, code: string}>}}
 */
function collectStyles(list) {
    const reg = {
        fonts: [{ bold: false, italic: false, underline: false, strike: false, color: null }],
        fontIds: new Map([["0000|", 0]]),
        fills: DEFAULT_FILL_MARKERS.slice(),
        fillIds: new Map([["", 0], ["gray125", 1]]),
        customNumFmts: [],
        customFmtIds: new Map(),
        xfs: [{ numFmtId: 0, fontId: 0, fillId: 0, align: null, wrap: false }],
        xfIds: new Map(),
    };
    reg.xfIds.set(xfKey(reg.xfs[0]), 0);
    list.forEach((sheet) => {
        sheet.styleIds = sheet.styles.map((row) => row.map((style) => styleIdOf(reg, style)));
    });
    return reg;
}

/** xf 去重键：分量都是最终写进文件的形式，键相同即整条样式相同 */
function xfKey(xf) {
    return `${xf.numFmtId}|${xf.fontId}|${xf.fillId}|${xf.align || ""}|${xf.wrap ? 1 : 0}`;
}

/** font 去重键：模型只关心四个布尔与字色（默认字体即 "0000|"，复用 0 号） */
function fontKey(style) {
    return `${style.bold ? 1 : 0}${style.italic ? 1 : 0}${style.underline ? 1 : 0}${style.strike ? 1 : 0}|${style.color || ""}`;
}

/**
 * 一条 CellStyle -> cellXfs 下标（顺带把引用的 font/fill/numFmt 建进集合）。
 * @param {object} reg 登记簿
 * @param {object|null} style 已规整的样式
 * @returns {number} cellXfs 下标
 */
function styleIdOf(reg, style) {
    if (isBlankStyle(style)) return 0; // 无格式 / 全默认：共用 0 号，不额外占位
    const xf = {
        numFmtId: numFmtIdOf(reg, style.format),
        fontId: fontIdOf(reg, style),
        fillId: fillIdOf(reg, style.fill),
        align: style.align,
        wrap: style.wrap,
    };
    const key = xfKey(xf);
    if (!reg.xfIds.has(key)) {
        reg.xfIds.set(key, reg.xfs.length);
        reg.xfs.push(xf);
    }
    return reg.xfIds.get(key);
}

/**
 * 字体登记：默认字体（全 false 无字色）复用 0 号，其余按内容去重后追加。
 * @param {object} reg 登记簿
 * @param {object} style CellStyle
 * @returns {number} fonts 下标
 */
function fontIdOf(reg, style) {
    const key = fontKey(style);
    if (reg.fontIds.has(key)) return reg.fontIds.get(key);
    const id = reg.fonts.length;
    reg.fonts.push({
        bold: style.bold,
        italic: style.italic,
        underline: style.underline,
        strike: style.strike,
        color: style.color,
    });
    reg.fontIds.set(key, id);
    return id;
}

/**
 * 填充登记：null -> 0（none），具体颜色按值去重追加（1 号 gray125 留给 Excel 惯例）。
 * @param {object} reg 登记簿
 * @param {string|null} color `#RRGGBB` 或 null
 * @returns {number} fills 下标
 */
function fillIdOf(reg, color) {
    const key = color || "";
    if (reg.fillIds.has(key)) return reg.fillIds.get(key);
    const id = reg.fills.length;
    reg.fills.push(color);
    reg.fillIds.set(key, id);
    return id;
}

/**
 * 数字格式 -> numFmtId：General 走 0，契约表内的走标准内置编号，
 * 其余（如 `0.0`、`0.000`、`@@文本@@`）才追加自定义条目，编号从 164 起。
 * @param {object} reg 登记簿
 * @param {string|null} code 格式串
 * @returns {number} numFmtId
 */
function numFmtIdOf(reg, code) {
    if (!code) return 0;
    if (FMT_ID.has(code)) return FMT_ID.get(code);
    if (!reg.customFmtIds.has(code)) {
        reg.customFmtIds.set(code, CUSTOM_FMT_FIRST_ID + reg.customNumFmts.length);
        reg.customNumFmts.push({ id: CUSTOM_FMT_FIRST_ID + reg.customNumFmts.length, code });
    }
    return reg.customFmtIds.get(code);
}
/**
 * 生成 `[Content_Types].xml`。
 * @param {Array<{part: string, type: string}>} overrides Override 列表
 * @returns {string} XML 文本
 */
function contentTypesXml(overrides) {
    const body = overrides.map((o) => `<Override PartName="${escapeXml(o.part)}" ContentType="${escapeXml(o.type)}"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="${CT_REL}"/><Default Extension="xml" ContentType="${CT_XML}"/>${body}</Types>`;
}

/**
 * 生成根关系 `_rels/.rels`：只指向 workbook 与两个 docProps。
 * @returns {string} XML 文本
 */
function rootRelsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${NS_REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`;
}

/**
 * 生成 `xl/_rels/workbook.xml.rels`：每个 worksheet 一条 + styles 一条。
 * @param {number} count 工作表数量
 * @returns {string} XML 文本
 */
function workbookRelsXml(count) {
    const items = [];
    for (let i = 1; i <= count; i++) {
        items.push(`<Relationship Id="rId${i}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i}.xml"/>`);
    }
    items.push(`<Relationship Id="rId${count + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>`);
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_PKG_REL}">${items.join("")}</Relationships>`;
}

/**
 * 生成 `xl/workbook.xml`。
 * @param {Array<{name: string, rows: string[][]}>} list 工作表列表
 * @returns {string} XML 文本
 */
function workbookXml(list) {
    const sheets = list
        .map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>${sheets}</sheets></workbook>`;
}

/**
 * 生成 `xl/styles.xml`：numFmts/fonts/fills/borders/cellStyleXfs/cellXfs/cellStyles/dxfs
 * 按 schema 顺序排布，**每个 count 都取对应数组的实际长度**（写死数字与数组不一致是 Excel
 * 判损坏的头号原因）。没有自定义数字格式时整段省掉 numFmts。
 * @param {{fonts: Array<object>, fills: Array<string|null>, xfs: Array<object>, customNumFmts: Array<{id: number, code: string}>}} reg 样式登记簿
 * @returns {string} XML 文本
 */
function stylesXml(reg) {
    const numFmts = reg.customNumFmts.length
        ? `<numFmts count="${reg.customNumFmts.length}">${reg.customNumFmts.map((f) => `<numFmt numFmtId="${f.id}" formatCode="${escapeXml(f.code)}"/>`).join("")}</numFmts>`
        : "";
    const fonts = `<fonts count="${reg.fonts.length}">${reg.fonts.map(fontXml).join("")}</fonts>`;
    const fills = `<fills count="${reg.fills.length}">${reg.fills.map(fillXml).join("")}</fills>`;
    const borders = '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>';
    const cellStyleXfs = '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>';
    const cellXfs = `<cellXfs count="${reg.xfs.length}">${reg.xfs.map(xfXml).join("")}</cellXfs>`;
    const cellStyles = '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS_MAIN}">${numFmts}${fonts}${fills}${borders}${cellStyleXfs}${cellXfs}${cellStyles}<dxfs count="0"/></styleSheet>`;
}

/**
 * 一条字体记录。子元素顺序按 CT_Font 的序列（b i strike u sz color name family），
 * 顺序错了严格校验器会报错；字号/字体名固定 Calibri 11（模型里没有这两项）。
 * @param {{bold: boolean, italic: boolean, underline: boolean, strike: boolean, color: string|null}} font 字体
 * @returns {string} XML 片段
 */
function fontXml(font) {
    const parts = [];
    if (font.bold) parts.push("<b/>");
    if (font.italic) parts.push("<i/>");
    if (font.strike) parts.push("<strike/>");
    if (font.underline) parts.push('<u val="single"/>');
    parts.push('<sz val="11"/>');
    // 默认字体保留 theme="1"（Excel 自己的写法），有字色时写 ARGB
    parts.push(font.color ? `<color rgb="FF${font.color.slice(1)}"/>` : '<color theme="1"/>');
    parts.push('<name val="Calibri"/>');
    parts.push('<family val="2"/>');
    return `<font>${parts.join("")}</font>`;
}

/**
 * 一条填充记录：null 走 patternType="none"，登记簿的 1 号保留 Excel 惯例的 gray125，
 * 其余按实心填充写 fgColor（bgColor 用 indexed=64，Excel 自己的写法）。
 * @param {string|null} color 填充色或 null/"gray125"
 * @returns {string} XML 片段
 */
function fillXml(color) {
    if (color === "gray125") return '<fill><patternFill patternType="gray125"/></fill>';
    if (!color) return '<fill><patternFill patternType="none"/></fill>';
    return `<fill><patternFill patternType="solid"><fgColor rgb="FF${color.slice(1)}"/><bgColor indexed="64"/></patternFill></fill>`;
}

/**
 * 一条 cellXfs 记录：引用都已经在 collectStyles 里建好，applyFont/applyFill/
 * applyNumberFormat/applyAlignment 只在真的偏离默认时打开（Excel 靠这几个开关决定是否套用，
 * 不写会因为 xfId=0 的样式而忽略字体/填充）。
 * @param {{numFmtId: number, fontId: number, fillId: number, align: string|null, wrap: boolean}} xf 样式
 * @returns {string} XML 片段
 */
function xfXml(xf) {
    const attrs = [`numFmtId="${xf.numFmtId}"`, `fontId="${xf.fontId}"`, `fillId="${xf.fillId}"`, 'borderId="0"', 'xfId="0"'];
    if (xf.fontId > 0) attrs.push('applyFont="1"');
    if (xf.fillId > 0) attrs.push('applyFill="1"');
    if (xf.numFmtId > 0) attrs.push('applyNumberFormat="1"');
    const alignment = alignmentXml(xf);
    if (!alignment) return `<xf ${attrs.join(" ")}/>`;
    attrs.push('applyAlignment="1"');
    return `<xf ${attrs.join(" ")}>${alignment}</xf>`;
}

/**
 * `<xf>` 的内联对齐子元素：模型只有水平对齐与自动换行两项，都没有就不产出。
 * @param {{align: string|null, wrap: boolean}} xf 样式
 * @returns {string} XML 片段或空串
 */
function alignmentXml(xf) {
    const attrs = [];
    if (xf.align) attrs.push(`horizontal="${xf.align}"`);
    if (xf.wrap) attrs.push('wrapText="1"');
    return attrs.length ? `<alignment ${attrs.join(" ")}/>` : "";
}

/**
 * 生成 `docProps/core.xml`（创建/修改时间用当前 UTC，去掉毫秒）。
 * @returns {string} XML 文本
 */
function coreXml() {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const author = "Deskly Office";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>电子表格</dc:title><dc:creator>${escapeXml(author)}</dc:creator><cp:lastModifiedBy>${escapeXml(author)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}

/**
 * 生成 `docProps/app.xml`（Applications 里登记各表名，Excel 校验 HeadingPairs/TitlesOfParts 成对）。
 * @param {Array<{name: string}>} list 工作表列表
 * @returns {string} XML 文本
 */
function appXml(list) {
    const titles = list.map((s) => `<vt:lpstr>${escapeXml(s.name)}</vt:lpstr>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Deskly Office</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${list.length}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${list.length}" baseType="lpstr">${titles}</vt:vector></TitlesOfParts><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0300</AppVersion></Properties>`;
}

/**
 * 生成一个 worksheet 部件：dimension 与实际写出的数据范围一致，
 * 每格带上 `s`（cellXfs 下标，0 号默认样式省略不写）。
 * @param {{name: string, rows: string[][], styleIds?: number[][]}} sheet 工作表（styleIds 由 collectStyles 补齐）
 * @returns {string} XML 文本
 */
function worksheetXml(sheet) {
    const rows = sheet.rows;
    const ids = sheet.styleIds || [];
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const dimension = rows.length && maxCols ? `A1:${colLetter(maxCols)}${rows.length}` : "A1";
    const body = rows
        .map((row, r) => {
            const idRow = ids[r] || [];
            const cells = row.map((value, c) => cellXml(`${colLetter(c + 1)}${r + 1}`, value, idRow[c] || 0)).join("");
            return `<row r="${r + 1}" spans="1:${Math.max(row.length, 1)}">${cells}</row>`;
        })
        .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="14.4"/><sheetData>${body}</sheetData></worksheet>`;
}

/**
 * 生成一个单元格：值以 `=` 开头走公式，纯数字走数值单元格，空串写成自闭合 `<c/>`（回读为 ""），
 * 其余走 `t="inlineStr"` 并保留首尾空格。
 * @param {string} ref 单元格地址
 * @param {string} value 文本值
 * @param {number} styleId cellXfs 下标（0 表示默认样式，省略 `s` 属性）
 * @returns {string} XML 片段
 */
function cellXml(ref, value, styleId) {
    const s = String(value === undefined || value === null ? "" : value);
    const st = styleId > 0 ? ` s="${styleId}"` : "";
    if (s === "") return `<c r="${ref}"${st}/>`;
    if (s.startsWith("=")) return formulaCellXml(ref, s, st);
    if (NUM_RE.test(s)) return `<c r="${ref}"${st}><v>${escapeXml(s)}</v></c>`;
    return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${escapeXml(s)}</t></is></c>`;
}

/**
 * 公式单元格：`<f>公式</f><v>缓存值</v>`。
 * 本模块不求值（求值在视图层），所以缓存值未知，按占位 0 写出：
 * 只写 `<f>` 不写 `<v>` 时 Excel 打开后在重算前是空白，写 `<v>0</v>` 最省事也最安全；
 * 回读时见到「`<f>` + 占位 0」会还原成 `=公式`，故自己的文件能安全往返。
 * 只输入了一个 `=`（公式为空）时不产出空 `<f>`——那会让 Excel 判文件损坏，按原文当文本写。
 * @param {string} ref 单元格地址
 * @param {string} raw 以 `=` 开头的原始值
 * @param {string} st 样式属性片段（` s="n"` 或空串）
 * @returns {string} XML 片段
 */
function formulaCellXml(ref, raw, st) {
    const expr = raw.slice(1).trim();
    if (!expr) {
        return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${escapeXml(raw)}</t></is></c>`;
    }
    return `<c r="${ref}"${st}><f>${escapeXml(expr)}</f><v>0</v></c>`;
}

/* ============================ csv ============================ */

/**
 * CSV 单字段转义。
 * @param {*} value 原始值
 * @returns {string} 可安全拼接的字段文本
 */
function csvField(value) {
    const s = String(value === undefined || value === null ? "" : value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV 词法扫描：逐字符状态机，支持引号内逗号/换行与 `""` 转义。
 * @param {string} text CSV 文本（可含 BOM）
 * @returns {string[][]} 二维数组（可能非矩形，交给 rectangleFromGrid 收尾）
 */
function csvGrid(text) {
    const src = String(text || "").replace(/^\uFEFF/, "");
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let touched = false; // 当前行是否真的出现过内容（区分「末尾换行」与「空行」）

    const endField = () => { row.push(field); field = ""; };
    const endRow = () => { endField(); rows.push(row); row = []; touched = false; };

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += ch;
            continue;
        }
        if (ch === '"' && field === "") { inQuotes = true; touched = true; continue; }
        if (ch === ",") { endField(); touched = true; continue; }
        if (ch === "\r") {
            if (src[i + 1] === "\n") i++;
            endRow();
            continue;
        }
        if (ch === "\n") { endRow(); continue; }
        field += ch;
        touched = true;
    }
    // 末尾有内容才补最后一行；纯尾随换行不产生空行
    if (inQuotes) { endField(); rows.push(row); }
    else if (touched || field !== "" || row.length) endRow();
    // 「末尾空行不产生空行」：文末只有一个空字段的行一律削掉（中间的空白行保留）
    while (rows.length && rows[rows.length - 1].length <= 1 && rows[rows.length - 1][0] === "") rows.pop();
    return rows;
}
