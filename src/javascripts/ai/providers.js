/**
 * providers.js — 统一 AI 服务商预设与能力表
 *
 * 单一来源：设置界面、Deskly.ai、Deskly AI 应用的能力开关都读这里，
 * 不在别处再写一份服务商 id 判断。
 *
 * kind：
 *   anthropic —— DeepSeek 的 Anthropic 兼容接口（/anthropic/v1/messages）
 *   openai    —— OpenAI Chat Completions 兼容接口（/chat/completions）
 *
 * thinkingMode：思考强度写进请求体的哪种参数；none 表示不发送。
 */

/** @typedef {{thinking:boolean,images:boolean,documents:boolean,search:boolean,readUrl:boolean,voice:boolean}} AiCapabilities */

export const PROVIDERS = Object.freeze([
    {
        id: "deepseek",
        name: "DeepSeek",
        kind: "anthropic",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-flash",
        models: ["deepseek-flash", "deepseek-chat", "deepseek-reasoner"],
        keyRequired: true,
        thinkingMode: "budget",
        capabilities: { thinking: true, images: true, documents: true, search: true, readUrl: true, voice: true },
    },
    {
        id: "openai",
        name: "OpenAI",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4.1-mini"],
        keyRequired: true,
        thinkingMode: "reasoning_effort",
        capabilities: { thinking: true, images: true, documents: true, search: false, readUrl: false, voice: false },
    },
    {
        id: "moonshot",
        name: "Kimi",
        kind: "openai",
        baseUrl: "https://api.moonshot.cn/v1",
        model: "moonshot-v1-8k",
        models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
        keyRequired: true,
        thinkingMode: "thinking",
        capabilities: { thinking: true, images: true, documents: true, search: false, readUrl: false, voice: false },
    },
    {
        id: "qwen",
        name: "通义千问",
        kind: "openai",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen-plus",
        models: ["qwen-plus", "qwen-turbo", "qwen-max"],
        keyRequired: true,
        thinkingMode: "enable_thinking",
        capabilities: { thinking: true, images: true, documents: true, search: false, readUrl: false, voice: false },
    },
    {
        id: "ollama",
        name: "Ollama",
        kind: "openai",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "llama3.2",
        models: ["llama3.2", "qwen2.5", "deepseek-r1"],
        keyRequired: false,
        thinkingMode: "think",
        capabilities: { thinking: true, images: true, documents: true, search: false, readUrl: false, voice: false },
    },
    {
        id: "custom",
        name: "自定义",
        kind: "openai",
        baseUrl: "",
        model: "",
        models: [],
        keyRequired: false,
        thinkingMode: "reasoning_effort",
        capabilities: { thinking: true, images: true, documents: true, search: false, readUrl: false, voice: false },
    },
]);

/** 预设清单（不含密钥）。 */
export function list() {
    return PROVIDERS.map((provider) => ({
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        model: provider.model,
        models: provider.models.slice(),
        keyRequired: provider.keyRequired,
        capabilities: { ...provider.capabilities },
    }));
}

/** 按 id 取预设；未知 id 返回 null。 */
export function byId(id) {
    const key = String(id || "").trim();
    return PROVIDERS.find((provider) => provider.id === key) || null;
}

/** 当前生效的服务商（设置缺失或非法时回退 DeepSeek）。 */
export function fallbackProvider() {
    return byId("deepseek");
}
