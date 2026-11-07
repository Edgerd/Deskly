/**
 * contextMenu.js — 右键菜单与桌面新建文件
 */
import { Z } from "../zindex.js";
import { FOLDER_ICON, GENERIC_DOC_ICON } from "../paths.js";
import { appendDesktopItem, makeDraggable } from "./desktopItems.js";

/**
 * 摘掉菜单挂载的 document 级关闭监听。
 * 菜单被下一次 createContextMenu 顶替、或被菜单项 action 关掉时也必须注销，
 * 否则监听器永久挂在 document 上，闭包钉住已脱离文档的菜单 DOM。
 * @param {HTMLElement} menu 菜单元素
 */
function detachMenu(menu) {
    // 菜单在延后注册监听的那一拍之前就被顶替/移除时，必须取消待执行的注册，
    // 否则 closeMenu 会永久挂在 document 上、闭包钉住已脱离文档的菜单 DOM。
    if (menu._closeTimeout) { clearTimeout(menu._closeTimeout); menu._closeTimeout = null; }
    menu._removed = true;
    if (menu._closeListener) {
        document.removeEventListener("click", menu._closeListener);
        menu._closeListener = null;
    }
    if (menu._keyListener) {
        document.removeEventListener("keydown", menu._keyListener);
        menu._keyListener = null;
    }
    if (menu._pointerListener) {
        document.removeEventListener("pointerdown", menu._pointerListener, true);
        menu._pointerListener = null;
    }
}

function removeMenu(menu) {
    detachMenu(menu);
    menu.remove();
}

/**
 * 清理分隔符：去掉开头、结尾以及连续出现的分隔符。
 * 调用方按组拼菜单时中间组可能整个为空，容易留下悬空或相连的分隔符，渲染前统一收敛。
 * @param {Array<object>} items 原始菜单项
 * @returns {Array<object>} 清理后的菜单项
 */
function normalizeMenuItems(items) {
    const out = [];
    (Array.isArray(items) ? items : []).forEach((item) => {
        if (!item) return;
        if (item.type === "separator") {
            if (!out.length || out[out.length - 1].type === "separator") return;
            out.push(item);
            return;
        }
        out.push(item);
    });
    while (out.length && out[out.length - 1].type === "separator") out.pop();
    return out;
}

/**
 * 在指定坐标创建右键菜单。
 * @param {number} x 视口横坐标
 * @param {number} y 视口纵坐标
 * @param {Array<object>} items 菜单项（{label, action, disabled, checked, hasSubmenu, type:"separator"|"header"}）
 * @returns {HTMLElement} 菜单元素
 */
export function createContextMenu(x, y, items) {
    const existingMenu = document.querySelector("div.menu.contextmenu");
    if (existingMenu) removeMenu(existingMenu);

    const menu = document.createElement("div");
    menu.classList.add("menu", "contextmenu", "visible");
    menu.style.opacity = "1";
    // 固定层级（见 zindex.js 层级表）。不再遍历全页取最高 z-index：
    // 那是每次右键一次全量强制样式计算，且会被亮度遮罩（2147483646）带跑成
    // INT_MAX，再被 zindex.js 的 9499 封顶拉回 Dock 之下 —— 菜单两头都不对。
    menu.style.zIndex = String(Z.CONTEXT);

    normalizeMenuItems(items).forEach((item) => {
        if (item.type === "separator") {
            const hr = document.createElement("hr");
            menu.appendChild(hr);
        } else if (item.type === "header") {
            // 菜单标题（不可点击，仅作分区说明，如 macOS「排列窗口」）
            const header = document.createElement("p");
            header.textContent = item.label;
            header.classList.add("menu-header");
            header.setAttribute("disabled", "");
            if (item.altOnly) header.classList.add("menu-alt-only");
            menu.appendChild(header);
        } else {
            const menuItem = document.createElement("p");
            // 平铺示意图标列（TL-04）：图标一律是调用方内置的受控 SVG 常量，
            // 不接收外部输入；有图标项统一留 16px 图标列对齐。
            if (item.icon) {
                const icon = document.createElement("span");
                icon.classList.add("menu-icon");
                icon.innerHTML = item.icon;
                icon.setAttribute("aria-hidden", "true");
                menuItem.appendChild(icon);
            }
            menuItem.appendChild(document.createTextNode(item.label));
            if (item.disabled) menuItem.setAttribute("disabled", "");
            // ⌥ 动态项（TL-09）：菜单打开期间按住 Option 才显示
            if (item.altOnly) menuItem.classList.add("menu-alt-only");
            // 勾选项：左侧统一预留 ✓ 列，未选中时隐藏勾，避免行文本左右跳。
            if (item.checked !== undefined) {
                menuItem.classList.add("menu-check");
                menuItem.dataset.checked = item.checked ? "true" : "false";
                menuItem.setAttribute("aria-checked", item.checked ? "true" : "false");
            }
            // 子菜单入口：右侧显示 ›，点击后由 action 在相同坐标弹出下一级菜单。
            if (item.hasSubmenu) menuItem.classList.add("has-submenu");
            // 置灰项只由 CSS 变淡，不禁用点击的话点一下照样执行（如「取消平铺」灰着却能触发）。
            if (item.action && !item.disabled) {
                menuItem.addEventListener("click", () => {
                    removeMenu(menu);
                    try {
                        // 把菜单打开坐标传给 action：「选项 → 位置」这类二级菜单
                        // 需要在同一位置继续弹出，旧实现收到 undefined 会算出 NaN 定位。
                        item.action(x, y);
                    } catch (err) {
                        console.error("[contextMenu] 菜单项执行失败:", item.label, err);
                    }
                });
            }
            menu.appendChild(menuItem);
        }
    });

    document.body.appendChild(menu);

    // 内容渲染后测量尺寸，四边都收进视口内。
    // 旧实现只在超出时翻到指针左/上方，翻完仍可能顶出上边界，也没处理
    // 「菜单比视口还高」的情况（15 项的「排列窗口」菜单在矮屏上会溢出）。
    const { offsetWidth: menuWidth, offsetHeight: menuHeight } = menu;
    const left = Math.max(4, Math.min(x, window.innerWidth - menuWidth - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - menuHeight - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const closeMenu = (e) => {
        if (!menu.contains(e.target)) removeMenu(menu);
    };
    menu._closeListener = closeMenu;
    // Esc 立即关闭：菜单可能盖住触发它的图标，点空白处不一定能点到
    // （菜单栏 / 窗口会截走 click），键盘退出是稳定通路。
    menu._keyListener = (e) => {
        if (e.key === "Escape") removeMenu(menu);
    };
    document.addEventListener("keydown", menu._keyListener);
    // 捕获阶段监听 pointerdown：菜单栏 / 窗口常会拦截 click，气泡阶段收不到，
    // 捕获阶段先于任何目标处理器，点菜单外一定关得上。
    menu._pointerListener = (e) => {
        if (!menu.contains(e.target)) removeMenu(menu);
    };
    document.addEventListener("pointerdown", menu._pointerListener, true);
    // 延后一拍注册点击监听，忽略触发本次菜单的那次点击
    menu._closeTimeout = setTimeout(() => {
        menu._closeTimeout = null;
        if (menu._removed || !document.body.contains(menu)) return;
        document.addEventListener("click", closeMenu);
    }, 0);

    return menu;
}

/**
 * 在桌面新建一个文件 / 文件夹图标。
 * 放置与拖拽复用 ui/desktopItems.js：此前这里是「第一个 container」+ 每个图标
 * 自建一对 document mousemove/mouseup 监听，与 desktop.js 的实现互相分叉。
 * @param {"folder"|"file"} type 类型
 * @param {string} [name="未命名"] 显示名称
 * @returns {HTMLElement|null} 图标元素，桌面未就绪时返回 null
 */
export function createDesktopFile(type, name = "未命名") {
    const item = document.createElement("div");
    item.classList.add("item");

    const icon = document.createElement("img");
    icon.src = type === "folder" ? FOLDER_ICON : GENERIC_DOC_ICON;

    const nameEl = document.createElement("p");
    nameEl.textContent = name;
    nameEl.contentEditable = "true";
    nameEl.addEventListener("blur", () => {
        nameEl.contentEditable = "false";
        if (!nameEl.textContent.trim()) nameEl.textContent = "未命名";
    });
    nameEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            nameEl.blur();
        }
    });

    item.append(icon, nameEl);
    makeDraggable(item);
    if (!appendDesktopItem(item)) return null;

    setTimeout(() => {
        nameEl.contentEditable = "true";
        nameEl.focus();
        const range = document.createRange();
        range.selectNodeContents(nameEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }, 0);

    return item;
}
