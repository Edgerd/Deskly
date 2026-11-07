/**
 * script.js — my-plugin 插件逻辑（模板）
 *
 * 冷加载两条铁律（见 devdocs/guides/cold-load.html）：
 * 1. 本入口脚本每次打开都会以全新 URL 重跑 → init() 必须幂等；
 * 2. 顶层注册的全局资源必须在 plugin-unload 里按 id 认领释放。
 */

import { i18n } from "../../src/javascripts/i18n.js";

// 插件自带文案：四语齐备是规约（cat = 萌猫语言，中文加「喵」尾）
i18n.registerMessagesAll({
    "zh-CN": { myPlugin: { title: "我的插件", hint: "在这里放你的界面", run: "运行" } },
    "en":    { myPlugin: { title: "My Plugin", hint: "Put your UI here", run: "Run" } },
    "ja-JP": { myPlugin: { title: "マイプラグイン", hint: "ここに UI を配置", run: "実行" } },
    "cat":   { myPlugin: { title: "我的插件喵", hint: "在这里放你的界面喵", run: "运行喵" } },
});

const log = window.__log ? window.__log.for("plugin/my-plugin") : console;

// 顶层登记的全局监听统一记在这里，plugin-unload 时逐个释放
const disposers = [];

function init() {
    // 系统注入窗口时已写好 data-plugin-id，用它做选择器，别用裸 .window
    const root = document.querySelector('.window[data-plugin-id="my-plugin"]');
    if (!root) {
        log.warn("未找到窗口根元素，跳过初始化");
        return;
    }

    const runBtn = root.querySelector(".my-plugin-run");
    if (runBtn) {
        // 挂在窗口内部元素上的监听随窗口移除一并回收，无需手动摘
        runBtn.addEventListener("click", () => {
            log.info("运行被点击");
            if (window.__notify) window.__notify.show({ title: i18n.t("myPlugin.title", "我的插件"), message: "Hello" });
        });
    }
}
init();

// ★ 硬约束：入口脚本每次打开都重跑，顶层注册的全局资源必须在此释放
function onUnload(e) {
    if (e.detail?.id !== "my-plugin") return;
    disposers.splice(0).forEach((fn) => { try { fn(); } catch { /* 释放失败不传染 */ } });
    window.removeEventListener("plugin-unload", onUnload);
}
window.addEventListener("plugin-unload", onUnload);
