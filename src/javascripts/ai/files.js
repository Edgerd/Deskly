/**
 * files.js — 附件在统一 AI 接口里的落点
 *
 * DeepSeek：走 Files API，返回服务端 file_id，可跨刷新复用。
 * 其他兼容服务：没有统一的文件引用机制，图片转 base64、文本类内联；
 * 只在当前页面会话有效，刷新后需要重新发送。
 */

import { aiError, fileToBase64, requestJson } from "./transport.js";

// 不支持服务端文件接口的服务商只能把附件内联进请求体：图片转 base64、文本直传。
// 图片放宽到 10MB（常见截图/照片），文本类保守到 2MB，避免一次请求体过大。
const IMAGE_LIMIT = 10 * 1024 * 1024;
const TEXT_LIMIT = 2 * 1024 * 1024;
const ephemeral = new Map();
let sequence = 0;

const TEXT_TYPES = /^text\//i;
const TEXT_EXTS = /\.(txt|md|markdown|json|csv|log|html|htm|xml|yaml|yml|ts|js|css|py)$/i;

function isTextLike(file) {
    return TEXT_TYPES.test(file.type || "") || TEXT_EXTS.test(file.name || "");
}

/** 上传附件，返回统一句柄 `{fileId, provider, kind}`。 */
export async function upload({ provider, key, file }) {
    if (!provider) throw aiError("INVALID_ARG", "未知的 AI 服务商");
    if (!file || typeof file.arrayBuffer !== "function") {
        throw aiError("INVALID_ARG", "附件格式无法识别");
    }
    if (provider.kind === "anthropic") {
        const form = new FormData();
        form.append("file", file, file.name || "attachment");
        const body = await requestJson(`${provider.baseUrl}/anthropic/v1/files`, {
            method: "POST",
            headers: {
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "files-api-2025-04-14",
            },
            body: form,
        });
        const fileId = body && (body.id || body.file_id);
        if (!fileId) throw aiError("UPSTREAM", "附件上传失败");
        return { fileId, provider: provider.id, kind: "server" };
    }

    const fileId = `local-file-${++sequence}`;
    if ((file.type || "").startsWith("image/")) {
        if (file.size > IMAGE_LIMIT) throw aiError("UNSUPPORTED", "该服务的图片附件需在 10MB 以内");
        const data = await fileToBase64(file);
        ephemeral.set(fileId, { kind: "image", mediaType: file.type, data });
        return { fileId, provider: provider.id, kind: "image" };
    }
    if (isTextLike(file)) {
        if (file.size > TEXT_LIMIT) throw aiError("UNSUPPORTED", "该服务的文本附件需在 2MB 以内");
        ephemeral.set(fileId, { kind: "document", text: await file.text() });
        return { fileId, provider: provider.id, kind: "document" };
    }
    throw aiError("UNSUPPORTED", "该服务暂不支持这种文件类型");
}

/**
 * 把请求消息里的 `{type:"file", file_id}` 换成本服务商能理解的内容块。
 * DeepSeek 原样透传；其他服务按内存表展开。
 */
export function resolveFileBlocks(messages, provider) {
    if (!Array.isArray(messages)) return [];
    if (provider.kind === "anthropic") return messages;
    return messages.map((message) => {
        if (!message || typeof message.content === "string" || !Array.isArray(message.content)) {
            return message;
        }
        const content = message.content.map((block) => {
            if (!block || typeof block !== "object" || block.type !== "image" && block.type !== "document") {
                return block;
            }
            const source = block.source;
            if (!source || source.type !== "file") return block;
            const stored = ephemeral.get(source.file_id);
            if (!stored) {
                throw aiError("UNSUPPORTED", "附件已失效，请重新发送");
            }
            if (stored.kind === "image") {
                return { type: "image", source: { type: "base64", media_type: stored.mediaType, data: stored.data } };
            }
            return { type: "document", source: { type: "text", text: stored.text } };
        });
        return { ...message, content };
    });
}
