/**
 * widgets/center.js —— 小组件中心（F-18）
 *
 * macOS 长按小组件进入的「编辑小组件」浮层的等价物：
 * - 上半：可用类型清单（含尺寸档），可加入通知中心或桌面；
 * - 中间：当前布局清单（两个容器分别列出，可移除）；
 * - 底部：桌面编辑模式开关（抖动 + 删除角标 + 拖拽）、完成。
 *
 * 入口：通知中心底部「编辑小组件…」按钮（F-17）。桌面 Control+点按入口归
 * 桌面右键菜单（desktop.js，本批次不动其区域），暂缺 —— 见批次报告。
 */

import { i18n } from "../i18n.js";
import { Z } from "../zindex.js";
import { SIZE_LABEL, REGISTRY_EVENT, listTypes, typeLabel } from "./registry.js";
import { host } from "./host.js";

let overlayEl = null;

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}

function sizeChips(def, current, onPick) {
    const wrap = el("div", "wc-sizes");
    def.sizes.forEach((s) => {
        const pair = SIZE_LABEL[s] || [null, s];
        const chip = el("button", `wc-size${s === current ? " is-active" : ""}`, pair[1]);
        chip.type = "button";
        chip.addEventListener("click", () => onPick(s));
        wrap.appendChild(chip);
    });
    return wrap;
}

function buildTypeRow(def) {
    const row = el("div", "wc-type");
    const head = el("div", "wc-type__head");
    head.appendChild(el("p", "wc-type__name", typeLabel(def.id)));
    let picked = def.sizes[0];
    head.appendChild(sizeChips(def, picked, (s) => { picked = s; }));
    row.appendChild(head);
    const actions = el("div", "wc-type__actions");
    const toCenter = el("button", "wc-add", i18n.t("widgets.addToCenter", "加入通知中心"));
    toCenter.type = "button";
    toCenter.addEventListener("click", () => host.addWidget({ type: def.id, size: picked, container: "center" }));
    const toDesktop = el("button", "wc-add", i18n.t("widgets.addToDesktop", "加入桌面"));
    toDesktop.type = "button";
    toDesktop.addEventListener("click", () => host.addWidget({ type: def.id, size: picked, container: "desktop" }));
    actions.append(toCenter, toDesktop);
    row.appendChild(actions);
    return row;
}

function buildLayoutSection(title, containerId) {
    const box = el("div", "wc-section");
    box.appendChild(el("p", "wc-section__title", title));
    const items = host.layoutItems ? host.layoutItems(containerId) : [];
    if (!items.length) {
        box.appendChild(el("p", "wc-empty", i18n.t("widgets.emptyContainer", "此容器还没有小组件")));
        return box;
    }
    items.forEach((it) => {
        const row = el("div", "wc-layout-row");
        row.appendChild(el("span", "wc-layout-row__name", typeLabel(it.type)));
        row.appendChild(el("span", "wc-layout-row__size", (SIZE_LABEL[it.size] || [null, it.size])[1]));
        const rm = el("button", "wc-remove", i18n.t("widgets.remove", "移除"));
        rm.type = "button";
        rm.addEventListener("click", () => host.removeWidget(it.id));
        row.appendChild(rm);
        box.appendChild(row);
    });
    return box;
}

function renderBody() {
    if (!overlayEl) return;
    const card = overlayEl.querySelector(".wc-card");
    card.innerHTML = "";

    const title = el("p", "wc-title", i18n.t("widgets.centerTitle", "编辑小组件"));
    card.appendChild(title);

    const gallery = el("div", "wc-section");
    gallery.appendChild(el("p", "wc-section__title", i18n.t("widgets.gallery", "可用小组件")));
    listTypes().forEach((def) => gallery.appendChild(buildTypeRow(def)));
    card.appendChild(gallery);

    card.appendChild(buildLayoutSection(i18n.t("widgets.sectionCenter", "通知中心"), "center"));
    card.appendChild(buildLayoutSection(i18n.t("widgets.sectionDesktop", "桌面"), "desktop"));

    const foot = el("div", "wc-foot");
    const editBtn = el("button", `wc-foot__edit${host.isEditMode() ? " is-active" : ""}`,
        i18n.t("widgets.editMode", "编辑桌面小组件"));
    editBtn.type = "button";
    editBtn.addEventListener("click", () => {
        const on = host.setEditMode(!host.isEditMode());
        editBtn.classList.toggle("is-active", on);
    });
    const done = el("button", "wc-done", i18n.t("widgets.close", "完成"));
    done.type = "button";
    done.addEventListener("click", () => close());
    foot.append(editBtn, done);
    card.appendChild(foot);
}

function buildOverlay() {
    overlayEl = el("div", "wc-overlay");
    overlayEl.setAttribute("role", "dialog");
    overlayEl.setAttribute("aria-label", i18n.t("widgets.centerTitle", "编辑小组件"));
    overlayEl.style.cssText = `position:fixed;inset:0;z-index:${Z.MODAL};display:flex;align-items:center;justify-content:center;`;
    const backdrop = el("div", "wc-backdrop");
    backdrop.style.cssText = "position:absolute;inset:0;background:rgba(0,0,0,0.25);";
    overlayEl.appendChild(backdrop);
    const card = el("div", "wc-card");
    overlayEl.appendChild(card);
    globalThis.__surface?.apply?.(card, { role: 3 });
    backdrop.addEventListener("click", () => close());
    document.body.appendChild(overlayEl);
    overlayEl.addEventListener("widgets-editmode-change", () => renderBody());
    renderBody();
}

export function open() {
    if (overlayEl) { renderBody(); overlayEl.style.display = "flex"; return; }
    buildOverlay();
}

export function close() {
    host.setEditMode(false);
    if (overlayEl) overlayEl.style.display = "none";
}

export function isOpen() {
    return Boolean(overlayEl) && overlayEl.style.display !== "none";
}

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close();
});
document.addEventListener(REGISTRY_EVENT, () => {
    if (overlayEl) renderBody();
});
