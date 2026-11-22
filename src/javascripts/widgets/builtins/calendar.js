/**
 * widgets/builtins/calendar.js —— 日历小组件（F-18，真实数据）
 *
 * small 尺寸给大号日期牌；medium/large 给整月网格。月历工厂复用 datetime_popover.js
 * 的 createCalendarPanel()（F-17 要求保留并复用现有月历代码），但走动态 import：
 * 静态引用会把 registry→calendar→datetime_popover→控制中心→菜单栏 整条重链拖进
 * 小组件模块并在加载环上互相卡位 —— 动态加载让 registry 只依赖叶子模块。
 * 实例清理契约：render() 返回清理函数（退订定时/监听），host 销毁实例时调用。
 */

import { i18n } from "../../i18n.js";

function htmlLang() {
    return document.documentElement.lang || "zh-CN";
}

/** small：日期牌（macOS 通知中心/桌面小组件的小尺寸日历样式） */
function renderSmall(container) {
    container.classList.add("wg-cal-small");
    const now = new Date();
    const dateEl = document.createElement("p");
    dateEl.className = "wg-cal-small__date";
    dateEl.textContent = String(now.getDate());
    const weekEl = document.createElement("p");
    weekEl.className = "wg-cal-small__week";
    weekEl.textContent = now.toLocaleDateString(htmlLang(), { weekday: "long" });
    const monthEl = document.createElement("p");
    monthEl.className = "wg-cal-small__month";
    monthEl.textContent = now.toLocaleDateString(htmlLang(), { year: "numeric", month: "long" });
    container.append(dateEl, weekEl, monthEl);
    const onChange = () => {
        weekEl.textContent = now.toLocaleDateString(htmlLang(), { weekday: "long" });
        monthEl.textContent = now.toLocaleDateString(htmlLang(), { year: "numeric", month: "long" });
    };
    const off = i18n.onChange(onChange);
    return () => { if (typeof off === "function") off(); };
}

export const calendarWidget = [
    {
        id: "calendar",
        sizes: ["small", "medium", "large"],
        render(container, size) {
            if (size === "small") return renderSmall(container);
            // medium / large：整月网格（自带翻月与语言重建）。面板异步挂入，挂入前容器先占位。
            let panel = null;
            let disposed = false;
            import("../../datetime_popover.js")
                .then((m) => {
                    if (disposed) return;
                    panel = m.createCalendarPanel();
                    container.appendChild(panel.el);
                })
                .catch((err) => {
                    console.warn("[widgets] 日历小组件加载失败:", err);
                });
            return () => {
                disposed = true;
                if (panel) panel.destroy();
            };
        },
    },
];
