/**
 * panes/screen-time.js — 「屏幕使用时间」面板
 *
 * 数据归属：时长账本与停用时间引擎在 usage-tracker.js（window.__screenTime），
 * 设置项 screenTime.enabled / downtime / allowAlways 的 schema 在 settings-definitions.js。
 * 本面板只做四件事：开关记录、展示今日榜单、编辑停用时间计划（时间与星期）、
 * 勾选「始终允许」的应用；所有写操作都走 settings.set，账本只读。
 * 「忽略限制」的口令闸门复用锁定屏幕的口令（lock.js），未设口令时如实说明。
 */

import { settings } from "../../../src/javascripts/settings.js";
import {
    el, t, note, row, group, statusRow, controlSwitch, usePaneStyle, track, paneLink,
} from "../ui.js";
import { childPanes } from "../registry.js";

export const paneId = "screenTime";

/** 面板语言包。 */
export const messages = {
    "zh-CN": {
        ss: {
            pane: { screenTime: "屏幕使用时间" },
            screenTime: {
                record: "记录使用情况", recordHint: "按前台应用统计每天的使用时长。",
                today: "今日使用", total: "总计", noData: "还没有记录。数据只保存在本机。",
                status: "当前状态", statusActive: "停用时间中", statusIdle: "未处于停用时间",
                downtime: "停用时间", downtimeEnable: "启用停用时间",
                start: "开始", end: "结束", days: "重复",
                day0: "日", day1: "一", day2: "二", day3: "三", day4: "四", day5: "五", day6: "六",
                alwaysAllow: "始终允许的应用",
                allowHint: "停用期间仍可打开这些应用。",
                allowEmpty: "最近 7 天还没有应用记录，使用一段时间后再来勾选。",
                passcode: "口令闸门", passcodeSet: "已设置锁定屏幕口令", passcodeNone: "未设置口令",
                passcodeNote: "停用期间忽略限制需要输入锁定屏幕口令；未设口令时只能提醒。",
                openLockScreen: "前往「锁定屏幕」",
            },
        },
    },
    "en": {
        ss: {
            pane: { screenTime: "Screen Time" },
            screenTime: {
                record: "Record usage", recordHint: "Track daily time per frontmost app.",
                today: "Today", total: "Total", noData: "Nothing recorded yet. Data stays on this device.",
                status: "Status", statusActive: "Downtime active", statusIdle: "Not in downtime",
                downtime: "Downtime", downtimeEnable: "Enable downtime",
                start: "Start", end: "End", days: "Repeat",
                day0: "Sun", day1: "Mon", day2: "Tue", day3: "Wed", day4: "Thu", day5: "Fri", day6: "Sat",
                alwaysAllow: "Always allowed apps",
                allowHint: "These apps stay available during downtime.",
                allowEmpty: "No apps recorded in the last 7 days yet; check back later.",
                passcode: "Passcode gate", passcodeSet: "Lock-screen passcode set", passcodeNone: "No passcode",
                passcodeNote: "Ignoring downtime requires the lock-screen passcode; without one it can only remind.",
                openLockScreen: "Open Lock Screen",
            },
        },
    },
    "ja-JP": {
        ss: {
            pane: { screenTime: "スクリーンタイム" },
            screenTime: {
                record: "使用状況を記録", recordHint: "最前面アプリごとに毎日の利用時間を記録します。",
                today: "今日の使用時間", total: "合計", noData: "まだ記録がありません。データはこの端末にだけ保存されます。",
                status: "現在の状態", statusActive: "ダウンタイム中", statusIdle: "ダウンタイム外",
                downtime: "ダウンタイム", downtimeEnable: "ダウンタイムを有効化",
                start: "開始", end: "終了", days: "繰り返し",
                day0: "日", day1: "月", day2: "火", day3: "水", day4: "木", day5: "金", day6: "土",
                alwaysAllow: "常に許可するアプリ",
                allowHint: "ダウンタイム中でもこれらのアプリは使えます。",
                allowEmpty: "過去 7 日間の記録がまだありません。しばらく使ってから選んでください。",
                passcode: "パスコードゲート", passcodeSet: "ロック画面のパスコード済み", passcodeNone: "パスコード未設定",
                passcodeNote: "ダウンタイムの解除にはロック画面のパスコードが必要です。未設定の場合は注意を表示するだけです。",
                openLockScreen: "「ロック画面」を開く",
            },
        },
    },
    "cat": {
        ss: {
            pane: { screenTime: "屏幕使用时间喵" },
            screenTime: {
                record: "记录使用情况喵", recordHint: "按前台应用算每天用了多久喵。",
                today: "今天用了喵", total: "总共喵", noData: "还没记到东西喵。数据只留在这台机器里喵。",
                status: "现在的状态喵", statusActive: "停用时间中喵", statusIdle: "没在停用时间喵",
                downtime: "停用时间喵", downtimeEnable: "开停用时间喵",
                start: "开始喵", end: "结束喵", days: "重复喵",
                day0: "日", day1: "一", day2: "二", day3: "三", day4: "四", day5: "五", day6: "六",
                alwaysAllow: "一直让用的应用喵",
                allowHint: "停用的时候这些应用照样能开喵。",
                allowEmpty: "最近 7 天还没记到应用喵，用一阵子再来勾喵。",
                passcode: "口令闸门喵", passcodeSet: "已设锁定屏幕口令喵", passcodeNone: "没设口令喵",
                passcodeNote: "停用时要忽略限制得输锁定屏幕口令喵；没设口令就只能提醒一下喵。",
                openLockScreen: "去「锁定屏幕」喵",
            },
        },
    },
};

/** 面板私有样式（榜单条 / 星期排 / 允许列表）。 */
const PANE_CSS = `
.ss-pane-screenTime .st-bars { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.ss-pane-screenTime .st-bar { display: grid; grid-template-columns: minmax(80px, 130px) 1fr 64px; align-items: center; gap: 8px; }
.ss-pane-screenTime .st-bar__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ss-text); }
.ss-pane-screenTime .st-bar__track { display: block; height: 6px; border-radius: 3px; background: var(--ss-row-bg); overflow: hidden; }
.ss-pane-screenTime .st-bar__fill { display: block; height: 100%; border-radius: 3px; background: var(--accent); }
.ss-pane-screenTime .st-bar__value { text-align: right; color: var(--ss-text-secondary); font-variant-numeric: tabular-nums; }
.ss-pane-screenTime .st-days { display: flex; gap: 6px; width: 100%; }
.ss-pane-screenTime .st-day {
    flex: 1; padding: 6px 0; text-align: center; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--ss-control-border); background: var(--ss-row-bg); color: var(--ss-text-secondary);
}
.ss-pane-screenTime .st-day--on { background: var(--accent); border-color: transparent; color: #fff; }
.ss-pane-screenTime .st-allow { display: flex; flex-direction: column; gap: 2px; width: 100%; }
.ss-pane-screenTime .st-allow__row { display: flex; align-items: center; gap: 10px; padding: 5px 2px; }
.ss-pane-screenTime .st-allow__row label { flex: 1; color: var(--ss-text); }
.ss-pane-screenTime .st-time input {
    padding: 5px 8px; border-radius: 7px; border: 1px solid var(--ss-control-border);
    background: var(--ss-field-bg); color: var(--ss-text); font: inherit;
}
`;

/** 读账本 API（boot 顺序保证面板打开时已就位；缺 API 时按空账本渲染）。 */
function tracker() {
    return globalThis.__screenTime || null;
}

/** 读停用时间计划（缺 API 时按未启用渲染）。 */
function readDowntime() {
    const raw = tracker()?.getDowntime?.();
    if (raw) return raw;
    return { enabled: false, start: -1, end: -1, days: [1, 2, 3, 4, 5] };
}

/** 分钟数 -> "HH:MM"（非法值回退默认）。 */
function minutesToHHMM(minutes, fallback) {
    if (!Number.isInteger(minutes) || minutes < 0) return fallback;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** 通过设置中枢把补丁合并写回停用时间计划。 */
function writeDowntime(patch) {
    const current = readDowntime();
    return settings.set("screenTime.downtime", { ...current, ...patch }, { source: "screen-time-pane" }).ok;
}

/** 秒数 -> 人类可读时长。 */
function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.round((total % 3600) / 60);
    if (h) return `${h} 小时 ${m} 分`;
    return `${m} 分钟`;
}

/** 造一个屏幕使用时间系列页面的根节点（共用同一套私有样式作用域）。 */
function pageRoot(id) {
    usePaneStyle(paneId, PANE_CSS);
    return el("div", { class: "ss-pane ss-pane-screenTime", dataset: { pane: id } });
}

/**
 * 「使用情况」子页：记录开关与今日榜单。
 * @returns {HTMLElement} 面板根元素
 */
export function buildUsage() {
    const root = pageRoot("screen-time-usage");

    // ---- 今日使用榜单 ----
    const bars = el("div", { class: "st-bars" });
    const totalRow = statusRow({ label: t("ss.screenTime.total", "总计"), value: "—" });
    const statusRowEl = statusRow({ label: t("ss.screenTime.status", "当前状态"), value: "—" });

    const refreshUsage = () => {
        const api = tracker();
        const totals = api ? api.getDayTotals() : {};
        const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 8);
        const total = entries.reduce((sum, [, v]) => sum + v, 0);
        bars.textContent = "";
        if (!entries.length) {
            bars.append(el("div", {
                text: t("ss.screenTime.noData", "还没有记录。数据只保存在本机。"),
                style: "color: var(--ss-text-secondary); font-size: 12px;",
            }));
        }
        entries.forEach(([name, seconds]) => {
            const pct = total > 0 ? Math.max(3, Math.round((seconds / total) * 100)) : 0;
            bars.append(el("div", { class: "st-bar" },
                el("span", { class: "st-bar__name", text: name }),
                el("span", { class: "st-bar__track" },
                    el("span", { class: "st-bar__fill", style: `width:${pct}%` })),
                el("span", { class: "st-bar__value", text: formatDuration(seconds) })));
        });
        totalRow.setValue(formatDuration(total));
        statusRowEl.setValue(api?.isDowntimeNow?.()
            ? t("ss.screenTime.statusActive", "停用时间中")
            : t("ss.screenTime.statusIdle", "未处于停用时间"));
    };

    root.append(
        group([controlSwitch("screenTime.enabled", {
            label: t("ss.screenTime.record", "记录使用情况"),
            hint: t("ss.screenTime.recordHint", "按前台应用统计每天的使用时长。"),
        })], { title: t("ss.pane.screen-time-usage", "使用情况") }),

        group([row({ label: "", control: bars, stack: true }), totalRow, statusRowEl],
            { title: t("ss.screenTime.today", "今日使用") }),
    );

    refreshUsage();
    // 每 30 秒刷新榜单与状态；订阅登记进 dispose，切面板/关窗自动清
    const timer = setInterval(() => { refreshUsage(); }, 30000);
    track(() => clearInterval(timer));
    const onChange = (event) => {
        const key = String(event.detail?.key || "");
        if (key.startsWith("screenTime.")) refreshUsage();
    };
    document.addEventListener("settings-changed", onChange);
    track(() => document.removeEventListener("settings-changed", onChange));
    return root;
}

/**
 * 「停用时间」子页：计划时间、星期与口令闸门。
 * @returns {HTMLElement} 面板根元素
 */
export function buildDowntime() {
    const root = pageRoot("screen-time-downtime");

    // ---- 停用时间计划 ----
    const def = readDowntime();
    const startInput = el("input", {
        attrs: { type: "time", value: minutesToHHMM(def.start, "23:00"), "aria-label": t("ss.screenTime.start", "开始") },
    });
    const endInput = el("input", {
        attrs: { type: "time", value: minutesToHHMM(def.end, "07:00"), "aria-label": t("ss.screenTime.end", "结束") },
    });
    const onTimeChange = () => {
        const parse = (text, fallback) => {
            const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || ""));
            return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
        };
        writeDowntime({ start: parse(startInput.value, 1380), end: parse(endInput.value, 420) });
    };
    startInput.addEventListener("change", onTimeChange);
    endInput.addEventListener("change", onTimeChange);

    const dayKeys = ["day0", "day1", "day2", "day3", "day4", "day5", "day6"];
    const daysWrap = el("div", { class: "st-days", attrs: { role: "group", "aria-label": t("ss.screenTime.days", "重复") } });
    const currentDays = new Set(def.days);
    dayKeys.forEach((key, d) => {
        const chip = el("button", {
            class: `st-day${currentDays.has(d) ? " st-day--on" : ""}`,
            attrs: { type: "button" }, text: t(`ss.screenTime.${key}`, "日一二三四五六"[d]), // i18n-dynamic-ok day0-day6 键在四语 messages 里成对出现
        });
        chip.addEventListener("click", () => {
            if (currentDays.has(d)) currentDays.delete(d); else currentDays.add(d);
            chip.classList.toggle("st-day--on", currentDays.has(d));
            writeDowntime({ days: [...currentDays].sort() });
        });
        daysWrap.append(chip);
    });

    // 「启用停用时间」开关：screenTime.downtime 是 JSON 键，controlSwitch 绑不了，
    // 用原生 checkbox 行直接读写 enabled 字段。
    const enableCheckbox = el("input", { attrs: { type: "checkbox" } });
    enableCheckbox.checked = Boolean(def.enabled);
    enableCheckbox.addEventListener("change", () => {
        writeDowntime({ enabled: enableCheckbox.checked });
    });

    root.append(
        group([
            row({
                label: t("ss.screenTime.downtimeEnable", "启用停用时间"),
                control: enableCheckbox,
            }),
            row({ label: t("ss.screenTime.start", "开始"), control: startInput }),
            row({ label: t("ss.screenTime.end", "结束"), control: endInput }),
            row({ label: t("ss.screenTime.days", "重复"), control: daysWrap, stack: true }),
        ], { title: t("ss.screenTime.downtime", "停用时间") }),

        passcodeGroup(),
    );
    return root;
}

/**
 * 「始终允许」子页：停用期间仍可打开的应用。
 * @returns {HTMLElement} 面板根元素
 */
export function buildAllow() {
    const root = pageRoot("screen-time-allow");

    // ---- 始终允许 ----
    const allowWrap = el("div", { class: "st-allow" });
    const refreshAllow = () => {
        const api = tracker();
        const allowed = api ? api.allowedApps() : [];
        const allowedNames = new Set(allowed.map((item) => item.name));
        const seen = new Map();
        (api ? api.getRecentDays(7) : []).forEach((day) => {
            Object.entries(day.apps || {}).forEach(([name, seconds]) => {
                seen.set(name, (seen.get(name) || 0) + seconds);
            });
        });
        const names = [...new Set([...allowedNames, ...seen.keys()])].sort();
        allowWrap.textContent = "";
        if (!names.length) {
            allowWrap.append(el("div", {
                text: t("ss.screenTime.allowEmpty", "最近 7 天还没有应用记录，使用一段时间后再来勾选。"),
                style: "color: var(--ss-text-secondary); font-size: 12px;",
            }));
            return;
        }
        names.forEach((name) => {
            const checkbox = el("input", { attrs: { type: "checkbox" } });
            checkbox.checked = allowedNames.has(name);
            checkbox.addEventListener("change", () => {
                const list = tracker().allowedApps().filter((item) => item.name !== name);
                if (checkbox.checked) list.push({ id: name, name });
                settings.set("screenTime.allowAlways", list, { source: "screen-time-pane" });
            });
            allowWrap.append(el("div", { class: "st-allow__row" }, checkbox, el("label", { text: name })));
        });
    };

    root.append(
        group([
            row({ label: "", control: allowWrap, stack: true }),
            note("ss.screenTime.allowHint", "停用期间仍可打开这些应用。"),
        ], { title: t("ss.screenTime.alwaysAllow", "始终允许的应用") }),
    );
    refreshAllow();

    const onChange = (event) => {
        const key = String(event.detail?.key || "");
        if (key.startsWith("screenTime.")) refreshAllow();
    };
    document.addEventListener("settings-changed", onChange);
    track(() => document.removeEventListener("settings-changed", onChange));
    return root;
}

/**
 * 「口令闸门」分组：停用时间页读取锁定屏幕口令状态，并提供前往入口。
 * @returns {HTMLElement} 分组元素
 */
function passcodeGroup() {
    const passRow = statusRow({ label: t("ss.screenTime.passcode", "口令闸门"), value: "—" });
    const refreshPasscode = () => {
        const locked = Boolean(globalThis.__lock?.hasPassword?.());
        passRow.setValue(locked
            ? t("ss.screenTime.passcodeSet", "已设置锁定屏幕口令")
            : t("ss.screenTime.passcodeNone", "未设置口令"));
    };

    const openLockButton = el("button", {
        class: "ss-btn", attrs: { type: "button" },
        text: t("ss.screenTime.openLockScreen", "前往「锁定屏幕」"),
    });
    openLockButton.addEventListener("click", () => {
        document.dispatchEvent(new CustomEvent("system-settings-open-pane", { detail: { pane: "lock-screen" }, bubbles: true }));
    });

    refreshPasscode();
    return group([
        passRow,
        row({ label: "", control: openLockButton, stack: true }),
        note("ss.screenTime.passcodeNote", "停用期间忽略限制需要输入锁定屏幕口令；未设口令时只能提醒。"),
    ], { title: t("ss.screenTime.passcode", "口令闸门") });
}

/**
 * 构建「屏幕使用时间」父页：只摆二级入口。
 * @param {object} ctx 外壳上下文
 * @returns {HTMLElement} 面板根元素
 */
export function build(ctx) {
    const root = pageRoot(paneId);
    const links = childPanes(paneId).map((child) => paneLink({
        label: t(child.i18nKey, child.label),
        icon: child.icon,
        onOpen: () => { if (ctx && typeof ctx.selectPane === "function") ctx.selectPane(child.id); },
    }));
    if (links.length) root.append(group(links));
    return root;
}
