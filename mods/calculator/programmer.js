/** programmer.js — 程序员模式纯逻辑（零 import / 零 DOM，供 dev/calc-programmer-check.mjs 断言）；内部值一律 64 位无符号 BigInt，所有函数绝不抛异常（调用点在按键监听里，抛错会连错误态都显示不出）。 */

export const WORD_BITS = 64;
export const RADIXES = [8, 10, 16];

/** 位网格每组位数与组数：macOS 程序员模式是 16 组 × 4 位 */
export const GROUP_BITS = 4;
export const GROUP_COUNT = WORD_BITS / GROUP_BITS;

/** 供 UI 渲染键位表；位移/旋转的位移数都按无符号值对 64 取模 */
export const OPERATORS = ["AND", "OR", "XOR", "NOR", "NAND", "<<", ">>", "RoL", "RoR", "+", "-", "*", "/", "mod"];
export const UNARY_OPERATORS = ["NOT", "NEG"];

const WORD_BITS_BIG = BigInt(WORD_BITS);
const MASK = (1n << WORD_BITS_BIG) - 1n;
const DIGITS = "0123456789ABCDEF";
// 长度粗筛：位数多于该进制下 2^64-1 的位数就必然溢出；临界长度仍要 parseExact 精判
const DIGITS_PER_WORD = { 8: 22, 10: 20, 16: 16 };
const BACKSPACE_KEYS = new Set(["⌫", "backspace", "del"]);
const SHIFT_KINDS = new Set(["<<", ">>", "RoL", "RoR"]);

// 每组最低位的位号，groups[0] 是最高 4 位
const GROUP_LOW_BITS = [];
for (let i = 0; i < GROUP_COUNT; i += 1) GROUP_LOW_BITS.push(WORD_BITS - 1 - i * GROUP_BITS - (GROUP_BITS - 1));

// macOS 只在 16 位段的两侧标位号：段首标最高位、段尾标最低位，故得 63/48/47/32/31/16/15/0
const BOUNDARY_LABELS = [];
for (let k = 0; k < 4; k += 1) {
    BOUNDARY_LABELS.push({ group: k * 4, bit: 63 - k * 16 });
    BOUNDARY_LABELS.push({ group: k * 4 + 3, bit: 48 - k * 16 });
}

const CONTROL_NAMES = {
    0: "NUL", 1: "SOH", 2: "STX", 3: "ETX", 4: "EOT", 5: "ENQ", 6: "ACK", 7: "BEL",
    8: "BS", 9: "TAB", 10: "LF", 11: "VT", 12: "FF", 13: "CR", 14: "SO", 15: "SI",
    16: "DLE", 17: "DC1", 18: "DC2", 19: "DC3", 20: "DC4", 21: "NAK", 22: "SYN", 23: "ETB",
    24: "CAN", 25: "EM", 26: "SUB", 27: "ESC", 28: "FS", 29: "GS", 30: "RS", 31: "US",
    32: "SPACE", 127: "DEL", 160: "NBSP", 173: "SHY",
};

// 有码位但「看不出来」的空白类：给字形，UI 仍可拿 label 兜底
const NAMED_GLYPH_CODES = new Set([32, 160]);

/* ───────────────────────── 内部工具 ───────────────────────── */

/** 输入归一：BigInt / 有限数（小数向零截断）/ 十进制数字串；其余 null */
function asBig(value) {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) return null;
        return BigInt(Math.trunc(value));
    }
    // UI 手上常是显示文本，字符串按十进制解释省去每次手写 fromRadix
    if (typeof value === "string") {
        const s = value.trim();
        return /^-?\d+$/.test(s) ? BigInt(s) : null;
    }
    return null;
}

function isRadix(radix) {
    return RADIXES.includes(radix);
}

function trimZeros(text) {
    let i = 0;
    while (i < text.length && text[i] === "0") i += 1;
    return text.slice(i);
}

/** 显示文本归一：去前导零、空串归 "0"；不校验字符合法性（非法字符进不了显示） */
function normalizeText(text) {
    if (typeof text !== "string") return "0";
    const s = trimZeros(text.trim().toUpperCase());
    return s === "" ? "0" : s;
}

/** 严格解析：合法返回未回绕 BigInt，非法返回 null */
function parseExact(text, radix) {
    if (!isRadix(radix)) return null;
    if (typeof text === "bigint" || typeof text === "number") {
        const v = asBig(text);
        return v === null || v < 0n ? null : v;
    }
    if (typeof text !== "string") return null;
    const s = text.trim().toUpperCase();
    if (s === "") return null;
    const R = BigInt(radix);
    let v = 0n;
    for (const ch of s) {
        const d = DIGITS.indexOf(ch);
        if (d < 0 || d >= radix) return null;
        v = v * R + BigInt(d);
    }
    return v;
}

function rotate(word, count, left) {
    const n = ((count % WORD_BITS_BIG) + WORD_BITS_BIG) % WORD_BITS_BIG;
    if (n === 0n) return word & MASK;
    const other = WORD_BITS_BIG - n;
    return left ? ((word << n) | (word >> other)) & MASK : ((word >> n) | (word << other)) & MASK;
}

/** 向零截断的余数（跟被除数同号），除零 null */
function remainder(a, b) {
    if (b === 0n) return null;
    return a - (a / b) * b;
}

/* ───────────────────────── 进制 ───────────────────────── */

/**
 * 值 → 当前进制的大写无前缀字符串（先按 64 位无符号回绕，故 NEG 后显示为补码大数）。
 * @param {bigint|number|string} value 待显示的值
 * @param {number} [radix] 8|10|16，缺省 10
 * @returns {string|null} 进制不支持或值不可解释时 null
 */
export function toRadix(value, radix = 10) {
    if (!isRadix(radix)) return null;
    const v = asBig(value);
    if (v === null) return null;
    return wrap(v).toString(radix).toUpperCase();
}

/**
 * 文本 → 值；非法字符返回 null（不抛），超出 64 位按无符号回绕。
 * @param {string|bigint|number} text 无前缀数字串（十六进制大小写均可）
 * @param {number} [radix] 8|10|16，缺省 10
 * @returns {bigint|null}
 */
export function fromRadix(text, radix = 10) {
    const v = parseExact(text, radix);
    return v === null ? null : v & MASK;
}

/**
 * 该按键在当前进制下是否合法；多字符键（"FF"/"00"）要求每个字符都合法。
 * 注意 "00" 在八/十进制也返回 true（两个 0 本就合法），实体键只在十六进制出现，由 UI 决定渲染。
 * @param {string} digit 单字符数字键或成对键文本
 * @param {number} radix 8|10|16
 * @returns {boolean}
 */
export function isDigitAllowed(digit, radix) {
    if (typeof digit !== "string") return false;
    const s = digit.trim().toUpperCase();
    if (s === "") return false;
    for (const ch of s) {
        const d = DIGITS.indexOf(ch);
        if (d < 0 || d >= radix) return false;
    }
    return isRadix(radix);
}

/**
 * 追加输入：处理数字 / A-F / 成对键 FF|00 / 退格（"⌫"|"backspace"|"del"）。
 * 前导零一律丢弃、只留单个 "0"；越界（>64 位）或被当前进制拒绝的键**静默忽略**，返回原显示文本。
 * @param {string} currentText 当前显示文本
 * @param {string} key 按下的键
 * @param {number} [radix] 8|10|16，缺省 10
 * @returns {string} 新显示文本（永不 null，避免 UI 把输入清空）
 */
export function appendInput(currentText, key, radix = 10) {
    const cur = typeof currentText === "string" ? currentText.trim().toUpperCase() : "";
    const safe = normalizeText(cur);
    if (!isRadix(radix) || typeof key !== "string") return safe;
    const k = key.trim().toUpperCase();
    if (k === "") return safe;
    if (BACKSPACE_KEYS.has(k)) return backspace(cur, radix);
    if (!isDigitAllowed(k, radix)) return safe;
    const next = trimZeros(trimZeros(cur) + k);
    if (next === "") return "0";
    if (next.length > DIGITS_PER_WORD[radix]) return safe;
    const v = parseExact(next, radix);
    if (v === null || v > MASK) return safe;
    return next;
}

/**
 * appendInput 的成对键别名（FF / 00 这类一次进两位的键），参数顺序按「先键后现值」写，
 * 方便 UI 给成对键单独绑 handler。"FF" 只在十六进制被放行；"00" 在任何进制都只是两个 0，
 * 实体键位同样只在十六进制渲染。前导零一律丢弃：显示 "0" 时按 "00" 仍是 "0"，按 "FF" 得 "FF"。
 * @param {string} digits 成对键文本（两位）
 * @param {string} current 当前显示文本
 * @param {number} [radix] 8|10|16，缺省 16（成对键是十六进制键位）
 * @returns {string}
 */
export function appendHexPair(digits, current, radix = 16) {
    return appendInput(current, digits, radix);
}

/**
 * 退格：删一个字符，删空（或只剩前导零）归 "0"。
 * @param {string} text 当前显示文本
 * @param {number} [radix] 8|10|16，缺省 10；与 appendInput 对称，非法进制时只归一文本
 * @returns {string}
 */
export function backspace(text, radix = 10) {
    if (!isRadix(radix)) return normalizeText(text);
    const s = typeof text === "string" ? text.trim().toUpperCase() : "";
    if (normalizeText(s) === "0") return "0";
    const cut = trimZeros(s).slice(0, -1);
    return cut === "" ? "0" : cut;
}

/* ───────────────────────── 位网格 ───────────────────────── */

/**
 * 64 位按 4 位一组的网格数据：groups[0] 是最高 4 位（形如 "0001"）。
 * @param {bigint|number|string} value
 * @returns {{groups:string[], bitLabels:number[], boundaryLabels:{group:number,bit:number}[], groupBits:number}|null}
 *          bitLabels[i] = 第 i 组最低位的位号（60,56,…,0）；boundaryLabels 只给 macOS 会标出的 16 位段边界
 */
export function bitGroups(value) {
    const v = asBig(value);
    if (v === null) return null;
    const w = v & MASK;
    const groups = [];
    for (let i = 0; i < GROUP_COUNT; i += 1) {
        const nib = Number((w >> BigInt(GROUP_LOW_BITS[i])) & 0xFn);
        groups.push(nib.toString(2).padStart(GROUP_BITS, "0"));
    }
    return { groups, bitLabels: GROUP_LOW_BITS.slice(), boundaryLabels: BOUNDARY_LABELS.slice(), groupBits: GROUP_BITS };
}

/**
 * 翻转指定位（index 0 = 最低位）；越界安全返回原值。
 * @param {bigint|number|string} value
 * @param {number} index 0..63
 * @returns {bigint|null}
 */
export function toggleBit(value, index) {
    const v = asBig(value);
    if (v === null) return null;
    const w = v & MASK;
    if (!Number.isInteger(index) || index < 0 || index >= WORD_BITS) return w;
    return w ^ (1n << BigInt(index));
}

/**
 * 取指定位；越界返回 null（UI 据此不渲染该格）。
 * @param {bigint|number|string} value
 * @param {number} index 0..63
 * @returns {0|1|null}
 */
export function bitAt(value, index) {
    const v = asBig(value);
    if (v === null) return null;
    if (!Number.isInteger(index) || index < 0 || index >= WORD_BITS) return null;
    return Number((v & MASK) >> BigInt(index)) & 1;
}

/* ───────────────────────── 运算 ───────────────────────── */

/**
 * 二元运算。位移/旋转的位数取右操作数无符号值对 64 的模（移 64 位 = 移 0 位）；
 * NOR/NAND/NOT 之类取反一律在 64 位内做，故不会溢出；`/` `mod` 除零返回 null。
 * @param {bigint|number|string} a 左操作数
 * @param {string} kind AND|OR|XOR|NOR|NAND|<<|>>|RoL|RoR|+|-|*|×|/|÷|mod|%
 * @param {bigint|number|string} b 右操作数
 * @returns {bigint|null} 64 位无符号结果，非法输入或除零为 null
 */
export function binaryOp(a, kind, b) {
    const av = asBig(a);
    const bv = asBig(b);
    if (av === null || bv === null || typeof kind !== "string") return null;
    const x = av & MASK;
    const y = bv & MASK;
    if (SHIFT_KINDS.has(kind)) {
        const n = y % WORD_BITS_BIG;
        if (kind === "<<") return (x << n) & MASK;
        if (kind === ">>") return x >> n;
        return rotate(x, n, kind === "RoL");
    }
    switch (kind) {
        case "AND": return x & y;
        case "OR": return x | y;
        case "XOR": return x ^ y;
        case "NOR": return ~(x | y) & MASK;
        case "NAND": return ~(x & y) & MASK;
        case "+": return (x + y) & MASK;
        case "-": return (x - y) & MASK;
        case "*": case "×": return (x * y) & MASK;
        case "/": case "÷": {
            const q = truncateDiv(x, y);
            return q === null ? null : q & MASK;
        }
        case "mod": case "%": {
            const r = remainder(x, y);
            return r === null ? null : r & MASK;
        }
        default: return null;
    }
}

/**
 * 一元运算，只收程序员键：NOT = 64 位内按位取反；NEG = 补码取负（等价 2^64 - x）。
 * @param {bigint|number|string} a
 * @param {string} kind NOT|NEG
 * @returns {bigint|null}
 */
export function unaryOp(a, kind) {
    const v = asBig(a);
    if (v === null || typeof kind !== "string") return null;
    const w = v & MASK;
    if (kind === "NOT") return (~w) & MASK;
    if (kind === "NEG") return wrap(-w);
    return null;
}

/**
 * macOS 的 X<< / X>>：先按下的显示值是 X、下一个输入是 Y，`=` 时才真正位移。
 * 语义与 binaryOp 的 "<<" ">>" 一致（逻辑位移，空位补 0，位数对 64 取模），此函数只为把
 * 「X 已被暂存」这件事在接口上写清楚，省得 UI 传反操作数。
 * @param {bigint|number|string} x 被位移的显示值
 * @param {bigint|number|string} y 位移量
 * @param {string} direction "<<"|"left" 或 ">>"|"right"
 * @returns {bigint|null}
 */
export function shiftPair(x, y, direction) {
    if (direction === "<<" || direction === "left") return binaryOp(x, "<<", y);
    if (direction === ">>" || direction === "right") return binaryOp(x, ">>", y);
    return null;
}

/**
 * 整数截断除法（向零，苹果文档明确「99 ÷ 10 = 9 而非 10」）：按**数学整数**解释操作数，
 * 结果保留符号且不回绕，要 64 位无符号值请交给调用方 wrap（binaryOp 的 "/" 已 wrap）。
 * @param {bigint|number|string} a 被除数
 * @param {bigint|number|string} b 除数
 * @returns {bigint|null} b 为 0 或输入非法时 null
 */
export function truncateDiv(a, b) {
    const av = asBig(a);
    const bv = asBig(b);
    if (av === null || bv === null) return null;
    if (bv === 0n) return null;
    return av / bv;
}

/**
 * 64 位无符号回绕（唯一一处允许「结果一定合法」的收敛点，运算出口都过它）。
 * @param {bigint|number|string} value 任意整数，可为负
 * @returns {bigint} 0 .. 2^64-1；输入不可解释时 0n（返回 null 会让每个调用点都得判空）
 */
export function wrap(value) {
    const v = asBig(value);
    if (v === null) return 0n;
    const m = v % (1n << WORD_BITS_BIG);
    return (m < 0n ? m + (1n << WORD_BITS_BIG) : m) & MASK;
}

/* ───────────────────────── 字节序 ───────────────────────── */

/**
 * 字节反转，本模块采用的确切定义（两键语义互相独立，不可由一个推出另一个）：
 * - width=16：把 64 位词切成 4 个 16 位段，**段内高低字节互换**、段序不动 → 0x1234 → 0x3412，0x12345678 → 0x3412_7856；
 * - width=8：把整字当成 **8 个字节做整体逆序**（大端↔小端）→ 0x1234 → 0x3412_0000_0000_0000。
 * 8 位单元内部只有一个字节、无「高低」可换，所以 flip8 只能取整体逆序这条读法。
 * @param {bigint|number|string} value
 * @param {number} width 8|16，其余返回 null
 * @returns {bigint|null}
 */
export function flipBytes(value, width) {
    const v = asBig(value);
    if (v === null) return null;
    if (width !== 8 && width !== 16) return null;
    const w = v & MASK;
    if (width === 8) {
        let out = 0n;
        for (let i = 0n; i < 8n; i += 1n) out = (out << 8n) | ((w >> (8n * i)) & 0xFFn);
        return out;
    }
    let out = 0n;
    for (let lane = 0; lane < 4; lane += 1) {
        const shift = BigInt(lane * 16);
        const half = (w >> shift) & 0xFFFFn;
        out |= (((half & 0xFFn) << 8n) | (half >> 8n)) << shift;
    }
    return out;
}

/* ───────────────────────── 字符转译 ───────────────────────── */

/**
 * 码位 → 字符。永远返回对象（绝不 null/抛），UI 直接把 text 或 label 贴上即可。
 * text 为空串时说明该码位无可显示字形，应显示 label。
 * @param {bigint|number|string} value 码位
 * @param {string} table "ascii"（只 0–127）| "unicode"（0–10FFFF，跳过代理区）
 * @returns {{text:string, label:string|null, valid:boolean, hint:string|null}}
 */
export function charFor(value, table) {
    const bad = (hint) => ({ text: "", label: null, valid: false, hint });
    const kind = table === "ascii" || typeof table === "undefined" ? "ascii" : table === "unicode" ? "unicode" : null;
    if (kind === null) return bad("未知字符表");
    const code = asBig(value);
    if (code === null) return bad("无效码位");
    if (code < 0n) return bad("码位为负");
    if (kind === "ascii" && code > 127n) return bad("超出 ASCII 范围（仅 0–127）");
    if (kind === "unicode" && code > 0x10FFFFn) return bad("超出 Unicode 范围（仅 0–10FFFF）");
    // 代理区在字符串里必须成对出现，单列码位不是合法字符；不拦会从 fromCodePoint 抛出 RangeError
    if (code >= 0xD800n && code <= 0xDFFFn) return bad("代理区码位（D800–DFFF）不是有效字符");
    const cp = Number(code);
    const name = Object.prototype.hasOwnProperty.call(CONTROL_NAMES, cp) ? CONTROL_NAMES[cp] : null;
    if (name === null) return { text: String.fromCodePoint(cp), label: String.fromCodePoint(cp), valid: true, hint: null };
    // 空格/不换行空格有字形只是看不见，其余控制字符没有字形可显示 → text 留空、靠 label 表达
    const glyph = NAMED_GLYPH_CODES.has(cp) ? String.fromCodePoint(cp) : "";
    return { text: glyph, label: name, valid: true, hint: null };
}
