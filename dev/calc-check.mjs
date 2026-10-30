/**
 * dev/calc-check.mjs — 计算器内核的 Node 断言（engine / rpn / history）
 *
 * 为什么单独一份：programmer.js 与 convert.js 各有自己的校验
 * （dev/calc-programmer-check.mjs、dev/calc-convert-check.mjs），
 * 这三个文件是计算器的「算得对不对」的全部剩余面积 ——
 * 运算次序、四舍五入显示、Deg/Rad、EE、阶乘、RPN 堆栈滚动、历史纸带落盘。
 * 浏览器里点按键验这些，成本是这里的十倍，而且错了也看不出来。
 *
 * 用法：`node dev/calc-check.mjs`（全绿退出码 0）
 */

import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOD = (name) => pathToFileURL(resolve(HERE, "..", "mods", "calculator", name)).href;

/* localStorage 替身：history.js 在拿不到时会退回内存，这里给一个能用的 */
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
};

const E = await import(MOD("engine.js"));
const R = await import(MOD("rpn.js"));
const H = await import(MOD("history.js"));
const P = await import(MOD("programmer.js"));
const C = await import(MOD("convert.js"));

let passed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed += 1; return; }
    failures.push(`${name}${extra === undefined ? "" : ` — 实得 ${JSON.stringify(extra)}`}`);
}
function eq(name, actual, expected) {
    check(`${name}（期望 ${JSON.stringify(expected)}）`, actual === expected, actual);
}
function near(name, actual, expected, eps = 1e-9) {
    check(`${name}（期望 ≈${expected}）`, typeof actual === "number" && Math.abs(actual - expected) <= eps * Math.max(1, Math.abs(expected)), actual);
}

/** 科学模式跑一串操作，返回模型 */
function sci(steps, opts) {
    const s = E.createState("scientific", opts);
    steps(s);
    return s;
}
function bas(steps, opts) {
    const s = E.createState("basic", opts);
    steps(s);
    return s;
}
const digits = (...ks) => (s) => ks.forEach((k) => E.pressDigit(s, k));
const op = (o) => (s) => E.pressOperator(s, o);
const eqs = () => (s) => E.pressEquals(s);

/* ───────────────────────── 1. 显示格式化 ───────────────────────── */

eq("千位分隔", E.formatNumber(1234567.891, { thousands: true, decimals: 2 }), "1,234,567.89");
eq("不分位", E.formatNumber(1234567.891, { thousands: false, decimals: 2 }), "1234567.89");
eq("自动位数去掉二进制误差", E.formatNumber(0.1 + 0.2, { decimals: "auto" }), "0.3");
eq("末尾零不显示", E.formatNumber(1.5, { decimals: 4 }), "1.5000");
eq("0 位小数四舍五入显示", E.formatNumber(9.9, { decimals: 0 }), "10");
eq("负零归一", E.formatNumber(-0, {}), "0");
eq("大数走科学计数", E.formatNumber(1e21, {}), "1e21");
eq("极小走科学计数", E.formatNumber(1.5e-12, {}), "1.5e-12");
eq("NaN 返回空串（界面另有错误态）", E.formatNumber(NaN, {}), "");
eq("Infinity 返回空串", E.formatNumber(Infinity, {}), "");
eq("负数分位", E.formatNumber(-1234567, { thousands: true }), "-1,234,567");
eq("小数位数归一 auto", E.normalizeDecimals("auto"), "auto");
eq("小数位数越界钳制", E.normalizeDecimals(99), 10);
eq("小数位数非法退回 auto", E.normalizeDecimals("abc"), "auto");

/* ───────────────────────── 2. 基础模式：立即执行 ───────────────────────── */

check("35+5=40", bas((s) => { digits("3", "5")(s); op("+")(s); digits("5")(s); eqs()(s); }).display === "40");
eq("结果后直接按 = 重复上一算式（40+40）", bas((s) => { digits("3", "5")(s); op("+")(s); digits("5")(s); eqs()(s); op("+")(s); eqs()(s); }).display, "80");
eq("结果后按 + 再敲 5 = 45", bas((s) => { digits("3", "5")(s); op("+")(s); digits("5")(s); eqs()(s); op("+")(s); digits("5")(s); eqs()(s); }).display, "45");
check("标准次序：基础模式是立即执行，2+3×4 = 20", bas((s) => {
    digits("2")(s); op("+")(s); digits("3")(s); op("*")(s); digits("4")(s); eqs()(s);
}).display === "20");
eq("除零进错误态", bas((s) => { digits("1")(s); op("/")(s); digits("0")(s); eqs()(s); }).display, "错误");
check("错误态后数字键复位", bas((s) => {
    digits("1")(s); op("/")(s); digits("0")(s); eqs()(s); digits("7")(s);
}).display === "7");
eq("敲错运算符时只替换不重复计算", bas((s) => {
    digits("8")(s); op("+")(s); op("-")(s); digits("3")(s); eqs()(s);
}).display, "5");
eq("小字行显示挂起算式", bas((s) => { digits("9", "9")(s); op("/")(s); digits("1", "0")(s); }).entry, "99 ÷");
eq("输入时就带千位分隔", bas(digits("1", "0", "0", "0", "0", "0", "0")).display, "1,000,000");
eq("关掉分位后原样", bas(digits("1", "0", "0", "0"), { thousands: false }).display, "1000");
eq("小数点保留尾点", bas((s) => { digits("0")(s); E.pressDot(s); }).display, "0.");
eq("退格删一位", bas((s) => { digits("1", "2", "3", "4")(s); E.pressDelete(s); }).display, "123");
eq("退格到空回到 0", bas((s) => { digits("7")(s); E.pressDelete(s); }).display, "0");
eq("取反（输入中）", bas((s) => { digits("1", "2", "3")(s); E.pressNegate(s); }).display, "-123");
eq("取反再取反", bas((s) => { digits("1", "2", "3")(s); E.pressNegate(s); E.pressNegate(s); }).display, "123");
eq("百分号无挂起时除以 100", bas((s) => { digits("5", "0")(s); E.pressPercent(s); }).display, "0.5");
eq("A+B% 求增量", bas((s) => { digits("2", "0", "0")(s); op("+")(s); digits("1", "0")(s); E.pressPercent(s); }).display, "220");
eq("A−B% 求减量", bas((s) => { digits("2", "0", "0")(s); op("-")(s); digits("1", "0")(s); E.pressPercent(s); }).display, "180");
eq("C 只清输入保留运算符", bas((s) => { digits("5")(s); op("+")(s); digits("3")(s); E.pressClearEntry(s); }).display, "0");
eq("AC 全清", bas((s) => { digits("5")(s); op("+")(s); digits("3")(s); E.resetAll(s); }).display, "0");
eq("记忆不被 AC 清掉", bas((s) => { digits("7")(s); E.pressMemoryAdd(s); E.resetAll(s); E.pressMemoryRecall(s); }).display, "7");
eq("m− 生效", bas((s) => { digits("7")(s); E.pressMemoryAdd(s); digits("2")(s); E.pressMemorySubtract(s); E.pressMemoryRecall(s); }).display, "5");
eq("非法数字键被忽略", bas((s) => { digits("1")(s); E.pressDigit(s, "x"); }).display, "1");
check("超长输入被截住", bas(digits("1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0")).display.replace(/[,]/g, "").length <= 17);

/* ───────────────────────── 3. 科学模式：表达式与标准次序 ───────────────────────── */

eq("2+3×4=14（标准次序）", sci((s) => { digits("2")(s); op("+")(s); digits("3")(s); op("*")(s); digits("4")(s); eqs()(s); }).display, "14");
eq("(2+3)×4=20", sci((s) => { E.pressParen(s); digits("2")(s); op("+")(s); digits("3")(s); E.pressParen(s); op("*")(s); digits("4")(s); eqs()(s); }).display, "20");
eq("隐式乘法 (1+2)(3+4)=21", sci((s) => {
    E.pressParen(s); digits("1")(s); op("+")(s); digits("2")(s); E.pressParen(s);
    E.pressParen(s); digits("3")(s); op("+")(s); digits("4")(s); E.pressParen(s); eqs()(s);
}).display, "21");
eq("2^10=1024", sci((s) => { digits("2")(s); op("^")(s); digits("1", "0")(s); eqs()(s); }).display, "1,024");
eq("右结合 2^3^2=512", sci((s) => { digits("2")(s); op("^")(s); digits("3")(s); op("^")(s); digits("2")(s); eqs()(s); }).display, "512");
eq("5!=120", sci((s) => { digits("5")(s); E.pressFactorial(s); eqs()(s); }).display, "120");
eq("5!+1=121", sci((s) => { digits("5")(s); E.pressFactorial(s); op("+")(s); digits("1")(s); eqs()(s); }).display, "121");
eq("√9=3", sci((s) => { E.pressFunction(s, "sqrt"); digits("9")(s); eqs()(s); }).display, "3");
eq("sin(30) 角度制=0.5", sci((s) => { E.pressFunction(s, "sin"); digits("3", "0")(s); eqs()(s); }).display, "0.5");
eq("1/3 显示 15 位", sci((s) => { digits("1")(s); op("/")(s); digits("3")(s); eqs()(s); }).display, "0.333333333333333");
eq("sin(π/2) 弧度制=1", sci((s) => {
    E.pressToggleAngle(s); E.pressFunction(s, "sin"); E.pressConstant(s, "pi"); op("/")(s); digits("2")(s); eqs()(s);
}).display, "1");
eq("Rad 徽标随角度切换", sci((s) => { E.pressToggleAngle(s); }).radians, true);
eq("ln(e)=1", sci((s) => { E.pressFunction(s, "ln"); E.pressConstant(s, "e"); eqs()(s); }).display, "1");
eq("log₁₀(100)=2", sci((s) => { E.pressFunction(s, "log"); digits("1", "0", "0")(s); eqs()(s); }).display, "2");
eq("eˣ 函数可用（2nd 路由在界面层）", sci((s) => { E.pressFunction(s, "exp"); digits("1")(s); eqs()(s); }).display, "2.71828182845905");
eq("2ˣ 函数可用", sci((s) => { E.pressFunction(s, "twoX"); digits("1", "0")(s); eqs()(s); }).display, "1,024");
eq("log₂ 函数可用", sci((s) => { E.pressFunction(s, "log2"); digits("8")(s); eqs()(s); }).display, "3");
eq("函数名有字形", E.labelFor("asin"), "sin⁻¹");
eq("未知函数名退回原样", E.labelFor("nope"), "nope");
eq("asin(1) 角度制=90", sci((s) => { E.pressFunction(s, "asin"); digits("1")(s); eqs()(s); }).display, "90");
eq("2 EE 5 = 200000", sci((s) => { digits("2")(s); E.pressOperator(s, "EE"); digits("5")(s); eqs()(s); }).display, "200,000");
eq("2 EE 5 ×3 = 600000", sci((s) => { digits("2")(s); E.pressOperator(s, "EE"); digits("5")(s); op("*")(s); digits("3")(s); eqs()(s); }).display, "600,000");
eq("表达式回看在小字行", sci((s) => { digits("1")(s); op("+")(s); digits("1")(s); eqs()(s); }).entry, "1+1 =");
eq("x² 作用于当前值", sci((s) => { digits("9")(s); E.pressPower(s, "sq"); eqs()(s); }).display, "81");
eq("x³ 作用于当前值", sci((s) => { digits("3")(s); E.pressPower(s, "cube"); eqs()(s); }).display, "27");
eq("1/x 倒数", sci((s) => { digits("4")(s); E.pressFunction(s, "inv"); eqs()(s); }).display, "0.25");
eq("除零进错误", sci((s) => { digits("1")(s); op("/")(s); digits("0")(s); eqs()(s); }).display, "错误");
eq("log(0) 定义域外进错误", sci((s) => { E.pressFunction(s, "log"); digits("0")(s); eqs()(s); }).display, "错误");
eq("√(-4) 进错误", sci((s) => { E.pressFunction(s, "sqrt"); digits("4")(s); E.pressNegate(s); eqs()(s); }).display, "错误");
eq("171! 溢出进错误", sci((s) => { digits("1", "7", "1")(s); E.pressFactorial(s); eqs()(s); }).display, "错误");
eq("空表达式按 = 不报错", sci((s) => { eqs()(s); }).display, "0");
eq("退格删掉整个 token", sci((s) => { digits("1")(s); op("+")(s); digits("2")(s); E.pressDelete(s); }).display, "1+");
eq("小数点接在函数后", sci((s) => { E.pressFunction(s, "sqrt"); E.pressDot(s); digits("2", "5")(s); eqs()(s); }).display, "0.5");
eq("值插入接在数字后补乘号", sci((s) => { digits("8")(s); E.pressMemoryAdd(s); E.pressMemoryClear(s); E.pressMemoryRecall(s); eqs()(s); }).display, "0");
eq("ans 续算", sci((s) => { digits("6")(s); op("*")(s); digits("7")(s); eqs()(s); E.pressAns(s); op("+")(s); digits("1")(s); eqs()(s); }).display, "43");

/* ───────────────────────── 4. RPN 堆栈 ───────────────────────── */

let r = R.createRpn();
R.pressRpnDigit(r, "1"); R.pressRpnDigit(r, "2");
eq("RPN 输入显示缓冲", R.rpnDisplay(r), "12");
eq("键入即代表 X", r.x, 12);
R.pressRpnEnter(r);
eq("Enter 把 X 复制进 Y", r.y, 12);
eq("Enter 后 X 保持可续敲", r.x, 12);
R.pressRpnDigit(r, "3");
R.pressRpnBinary(r, "*");
eq("12 Enter 3 * = 36", r.x, 36);
R.pressRpnEnter(r);
R.pressRpnDigit(r, "4");
R.pressRpnBinary(r, "+");
eq("再加 4 = 40", r.x, 40);

r = R.createRpn();
[1, 2, 3, 4].forEach((n) => { R.pressRpnDigit(r, String(n)); R.pressRpnEnter(r); });
eq("四级堆栈 X=4", r.x, 4);
eq("Y=4（Enter 是复制不是弹出）", r.y, 4);
eq("Z=3", r.z, 3);
eq("T=2", r.t, 2);

r = R.createRpn();
R.pressRpnDigit(r, "1"); R.pressRpnEnter(r); R.pressRpnDigit(r, "2");
eq("交换前 X=2 Y=1", `${r.x},${r.y}`, "2,1");
R.pressRpnSwap(r);
eq("交换后 X=1 Y=2", `${r.x},${r.y}`, "1,2");

r = R.createRpn();
[1, 2, 3, 4].forEach((n) => { R.pressRpnDigit(r, String(n)); R.pressRpnEnter(r); });
R.pressRpnRollUp(r);
eq("上滚把 T 转到 X", r.x, 2);
R.pressRpnRollDown(r);
eq("下滚转回来", r.x, 4);
R.pressRpnDrop(r);
eq("丢弃后 X=Y", r.x, 4);
eq("丢弃后 Y=Z", r.y, 3);

r = R.createRpn();
R.pressRpnDigit(r, "9"); R.pressRpnEnter(r);
R.pressRpnUnary(r, "sqrt");
eq("√9 = 3", r.x, 3);
R.pressRpnNegate(r);
eq("取反 = −3", r.x, -3);
R.pressRpnPercent(r);
near("百分号除以 100", r.x, -0.03);
R.clearRpn(r);
eq("全清后 X=0", r.x, 0);
eq("全清后 T=0", r.t, 0);
r = R.createRpn();
R.pressRpnDigit(r, "5");
R.pressRpnDot(r);
R.pressRpnDigit(r, "5");
eq("小数缓冲实时进 X", r.x, 5.5);
R.pressRpnEnter(r);
R.pressRpnDigit(r, "5");
R.pressRpnBinary(r, "*");
near("5.5 × 5 = 27.5", r.x, 27.5);
eq("10÷0 进错误", (() => { const s = R.createRpn(); R.pressRpnDigit(s, "1"); R.pressRpnDigit(s, "0"); R.pressRpnEnter(s); R.pressRpnDigit(s, "0"); R.pressRpnBinary(s, "/"); return s.error; })(), true);
eq("错误后显示「错误」", R.rpnDisplay((() => { const s = R.createRpn(); R.pressRpnDigit(s, "1"); R.pressRpnEnter(s); R.pressRpnDigit(s, "0"); R.pressRpnBinary(s, "/"); return s; })()), "错误");
eq("错误后清除回到 0", (() => { const s = R.createRpn(); R.pressRpnDigit(s, "1"); R.pressRpnEnter(s); R.pressRpnDigit(s, "0"); R.pressRpnBinary(s, "/"); R.clearRpn(s); return R.rpnDisplay(s); })(), "0");
eq("错误后数字键复位", (() => { const s = R.createRpn(); R.pressRpnDigit(s, "1"); R.pressRpnEnter(s); R.pressRpnDigit(s, "0"); R.pressRpnBinary(s, "/"); R.pressRpnDigit(s, "6"); return R.rpnDisplay(s); })(), "6");
eq("RPN 行数四行", R.rpnRows(R.createRpn()).length, 4);
eq("RPN 行序 T 在前", R.rpnRows(R.createRpn())[0].label, "T");
eq("RPN 千位分隔", (() => { const s = R.createRpn(); s.x = 1234567; return R.rpnDisplay(s); })(), "1,234,567");
eq("RPN 退格", (() => { const s = R.createRpn(); R.pressRpnDigit(s, "1"); R.pressRpnDigit(s, "2"); R.pressRpnDelete(s); return R.rpnDisplay(s); })(), "1");
eq("RPN 快照带 note", typeof R.rpnSnapshot(R.createRpn()).note, "string");

/* ───────────────────────── 5. 历史纸带 ───────────────────────── */

H.clearHistory();
eq("初始为空", H.listHistory().length, 0);
H.addHistory({ expr: "1+1 =", result: "2", mode: "scientific" });
H.addHistory({ expr: "5!", result: "120", mode: "scientific" });
eq("新的在前", H.listHistory()[0].result, "120");
eq("两条都在", H.listHistory().length, 2);
H.addHistory({ expr: "x", result: "", mode: "basic" });
eq("空结果不入历史", H.listHistory().length, 2);
H.addHistory({ expr: "1/0", result: "错误", mode: "basic" });
eq("错误结果不入历史", H.listHistory().length, 2);
const first = H.listHistory()[0];
H.removeHistory(first.id);
eq("删除一条", H.listHistory().length, 1);
eq("删的是对的那条", H.listHistory()[0].result, "2");
const groups = H.groupByDay();
eq("今天的记录归一组", groups.length, 1);
eq("组标题是今天", groups[0].label, "今天");
eq("组内条数", groups[0].items.length, 1);
// 造一条昨天的记录，验证分组与排序
const list = H.listHistory();
list.push({ id: "old", at: Date.now() - 86400000, expr: "yesterday", result: "1", mode: "basic" });
store.set("calculator-history", JSON.stringify(list));
const two = H.groupByDay();
eq("跨天分两组", two.length, 2);
eq("第二组是昨天", two[1].label, "昨天");
H.clearHistory();
eq("清除全部", H.listHistory().length, 0);
for (let i = 0; i < 250; i += 1) H.addHistory({ expr: `e${i}`, result: String(i), mode: "basic" });
eq("历史上限 200", H.listHistory().length, 200);
eq("留下的是最新的", H.listHistory()[0].result, "249");
H.clearHistory();
eq("落盘槽名", H.HISTORY_SLOT, "calculator-history");

/* ───────────────────────── 6. 跨模块一致性 ───────────────────────── */

// 四个内核各自格式化数字，最容易出的问题是「同一个值在两个地方长得不一样」。
const grouped = [1234567, 0.5, -42, 1000];
grouped.forEach((v) => {
    const fromEngine = E.formatNumber(v, { thousands: true, decimals: "auto" });
    const fromConvert = C.formatValue(v, { thousands: true });
    eq(`engine 与 convert 的千位分隔一致（${v}）`, fromEngine, fromConvert);
});
eq("programmer 十六进制大写", P.toRadix(255n, 16), "FF");
eq("programmer 十进制走同一串字符", P.toRadix(1234567n, 10), "1234567");
eq("engine 对同一个数分位一致", E.formatNumber(1234567, { thousands: true }), P.toRadix(1234567n, 10).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
eq("programmer 截断除法与文档一致", P.toRadix(P.binaryOp(99n, "/", 10n), 10), "9");
eq("convert 温度不动点", C.convert(-40, "c", "f"), -40);
eq("convert 货币快照可往返", Math.abs(C.convert(C.convert(1000, "usd", "cny"), "cny", "usd") - 1000) < 1e-6, true);
eq("convert 跨类别返回 null", C.convert(1, "m", "kg"), null);
eq("rpn 与 engine 共用一元语义（√9）", (() => { const st = R.createRpn(); R.pressRpnDigit(st, "9"); R.pressRpnUnary(st, "sqrt"); return st.x; })(), 3);
eq("rpn 与 engine 共用二元语义（除零）", (() => { const st = R.createRpn(); R.pressRpnDigit(st, "1"); R.pressRpnEnter(st); R.pressRpnDigit(st, "0"); R.pressRpnBinary(st, "/"); return st.error; })(), true);
eq("history 与 engine 的「错误」词一致", (() => {
    H.clearHistory();
    H.addHistory({ expr: "1/0", result: "错误", mode: "basic" });
    return H.listHistory().length;
})(), 0);
eq("位网格 16 组 × 4 位", P.bitGroups(0xFFFFn).groups.length, 16);
eq("位网格最低组是 1111", P.bitGroups(0xFFFFn).groups[15], "1111");
eq("字符框对控制字符给出名字", P.charFor(7n, "ascii").label, "BEL");

/* ───────────────────────── 6. 结果 ───────────────────────── */

console.log(`  · 断言 ${passed + failures.length} 条`);
if (failures.length) {
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    console.log(`计算器内核断言失败 ${failures.length} 条`);
    process.exit(1);
}
console.log("计算器内核断言全部通过 ✓");
process.exit(0);
