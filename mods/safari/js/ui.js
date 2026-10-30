/** 通用 UI 原语：提示条、确认框、菜单行、浮层定位、上下文菜单。 */

import { app } from "./app.js";
import { escapeHtml, icon } from "./utils.js";

export function isMenuOpen(element) {
    return !!element && !element.hidden;
}

export function canUse(element) {
    return !!element && !element.hidden && element.isConnected;
}

export function showToast(text) {
    const toast = app.dom.toast;
    if (!toast) return;
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(app.state.toastTimer);
    app.state.toastTimer = setTimeout(() => {
        toast.hidden = true;
    }, 1800);
}

export function askConfirm({ title, message, okLabel = "确定" }) {
    if (app.state.confirmResolver) {
        const previous = app.state.confirmResolver;
        app.state.confirmResolver = null;
        previous(false);
    }
    const d = app.dom;
    d.confirmTitle.textContent = title;
    d.confirmMessage.textContent = message;
    d.confirmOk.textContent = okLabel;
    d.confirm.hidden = false;
    d.confirmCancel.focus();
    return new Promise((resolve) => {
        app.state.confirmResolver = resolve;
    });
}

export function settleConfirm(value) {
    const resolver = app.state.confirmResolver;
    app.state.confirmResolver = null;
    if (app.dom.confirm) app.dom.confirm.hidden = true;
    if (resolver) resolver(value);
}

export function makeMenuRow({ iconName, label, key, checked, danger, disabled, onClick }) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "safari-menu-row" + (danger ? " is-danger" : "");
    row.setAttribute("role", "menuitem");
    row.disabled = disabled === true;
    row.innerHTML = (iconName ? icon(iconName) : "") +
        `<span class="safari-menu-label">${escapeHtml(label)}</span>` +
        (checked ? `<span class="safari-menu-check">${icon("check")}</span>` : "") +
        (key ? `<span class="safari-menu-key">${escapeHtml(key)}</span>` : "");
    if (onClick) row.addEventListener("click", onClick);
    return row;
}

export function makeSeparator() {
    const line = document.createElement("div");
    line.className = "safari-menu-sep";
    return line;
}

/** 只负责收起，不负责清空内容；重新打开时会重建。 */
export function closeMenus() {
    const d = app.dom;
    if (!d.pageMenu) return;
    d.pageMenu.hidden = true;
    d.shareMenu.hidden = true;
    d.tabList.hidden = true;
    d.editPanel.hidden = true;
    d.contextMenu.hidden = true;
    d.tabgroupBtn.setAttribute("aria-expanded", "false");
    d.shareBtn.setAttribute("aria-expanded", "false");
    d.editBtn.setAttribute("aria-expanded", "false");
    const pageButton = d.tabsEl ? d.tabsEl.querySelector(".safari-tab-pagebtn") : null;
    if (pageButton) pageButton.setAttribute("aria-expanded", "false");
}

/** 浮层已渲染后调用：只做窗口内钳制。 */
export function placePopover(element, left, top, clampToToolbar = true) {
    const maxLeft = app.root.clientWidth - element.offsetWidth - 8;
    const maxTop = app.root.clientHeight - element.offsetHeight - 8;
    let x = Math.min(Math.max(left, 8), Math.max(8, maxLeft));
    let y = Math.min(top, Math.max(8, maxTop));
    if (clampToToolbar) y = Math.max(app.dom.toolbar.offsetHeight + 4, y);
    element.style.left = `${Math.round(x)}px`;
    element.style.top = `${Math.round(y)}px`;
}

export function openContextMenu(x, y, items) {
    closeMenus();
    app.api.suggestions?.close?.();
    const menu = app.dom.contextMenu;
    menu.replaceChildren();
    for (const item of items) {
        if (item.separator) {
            menu.appendChild(makeSeparator());
            continue;
        }
        menu.appendChild(makeMenuRow({
            label: item.label,
            key: item.key,
            danger: item.danger,
            disabled: item.disabled,
            onClick: () => {
                closeMenus();
                if (item.action) item.action();
            },
        }));
    }
    menu.style.width = "224px";
    menu.hidden = false;
    const rootRect = app.root.getBoundingClientRect();
    const width = menu.offsetWidth || 224;
    const height = menu.offsetHeight || 120;
    let left = Math.min(Math.max(x - rootRect.left, 8), Math.max(8, app.root.clientWidth - width - 8));
    let top = y - rootRect.top;
    if (top + height > app.root.clientHeight - 8) top -= height + 4;
    top = Math.min(Math.max(top, app.dom.toolbar.offsetHeight + 4), Math.max(8, app.root.clientHeight - height - 8));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
}
