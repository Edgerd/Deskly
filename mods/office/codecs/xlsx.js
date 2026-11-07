/**
 * xlsx.js — 电子表格编解码（.xlsx 读写 + .csv 读写）。
 * 只依赖同目录的 `xml.js` 与 `zip.js`，不碰 DOM，浏览器和 Node 都能跑
 * （Node 里跑才能做「生成 → 回读」的结构自校验）。
 *
 * 数据契约（UI 层依赖，勿改签名）：
 *   Sheet     = { name: string, rows: string[][], styles: CellStyle[][], images: ImageItem[],
 *                 filter: {col: number, value: string} | null, widths: number[] | null,
 *                 heights: number[] | null,                          // 行高 pt（索引=行，0/缺省=默认，null=全默认）
 *                 freeze: { row: boolean, col: boolean },             // 冻结首行 / 首列（落进 <pane>）
 *                 merges: [r1, c1, r2, c2][] }                        // 合并区（0 基闭区间，最多 200 区）
 *   ImageItem = { src: string, width: number, height: number }   // src 是 data URL，宽高是 px（96dpi）
 *   CellStyle = { bold, italic, underline, strike, color, fill, align, wrap, format,
 *                 font: string | null, fontSize: number | null } | null   // font=字体名，fontSize=pt（1..400）
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
 *   - 图片只支持 png/jpg/jpeg/gif/webp：每张表一组 `xl/drawings/drawingK.xml` + media，
 *     读取时只按 blip 与 `xdr:ext` 还原 src/宽高；锚点位置/裁剪/旋转/链接图片都不建模，
 *     回写一律落在 A1 附近的 `oneCellAnchor`（已知降级）。
 *   - 字体只搬 `<font>` 的 name/sz，主题字体（theme 属性）/family/charset 忽略；读回时
 *     Calibri + 11pt 视为「继承默认」（null），其余值原样回读，保证自己的包往返一致。
 *   - 合并区只写结构不搬内容：被覆盖格子的原文照旧保存（Excel 打开时同样只显示左上格）。
 *   - 行高只认 `@ht` + `@customHeight`，且限制 12..200 pt；其它（自动行高、隐藏行）不建模。
 */

import { escapeXml, parseXml, children, allText, findAll, localNameOf, firstChild } from "./xml.js";
import { unzipPackage, zipParts } from "./zip.js";

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

/** 行高模型边界（pt）：与视图层「行高 + / -」命令同一口径 */
const HEIGHT_MIN_PT = 12;
const HEIGHT_MAX_PT = 200;
/** 字号模型边界（pt） */
const FONT_SIZE_MIN_PT = 1;
const FONT_SIZE_MAX_PT = 400;
/** 合并区数量上限（先到先得，超出丢弃） */
const MERGE_MAX = 200;
/** 无字体 / 字号格式的格子沿用这套默认字体记录（读回时视为 null=继承） */
const DEFAULT_FONT_NAME = "Calibri";
const DEFAULT_FONT_SIZE_PT = 11;

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
const CT_DRAWING = "application/vnd.openxmlformats-officedocument.drawing+xml";

/** 1px = 9525 EMU（96dpi） */
const EMU_PER_PX = 9525;
/** 图片扩展名 -> MIME（只支持这五种，svg 不插入） */
const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** 图片缺失尺寸时的兜底（px），与视图层插入图片的兜底一致 */
const IMAGE_FALLBACK_W = 200;
const IMAGE_FALLBACK_H = 150;
/** drawing 命名空间（spreadsheetDrawing 与 DrawingML 主命名空间） */
const NS_XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";

/* 对外 API */

/**
 * 造一个空白工作表。
 * @param {string} name 表名
 * @returns {{name: string, rows: string[][], styles: Array<Array<object|null>>, images: object[], filter: null, widths: null, heights: null, freeze: {row: boolean, col: boolean}, merges: array}} 1x1 空格子、无格式、无筛选与自定义列宽的工作表
 */
export function emptySheet(name = "工作表1") {
    return {
        name, rows: [[""]], styles: [[null]], images: [],
        filter: null, widths: null, heights: null,
        freeze: { row: false, col: false }, merges: [],
    };
}

/**
 * 解析 .xlsx 字节，取出全部工作表（顺序与 workbook.xml 一致）。
 * styles 与 rows 同矩形；无样式部件 / `s` 缺失或越界的格子给 null。
 * @param {ArrayBuffer|Uint8Array} bytes .xlsx 文件字节
 * @returns {Promise<{sheets: Array<{name: string, rows: string[][], styles: Array<Array<object|null>>, images: object[]}>}>}
 * @throws {Error} 中文错误：不是 zip 包 / 缺 workbook.xml
 */
export async function parseXlsx(bytes) {
    let parts;
    try {
        parts = await unzipPackage(bytes);
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
        const found = resolveSheetPart(parts, index, rels, node, i);
        // 部件找不到时给空表而不是炸：真实产物里偶有悬空引用，表格能开比报错有用
        if (found == null) sheets.push(emptySheet(name));
        else {
            sheets.push(Object.assign({ name }, readSheet(found.text, shared, xfs), {
                images: readSheetImages(parts, index, found.path, found.text),
            }));
        }
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
    const media = collectSheetImages(list);
    const parts = {};
    const overrides = [
        { part: "/xl/workbook.xml", type: CT_SHEET },
        ...list.map((_, i) => ({ part: `/xl/worksheets/sheet${i + 1}.xml`, type: CT_WORKSHEET })),
        { part: "/xl/styles.xml", type: CT_STYLES },
        { part: "/docProps/core.xml", type: CT_CORE },
        { part: "/docProps/app.xml", type: CT_APP },
        ...media.drawings.map((d) => ({ part: `/xl/drawings/drawing${d.k}.xml`, type: CT_DRAWING })),
    ];

    parts["[Content_Types].xml"] = contentTypesXml(media.entries, overrides);
    parts["_rels/.rels"] = rootRelsXml();
    parts["xl/workbook.xml"] = workbookXml(list);
    parts["xl/_rels/workbook.xml.rels"] = workbookRelsXml(list.length);
    parts["xl/styles.xml"] = stylesXml(reg);
    parts["docProps/core.xml"] = coreXml();
    parts["docProps/app.xml"] = appXml(list);
    const drawingOf = new Map(media.drawings.map((d) => [d.sheet, d]));
    list.forEach((sheet, i) => {
        const drawing = drawingOf.get(i);
        parts[`xl/worksheets/sheet${i + 1}.xml`] = worksheetXml(sheet, Boolean(drawing));
        if (drawing) {
            parts[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`] = sheetDrawingRelsXml(drawing.k);
        }
    });
    // 图片部件与 drawing 只在有图时写，无图工作簿的包结构保持原样
    for (const entry of media.entries) parts[entry.path] = { base64: entry.base64 };
    for (const drawing of media.drawings) {
        parts[`xl/drawings/drawing${drawing.k}.xml`] = sheetDrawingXml(drawing.refs);
        parts[`xl/drawings/_rels/drawing${drawing.k}.xml.rels`] = drawingRelsXml(drawing.refs);
    }
    return zipParts(parts);
}

/**
 * 收集各表图片：按 src 去重（跨表共用 media 部件），给每张有图的表分配 drawing 序号。
 * 非法 data URL 的图片被丢弃，不写 media / drawing。
 * @param {object[]} list 已规整的工作表
 * @returns {{entries: Array<{src: string, path: string, ext: string, base64: string}>, drawings: Array<{sheet: number, k: number, refs: object[]}>}}
 */
function collectSheetImages(list) {
    const entries = [];
    const bySrc = new Map();
    const drawings = [];
    list.forEach((sheet, i) => {
        if (!sheet.images.length) return;
        const refs = [];
        for (const img of sheet.images) {
            const info = dataUrlImage(img.src);
            if (!info) continue;
            let entry = bySrc.get(img.src);
            if (!entry) {
                entry = {
                    src: img.src,
                    path: `xl/media/image${entries.length + 1}.${info.ext}`,
                    ext: info.ext,
                    base64: info.base64,
                };
                entries.push(entry);
                bySrc.set(img.src, entry);
            }
            refs.push({ entry, width: img.width, height: img.height });
        }
        if (!refs.length) return;
        drawings.push({ sheet: i, k: drawings.length + 1, refs });
    });
    return { entries, drawings };
}

/**
 * 规整单张图片项：src 非 data URL 时丢弃（返回 null），宽高非正数用兜底值。
 * @param {object} raw 原始图片项
 * @returns {{src: string, width: number, height: number}|null}
 */
function normalizeImage(raw) {
    const img = raw || {};
    const src = typeof img.src === "string" ? img.src.trim() : "";
    if (!dataUrlImage(src)) return null;
    return { src, width: normImagePx(img.width, IMAGE_FALLBACK_W), height: normImagePx(img.height, IMAGE_FALLBACK_H) };
}

/**
 * 规整图片数组：去坏项、缺省给 []（旧文档无 images 字段也能安全加载）。
 * @param {unknown} list 原始数组
 * @returns {Array<{src: string, width: number, height: number}>}
 */
function normalizeImages(list) {
    if (!Array.isArray(list)) return [];
    return list.map(normalizeImage).filter(Boolean);
}

/**
 * 图片像素尺寸：非数字/非正数用兜底值，其余四舍五入成整数 px。
 * @param {unknown} value 原始值
 * @param {number} fallback 兜底 px
 * @returns {number}
 */
function normImagePx(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
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
 * 解析 CSV 文本（RFC4180 子集：只认逗号分隔）。
 * 支持引号包裹、引号内的逗号/换行/`""` 转义、`\r\n`/`\n`/`\r`；文首 BOM 剥掉，
 * 文末连续的空行不产生空行（中间的空白行保留）。
 * 注意：`["a",""]` 这类**含逗号**的行能安全往返；只有「整行没有任何内容」的尾行会被削掉。
 * csv 不带样式，但 styles 仍给出与 rows 同矩形的 null（视图层按下标取值，缺位会崩）。
 * @param {string} text CSV 文本
 * @returns {Array<{name: string, rows: string[][], styles: Array<Array<object|null>>, images: object[], filter: null, widths: null, heights: null, freeze: {row: boolean, col: boolean}, merges: array}>} 单元素数组
 */
export function parseCsv(text) {
    const rows = rectangleFromGrid(csvGrid(text));
    return [{
        name: "工作表1", rows, styles: rectangleStyleGrid(null, rows.length, colsOf(rows)), images: [],
        filter: null, widths: null, heights: null, freeze: { row: false, col: false }, merges: [],
    }];
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

/* xlsx 读取 */

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
function resolveSheetPart(parts, index, rels, node, i) {
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
        if (text != null) return { text, path: index.get(cand.toLowerCase()) || cand };
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
 * @returns {{rows: string[][], styles: Array<Array<object|null>>, filter: object|null, widths: number[]|null, heights: number[]|null, freeze: {row: boolean, col: boolean}, merges: Array<[number, number, number, number]>}} 同矩形的值网格与样式网格 + 自动筛选 + 自定义列宽 + 行高 + 冻结 + 合并区
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
    const freeze = readFreeze(root);
    if (maxRow === 0 || maxCol === 0) {
        return { rows, styles, filter: readAutoFilter(root), widths: readColWidths(root), heights: null, freeze, merges: [] };
    }
    for (let r = 0; r < maxRow; r++) {
        rows.push(new Array(maxCol).fill(""));
        styles.push(new Array(maxCol).fill(null));
    }
    for (const cell of grid) {
        rows[cell.row - 1][cell.col - 1] = cell.value;
        styles[cell.row - 1][cell.col - 1] = cell.style;
    }
    return {
        rows,
        styles,
        filter: readAutoFilter(root),
        widths: readColWidths(root),
        heights: readRowHeights(root, maxRow),
        freeze,
        merges: readMerges(root, maxRow, maxCol),
    };
}

/**
 * 读行高：只认 `<row @ht @customHeight>` 且 pt 落在 12..200（取整），其余丢弃；
 * 数组索引 = 行号，0 = 默认，没有任何自定义行高时返回 null。
 * @param {object|null} root worksheet 根节点
 * @param {number} rowCount 数据行数（行高数组按它对齐）
 * @returns {number[]|null}
 */
function readRowHeights(root, rowCount) {
    const sheetData = firstChild(root, "sheetData");
    if (!sheetData || rowCount <= 0) return null;
    const out = new Array(rowCount).fill(0);
    let any = false;
    kids(sheetData, "row").forEach((node, i) => {
        if (!isOn(node.attrs.customHeight)) return;
        const rAttr = parseInt(node.attrs.r, 10);
        const rowNum = Number.isFinite(rAttr) && rAttr > 0 ? rAttr : i + 1;
        if (rowNum > rowCount) return;
        const ht = Number(node.attrs.ht);
        if (!Number.isFinite(ht)) return;
        const pt = Math.round(ht);
        if (pt < HEIGHT_MIN_PT || pt > HEIGHT_MAX_PT) return;
        out[rowNum - 1] = pt;
        any = true;
    });
    return any ? out : null;
}

/**
 * 读冻结：`<sheetViews><sheetView><pane xSplit / ySplit>` 是否 > 0，其它属性忽略。
 * @param {object|null} root worksheet 根节点
 * @returns {{row: boolean, col: boolean}}
 */
function readFreeze(root) {
    const views = firstChild(root, "sheetViews");
    const view = views ? firstChild(views, "sheetView") : null;
    const pane = view ? firstChild(view, "pane") : null;
    if (!pane) return { row: false, col: false };
    const x = Number(pane.attrs.xSplit);
    const y = Number(pane.attrs.ySplit);
    return { row: Number.isFinite(y) && y > 0, col: Number.isFinite(x) && x > 0 };
}

/**
 * 读合并区：`<mergeCells><mergeCell ref="A1:B2">` → 0 基闭区间，再按数据矩形做
 * 非法 / 单格 / 越界 / 重叠（先到先得）与 200 区上限的规整。
 * @param {object|null} root worksheet 根节点
 * @param {number} rowCount 数据行数
 * @param {number} colCount 数据列数
 * @returns {Array<[number, number, number, number]>}
 */
function readMerges(root, rowCount, colCount) {
    const box = firstChild(root, "mergeCells");
    if (!box) return [];
    const list = [];
    for (const node of kids(box, "mergeCell")) {
        const range = parseMergeRef(node.attrs.ref);
        if (range) list.push(range);
    }
    return normMerges(list, rowCount, colCount);
}

/**
 * `A1:B2` → `[r1, c1, r2, c2]`（0 基，允许单格写法；非法返回 null）。
 * @param {string} ref 合并区 ref
 * @returns {[number, number, number, number]|null}
 */
function parseMergeRef(ref) {
    const m = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(String(ref || "").trim());
    if (!m) return null;
    const c1 = colFromRef(m[1]) - 1;
    const r1 = parseInt(m[2], 10) - 1;
    const c2 = m[3] ? colFromRef(m[3]) - 1 : c1;
    const r2 = m[4] ? parseInt(m[4], 10) - 1 : r1;
    if (c1 < 0 || c2 < 0 || !(r1 >= 0) || !(r2 >= 0)) return null;
    return [r1, c1, r2, c2];
}

/**
 * 读 `<autoFilter>`：只认第一条 `filterColumn/customFilters/customFilter` 且 `operator="equal"`；
 * `colId` 在 OOXML 里就是 0 起列号，与模型列号一致。其它运算符/结构一律返回 null。
 * @param {object|null} root worksheet 根节点
 * @returns {{col: number, value: string}|null} 筛选条件
 */
function readAutoFilter(root) {
    const autoFilter = firstChild(root, "autoFilter");
    if (!autoFilter) return null;
    const column = firstChild(autoFilter, "filterColumn");
    if (!column) return null;
    const col = parseInt(attrByLocal(column, ["colid"]), 10);
    if (!Number.isFinite(col) || col < 0) return null;
    const custom = firstChild(column, "customFilters", "customFilter");
    if (!custom) return null;
    const operator = String(attrByLocal(custom, ["operator"]) || "equal").toLowerCase();
    if (operator !== "equal") return null;
    return { col, value: String(attrByLocal(custom, ["val"]) || "") };
}

/**
 * 读 `<cols>` 下的 `<col>`：`min/max` 是 1 起列号，按 `min-1` 索引铺开，长度取出现的最大列；
 * 未声明或宽度非法（非正数）的列保留 0（= 默认列宽）。
 * @param {object|null} root worksheet 根节点
 * @returns {number[]|null} 列宽数组（字符宽，0 表示默认）；没有任何 col 时 null
 */
function readColWidths(root) {
    const cols = firstChild(root, "cols");
    if (!cols) return null;
    const entries = kids(cols, "col");
    if (!entries.length) return null;
    let maxCol = 0;
    const rows = [];
    for (const node of entries) {
        const min = parseInt(node.attrs.min, 10);
        const max = parseInt(node.attrs.max !== undefined ? node.attrs.max : node.attrs.min, 10);
        const width = Number(node.attrs.width);
        if (!Number.isFinite(min) || min < 1) continue;
        const end = Number.isFinite(max) && max >= min ? max : min;
        if (!Number.isFinite(width) || width <= 0) continue;
        for (let col = min - 1; col < end; col++) rows[col] = Math.round(width * 10) / 10;
        maxCol = Math.max(maxCol, end);
    }
    if (!maxCol) return null;
    const out = new Array(maxCol).fill(0);
    for (let i = 0; i < maxCol; i++) if (rows[i]) out[i] = rows[i];
    return out;
}

/**
 * 读一张表里的图片：worksheet 的 `<drawing>` -> worksheet rels -> drawing 部件 ->
 * 每个 anchor 的 `a:blip r:embed` -> drawing rels -> media 二进制 -> data URL + `xdr:ext` 尺寸。
 * 悬空关系、缺部件、非支持格式一律跳过；只认 oneCellAnchor/twoCellAnchor/absoluteAnchor。
 * @param {Map} parts 部件表
 * @param {Map<string, string>} index 小写路径索引
 * @param {string} partPath worksheet 实际部件路径
 * @param {string} text worksheet XML 文本
 * @returns {Array<{src: string, width: number, height: number}>} 图片项
 */
function readSheetImages(parts, index, partPath, text) {
    const root = parseXml(text);
    const drawingNode = root ? firstChild(root, "drawing") : null;
    if (!drawingNode) return [];
    const rid = attrByLocal(drawingNode, ["id", "relid", "relationshipid"]);
    if (!rid) return [];

    const sheetRels = readRels(pickPart(parts, index, relsPathOf(partPath)), relsPathOf(partPath));
    const rel = sheetRels.get(rid);
    if (!rel || rel.external) return [];
    const drawingPath = findRelatedPart(parts, index, rel.target, relsPathOf(partPath));
    if (!drawingPath) return [];
    const drawingRoot = parseXml(pickPart(parts, index, drawingPath));
    if (!drawingRoot) return [];

    const drawingRels = readRels(pickPart(parts, index, relsPathOf(drawingPath)), relsPathOf(drawingPath));
    const out = [];
    for (const child of children(drawingRoot)) {
        const ln = localNameOf(child);
        if (ln !== "oneCellAnchor" && ln !== "twoCellAnchor" && ln !== "absoluteAnchor") continue;
        const blip = findAll(child, "blip")[0];
        if (!blip) continue;
        const embed = attrByLocal(blip, ["embed", "link"]);
        const imgRel = embed ? drawingRels.get(embed) : null;
        if (!imgRel || imgRel.external) continue;
        const mediaPath = findRelatedPart(parts, index, imgRel.target, relsPathOf(drawingPath));
        const base64 = mediaPath ? binaryAt(parts, index, mediaPath) : null;
        const ext = mediaPath ? imageExtOf(mediaPath) : "";
        const mime = IMAGE_MIME[ext];
        if (!base64 || !mime) continue;
        const extNode = firstChild(child, "ext");
        out.push(normalizeImage({
            src: `data:${mime};base64,${base64}`,
            width: emuToPx(extNode ? extNode.attrs.cx : null, IMAGE_FALLBACK_W),
            height: emuToPx(extNode ? extNode.attrs.cy : null, IMAGE_FALLBACK_H),
        }));
    }
    return out;
}

/**
 * 关系 Target -> 实际部件路径（优先按 Target 解析，其次按尾段搜）。
 * @param {Map} parts 部件表
 * @param {Map<string, string>} index 小写路径索引
 * @param {string} target 关系 Target
 * @param {string} relsPath 关系所在 rels 部件路径（定位基准）
 * @returns {string|null} 部件实际路径
 */
function findRelatedPart(parts, index, target, relsPath) {
    const candidates = targetCandidates(target, relsPath);
    findBySuffix(index, targetSuffix(target)).forEach((p) => candidates.push(p));
    for (const cand of candidates) {
        if (pickPart(parts, index, cand) != null || binaryAt(parts, index, cand)) {
            return index.get(cand.toLowerCase()) || cand;
        }
    }
    return null;
}

/**
 * 部件路径对应的 rels 路径：`a/b/c.xml` -> `a/b/_rels/c.xml.rels`。
 * @param {string} path 部件路径
 * @returns {string} rels 路径
 */
function relsPathOf(path) {
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "" : path.slice(0, slash + 1);
    const name = slash === -1 ? path : path.slice(slash + 1);
    return `${dir}_rels/${name}.rels`;
}

/**
 * 按包内路径取图片 base64（大小写不敏感）。
 * @param {Map} parts 部件表
 * @param {Map<string, string>} index 小写路径索引
 * @param {string} path 期望路径
 * @returns {string|null} base64
 */
function binaryAt(parts, index, path) {
    const real = index.get(String(path).toLowerCase());
    const value = real === undefined ? null : parts.get(real);
    return value && typeof value === "object" && typeof value.base64 === "string" ? value.base64 : null;
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

/* 样式表读取（xl/styles.xml） */

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
 * @returns {{bold: boolean, italic: boolean, underline: boolean, strike: boolean, color: string|null, font: string|null, fontSize: number|null}}
 */
function readFontRecord(node) {
    const nameNode = firstChild(node, "name");
    const sizeNode = firstChild(node, "sz");
    const rawName = nameNode && typeof nameNode.attrs.val === "string" ? nameNode.attrs.val.trim() : "";
    const rawSize = sizeNode ? Number(sizeNode.attrs.val) : NaN;
    return {
        bold: onFlag(node, "b"),
        italic: onFlag(node, "i"),
        strike: onFlag(node, "strike"),
        underline: underlined(node),
        color: colorOf(firstChild(node, "color")),
        font: rawName || null,
        fontSize: Number.isFinite(rawSize) && rawSize >= FONT_SIZE_MIN_PT && rawSize <= FONT_SIZE_MAX_PT
            ? Math.round(rawSize * 10) / 10
            : null,
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
        font: inheritedFontName(font),
        fontSize: inheritedFontSize(font),
    });
}

/**
 * 字体名回读口径：包的默认字体（Calibri）视为「继承」（null），其余原样返回 ——
 * 刚好抵消「无字体格式的 font 记录也写着 Calibri」，保证自己的包往返一致。
 * @param {object|undefined} font fonts 集合里的记录
 * @returns {string|null}
 */
function inheritedFontName(font) {
    const name = font && typeof font.font === "string" ? font.font : "";
    if (!name) return null;
    return name.toLowerCase() === DEFAULT_FONT_NAME.toLowerCase() ? null : name;
}

/**
 * 字号回读口径：11pt（包的默认字号）视为「继承」（null），其余原样返回。
 * @param {object|undefined} font fonts 集合里的记录
 * @returns {number|null}
 */
function inheritedFontSize(font) {
    const size = font && typeof font.fontSize === "number" ? font.fontSize : null;
    return size === DEFAULT_FONT_SIZE_PT ? null : size;
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

/* xlsx 写出 */

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
        return {
            name,
            rows,
            styles: rectangleStyleGrid(sheet.styles, rows.length, colsOf(rows)),
            images: normalizeImages(sheet.images),
            filter: normFilter(sheet.filter),
            widths: normWidths(sheet.widths),
            heights: normHeights(sheet.heights),
            freeze: normFreeze(sheet.freeze),
            merges: normMerges(sheet.merges, rows.length, colsOf(rows)),
        };
    });
    return out.length ? out : [{
        name: "工作表1", rows: [], styles: [], images: [],
        filter: null, widths: null, heights: null, freeze: { row: false, col: false }, merges: [],
    }];
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
        font: normFontName(raw.font),
        fontSize: normFontSize(raw.fontSize),
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
        && !style.color && !style.fill && !style.align && !style.wrap && style.format === null
        && !style.font && style.fontSize === null;
}

/**
 * 字体名规整：非字符串 / 空白 → null（= 继承默认），有效名去首尾空格并截到 64 字符。
 * @param {*} raw 原始字体名
 * @returns {string|null}
 */
function normFontName(raw) {
    if (typeof raw !== "string") return null;
    const s = raw.trim();
    return s ? s.slice(0, 64) : null;
}

/**
 * 字号规整：数字且落在 1..400 pt 内，保留一位小数；其余（字符串 / 越界 / NaN）→ null。
 * @param {*} raw 原始字号
 * @returns {number|null}
 */
function normFontSize(raw) {
    if (typeof raw === "number") {
        if (!Number.isFinite(raw) || raw < FONT_SIZE_MIN_PT || raw > FONT_SIZE_MAX_PT) return null;
        return Math.round(raw * 10) / 10;
    }
    return null;
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

/** 自定义列宽合法区间（字符宽）：低于 4 或高于 40 视为非法，按默认列宽处理 */
const WIDTH_MIN_CHARS = 4;
const WIDTH_MAX_CHARS = 40;

/**
 * 自动筛选规整：只接受 `{col: 整数 >= 0, value: string}`，其余（缺值、非字符串列号）成 null。
 * @param {*} raw 原始筛选条件
 * @returns {{col: number, value: string}|null}
 */
function normFilter(raw) {
    if (!raw || typeof raw !== "object") return null;
    const col = Number(raw.col);
    if (!Number.isInteger(col) || col < 0) return null;
    if (typeof raw.value !== "string") return null;
    return { col, value: raw.value };
}

/**
 * 自定义列宽规整：索引 = 列号，值 = 字符宽（4..40，保留一位小数）；非法位置记 0（= 默认）。
 * 没有任何自定义列宽时返回 null（而不是全 0 数组），与契约的「默认 null」一致。
 * @param {*} raw 原始列宽数组
 * @returns {number[]|null}
 */
function normWidths(raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    raw.forEach((value, i) => {
        const n = Number(value);
        if (!Number.isFinite(n) || n < WIDTH_MIN_CHARS || n > WIDTH_MAX_CHARS) return;
        out[i] = Math.round(n * 10) / 10;
    });
    if (!out.some((value) => value > 0)) return null;
    return out;
}

/**
 * 行高规整：索引 = 行号，值 = pt（12..200，取整）；非法 / 越界记 0（= 默认）。
 * 没有任何自定义行高时返回 null（契约默认），避免给旧文档凭空添字段值。
 * @param {*} raw 原始行高数组
 * @returns {number[]|null}
 */
function normHeights(raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    raw.forEach((value, i) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return;
        const pt = Math.round(n);
        // 0 与越界值都记 0（保留下标 = 行号），只有合法 pt 才是自定义行高
        out[i] = pt >= HEIGHT_MIN_PT && pt <= HEIGHT_MAX_PT ? pt : 0;
    });
    if (!out.some((value) => value > 0)) return null;
    return out;
}

/**
 * 冻结规整：只认 `{row, col}` 两个布尔，缺省 / 非法一律 false（旧文档无该字段也能开）。
 * @param {*} raw 原始冻结对象
 * @returns {{row: boolean, col: boolean}}
 */
function normFreeze(raw) {
    if (!raw || typeof raw !== "object") return { row: false, col: false };
    return { row: !!raw.row, col: !!raw.col };
}

/**
 * 合并区规整：0 基闭区间，行列序归一后丢弃非法 / 单格 / 越界 / 与已收区重叠的项
 * （先到先得），最多 MERGE_MAX 区。
 * @param {*} raw 原始合并区数组
 * @param {number} rowCount 表格行数（越界判断）
 * @param {number} colCount 表格列数（越界判断）
 * @returns {Array<[number, number, number, number]>}
 */
function normMerges(raw, rowCount, colCount) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
        if (out.length >= MERGE_MAX) break;
        if (!Array.isArray(item) || item.length !== 4) continue;
        const nums = item.map((v) => Number(v));
        if (!nums.every((n) => Number.isInteger(n) && n >= 0)) continue;
        const [r1, c1, r2, c2] = [Math.min(nums[0], nums[2]), Math.min(nums[1], nums[3]),
            Math.max(nums[0], nums[2]), Math.max(nums[1], nums[3])];
        if (r1 === r2 && c1 === c2) continue;
        if (r2 >= rowCount || c2 >= colCount) continue;
        if (out.some((m) => r1 <= m[2] && m[0] <= r2 && c1 <= m[3] && m[1] <= c2)) continue;
        out.push([r1, c1, r2, c2]);
    }
    return out;
}

/* 样式表写出（去重建索引） */

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
        fonts: [{ bold: false, italic: false, underline: false, strike: false, color: null, font: null, fontSize: null }],
        fontIds: new Map([[fontKey({ bold: false, italic: false, underline: false, strike: false, color: null, font: null, fontSize: null }), 0]]),
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

/** font 去重键：四个布尔 + 字色 + 字体名 + 字号（无字体/字号格式的格子与 0 号同键） */
function fontKey(style) {
    return `${style.bold ? 1 : 0}${style.italic ? 1 : 0}${style.underline ? 1 : 0}${style.strike ? 1 : 0}|${style.color || ""}|${style.font || ""}|${style.fontSize === null ? "" : style.fontSize}`;
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
        font: style.font,
        fontSize: style.fontSize,
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
 * @param {Array<{ext: string}>} images 图片登记（只取扩展名声明 Default）
 * @param {Array<{part: string, type: string}>} overrides Override 列表
 * @returns {string} XML 文本
 */
function contentTypesXml(images, overrides) {
    const exts = [];
    for (const img of images || []) if (img.ext && !exts.includes(img.ext)) exts.push(img.ext);
    const imageDefaults = exts
        .map((ext) => `<Default Extension="${ext}" ContentType="${IMAGE_MIME[ext] || "application/octet-stream"}"/>`)
        .join("");
    const body = overrides.map((o) => `<Override PartName="${escapeXml(o.part)}" ContentType="${escapeXml(o.type)}"/>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="${CT_REL}"/><Default Extension="xml" ContentType="${CT_XML}"/>${imageDefaults}${body}</Types>`;
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
 * 顺序错了严格校验器会报错；未指定字体 / 字号时沿用默认 Calibri 11。
 * @param {{bold: boolean, italic: boolean, underline: boolean, strike: boolean, color: string|null, font?: string|null, fontSize?: number|null}} font 字体
 * @returns {string} XML 片段
 */
function fontXml(font) {
    const parts = [];
    if (font.bold) parts.push("<b/>");
    if (font.italic) parts.push("<i/>");
    if (font.strike) parts.push("<strike/>");
    if (font.underline) parts.push('<u val="single"/>');
    const size = font.fontSize === null || font.fontSize === undefined ? DEFAULT_FONT_SIZE_PT : font.fontSize;
    parts.push(`<sz val="${size}"/>`);
    // 默认字体保留 theme="1"（Excel 自己的写法），有字色时写 ARGB
    parts.push(font.color ? `<color rgb="FF${font.color.slice(1)}"/>` : '<color theme="1"/>');
    parts.push(`<name val="${escapeXml(font.font || DEFAULT_FONT_NAME)}"/>`);
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
function worksheetXml(sheet, hasDrawing = false) {
    const rows = sheet.rows;
    const ids = sheet.styleIds || [];
    const heights = Array.isArray(sheet.heights) ? sheet.heights : [];
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const dimension = rows.length && maxCols ? `A1:${colLetter(maxCols)}${rows.length}` : "A1";
    const body = rows
        .map((row, r) => {
            const idRow = ids[r] || [];
            const cells = row.map((value, c) => cellXml(`${colLetter(c + 1)}${r + 1}`, value, idRow[c] || 0)).join("");
            const ht = heights[r] > 0 ? ` ht="${heights[r]}" customHeight="1"` : "";
            // 已有属性（spans）保留，只在有自定义行高时增量追加 ht / customHeight
            return `<row r="${r + 1}"${ht} spans="1:${Math.max(row.length, 1)}">${cells}</row>`;
        })
        .join("");
    // schema 顺序：sheetViews -> sheetFormatPr -> cols -> sheetData -> autoFilter -> mergeCells -> drawing
    const cols = colsXml(sheet.widths);
    const autoFilter = autoFilterXml(sheet.filter, Math.max(maxCols, 1), Math.max(rows.length, 1));
    const merges = mergeCellsXml(sheet.merges);
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><dimension ref="${dimension}"/>${sheetViewsXml(sheet.freeze)}<sheetFormatPr defaultRowHeight="14.4"/>${cols}<sheetData>${body}</sheetData>${autoFilter}${merges}${hasDrawing ? '<drawing r:id="rId1"/>' : ""}</worksheet>`;
}

/**
 * 生成 `<sheetViews>`：冻结首行 / 首列写成 `<pane>`，无冻结时不写（旧包零新增）。
 * 双冻结必须同时给 xSplit / ySplit / topLeftCell / activePane="bottomRight"。
 * @param {{row: boolean, col: boolean}|undefined} freeze 冻结开关
 * @returns {string} XML 片段
 */
function sheetViewsXml(freeze) {
    const row = !!(freeze && freeze.row);
    const col = !!(freeze && freeze.col);
    let pane = "";
    if (row && col) pane = '<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/>';
    else if (row) pane = '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>';
    else if (col) pane = '<pane xSplit="1" topLeftCell="B1" activePane="topRight" state="frozen"/>';
    return `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>`;
}

/**
 * 生成 `<mergeCells>`：ref 用 A1:B2 形式（0 基闭区间转 1 基），无合并不写。
 * @param {Array<[number, number, number, number]>|undefined} merges 合并区
 * @returns {string} XML 片段
 */
function mergeCellsXml(merges) {
    if (!Array.isArray(merges) || !merges.length) return "";
    const refs = merges.map(([r1, c1, r2, c2]) =>
        `<mergeCell ref="${colLetter(c1 + 1)}${r1 + 1}:${colLetter(c2 + 1)}${r2 + 1}"/>`).join("");
    return `<mergeCells count="${merges.length}">${refs}</mergeCells>`;
}

/**
 * 生成 `<cols>`：只写自定义列宽（0 视为默认），相邻同宽列合并成一个 `<col min..max>`。
 * @param {number[]|null} widths 列宽数组（字符宽，索引 = 列号）
 * @returns {string} XML 片段（无自定义列宽时为空串）
 */
function colsXml(widths) {
    if (!Array.isArray(widths)) return "";
    const items = [];
    for (let i = 0; i < widths.length;) {
        const width = widths[i];
        if (!(width > 0)) { i += 1; continue; }
        let end = i + 1;
        while (end < widths.length && widths[end] === width) end += 1;
        items.push(`<col min="${i + 1}" max="${end}" width="${width}" customWidth="1"/>`);
        i = end;
    }
    return items.length ? `<cols>${items.join("")}</cols>` : "";
}

/**
 * 生成 `<autoFilter>`：ref 覆盖数据区（筛选列超出数据列时以筛选列为末列），
 * `colId` 直接是 0 起列号，值走 XML 转义。
 * @param {{col: number, value: string}|null} filter 筛选条件
 * @param {number} dataCols 数据列数
 * @param {number} dataRows 数据行数
 * @returns {string} XML 片段（无筛选时为空串）
 */
function autoFilterXml(filter, dataCols, dataRows) {
    if (!filter) return "";
    const lastCol = colLetter(Math.max(dataCols, filter.col + 1));
    return `<autoFilter ref="A1:${lastCol}${dataRows}"><filterColumn colId="${filter.col}">`
        + `<customFilters><customFilter operator="equal" val="${escapeXml(filter.value)}"/></customFilters>`
        + "</filterColumn></autoFilter>";
}

/**
 * 生成一张表的 drawing 部件：每张图一个 `xdr:oneCellAnchor`，from 固定 A1 起点，
 * 大小由 `xdr:ext` 决定（px * 9525）。图片实际落点/裁剪/旋转不建模（已知降级）。
 * @param {Array<{entry: {path: string}, width: number, height: number}>} refs 图片登记
 * @returns {string} XML 文本
 */
function sheetDrawingXml(refs) {
    const anchors = refs.map((ref, i) => {
        const rid = `rId${i + 1}`;
        const cx = Math.round(ref.width * EMU_PER_PX);
        const cy = Math.round(ref.height * EMU_PER_PX);
        return `<xdr:oneCellAnchor>`
            + `<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
            + `<xdr:ext cx="${cx}" cy="${cy}"/>`
            + `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="图片 ${i + 1}"/>`
            + `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
            + `<xdr:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
            + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
            + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`
            + `<xdr:clientData/></xdr:oneCellAnchor>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}" xmlns:r="${NS_REL}">${anchors}</xdr:wsDr>`;
}

/**
 * 生成 drawing 的关系：每张图一条 image 关系，Target 指向 `../media/…`。
 * @param {Array<{entry: {path: string}}>} refs 图片登记
 * @returns {string} XML 文本
 */
function drawingRelsXml(refs) {
    const items = refs.map((ref, i) => {
        // drawing 部件在 xl/drawings/ 下，media 在 xl/media/：相对路径必须回退一级
        const target = `../${ref.entry.path.replace(/^xl\//, "")}`;
        return `<Relationship Id="rId${i + 1}" Type="${NS_REL}/image" Target="${escapeXml(target)}"/>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_PKG_REL}">${items}</Relationships>`;
}

/**
 * 生成 worksheet 的关系：只含一条 drawing 关系（rId1，与 `<drawing r:id>` 对齐）。
 * @param {number} k drawing 序号
 * @returns {string} XML 文本
 */
function sheetDrawingRelsXml(k) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/drawing" Target="../drawings/drawing${k}.xml"/></Relationships>`;
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

/* csv */

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
