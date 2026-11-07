/**
 * spotlight-provider.js — 计算器的聚焦结果提供者（Provider API 的第一个实验对象）
 *
 * 由 manifest.spotlightProviders 声明，聚焦应用在首次需要时惰性 import 本模块
 * （不打开计算器也能用：engine.js / convert.js 是纯逻辑、零 DOM）。
 *
 * 两类结果：
 * 1. **算式求值**：`12*37`、`(1+2)/3`、`2^10`、`sqrt(2)`、`sin(30)`（角度制）
 *    —— 走 engine.js 的调度场求值器（CSP 安全，不 eval）。
 * 2. **单位/货币换算**：`5 km to mile`、`100 usd to cny`、`36.5 c to f`
 *    —— 走 convert.js 的离线换算表；货币是随包快照，结果行必须标出 RATE_DATE。
 *
 * 回车默认动作：**复制结果**（快速取数路径；要打开计算器本体可从 Dock/启动台进）。
 */

import { i18n } from "../../src/javascripts/i18n.js";
import { assetIcon } from "../../src/javascripts/paths.js";
import { createState, evaluateTokens, formatNumber } from "./engine.js";
import { CATEGORIES, convert, formatValue, RATE_DATE } from "./convert.js";

const CALC_ICON = assetIcon("Calculatrice");

/* ───────────────────────── 算式求值 ───────────────────────── */

/** engine.js 的一元函数名白名单（与 FUNCTIONS 表同键）。 */
const FUNC_NAMES = new Set([
    "sqrt", "cbrt", "ln", "log", "log2", "exp", "pow2", "pow3", "twoX", "pow10",
    "inv", "fact", "sin", "cos", "tan", "asin", "acos", "atan",
    "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
]);

/** 把全角/手写运算符归一成 ASCII；无法识别的字符返回 null（整个查询不算式）。 */
function normalizeExpr(text) {
    return String(text)
        .replace(/[×✕✖]/g, "*").replace(/[÷]/g, "/").replace(/[−–]/g, "-")
        .replace(/（/g, "(").replace(/）/g, ")")
        .replace(/\*\*/g, "^")
        .replace(/\s+/g, "");
}

/**
 * 文本 → 求值 token 序列。只允许数字/运算符/括号/函数/常量/阶乘，
 * 出现任何其它字符即返回 null（防误吞普通搜索词）。
 * @param {string} expr 已归一化的表达式
 * @returns {Array<object>|null}
 */
function tokenize(expr) {
    const tokens = [];
    let i = 0;
    while (i < expr.length) {
        const rest = expr.slice(i);
        let m = rest.match(/^(\d+(?:\.\d+)?|\.\d+)/);
        if (m) {
            tokens.push({ type: "num", raw: m[1], value: parseFloat(m[1]) });
            i += m[1].length;
            continue;
        }
        m = rest.match(/^(sqrt|cbrt|log2|log|ln|exp|pow2|pow3|twoX|pow10|inv|fact|sinh|cosh|tanh|asinh|acosh|atanh|asin|acos|atan|sin|cos|tan)(?=\()/);
        if (m) {
            tokens.push({ type: "func", name: m[1] });
            i += m[1].length;
            continue;
        }
        m = rest.match(/^(pi|e)(?![a-z])/i);
        if (m) {
            const name = m[1].toLowerCase() === "pi" ? "pi" : "e";
            tokens.push({ type: "const", value: name, literal: name === "pi" ? Math.PI : Math.E });
            i += m[1].length;
            continue;
        }
        m = rest.match(/^mod(?![a-z])/);
        if (m) { tokens.push({ type: "op", value: "mod" }); i += 3; continue; }
        const ch = expr[i];
        if ("+-*/^".includes(ch)) { tokens.push({ type: "op", value: ch }); i += 1; continue; }
        if (ch === "(") { tokens.push({ type: "lparen" }); i += 1; continue; }
        if (ch === ")") { tokens.push({ type: "rparen" }); i += 1; continue; }
        if (ch === "!") { tokens.push({ type: "suffix", value: "!" }); i += 1; continue; }
        return null;
    }
    return tokens.length ? tokens : null;
}

/**
 * 判断查询是不是算式并求值。规则（防误吞）：
 * 归一化后只含算式字符，且至少有一个运算符/函数/常量/阶乘 —— 纯数字串（"2024"）不算式。
 * @param {string} query 原始查询
 * @returns {{text:string, value:number}|null}
 */
function evalArithmetic(query) {
    const expr = normalizeExpr(query);
    if (!expr || expr.length > 80) return null;
    if (!/^[0-9a-z+\-*/^().!]+$/i.test(expr)) return null;
    const hasOp = /[+\-*/^!]/.test(expr) || /\(/.test(expr) || /(mod|sqrt|cbrt|ln|log|exp|pow|twoX|inv|fact|sin|cos|tan|pi)/i.test(expr);
    if (!hasOp) return null;
    const tokens = tokenize(expr);
    if (!tokens) return null;
    const value = evaluateTokens(tokens, createState("scientific"));
    if (value === null || !Number.isFinite(value)) return null;
    return { text: expr, value };
}

/* ───────────────────────── 单位 / 货币换算 ───────────────────────── */

/** 单位别名表：id / 中文名 / symbol（小写）→ { id, categoryId, kind }，附常见英文复数去 s。 */
const UNIT_ALIAS = new Map();
for (const category of CATEGORIES) {
    for (const unit of category.units) {
        const record = { id: unit.id, categoryId: category.id, kind: category.kind };
        for (const key of [unit.id, unit.name, unit.symbol]) {
            if (key) UNIT_ALIAS.set(String(key).toLowerCase(), record);
        }
    }
}
// 常用别名（中文民间叫法与英文全名；id 与 convert.js 单位表一致）
[["公里", "km"], ["英里", "mi"], ["海里", "nmi"], ["公斤", "kg"], ["斤", "jin"],
["英尺", "ft"], ["英寸", "in"], ["码", "yd"], ["磅", "lb"], ["盎司", "oz"],
["升", "l"], ["毫升", "ml"], ["加仑", "gal"], ["亩", "mu"], ["公顷", "ha"],
["摄氏度", "c"], ["华氏度", "f"], ["开尔文", "k"],
["mile", "mi"], ["kilometer", "km"], ["meter", "m"], ["metre", "m"],
["foot", "ft"], ["feet", "ft"], ["inch", "in"], ["yard", "yd"],
["pound", "lb"], ["ounce", "oz"], ["gallon", "gal"], ["liter", "l"], ["litre", "l"],
].forEach(([alias, id]) => {
    const found = [...UNIT_ALIAS.values()].find((r) => r.id === id);
    if (found && !UNIT_ALIAS.has(alias)) UNIT_ALIAS.set(alias, found);
});

/**
 * 解析单位词（带英文复数去 s 兜底）。
 * @param {string} word 单位词
 * @returns {{id:string, categoryId:string, kind:string}|null}
 */
function unitOf(word) {
    const key = String(word || "").trim().toLowerCase();
    if (!key) return null;
    return UNIT_ALIAS.get(key) || (key.endsWith("s") ? UNIT_ALIAS.get(key.slice(0, -1)) : null) || null;
}

/**
 * 解析换算表达：`<数><单位> (to|in|成|到|换|等于|=) <单位>`。
 * @param {string} query 原始查询
 * @returns {{value:number, from:object, to:object}|null}
 */
function parseConversion(query) {
    const m = String(query).trim()
        .match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z°µμ一-鿿]+)\s*(?:to|in|成|到|换|等于|=)\s*([a-zA-Z°µμ一-鿿]+)$/i);
    if (!m) return null;
    const value = parseFloat(m[1]);
    const from = unitOf(m[2]);
    const to = unitOf(m[3]);
    if (!Number.isFinite(value) || !from || !to) return null;
    return { value, from, to };
}

/** 目标单位的显示名（货币用 ISO 代码，其它用 symbol）。 */
function unitLabel(id) {
    for (const category of CATEGORIES) {
        const unit = category.units.find((u) => u.id === id);
        if (unit) return category.kind === "currency" ? unit.id.toUpperCase() : (unit.symbol || unit.name);
    }
    return id;
}

export const provider = {
    id: "calculator",
    group: "calculation",
    weight: 50,
    async: false,
    types: ["calculation", "conversion", "currency"],
    search(ctx) {
        const out = [];
        const arithmetic = evalArithmetic(ctx.query);
        if (arithmetic) {
            const text = formatNumber(arithmetic.value, { decimals: "auto", thousands: true });
            out.push({
                type: "calculation",
                score: 0,
                label: `${arithmetic.text} = ${text}`,
                sub: i18n.t("spotlight.calcSub", "计算"),
                hint: i18n.t("spotlight.copyHint", "回车复制"),
                icon: CALC_ICON,
                copyText: String(arithmetic.value),
            });
        }
        const conv = parseConversion(ctx.query);
        if (conv) {
            const value = convert(conv.value, conv.from.id, conv.to.id);
            if (value !== null && Number.isFinite(value)) {
                const isCurrency = conv.from.kind === "currency";
                const text = formatValue(value);
                out.push({
                    type: isCurrency ? "currency" : "conversion",
                    score: 0,
                    label: `${conv.value} ${unitLabel(conv.from.id)} = ${text} ${unitLabel(conv.to.id)}`,
                    sub: isCurrency
                        ? `${i18n.t("spotlight.currencySub", "货币换算")} · ${i18n.t("spotlight.rateDate", "汇率快照")} ${RATE_DATE}`
                        : i18n.t("spotlight.convertSub", "单位换算"),
                    hint: i18n.t("spotlight.copyHint", "回车复制"),
                    icon: CALC_ICON,
                    copyText: `${text} ${unitLabel(conv.to.id)}`,
                });
            }
        }
        return out;
    },
};

export default provider;
