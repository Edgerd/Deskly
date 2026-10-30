/**
 * script.js — 关于本机插件逻辑
 *
 * 职责：
 * 1. 插件 HTML 由 loader 在 i18n 首屏扫描之后注入，故按 i18n.js 同一套 data-i18n 约定补一次翻译；
 * 2. 「更多信息…」展示产品名称 / 版本 / 作者，数据源为 src/javascripts/version.js（单一来源）；
 * 3. 系统版本行同样取自 version.js，避免手写文案随版本漂移。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { VERSION, APP_NAME, APP_AUTHOR } from '../../src/javascripts/version.js';

const root = document.querySelector(".about_this_mac.window");

if (root) {
    init();
} else {
    console.warn("[about] 未找到窗口根元素，跳过初始化");
}

/** 应用静态文案与系统版本行 */
function init() {
    // 语言切换时核心会全量扫描 data-i18n，这里只需在打开时补一次
    root.querySelectorAll("[data-i18n]").forEach((el) => {
        const fallback = el.getAttribute("data-i18n-fallback") || el.textContent;
        el.textContent = i18n.t(el.getAttribute("data-i18n"), fallback);
    });

    const osVersion = root.querySelector(".os-version");
    if (osVersion) osVersion.textContent = `${APP_NAME} ${VERSION}`;

    // 监听挂在窗口内部元素上，随窗口移除一并回收，无需 plugin-unload 摘除
    const moreInfoBtn = root.querySelector(".button");
    if (moreInfoBtn) moreInfoBtn.addEventListener("click", showMoreInfo);
}

/** 更多信息弹窗：产品名称 / 版本 / 作者 / 数据存储位置 */
function showMoreInfo() {
    const dialog = window.__dialog;
    if (!dialog) {
        console.warn("[about] 系统弹窗接口不可用，无法显示更多信息");
        return;
    }
    const rows = [
        [i18n.t("about.field.name", "产品名称"), APP_NAME],
        [i18n.t("about.field.version", "软件版本"), VERSION],
        [i18n.t("about.field.author", "作者"), APP_AUTHOR],
        [i18n.t("about.field.storage", "数据存储"), i18n.t("about.field.storageValue", "浏览器本地存储（localStorage / IndexedDB）")],
    ];
    // 正文按纯文本交给弹窗处理（内部会转义并把换行转成 <br>）
    dialog.alert(i18n.t("about.moreInfoTitle", "更多信息"), rows.map(([k, v]) => `${k}：${v}`).join("\n"));
}
