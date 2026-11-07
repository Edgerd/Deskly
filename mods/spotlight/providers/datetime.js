/**
 * providers/datetime.js — 自然语言日期换算（「下周三」「3 天后」「in 5 days」）
 *
 * 注册表条目：分组 calculation（与计算同属 top hit 区）、权重 60、
 * 匹配策略 固定词表 + N 天/周前后 + 周几偏移（中英双语，离线纯计算）、
 * 索引方式 无（每次查询现算，毫秒级）、异步 否、
 * 失败降级 不认识的表达返回 []（绝不错给日期）。
 */

import { i18n } from "../../../src/javascripts/i18n.js";
import { glyph } from "../../../src/javascripts/paths.js";

const DAY = 86_400_000;
const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];

/** 今天 0 点（本地时区）为基准，避免跨午夜的绝对毫秒漂移。 */
function today() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** 格式化成「2026年11月12日 星期四」；动作用 copyText 复制 ISO。 */
function format(date) {
    return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 · 星期${WEEKDAY_ZH[date.getDay()]}`;
}

/**
 * 解析自然日期表达。返回 Date 或 null。
 * 支持：今天/明天/后天/昨天/前天；N 天后/N 天前（digits 与中文数字一二三四五六七八九十）；
 * 本周X/下周X/下下周X/上周X；tomorrow / yesterday / in N days / N days ago / next fri(day)。
 */
export function parseNaturalDate(raw) {
    const text = String(raw || "").trim().toLowerCase();
    if (!text) return null;
    const base = today();
    const fixed = {
        "今天": 0, "明天": 1, "后天": 2, "昨天": -1, "前天": -2,
        "today": 0, "tomorrow": 1, "yesterday": -1,
    };
    if (text in fixed) return new Date(base.getTime() + fixed[text] * DAY);

    const zhNum = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    let m = text.match(/^([0-9]+|[一二两三四五六七八九十])\s*天(后|前)$/);
    if (m) {
        const n = /^[0-9]+$/.test(m[1]) ? parseInt(m[1], 10) : zhNum[m[1]];
        if (Number.isFinite(n)) return new Date(base.getTime() + (m[2] === "后" ? n : -n) * DAY);
    }
    m = text.match(/^(下下周|下周|本周|这周|上周)([一二三四五六日天])$/);
    if (m) {
        const target = WEEKDAY_ZH.indexOf(m[2].replace("天", "日"));
        const offsetWeeks = { "上周": -1, "本周": 0, "这周": 0, "下周": 1, "下下周": 2 }[m[1]];
        const mondayBase = base.getTime() - ((base.getDay() + 6) % 7) * DAY; // 本周一
        return new Date(mondayBase + (offsetWeeks * 7 + (target === 0 ? 6 : target - 1)) * DAY);
    }
    m = text.match(/^in\s+(\d+)\s+days?$/) || text.match(/^(\d+)\s+days?\s+ago$/);
    if (m) {
        const n = parseInt(m[1], 10);
        const sign = text.includes("ago") ? -1 : 1;
        return new Date(base.getTime() + sign * n * DAY);
    }
    m = text.match(/^next\s+(mon|tue|wed|thu|fri|sat|sun)/);
    if (m) {
        const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
        const target = names.indexOf(m[1]);
        const delta = ((target - base.getDay()) + 7) % 7 || 7; // 同日取下周
        return new Date(base.getTime() + delta * DAY);
    }
    return null;
}

export const datetimeProvider = {
    id: "datetime",
    group: "calculation",
    weight: 60,
    async: false,
    types: ["datetime"],
    search(ctx) {
        const date = parseNaturalDate(ctx.query);
        if (!date) return [];
        const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        return [{
            type: "datetime",
            score: 0,
            label: format(date),
            sub: i18n.t("spotlight.dateSub", "日期换算"),
            hint: i18n.t("spotlight.copyHint", "回车复制"),
            icon: glyph("clock.blue"),
            copyText: iso,
        }];
    },
};
