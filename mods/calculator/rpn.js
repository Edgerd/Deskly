/**
 * rpn.js — 逆波兰（RPN）堆栈内核（纯逻辑，不碰 DOM）
 *
 * 苹果把 RPN 做成基础/科学之上的一个开关：`=` 变成 `Enter`，多出一排堆栈键
 * （交换寄存器、向上/向下滚动、丢弃）。所以这里不复用 engine 的表达式模型，
 * 只借它的一元/二元求值出口 —— 两套语义混在一个状态机里迟早互相踩。
 *
 * 四级堆栈 X Y Z T：Enter 把 X 推上去，二元运算弹出 X、Y 并把结果放回 X。
 * 滚动（roll）是循环移位而不是压弹，这是 HP 计算器的经典语义，苹果照搬。
 */

import { applyUnary, applyBinaryOp } from "./engine.js";

const LEVELS = ["X", "Y", "Z", "T"];

export function createRpn(opts = {}) {
    return {
        x: 0,
        y: 0,
        z: 0,
        t: 0,
        /** X 是否正在被键入（决定数字是续接还是覆盖） */
        typing: false,
        buffer: "0",
        decimals: opts.decimals === undefined ? "auto" : opts.decimals,
        thousands: opts.thousands !== false,
        error: false,
        /** 最近一次操作的文字描述，显示在小字行 */
        note: "",
    };
}

function format(state, value) {
    if (!Number.isFinite(value)) return "错误";
    const text = formatPlain(value, state);
    return state.thousands ? addGrouping(text) : text;
}

function formatPlain(value, state) {
    if (Object.is(value, -0)) value = 0;
    if (state.decimals === "auto") {
        const magnitude = value === 0 ? 0 : Math.floor(Math.log10(Math.abs(value)));
        if (value !== 0 && (magnitude >= 16 || magnitude <= -10)) {
            const exp = magnitude;
            const mantissa = value / Math.pow(10, exp);
            return `${trim(mantissa.toPrecision(13))}e${exp}`;
        }
        return trim(value.toPrecision(16));
    }
    return value.toFixed(clamp(state.decimals, 0, 10));
}

function trim(text) {
    return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

function clamp(v, min, max) {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function addGrouping(text) {
    const [int, rest] = String(text).split(".");
    const sign = int.startsWith("-") ? "-" : "";
    const digits = sign ? int.slice(1) : int;
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return rest === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${rest}`;
}

/** 四级显示行，从上到下是 T Z Y X（苹果就是这个顺序）。 */
export function rpnRows(state) {
    return LEVELS.slice().reverse().map((label) => ({
        label,
        text: label === "X" && state.typing ? groupBuffer(state) : format(state, state[label.toLowerCase()]),
    }));
}

function groupBuffer(state) {
    const [int, rest] = state.buffer.split(".");
    const sign = int.startsWith("-") ? "-" : "";
    const digits = sign ? int.slice(1) : int;
    const grouped = state.thousands ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : digits;
    return rest === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${rest}`;
}

export function rpnDisplay(state) {
    if (state.error) return "错误";
    return state.typing ? groupBuffer(state) : format(state, state.x);
}

export function pressRpnDigit(state, digit) {
    if (!/^[0-9]$/.test(String(digit))) return state;
    if (state.error) clearRpn(state);
    if (!state.typing) {
        state.buffer = digit;
        state.typing = true;
        return commitBuffer(state);
    }
    if (state.buffer.replace(/[-.]/g, "").length >= 16) return state;
    state.buffer = state.buffer === "0" ? digit : state.buffer + digit;
    return commitBuffer(state);
}

/** 键入即代表 X：HP 与苹果的 RPN 都是「X 跟着按键走，Enter 才往下压」。 */
function commitBuffer(state) {
    const value = Number(state.buffer.replace(/,/g, ""));
    if (Number.isFinite(value)) state.x = value;
    return state;
}

export function pressRpnDot(state) {
    if (state.error) return clearRpn(state);
    if (!state.typing) {
        state.buffer = "0.";
        state.typing = true;
        return state;
    }
    if (!state.buffer.includes(".")) state.buffer += ".";
    return commitBuffer(state);
}

export function pressRpnDelete(state) {
    if (state.error) return clearRpn(state);
    if (!state.typing) return state;
    state.buffer = state.buffer.length <= 1 || state.buffer === "-0" ? "0" : state.buffer.slice(0, -1);
    if (state.buffer === "" || state.buffer === "-") {
        state.buffer = "0";
        state.typing = false;
    }
    return commitBuffer(state);
}

/** 键入值落到 X（未 Enter 时数字始终代表 X）。 */
function committedX(state) {
    if (!state.typing) return state.x;
    const value = Number(state.buffer.replace(/,/g, ""));
    return Number.isFinite(value) ? value : 0;
}

/** Enter：把 X 复制进 Y 并让整条堆栈下移一格，X 保持可继续键入。 */
export function pressRpnEnter(state) {
    if (state.error) return state;
    const value = committedX(state);
    state.t = state.z;
    state.z = state.y;
    state.y = value;
    state.x = value;
    state.typing = false;
    state.buffer = String(value);
    state.note = "Enter";
    return state;
}

export function pressRpnBinary(state, op) {
    if (state.error) return state;
    const left = state.y;
    const right = committedX(state);
    const result = applyBinaryOp(left, op, right);
    if (result === null || Number.isNaN(result)) return enterRpnError(state);
    state.x = result;
    state.y = state.z;
    state.z = state.t;
    state.typing = false;
    state.buffer = String(result);
    state.note = `Y ${op} X`;
    return state;
}

export function pressRpnUnary(state, name) {
    if (state.error) return state;
    const r = applyUnary(state, name, committedX(state));
    // 一元运算就地作用于 X，不动堆栈（与 HP 一致）
    if (r === null) return enterRpnError(state);
    state.x = r;
    state.typing = false;
    state.buffer = String(r);
    state.note = name;
    return state;
}

/** 交换寄存器：X ⇄ Y（苹果快捷键 ⌘E）。 */
export function pressRpnSwap(state) {
    if (state.error) return state;
    const x = committedX(state);
    state.x = state.y;
    state.y = x;
    state.typing = false;
    state.buffer = "0";
    state.note = "x ⇄ y";
    return state;
}

/** 向上滚动：X→Y→Z→T→X。 */
export function pressRpnRollUp(state) {
    if (state.error) return state;
    const x = committedX(state);
    state.x = state.t;
    state.t = state.z;
    state.z = state.y;
    state.y = x;
    state.typing = false;
    state.buffer = "0";
    state.note = "↑ 滚动";
    return state;
}

/** 向下滚动：X←T←Z←Y←X。 */
export function pressRpnRollDown(state) {
    if (state.error) return state;
    const x = committedX(state);
    state.x = state.y;
    state.y = state.z;
    state.z = state.t;
    state.t = x;
    state.typing = false;
    state.buffer = "0";
    state.note = "↓ 滚动";
    return state;
}

/** 丢弃：把 X 弹出，下面的补上来（⌘Delete）。 */
export function pressRpnDrop(state) {
    if (state.error) return state;
    state.x = state.y;
    state.y = state.z;
    state.z = state.t;
    state.typing = false;
    state.buffer = "0";
    state.note = "丢弃";
    return state;
}

export function pressRpnNegate(state) {
    if (state.error) return state;
    if (state.typing) {
        state.buffer = state.buffer.startsWith("-") ? state.buffer.slice(1) : `-${state.buffer}`;
        return commitBuffer(state);
    }
    state.x = -state.x;
    state.buffer = String(state.x);
    return state;
}

/** 百分号在 RPN 里就是「除以 100」，没有挂起运算符可以参照。 */
export function pressRpnPercent(state) {
    if (state.error) return state;
    state.x = committedX(state) / 100;
    state.typing = false;
    state.buffer = String(state.x);
    return state;
}

export function clearRpnEntry(state) {
    state.typing = false;
    state.buffer = "0";
    state.x = 0;
    state.error = false;
    return state;
}

export function clearRpn(state) {
    state.x = 0;
    state.y = 0;
    state.z = 0;
    state.t = 0;
    state.typing = false;
    state.buffer = "0";
    state.error = false;
    state.note = "全部清除";
    return state;
}

function enterRpnError(state) {
    state.error = true;
    state.note = "错误";
    return state;
}

/** 供历史面板记录用：X 与它的来路。 */
export function rpnSnapshot(state) {
    return { x: state.x, y: state.y, z: state.z, t: state.t, note: state.note };
}
