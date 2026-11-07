/** engine.js — 求值内核（基础=立即执行、科学=攒表达式按 = 求值；纯逻辑不碰 DOM，可在 Node 里断言）；所有 press* 不抛异常，非法输入进错误态。 */

/** 记忆值与 ans 之外没有全局状态；每次 openApp 都从 createState 起新表。 */
export const MODES = ["basic", "scientific"];

/** 显示用的运算符字形（内部一律用 ASCII，避免 `×` 参与解析）。 */
export const GLYPH = {
    "+": "+", "-": "−", "*": "×", "/": "÷", "^": "^", "EE": "EE", "!": "!",
    pi: "π", e: "e", mod: "mod",
};

const MAX_DIGITS = 16;
/** 「自动」位数用 15 位有效数字：16 位会把 sin(30) 打成 0.4999999999999999，15 位是「看得见精度、又藏住二进制误差」的甜点。 */
const AUTO_DIGITS = 15;
const HISTORY_LIMIT = 200;

/**
 * @param {string} mode "basic" | "scientific"
 * @param {{decimals?:number|"auto", thousands?:boolean}} [opts]
 */
export function createState(mode = "basic", opts = {}) {
    return {
        mode: MODES.includes(mode) ? mode : "basic",
        /** 大字行：正在输入的量、当前值，或科学模式下攒出来的表达式 */
        display: "0",
        /** 小字行：基础模式是挂起的算式，科学模式是上一次 = 的完整表达式 */
        entry: "",
        /** 科学模式：表达式 token 序列；基础模式不用它 */
        tokens: [],
        /** 基础模式：左操作数与待执行的运算符 */
        pending: null,
        /** 输入缓冲：区分「正在敲的数字」与「刚算出来的值」，避免 12 变成 1→2 拼接错乱 */
        typing: false,
        /** 基础模式正在敲的原始数字串；display 是它的格式化结果 */
        buffer: "0",
        /** 刚按过 = ：此时再敲数字是新算式，敲运算符则续接上次结果 */
        justEvaluated: false,
        memory: 0,
        ans: 0,
        second: false,
        radians: false,
        error: false,
        decimals: opts.decimals === undefined ? "auto" : opts.decimals,
        thousands: opts.thousands !== false,
        /** 供历史面板用：{expr, result} */
        last: null,
    };
    }

/* ───────────────────────── 数值 → 文本 ───────────────────────── */

/**
 * 把数值格式化成显示文本。
 * 规则来自苹果文档：末尾零永不显示；小数位数是「四舍五入显示」而不是改存储值
 * （99÷10 且 0 位小数 → 显示 10，但存储仍是 9.9，所以这里只做显示、不动 state.value）。
 * @param {number} value
 * @param {{decimals?:number|"auto", thousands?:boolean}} [opts]
 * @returns {string}
 */
export function formatNumber(value, opts = {}) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "";
    if (Object.is(value, -0)) value = 0;
    const decimals = opts.decimals === undefined ? "auto" : opts.decimals;
    const negative = value < 0;
    let abs = Math.abs(value);

    // 超出十进制精度或数量级太大：走科学计数，否则 1e21 会打印成 21 位的长整数串
    const magnitude = abs === 0 ? 0 : Math.floor(Math.log10(abs));
    if (abs !== 0 && (magnitude >= MAX_DIGITS || magnitude <= -10)) {
        const mantissa = abs / Math.pow(10, magnitude);
        const text = trimZeros(mantissa.toFixed(Math.min(9, MAX_DIGITS - 1)));
        return `${negative ? "-" : ""}${text}e${magnitude}`;
    }

    let text;
    if (decimals === "auto") {
        // toPrecision 再裁尾零：给 0.1+0.2 这类二进制误差一个可读的 15 位上限
        text = trimZeros(abs.toPrecision(AUTO_DIGITS));
        if (text.includes("e")) text = trimZeros(String(Number(abs.toPrecision(AUTO_DIGITS))));
    } else {
        const digits = clampInt(decimals, 0, 10);
        text = abs.toFixed(digits);
    }
    if (opts.thousands) text = addGrouping(text);
    return `${negative ? "-" : ""}${text}`;
}

/** 去掉小数尾零与孤立的小数点。 */
function trimZeros(text) {
    if (!text.includes(".")) return text;
    return text.replace(/0+$/, "").replace(/\.$/, "");
}

/** 只对整数部分加分位符，小数部分原样保留。 */
function addGrouping(text) {
    const [int, rest] = String(text).split(".");
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return rest === undefined ? grouped : `${grouped}.${rest}`;
}

function clampInt(v, min, max) {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
}

/* ───────────────────────── 词法：token → 文本 ───────────────────────── */

/**
 * token 序列 → 显示文本。
 * 内部用 ASCII 运算符，显示时才换成 ÷ × − π，这样解析器不必处理两种字形。
 */
export function tokensToText(tokens) {
    return tokens.map((t) => tokenGlyph(t)).join("");
}

function tokenGlyph(token) {
    switch (token.type) {
        case "num":
            return token.raw !== undefined ? token.raw : String(token.value);
        case "op":
            return GLYPH[token.value] || token.value;
        case "func":
            // 左括号是独立 token（见 pressFunction），字形不能再补一次括号
            return token.label;
        case "const":
            return GLYPH[token.value] || token.value;
        case "lparen":
            return "(";
        case "rparen":
            return ")";
        case "suffix":
            return token.value === "EE" ? " EE " : GLYPH[token.value] || token.value;
        default:
            return "";
    }
}

/* ───────────────────────── 输入：数字与小数点 ───────────────────────── */

export function pressDigit(state, digit) {
    if (!/^[0-9]$/.test(String(digit))) return state;
    if (state.error) resetAll(state);
    if (state.justEvaluated) {
        // 出结果后敲数字 = 新算式；小字行留着上一次的表达式以便回看
        beginNewEntry(state);
    }
    if (state.mode === "scientific") {
        const tail = lastToken(state, "num");
        if (tail && state.typing) {
            if (tail.raw.length >= MAX_DIGITS + 4) return state;
            tail.raw += digit;
            tail.value = Number(tail.raw);
        } else {
            pushToken(state, { type: "num", raw: digit, value: Number(digit) });
        }
        state.typing = true;
        syncScientificDisplay(state);
        return state;
    }
    if (!state.typing) {
        state.buffer = digit;
        state.typing = true;
        state.display = formatBuffer(state);
        return state;
    }
    if (state.buffer.replace(/[-.]/g, "").length >= MAX_DIGITS) return state;
    state.buffer = state.buffer === "0" ? digit : state.buffer + digit;
    state.display = formatBuffer(state);
    return state;
}

export function pressDot(state) {
    if (state.error) resetAll(state);
    if (state.justEvaluated) beginNewEntry(state);
    if (state.mode === "scientific") {
        const tail = lastToken(state, "num");
        if (tail && state.typing) {
            if (!tail.raw.includes(".")) tail.raw += ".";
        } else {
            pushToken(state, { type: "num", raw: "0.", value: 0 });
        }
        state.typing = true;
        syncScientificDisplay(state);
        return state;
    }
    if (!state.typing) {
        state.buffer = "0.";
        state.typing = true;
        state.display = formatBuffer(state);
        return state;
    }
    if (!state.buffer.includes(".")) state.buffer += ".";
    state.display = formatBuffer(state);
    return state;
}

/** 退格：删掉正在输入的数字的最后一位（苹果文档：删除最后一位数字）。 */
export function pressDelete(state) {
    if (state.error) return resetAll(state);
    if (state.justEvaluated) return state;
    if (state.mode === "scientific") {
        const tail = state.tokens[state.tokens.length - 1];
        if (!tail) return state;
        if (tail.type === "num" && state.typing) {
            tail.raw = tail.raw.slice(0, -1);
            if (tail.raw === "" || tail.raw === "-") {
                state.tokens.pop();
                state.typing = false;
            } else {
                tail.value = Number(tail.raw) || 0;
            }
        } else {
            state.tokens.pop();
            state.typing = false;
        }
        syncScientificDisplay(state);
        return state;
    }
    if (!state.typing) return state;
    state.buffer = state.buffer.length <= 1 || (state.buffer.length === 2 && state.buffer.startsWith("-"))
        ? "0"
        : state.buffer.slice(0, -1);
    state.display = formatBuffer(state);
    if (state.buffer === "0") state.typing = false;
    return state;
}

/* ───────────────────────── 输入：运算符 ───────────────────────── */

const BINARY = { "+": 2, "-": 2, "*": 2, "/": 2, "^": 3, mod: 2 };

export function pressOperator(state, op) {
    if (state.error) return state;
    if (!BINARY[op] && op !== "EE") return state;

    if (state.mode === "basic") {
        const value = currentValue(state);
        if (value === null) return state;
        // 立即执行：连着按运算符只替换待执行的那个（macOS 与 iOS 都是这个语义）
        if (state.pending && state.typing === false) {
            state.pending.op = op;
            state.entry = entryLine(state, op);
            return state;
        }
        if (state.pending) {
            const next = applyBinary(state.pending.value, value, state.pending.op);
            if (next === null) return enterError(state);
            state.pending = { value: next, op };
            state.display = formatNumber(next, state);
        } else {
            state.pending = { value, op };
        }
        state.typing = false;
        state.justEvaluated = false;
        state.entry = entryLine(state, op);
        return state;
    }

    if (op === "EE") {
        // EE 只能跟在数字/常量/右括号后面，否则折叠阶段拿不到左值
        const tail = state.tokens[state.tokens.length - 1];
        const okTail = tail && (tail.type === "num" || tail.type === "const" || tail.type === "rparen" || tail.type === "suffix");
        if (!okTail) return state;
        pushToken(state, { type: "suffix", value: "EE" });
        state.typing = false;
        syncScientificDisplay(state);
        return state;
    }
    // 出结果后直接续运算符：以 ans 为左操作数
    if (state.justEvaluated) {
        state.tokens = [{ type: "num", raw: String(state.ans), value: state.ans }];
        state.justEvaluated = false;
    }
    const tail = state.tokens[state.tokens.length - 1];
    // 只替换「还没落地的二元运算符」；`!` / `EE` 是后缀，替换掉会把阶乘吃掉
    if (tail && tail.type === "op") tail.value = op;
    else if (!tail) { pushToken(state, { type: "num", raw: "0", value: 0 }); pushToken(state, { type: "op", value: op }); }
    else pushToken(state, { type: "op", value: op });
    state.typing = false;
    syncScientificDisplay(state);
    return state;
}

/** 小字行：`38670 ÷` 这种挂起算式（对应苹果基础模式截图）。 */
function entryLine(state, op) {
    return `${formatNumber(state.pending.value, state)} ${GLYPH[op] || op}`;
}

export function pressEquals(state) {
    if (state.error) return state;
    if (state.mode === "basic") {
        if (!state.pending) {
            state.ans = currentValue(state) || 0;
            state.justEvaluated = true;
            return state;
        }
        const { value: left, op } = state.pending;
        const right = currentValue(state);
        if (right === null) return enterError(state);
        const result = applyBinary(left, right, op);
        state.pending = null;
        state.entry = `${fmt(state, left)} ${GLYPH[op] || op} ${fmt(state, right)} =`;
        if (result === null) return enterError(state);
        state.display = formatNumber(result, state);
        state.buffer = String(result);
        state.ans = result;
        state.typing = false;
        state.justEvaluated = true;
        state.last = { expr: state.entry, result: state.display };
        return state;
    }

    if (!state.tokens.length) return state;
    closeOpenParens(state);
    const exprText = tokensToText(state.tokens);
    const result = evaluateTokens(state.tokens, state);
    if (result === null) return enterError(state);
    state.tokens = [];
    state.display = formatNumber(result, state);
    state.entry = `${exprText} =`;
    state.ans = result;
    state.typing = false;
    state.justEvaluated = true;
    state.last = { expr: exprText, result: state.display };
    return state;
}

/** 苹果科学模式：`sin(3` 按 = 直接当 `sin(3)` 算，不必手动补右括号。 */
function closeOpenParens(state) {
    const open = state.tokens.filter((t) => t.type === "lparen").length;
    const close = state.tokens.filter((t) => t.type === "rparen").length;
    for (let i = close; i < open; i += 1) state.tokens.push({ type: "rparen" });
}

/** 输入缓冲 → 带分位符的显示串（保留结尾的小数点：刚按了「.」时不能吞掉）。 */
function formatBuffer(state) {
    const [int, rest] = String(state.buffer).split(".");
    const sign = int.startsWith("-") ? "-" : "";
    const digits = sign ? int.slice(1) : int;
    const grouped = state.thousands ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : digits;
    return rest === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${rest}`;
}

function fmt(state, value) {
    return formatNumber(value, state);
}

export function pressClearEntry(state) {
    // C：只清当前输入，保留挂起的运算符
    if (state.mode === "basic") {
        state.display = "0";
        state.buffer = "0";
        state.typing = false;
        return state;
    }
    const tail = state.tokens[state.tokens.length - 1];
    if (tail && tail.type === "num") state.tokens.pop();
    state.typing = false;
    syncScientificDisplay(state);
    return state;
}

/**
 * 清除键（一个键两个身份，照 macOS）：
 * 正在输入或显示非零时先清输入（C），已经干净时全清（AC）。
 * 键盘上仍保留两套独立入口：Esc = 本键，⌥Esc = 无条件全清，Delete = 退一格。
 */
export function pressClearKey(state) {
    // 只看「有没有正在输入的东西」：把挂起运算符也算脏的话，这个键会永远停在 C 档、再也按不到 AC
    const dirty = state.mode === "basic"
        ? (state.typing || state.display !== "0")
        : (state.typing || !!state.tokens.length);
    if (!dirty) return resetAll(state);
    return pressClearEntry(state);
}

export function resetAll(state) {
    state.display = "0";
    state.buffer = "0";
    state.entry = "";
    state.tokens = [];
    state.pending = null;
    state.typing = false;
    state.justEvaluated = false;
    state.error = false;
    // 记忆与 ans 不随清屏丢失（苹果行为：AC 不清 M）
    return state;
}

export function pressNegate(state) {
    if (state.error) return state;
    if (state.mode === "basic") {
        const v = currentValue(state);
        if (v === null) return state;
        // 正在敲数字时直接翻缓冲，否则翻显示值：否则 0.5 敲 ± 会变成 "−0.5" 的格式化串再被当数字解析
        if (state.typing) {
            state.buffer = state.buffer.startsWith("-") ? state.buffer.slice(1) : `-${state.buffer}`;
            state.display = formatBuffer(state);
            return state;
        }
        state.display = formatNumber(-v, state);
        return state;
    }
    const tail = state.tokens[state.tokens.length - 1];
    if (tail && tail.type === "num") {
        tail.raw = tail.raw.startsWith("-") ? tail.raw.slice(1) : `-${tail.raw}`;
        tail.value = Number(tail.raw);
    } else {
        // 表达式末尾不是数字时只压一个减号：调度场里「前面没有值的一元负号」会补 0
        pushToken(state, { type: "op", value: "-" });
        state.typing = false;
    }
    syncScientificDisplay(state);
    return state;
}

/**
 * 百分号：
 * - 有挂起运算符时按苹果语义处理（`A + B%` = `A + A·B/100`，`A − B%` 同理）；
 * - 否则就是 `÷100`。
 */
export function pressPercent(state) {
    if (state.error) return state;
    const value = currentValue(state);
    if (value === null) return state;
    if (state.mode === "basic" && state.pending) {
        const { value: left, op } = state.pending;
        const delta = (left * value) / 100;
        const result = op === "+" ? left + delta : op === "-" ? left - delta : null;
        if (result === null) {
            state.display = formatNumber(value / 100, state);
            state.typing = false;
            return state;
        }
        state.pending = null;
        state.entry = `${fmt(state, left)} ${GLYPH[op]} ${fmt(state, value)}% =`;
        state.display = formatNumber(result, state);
        state.ans = result;
        state.typing = false;
        state.justEvaluated = true;
        state.last = { expr: state.entry, result: state.display };
        return state;
    }
    const next = value / 100;
    if (state.mode === "scientific") {
        const tail = lastToken(state, "num");
        if (tail && state.typing) { tail.raw = String(next); tail.value = next; }
        else pushToken(state, { type: "num", raw: String(next), value: next });
        syncScientificDisplay(state);
        return state;
    }
    state.display = formatNumber(next, state);
    state.typing = false;
    return state;
}

/* ───────────────────────── 科学函数与常量 ───────────────────────── */

/** 一元函数表：`name(state, x)`，角度类函数按 Deg/Rad 换算。 */
const FUNCTIONS = {
    sqrt: (st, x) => (x < 0 ? null : Math.sqrt(x)),
    cbrt: (st, x) => Math.cbrt(x),
    ln: (st, x) => (x <= 0 ? null : Math.log(x)),
    log: (st, x) => (x <= 0 ? null : Math.log10(x)),
    log2: (st, x) => (x <= 0 ? null : Math.log2(x)),
    exp: (st, x) => Math.exp(x),
    pow2: (st, x) => x * x,
    pow3: (st, x) => x * x * x,
    twoX: (st, x) => Math.pow(2, x),
    pow10: (st, x) => Math.pow(10, x),
    inv: (st, x) => (x === 0 ? null : 1 / x),
    fact: (st, x) => factorial(x),
    sin: (st, x) => Math.sin(toRadians(st, x)),
    cos: (st, x) => Math.cos(toRadians(st, x)),
    tan: (st, x) => Math.tan(toRadians(st, x)),
    asin: (st, x) => (Math.abs(x) > 1 ? null : fromRadians(st, Math.asin(x))),
    acos: (st, x) => (Math.abs(x) > 1 ? null : fromRadians(st, Math.acos(x))),
    atan: (st, x) => fromRadians(st, Math.atan(x)),
    sinh: (st, x) => Math.sinh(x),
    cosh: (st, x) => Math.cosh(x),
    tanh: (st, x) => Math.tanh(x),
    asinh: (st, x) => Math.asinh(x),
    acosh: (st, x) => (x < 1 ? null : Math.acosh(x)),
    atanh: (st, x) => (Math.abs(x) >= 1 ? null : Math.atanh(x)),
};

/** 键位字形（2nd 状态由界面决定按哪个动作，这里只管显示）。 */
const GLYPHS = {
    sqrt: "√x", cbrt: "∛x", pow2: "x²", pow3: "x³", twoX: "2ˣ", pow10: "10ˣ", inv: "1/x",
    fact: "x!", ln: "ln", log: "log₁₀", log2: "log₂", exp: "eˣ",
    sin: "sin", cos: "cos", tan: "tan", asin: "sin⁻¹", acos: "cos⁻¹", atan: "tan⁻¹",
    sinh: "sinh", cosh: "cosh", tanh: "tanh", asinh: "sinh⁻¹", acosh: "cosh⁻¹", atanh: "tanh⁻¹",
};

/** 函数名 → 键面字形；未知名字原样返回（界面自己决定标签时兜底）。 */
export function labelFor(name) {
    return GLYPHS[name] || name;
}

/**
 * 函数键：科学模式把它作为 `func(` token 接在表达式里（苹果科学模式允许
 * `sin` 后面再敲数字，也允许 `sin(30)`），一元运算在基础模式下直接作用于当前值。
 */
export function pressFunction(state, name) {
    if (state.error) return state;
    const key = name;
    if (key === "pow10") {
        pushToken(state, { type: "num", raw: "10", value: 10 });
        pushToken(state, { type: "op", value: "^" });
        state.second = false;
        syncScientificDisplay(state);
        return state;
    }
    const fn = FUNCTIONS[key];
    if (!fn && key !== "pow10") return state;
    if (state.mode === "basic") {
        const v = currentValue(state);
        if (v === null) return state;
        const r = fn ? fn(state, v) : null;
        if (r === null || r === undefined || !Number.isFinite(r)) return enterError(state);
        state.display = formatNumber(r, state);
        state.typing = false;
        state.second = false;
        return state;
    }
    // 函数自带一个左括号：`sin` 之后可以直接敲数字，= 时再自动补齐右括号
    pushToken(state, { type: "func", name: key, label: labelFor(key, false) });
    pushToken(state, { type: "lparen" });
    state.typing = false;
    state.second = false;
    syncScientificDisplay(state);
    return state;
}

export function pressPower(state, kind) {
    // x² / x³ / xʸ / eˣ / 10ˣ：前三个是「当前值的幂」，用后缀 token 表达，
    // 这样 `3 x! =` 与 `2 x² + 1 =` 都能按标准次序求值。
    if (state.error) return state;
    if (kind === "sq" || kind === "cube") {
        pushToken(state, { type: "op", value: "^" });
        pushToken(state, { type: "num", raw: kind === "sq" ? "2" : "3", value: kind === "sq" ? 2 : 3 });
        state.second = false;
        syncScientificDisplay(state);
        return state;
    }
    if (kind === "pow") return pressOperator(state, "^");
    if (kind === "expE") {
        pushToken(state, { type: "func", name: "exp", label: "eˣ" });
        pushToken(state, { type: "lparen" });
        state.second = false;
        syncScientificDisplay(state);
        return state;
    }
    if (kind === "exp10") {
        pushToken(state, { type: "num", raw: "10", value: 10 });
        pushToken(state, { type: "op", value: "^" });
        state.second = false;
        syncScientificDisplay(state);
        return state;
    }
    return state;
}

export function pressFactorial(state) {
    if (state.error) return state;
    if (state.mode === "basic") {
        const v = currentValue(state);
        const r = v === null ? null : factorial(v);
        if (r === null) return enterError(state);
        state.display = formatNumber(r, state);
        state.typing = false;
        return state;
    }
    pushToken(state, { type: "suffix", value: "!" });
    syncScientificDisplay(state);
    return state;
}

export function pressConstant(state, name) {
    if (state.error) return state;
    const value = name === "pi" ? Math.PI : Math.E;
    if (state.mode === "basic") {
        pushBasicValue(state, value);
        return state;
    }
    insertValue(state, { type: "const", value: name === "pi" ? "pi" : "e", literal: value });
    state.typing = false;
    syncScientificDisplay(state);
    return state;
}

export function pressRandom(state) {
    if (state.error) return state;
    const value = Math.random();
    if (state.mode === "basic") return pushBasicValue(state, value), state;
    insertValue(state, { type: "num", raw: String(value), value });
    state.typing = false;
    syncScientificDisplay(state);
    return state;
}

export function pressAns(state) {
    if (state.mode === "basic") return pushBasicValue(state, state.ans), state;
    insertValue(state, { type: "num", raw: String(state.ans), value: state.ans });
    state.typing = false;
    syncScientificDisplay(state);
    return state;
}

function pushBasicValue(state, value) {
    if (state.justEvaluated) beginNewEntry(state);
    state.display = formatNumber(value, state);
    state.typing = false;
    return state;
}

export function pressParen(state) {
    if (state.error) return state;
    if (state.mode === "basic") return state;
    const openCount = state.tokens.filter((t) => t.type === "lparen").length;
    const closeCount = state.tokens.filter((t) => t.type === "rparen").length;
    const tail = state.tokens[state.tokens.length - 1];
    const canClose = tail && (tail.type === "num" || tail.type === "rparen" || tail.type === "suffix" || tail.type === "const");
    if (openCount > closeCount && canClose) {
        pushToken(state, { type: "rparen" });
    } else {
        // 前面是数字或右括号时补乘号：`(1+2)(3+4)` 与 `2(3)` 都能算
        if (tail && (tail.type === "num" || tail.type === "rparen" || tail.type === "const" || tail.type === "suffix")) {
            pushToken(state, { type: "op", value: "*" });
        }
        pushToken(state, { type: "lparen" });
    }
    state.typing = false;
    syncScientificDisplay(state);
    return state;
}

/**
 * 供 RPN 与程序员模式复用一元函数表（它们不走表达式解析，只需要「对 X 求值」）。
 * @param {object} state 提供 radians 标志的模型（RPN 自己造一个）
 * @param {string} name 函数名
 * @param {number} value 入参
 * @returns {number|null} null 表示定义域外或未知函数
 */
export function applyUnary(state, name, value) {
    const fn = FUNCTIONS[name];
    if (!fn) return null;
    const r = fn(state, value);
    if (r === null || r === undefined || !Number.isFinite(r)) return null;
    return r;
}

/** 二元求值的唯一出口（RPN 与基础模式共用，避免两处语义漂移）。 */
export function applyBinaryOp(a, op, b) {
    return BINARY[op] ? applyBinary(a, b, op) : null;
}

/* ───────────────────────── 记忆与角度 ───────────────────────── */

export function pressMemoryClear(state) { state.memory = 0; return state; }
export function pressMemoryRecall(state) {
    if (state.mode === "basic") return pushBasicValue(state, state.memory), state;
    insertValue(state, { type: "num", raw: String(state.memory), value: state.memory });
    state.typing = false;
    syncScientificDisplay(state);
    return state;
}
export function pressMemoryAdd(state) {
    const v = currentValue(state);
    if (v !== null) state.memory += v;
    state.typing = false;
    return state;
}
export function pressMemorySubtract(state) {
    const v = currentValue(state);
    if (v !== null) state.memory -= v;
    state.typing = false;
    return state;
}
export function pressToggleSecond(state) { state.second = !state.second; return state; }
export function pressToggleAngle(state) {
    state.radians = !state.radians;
    return state;
}

function toRadians(state, value) { return state.radians ? value : (value * Math.PI) / 180; }
function fromRadians(state, value) { return state.radians ? value : (value * 180) / Math.PI; }

/** 阶乘：只接受非负整数；>170 溢出为 Infinity（按错误处理，避免显示 Infinity）。 */
function factorial(x) {
    if (!Number.isFinite(x) || x < 0 || Math.floor(x) !== x) return null;
    if (x > 170) return null;
    let out = 1;
    for (let i = 2; i <= x; i += 1) out *= i;
    return out;
}

/* ───────────────────────── 求值 ───────────────────────── */

function applyBinary(a, b, op) {
    switch (op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return b === 0 ? null : a / b;
        case "^": return Math.pow(a, b);
        case "mod": return b === 0 ? null : a % b;
        default: return null;
    }
}

/**
 * 把 `a EE b` 折回成一个字面量 `a×10^b`。
 * EE 是科学记数法的输入快捷方式（苹果文档明说它是「×10ˣ 的快捷键」），
 * 参与运算符优先级会算错，所以进求值前先合并掉。
 * @param {Array<object>} tokens
 * @returns {Array<object>|null} 结构非法时返回 null
 */
function foldEE(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (token.type !== "suffix" || token.value !== "EE") {
            out.push(token);
            continue;
        }
        const left = out[out.length - 1];
        const right = tokens[i + 1];
        const leftValue = left && (left.type === "num" ? left.value : left.type === "const" ? (left.literal ?? Math.PI) : null);
        if (leftValue === null || !right || right.type !== "num") return null;
        out[out.length - 1] = {
            type: "num",
            value: leftValue * Math.pow(10, right.value),
            raw: `${left.raw ?? leftValue} EE ${right.raw ?? right.value}`,
        };
        i += 1;
    }
    return out;
}

/**
 * 调度场算法 → RPN → 求值。
 * 为什么不用 new Function：扩展页 CSP 是 script-src 'self'，eval 一律被拒；
 * 而且把用户输入拼进代码字符串本身就是注入面。
 */
export function evaluateTokens(rawTokens, state) {
    const tokens = foldEE(rawTokens);
    if (!tokens) return null;
    const rpn = [];
    const ops = [];
    const prec = { "+": 1, "-": 1, "*": 2, "/": 2, mod: 2, "^": 4, "!": 5 };
    const rightAssoc = { "^": true };
    let prevWasValue = false;

    const popOp = (op) => rpn.push(op);
    for (const token of tokens) {
        switch (token.type) {
            case "num":
            case "const":
                rpn.push(token);
                prevWasValue = true;
                break;
            case "func":
                ops.push(token);
                prevWasValue = false;
                break;
            case "lparen":
                ops.push(token);
                prevWasValue = false;
                break;
            case "rparen": {
                // 括号里没东西（`sin()`）视为 0，避免栈空崩掉
                let found = false;
                while (ops.length) {
                    const top = ops[ops.length - 1];
                    if (top.type === "lparen") { ops.pop(); found = true; break; }
                    popOp(ops.pop());
                }
                if (!found) return null;
                if (ops.length && ops[ops.length - 1].type === "func") popOp(ops.pop());
                prevWasValue = true;
                break;
            }
            case "suffix": {
                if (!prevWasValue) return null;
                popOp(token);
                prevWasValue = true;
                break;
            }
            case "op": {
                if (!prevWasValue && token.value === "-") {
                    // 一元负号：塞一个 0 在前，`0 - x` 与减法语义一致
                    rpn.push({ type: "num", value: 0 });
                } else if (!prevWasValue) {
                    return null;
                }
                while (ops.length) {
                    const top = ops[ops.length - 1];
                    if (top.type === "lparen" || top.type === "func") break;
                    const topPrec = top.type === "suffix" ? prec[top.value] : prec[top.value];
                    if (topPrec > prec[token.value] || (topPrec === prec[token.value] && !rightAssoc[token.value])) popOp(ops.pop());
                    else break;
                }
                ops.push(token);
                prevWasValue = false;
                break;
            }
            default:
                return null;
        }
    }
    while (ops.length) {
        const top = ops.pop();
        if (top.type === "lparen") return null;
        rpn.push(top);
    }

    const stack = [];
    const take = () => (stack.length ? stack.pop() : null);
    for (const item of rpn) {
        if (item.type === "num") stack.push(item.value);
        else if (item.type === "const") stack.push(item.literal !== undefined ? item.literal : (item.value === "pi" ? Math.PI : Math.E));
        else if (item.type === "func") {
            const x = take();
            if (x === null) return null;
            const fn = FUNCTIONS[item.name];
            const r = fn ? fn(state, x) : null;
            if (r === null || r === undefined || !Number.isFinite(r)) return null;
            stack.push(r);
        } else if (item.type === "suffix") {
            const x = take();
            if (x === null) return null;
            const r = item.value === "!" ? factorial(x) : null;
            if (r === null) return null;
            stack.push(r);
        } else if (item.type === "op") {
            const b = take();
            const a = take();
            if (a === null || b === null) return null;
            const r = applyBinary(a, b, item.value);
            if (r === null || Number.isNaN(r)) return null;
            stack.push(r);
        }
    }
    if (stack.length !== 1) return null;
    const out = stack[0];
    return Number.isFinite(out) ? out : null;
}

/* ───────────────────────── token 小工具 ───────────────────────── */

function pushToken(state, token) {
    state.tokens.push(token);
    state.justEvaluated = false;
}

/** 值型 token 入列：前面已经是值时补一个乘号，避免 `8 mr` 显示成 "80"。 */
function insertValue(state, token) {
    const tail = state.tokens[state.tokens.length - 1];
    if (tail && (tail.type === "num" || tail.type === "const" || tail.type === "rparen" || tail.type === "suffix")) {
        pushToken(state, { type: "op", value: "*" });
    }
    pushToken(state, token);
}

function lastToken(state, type) {
    const tail = state.tokens[state.tokens.length - 1];
    return tail && tail.type === type ? tail : null;
}

/** 大字行 = 表达式文本（科学模式）。空表达式时回到 ans，和苹果一致。 */
function syncScientificDisplay(state) {
    if (!state.tokens.length) {
        state.display = state.justEvaluated ? formatNumber(state.ans, state) : "0";
        return;
    }
    state.display = tokensToText(state.tokens);
}

function beginNewEntry(state) {
    state.justEvaluated = false;
    state.entry = "";
    state.tokens = [];
    state.pending = null;
    state.display = "0";
    state.buffer = "0";
    state.typing = false;
}

/** 当前大字行代表的数值（科学模式取表达式尾部数字或 ans）。 */
export function currentValue(state) {
    if (state.error) return null;
    if (state.mode === "basic") {
        const raw = state.typing ? state.buffer : state.display;
        const n = Number(String(raw).replace(/,/g, ""));
        return Number.isFinite(n) ? n : null;
    }
    const tail = state.tokens[state.tokens.length - 1];
    if (tail && tail.type === "num") return tail.value;
    if (tail && (tail.type === "rparen" || tail.type === "const" || tail.type === "suffix")) {
        const v = evaluateTokens(state.tokens, state);
        return v === null ? null : v;
    }
    return Number.isFinite(state.ans) ? state.ans : null;
}

function enterError(state) {
    state.error = true;
    state.display = "错误";
    state.entry = "";
    state.tokens = [];
    state.pending = null;
    state.typing = false;
    state.justEvaluated = false;
    return state;
}

export function isError(state) { return !!state.error; }

/** 供设置项校验：小数位数只接受 auto 或 0–10。 */
export function normalizeDecimals(value) {
    if (value === "auto") return "auto";
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) ? clampInt(n, 0, 10) : "auto";
}

export const HISTORY_MAX = HISTORY_LIMIT;
