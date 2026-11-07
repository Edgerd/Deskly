/**
 * dev/calc-programmer-check.mjs — 程序员模式纯逻辑（mods/calculator/programmer.js）的 Node 断言。
 * 补码回绕、截断除法、位移取模、代理区写错时界面上只是「显示个奇怪的数」，必须在磁盘上把 2^64 边界钉死。
 * 用法：`node dev/calc-programmer-check.mjs`（全绿退出码 0，失败逐条列出并退 1）
 */

import * as P from "../mods/calculator/programmer.js";

/* ───────────────────────── 断言工具 ───────────────────────── */

let passed = 0;
const failures = [];

/** BigInt 进 JSON.stringify 会抛，故自渲染 */
function show(v) {
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v === "symbol") return String(v);
    if (typeof v === "string") return JSON.stringify(v);
    if (v === undefined) return "undefined";
    try { return JSON.stringify(v); } catch { return String(v); }
}
function check(name, cond, extra) {
    if (cond) { passed += 1; return; }
    failures.push(`${name}${extra === undefined ? "" : ` — 实得 ${show(extra)}`}`);
}
function eq(name, actual, expected) {
    check(`${name}（期望 ${show(expected)}）`, actual === expected, actual);
}
/** 非法输入不许抛：抛了就是按键死掉 */
function noThrow(name, fn) {
    try { check(name, true); return fn(); }
    catch (err) { failures.push(`${name} — 抛出 ${err && err.message ? err.message : String(err)}`); }
    return undefined;
}

const MASK = (1n << 64n) - 1n;
const HIGH = 1n << 63n;

/* ───────────────────────── 1. 常量 ───────────────────────── */

eq("位宽 64", P.WORD_BITS, 64);
eq("支持三种进制", P.RADIXES.join(","), "8,10,16");
eq("每组 4 位", P.GROUP_BITS, 4);
eq("共 16 组", P.GROUP_COUNT, 16);
eq("一元键只有 NOT/NEG", P.UNARY_OPERATORS.join(","), "NOT,NEG");
eq("键表含 NOR", P.OPERATORS.includes("NOR"), true);
eq("键表不含非程序员键", P.OPERATORS.includes("^"), false);

/* ───────────────────────── 2. toRadix ───────────────────────── */

eq("0 → 十进制", P.toRadix(0n, 10), "0");
eq("2^63 → 十进制", P.toRadix(HIGH, 10), "9223372036854775808");
eq("2^64-1 → 十进制", P.toRadix(MASK, 10), "18446744073709551615");
eq("255 → 十六进制大写", P.toRadix(255, 16), "FF");
eq("255 → 八进制", P.toRadix(255, 8), "377");
eq("十六进制不带前缀", P.toRadix(0xABCDEFn, 16), "ABCDEF");
eq("八进制不带前缀", P.toRadix(8n, 8), "10");
eq("负值按无符号回绕显示", P.toRadix(-1, 16), "FFFFFFFFFFFFFFFF");
eq("小数向零截断", P.toRadix(9.9, 10), "9");
eq("缺省进制是十进制", P.toRadix(255), "255");
eq("显示不补前导零", P.toRadix(1n, 16), "1");
eq("不支持的进制返回 null", P.toRadix(1, 2), null);
eq("NaN 返回 null", P.toRadix(Number.NaN, 10), null);
eq("Infinity 返回 null", P.toRadix(Number.POSITIVE_INFINITY, 10), null);
eq("数字串按十进制解释", P.toRadix("255", 16), "FF");

/* ───────────────────────── 3. fromRadix ───────────────────────── */

eq("解析 2^64-1", P.fromRadix("18446744073709551615", 10), MASK);
eq("十六进制小写可解析", P.fromRadix("ff", 16), 255n);
eq("八进制解析", P.fromRadix("377", 8), 255n);
eq("八进制里没有 8", P.fromRadix("8", 8), null);
eq("十进制里没有 A", P.fromRadix("A", 10), null);
eq("十六进制里没有 G", P.fromRadix("G", 16), null);
eq("空串是非法而非 0", P.fromRadix("", 10), null);
eq("不接受 0x 前缀", P.fromRadix("0xFF", 16), null);
eq("不接受 0o 前缀", P.fromRadix("0o17", 8), null);
eq("不接受空格以外的符号", P.fromRadix("1 2", 10), null);
eq("前后空白可忽略", P.fromRadix("  12  ", 10), 12n);
eq("null 输入返回 null", P.fromRadix(null, 10), null);
eq("未知进制返回 null", P.fromRadix("10", 2), null);
eq("超出 64 位回绕", P.toRadix(P.fromRadix("1FFFFFFFFFFFFFFFF", 16), 16), "FFFFFFFFFFFFFFFF");

/* ───────────────────────── 4. 进制互转往返 ───────────────────────── */

for (const radix of P.RADIXES) {
    for (const value of [0n, 1n, 255n, HIGH, MASK]) {
        const back = P.fromRadix(P.toRadix(value, radix), radix);
        eq(`往返 进制${radix} 值${value}`, back, value);
    }
}
eq("切进制只变表示不变值（十→八→十）", P.fromRadix(P.toRadix(15n, 8), 8), 15n);
eq("同一个值三种进制的表示", [P.toRadix(255n, 8), P.toRadix(255n, 10), P.toRadix(255n, 16)].join("/"), "377/255/FF");
eq("切进制只变表示不变值（八→十六）", P.toRadix(P.fromRadix("17", 8), 16), "F");

/* ───────────────────────── 5. isDigitAllowed ───────────────────────── */

eq("八进制允许 7", P.isDigitAllowed("7", 8), true);
eq("八进制拒绝 8", P.isDigitAllowed("8", 8), false);
eq("八进制拒绝 9", P.isDigitAllowed("9", 8), false);
eq("八进制拒绝 A", P.isDigitAllowed("A", 8), false);
eq("十进制允许 9", P.isDigitAllowed("9", 10), true);
eq("十进制拒绝 A", P.isDigitAllowed("A", 10), false);
eq("十六进制允许 A", P.isDigitAllowed("A", 16), true);
eq("十六进制允许小写 f", P.isDigitAllowed("f", 16), true);
eq("十六进制允许成对 FF", P.isDigitAllowed("FF", 16), true);
eq("十进制拒绝 FF", P.isDigitAllowed("FF", 10), false);
eq("空串不是合法键", P.isDigitAllowed("", 16), false);
eq("未知进制一律禁用", P.isDigitAllowed("1", 2), false);
eq("非字符串一律禁用", P.isDigitAllowed(5, 10), false);

/* ───────────────────────── 6. appendInput / appendHexPair ───────────────────────── */

eq("显示 0 时首位替换 0", P.appendInput("0", "5", 10), "5");
eq("非零后追加", P.appendInput("5", "0", 10), "50");
eq("0 上按 0 仍是 0", P.appendInput("0", "0", 10), "0");
eq("八进制拒绝 8", P.appendInput("12", "8", 8), "12");
eq("八进制拒绝 9", P.appendInput("12", "9", 8), "12");
eq("八进制接受 7", P.appendInput("12", "7", 8), "127");
eq("十进制拒绝 A", P.appendInput("12", "A", 10), "12");
eq("十六进制接受小写 a", P.appendInput("12", "a", 16), "12A");
eq("空文本按 7", P.appendInput("", "7", 10), "7");
eq("丢弃已有前导零", P.appendInput("0012", "3", 10), "123");
eq("全零文本追加后归一", P.appendInput("0000", "5", 10), "5");
eq("退格键并入追加口", P.appendInput("123", "⌫", 10), "12");
eq("十六进制满字后再进一位被拒", P.appendInput("FFFFFFFFFFFFFFFF", "1", 16), "FFFFFFFFFFFFFFFF");
eq("十进制刚好进到位上限", P.appendInput("1844674407370955161", "5", 10), "18446744073709551615");
eq("十进制越界一位被拒", P.appendInput("1844674407370955161", "6", 10), "1844674407370955161");
eq("八进制越界被拒", P.appendInput("1777777777777777777777", "7", 8), "1777777777777777777777");
eq("未知进制不改坏文本", P.appendInput("12", "3", 2), "12");
eq("非字符串键不改文本", P.appendInput("12", null, 10), "12");
eq("FF 一次进两位", P.appendHexPair("FF", "0", 16), "FF");
eq("FF 接在非零后", P.appendHexPair("FF", "A", 16), "AFF");
eq("00 左移两位", P.appendHexPair("00", "1", 16), "100");
eq("00 在前导零上仍是 0", P.appendHexPair("00", "0", 16), "0");
eq("成对键缺省按十六进制", P.appendHexPair("00", "AB"), "AB00");
eq("十六进制里 F 单键", P.appendHexPair("F", "0"), "F");

/* ───────────────────────── 7. backspace ───────────────────────── */

eq("退格删一位", P.backspace("10", 10), "1");
eq("退格删末尾零", P.backspace("100", 10), "10");
eq("删空归 0", P.backspace("F", 16), "0");
eq("0 上再删仍是 0", P.backspace("0", 10), "0");
eq("空串归 0", P.backspace("", 10), "0");
eq("前导零先归一再删", P.backspace("000F", 16), "0");
eq("八进制退格", P.backspace("127", 8), "12");
eq("未知进制只归一", P.backspace("0012", 2), "12");
eq("退格后可继续输入", P.appendInput(P.backspace("8", 8), "7", 8), "7");

/* ───────────────────────── 8. 位网格 ───────────────────────── */

const grid = P.bitGroups(0xFn);
eq("网格 16 组", grid.groups.length, 16);
eq("最高组补零到 4 位", grid.groups[0], "0000");
eq("最低组是 1111", grid.groups[15], "1111");
eq("网格共 64 位", grid.groups.join("").length, 64);
eq("每组 4 字符", grid.groups.every((g) => g.length === 4), true);
eq("全 1 时每组 1111", P.bitGroups(MASK).groups.every((g) => g === "1111"), true);
eq("2^63 只点亮最高位", P.bitGroups(HIGH).groups[0], "1000");
eq("0x1234 的次低组", P.bitGroups(0x1234n).groups[14], "0011");
eq("位标签有 16 个", grid.bitLabels.length, 16);
eq("首组最低位是 60", grid.bitLabels[0], 60);
eq("末组最低位是 0", grid.bitLabels[15], 0);
eq("位标签自高向低步长 4", grid.bitLabels[0] - grid.bitLabels[1], 4);
eq("边界标签 8 处", grid.boundaryLabels.length, 8);
eq("边界标签起于 63", grid.boundaryLabels[0].bit, 63);
eq("边界标签含 47", grid.boundaryLabels.some((b) => b.bit === 47), true);
eq("边界标签含 32", grid.boundaryLabels.some((b) => b.bit === 32), true);
eq("边界标签含 15", grid.boundaryLabels.some((b) => b.bit === 15), true);
eq("边界标签止于 0", grid.boundaryLabels[7].bit, 0);
eq("边界标签指向组内", grid.boundaryLabels.every((b) => b.group >= 0 && b.group < 16), true);
eq("非法值不出网格", P.bitGroups("zz"), null);
eq("0x1234 的最低组是 0100", P.bitGroups(0x1234n).groups[15], "0100");
eq("网格与 bitAt 同步", P.bitGroups(HIGH).groups[0][0], "1");

/* ───────────────────────── 9. toggleBit / bitAt ───────────────────────── */

eq("翻最低位", P.toggleBit(0n, 0), 1n);
eq("再翻回来", P.toggleBit(P.toggleBit(0n, 0), 0), 0n);
eq("翻最高位", P.toggleBit(0n, 63), HIGH);
eq("越界 64 安全返回原值", P.toggleBit(5n, 64), 5n);
eq("越界 -1 安全返回原值", P.toggleBit(5n, -1), 5n);
eq("非整数位号安全返回原值", P.toggleBit(5n, 3.5), 5n);
eq("字符串位号当越界处理（安全返回原值）", P.toggleBit(5n, "3"), 5n);
eq("NEG 2^63 仍是 2^63", P.unaryOp(HIGH, "NEG"), HIGH);
eq("00 在十进制也只当两个 0", P.isDigitAllowed("00", 10), true);
eq("八进制 0 上按 0 仍是 0", P.appendInput("0", "0", 8), "0");
eq("非法值返回 null", P.toggleBit("abc", 0), null);
eq("负值先回绕再翻位", P.toggleBit(-1n, 0), MASK - 1n);
for (const index of [0, 7, 15, 32, 63]) {
    eq(`往返位 ${index}`, P.toggleBit(P.toggleBit(0xDEADBEEFn, index), index), 0xDEADBEEFn);
}
eq("bitAt 取到 1", P.bitAt(1n, 0), 1);
eq("bitAt 取到 0", P.bitAt(0n, 5), 0);
eq("bitAt 最高位", P.bitAt(HIGH, 63), 1);
eq("bitAt 越界返回 null", P.bitAt(1n, 64), null);
eq("bitAt 负位返回 null", P.bitAt(1n, -1), null);
eq("toggleBit 与 bitAt 一致", P.bitAt(P.toggleBit(0n, 10), 10), 1);
eq("bitAt 非法值 null", P.bitAt(undefined, 0), null);

/* ───────────────────────── 10. 位运算与算术 ───────────────────────── */

eq("AND", P.binaryOp(0xF0n, "AND", 0x3Cn), 0x30n);
eq("OR", P.binaryOp(0xF0n, "OR", 0x3Cn), 0xFCn);
eq("XOR", P.binaryOp(0xF0n, "XOR", 0x3Cn), 0xCCn);
eq("NOR 零值回绕成全 1", P.binaryOp(0n, "NOR", 0n), MASK);
eq("NOR", P.binaryOp(0xF0n, "NOR", 0x3Cn), 0xFFFFFFFFFFFFFF03n);
eq("NAND", P.binaryOp(0xF0n, "NAND", 0x3Cn), 0xFFFFFFFFFFFFFFCFn);
eq("NAND 全 1 得 0", P.binaryOp(MASK, "NAND", MASK), 0n);
eq("NAND 零值回绕成全 1", P.binaryOp(0n, "NAND", 0n), MASK);
eq("NOR 结果不越 64 位", P.binaryOp(MASK, "NOR", 0n), 0n);
eq("左移 1 位", P.binaryOp(1n, "<<", 1n), 2n);
eq("左移丢高位（逻辑）", P.binaryOp(HIGH, "<<", 1n), 0n);
eq("右移 1 位", P.binaryOp(0x80n, ">>", 4n), 8n);
eq("右移空位补 0", P.binaryOp(HIGH, ">>", 1n), 1n << 62n);
eq("无符号右移不回卷", P.binaryOp(MASK, ">>", 63n), 1n);
eq("移 0 位不变（左）", P.binaryOp(0x1234n, "<<", 0n), 0x1234n);
eq("移 0 位不变（右）", P.binaryOp(0x1234n, ">>", 0n), 0x1234n);
eq("移 64 位等于移 0 位", P.binaryOp(0x1234n, ">>", 64n), 0x1234n);
eq("移 64 位左移也不动", P.binaryOp(0x1234n, "<<", 64n), 0x1234n);
eq("移 65 位按模 64", P.binaryOp(1n, "<<", 65n), 2n);
eq("移 130 位按模 64 等于移 2 位", P.binaryOp(0x1234n, ">>", 130n), 0x48Dn);
eq("RoL 把最高位转到最低", P.binaryOp(HIGH, "RoL", 1n), 1n);
eq("RoR 把最低位转到最高", P.binaryOp(1n, "RoR", 1n), HIGH);
eq("RoL 64 位是恒等", P.binaryOp(0xDEADBEEFn, "RoL", 64n), 0xDEADBEEFn);
eq("RoR 65 位等于转 1 位", P.binaryOp(1n, "RoR", 65n), HIGH);
eq("RoL 移 0 位不变", P.binaryOp(0xABCDn, "RoL", 0n), 0xABCDn);
eq("RoL 2 位", P.binaryOp(0b1011n, "RoL", 2n), 0b101100n);
eq("RoL 保住 1 的个数（低位绕回高位的 1）", P.binaryOp(0b1011n, "RoL", 62n), (1n << 63n) | (1n << 62n) | 2n);
eq("加法回绕", P.binaryOp(MASK, "+", 1n), 0n);
eq("减法借位回绕", P.binaryOp(0n, "-", 1n), MASK);
eq("乘法溢出回绕", P.binaryOp(1n << 32n, "*", 1n << 32n), 0n);
eq("乘法", P.binaryOp(6n, "×", 7n), 42n);
eq("除法截断而非四舍五入", P.binaryOp(99n, "÷", 10n), 9n);
eq("除法", P.binaryOp(255n, "/", 16n), 15n);
eq("除法除零返回 null", P.binaryOp(5n, "/", 0n), null);
eq("取模除零返回 null", P.binaryOp(5n, "mod", 0n), null);
eq("取模", P.binaryOp(99n, "mod", 10n), 9n);
eq("取模别名 %", P.binaryOp(100n, "%", 7n), 2n);
eq("未知运算返回 null", P.binaryOp(1n, "^^", 1n), null);
eq("非法左值返回 null", P.binaryOp(Number.NaN, "AND", 1n), null);
eq("非法右值返回 null", P.binaryOp(1n, "AND", undefined), null);
eq("负操作数按补码参与", P.binaryOp(-1n, "AND", 0xFn), 0xFn);
for (const kind of P.OPERATORS) {
    noThrow(`运算 ${kind} 不吃怪输入`, () => P.binaryOp({}, kind, []));
}

/* ───────────────────────── 11. 一元运算 ───────────────────────── */

eq("NOT 0 得全 1", P.unaryOp(0n, "NOT"), MASK);
eq("NOT 具体值", P.unaryOp(0xFn, "NOT"), 0xFFFFFFFFFFFFFFF0n);
eq("NOT 两次还原", P.unaryOp(P.unaryOp(0x1234n, "NOT"), "NOT"), 0x1234n);
eq("NEG 1 得 2^64-1", P.unaryOp(1n, "NEG"), MASK);
eq("NEG 全 1 得 1", P.unaryOp(MASK, "NEG"), 1n);
eq("NEG 0 仍是 0", P.unaryOp(0n, "NEG"), 0n);
eq("NEG 两次还原", P.unaryOp(P.unaryOp(12345n, "NEG"), "NEG"), 12345n);
eq("未知一元键返回 null", P.unaryOp(1n, "1/x"), null);
eq("非法一元值返回 null", P.unaryOp(null, "NOT"), null);
for (const kind of P.UNARY_OPERATORS) {
    eq(`一元键 ${kind} 结果在 64 位内`, P.unaryOp(0x1234n, kind) <= MASK, true);
}

/* ───────────────────────── 12. X<<Y / X>>Y ───────────────────────── */

eq("X<<Y 以显示值为 X", P.shiftPair(0x80n, 4n, "<<"), 0x800n);
eq("X>>Y 是逻辑右移", P.shiftPair(0x80n, 4n, ">>"), 8n);
eq("方向别名 left", P.shiftPair(1n, 63n, "left"), HIGH);
eq("方向别名 right", P.shiftPair(HIGH, 63n, "right"), 1n);
eq("X>>Y 不补符号位", P.shiftPair(MASK, 32n, ">>"), 0xFFFFFFFFn);
eq("X<<Y 移 0 位不变", P.shiftPair(7n, 0n, "<<"), 7n);
eq("X<<Y 移 64 位取模", P.shiftPair(0x1234n, 64n, "<<"), 0x1234n);
eq("方向写错返回 null", P.shiftPair(1n, 1n, "RoL"), null);
eq("操作数非法返回 null", P.shiftPair("x", 1n, "<<"), null);

/* ───────────────────────── 13. flip8 / flip16 ───────────────────────── */

eq("flip16 段内高低字节互换", P.flipBytes(0x1234n, 16), 0x3412n);
eq("flip16 四段同时生效", P.flipBytes(0x1122334455667788n, 16), 0x2211443366558877n);
eq("flip16 段序不动", P.flipBytes(0x12345678n, 16), 0x34127856n);
eq("flip16 高段同样生效", P.flipBytes(1n << 48n, 16), 1n << 56n);
eq("flip16 全零仍是全零", P.flipBytes(0n, 16), 0n);
eq("flip16 两次还原", P.flipBytes(P.flipBytes(0x12345678n, 16), 16), 0x12345678n);
eq("flip16 整字逆序后仍在 64 位内", P.flipBytes(MASK, 16), MASK);
eq("flip8 整字 8 字节逆序", P.flipBytes(0x1234n, 8), 0x3412000000000000n);
eq("flip8 逐字节逆序", P.flipBytes(0x0102030405060708n, 8), 0x0807060504030201n);
eq("flip8 两次还原", P.flipBytes(P.flipBytes(0xDEADBEEFn, 8), 8), 0xDEADBEEFn);
eq("flip8 与 flip16 不等价", P.flipBytes(0x1234n, 8) === P.flipBytes(0x1234n, 16), false);
eq("flip 全 1 不变", P.flipBytes(MASK, 8), MASK);
eq("非法宽度返回 null", P.flipBytes(1n, 32), null);
eq("非法值返回 null", P.flipBytes("zz", 8), null);

/* ───────────────────────── 14. 截断除法与回绕 ───────────────────────── */

eq("99 ÷ 10 = 9（苹果文档那条）", P.truncateDiv(99n, 10n), 9n);
eq("-99 ÷ 10 = -9（向零）", P.truncateDiv(-99n, 10n), -9n);
eq("99 ÷ -10 = -9", P.truncateDiv(99n, -10n), -9n);
eq("-99 ÷ -10 = 9", P.truncateDiv(-99n, -10n), 9n);
eq("负商不回绕", P.truncateDiv(-1n, 1n), -1n);
eq("整除", P.truncateDiv(100n, 4n), 25n);
eq("除零返回 null", P.truncateDiv(1n, 0n), null);
eq("number 也能除", P.truncateDiv(7, 2), 3n);
eq("小数操作数先向零截断", P.truncateDiv(9.9, 10), 0n);
eq("非法操作数返回 null", P.truncateDiv("x", 10n), null);
eq("wrap(-1) 得 2^64-1", P.wrap(-1n), MASK);
eq("wrap(2^64) 得 0", P.wrap(1n << 64n), 0n);
eq("wrap(2^64+5) 得 5", P.wrap((1n << 64n) + 5n), 5n);
eq("wrap(-2^64) 得 0", P.wrap(-(1n << 64n)), 0n);
eq("wrap(number)", P.wrap(255), 255n);
eq("wrap 小数向零", P.wrap(9.9), 9n);
eq("wrap 非法输入给 0n", P.wrap(Number.NaN), 0n);
eq("wrap 结果恒在域内", P.wrap(-1n << 200n) <= MASK, true);

/* ───────────────────────── 15. ASCII / Unicode 转译 ───────────────────────── */

eq("ASCII 65 是 A", P.charFor(65, "ascii").text, "A");
eq("ASCII 65 合法", P.charFor(65, "ascii").valid, true);
eq("ASCII 65 无提示", P.charFor(65, "ascii").hint, null);
eq("ASCII 0 名字是 NUL", P.charFor(0, "ascii").label, "NUL");
eq("ASCII 0 无可显示字形", P.charFor(0, "ascii").text, "");
eq("ASCII 0 仍算合法码位", P.charFor(0, "ascii").valid, true);
eq("ASCII 7 名字是 BEL", P.charFor(7, "ascii").label, "BEL");
eq("ASCII 9 名字是 TAB", P.charFor(9, "ascii").label, "TAB");
eq("ASCII 10 名字是 LF", P.charFor(10, "ascii").label, "LF");
eq("ASCII 13 名字是 CR", P.charFor(13, "ascii").label, "CR");
eq("ASCII 32 名字是 SPACE", P.charFor(32, "ascii").label, "SPACE");
eq("ASCII 32 有字形", P.charFor(32, "ascii").text, " ");
eq("ASCII 127 名字是 DEL", P.charFor(127, "ascii").label, "DEL");
eq("ASCII 127 合法", P.charFor(127, "ascii").valid, true);
eq("ASCII 128 越界", P.charFor(128, "ascii").valid, false);
eq("ASCII 128 不给字符", P.charFor(128, "ascii").text, "");
eq("ASCII 128 提示是中文", P.charFor(128, "ascii").hint.includes("超出 ASCII"), true);
eq("ASCII 大数越界", P.charFor(1n << 40n, "ascii").valid, false);
eq("缺省字符表是 ASCII", P.charFor(200).valid, false);
eq("Unicode 汉字", P.charFor(0x4E2D, "unicode").text, "中");
eq("Unicode 扩平面合法", P.charFor(0x10FFFF, "unicode").valid, true);
eq("Unicode 扩平面是代理对", P.charFor(0x1F600, "unicode").text.length, 2);
eq("Unicode 代理区下界无效", P.charFor(0xD800, "unicode").valid, false);
eq("Unicode 代理区上界无效", P.charFor(0xDFFF, "unicode").valid, false);
eq("Unicode 代理区中间无效", P.charFor(0xDBFF, "unicode").valid, false);
eq("代理区提示写明原因", P.charFor(0xDC00, "unicode").hint.includes("代理"), true);
eq("代理区不产出字符", P.charFor(0xD800, "unicode").text, "");
eq("Unicode 0x110000 越界", P.charFor(0x110000, "unicode").valid, false);
eq("越界提示写明范围", P.charFor(0x110000, "unicode").hint.includes("10FFFF"), true);
eq("负码位无效", P.charFor(-1, "unicode").valid, false);
eq("未知字符表无效", P.charFor(65, "ebcdic").valid, false);
eq("非数字码位无效", P.charFor("abc", "ascii").valid, false);
eq("charFor 永不返回 null", P.charFor(undefined, undefined) !== null, true);
eq("charFor 的 label 缺省时是 null", P.charFor("abc", "ascii").label, null);
noThrow("代理区不抛异常", () => P.charFor(0xD800, "unicode"));
noThrow("越界码位不抛异常", () => P.charFor(0x7FFFFFFFn, "unicode"));
noThrow("怪对象不抛异常", () => P.charFor({ toString: () => "x" }, "unicode"));

/* ───────────────────────── 16. 怪输入一律不抛（按键不许死） ───────────────────────── */

const HOSTILE = [undefined, null, NaN, Infinity, -0, "", "  ", "xyz", {}, [], Symbol("s"), -1.5, 1n << 70n];
for (const bad of HOSTILE) {
    const tag = show(bad);
    noThrow(`toRadix 不吃 ${tag}`, () => P.toRadix(bad, 10));
    noThrow(`fromRadix 不吃 ${tag}`, () => P.fromRadix(bad, 16));
    noThrow(`appendInput 不吃 ${tag}`, () => P.appendInput(bad, bad, 8));
    noThrow(`backspace 不吃 ${tag}`, () => P.backspace(bad, 10));
    noThrow(`bitGroups 不吃 ${tag}`, () => P.bitGroups(bad));
    noThrow(`toggleBit 不吃 ${tag}`, () => P.toggleBit(bad, bad));
    noThrow(`bitAt 不吃 ${tag}`, () => P.bitAt(bad, bad));
    noThrow(`unaryOp 不吃 ${tag}`, () => P.unaryOp(bad, bad));
    noThrow(`shiftPair 不吃 ${tag}`, () => P.shiftPair(bad, bad, bad));
    noThrow(`flipBytes 不吃 ${tag}`, () => P.flipBytes(bad, bad));
    noThrow(`truncateDiv 不吃 ${tag}`, () => P.truncateDiv(bad, bad));
    noThrow(`wrap 不吃 ${tag}`, () => P.wrap(bad));
}
for (const value of HOSTILE) {
    eq(`toRadix 的怪值不是字符串就是 null`, typeof P.toRadix(value, 10) === "string" || P.toRadix(value, 10) === null, true);
    eq(`wrap 的怪值仍是合法字`, P.wrap(value) >= 0n && P.wrap(value) <= MASK, true);
    eq(`appendInput 永不返回 null`, typeof P.appendInput(value, "5", 10), "string");
    eq(`backspace 永不返回 null`, typeof P.backspace(value, 10), "string");
}
eq("Symbol 输入返回 null", P.toRadix(Symbol("s"), 10), null);
eq("负零显示为 0", P.toRadix(-0, 10), "0");
eq("超大 BigInt 仍回绕", P.wrap(1n << 70n), 0n);

/* ───────────────────────── 17. 程序员模式典型流程 ───────────────────────── */

const step1 = P.appendInput("0", "9", 10);
eq("输入 9 得 9", P.toRadix(P.fromRadix(step1, 10), 10), "9");
eq("9 ÷ 10 截断成 0", P.toRadix(P.binaryOp(P.fromRadix(step1, 10), "÷", 10n), 10), "0");
eq("99 ÷ 10 走完整链是 9", P.toRadix(P.binaryOp(P.fromRadix(P.appendInput("9", "9", 10), 10), "/", 10n), 10), "9");
eq("NEG 后十六进制显示全 F", P.toRadix(P.unaryOp(P.fromRadix("1", 10), "NEG"), 16), "FFFFFFFFFFFFFFFF");
eq("NOT 全 F 得 0", P.toRadix(P.unaryOp(P.fromRadix("FFFFFFFFFFFFFFFF", 16), "NOT"), 16), "0");
eq("八进制 377 切十六进制是 FF", P.toRadix(P.fromRadix("377", 8), 16), "FF");
eq("翻位后网格最低组是 1000", P.bitGroups(P.toggleBit(0n, 3)).groups[15], "1000");
eq("X<<Y 走一遍 0x8<<4 是 0x80", P.toRadix(P.shiftPair(P.fromRadix("8", 16), P.fromRadix("4", 16), "<<"), 16), "80");
eq("flip16 走一遍 1234→3412", P.toRadix(P.flipBytes(P.fromRadix("1234", 16), 16), 16), "3412");

/* ───────────────────────── 结果 ───────────────────────── */

console.log(`  · 断言 ${passed + failures.length} 条`);
if (failures.length) {
    failures.forEach((f) => console.log(`  × ${f}`));
    console.log(`程序员模式断言失败 ${failures.length} 条`);
    process.exit(1);
}
console.log("程序员模式断言全部通过");
// display.js / lock.js 一类模块在 import 时挂了 setInterval，不显式退出进程会挂着不退
process.exit(0);
