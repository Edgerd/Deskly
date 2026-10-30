/**
 * view-excel.js — 表格（excel）网格视图：Office 2016 功能区 + 单元格样式 + 公式
 *
 * 外壳把 `.office-canvas > .office-view[data-role="view"]` 交给我们，本模块负责
 * A1 坐标网格、单元格编辑与列宽拖拽，并按 `ribbon() / command(id, value) / state()` 契约
 * 声明「开始 / 插入 / 数据 / 视图」四个标签页。工具条已经换成功能区，视图内不再自建按钮，
 * 只留一条地址栏（选中格坐标 + 原始内容 + 公式错误计数）。
 *
 * 模型（与 codecs/xlsx.js 同一份约定，本模块不 import 它，只按字段读写）：
 *   Sheet     = { name, rows: string[][], styles: CellStyle[][] }
 *   CellStyle = { bold, italic, underline, strike, color, fill, align, wrap, format } | null
 * styles 与 rows **同矩形**：无格式的格子为 null，外来模型缺位补 null、多位裁掉
 * （rectangularizeStyles 补，fitStyleRect 按 rows 的尺寸硬裁）。csv 这类不带样式的来源
 * 也必须给出全 null 的矩形，否则按下标取值会崩。
 *
 * **显示与存储分离**（本视图最要紧的一条）：
 * `rows` 里存的永远是原文，以 `=` 开头的公式照原样存 —— 保存时由编解码写 `<f>`；
 * 求值结果只进 `shown` 矩阵、只用于渲染。于是 read() 导出的公式不会被计算值覆盖
 * （Excel 打开还能重算），而用户看到的是数字。数字格式 `format` 同理：
 * 只改写显示串，绝不改写存储值（否则百分比单元格会被存成 0.25 → "25%" 这种没法再算的文本）。
 *
 * 格子不挂 contenteditable，也**一个监听都不挂**：全网格共用一个覆盖式 `<input>` 编辑器，
 * 键盘 / 鼠标 / 粘贴一律走网格容器的事件委托（`closest("[data-cell]")` 定位）。
 *
 * colName / colIndex / rectangularize / rectangularizeStyles / fitStyleRect / normalizeStyle /
 * trimTrailing / trimTrailingStyles / parseFormula / evaluateFormulas / formatCell
 * 都是不依赖 DOM 的导出纯函数，供 Node 侧探针直接验证
 * （.workbuddy/office_grid_logic_probe.mjs 验矩形化与裁尾，
 *  .workbuddy/office_xlsx_view_probe.mjs 验公式求值、功能区命令与样式随行移动）。
 */

import { el, useStyle } from "./view-style.js";
import { t } from "./t.js";

const PAD_ROWS = 12;
const PAD_COLS = 6;
const DEFAULT_COL_W = 108;
const MIN_COL_W = 48;
const MAX_COL_W = 420;
const EMPTY_NAME = "工作表1";

/** 撤销栈容量：取 60（满足「≥50」，多出 10 格缓冲，避免刚好卡在边界） */
const HISTORY_MAX = 60;
/** 同一格连续输入 400ms 内的多次提交合成一条历史（按时间戳判定，不起定时器） */
const COALESCE_MS = 400;

/** 数字字面量 / 纯数字单元格判定（公式求值与 xl.sum 取样都用它） */
const NUM_RE = /^[-+]?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/;
/** 模型里 color / fill 只接受 #RRGGBB，其余一律归 null（与编解码同规则） */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** 视图里可用的缩放档位：只给 Office 常用的四档 */
const ZOOM_LEVELS = [80, 100, 120, 140];

/* ───────────────────────── 纯函数：列名与矩形化 ───────────────────────── */

/**
 * 列下标 → A1 风格列名（0 → "A"、25 → "Z"、26 → "AA"、701 → "ZZ"、702 → "AAA"）。
 * @param {number} i 零基列下标
 * @returns {string} 列名
 */
export function colName(i) {
    let n = Math.trunc(i) + 1;
    if (!(n > 0)) return "A";
    let s = "";
    while (n > 0) {
        s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

/**
 * A1 风格列名 → 列下标（"A" → 0、"Z" → 25、"AA" → 26）。非法输入返回 -1。
 * @param {string} name 列名（大小写不敏感）
 * @returns {number} 零基列下标
 */
export function colIndex(name) {
    const s = String(name || "").toUpperCase();
    if (!/^[A-Z]{1,3}$/.test(s)) return -1;
    let n = 0;
    for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
}

/**
 * 矩形化：每行补齐到最大列数并按 minCols / minRows 取下界，空洞与非字符串归一成 ""。
 * @param {Array<Array<*>>} rows 原始行（可稀疏、可参差）
 * @param {number} [minCols] 列数下界
 * @param {number} [minRows] 行数下界
 * @returns {string[][]} 新建矩形矩阵（不与入参共享内层数组）
 */
export function rectangularize(rows, minCols = 0, minRows = 0) {
    const src = Array.isArray(rows) ? rows : [];
    let cols = Math.max(Math.trunc(minCols) || 0, 0);
    for (const row of src) {
        if (Array.isArray(row) && row.length > cols) cols = row.length;
    }
    const count = Math.max(Math.trunc(minRows) || 0, src.length);
    const out = [];
    for (let y = 0; y < count; y++) {
        const srcRow = Array.isArray(src[y]) ? src[y] : [];
        const row = new Array(cols);
        for (let x = 0; x < cols; x++) {
            const v = srcRow[x];
            row[x] = v == null ? "" : String(v);
        }
        out.push(row);
    }
    return out;
}

/**
 * 单元格样式的规范形状（九项齐全）。null / 非对象 / 字段缺失都按默认值补齐，
 * 全默认则折叠成 null —— 这样「只点了一下粗体又取消」不会在模型里留下空壳对象，
 * 编解码那边也就不会为无格式的格子生成 cellXfs 条目。
 * @param {*} raw 外来样式（可以是 null / 缺字段 / 类型不对）
 * @returns {object|null} 规范样式或 null
 */
export function normalizeStyle(raw) {
    if (!raw || typeof raw !== "object") return null;
    const align = raw.align === "left" || raw.align === "center" || raw.align === "right" ? raw.align : null;
    const st = {
        bold: !!raw.bold,
        italic: !!raw.italic,
        underline: !!raw.underline,
        strike: !!raw.strike,
        color: typeof raw.color === "string" && HEX_RE.test(raw.color) ? raw.color.toUpperCase() : null,
        fill: typeof raw.fill === "string" && HEX_RE.test(raw.fill) ? raw.fill.toUpperCase() : null,
        align,
        wrap: !!raw.wrap,
        format: typeof raw.format === "string" && raw.format ? raw.format : null,
    };
    return isBlankStyle(st) ? null : st;
}

/**
 * 是否等价于「无格式」。
 * @param {object|null} st 规范样式
 * @returns {boolean} 全默认则 true
 */
function isBlankStyle(st) {
    return !st || (!st.bold && !st.italic && !st.underline && !st.strike &&
        !st.color && !st.fill && !st.align && !st.wrap && !st.format);
}

/**
 * 样式矩阵矩形化：与 rectangularize 同样的下界规则，空洞补 null，多余裁掉，
 * 每项过 normalizeStyle（于是 csv 传来的 `styles: undefined` 也能得到同矩形的 null 阵）。
 * @param {Array<Array<*>>} styles 原始样式（可稀疏、可参差、可缺省）
 * @param {number} [minCols] 列数下界
 * @param {number} [minRows] 行数下界
 * @returns {Array<Array<object|null>>} 新建矩形矩阵
 */
export function rectangularizeStyles(styles, minCols = 0, minRows = 0) {
    const src = Array.isArray(styles) ? styles : [];
    let cols = Math.max(Math.trunc(minCols) || 0, 0);
    for (const row of src) {
        if (Array.isArray(row) && row.length > cols) cols = row.length;
    }
    const count = Math.max(Math.trunc(minRows) || 0, src.length);
    const out = [];
    for (let y = 0; y < count; y++) {
        const srcRow = Array.isArray(src[y]) ? src[y] : [];
        const row = new Array(cols);
        for (let x = 0; x < cols; x++) row[x] = normalizeStyle(srcRow[x]);
        out.push(row);
    }
    return out;
}

/**
 * 尾部空行空列的尺寸：返回裁剪后的行列数（全空则 h/w 为 0）。
 * @param {string[][]} rect 已矩形化的行
 * @returns {{h: number, w: number}} 裁剪后尺寸
 */
function trimSize(rect) {
    let h = rect.length;
    while (h > 0 && rect[h - 1].every((v) => v === "")) h--;
    if (h === 0) return { h: 0, w: 0 };
    for (let x = rect[0].length - 1; x >= 0; x--) {
        let empty = true;
        for (let y = 0; y < h; y++) {
            if (rect[y][x] !== "") { empty = false; break; }
        }
        if (!empty) return { h, w: x + 1 };
    }
    return { h: 0, w: 0 };
}

/**
 * 把样式阵硬对齐到「rows 的行数 × 列数」这个尺寸：窄了补 null，**宽了裁掉**。
 * rectangularizeStyles 的下界语义是「至少这么宽」，同矩形这条铁律要的是「正好这么宽」，
 * 外来模型带着一排多余的样式时（手工改过的 xlsx 真会出现）必须由这里裁掉。
 * @param {Array<Array<*>>} styles 原始样式
 * @param {number} h 行数（以 rows 为准）
 * @param {number} w 列数（以 rows 为准）
 * @returns {Array<Array<object|null>>} h×w 的样式矩阵
 */
export function fitStyleRect(styles, h, w) {
    return rectangularizeStyles(styles, w, h).slice(0, Math.max(0, h)).map((row) => row.slice(0, Math.max(0, w)));
}

/**
 * 先矩形化，再裁掉尾部全空行与全空列；整表为空时返回 []。
 * @param {Array<Array<*>>} rows 原始行
 * @returns {string[][]} 裁剪后的矩形矩阵
 */
export function trimTrailing(rows) {
    const rect = rectangularize(rows);
    const { h, w } = trimSize(rect);
    if (h === 0 || w === 0) return [];
    return rect.slice(0, h).map((row) => row.slice(0, w));
}

/**
 * 按 rows 的裁尾结果把 styles 裁成同一矩形（读回时必须与 rows 同尺寸，否则下标错位）。
 * @param {Array<Array<*>>} styles 原始样式
 * @param {Array<Array<*>>} rows 对应的行（用来算裁剪尺寸）
 * @param {number} [minCols] 列数下界
 * @param {number} [minRows] 行数下界
 * @returns {Array<Array<object|null>>} 与裁尾后 rows 同矩形的样式
 */
export function trimTrailingStyles(styles, rows, minCols = 0, minRows = 0) {
    const rect = rectangularize(rows, minCols, minRows);
    const { h, w } = trimSize(rect);
    return fitStyleRect(styles, h, w);
}

/* ───────────────────────── 纯函数：公式求值 ───────────────────────── */

/** 错误值（与 Excel 同名单）：视图层只产出这几个，编解码不参与求值 */
const ERR_NAME = "#NAME?";
const ERR_REF = "#REF!";
const ERR_VALUE = "#VALUE!";
const ERR_DIV = "#DIV/0!";
/** 支持的函数：够用且可测；其余一律 #NAME?（不求值成 0，避免静默出错） */
const FUNCTIONS = new Set(["SUM", "AVERAGE", "MIN", "MAX", "COUNT"]);

/**
 * 是否是错误值（已算出的错误串以 # 开头，如 "#DIV/0!"）。
 * @param {*} v 值
 * @returns {boolean} 是否错误
 */
function isErr(v) {
    return typeof v === "string" && v.charCodeAt(0) === 35;
}

/**
 * 词法分析：数字 / 函数名 / 单元格引用（含 `$`）/ `+ - * / ( ) : ,`。
 * 函数名判定优先于引用（否则 `LOG10(` 会被切成引用 `LOG10`）。
 * @param {string} src 公式体（不含前导 `=`）
 * @returns {Array<object>|null} token 数组，语法不合法返回 null
 */
function tokenize(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === " " || ch === "\t") { i++; continue; }
        if ((ch >= "0" && ch <= "9") || (ch === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
            let j = i;
            while (j < src.length && /[\d.]/.test(src[j])) j++;
            if (/[eE]/.test(src[j] || "")) {
                let k = j + 1;
                if (/[+-]/.test(src[k] || "")) k++;
                if (/\d/.test(src[k] || "")) { k++; while (/\d/.test(src[k] || "")) k++; j = k; }
            }
            const num = Number(src.slice(i, j));
            if (!Number.isFinite(num)) return null;
            out.push({ t: "num", v: num });
            i = j;
            continue;
        }
        if (/[A-Za-z_$]/.test(ch)) {
            let j = i;
            while (j < src.length && /[A-Za-z0-9_.$]/.test(src[j])) j++;
            const word = src.slice(i, j);
            let k = j;
            while (src[k] === " ") k++;
            if (src[k] === "(") { out.push({ t: "fn", name: word.toUpperCase().replace(/[$.]/g, "") }); i = j; continue; }
            const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(word);
            if (m) {
                const c = colIndex(m[1]);
                const rowNum = Number(m[2]);
                // 行号为 0（`=A0`）在 Excel 里就是 #REF!，这里保留同样的判定
                out.push(c < 0 || rowNum < 1 ? { t: "badref" } : { t: "ref", r: rowNum - 1, c });
                i = j;
                continue;
            }
            return null;
        }
        if ("+-*/():".indexOf(ch) >= 0 || ch === ",") { out.push({ t: ch }); i++; continue; }
        return null;
    }
    return out;
}

/**
 * 递归下降解析（`+ -` < `* /` < 一元正负 < 括号 / 函数 / 引用 / 数字）。
 * 区域 `A1:B4` 只作为整体出现（函数实参位），参与四则运算时按左上格取值。
 * @param {Array<object>} ts token 数组
 * @returns {object|null} AST 根节点，语法错误返回 null
 */
function parseTokens(ts) {
    let p = 0;
    const peek = () => ts[p];
    const eat = (t) => (ts[p] && ts[p].t === t ? (p++, true) : false);

    function primary() {
        const tk = peek();
        if (!tk) return null;
        if (tk.t === "num") { p++; return { k: "num", v: tk.v }; }
        if (tk.t === "badref") { p++; return { k: "bad" }; }
        if (tk.t === "(") {
            p++;
            const inner = expr();
            if (!inner || !eat(")")) return null;
            return inner;
        }
        if (tk.t === "fn") {
            const name = tk.name;
            p++;
            if (!eat("(")) return null;
            const args = [];
            if (!eat(")")) {
                for (;;) {
                    const arg = expr();
                    if (!arg) return null;
                    args.push(arg);
                    if (eat(",")) continue;
                    if (eat(")")) break;
                    return null;
                }
            }
            return { k: "fn", name, args };
        }
        if (tk.t === "ref") {
            p++;
            if (eat(":")) {
                const t2 = peek();
                if (!t2) return null;
                if (t2.t === "badref") { p++; return { k: "bad" }; }
                if (t2.t !== "ref") return null;
                p++;
                // 反着写的区域（B4:A1）归一成角落对，与 Excel 一致
                const r1 = Math.min(tk.r, t2.r);
                const r2 = Math.max(tk.r, t2.r);
                const c1 = Math.min(tk.c, t2.c);
                const c2 = Math.max(tk.c, t2.c);
                if (r1 === r2 && c1 === c2) return { k: "cell", r: r1, c: c1 };
                return { k: "range", r1, c1, r2, c2 };
            }
            return { k: "cell", r: tk.r, c: tk.c };
        }
        return null;
    }

    function unary() {
        if (eat("+")) return unary();
        if (eat("-")) {
            const a = unary();
            return a ? { k: "neg", a } : null;
        }
        return primary();
    }

    function term() {
        let a = unary();
        if (!a) return null;
        for (;;) {
            const tk = peek();
            if (!tk || (tk.t !== "*" && tk.t !== "/")) return a;
            p++;
            const b = unary();
            if (!b) return null;
            a = { k: "op", op: tk.t, a, b };
        }
    }

    function expr() {
        let a = term();
        if (!a) return null;
        for (;;) {
            const tk = peek();
            if (!tk || (tk.t !== "+" && tk.t !== "-")) return a;
            p++;
            const b = term();
            if (!b) return null;
            a = { k: "op", op: tk.t, a, b };
        }
    }

    const root = expr();
    return root && p === ts.length ? root : null;
}

/**
 * 解析一条公式体（不含 `=`）。
 * @param {string} body 公式文本
 * @returns {object|null} AST，语法错误返回 null
 */
export function parseFormula(body) {
    const ts = tokenize(String(body == null ? "" : body));
    return ts ? parseTokens(ts) : null;
}

/**
 * 收集 AST 依赖到的格子（区域内的每一格都算依赖，网格外的不算 —— 网格外按空值参与运算）。
 * @param {object} node AST 节点
 * @param {(r: number, c: number) => void} add 依赖回调
 * @returns {void}
 */
function collectDeps(node, add) {
    if (!node) return;
    switch (node.k) {
        case "cell": add(node.r, node.c); break;
        case "range":
            for (let r = node.r1; r <= node.r2; r++) for (let c = node.c1; c <= node.c2; c++) add(r, c);
            break;
        case "neg": collectDeps(node.a, add); break;
        case "op": collectDeps(node.a, add); collectDeps(node.b, add); break;
        case "fn": node.args.forEach((a) => collectDeps(a, add)); break;
        default: break;
    }
}

/**
 * 由公式数组结构建依赖图并迭代求值（Kahn 拓扑推进，不做递归 —— 自引用与互引用
 * 会一路递归到爆栈，这里靠「依赖没齐就跳过、一轮推不动就整批判 #REF!」收尾）。
 * @param {Array<Array<string>>} rect 矩形化的原始值（含 `=` 前缀公式）
 * @returns {Array<Array<string>>} 与输入同矩形的显示值（非公式格原样返回）
 */
function evalGrid(rect) {
    const h = rect.length;
    const w = h ? rect[0].length : 0;
    const out = rect.map((row) => row.slice());
    if (!h || !w) return out;
    const K = (r, c) => r * 1048576 + c;

    /** 已算出的公式结果：key -> number | 错误串 */
    const done = new Map();
    /** 公式格自己的 key 集合：依赖里只有这些才需要等，普通格直接现读 */
    const formulaKeys = new Set();
    const queue = [];

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const raw = rect[y][x];
            if (typeof raw !== "string" || raw.charCodeAt(0) !== 61) continue; // 只有 `=` 开头才是公式
            const key = K(y, x);
            const ast = parseFormula(raw.slice(1));
            if (!ast) { done.set(key, ERR_NAME); continue; }
            formulaKeys.add(key);
            const deps = [];
            collectDeps(ast, (r, c) => {
                if (r >= 0 && c >= 0 && r < h && c < w) deps.push(K(r, c));
            });
            queue.push({ r: y, c: x, ast, deps, key });
        }
    }

    /** 单格标量：公式取结果，数字取数值，**空格返回 ""**（四则运算里当 0，聚合里被忽略 —— 与 Excel 一致），
     *  文本原样（进四则运算会撞成 #VALUE!） */
    const scalarAt = (r, c) => {
        if (r < 0 || c < 0 || r >= h || c >= w) return "";
        const k = K(r, c);
        if (done.has(k)) return done.get(k);
        const raw = rect[r][c];
        if (raw === "" || raw == null) return "";
        return NUM_RE.test(raw) ? Number(raw) : String(raw);
    };

    /** 表达式 → 标量（区域退化成左上格） */
    const numOf = (node) => {
        if (!node) return ERR_VALUE;
        if (node.k === "range") return toNum(scalarAt(node.r1, node.c1));
        return toNum(evalNode(node));
    };

    /** 实参 → 数值列表：区域展开成每格、文本与空值忽略（与 Excel 的聚合口径一致） */
    const collectValues = (node, acc) => {
        if (!node) return ERR_VALUE;
        if (node.k === "range") {
            for (let r = node.r1; r <= node.r2; r++) {
                for (let c = node.c1; c <= node.c2; c++) {
                    const v = scalarAt(r, c);
                    if (isErr(v)) return v;
                    if (typeof v === "number") acc.push(v);
                }
            }
            return null;
        }
        if (node.k === "cell") {
            const v = scalarAt(node.r, node.c);
            if (isErr(v)) return v;
            if (typeof v === "number") acc.push(v);
            return null;
        }
        const v = evalNode(node);
        if (isErr(v)) return v;
        if (typeof v === "number") acc.push(v);
        return null;
    };

    function evalNode(node) {
        if (!node) return ERR_VALUE;
        switch (node.k) {
            case "num":
                return node.v;
            case "bad":
                return ERR_REF;
            case "cell": return toNum(scalarAt(node.r, node.c));
            case "range": return toNum(scalarAt(node.r1, node.c1));
            case "neg": {
                const a = numOf(node.a);
                return typeof a === "number" ? -a : a;
            }
            case "op": {
                const a = numOf(node.a);
                if (typeof a !== "number") return a;
                const b = numOf(node.b);
                if (typeof b !== "number") return b;
                if (node.op === "+") return a + b;
                if (node.op === "-") return a - b;
                if (node.op === "*") return a * b;
                if (b === 0) return ERR_DIV;
                return a / b;
            }
            case "fn": {
                if (!FUNCTIONS.has(node.name)) return ERR_NAME;
                const acc = [];
                for (const arg of node.args) {
                    const err = collectValues(arg, acc);
                    if (err) return err;
                }
                switch (node.name) {
                    case "SUM": return acc.reduce((s, n) => s + n, 0);
                    case "AVERAGE": return acc.length ? acc.reduce((s, n) => s + n, 0) / acc.length : ERR_DIV;
                    case "MIN": return acc.length ? Math.min.apply(null, acc) : 0;
                    case "MAX": return acc.length ? Math.max.apply(null, acc) : 0;
                    default: return acc.length; // COUNT
                }
            }
            default:
                return ERR_VALUE;
        }
    }

    let progress = true;
    while (queue.length && progress) {
        progress = false;
        for (let i = queue.length - 1; i >= 0; i--) {
            const item = queue[i];
            let ready = true;
            for (const d of item.deps) {
                // 只有「也是公式」的依赖才要等：普通格直接现读（空格按 0、文本按原样）
                if (formulaKeys.has(d) && !done.has(d)) { ready = false; break; }
            }
            if (!ready) continue;
            done.set(item.key, evalNode(item.ast));
            queue.splice(i, 1);
            progress = true;
        }
    }
    // 剩下的都推不动：要么自成环，要么下游挂着环 —— Excel 同样显示 #REF!，一次收尾不死循环
    for (const item of queue) done.set(item.key, ERR_REF);

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const raw = rect[y][x];
            if (typeof raw !== "string" || raw.charCodeAt(0) !== 61) continue;
            const v = done.get(K(y, x));
            if (typeof v === "number") out[y][x] = Number.isFinite(v) ? String(round10(v)) : ERR_VALUE;
            else out[y][x] = v == null ? ERR_VALUE : String(v);
        }
    }
    return out;
}

/** 去掉二进制浮点的尾噪（0.1+0.2 → 0.3 而不是 0.30000000000000004） */
function round10(n) {
    return Math.round(n * 1e10) / 1e10;
}

/** 标量进四则运算：数字放行、空格当 0、错误传播、文本按 #VALUE! */
function toNum(v) {
    if (typeof v === "number") return v;
    if (isErr(v)) return v;
    if (v === "" || v == null) return 0;
    if (typeof v === "string" && NUM_RE.test(v)) return Number(v);
    return ERR_VALUE;
}

/**
 * 对整个工作表求值（不依赖 DOM 的纯函数）。
 * 以 `=` 开头的格子按公式处理，其余原样返回；结果只用于显示，不回写模型。
 * @param {{rows?: Array<Array<*>>}} sheet 工作表（只用 rows，styles 忽略）
 * @returns {{ok: string[][], errors: number}} ok = 与输入同矩形的显示值，errors = 出错公式数
 */
export function evaluateFormulas(sheet) {
    const rect = rectangularize((sheet && sheet.rows) || []);
    const ok = evalGrid(rect);
    let errors = 0;
    for (let y = 0; y < rect.length; y++) {
        for (let x = 0; x < rect[y].length; x++) {
            if (rect[y][x].charCodeAt(0) === 61 && isErr(ok[y][x])) errors++;
        }
    }
    return { ok, errors };
}

/**
 * 数字格式只作用于显示串（存储值不动）。
 * 支持的格式串与编解码的 FMT_ID 契约表一致；未知格式原样返回，绝不吞值。
 * `yyyy-mm-dd` 按 Excel 序列号换算（1900 日期系统，25569 = 1970-01-01），
 * 非数字（文本日期）原样显示 —— 不做多语言日期解析，那是编解码之外的事。
 * @param {string} text 显示用的原始值
 * @param {string|null} format 格式串（null = 常规）
 * @returns {string} 格式化后的显示串
 */
export function formatCell(text, format) {
    const raw = text == null ? "" : String(text);
    if (!format || raw === "") return raw;
    if (isErr(raw)) return raw;
    if (!NUM_RE.test(raw)) return raw;
    const n = Number(raw);
    switch (format) {
        case "0.00": return n.toFixed(2);
        case "#,##0": return groupThousands(String(Math.round(n)));
        case "#,##0.00": return groupThousands(n.toFixed(2));
        case "0%": return String(Math.round(n * 100)) + "%";
        case "0.00%": return (n * 100).toFixed(2) + "%";
        case "yyyy-mm-dd": {
            const ms = Math.round((n - 25569) * 86400000);
            const d = new Date(ms);
            return Number.isNaN(d.getTime()) ? raw : d.toISOString().slice(0, 10);
        }
        default: return raw;
    }
}

/** 整数部分加千分位（小数部分原样接在后面） */
function groupThousands(text) {
    const s = String(text);
    const neg = s.charAt(0) === "-";
    const body = neg ? s.slice(1) : s;
    const dot = body.indexOf(".");
    const int = dot >= 0 ? body.slice(0, dot) : body;
    const rest = dot >= 0 ? body.slice(dot) : "";
    return (neg ? "-" : "") + int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + rest;
}

/* ───────────────────────── 功能区声明 ───────────────────────── */

const COLOR_OPTIONS = () => [
    { value: "", label: t("excel.auto", "自动") },
    { value: "#1D1D1F", label: t("excel.black", "黑") },
    { value: "#C00000", label: t("excel.red", "红") },
    { value: "#2B579A", label: t("excel.blue", "蓝") },
    { value: "#1F9E5A", label: t("excel.green", "绿") },
    { value: "#B26B00", label: t("excel.orange", "橙") },
];
const FILL_OPTIONS = () => [
    { value: "", label: t("excel.none", "无") },
    { value: "#FFF2CC", label: t("excel.yellow", "黄") },
    { value: "#E2EFDA", label: t("excel.green", "绿") },
    { value: "#DCE6F1", label: t("excel.blue", "蓝") },
    { value: "#FDE9D9", label: t("excel.orange", "橙") },
    { value: "#EDEDED", label: t("excel.gray", "灰") },
];
/** 数字格式菜单：`""` 表示常规（模型里存 null），其余串原样进 styles.format */
const FORMAT_OPTIONS = () => [
    { value: "", label: t("excel.formatGeneral", "常规") },
    { value: "0.00", label: t("excel.formatNumber", "数值 0.00") },
    { value: "#,##0", label: t("excel.formatThousands", "千分位") },
    { value: "0%", label: t("excel.formatPercent", "百分比") },
    { value: "yyyy-mm-dd", label: t("excel.formatDate", "日期") },
];
const ZOOM_OPTIONS = ZOOM_LEVELS.map((z) => ({ value: String(z), label: z + "%" }));

/**
 * 标签页与控件声明（结构固定，状态由 state() 提供）。
 * `xl.gridlines` 在「开始」和「视图」两处各出现一次，共用同一个状态源。
 * **文案每次现取**：外壳在 languagechange 时会重新调 ribbon()，所以这里不能固化成常量。
 */
const TABS = () => [
    {
        id: "home",
        label: t("excel.tabHome", "开始"),
        groups: [
            {
                label: t("excel.groupUndo", "撤销"),
                items: [
                    { id: "xl.undo", label: t("excel.undo", "撤销"), icon: "undo", title: t("excel.undoTip", "撤销上一步（⌘Z）") },
                    { id: "xl.redo", label: t("excel.redo", "重做"), icon: "redo", title: t("excel.redoTip", "重做（⌘⇧Z）") },
                ],
            },
            {
                label: t("excel.groupFont", "字体"),
                items: [
                    { id: "xl.bold", label: t("excel.bold", "粗体"), icon: "bold", type: "toggle", title: t("excel.boldTip", "加粗选中格") },
                    { id: "xl.italic", label: t("excel.italic", "斜体"), icon: "italic", type: "toggle" },
                    { id: "xl.underline", label: t("excel.underline", "下划线"), icon: "underline", type: "toggle" },
                    { id: "xl.strike", label: t("excel.strike", "删除线"), icon: "strike", type: "toggle" },
                    { id: "xl.color", label: t("excel.textColor", "字色"), type: "menu", options: COLOR_OPTIONS() },
                    { id: "xl.fill", label: t("excel.fillColor", "填充"), type: "menu", options: FILL_OPTIONS() },
                    { id: "xl.clear", label: t("excel.clearFormat", "清除格式"), icon: "clear", title: t("excel.clearFormatTip", "只清格式，留内容") },
                ],
            },
            {
                label: t("excel.groupAlign", "对齐"),
                items: [
                    { id: "xl.alignLeft", label: t("excel.alignLeft", "左对齐"), icon: "alignLeft", type: "toggle" },
                    { id: "xl.alignCenter", label: t("excel.alignCenter", "居中"), icon: "alignCenter", type: "toggle" },
                    { id: "xl.alignRight", label: t("excel.alignRight", "右对齐"), icon: "alignRight", type: "toggle" },
                    { id: "xl.wrap", label: t("excel.wrap", "自动换行"), icon: "wrap", type: "toggle" },
                ],
            },
            {
                label: t("excel.groupNumber", "数字"),
                items: [
                    { id: "xl.format", label: t("excel.format", "格式"), type: "menu", options: FORMAT_OPTIONS() },
                    { id: "xl.sum", label: t("excel.sum", "自动求和"), icon: "Σ", title: t("excel.sumTip", "把选中格设为 =SUM(上方连续数字区间)") },
                ],
            },
            {
                label: t("excel.groupCell", "单元格"),
                items: [
                    { id: "xl.insertRowBelow", label: t("excel.insertRowBelow", "下方插行"), icon: "row", size: "large" },
                    { id: "xl.insertColRight", label: t("excel.insertColRight", "右侧插列"), icon: "column", size: "large" },
                    { id: "xl.deleteRow", label: t("excel.deleteRow", "删除本行"), type: "button" },
                    { id: "xl.deleteCol", label: t("excel.deleteCol", "删除本列"), type: "button" },
                ],
            },
            {
                label: t("excel.groupView", "视图"),
                items: [
                    { id: "xl.gridlines", label: t("excel.gridlines", "网格线"), icon: "page", type: "toggle", title: t("excel.gridlinesTip", "显示 / 隐藏网格线（与「视图」页同一个开关）") },
                ],
            },
        ],
    },
    {
        id: "insert",
        label: t("excel.tabInsert", "插入"),
        groups: [
            {
                label: t("excel.groupRowsCols", "行与列"),
                items: [
                    { id: "xl.rows5", label: t("excel.rows5", "下方插 5 行"), icon: "row", size: "large" },
                    { id: "xl.cols3", label: t("excel.cols3", "右侧插 3 列"), icon: "column", size: "large" },
                ],
            },
            {
                label: t("excel.groupEdit", "编辑"),
                items: [
                    { id: "xl.fillDown", label: t("excel.fillDown", "向下填充"), icon: "↓", title: t("excel.fillDownTip", "把选中格上方一格的值填进本格") },
                ],
            },
        ],
    },
    {
        id: "data",
        label: t("excel.tabData", "数据"),
        groups: [
            {
                label: t("excel.groupSort", "排序"),
                items: [
                    { id: "xl.sortAsc", label: t("excel.sortAsc", "升序"), icon: "sortAsc", size: "large", title: t("excel.sortTip", "以当前列为键对全表行排序（样式随行一起移动）") },
                    { id: "xl.sortDesc", label: t("excel.sortDesc", "降序"), icon: "sortDesc", size: "large" },
                ],
            },
            {
                label: t("excel.groupClear", "清除"),
                items: [
                    { id: "xl.clearContents", label: t("excel.clearContents", "清除全部"), icon: "clear", size: "large", title: t("excel.clearContentsTip", "清空选中格的内容与样式") },
                ],
            },
        ],
    },
    {
        id: "view",
        label: t("excel.tabView", "视图"),
        groups: [
            {
                label: t("excel.groupDisplay", "显示"),
                items: [
                    { id: "xl.zoom", label: t("excel.zoom", "缩放"), type: "menu", options: ZOOM_OPTIONS },
                    { id: "xl.gridlines", label: t("excel.gridlines", "网格线"), icon: "page", type: "toggle" },
                ],
            },
        ],
    },
];

/**
 * 功能区里声明的全部命令 id（探针用它做双向对账）。
 * 这里只固化 id —— id 不随语言变化；label / title 留在 TABS() 里每次现取。
 */
export const RIBBON_COMMAND_IDS = TABS().reduce((acc, tab) => {
    for (const group of tab.groups || []) {
        for (const item of group.items || []) if (item.id && acc.indexOf(item.id) === -1) acc.push(item.id);
    }
    return acc;
}, []);

/** 对齐命令 id → align 取值 */
const ALIGN_COMMANDS = {
    "xl.alignLeft": "left",
    "xl.alignCenter": "center",
    "xl.alignRight": "right",
};

/* ───────────────────────── 视图 ───────────────────────── */

/**
 * @typedef {object} ExcelStyle
 * @property {boolean} bold 粗体
 * @property {boolean} italic 斜体
 * @property {boolean} underline 下划线
 * @property {boolean} strike 删除线
 * @property {string|null} color 字色 #RRGGBB
 * @property {string|null} fill 填充 #RRGGBB
 * @property {string|null} align 水平对齐
 * @property {boolean} wrap 自动换行
 * @property {string|null} format 数字格式
 */

/**
 * @typedef {object} ExcelModel
 * @property {string} name 工作表名
 * @property {string[][]} rows 矩形单元格矩阵（原文，公式仍是 `=` 开头）
 * @property {Array<ExcelStyle|null>[][]} styles 与 rows 同矩形的样式矩阵
 */

/**
 * 建表格网格视图。
 * @param {HTMLElement} viewEl 外壳给的 `[data-role="view"]` 容器
 * @param {{ onInput?: () => void, onSelectionChange?: () => void }} [opts] 内容变化 / 选中格变化回调
 * @returns {object} 视图实例（load / read / clear / focus / dispose / metric / ribbon /
 *          command / state / canUndo / canRedo / undo / redo / applyEdit）
 */
export function createView(viewEl, opts = {}) {
    useStyle(import.meta.url, "view-excel.css");
    const onInput = typeof opts.onInput === "function" ? opts.onInput : () => {};
    const onSelectionChange = typeof opts.onSelectionChange === "function" ? opts.onSelectionChange : () => {};

    /** 模型：rows 与 styles 始终同矩形（padded 时两者都是空数组，占位网格不落进模型） */
    let name = EMPTY_NAME;
    let rows = [];
    let styles = [];
    let padded = true;
    let gridRows = PAD_ROWS;
    let gridCols = PAD_COLS;

    /** 显示矩阵：公式已求值，只喂渲染，不进模型 */
    let shown = [];
    let formulaErrors = 0;

    /** 纯视图状态（不写进模型、不影响保存）：列宽 + 网格线开关 + 缩放档位 */
    const colWidths = [];
    let gridlines = true;
    let zoom = 100;

    let sel = { x: 0, y: 0 };
    let editing = false;
    let drag = null;
    let disposed = false;

    /* 撤销栈：快照 = { rows, styles, padded, gridRows, gridCols }。
       维度也进快照，于是撤销「插入 5 行」能把网格一起缩回去。 */
    const undoStack = [];
    const redoStack = [];
    let mergeKey = null;
    let mergeAt = 0;

    let cells = [];
    let colHeads = [];
    let rowHeads = [];
    let selEl = null;
    let selColHead = null;
    let selRowHead = null;

    /** 监听登记表：注册与 dispose 逐条对账（委托 / 编辑器 / 拖列宽都走它） */
    const bound = [];
    const listen = (node, type, handler) => {
        node.addEventListener(type, handler);
        bound.push([node, type, handler]);
    };

    const root = el("div", "excel-view");

    /* ── 地址栏：坐标 + 原始内容 + 公式错误计数 ── */
    const namebar = el("div", "excel-namebar");
    const addrBox = el("span", "excel-addr");
    const rawBox = el("span", "excel-raw");
    const errBox = el("span", "excel-err");
    errBox.hidden = true;
    namebar.append(addrBox, rawBox, errBox);

    const grid = el("div", "excel-grid");
    grid.tabIndex = 0;
    const table = el("div", "excel-table");
    const editor = el("input", "excel-editor");
    editor.type = "text";
    editor.spellcheck = false;
    editor.hidden = true;
    grid.appendChild(table);
    root.append(namebar, grid);
    viewEl.appendChild(root);

    const cellAt = (x, y) => (rows[y] && rows[y][x]) || "";
    const styleAt = (x, y) => (styles[y] && styles[y][x]) || null;
    const cellEl = (x, y) => cells[y * gridCols + x] || null;

    /** 显示值：已求值 + 已按 format 格式化（永远不回写 rows） */
    function displayAt(x, y) {
        const row = shown[y];
        const base = row && row[x] !== undefined ? row[x] : cellAt(x, y);
        const st = styleAt(x, y);
        return formatCell(base, st && st.format);
    }

    /** 重算显示矩阵（公式 + 错误计数）；结构不变时配合 repaintAll 用，省掉整表重建。
     *  错误计数只在地址栏的 `excel-err` 上显示，不抢状态栏（状态栏留给保存去向这类要紧话）。 */
    function recompute() {
        const res = evaluateFormulas({ rows });
        shown = res.ok;
        formulaErrors = res.errors;
    }

    /** 模型矩形化到当前网格尺寸，styles 同步跟上（保持同矩形这条铁律） */
    function resizeBoth() {
        rows = rectangularize(rows, gridCols, gridRows);
        styles = fitStyleRect(styles, gridRows, gridCols);
    }

    function applyTemplate() {
        const parts = [];
        for (let x = 0; x < gridCols; x++) parts.push(`calc(${colWidths[x] || DEFAULT_COL_W}px * var(--excel-zoom, 1))`);
        table.style.gridTemplateColumns = `calc(46px * var(--excel-zoom, 1)) ${parts.join(" ")}`;
    }

    /** 占位网格落进模型（首次写入 / 扩格 / 单元格命令时物化 12×6） */
    function materialize() {
        if (!padded) return;
        padded = false;
        rows = rectangularize([], gridCols, gridRows);
        styles = rectangularizeStyles([], gridCols, gridRows);
    }

    /** 确保模型与网格覆盖 (x, y)，不够就扩行 / 扩列并重渲染 */
    function ensureCell(x, y) {
        materialize();
        if (x >= gridCols || y >= gridRows) {
            gridCols = Math.max(gridCols, x + 1);
            gridRows = Math.max(gridRows, y + 1);
            resizeBoth();
            render();
        }
    }

    /* ── 渲染 ── */

    function render() {
        table.replaceChildren();
        colHeads = [];
        rowHeads = [];
        cells = [];

        table.appendChild(el("div", "excel-corner"));
        for (let x = 0; x < gridCols; x++) {
            const head = el("div", "excel-colhead", colName(x));
            head.dataset.col = String(x);
            const resizer = el("div", "excel-resizer");
            resizer.dataset.resize = String(x);
            head.appendChild(resizer);
            table.appendChild(head);
            colHeads.push(head);
        }
        for (let y = 0; y < gridRows; y++) {
            const head = el("div", "excel-rowhead", String(y + 1));
            head.dataset.rowhead = String(y);
            table.appendChild(head);
            rowHeads.push(head);
            for (let x = 0; x < gridCols; x++) {
                const cell = el("div", "excel-cell");
                cell.dataset.cell = String(x);
                cell.dataset.row = String(y);
                table.appendChild(cell);
                cells.push(cell);
                paintNode(cell, x, y);
            }
        }
        table.appendChild(editor);
        applyTemplate();
        selEl = null;
        selColHead = null;
        selRowHead = null;
        applySel();
    }

    /**
     * 把一格的显示值与样式落到格子元素上。
     * 字体 / 对齐 / 换行走类名（可主题化、深色模式能覆盖），
     * 只有 color / fill 这两个任意取值写内联样式。
     * @param {HTMLElement} cell 格子元素
     * @param {number} x 列
     * @param {number} y 行
     * @returns {void}
     */
    function paintNode(cell, x, y) {
        const text = displayAt(x, y);
        if (cell.textContent !== text) cell.textContent = text;
        const st = styleAt(x, y);
        const on = (flag) => !!(st && st[flag]);
        cell.classList.toggle("is-bold", on("bold"));
        cell.classList.toggle("is-italic", on("italic"));
        cell.classList.toggle("is-underline", on("underline"));
        cell.classList.toggle("is-strike", on("strike"));
        cell.classList.toggle("is-wrap", on("wrap"));
        const align = st && st.align;
        cell.classList.toggle("is-left", align === "left");
        cell.classList.toggle("is-center", align === "center");
        cell.classList.toggle("is-right", align === "right");
        // 标准对齐（align=null）时数字靠右、文本靠左 —— 跟 Excel 一致
        cell.classList.toggle("is-num", !align && NUM_RE.test(text));
        cell.style.color = st && st.color ? st.color : "";
        cell.style.backgroundColor = st && st.fill ? st.fill : "";
    }

    /** 只重画内容层（不重建 DOM）：单格改动与样式改动走这条快路 */
    function repaintAll() {
        for (let y = 0; y < gridRows; y++) {
            for (let x = 0; x < gridCols; x++) paintCell(x, y);
        }
        paintNamebar();
    }

    function paintCell(x, y) {
        const cell = cellEl(x, y);
        if (cell) paintNode(cell, x, y);
    }

    function applySel() {
        if (selEl) selEl.classList.remove("is-sel");
        if (selColHead) selColHead.classList.remove("is-head");
        if (selRowHead) selRowHead.classList.remove("is-head");
        selEl = cellEl(sel.x, sel.y);
        selColHead = colHeads[sel.x] || null;
        selRowHead = rowHeads[sel.y] || null;
        if (selEl) selEl.classList.add("is-sel");
        if (selColHead) selColHead.classList.add("is-head");
        if (selRowHead) selRowHead.classList.add("is-head");
        paintNamebar();
    }

    /** 地址栏：`B3` + 原始内容（公式显示 `=...`，让用户看得见存的是什么） */
    function paintNamebar() {
        addrBox.textContent = `${colName(sel.x)}${sel.y + 1}`;
        rawBox.textContent = cellAt(sel.x, sel.y);
        if (formulaErrors) {
            errBox.hidden = false;
            errBox.textContent = t("excel.formulaErrors", "公式错误 {n} 处").replace("{n}", String(formulaErrors));
        } else {
            errBox.hidden = true;
            errBox.textContent = "";
        }
    }

    /** 移动选中；越过后沿由 ensureCell 自动补行 / 补列 */
    function moveTo(x, y) {
        if (x < 0 || y < 0) return;
        if (x >= gridCols || y >= gridRows) ensureCell(x, y);
        if (x === sel.x && y === sel.y) { applySel(); return; }
        sel = { x, y };
        applySel();
        onSelectionChange();
        if (selEl && selEl.scrollIntoView) selEl.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    /** 选中格变了但坐标没变（例如 load / undo）也要让外壳刷一次功能区状态 */
    function resyncSelection() {
        applySel();
        onSelectionChange();
    }

    function beginEdit(seed) {
        if (editing) return;
        const cell = cellEl(sel.x, sel.y);
        if (!cell) return;
        editing = true;
        cell.classList.add("is-editing");
        // 编辑器里永远给原文（公式也是原文），不是算出来的显示值
        editor.value = seed === undefined ? cellAt(sel.x, sel.y) : String(seed);
        editor.style.left = cell.offsetLeft + "px";
        editor.style.top = cell.offsetTop + "px";
        editor.style.width = cell.offsetWidth + "px";
        editor.style.height = cell.offsetHeight + "px";
        editor.hidden = false;
        editor.focus();
        const n = editor.value.length;
        editor.setSelectionRange(n, n);
    }

    /** 结束编辑：commit 写回模型（必要时扩格），move 指定提交后的跳转方向 */
    function endEdit(commit, move) {
        if (!editing) return;
        editing = false;
        const text = editor.value;
        editor.hidden = true;
        editor.value = "";
        const cell = cellEl(sel.x, sel.y);
        if (cell) cell.classList.remove("is-editing");
        if (!commit) {
            applySel();
            grid.focus({ preventScroll: true });
            return;
        }
        setValue(sel.x, sel.y, text, `edit:${sel.x}:${sel.y}`);
        if (move === "down") moveTo(sel.x, sel.y + 1);
        else if (move === "right") moveTo(sel.x + 1, sel.y);
        else if (move === "left") moveTo(sel.x - 1, sel.y);
        else applySel();
        if (!disposed) grid.focus({ preventScroll: true });
    }

    /** 写一格原文（进历史，可按 key 合并） */
    function setValue(x, y, text, key) {
        beforeChange(key === undefined ? null : key);
        ensureCell(x, y);
        rows[y][x] = text;
        recompute();
        repaintAll();
        onInput();
    }

    /* ── 历史 ── */

    /** 拍一份可编辑状态快照（rows/styles 深拷贝，改模型不会污染历史） */
    function snapshot() {
        return {
            rows: rows.map((row) => row.slice()),
            styles: styles.map((row) => row.map((st) => (st ? { ...st } : null))),
            padded,
            gridRows,
            gridCols,
        };
    }

    /**
     * 改动前入栈。
     * @param {string|null} key 合并标识：同一 key 且距上次不足 COALESCE_MS 则并入同一步；
     *        传 null 表示离散动作（结构性命令、样式命令），永不合并
     * @returns {void}
     */
    function beforeChange(key) {
        const now = Date.now();
        const mergeable = !!key && key === mergeKey && now - mergeAt < COALESCE_MS;
        if (!mergeable) {
            undoStack.push(snapshot());
            if (undoStack.length > HISTORY_MAX) undoStack.shift();
            redoStack.length = 0;
        }
        mergeKey = key || null;
        mergeAt = now;
    }

    /** 把快照写回模型（维度一起还原，colWidths 属视图状态不动） */
    function restore(snap) {
        rows = snap.rows.map((row) => row.slice());
        styles = snap.styles.map((row) => row.map((st) => (st ? { ...st } : null)));
        padded = !!snap.padded;
        gridRows = snap.gridRows;
        gridCols = snap.gridCols;
        recompute();
        render();
    }

    function canUndo() {
        return undoStack.length > 0;
    }

    function canRedo() {
        return redoStack.length > 0;
    }

    function undo() {
        if (!undoStack.length) return;
        redoStack.push(snapshot());
        if (redoStack.length > HISTORY_MAX) redoStack.shift();
        restore(undoStack.pop());
        mergeKey = null;
        clampSel();
        resyncSelection();
        onInput();
    }

    function redo() {
        if (!redoStack.length) return;
        undoStack.push(snapshot());
        if (undoStack.length > HISTORY_MAX) undoStack.shift();
        restore(redoStack.pop());
        mergeKey = null;
        clampSel();
        resyncSelection();
        onInput();
    }

    /** 模型缩回去之后把选中格拉回范围内 */
    function clampSel() {
        sel = { x: Math.min(sel.x, Math.max(0, gridCols - 1)), y: Math.min(sel.y, Math.max(0, gridRows - 1)) };
    }

    /* ── 样式写入 ── */

    /**
     * 改选中格的样式：一次一条历史，改完重画（样式影响显示，比如 format）。
     * 占位网格上的空格也能刷格式 —— materialize 会把它落进模型；read() 的裁尾
     * 保证「全空的 12×6」不会带着样式落进文件（空表仍导出空表）。
     * @param {(st: object) => void} mutate 就地改样式对象
     * @returns {boolean} 是否生效
     */
    function editStyle(mutate) {
        beforeChange(null);
        materialize();
        const cur = styles[sel.y][sel.x];
        const st = cur ? { ...cur } : {
            bold: false, italic: false, underline: false, strike: false,
            color: null, fill: null, align: null, wrap: false, format: null,
        };
        mutate(st);
        // 全默认折叠回 null，模型里不留空壳
        styles[sel.y][sel.x] = isBlankStyle(st) ? null : st;
        recompute();
        repaintAll();
        onInput();
        return true;
    }

    function toggleFlag(flag) {
        return editStyle((st) => { st[flag] = !st[flag]; });
    }

    function setColor(value) {
        if (value === undefined) return;
        const hex = typeof value === "string" && HEX_RE.test(value) ? value.toUpperCase() : null;
        return editStyle((st) => { st.color = hex; });
    }

    function setFill(value) {
        if (value === undefined) return;
        const hex = typeof value === "string" && HEX_RE.test(value) ? value.toUpperCase() : null;
        return editStyle((st) => { st.fill = hex; });
    }

    function setAlign(target) {
        // 互斥 toggle：点已生效的那一档等于取消对齐（回到标准对齐）
        return editStyle((st) => { st.align = st.align === target ? null : target; });
    }

    function setFormat(value) {
        if (value === undefined) return;
        // "" 是菜单里的「常规」，模型里存 null；其余格式串原样存
        const fmt = typeof value === "string" && value ? value : null;
        return editStyle((st) => { st.format = fmt; });
    }

    /** 只清格式、留内容 */
    function clearFormat() {
        beforeChange(null);
        materialize();
        styles[sel.y][sel.x] = null;
        recompute();
        repaintAll();
        onInput();
        return true;
    }

    /** 内容与格式一起清 */
    function clearContents() {
        beforeChange(null);
        materialize();
        rows[sel.y][sel.x] = "";
        styles[sel.y][sel.x] = null;
        recompute();
        repaintAll();
        onInput();
        return true;
    }

    /* ── 结构性命令（styles 必须与 rows 同步移动，最容易漏的就是这一类） ── */

    const blankRow = () => new Array(gridCols).fill("");
    const blankStyleRow = () => new Array(gridCols).fill(null);

    /** 在 at 行之前插 count 行（整行整列地插，不留参差） */
    function insertRowsAt(at, count) {
        if (!(count > 0)) return;
        beforeChange(null);
        materialize();
        const y = Math.max(0, Math.min(at, gridRows));
        for (let i = 0; i < count; i++) {
            rows.splice(y, 0, blankRow());
            styles.splice(y, 0, blankStyleRow());
        }
        gridRows += count;
        sel = { x: sel.x, y };
        recompute();
        render();
        resyncSelection();
        onInput();
        return true;
    }

    /** 在 at 列之前插 count 列：每一行与每一行样式都要按 count 补格 */
    function insertColsAt(at, count) {
        if (!(count > 0)) return;
        beforeChange(null);
        materialize();
        const x = Math.max(0, Math.min(at, gridCols));
        const fresh = new Array(count).fill("");
        const freshStyles = new Array(count).fill(null);
        for (let y = 0; y < rows.length; y++) {
            rows[y].splice(x, 0, ...fresh);
            styles[y].splice(x, 0, ...freshStyles);
        }
        // 列宽跟着列走：新列用默认宽（插进来的列不该继承右边的宽）
        colWidths.splice(x, 0, ...new Array(count).fill(null));
        gridCols += count;
        sel = { x, y: sel.y };
        recompute();
        render();
        resyncSelection();
        onInput();
        return true;
    }

    /** 删一行。返回值语义见 command()：空表上是「认得但做不了」，不是未实现。 */
    function deleteRowAt(at) {
        if (!rows.length) {
            note(t("excel.noRowsToDelete", "空表没有可删除的行"));
            return;
        }
        beforeChange(null);
        rows.splice(at, 1);
        styles.splice(at, 1);
        gridRows = rows.length;
        if (!gridRows) return collapseEmpty();
        sel = { x: sel.x, y: Math.max(0, Math.min(at, gridRows - 1)) };
        recompute();
        render();
        resyncSelection();
        onInput();
        return true;
    }

    function deleteColAt(at) {
        if (!rows.length) {
            note(t("excel.noColsToDelete", "空表没有可删除的列"));
            return;
        }
        beforeChange(null);
        for (let y = 0; y < rows.length; y++) {
            rows[y].splice(at, 1);
            styles[y].splice(at, 1);
        }
        colWidths.splice(at, 1);
        gridCols = rows[0].length;
        if (!gridCols) return collapseEmpty();
        sel = { x: Math.max(0, Math.min(at, gridCols - 1)), y: sel.y };
        recompute();
        render();
        resyncSelection();
        onInput();
        return true;
    }

    /** 删到没有行列了：退回占位空表（网格不能是 0×N，选中格会无处安放） */
    function collapseEmpty() {
        rows = [];
        styles = [];
        padded = true;
        gridRows = PAD_ROWS;
        gridCols = PAD_COLS;
        sel = { x: 0, y: 0 };
        recompute();
        render();
        resyncSelection();
        onInput();
        return true;
    }

    /**
     * 自动求和：把选中格设为 `=SUM(上方连续数字区间)`。
     * 「连续」指从上一格起向上直到遇到非数字或空为止；写成区域形式（哪怕只有一格），
     * 便于用户再往外拖。求值与显示立刻跟上（setValue 里 recompute + repaint）。
     * @returns {boolean|undefined} 生效 / 上方没有数字（认得但做不了）
     */
    function insertSum() {
        materialize();
        let top = sel.y - 1;
        let seen = 0;
        while (top >= 0 && NUM_RE.test(cellAt(sel.x, top))) { top--; seen++; }
        if (!seen) {
            note(t("excel.noSumRange", "选中格上方没有连续的数字区域"));
            return;
        }
        const col = colName(sel.x);
        const from = top + 2; // top 已停在区间上方的第一格
        const formula = `=SUM(${col}${from}:${col}${sel.y})`;
        setValue(sel.x, sel.y, formula, null);
        note(t("excel.writtenFormula", "已写入 {f}").replace("{f}", () => formula));
        return true;
    }

    /** 向下填充：把选中格上方一格的**原文**抄下来（公式一起抄，样式不动） */
    function fillDown() {
        if (sel.y === 0) {
            note(t("excel.nothingAbove", "第一格上面没有内容"));
            return;
        }
        setValue(sel.x, sel.y, cellAt(sel.x, sel.y - 1), null);
        return true;
    }

    /**
     * 以当前列为键对全表排序，**行内容与样式一起移动**。
     * 口径：数字按数值比（公式格按算出来的值比），非数字一律按码位字典序 —— 刻意不走
     * localeCompare，后者会按拼音给中文排序，跟「与拼音无关」的约定相反。
     * 空格恒排末尾（Excel 也这样）。首行不当表头：模型里没有表头信息，猜了更容易错。
     * @param {boolean} desc 是否降序
     * @returns {boolean|undefined} 生效 / 不足两行（认得但做不了）
     */
    function sortRows(desc) {
        if (rows.length < 2) {
            note(t("excel.noRowsToSort", "没有可排序的行"));
            return;
        }
        beforeChange(null);
        const x = sel.x;
        const keyOf = (y) => {
            const row = shown[y] && shown[y][x] !== undefined ? shown[y][x] : cellAt(x, y);
            const text = String(row == null ? "" : row);
            return { text, num: NUM_RE.test(text) ? Number(text) : null };
        };
        const order = rows.map((_, y) => y);
        const keys = rows.map((_, y) => keyOf(y));
        order.sort((a, b) => {
            const ka = keys[a];
            const kb = keys[b];
            if (!ka.text && !kb.text) return 0;
            if (!ka.text) return 1;
            if (!kb.text) return -1;
            let d;
            if (ka.num !== null && kb.num !== null) d = ka.num - kb.num;
            else if (ka.num !== null) d = -1;
            else if (kb.num !== null) d = 1;
            else d = ka.text < kb.text ? -1 : ka.text > kb.text ? 1 : 0;
            return desc ? -d : d;
        });
        rows = order.map((y) => rows[y]);
        styles = order.map((y) => styles[y] ? styles[y].slice() : blankStyleRow());
        recompute();
        render();
        resyncSelection();
        onInput();
        return true;
    }

    /* ── 状态与提示 ── */

    /** 向外壳的状态栏（`[data-role="note"]`）提示，找不到就退回控制台 */
    function note(msg) {
        const host = viewEl.closest(".office");
        const slot = host ? host.querySelector('[data-role="note"]') : null;
        if (slot) slot.textContent = msg;
        else console.warn("[excel]", msg);
    }

    function copySel() {
        const text = cellAt(sel.x, sel.y);
        try {
            navigator.clipboard.writeText(text).catch((err) => {
                console.warn("[excel] 复制失败：", err);
                note(t("excel.copyFailed", "复制失败"));
            });
        } catch (err) {
            console.warn("[excel] 复制失败：", err);
            note(t("excel.copyFailed", "复制失败"));
        }
    }

    /* ── 事件：全部委托在网格容器上，格子零监听 ── */

    function onGridMousedown(e) {
        const resizer = e.target.closest("[data-resize]");
        if (resizer) {
            startDrag(e, Number(resizer.dataset.resize));
            return;
        }
        const cell = e.target.closest("[data-cell]");
        if (!cell) return;
        if (editing) endEdit(true, null);
        moveTo(Number(cell.dataset.cell), Number(cell.dataset.row));
        grid.focus({ preventScroll: true });
    }

    function onGridDblclick(e) {
        const cell = e.target.closest("[data-cell]");
        if (!cell) return;
        sel = { x: Number(cell.dataset.cell), y: Number(cell.dataset.row) };
        applySel();
        onSelectionChange();
        beginEdit();
    }

    function onGridKeydown(e) {
        if (editing || e.isComposing) return;
        const k = e.key;
        if ((e.ctrlKey || e.metaKey) && (k === "c" || k === "C")) {
            e.preventDefault();
            copySel();
            return;
        }
        switch (k) {
            case "ArrowUp": e.preventDefault(); moveTo(sel.x, sel.y - 1); break;
            case "ArrowDown": e.preventDefault(); moveTo(sel.x, sel.y + 1); break;
            case "ArrowLeft": e.preventDefault(); moveTo(sel.x - 1, sel.y); break;
            case "ArrowRight": e.preventDefault(); moveTo(sel.x + 1, sel.y); break;
            case "Tab": e.preventDefault(); moveTo(sel.x + (e.shiftKey ? -1 : 1), sel.y); break;
            case "Enter": e.preventDefault(); beginEdit(); break;
            case "F2": e.preventDefault(); beginEdit(); break;
            case "Delete":
            case "Backspace": {
                // Delete 只清内容（Excel 的默认口径），格式交给「清除全部 / 清除格式」
                e.preventDefault();
                setValue(sel.x, sel.y, "", null);
                break;
            }
            case "Escape":
                grid.blur();
                break;
            default:
                if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.preventDefault();
                    beginEdit(k);
                }
        }
    }

    function onGridPaste(e) {
        const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
        if (!text || editing) return;
        e.preventDefault();
        beforeChange(null);
        const lines = text.replace(/\r\n?/g, "\n").split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        let maxCols = 1;
        const block = lines.map((line) => {
            const parts = line.split("\t");
            if (parts.length > maxCols) maxCols = parts.length;
            return parts;
        });
        ensureCell(sel.x + maxCols - 1, sel.y + block.length - 1);
        for (let r = 0; r < block.length; r++) {
            for (let c = 0; c < block[r].length; c++) {
                // 粘的是纯文本：只动内容，原格的样式保留（带格式粘贴板不在这一版范围）
                rows[sel.y + r][sel.x + c] = block[r][c];
            }
        }
        recompute();
        render();
        moveTo(sel.x + maxCols - 1, sel.y + block.length - 1);
        onInput();
    }

    function onEditorKeydown(e) {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); endEdit(true, "down"); }
        else if (e.key === "Tab") { e.preventDefault(); endEdit(true, e.shiftKey ? "left" : "right"); }
        else if (e.key === "Escape") { e.preventDefault(); endEdit(false, null); }
    }

    function onEditorBlur() {
        endEdit(true, null);
    }

    /* ── 列宽拖拽（视图状态，不进模型也不进历史） ── */

    function startDrag(e, x) {
        e.preventDefault();
        drag = { x, startX: e.clientX, startW: colWidths[x] || DEFAULT_COL_W };
        root.classList.add("is-resizing");
        window.addEventListener("mousemove", onDragMove);
        window.addEventListener("mouseup", onDragEnd);
    }

    function onDragMove(e) {
        if (!drag) return;
        // 拖拽的像素差要按缩放档位折算，否则 140% 下手感会偏快
        const scale = zoom / 100;
        const w = Math.min(MAX_COL_W, Math.max(MIN_COL_W, drag.startW + (e.clientX - drag.startX) / scale));
        colWidths[drag.x] = w;
        applyTemplate();
    }

    function onDragEnd() {
        drag = null;
        root.classList.remove("is-resizing");
        window.removeEventListener("mousemove", onDragMove);
        window.removeEventListener("mouseup", onDragEnd);
    }

    /* ── 功能区 ── */

    /**
     * 声明本视图的标签页与控件。
     * @returns {Array<object>} ribbon 结构
     */
    function ribbon() {
        return TABS();
    }

    /**
     * 控件状态：以选中格为准（撤销 / 重做不做按下态，网格线 / 缩放是全局视图态）。
     * @returns {object} id -> 值
     */
    function state() {
        const st = styleAt(sel.x, sel.y) || {};
        const out = {
            "xl.bold": !!st.bold,
            "xl.italic": !!st.italic,
            "xl.underline": !!st.underline,
            "xl.strike": !!st.strike,
            "xl.wrap": !!st.wrap,
            "xl.color": st.color || "",
            "xl.fill": st.fill || "",
            "xl.alignLeft": st.align === "left",
            "xl.alignCenter": st.align === "center",
            "xl.alignRight": st.align === "right",
            "xl.format": st.format || "",
            "xl.gridlines": gridlines,
            "xl.zoom": String(zoom),
        };
        return out;
    }

    /**
     * 执行一条功能区命令。三态返回：
     * - `false` —— 本视图不认这个 id（外壳据此提示「未实现的命令」并让出兜底）
     * - `undefined` —— 认得但这次没做成（空表删行、首格下填），已用状态栏说明
     * - `true` —— 改了模型
     * @param {string} id 命令 id
     * @param {string|undefined} value 下拉控件的当前取值
     * @returns {boolean|undefined} 处理结果
     */
    function command(id, value) {
        switch (id) {
            case "xl.undo": undo(); return;
            case "xl.redo": redo(); return;
            case "xl.bold": return toggleFlag("bold");
            case "xl.italic": return toggleFlag("italic");
            case "xl.underline": return toggleFlag("underline");
            case "xl.strike": return toggleFlag("strike");
            case "xl.color": return setColor(value);
            case "xl.fill": return setFill(value);
            case "xl.clear": return clearFormat();
            case "xl.clearContents": return clearContents();
            case "xl.wrap": return toggleFlag("wrap");
            case "xl.format": return setFormat(value);
            case "xl.sum": return insertSum();
            case "xl.insertRowBelow": return insertRowsAt(sel.y + 1, 1);
            case "xl.insertColRight": return insertColsAt(sel.x + 1, 1);
            case "xl.deleteRow": return deleteRowAt(sel.y);
            case "xl.deleteCol": return deleteColAt(sel.x);
            case "xl.rows5": return insertRowsAt(sel.y + 1, 5);
            case "xl.cols3": return insertColsAt(sel.x + 1, 3);
            case "xl.fillDown": return fillDown();
            case "xl.sortAsc": return sortRows(false);
            case "xl.sortDesc": return sortRows(true);
            case "xl.gridlines":
                // 视图态：不进撤销栈（跟列宽同一类，改了不该让文档变脏）
                gridlines = !gridlines;
                root.classList.toggle("no-gridlines", !gridlines);
                return;
            case "xl.zoom": {
                // 缩放刻意不用 CSS `zoom`：见 view-excel.css 的 --excel-zoom 注释
                const level = Math.round(Number(value));
                if (!(level > 0)) return;
                zoom = Math.min(140, Math.max(80, level));
                root.style.setProperty("--excel-zoom", String(zoom / 100));
                applyTemplate();
                repaintAll();
                return;
            }
            default:
                if (ALIGN_COMMANDS[id]) return setAlign(ALIGN_COMMANDS[id]);
                return false;
        }
    }

    /**
     * 外壳（查找替换之类）批量改模型的唯一入口：改动照样进撤销栈，越界自动矩形化。
     * @param {(model: ExcelModel) => void} mutate 就地改模型
     * @returns {void}
     */
    function applyEdit(mutate) {
        if (typeof mutate !== "function") return;
        const draft = read();
        const depth = undoStack.length;
        beforeChange(null);
        try {
            mutate(draft);
        } catch (err) {
            // 改坏了就把刚压进去的快照退回来，别留一条什么都没改的历史
            while (undoStack.length > depth) undoStack.pop();
            throw err;
        }
        adopt(draft);
        mergeKey = null;
        recompute();
        render();
        resyncSelection();
        onInput();
    }

    /* ── 对外 API ── */

    /** 把外来模型洗进内部状态（rows / styles 同矩形，空模型退回占位网格） */
    function adopt(model) {
        endEdit(false, null);
        const src = model && Array.isArray(model.rows) ? model.rows : [];
        const srcStyles = model && Array.isArray(model.styles) ? model.styles : [];
        name = model && typeof model.name === "string" && model.name ? model.name : EMPTY_NAME;
        const rect = rectangularize(src);
        if (rect.length === 0) {
            padded = true;
            rows = [];
            styles = [];
            gridRows = PAD_ROWS;
            gridCols = PAD_COLS;
        } else {
            padded = false;
            gridRows = rect.length;
            gridCols = Math.max(rect[0].length, 1);
            rows = rectangularize(rect, gridCols, gridRows);
            styles = fitStyleRect(srcStyles, gridRows, gridCols);
        }
        sel = { x: 0, y: 0 };
        recompute();
    }

    /**
     * 载入模型（换文档）：撤销栈清空 —— 历史不跨文档；
     * 列宽 / 缩放 / 网格线是视图偏好，保留（用户不会因为换个表就重设缩放）。
     * @param {ExcelModel} model 工作表
     * @returns {void}
     */
    function load(model) {
        adopt(model);
        undoStack.length = 0;
        redoStack.length = 0;
        mergeKey = null;
        render();
        resyncSelection();
    }

    /**
     * 导出模型：rows 是原文（公式照 `=` 存），styles 与裁尾后的 rows 同矩形。
     * @returns {ExcelModel} 工作表
     */
    function read() {
        const trimmed = trimTrailing(rows);
        return { name, rows: trimmed, styles: trimTrailingStyles(styles, rows) };
    }

    function clear() {
        load({ name: EMPTY_NAME, rows: [], styles: [] });
    }

    function focus() {
        grid.focus();
    }

    function metric() {
        const data = trimTrailing(rows);
        return t("excel.size", "{r} 行 × {c} 列")
            .replace("{r}", String(data.length))
            .replace("{c}", String(data.length ? data[0].length : 0));
    }

    /**
     * 解绑全部监听（委托 / 编辑器 / 拖列宽）并移除界面。
     * @returns {void}
     */
    function dispose() {
        if (disposed) return;
        disposed = true;
        endEdit(false, null);
        for (const [node, type, handler] of bound) node.removeEventListener(type, handler);
        bound.length = 0;
        // 拖拽中途关窗：window 上那两个监听是临时挂的，必须一起摘
        if (drag) onDragEnd();
        viewEl.replaceChildren();
        cells = [];
        colHeads = [];
        rowHeads = [];
        selEl = null;
        selColHead = null;
        selRowHead = null;
    }

    listen(grid, "mousedown", onGridMousedown);
    listen(grid, "dblclick", onGridDblclick);
    listen(grid, "keydown", onGridKeydown);
    listen(grid, "paste", onGridPaste);
    listen(editor, "keydown", onEditorKeydown);
    listen(editor, "blur", onEditorBlur);

    recompute();
    render();

    return { load, read, clear, focus, dispose, metric, ribbon, command, state, canUndo, canRedo, undo, redo, applyEdit };
}
