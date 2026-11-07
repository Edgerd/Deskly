/**
 * panes/whats-new.js — 「新功能」面板：最近一次更新的摘要 + 完整更新日志。
 *
 * 数据全部来自 docs/changelog.json（经 src/javascripts/changelog.js 清洗与分组），
 * 界面不解析 Markdown，也不留硬编码的版本号或日期 —— 日志改了这里自动跟上。
 * 摘要是可点的整块卡片：点一下收起/展开下面的完整日志（aria-expanded 同步）。
 */

import { el, t, group, note, usePaneStyle, track } from "../ui.js";
import { i18n } from "../../../src/javascripts/i18n.js";
import {
    getSystemChangelog,
    versionGroups,
    latestGroup,
    summaryOf,
    relativeTime,
    versionLabel,
} from "../../../src/javascripts/changelog.js";

export const paneId = "whats-new";

/** 面板语言包：四种语言都给全；共享词条（标题/类型/相对时间）在 changelog.js 里。 */
export const messages = {
    "zh-CN": {
        ss: {
            whatsNew: {
                latest: "最近一次更新",
                fullLog: "完整更新日志",
                loading: "正在读取…",
            },
        },
    },
    en: {
        ss: {
            whatsNew: {
                latest: "Latest Update",
                fullLog: "Full Changelog",
                loading: "Loading…",
            },
        },
    },
    "ja-JP": {
        ss: {
            whatsNew: {
                latest: "最新のアップデート",
                fullLog: "すべての更新履歴",
                loading: "読み込み中…",
            },
        },
    },
    cat: {
        ss: {
            whatsNew: {
                latest: "最近一次的更新喵",
                fullLog: "完整的更新日志喵",
                loading: "正在翻喵…",
            },
        },
    },
};

/** 面板私有样式：只影响本面板；颜色只消费 --ss-* 令牌。 */
const PANE_CSS = `
.ss-pane-whats-new .ss-wn-summary {
    display: flex; align-items: center; gap: 12px; width: 100%;
    padding: 10px 14px; font: inherit; text-align: left;
    background: transparent; border: none; border-radius: 10px;
    cursor: var(--deskly-cursor, pointer);
}
.ss-pane-whats-new .ss-wn-summary:hover { background: var(--ss-hover); }
.ss-pane-whats-new .ss-wn-summary:active { background: var(--ss-pressed); }
.ss-pane-whats-new .ss-wn-summary__main { flex: 1 1 auto; min-width: 0; }
.ss-pane-whats-new .ss-wn-summary__title {
    margin: 0 0 2px; font-size: 13px; font-weight: 500;
    font-family: "SFPro-Medium", "PingFangSC-Medium"; color: var(--ss-text);
}
.ss-pane-whats-new .ss-wn-summary__text {
    margin: 0; font-size: 12px; line-height: 1.45; color: var(--ss-text-secondary);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ss-pane-whats-new .ss-wn-summary__meta { flex: 0 0 auto; text-align: right; }
.ss-pane-whats-new .ss-wn-summary__ver {
    display: block; font-size: 12px; color: var(--ss-text-secondary);
    font-variant-numeric: tabular-nums;
}
.ss-pane-whats-new .ss-wn-summary__when {
    display: block; margin-top: 2px; font-size: 11px; color: var(--ss-text-tertiary);
}
.ss-pane-whats-new .ss-wn-version { padding: 10px 14px; }
.ss-pane-whats-new .ss-wn-version + .ss-wn-version { border-top: 1px solid var(--ss-row-divider); }
.ss-pane-whats-new .ss-wn-version__head {
    display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px;
}
.ss-pane-whats-new .ss-wn-version__ver {
    font-size: 13px; font-weight: 500; font-family: "SFPro-Medium", "PingFangSC-Medium";
    color: var(--ss-text); font-variant-numeric: tabular-nums;
}
.ss-pane-whats-new .ss-wn-version__date { font-size: 11px; color: var(--ss-text-tertiary); }
.ss-pane-whats-new .ss-wn-type { margin: 6px 0; }
.ss-pane-whats-new .ss-wn-type__label {
    display: inline-block; margin-bottom: 3px; padding: 0 7px;
    font-size: 11px; line-height: 18px; border-radius: 5px;
    color: var(--ss-on-accent); background: var(--accent, #0a82ff);
}
.ss-pane-whats-new .ss-wn-type__label--improved { background: var(--ss-text-tertiary); }
.ss-pane-whats-new .ss-wn-type__label--fixed { background: var(--ss-text-secondary); }
.ss-pane-whats-new .ss-wn-type__items {
    margin: 0; padding-left: 18px; font-size: 12.5px; line-height: 1.7;
    color: var(--ss-text-secondary);
}
`;

/** 一个版本组：版本头 + 按类型分组的条目列表。 */
function versionBlock(g) {
    const head = el("div", { class: "ss-wn-version__head" },
        el("span", { class: "ss-wn-version__ver", text: g.unreleased ? versionLabel(g.version) : `v${g.version}` }),
        el("span", { class: "ss-wn-version__date", text: `${g.date} · ${relativeTime(g.date)}` }));
    const box = el("div", { class: "ss-wn-version" }, head);
    g.types.forEach((bucket) => {
        // 静态键表：动态拼键会被 static-check 拦下（漏键高发形态）
        const typeLabel = {
            added: t("cl.type.added", "新增"),
            improved: t("cl.type.improved", "优化"),
            fixed: t("cl.type.fixed", "修复"),
        }[bucket.type] || bucket.type;
        const ul = el("ul", { class: "ss-wn-type__items" });
        bucket.items.forEach((text) => ul.append(el("li", { text })));
        box.append(el("div", { class: "ss-wn-type" },
            el("span", { class: `ss-wn-type__label ss-wn-type__label--${bucket.type}`, text: typeLabel }), ul));
    });
    return box;
}

/**
 * 构建「新功能」面板。
 * @param {object} ctx 外壳上下文
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    usePaneStyle(paneId, PANE_CSS);
    const root = el("div", { class: "ss-pane ss-pane-whats-new", dataset: { pane: paneId } });

    const loading = note("ss.whatsNew.loading", "正在读取…");
    root.append(loading);

    let alive = true;
    track(() => { alive = false; });

    getSystemChangelog().then((log) => {
        if (!alive || !root.isConnected) return;
        loading.remove();

        const groups = versionGroups(log);
        if (!log || !groups.length) {
            root.append(note("cl.loadFailed", "更新日志暂时无法读取"));
            return;
        }

        const latest = latestGroup(log);
        const summary = summaryOf(latest);

        // 摘要卡：标题「新功能」+ 一行摘要 + 右侧版本与相对时间；点一下收起/展开完整日志
        const logSection = el("div");
        const summaryBtn = el("button", {
            class: "ss-wn-summary", attrs: { type: "button", "aria-expanded": "true" },
        },
            el("div", { class: "ss-wn-summary__main" },
                el("p", { class: "ss-wn-summary__title", text: t("cl.title", "新功能") }),
                el("p", { class: "ss-wn-summary__text", text: summary })),
            el("div", { class: "ss-wn-summary__meta" },
                el("span", {
                    class: "ss-wn-summary__ver",
                    text: `${t("cl.version", "版本")} ${latest.unreleased ? versionLabel(latest.version) : latest.version}`,
                }),
                el("span", { class: "ss-wn-summary__when", text: relativeTime(latest.date) })));

        const setOpen = (open) => {
            logSection.hidden = !open;
            summaryBtn.setAttribute("aria-expanded", open ? "true" : "false");
        };
        summaryBtn.addEventListener("click", () => setOpen(logSection.hidden));

        groups.forEach((g) => logSection.append(versionBlock(g)));

        root.append(
            group([summaryBtn], { title: t("ss.whatsNew.latest", "最近一次更新") }),
            group([logSection], { title: t("ss.whatsNew.fullLog", "完整更新日志") }),
        );
    });

    return root;
}
