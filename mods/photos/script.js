/**
 * 照片应用逻辑 — 参照 macOS Photos
 * 支持图片与视频统一浏览、网格/列表视图、预览、批量操作、相簿管理
 */

(function () {
    "use strict";

    const STORAGE_KEY = "webstartos-photos-library";
    const MAX_FILE_SIZE = 6 * 1024 * 1024; // 6MB，超过则提示

    // ---- 状态 ----
    let state = {
        items: [],
        albums: [],
        nextId: 1,
        view: "all",           // 当前侧边栏视图：all / recent / favorites / trash / smart-video / smart-image / album-<id>
        mode: "grid",          // grid / list
        search: "",
        selection: new Set(),
        selecting: false,
        previewIndex: -1,
        previewItems: [],
        zoom: 1,
        detailOpen: false,
    };

    // ---- DOM 引用 ----
    const win = document.querySelector(".photos.window");
    if (!win) return;

    const els = {
        navItems: win.querySelectorAll(".nav-item[data-view]"),
        toolbarTitle: win.querySelector(".toolbar-title"),
        toolbarCount: win.querySelector(".toolbar-count"),
        gridView: win.querySelector(".grid-view"),
        gridContent: win.querySelector(".grid-content"),
        listView: win.querySelector(".list-view"),
        listBody: win.querySelector(".list-body"),
        emptyState: win.querySelector(".empty-state"),
        segBtns: win.querySelectorAll(".seg-btn"),
        searchInput: win.querySelector(".search-input"),
        btnSelect: win.querySelector(".btn-select"),
        btnImport: win.querySelector(".btn-import"),
        selectionBar: win.querySelector(".selection-bar"),
        selectionCount: win.querySelector(".selection-count"),
        btnSelFavorite: win.querySelector(".btn-sel-favorite"),
        btnSelDelete: win.querySelector(".btn-sel-delete"),
        btnSelCancel: win.querySelector(".btn-sel-cancel"),
        previewOverlay: win.querySelector(".preview-overlay"),
        previewContent: win.querySelector(".preview-content"),
        previewImage: win.querySelector(".preview-image"),
        previewVideo: win.querySelector(".preview-video"),
        previewPosition: win.querySelector(".preview-position"),
        btnBack: win.querySelector(".btn-back"),
        btnPrev: win.querySelector(".btn-prev"),
        btnNext: win.querySelector(".btn-next"),
        btnZoomOut: win.querySelector(".btn-zoom-out"),
        btnZoomIn: win.querySelector(".btn-zoom-in"),
        zoomSlider: win.querySelector(".zoom-slider"),
        btnFavorite: win.querySelector(".preview-overlay .btn-favorite"),
        btnInfo: win.querySelector(".btn-info"),
        btnDelete: win.querySelector(".preview-overlay .btn-delete"),
        previewDetail: win.querySelector(".preview-detail"),
        detailClose: win.querySelector(".detail-close"),
        detailThumb: win.querySelector(".detail-thumb"),
        detailTitle: win.querySelector(".detail-title"),
        detailRows: win.querySelector(".detail-rows"),
        fileInput: null,
        modalOverlay: null,
        modalInput: null,
    };

    // ---- 数据持久化 ----
    function loadLibrary() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                state.items = data.items || [];
                state.albums = data.albums || [];
                state.nextId = data.nextId || 1;
            }
        } catch (e) {
            console.warn("[photos] 读取媒体库失败", e);
        }
        ensureDefaultAlbums();
    }

    function saveLibrary() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                items: state.items,
                albums: state.albums,
                nextId: state.nextId,
            }));
        } catch (e) {
            console.warn("[photos] 保存媒体库失败", e);
            alert("存储空间不足，无法保存更多媒体。请删除部分项目后再试。");
        }
    }

    function ensureDefaultAlbums() {
        const defaults = ["旅行", "工作", "家人"];
        let changed = false;
        defaults.forEach((name) => {
            if (!state.albums.find((a) => a.name === name)) {
                state.albums.push({ id: `album-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name });
                changed = true;
            }
        });
        if (changed) saveLibrary();
    }

    // ---- 工具函数 ----
    function generateId() {
        return `item-${state.nextId++}`;
    }

    function formatSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    function formatDate(dateStr) {
        const d = new Date(dateStr);
        if (isNaN(d)) return "—";
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }

    function formatDuration(seconds) {
        if (!seconds || isNaN(seconds)) return "00:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${String(s).padStart(2, "0")}`;
    }

    function getFileType(file) {
        if (file.type.startsWith("video/")) return "video";
        return "image";
    }

    function getFileExtension(name) {
        const idx = name.lastIndexOf(".");
        return idx > 0 ? name.slice(idx + 1).toUpperCase() : "";
    }

    // 统一把 id 或 id 数组规整为数组，便于批量操作复用
    const toIdArray = (ids) => Array.isArray(ids) ? ids : [ids];

    // ---- 当前可见项目 ----
    function getVisibleItems() {
        let items = state.items;

        switch (state.view) {
            case "all":
                items = items.filter((i) => !i.deleted);
                break;
            case "recent":
                items = items.filter((i) => !i.deleted).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 50);
                break;
            case "favorites":
                items = items.filter((i) => i.favorite && !i.deleted);
                break;
            case "trash":
                items = items.filter((i) => i.deleted);
                break;
            case "smart-video":
                items = items.filter((i) => i.type === "video" && !i.deleted);
                break;
            case "smart-image":
                items = items.filter((i) => i.type === "image" && !i.deleted);
                break;
            default:
                if (state.view.startsWith("album-")) {
                    const albumId = state.view.slice(6);
                    items = items.filter((i) => i.albumIds && i.albumIds.includes(albumId) && !i.deleted);
                } else {
                    items = items.filter((i) => !i.deleted);
                }
        }

        const kw = state.search.trim().toLowerCase();
        if (kw) {
            items = items.filter((i) => {
                const name = (i.name || "").toLowerCase();
                const date = formatDate(i.date).toLowerCase();
                const type = i.type === "video" ? "视频" : "图片";
                return name.includes(kw) || date.includes(kw) || type.includes(kw);
            });
        }

        return items;
    }

    function getViewTitle() {
        switch (state.view) {
            case "all": return "所有照片";
            case "recent": return "最近项目";
            case "favorites": return "个人收藏";
            case "trash": return "已删除";
            case "smart-video": return "仅视频";
            case "smart-image": return "仅图片";
            default:
                if (state.view.startsWith("album-")) {
                    const album = state.albums.find((a) => a.id === state.view.slice(6));
                    return album ? album.name : "相簿";
                }
                return "所有照片";
        }
    }

    // ---- 渲染侧边栏相簿 ----
    function renderAlbumNav() {
        // 移除旧的动态相簿项
        win.querySelectorAll(".nav-album-dynamic").forEach((el) => el.remove());

        const albumSection = win.querySelector(".nav-section:nth-child(2) .nav-list");
        if (!albumSection) return;

        state.albums.forEach((album) => {
            const li = document.createElement("li");
            li.className = "nav-item nav-album-dynamic";
            li.dataset.view = `album-${album.id}`;
            li.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 11.5l4-4 3.5 3.5 3-3 2.5 2.5"/></svg>
                <span>${escapeHtml(album.name)}</span>
            `;
            li.addEventListener("click", () => setView(`album-${album.id}`));
            albumSection.appendChild(li);
        });
    }

    function escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    // ---- 渲染主内容 ----
    function render() {
        const items = getVisibleItems();
        els.toolbarTitle.textContent = getViewTitle();
        els.toolbarCount.textContent = `${items.length} 项`;

        // 空状态
        if (items.length === 0) {
            els.emptyState.classList.add("show");
            els.gridView.classList.remove("active");
            els.listView.classList.remove("active");
            els.gridContent.innerHTML = "";
            els.listBody.innerHTML = "";
            updateSelectionUI();
            return;
        }
        els.emptyState.classList.remove("show");

        if (state.mode === "grid") {
            els.gridView.classList.add("active");
            els.listView.classList.remove("active");
            renderGrid(items);
        } else {
            els.gridView.classList.remove("active");
            els.listView.classList.add("active");
            renderList(items);
        }

        updateSelectionUI();
    }

    function renderGrid(items) {
        els.gridContent.innerHTML = "";
        items.forEach((item) => {
            const el = document.createElement("div");
            el.className = "grid-item";
            el.dataset.id = item.id;
            if (state.selection.has(item.id)) el.classList.add("selected");
            if (item.favorite) el.classList.add("favorite");

            if (item.type === "video") {
                el.innerHTML = `
                    <video src="${item.src}" preload="metadata" muted></video>
                    <div class="video-badge"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>
                    <div class="video-duration">${formatDuration(item.duration)}</div>
                `;
            } else {
                el.innerHTML = `<img src="${item.src}" alt="${escapeHtml(item.name)}">`;
            }

            el.addEventListener("click", (e) => onItemClick(e, item));
            el.addEventListener("dblclick", (e) => onItemDblClick(e, item));
            el.addEventListener("contextmenu", (e) => onItemContextMenu(e, item));
            els.gridContent.appendChild(el);
        });
    }

    function renderList(items) {
        els.listBody.innerHTML = "";
        items.forEach((item) => {
            const row = document.createElement("div");
            row.className = "list-row";
            row.dataset.id = item.id;
            if (state.selection.has(item.id)) row.classList.add("selected");

            const thumb = item.type === "video"
                ? `<video class="list-thumb" src="${item.src}" preload="metadata" muted></video>`
                : `<img class="list-thumb" src="${item.src}" alt="">`;

            row.innerHTML = `
                <div class="list-col list-col-thumb">${thumb}</div>
                <div class="list-col list-col-name">${escapeHtml(item.name)}</div>
                <div class="list-col list-col-type list-type">${item.type === "video" ? "视频" : "图片"}</div>
                <div class="list-col list-col-date list-date">${formatDate(item.date)}</div>
                <div class="list-col list-col-size list-size">${formatSize(item.size)}</div>
            `;

            row.addEventListener("click", (e) => onItemClick(e, item));
            row.addEventListener("dblclick", (e) => onItemDblClick(e, item));
            row.addEventListener("contextmenu", (e) => onItemContextMenu(e, item));
            els.listBody.appendChild(row);
        });
    }

    // ---- 交互处理 ----
    function onItemClick(e, item) {
        if (e.ctrlKey || e.metaKey) {
            toggleSelection(item.id);
        } else if (state.selecting) {
            toggleSelection(item.id);
        } else {
            openPreview(item.id);
        }
    }

    function onItemDblClick(e, item) {
        e.preventDefault();
        openPreview(item.id);
    }

    function toggleSelection(id) {
        state.selection.has(id) ? state.selection.delete(id) : state.selection.add(id);
        render();
    }

    function clearSelection() {
        state.selection.clear();
        state.selecting = false;
        render();
    }

    function updateSelectionUI() {
        if (state.selecting && state.selection.size > 0) {
            els.selectionBar.classList.add("show");
            els.selectionCount.textContent = `已选择 ${state.selection.size} 项`;
        } else {
            els.selectionBar.classList.remove("show");
        }
    }

    // ---- 视图切换 ----
    function setView(view) {
        state.view = view;
        state.search = "";
        els.searchInput.value = "";
        state.selection.clear();

        // 更新侧边栏选中态
        win.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("active"));
        const active = win.querySelector(`.nav-item[data-view="${view}"]`);
        if (active) active.classList.add("active");

        render();
    }

    function setMode(mode) {
        state.mode = mode;
        els.segBtns.forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.mode === mode);
        });
        render();
    }

    // ---- 预览模式 ----
    function openPreview(id) {
        const items = getVisibleItems();
        const idx = items.findIndex((i) => i.id === id);
        if (idx === -1) return;

        state.previewItems = items;
        state.previewIndex = idx;
        state.zoom = 1;
        els.zoomSlider.value = 1;
        els.previewOverlay.classList.add("show");
        els.previewDetail.classList.remove("show");
        state.detailOpen = false;

        updatePreview();
    }

    function closePreview() {
        els.previewOverlay.classList.remove("show");
        els.previewImage.style.display = "none";
        els.previewVideo.style.display = "none";
        els.previewVideo.pause();
        state.previewItems = [];
        state.previewIndex = -1;
    }

    function updatePreview() {
        const item = state.previewItems[state.previewIndex];
        if (!item) return;

        els.previewPosition.textContent = `${state.previewIndex + 1} / ${state.previewItems.length}`;
        els.previewImage.style.display = "none";
        els.previewVideo.style.display = "none";
        els.previewVideo.pause();

        if (item.type === "video") {
            els.previewVideo.src = item.src;
            els.previewVideo.style.display = "block";
        } else {
            els.previewImage.src = item.src;
            els.previewImage.style.display = "block";
            els.previewImage.style.transform = `scale(${state.zoom})`;
        }

        els.btnPrev.disabled = state.previewIndex === 0;
        els.btnNext.disabled = state.previewIndex === state.previewItems.length - 1;

        updateFavoriteBtn(item);
        if (state.detailOpen) renderDetail(item);
    }

    function previewPrev() {
        if (state.previewIndex > 0) {
            state.previewIndex--;
            state.zoom = 1;
            els.zoomSlider.value = 1;
            updatePreview();
        }
    }

    function previewNext() {
        if (state.previewIndex < state.previewItems.length - 1) {
            state.previewIndex++;
            state.zoom = 1;
            els.zoomSlider.value = 1;
            updatePreview();
        }
    }

    function updateFavoriteBtn(item) {
        const svg = els.btnFavorite.querySelector("svg");
        if (svg) {
            svg.style.fill = item.favorite ? "#FFD60A" : "none";
            svg.style.stroke = item.favorite ? "#FFD60A" : "currentColor";
        }
    }

    // ---- 详情面板 ----
    function toggleDetail() {
        state.detailOpen = !state.detailOpen;
        els.previewDetail.classList.toggle("show", state.detailOpen);
        if (state.detailOpen) {
            const item = state.previewItems[state.previewIndex];
            if (item) renderDetail(item);
        }
    }

    function renderDetail(item) {
        els.detailTitle.textContent = item.name;
        els.detailThumb.innerHTML = item.type === "video"
            ? `<video src="${item.src}" muted></video>`
            : `<img src="${item.src}" alt="">`;

        const rows = [
            ["类型", item.type === "video" ? "视频" : "图片"],
            ["格式", getFileExtension(item.name)],
            ["拍摄日期", formatDate(item.date)],
            ["文件大小", formatSize(item.size)],
            ["分辨率", item.width && item.height ? `${item.width} × ${item.height}` : "—"],
        ];
        if (item.type === "video") {
            rows.push(["时长", formatDuration(item.duration)]);
        }
        rows.push(["位置", item.location || "—"]);

        els.detailRows.innerHTML = rows.map(([label, value]) => `
            <div class="detail-row">
                <span class="detail-label">${label}</span>
                <span class="detail-value">${escapeHtml(String(value))}</span>
            </div>
        `).join("");
    }

    // ---- 放大/缩小 ----
    function setZoom(z) {
        state.zoom = Math.max(0.5, Math.min(4, z));
        els.zoomSlider.value = state.zoom;
        els.previewImage.style.transform = `scale(${state.zoom})`;
    }

    // ---- 批量/单个操作 ----
    function toggleFavorite(ids) {
        toIdArray(ids).forEach((id) => {
            const item = state.items.find((i) => i.id === id);
            if (item) item.favorite = !item.favorite;
        });
        saveLibrary();
        render();
        if (state.previewIndex >= 0) {
            const item = state.previewItems[state.previewIndex];
            if (item) updateFavoriteBtn(item);
        }
    }

    function deleteItems(ids) {
        toIdArray(ids).forEach((id) => {
            const item = state.items.find((i) => i.id === id);
            if (!item) return;
            if (item.deleted) {
                // 彻底删除
                state.items = state.items.filter((i) => i.id !== id);
            } else {
                item.deleted = true;
            }
        });
        saveLibrary();
        clearSelection();
        render();
        if (state.previewItems.length) closePreview();
    }

    function restoreItems(ids) {
        toIdArray(ids).forEach((id) => {
            const item = state.items.find((i) => i.id === id);
            if (item) item.deleted = false;
        });
        saveLibrary();
        clearSelection();
        render();
    }

    function addToAlbum(ids, albumId) {
        toIdArray(ids).forEach((id) => {
            const item = state.items.find((i) => i.id === id);
            if (!item) return;
            item.albumIds = item.albumIds || [];
            if (!item.albumIds.includes(albumId)) item.albumIds.push(albumId);
        });
        saveLibrary();
        clearSelection();
        render();
    }

    function removeFromAlbum(ids, albumId) {
        toIdArray(ids).forEach((id) => {
            const item = state.items.find((i) => i.id === id);
            if (item && item.albumIds) {
                item.albumIds = item.albumIds.filter((a) => a !== albumId);
            }
        });
        saveLibrary();
        clearSelection();
        render();
    }

    // ---- 新建相簿 ----
    function showNewAlbumModal() {
        if (!els.modalOverlay) createModal();
        els.modalOverlay.classList.add("show");
        els.modalInput.value = "";
        els.modalInput.focus();
    }

    function hideNewAlbumModal() {
        if (els.modalOverlay) els.modalOverlay.classList.remove("show");
    }

    function createModal() {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.innerHTML = `
            <div class="modal">
                <div class="modal-title">新建相簿</div>
                <input type="text" class="modal-input" placeholder="相簿名称">
                <div class="modal-actions">
                    <button class="modal-btn secondary cancel">取消</button>
                    <button class="modal-btn primary confirm">创建</button>
                </div>
            </div>
        `;
        win.appendChild(overlay);
        els.modalOverlay = overlay;
        els.modalInput = overlay.querySelector(".modal-input");

        overlay.querySelector(".cancel").addEventListener("click", hideNewAlbumModal);
        overlay.querySelector(".confirm").addEventListener("click", () => {
            const name = els.modalInput.value.trim();
            if (!name) return;
            state.albums.push({ id: `album-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name });
            saveLibrary();
            renderAlbumNav();
            hideNewAlbumModal();
        });
        els.modalInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") overlay.querySelector(".confirm").click();
            if (e.key === "Escape") hideNewAlbumModal();
        });
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) hideNewAlbumModal();
        });
    }

    // ---- 导入 ----
    function createFileInput() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*,video/*";
        input.multiple = true;
        input.className = "file-input";
        input.addEventListener("change", handleFileSelect);
        win.appendChild(input);
        els.fileInput = input;
    }

    function handleFileSelect(e) {
        const files = Array.from(e.target.files);
        if (!files.length) return;
        importFiles(files);
        e.target.value = "";
    }

    function importFiles(files) {
        let completed = 0;
        const oversized = [];

        files.forEach((file) => {
            if (file.size > MAX_FILE_SIZE) {
                oversized.push(file.name);
                completed++;
                if (completed === files.length) finishImport(oversized);
                return;
            }

            const reader = new FileReader();
            reader.onload = (ev) => {
                const src = ev.target.result;
                const type = getFileType(file);
                const item = {
                    id: generateId(),
                    name: file.name,
                    type,
                    src,
                    size: file.size,
                    date: new Date(file.lastModified || Date.now()).toISOString(),
                    favorite: false,
                    deleted: false,
                    albumIds: [],
                    location: "",
                };

                // 导入完成回调：入库存档并判断是否全部完成
                const done = () => {
                    state.items.push(item);
                    if (++completed === files.length) finishImport(oversized);
                };

                if (type === "image") {
                    const img = new Image();
                    img.onload = () => {
                        item.width = img.naturalWidth;
                        item.height = img.naturalHeight;
                        done();
                    };
                    img.onerror = () => {
                        done();
                    };
                    img.src = src;
                } else {
                    const video = document.createElement("video");
                    video.preload = "metadata";
                    video.onloadedmetadata = () => {
                        item.duration = video.duration;
                        item.width = video.videoWidth;
                        item.height = video.videoHeight;
                        done();
                    };
                    video.onerror = () => {
                        done();
                    };
                    video.src = src;
                }
            };
            reader.readAsDataURL(file);
        });
    }

    function finishImport(oversized) {
        saveLibrary();
        render();
        if (oversized.length) {
            alert(`以下文件超过 6MB 未导入：\n${oversized.join("\n")}`);
        }
    }

    // ---- 右键菜单 ----
    function onItemContextMenu(e, item) {
        e.preventDefault();
        e.stopPropagation();

        if (!state.selection.has(item.id)) {
            state.selection.clear();
            state.selection.add(item.id);
            render();
        }

        const selectedIds = Array.from(state.selection);
        const menu = document.createElement("div");
        menu.className = "context-menu";

        const items = [
            { label: "显示简介", action: () => { openPreview(item.id); setTimeout(toggleDetail, 50); } },
            { label: item.favorite ? "取消收藏" : "添加收藏", action: () => toggleFavorite(selectedIds) },
            { type: "separator" },
        ];

        if (state.view.startsWith("album-")) {
            const albumId = state.view.slice(6);
            items.push({ label: "从相簿移除", action: () => removeFromAlbum(selectedIds, albumId) });
        } else {
            state.albums.forEach((album) => {
                items.push({ label: `移动到「${album.name}」`, action: () => addToAlbum(selectedIds, album.id) });
            });
        }

        items.push({ type: "separator" });
        items.push({
            label: item.deleted ? "恢复" : "删除",
            action: () => item.deleted ? restoreItems(selectedIds) : deleteItems(selectedIds),
        });

        menu.innerHTML = items.map((it) => {
            if (it.type === "separator") return `<div class="context-separator"></div>`;
            return `<div class="context-item">${escapeHtml(it.label)}</div>`;
        }).join("");

        menu.querySelectorAll(".context-item").forEach((el, idx) => {
            el.addEventListener("click", () => {
                items[idx].action();
                menu.remove();
            });
        });

        document.body.appendChild(menu);
        const rect = menu.getBoundingClientRect();
        let x = e.clientX;
        let y = e.clientY;
        if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
        if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        const closeMenu = (ev) => {
            if (!menu.contains(ev.target)) {
                menu.remove();
                document.removeEventListener("click", closeMenu);
                document.removeEventListener("contextmenu", closeMenu);
            }
        };
        setTimeout(() => {
            document.addEventListener("click", closeMenu);
            document.addEventListener("contextmenu", closeMenu);
        }, 10);
    }

    // ---- 事件绑定 ----
    function bindEvents() {
        els.navItems.forEach((el) => {
            el.addEventListener("click", () => {
                const view = el.dataset.view;
                if (view) setView(view);
            });
        });

        win.querySelector(".nav-add-album").addEventListener("click", showNewAlbumModal);

        els.segBtns.forEach((btn) => {
            btn.addEventListener("click", () => setMode(btn.dataset.mode));
        });

        els.searchInput.addEventListener("input", (e) => {
            state.search = e.target.value;
            render();
        });

        els.btnSelect.addEventListener("click", () => {
            state.selecting = !state.selecting;
            els.btnSelect.textContent = state.selecting ? "完成" : "选择";
            if (!state.selecting) clearSelection();
            else render();
        });

        els.btnImport.addEventListener("click", () => {
            if (!els.fileInput) createFileInput();
            els.fileInput.click();
        });

        els.btnSelFavorite.addEventListener("click", () => toggleFavorite(Array.from(state.selection)));
        els.btnSelDelete.addEventListener("click", () => deleteItems(Array.from(state.selection)));
        els.btnSelCancel.addEventListener("click", clearSelection);

        // 预览
        els.btnBack.addEventListener("click", closePreview);
        els.btnPrev.addEventListener("click", previewPrev);
        els.btnNext.addEventListener("click", previewNext);
        els.btnFavorite.addEventListener("click", () => {
            const item = state.previewItems[state.previewIndex];
            if (item) toggleFavorite(item.id);
        });
        els.btnInfo.addEventListener("click", toggleDetail);
        els.detailClose.addEventListener("click", toggleDetail);
        els.btnDelete.addEventListener("click", () => {
            const item = state.previewItems[state.previewIndex];
            if (item) {
                deleteItems(item.id);
                closePreview();
            }
        });

        els.btnZoomOut.addEventListener("click", () => setZoom(state.zoom - 0.25));
        els.btnZoomIn.addEventListener("click", () => setZoom(state.zoom + 0.25));
        els.zoomSlider.addEventListener("input", (e) => setZoom(parseFloat(e.target.value)));

        // 键盘
        win.addEventListener("keydown", (e) => {
            if (!els.previewOverlay.classList.contains("show")) return;
            if (e.key === "ArrowLeft") previewPrev();
            if (e.key === "ArrowRight") previewNext();
            if (e.key === "Escape") {
                if (state.detailOpen) toggleDetail();
                else closePreview();
            }
            if (e.key === "+") setZoom(state.zoom + 0.25);
            if (e.key === "-") setZoom(state.zoom - 0.25);
        });

        // 拖拽/滑动切换
        let touchStartX = 0;
        let mouseDownX = 0;
        els.previewOverlay.addEventListener("touchstart", (e) => {
            touchStartX = e.touches[0].clientX;
        }, { passive: true });
        els.previewOverlay.addEventListener("touchend", (e) => {
            const diff = e.changedTouches[0].clientX - touchStartX;
            if (diff > 60) previewPrev();
            if (diff < -60) previewNext();
        }, { passive: true });
        els.previewContent.addEventListener("mousedown", (e) => {
            mouseDownX = e.clientX;
        });
        els.previewContent.addEventListener("mouseup", (e) => {
            const diff = e.clientX - mouseDownX;
            if (Math.abs(diff) > 80) {
                if (diff > 0) previewPrev();
                else previewNext();
            }
        });

        // 内容区右键空白菜单
        els.gridView.addEventListener("contextmenu", (e) => {
            if (e.target.closest(".grid-item")) return;
            e.preventDefault();
        });
        els.listView.addEventListener("contextmenu", (e) => {
            if (e.target.closest(".list-row")) return;
            e.preventDefault();
        });
    }

    // ---- 初始化 ----
    function init() {
        loadLibrary();
        renderAlbumNav();
        bindEvents();
        render();
    }

    init();
})();
