/**
 * widgets/builtins/weather.js —— 天气小组件（F-18，本地占位）
 *
 * 原版 weather 小组件需要外部天气数据源（定位 + 网络服务）。Deskly 是纯本地 MV3
 * 扩展，G9 禁止假数据：这里只保留版式与明确的降级说明，不编造城市/温度/图标。
 * 待真实数据源接入后替换 render 内的占位内容。
 */

import { i18n } from "../../i18n.js";

export const weatherWidget = [
    {
        id: "weather",
        sizes: ["medium", "large"],
        render(container) {
            container.classList.add("wg-weather");

            const head = document.createElement("p");
            head.className = "wg-weather__title";
            head.textContent = i18n.t("widgets.weather", "天气");

            const body = document.createElement("p");
            body.className = "wg-weather__empty";
            body.textContent = i18n.t("widgets.weatherEmpty", "暂无天气数据");

            const note = document.createElement("p");
            note.className = "wg-weather__note";
            note.textContent = i18n.t("widgets.weatherNote", "实时天气需要联网数据源，当前仅保留版式");

            container.append(head, body, note);
            const off = i18n.onChange(() => {
                head.textContent = i18n.t("widgets.weather", "天气");
                body.textContent = i18n.t("widgets.weatherEmpty", "暂无天气数据");
                note.textContent = i18n.t("widgets.weatherNote", "实时天气需要联网数据源，当前仅保留版式");
            });
            return () => { if (typeof off === "function") off(); };
        },
    },
];
