/**
 * providers/instant.js — 聚焦即时换算（F-21）：裸数量多单位列表 + 货币符号
 *
 * 与 calculator/spotlight-provider.js 的分工：那边管「显式目标」表（"5 km to mile"、
 * "100 usd to cny"），这里管原版 S0016 的「裸数量」形态 —— 只给数量与单位、不给目标时，
 * 直接列出一排最常用的目标单位：
 *   25 磅 / 25lb   →  千克 / 吨 / 斤 / 盎司 / 克 / 克拉 …（同类别按量级从大到小，至多 6 行）
 *   $100 / 100$    →  人民币 / 欧元 / 日元 / 英镑 / 港币 / 新台币（汇率快照标注在首行副标题）
 *   100 美元       →  同上（单位名直接命中货币表）
 *
 * 数据源只有 mods/calculator/convert.js 一张表（纯逻辑、零依赖）：单位定义、换算内核、
 * 汇率快照全部复用，本文件不持有第二份换算事实，避免两处各算各的。
 *
 * 开关门：与计算器同用 spotlight.convert（「计算与换算」）——关掉后本 provider 一并退场。
 */

import { i18n } from "../../../src/javascripts/i18n.js";
import { CATEGORIES, convert, formatValue, RATE_DATE } from "../../calculator/convert.js";

/** 常用别名 → 单位 id：表内 name 之外的通俗写法（「公斤/公里/元」这类）。 */
const ALIASES = {
    "公斤": "kg", "公里": "km", "千米": "km", "元": "cny", "美刀": "usd", "大卡": "kcal",
    "度": "c",
    "pounds": "lb", "pound": "lb", "lbs": "lb",
    "kilograms": "kg", "kilogram": "kg", "kilo": "kg", "kilos": "kg",
    "kilometers": "km", "kilometer": "km",
    "miles": "mi", "mile": "mi",
    "inches": "in", "inch": "in",
    "feet": "ft", "foot": "ft",
    "gallons": "gal", "gallon": "gal",
    "dollars": "usd", "dollar": "usd",
    "euros": "eur", "euro": "eur",
    "yen": "jpy", "yuan": "cny",
};

/** 货币符号 → 单位 id（「¥」按中文界面惯例归人民币；日元写 jpy/日元）。 */
const SYMBOLS = { "$": "usd", "€": "eur", "£": "gbp", "¥": "cny", "￥": "cny" };

/** 裸数量形态：$100 / 100$ / 100 usd / 25 磅 / 25lb。 */
const BARE_RE = [
    /^([$€£¥￥])\s*([\d][\d,]*(?:\.\d+)?)$/,          // 符号在前：$100
    /^([\d][\d,]*(?:\.\d+)?)\s*([$€£¥￥])$/,          // 符号在后：100$
    /^([\d][\d,]*(?:\.\d+)?)\s*([^\d\s.,+*/=×÷^%()\-]{1,8})$/i, // 数量+单位：25 磅 / 25lb
];

/**
 * 解析数量文本（容忍千位逗号）。
 * @param {string} raw 数量片段
 * @returns {number|null} 非有限输入返回 null
 */
function parseAmount(raw) {
    const n = Number(String(raw).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
}

/**
 * 在总表里解析单位 token：别名 → id/symbol（拉丁不区分大小写）→ 中文名精确匹配。
 * @param {string} token 用户输入的单位片段
 * @returns {{unit: object, category: object}|null} 未命中返回 null
 */
function resolveToken(token) {
    const raw = String(token || "").trim();
    if (!raw) return null;
    if (ALIASES[raw]) return lookup(ALIASES[raw]);
    const lower = raw.toLowerCase();
    if (SYMBOLS[raw]) return lookup(SYMBOLS[raw]);
    for (const category of CATEGORIES) {
        for (const unit of category.units) {
            if (unit.id === lower || String(unit.symbol).toLowerCase() === lower) {
                return { unit, category };
            }
        }
    }
    for (const category of CATEGORIES) {
        for (const unit of category.units) {
            if (unit.name === raw) return { unit, category };
        }
    }
    return null;
}

/** id → {unit, category}；只给 ALIASES/SYMBOLS 里已收录的 id 用。 */
function lookup(unitId) {
    for (const category of CATEGORIES) {
        for (const unit of category.units) {
            if (unit.id === unitId) return { unit, category };
        }
    }
    return null;
}

/**
 * 生成一排「同类别其他单位」的换算行。
 * 顺序：线性类别按 factor 从大到小（大单位在前，读数天然递减）；货币与温度按表内
 * 既有顺序（人民币/欧元/日元… 与下拉菜单一致，不搞另一套排序事实）。
 * @param {number} amount 数量
 * @param {{unit: object, category: object}} ref 命中的单位
 * @returns {Array<object>} 聚焦结果行
 */
function buildRows(amount, ref) {
    const { unit, category } = ref;
    const isCurrency = category.kind === "currency";
    const others = category.units.filter((u) => u.id !== unit.id);
    const ordered = (category.kind === "linear")
        ? others.slice().sort((a, b) => (Number(b.factor) || 0) - (Number(a.factor) || 0))
        : others;
    const sub = isCurrency
        ? `${i18n.t("spotlight.currencySub", "货币换算")} · ${i18n.t("spotlight.rateDate", "汇率快照")} ${RATE_DATE}`
        : i18n.t("spotlight.convertSub", "单位换算");
    const rows = [];
    ordered.slice(0, 6).forEach((target, index) => {
        const out = convert(amount, unit.id, target.id);
        if (out === null) return;
        const text = formatValue(out, { decimals: target.decimalsHint ?? "auto" });
        rows.push({
            type: "conversion",
            score: 0,
            label: `${text} ${target.name}`,
            sub,
            hint: i18n.t("spotlight.copyHint", "回车复制"),
            copyText: `${text} ${target.name}`,
            weight: index,
        });
    });
    return rows;
}

export const instantProvider = {
    id: "instant",
    group: "calculation",
    weight: 20,
    async: false,
    types: ["conversion"],
    /**
     * 只处理「整条查询就是一个数量+单位」的裸形态；带目标（to）与算式的查询
     * 交给 calculator provider，本 provider 直接不说话，避免同一查询两处抢答案。
     * @param {import("../engine.js").SpotlightQueryContext} ctx 查询上下文
     * @returns {Array<object>} 换算结果行
     */
    search(ctx) {
        const query = String(ctx.query || "").trim();
        if (!query || /[\s]{2,}|[=+*/×÷^]| to /i.test(query)) return [];
        for (const re of BARE_RE) {
            const m = query.match(re);
            if (!m) continue;
            let amount;
            let ref;
            if (SYMBOLS[m[1]]) {
                // 符号在前：$100
                amount = parseAmount(m[2]);
                ref = lookup(SYMBOLS[m[1]]);
            } else if (SYMBOLS[m[2]]) {
                // 符号在后：100$
                amount = parseAmount(m[1]);
                ref = lookup(SYMBOLS[m[2]]);
            } else {
                // 数量 + 单位：25 磅 / 25lb / 100 美元
                amount = parseAmount(m[1]);
                ref = resolveToken(m[2]);
            }
            if (amount === null || !ref) return [];
            return buildRows(amount, ref);
        }
        return [];
    },
};
