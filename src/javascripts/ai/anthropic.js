/**
 * anthropic.js — DeepSeek 的 Anthropic 兼容适配器
 *
 * 事件原样透传：上游 SSE 就是 Anthropic Messages 形状，Deskly AI 直接消费。
 */

import { streamSse } from "./transport.js";
import { resolveFileBlocks } from "./files.js";

const THINKING_BUDGET = { low: 1024, medium: 2048, high: 4096 };

/** 只放行已知的服务端工具，顺手兼容字符串与 {type,name} 两种写法。 */
function normalizeTools(tools) {
    if (!Array.isArray(tools)) return [];
    const allowed = new Set(["deepseek_read_url", "deepseek_web_search"]);
    return tools
        .map((tool) => (typeof tool === "string" ? tool : tool && tool.type))
        .filter((type) => allowed.has(type))
        .map((type) => ({ type, name: type }));
}

/** 生成请求体（导出给单测/诊断用）。 */
export function buildBody(ctx) {
    const body = {
        model: ctx.model,
        max_tokens: ctx.maxTokens,
        messages: resolveFileBlocks(ctx.request.messages, ctx.provider),
        stream: true,
    };
    if (ctx.request.system) body.system = ctx.request.system;
    if (Number.isFinite(ctx.temperature)) body.temperature = ctx.temperature;

    const tools = normalizeTools(ctx.request.tools);
    if (tools.length) body.tools = tools;

    if (ctx.thinking) {
        const budget = THINKING_BUDGET[ctx.effort] || THINKING_BUDGET.medium;
        body.thinking = { type: "enabled", budget_tokens: budget };
    }
    return body;
}

export async function stream(ctx) {
    const body = buildBody(ctx);
    const needsFiles = JSON.stringify(body.messages).includes('"file"');
    const headers = {
        "content-type": "application/json",
        "x-api-key": ctx.key,
        "anthropic-version": "2023-06-01",
    };
    if (needsFiles) headers["anthropic-beta"] = "files-api-2025-04-14";

    await streamSse(`${ctx.provider.baseUrl}/anthropic/v1/messages`, {
        headers,
        body: JSON.stringify(body),
        signal: ctx.signal,
        onEvent: ctx.onEvent,
    });
}
