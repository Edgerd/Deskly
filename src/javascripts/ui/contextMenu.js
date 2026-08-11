/**
 * 计算当前页面中所有元素的最高 z-index，用于让右键菜单始终置顶。
 * 窗口 z-index 会随每次 bringToFront 递增，菜单必须动态取最高值 + 1，
 * 否则会被多次切换后的窗口遮挡。
 */
function getTopZIndex() {
    return Array.from(document.querySelectorAll("*")).reduce((max, el) => {
        const value = parseInt(window.getComputedStyle(el).zIndex, 10);
        return !isNaN(value) && value > max ? value : max;
    }, 0);
}

export function createContextMenu(x, y, items) {
    const existingMenu = document.querySelector("div.menu.contextmenu");
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement("div");
    menu.classList.add("menu", "contextmenu", "visible");
    menu.style.opacity = "1";
    // 动态计算置顶层级，确保菜单始终位于所有窗口之上
    menu.style.zIndex = (getTopZIndex() + 1);

    items.forEach(item => {
        if (item.type === "separator") {
            const hr = document.createElement("hr");
            menu.appendChild(hr);
        } else if (item.type === "header") {
            // 菜单标题（不可点击，仅作分区说明，如 macOS「排列窗口」）
            const header = document.createElement("p");
            header.textContent = item.label;
            header.classList.add("menu-header");
            header.setAttribute("disabled", "");
            menu.appendChild(header);
        } else {
            const menuItem = document.createElement("p");
            menuItem.textContent = item.label;
            if (item.disabled) menuItem.setAttribute("disabled", "");
            if (item.action) menuItem.addEventListener("click", () => { item.action(); menu.remove(); });
            menu.appendChild(menuItem);
        }
    });

    document.body.appendChild(menu);

    // 内容渲染后测量尺寸，自动检测可视空间，避免菜单超出屏幕下方/右侧
    const { offsetWidth: menuWidth, offsetHeight: menuHeight } = menu;
    const top = y + menuHeight > window.innerHeight ? Math.max(0, y - menuHeight) : y;
    const left = x + menuWidth > window.innerWidth ? Math.max(0, x - menuWidth) : x;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener("click", closeMenu);
        }
    };
    setTimeout(() => document.addEventListener("click", closeMenu), 0);

    return menu;
}

export function createDesktopFile(type, name = "未命名") {
    const container = document.querySelector(".desktop .container");
    const item = document.createElement("div");
    item.classList.add("item");

    const icon = document.createElement("img");
    icon.src = type === "folder"
        ? "./assets/icons/folder/Folder.png"
        : "./assets/images/GenericDocumentIcon.png";

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

    item.appendChild(icon);
    item.appendChild(nameEl);
    // item.style.cursor = "grab";

    const makeDraggable = (item) => {
        let isDragging = false;
        let offsetX, offsetY;

        item.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;

            document.querySelectorAll(".item.selected").forEach(el => el.classList.remove("selected"));
            item.classList.add("selected");

            isDragging = true;
            const rect = item.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;

            item.style.position = "fixed";
            item.style.margin = "0";
            item.style.left = (e.clientX - offsetX) + "px";
            item.style.top = (e.clientY - offsetY) + "px";
            item.style.zIndex = "9999";
            // item.style.cursor = "grabbing";
            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            item.style.left = (e.clientX - offsetX) + "px";
            item.style.top = (e.clientY - offsetY) + "px";
        });

        document.addEventListener("mouseup", () => {
            if (isDragging) {
                isDragging = false;
                item.style.zIndex = "0";
                // item.style.cursor = "grab";
            }
        });
    };

    makeDraggable(item);
    container.appendChild(item);

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
