/**
 * desktop.js — 桌面：图标放置 / 拖拽 / 右键菜单 / 文件拖入
 *
 * 图标的放置与拖拽统一在 ui/desktopItems.js（右键「新建文件夹」与本模块共用同一实现）。
 */
import { createContextMenu, createDesktopFile } from './ui/contextMenu.js';
import { appendDesktopItem, makeDraggable } from './ui/desktopItems.js';
import { isNativeContextMenuEnabled } from './contextMenuSettings.js';
import { i18n } from './i18n.js';
import { FOLDER_ICON, GENERIC_DOC_ICON } from './paths.js';

const desktop = document.getElementById("desktop");

document.addEventListener("mousedown", (e) => {
    // 防御：非 Element（Text 节点 / Document）没有 closest
    if (e.target.closest && !e.target.closest(".item") && !e.target.closest(".menu.contextmenu")) {
        document.querySelectorAll(".item.selected").forEach(el => el.classList.remove("selected"));
    }
});

/** 行内重命名：直接复用图标名称节点的 contentEditable，不再用 prompt() 阻塞主线程 */
function startRename(item) {
    const nameEl = item.querySelector("p");
    if (!nameEl) return;
    nameEl.contentEditable = "true";
    nameEl.focus();
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const commit = () => {
        nameEl.contentEditable = "false";
        if (!nameEl.textContent.trim()) nameEl.textContent = i18n.t("desktop.untitled", "未命名");
    };
    nameEl.addEventListener("blur", commit, { once: true });
    nameEl.addEventListener("keydown", function onKey(e) {
        if (e.key === "Enter") {
            e.preventDefault();
            nameEl.removeEventListener("keydown", onKey);
            nameEl.blur();
        }
    });
}

document.addEventListener("contextmenu", (e) => {
    // 若系统右键菜单已开启（使用浏览器原生菜单），则不拦截，直接返回
    if (isNativeContextMenuEnabled()) return;

    const item = e.target.closest && e.target.closest(".item");
    if (item) {
        e.preventDefault();
        e.stopPropagation();

        document.querySelectorAll(".item.selected").forEach(el => el.classList.remove("selected"));
        item.classList.add("selected");

        // 「打开」曾经是 action: () => {}（点了毫无反应的占位项），已移除。
        createContextMenu(e.clientX, e.clientY, [
            { label: i18n.t("desktop.rename", "重命名"), action: () => startRename(item) },
            {
                label: i18n.t("desktop.moveToTrash", "移到废纸篓"),
                action: () => {
                    const icon = item.querySelector("img");
                    // 释放缩略图 blob，否则每次删除都漏一个文件大小的内存
                    if (icon && icon.src.startsWith("blob:")) URL.revokeObjectURL(icon.src);
                    item.remove();
                },
            },
            { type: "separator" },
            { label: i18n.t("desktop.getInfo", "显示简介"), disabled: true },
        ]);
        return;
    }

    const isDockDeadZone = e.target.closest &&
        e.target.closest(".dockcontainer") &&
        !e.target.closest(".dock");

    // Dock 栏左右两侧未覆盖的区域直接落在 body 上，也视为桌面区域
    const isBodyArea = e.target === document.body;

    const isDesktopArea = e.target === desktop ||
        e.target.classList.contains("container") ||
        e.target.classList.contains("wallpaper") ||
        e.target.classList.contains("desktop") ||
        isDockDeadZone ||
        isBodyArea;

    if (isDesktopArea) {
        e.preventDefault();
        e.stopPropagation();

        document.querySelectorAll(".item.selected").forEach(el => el.classList.remove("selected"));

        // 只保留有真实行为的项：原先的「使用群组 / 排序方式 / 整理 / 整理方式 /
        // 查看显示选项」都只是 console.log，属于摆着点了没反应的假功能。
        createContextMenu(e.clientX, e.clientY, [
            {
                label: i18n.t("desktop.newFolder", "新建文件夹"),
                action: () => createDesktopFile("folder", i18n.t("desktop.newFolder", "新建文件夹")),
            },
            { type: "separator" },
            { label: i18n.t("desktop.getInfo", "显示简介"), disabled: true },
        ]);
    }
});

/**
 * 为拖入的文件生成缩略图地址。
 * @param {File} file 文件
 * @returns {Promise<string>} 图片地址（无法生成时回退通用文档图标）
 */
function getThumb(file) {
    const type = file.type || "";
    if (type.startsWith("image/")) {
        return Promise.resolve(URL.createObjectURL(file));
    }
    if (type.startsWith("video/")) {
        // 抽一帧画到 canvas。旧实现只在 video.onseeked 里 resolve，
        // 元数据加载失败或编码不支持时这个 Promise 永不 settle，
        // 图标于是永远停在空 src 上。
        return new Promise((resolve) => {
            const url = URL.createObjectURL(file);
            const canvas = document.createElement("canvas");
            const video = document.createElement("video");
            let settled = false;
            const done = (result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                video.removeEventListener("loadeddata", onLoadedData);
                video.removeAttribute("src");
                video.load();
                URL.revokeObjectURL(url);
                resolve(result);
            };
            const timer = setTimeout(() => done(GENERIC_DOC_ICON), 3000);

            const onLoadedData = () => {
                canvas.width = video.videoWidth || 160;
                canvas.height = video.videoHeight || 120;
                video.onseeked = () => {
                    try {
                        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
                        done(canvas.toDataURL("image/jpeg", 0.7));
                    } catch (err) {
                        done(GENERIC_DOC_ICON);
                    }
                };
                try {
                    video.currentTime = 0.1;
                } catch (err) {
                    done(GENERIC_DOC_ICON);
                }
            };

            video.addEventListener("loadeddata", onLoadedData, { once: true });
            video.addEventListener("error", () => done(GENERIC_DOC_ICON), { once: true });
            video.muted = true;
            video.src = url;
            video.load();
        });
    }
    return Promise.resolve(GENERIC_DOC_ICON);
}

/**
 * 在桌面上放一个图标。
 * @param {string} name 显示名称（按纯文本处理，不参与 HTML 解析）
 * @param {string|Promise<string>} thumb 图标地址或其异步来源
 * @returns {HTMLElement|null}
 */
function addDesktopIcon(name, thumb) {
    const item = document.createElement("div");
    item.className = "item";

    const icon = document.createElement("img");
    const label = document.createElement("p");
    // 文件名是不可信文本：旧实现用 innerHTML 写入，名为 <img src=x onerror=...> 的文件
    // 会在宿主文档里直接执行。
    label.textContent = String(name);

    item.append(icon, label);
    makeDraggable(item);
    if (!appendDesktopItem(item)) return null;

    Promise.resolve(thumb)
        .then((src) => {
            icon.src = src;
            // 图片解码完成后即可释放 blob，避免随图标数量线性增长的内存驻留
            if (src.startsWith("blob:")) {
                icon.addEventListener("load", () => URL.revokeObjectURL(src), { once: true });
            }
        })
        .catch((err) => {
            console.warn("[desktop] 缩略图生成失败:", err);
            icon.src = GENERIC_DOC_ICON;
        });

    return item;
}

/** 把拖入项（File / DataTransferItem / FileSystemFileEntry）归一成 File */
function toFile(dropped) {
    if (dropped instanceof File) return Promise.resolve(dropped);
    if (dropped && typeof dropped.getFile === "function") {
        return new Promise((resolve, reject) => dropped.getFile(resolve, reject));
    }
    return Promise.reject(new Error("无法取得文件"));
}

function addFile(dropped) {
    toFile(dropped)
        .then((file) => addDesktopIcon(file.name, getThumb(file)))
        .catch(() => addDesktopIcon((dropped && dropped.name) || "", GENERIC_DOC_ICON));
}

function addFolder(entry) {
    addDesktopIcon(entry.name, FOLDER_ICON);
}

["dragenter", "dragleave", "dragend", "dragover"].forEach((ev) =>
    document.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); }));

document.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const items = event.dataTransfer && event.dataTransfer.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind !== "file") continue;
        if (typeof item.webkitGetAsEntry === "function") {
            // 旧实现不判空：非文件系统来源时 entry 为 null，读 .isDirectory 直接抛；
            // else 分支又把 DataTransferItem 当 File 传下去，在 file.file(...) 处再抛一次。
            const entry = item.webkitGetAsEntry();
            if (entry && entry.isDirectory) {
                addFolder(entry);
                continue;
            }
            if (entry && entry.isFile) {
                addFile(entry);
                continue;
            }
        }
        const file = item.getAsFile && item.getAsFile();
        if (file) addFile(file);
    }
});
