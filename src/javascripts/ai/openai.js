/**
 * openai.js — OpenAI Chat Completions 兼容适配器
 *
 * 把统一的 Anthropic 消息形状翻成 OpenAI 请求，再把 delta 流翻回
 * Anthropic 事件，让上层（Deskly AI）只认一种事件协议。
 */

import { aiError, streamSse } from "./transport.js";
import { resolveFileBlocks } from "./files.js";

/** 把 Anthropic 内容块翻成 OpenAI 的 content。 */
function convertContent(role, content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts = [];
    for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
            parts.push({ type: "text", text: block.text });
        } else if (block.type === "image" && block.source) {
            const source = block.source;
            if (source.type === "base64" && source.data) {
                parts.push({
                    type: "image_url",
                    image_url: { url: `data:${source.media_type || "image/png"};base64,${source.data}` },
                });
            } else if (source.type === "file") {
                throw aiError("UNSUPPORTED", "当前服务不支持这个附件，请改发图片或文本");
            }
        } else if (block.type === "document" && block.source) {
            const source = block.source;
            if (source.type === "text" && typeof source.text === "string") {
                parts.push({ type: "text", text: source.text });
            } else {
                throw aiError("UNSUPPORTED", "当前服务不支持这个文档类型");
            }
        }
    }
    if (role !== "user") {
        return parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    }
    if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
    return parts;
}

/** 统一消息 -> OpenAI messages。 */
function convertMessages(request, provider) {
    const messages = resolveFileBlocks(request.messages, provider);
    const output = [];
    if (request.system) output.push({ role: "system", content: String(request.system) });
    for (const message of messages) {
        if (!message || !message.role) continue;
        output.push({
            role: message.role === "assistant" ? "assistant" : "user",
            content: convertContent(message.role, message.content),
        });
    }
    return output;
}

/** 思考开关写到该服务商认识的参数上。 */
function applyThinking(body, ctx) {
    if (!ctx.thinking) return;
    switch (ctx.provider.thinkingMode) {
        case "reasoning_effort":
            body.reasoning_effort = ctx.effort === "high" ? "high" : ctx.effort === "low" ? "low" : "medium";
            break;
        case "enable_thinking":
            body.enable_thinking = true;
            break;
        case "thinking":
            body.thinking = { type: "enabled" };
            break;
        case "think":
            body.think = true;
            break;
        default:
            break;
    }
}

/** 生成请求体（导出给诊断用）。 */
export function buildBody(ctx) {
    const body = {
        model: ctx.model,
        messages: convertMessages(ctx.request, ctx.provider),
        stream: true,
        stream_options: { include_usage: true },
    };
    if (Number.isFinite(ctx.temperature)) body.temperature = ctx.temperature;
    if (Number.isFinite(ctx.maxTokens)) body.max_tokens = ctx.maxTokens;
    applyThinking(body, ctx);
    return body;
}

function stopReason(reason) {
    return reason === "length" ? "max_tokens" : "end_turn";
}

/** 把 OpenAI 的 delta 流翻译成 Anthropic 事件。 */
function createTranslator(ctx) {
    let started = false;
    let openType = null;
    let index = 0;
    let usage = null;
    let finish = null;

    const emit = (event) => ctx.onEvent(event);
    const startMessage = () => {
        if (started) return;
        started = true;
        emit({
            type: "message_start",
            message: {
                id: `deskly-${Date.now()}`,
                type: "message",
                role: "assistant",
                model: ctx.model,
                content: [],
                usage: { input_tokens: 0, output_tokens: 0 },
            },
        });
    };
    const open = (type) => {
        startMessage();
        if (openType === type) return;
        if (openType) {
            emit({ type: "content_block_stop", index });
            index += 1;
        }
        openType = type;
        emit({
            type: "content_block_start",
            index,
            content_block: type === "thinking"
                ? { type: "thinking", thinking: "", signature: "" }
                : { type: "text", text: "" },
        });
    };

    return {
        push(event) {
            if (event && event.usage) usage = event.usage;
            const choice = event && Array.isArray(event.choices) ? event.choices[0] : null;
            if (!choice) return;
            const delta = choice.delta || {};
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
                open("thinking");
                emit({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: delta.reasoning_content } });
            }
            if (typeof delta.content === "string" && delta.content) {
                open("text");
                emit({ type: "content_block_delta", index, delta: { type: "text_delta", text: delta.content } });
            }
            if (choice.finish_reason) finish = choice.finish_reason;
        },
        finish() {
            startMessage();
            if (openType) emit({ type: "content_block_stop", index });
            const input = usage ? Number(usage.prompt_tokens) || 0 : 0;
            const output = usage ? Number(usage.completion_tokens) || 0 : 0;
            emit({
                type: "message_delta",
                delta: { stop_reason: stopReason(finish), stop_sequence: null },
                usage: { input_tokens: input, output_tokens: output },
            });
            emit({ type: "message_stop" });
        },
    };
}

export async function stream(ctx) {
    const baseUrl = String(ctx.baseUrl || ctx.provider.baseUrl).replace(/\/+$/, "");
    if (!baseUrl) throw aiError("INVALID_ARG", "请先填写服务地址");
    const headers = { "content-type": "application/json" };
    if (ctx.key) headers.Authorization = `Bearer ${ctx.key}`;

    const translator = createTranslator(ctx);
    await streamSse(`${baseUrl}/chat/completions`, {
        headers,
        body: JSON.stringify(buildBody(ctx)),
        signal: ctx.signal,
        onEvent: (event) => translator.push(event),
    });
    translator.finish();
}
