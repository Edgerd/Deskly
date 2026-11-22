/**
 * panes/siri.js — 「Apple 智能与 Siri」面板：统一 AI 服务 + 高级参数
 *
 * 三块内容：
 * 1. AI 服务 —— 服务商、API 密钥、连接测试、自定义地址与模型。密钥只经设置中枢落盘，
 *    界面只回显掩码，不回读明文。
 * 2. 高级 —— 温度、思考强度、最多输出，全部是 ai.* 设置键。
 */

import { settings } from "../../../src/javascripts/settings.js";
import { log } from "../../../src/javascripts/log.js";
import { list as listProviders, byId } from "../../../src/javascripts/ai/providers.js";
import { keyOf, maskKey } from "../../../src/javascripts/ai/credentials.js";
import { originPattern } from "../../../src/javascripts/ai/transport.js";
import * as AI from "../../../src/javascripts/ai/index.js";
import {
    el, t, row, group, note, track,
    controlSlider, controlDropdown, controlText, usePaneStyle,
} from "../ui.js";

export const paneId = "siri";

/** 面板语言包。插件自注册行的标题与提示来自内核定义本身，不在这里覆盖。 */
export const messages = {
    "zh-CN": {
        ss: {
            pane: { siri: "Apple 智能与 Siri" },
            siri: {
                ai: {
                    title: "AI 服务",
                    advanced: "高级",
                    provider: "服务商",
                    key: "API 密钥",
                    keyPlaceholder: "粘贴密钥",
                    keyEmpty: "未设置",
                    keyNotRequired: "无需密钥",
                    keySaved: "已保存",
                    save: "保存",
                    clear: "清除",
                    test: "测试连接",
                    testing: "测试中…",
                    testOk: "连接正常",
                    testFail: "连接失败",
                    baseUrl: "服务地址",
                    baseUrlApply: "应用",
                    model: "模型",
                    modelPlaceholder: "留空则用默认模型",
                    temperature: "温度",
                    thinking: "思考强度",
                    maxTokens: "最多输出",
                },
            },
        },
    },
    "en": {
        ss: {
            pane: { siri: "Apple Intelligence & Siri" },
            siri: {
                ai: {
                    title: "AI Service",
                    advanced: "Advanced",
                    provider: "Provider",
                    key: "API key",
                    keyPlaceholder: "Paste key",
                    keyEmpty: "Not set",
                    keyNotRequired: "No key needed",
                    keySaved: "Saved",
                    save: "Save",
                    clear: "Clear",
                    test: "Test connection",
                    testing: "Testing…",
                    testOk: "Connected",
                    testFail: "Connection failed",
                    baseUrl: "Endpoint",
                    baseUrlApply: "Apply",
                    model: "Model",
                    modelPlaceholder: "Empty uses the default",
                    temperature: "Temperature",
                    thinking: "Thinking effort",
                    maxTokens: "Max output",
                },
            },
        },
    },
    "ja-JP": {
        ss: {
            pane: { siri: "Apple Intelligence と Siri" },
            siri: {
                ai: {
                    title: "AI サービス",
                    advanced: "詳細",
                    provider: "プロバイダ",
                    key: "API キー",
                    keyPlaceholder: "キーを貼り付け",
                    keyEmpty: "未設定",
                    keyNotRequired: "キー不要",
                    keySaved: "保存済み",
                    save: "保存",
                    clear: "消去",
                    test: "接続をテスト",
                    testing: "テスト中…",
                    testOk: "接続しました",
                    testFail: "接続に失敗",
                    baseUrl: "接続先",
                    baseUrlApply: "適用",
                    model: "モデル",
                    modelPlaceholder: "空欄なら既定のモデル",
                    temperature: "温度",
                    thinking: "思考の強さ",
                    maxTokens: "最大出力",
                },
            },
        },
    },
    cat: {
        ss: {
            pane: { siri: "Apple 智能同 Siri 喵" },
            siri: {
                ai: {
                    title: "AI 服務喵",
                    advanced: "進階喵",
                    provider: "服務商喵",
                    key: "API 密鑰喵",
                    keyPlaceholder: "貼上密鑰喵",
                    keyEmpty: "還沒設定喵",
                    keyNotRequired: "不用密鑰喵",
                    keySaved: "收好啦喵",
                    save: "收好",
                    clear: "擦掉",
                    test: "試一下連線喵",
                    testing: "正在試喵…",
                    testOk: "連上啦喵",
                    testFail: "連不上喵",
                    baseUrl: "服務地址喵",
                    baseUrlApply: "套用",
                    model: "模型喵",
                    modelPlaceholder: "留空就用預設模型喵",
                    temperature: "溫度喵",
                    thinking: "思考力度喵",
                    maxTokens: "最多吐出多少喵",
                },
            },
        },
    },
};

/** 面板私有样式：密钥输入行与连通性提示。 */
const PANE_CSS = `
.ss-pane-siri .ss-ai-key {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
}
.ss-pane-siri .ss-ai-key .ss-input { flex: 1 1 auto; min-width: 0; }
.ss-pane-siri .ss-ai-key .ss-btn { flex: 0 0 auto; }
.ss-pane-siri .ss-ai-test {
    margin: 6px 0 0;
    padding: 0 12px 10px;
    font-size: 12px;
    color: var(--text-secondary);
    min-height: 16px;
}
.ss-pane-siri .ss-ai-inline {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
}
.ss-pane-siri .ss-ai-inline .ss-input { flex: 1 1 auto; min-width: 0; }
`;

/**
 * 取当前生效的服务商 id（未知值回退 DeepSeek）。
 * @returns {string} 服务商 id
 */
function currentProviderId() {
    const id = String(settings.get("ai.provider") || "deepseek");
    return byId(id) ? id : "deepseek";
}

/**
 * 自定义服务地址需要对应域名的联网许可；预设域名已写进清单，无需再问。
 * 用户点击「应用」时申请，避免安装后凭空多一条权限。
 * @param {string} url 服务地址
 * @returns {Promise<boolean>} 是否拿到许可（非扩展环境视为通过）
 */
async function requestOrigin(url) {
    const pattern = originPattern(url);
    if (!pattern) return true;
    if (typeof chrome === "undefined" || !chrome.permissions) return true;
    try {
        if (await chrome.permissions.contains({ origins: [pattern] })) return true;
        return await chrome.permissions.request({ origins: [pattern] });
    } catch (err) {
        log.warn("plugin/system-settings", `申请 ${pattern} 联网许可失败`, err);
        return true;
    }
}

/**
 * 构建「Apple 智能与 Siri」面板。
 * @param {object} ctx 外壳上下文
 * @returns {HTMLElement} 面板根元素
 */
export function build(ctx) {
    usePaneStyle(paneId, PANE_CSS);
    const root = el("div", { class: "ss-pane ss-pane-siri", dataset: { pane: paneId } });

    // ── AI 服务 ───────────────────────────────────────────────────────
    const providerRow = controlDropdown("ai.provider", {
        label: t("ss.siri.ai.provider", "服务商"),
        options: listProviders().map((provider) => ({ value: provider.id, label: provider.name })),
    });

    const keyInput = el("input", {
        class: "ss-input",
        attrs: {
            type: "password", autocomplete: "off", spellcheck: "false",
            "aria-label": t("ss.siri.ai.key", "API 密钥"),
        },
    });
    const saveBtn = el("button", { class: "ss-btn", attrs: { type: "button" }, text: t("ss.siri.ai.save", "保存") });
    const clearBtn = el("button", { class: "ss-btn", attrs: { type: "button" }, text: t("ss.siri.ai.clear", "清除") });
    const keyRow = row({
        label: t("ss.siri.ai.key", "API 密钥"),
        control: el("div", { class: "ss-ai-key" }, keyInput, saveBtn, clearBtn),
        stack: true,
    });
    const keyHint = el("p", { class: "ss-row__hint" });
    keyRow.querySelector(".ss-row__main").append(keyHint);

    const testBtn = el("button", { class: "ss-btn", attrs: { type: "button" }, text: t("ss.siri.ai.test", "测试连接") });
    const testNote = el("p", { class: "ss-ai-test" });

    const baseRow = controlText({
        label: t("ss.siri.ai.baseUrl", "服务地址"),
        placeholder: "https://…",
        buttonText: t("ss.siri.ai.baseUrlApply", "应用"),
        defaultValue: String(settings.get("ai.baseUrl") || ""),
        onSubmit: async (value) => {
            if (value && !(await requestOrigin(value))) return;
            settings.set("ai.baseUrl", value, { source: "system-settings" });
        },
    });
    const modelRow = controlText({
        label: t("ss.siri.ai.model", "模型"),
        placeholder: t("ss.siri.ai.modelPlaceholder", "留空则用默认模型"),
        buttonText: t("ss.siri.ai.baseUrlApply", "应用"),
        defaultValue: String(settings.get("ai.model") || ""),
        onSubmit: (value) => { settings.set("ai.model", value, { source: "system-settings" }); },
    });

    /** 重画密钥状态：只显示掩码，不把明文写回输入框。 */
    const paintKey = () => {
        const provider = byId(currentProviderId());
        const saved = keyOf(provider.id);
        keyHint.textContent = !provider.keyRequired
            ? t("ss.siri.ai.keyNotRequired", "无需密钥")
            : saved
                ? `${t("ss.siri.ai.keySaved", "已保存")} ${maskKey(saved)}`
                : t("ss.siri.ai.keyEmpty", "未设置");
        keyInput.placeholder = saved ? maskKey(saved) : t("ss.siri.ai.keyPlaceholder", "粘贴密钥");
        clearBtn.disabled = !saved;
    };

    /** 服务商切换后：同步默认模型提示与自定义地址的显隐。 */
    const paintProvider = () => {
        const provider = byId(currentProviderId());
        modelRow.input.placeholder = provider.model
            ? `${t("ss.siri.ai.modelPlaceholder", "留空则用默认模型")}（${provider.model}）`
            : t("ss.siri.ai.modelPlaceholder", "留空则用默认模型");
        baseRow.hidden = provider.id !== "custom";
        keyRow.hidden = !provider.keyRequired;
        paintKey();
    };

    saveBtn.addEventListener("click", () => {
        const value = keyInput.value.trim();
        if (!value) return;
        AI.saveKey(currentProviderId(), value);
        keyInput.value = "";
        paintKey();
        testNote.textContent = t("ss.siri.ai.keySaved", "已保存");
    });
    clearBtn.addEventListener("click", () => {
        AI.clearKey(currentProviderId());
        keyInput.value = "";
        paintKey();
        testNote.textContent = "";
    });

    testBtn.addEventListener("click", async () => {
        if (testBtn.disabled) return;
        const original = testBtn.textContent;
        testBtn.disabled = true;
        testBtn.textContent = t("ss.siri.ai.testing", "测试中…");
        testNote.textContent = "";
        try {
            const result = await AI.validate(currentProviderId());
            const count = result.models.length ? ` · ${result.models.length}` : "";
            testNote.textContent = `${t("ss.siri.ai.testOk", "连接正常")} · ${result.model}${count}`;
        } catch (err) {
            testNote.textContent = `${t("ss.siri.ai.testFail", "连接失败")}：${err && err.message ? err.message : String(err)}`;
        } finally {
            testBtn.disabled = false;
            testBtn.textContent = original;
        }
    });

    track(settings.subscribe((detail) => {
        if (detail.key === "ai.provider") paintProvider();
        else if (detail.key === "ai.keys") paintKey();
    }));
    paintProvider();

    root.append(
        group([
            providerRow,
            keyRow,
            row({
                label: t("ss.siri.ai.test", "测试连接"),
                control: testBtn,
            }),
            testNote,
            baseRow,
            modelRow,
        ], { title: t("ss.siri.ai.title", "AI 服务") }),
    );

    // ── 高级 ─────────────────────────────────────────────────────────
    root.append(
        group([
            controlSlider("ai.temperature", { label: t("ss.siri.ai.temperature", "温度") }),
            controlDropdown("ai.thinking", { label: t("ss.siri.ai.thinking", "思考强度") }),
            controlSlider("ai.maxTokens", { label: t("ss.siri.ai.maxTokens", "最多输出") }),
        ], { title: t("ss.siri.ai.advanced", "高级") }),
    );

    // ── Siri 分组已随旧 Siri 应用一并移除 ──────────────────────────────

    log.debug("plugin/system-settings", "Apple 智能与 Siri 面板已渲染");
    return root;
}
