/** script.js — 关于本机：补一次 data-i18n 翻译、填充系统版本行、生成稳定序列号、
 *  「更多信息…」改为窗口内系统报告（浏览器 / 版本 / 应用 / 存储 / 权限台账，全部本机只读信息）。
 *  版本、名称、作者取自 src/javascripts/version.js 单一来源。 */

import { i18n } from '../../src/javascripts/i18n.js';
import { VERSION, APP_NAME, APP_AUTHOR } from '../../src/javascripts/version.js';
import { listApps, getPlugins } from '../../src/javascripts/plugin-manager.js';

// 稳定序列号的存储槽：首次打开生成一次，此后只读（与机型硬件信息同级的「随机标识」）
const SERIAL_SLOT = "deskly-about-serial";

const root = document.querySelector(".about_this_mac.window");

if (root) {
    init();
} else {
    console.warn("[about] 未找到窗口根元素，跳过初始化");
}

/** 应用静态文案、系统版本行、序列号，接上系统报告入口 */
function init() {
    // 语言切换时核心会全量扫描 data-i18n，这里只需在打开时补一次
    root.querySelectorAll("[data-i18n]").forEach((el) => {
        const fallback = el.getAttribute("data-i18n-fallback") || el.textContent;
        el.textContent = i18n.t(el.getAttribute("data-i18n"), fallback);
    });

    const osVersion = root.querySelector(".os-version");
    if (osVersion) osVersion.textContent = `${APP_NAME} ${VERSION}`;

    const serial = root.querySelector(".serial");
    if (serial) serial.textContent = stableSerial();

    // 监听挂在窗口内部元素上，随窗口移除一并回收，无需 plugin-unload 摘除
    const moreInfoBtn = root.querySelector(".button");
    if (moreInfoBtn) moreInfoBtn.addEventListener("click", showSystemReport);
    const closeBtn = root.querySelector(".sys-report__close");
    if (closeBtn) closeBtn.addEventListener("click", hideSystemReport);
}

/**
 * 取（或首次生成）本机的稳定序列号：随机来源 + localStorage 持久化，
 * 同一台机器每次打开看到的都是同一个号。
 * @returns {string} 形如 C02XXXXXXXXX 的序列号
 */
function stableSerial() {
    let serial = "";
    try { serial = String(localStorage.getItem(SERIAL_SLOT) || ""); } catch { serial = ""; }
    if (!serial) {
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"; // 去掉易混淆的 I/O
        const pool = new Uint8Array(8);
        if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
            globalThis.crypto.getRandomValues(pool);
        } else {
            pool.forEach((_, i) => { pool[i] = Math.floor(Math.random() * 256); });
        }
        let tail = "";
        pool.forEach((byte) => { tail += alphabet[byte % alphabet.length]; });
        serial = `C02${tail}`;
        try { localStorage.setItem(SERIAL_SLOT, serial); } catch { /* 隐私模式下下次重新生成，无碍显示 */ }
    }
    return serial;
}

/** 系统报告词条（缺失时中文兜底）。 */
function reportText(key, fallback) {
    return i18n.t(`about.report.${key}`, fallback); // i18n-dynamic-ok 键名集合即 renderReport 里的 reportText() 实参
}

/** 「更多信息…」：在窗口内展开系统报告层（不再走系统弹窗）。 */
function showSystemReport() {
    const overlay = root.querySelector(".sys-report");
    if (!overlay) return;
    const title = overlay.querySelector(".sys-report__title");
    if (title) title.textContent = reportText("title", "系统报告");
    const close = overlay.querySelector(".sys-report__close");
    if (close) close.textContent = reportText("close", "完成");
    const body = overlay.querySelector(".sys-report__body");
    if (body) renderReport(body);
    overlay.hidden = false;
}

/** 收起系统报告层。 */
function hideSystemReport() {
    const overlay = root.querySelector(".sys-report");
    if (overlay) overlay.hidden = true;
}

/** 单行「名 / 值」。 */
function reportRow(label, value) {
    const row = document.createElement("div");
    row.className = "sys-report__row";
    const k = document.createElement("span");
    k.className = "sys-report__k";
    k.textContent = label;
    const v = document.createElement("span");
    v.className = "sys-report__v";
    v.textContent = String(value);
    row.append(k, v);
    return row;
}

/** 一节内容：小标题 + 行数组。 */
function reportGroup(title, rows) {
    const group = document.createElement("div");
    group.className = "sys-report__group";
    const head = document.createElement("p");
    head.className = "sys-report__group-title";
    head.textContent = title;
    group.append(head, ...rows);
    return group;
}

/** 外观主题文案：<html data-theme> 是 appearance.js 的产出。 */
function themeLabel() {
    return document.documentElement.dataset.theme === "dark" ? "深色" : "浅色";
}

/** 浏览器一句话（UA 原文太长，取平台与内核关键段）。 */
function browserLine() {
    const ua = navigator.userAgent || "";
    const engine = /Chrome\/([\d.]+)/.exec(ua);
    const edge = /Edg\//.test(ua);
    const name = edge ? "Edge" : "Chrome";
    return engine ? `${name} ${engine[1].split(".")[0]}` : ua.slice(0, 60);
}

/**
 * 渲染系统报告正文：全部本机只读信息，逐行 textContent，不解析任何 HTML。
 * @param {HTMLElement} body 报告正文容器
 */
function renderReport(body) {
    body.textContent = "";
    body.append(
        reportGroup(reportText("system", "系统"), [
            reportRow(reportText("version", "系统版本"), `${APP_NAME} ${VERSION}`),
            reportRow(reportText("author", "作者"), APP_AUTHOR),
            reportRow(reportText("browser", "浏览器"), browserLine()),
            reportRow(reportText("theme", "外观"), themeLabel()),
            reportRow(reportText("language", "语言"), i18n.getLanguage()),
        ]),
    );

    // 已装应用（来自插件注册表，只读清单）
    const apps = listApps().map((rec) => rec.name || rec.windowName || rec.appId).filter(Boolean);
    const plugins = getPlugins();
    body.append(reportGroup(reportText("apps", "应用与插件"), [
        reportRow(reportText("appsCount", "已装应用"), `${apps.length}`),
        reportRow(reportText("appList", "应用清单"), apps.join("、") || "—"),
        reportRow(reportText("pluginsCount", "插件数"), `${plugins.length}`),
    ]));

    // 存储用量（异步补行，失败静默留占位）
    const storageRow = reportRow(reportText("storage", "存储用量"), "…");
    const storageGroup = reportGroup(reportText("storageTitle", "存储"), [storageRow]);
    body.append(storageGroup);
    const permissions = globalThis.__permissions;
    if (permissions && typeof permissions.storageEstimate === "function") {
        permissions.storageEstimate().then((estimate) => {
            if (!estimate || !estimate.supported) {
                storageRow.querySelector(".sys-report__v").textContent = reportText("unsupported", "不支持");
                return;
            }
            const mb = (n) => `${(Number(n) / 1024 / 1024).toFixed(1)} MB`;
            storageRow.querySelector(".sys-report__v").textContent =
                `${mb(estimate.usage)} / ${mb(estimate.quota)}（${estimate.percent}%）` +
                (estimate.persisted ? " · 持久" : "");
        }).catch(() => {
            storageRow.querySelector(".sys-report__v").textContent = "—";
        });
    } else {
        storageRow.querySelector(".sys-report__v").textContent = reportText("unsupported", "不支持");
    }

    // 权限台账（只读状态，不触发任何授权弹窗）
    if (permissions && typeof permissions.list === "function") {
        const permGroup = reportGroup(reportText("permissions", "权限台账"), [
            reportRow(reportText("permissionsLoading", "正在读取"), "…"),
        ]);
        body.append(permGroup);
        permissions.list().then((rows) => {
            if (!permGroup.isConnected) return;
            permGroup.replaceChildren();
            const head = document.createElement("p");
            head.className = "sys-report__group-title";
            head.textContent = reportText("permissions", "权限台账");
            permGroup.append(head, ...rows.map((row) => reportRow(row.label || row.name, row.state)));
        }).catch(() => {
            permGroup.replaceChildren();
            const head = document.createElement("p");
            head.className = "sys-report__group-title";
            head.textContent = reportText("permissions", "权限台账");
            permGroup.append(head, reportRow(reportText("permissionsFailed", "读取失败"), "—"));
        });
    }
}
