/**
 * providers/websearch.js — 网页搜索回退（本地无结果时给出「用搜索引擎打开」）
 *
 * 注册表条目：分组 websearch、权重 99（永远垫底）、匹配策略 不参与本地匹配、
 * 索引方式 无、异步 否、失败降级 只拼 URL，整条链路不联网。
 *
 * 使用方式特殊：它不是常规 provider —— shell 在一次查询本地结果为空时才
 * 调 fallback(query) 追加这条结果（macOS 的「搜索网页」行为），
 * 因此引擎中途不会把它混进本地结果里。
 */

import { i18n } from "../../../src/javascripts/i18n.js";
import { assetIcon } from "../../../src/javascripts/paths.js";

/** 搜索引擎：与壁纸线一致选 Bing（国内可达，不要求 API key）。 */
const ENGINE_URL = "https://www.bing.com/search?q=";

/**
 * 构造「网页搜索」回退结果。
 * @param {string} query 查询文本
 * @returns {object|null} 结果条目；空查询返回 null
 */
export function webSearchFallback(query) {
    const text = String(query || "").trim();
    if (!text) return null;
    return {
        type: "websearch",
        group: "websearch",
        weight: 99,
        score: 2,
        label: i18n.t("spotlight.websearchLabel", "搜索网页"),
        sub: `Bing · ${text}`,
        hint: i18n.t("spotlight.openBrowserHint", "回车在浏览器打开"),
        icon: assetIcon("Safari"),
        action: () => window.open(`${ENGINE_URL}${encodeURIComponent(text)}`, "_blank", "noopener"),
    };
}
