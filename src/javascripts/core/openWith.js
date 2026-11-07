/**
 * core/openWith.js — 「打开方式」选择器（未知类型双击时弹出）。
 *
 * 为什么需要它：双击一个没有默认应用的文件时，旧实现退回 Quick Look 预览，
 * 用户看到预览就以为文件「打不开」。macOS 的语义是弹「选择应用」面板：
 * 列出声明能打开该类型的应用，允许勾选「始终用此应用打开」，选中即生效。
 *
 * 与 core/fileMenu.js 的「打开方式」子菜单共用同一条候选口径
 * （core/appFormats.js + appsForExtension），避免右键菜单和双击选择器给出不同的应用列表。
 *
 * 单例：再次打开换内容，不开第二个面板（与 Quick Look / 显示简介同口径）。
 */

import { i18n } from "../i18n.js";
import { listApps, openApp } from "../plugin-manager.js";
import { normalizeExtension } from "./appFormats.js";
import { appsForExtension } from "./fileMenu.js";
import * as defaultApps from "../default-apps.js";
import { GENERIC_DOC_ICON } from "../paths.js";

const t = (key, fallback) => i18n.t(key, fallback);

/**
 * 候选应用：优先声明能打开该扩展名的；一个都没有时退回全部已注册应用
 * （macOS 的「选择应用」同样允许选任意应用，否则未知类型会走进死路）。
 * @param {string} ext 扩展名（可带点）
 * @returns {Array<{appId:string,name:string,isDefault:boolean}>}
 */
export function candidatesFor(ext) {
    const bare = normalizeExtension(ext);
    const declared = appsForExtension(bare);
    if (declared.length) return declared;
    const defaultAppId = defaultApps.get(bare);
    return (listApps() || [])
        .filter((rec) => rec && rec.app && rec.appId)
        .map((rec) => ({ appId: rec.appId, name: rec.name || rec.displayName || rec.appId, isDefault: rec.appId === defaultAppId }));
}

/* ── 面板 ── */

let panel = null;          // { root, els }
let candidates = [];
let selectedAppId = null;
let currentPath = "";
let currentExt = "";

function buildPanel() {
    const root = document.createElement("div");
    root.className = "openwith-panel";
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.innerHTML = `
        <div class="ow-head">
            <p class="ow-title">${t("openWith.title", "打开方式")}</p>
            <p class="ow-sub"></p>
        </div>
        <div class="ow-list" role="radiogroup" aria-label="${t("openWith.title", "打开方式")}"></div>
        <label class="ow-always"><input type="checkbox" /><span class="ow-always-label"></span></label>
        <div class="ow-actions">
            <button class="ow-cancel" type="button">${t("openWith.cancel", "取消")}</button>
            <button class="ow-open" type="button">${t("openWith.open", "打开")}</button>
        </div>`;
    document.body.appendChild(root);

    const els = {
        root,
        sub: root.querySelector(".ow-sub"),
        list: root.querySelector(".ow-list"),
        always: root.querySelector(".ow-always input"),
        alwaysLabel: root.querySelector(".ow-always-label"),
        cancel: root.querySelector(".ow-cancel"),
        confirm: root.querySelector(".ow-open"),
    };
    els.cancel.addEventListener("click", close);
    els.confirm.addEventListener("click", () => { confirm().catch(() => {}); });
    return { root, els };
}

function renderList() {
    const { list } = panel.els;
    list.innerHTML = "";
    if (!candidates.length) {
        const empty = document.createElement("p");
        empty.className = "ow-empty";
        empty.textContent = t("openWith.none", "没有可用来打开该文件的应用");
        list.appendChild(empty);
        return;
    }
    for (const app of candidates) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "ow-app";
        row.dataset.appId = app.appId;
        row.setAttribute("role", "radio");
        const picked = app.appId === selectedAppId;
        row.setAttribute("aria-checked", picked ? "true" : "false");
        if (picked) row.classList.add("selected");
        const icon = document.createElement("img");
        icon.alt = "";
        icon.src = GENERIC_DOC_ICON;
        const label = document.createElement("span");
        label.textContent = app.name;
        row.append(icon, label);
        row.addEventListener("click", () => {
            selectedAppId = app.appId;
            syncSelection();
        });
        row.addEventListener("dblclick", () => { confirm().catch(() => {}); });
        list.appendChild(row);
    }
}

function syncSelection() {
    if (!panel) return;
    panel.els.list.querySelectorAll(".ow-app").forEach((row) => {
        const picked = row.dataset.appId === selectedAppId;
        row.classList.toggle("selected", picked);
        row.setAttribute("aria-checked", picked ? "true" : "false");
    });
    const name = candidates.find((app) => app.appId === selectedAppId)?.name || "";
    const extText = currentExt ? `.${currentExt}` : t("openWith.thisKind", "这类文件");
    panel.els.alwaysLabel.textContent = name
        ? t("openWith.always", `始终用“${name}”打开 ${extText} 文件`)
        : t("openWith.alwaysEmpty", "始终用所选应用打开");
    panel.els.confirm.disabled = !selectedAppId;
}

function onKeydown(e) {
    if (!panel || panel.root.hidden) return;
    // 面板打开期间把按键留在面板里：否则桌面会同时响应空格/⌘A 等快捷键
    if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        close();
        return;
    }
    if (e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        confirm().catch(() => {});
        return;
    }
    e.stopPropagation();
}

function onOutside(e) {
    if (!panel || panel.root.hidden) return;
    if (!panel.root.contains(e.target)) close();
}

function close() {
    if (!panel) return;
    panel.root.hidden = true;
    selectedAppId = null;
}

function isOpen() {
    return !!(panel && !panel.root.hidden);
}

async function confirm() {
    if (!panel || panel.root.hidden || !selectedAppId || !currentPath) return;
    const appId = selectedAppId;
    const filePath = currentPath;
    // 勾选「始终用」：写进 default-apps，下一次双击/访达打开同一类型不再问
    if (panel.els.always.checked && currentExt) {
        try {
            defaultApps.set(currentExt, appId);
        } catch (err) {
            console.warn("[openWith] 默认应用改绑失败：", err);
        }
    }
    close();
    await openApp(appId, { file: filePath }).catch((err) => {
        console.warn("[openWith] 打开失败：", filePath, err);
        const dialog = window.__dialog;
        if (dialog) dialog.alert(t("openWith.failed", "无法打开"), err.message || String(err));
    });
}

/**
 * 打开选择器（单例接管）。
 * @param {string} filePath 目标文件路径
 */
async function open(filePath) {
    if (!filePath) return;
    if (!panel) {
        panel = buildPanel();
        document.addEventListener("keydown", onKeydown, true);
        document.addEventListener("pointerdown", onOutside, true);
    }
    currentPath = filePath;
    const name = filePath.split("/").pop() || filePath;
    currentExt = String(name.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
    candidates = candidatesFor(currentExt);
    // 预选：默认应用 → 第一个候选
    selectedAppId = (candidates.find((app) => app.isDefault) || candidates[0] || {}).appId || null;

    panel.root.hidden = false;
    panel.els.sub.textContent = currentExt
        ? t("openWith.subtitle", `选择用来打开“${name}”的应用`)
        : t("openWith.subtitleUnknown", `“${name}”没有可识别的文件类型，请选择应用`);
    renderList();
    syncSelection();
}

const OpenWith = Object.freeze({ open, close, isOpen, candidatesFor: candidatesFor });
export { OpenWith };
