/**
 * transport.js — 统一 AI 请求的网络层
 *
 * 所有请求都由扩展页 fetch 发出：预设域名已写进 manifest 的 host_permissions，
 * 自定义域名由设置面板在用户点击时申请 host 权限。
 */

/** 带 code 的错误：os-api 的信封会把它原样翻成 code。 */
export function aiError(code, message) {
    const err = new Error(message || code);
    err.code = code;
    return err;
}

/** HTTP 状态 -> 错误码。 */
function statusCode(status) {
    if (status === 401 || status === 403) return "AUTH";
    if (status === 429) return "RATE_LIMIT";
    if (status === 400 || status === 422) return "INVALID_ARG";
    return "UPSTREAM";
}

/** 从响应体里尽量摘出服务商给的说明。 */
function pickMessage(raw) {
    if (!raw) return "";
    try {
        const body = JSON.parse(raw);
        return String(
            (body && body.error && (body.error.message || body.error.code)) ||
            (body && (body.message || body.msg)) ||
            ""
        ).slice(0, 200);
    } catch {
        return String(raw).slice(0, 200);
    }
}

/** fetch 抛错时区分取消与网络/权限问题。 */
export function normalizeFetchError(err, signal) {
    if (err && err.code) return err;
    if ((err && err.name === "AbortError") || (signal && signal.aborted)) {
        return aiError("ABORTED", "请求已取消");
    }
    return aiError("NETWORK", "无法连接到 AI 服务，请检查网络与服务地址");
}

/**
 * 发一次请求并返回 Response；非 2xx 统一抛错。
 * @param {string} url
 * @param {object} opts fetch 选项
 */
export async function request(url, opts = {}) {
    let response;
    try {
        response = await fetch(url, opts);
    } catch (err) {
        throw normalizeFetchError(err, opts.signal);
    }
    if (!response.ok) {
        const raw = await response.text().catch(() => "");
        const detail = pickMessage(raw);
        throw aiError(statusCode(response.status), detail || `AI 服务返回 ${response.status}`);
    }
    return response;
}

/** 发一次 JSON 请求并解析响应。 */
export async function requestJson(url, opts = {}) {
    const response = await request(url, opts);
    const raw = await response.text();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        throw aiError("UPSTREAM", "AI 服务返回了无法解析的内容");
    }
}

/**
 * 读取 SSE 流，逐个解析 `data:` 行交给 onEvent。
 * 兼容 `[DONE]` 结束标记与 CRLF。
 * @param {string} url
 * @param {{headers?:object, body?:string, signal?:AbortSignal, onEvent:(event:object)=>void}} opts
 */
export async function streamSse(url, opts) {
    const response = await request(url, {
        method: "POST",
        headers: opts.headers,
        body: opts.body,
        signal: opts.signal,
    });
    if (!response.body) throw aiError("UPSTREAM", "AI 服务没有返回流式内容");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || "";
            for (const block of blocks) {
                const payload = block
                    .split(/\r?\n/)
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart())
                    .join("\n");
                if (!payload || payload === "[DONE]") continue;
                let event;
                try {
                    event = JSON.parse(payload);
                } catch {
                    continue;
                }
                opts.onEvent(event);
            }
        }
    } catch (err) {
        throw normalizeFetchError(err, opts.signal);
    }
}

/** 把文件读成 base64（不带上 data: 前缀）。 */
export async function fileToBase64(file) {
    const buffer = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < buffer.length; i += chunk) {
        binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunk));
    }
    return btoa(binary);
}

/** 从 origin 生成 host 权限匹配串。 */
export function originPattern(baseUrl) {
    try {
        const url = new URL(baseUrl);
        return `${url.protocol}//${url.host}/*`;
    } catch {
        return "";
    }
}
