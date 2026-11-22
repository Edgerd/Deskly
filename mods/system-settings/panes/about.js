/**
 * panes/about.js — 「关于本机」子面板
 *
 * 通用 › 关于本机：版本、App 与设置项统计，以及原「新功能」面板里的更新日志。
 * 更新日志的构建复用 sections/whats-new.js，词条一起合并注册。
 */

import { VERSION } from "../../../src/javascripts/version.js";
import { settings } from "../../../src/javascripts/settings.js";
import { listEntries } from "../../../src/javascripts/store-api.js";
import { el, t, group, statusRow, usePaneStyle } from "../ui.js";
import { build as buildWhatsNew, messages as whatsNewMessages } from "../sections/whats-new.js";

export const paneId = "about";

/** 四语言词典按 ss 顶层合并，供同一面板里并入了多个模块的场景使用。 */
function mergedMessages(...dicts) {
    const out = {};
    for (const dict of dicts) {
        for (const [lang, values] of Object.entries(dict || {})) {
            out[lang] = out[lang] || { ss: {} };
            out[lang].ss = { ...out[lang].ss, ...(values.ss || {}) };
        }
    }
    return out;
}

/** 面板语言包。 */
const ownMessages = {
    "zh-CN": {
        ss: {
            pane: { about: "关于本机" },
            about: {
                system: "系统", version: "版本", platform: "运行环境",
                apps: "App", appsEnabled: "已启用",
                settingsKeys: "设置项",
                note: "Deskly 是纯前端的网页桌面，版本随仓库发布。",
                devTitle: "开发者信息", build: "构建", channel: "发布通道", channelWeb: "网页（无应用内更新）",
            },
        },
    },
    en: {
        ss: {
            pane: { about: "About This Mac" },
            about: {
                system: "System", version: "Version", platform: "Runtime",
                apps: "Apps", appsEnabled: "Enabled",
                settingsKeys: "Settings",
                note: "Deskly is a pure front-end web desktop; releases ship with the repository.",
                devTitle: "Developer", build: "Build", channel: "Release Channel", channelWeb: "Web (no in-app updates)",
            },
        },
    },
    "ja-JP": {
        ss: {
            pane: { about: "この Mac について" },
            about: {
                system: "システム", version: "バージョン", platform: "実行環境",
                apps: "App", appsEnabled: "有効",
                settingsKeys: "設定項目",
                note: "Deskly はフロントエンドのみのウェブデスクトップです。バージョンはリポジトリと共に公開されます。",
                devTitle: "開発者情報", build: "ビルド", channel: "リリース経路", channelWeb: "ウェブ（アプリ内更新なし）",
            },
        },
    },
    cat: {
        ss: {
            pane: { about: "呢部機嘅檔案喵" },
            about: {
                system: "系統喵", version: "第幾版喵", platform: "喺邊度行喵",
                apps: "App 喵", appsEnabled: "開住嘅喵",
                settingsKeys: "設定項喵",
                note: "Deskly 係純網頁桌面喵，版本跟倉庫一齊發布喵。",
                devTitle: "開發者嘅嘢喵", build: "點樣砌出嚟喵", channel: "發布通道喵", channelWeb: "網頁（冇應用內更新）喵",
            },
        },
    },
};

export const messages = mergedMessages(ownMessages, whatsNewMessages);

const PANE_CSS = `
.ss-pane-about .ss-about__version { font-variant-numeric: tabular-nums; }
.ss-pane-about .ss-pane-whats-new { margin-top: 18px; }
`;

/**
 * 构建「关于本机」面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    usePaneStyle(paneId, PANE_CSS);
    const root = el("div", { class: "ss-pane ss-pane-about", dataset: { pane: paneId } });

    const entries = typeof listEntries === "function" ? listEntries() : [];
    const enabled = entries.filter((entry) => entry && entry.enabled !== false).length;

    root.append(
        group([
            statusRow({ label: t("ss.about.version", "版本"), value: `v${VERSION}` }),
            statusRow({ label: t("ss.about.platform", "运行环境"), value: "Web / ES Modules" }),
            statusRow({ label: t("ss.about.apps", "App"), value: `${entries.length}` }),
            statusRow({ label: t("ss.about.appsEnabled", "已启用"), value: `${enabled}` }),
            statusRow({ label: t("ss.about.settingsKeys", "设置项"), value: `${Object.keys(settings.snapshot() || {}).length}` }),
        ], { title: t("ss.about.system", "系统") }),
    );

    // 更新日志：原「新功能」面板整块搬进来。
    root.append(buildWhatsNew());

    return root;
}
