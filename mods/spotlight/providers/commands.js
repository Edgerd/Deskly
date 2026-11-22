/**
 * providers/commands.js — 系统动作结果（可执行命令，注册表驱动）
 *
 * 注册表条目：分组 command、权重 50、匹配策略 rankOf(label/别名/id/sub)、
 * 索引方式 无索引（每次查询现读 system-actions 注册表）、异步 否、
 * 失败降级 动作不可用时自动消失；执行抛错由 runSystemAction 隔离记录，不拖垮搜索。
 *
 * 动作来源只有一张表：src/javascripts/system-actions.js 的注册表。
 * 本模块在求值期把 12 条内置动作注册进去（与窗口线/控制中心将来注册的
 * 台前调度等动作同表同待遇），聚焦自身不持有第二份清单。
 */

import { i18n } from "../../../src/javascripts/i18n.js";
import { glyph, assetPath } from "../../../src/javascripts/paths.js";
import { appearance, setTheme } from "../../../src/javascripts/appearance.js";
import { settings } from "../../../src/javascripts/settings.js";
import { showNotification } from "../../../src/javascripts/ui/notification.js";
import { registerSystemAction, listSystemActions, runSystemAction } from "../../../src/javascripts/system-actions.js";
import { rankOf } from "../engine.js";

/** 切换深色模式：读当前主题写反向值。 */
function toggleDarkMode() {
    setTheme(appearance.getTheme() === "dark" ? "light" : "dark");
}

/** 进行中的计时器句柄：同一时刻只保留一个（再设一个就是改时间）。 */
let timerHandle = null;

/**
 * F-21：计时器快捷命令。原版「设置计时器」的等价实现：聚焦里输入
 * 「计时器 5」/「timer 5 分钟」回车即开始倒计时，到点弹一条不自动收起的通知。
 * @param {number} minutes 分钟数（1..1440，搜索分支已保证）
 */
function startTimer(minutes) {
    if (timerHandle) clearTimeout(timerHandle);
    const label = i18n.t("spotlight.timerBody", "{min} 分钟计时")
        .replace("{min}", String(minutes));
    showNotification({
        title: i18n.t("spotlight.timerStarted", "计时开始"),
        text: label,
        duration: 5000,
    });
    timerHandle = setTimeout(() => {
        timerHandle = null;
        showNotification({
            title: i18n.t("spotlight.timerDone", "计时结束"),
            text: label,
            duration: 0, // 到点的提醒常驻直到点掉，不做成会悄悄消失的假提醒
        });
    }, Math.round(minutes * 60 * 1000));
}

/** 自带实现的动作表：键名与 __menuActions 同一命名空间，解析时优先查菜单表。 */
const LOCAL_ACTIONS = {
    toggleDarkMode, startTimer,
};

/**
 * 解析动作名为可执行函数：__menuActions 是唯一权威（菜单命令即注册表键名，
 * 绝不按名字 eval），本地实现与 debug.js 的具名导出补两张小表。
 */
function resolveAction(name) {
    const fromMenu = (globalThis.__menuActions || {})[name];
    if (typeof fromMenu === "function") return fromMenu;
    if (typeof LOCAL_ACTIONS[name] === "function") return LOCAL_ACTIONS[name];
    if (name === "reloadActivePlugin") {
        return async () => {
            const { reloadActivePlugin } = await import("../../../src/javascripts/debug.js");
            if (typeof reloadActivePlugin === "function") reloadActivePlugin();
        };
    }
    return null;
}

/** 有打开的应用窗口（hideActiveApp/showAll 的可用性前提）。 */
function hasAppWindow() {
    return typeof document !== "undefined" && Boolean(document.querySelector("body > .window"));
}

/**
 * 内置动作表：id 即 __menuActions 键名（toggleDarkMode 为本地实现）。
 * group：session 会话命令 / window 窗口 / desktop 桌面 / appearance 外观 / debug 调试。
 */
const BUILTIN_ACTIONS = [
    { id: "lockScreen", label: "锁定屏幕", aliases: ["lock"], sub: "会话命令", group: "session", icon: glyph("lock.fill") },
    { id: "sleep", label: "睡眠", aliases: ["sleep"], sub: "会话命令", group: "session", icon: glyph("moon.fill") },
    { id: "shutdown", label: "关机", aliases: ["shutdown"], sub: "会话命令", group: "session", icon: glyph("moon.stars.circle") },
    { id: "restart", label: "重新启动", aliases: ["restart", "重启桌面"], sub: "会话命令 · 重新加载页面", group: "session", icon: glyph("arrow.up.left.and.arrow.down.right") },
    { id: "forceQuit", label: "强制退出全部应用", aliases: ["force quit"], sub: "会话命令", group: "session", icon: glyph("hand.raised.fill") },
    { id: "logOut", label: "退出登录", aliases: ["log out"], sub: "会话命令", group: "session", icon: glyph("person.2.fill") },
    { id: "emptyTrash", label: "清倒废纸篓", aliases: ["empty trash"], sub: "桌面", group: "desktop", icon: assetPath("icons/trash/trash_light.webp") },
    { id: "hideActiveApp", label: "隐藏当前应用", aliases: ["hide"], sub: "窗口", group: "window", icon: glyph("chevron.down"), needsWindow: true },
    { id: "showAll", label: "显示全部窗口", aliases: ["show all"], sub: "窗口", group: "window", icon: glyph("menubar.dock.rectangle"), needsWindow: true },
    { id: "aboutThisMac", label: "关于本机", aliases: ["about"], sub: "会话命令", group: "session", icon: glyph("gear") },
    { id: "reloadActivePlugin", label: "重新载入当前插件", aliases: ["reload"], sub: "调试", group: "debug", icon: glyph("switch.2") },
    { id: "toggleDarkMode", label: "切换深色模式", aliases: ["dark mode", "深色", "dark"], sub: "外观", group: "appearance", icon: glyph("moonphase.last.quarter.inverse") },
];

// 内置动作注册进系统动作表（重复求值时同 id 覆盖，幂等）。
// 可用性 = 动作名能解析到真实函数（解析不到的条目自动从结果消失，与旧行为一致），
// 窗口类动作额外要求存在应用窗口；def.availability 是逐条补充的状态可用性。
for (const def of BUILTIN_ACTIONS) {
    registerSystemAction({
        id: def.id,
        label: def.label,
        sub: def.sub,
        icon: def.icon,
        group: def.group,
        aliases: def.aliases,
        available: () => Boolean(resolveAction(def.id)) && (!def.needsWindow || hasAppWindow())
            && (typeof def.availability !== "function" || def.availability()),
        run: () => resolveAction(def.id)?.(),
    });
}

/** 「计时器 5」「timer 5 分钟」形态：命令词 + 可选数量 + 可选单位词。 */
const TIMER_RE = /^(?:计时器|定时|timer)\s*([\d.]+)?\s*(?:分钟|分|min|minutes?)?$/i;

/**
 * 计时器形态解析（F-21）：命令词后必须带分钟数（1..1440），没有数字就不出结果 ——
 * 「计时器」单独出现不给一个点了没反应的假条目。
 * @param {string} lower 小写查询
 * @returns {Array<object>} 命中时一条可执行结果，否则空
 */
function timerResults(lower) {
    const m = lower.match(TIMER_RE);
    if (!m) return [];
    const minutes = Number(m[1]);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) return [];
    return [{
        type: "command",
        score: 0,
        label: i18n.t("spotlight.timerLabel", "设置计时器：{min} 分钟").replace("{min}", String(minutes)),
        sub: i18n.t("spotlight.timerSub", "计时器"),
        hint: i18n.t("spotlight.runHint", "回车执行"),
        icon: glyph("clock.blue"),
        action: () => startTimer(minutes),
    }];
}

export const commandsProvider = {
    id: "commands",
    group: "command",
    weight: 50,
    async: false,
    types: ["command"],
    search(ctx) {
        const timer = timerResults(ctx.lower);
        if (timer.length) return timer;
        return listSystemActions()
            .map((action) => ({ action, score: rankOf(ctx.lower, action.label, action.id, action.sub, ...action.aliases) }))
            .filter(({ score }) => score < 3)
            .slice(0, ctx.limit)
            .map(({ action, score }) => ({
                type: "command",
                score,
                label: action.label,
                sub: action.sub || action.group,
                hint: i18n.t("spotlight.runHint", "回车执行"),
                icon: action.icon || undefined,
                action: () => runSystemAction(action.id),
            }));
    },
};
