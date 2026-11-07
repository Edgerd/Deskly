/** script.js — 计算器外壳与交互：键帽布局、按键派发、结果显示、与宿主（设置/菜单/浮层/窗口尺寸）打交道；求值语义在 engine.js / rpn.js / programmer.js / convert.js。 */

import { settings } from '../../src/javascripts/settings.js';
import { openPopover } from '../../src/javascripts/ui/popover.js';
import * as Engine from './engine.js';
import * as Rpn from './rpn.js';
import * as History from './history.js';
import * as Prog from './programmer.js';
import * as Conv from './convert.js';

const root = document.querySelector(".calculator.window");

/* ───────────────────────── 设置项 ───────────────────────── */

// 首段必须全小写（设置中枢的 KEY_PATTERN），且 hidden 的项不进「插件」面板，
// 它们是应用的记忆（上次用的模式 / 单位），不是给用户改的配置。
settings.defineMany([
    {
        key: "calculator.background", type: "string", default: "glass",
        values: ["glass", "solid"], valuesLabel: ["深色毛玻璃", "深色不透明"],
        label: "计算器背景", hint: "计算器恒为深色，只有磨砂与实底两档；系统「降低透明度」打开时自动落到实底",
        control: "dropdown", owner: "calculator", pane: "plugins", order: 10,
    },
    {
        key: "calculator.thousands", type: "boolean", default: true,
        label: "显示千位分隔符", hint: "大数字按三位分组显示；只影响显示，不影响计算精度",
        control: "switch", owner: "calculator", pane: "plugins", order: 20,
    },
    {
        key: "calculator.decimals", type: "string", default: "auto",
        values: ["auto", "0", "1", "2", "3", "4", "6", "8", "10"],
        valuesLabel: ["自动", "0 位", "1 位", "2 位", "3 位", "4 位", "6 位", "8 位", "10 位"],
        label: "小数位数", hint: "四舍五入的是显示值，存储仍是完整精度（99÷10 取 0 位显示 10）",
        control: "dropdown", owner: "calculator", pane: "plugins", order: 30,
    },
    {
        key: "calculator.keepHistory", type: "boolean", default: true,
        label: "保留历史记录", hint: "关掉后不再记录算式，已有记录仍会保留，可在历史记录面板清除",
        control: "switch", owner: "calculator", pane: "plugins", order: 40,
    },
    { key: "calculator.mode", type: "string", default: "basic", hidden: true },
    { key: "calculator.rpn", type: "boolean", default: false, hidden: true },
    { key: "calculator.convert", type: "boolean", default: false, hidden: true },
    { key: "calculator.units", type: "json", default: {}, hidden: true },
]);

/* ───────────────────────── 键位表 ───────────────────────── */

/** 键位描述：k = 动作 id，t = 字形（省略即用 k），cls = 配色档，help = 悬浮提示。 */
const KEYPADS = {
    basic: [
        [{ k: "ac", t: "AC", cls: "fn" }, { k: "neg", t: "+/−", cls: "fn" }, { k: "pct", t: "%", cls: "fn" }, { k: "op:/", t: "÷", cls: "op" }],
        [{ k: "7" }, { k: "8" }, { k: "9" }, { k: "op:*", t: "×", cls: "op" }],
        [{ k: "4" }, { k: "5" }, { k: "6" }, { k: "op:-", t: "−", cls: "op" }],
        [{ k: "1" }, { k: "2" }, { k: "3" }, { k: "op:+", t: "+", cls: "op" }],
        [{ k: "mode", t: "", cls: "fn modekey" }, { k: "0" }, { k: "." }, { k: "eq", t: "=", cls: "op" }],
    ],
    scientific: [
        [{ k: "lp", t: "(", cls: "fn" }, { k: "rp", t: ")", cls: "fn" }, { k: "mem:mc", t: "mc", cls: "fn" }, { k: "mem:m+", t: "m+", cls: "fn" }, { k: "mem:m-", t: "m−", cls: "fn" }, { k: "mem:mr", t: "mr", cls: "fn" }, { k: "ac", t: "⌫", cls: "fn" }, { k: "neg", t: "+/−", cls: "fn" }, { k: "pct", t: "%", cls: "fn" }, { k: "op:/", t: "÷", cls: "op" }],
        [{ k: "2nd", t: "2nd", cls: "fn" }, { k: "pow:sq", t: "x²", s: "2ˣ", sa: "fn:twoX", cls: "fn" }, { k: "pow:cube", t: "x³", cls: "fn" }, { k: "op:^", t: "xʸ", cls: "fn" }, { k: "pow:expE", t: "eˣ", cls: "fn" }, { k: "pow:exp10", t: "10ˣ", cls: "fn" }, { k: "7" }, { k: "8" }, { k: "9" }, { k: "op:*", t: "×", cls: "op" }],
        [{ k: "fn:inv", t: "¹∕ₓ", cls: "fn" }, { k: "fn:sqrt", t: "²√x", cls: "fn" }, { k: "fn:cbrt", t: "³√x", cls: "fn" }, { k: "fn:yroot", t: "ʸ√x", cls: "fn" }, { k: "fn:ln", t: "ln", s: "eˣ", sa: "fn:exp", cls: "fn" }, { k: "fn:log", t: "log₁₀", s: "log₂", sa: "fn:log2", cls: "fn" }, { k: "4" }, { k: "5" }, { k: "6" }, { k: "op:-", t: "−", cls: "op" }],
        [{ k: "fact", t: "x!", cls: "fn" }, { k: "fn:sin", t: "sin", s: "sin⁻¹", sa: "fn:asin", cls: "fn" }, { k: "fn:cos", t: "cos", s: "cos⁻¹", sa: "fn:acos", cls: "fn" }, { k: "fn:tan", t: "tan", s: "tan⁻¹", sa: "fn:atan", cls: "fn" }, { k: "const:e", t: "e", cls: "fn" }, { k: "op:EE", t: "EE", cls: "fn" }, { k: "1" }, { k: "2" }, { k: "3" }, { k: "op:+", t: "+", cls: "op" }],
        [{ k: "mode", t: "", cls: "fn modekey" }, { k: "fn:sinh", t: "sinh", s: "sinh⁻¹", sa: "fn:asinh", cls: "fn" }, { k: "fn:cosh", t: "cosh", s: "cosh⁻¹", sa: "fn:acosh", cls: "fn" }, { k: "fn:tanh", t: "tanh", s: "tanh⁻¹", sa: "fn:atanh", cls: "fn" }, { k: "const:pi", t: "π", cls: "fn" }, { k: "angle", t: "Rad", cls: "fn anglekey" }, { k: "rand", t: "Rand", cls: "fn" }, { k: "0" }, { k: "." }, { k: "eq", t: "=", cls: "op" }],
    ],
    programmer: [
        [{ k: "lp", t: "(", cls: "fn" }, { k: "rp", t: ")", cls: "fn" }, { k: "prog:XOR", cls: "fn" }, { k: "hex:D", cls: "fn hexkey" }, { k: "hex:E", cls: "fn hexkey" }, { k: "hex:F", cls: "fn hexkey" }, { k: "ac", t: "⌫", cls: "fn" }],
        [{ k: "prog:AND", cls: "fn" }, { k: "prog:OR", cls: "fn" }, { k: "prog:NOR", cls: "fn" }, { k: "hex:A", cls: "fn hexkey" }, { k: "hex:B", cls: "fn hexkey" }, { k: "hex:C", cls: "fn hexkey" }, { k: "op:/", t: "÷", cls: "op" }],
        [{ k: "prog:NOT", cls: "fn" }, { k: "prog:<<", cls: "fn" }, { k: "prog:>>", cls: "fn" }, { k: "7" }, { k: "8" }, { k: "9" }, { k: "op:*", t: "×", cls: "op" }],
        [{ k: "prog:NEG", cls: "fn" }, { k: "prog:X<<Y", cls: "fn" }, { k: "prog:X>>Y", cls: "fn" }, { k: "4" }, { k: "5" }, { k: "6" }, { k: "op:-", t: "−", cls: "op" }],
        [{ k: "prog:mod", cls: "fn" }, { k: "prog:RoL", cls: "fn" }, { k: "prog:RoR", cls: "fn" }, { k: "1" }, { k: "2" }, { k: "3" }, { k: "op:+", t: "+", cls: "op" }],
        [{ k: "mode", t: "", cls: "fn modekey" }, { k: "prog:flip8", cls: "fn" }, { k: "prog:flip16", cls: "fn" }, { k: "hex:FF", cls: "fn hexkey" }, { k: "0" }, { k: "hex:00", cls: "fn hexkey" }, { k: "eq", t: "=", cls: "op" }],
    ],
};

/** key id → 键位定义，2nd 换字形与换动作都要查它。 */
const KEY_INDEX = {};
Object.values(KEYPADS).forEach((rows) => rows.forEach((row) => row.forEach((k) => { KEY_INDEX[k.k] = k; })));

/** 悬浮帮助标签（苹果：把指针停在键上就能看到它干什么）。 */
const KEY_HELP = {
    ac: "清除：先清当前输入（C），再按一次全部清除（AC）；键盘 Delete 退一格、Esc 等价本键",
    neg: "对所显示的值取反（Option −）",
    pct: "百分比：有挂起运算时按 A+B% 求增量，否则除以 100",
    del: "删除最近输入的一位（Delete）",
    lp: "左括号", rp: "右括号",
    "2nd": "打开第二层函数（反函数、立方、10 的幂等）",
    "pow:sq": "平方", "pow:cube": "立方", "op:^": "x 的 y 次方", "pow:expE": "e 的 x 次方", "pow:exp10": "10 的 x 次方",
    "fn:inv": "取倒数", "fn:sqrt": "平方根", "fn:cbrt": "立方根", "fn:yroot": "y 次方根",
    "fn:ln": "自然对数", "fn:log": "以 10 为底的对数", fact: "阶乘",
    "fn:sin": "正弦", "fn:cos": "余弦", "fn:tan": "正切",
    "fn:sinh": "双曲正弦", "fn:cosh": "双曲余弦", "fn:tanh": "双曲正切",
    "const:pi": "圆周率 π", "const:e": "自然常数 e",
    rand: "生成 0 到 1 之间的随机数", angle: "在角度与弧度之间切换",
    "mem:mc": "清除记忆", "mem:m+": "把显示值加进记忆", "mem:m-": "从记忆减去显示值", "mem:mr": "读出记忆值",
    "op:EE": "科学记数法快捷方式（2 EE 5 就是 2×10⁵）",
    mode: "计算器模式：基础 / 科学 / 程序员 / 转换",
    eq: "求值（RPN 模式下是 Enter）",
    "prog:AND": "按位与", "prog:OR": "按位或", "prog:XOR": "按位异或",
    "prog:NOR": "按位或非", "prog:NOT": "按位取反", "prog:NEG": "取负（64 位补码）",
    "prog:<<": "左移一位", "prog:>>": "右移一位", "prog:X<<Y": "X 左移 Y 位", "prog:X>>Y": "X 右移 Y 位",
    "prog:RoL": "循环左移", "prog:RoR": "循环右移", "prog:flip8": "按字节反转（8 位组）", "prog:flip16": "按字反转（16 位组）",
    "prog:mod": "取余", "hex:FF": "一次输入两个 F", "hex:00": "一次输入两个 0",
};

/** 各模式的目标宽度（高度不写死：转换块、RPN 块、位网格都会各自加高，量出来的才算数）。 */
const MODE_WIDTH = { basic: 248, scientific: 412, programmer: 420 };
const HISTORY_WIDTH = 224;
/** 量高度时用的键帽行高（真实渲染由 1fr 分摊，这里只要给一个接近视觉值的数）。 */
const KEY_ROW = 42;

/* ───────────────────────── 运行状态 ───────────────────────── */

let mode = "basic";
let model = null;
let rpnState = null;
let rpnOn = false;
let convertOn = false;
let convertCategory = "length";
let convertTop = "m";
let convertBottom = "cm";
let prog = null;
let historyOpen = false;
let popoverHandle = null;
let unsubs = [];

function $(role) { return root.querySelector(`[data-role="${role}"]`); }

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
}

function options() {
    return {
        decimals: settings.get("calculator.decimals", "auto"),
        thousands: settings.get("calculator.thousands", true) !== false,
    };
}

/* ───────────────────────── 初始化 ───────────────────────── */

function init() {
    mode = ["basic", "scientific", "programmer"].includes(settings.get("calculator.mode", "basic"))
        ? settings.get("calculator.mode", "basic") : "basic";
    rpnOn = settings.get("calculator.rpn", false) === true;
    convertOn = settings.get("calculator.convert", false) === true;
    const savedUnits = settings.get("calculator.units", {}) || {};
    if (savedUnits.top && savedUnits.bottom) {
        convertTop = savedUnits.top;
        convertBottom = savedUnits.bottom;
        const cat = Conv.categoryOfUnit(convertTop);
        if (cat) convertCategory = cat.id;
    }
    resetModels();
    applyBackground();
    bindKeypad();
    bindChrome();
    bindSettings();
    bindKeyboard();
    registerMenuCommands();
    setMode(mode, { persist: false, resize: true });
    renderAll();
}

function resetModels() {
    model = Engine.createState(mode === "programmer" ? "basic" : mode, options());
    rpnState = Rpn.createRpn(options());
    prog = createProgState();
}

function createProgState() {
    return {
        word: 0n,
        radix: 10,
        buffer: "0",
        typing: false,
        pending: null,
        tokens: [],
        entry: "",
        display: "0",
        table: "ascii",
        showBits: false,
        error: false,
        memory: 0n,
    };
}

/* ───────────────────────── 渲染 ───────────────────────── */

function renderAll() {
    renderKeypad();
    renderDisplay();
    renderProgrammer();
    renderConvert();
    renderRpn();
    renderHistory();
    root.dataset.mode = mode;
    root.dataset.convert = convertOn ? "on" : "off";
    // 必须在内容都落进 DOM 之后再量高度：先量会量到空容器，把窗口钉成一条窄板
    resizeForMode();
}

function renderKeypad() {
    const keypad = $("keypad");
    keypad.innerHTML = "";
    keypad.style.setProperty("--cols", String(KEYPADS[mode][0].length));
    KEYPADS[mode].forEach((row) => {
        row.forEach((key) => {
            const btn = el("button", `calc-key ${key.cls || ""}`.trim());
            btn.type = "button";
            btn.dataset.key = key.k;
            if (key.k === "mode") {
                btn.append(el("span", "calc-icon calc-icon--mode"));
                btn.setAttribute("aria-label", "计算器模式");
            } else {
                btn.textContent = key.t || defaultLabel(key.k);
            }
            const help = KEY_HELP[key.k] || keyHelp(key.k);
            if (help) btn.title = help;
            if (key.k === "ac") btn.dataset.wide = "1";
            if (key.k === "eq") btn.dataset.wide = "1";
            keypad.appendChild(btn);
        });
    });
    syncKeypadState();
}

/** 2nd / Rad / RPN 会改键帽字形，渲染后统一同步。 */
function syncKeypadState() {
    root.querySelectorAll(".calc-key").forEach((btn) => {
        const key = btn.dataset.key;
        if (key === "ac" && mode === "basic") btn.textContent = model.typing || model.display !== "0" || model.pending ? "C" : "AC";
        if (key === "2nd") btn.classList.toggle("on", !!model.second);
        if (key === "angle") {
            btn.textContent = model.radians ? "Deg" : "Rad";
            btn.classList.toggle("on", model.radians);
        }
        if (key === "eq") btn.textContent = rpnOn && mode !== "programmer" ? "Enter" : "=";
        const def = KEY_INDEX[key];
        if (def && def.s) btn.textContent = (rpnOn ? rpnState.second : model.second) ? def.s : def.t;
        if (key.startsWith("prog:") || key.startsWith("hex:")) {
            const disabled = key.startsWith("hex:") && prog.radix !== 16;
            btn.classList.toggle("dim", disabled);
        }
    });
}

function keyHelp(key) {
    if (key.startsWith("digit:")) return `数字 ${key.slice(6)}`;
    if (/^[0-9]$/.test(key)) return `数字 ${key}`;
    if (key.startsWith("op:")) return `运算符 ${key.slice(3)}`;
    return "";
}

function defaultLabel(key) {
    if (key.startsWith("prog:")) return key.slice(5).replace("flip8", "flip₈").replace("flip16", "flip₁₆");
    if (key.startsWith("hex:")) return key.slice(4);
    if (key.startsWith("op:")) return Engine.GLYPH[key.slice(3)] || key.slice(3);
    return key;
}

function renderDisplay() {
    const entry = $("entry");
    const value = $("value");
    if (mode === "programmer") {
        entry.textContent = prog.entry || "";
        value.textContent = `${prog.display || "0"}${prog.radix === 8 ? "₈" : prog.radix === 16 ? "₁₆" : ""}`;
    } else if (rpnOn) {
        entry.textContent = rpnState.note || "";
        value.textContent = Rpn.rpnDisplay(rpnState);
    } else {
        entry.textContent = model.entry || "";
        value.textContent = model.display;
    }
    $("angle").hidden = mode !== "scientific" || !model.radians;
    $("angle").textContent = "Rad";
    $("memory").hidden = !model.memory;
    $("memory").textContent = `M ${Engine.formatNumber(model.memory, options())}`;
    $("rpn").hidden = !rpnOn || mode === "programmer";
}

function renderProgrammer() {
    const block = $("programmer");
    block.hidden = mode !== "programmer";
    if (mode !== "programmer") return;
    $("radixTag").hidden = true;
    const char = Prog.charFor(prog.word, prog.table);
    // 没有字形可显示时给名字（BEL/CR…），连名字都没有就直说，留白会让人以为控件坏了
    $("charBox").textContent = char.text || char.label || "无对应字符";
    $("charBox").title = char.hint || `码位 ${prog.word.toString(16).toUpperCase()}₁₆`;
    $("tableAscii").classList.toggle("on", prog.table === "ascii");
    $("tableUnicode").classList.toggle("on", prog.table === "unicode");
    $("bitsToggle").classList.toggle("on", prog.showBits);
    block.querySelectorAll("[data-radix]").forEach((btn) => {
        btn.classList.toggle("on", Number(btn.dataset.radix) === prog.radix);
    });
    const bits = $("bits");
    bits.innerHTML = "";
    bits.hidden = !prog.showBits;
    if (!prog.showBits) return;
    const groups = Prog.bitGroups(prog.word);
    groups.groups.forEach((group, index) => {
        const cell = el("div", "calc-bitgroup");
        const row = el("div", "calc-bitgroup-bits");
        group.split("").forEach((bit, i) => {
            const indexFromLsb = (groups.groups.length - 1 - index) * 4 + (3 - i);
            const b = el("button", "calc-bit" + (bit === "1" ? " on" : ""), bit);
            b.type = "button";
            b.dataset.bit = String(indexFromLsb);
            b.title = `第 ${indexFromLsb} 位（点按取反）`;
            row.appendChild(b);
        });
        cell.appendChild(row);
        cell.appendChild(el("span", "calc-bitgroup-label", String(groups.bitLabels[index])));
        bits.appendChild(cell);
    });
}

function renderConvert() {
    const block = $("convert");
    block.hidden = !convertOn || mode === "programmer";
    if (block.hidden) return;
    const top = Engine.currentValue(model);
    const topNumber = top === null ? 0 : top;
    const converted = Conv.convert(topNumber, convertTop, convertBottom);
    const topUnit = Conv.findUnit(convertTop);
    const bottomUnit = Conv.findUnit(convertBottom);
    $("convTop").textContent = Conv.formatValue(topNumber, { thousands: options().thousands });
    $("convBottom").textContent = converted === null
        ? "—"
        : Conv.formatValue(converted, { thousands: options().thousands, decimals: bottomUnit ? bottomUnit.unit.decimalsHint : undefined });
    $("convTopUnit").textContent = topUnit ? topUnit.unit.name : "?";
    $("convBottomUnit").textContent = bottomUnit ? bottomUnit.unit.name : "?";
    $("convNote").textContent = convertCategory === "currency"
        ? `货币为 ${Conv.RATE_DATE} 的离线快照，不是实时汇率`
        : "";
}

function renderRpn() {
    const block = $("rpn");
    const show = rpnOn && mode !== "programmer";
    block.hidden = !show;
    if (!show) return;
    const rows = $("rpnRows");
    rows.innerHTML = "";
    Rpn.rpnRows(rpnState).forEach((row) => {
        const line = el("div", "calc-rpn-row");
        line.appendChild(el("span", "calc-rpn-label", row.label));
        line.appendChild(el("span", "calc-rpn-value", row.text));
        rows.appendChild(line);
    });
}

function renderHistory() {
    const panel = $("historyPanel");
    panel.hidden = !historyOpen;
    if (!historyOpen) return;
    const list = $("historyList");
    list.innerHTML = "";
    const groups = History.groupByDay();
    if (!groups.length) {
        list.appendChild(el("p", "calc-history-empty", "还没有记录。按 = 求值后会自动记下来。"));
        return;
    }
    groups.forEach((group) => {
        const box = el("div", "calc-history-group");
        box.appendChild(el("h4", "calc-history-day", group.label));
        group.items.forEach((item) => {
            const row = el("div", "calc-history-item");
            row.tabIndex = 0;
            row.appendChild(el("p", "calc-history-expr", item.expr));
            row.appendChild(el("p", "calc-history-result", item.result));
            const tools = el("div", "calc-history-tools");
            const copy = el("button", "calc-history-btn", "拷贝");
            copy.type = "button";
            copy.title = "把结果复制到剪贴板";
            copy.addEventListener("click", (event) => {
                event.stopPropagation();
                copyToClipboard(item.result);
            });
            const del = el("button", "calc-history-btn danger", "删除");
            del.type = "button";
            del.title = "删除这条记录";
            del.addEventListener("click", (event) => {
                event.stopPropagation();
                History.removeHistory(item.id);
                renderHistory();
            });
            tools.append(copy, del);
            row.appendChild(tools);
            row.addEventListener("click", () => recallResult(item.result));
            box.appendChild(row);
        });
        list.appendChild(box);
    });
}

function copyToClipboard(text) {
    try {
        // writeText 返回 Promise：权限被拒/文档失焦是异步拒绝，try/catch 捕不到，
        // 不挂 .catch 就是 unhandledrejection 噪音（BUG-71）
        navigator.clipboard.writeText(String(text).replace(/,/g, ""))
            .catch((err) => console.warn("[calculator] 剪贴板写入被拒：", err));
    } catch (err) {
        console.warn("[calculator] 剪贴板不可用：", err);
    }
}

/** 历史记录点一下：把那条结果拿回来当当前输入。 */
function recallResult(text) {
    const value = Number(String(text).replace(/,/g, ""));
    if (!Number.isFinite(value)) return;
    if (mode === "programmer") {
        prog.word = Prog.wrap(BigInt(Math.trunc(value)));
        prog.buffer = String(Math.trunc(value));
        prog.display = Prog.toRadix(prog.word, prog.radix);
    } else if (rpnOn) {
        rpnState.typing = false;
        rpnState.x = value;
    } else {
        Engine.resetAll(model);
        model.display = Engine.formatNumber(value, options());
        model.buffer = String(value);
        model.typing = false;
        model.justEvaluated = true;
    }
    renderDisplay();
    renderProgrammer();
    renderRpn();
    renderConvert();
}

/* ───────────────────────── 按键派发 ───────────────────────── */

function bindKeypad() {
    $("keypad").addEventListener("click", (event) => {
        const btn = event.target.closest(".calc-key");
        if (!btn) return;
        press(btn.dataset.key);
    });
    $("bits").addEventListener("click", (event) => {
        const cell = event.target.closest(".calc-bit");
        if (!cell) return;
        prog.word = Prog.toggleBit(prog.word, Number(cell.dataset.bit));
        prog.display = Prog.toRadix(prog.word, prog.radix);
        prog.buffer = prog.word.toString(prog.radix);
        renderDisplay();
        renderProgrammer();
    });
}

function press(key) {
    closePopover();
    if (key === "mode") return openModeMenu(root.querySelector('.calc-key[data-key="mode"]'));
    // 2nd 是一次性的：它把键位换成第二动作，按完就退出
    const def = KEY_INDEX[key];
    if (def && def.sa && (rpnOn ? rpnState.second : model.second)) {
        if (rpnOn) rpnState.second = false;
        else model.second = false;
        key = def.sa;
    }
    if (mode === "programmer") return pressProgrammer(key);
    if (rpnOn) return pressRpn(key);
    return pressCalc(key);
}

function pressCalc(key) {
    const [kind, arg] = key.includes(":") ? key.split(":") : ["digit", key];
    switch (kind) {
        case "digit":
            if (/^[0-9]$/.test(arg)) Engine.pressDigit(model, arg);
            break;
        case "op":
            Engine.pressOperator(model, arg);
            break;
        case "fn":
            Engine.pressFunction(model, arg);
            break;
        case "pow":
            Engine.pressPower(model, arg);
            break;
        case "const":
            Engine.pressConstant(model, arg === "pi" ? "pi" : "e");
            break;
        case "mem":
            if (arg === "mc") Engine.pressMemoryClear(model);
            if (arg === "m+") Engine.pressMemoryAdd(model);
            if (arg === "m-") Engine.pressMemorySubtract(model);
            if (arg === "mr") Engine.pressMemoryRecall(model);
            break;
        default:
            break;
    }
    switch (key) {
        case ".":
            Engine.pressDot(model);
            break;
        case "eq":
            commitAndMaybeRecord(() => Engine.pressEquals(model));
            break;
        case "ac":
            Engine.pressClearKey(model);
            break;
        case "del":
            Engine.pressDelete(model);
            break;
        case "neg":
            Engine.pressNegate(model);
            break;
        case "pct":
            Engine.pressPercent(model);
            break;
        case "2nd":
            Engine.pressToggleSecond(model);
            break;
        case "angle":
            Engine.pressToggleAngle(model);
            break;
        case "rand":
            Engine.pressRandom(model);
            break;
        case "fact":
            Engine.pressFactorial(model);
            break;
        case "lp":
        case "rp":
            Engine.pressParen(model);
            break;
        default:
            break;
    }
    if (convertOn) renderConvert();
    renderDisplay();
    syncKeypadState();
    renderRpn();
}

/** 求值后把算式记进历史（连续按 = 不重复记同一条）。 */
function commitAndMaybeRecord(run) {
    const before = model.last;
    run();
    if (!model.last || model.last === before) return;
    if (settings.get("calculator.keepHistory", true) !== false) {
        History.addHistory({ expr: model.last.expr, result: model.last.result, mode });
    }
    if (historyOpen) renderHistory();
}

function pressRpn(key) {
    const [kind, arg] = key.includes(":") ? key.split(":") : ["digit", key];
    if (kind === "digit" && /^[0-9]$/.test(arg)) Rpn.pressRpnDigit(rpnState, arg);
    else if (kind === "fn") Rpn.pressRpnUnary(rpnState, arg);
    else if (kind === "pow" && (arg === "sq" || arg === "cube")) Rpn.pressRpnUnary(rpnState, arg === "sq" ? "pow2" : "pow3");
    else if (kind === "pow" && arg === "expE") Rpn.pressRpnUnary(rpnState, "exp");
    else if (kind === "const") {
        rpnState.x = arg === "pi" ? Math.PI : Math.E;
        rpnState.typing = false;
    }
    else {
        switch (key) {
            case ".":
                Rpn.pressRpnDot(rpnState);
                break;
            case "eq": {
                Rpn.pressRpnEnter(rpnState);
                if (settings.get("calculator.keepHistory", true) !== false) {
                    History.addHistory({ expr: "Enter", result: Rpn.rpnDisplay(rpnState), mode: `${mode}+rpn` });
                }
                if (historyOpen) renderHistory();
                break;
            }
            case "ac":
                // RPN 下同样两档：有输入先清 X，干净时全清堆栈
                if (rpnState.typing || rpnState.x !== 0) Rpn.clearRpnEntry(rpnState);
                else Rpn.clearRpn(rpnState);
                break;
            case "del":
                Rpn.pressRpnDelete(rpnState);
                break;
            case "neg":
                Rpn.pressRpnNegate(rpnState);
                break;
            case "pct":
                Rpn.pressRpnPercent(rpnState);
                break;
            case "rpnSwap":
                Rpn.pressRpnSwap(rpnState);
                break;
            case "rpnUp":
                Rpn.pressRpnRollUp(rpnState);
                break;
            case "rpnDown":
                Rpn.pressRpnRollDown(rpnState);
                break;
            case "rpnDrop":
                Rpn.pressRpnDrop(rpnState);
                break;
            case "2nd":
            case "angle":
            case "rand":
            case "fact":
            case "lp":
            case "rp":
                if (key === "rand") {
                    rpnState.x = Math.random();
                    rpnState.typing = false;
                }
                if (key === "fact") Rpn.pressRpnUnary(rpnState, "fact");
                if (key === "2nd") rpnState.second = !rpnState.second;
                if (key === "angle") rpnState.radians = !rpnState.radians;
                break;
            default:
                if (kind === "op") Rpn.pressRpnBinary(rpnState, arg);
                break;
        }
    }
    renderDisplay();
    renderRpn();
    syncKeypadState();
}

/* ───────────────────────── 程序员模式 ───────────────────────── */

function pressProgrammer(key) {
    const [kind, arg] = key.includes(":") ? key.split(":") : ["digit", key];
    // 这里一律走分支后落到函数末尾统一渲染：早退的 `return` 会跳过渲染，
    // 表现为「按了数字但显示行不动」，直到按下等号才一次性跳出来。
    if (kind === "digit" && /^[0-9]$/.test(arg)) progAppend(arg);
    else if (kind === "hex") progAppend(arg);
    else if (kind === "op") progOperator(arg);
    else if (kind === "prog") progFunction(arg);
    else switch (key) {
        case "ac":
            prog.word = 0n;
            prog.buffer = "0";
            prog.typing = false;
            prog.pending = null;
            prog.entry = "";
            prog.display = "0";
            break;
        case "del":
            prog.buffer = Prog.backspace(prog.buffer, prog.radix);
            prog.display = prog.buffer || "0";
            prog.word = Prog.fromRadix(prog.buffer || "0", prog.radix) ?? 0n;
            if (!prog.buffer) prog.typing = false;
            break;
        case "neg":
            prog.word = Prog.unaryOp(prog.word, "NEG");
            prog.display = Prog.toRadix(prog.word, prog.radix);
            break;
        case "lp":
        case "rp":
            // 程序员模式不支持嵌套表达式，括号退化为「以当前值为左操作数」
            break;
        case "eq":
            progEquals();
            break;
        default:
            break;
    }
    renderDisplay();
    renderProgrammer();
    // 换进制会改「哪些十六进制键可用」，不同步键帽就会一直灰着（dim 只在这里同步）
    syncKeypadState();
}

function progAppend(text) {
    if (!prog.typing) {
        prog.buffer = "";
        prog.typing = true;
    }
    const next = Prog.appendInput(prog.buffer, text, prog.radix);
    if (next === null) return;
    prog.buffer = next;
    prog.display = next || "0";
}

function progOperator(op) {
    const value = currentProgWord();
    if (op === "NOT") {
        prog.word = Prog.unaryOp(value, "NOT");
        prog.display = Prog.toRadix(prog.word, prog.radix);
        prog.typing = false;
        return;
    }
    if (op === "NEG") {
        prog.word = Prog.unaryOp(value, "NEG");
        prog.display = Prog.toRadix(prog.word, prog.radix);
        prog.typing = false;
        return;
    }
    if (op === "flip8" || op === "flip16") {
        prog.word = Prog.flipBytes(value, op === "flip8" ? 8 : 16);
        prog.display = Prog.toRadix(prog.word, prog.radix);
        prog.typing = false;
        return;
    }
    if (op === "RoL" || op === "RoR") {
        prog.pending = { left: value, op };
        prog.entry = `${Prog.toRadix(value, prog.radix)} ${op}`;
        prog.typing = false;
        return;
    }
    if (op === "X<<Y" || op === "X>>Y") {
        prog.pending = { left: value, op: op === "X<<Y" ? "<<" : ">>" };
        prog.entry = `${Prog.toRadix(value, prog.radix)} ${op}`;
        prog.typing = false;
        return;
    }
    if (op === "<<" || op === ">>") {
        prog.word = Prog.shiftPair(value, 1n, op);
        prog.display = Prog.toRadix(prog.word, prog.radix);
        prog.typing = false;
        return;
    }
    prog.pending = { left: value, op };
    prog.entry = `${Prog.toRadix(value, prog.radix)} ${op}`;
    prog.typing = false;
}

function progFunction(name) {
    return progOperator(name);
}

function currentProgWord() {
    if (!prog.typing) return prog.word;
    const parsed = Prog.fromRadix(prog.buffer, prog.radix);
    return parsed === null ? prog.word : parsed;
}

function progEquals() {
    if (!prog.pending) {
        prog.word = currentProgWord();
        prog.entry = "";
        prog.display = Prog.toRadix(prog.word, prog.radix);
        prog.typing = false;
        return;
    }
    const { left, op } = prog.pending;
    const right = currentProgWord();
    const result = Prog.binaryOp(left, op, right);
    prog.pending = null;
    prog.entry = "";
    if (result === null) {
        prog.display = "错误";
        prog.error = true;
        return;
    }
    prog.error = false;
    prog.word = result;
    prog.display = Prog.toRadix(result, prog.radix);
    prog.typing = false;
    if (settings.get("calculator.keepHistory", true) !== false) {
        History.addHistory({ expr: `${Prog.toRadix(left, prog.radix)} ${op} ${Prog.toRadix(right, prog.radix)}`, result: prog.display, mode: "programmer" });
    }
    if (historyOpen) renderHistory();
}

/* ───────────────────────── 窗口外壳交互 ───────────────────────── */

function bindChrome() {
    $("history").addEventListener("click", () => toggleHistory());
    $("historyClear").addEventListener("click", async () => {
        const dialog = window.__dialog;
        if (dialog && !(await dialog.confirm("清除历史记录", "将删除全部计算记录，无法撤销。", { danger: true }))) return;
        History.clearHistory();
        renderHistory();
    });
    $("convSwap").addEventListener("click", () => {
        const top = convertTop;
        convertTop = convertBottom;
        convertBottom = top;
        saveUnits();
        renderConvert();
    });
    $("convTopUnit").addEventListener("click", (event) => openUnitMenu(event.currentTarget, "top"));
    $("convBottomUnit").addEventListener("click", (event) => openUnitMenu(event.currentTarget, "bottom"));
    $("tableAscii").addEventListener("click", () => { prog.table = "ascii"; renderProgrammer(); });
    $("tableUnicode").addEventListener("click", () => { prog.table = "unicode"; renderProgrammer(); });
    $("bitsToggle").addEventListener("click", () => {
        prog.showBits = !prog.showBits;
        renderProgrammer();
        resizeForMode();
    });
    $("programmer").querySelectorAll("[data-radix]").forEach((btn) => {
        btn.addEventListener("click", () => {
            prog.radix = Number(btn.dataset.radix);
            prog.display = Prog.toRadix(prog.word, prog.radix);
            prog.buffer = prog.typing ? Prog.toRadix(prog.word, prog.radix) : prog.display;
            renderDisplay();
            renderProgrammer();
            syncKeypadState();
        });
    });
    $("rpn").querySelectorAll("[data-key]").forEach((btn) => {
        btn.addEventListener("click", () => press(btn.dataset.key));
    });
}

function toggleHistory(force) {
    historyOpen = force === undefined ? !historyOpen : !!force;
    renderHistory();
    // 侧栏占一列，窗口宽度必须跟着变，否则历史会把键帽挤扁
    resizeForMode();
}

function closePopover() {
    if (popoverHandle) {
        popoverHandle.close();
        popoverHandle = null;
    }
}

/** 模式浮层：左下角的「计算器模式」键与标题栏都调它。 */
function openModeMenu(anchor) {
    if (!anchor) return;
    closePopover();
    const menu = el("div", "calc-menu");
    const item = (label, on, onClick, hint) => {
        const row = el("button", "calc-menu-item" + (on ? " on" : ""));
        row.type = "button";
        row.appendChild(el("span", "calc-menu-check", on ? "✓" : ""));
        row.appendChild(el("span", "calc-menu-label", label));
        if (hint) row.appendChild(el("kbd", "calc-menu-key", hint));
        row.addEventListener("click", () => { onClick(); closePopover(); });
        return row;
    };
    menu.append(
        item("基础", mode === "basic" && !convertOn, () => setMode("basic")),
        item("科学", mode === "scientific" && !convertOn, () => setMode("scientific")),
        item("程序员", mode === "programmer", () => setMode("programmer")),
    );
    if (mode !== "programmer") {
        menu.append(el("hr", "calc-menu-sep"));
        menu.append(item("转换", convertOn, () => setConvert(!convertOn), "⌥⌘C"));
    }
    menu.append(item("RPN 模式", rpnOn && mode !== "programmer", () => setRpn(!rpnOn), "⌘R"));
    menu.append(el("hr", "calc-menu-sep"));
    menu.append(item("历史记录", historyOpen, () => toggleHistory(true), "⌘H"));
    popoverHandle = openPopover({ anchor, content: menu, align: "start", gap: 6, scope: ["calculator"] });
}

/** 单位菜单：先选类别再选单位，两级都在同一个浮层里（避免连开两个浮层互相顶掉）。 */
function openUnitMenu(anchor, which) {
    closePopover();
    const menu = el("div", "calc-menu calc-menu--units");
    const cats = el("div", "calc-menu-cats");
    const list = el("div", "calc-menu-units");
    const renderUnits = (categoryId) => {
        list.innerHTML = "";
        const category = Conv.CATEGORIES.find((c) => c.id === categoryId) || Conv.CATEGORIES[0];
        convertCategory = category.id;
        category.units.forEach((unit) => {
            const row = el("button", "calc-menu-item" + (unit.id === (which === "top" ? convertTop : convertBottom) ? " on" : ""));
            row.type = "button";
            row.appendChild(el("span", "calc-menu-label", unit.name));
            row.appendChild(el("span", "calc-menu-sym", unit.symbol));
            row.addEventListener("click", () => {
                if (which === "top") convertTop = unit.id;
                else convertBottom = unit.id;
                if (!Conv.categoryOfUnit(convertTop) || !Conv.categoryOfUnit(convertBottom)
                    || Conv.isCrossCategory(convertTop, convertBottom)) {
                    // 跨类别没有意义：把另一边拉到同一类别里，缺省用该类别第二个单位
                    const other = Conv.unitsOf(category.id).find((u) => u.id !== (which === "top" ? convertTop : convertBottom));
                    if (which === "top") convertBottom = other ? other.id : convertBottom;
                    else convertTop = other ? other.id : convertTop;
                }
                saveUnits();
                closePopover();
                renderConvert();
            });
            list.appendChild(row);
        });
        cats.querySelectorAll(".calc-menu-cat").forEach((btn) => btn.classList.toggle("on", btn.dataset.cat === category.id));
    };
    Conv.CATEGORIES.forEach((category) => {
        const btn = el("button", "calc-menu-cat", category.label);
        btn.type = "button";
        btn.dataset.cat = category.id;
        btn.addEventListener("click", () => renderUnits(category.id));
        cats.appendChild(btn);
    });
    menu.append(cats, list);
    renderUnits(convertCategory);
    popoverHandle = openPopover({ anchor, content: menu, align: "end", gap: 6, scope: ["calculator"] });
}

function saveUnits() {
    settings.set("calculator.units", { top: convertTop, bottom: convertBottom, category: convertCategory }, { source: "calculator" });
}

/* ───────────────────────── 模式切换 ───────────────────────── */

function setMode(next, opts = {}) {
    const { persist = true, resize = true } = opts;
    if (!KEYPADS[next]) return;
    if (mode === "programmer" && next !== "programmer" && !model) model = Engine.createState(next, options());
    mode = next;
    if (next === "programmer") convertOn = false;
    if (model) {
        model.mode = next === "programmer" ? "basic" : next;
        Engine.resetAll(model);
    }
    if (next === "programmer") {
        prog = prog || createProgState();
        rpnOn = false;
    }
    if (persist) settings.set("calculator.mode", next, { source: "calculator" });
    renderAll();
    if (resize) resizeForMode();
    syncMenu();
}

function setConvert(on) {
    convertOn = !!on && mode !== "programmer";
    settings.set("calculator.convert", convertOn, { source: "calculator" });
    renderAll();
    syncMenu();
}

function setRpn(on) {
    rpnOn = !!on && mode !== "programmer";
    settings.set("calculator.rpn", rpnOn, { source: "calculator" });
    renderAll();
    syncMenu();
}

function resizeForMode() {
    const width = (MODE_WIDTH[mode] || MODE_WIDTH.basic) + (historyOpen ? HISTORY_WIDTH : 0);
    // 临时放开内联高度量自然高度：窗口是 flex 列，内容自决高度，比拼「模式+开关」尺寸表可靠。
    // 键帽行是 minmax(0,1fr)，量前须先给真实行高（否则会塌成 min-height 量偏小），量完再交还 1fr 分摊。
    const keypad = $("keypad");
    const inline = root.style.height;
    const inlineRows = keypad.style.gridAutoRows;
    keypad.style.gridAutoRows = `${KEY_ROW}px`;
    root.style.height = "auto";
    const height = Math.ceil(root.getBoundingClientRect().height);
    root.style.height = inline;
    keypad.style.gridAutoRows = inlineRows;
    const api = window.Deskly && window.Deskly.windows;
    if (api && typeof api.configure === "function") {
        Promise.resolve(api.configure(null, { width, height })).catch((err) => {
            console.warn("[calculator] 调整窗口尺寸失败：", err);
        });
        return;
    }
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
}

/* ───────────────────────── 设置联动 ───────────────────────── */

function applyBackground() {
    const value = settings.get("calculator.background", "glass");
    root.dataset.bg = value === "solid" ? "solid" : "glass";
}

function bindSettings() {
    const sync = () => {
        applyBackground();
        Object.assign(model, options());
        Object.assign(rpnState, options());
        renderAll();
    };
    ["calculator.background", "calculator.thousands", "calculator.decimals", "calculator.keepHistory"].forEach((key) => {
        unsubs.push(settings.on(key, sync));
    });
}

/* ───────────────────────── 键盘 ───────────────────────── */

const KEY_MAP = {
    Enter: "eq", "=": "eq",
    Escape: "ac",
    Backspace: "del",
    Delete: "del",
    "+": "op:+", "-": "op:-", "*": "op:*", "/": "op:/", "^": "op:^", "%": "pct", "!": "fact",
    "(": "lp", ")": "rp", ".": ".", ",": ".",
    e: "const:e", c: "ac",
};

function bindKeyboard() {
    document.addEventListener("keydown", onKeyDown, true);
    unsubs.push(() => document.removeEventListener("keydown", onKeyDown, true));
}

function onKeyDown(event) {
    if (!root.isConnected || root.classList.contains("minimized")) return;
    // 捕获阶段挂在 document 上，必须只响应「本窗口是活动窗口」的按键：
    // 否则开着计算器，别的窗口里 ⌘C/数字键/⌘R 全被它拦下（BUG-65）。
    if (!root.classList.contains("is-active")) return;
    const target = event.target;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    const meta = event.metaKey || event.ctrlKey;

    if (meta && event.key === "1") return modeShortcut(event, "basic");
    if (meta && event.key === "2") return modeShortcut(event, "scientific");
    if (meta && event.key === "3") return modeShortcut(event, "programmer");
    if (meta && event.key.toLowerCase() === "r") return modeShortcut(event, "__rpn");
    if (meta && event.key.toLowerCase() === "h") return modeShortcut(event, "__history");
    if (meta && event.altKey && event.key.toLowerCase() === "c") return modeShortcut(event, "__convert");
    if (meta && event.key.toLowerCase() === "c" && !event.altKey) {
        event.preventDefault();
        return copyToClipboard($("value").textContent);
    }
    if (meta) return;
    if (event.altKey && event.key === "-") {
        event.preventDefault();
        press("neg");
        return;
    }
    if (event.altKey && event.code === "Escape") {
        event.preventDefault();
        press("ac");
        return;
    }
    const mapped = KEY_MAP[event.key] || (/^[0-9]$/.test(event.key) ? event.key : null);
    if (!mapped) return;
    if (!hasKey(mapped) && !(mode === "programmer" && /^[0-9]$/.test(mapped))) return;
    event.preventDefault();
    press(mapped);
    flashKey(mapped);
}

function modeShortcut(event, target) {
    event.preventDefault();
    if (target === "__rpn") return setRpn(!rpnOn);
    if (target === "__history") return toggleHistory();
    if (target === "__convert") return setConvert(!convertOn);
    setMode(target);
}

function hasKey(key) {
    return KEYPADS[mode].some((row) => row.some((k) => k.k === key));
}

/** 键盘触发时给对应键帽一个短暂的按下态，让「按了哪个键」看得见。 */
function flashKey(key) {
    const btn = root.querySelector(`.calc-key[data-key="${key}"]`);
    if (!btn) return;
    btn.classList.add("flash");
    setTimeout(() => btn.classList.remove("flash"), 120);
}

/* ───────────────────────── 顶栏菜单命令 ───────────────────────── */

const MENU_COMMANDS = {
    calcSetMode(value) { setMode(value); },
    calcToggleRpn() { setRpn(!rpnOn); },
    calcToggleConvert() { setConvert(!convertOn); },
    calcToggleHistory() { toggleHistory(); },
    calcToggleThousands() { settings.set("calculator.thousands", settings.get("calculator.thousands", true) === false, { source: "calculator" }); },
    calcClearEntry() { press("ac"); },
    calcCopyResult() { copyToClipboard($("value").textContent); },
    calcOpenModeMenu() { openModeMenu(root.querySelector('.calc-key[data-key="mode"]')); },
};
const MENU_KEYS = Object.keys(MENU_COMMANDS);

function registerMenuCommands() {
    window.__menuActions = window.__menuActions || {};
    MENU_KEYS.forEach((key) => { window.__menuActions[key] = MENU_COMMANDS[key]; });
}

function syncMenu() {
    // 顶栏菜单画不了勾（finderbar 的字段白名单里没有 checked），
    // 所以「当前模式」只反映在窗口内：mode 键的浮层与标题栏 aria-label。
    root.setAttribute("aria-label", `计算器 · ${mode === "basic" ? "基础" : mode === "scientific" ? "科学" : "程序员"}${convertOn ? " · 转换" : ""}${rpnOn ? " · RPN" : ""}`);
}

/* ───────────────────────── 卸载清理 ───────────────────────── */

const onCalcUnload = (event) => {
    if ((event.detail || {}).id !== "calculator") return;
    window.removeEventListener("plugin-unload", onCalcUnload);
    closePopover();
    unsubs.forEach((off) => { try { off(); } catch (err) { /* 尽力而为 */ } });
    unsubs = [];
    MENU_KEYS.forEach((key) => {
        if (window.__menuActions && window.__menuActions[key] === MENU_COMMANDS[key]) delete window.__menuActions[key];
    });
};
window.addEventListener("plugin-unload", onCalcUnload);

/* ───────────────────────── 启动 ─────────────────────────
   必须放在所有模块级 `let` 与函数声明之后：init() 会给 mode / rpnOn 等赋值，
   写在文件顶部会撞 TDZ（Cannot access 'mode' before initialization），整个界面都不渲染。 */
if (!root) {
    console.warn("[calculator] 未找到窗口根元素，跳过初始化");
} else {
    init();
}

