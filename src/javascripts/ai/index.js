/**
 * index.js — Deskly.ai 的内核实现
 *
 * 对外只暴露统一语义：请求、流式事件、附件、语音、状态与连接测试。
 * 服务商差异全部收在 anthropic.js / openai.js 里。
 */

import { settings } from "../settings.js";
import { byId, fallbackProvider, list } from "./providers.js";
import { hasKey, keyOf, maskKey, saveKey, clearKey } from "./credentials.js";
import { aiError, requestJson } from "./transport.js";
import * as anthropic from "./anthropic.js";
import * as openai from "./openai.js";
import { upload as uploadFile } from "./files.js";
import * as speech from "./speech.js";

const EFFORTS = new Set(["off", "low", "medium", "high"]);

function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function activeId() {
    const id = String(settings.get("ai.provider") || "").trim();
    return byId(id) ? id : "deepseek";
}

/** 解析本次请求实际使用的服务商、模型与参数；缺配置时抛可编程错误码。 */
function resolveConfig(request = {}) {
    const provider = byId(request.provider) || byId(activeId()) || fallbackProvider();
    const key = keyOf(provider.id);
    if (provider.keyRequired && !key) {
        throw aiError("NO_KEY", `请先在系统设置中填写 ${provider.name} 密钥`);
    }

    const baseUrl = (provider.id === "custom"
        ? String(settings.get("ai.baseUrl") || "").trim()
        : provider.baseUrl).replace(/\/+$/, "");
    if (!baseUrl) throw aiError("INVALID_ARG", "请先填写服务地址");

    const model = String(settings.get("ai.model") || "").trim() || provider.model;
    if (!model) throw aiError("INVALID_ARG", "请先填写模型名称");

    const effort = EFFORTS.has(settings.get("ai.thinking")) ? settings.get("ai.thinking") : "medium";
    const temperature = clamp(request.temperature, 0, 2, clamp(settings.get("ai.temperature"), 0, 2, 1));
    const maxTokens = Math.round(clamp(request.maxTokens, 256, 32768, clamp(settings.get("ai.maxTokens"), 256, 32768, 4096)));
    // 调用方可能传 true，也可能传 Anthropic 形状 {type:"enabled"|"disabled"}：
    // 只有显式开启才算开，`{type:"disabled"}` 不能因为对象为真值就把思考打开。
    const wantsThinking = request.thinking === true
        || (request.thinking && typeof request.thinking === "object" && request.thinking.type === "enabled");
    // 系统把思考强度设为「不开启」时，调用方仍可临时开启思考：此时按最低强度执行，
    // 由界面负责提示，避免「开了却没生效」。
    const thinking = wantsThinking && provider.capabilities.thinking;
    const effectiveEffort = thinking && effort === "off" ? "low" : effort;

    // 联网搜索 / 链接阅读依赖 DeepSeek 的服务端工具；其他服务商静默丢工具会让用户
    // 以为搜索开着，这里直接给出可读错误（思考与附件不受此限制）。
    if (Array.isArray(request.tools) && request.tools.length && !provider.capabilities.search) {
        throw aiError("UNSUPPORTED", "联网搜索与链接阅读需要 DeepSeek 密钥");
    }

    return {
        provider,
        key,
        baseUrl,
        model,
        temperature,
        maxTokens,
        effort: effectiveEffort,
        thinking,
        request,
    };
}

async function run(prepared, onEvent, signal) {
    const ctx = {
        provider: prepared.provider,
        baseUrl: prepared.baseUrl,
        key: prepared.key,
        model: prepared.model,
        request: prepared.request,
        temperature: prepared.temperature,
        maxTokens: prepared.maxTokens,
        thinking: prepared.thinking,
        effort: prepared.effort,
        signal,
        onEvent,
    };
    if (prepared.provider.kind === "anthropic") await anthropic.stream(ctx);
    else await openai.stream(ctx);
    return { provider: prepared.provider.id, model: prepared.model };
}

/** 可序列化的服务商清单（绝不带密钥）。 */
export function listProviders() {
    return list().map((provider) => ({
        ...provider,
        baseUrl: provider.id === "custom" ? "" : provider.baseUrl,
        configured: hasKey(provider.id),
    }));
}

/** 当前生效配置与能力。 */
export function status() {
    const provider = byId(activeId()) || fallbackProvider();
    const model = String(settings.get("ai.model") || "").trim() || provider.model;
    return {
        provider: provider.id,
        name: provider.name,
        model,
        configured: hasKey(provider.id),
        keyHint: maskKey(keyOf(provider.id)),
        capabilities: { ...provider.capabilities },
        effort: settings.get("ai.thinking"),
        temperature: settings.get("ai.temperature"),
        maxTokens: settings.get("ai.maxTokens"),
    };
}

/** 连接测试：GET /models，用返回结果确认密钥与地址都有效。 */
export async function validate(providerId) {
    const prepared = resolveConfig({ provider: providerId });
    const body = await requestJson(`${prepared.baseUrl}/models`, {
        headers: prepared.key ? { Authorization: `Bearer ${prepared.key}` } : {},
    });
    const models = body && Array.isArray(body.data)
        ? body.data.map((item) => String(item && item.id || "")).filter(Boolean)
        : [];
    return { provider: prepared.provider.id, model: prepared.model, models };
}

/** 非流式对话：内部复用流，聚合文本与用量。 */
export async function chat(request = {}) {
    const prepared = resolveConfig(request);
    let text = "";
    let usage = null;
    await run(prepared, (event) => {
        if (!event) return;
        if (event.type === "content_block_delta" && event.delta && event.delta.type === "text_delta") {
            text += event.delta.text || "";
        } else if (event.type === "message_delta" && event.usage) {
            usage = event.usage;
        }
    });
    return { text, usage, provider: prepared.provider.id, model: prepared.model };
}

/**
 * 流式对话：立即返回 { abort }；事件、结束、错误走回调。
 * @param {object} request
 * @param {{onEvent?:Function,onDone?:Function,onError?:Function}} handlers
 */
export async function startStream(request = {}, handlers = {}) {
    const prepared = resolveConfig(request);
    const controller = new AbortController();
    run(prepared, (event) => {
        try { handlers.onEvent?.(event); } catch (err) { console.warn("[ai] onEvent 回调失败：", err); }
    }, controller.signal)
        .then((result) => {
            try { handlers.onDone?.(result); } catch (err) { console.warn("[ai] onDone 回调失败：", err); }
        })
        .catch((err) => {
            try { handlers.onError?.(err); } catch (inner) { console.warn("[ai] onError 回调失败：", inner); }
        });
    return { abort: () => controller.abort() };
}

/** 上传附件；服务商差异由 files.js 处理。 */
export async function upload(file) {
    const prepared = resolveConfig({});
    return uploadFile({ provider: prepared.provider, key: prepared.key, file });
}

/** 语音合成（仅 DeepSeek）。 */
export async function synthesize(text, voice) {
    const prepared = resolveConfig({});
    if (prepared.provider.id !== "deepseek") {
        throw aiError("UNSUPPORTED", "语音功能需要 DeepSeek 密钥");
    }
    return speech.synthesize({ baseUrl: prepared.baseUrl, key: prepared.key, text, voice });
}

/** 语音识别（仅 DeepSeek）。 */
export async function transcribe(audio) {
    const prepared = resolveConfig({});
    if (prepared.provider.id !== "deepseek") {
        throw aiError("UNSUPPORTED", "语音功能需要 DeepSeek 密钥");
    }
    return speech.transcribe({ baseUrl: prepared.baseUrl, key: prepared.key, audio });
}

export { saveKey, clearKey, maskKey };
