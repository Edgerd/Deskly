/**
 * speech.js — DeepSeek 语音能力（ASR/TTS）
 *
 * 语音是 DeepSeek 专有工具接口，其他预设没有等价端点；
 * Deskly.ai 在调用前会先挡掉非 DeepSeek 服务商。
 */

import { aiError, request, requestJson } from "./transport.js";

/** 语音合成：返回裸 PCM 字节流。 */
export async function synthesize({ baseUrl, key, text, voice, signal }) {
    if (!String(text || "").trim()) throw aiError("INVALID_ARG", "没有可朗读的内容");
    const response = await request(`${baseUrl}/v1/tools/tts`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            text,
            voice_id: voice === "tide" ? "tide" : "stella",
            format: "pcm",
            filter_markdown: true,
        }),
        signal,
    });
    return response.arrayBuffer();
}

/** 语音识别：WAV / Ogg Opus，返回全文。 */
export async function transcribe({ baseUrl, key, audio, signal }) {
    if (!audio) throw aiError("INVALID_ARG", "没有收到录音");
    const form = new FormData();
    form.append("file", audio, "recording.wav");
    const body = await requestJson(`${baseUrl}/v1/tools/asr`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal,
    });
    if (!body || typeof body.text !== "string") {
        throw aiError("UPSTREAM", "语音识别没有返回文本");
    }
    return body.text;
}
