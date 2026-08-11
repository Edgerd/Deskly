/**
 * script.js — 系统设置插件逻辑
 * import 路径与资源路径已按插件目录重写。
 */

import { createAlert } from '../../src/javascripts/ui/alert.js';
import { setTrashIcon, getTrashKey } from '../../src/javascripts/trashIcon.js';
import { isNativeContextMenuEnabled, setNativeContextMenuEnabled } from '../../src/javascripts/contextMenuSettings.js';
import { wallpaper } from '../../src/javascripts/wallpaper.js';
import { VFS } from '../../src/javascripts/vfs.js';
import {
    appearance,
    setTheme, setAccent, setHighlight, setSidebarSize, setTint, setScrollbars, setScrollClick,
} from '../../src/javascripts/appearance.js';

let window_settings = document.querySelector(".window.settings");
let selectionIcons = document.querySelectorAll(".left .list .selection div.icon");
let selections = document.querySelectorAll(".left .list .selection");
let rightTitle = document.querySelector(".right .toolbar p");

let nowPage = document.getElementById("appearance");
let nowSelection = document.querySelector(".left .list .selection.focus");

// 图标背景（沿用原逻辑）
selectionIcons.forEach(icon => {
    const scale = icon.getAttribute("scale") || "75%";
    icon.style.background = `url(${icon.getAttribute("icon")}) center center / ${scale} no-repeat,
        url(../../assets/images/backgrounds/bg.${icon.classList[1]}.svg) center center / cover no-repeat`;
});

// 搜索框占位符
const searchInput = document.querySelector(".left .list swift-input.search");
if (searchInput && searchInput.shadowRoot) {
    const inner = searchInput.shadowRoot.querySelector("input");
    if (inner) inner.placeholder = "搜索";
}

// 左侧菜单点击切换页面（基于 data-page，避免图标路径解析失败）
selections.forEach(selection => {
    selection.addEventListener("click", () => {
        const pageId = selection.dataset.page;
        if (!pageId) return;
        nowSelection.classList.remove("focus");
        selection.classList.add("focus");
        nowSelection = selection;

        let nextPage = document.getElementById(pageId);
        if (!nextPage) {
            // 未提供显式页面的模块：生成占位页
            nextPage = document.createElement("div");
            nextPage.className = "page";
            nextPage.id = pageId;
            const title = selection.querySelector("p:not(.title)")?.textContent || "设置";
            nextPage.innerHTML = `<p class="a">${title}</p><p class="b">还没做😡😭</p>`;
            document.querySelector(".right .main").appendChild(nextPage);
        }

        nowPage.classList.remove("focus");
        nextPage.classList.add("focus");
        nowPage = nextPage;

        rightTitle.textContent = selection.querySelector("p:not(.title)")?.textContent || "";
    });
});

// 搜索框过滤左侧列表
const margins = document.querySelectorAll(".left .list .margin");
function refreshMargins() {
    margins.forEach(m => {
        let prev = m.previousElementSibling, next = m.nextElementSibling;
        while (prev && !prev.classList.contains("selection")) prev = prev.previousElementSibling;
        while (next && !next.classList.contains("selection")) next = next.nextElementSibling;
        const prevVisible = prev && prev.style.display !== "none";
        const nextVisible = next && next.style.display !== "none";
        m.style.display = (prevVisible || nextVisible) ? "" : "none";
    });
}
if (searchInput) {
    searchInput.addEventListener("input", () => {
        const q = (searchInput.value || "").trim().toLowerCase();
        document.querySelectorAll(".left .list .selection").forEach(sel => {
            const label = sel.querySelector("p:not(.title)")?.textContent || "";
            const match = !q || label.toLowerCase().includes(q);
            sel.style.display = match ? "" : "none";
        });
        refreshMargins();
    });
}

// ===== 外观页：全部控件绑定 =====

// 1. 外观：浅色 / 深色 / 自动
const appearancePics = document.querySelectorAll("#appearance .pic[data-appearance]");
// 通用「焦点组」绑定：根据 saved 预置 .focus，点击时排他切换并调用 apply
function bindFocusGroup(els, dataKey, saved, apply) {
    els.forEach((el) => {
        if (el.dataset[dataKey] === saved) el.classList.add("focus");
        el.addEventListener("click", () => {
            els.forEach((x) => x.classList.remove("focus"));
            el.classList.add("focus");
            apply(el.dataset[dataKey]);
        });
    });
}
bindFocusGroup(appearancePics, "appearance", appearance.getTheme(), setTheme);

// 2. 强调色
const accentOvals = document.querySelectorAll("#appearance .oval[data-accent]");
bindFocusGroup(accentOvals, "accent", appearance.getAccent(), setAccent);

// 3. 高亮标记颜色（下拉菜单形式，显示 Accent Color）
const highlightDropdown = document.getElementById("highlight-dropdown");
if (highlightDropdown) {
  const savedHighlight = appearance.getHighlight();
  // 更新预览色块
  const colorPreview = highlightDropdown.querySelector(".color-preview");
  const labelEl = highlightDropdown.querySelector(".dropdown-label");
  function updateHighlightPreview(color) {
    const colors = {
      accent: "linear-gradient(135deg, #006fff 0%, #8a358b 50%, #F64694 100%)",
      blue: "#006fff",
      purple: "#8a358b",
      pink: "#F64694",
      red: "#DB3136",
      orange: "#f67719",
      yellow: "#FFC022",
      green: "#57B13D",
      gray: "#8D8D8D"
    };
    if (colorPreview) colorPreview.style.background = colors[color] || colors.accent;
    if (labelEl) labelEl.textContent = color === "accent" ? "Accent Color" : color.charAt(0).toUpperCase() + color.slice(1);
  }
  updateHighlightPreview(savedHighlight);
}
// 保留原有高亮色 oval 点击逻辑以兼容（如果页面仍有 oval 元素）
const highlightOvals = document.querySelectorAll("#appearance .oval[data-highlight]");
if (highlightOvals.length > 0) {
  bindFocusGroup(highlightOvals, "highlight", appearance.getHighlight(), setHighlight);
}

// 4. 边栏图标大小（下拉菜单形式，显示 Medium）
const sidebarSizeDropdown = document.getElementById("sidebar-size-dropdown");
if (sidebarSizeDropdown) {
  const savedSize = appearance.getSidebarSize();
  const sizeLabels = { small: "Small", medium: "Medium", large: "Large" };
  const labelEl = sidebarSizeDropdown.querySelector(".dropdown-label");
  if (labelEl) labelEl.textContent = sizeLabels[savedSize] || "Medium";
}
// 保留原有分段控件逻辑以兼容
const sidebarSeg = document.getElementById("sidebar-size");
if (sidebarSeg) {
    const savedSize = appearance.getSidebarSize();
    const syncSize = () => sidebarSeg.querySelectorAll(".seg-btn").forEach(b => b.classList.toggle("active", b.dataset.value === savedSize));
    syncSize();
    sidebarSeg.querySelectorAll(".seg-btn").forEach(btn => btn.addEventListener("click", () => {
        setSidebarSize(btn.dataset.value);
        syncSize();
    }));
}

// 5. 允许基于墙纸调整窗口色调（默认关闭，与 macOS 一致）
const tintSwitch = document.getElementById("wallpaper-tint");
if (tintSwitch) {
    tintSwitch.state = appearance.getTint();
    const obs = new MutationObserver((mutations) => {
        mutations.forEach((m) => {
            if (m.type === "attributes" && m.attributeName === "state") {
                setTint(tintSwitch.getAttribute("state"));
            }
        });
    });
    obs.observe(tintSwitch, { attributes: true });
}

// 6. 显示滚动条（单选按钮形式）
const scrollRadioGroup = document.getElementById("scrollbars");
if (scrollRadioGroup) {
  const saved = appearance.getScrollbars();
  const checkedRadio = scrollRadioGroup.querySelector(`input[value="${saved}"]`);
  if (checkedRadio) checkedRadio.checked = true;
  scrollRadioGroup.querySelectorAll("input[name='scrollbars']").forEach(radio => {
    radio.addEventListener("change", () => {
      if (radio.checked) setScrollbars(radio.value);
    });
  });
}
// 保留原有分段控件逻辑以兼容
const scrollSeg = document.getElementById("scrollbars");
if (scrollSeg && scrollSeg.classList.contains("seg")) {
    const saved = appearance.getScrollbars();
    const sync = () => scrollSeg.querySelectorAll(".seg-btn").forEach(b => b.classList.toggle("active", b.dataset.value === saved));
    sync();
    scrollSeg.querySelectorAll(".seg-btn").forEach(btn => btn.addEventListener("click", () => {
        setScrollbars(btn.dataset.value);
        sync();
    }));
}

// 7. 在滚动条中点按（单选按钮形式）
const scrollClickRadioGroup = document.getElementById("scroll-click");
if (scrollClickRadioGroup) {
  const saved = appearance.getScrollClick();
  const checkedRadio = scrollClickRadioGroup.querySelector(`input[value="${saved}"]`);
  if (checkedRadio) checkedRadio.checked = true;
  scrollClickRadioGroup.querySelectorAll("input[name='scroll-click']").forEach(radio => {
    radio.addEventListener("change", () => {
      if (radio.checked) setScrollClick(radio.value);
    });
  });
}
// 保留原有分段控件逻辑以兼容
const scrollClickSeg = document.getElementById("scroll-click");
if (scrollClickSeg && scrollClickSeg.classList.contains("seg")) {
    const saved = appearance.getScrollClick();
    const sync = () => scrollClickSeg.querySelectorAll(".seg-btn").forEach(b => b.classList.toggle("active", b.dataset.value === saved));
    sync();
    scrollClickSeg.querySelectorAll(".seg-btn").forEach(btn => btn.addEventListener("click", () => {
        setScrollClick(btn.dataset.value);
        sync();
    }));
}

// ===== 桌面与程序坞设置（沿用原逻辑） =====

// 通用开关绑定：设置初始 state，并监听 state 属性变化回调 onChange
function bindStateSwitch(id, initial, onChange) {
    const sw = document.getElementById(id);
    if (!sw) return;
    sw.state = initial;
    new MutationObserver((muts) => muts.forEach((m) => {
        if (m.type === "attributes" && m.attributeName === "state") onChange(sw.getAttribute("state"));
    })).observe(sw, { attributes: true });
}

bindStateSwitch("dock-autohide",
    localStorage.getItem("dock-autohide") || "off",
    (state) => {
        localStorage.setItem("dock-autohide", state);
        window.dispatchEvent(new CustomEvent("dock-autohide-change", { detail: state }));
    });

bindStateSwitch("dock-zoom",
    localStorage.getItem("dock-zoom") || "on",
    (state) => {
        localStorage.setItem("dock-zoom", state);
        window.dispatchEvent(new CustomEvent("dock-zoom-change", { detail: state }));
    });

// 程序坞大小滑块：实时写入存储并广播 dock-size-change
const dockSizeSlider = document.getElementById("dock-size");
if (dockSizeSlider) {
    dockSizeSlider.value = localStorage.getItem("dock-size") || "50";
    dockSizeSlider.addEventListener("input", () => {
        const v = parseInt(dockSizeSlider.value, 10) || 50;
        localStorage.setItem("dock-size", String(v));
        window.dispatchEvent(new CustomEvent("dock-size-change", { detail: String(v) }));
    });
}

// 程序坞位置分段控件：左边 / 底部 / 右边
const dockPositionSeg = document.getElementById("dock-position");
if (dockPositionSeg) {
    const savedPos = localStorage.getItem("dock-position") || "bottom";
    const syncPos = () => {
        dockPositionSeg.querySelectorAll(".seg-btn").forEach(b => {
            b.classList.toggle("active", b.dataset.value === savedPos);
        });
    };
    syncPos();
    dockPositionSeg.querySelectorAll(".seg-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const pos = btn.dataset.value;
            localStorage.setItem("dock-position", pos);
            window.dispatchEvent(new CustomEvent("dock-position-change", { detail: pos }));
            syncPos();
        });
    });
}

// 放大程度滑块：实时写入存储并广播 dock-zoom-amount-change
const dockZoomAmountSlider = document.getElementById("dock-zoom-amount");
if (dockZoomAmountSlider) {
    dockZoomAmountSlider.value = localStorage.getItem("dock-zoom-amount") || "1.8";
    dockZoomAmountSlider.addEventListener("input", () => {
        const v = parseFloat(dockZoomAmountSlider.value) || 1.8;
        localStorage.setItem("dock-zoom-amount", String(v));
        window.dispatchEvent(new CustomEvent("dock-zoom-amount-change", { detail: String(v) }));
    });
}

// 显示运行指示灯开关
bindStateSwitch("dock-show-indicators",
    showIndicatorsState(),
    (state) => {
        const on = state === "on";
        localStorage.setItem("dock-show-indicators", on ? "on" : "off");
        window.dispatchEvent(new CustomEvent("dock-show-indicators-change", { detail: on ? "on" : "off" }));
    });

// 显示“最近使用的应用程序”开关
bindStateSwitch("dock-show-recent",
    showRecentState(),
    (state) => {
        const on = state === "on";
        localStorage.setItem("dock-show-recent", on ? "on" : "off");
        window.dispatchEvent(new CustomEvent("dock-show-recent-change", { detail: on ? "on" : "off" }));
    });

function showIndicatorsState() {
    return localStorage.getItem("dock-show-indicators") !== "off" ? "on" : "off";
}
function showRecentState() {
    return localStorage.getItem("dock-show-recent") !== "off" ? "on" : "off";
}

// 废纸篓图标选择：根据当前选择高亮，并绑定点击切换
const trashPicks = document.querySelectorAll(".trash-pick .pic");
const currentTrashKey = getTrashKey();
trashPicks.forEach(pick => {
    if (pick.dataset.trash === currentTrashKey) pick.classList.add("focus");
    pick.addEventListener("click", () => {
        trashPicks.forEach(p => p.classList.remove("focus"));
        pick.classList.add("focus");
        setTrashIcon(pick.dataset.trash);
    });
});

// 系统右键菜单开关：启用后恢复浏览器原生右键菜单，关闭则统一使用自定义菜单
bindStateSwitch("native-context-menu",
    isNativeContextMenuEnabled() ? "on" : "off",
    (state) => setNativeContextMenuEnabled(state === "on"));

// ===== 墙纸设置 =====

const wallpaperPreview = document.getElementById("wallpaper-preview");
const wallpaperCurrentName = document.getElementById("wallpaper-current-name");
const wallpaperUrlInput = document.getElementById("wallpaper-url");
const wallpaperApplyBtn = document.getElementById("wallpaper-apply");
const wallpaperFileInput = document.getElementById("wallpaper-file");
const wallpaperUploadBtn = document.getElementById("wallpaper-upload");
const wallpaperResetBtn = document.getElementById("wallpaper-reset");
const wallpaperBingBtn = document.getElementById("wallpaper-bing-apply");
const systemWallpaperGrid = document.getElementById("system-wallpaper-grid");

/** 壁纸类型对应的友好中文名称 */
const WALLPAPER_TYPE_LABEL = {
    default: "系统默认",
    system: "系统壁纸",
    network: "网络壁纸",
    upload: "本地图片",
    bing: "Bing 每日壁纸",
};

/**
 * 更新墙纸预览缩略图与当前名称。
 * @param {{url: string, name?: string, type?: string}} config 壁纸配置对象
 */
function updateWallpaperPreview(config) {
    if (!config) return;
    if (wallpaperPreview && config.url) {
        wallpaperPreview.style.backgroundImage = `url("${config.url}")`;
        wallpaperPreview.style.backgroundSize = "cover";
        wallpaperPreview.style.backgroundPosition = "center";
    }
    if (wallpaperCurrentName) {
        const display = config.name || (WALLPAPER_TYPE_LABEL[config.type] || "自定义壁纸");
        wallpaperCurrentName.textContent = display;
    }
}

/**
 * 根据当前壁纸配置高亮系统壁纸网格中的选中项。
 */
function highlightCurrentSystemWallpaper() {
    const config = wallpaper.getWallpaperConfig();
    if (!systemWallpaperGrid) return;
    const items = systemWallpaperGrid.querySelectorAll(".wall-item");
    items.forEach((item) => {
        const match = item.dataset.systemId && (item.dataset.systemId === config.systemId ||
            (config.type === "default" && item.dataset.systemId === "sequoia-default"));
        item.classList.toggle("focus", !!match);
    });
}

/**
 * 渲染系统默认壁纸网格。
 */
function renderSystemWallpapers() {
    if (!systemWallpaperGrid) return;
    const list = wallpaper.getSystemWallpapers();
    systemWallpaperGrid.innerHTML = "";
    list.forEach((wp) => {
        const item = document.createElement("div");
        item.className = "wall-item";
        item.dataset.systemId = wp.id;
        item.title = wp.name;

        const thumb = document.createElement("div");
        thumb.className = "wall-thumb";
        thumb.style.backgroundImage = `url("${wp.thumb}")`;

        const name = document.createElement("p");
        name.className = "wall-name";
        name.textContent = wp.name;

        item.appendChild(thumb);
        item.appendChild(name);

        item.addEventListener("click", () => {
            if (wallpaper.setSystemWallpaper(wp.id)) {
                highlightCurrentSystemWallpaper();
            }
        });

        systemWallpaperGrid.appendChild(item);
    });
    highlightCurrentSystemWallpaper();
}

// 初始化预览：读取当前壁纸配置
function initWallpaperPreview() {
    const config = wallpaper.getWallpaperConfig();
    updateWallpaperPreview(config);
    renderSystemWallpapers();
}
initWallpaperPreview();

// 监听壁纸变更事件，实时刷新预览
const onWallpaperChange = (event) => {
    const config = event.detail;
    if (config) updateWallpaperPreview(config);
    highlightCurrentSystemWallpaper();
};
window.addEventListener("wallpaper-change", onWallpaperChange);

// 资源释放：系统设置窗口关闭时移除全局壁纸监听
const onSystemSettingsUnload = (e) => {
    if (e.detail.id !== "system-settings") return;
    window.removeEventListener("plugin-unload", onSystemSettingsUnload);
    window.removeEventListener("wallpaper-change", onWallpaperChange);
};
window.addEventListener("plugin-unload", onSystemSettingsUnload);

/**
 * 应用网络壁纸源（异步，先预加载校验有效性）。
 */
async function applyNetworkWallpaper() {
    const url = wallpaperUrlInput.value.trim();
    if (!url) {
        createAlert("../../assets/icons/Finder.png", "无法应用壁纸。", "请输入网络图片地址", "好", "close");
        return;
    }
    const originalText = wallpaperApplyBtn?.textContent || "";
    try {
        if (wallpaperApplyBtn) {
            wallpaperApplyBtn.disabled = true;
            wallpaperApplyBtn.textContent = "加载中…";
            wallpaperApplyBtn.style.opacity = "0.7";
        }
        const ok = await wallpaper.setNetworkWallpaper(url);
        if (ok) wallpaperUrlInput.value = "";
    } catch (err) {
        createAlert(
            "../../assets/icons/Finder.png",
            "无法应用壁纸。",
            err.message || "请检查图片地址是否有效",
            "好",
            "close",
        );
    } finally {
        if (wallpaperApplyBtn) {
            wallpaperApplyBtn.disabled = false;
            wallpaperApplyBtn.textContent = originalText;
            wallpaperApplyBtn.style.opacity = "";
        }
    }
}

if (wallpaperApplyBtn) {
    wallpaperApplyBtn.addEventListener("click", applyNetworkWallpaper);
}
if (wallpaperUrlInput) {
    wallpaperUrlInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") applyNetworkWallpaper();
    });
}

// 上传本地图片
if (wallpaperUploadBtn) {
    wallpaperUploadBtn.addEventListener("click", () => wallpaperFileInput && wallpaperFileInput.click());
}
if (wallpaperFileInput) {
    wallpaperFileInput.addEventListener("change", () => {
        const file = wallpaperFileInput.files && wallpaperFileInput.files[0];
        if (!file) return;
        wallpaper.uploadLocal(file).catch((err) => {
            createAlert("../../assets/icons/Finder.png", "壁纸上传失败。", err.message || "请选择有效的图片文件", "好", "close");
        });
        wallpaperFileInput.value = "";
    });
}

// 恢复默认壁纸
if (wallpaperResetBtn) {
    wallpaperResetBtn.addEventListener("click", () => wallpaper.resetWallpaper());
}

// Bing 每日壁纸
if (wallpaperBingBtn) {
    wallpaperBingBtn.addEventListener("click", async () => {
        const originalText = wallpaperBingBtn.textContent;
        try {
            wallpaperBingBtn.disabled = true;
            wallpaperBingBtn.textContent = "加载中…";
            wallpaperBingBtn.style.opacity = "0.7";
            await wallpaper.fetchBingWallpaper();
        } catch (err) {
            createAlert(
                "../../assets/icons/Finder.png",
                "获取 Bing 壁纸失败。",
                err.message || "请稍后再试，或检查网络连接",
                "好",
                "close",
            );
        } finally {
            if (wallpaperBingBtn) {
                wallpaperBingBtn.disabled = false;
                wallpaperBingBtn.textContent = originalText;
                wallpaperBingBtn.style.opacity = "";
            }
        }
    });
}

// ===== 本地存储页（原文件系统） =====

const fsFolders = document.getElementById("fs-folders");
/** 三个真实文件夹的图标与标签 */
const FS_CONFIG = [
    { key: "download", label: "下载", icon: "../../assets/icons/folder/Download.png" },
    { key: "docs", label: "文档", icon: "../../assets/icons/folder/Documents.png" },
    { key: "pictures", label: "图片", icon: "../../assets/icons/folder/Pictures.png" },
];

/**
 * 渲染本地存储页的文件夹授权状态列表。
 * @returns {Promise<void>}
 */
async function renderFsFolders() {
    if (!fsFolders) return;
    await VFS.init();
    const status = VFS.getAuthStatus();
    fsFolders.innerHTML = "";
    FS_CONFIG.forEach((item, idx) => {
        const row = document.createElement("div");
        row.className = "fs-folder-row" + (idx === 0 ? " first" : idx === FS_CONFIG.length - 1 ? " last" : " middle");

        const info = document.createElement("div");
        info.className = "fs-folder-info";

        const img = document.createElement("img");
        img.src = item.icon;
        img.draggable = false;
        info.appendChild(img);

        const name = document.createElement("p");
        name.className = "fs-folder-name";
        name.textContent = item.label;
        info.appendChild(name);

        const statusEl = document.createElement("p");
        statusEl.className = "fs-folder-status";
        const authorized = !!status.folders[item.key];
        statusEl.textContent = authorized ? "已授权" : status.supported ? "未授权" : "不可用";
        statusEl.classList.add(authorized ? "ok" : "warn");
        info.appendChild(statusEl);

        const btn = document.createElement("button");
        btn.className = "fs-folder-btn";
        btn.textContent = authorized ? "重新授权" : "授权";
        btn.disabled = !status.supported;
        btn.addEventListener("click", async () => {
            btn.disabled = true;
            btn.textContent = "请选择文件夹…";
            try {
                await VFS.authorizeOne(item.key);
                await renderFsFolders();
            } catch (err) {
                createAlert("../../assets/icons/Finder.png", "授权失败。", err.message || "未能完成文件夹授权", "好", "close");
                await renderFsFolders();
            }
        });

        row.appendChild(info);
        row.appendChild(btn);
        fsFolders.appendChild(row);
    });
}
renderFsFolders();
