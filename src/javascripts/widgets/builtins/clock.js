/**
 * widgets/builtins/clock.js —— 时钟小组件（F-18，真实数据）
 *
 * small：数字时钟（时:分 + 日期行）；medium/large：模拟表盘（CSS 指针）+ 数字时间。
 * 每实例 1 秒节拍，销毁时清理，避免后台实例漏跳。
 */

const DEFAULT_LOCALE = "zh-CN";

function htmlLang() {
    return document.documentElement.lang || DEFAULT_LOCALE;
}

function timeParts() {
    const now = new Date();
    return {
        now,
        hhmm: now.toLocaleTimeString(htmlLang(), { hour: "2-digit", minute: "2-digit" }),
        date: now.toLocaleDateString(htmlLang(), { month: "short", day: "numeric", weekday: "short" }),
        h: now.getHours() % 12,
        m: now.getMinutes(),
        s: now.getSeconds(),
    };
}

/** 模拟表盘：指针用 transform rotate，跟随系统主题令牌配色 */
function buildAnalog() {
    const face = document.createElement("div");
    face.className = "wg-clock__face";
    // 刻度：12 个点
    for (let i = 0; i < 12; i += 1) {
        const tick = document.createElement("span");
        tick.className = "wg-clock__tick";
        tick.style.transform = `rotate(${i * 30}deg)`;
        if (i % 3 === 0) tick.classList.add("is-major");
        face.appendChild(tick);
    }
    const hourHand = document.createElement("span");
    hourHand.className = "wg-clock__hand wg-clock__hand--h";
    const minHand = document.createElement("span");
    minHand.className = "wg-clock__hand wg-clock__hand--m";
    const secHand = document.createElement("span");
    secHand.className = "wg-clock__hand wg-clock__hand--s";
    const hub = document.createElement("span");
    hub.className = "wg-clock__hub";
    face.append(hourHand, minHand, secHand, hub);
    return { face, hourHand, minHand, secHand };
}

export const clockWidget = [
    {
        id: "clock",
        sizes: ["small", "medium", "large"],
        render(container, size) {
            const digital = document.createElement("p");
            digital.className = "wg-clock__digital";
            const dateEl = document.createElement("p");
            dateEl.className = "wg-clock__date";

            let hands = null;
            if (size === "small") {
                container.classList.add("wg-clock--small");
                container.append(digital, dateEl);
            } else {
                container.classList.add("wg-clock--analog");
                hands = buildAnalog();
                container.append(hands.face, digital, dateEl);
            }

            const tick = () => {
                const { now, hhmm, date, h, m, s } = timeParts();
                digital.textContent = hhmm;
                dateEl.textContent = date;
                if (hands) {
                    hands.hourHand.style.transform = `rotate(${(h + m / 60) * 30}deg)`;
                    hands.minHand.style.transform = `rotate(${(m + s / 60) * 6}deg)`;
                    hands.secHand.style.transform = `rotate(${s * 6}deg)`;
                }
                container.dataset.time = String(now.getTime());
            };
            tick();
            const timer = setInterval(tick, 1000);
            return () => clearInterval(timer);
        },
    },
];
