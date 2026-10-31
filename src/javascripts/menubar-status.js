/**
 * menubar-status.js — 菜单栏状态项（手册对照 P0-5）
 *
 * 电池 / 音量 / 蓝牙三个状态项，全部真数据、无装饰图：
 *  - 电池    navigator.getBattery 直读；机器没有电池（桌面机）时该项整体不显示，
 *             不画假电池。
 *  - 音量    window.__settings 的 sound.master / sound.muted（与控制中心同一个 JSON 槽）。
 *  - 蓝牙    window.__settings 的 controlcenter.bluetooth。
 *
 * 每项一个「在菜单栏显示」开关（menubar.showBattery / showVolume / showBluetooth）：
 * 本模块自注册进设置中枢（owner 是取值范围权威，同 controlcenter.showInMenuBar 的
 * 自持定义模式，见 settings-definitions.js 顶部第 3 条）。关掉的项元素仍在 DOM，
 * 只是不占位 —— 再打开时不必重新挂载。
 *
 * 交互：点任一状态项打开控制中心面板（连通性模块的家），不做「点电池开电池面板」
 * 的半吊子路径。
 *
 * 位置：挂在菜单栏右侧容器、时钟之前（macOS 顺序：状态项 → 状态图标 → 时钟）。
 */
import { i18n } from "./i18n.js";
import { settings } from "./settings.js";

// —— 状态项 SVG（与 controlcenter 同一套 24×24 记法，颜色走 currentColor） ——
const ICONS = {
    battery: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="7.5" width="17" height="9" rx="2.5"/><path d="M21.5 10.5v3.5" stroke-linecap="round"/><rect class="ms-battery-fill" x="3.8" y="9.3" width="10" height="5.4" rx="1" fill="currentColor" stroke="none"/></svg>',
    volume: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M4 9.5v5h3.5L12 18.5v-17L7.5 9.5H4z"/><path class="ms-vol-wave" d="M15 8.5a5 5 0 0 1 0 7" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/><path class="ms-vol-wave" d="M17.8 6a9 9 0 0 1 0 12" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>',
    bluetooth: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M11 2.5 16.5 7.5 12 12l4.5 4.5L11 21.5V15l-3 3-3-3 4-4.5-4-4.5 3-3 3 3V2.5z" opacity=".9"/></svg>',
};

const items = {};
let right = null;

/**
 * 造一个状态项并挂到菜单栏右侧。
 * @param {string} key 状态项键（battery / volume / bluetooth）
 * @param {string} svg 图标标记
 * @param {string} tipKey i18n 标题键
 * @param {string} tipFallback 标题中文兜底
 * @param {(rec: object) => void} dataFn 数据刷新函数
 * @returns {object} 状态项记录
 */
function makeItem(key, svg, tipKey, tipFallback, dataFn) {
    const el = document.createElement("p");
    el.className = "menubar-status menubar-status--" + key;
    el.innerHTML = svg;
    el.title = i18n.t(tipKey, tipFallback);
    el.addEventListener("click", (e) => {
        e.stopPropagation();
        import("./controlcenter.js").then((cc) => cc.show()).catch(() => {});
    });
    right.appendChild(el);
    const rec = {
        el,
        apply() {
            const cap = key[0].toUpperCase() + key.slice(1);
            const visible = settings.get("menubar.show" + cap, true) !== false;
            el.classList.toggle("is-hidden", !visible);
            el.title = i18n.t(tipKey, tipFallback);
            dataFn(rec);
        },
    };
    items[key] = rec;
    return rec;
}

/** 电池数据源：无电池 API 时整项隐藏（不画假电池）。 */
function refreshBattery(rec) {
    if (typeof navigator?.getBattery !== "function") {
        rec.el.classList.add("no-data");
        return;
    }
    navigator.getBattery().then((bat) => {
        let pctEl = rec.el.querySelector(".ms-battery-pct");
        if (!pctEl) {
            pctEl = document.createElement("span");
            pctEl.className = "ms-battery-pct";
            pctEl.textContent = "";
            rec.el.appendChild(pctEl);
        }
        const paint = () => {
            const pct = Math.round(bat.level * 100);
            // 桌面机没有电池，Chrome 仍会返回「100% 充电中、充满时间缺失」的假状态
            // （与控制中心 initBattery 同一判定）：这种情况整项隐藏，不画假电池。
            const ct = bat.chargingTime;
            const dt = bat.dischargingTime;
            const chargingTimeMissing = ct === 0 || ct === Infinity || ct < 0 || ct == null;
            const dischargingTimeMissing = dt === null || dt === Infinity || dt < 0;
            const fullyCharged = Math.abs(bat.level - 1) < 0.001;
            const hasBattery = !(fullyCharged && bat.charging && chargingTimeMissing && dischargingTimeMissing);
            rec.el.classList.toggle("no-data", !hasBattery);
            rec.el.classList.toggle("charging", bat.charging);
            const fill = rec.el.querySelector(".ms-battery-fill");
            if (fill) fill.style.width = (13.4 * bat.level).toFixed(1) + "px";
            pctEl.textContent = pct + "%";
            rec.el.title = i18n.t("menubar.batteryTip", "电池 {pct}%{state}")
                .replace("{pct}", String(pct))
                .replace("{state}", bat.charging ? i18n.t("menubar.batteryCharging", "（充电中）") : "");
        };
        paint();
        bat.addEventListener("levelchange", paint);
        bat.addEventListener("chargingchange", paint);
        bat.addEventListener("chargingtimechange", paint);
        bat.addEventListener("dischargingtimechange", paint);
    }).catch(() => rec.el.classList.add("no-data"));
}

/** 音量数据源：与声音模块共用 sound.master / sound.muted。 */
function refreshVolume(rec) {
    const muted = settings.get("sound.muted", false) === true;
    const vol = Number(settings.get("sound.master", 0.7));
    rec.el.classList.toggle("is-muted", muted);
    rec.el.querySelectorAll(".ms-vol-wave").forEach((w) => {
        w.style.opacity = muted || vol === 0 ? "0" : "1";
    });
    rec.el.title = i18n.t("menubar.volumeTip", "音量 {v}%")
        .replace("{v}", muted ? "0" : String(Math.round(vol * 100)));
}

/** 蓝牙数据源：与控制中心面板共用 controlcenter.bluetooth。 */
function refreshBluetooth(rec) {
    const on = settings.get("controlcenter.bluetooth", false) === true;
    rec.el.classList.toggle("is-off", !on);
    rec.el.title = i18n.t("menubar.bluetooth", "蓝牙") + (on ? "" : i18n.t("menubar.bluetoothOff", "（关闭）"));
}

export function init() {
    right = document.querySelector(".finderbar .right");
    if (!right) return;
    const bRec = makeItem("battery", ICONS.battery, "menubar.battery", "电池", refreshBattery);
    const vRec = makeItem("volume", ICONS.volume, "menubar.volume", "音量", refreshVolume);
    const btRec = makeItem("bluetooth", ICONS.bluetooth, "menubar.bluetooth", "蓝牙", refreshBluetooth);
    // .right 是 row-reverse：DOM 越靠后视觉越靠左。追加到末尾 = 落在时钟左侧，
    // 与 macOS 的「状态项 → 控制中心 → 日期/时间 → Siri」顺序一致。
    [bRec.el, vRec.el, btRec.el].forEach((el) => right.appendChild(el));

    // 三项「在菜单栏显示」开关（自持定义：owner 权威，同 controlcenter.showInMenuBar 模式）
    settings.defineMany([
        { key: "menubar.showBattery", type: "boolean", default: true, label: i18n.t("menubar.showBattery", "电池"), owner: "system", pane: "controlcenter", group: "菜单栏状态项", order: 31, control: "switch", apply: () => bRec.apply() },
        { key: "menubar.showVolume", type: "boolean", default: true, label: i18n.t("menubar.showVolume", "音量"), owner: "system", pane: "controlcenter", group: "菜单栏状态项", order: 32, control: "switch", apply: () => vRec.apply() },
        { key: "menubar.showBluetooth", type: "boolean", default: true, label: i18n.t("menubar.showBluetooth", "蓝牙"), owner: "system", pane: "controlcenter", group: "菜单栏状态项", order: 33, control: "switch", apply: () => btRec.apply() },
    ]);

    // 数据刷新：音量 / 静音 / 蓝牙开关都经设置中枢写，订阅同一广播
    window.addEventListener("settings-changed", (e) => {
        const key = e && e.detail && e.detail.key;
        if (key === "sound.master" || key === "sound.muted") vRec.apply();
        else if (key === "controlcenter.bluetooth") btRec.apply();
    });

    // 声音模块是可选内核（bootstrap 在 plugins-ready 后才初始化）：它的设置定义晚于
    // 本模块求值，首帧读到的可能还是兜底值 —— 插件就绪后再刷一遍，菜单栏与面板对齐。
    window.addEventListener("plugins-ready", () => {
        vRec.apply();
        btRec.apply();
    });

    bRec.apply();
    vRec.apply();
    btRec.apply();

    // 切语言时重刷标题（详细标题由各 apply 里的数据刷新写回）
    document.addEventListener("languagechange", () => {
        bRec.apply();
        vRec.apply();
        btRec.apply();
    });
}

init();
