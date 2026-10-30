/**
 * panes/siri.js — 「Siri」面板：光球大小 + 由插件自己注册进来的 siri.* 设置
 *
 * siri.orb.size 属于「owner 只有监听、没有 setter」那一类：定义里给了 event，
 * 设置中枢按旧格式在 window 上补发 siri-orb-size-change，Siri 那边零改动即可收到。
 * 面板里的预览用同一个值实时缩放，看到的就是真正生效的直径。
 *
 * 另外这里不写死任何 Siri 私有开关：把 settings.list({prefix:"siri."}) 拿到的定义
 * 逐条交给 ui.autoRow() 生成控件 —— 插件 define 一个键就自动获得一行界面，
 * 本面板不必跟着改代码（hidden 的定义 autoRow 返回 null，由这里滤掉）。
 */

import { settings } from "../../../src/javascripts/settings.js";
import { SIRI_BAR_ICON } from "../../../src/javascripts/paths.js";
import { log } from "../../../src/javascripts/log.js";
import {
    el, t, row, group, note, statusRow, bind, autoRow,
    controlSlider, usePaneStyle,
} from "../ui.js";

export const paneId = "siri";

/** 面板语言包。插件自注册行的标题与提示来自内核定义本身，不在这里覆盖。 */
export const messages = {
    "zh-CN": {
        ss: {
            pane: { siri: "Siri" },
            siri: {
                orb: "光球大小",
                preview: "预览",
                live: "当前直径",
                plugin: "Siri 设置",
                pluginEmpty: "Siri 目前没有额外设置。",
            },
        },
    },
    "en": {
        ss: {
            pane: { siri: "Siri" },
            siri: {
                orb: "Orb size",
                preview: "Preview",
                live: "Current diameter",
                plugin: "Siri settings",
                pluginEmpty: "No additional Siri settings.",
            },
        },
    },
    "ja-JP": {
        ss: {
            pane: { siri: "Siri" },
            siri: {
                orb: "オーブの大きさ",
                preview: "プレビュー",
                live: "現在の直径",
                plugin: "Siri の設定",
                pluginEmpty: "Siri の追加設定はありません。",
            },
        },
    },
    cat: {
        ss: {
            pane: { siri: "Siri 喵" },
            siri: {
                orb: "光球多大喵",
                preview: "看看喵",
                live: "現在的直徑喵",
                plugin: "Siri 自己的設定喵",
                pluginEmpty: "Siri 目前還沒登記別的設定喵。",
            },
        },
    },
};

/** 面板私有样式：发光舞台与光球。 */
const PANE_CSS = `
.ss-pane-siri .ss-siri__stage {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 168px;
    border-radius: 9px;
    border: 1px solid var(--ss-row-divider);
    background: radial-gradient(circle at 50% 50%, rgba(var(--accent-rgb), 0.14), transparent 70%), var(--ss-row-bg);
    overflow: hidden;
}
.ss-pane-siri .ss-siri__orb {
    width: 150px;
    height: 150px;
    border-radius: 50%;
    background: url("${SIRI_BAR_ICON}") center / contain no-repeat;
    filter: drop-shadow(0 0 14px rgba(var(--accent-rgb), 0.55));
    transition: width 0.12s ease, height 0.12s ease;
}
html[data-reduce-motion="on"] .ss-pane-siri .ss-siri__orb { transition: none; }
`;

/**
 * 构建「Siri」面板。
 * @param {object} ctx 外壳上下文
 * @returns {HTMLElement} 面板根元素
 */
export function build(ctx) {
    usePaneStyle(paneId, PANE_CSS);
    const root = el("div", { class: "ss-pane ss-pane-siri", dataset: { pane: paneId } });

    const definition = settings.info("siri.orb.size") || {};
    const min = typeof definition.min === "number" ? definition.min : 80;
    const max = typeof definition.max === "number" ? definition.max : 300;

    const orb = el("div", { class: "ss-siri__orb" });
    const liveRow = statusRow({ label: t("ss.siri.live", "当前直径"), value: "—" });

    /**
     * 按当前直径画预览光球。只改宽高、不用 transform：与站内「不制造额外合成层」的
     * 写法保持一致，也省得将来这块被放进带 backdrop-filter 的容器时踩同一颗雷。
     * @param {number|string} value 设置里的直径
     */
    const paintOrb = (value) => {
        const size = Number(value);
        const clamped = Number.isFinite(size) ? Math.min(max, Math.max(min, size)) : min;
        orb.style.width = `${clamped}px`;
        orb.style.height = `${clamped}px`;
        liveRow.setValue(`${clamped} px`);
    };
    // 直径有两条通知路径：bind 的 store 订阅（覆盖任何来源的写入）与光球本身的绘制
    bind("siri.orb.size", paintOrb);

    // 插件自己注册的 siri.* 定义即界面：这里一个键名都不复制
    const pluginRows = settings.list({ prefix: "siri." })
        .filter((item) => item.key !== "siri.orb.size")
        .map((item) => autoRow(item))
        .filter((node) => node !== null);

    root.append(
        group([
            controlSlider("siri.orb.size", {
                label: t("ss.siri.orb", "光球大小"),
                units: "px",
            }),
            liveRow,
            row({
                label: t("ss.siri.preview", "预览"),
                control: el("div", { class: "ss-siri__stage" }, orb),
                stack: true,
            }),
        ]),
    );

    const pluginTitle = t("ss.siri.plugin", "Siri 设置");
    if (pluginRows.length) {
        root.append(group(pluginRows, { title: pluginTitle }));
    } else {
        root.append(group([note("ss.siri.pluginEmpty", "Siri 目前没有额外设置。")], { title: pluginTitle }));
    }

    log.debug("plugin/system-settings", `Siri 面板已渲染，App 自定义项 ${pluginRows.length} 条`);
    return root;
}
