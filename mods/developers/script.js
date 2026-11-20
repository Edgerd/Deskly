/**
 * script.js — Developers app controller.
 *
 * Owns only the UI: sidebar, home, create form, manage list, settings.
 * Storage, spec validation, icons, capture, templates and installation all live in ./js/.
 * Created plugins are real system plugins (window/page) or source-only shortcuts.
 */

import { i18n } from "../../src/javascripts/i18n.js";
import { DEVELOPER_MESSAGES } from "./messages.js";
import {
    normalizeWindow,
    loadLibrary,
    saveLibrary,
    getRecord,
    upsertRecord,
    removeRecord,
    estimateBytes,
    makeId,
    touch,
} from "./js/library.js";
import {
    SPEC_SCHEMA_DOC,
    SPEC_EXAMPLE,
    PACKAGE_FORMAT,
    PACKAGE_VERSION,
    normalizeSpec,
    normalizeUrl,
    hostOf,
    titleFromUrl,
    buildPackage,
    parseImportText,
    exportFilename,
    downloadText,
} from "./js/spec.js";
import { iconFromFile, applyIconData, clearIconData, iconColor } from "./js/icon.js";
import { isInstalled, installRecord, uninstallRecord, launchRecord } from "./js/install.js";
import { captureSite, requestSiteAccess } from "./js/capture.js";
import { buildPreviewDocument, PAGE_TEMPLATES } from "./js/templates.js";

i18n.registerMessagesAll(DEVELOPER_MESSAGES);

const win = document.querySelector(".developers.window");

const RECOMMENDED = [
    { name: "GitHub", url: "https://github.com", letter: "G", color: "#24292F" },
    { name: "Figma", url: "https://www.figma.com", letter: "F", color: "#A259FF" },
    { name: "Notion", url: "https://www.notion.so", letter: "N", color: "#111111" },
    { name: "Linear", url: "https://linear.app", letter: "L", color: "#5E6AD2" },
    { name: "MDN", url: "https://developer.mozilla.org", letter: "M", color: "#1B1B1B" },
    { name: "Dribbble", url: "https://dribbble.com", letter: "D", color: "#EA4C89" },
    { name: "Vercel", url: "https://vercel.com", letter: "V", color: "#000000" },
    { name: "Unsplash", url: "https://unsplash.com", letter: "U", color: "#111111" },
];

const ACCENTS = ["#2078DA", "#1D9BF0", "#34A853", "#F59E0B", "#E5484D", "#8B5CF6", "#EC4899", "#111827"];
const PANE_NAMES = ["home", "form", "manage", "settings"];

const state = {
    current: "home",
    library: { version: 1, updatedAt: "", plugins: [] },
    draft: null,
    manageKind: "all",
    manageKeyword: "",
    dialog: null,
};

/* ── small helpers ── */

const t = (key, fallback = "") => i18n.t(key, fallback || key);

function fill(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
    ));
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function p(text, className) {
    return el("p", className || "", text);
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

function hexA(hex, alpha) {
    const value = String(hex || "").replace("#", "");
    if (!/^[0-9a-f]{6}$/i.test(value)) return "rgba(32, 120, 218, 0.14)";
    const n = parseInt(value, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function formatDate(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    try {
        return new Intl.DateTimeFormat(i18n.getLanguage(), { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
    } catch (_) {
        return date.toISOString().slice(0, 10);
    }
}

function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const paneEl = (name) => win.querySelector(`[data-pane="${name}"]`);
const role = (name) => win.querySelector(`[data-role="${name}"]`);

/** 类型名的静态键表：拼出来的键（dev.kind.${kind}）静态检查查不到，漏键也不会报错。 */
const KIND_KEYS = { shortcut: "dev.kind.shortcut", window: "dev.kind.window", page: "dev.kind.page" };

function kindLabel(kind) {
    return t(KIND_KEYS[kind] || kind, kind);
}

function navIcon(name) {
    const paths = {
        home: '<path d="M2.2 6.6 8 2.2l5.8 4.4v6.2a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1z"/><path d="M6.1 13.8V9.3h3.8v4.5"/>',
        create: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
        manage: '<path d="M2.8 4.4h10.4M2.8 8h10.4M2.8 11.6h10.4"/>',
        settings: '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.7v1.9M8 12.4v1.9M1.7 8h1.9M12.4 8h1.9M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4"/>',
    };
    return `<svg class="ui-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || ""}</svg>`;
}

function monoNode(record, className) {
    const color = iconColor(record);
    const node = el("span", `${className || ""} dv-mono`.trim(), record.icon && record.icon.letter ? record.icon.letter : "?");
    node.style.color = color;
    node.style.background = hexA(color, 0.14);
    return node;
}

function iconNode(record, className) {
    const box = el("div", className || "");
    if (record.icon && record.icon.data) {
        const img = el("img");
        img.src = record.icon.data;
        img.alt = "";
        box.appendChild(img);
    } else {
        const mono = monoNode(record, "");
        box.appendChild(mono);
    }
    return box;
}

/* ── toast and dialogs ── */

let toastTimer = 0;

function toast(message, bad = false) {
    const node = role("toast");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("dv-toast--bad", !!bad);
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3400);
}

function showDialog({ title, body, buttons = [], onMount }) {
    return new Promise((resolve) => {
        const modal = role("modal");
        const titleEl = role("modal-title");
        const bodyEl = role("modal-body");
        const footEl = role("modal-foot");
        const closeBtn = role("modal-close");

        titleEl.textContent = title || "";
        bodyEl.innerHTML = "";
        footEl.innerHTML = "";
        if (typeof body === "string") bodyEl.innerHTML = body;
        else if (body) bodyEl.appendChild(body);

        let done = false;
        const close = (value) => {
            if (done) return;
            done = true;
            modal.hidden = true;
            state.dialog = null;
            win.removeEventListener("keydown", onKey);
            resolve(value);
        };
        const onKey = (event) => {
            if (event.key === "Escape") close(null);
        };
        win.addEventListener("keydown", onKey);
        closeBtn.onclick = () => close(null);

        const controls = {
            close,
            setBusy(on) {
                footEl.querySelectorAll("button").forEach((btn) => { btn.disabled = !!on; });
            },
            setError(text) {
                const error = bodyEl.querySelector(".dv-modal__error");
                if (error) error.textContent = text || "";
            },
        };

        buttons.forEach((item) => {
            const btn = el("button", `dv-btn${item.primary ? " dv-btn--primary" : ""}${item.danger ? " dv-btn--danger" : ""}`, item.label);
            btn.type = "button";
            btn.onclick = async () => {
                if (!item.onClick) {
                    close(item.value === undefined ? true : item.value);
                    return;
                }
                const result = await item.onClick(controls);
                if (result === false) return;
                close(result === undefined ? item.value : result);
            };
            footEl.appendChild(btn);
        });

        modal.hidden = false;
        state.dialog = { close };
        if (onMount) onMount({ modal, bodyEl, close, setBusy: controls.setBusy });
    });
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (_) {
        try {
            const area = el("textarea");
            area.value = text;
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.appendChild(area);
            area.select();
            const ok = document.execCommand("copy");
            area.remove();
            return ok;
        } catch (_) {
            return false;
        }
    }
}

function specErrorText(error) {
    const reason = (error && (error.detail || error.code)) || "format";
    return fill(t("dev.dialog.invalid"), { reason });
}

/* ── navigation and layout ── */

function renderNav() {
    const nav = role("nav");
    if (!nav) return;
    nav.innerHTML = "";
    const items = [
        ["home", "dev.nav.home"],
        ["create", "dev.nav.create"],
        ["manage", "dev.nav.manage"],
    ];
    items.forEach(([key, label]) => {
        const btn = el("button", "dv-navitem");
        btn.type = "button";
        btn.dataset.nav = key;
        const active = (key === "home" && state.current === "home")
            || (key === "create" && state.current === "form")
            || (key === "manage" && state.current === "manage");
        if (active) btn.classList.add("active");
        btn.innerHTML = `${navIcon(key)}<span class="dv-navitem__label"></span>`;
        btn.querySelector(".dv-navitem__label").textContent = t(label);
        nav.appendChild(btn);
    });

    const settings = win.querySelector('[data-nav="settings"]');
    if (settings) {
        settings.innerHTML = `${navIcon("settings")}<span class="dv-navitem__label"></span>`;
        settings.querySelector(".dv-navitem__label").textContent = t("dev.nav.settings");
        settings.classList.toggle("active", state.current === "settings");
    }
}

function renderChrome() {
    renderNav();
    const brand = role("brand");
    if (brand) brand.textContent = "开发者";
    const line = role("storage-line");
    if (line) line.textContent = fill(t("dev.manage.count"), { n: state.library.plugins.length });

    const heading = role("heading");
    const subheading = role("subheading");
    const actions = role("actions");
    if (!heading || !subheading || !actions) return;

    let titleKey = "dev.toolbar.home";
    let subKey = "dev.toolbar.homeSub";
    if (state.current === "form") {
        titleKey = state.draft && state.draft.editing ? "dev.toolbar.edit" : "dev.toolbar.create";
        subKey = state.draft && state.draft.editing ? "dev.toolbar.editSub" : "dev.toolbar.createSub";
    } else if (state.current === "manage") {
        titleKey = "dev.toolbar.manage";
        subKey = "dev.toolbar.manageSub";
    } else if (state.current === "settings") {
        titleKey = "dev.toolbar.settings";
        subKey = "dev.toolbar.settingsSub";
    }
    heading.textContent = t(titleKey);
    subheading.textContent = t(subKey);

    actions.innerHTML = "";
    if (state.current === "home") {
        const importBtn = el("button", "dv-btn dv-btn--tinted", t("dev.dialog.importTitle"));
        importBtn.type = "button";
        importBtn.dataset.action = "import";
        const createBtn = el("button", "dv-btn dv-btn--primary", t("dev.home.primary"));
        createBtn.type = "button";
        createBtn.dataset.action = "create";
        actions.append(importBtn, createBtn);
    } else if (state.current === "manage") {
        const importBtn = el("button", "dv-btn dv-btn--tinted", t("dev.dialog.importTitle"));
        importBtn.type = "button";
        importBtn.dataset.action = "import";
        actions.appendChild(importBtn);
    }
}

function renderPane() {
    PANE_NAMES.forEach((name) => {
        const pane = paneEl(name);
        if (pane) pane.hidden = name !== state.current;
    });
    if (state.current === "home") renderHome();
    else if (state.current === "form") renderForm();
    else if (state.current === "manage") renderManage();
    else if (state.current === "settings") renderSettings();
}

function renderAll() {
    renderChrome();
    renderPane();
}

function navTo(target) {
    if (target === "create") {
        startCreate("url");
        return;
    }
    if (target === "form" && !state.draft) {
        startCreate("url");
        return;
    }
    state.current = target;
    renderAll();
}

/* ── home ── */

function renderHome() {
    const pane = paneEl("home");
    if (!pane) return;
    const plugins = state.library.plugins;
    const installed = plugins.filter((item) => item.kind !== "shortcut" && isInstalled(item)).length;
    const shortcuts = plugins.filter((item) => item.kind === "shortcut").length;

    pane.innerHTML = `
        <section class="dv-hero">
            <div>
                <p class="dv-kicker">${esc(t("dev.home.kicker"))}</p>
                <h1 class="dv-hero-title">${esc(t("dev.home.title"))}</h1>
                <p class="dv-hero-text">${esc(t("dev.home.text"))}</p>
                <div class="dv-hero-actions">
                    <button class="dv-btn dv-btn--primary" type="button" data-action="create">${esc(t("dev.home.primary"))}</button>
                    <button class="dv-btn dv-btn--tinted" type="button" data-action="new-page">${esc(t("dev.create.tabPage"))}</button>
                </div>
                <p class="dv-note">${esc(t("dev.home.localNote"))}</p>
            </div>
            <aside class="dv-hero-panel" aria-hidden="true">
                <div class="dv-stack">
                    <div class="dv-stack__win dv-stack__win--back">
                        <div class="dv-stack__bar"><span class="dv-stack__dot"></span><span class="dv-stack__dot"></span><span class="dv-stack__dot"></span></div>
                        <div class="dv-stack__body">
                            <span class="dv-stack__line dv-stack__line--mid"></span>
                            <span class="dv-stack__line"></span>
                            <span class="dv-stack__line dv-stack__line--short"></span>
                        </div>
                    </div>
                    <div class="dv-stack__win dv-stack__win--front">
                        <div class="dv-stack__bar"><span class="dv-stack__dot"></span><span class="dv-stack__dot"></span><span class="dv-stack__dot"></span></div>
                        <div class="dv-stack__body">
                            <span class="dv-stack__line dv-stack__line--accent"></span>
                            <span class="dv-stack__line"></span>
                            <span class="dv-stack__line dv-stack__line--mid"></span>
                        </div>
                    </div>
                    <div class="dv-stack__plus">+</div>
                </div>
                <div class="dv-stack__labels"><span>${esc(kindLabel("shortcut"))}</span><span>${esc(kindLabel("window"))}</span></div>
                <dl class="dv-facts">
                    <div><dt>${esc(t("dev.home.statCreated"))}</dt><dd>${plugins.length}</dd></div>
                    <div><dt>${esc(t("dev.home.statInstalled"))}</dt><dd>${installed}</dd></div>
                    <div><dt>${esc(t("dev.home.statShortcuts"))}</dt><dd>${shortcuts}</dd></div>
                </dl>
            </aside>
        </section>
        <section class="dv-section">
            <div class="dv-section-head">
                <h3>${esc(t("dev.home.recommended"))}</h3>
                <span class="dv-section-hint">${esc(t("dev.home.recommendedHint"))}</span>
            </div>
            <div class="dv-recs" data-role="recs"></div>
        </section>
        <section class="dv-section">
            <div class="dv-section-head"><h3>${esc(t("dev.home.recent"))}</h3></div>
            <div class="dv-recent" data-role="recent"></div>
        </section>`;

    renderRecommended();
    renderRecent();
}

function renderRecommended() {
    const grid = paneEl("home").querySelector('[data-role="recs"]');
    if (!grid) return;
    grid.innerHTML = "";
    RECOMMENDED.forEach((site, index) => {
        const existing = state.library.plugins.find((item) => item.url === site.url);
        const row = el("div", `dv-rec${existing ? " is-added" : ""}`);
        const number = el("span", "dv-rec__index", String(index + 1).padStart(2, "0"));
        const mono = el("span", "dv-rec__mono", site.letter);
        mono.style.color = site.color;
        mono.style.background = hexA(site.color, 0.14);
        const text = el("div", "dv-rec__text");
        text.append(el("span", "dv-rec__name", site.name), el("span", "dv-rec__host", hostOf(site.url)));
        const actions = el("div", "dv-rec__actions");
        if (existing) {
            actions.appendChild(el("span", "dv-badge", t("dev.home.added")));
            const open = el("button", "dv-btn dv-btn--ghost dv-btn--sm", t("dev.home.open"));
            open.type = "button";
            open.dataset.action = "open";
            open.dataset.id = existing.id;
            actions.appendChild(open);
        } else {
            const add = el("button", "dv-btn dv-btn--ghost dv-btn--sm", t("dev.home.addShortcut"));
            add.type = "button";
            add.dataset.action = "add-rec";
            add.dataset.index = String(index);
            add.dataset.kind = "shortcut";
            const addWindow = el("button", "dv-btn dv-btn--ghost dv-btn--sm", t("dev.home.addWindowShort"));
            addWindow.type = "button";
            addWindow.dataset.action = "add-rec";
            addWindow.dataset.index = String(index);
            addWindow.dataset.kind = "window";
            addWindow.title = t("dev.home.addWindow");
            actions.append(add, addWindow);
        }
        row.append(number, mono, text, actions);
        grid.appendChild(row);
    });
}

function renderRecent() {
    const box = paneEl("home").querySelector('[data-role="recent"]');
    if (!box) return;
    box.innerHTML = "";
    const recent = [...state.library.plugins]
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, 6);
    if (!recent.length) {
        const empty = el("div", "dv-empty");
        empty.append(p(t("dev.home.recentEmpty"), "dv-empty__hint"));
        box.appendChild(empty);
        return;
    }
    recent.forEach((record) => {
        const row = el("button", "dv-recent__row");
        row.type = "button";
        row.dataset.action = "open";
        row.dataset.id = record.id;
        row.appendChild(iconNode(record, ""));
        row.appendChild(el("span", "dv-recent__name", record.name));
        row.appendChild(el("span", "dv-recent__kind", kindLabel(record.kind)));
        row.appendChild(el("span", "dv-recent__time", formatDate(record.updatedAt)));
        box.appendChild(row);
    });
}

async function addRecommended(index, kind, button) {
    const site = RECOMMENDED[index];
    if (!site) return;
    if (button) button.disabled = true;
    const normalized = normalizeSpec({
        schema: undefined,
        name: site.name,
        kind,
        url: site.url,
        description: "",
        window: normalizeWindow({}),
        icon: { letter: site.letter, color: site.color },
    });
    if (!normalized.ok) {
        toast(specErrorText(normalized.error), true);
        return;
    }
    const record = normalized.record;
    try {
        upsertRecord(state.library, record);
        await saveLibrary(state.library);
    } catch (err) {
        toast(t("dev.toast.storageFailed"), true);
        return;
    }
    if (kind !== "shortcut") {
        const result = await installRecord(record, { overwrite: false });
        if (!result.ok) toast(fill(t("dev.create.installFailed"), { reason: result.reason || "install" }), true);
        else toast(t("dev.toast.installed"));
    } else {
        toast(t("dev.home.added"));
    }
    renderAll();
}

/* ── create / edit form ── */

function newDraft(mode) {
    return {
        id: "",
        editing: false,
        mode,
        kind: mode === "page" ? "page" : "shortcut",
        url: "",
        name: "",
        description: "",
        icon: { data: "", letter: "", color: "" },
        window: normalizeWindow({}),
        page: mode === "page" ? { ...PAGE_TEMPLATES.blank } : { html: "", css: "", js: "" },
        pageTab: "html",
        template: mode === "page" ? "blank" : "",
        nameTouched: false,
        scriptConfirmed: false,
        originalJs: "",
    };
}

function draftFromRecord(record) {
    return {
        id: record.id,
        editing: true,
        mode: record.kind === "page" ? "page" : "url",
        kind: record.kind,
        url: record.url,
        name: record.name,
        description: record.description,
        icon: { ...record.icon },
        window: { ...record.window },
        page: { ...record.page },
        pageTab: "html",
        template: "",
        nameTouched: true,
        scriptConfirmed: true,
        originalJs: record.page.js || "",
    };
}

function startCreate(mode) {
    state.draft = newDraft(mode === "page" ? "page" : "url");
    state.current = "form";
    renderAll();
}

function startEdit(id) {
    const record = getRecord(state.library, id);
    if (!record) return;
    state.draft = draftFromRecord(record);
    state.current = "form";
    renderAll();
}

function draftLetter() {
    const draft = state.draft;
    if (!draft) return "?";
    if (draft.icon && draft.icon.letter) return draft.icon.letter;
    const source = (draft.name || "").trim() || titleFromUrl(draft.url) || "?";
    return source.slice(0, 2).toUpperCase();
}

function syncLetter() {
    const draft = state.draft;
    if (!draft || (draft.icon && draft.icon.data)) return;
    const source = (draft.name || "").trim() || titleFromUrl(draft.url) || "?";
    draft.icon.letter = source.slice(0, 2).toUpperCase();
}

function iconPreviewHtml() {
    const draft = state.draft;
    if (draft.icon && draft.icon.data) {
        return `<img src="${esc(draft.icon.data)}" alt="" />`;
    }
    const color = draft.window.accent || "#2078DA";
    return `<span class="dv-mono" style="color:${esc(color)};background:${esc(hexA(color, 0.14))}">${esc(draftLetter())}</span>`;
}

function windowPanelHtml() {
    const draft = state.draft;
    const w = draft.window;
    const swatches = ACCENTS.map((color) => (
        `<button class="dv-swatch" type="button" data-accent="${color}" aria-checked="${String(w.accent).toLowerCase() === color.toLowerCase()}" style="--dv-swatch:${color}" aria-label="${color}"></button>`
    )).join("");
    return `
    <div class="dv-windowpanel">
        <h4>${esc(t("dev.create.windowTitle"))}</h4>
        <p>${esc(t("dev.create.windowHint"))}</p>
        <div class="dv-preview" data-role="winpreview" style="aspect-ratio:${w.width} / ${w.height}">
            <div class="dv-preview__bar" data-role="winpreview-bar">
                <span class="dv-preview__dot"></span><span class="dv-preview__dot"></span><span class="dv-preview__dot"></span>
                <span class="dv-preview__title" data-role="winpreview-title">${esc(draft.name || t("dev.create.preview"))}</span>
            </div>
            <div class="dv-preview__body">
                <div class="dv-preview__frame">
                    <span class="dv-preview__line dv-preview__line--accent"></span>
                    <span class="dv-preview__line"></span>
                    <span class="dv-preview__line dv-preview__line--short"></span>
                </div>
            </div>
        </div>
        <div class="dv-grid2">
            ${[["width", "dev.create.width"], ["height", "dev.create.height"], ["minWidth", "dev.create.minWidth"], ["minHeight", "dev.create.minHeight"]].map(([key, labelKey]) => (
                `<label class="dv-number"><span>${esc(t(labelKey))}</span><input type="number" data-win="${key}" value="${w[key]}" min="1" step="1" /></label>`
            )).join("")}
        </div>
        ${[["resizable", "dev.create.resizable"], ["draggable", "dev.create.draggable"], ["titlebar", "dev.create.titlebar"]].map(([key, labelKey]) => (
            `<div class="dv-switchrow"><span>${esc(t(labelKey))}</span><button class="dv-switch" type="button" role="switch" aria-checked="${w[key] ? "true" : "false"}" data-switch="${key}" aria-label="${esc(t(labelKey))}"></button></div>`
        )).join("")}
        <div class="dv-switchrow">
            <span>${esc(t("dev.create.accent"))}</span>
            <div class="dv-swatches">
                <button class="dv-swatch dv-swatch--system" type="button" data-accent="" aria-checked="${w.accent ? "false" : "true"}" aria-label="${esc(t("dev.create.accentSystem"))}"></button>
                ${swatches}
                <input class="dv-color" type="color" data-color="accent" value="${esc(w.accent || "#2078DA")}" aria-label="${esc(t("dev.create.accentCustom"))}" />
            </div>
        </div>
    </div>`;
}

function fieldsHtml(isPage) {
    const draft = state.draft;
    return `
    <div class="dv-field">
        <label class="dv-label" for="dv-name">${esc(t("dev.create.nameLabel"))}</label>
        <input class="dv-input" id="dv-name" data-field="name" type="text" maxlength="80" value="${esc(draft.name)}" placeholder="${esc(t("dev.create.namePlaceholder"))}" />
    </div>
    <div class="dv-field">
        <span class="dv-label">${esc(t("dev.create.iconLabel"))}</span>
        <div class="dv-iconrow">
            <div class="dv-iconpreview" data-role="icon-preview">${iconPreviewHtml()}</div>
            <div class="dv-iconrow-actions">
                <button class="dv-btn dv-btn--sm" type="button" data-action="pick-icon">${esc(t("dev.create.changeIcon"))}</button>
                <button class="dv-btn dv-btn--ghost dv-btn--sm" type="button" data-action="reset-icon">${esc(t("dev.create.resetIcon"))}</button>
            </div>
        </div>
    </div>
    <div class="dv-field">
        <label class="dv-label" for="dv-desc">${esc(t("dev.create.descLabel"))}</label>
        <textarea class="dv-textarea" id="dv-desc" data-field="description" maxlength="280" placeholder="${esc(t("dev.create.descPlaceholder"))}">${esc(draft.description)}</textarea>
    </div>
    ${isPage ? "" : `
    <div class="dv-field">
        <span class="dv-label">${esc(t("dev.create.typeLabel"))}</span>
        <div class="dv-kinds">
            <button class="dv-kind${draft.kind === "shortcut" ? " active" : ""}" type="button" data-kind="shortcut">
                <span class="dv-kind__dot"></span>
                <span class="dv-kind__text"><span class="dv-kind__name">${esc(t("dev.create.typeShortcut"))}</span><span class="dv-kind__hint">${esc(t("dev.create.typeShortcutHint"))}</span></span>
            </button>
            <button class="dv-kind${draft.kind === "window" ? " active" : ""}" type="button" data-kind="window">
                <span class="dv-kind__dot"></span>
                <span class="dv-kind__text"><span class="dv-kind__name">${esc(t("dev.create.typeWindow"))}</span><span class="dv-kind__hint">${esc(t("dev.create.typeWindowHint"))}</span></span>
            </button>
        </div>
    </div>`}`;
}

function editorHtml() {
    const draft = state.draft;
    const tabs = [["html", "dev.create.html"], ["css", "dev.create.css"], ["js", "dev.create.js"]];
    const options = [["blank", "dev.create.templateBlank"], ["card", "dev.create.templateCard"], ["board", "dev.create.templateBoard"]];
    return `
    <div class="dv-field">
        <label class="dv-label" for="dv-template">${esc(t("dev.create.template"))}</label>
        <select class="dv-select" id="dv-template" data-role="template-select">
            ${options.map(([value, key]) => `<option value="${value}"${draft.template === value ? " selected" : ""}>${esc(t(key))}</option>`).join("")}
        </select>
    </div>
    <div class="dv-field">
        <div class="dv-editor-head">
            <div class="dv-codetabs">
                ${tabs.map(([key, labelKey]) => `<button class="dv-codetab${draft.pageTab === key ? " active" : ""}" type="button" data-codetab="${key}">${esc(t(labelKey))}</button>`).join("")}
            </div>
            <span class="dv-editor-meta" data-role="editor-meta"></span>
        </div>
        <textarea class="dv-code" data-code="${draft.pageTab}" spellcheck="false" autocomplete="off">${esc(draft.page[draft.pageTab] || "")}</textarea>
    </div>
    <div class="dv-field">
        <div class="dv-previewbox">
            <div class="dv-previewbox__head">
                <span>${esc(t("dev.create.preview"))}</span>
                <button class="dv-btn dv-btn--sm" type="button" data-action="refresh-preview">${esc(t("dev.create.previewBtn"))}</button>
            </div>
            <div class="dv-previewbox__empty" data-role="preview-empty">${esc(t("dev.create.previewEmpty"))}</div>
            <iframe class="dv-pagepreview" data-role="page-preview" sandbox="" title="${esc(t("dev.create.preview"))}" hidden></iframe>
        </div>
    </div>`;
}

function renderForm() {
    const pane = paneEl("form");
    const draft = state.draft;
    if (!pane || !draft) return;
    const isPage = draft.mode === "page";
    const showWindow = isPage || draft.kind === "window";

    pane.innerHTML = `
    <div class="dv-tabs">
        <button class="dv-tab${!isPage ? " active" : ""}" type="button" data-tabs="url">${esc(t("dev.create.tabUrl"))}</button>
        <button class="dv-tab${isPage ? " active" : ""}" type="button" data-tabs="page">${esc(t("dev.create.tabPage"))}</button>
    </div>
    <form class="dv-form" novalidate>
        <div class="dv-form-grid${showWindow ? "" : " dv-form-grid--page"}">
            <div>
                ${isPage ? "" : `
                <div class="dv-field">
                    <label class="dv-label" for="dv-url">${esc(t("dev.create.urlLabel"))}</label>
                    <div class="dv-urlrow">
                        <input class="dv-input" id="dv-url" data-field="url" type="text" inputmode="url" value="${esc(draft.url)}" placeholder="${esc(t("dev.create.urlPlaceholder"))}" />
                        <button class="dv-btn" type="button" data-action="fetch">${esc(t("dev.create.fetch"))}</button>
                    </div>
                    <div class="dv-field-note" data-role="fetch-note"></div>
                </div>`}
                ${fieldsHtml(isPage)}
                ${isPage ? editorHtml() : ""}
            </div>
            ${showWindow ? `<aside>${windowPanelHtml()}</aside>` : ""}
        </div>
        <div class="dv-form-actions">
            <div class="dv-form-error" data-role="form-error"></div>
            <button class="dv-btn" type="button" data-action="cancel-form">${esc(t("dev.create.cancel"))}</button>
            <button class="dv-btn dv-btn--primary" type="submit">${esc(draft.editing ? t("dev.create.submitEdit") : t("dev.create.submit"))}</button>
        </div>
    </form>`;

    bindForm();
    updateEditorMeta();
    updateWindowPreview();
    updatePagePreview();
}

function bindForm() {
    const pane = paneEl("form");
    if (!pane) return;
    const query = (selector) => pane.querySelector(selector);

    const urlInput = query('[data-field="url"]');
    if (urlInput) {
        urlInput.addEventListener("input", () => {
            state.draft.url = urlInput.value;
            if (!state.draft.nameTouched) {
                state.draft.name = titleFromUrl(normalizeUrl(urlInput.value) || "");
                const nameInput = query('[data-field="name"]');
                if (nameInput) nameInput.value = state.draft.name;
                syncLetter();
                updateIconPreview();
                updateWindowPreview();
            }
        });
    }

    const nameInput = query('[data-field="name"]');
    if (nameInput) {
        nameInput.addEventListener("input", () => {
            state.draft.name = nameInput.value;
            state.draft.nameTouched = true;
            syncLetter();
            updateIconPreview();
            updateWindowPreview();
        });
    }

    const descInput = query('[data-field="description"]');
    if (descInput) {
        descInput.addEventListener("input", () => { state.draft.description = descInput.value; });
    }

    pane.querySelectorAll("[data-win]").forEach((input) => {
        input.addEventListener("input", () => {
            const key = input.dataset.win;
            const value = Number(input.value);
            if (!Number.isFinite(value)) return;
            state.draft.window[key] = Math.round(value);
            updateWindowPreview();
        });
        input.addEventListener("blur", () => {
            state.draft.window = normalizeWindow(state.draft.window);
            input.value = String(state.draft.window[input.dataset.win]);
            updateWindowPreview();
        });
    });

    const colorInput = query('[data-color="accent"]');
    if (colorInput) {
        colorInput.addEventListener("input", () => {
            state.draft.window.accent = colorInput.value.toLowerCase();
            updateWindowPreview();
        });
    }

    const templateSelect = query('[data-role="template-select"]');
    if (templateSelect) {
        templateSelect.addEventListener("change", () => {
            applyTemplate(templateSelect.value);
        });
    }

    const code = query("[data-code]");
    if (code) {
        code.addEventListener("input", () => {
            state.draft.page[state.draft.pageTab] = code.value;
            updateEditorMeta();
        });
    }

    const form = pane.querySelector("form");
    if (form) {
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            submitDraft();
        });
    }
}

function updateIconPreview() {
    const box = paneEl("form") && paneEl("form").querySelector('[data-role="icon-preview"]');
    if (!box) return;
    box.innerHTML = iconPreviewHtml();
}

function updateWindowPreview() {
    const draft = state.draft;
    const pane = paneEl("form");
    if (!draft || !pane) return;
    const preview = pane.querySelector('[data-role="winpreview"]');
    if (!preview) return;
    const w = draft.window;
    preview.style.aspectRatio = `${w.width} / ${w.height}`;
    const bar = pane.querySelector('[data-role="winpreview-bar"]');
    if (bar) bar.hidden = !w.titlebar;
    const title = pane.querySelector('[data-role="winpreview-title"]');
    if (title) title.textContent = draft.name || hostOf(draft.url) || t("dev.create.preview");
    preview.style.setProperty("--dv-preview-accent", w.accent || "var(--accent, #2078DA)");
}

function updateEditorMeta() {
    const draft = state.draft;
    const pane = paneEl("form");
    if (!draft || !pane || draft.mode !== "page") return;
    const meta = pane.querySelector('[data-role="editor-meta"]');
    if (meta) meta.textContent = `${(draft.page[draft.pageTab] || "").length}`;
}

function updatePagePreview() {
    const draft = state.draft;
    const pane = paneEl("form");
    if (!draft || !pane || draft.mode !== "page") return;
    const frame = pane.querySelector('[data-role="page-preview"]');
    const empty = pane.querySelector('[data-role="preview-empty"]');
    if (!frame || !empty) return;
    const hasContent = Boolean((draft.page.html || "").trim() || (draft.page.css || "").trim());
    empty.hidden = hasContent;
    frame.hidden = !hasContent;
    if (hasContent) frame.srcdoc = buildPreviewDocument({ page: draft.page });
}

function applyTemplate(name) {
    const template = PAGE_TEMPLATES[name];
    if (!template) return;
    state.draft.page = { ...template };
    state.draft.pageTab = "html";
    state.draft.template = name;
    renderForm();
}

function switchMode(mode) {
    const draft = state.draft;
    if (!draft || draft.mode === mode) return;
    draft.mode = mode;
    if (mode === "page") {
        draft.kind = "page";
        if (!(draft.page.html || "").trim() && !(draft.page.css || "").trim() && !(draft.page.js || "").trim()) {
            draft.page = { ...PAGE_TEMPLATES.blank };
            draft.template = "blank";
        }
    } else {
        if (draft.kind === "page") draft.kind = "shortcut";
    }
    renderForm();
}

function switchCodeTab(tab) {
    const draft = state.draft;
    const pane = paneEl("form");
    if (!draft || !pane || draft.pageTab === tab) return;
    const code = pane.querySelector("[data-code]");
    if (code) draft.page[draft.pageTab] = code.value;
    draft.pageTab = tab;
    renderForm();
}

function formError(text) {
    const node = paneEl("form") && paneEl("form").querySelector('[data-role="form-error"]');
    if (node) node.textContent = text || "";
}

function syncDraftInputs() {
    const draft = state.draft;
    const pane = paneEl("form");
    if (!draft || !pane) return;
    const read = (name) => {
        const input = pane.querySelector(`[data-field="${name}"]`);
        return input ? input.value : null;
    };
    const url = read("url");
    if (url != null) draft.url = url;
    const name = read("name");
    if (name != null) draft.name = name;
    const description = read("description");
    if (description != null) draft.description = description;
    const code = pane.querySelector("[data-code]");
    if (code) draft.page[draft.pageTab] = code.value;
}

async function submitDraft() {
    const draft = state.draft;
    if (!draft) return;
    syncDraftInputs();
    formError("");

    const isPage = draft.mode === "page";
    const kind = isPage ? "page" : draft.kind;
    const name = (draft.name || "").trim();
    if (!name) {
        formError(t("dev.create.errName"));
        return;
    }
    const url = isPage ? "" : normalizeUrl(draft.url);
    if (!isPage && !url) {
        formError(t("dev.create.errUrl"));
        return;
    }
    if (isPage && !(draft.page.html || "").trim() && !(draft.page.css || "").trim() && !(draft.page.js || "").trim()) {
        formError(t("dev.create.errPage"));
        return;
    }

    if (isPage && (draft.page.js || "").trim() && draft.page.js !== draft.originalJs && !draft.scriptConfirmed) {
        const ok = await showDialog({
            title: t("dev.create.scriptConfirmTitle"),
            body: p(t("dev.create.scriptConfirmText")),
            buttons: [
                { label: t("dev.dialog.cancel"), value: false },
                { label: t("dev.create.submit"), value: true, primary: true },
            ],
        });
        if (!ok) return;
        draft.scriptConfirmed = true;
    }

    const normalized = normalizeSpec({
        name,
        kind,
        url,
        description: draft.description,
        window: draft.window,
        page: isPage ? draft.page : {},
        icon: { ...draft.icon, letter: draft.icon.letter || draftLetter() },
        createdAt: undefined,
    }, { id: draft.editing ? draft.id : undefined });

    if (!normalized.ok) {
        const code = normalized.error && normalized.error.code;
        formError(code === "PAGE" ? t("dev.create.errPage") : code === "NAME" ? t("dev.create.errName") : code === "URL" ? t("dev.create.errUrl") : specErrorText(normalized.error));
        return;
    }

    const record = touch(normalized.record);
    if (!record.icon.letter) record.icon.letter = draftLetter();
    if (!draft.editing && getRecord(state.library, record.id)) {
        record.id = makeId(record.name, `${record.url}-${Date.now()}`);
    }

    const submit = paneEl("form") && paneEl("form").querySelector('button[type="submit"]');
    if (submit) {
        submit.disabled = true;
        submit.textContent = draft.editing ? t("dev.create.saving") : t("dev.create.creating");
    }

    const original = draft.editing ? getRecord(state.library, draft.id) : null;
    try {
        upsertRecord(state.library, record);
        await saveLibrary(state.library);
    } catch (err) {
        formError(t("dev.create.storageFailed"));
        if (submit) {
            submit.disabled = false;
            submit.textContent = draft.editing ? t("dev.create.submitEdit") : t("dev.create.submit");
        }
        return;
    }

    let installProblem = "";
    if (record.kind === "shortcut") {
        if (original && original.kind !== "shortcut") {
            await uninstallRecord(record.id);
        }
    } else {
        const result = await installRecord(record, { overwrite: !!draft.editing });
        if (!result.ok) installProblem = result.reason || result.code || "install";
    }

    const editing = draft.editing;
    state.draft = null;
    state.current = editing ? "manage" : "home";
    renderAll();

    if (installProblem) {
        const cancelled = /取消|cancel/i.test(installProblem);
        toast(cancelled ? t("dev.create.installCancelled") : fill(t("dev.create.installFailed"), { reason: installProblem }), true);
    } else {
        toast(editing ? t("dev.create.updated") : t("dev.create.created"));
    }
}

async function fetchSiteInfo(button) {
    const draft = state.draft;
    if (!draft) return;
    const pane = paneEl("form");
    const input = pane.querySelector('[data-field="url"]');
    const note = pane.querySelector('[data-role="fetch-note"]');
    const url = normalizeUrl(input ? input.value : draft.url);
    if (!url) {
        formError(t("dev.create.errUrl"));
        return;
    }
    draft.url = url;
    if (input) input.value = url;
    formError("");

    const access = await requestSiteAccess(url);
    if (access === "denied") {
        if (!draft.nameTouched) draft.name = titleFromUrl(url);
        syncLetter();
        if (note) {
            note.textContent = t("dev.create.fetchDenied");
            note.classList.add("is-warn");
        }
        renderForm();
        return;
    }

    const label = button ? button.textContent : "";
    if (button) {
        button.disabled = true;
        button.textContent = t("dev.create.fetching");
    }
    const result = await captureSite(url);
    if (button) {
        button.disabled = false;
        button.textContent = label;
    }

    if (result.ok) {
        if (!draft.nameTouched && result.title) {
            draft.name = result.title;
            const nameInput = pane.querySelector('[data-field="name"]');
            if (nameInput) nameInput.value = result.title;
        }
        if (result.description && !draft.description) draft.description = result.description;
        if (result.iconData) applyIconData(draft, result.iconData);
        syncLetter();
        if (note) {
            note.textContent = t("dev.create.fetched");
            note.classList.remove("is-warn");
        }
    } else {
        if (!draft.nameTouched) draft.name = result.title || titleFromUrl(url);
        syncLetter();
        if (note) {
            note.textContent = t("dev.create.fetchFailed");
            note.classList.add("is-warn");
        }
    }
    renderForm();
    const nextNote = paneEl("form").querySelector('[data-role="fetch-note"]');
    if (nextNote && note) {
        nextNote.textContent = note.textContent;
        nextNote.classList.toggle("is-warn", note.classList.contains("is-warn"));
    }
}

/* ── manage ── */

function filteredRecords() {
    const keyword = state.manageKeyword.trim().toLowerCase();
    return state.library.plugins.filter((record) => {
        if (state.manageKind !== "all" && record.kind !== state.manageKind) return false;
        if (!keyword) return true;
        return [record.name, record.url, record.description, record.id]
            .some((value) => String(value || "").toLowerCase().includes(keyword));
    });
}

function renderManage() {
    const pane = paneEl("manage");
    if (!pane) return;
    const counts = {
        all: state.library.plugins.length,
        shortcut: state.library.plugins.filter((item) => item.kind === "shortcut").length,
        window: state.library.plugins.filter((item) => item.kind === "window").length,
        page: state.library.plugins.filter((item) => item.kind === "page").length,
    };
    const chips = [["all", "dev.manage.all"], ["shortcut", "dev.manage.shortcut"], ["window", "dev.manage.window"], ["page", "dev.manage.page"]];
    pane.innerHTML = `
        <div class="dv-managebar">
            <div class="dv-chips">
                ${chips.map(([key, labelKey]) => `<button class="dv-chip${state.manageKind === key ? " active" : ""}" type="button" data-filter="${key}">${esc(t(labelKey))} ${counts[key]}</button>`).join("")}
            </div>
            <input class="dv-search" type="search" data-role="manage-search" placeholder="${esc(t("dev.manage.search"))}" value="${esc(state.manageKeyword)}" />
            <span class="dv-count" data-role="manage-count"></span>
        </div>
        <div class="dv-list" data-role="manage-list"></div>`;
    const search = pane.querySelector('[data-role="manage-search"]');
    if (search) {
        search.addEventListener("input", () => {
            state.manageKeyword = search.value;
            renderManageList();
        });
    }
    renderManageList();
}

function renderManageList() {
    const pane = paneEl("manage");
    if (!pane) return;
    const list = pane.querySelector('[data-role="manage-list"]');
    const count = pane.querySelector('[data-role="manage-count"]');
    if (!list) return;
    const records = filteredRecords();
    if (count) count.textContent = fill(t("dev.manage.count"), { n: records.length });
    list.innerHTML = "";

    if (!records.length) {
        const empty = el("div", "dv-empty");
        empty.appendChild(el("strong", "dv-empty__title", t("dev.manage.empty")));
        empty.appendChild(p(t("dev.manage.emptyHint"), "dv-empty__hint"));
        if (state.library.plugins.length) {
            empty.querySelector(".dv-empty__title").textContent = t("dev.manage.noMatch");
        } else {
            const button = el("button", "dv-btn dv-btn--tinted", t("dev.home.primary"));
            button.type = "button";
            button.dataset.action = "create";
            empty.appendChild(button);
        }
        list.appendChild(empty);
        return;
    }

    records.forEach((record) => {
        const row = el("div", "dv-row");
        row.appendChild(iconNode(record, "dv-row__icon"));
        const main = el("div", "dv-row__main");
        const titleline = el("div", "dv-row__titleline");
        titleline.appendChild(el("span", "dv-row__name", record.name));
        titleline.appendChild(el("span", "dv-badge", kindLabel(record.kind)));
        if (record.kind !== "shortcut") {
            const installed = isInstalled(record);
            const badge = el("span", `dv-badge ${installed ? "dv-badge--ok" : "dv-badge--warn"}`, installed ? t("dev.manage.installed") : t("dev.manage.notInstalled"));
            titleline.appendChild(badge);
        }
        const meta = el("div", "dv-row__meta");
        const host = hostOf(record.url) || record.description || kindLabel(record.kind);
        meta.appendChild(el("span", "", host));
        meta.appendChild(el("span", "", fill(t("dev.manage.updatedAt"), { date: formatDate(record.updatedAt) })));
        main.append(titleline, meta);
        row.appendChild(main);

        const actions = el("div", "dv-row__actions");
        if (record.kind !== "shortcut" && !isInstalled(record)) {
            const reinstall = el("button", "dv-btn dv-btn--sm", t("dev.manage.reinstall"));
            reinstall.type = "button";
            reinstall.dataset.action = "reinstall";
            reinstall.dataset.id = record.id;
            actions.appendChild(reinstall);
        } else {
            const open = el("button", "dv-btn dv-btn--ghost dv-btn--sm", t("dev.manage.open"));
            open.type = "button";
            open.dataset.action = "open";
            open.dataset.id = record.id;
            actions.appendChild(open);
        }
        [["edit", "dev.manage.edit"], ["export", "dev.manage.export"]].forEach(([action, key]) => {
            const button = el("button", "dv-btn dv-btn--ghost dv-btn--sm", t(key));
            button.type = "button";
            button.dataset.action = action;
            button.dataset.id = record.id;
            actions.appendChild(button);
        });
        const uninstall = el("button", "dv-btn dv-btn--danger dv-btn--sm", t("dev.manage.uninstall"));
        uninstall.type = "button";
        uninstall.dataset.action = "uninstall";
        uninstall.dataset.id = record.id;
        actions.appendChild(uninstall);
        row.appendChild(actions);
        list.appendChild(row);
    });
}

async function openRecord(id) {
    const record = getRecord(state.library, id);
    if (!record) return;
    const result = await launchRecord(record);
    if (!result.ok) {
        toast(fill(t("dev.toast.launchFailed"), { reason: result.reason || "launch" }), true);
    }
}

async function reinstallRecord(id) {
    const record = getRecord(state.library, id);
    if (!record) return;
    const result = await installRecord(record, { overwrite: true });
    if (result.ok) {
        toast(t("dev.manage.reinstalled"));
        renderAll();
    } else {
        toast(fill(t("dev.toast.installFailed"), { reason: result.reason || "install" }), true);
    }
}

async function uninstall(id) {
    const record = getRecord(state.library, id);
    if (!record) return;
    const ok = await showDialog({
        title: t("dev.manage.uninstallTitle"),
        body: p(fill(t("dev.manage.uninstallText"), { name: record.name })),
        buttons: [
            { label: t("dev.dialog.cancel"), value: false },
            { label: t("dev.dialog.uninstall"), value: true, danger: true },
        ],
    });
    if (!ok) return;

    if (record.kind !== "shortcut") {
        const result = await uninstallRecord(record.id);
        if (result && result.ok === false && result.reason) {
            toast(fill(t("dev.toast.uninstallFailed"), { reason: result.reason }), true);
            return;
        }
    }
    try {
        removeRecord(state.library, record.id);
        await saveLibrary(state.library);
    } catch (err) {
        toast(t("dev.toast.storageFailed"), true);
        return;
    }
    toast(t("dev.manage.uninstalled"));
    renderAll();
}

/* ── settings ── */

function renderSettings() {
    const pane = paneEl("settings");
    if (!pane) return;
    const plugins = state.library.plugins;
    const bytes = estimateBytes(state.library);
    pane.innerHTML = `
    <div class="dv-settings">
        <section class="dv-card">
            <h3>${esc(t("dev.settings.storageTitle"))}</h3>
            <p>${esc(t("dev.settings.storageHint"))}</p>
            <dl class="dv-kv">
                <div><dt>${esc(t("dev.settings.storagePath"))}</dt><dd>/AppData/developers/library.json</dd></div>
                <div><dt>${esc(t("dev.settings.storageCount"))}</dt><dd>${plugins.length}</dd></div>
                <div><dt>${esc(t("dev.settings.storageSize"))}</dt><dd>${formatBytes(bytes)}</dd></div>
                <div><dt>${esc(t("dev.settings.storageSaved"))}</dt><dd>${esc(formatDate(state.library.updatedAt))}</dd></div>
            </dl>
        </section>
        <section class="dv-card">
            <h3>${esc(t("dev.settings.dataTitle"))}</h3>
            <p>${esc(t("dev.settings.dataHint"))}</p>
            <div class="dv-card__actions">
                <button class="dv-btn" type="button" data-action="export-all">${esc(t("dev.settings.exportAll"))}</button>
                <button class="dv-btn" type="button" data-action="import-file">${esc(t("dev.settings.importFile"))}</button>
            </div>
        </section>
        <section class="dv-card">
            <h3>${esc(t("dev.settings.specTitle"))}</h3>
            <p>${esc(t("dev.settings.specText"))}</p>
            <div class="dv-card__actions">
                <button class="dv-btn" type="button" data-action="copy-schema">${esc(t("dev.dialog.schema"))}</button>
                <button class="dv-btn" type="button" data-action="copy-example">${esc(t("dev.dialog.example"))}</button>
                <button class="dv-btn dv-btn--tinted" type="button" data-action="import-spec">${esc(t("dev.dialog.importTitle"))}</button>
            </div>
        </section>
        <section class="dv-card">
            <h3>${esc(t("dev.settings.maintenanceTitle"))}</h3>
            <div class="dv-card__actions">
                <button class="dv-btn" type="button" data-action="reinstall-all">${esc(t("dev.settings.reinstallAll"))}</button>
                <button class="dv-btn dv-btn--danger" type="button" data-action="clear-all">${esc(t("dev.settings.clearAll"))}</button>
            </div>
        </section>
        <section class="dv-card">
            <h3>${esc(t("dev.settings.uninstallTitle"))}</h3>
            <p>${esc(t("dev.settings.uninstallHint"))}</p>
            <div class="dv-uninstall-list" data-role="uninstall-list"></div>
        </section>
        <section class="dv-card">
            <h3>${esc(t("dev.settings.aboutTitle"))}</h3>
            <dl class="dv-kv">
                <div><dt>${esc(t("dev.settings.version"))}</dt><dd>1.0.0</dd></div>
            </dl>
            <p>${esc(t("dev.settings.builtinNote"))}</p>
        </section>
    </div>`;

    const list = pane.querySelector('[data-role="uninstall-list"]');
    if (!list) return;
    if (!plugins.length) {
        list.appendChild(p(t("dev.settings.noPlugins"), "dv-empty__hint"));
        return;
    }
    plugins.forEach((record) => {
        const row = el("div", "dv-uninstall-row");
        row.appendChild(iconNode(record, ""));
        const name = el("span", "dv-uninstall-row__name", record.name);
        const button = el("button", "dv-btn dv-btn--danger dv-btn--sm", t("dev.manage.uninstall"));
        button.type = "button";
        button.dataset.action = "uninstall";
        button.dataset.id = record.id;
        row.append(name, button);
        list.appendChild(row);
    });
}

async function reinstallAll() {
    const records = state.library.plugins.filter((record) => record.kind !== "shortcut");
    let failed = "";
    for (const record of records) {
        const result = await installRecord(record, { overwrite: true });
        if (!result.ok && !failed) failed = result.reason || result.code || "install";
    }
    if (failed) toast(fill(t("dev.toast.installFailed"), { reason: failed }), true);
    else toast(t("dev.manage.reinstalled"));
    renderAll();
}

async function clearAll() {
    if (!state.library.plugins.length) return;
    const ok = await showDialog({
        title: t("dev.settings.clearTitle"),
        body: p(t("dev.settings.clearText")),
        buttons: [
            { label: t("dev.dialog.cancel"), value: false },
            { label: t("dev.settings.clearAll"), value: true, danger: true },
        ],
    });
    if (!ok) return;
    for (const record of [...state.library.plugins]) {
        if (record.kind !== "shortcut") await uninstallRecord(record.id);
    }
    try {
        state.library.plugins = [];
        await saveLibrary(state.library);
    } catch (err) {
        toast(t("dev.toast.storageFailed"), true);
        return;
    }
    toast(t("dev.settings.cleared"));
    renderAll();
}

/* ── share / import / AI spec ── */

function exportRecord(id) {
    const record = getRecord(state.library, id);
    if (!record) return;
    downloadText(exportFilename(record), JSON.stringify(buildPackage(record), null, 2));
    toast(t("dev.toast.exported"));
}

function exportAll() {
    if (!state.library.plugins.length) return;
    const payload = {
        format: PACKAGE_FORMAT,
        formatVersion: PACKAGE_VERSION,
        exportedAt: new Date().toISOString(),
        plugins: state.library.plugins,
    };
    downloadText("developers-plugins.devplugin.json", JSON.stringify(payload, null, 2));
    toast(t("dev.toast.exported"));
}

function importDialog(prefill = "") {
    const wrap = el("div");
    wrap.appendChild(p(t("dev.dialog.importHint")));
    const tools = el("div", "dv-modal__tools");
    const schema = el("button", "dv-btn dv-btn--sm", t("dev.dialog.schema"));
    schema.type = "button";
    schema.onclick = async () => {
        if (await copyText(JSON.stringify(SPEC_SCHEMA_DOC, null, 2))) toast(t("dev.dialog.copied"));
        else toast(t("dev.dialog.copyFailed"), true);
    };
    const example = el("button", "dv-btn dv-btn--sm", t("dev.dialog.example"));
    example.type = "button";
    example.onclick = async () => {
        if (await copyText(JSON.stringify(SPEC_EXAMPLE, null, 2))) toast(t("dev.dialog.copied"));
        else toast(t("dev.dialog.copyFailed"), true);
    };
    tools.append(schema, example);
    const code = el("textarea", "dv-modal__code");
    code.spellcheck = false;
    code.placeholder = t("dev.dialog.importPlaceholder");
    code.value = prefill;
    const error = el("div", "dv-modal__error");
    wrap.append(tools, code, error);

    return showDialog({
        title: t("dev.dialog.importTitle"),
        body: wrap,
        buttons: [
            { label: t("dev.dialog.cancel"), value: null },
            {
                label: t("dev.dialog.import"),
                primary: true,
                onClick: () => {
                    if (!code.value.trim()) {
                        error.textContent = t("dev.dialog.invalid", "format");
                        return false;
                    }
                    return code.value;
                },
            },
        ],
        onMount: () => setTimeout(() => code.focus(), 30),
    });
}

async function runImport(text) {
    const parsed = parseImportText(text);
    if (!parsed.ok) {
        toast(specErrorText(parsed.error), true);
        return;
    }
    let imported = 0;
    let failed = 0;
    let reason = "";
    let scriptAsked = false;
    let scriptAllowed = false;

    for (let index = 0; index < parsed.specs.length; index += 1) {
        const spec = parsed.specs[index];
        let targetId = typeof spec.id === "string" && spec.id ? spec.id : undefined;
        const existing = targetId ? getRecord(state.library, targetId) : null;
        let overwrite = false;

        if (existing) {
            const choice = await showDialog({
                title: t("dev.dialog.overwriteTitle"),
                body: p(fill(t("dev.dialog.overwriteText"), { id: existing.id })),
                buttons: [
                    { label: t("dev.dialog.cancel"), value: null },
                    { label: t("dev.dialog.keepBoth"), value: "keep" },
                    { label: t("dev.dialog.overwrite"), value: "overwrite", primary: true },
                ],
            });
            if (!choice) return;
            if (choice === "keep") {
                targetId = makeId(spec.name || "plugin", `${existing.id}-${Date.now()}-${index}`);
            } else {
                targetId = existing.id;
                overwrite = true;
            }
        }

        const normalized = normalizeSpec(spec, { id: targetId });
        if (!normalized.ok) {
            failed += 1;
            if (!reason) reason = normalized.error && (normalized.error.detail || normalized.error.code);
            continue;
        }
        const record = touch(normalized.record);

        if (record.kind === "page" && (record.page.js || "").trim()) {
            if (!scriptAsked) {
                scriptAsked = true;
                scriptAllowed = await showDialog({
                    title: t("dev.create.scriptConfirmTitle"),
                    body: p(t("dev.create.scriptConfirmText")),
                    buttons: [
                        { label: t("dev.dialog.cancel"), value: false },
                        { label: t("dev.dialog.import"), value: true, primary: true },
                    ],
                });
            }
            if (!scriptAllowed) continue;
        }

        try {
            upsertRecord(state.library, record);
            await saveLibrary(state.library);
        } catch (err) {
            toast(t("dev.toast.storageFailed"), true);
            return;
        }

        if (record.kind !== "shortcut") {
            const result = await installRecord(record, { overwrite });
            if (!result.ok) {
                failed += 1;
                if (!reason) reason = result.reason || result.code || "install";
            }
        }
        imported += 1;
    }

    if (imported) toast(fill(t("dev.toast.imported"), { n: imported }));
    if (failed && !imported) toast(fill(t("dev.dialog.invalid"), { reason: reason || "format" }), true);
    else if (failed) toast(fill(t("dev.create.installFailed"), { reason: reason || "install" }), true);

    renderAll();
    if (imported && state.current !== "form") {
        state.current = "manage";
        renderAll();
    }
}

async function importFromFile(file) {
    if (!file) return;
    try {
        const text = await file.text();
        await runImport(text);
    } catch (err) {
        toast(t("dev.dialog.copyFailed"), true);
    }
}

/* ── icon picking ── */

async function pickIcon(file) {
    if (!file) return;
    try {
        const data = await iconFromFile(file);
        applyIconData(state.draft, data);
        updateIconPreview();
    } catch (err) {
        toast(err && err.code === "TOO_LARGE" ? t("dev.create.iconTooBig") : t("dev.create.iconReadFailed"), true);
    }
}

function resetIcon() {
    if (!state.draft) return;
    clearIconData(state.draft);
    syncLetter();
    updateIconPreview();
}

/* ── events ── */

function handleAction(action, data, button) {
    switch (action) {
        case "create":
            startCreate("url");
            break;
        case "new-page":
            startCreate("page");
            break;
        case "cancel-form": {
            const editing = state.draft && state.draft.editing;
            state.draft = null;
            state.current = editing ? "manage" : "home";
            renderAll();
            break;
        }
        case "import":
        case "import-spec":
            openImport();
            break;
        case "add-rec":
            addRecommended(Number(data.index), data.kind, button);
            break;
        case "open":
            openRecord(data.id);
            break;
        case "edit":
            startEdit(data.id);
            break;
        case "export":
            exportRecord(data.id);
            break;
        case "uninstall":
            uninstall(data.id);
            break;
        case "reinstall":
            reinstallRecord(data.id);
            break;
        case "export-all":
            exportAll();
            break;
        case "import-file": {
            const input = role("import-file");
            if (input) {
                input.value = "";
                input.click();
            }
            break;
        }
        case "reinstall-all":
            reinstallAll();
            break;
        case "clear-all":
            clearAll();
            break;
        case "copy-schema":
            copyText(JSON.stringify(SPEC_SCHEMA_DOC, null, 2)).then((ok) => {
                toast(ok ? t("dev.dialog.copied") : t("dev.dialog.copyFailed"), !ok);
            });
            break;
        case "copy-example":
            copyText(JSON.stringify(SPEC_EXAMPLE, null, 2)).then((ok) => {
                toast(ok ? t("dev.dialog.copied") : t("dev.dialog.copyFailed"), !ok);
            });
            break;
        case "fetch":
            fetchSiteInfo(button);
            break;
        case "pick-icon": {
            const input = role("icon-file");
            if (input) {
                input.value = "";
                input.click();
            }
            break;
        }
        case "reset-icon":
            resetIcon();
            break;
        case "refresh-preview":
            updatePagePreview();
            break;
        default:
            break;
    }
}

async function openImport() {
    const text = await importDialog();
    if (!text) return;
    await runImport(text);
}

win.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-nav]");
    if (nav) {
        navTo(nav.dataset.nav);
        return;
    }

    const tab = event.target.closest("[data-tabs]");
    if (tab) {
        switchMode(tab.dataset.tabs);
        return;
    }

    const codeTab = event.target.closest("[data-codetab]");
    if (codeTab) {
        switchCodeTab(codeTab.dataset.codetab);
        return;
    }

    const kind = event.target.closest("[data-kind]");
    if (kind && kind.classList.contains("dv-kind")) {
        state.draft.kind = kind.dataset.kind;
        renderForm();
        return;
    }

    const filter = event.target.closest("[data-filter]");
    if (filter) {
        state.manageKind = filter.dataset.filter;
        renderManage();
        return;
    }

    const swatch = event.target.closest("[data-accent]");
    if (swatch) {
        state.draft.window.accent = swatch.dataset.accent;
        renderForm();
        return;
    }

    const toggle = event.target.closest("[data-switch]");
    if (toggle) {
        const key = toggle.dataset.switch;
        state.draft.window[key] = !state.draft.window[key];
        toggle.setAttribute("aria-checked", state.draft.window[key] ? "true" : "false");
        updateWindowPreview();
        return;
    }

    const action = event.target.closest("[data-action]");
    if (action && !action.disabled) {
        handleAction(action.dataset.action, action.dataset, action);
        return;
    }

    if (event.target === role("modal") && state.dialog) {
        state.dialog.close(null);
    }
});

const iconFile = role("icon-file");
if (iconFile) {
    iconFile.addEventListener("change", () => {
        const file = iconFile.files && iconFile.files[0];
        pickIcon(file);
    });
}

const importFile = role("import-file");
if (importFile) {
    importFile.addEventListener("change", () => {
        const file = importFile.files && importFile.files[0];
        importFromFile(file);
    });
}

/* ── boot ── */

async function boot() {
    try {
        state.library = await loadLibrary();
    } catch (err) {
        state.library = { version: 1, updatedAt: "", plugins: [] };
        toast(t("dev.toast.storageFailed"), true);
    }
    renderAll();
}

boot();
