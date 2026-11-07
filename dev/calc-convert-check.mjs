/**
 * dev/calc-convert-check.mjs — 换算纯逻辑层（mods/calculator/convert.js）的 Node 断言。
 * 102 单位 × 13 类别人肉点不完；温度往返、货币往返、跨类别禁用最易错又最难肉眼发现，在此钉住。
 * 用法：`node dev/calc-convert-check.mjs`（全绿退出码 0，失败逐条列出并退出码 1）
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as MODULE from "../mods/calculator/convert.js";
import {
    CATEGORIES,
    RATES,
    RATE_DATE,
    categoryOfUnit,
    convert,
    findUnit,
    formatValue,
    isCrossCategory,
    suggestUnit,
    temperatureFromKelvin,
    temperatureToKelvin,
    unitsOf,
} from "../mods/calculator/convert.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CONVERT_PATH = join(ROOT, "mods", "calculator", "convert.js");

/* ───────────────────────── 断言工具 ───────────────────────── */

let passed = 0;
const failures = [];

function check(name, cond, extra) {
    if (cond) { passed += 1; return; }
    failures.push(`${name}${extra === undefined ? "" : ` — 实得 ${JSON.stringify(extra)}`}`);
}

function eq(name, actual, expected) {
    check(`${name}（期望 ${JSON.stringify(expected)}）`, actual === expected, actual);
}

/**
 * 相对误差比较。换算全部是乘法再除法，双精度会留 1 ulp 的尾巴，
 * 所以锚点断言一律走近似比较而不是 ===；1e-9 足够把「真算错」和「舍入」分开。
 */
function approx(name, actual, expected, relTol = 1e-9) {
    if (typeof actual !== "number" || !Number.isFinite(actual)) {
        failures.push(`${name} — 期望 ${expected}，实得 ${JSON.stringify(actual)}（非有限数）`);
        return;
    }
    const tol = expected === 0 ? relTol : Math.abs(expected) * relTol;
    const diff = Math.abs(actual - expected);
    if (diff <= tol) { passed += 1; return; }
    failures.push(`${name} — 期望 ${expected}，实得 ${actual}（差 ${diff} > 容差 ${tol}）`);
}

/** 绝对误差比较：给「1 atm = 759.99996 mmHg 而不是 760」这类有定义差异的锚点用。 */
function near(name, actual, expected, absTol) {
    if (typeof actual !== "number" || !Number.isFinite(actual)) {
        failures.push(`${name} — 期望 ${expected}，实得 ${JSON.stringify(actual)}（非有限数）`);
        return;
    }
    const diff = Math.abs(actual - expected);
    if (diff <= absTol) { passed += 1; return; }
    failures.push(`${name} — 期望 ${expected}±${absTol}，实得 ${actual}（差 ${diff}）`);
}

/* ───────────────────────── 便利数据 ───────────────────────── */

const ALL_UNITS = CATEGORIES.flatMap((category) => category.units.map((unit) => ({ unit, category })));
/** 每个类别的基准单位（factor 为 1 的那个），温度取开尔文、货币取美元。 */
const BASE_OF = {
    length: "m", mass: "kg", volume: "m3", area: "m2", temperature: "k", speed: "mps",
    time: "s", data: "bit", energy: "j", pressure: "pa", power: "w", angle: "deg", currency: "usd",
};
const EXPECTED_COUNTS = {
    length: 10, mass: 8, volume: 12, area: 7, temperature: 4, speed: 5, time: 8,
    data: 7, energy: 8, pressure: 7, power: 4, angle: 5, currency: 17,
};
const CURRENCY_CODES = ["USD", "CNY", "EUR", "JPY", "GBP", "HKD", "TWD", "KRW", "AUD", "CAD",
    "CHF", "SGD", "RUB", "INR", "BRL", "CZK", "BOB"];

/* ───────────────────────── 1. 源码纯净：零依赖 / 零 DOM / 零网络 ───────────────────────── */

const RAW_SOURCE = readFileSync(CONVERT_PATH, "utf8");
// 注释里出现 fetch、import 这些词是说明性文字，必须先剥掉注释再判，
// 否则文档写得越清楚越容易被误杀。
const CODE = RAW_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

check("源码无 import 语句", !/^\s*import[\s{*]/m.test(CODE), CODE.match(/^\s*import.*$/m));
check("源码无 require 调用", !/\brequire\s*\(/.test(CODE));
check("源码无动态 import()", !/\bimport\s*\(/.test(CODE));
check("源码无 fetch", !/\bfetch\s*\(/.test(CODE));
check("源码无 XMLHttpRequest", !/XMLHttpRequest/.test(CODE));
check("源码不碰 document", !/\bdocument\b/.test(CODE));
check("源码不碰 window", !/\bwindow\b/.test(CODE));
check("源码不碰 localStorage", !/localStorage/.test(CODE));
check("源码不留定时器（否则 Node 校验脚本会挂住）", !/setInterval|setTimeout|requestAnimationFrame/.test(CODE));
check("源码无 Date.now（换算必须是确定性的）", !/Date\s*\.\s*now/.test(CODE));
eq("导出集合与接口约定一致", Object.keys(MODULE).sort().join(","), [
    "CATEGORIES", "RATE_DATE", "RATES", "categoryOfUnit", "convert", "findUnit", "formatValue",
    "isCrossCategory", "suggestUnit", "temperatureFromKelvin", "temperatureToKelvin", "unitsOf",
].sort().join(","));

/* ───────────────────────── 2. 表结构与 id 唯一性 ───────────────────────── */

eq("类别数量", CATEGORIES.length, 13);
eq("单位总数", ALL_UNITS.length, 102);

const categoryIds = CATEGORIES.map((c) => c.id);
eq("类别 id 无重复", new Set(categoryIds).size, categoryIds.length);
eq("单位 id 全局无重复", new Set(ALL_UNITS.map((x) => x.unit.id)).size, ALL_UNITS.length);
check("所有单位 id 都是小写 ascii", ALL_UNITS.every((x) => /^[a-z][a-z0-9]*$/.test(x.unit.id)),
    ALL_UNITS.filter((x) => !/^[a-z][a-z0-9]*$/.test(x.unit.id)).map((x) => x.unit.id));
eq("类别 kind 只允许三种", [...new Set(CATEGORIES.map((c) => c.kind))].sort().join(","), "currency,linear,temp");

CATEGORIES.forEach((category) => {
    eq(`类别 ${category.id} 的单位数量`, category.units.length, EXPECTED_COUNTS[category.id] ?? -1);
    check(`类别 ${category.id} 有中文名`, typeof category.label === "string" && category.label.length > 0, category.label);
    check(`类别 ${category.id} 的每个单位都有中文名与 symbol`,
        category.units.every((u) => typeof u.name === "string" && u.name.length > 0 && typeof u.symbol === "string" && u.symbol.length > 0));
});

const linearCats = CATEGORIES.filter((c) => c.kind !== "temp");
check("线性与货币单位的 factor 全是有限正数",
    linearCats.every((c) => c.units.every((u) => typeof u.factor === "number" && Number.isFinite(u.factor) && u.factor > 0)),
    linearCats.flatMap((c) => c.units.filter((u) => !(u.factor > 0)).map((u) => `${c.id}/${u.id}`)));
check("温度单位不带 factor（非线性必须走函数）",
    CATEGORIES.find((c) => c.id === "temperature").units.every((u) => u.factor === undefined));

/* ───────────────────────── 3. 查询接口 ───────────────────────── */

eq("unitsOf('length') 返回 10 个", unitsOf("length").length, 10);
eq("unitsOf('currency') 返回 17 个", unitsOf("currency").length, 17);
check("未知类别 unitsOf 返回空数组", Array.isArray(unitsOf("nope")) && unitsOf("nope").length === 0);
check("空串类别 unitsOf 返回空数组", Array.isArray(unitsOf("")) && unitsOf("").length === 0);
check("unitsOf('temperature') 内容与 CATEGORIES 同一份", unitsOf("temperature") === CATEGORIES.find((c) => c.id === "temperature").units);

eq("findUnit('m') 的 id", findUnit("m")?.unit.id, "m");
eq("findUnit('m') 的类别", findUnit("m")?.category.id, "length");
eq("findUnit('bob') 的名称", findUnit("bob")?.unit.name, "玻利维亚诺");
eq("findUnit('bob') 的 symbol", findUnit("bob")?.unit.symbol, "BOB");
eq("findUnit 未知单位返回 null", findUnit("furlong"), null);
eq("findUnit 空串返回 null", findUnit(""), null);
eq("findUnit(undefined) 返回 null", findUnit(undefined), null);
eq("categoryOfUnit('kg')", categoryOfUnit("kg")?.id, "mass");
eq("categoryOfUnit('k')", categoryOfUnit("k")?.id, "temperature");
eq("categoryOfUnit 未知返回 null", categoryOfUnit("nope"), null);
check("每个单位都能被 findUnit 找回", ALL_UNITS.every((x) => findUnit(x.unit.id)?.unit === x.unit));
check("每个单位的 categoryOfUnit 与所属类别一致", ALL_UNITS.every((x) => categoryOfUnit(x.unit.id) === x.category));

/* ───────────────────────── 4. 跨类别判定与禁用 ───────────────────────── */

eq("米→厘米 同类别", isCrossCategory("m", "cm"), false);
eq("米→米 同类别", isCrossCategory("m", "m"), false);
eq("米→千克 跨类别", isCrossCategory("m", "kg"), true);
eq("摄氏度→米 跨类别", isCrossCategory("c", "m"), true);
eq("美元→米 跨类别", isCrossCategory("usd", "m"), true);
eq("克→吉字节 跨类别（同为 g/gb 前缀也要禁）", isCrossCategory("g", "gb"), true);
eq("美元→人民币 同类别", isCrossCategory("usd", "cny"), false);
eq("未知单位按不可换算处理", isCrossCategory("m", "nope"), true);
eq("两侧都未知按不可换算处理", isCrossCategory("nope1", "nope2"), true);
eq("空串按不可换算处理", isCrossCategory("", ""), true);

/** 跨类别必须一律 null：13×12 全矩阵，界面禁用逻辑靠它。 */
Object.keys(BASE_OF).forEach((fromCat) => {
    Object.keys(BASE_OF).forEach((toCat) => {
        if (fromCat === toCat) return;
        eq(`跨类别 null：${BASE_OF[fromCat]}→${BASE_OF[toCat]}`, convert(1, BASE_OF[fromCat], BASE_OF[toCat]), null);
    });
});

/* ───────────────────────── 5. convert 的非法输入 ───────────────────────── */

eq("未知源单位返回 null", convert(1, "nope", "m"), null);
eq("未知目标单位返回 null", convert(1, "m", "nope"), null);
eq("两个都未知返回 null", convert(1, "nope", "nope2"), null);
eq("空串单位返回 null", convert(1, "", ""), null);
eq("NaN 返回 null", convert(NaN, "m", "cm"), null);
eq("Infinity 返回 null", convert(Infinity, "m", "cm"), null);
eq("-Infinity 返回 null", convert(-Infinity, "m", "cm"), null);
eq("字符串数值不做隐式转换", convert("10", "m", "cm"), null);
eq("undefined 返回 null", convert(undefined, "m", "cm"), null);
eq("null 返回 null", convert(null, "m", "cm"), null);
eq("布尔返回 null", convert(true, "m", "cm"), null);
eq("同单位返回原值", convert(5, "m", "m"), 5);
eq("同单位返回原值（温度）", convert(36.6, "c", "c"), 36.6);
eq("0 是合法输入不是缺省", convert(0, "m", "km"), 0);
eq("负值合法", convert(-2, "km", "m"), -2000);

/* ───────────────────────── 6. 长度 ───────────────────────── */

approx("1 米 = 100 厘米", convert(1, "m", "cm"), 100);
approx("1 英里 = 1609.344 米", convert(1, "mi", "m"), 1609.344);
approx("1 英寸 = 0.0254 米", convert(1, "in", "m"), 0.0254);
approx("1 英尺 = 0.3048 米", convert(1, "ft", "m"), 0.3048);
approx("1 码 = 0.9144 米", convert(1, "yd", "m"), 0.9144);
approx("1 海里 = 1852 米", convert(1, "nmi", "m"), 1852);
approx("1 千米 = 1000 米", convert(1, "km", "m"), 1000);
approx("1 微米 = 1e-6 米", convert(1, "um", "m"), 1e-6);
approx("1 毫米 = 0.1 厘米", convert(1, "mm", "cm"), 0.1);
approx("1 英尺 = 12 英寸", convert(1, "ft", "in"), 12);
approx("1 码 = 3 英尺", convert(1, "yd", "ft"), 3);
approx("1 英里 = 5280 英尺", convert(1, "mi", "ft"), 5280);
approx("1 英里 = 1760 码", convert(1, "mi", "yd"), 1760);
approx("1 海里 = 1.150779448 英里", convert(1, "nmi", "mi"), 1852 / 1609.344);
approx("1 米 = 39.37007874 英寸", convert(1, "m", "in"), 1 / 0.0254);
approx("长度往返 m→mi→m", convert(convert(7.42, "m", "mi"), "mi", "m"), 7.42);
approx("长度往返 um→km", convert(convert(1, "um", "km"), "km", "um"), 1);

/* ───────────────────────── 7. 重量 ───────────────────────── */

approx("1 磅 = 0.45359237 千克", convert(1, "lb", "kg"), 0.45359237);
approx("1 斤 = 500 克", convert(1, "jin", "g"), 500);
approx("1 斤 = 0.5 千克", convert(1, "jin", "kg"), 0.5);
approx("1 千克 = 2 斤", convert(1, "kg", "jin"), 2);
approx("1 盎司 = 28.349523125 克", convert(1, "oz", "g"), 28.349523125);
approx("1 磅 = 16 盎司", convert(1, "lb", "oz"), 16);
approx("1 克拉 = 0.2 克", convert(1, "ct", "g"), 0.2);
approx("1 克 = 5 克拉", convert(1, "g", "ct"), 5);
approx("1 吨 = 1000 千克", convert(1, "t", "kg"), 1000);
approx("1 千克 = 1000 克", convert(1, "kg", "g"), 1000);
approx("1 克 = 1000 毫克", convert(1, "g", "mg"), 1000);
approx("1 磅 = 453.59237 克", convert(1, "lb", "g"), 453.59237);
approx("重量往返 lb→ct→lb", convert(convert(3.75, "lb", "ct"), "ct", "lb"), 3.75);
approx("100 斤 = 50 千克", convert(100, "jin", "kg"), 50);

/* ───────────────────────── 8. 容量 ───────────────────────── */

approx("1 加仑（美制）= 3.785411784 升", convert(1, "gal", "l"), 3.785411784);
approx("1 加仑 = 231 立方英寸", convert(1, "gal", "in3"), 231);
approx("1 立方英尺 = 28.316846592 升", convert(1, "ft3", "l"), 28.316846592);
approx("1 立方英寸 = 0.016387064 升", convert(1, "in3", "l"), 0.016387064);
approx("1 立方米 = 1000 升", convert(1, "m3", "l"), 1000);
approx("1 升 = 1000 毫升", convert(1, "l", "ml"), 1000);
approx("1 夸脱 = 0.946352946 升", convert(1, "qt", "l"), 0.946352946);
approx("1 品脱 = 0.473176473 升", convert(1, "pt", "l"), 0.473176473);
approx("1 杯 = 236.5882365 毫升", convert(1, "cup", "ml"), 236.5882365);
approx("1 液盎司 = 29.5735295625 毫升", convert(1, "floz", "ml"), 29.5735295625);
approx("1 汤匙 = 3 茶匙", convert(1, "tbsp", "tsp"), 3);
approx("1 液盎司 = 2 汤匙", convert(1, "floz", "tbsp"), 2);
approx("1 杯 = 16 汤匙", convert(1, "cup", "tbsp"), 16);
approx("1 杯 = 48 茶匙", convert(1, "cup", "tsp"), 48);
approx("1 加仑 = 128 液盎司", convert(1, "gal", "floz"), 128);
approx("1 加仑 = 16 杯", convert(1, "gal", "cup"), 16);
approx("1 夸脱 = 2 品脱", convert(1, "qt", "pt"), 2);
approx("1 立方英尺 = 7.480519480 加仑", convert(1, "ft3", "gal"), 1728 / 231);
approx("容量往返 ml→gal→ml", convert(convert(250, "ml", "gal"), "gal", "ml"), 250);

/* ───────────────────────── 9. 面积 ───────────────────────── */

approx("1 亩 = 666.666… 平方米", convert(1, "mu", "m2"), 2000 / 3);
approx("1 亩 = 1/15 公顷", convert(1, "mu", "ha"), 1 / 15);
approx("15 亩 = 1 公顷", convert(15, "mu", "ha"), 1);
approx("1 公顷 = 10000 平方米", convert(1, "ha", "m2"), 10000);
approx("1 平方千米 = 100 公顷", convert(1, "km2", "ha"), 100);
approx("1 英亩 = 4046.8564224 平方米", convert(1, "ac", "m2"), 4046.8564224);
approx("1 英亩 = 4840 平方码（= 43560 平方英尺）", convert(1, "ac", "ft2"), 43560);
approx("1 平方英尺 = 0.09290304 平方米", convert(1, "ft2", "m2"), 0.09290304);
approx("1 平方英寸 = 0.00064516 平方米", convert(1, "in2", "m2"), 0.00064516);
approx("1 平方英尺 = 144 平方英寸", convert(1, "ft2", "in2"), 144);
approx("1 平方米 = 1e-6 平方千米", convert(1, "m2", "km2"), 1e-6);
approx("面积往返 mu→ac→mu", convert(convert(3, "mu", "ac"), "ac", "mu"), 3);

/* ───────────────────────── 10. 温度（非线性，锚点必须精确落回） ───────────────────────── */

eq("0 °C = 32 °F", convert(0, "c", "f"), 32);
eq("100 °C = 212 °F", convert(100, "c", "f"), 212);
eq("-40 °C = -40 °F（不动点）", convert(-40, "c", "f"), -40);
eq("-40 °F = -40 °C（不动点反向）", convert(-40, "f", "c"), -40);
eq("0 K = -273.15 °C", convert(0, "k", "c"), -273.15);
eq("0 °C = 273.15 K", convert(0, "c", "k"), 273.15);
approx("273.15 K = 0 °C", convert(273.15, "k", "c"), 0);
approx("37 °C = 98.6 °F", convert(37, "c", "f"), 98.6, 1e-12);
approx("0 K = -459.67 °F", convert(0, "k", "f"), -459.67, 1e-12);
approx("0 K = 0 °R", convert(0, "k", "r"), 0);
approx("100 °C = 671.67 °R", convert(100, "c", "r"), 671.67, 1e-12);
approx("491.67 °R = 0 °C", convert(491.67, "r", "c"), 0, 1e-12);
eq("20 °C = 68 °F", convert(20, "c", "f"), 68);
approx("温度不是比例量：10 °C 是 50 °F 而不是 68 的一半", convert(10, "c", "f"), 50, 1e-12);
eq("温度类内部四单位都可用", ["c", "f", "k", "r"].every((id) => convert(25, id, "k") !== null), true);

/**
 * 往返分两级：定义锚点（整度数）要求逐位精确，界面上的 32 °F 不能显示成 31.999999；
 * 任意读数只能要求近似——十进制小数在二进制下本来就不是精确值，1e-12 相对误差才是可承诺的下限。
 */
[0, 32, 37, 100, -40, 212, 0.5].forEach((v) => {
    eq(`C→F→C 逐位精确：${v}`, convert(convert(v, "c", "f"), "f", "c"), v);
});
[32, 212, -40].forEach((v) => {
    eq(`F→C→F 逐位精确：${v}`, convert(convert(v, "f", "c"), "c", "f"), v);
});
[0, 273.15, 373.15, 100, 0.5].forEach((v) => {
    eq(`K→C→K 逐位精确：${v}`, convert(convert(v, "k", "c"), "c", "k"), v);
});
[0, 273.15, 373.15].forEach((v) => {
    eq(`K→R→K 逐位精确：${v}`, convert(convert(v, "k", "r"), "r", "k"), v);
});
[0, 1.5, 25, 36.6, 999.99, -273.15, -40].forEach((v) => {
    approx(`C→F→C 近似回到原值：${v}`, convert(convert(v, "c", "f"), "f", "c"), v, 1e-12);
    approx(`C→K→C 近似回到原值：${v}`, convert(convert(v, "c", "k"), "k", "c"), v, 1e-12);
    approx(`F→K→F 近似回到原值：${v}`, convert(convert(v, "f", "k"), "k", "f"), v, 1e-12);
    approx(`C→R→C 近似回到原值：${v}`, convert(convert(v, "c", "r"), "r", "c"), v, 1e-12);
});
[0, 32, 491.67, 671.67, 1000].forEach((r) => {
    approx(`R→F→R 近似回到原值：${r}`, convert(convert(r, "r", "f"), "f", "r"), r, 1e-12);
    approx(`R→K→R 近似回到原值：${r}`, convert(convert(r, "r", "k"), "k", "r"), r, 1e-12);
});

eq("temperatureToKelvin(100,'c')", temperatureToKelvin(100, "c"), 373.15);
eq("temperatureToKelvin(0,'k')", temperatureToKelvin(0, "k"), 0);
approx("temperatureToKelvin(-40,'f')", temperatureToKelvin(-40, "f"), 233.15, 1e-12);
approx("temperatureToKelvin(491.67,'r')", temperatureToKelvin(491.67, "r"), 273.15, 1e-12);
eq("temperatureFromKelvin(273.15,'f')", temperatureFromKelvin(273.15, "f"), 32);
approx("temperatureFromKelvin(0,'r')", temperatureFromKelvin(0, "r"), 0);
eq("temperatureToKelvin 非温度单位返回 null", temperatureToKelvin(10, "m"), null);
eq("temperatureFromKelvin 非温度单位返回 null", temperatureFromKelvin(10, "kg"), null);
eq("temperatureToKelvin 未知单位返回 null", temperatureToKelvin(10, "nope"), null);
eq("temperatureToKelvin 非有限输入返回 null", temperatureToKelvin(NaN, "c"), null);
eq("temperatureFromKelvin 非有限输入返回 null", temperatureFromKelvin(Infinity, "c"), null);
eq("温度换算的非法输入也返回 null", convert(NaN, "c", "f"), null);

/* ───────────────────────── 11. 速度 ───────────────────────── */

approx("1 节 = 1.852 千米每时", convert(1, "kn", "kph"), 1.852);
approx("1 节 = 0.514444… 米每秒", convert(1, "kn", "mps"), 1852 / 3600);
approx("1 米每秒 = 3.6 千米每时", convert(1, "mps", "kph"), 3.6);
approx("1 千米每时 = 0.2777… 米每秒", convert(1, "kph", "mps"), 1 / 3.6);
approx("1 英里每时 = 1.609344 千米每时", convert(1, "mph", "kph"), 1.609344);
approx("1 英里每时 = 0.44704 米每秒", convert(1, "mph", "mps"), 0.44704);
approx("1 马赫 = 340.29 米每秒", convert(1, "mach", "mps"), 340.29);
approx("1 马赫 = 1225.044 千米每时", convert(1, "mach", "kph"), 340.29 * 3.6);
approx("1 千米每时 = 0.539956… 节", convert(1, "kph", "kn"), 1000 / 1852);
approx("速度往返 kn→mph→kn", convert(convert(12.5, "kn", "mph"), "mph", "kn"), 12.5);

/* ───────────────────────── 12. 时间 ───────────────────────── */

approx("1 分钟 = 60 秒", convert(1, "min", "s"), 60);
approx("1 小时 = 3600 秒", convert(1, "h", "s"), 3600);
approx("1 天 = 24 小时", convert(1, "d", "h"), 24);
approx("1 周 = 7 天", convert(1, "wk", "d"), 7);
approx("1 月 = 30 天", convert(1, "mo", "d"), 30);
approx("1 年 = 365 天", convert(1, "yr", "d"), 365);
approx("1 秒 = 1000 毫秒", convert(1, "s", "ms"), 1000);
approx("1 年 = 31536000 秒", convert(1, "yr", "s"), 365 * 86400);
approx("1 周 = 604800000 毫秒", convert(1, "wk", "ms"), 604800000);
approx("时间往返 ms→yr→ms", convert(convert(1, "ms", "yr"), "yr", "ms"), 1);
approx("1 小时 = 0.041666… 天", convert(1, "h", "d"), 1 / 24);

/* ───────────────────────── 13. 数据（1024 二进制前缀） ───────────────────────── */

approx("1 GB = 1024 MB", convert(1, "gb", "mb"), 1024);
approx("1 TB = 1024 GB", convert(1, "tb", "gb"), 1024);
approx("1 PB = 1024 TB", convert(1, "pb", "tb"), 1024);
approx("1 KB = 1024 字节", convert(1, "kb", "byte"), 1024);
approx("1 MB = 1024 KB", convert(1, "mb", "kb"), 1024);
approx("1 字节 = 8 比特", convert(1, "byte", "bit"), 8);
approx("1 KB = 8192 比特", convert(1, "kb", "bit"), 8192);
approx("1 GB = 8589934592 比特", convert(1, "gb", "bit"), 8 * 1024 ** 3);
approx("1 MB = 1048576 字节", convert(1, "mb", "byte"), 1048576);
approx("数据往返 pb→bit→pb", convert(convert(2.5, "pb", "bit"), "bit", "pb"), 2.5);
check("数据按 1024 而非 SI 的 1000 定义", convert(1, "kb", "byte") === 1024, convert(1, "kb", "byte"));
approx("1 GB = 1/1024 TB", convert(1, "gb", "tb"), 1 / 1024);

/* ───────────────────────── 14. 能量 ───────────────────────── */

approx("1 千瓦时 = 3.6e6 焦耳", convert(1, "kwh", "j"), 3.6e6);
approx("1 千瓦时 = 1000 瓦时", convert(1, "kwh", "wh"), 1000);
approx("1 瓦时 = 3600 焦耳", convert(1, "wh", "j"), 3600);
approx("1 千焦 = 1000 焦耳", convert(1, "kj", "j"), 1000);
approx("1 卡路里 = 4.184 焦耳", convert(1, "cal", "j"), 4.184);
approx("1 千卡 = 4184 焦耳", convert(1, "kcal", "j"), 4184);
approx("1 千卡 = 1000 卡", convert(1, "kcal", "cal"), 1000);
approx("1 BTU = 1055.05585262 焦耳", convert(1, "btu", "j"), 1055.05585262);
eq("1 BTU 读数四舍五入到 5 位是 1055.05585", formatValue(convert(1, "btu", "j"), { decimals: 5, thousands: false }), "1055.05585");
approx("1 电子伏特 = 1.602176634e-19 焦耳", convert(1, "ev", "j"), 1.602176634e-19);
approx("能量往返 btu→ev→btu", convert(convert(1, "btu", "ev"), "ev", "btu"), 1);
approx("1 焦耳 = 0.2388458966 卡", convert(1, "j", "cal"), 1 / 4.184);
approx("1 千瓦时 = 859.845… 大卡（电表与食品标签同一把尺）", convert(1, "kwh", "kcal"), 3.6e6 / 4184);

/* ───────────────────────── 15. 压力 ───────────────────────── */

approx("1 千帕 = 1000 帕", convert(1, "kpa", "pa"), 1000);
approx("1 兆帕 = 1000 千帕", convert(1, "mpa", "kpa"), 1000);
approx("1 巴 = 100000 帕", convert(1, "bar", "pa"), 1e5);
approx("1 巴 = 100 千帕", convert(1, "bar", "kpa"), 100);
approx("1 标准大气压 = 101325 帕", convert(1, "atm", "pa"), 101325);
approx("1 标准大气压 = 1.01325 巴", convert(1, "atm", "bar"), 1.01325);
// 毫米汞柱按汞密度定义（133.322387415 Pa），与 Torr（101325/760）差千万分之几，
// 所以 1 atm 是 759.99996 mmHg 而不是 760：容差放宽到 0.01，别把定义差异当 bug。
near("1 标准大气压 ≈ 760 毫米汞柱", convert(1, "atm", "mmhg"), 760, 0.01);
approx("1 毫米汞柱 = 133.322387415 帕", convert(1, "mmhg", "pa"), 13595.1 * 9.80665 * 1e-3);
approx("1 psi = 6894.757293168 帕", convert(1, "psi", "pa"), 0.45359237 * 9.80665 / 0.0254 ** 2);
approx("1 psi = 6.894757… 千帕", convert(1, "psi", "kpa"), 6.894757293168361);
approx("1 标准大气压 = 14.695948776 psi", convert(1, "atm", "psi"), 101325 / (0.45359237 * 9.80665 / 0.0254 ** 2));
approx("压力往返 psi→bar→psi", convert(convert(33, "psi", "bar"), "bar", "psi"), 33);

/* ───────────────────────── 16. 功率 ───────────────────────── */

approx("1 千瓦 = 1000 瓦", convert(1, "kw", "w"), 1000);
approx("1 马力（机械）= 745.699871582 瓦", convert(1, "hp", "w"), 745.6998715822702);
approx("1 马力（公制）= 735.49875 瓦", convert(1, "ps", "w"), 735.49875);
approx("机械马力比公制马力大约 1.4 %", convert(1, "hp", "ps"), 745.6998715822702 / 735.49875);
approx("1 千瓦 = 1.34102209 马力（机械）", convert(1, "kw", "hp"), 1000 / 745.6998715822702);
approx("功率往返 w→hp→w", convert(convert(2.2, "w", "hp"), "hp", "w"), 2.2);

/* ───────────────────────── 17. 角度 ───────────────────────── */

approx("1 度 = 60 角分", convert(1, "deg", "arcmin"), 60);
approx("1 度 = 3600 角秒", convert(1, "deg", "arcsec"), 3600);
approx("1 角分 = 60 角秒", convert(1, "arcmin", "arcsec"), 60);
approx("1 弧度 = 57.29577951308232 度", convert(1, "rad", "deg"), 180 / Math.PI);
approx("π 弧度 = 180 度", convert(Math.PI, "rad", "deg"), 180);
approx("100 百分度 = 90 度", convert(100, "grad", "deg"), 90);
approx("1 度 = 1.1111 百分度", convert(1, "deg", "grad"), 1 / 0.9);
approx("角度往返 arcsec→rad→arcsec", convert(convert(4500, "arcsec", "rad"), "rad", "arcsec"), 4500);

/* ───────────────────────── 18. 货币快照 ───────────────────────── */

eq("汇率基准日", RATE_DATE, "2026-10");
eq("美元是快照基准（1 USD = 1）", RATES.USD, 1);
eq("货币类别 kind", categoryOfUnit("cny")?.kind, "currency");
CURRENCY_CODES.forEach((code) => {
    const found = findUnit(code.toLowerCase());
    check(`汇率表含 ${code}`, !!found && found.category.id === "currency", code);
    approx(`${code} 的 factor 是 RATES 的倒数`, found.unit.factor, 1 / RATES[code], 1e-15);
});
approx("1 美元 = 7.1 人民币", convert(1, "usd", "cny"), 7.1);
approx("100 美元 = 14850 日元", convert(100, "usd", "jpy"), 14850);
approx("1 美元 = 6.96 玻利维亚诺", convert(1, "usd", "bob"), 6.96);
approx("1 欧元 = 美元/欧元倒数", convert(1, "eur", "usd"), 1 / RATES.EUR, 1e-12);
approx("USD→CNY 往返一致", convert(convert(1234.56, "usd", "cny"), "cny", "usd"), 1234.56);
approx("CZK→BOB 可得（截图里出现的组合）", convert(1000, "czk", "bob"), 1000 * RATES.BOB / RATES.CZK, 1e-12);
approx("CZK→BOB→CZK 往返一致", convert(convert(1000, "czk", "bob"), "bob", "czk"), 1000);
check("CZK→BOB 结果是正有限数", Number.isFinite(convert(1000, "czk", "bob")) && convert(1000, "czk", "bob") > 0, convert(1000, "czk", "bob"));
near("CZK→BOB 读数约 301.3", convert(1000, "czk", "bob"), 301.2987013, 1e-4);
approx("USD→CNY→EUR→USD 链式与直接一致",
    convert(convert(convert(500, "usd", "cny"), "cny", "eur"), "eur", "usd"), 500);
approx("货币 0 金额合法", convert(0, "usd", "cny"), 0);
approx("货币负值合法（退款场景）", convert(-25.5, "usd", "cny"), -25.5 * RATES.CNY, 1e-12);
eq("同币种返回原值", convert(88.8, "krw", "krw"), 88.8);
check("日元/韩元提示 0 位小数（ISO 4217 无辅币）",
    findUnit("jpy").unit.decimalsHint === 0 && findUnit("krw").unit.decimalsHint === 0);
check("人民币提示 2 位小数", findUnit("cny").unit.decimalsHint === 2);
// 快照会过期：界面必须能拿到基准日文案，所以 RATE_DATE 必须是可直接展示的字符串。
check("RATE_DATE 可直接展示", typeof RATE_DATE === "string" && /^\d{4}-\d{2}$/.test(RATE_DATE), RATE_DATE);

/* ───────────────────────── 19. 全表自检：基准换算与往返 ───────────────────────── */

ALL_UNITS.forEach(({ unit, category }) => {
    const base = BASE_OF[category.id];
    const one = convert(1, unit.id, base);
    if (category.kind === "temp") {
        check(`${unit.id}→开尔文 是有限数`, Number.isFinite(one), one);
    } else {
        approx(`1 ${unit.id} 折算到基准 ${base} 为正数`, one, unit.factor, 1e-9);
    }
    eq(`自身换算 ${unit.id}`, convert(3.25, unit.id, unit.id), 3.25);
});
ALL_UNITS.forEach(({ unit, category }) => {
    const base = BASE_OF[category.id];
    const there = convert(2.5, base, unit.id);
    const back = convert(there, unit.id, base);
    if (category.kind === "temp") {
        near(`温度往返 ${base}→${unit.id}→${base}`, back, 2.5, 1e-9);
    } else {
        approx(`往返 ${base}→${unit.id}→${base}`, back, 2.5, 1e-9);
    }
});

/* ───────────────────────── 20. formatValue ───────────────────────── */

eq("0 不加小数点", formatValue(0), "0");
eq("负零归一为 0", formatValue(-0), "0");
eq("千位分隔", formatValue(1234567.891), "1,234,567.891");
eq("极小值转科学计数", formatValue(1e-12), "1e-12");
eq("NaN 显示中文错误", formatValue(NaN), "错误");
eq("Infinity 显示中文错误", formatValue(Infinity), "错误");
eq("-Infinity 显示中文错误", formatValue(-Infinity), "错误");
eq("非数值输入显示中文错误", formatValue("1234"), "错误");
eq("undefined 显示中文错误", formatValue(undefined), "错误");
eq("错误文案可覆盖", formatValue(NaN, { errorText: "不可换算" }), "不可换算");
eq("整数值不带小数点", formatValue(5), "5");
eq("负整数", formatValue(-42), "-42");
eq("六位整数分组", formatValue(999999), "999,999");
eq("不足千位不加分隔", formatValue(999), "999");
eq("小数去尾零", formatValue(2.5, { decimals: 2 }), "2.5");
eq("固定小数位", formatValue(1 / 3, { decimals: 4 }), "0.3333");
eq("固定小数位会补零到该位再截尾", formatValue(1, { decimals: 2 }), "1");
eq("关闭千位分隔用 thousands（与 engine.js/rpn.js 同名选项）", formatValue(1234567.891, { thousands: false }), "1234567.891");
eq("显式打开千位分隔", formatValue(1234567.891, { thousands: true }), "1,234,567.891");
eq("decimals 的 auto 写法与省略等价", formatValue(1 / 3, { decimals: "auto" }), formatValue(1 / 3));
eq("未知选项名被忽略而不是关掉默认行为", formatValue(1234.5, { grouping: false }), "1,234.5");
eq("opts 缺省等价于空对象", formatValue(1234.5, undefined), "1,234.5");
eq("自定义分隔符", formatValue(1234.5, { groupSeparator: " " }), "1 234.5");
eq("有效位切掉浮点尾巴", formatValue(0.1 + 0.2), "0.3");
eq("有效位可收窄", formatValue(1 / 3, { sig: 4 }), "0.333");
eq("极大值转科学计数", formatValue(1e15), "1e15");
eq("科学计数正指数不带加号", formatValue(1.23e21), "1.23e21");
eq("科学计数负指数保留负号", formatValue(-1e-10), "-1e-10");
eq("科学计数也去尾零", formatValue(1e-12, { sig: 6 }), "1e-12");
eq("阈值可放宽（1e-12 低于默认 1e-9，放宽后仍出科学计数而不是 0）", formatValue(1e-12, { exponentBelow: 1e-15 }), "1e-12");
eq("小数但不触发科学计数", formatValue(1e-6), "0.000001");
eq("负小数分组", formatValue(-12345.6, { decimals: 1 }), "-12,345.6");
eq("换算结果直接可格式化", formatValue(convert(1, "mi", "m")), "1,609.344");
eq("面积亩读数", formatValue(convert(1, "mu", "m2")), "666.666666667");
eq("电子伏特读数走科学计数", formatValue(convert(1, "ev", "j")), "1.602176634e-19");
eq("大整数不做无谓截位（双精度整数位本身精确）", formatValue(12345678901234, { sig: 12 }), "12,345,678,901,234");
eq("四舍五入进位到更高整数位", formatValue(0.9999999999999), "1");
eq("进位后的分组仍然正确", formatValue(999999.9999999999), "1,000,000");

/* ───────────────────────── 21. suggestUnit ───────────────────────── */

eq("1500 米建议千米", suggestUnit("length", 1500)?.unit.id, "km");
approx("1500 米的建议读数", suggestUnit("length", 1500)?.value, 1.5);
eq("0.0005 米建议微米", suggestUnit("length", 0.0005)?.unit.id, "um");
eq("0.5 米建议厘米", suggestUnit("length", 0.5)?.unit.id, "cm");
eq("0.5 米建议读数 50", suggestUnit("length", 0.5)?.value, 50);
eq("1e-9 米（比最小单位还小）落到微米", suggestUnit("length", 1e-9)?.unit.id, "um");
eq("8 GiB 建议 GB", suggestUnit("data", 8 * 1024 ** 3)?.unit.id, "gb");
eq("604800 秒建议周", suggestUnit("time", 604800)?.unit.id, "wk");
eq("90000 秒建议天", suggestUnit("time", 90000)?.unit.id, "d");
eq("2 千克建议千克而不是 2000 克", suggestUnit("mass", 2)?.unit.id, "kg");
eq("2000 千克建议吨", suggestUnit("mass", 2000)?.unit.id, "t");
approx("2000 千克的建议读数", suggestUnit("mass", 2000)?.value, 2);
eq("1 焦耳的千焦之下建议焦耳", suggestUnit("energy", 1)?.unit.id, "j");
eq("1 焦耳建议读数 1", suggestUnit("energy", 1)?.value, 1);
eq("负值保留符号", suggestUnit("length", -1500)?.value, -1.5);
eq("温度没有档位阶梯，返回 null", suggestUnit("temperature", 100), null);
eq("货币没有档位阶梯，返回 null", suggestUnit("currency", 100), null);
eq("0 没有合适档位，返回 null", suggestUnit("length", 0), null);
eq("NaN 返回 null", suggestUnit("length", NaN), null);
eq("Infinity 返回 null", suggestUnit("length", Infinity), null);
eq("未知类别返回 null", suggestUnit("nope", 1), null);
const LINEAR = CATEGORIES.filter((c) => c.kind === "linear");
check("线性类别都声明了 ladder", LINEAR.every((c) => Array.isArray(c.ladder) && c.ladder.length > 0),
    LINEAR.filter((c) => !Array.isArray(c.ladder)).map((c) => c.id));
check("ladder 里的 id 都在该类别单位表里", LINEAR.every((c) => c.ladder.every((id) => c.units.some((u) => u.id === id))),
    LINEAR.flatMap((c) => c.ladder.filter((id) => !c.units.some((u) => u.id === id)).map((id) => `${c.id}/${id}`)));
check("建议单位一定来自 ladder", LINEAR.every((c) => c.ladder.every((id) => {
    const factor = c.units.find((u) => u.id === id).factor;
    return suggestUnit(c.id, factor)?.unit.id != null && c.ladder.includes(suggestUnit(c.id, factor).unit.id);
})));
check("按 ladder 档位取整量级时读数不小于 1 且建议有效", LINEAR.every((c) => c.ladder.every((id) => {
    const factor = c.units.find((u) => u.id === id).factor;
    const pick = suggestUnit(c.id, factor * 7);
    return !!pick && pick.value >= 1 && pick.value < 1000;
})), LINEAR.map((c) => `${c.id}:${c.ladder.map((id) => suggestUnit(c.id, c.units.find((u) => u.id === id).factor * 7)?.unit.id).join(">")}`));

/* ───────────────────────── 结果 ───────────────────────── */

console.log(`  · 断言 ${passed + failures.length} 条`);
if (failures.length) {
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    console.log(`计算器换算断言失败 ${failures.length} 条`);
    process.exit(1);
}
console.log("计算器换算断言全部通过 ✓");
// convert.js 不留定时器，但仓库其它模块在 import 时会注册 setInterval；
// 显式退出，不让校验脚本因为事件循环里还有活就挂住。
process.exit(0);
