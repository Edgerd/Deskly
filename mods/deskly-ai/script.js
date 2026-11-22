/**
 * script.js — Deskly AI 宿主桥
 *
 * 应用本身跑在同源 iframe 里（app/index.html），不直接联网、也不保存密钥。
 * 它用 postMessage 发 request / abort，这里在 mods/deskly-ai/ 下调用 Deskly.ai，
 * 再把事件与结果原路回推。调用者归属靠本文件位于 mods/deskly-ai/ 来认定。
 */

const PLUGIN_ID = "deskly-ai";
const frame = document.querySelector(".deskly-ai-frame");

/** 进行中的流：id → { abort } */
const streams = new Map();
let released = false;

/**
 * 给 iframe 回一条消息。
 * @param {number} id 请求 id
 * @param {"event"|"done"|"result"|"error"} kind 消息类型
 * @param {unknown} [payload] 负载
 * @param {Transferable[]} [transfer] 需要转移的对象（如 TTS 的 ArrayBuffer）
 * @returns {void}
 */
function reply(id, kind, payload, transfer = []) {
    if (released) return;
    const target = frame && frame.contentWindow;
    if (!target) return;
    const message = { __desklyAI: "reply", id, kind, payload };
    if (transfer.length) target.postMessage(message, "*", transfer);
    else target.postMessage(message, "*");
}

/**
 * 回错误，保留统一接口的 code（NO_KEY / UNSUPPORTED / AUTH 等）。
 * @param {number} id 请求 id
 * @param {any} error 错误对象
 * @returns {void}
 */
function replyError(id, error) {
    if (released) return;
    const target = frame && frame.contentWindow;
    if (!target) return;
    target.postMessage({
        __desklyAI: "reply",
        id,
        kind: "error",
        code: error && error.code,
        message: error && error.message ? error.message : String(error),
    }, "*");
}

/**
 * 拆开 Deskly 的信封：{ok:true,value} 取 value，否则抛带 code 的错误。
 * @param {any} result guard() 返回的信封
 * @returns {any} 真实结果
 */
function unwrap(result) {
    if (result && result.ok) return result.value;
    const error = new Error(result && result.reason ? result.reason : "AI 调用失败");
    error.code = result && result.code;
    throw error;
}

/** 一次性调用。 */
async function invoke(method, payload, id) {
    switch (method) {
        case "status":
            return reply(id, "result", Deskly.ai.status());
        case "validate":
            return reply(id, "result", unwrap(await Deskly.ai.validate()));
        case "upload":
            return reply(id, "result", unwrap(await Deskly.ai.upload(payload.file)));
        case "asr":
            return reply(id, "result", unwrap(await Deskly.ai.speech.transcribe(payload.audio)));
        case "tts": {
            const buffer = unwrap(await Deskly.ai.speech.synthesize(payload.text, payload.voice));
            return reply(id, "result", buffer, [buffer]);
        }
        default: {
            const error = new Error(`未知的 AI 调用：${method}`);
            error.code = "INVALID_ARG";
            throw error;
        }
    }
}

/** 建立一条流；销毁时把 abort 句柄移除。 */
async function startStream(body, id) {
    const request = await Deskly.ai.stream(body || {}, {
        onEvent: (event) => reply(id, "event", event),
        onDone: () => {
            streams.delete(id);
            reply(id, "done");
        },
        onError: (error) => {
            streams.delete(id);
            replyError(id, error);
        },
    });
    if (!request || !request.ok) {
        unwrap(request); // 抛错交给外层统一回推
        return;
    }
    streams.set(id, request.value);
}

const onMessage = (event) => {
    if (released) return;
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.__desklyAI !== "request") return;

    if (data.method === "stream") {
        startStream(data.payload && data.payload.body, data.id).catch((error) => replyError(data.id, error));
        return;
    }
    invoke(data.method, data.payload || {}, data.id).catch((error) => replyError(data.id, error));
};

/** 中止某条流（iframe 侧按 AbortController 发来）。 */
const onAbortMessage = (event) => {
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || data.__desklyAI !== "abort") return;
    const handle = streams.get(data.id);
    if (handle) {
        handle.abort();
        streams.delete(data.id);
    }
};

// abort 与 request 共用同一个 message 事件：这里先收 abort，再统一走 onMessage。
const onWindowMessage = (event) => {
    if (released) return;
    const data = event.data;
    if (data && typeof data === "object" && data.__desklyAI === "abort") onAbortMessage(event);
    else onMessage(event);
};

window.addEventListener("message", onWindowMessage);

/**
 * 把系统亚克力参数同步到 iframe。
 *
 * iframe 内部的 backdrop-filter 采不到窗口外的壁纸，但面板本身的透明度与
 * 「跟随系统模糊强度」仍要靠同一组令牌：宿主读系统变量，写进 iframe 的 html，
 * 侧栏 CSS 再消费 --deskly-blur / --deskly-saturate。
 * @returns {void}
 */
function syncSurface() {
    if (!frame) return;
    const doc = frame.contentDocument;
    if (!doc) return;
    const computed = getComputedStyle(document.documentElement);
    const blur = computed.getPropertyValue("--surface-blur-4").trim() || "20px";
    const saturate = computed.getPropertyValue("--surface-saturate").trim() || "180%";
    doc.documentElement.style.setProperty("--deskly-blur", blur);
    doc.documentElement.style.setProperty("--deskly-saturate", saturate);
}

// 设置中枢在文档上广播；模糊强度或主题变化后重新同步一次
document.addEventListener("settings-changed", syncSurface);

if (frame) {
    frame.addEventListener("load", () => {
        frame.classList.add("loaded");
        syncSurface();
    });
}

/** 关窗：中止全部流、摘掉监听、卸载 iframe 文档。 */
function releaseResources() {
    if (released) return;
    released = true;
    window.removeEventListener("message", onWindowMessage);
    document.removeEventListener("settings-changed", syncSurface);
    streams.forEach((handle) => {
        try { handle.abort(); } catch { /* 已结束 */ }
    });
    streams.clear();
    if (!frame) return;
    try { frame.src = "about:blank"; } catch { /* 沙箱限制：下方移除仍生效 */ }
    if (frame.isConnected) frame.remove();
}

const onUnload = (event) => {
    if (event.detail && event.detail.id !== PLUGIN_ID) return;
    window.removeEventListener("plugin-unload", onUnload);
    releaseResources();
};
window.addEventListener("plugin-unload", onUnload);
