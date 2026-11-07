/** script.js — 照片（统一图库与查看器）：元数据在 localStorage，二进制与缩略图在 IndexedDB（photo-store.js），原图按引用计数取用。 */

import { i18n } from '../../src/javascripts/i18n.js';
import {
    putMedia,
    getMedia,
    putThumb,
    getThumbURL,
    getMediaURL,
    releaseMediaURL,
    deleteMedia,
    releaseAllMediaURLs,
    releaseAllThumbURLs,
    scanLibrary,
    addExternalMount,
    scanExternalMount,
    listExternalMounts,
    PHOTOS_ROOT,
    EXTERNAL_ID_PREFIX,
} from './photo-store.js';

const HOST_WINDOW = document.querySelector('.photos.window');
if (HOST_WINDOW) startPhotos(HOST_WINDOW);

/**
 * 应用入口。DOM 已由插件管理器注入后才求值。
 * @param {HTMLElement} win 照片窗口根元素
 */
function startPhotos(win) {
    "use strict";

    const dialog = window.__dialog || null;

    /** Q6 收口：只走 Deskly 公开 API；信封统一在此拆（ok:false 抛带 code 的错误）。 */
    const Deskly = () => window.Deskly;
    const unwrap = (env) => {
        if (!env || !env.ok) {
            const err = new Error((env && env.reason) || "Deskly 调用失败");
            err.code = (env && env.code) || "EIO";
            throw err;
        }
        return env.value;
    };
    const createContextMenu = (x, y, items) => Deskly().ui.contextMenu(x, y, items);

    const STORAGE_KEY = "webstartos-photos-library";
    const MODE_KEY = "webstartos_photos_view_mode";
    const VOLUME_KEY = "webstartos_photos_volume";
    const MUTED_KEY = "webstartos_photos_muted";
    const MAX_FILE_SIZE = 100 * 1024 * 1024;
    const METADATA_TIMEOUT_MS = 9000;
    const THUMB_MAX_EDGE = 640;
    const RENDER_CHUNK = 40;
    const SLIDE_INTERVAL_MS = 4000;

    const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "heif", "bmp", "avif", "tif", "tiff"]);
    const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v", "ogv", "mkv"]);

    const PLAY_ICON = `<svg class="icon-play" width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><path d="M5 3l10 6-10 6V3z"/></svg>`;
    const PAUSE_ICON = `<svg class="icon-pause" width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><rect x="4" y="3" width="3" height="12" rx="1"/><rect x="11" y="3" width="3" height="12" rx="1"/></svg>`;
    const SLIDESHOW_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3l8 5-8 5V3z"/></svg>`;
    const SLIDESHOW_STOP_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx="0.6"/><rect x="9" y="3" width="3" height="10" rx="0.6"/></svg>`;
    const STAR_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.7 4.2 13.3l.7-4.3-3.1-3 4.3-.6z"/></svg>`;
    const PLAY_BADGE_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
    const PLAY_BADGE_SMALL = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;

    /** @returns {object} 全新的会话状态 */
    function createState() {
        return {
            items: [],
            albums: [],
            meta: {},
            view: "all",
            mode: readViewMode(),
            search: "",
            selection: new Set(),
            selecting: false,
            anchorId: null,
            importJobs: 0,
            preview: {
                open: false,
                items: [],
                index: -1,
                detailOpen: false,
                slideshow: false,
                timer: 0,
                zoom: 1,
                panX: 0,
                panY: 0,
                drag: null,
                pendingAutoplay: false,
                mediaSeq: 0,
                videoReadySeq: -1,
            },
        };
    }

    let state = createState();
    let disposed = false;
    let libraryReady = Promise.resolve();
    let layoutQueued = 0;

    // 分块渲染序号 / rAF：视图或数据变化时作废进行中的批次
    let renderSeq = 0;
    let renderFrame = 0;
    let renderScheduled = 0;

    // 预览代次：连点上一张/下一张时，异步取回的 URL 与事件只认最新一次
    let previewSeq = 0;

    // 预览期间持有的原图 URL（引用计数），同一时刻只保留当前与前后各一张
    const previewHeld = new Map();
    const previewPending = new Map();
    const previewKeep = new Set();

    // 缩略图后台生成队列（旧库没有缩略图时按需补）
    const thumbQueue = [];
    let thumbActive = 0;
    let metadataSaveTimer = 0;

    const videoPrefs = readVideoPrefs();
    let videoClickTimer = 0;
    let seekingVideo = false;
    let dragDepth = 0;
    let openingPath = null;

    // ---- DOM 引用 ----
    const els = {
        sidebarNav: win.querySelector(".sidebar-nav"),
        albumList: win.querySelector(".album-list"),
        searchInput: win.querySelector(".search-input"),
        searchClear: win.querySelector(".search-clear"),
        toolbarTitle: win.querySelector(".toolbar-title"),
        toolbarCount: win.querySelector(".toolbar-count"),
        segBtns: win.querySelectorAll(".seg-btn"),
        btnImport: win.querySelector(".btn-import"),
        btnExtMount: win.querySelector(".btn-extmount"),
        importLabel: win.querySelector(".import-label"),
        btnSelect: win.querySelector(".btn-select"),
        gridView: win.querySelector(".grid-view"),
        gridContent: win.querySelector(".grid-content"),
        listView: win.querySelector(".list-view"),
        listBody: win.querySelector(".list-body"),
        emptyState: win.querySelector(".empty-state"),
        emptyTitle: win.querySelector(".empty-title"),
        emptyHint: win.querySelector(".empty-hint"),
        emptyAction: win.querySelector(".empty-action"),
        selectionBar: win.querySelector(".selection-bar"),
        selectionCount: win.querySelector(".selection-count"),
        btnSelAlbum: win.querySelector(".btn-sel-album"),
        btnSelFavorite: win.querySelector(".btn-sel-favorite"),
        btnSelDelete: win.querySelector(".btn-sel-delete"),
        btnSelCancel: win.querySelector(".btn-sel-cancel"),
        previewOverlay: win.querySelector(".preview-overlay"),
        previewPosition: win.querySelector(".preview-position"),
        previewName: win.querySelector(".preview-name"),
        previewContent: win.querySelector(".preview-content"),
        previewStage: win.querySelector(".preview-stage"),
        previewImage: win.querySelector(".preview-image"),
        previewVideo: win.querySelector(".preview-video"),
        previewSpinner: win.querySelector(".preview-spinner"),
        previewError: win.querySelector(".preview-error"),
        previewFilmstrip: win.querySelector(".preview-filmstrip"),
        filmstripItems: win.querySelector(".filmstrip-items"),
        previewDetail: win.querySelector(".preview-detail"),
        detailClose: win.querySelector(".detail-close"),
        detailThumb: win.querySelector(".detail-thumb"),
        detailTitle: win.querySelector(".detail-title"),
        detailRows: win.querySelector(".detail-rows"),
        btnBack: win.querySelector(".btn-back"),
        btnPrev: win.querySelector(".btn-prev"),
        btnNext: win.querySelector(".btn-next"),
        btnRotateLeft: win.querySelector(".btn-rotate-left"),
        btnRotateRight: win.querySelector(".btn-rotate-right"),
        btnZoomOut: win.querySelector(".btn-zoom-out"),
        btnZoomIn: win.querySelector(".btn-zoom-in"),
        zoomSlider: win.querySelector(".zoom-slider"),
        btnSlideshow: win.querySelector(".btn-slideshow"),
        btnFullscreen: win.querySelector(".btn-fullscreen"),
        btnFavorite: win.querySelector(".preview-overlay .btn-favorite"),
        btnInfo: win.querySelector(".btn-info"),
        btnDelete: win.querySelector(".preview-overlay .btn-delete"),
        slideshowExit: win.querySelector(".slideshow-exit"),
        slideshowHint: win.querySelector(".slideshow-hint"),
        videoControls: win.querySelector(".video-controls"),
        vcProgress: win.querySelector(".vc-progress"),
        vcCurrent: win.querySelector(".vc-current"),
        vcDuration: win.querySelector(".vc-duration"),
        vcPlay: win.querySelector(".vc-play"),
        vcStop: win.querySelector(".vc-stop"),
        vcRewind: win.querySelector(".vc-rewind"),
        vcForward: win.querySelector(".vc-forward"),
        vcMute: win.querySelector(".vc-mute"),
        vcVolume: win.querySelector(".vc-volume"),
        vcFullscreen: win.querySelector(".vc-fullscreen"),
        fileInput: null,
    };

    /* ── 基础工具 ── */

    /** i18n 取词（带中文兜底，缺少语言包时界面不会空白）。 */
    const T = (key, fallback) => i18n.t(key, fallback);

    function makeId(prefix) {
        return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function normRotation(value) {
        const deg = Number(value);
        if (!Number.isFinite(deg)) return 0;
        return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
    }

    function extOf(name) {
        const text = String(name || "");
        const idx = text.lastIndexOf(".");
        return idx > 0 ? text.slice(idx + 1).toLowerCase() : "";
    }

    function baseName(path) {
        const parts = String(path || "").split(/[\\/]/);
        return parts[parts.length - 1] || "";
    }

    function typeLabel(type) {
        return type === "video" ? T("photos.type.video", "视频") : T("photos.type.image", "图片");
    }

    function formatSize(bytes) {
        const size = Number(bytes) || 0;
        if (size < 1024) return `${size} B`;
        if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
        return `${(size / (1024 * 1024)).toFixed(2)} MB`;
    }

    function formatDate(dateStr) {
        const d = new Date(dateStr);
        if (isNaN(d)) return "—";
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }

    function formatDuration(seconds) {
        const value = Number(seconds);
        if (!Number.isFinite(value)) return "--:--";
        if (value <= 0) return "0:00";
        const total = Math.floor(value);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        return `${m}:${String(s).padStart(2, "0")}`;
    }

    /** 外部挂载项目（ext://）判定：只读，删除/写入一律被 store 拒绝（Q2 越界不静默）。 */
    function isExternalItem(item) {
        return !!(item && typeof item.id === "string" && item.id.startsWith(EXTERNAL_ID_PREFIX));
    }

    /** 文件名 / MIME → image | video | null */
    function mediaKind(name, mime = "") {
        const ext = extOf(name);
        if (String(mime).startsWith("video/") || VIDEO_EXTS.has(ext)) return "video";
        if (String(mime).startsWith("image/") || IMAGE_EXTS.has(ext)) return "image";
        return null;
    }

    function cssEscape(value) {
        return String(value).replace(/["\\]/g, "\\$&");
    }

    function readViewMode() {
        try {
            return localStorage.getItem(MODE_KEY) === "list" ? "list" : "grid";
        } catch (e) {
            return "grid";
        }
    }

    function readVideoPrefs() {
        let volume = 1;
        let muted = false;
        try {
            const stored = parseFloat(localStorage.getItem(VOLUME_KEY));
            if (Number.isFinite(stored)) volume = clamp(stored, 0, 1);
            muted = localStorage.getItem(MUTED_KEY) === "1";
        } catch (e) { /* 隐私模式下读不到就用默认值 */ }
        return { volume, muted };
    }

    function storeVideoPrefs() {
        try {
            localStorage.setItem(VOLUME_KEY, String(videoPrefs.volume));
            localStorage.setItem(MUTED_KEY, videoPrefs.muted ? "1" : "0");
        } catch (e) { /* 读不到就只保留本次会话 */ }
    }

    function showError(title, message) {
        if (dialog && typeof dialog.error === "function") dialog.error(title, message);
        else console.error(`[photos] ${title}: ${message}`);
    }

    function showInfo(title, message) {
        if (dialog && typeof dialog.alert === "function") dialog.alert(title, message);
        else console.info(`[photos] ${title}: ${message}`);
    }

    function askText({ title, message = "", value = "", placeholder = "", okText }) {
        if (dialog && typeof dialog.prompt === "function") {
            return dialog.prompt(title, message, {
                value,
                placeholder,
                okText: okText || T("common.ok", "好"),
                cancelText: T("common.cancel", "取消"),
            });
        }
        console.warn("[photos] 系统弹窗不可用，输入按取消处理");
        return Promise.resolve(null);
    }

    function askConfirm(title, message, okText, danger = false) {
        if (dialog && typeof dialog.confirm === "function") {
            return dialog.confirm(title, message, {
                okText: okText || T("common.ok", "好"),
                cancelText: T("common.cancel", "取消"),
                danger,
            });
        }
        console.warn("[photos] 系统弹窗不可用，确认按取消处理");
        return Promise.resolve(false);
    }

    /* ── 多语言 ── */

    function setText(selector, key, fallback) {
        win.querySelectorAll(selector).forEach((el) => { el.textContent = T(key, fallback); });
    }

    function setTip(selector, key, fallback) {
        win.querySelectorAll(selector).forEach((el) => {
            const text = T(key, fallback);
            el.title = text;
            el.setAttribute("aria-label", text);
        });
    }

    function applyStaticI18n() {
        els.searchInput.placeholder = T("photos.search", "搜索");
        els.searchInput.title = T("photos.search", "搜索");
        els.searchClear.title = T("photos.clearSearch", "清除搜索");
        els.searchClear.setAttribute("aria-label", T("photos.clearSearch", "清除搜索"));

        const sections = win.querySelectorAll(".nav-section-title");
        if (sections[0]) sections[0].textContent = T("photos.section.library", "图库");
        if (sections[1]) sections[1].textContent = T("photos.section.albums", "相簿");
        if (sections[2]) sections[2].textContent = T("photos.section.smart", "智能相簿");

        setText('.nav-item[data-view="all"] span', "photos.view.all", "所有照片");
        setText('.nav-item[data-view="recent"] span', "photos.view.recent", "最近项目");
        setText('.nav-item[data-view="favorites"] span', "photos.view.favorites", "个人收藏");
        setText('.nav-item[data-view="trash"] span', "photos.view.trash", "已删除");
        setText('.nav-item[data-view="smart-video"] span', "photos.view.videos", "仅视频");
        setText('.nav-item[data-view="smart-image"] span', "photos.view.images", "仅图片");
        setText(".nav-add-album span", "photos.newAlbum", "新建相簿");

        setTip('.seg-btn[data-mode="grid"]', "photos.toolbar.grid", "网格视图");
        setTip('.seg-btn[data-mode="list"]', "photos.toolbar.list", "列表视图");
        setTip(".btn-import", "photos.import", "导入");
        setText(".list-col-name", "photos.list.name", "名称");
        setText(".list-col-type", "photos.list.type", "类型");
        setText(".list-col-date", "photos.list.date", "日期");
        setText(".list-col-size", "photos.list.size", "大小");

        setTip(".btn-sel-album", "photos.selection.addToAlbum", "添加到相簿");
        setTip(".btn-sel-favorite", "photos.selection.favorite", "收藏");
        setTip(".btn-sel-delete", "photos.selection.delete", "删除");
        setText(".btn-sel-cancel", "common.cancel", "取消");

        setTip(".btn-back", "photos.preview.back", "返回");
        setTip(".btn-prev", "photos.preview.prev", "上一张");
        setTip(".btn-next", "photos.preview.next", "下一张");
        setTip(".btn-rotate-left", "photos.preview.rotateLeft", "向左旋转");
        setTip(".btn-rotate-right", "photos.preview.rotateRight", "向右旋转");
        setTip(".btn-zoom-out", "photos.preview.zoomOut", "缩小");
        setTip(".btn-zoom-in", "photos.preview.zoomIn", "放大");
        els.zoomSlider.title = T("photos.preview.zoom", "缩放");
        els.zoomSlider.setAttribute("aria-label", T("photos.preview.zoom", "缩放"));
        setTip(".btn-favorite", "photos.preview.favorite", "收藏");
        setTip(".btn-info", "photos.preview.info", "信息");
        setTip(".btn-delete", "photos.preview.delete", "删除");
        setTip(".detail-close", "photos.preview.closeDetail", "关闭详情");
        setTip(".slideshow-exit", "photos.preview.stopSlideshow", "退出幻灯片");
        els.slideshowHint.textContent = T("photos.preview.slideshowHint", "幻灯片播放中 · 点击空白处或按 Esc 退出");
        win.querySelector(".drop-card p").textContent = T("photos.drop", "松开以导入到照片");

        setTip(".vc-play", "photos.video.play", "播放");
        setTip(".vc-stop", "photos.video.stop", "停止");
        setTip(".vc-rewind", "photos.video.rewind", "后退 10 秒");
        setTip(".vc-forward", "photos.video.forward", "前进 10 秒");
        setTip(".vc-mute", "photos.video.mute", "静音");
        setTip(".vc-fullscreen", "photos.preview.fullscreen", "全屏");
        els.vcVolume.title = T("photos.video.volume", "音量");
        els.vcVolume.setAttribute("aria-label", T("photos.video.volume", "音量"));
        els.vcProgress.setAttribute("aria-label", T("photos.video.progress", "播放进度"));

        updateSelectButton();
        updateImportUI();
        updateDynamicChrome();
    }

    /* ── 数据持久化 ── */

    function seedAlbums() {
        return [
            { id: makeId("album"), name: T("photos.album.travel", "旅行") },
            { id: makeId("album"), name: T("photos.album.work", "工作") },
            { id: makeId("album"), name: T("photos.album.family", "家人") },
        ];
    }

    function loadLibrary() {
        // 元数据（相簿归属/收藏/旋转等）按路径挂在 localStorage；
        // 媒体本体不在元数据里——/Picture/ 才是唯一真相（Q2）。
        let data = null;
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            data = raw ? JSON.parse(raw) : null;
        } catch (e) {
            console.warn("[photos] 媒体库元数据损坏，按空打开", e);
        }
        if (data && typeof data === "object") {
            state.meta = (data.meta && typeof data.meta === "object") ? data.meta : {};
            const albumSeen = new Set();
            state.albums = (Array.isArray(data.albums) ? data.albums : [])
                .filter((a) => a && typeof a.id === "string" && typeof a.name === "string")
                .filter((a) => !albumSeen.has(a.id) && albumSeen.add(a.id))
                .map((a) => ({ id: a.id, name: a.name }));
        } else {
            state.meta = {};
            // 只有首次打开才播种默认相簿：用户删掉的相簿不应该下次启动又长回来
            state.albums = seedAlbums();
            saveLibrary();
        }
    }

    /** 扫描 /Picture/ 建库（Q2：启动自动扫描），并把按路径存的元数据贴回条目上。 */
    async function scanIntoState() {
        const files = await scanLibrary().catch((err) => {
            console.warn("[photos] 扫描照片库失败：", err);
            return [];
        });
        if (disposed) return;
        state.items = files.map((f) => {
            const meta = state.meta[f.path] || {};
            return {
                id: f.path,
                name: f.name,
                type: f.type === "video" ? "video" : "image",
                size: Number(f.size) || 0,
                date: f.modified ? new Date(f.modified).toISOString() : new Date().toISOString(),
                favorite: !!meta.favorite,
                deleted: false,
                deletedAt: null,
                albumIds: Array.isArray(meta.albumIds) ? meta.albumIds : [],
                rotation: normRotation(meta.rotation),
                location: typeof meta.location === "string" ? meta.location : "",
                width: Number(meta.width) || 0,
                height: Number(meta.height) || 0,
                duration: Number(meta.duration) || 0,
                sourcePath: f.path,
                external: false,
            };
        });
        // 外部挂载（本会话内已授权的）合并进来，只读展示
        for (const mount of listExternalMounts()) {
            const extItems = await scanExternalMount(mount.id).catch(() => []);
            if (disposed) return;
            state.items.push(...extItems.map((f) => {
                const meta = state.meta[f.id] || {};
                return {
                    id: f.id,
                    name: f.name,
                    type: f.type,
                    size: Number(f.size) || 0,
                    date: f.modified ? new Date(f.modified).toISOString() : new Date().toISOString(),
                    favorite: !!meta.favorite,
                    deleted: false,
                    deletedAt: null,
                    albumIds: [],
                    rotation: normRotation(meta.rotation),
                    location: mount.name,
                    width: Number(meta.width) || 0,
                    height: Number(meta.height) || 0,
                    duration: Number(meta.duration) || 0,
                    sourcePath: "",
                    external: true,
                    mountName: mount.name,
                };
            }));
        }
    }

    function saveLibrary() {
        let payload;
        try {
            // 只持久化用户意图（收藏/相簿/旋转/位置）与惰性学到的尺寸时长，
            // 其余字段全部由扫描重建，避免元数据与库内容出现两个真相
            const meta = {};
            state.items.forEach((item) => {
                const entry = {};
                if (item.favorite) entry.favorite = true;
                if (item.albumIds && item.albumIds.length) entry.albumIds = item.albumIds;
                if (item.rotation) entry.rotation = item.rotation;
                if (item.location) entry.location = item.location;
                if (item.width) entry.width = item.width;
                if (item.height) entry.height = item.height;
                if (item.duration) entry.duration = item.duration;
                if (Object.keys(entry).length) meta[item.id] = entry;
            });
            payload = JSON.stringify({ version: 3, meta, albums: state.albums });
        } catch (e) {
            console.error("[photos] 媒体库元数据序列化失败", e);
            reportSaveFailure("serialize", e);
            return false;
        }
        try {
            localStorage.setItem(STORAGE_KEY, payload);
            return true;
        } catch (e) {
            console.warn("[photos] 保存媒体库元数据失败", e);
            reportSaveFailure("write", e);
            return false;
        }
    }

    function reportSaveFailure(stage, err) {
        if (!dialog) return;
        const isQuota = err && (err.name === "QuotaExceededError" || err.code === 22 || err.code === 1014);
        if (isQuota) {
            dialog.error(T("photos.errSaveTitle", "保存失败"), T("photos.errQuota", "浏览器本地存储已满，本次更改未保存。请删除部分项目，或清理浏览器存储后重试。"));
        } else if (stage === "serialize") {
            dialog.error(T("photos.errSaveTitle", "保存失败"), T("photos.errSerialize", "媒体库数据无法序列化，本次更改未保存。") + " " + (err && err.message ? err.message : ""));
        } else {
            dialog.error(T("photos.errSaveTitle", "保存失败"), T("photos.errSaveDetail", "本次更改未保存。") + " " + (err && err.message ? err.message : ""));
        }
    }

    function scheduleMetadataSave() {
        if (disposed || metadataSaveTimer) return;
        metadataSaveTimer = setTimeout(() => {
            metadataSaveTimer = 0;
            if (!disposed) saveLibrary();
        }, 800);
    }

    /* ── 缩略图与媒体分析 ── */

    function canvasToBlob(canvas) {
        return new Promise((resolve) => {
            canvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                    return;
                }
                // WebP 不可用时退回 PNG（仍保留透明通道）
                canvas.toBlob((png) => resolve(png || null), "image/png");
            }, "image/webp", 0.82);
        });
    }

    async function makeThumbBlob(source, width, height) {
        if (!width || !height) return null;
        const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(width, height));
        const w = Math.max(1, Math.round(width * scale));
        const h = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        try {
            ctx.drawImage(source, 0, 0, w, h);
        } catch (e) {
            return null;
        }
        return canvasToBlob(canvas);
    }

    function analyzeImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            let done = false;
            const finish = (fn) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                img.onload = null;
                img.onerror = null;
                fn();
            };
            const timer = setTimeout(() => finish(() => reject(new Error("图片解析超时"))), METADATA_TIMEOUT_MS);
            img.onload = () => {
                const width = img.naturalWidth || 0;
                const height = img.naturalHeight || 0;
                if (!width || !height) {
                    finish(() => resolve({ width: 0, height: 0, thumb: null }));
                    return;
                }
                makeThumbBlob(img, width, height)
                    .catch(() => null)
                    .then((thumb) => finish(() => resolve({ width, height, thumb })));
            };
            img.onerror = () => finish(() => reject(new Error("图片无法解码")));
            img.src = url;
        });
    }

    /**
     * 读取视频时长。MediaRecorder 产出的 WebM 常常没有时长头，duration 会一直是 Infinity；
     * 把它 seek 到一个极大时间点可逼浏览器 (re)compute duration。仅对未知时长调用。
     * @param {HTMLVideoElement} video 已装载元数据的视频元素
     * @param {number} timeout 最长等待
     * @returns {Promise<number>} 有限时长；仍未知则为 0
     */
    function probeFiniteDuration(video, timeout = 700) {
        if (Number.isFinite(video.duration)) return Promise.resolve(video.duration);
        if (!video.paused) return Promise.resolve(0);
        return new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                video.removeEventListener("durationchange", onChange);
                video.removeEventListener("timeupdate", onChange);
                resolve(Number.isFinite(video.duration) ? video.duration : 0);
            };
            const onChange = () => {
                if (Number.isFinite(video.duration)) finish();
            };
            video.addEventListener("durationchange", onChange);
            video.addEventListener("timeupdate", onChange);
            const timer = setTimeout(finish, timeout);
            try {
                video.currentTime = 1e101;
            } catch (e) {
                finish();
            }
        });
    }

    function analyzeVideo(url) {
        return new Promise((resolve) => {
            const video = document.createElement("video");
            let done = false;
            let started = false;
            video.muted = true;
            video.playsInline = true;
            video.preload = "auto";

            const cleanup = () => {
                clearTimeout(timer);
                video.onloadeddata = null;
                video.onerror = null;
                try { video.pause(); } catch (e) { /* 尚未开始播放 */ }
                video.removeAttribute("src");
                try { video.load(); } catch (e) { /* 元素已脱离文档 */ }
            };
            const finish = (meta) => {
                if (done) return;
                done = true;
                cleanup();
                resolve(meta);
            };
            const fail = () => finish({ width: 0, height: 0, duration: 0, thumb: null });
            const timer = setTimeout(fail, METADATA_TIMEOUT_MS);

            video.onerror = fail;
            video.onloadeddata = async () => {
                if (started) return;
                started = true;
                const width = video.videoWidth || 0;
                const height = video.videoHeight || 0;
                let duration = Number.isFinite(video.duration) ? video.duration : 0;
                if (!duration) {
                    duration = await probeFiniteDuration(video);
                    if (duration > 0) {
                        try { video.currentTime = 0; } catch (e) { /* 无法 seek 的视频 */ }
                    }
                }
                if (!width || !height) {
                    finish({ width, height, duration, thumb: null });
                    return;
                }
                try {
                    if (duration > 0.4) {
                        video.currentTime = Math.min(0.1, duration * 0.08);
                        await new Promise((doneSeek) => {
                            const t = setTimeout(doneSeek, 1200);
                            video.addEventListener("seeked", () => { clearTimeout(t); doneSeek(); }, { once: true });
                        });
                    }
                } catch (e) { /* 某些格式不支持 seek，直接画首帧 */ }
                let thumb = null;
                try { thumb = await makeThumbBlob(video, width, height); } catch (e) { thumb = null; }
                finish({ width, height, duration, thumb });
            };
            video.src = url;
        });
    }

    async function analyzeMedia(blob, type) {
        const url = URL.createObjectURL(blob);
        try {
            return type === "video" ? await analyzeVideo(url) : await analyzeImage(url);
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    function queueThumb(item) {
        if (disposed || !item) return;
        if (item._thumbState === "pending" || item._thumbState === "ready" || item._thumbState === "failed") return;
        item._thumbState = "pending";
        thumbQueue.push(item);
        pumpThumbQueue();
    }

    function pumpThumbQueue() {
        while (!disposed && thumbActive < 2 && thumbQueue.length) {
            const item = thumbQueue.shift();
            thumbActive++;
            generateThumb(item).finally(() => {
                thumbActive--;
                pumpThumbQueue();
            });
        }
    }

    async function generateThumb(item) {
        try {
            const blob = await getMedia(item.id);
            if (!blob) throw new Error("媒体数据缺失");
            const meta = await analyzeMedia(blob, item.type);
            let changed = false;
            if (meta.width && !item.width) { item.width = meta.width; changed = true; }
            if (meta.height && !item.height) { item.height = meta.height; changed = true; }
            if (meta.duration && !item.duration) { item.duration = meta.duration; changed = true; }
            if (meta.thumb) {
                await putThumb(item.id, meta.thumb);
                item._thumbState = "ready";
                if (!disposed) {
                    refreshThumbDOM(item.id);
                    refreshDurationDOM(item.id);
                    updateDetailIfCurrent(item);
                }
            } else {
                item._thumbState = "failed";
            }
            if (changed) scheduleMetadataSave();
        } catch (e) {
            item._thumbState = "failed";
        }
    }

    function applyRotationToElement(el, item) {
        if (!el) return;
        el.style.transform = item.rotation ? `rotate(${item.rotation}deg)` : "";
    }

    function bindThumb(el, item, seq = null) {
        if (!el) return;
        el.classList.add("thumb-media");
        el.dataset.id = item.id;
        applyRotationToElement(el, item);
        el.onload = () => el.classList.add("loaded");
        el.onerror = () => el.classList.remove("loaded");

        if (isInlineSource(item)) {
            el.src = item.src;
            return;
        }
        getThumbURL(item.id).then((url) => {
            if (seq != null && (seq !== renderSeq || !el.isConnected)) return;
            if (!url) {
                if (el.isConnected) queueThumb(item);
                return;
            }
            el.src = url;
            if (el.complete && el.naturalWidth) el.classList.add("loaded");
        }).catch(() => {
            if (el.isConnected) queueThumb(item);
        });
    }

    function refreshThumbDOM(id) {
        const selector = `.thumb-media[data-id="${cssEscape(id)}"]`;
        const item = findItem(id);
        if (!item) return;
        getThumbURL(id).then((url) => {
            if (!url || disposed) return;
            win.querySelectorAll(selector).forEach((el) => {
                if (el.src !== url) el.src = url;
                if (el.complete && el.naturalWidth) el.classList.add("loaded");
            });
        }).catch(() => {});
    }

    function refreshDurationDOM(id) {
        const item = findItem(id);
        if (!item || item.type !== "video") return;
        win.querySelectorAll(`[data-id="${cssEscape(id)}"] .video-duration`).forEach((el) => {
            el.textContent = formatDuration(item.duration);
        });
    }

    function refreshRotationDOM(id) {
        const item = findItem(id);
        if (!item) return;
        win.querySelectorAll(`.thumb-media[data-id="${cssEscape(id)}"]`).forEach((el) => {
            applyRotationToElement(el, item);
        });
        if (state.preview.open && currentPreviewItem() && currentPreviewItem().id === id) {
            applyImageTransform();
        }
    }

    function updateDetailIfCurrent(item) {
        if (!state.preview.open || !state.preview.detailOpen) return;
        const current = currentPreviewItem();
        if (current && current.id === item.id) renderDetail(current);
    }

    /* ── 查询与视图 ── */

    function findItem(id) {
        return state.items.find((item) => item.id === id);
    }

    function findAlbum(id) {
        return state.albums.find((album) => album.id === id);
    }

    function sortByDate(items) {
        return [...items].sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    function getVisibleItems() {
        let items = state.items;
        switch (state.view) {
            case "recent":
                items = sortByDate(items.filter((i) => !i.deleted)).slice(0, 50);
                break;
            case "favorites":
                items = sortByDate(items.filter((i) => i.favorite && !i.deleted));
                break;
            case "trash":
                items = [...items.filter((i) => i.deleted)].sort((a, b) => new Date(b.deletedAt || b.date) - new Date(a.deletedAt || a.date));
                break;
            case "smart-video":
                items = sortByDate(items.filter((i) => i.type === "video" && !i.deleted));
                break;
            case "smart-image":
                items = sortByDate(items.filter((i) => i.type === "image" && !i.deleted));
                break;
            default:
                if (state.view.startsWith("album-")) {
                    const albumId = state.view.slice(6);
                    items = sortByDate(items.filter((i) => i.albumIds && i.albumIds.includes(albumId) && !i.deleted));
                } else {
                    items = sortByDate(items.filter((i) => !i.deleted));
                }
        }

        const keyword = state.search.trim().toLowerCase();
        if (keyword) {
            items = items.filter((item) => {
                const name = (item.name || "").toLowerCase();
                const date = formatDate(item.date).toLowerCase();
                const type = typeLabel(item.type).toLowerCase();
                return name.includes(keyword) || date.includes(keyword) || type.includes(keyword) || item.type.includes(keyword);
            });
        }
        return items;
    }

    function getViewTitle() {
        switch (state.view) {
            case "all": return T("photos.view.all", "所有照片");
            case "recent": return T("photos.view.recent", "最近项目");
            case "favorites": return T("photos.view.favorites", "个人收藏");
            case "trash": return T("photos.view.trash", "已删除");
            case "smart-video": return T("photos.view.videos", "仅视频");
            case "smart-image": return T("photos.view.images", "仅图片");
            default:
                if (state.view.startsWith("album-")) {
                    const album = findAlbum(state.view.slice(6));
                    return album ? album.name : T("photos.view.album", "相簿");
                }
                return T("photos.view.all", "所有照片");
        }
    }

    /* ── 主界面渲染 ── */

    function stopChunkedRender() {
        renderSeq++;
        if (renderFrame) {
            cancelAnimationFrame(renderFrame);
            renderFrame = 0;
        }
    }

    function scheduleRender() {
        if (disposed || renderScheduled) return;
        renderScheduled = requestAnimationFrame(() => {
            renderScheduled = 0;
            render();
        });
    }

    function updateToolbar(count) {
        els.toolbarTitle.textContent = getViewTitle();
        els.toolbarCount.textContent = `${count} ${T("photos.countUnit", "项")}`;
    }

    function render() {
        if (disposed) return;
        stopChunkedRender();
        updateSelectButton();
        const items = getVisibleItems();
        updateToolbar(items.length);

        if (!items.length) {
            state.selection.clear();
            state.anchorId = null;
            showEmptyState();
            updateSelectionBar();
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
    }

    function showEmptyState() {
        els.gridView.classList.remove("active");
        els.listView.classList.remove("active");
        els.gridContent.innerHTML = "";
        els.listBody.innerHTML = "";
        els.emptyState.classList.add("show");
        updateSelectionBar();

        let kind = "all";
        if (state.search.trim()) kind = "search";
        else if (state.view === "trash") kind = "trash";
        else if (state.view === "favorites") kind = "favorites";
        else if (state.view.startsWith("album-")) kind = "album";
        else if (state.view === "smart-video") kind = "videos";
        else if (state.view === "smart-image") kind = "images";

        const texts = {
            all: ["photos.empty.all.title", "没有照片", "photos.empty.all.hint", "点击「导入」按钮，或把图片、视频拖进窗口", "photos.import", "导入", "import"],
            search: ["photos.empty.search.title", "没有找到结果", "photos.empty.search.hint", "试试其他关键词，或清除搜索。", "photos.clearSearch", "清除搜索", "clear"],
            trash: ["photos.empty.trash.title", "没有已删除的项目", "photos.empty.trash.hint", "移到「已删除」的项目会出现在这里。", null, "", null],
            favorites: ["photos.empty.favorites.title", "没有个人收藏", "photos.empty.favorites.hint", "在项目上点右键，或打开预览后点星标即可收藏。", null, "", null],
            album: ["photos.empty.album.title", "相簿是空的", "photos.empty.album.hint", "在「所有照片」中选择项目，再添加到这个相簿。", "photos.empty.album.action", "前往所有照片", "all"],
            videos: ["photos.empty.videos.title", "没有视频", "photos.empty.videos.hint", "导入的视频会显示在这里。", "photos.import", "导入", "import"],
            images: ["photos.empty.images.title", "没有图片", "photos.empty.images.hint", "导入的图片会显示在这里。", "photos.import", "导入", "import"],
        }[kind];

        els.emptyTitle.textContent = T(texts[0], texts[1]);
        els.emptyHint.textContent = T(texts[2], texts[3]);
        const hasAction = !!texts[5];
        els.emptyAction.hidden = !hasAction;
        if (hasAction) {
            els.emptyAction.textContent = T(texts[4], texts[5]);
            els.emptyState.dataset.action = texts[6] || "";
            els.emptyAction.disabled = texts[6] === "import" && state.importJobs > 0;
        } else {
            els.emptyState.dataset.action = "";
        }
    }

    function createGridItem(item) {
        const el = document.createElement("div");
        el.className = "grid-item";
        el.dataset.id = item.id;
        el.title = item.name || "";
        if (item.type === "video") el.classList.add("video-item");
        else el.classList.add("image-item");
        if (state.selection.has(item.id)) el.classList.add("selected");
        if (item.favorite) el.classList.add("favorite");

        const img = document.createElement("img");
        img.className = "grid-thumb";
        img.alt = item.name || "";
        img.loading = "lazy";
        img.decoding = "async";
        img.draggable = false;
        bindThumb(img, item, renderSeq);
        el.appendChild(img);

        const fav = document.createElement("span");
        fav.className = "fav-badge";
        fav.innerHTML = STAR_SVG;
        el.appendChild(fav);

        if (item.type === "video") {
            const badge = document.createElement("div");
            badge.className = "video-badge";
            badge.innerHTML = PLAY_BADGE_SVG;
            const duration = document.createElement("div");
            duration.className = "video-duration";
            duration.textContent = formatDuration(item.duration);
            el.appendChild(badge);
            el.appendChild(duration);
        }

        el.addEventListener("click", (e) => onItemClick(e, item));
        el.addEventListener("dblclick", (e) => onItemDblClick(e, item));
        el.addEventListener("contextmenu", (e) => onItemContextMenu(e, item));
        return el;
    }

    function renderGrid(items) {
        const seq = renderSeq;
        els.gridContent.innerHTML = "";
        if (!items.length) {
            updateSelectionBar();
            return;
        }
        let i = 0;
        const step = () => {
            if (seq !== renderSeq) return;
            const batch = i === 0 ? Math.ceil(RENDER_CHUNK / 2) : RENDER_CHUNK;
            const end = Math.min(i + batch, items.length);
            for (; i < end; i++) {
                els.gridContent.appendChild(createGridItem(items[i]));
            }
            if (i < items.length) {
                renderFrame = requestAnimationFrame(step);
            } else {
                renderFrame = 0;
                refreshSelectionDOM();
            }
        };
        step();
    }

    function createListRow(item) {
        const row = document.createElement("div");
        row.className = "list-row";
        row.dataset.id = item.id;
        row.title = item.name || "";
        if (state.selection.has(item.id)) row.classList.add("selected");
        if (item.favorite) row.classList.add("favorite");

        const thumbCol = document.createElement("div");
        thumbCol.className = "list-col list-col-thumb";
        const img = document.createElement("img");
        img.className = "list-thumb";
        img.alt = "";
        img.loading = "lazy";
        img.decoding = "async";
        img.draggable = false;
        bindThumb(img, item, renderSeq);
        thumbCol.appendChild(img);

        const nameCol = document.createElement("div");
        nameCol.className = "list-col list-col-name";
        nameCol.textContent = item.name || "";
        const typeCol = document.createElement("div");
        typeCol.className = "list-col list-col-type";
        typeCol.textContent = typeLabel(item.type);
        const dateCol = document.createElement("div");
        dateCol.className = "list-col list-col-date";
        dateCol.textContent = formatDate(item.date);
        const sizeCol = document.createElement("div");
        sizeCol.className = "list-col list-col-size";
        sizeCol.textContent = formatSize(item.size);

        row.append(thumbCol, nameCol, typeCol, dateCol, sizeCol);
        row.addEventListener("click", (e) => onItemClick(e, item));
        row.addEventListener("dblclick", (e) => onItemDblClick(e, item));
        row.addEventListener("contextmenu", (e) => onItemContextMenu(e, item));
        return row;
    }

    function renderList(items) {
        const seq = renderSeq;
        els.listBody.innerHTML = "";
        if (!items.length) {
            updateSelectionBar();
            return;
        }
        let i = 0;
        const step = () => {
            if (seq !== renderSeq) return;
            const batch = i === 0 ? Math.ceil(RENDER_CHUNK / 2) : RENDER_CHUNK;
            const end = Math.min(i + batch, items.length);
            for (; i < end; i++) {
                els.listBody.appendChild(createListRow(items[i]));
            }
            if (i < items.length) {
                renderFrame = requestAnimationFrame(step);
            } else {
                renderFrame = 0;
                refreshSelectionDOM();
            }
        };
        step();
    }

    /* ── 侧边栏 / 相簿 ── */

    function renderAlbumNav() {
        if (disposed) return;
        win.querySelectorAll(".nav-album-dynamic").forEach((el) => el.remove());
        const addItem = win.querySelector(".nav-add-album");
        if (!els.albumList || !addItem) return;

        state.albums.forEach((album) => {
            const li = document.createElement("li");
            li.className = "nav-item nav-album-dynamic";
            li.dataset.view = `album-${album.id}`;
            li.dataset.albumId = album.id;
            li.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 11.5l4-4 3.5 3.5 3-3 2.5 2.5"/></svg>`;
            const name = document.createElement("span");
            name.textContent = album.name;
            const count = document.createElement("span");
            count.className = "nav-count";
            count.textContent = String(state.items.filter((i) => !i.deleted && i.albumIds && i.albumIds.includes(album.id)).length);
            li.append(name, count);
            if (state.view === `album-${album.id}`) li.classList.add("active");
            els.albumList.insertBefore(li, addItem);
        });
        setActiveNav(state.view);
    }

    function setActiveNav(view) {
        win.querySelectorAll(".nav-item[data-view]").forEach((el) => {
            el.classList.toggle("active", el.dataset.view === view);
        });
    }

    function setView(view) {
        if (view.startsWith("album-") && !findAlbum(view.slice(6))) view = "all";
        state.view = view;
        state.search = "";
        els.searchInput.value = "";
        updateSearchClear();
        clearSelection();
        setActiveNav(view);
        els.gridView.scrollTop = 0;
        els.listBody.scrollTop = 0;
        render();
    }

    function resetToAllView() {
        if (state.view !== "all") {
            state.view = "all";
            setActiveNav("all");
        }
        if (state.search) {
            state.search = "";
            els.searchInput.value = "";
            updateSearchClear();
        }
        state.selection.clear();
        state.anchorId = null;
    }

    function updateSearchClear() {
        els.searchClear.hidden = !els.searchInput.value;
    }

    function updateSelectButton() {
        if (!els.btnSelect) return;
        const text = state.selecting ? T("photos.selectDone", "完成") : T("photos.select", "选择");
        els.btnSelect.textContent = text;
        els.btnSelect.title = text;
        els.btnSelect.classList.toggle("active", state.selecting);
    }

    function clearSelection() {
        state.selection.clear();
        state.anchorId = null;
        state.selecting = false;
        updateSelectButton();
        refreshSelectionDOM();
    }

    function toggleSelection(id) {
        if (state.selection.has(id)) {
            state.selection.delete(id);
        } else {
            state.selection.add(id);
            state.anchorId = id;
        }
        refreshSelectionDOM();
    }

    function selectOnly(id) {
        state.selection.clear();
        state.selection.add(id);
        state.anchorId = id;
        refreshSelectionDOM();
    }

    function selectRangeTo(id) {
        const items = getVisibleItems();
        const target = items.findIndex((item) => item.id === id);
        if (target < 0) return;
        let anchor = state.selection.has(state.anchorId) ? items.findIndex((item) => item.id === state.anchorId) : -1;
        if (anchor < 0) {
            const first = items.findIndex((item) => state.selection.has(item.id));
            anchor = first >= 0 ? first : target;
        }
        const from = Math.min(anchor, target);
        const to = Math.max(anchor, target);
        for (let i = from; i <= to; i++) state.selection.add(items[i].id);
        refreshSelectionDOM();
    }

    function selectAllVisible() {
        const items = getVisibleItems();
        if (!items.length) return;
        items.forEach((item) => state.selection.add(item.id));
        state.anchorId = state.anchorId || items[0].id;
        refreshSelectionDOM();
    }

    function refreshSelectionDOM() {
        win.classList.toggle("selecting", state.selecting);
        win.querySelectorAll(".grid-item, .list-row").forEach((el) => {
            el.classList.toggle("selected", state.selection.has(el.dataset.id));
        });
        updateSelectionBar();
    }

    function updateSelectionBar() {
        if (!els.selectionBar) return;
        const count = state.selection.size;
        if (!count) {
            els.selectionBar.classList.remove("show");
            return;
        }
        els.selectionBar.classList.add("show");
        els.selectionCount.textContent = `${T("photos.selected", "已选择")} ${count} ${T("photos.countUnit", "项")}`;

        const selected = Array.from(state.selection).map(findItem).filter(Boolean);
        const allFavorite = selected.length > 0 && selected.every((item) => item.favorite);
        els.btnSelFavorite.classList.toggle("active", allFavorite);
        const favTitle = allFavorite ? T("photos.menu.unfavorite", "取消收藏") : T("photos.menu.favorite", "添加收藏");
        els.btnSelFavorite.title = favTitle;
        els.btnSelFavorite.setAttribute("aria-label", favTitle);
        const deleteTitle = state.view === "trash" ? T("photos.preview.permanentDelete", "永久删除") : T("photos.menu.delete", "删除");
        els.btnSelDelete.title = deleteTitle;
        els.btnSelDelete.setAttribute("aria-label", deleteTitle);
    }

    function moveSelection(dx, dy) {
        const items = getVisibleItems();
        if (!items.length) return;
        let idx = -1;
        if (state.anchorId) idx = items.findIndex((item) => item.id === state.anchorId && state.selection.has(item.id));
        if (idx < 0) idx = items.findIndex((item) => state.selection.has(item.id));
        if (idx < 0) {
            selectOnly(items[0].id);
            scrollItemIntoView(items[0].id);
            return;
        }
        const columns = state.mode === "grid" ? getGridColumnCount() : 1;
        let next = idx;
        if (dx) next = idx + dx;
        else if (dy) next = idx + dy * columns;
        next = clamp(next, 0, items.length - 1);
        selectOnly(items[next].id);
        scrollItemIntoView(items[next].id);
    }

    function getGridColumnCount() {
        const template = getComputedStyle(els.gridContent).gridTemplateColumns;
        const count = template.split(" ").filter(Boolean).length;
        return Math.max(1, count);
    }

    function scrollItemIntoView(id) {
        const el = win.querySelector(`.grid-item[data-id="${cssEscape(id)}"], .list-row[data-id="${cssEscape(id)}"]`);
        if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
    }

    function setMode(mode) {
        state.mode = mode === "list" ? "list" : "grid";
        try { localStorage.setItem(MODE_KEY, state.mode); } catch (e) { /* 隐私模式 */ }
        els.segBtns.forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === state.mode));
        render();
    }

    function onItemClick(e, item) {
        if (e.shiftKey) {
            selectRangeTo(item.id);
            return;
        }
        if (e.metaKey || e.ctrlKey) {
            toggleSelection(item.id);
            return;
        }
        if (state.selecting) {
            toggleSelection(item.id);
            return;
        }
        selectOnly(item.id);
    }

    function onItemDblClick(e, item) {
        e.preventDefault();
        selectOnly(item.id);
        openPreview(item.id);
    }

    /* ── 预览：生命周期 ── */

    function currentPreviewItem() {
        return state.preview.items[state.preview.index] || null;
    }

    function openPreview(id, options = {}) {
        const items = getVisibleItems();
        const idx = items.findIndex((item) => item.id === id);
        if (idx < 0) return;

        const wasOpen = state.preview.open;
        stopSlideshow({ pauseVideo: false });
        state.preview.items = items;
        state.preview.index = idx;
        state.preview.open = true;
        state.preview.detailOpen = !!options.detail;
        state.preview.slideshow = false;
        clearSlideTimer();
        els.previewOverlay.classList.remove("slideshow");
        els.previewDetail.classList.toggle("show", state.preview.detailOpen);
        els.previewOverlay.classList.toggle("detail-open", state.preview.detailOpen);
        els.previewOverlay.classList.add("show");
        renderFilmstrip();
        resetZoomState();
        updatePreview();
        els.previewOverlay.focus({ preventScroll: true });
        if (!wasOpen) updateFullscreenUI();
    }

    function closePreview() {
        if (!state.preview.open) return;
        stopSlideshow({ pauseVideo: true });
        const wasFullscreen = document.fullscreenElement === els.previewOverlay;
        state.preview.open = false;
        previewSeq++;
        clearPreviewMedia();
        previewKeep.clear();
        syncPreviewHeld();
        state.preview.items = [];
        state.preview.index = -1;
        state.preview.detailOpen = false;
        clearSlideTimer();
        els.previewOverlay.classList.remove("show", "is-video", "is-image", "zoomed", "dragging", "slideshow", "detail-open");
        els.previewDetail.classList.remove("show");
        els.filmstripItems.innerHTML = "";
        els.previewFilmstrip.classList.remove("show");
        els.previewName.textContent = "";
        els.previewPosition.textContent = "";
        resetZoomState();
        updateFullscreenUI();
        if (wasFullscreen) document.exitFullscreen().catch(() => {});
    }

    function updatePreview(options = {}) {
        const item = currentPreviewItem();
        if (!item) {
            closePreview();
            return;
        }
        const seq = ++previewSeq;
        state.preview.mediaSeq = seq;
        updatePreviewChrome(item);
        clearPreviewMedia();
        updatePreviewKeep(item);
        if (!options.preserveZoom) resetZoomState();

        els.previewSpinner.hidden = false;
        els.previewError.hidden = true;
        els.previewError.textContent = "";

        acquirePreviewUrl(item).then((url) => {
            if (seq !== previewSeq || !state.preview.open) return;
            if (item.type === "video") {
                loadPreviewVideo(url, options.autoplay);
            } else {
                showPreviewImage(item, url, seq);
            }
            prefetchNeighbors(item);
        }).catch((err) => {
            if (seq !== previewSeq) return;
            els.previewSpinner.hidden = true;
            showPreviewError(T("photos.mediaMissingDetail", "该项目的媒体数据不在本地库中（可能已被清理）。") + (err && err.message ? ` (${err.message})` : ""));
        });

        if (state.preview.slideshow) scheduleSlide();
    }

    function updatePreviewChrome(item) {
        els.previewOverlay.classList.toggle("is-video", item.type === "video");
        els.previewOverlay.classList.toggle("is-image", item.type !== "video");
        els.previewPosition.textContent = `${state.preview.index + 1} / ${state.preview.items.length}`;
        els.previewName.textContent = item.name || "";
        els.btnPrev.disabled = !state.preview.slideshow && state.preview.index <= 0;
        els.btnNext.disabled = !state.preview.slideshow && state.preview.index >= state.preview.items.length - 1;
        els.btnInfo.classList.toggle("active", state.preview.detailOpen);
        updateFavoriteButton(item);
        updateSlideshowUI();
        updateFullscreenUI();
        updateDynamicChrome();
        updateFilmstripActive();
        if (state.preview.detailOpen) renderDetail(item);
    }

    function prefetchNeighbors(item) {
        const list = state.preview.items;
        const index = state.preview.index;
        [list[index - 1], list[index + 1]].forEach((neighbor) => {
            if (!neighbor || neighbor.type !== "image") return;
            acquirePreviewUrl(neighbor).then(() => syncPreviewHeld()).catch(() => {});
        });
    }

    // ---- 原图 URL 引用管理 ----

    function acquirePreviewUrl(item) {
        if (!item) return Promise.resolve(null);
        const id = item.id;
        const held = previewHeld.get(id);
        if (held) return Promise.resolve(held);
        const pending = previewPending.get(id);
        if (pending) return pending;
        const task = getMediaURL(id).then((url) => {
            previewPending.delete(id);
            const existing = previewHeld.get(id);
            if (existing) {
                releaseMediaURL(id);
                return existing;
            }
            previewHeld.set(id, url);
            return url;
        }).catch((err) => {
            previewPending.delete(id);
            throw err;
        });
        previewPending.set(id, task);
        return task;
    }

    function releasePreviewHeld(id) {
        if (previewPending.has(id)) {
            previewPending.get(id).then(() => {
                if (previewKeep.has(id)) return;
                if (previewHeld.has(id)) {
                    releaseMediaURL(id);
                    previewHeld.delete(id);
                }
            }).catch(() => {});
            return;
        }
        if (!previewHeld.has(id)) return;
        releaseMediaURL(id);
        previewHeld.delete(id);
    }

    function syncPreviewHeld() {
        [...previewHeld.keys()].forEach((id) => {
            if (!previewKeep.has(id)) releasePreviewHeld(id);
        });
        [...previewPending.keys()].forEach((id) => {
            if (!previewKeep.has(id)) releasePreviewHeld(id);
        });
    }

    function updatePreviewKeep(item) {
        previewKeep.clear();
        const list = state.preview.items;
        const index = state.preview.index;
        if (item) previewKeep.add(item.id);
        // 只预热图片邻居；视频邻居不预取，避免同时占住三份视频 Blob
        [list[index - 1], list[index + 1]].forEach((entry) => {
            if (entry && entry.type === "image") previewKeep.add(entry.id);
        });
        syncPreviewHeld();
    }

    /* ── 预览：媒体装载 ── */

    function clearPreviewMedia() {
        resetVideoElement();
        const img = els.previewImage;
        img.onload = null;
        img.onerror = null;
        img.removeAttribute("src");
        img.style.display = "none";
        img.style.transform = "";
        img.style.maxWidth = "";
        img.style.maxHeight = "";
        els.previewSpinner.hidden = true;
        els.previewError.hidden = true;
        els.previewError.textContent = "";
    }

    function showPreviewImage(item, url, seq) {
        const img = els.previewImage;
        img.alt = item.name || "";
        img.onload = () => {
            if (seq !== previewSeq) return;
            img.style.display = "block";
            applyPreviewFit();
            clampPan();
            applyImageTransform();
            els.previewSpinner.hidden = true;
            els.previewError.hidden = true;
        };
        img.onerror = () => {
            if (seq !== previewSeq) return;
            els.previewSpinner.hidden = true;
            showPreviewError(T("photos.mediaMissingDetail", "该项目的媒体数据不在本地库中（可能已被清理）。"));
        };
        img.src = url;
    }

    function loadPreviewVideo(url, autoplay) {
        const video = els.previewVideo;
        state.preview.pendingAutoplay = !!autoplay;
        state.preview.videoReadySeq = -1;
        video.style.display = "none";
        els.previewImage.style.display = "none";
        video.volume = videoPrefs.volume;
        video.muted = videoPrefs.muted;
        video.src = url;
        try { video.load(); } catch (e) { /* 元素尚未挂载 */ }
        els.previewSpinner.hidden = false;
        syncVideoElementUI();
    }

    /**
     * loadeddata 之后收尾：无时长头的视频先探测有限时长，再显示画面 / 自动播放。
     * 探测会 seek 到极大时间点，必须在开始播放之前完成，否则画面会跳到片尾。
     * @param {number} seq 预览代次
     * @returns {Promise<void>}
     */
    async function finalizeVideoReady(seq) {
        const video = els.previewVideo;
        if (!isCurrentVideo() || seq !== state.preview.mediaSeq) return;
        let duration = video.duration;
        if (!Number.isFinite(duration)) {
            duration = await probeFiniteDuration(video);
            if (!isCurrentVideo() || seq !== state.preview.mediaSeq) return;
            if (duration > 0) {
                try { video.currentTime = 0; } catch (e) { /* 流式视频无法回跳 */ }
            }
        }
        if (!isCurrentVideo() || seq !== state.preview.mediaSeq) return;
        els.vcDuration.textContent = formatDuration(duration);
        video.style.display = "block";
        els.previewSpinner.hidden = true;
        els.previewError.hidden = true;
        syncVideoElementUI();
        if (state.preview.pendingAutoplay) {
            state.preview.pendingAutoplay = false;
            requestVideoPlay();
        }
        if (state.preview.slideshow) scheduleSlide();
    }

    function showPreviewError(message) {
        els.previewError.textContent = message;
        els.previewError.hidden = false;
    }

    /* ── 预览：导航 / 缩放 / 旋转 ── */

    function previewGo(delta) {
        const total = state.preview.items.length;
        if (!total) return;
        let next = state.preview.index + delta;
        if (state.preview.slideshow) next = (next % total + total) % total;
        if (next < 0 || next >= total) return;
        state.preview.index = next;
        updatePreview({ autoplay: state.preview.slideshow });
    }

    function goToPreview(index) {
        if (index < 0 || index >= state.preview.items.length) return;
        state.preview.index = index;
        updatePreview({ autoplay: state.preview.slideshow });
    }

    function resetZoomState() {
        state.preview.zoom = 1;
        state.preview.panX = 0;
        state.preview.panY = 0;
        if (els.previewOverlay) els.previewOverlay.classList.remove("zoomed");
        updateZoomUI();
        if (els.previewImage) els.previewImage.style.transform = "";
    }

    function updateZoomUI() {
        const zoom = state.preview.zoom;
        els.zoomSlider.value = String(zoom);
        const percent = `${Math.round(zoom * 100)}%`;
        els.zoomSlider.title = `${T("photos.preview.zoom", "缩放")} ${percent}`;
        els.zoomSlider.setAttribute("aria-valuetext", percent);
        els.previewOverlay.classList.toggle("zoomed", zoom > 1.001);
    }

    function applyPreviewFit() {
        const item = currentPreviewItem();
        if (!item || item.type === "video") return;
        const stage = els.previewStage;
        const width = stage.clientWidth;
        const height = stage.clientHeight;
        if (!width || !height) return;
        const rotated = normRotation(item.rotation) % 180 !== 0;
        els.previewImage.style.maxWidth = `${rotated ? height : width}px`;
        els.previewImage.style.maxHeight = `${rotated ? width : height}px`;
    }

    function clampPan() {
        const item = currentPreviewItem();
        const img = els.previewImage;
        if (!item || item.type === "video" || !img.clientWidth || !img.clientHeight) {
            state.preview.panX = 0;
            state.preview.panY = 0;
            return;
        }
        const zoom = state.preview.zoom;
        const rotated = normRotation(item.rotation) % 180 !== 0;
        const boundW = (rotated ? img.clientHeight : img.clientWidth) * zoom;
        const boundH = (rotated ? img.clientWidth : img.clientHeight) * zoom;
        const maxX = Math.max(0, (boundW - els.previewStage.clientWidth) / 2);
        const maxY = Math.max(0, (boundH - els.previewStage.clientHeight) / 2);
        state.preview.panX = clamp(state.preview.panX, -maxX, maxX);
        state.preview.panY = clamp(state.preview.panY, -maxY, maxY);
    }

    function applyImageTransform() {
        const item = currentPreviewItem();
        const img = els.previewImage;
        if (!item || item.type === "video") return;
        const { zoom, panX, panY } = state.preview;
        img.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom}) rotate(${normRotation(item.rotation)}deg)`;
    }

    function zoomAt(nextZoom, clientX, clientY) {
        const item = currentPreviewItem();
        if (!item || item.type === "video") return;
        const next = clamp(nextZoom, 1, 4);
        const prev = state.preview.zoom;
        if (Math.abs(next - prev) < 0.001) return;

        const rect = els.previewStage.getBoundingClientRect();
        if (rect.width && rect.height) {
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const px = clientX - cx;
            const py = clientY - cy;
            const qx = (px - state.preview.panX) / prev;
            const qy = (py - state.preview.panY) / prev;
            state.preview.panX = px - qx * next;
            state.preview.panY = py - qy * next;
        }
        state.preview.zoom = next;
        clampPan();
        applyImageTransform();
        updateZoomUI();
    }

    function zoomStep(delta) {
        const rect = els.previewStage.getBoundingClientRect();
        zoomAt(state.preview.zoom + delta, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }

    function rotateCurrent(delta) {
        const item = currentPreviewItem();
        if (!item || item.type === "video") return;
        const prev = item.rotation;
        item.rotation = normRotation((item.rotation || 0) + delta);
        if (!saveLibrary()) {
            item.rotation = prev;
            refreshRotationDOM(item.id);
            return;
        }
        state.preview.panX = 0;
        state.preview.panY = 0;
        applyPreviewFit();
        applyImageTransform();
        refreshRotationDOM(item.id);
        updateDetailIfCurrent(item);
    }

    /* ── 预览：详情 / 胶片条 ── */

    function toggleDetail() {
        if (!state.preview.open) return;
        state.preview.detailOpen = !state.preview.detailOpen;
        els.previewDetail.classList.toggle("show", state.preview.detailOpen);
        els.previewOverlay.classList.toggle("detail-open", state.preview.detailOpen);
        els.btnInfo.classList.toggle("active", state.preview.detailOpen);
        const item = currentPreviewItem();
        if (state.preview.detailOpen && item) renderDetail(item);
    }

    function renderDetail(item) {
        if (!item) return;
        els.detailTitle.textContent = item.name || "";
        els.detailThumb.innerHTML = "";
        const thumb = document.createElement("img");
        thumb.alt = "";
        thumb.loading = "lazy";
        thumb.decoding = "async";
        thumb.draggable = false;
        // 详情缩略图不参与网格分块渲染，不能拿 previewSeq 去比 renderSeq；
        // 预览切换时面板会重新渲染，这里只需 isConnected 守卫。
        bindThumb(thumb, item, null);
        els.detailThumb.appendChild(thumb);

        const albumNames = (item.albumIds || [])
            .map((id) => findAlbum(id))
            .filter(Boolean)
            .map((album) => album.name)
            .join("、");
        const rows = [
            [T("photos.detail.type", "类型"), typeLabel(item.type)],
            [T("photos.detail.format", "格式"), extOf(item.name).toUpperCase() || "—"],
            [T("photos.detail.date", "拍摄日期"), formatDate(item.date)],
            [T("photos.detail.size", "文件大小"), formatSize(item.size)],
            [T("photos.detail.resolution", "分辨率"), item.width && item.height ? `${item.width} × ${item.height}` : "—"],
        ];
        if (item.type === "video") rows.push([T("photos.detail.duration", "时长"), formatDuration(item.duration)]);
        rows.push([T("photos.detail.location", "位置"), item.location || "—"]);
        rows.push([T("photos.detail.albums", "相簿"), albumNames || "—"]);
        rows.push([T("photos.detail.favorite", "收藏"), item.favorite ? T("photos.favorite.yes", "是") : T("photos.favorite.no", "否")]);
        if (item.rotation) rows.push([T("photos.detail.rotation", "旋转"), `${item.rotation}°`]);
        if (item.sourcePath) rows.push([T("photos.detail.source", "来源"), item.sourcePath]);

        els.detailRows.innerHTML = "";
        rows.forEach(([label, value]) => {
            const row = document.createElement("div");
            row.className = "detail-row";
            const labelEl = document.createElement("span");
            labelEl.className = "detail-label";
            labelEl.textContent = label;
            const valueEl = document.createElement("span");
            valueEl.className = "detail-value";
            valueEl.textContent = value;
            row.append(labelEl, valueEl);
            els.detailRows.appendChild(row);
        });
    }

    function renderFilmstrip() {
        els.filmstripItems.innerHTML = "";
        const items = state.preview.items;
        if (items.length <= 1) {
            els.previewFilmstrip.classList.remove("show");
            return;
        }
        const fragment = document.createDocumentFragment();
        items.forEach((item, index) => {
            const cell = document.createElement("div");
            cell.className = "film-thumb";
            cell.dataset.id = item.id;
            cell.dataset.index = String(index);
            cell.title = item.name || "";
            const img = document.createElement("img");
            img.alt = "";
            img.loading = "lazy";
            img.decoding = "async";
            img.draggable = false;
            bindThumb(img, item, null);
            cell.appendChild(img);
            if (item.type === "video") {
                const play = document.createElement("span");
                play.className = "film-play";
                play.innerHTML = PLAY_BADGE_SMALL;
                const duration = document.createElement("div");
                duration.className = "video-duration";
                duration.textContent = formatDuration(item.duration);
                cell.append(play, duration);
            }
            cell.addEventListener("click", () => goToPreview(index));
            fragment.appendChild(cell);
        });
        els.filmstripItems.appendChild(fragment);
        els.previewFilmstrip.classList.add("show");
        updateFilmstripActive();
    }

    function updateFilmstripActive() {
        if (!els.previewFilmstrip.classList.contains("show")) return;
        let active = null;
        win.querySelectorAll(".film-thumb").forEach((el) => {
            const isActive = Number(el.dataset.index) === state.preview.index;
            el.classList.toggle("active", isActive);
            if (isActive) active = el;
        });
        if (active && typeof active.scrollIntoView === "function") {
            active.scrollIntoView({ block: "nearest", inline: "center" });
        }
    }

    /* ── 预览：幻灯片 / 全屏 ── */

    function clearSlideTimer() {
        if (state.preview.timer) {
            clearTimeout(state.preview.timer);
            state.preview.timer = 0;
        }
    }

    function startSlideshow() {
        if (state.preview.items.length <= 1) {
            showInfo(T("photos.slideshow.needTwoTitle", "无法播放幻灯片"), T("photos.slideshow.needTwo", "至少需要两个项目才能播放幻灯片。"));
            return;
        }
        state.preview.slideshow = true;
        els.previewOverlay.classList.add("slideshow");
        updateSlideshowUI();
        const item = currentPreviewItem();
        if (item && item.type === "video") requestVideoPlay();
        scheduleSlide();
    }

    function stopSlideshow(options = {}) {
        const wasRunning = state.preview.slideshow;
        state.preview.slideshow = false;
        clearSlideTimer();
        els.previewOverlay.classList.remove("slideshow");
        updateSlideshowUI();
        if (wasRunning && options.pauseVideo !== false && currentPreviewItem() && currentPreviewItem().type === "video") {
            els.previewVideo.pause();
        }
        if (wasRunning) {
            const item = currentPreviewItem();
            if (item) {
                els.btnPrev.disabled = state.preview.index <= 0;
                els.btnNext.disabled = state.preview.index >= state.preview.items.length - 1;
            }
        }
    }

    function scheduleSlide() {
        clearSlideTimer();
        if (!state.preview.slideshow || disposed) return;
        const item = currentPreviewItem();
        if (!item) return;
        if (item.type === "video") {
            const video = els.previewVideo;
            if (video.getAttribute("src")) {
                if (video.paused) requestVideoPlay();
                const remain = Number.isFinite(video.duration) && video.duration > 0
                    ? Math.max(2, video.duration - video.currentTime + 0.8)
                    : 15;
                state.preview.timer = setTimeout(advanceSlide, remain * 1000);
            } else {
                state.preview.timer = setTimeout(advanceSlide, SLIDE_INTERVAL_MS);
            }
        } else {
            state.preview.timer = setTimeout(advanceSlide, SLIDE_INTERVAL_MS);
        }
    }

    function advanceSlide() {
        if (!state.preview.slideshow || disposed) return;
        clearSlideTimer();
        const total = state.preview.items.length;
        if (!total) return;
        state.preview.index = (state.preview.index + 1) % total;
        updatePreview({ autoplay: true });
    }

    function updateSlideshowUI() {
        const active = state.preview.slideshow;
        if (els.btnSlideshow) {
            els.btnSlideshow.innerHTML = active ? SLIDESHOW_STOP_ICON : SLIDESHOW_ICON;
            const title = active ? T("photos.preview.stopSlideshow", "停止幻灯片") : T("photos.preview.slideshow", "幻灯片播放");
            els.btnSlideshow.title = title;
            els.btnSlideshow.setAttribute("aria-label", title);
            els.btnSlideshow.classList.toggle("active", active);
        }
        if (els.slideshowExit) {
            const title = T("photos.preview.stopSlideshow", "退出幻灯片");
            els.slideshowExit.title = title;
            els.slideshowExit.setAttribute("aria-label", title);
        }
    }

    function togglePreviewFullscreen() {
        if (document.fullscreenElement === els.previewOverlay) {
            document.exitFullscreen().catch(() => {});
            return;
        }
        if (typeof els.previewOverlay.requestFullscreen !== "function") {
            showError(T("photos.preview.fullscreen", "全屏"), T("photos.errFullscreen", "当前浏览器不支持全屏。"));
            return;
        }
        els.previewOverlay.requestFullscreen().catch((err) => {
            showError(T("photos.preview.fullscreen", "全屏"), (err && err.message) || T("photos.errFullscreen", "当前浏览器不支持全屏。"));
        });
    }

    function updateFullscreenUI() {
        const full = document.fullscreenElement === els.previewOverlay;
        const title = full ? T("photos.preview.exitFullscreen", "退出全屏") : T("photos.preview.fullscreen", "全屏");
        [els.btnFullscreen, els.vcFullscreen].forEach((btn) => {
            if (!btn) return;
            btn.title = title;
            btn.setAttribute("aria-label", title);
            btn.classList.toggle("active", full);
        });
    }

    /* ── 预览：视频 ── */

    function isCurrentVideo() {
        const item = currentPreviewItem();
        return !!(state.preview.open && item && item.type === "video");
    }

    function resetVideoElement() {
        const video = els.previewVideo;
        if (!video) return;
        state.preview.pendingAutoplay = false;
        state.preview.videoReadySeq = -1;
        try { video.pause(); } catch (e) { /* 尚未装载 */ }
        video.removeAttribute("src");
        try { video.load(); } catch (e) { /* 元素已脱离文档 */ }
        video.style.display = "none";
        els.vcProgress.style.setProperty("--progress", "0%");
        els.vcProgress.style.setProperty("--buffer", "0%");
        els.vcProgress.setAttribute("aria-valuenow", "0");
        els.vcCurrent.textContent = "0:00";
        els.vcDuration.textContent = "0:00";
        els.vcPlay.innerHTML = PLAY_ICON;
        syncMuteButton();
    }

    function requestVideoPlay() {
        const video = els.previewVideo;
        if (!isCurrentVideo() || !video.getAttribute("src")) return;
        const promise = video.play();
        if (promise && typeof promise.catch === "function") {
            promise.catch((err) => {
                if (!state.preview.open || !isCurrentVideo()) return;
                if (state.preview.slideshow) return;
                const message = err && err.name === "NotAllowedError"
                    ? T("photos.video.autoplayBlocked", "浏览器拦截了自动播放，请再次点击播放。")
                    : T("photos.video.errPlay", "无法播放这个视频。");
                showError(T("photos.video.cannotPlay", "无法播放"), message);
            });
        }
    }

    function toggleVideoPlay() {
        if (!isCurrentVideo()) return;
        const video = els.previewVideo;
        if (video.paused) requestVideoPlay();
        else video.pause();
    }

    function stopVideo() {
        if (!isCurrentVideo()) return;
        const video = els.previewVideo;
        video.pause();
        if (Number.isFinite(video.duration)) video.currentTime = 0;
        updateVideoProgress();
    }

    function skipVideo(seconds) {
        if (!isCurrentVideo()) return;
        const video = els.previewVideo;
        if (!Number.isFinite(video.duration)) return;
        video.currentTime = clamp(video.currentTime + seconds, 0, video.duration);
        updateVideoProgress();
    }

    function syncPlayButton() {
        if (!els.vcPlay) return;
        const playing = isCurrentVideo() && !els.previewVideo.paused;
        els.vcPlay.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
        const title = playing ? T("photos.video.pause", "暂停") : T("photos.video.play", "播放");
        els.vcPlay.title = title;
        els.vcPlay.setAttribute("aria-label", title);
    }

    function syncMuteButton() {
        if (!els.vcMute) return;
        const video = els.previewVideo;
        const muted = !!video.muted || video.volume === 0;
        els.vcMute.classList.toggle("muted", muted);
        const title = muted ? T("photos.video.unmute", "取消静音") : T("photos.video.mute", "静音");
        els.vcMute.title = title;
        els.vcMute.setAttribute("aria-label", title);
    }

    function updateVideoProgress() {
        const video = els.previewVideo;
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        const percent = duration ? clamp(video.currentTime / duration, 0, 1) * 100 : 0;
        els.vcProgress.style.setProperty("--progress", `${percent}%`);
        els.vcCurrent.textContent = formatDuration(video.currentTime);
        els.vcProgress.setAttribute("aria-valuenow", String(Math.round(percent)));
    }

    function updateVideoBuffer() {
        const video = els.previewVideo;
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        if (!duration || !video.buffered || !video.buffered.length) return;
        const end = video.buffered.end(video.buffered.length - 1);
        els.vcProgress.style.setProperty("--buffer", `${clamp(end / duration, 0, 1) * 100}%`);
    }

    function syncVideoElementUI() {
        const video = els.previewVideo;
        els.vcDuration.textContent = formatDuration(video.duration);
        els.vcCurrent.textContent = formatDuration(video.currentTime);
        els.vcVolume.value = String(Math.round((video.muted ? 0 : video.volume) * 100));
        updateVideoProgress();
        updateVideoBuffer();
        syncPlayButton();
        syncMuteButton();
    }

    function seekVideoFromEvent(e) {
        const video = els.previewVideo;
        if (!Number.isFinite(video.duration) || video.duration <= 0) return;
        const rect = els.vcProgress.getBoundingClientRect();
        if (!rect.width) return;
        const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
        video.currentTime = ratio * video.duration;
        updateVideoProgress();
    }

    /* ── 收藏 / 删除 / 相簿操作 ── */

    function updateFavoriteButton(item) {
        const svg = els.btnFavorite.querySelector("svg");
        if (!svg) return;
        svg.style.fill = item.favorite ? "#FFD60A" : "none";
        svg.style.stroke = item.favorite ? "#FFD60A" : "currentColor";
        const title = item.favorite ? T("photos.menu.unfavorite", "取消收藏") : T("photos.menu.favorite", "添加收藏");
        els.btnFavorite.title = title;
        els.btnFavorite.setAttribute("aria-label", title);
    }

    function refreshFavoriteDOM(id) {
        const item = findItem(id);
        if (!item) return;
        win.querySelectorAll(`.grid-item[data-id="${cssEscape(id)}"], .list-row[data-id="${cssEscape(id)}"]`).forEach((el) => {
            el.classList.toggle("favorite", item.favorite);
        });
    }

    function setFavorite(ids, next) {
        const touched = [];
        ids.forEach((id) => {
            const item = findItem(id);
            if (!item || item.favorite === next) return;
            touched.push({ item, prev: item.favorite });
            item.favorite = next;
        });
        if (!touched.length) return;
        if (!saveLibrary()) {
            touched.forEach(({ item, prev }) => { item.favorite = prev; });
            return;
        }
        touched.forEach(({ item }) => refreshFavoriteDOM(item.id));
        refreshSelectionDOM();
        if (state.preview.open) {
            const current = currentPreviewItem();
            if (current) updateFavoriteButton(current);
            if (state.preview.detailOpen && current) renderDetail(current);
        }
        if (state.view === "favorites") {
            refreshPreviewAfterLibraryChange();
            render();
        }
    }

    function toggleCurrentFavorite() {
        const item = currentPreviewItem();
        if (item) setFavorite([item.id], !item.favorite);
    }

    function deleteItems(ids) {
        const list = toIdList(ids);
        if (!list.length) return;
        // 外部挂载为只读：store 层会拒绝，这里先把话说明白（Q2 越界不静默）
        const blocked = list.filter((id) => isExternalItem(findItem(id)));
        const allowed = list.filter((id) => !blocked.includes(id));
        if (blocked.length) {
            showInfo(
                T("photos.extReadonlyTitle", "外部图片文件夹为只读"),
                T("photos.extReadonlyDelete", "外部文件夹中的项目不能在照片应用里删除；要删除请在访达中操作对应文件夹。")
            );
        }
        if (!allowed.length) return;
        const prevItems = state.items;
        const gone = new Set(allowed);
        // 库内删除 = 文件进 /废纸篓（store.deleteMedia → moveToTrash），没有应用内回收站旁路
        state.items = prevItems.filter((item) => !gone.has(item.id));
        if (!saveLibrary()) {
            state.items = prevItems;
            return;
        }
        state.selection.clear();
        state.anchorId = null;
        refreshPreviewAfterLibraryChange();
        render();
        renderAlbumNav();
        deleteMedia(allowed).catch((err) => {
            console.warn("[photos] 移入废纸篓失败：", err);
            // 移动失败的项目还躺在库里：重新扫描让界面回到真相
            scanIntoState().then(() => { if (!disposed) { render(); renderAlbumNav(); } });
        });
    }

    function restoreItems(ids) {
        const list = toIdList(ids);
        if (!list.length) return;
        const touched = [];
        list.forEach((id) => {
            const item = findItem(id);
            if (!item || !item.deleted) return;
            touched.push({ item, prevDeletedAt: item.deletedAt });
            item.deleted = false;
            item.deletedAt = null;
        });
        if (!touched.length) return;
        if (!saveLibrary()) {
            touched.forEach(({ item, prevDeletedAt }) => {
                item.deleted = true;
                item.deletedAt = prevDeletedAt;
            });
            return;
        }
        state.selection.clear();
        state.anchorId = null;
        refreshPreviewAfterLibraryChange();
        render();
        renderAlbumNav();
    }

    function toIdList(ids) {
        return (Array.isArray(ids) ? ids : [ids]).filter((id) => typeof id === "string" && findItem(id));
    }

    function addToAlbum(ids, albumId) {
        const album = findAlbum(albumId);
        if (!album) return;
        const touched = [];
        toIdList(ids).forEach((id) => {
            const item = findItem(id);
            if (!item) return;
            const prev = item.albumIds || [];
            if (prev.includes(albumId)) return;
            touched.push({ item, prev });
            item.albumIds = [...prev, albumId];
        });
        if (!touched.length) return;
        if (!saveLibrary()) {
            touched.forEach(({ item, prev }) => { item.albumIds = prev; });
            return;
        }
        renderAlbumNav();
        const current = currentPreviewItem();
        if (current && state.preview.detailOpen) renderDetail(current);
    }

    function removeFromAlbum(ids, albumId) {
        const touched = [];
        toIdList(ids).forEach((id) => {
            const item = findItem(id);
            if (!item || !item.albumIds || !item.albumIds.includes(albumId)) return;
            touched.push({ item, prev: item.albumIds });
            item.albumIds = item.albumIds.filter((idValue) => idValue !== albumId);
        });
        if (!touched.length) return;
        if (!saveLibrary()) {
            touched.forEach(({ item, prev }) => { item.albumIds = prev; });
            return;
        }
        state.selection.clear();
        state.anchorId = null;
        if (state.view === `album-${albumId}`) {
            refreshPreviewAfterLibraryChange();
            render();
        }
        renderAlbumNav();
        updateSelectionBar();
        const current = currentPreviewItem();
        if (current && state.preview.detailOpen) renderDetail(current);
    }

    /** 项目归属 / 可见性变化后，同步正在预览的项目与胶片条。 */
    function refreshPreviewAfterLibraryChange() {
        if (!state.preview.open) return;
        const current = currentPreviewItem();
        const currentId = current ? current.id : null;
        const items = getVisibleItems();
        if (!items.length) {
            closePreview();
            return;
        }
        let index = items.findIndex((item) => item.id === currentId);
        const stillVisible = index >= 0;
        if (!stillVisible) index = clamp(state.preview.index, 0, items.length - 1);
        state.preview.items = items;
        state.preview.index = index;
        renderFilmstrip();
        if (stillVisible) {
            updatePreviewChrome(items[index]);
            if (state.preview.detailOpen) renderDetail(items[index]);
        } else {
            updatePreview({ autoplay: state.preview.slideshow });
        }
    }

    /* ── 相簿 CRUD ── */

    async function promptNewAlbum() {
        const name = await askText({
            title: T("photos.newAlbumTitle", "新建相簿"),
            value: "",
            placeholder: T("photos.albumNamePlaceholder", "相簿名称"),
            okText: T("photos.create", "创建"),
        });
        if (name == null) return null;
        const trimmed = String(name).trim();
        if (!trimmed) return null;
        if (state.albums.some((album) => album.name.toLowerCase() === trimmed.toLowerCase())) {
            showInfo(T("photos.newAlbumTitle", "新建相簿"), T("photos.album.exists", "已存在同名相簿。"));
            return null;
        }
        const album = { id: makeId("album"), name: trimmed };
        state.albums.push(album);
        if (!saveLibrary()) {
            state.albums.pop();
            return null;
        }
        renderAlbumNav();
        return album;
    }

    async function renameAlbumPrompt(album) {
        if (!album) return;
        const name = await askText({
            title: T("photos.album.renameTitle", "重命名相簿"),
            value: album.name,
            placeholder: T("photos.albumNamePlaceholder", "相簿名称"),
            okText: T("photos.album.renameAction", "重命名"),
        });
        if (name == null) return;
        const trimmed = String(name).trim();
        if (!trimmed) return;
        if (state.albums.some((entry) => entry.id !== album.id && entry.name.toLowerCase() === trimmed.toLowerCase())) {
            showInfo(T("photos.album.renameTitle", "重命名相簿"), T("photos.album.exists", "已存在同名相簿。"));
            return;
        }
        const prev = album.name;
        album.name = trimmed;
        if (!saveLibrary()) {
            album.name = prev;
            return;
        }
        renderAlbumNav();
        updateToolbar(getVisibleItems().length);
        const current = currentPreviewItem();
        if (current && state.preview.detailOpen) renderDetail(current);
    }

    async function deleteAlbumPrompt(album) {
        if (!album) return;
        const proceed = await askConfirm(
            T("photos.album.deleteTitle", "删除相簿"),
            T("photos.album.deleteBody", "「{name}」中的项目会保留，相簿本身将被删除。").replace("{name}", album.name),
            T("photos.album.delete", "删除相簿"),
            true
        );
        if (!proceed) return;

        const albumIndex = state.albums.findIndex((entry) => entry.id === album.id);
        if (albumIndex < 0) return;
        const touched = state.items
            .filter((item) => item.albumIds && item.albumIds.includes(album.id))
            .map((item) => ({ item, prev: item.albumIds }));
        state.albums.splice(albumIndex, 1);
        touched.forEach(({ item }) => {
            item.albumIds = item.albumIds.filter((id) => id !== album.id);
        });
        if (!saveLibrary()) {
            state.albums.splice(albumIndex, 0, album);
            touched.forEach(({ item, prev }) => { item.albumIds = prev; });
            return;
        }
        renderAlbumNav();
        if (state.view === `album-${album.id}`) setView("all");
        else render();
        const current = currentPreviewItem();
        if (current && state.preview.detailOpen) renderDetail(current);
    }

    function albumMenuItems(ids) {
        const items = [];
        if (state.albums.length) {
            state.albums.forEach((album) => {
                items.push({
                    label: `${T("photos.menu.moveToAlbum", "移动到")}「${album.name}」`,
                    action: () => addToAlbum(ids, album.id),
                });
            });
            items.push({ type: "separator" });
        }
        items.push({
            label: T("photos.menu.newAlbum", "新建相簿…"),
            action: async () => {
                const album = await promptNewAlbum();
                if (album) addToAlbum(ids, album.id);
            },
        });
        return items;
    }

    function openAlbumChooser(ids, x, y) {
        if (!toIdList(ids).length) return;
        createContextMenu(x, y, albumMenuItems(ids));
    }

    /* ── 导入 / 访达打开 ── */

    function createFileInput() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*,video/*";
        input.multiple = true;
        input.className = "file-input";
        input.addEventListener("change", (e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = "";
            if (files.length) handleImportFiles(files);
        });
        win.appendChild(input);
        els.fileInput = input;
    }

    function pickFiles() {
        if (!els.fileInput) createFileInput();
        els.fileInput.value = "";
        els.fileInput.click();
    }

    /** 添加外部图片文件夹：目录选择器授权后挂载为只读来源（Q2），合并进当前图库展示。 */
    async function mountExternalFolder() {
        if (typeof window.showDirectoryPicker !== "function") {
            showInfo(T("photos.extUnsupportedTitle", "当前浏览器不支持"), T("photos.extUnsupported", "这个浏览器没有 File System Access API，无法挂载外部图片文件夹。"));
            return;
        }
        let handle = null;
        try {
            handle = await window.showDirectoryPicker({ id: "deskly-photos-ext", mode: "read" });
        } catch (err) {
            return;   // 用户取消不是故障
        }
        setImporting(1);
        try {
            const mount = await addExternalMount(handle, { mode: "read" });
            // 重新扫描（含刚挂载的外部目录），让界面回到真相
            await scanIntoState();
            if (disposed) return;
            render();
            renderAlbumNav();
            showInfo(T("photos.extMountedTitle", "已添加外部图片文件夹"), mount.name);
        } catch (err) {
            console.warn("[photos] 外部文件夹挂载失败：", err);
            showError(T("photos.extMountFailedTitle", "无法添加外部文件夹"), (err && err.message) || String(err));
        } finally {
            setImporting(-1);
        }
    }

    function handleImportFiles(files) {
        importFiles(files).catch((err) => {
            console.error("[photos] 导入失败", err);
            showError(T("photos.errImportTitle", "导入失败"), (err && err.message) || String(err));
        });
    }

    function setImporting(delta) {
        state.importJobs = Math.max(0, state.importJobs + delta);
        updateImportUI();
    }

    function updateImportUI() {
        if (!els.btnImport) return;
        const busy = state.importJobs > 0;
        els.btnImport.disabled = busy;
        els.btnImport.classList.toggle("importing", busy);
        if (els.importLabel) els.importLabel.textContent = busy ? T("photos.importing", "导入中…") : T("photos.import", "导入");
        if (els.emptyAction && !els.emptyAction.hidden) {
            els.emptyAction.disabled = busy && els.emptyState.dataset.action === "import";
        }
    }

    async function mapLimit(items, limit, worker) {
        const results = new Array(items.length);
        let next = 0;
        const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
            while (next < items.length) {
                const index = next++;
                try {
                    results[index] = { ok: true, value: await worker(items[index], index) };
                } catch (err) {
                    results[index] = { ok: false, error: err };
                }
            }
        });
        await Promise.all(runners);
        return results;
    }

    async function importFiles(files, options = {}) {
        if (!files || !files.length) return { added: [], failed: [] };
        await libraryReady.catch(() => {});
        setImporting(1);
        try {
            const results = await mapLimit(files, 3, (file) => importOne(file, options.sourcePath || null));
            const added = [];
            const failed = [];
            results.forEach((result, index) => {
                if (result.ok) added.push(result.value);
                else failed.push({ name: files[index].name || "", reason: result.error && result.error.reason });
            });
            const committed = commitImport(added, failed);
            return { added: committed, failed };
        } finally {
            setImporting(-1);
        }
    }

    /** 库内唯一落点：IMG.jpg → IMG (1).jpg 顺延（putMedia 写 /Picture/ 是原子写，此处只管起名）。 */
    async function uniqueLibraryPath(name) {
        const clean = Deskly().fs.paths.sanitizeName(String(name || "").replace(/\.[^.]+$/, "")) || T("photos.untitled", "未命名");
        const ext = (String(name || "").match(/\.[^.]+$/) || [""])[0].toLowerCase() || ".jpg";
        let candidate = `${PHOTOS_ROOT}/${clean}${ext}`;
        for (let i = 1; unwrap(await Deskly().fs.existsAt(candidate)); i++) candidate = `${PHOTOS_ROOT}/${clean} (${i})${ext}`;
        return candidate;
    }

    async function importOne(file, sourcePath = null) {
        const kind = mediaKind(file.name || sourcePath || "", file.type || "");
        if (!kind) {
            const err = new Error("unsupported");
            err.reason = "unsupported";
            throw err;
        }
        if (file.size > MAX_FILE_SIZE) {
            const err = new Error("too-large");
            err.reason = "tooLarge";
            throw err;
        }
        const item = {
            // id 即库内路径：/Picture/ 是唯一真相，没有第二处索引（Q2）
            id: await uniqueLibraryPath(file.name || baseName(sourcePath) || T("photos.untitled", "未命名")),
            name: file.name || baseName(sourcePath) || T("photos.untitled", "未命名"),
            type: kind,
            size: Number(file.size) || 0,
            date: new Date(file.lastModified || Date.now()).toISOString(),
            favorite: false,
            deleted: false,
            deletedAt: null,
            albumIds: [],
            location: "",
            rotation: 0,
            sourcePath: sourcePath || "",
            external: false,
        };
        item.sourcePath = item.id;
        try {
            await putMedia(item.id, file);
        } catch (e) {
            const err = new Error((e && e.message) || "storage");
            err.reason = e && (e.code === "EQUOTA" || e.name === "QuotaExceededError" || e.code === 22 || e.code === 1014) ? "quota" : "storage";
            throw err;
        }
        const meta = await analyzeMedia(file, kind).catch(() => null);
        if (meta) {
            if (meta.width) item.width = meta.width;
            if (meta.height) item.height = meta.height;
            if (meta.duration) item.duration = meta.duration;
            if (meta.thumb) {
                try {
                    await putThumb(item.id, meta.thumb);
                    item._thumbState = "ready";
                } catch (e) {
                    item._thumbState = "failed";
                }
            } else {
                item._thumbState = "failed";
            }
        } else {
            item._thumbState = "failed";
        }
        return item;
    }

    function commitImport(added, failed) {
        let committed = added;
        if (added.length) {
            state.items.push(...added);
            if (!saveLibrary()) {
                const ids = new Set(added.map((item) => item.id));
                state.items = state.items.filter((item) => !ids.has(item.id));
                deleteMedia(Array.from(ids)).catch((err) => console.warn("[photos] 回滚媒体数据失败", err));
                committed = [];
            }
        }
        if (!disposed && committed.length) {
            resetToAllView();
            setView("all");
        } else if (!disposed) {
            render();
        }
        if (failed.length && !disposed) {
            const list = failed.map((entry) => `${entry.name || T("photos.untitled", "未命名")}：${failReason(entry.reason)}`).join("\n");
            showInfo(T("photos.importPartialTitle", "部分文件未导入"), list);
        }
        return committed;
    }

    function failReason(reason) {
        switch (reason) {
            case "tooLarge": return `${T("photos.errTooLarge", "文件超过单文件上限")} ${formatSize(MAX_FILE_SIZE)}`;
            case "quota": return T("photos.errStorageQuota", "本地存储已满");
            case "storage": return T("photos.errStorageWrite", "写入本地存储失败");
            case "unsupported": return T("photos.errUnsupported", "不支持的文件类型");
            default: return T("photos.errReadFile", "读取文件失败");
        }
    }

    async function openPath(path) {
        if (!path || openingPath === path) return;
        openingPath = path;
        try {
            await libraryReady.catch(() => {});
            const existing = state.items.find((item) => item.id === path || item.sourcePath === path);
            if (existing) {
                if (existing.deleted) {
                    existing.deleted = false;
                    existing.deletedAt = null;
                    if (!saveLibrary()) {
                        existing.deleted = true;
                        return;
                    }
                    renderAlbumNav();
                }
                if (disposed) return;
                resetToAllView();
                setView("all");
                openPreview(existing.id);
                return;
            }

            setImporting(1);
            try {
                const file = unwrap(await Deskly().fs.at(path));
                if (!file) throw new Error(T("photos.errReadPath", "无法读取文件：{path}").replace("{path}", path));
                const kind = mediaKind(file.name || path, file.type || "");
                if (!kind) {
                    showError(T("photos.errOpenFileTitle", "无法打开文件"), T("photos.errUnsupported", "不支持的文件类型"));
                    return;
                }
                const item = await importOne(file, path);
                const committed = commitImport([item], []);
                if (!disposed && committed.length) openPreview(item.id);
            } catch (err) {
                if (disposed) return;
                const reason = err && err.reason;
                const message = reason ? failReason(reason) : ((err && err.message) || String(err));
                showError(T("photos.errOpenFileTitle", "无法打开文件"), message);
            } finally {
                setImporting(-1);
            }
        } finally {
            openingPath = null;
        }
    }

    /* ── 右键菜单 ── */

    function onItemContextMenu(e, item) {
        e.preventDefault();
        e.stopPropagation();
        if (!state.selection.has(item.id)) selectOnly(item.id);
        const ids = Array.from(state.selection);
        const selected = ids.map(findItem).filter(Boolean);
        const allFavorite = selected.length > 0 && selected.every((entry) => entry.favorite);

        const menu = [
            { label: T("photos.menu.open", "打开"), action: () => openPreview(item.id) },
            { label: T("photos.menu.showInfo", "显示简介"), action: () => openPreview(item.id, { detail: true }) },
            { type: "separator" },
            {
                label: allFavorite ? T("photos.menu.unfavorite", "取消收藏") : T("photos.menu.favorite", "添加收藏"),
                action: () => setFavorite(ids, !allFavorite),
            },
        ];

        if (state.view === "trash") {
            menu.push({ type: "separator" });
            menu.push({ label: T("photos.menu.restore", "恢复"), action: () => restoreItems(ids) });
            menu.push({ label: T("photos.menu.permanentDelete", "永久删除"), action: () => deleteItems(ids) });
        } else {
            menu.push({ type: "separator" });
            menu.push(...albumMenuItems(ids));
            if (state.view.startsWith("album-")) {
                const albumId = state.view.slice(6);
                menu.push({ label: T("photos.menu.removeFromAlbum", "从相簿移除"), action: () => removeFromAlbum(ids, albumId) });
            }
            menu.push({ type: "separator" });
            menu.push({ label: T("photos.menu.delete", "删除"), action: () => deleteItems(ids) });
        }
        createContextMenu(e.clientX, e.clientY, menu);
    }

    function onBlankContextMenu(e) {
        e.preventDefault();
        const items = getVisibleItems();
        const deletedItems = state.items.filter((item) => item.deleted);
        const menu = [
            { label: T("photos.menu.import", "导入…"), action: pickFiles },
            { label: T("photos.menu.newAlbum", "新建相簿…"), action: () => promptNewAlbum() },
            { type: "separator" },
            { label: T("photos.menu.selectAll", "全选"), action: selectAllVisible, disabled: !items.length },
            {
                label: state.mode === "grid" ? T("photos.menu.listView", "显示为列表") : T("photos.menu.gridView", "显示为网格"),
                action: () => setMode(state.mode === "grid" ? "list" : "grid"),
            },
        ];
        if (state.view === "trash") {
            menu.push({ type: "separator" });
            menu.push({ label: T("photos.menu.restoreAll", "全部恢复"), action: () => restoreItems(deletedItems.map((item) => item.id)), disabled: !deletedItems.length });
            menu.push({
                label: T("photos.menu.emptyTrash", "清倒废纸篓…"),
                disabled: !deletedItems.length,
                action: async () => {
                    const proceed = await askConfirm(
                        T("photos.trash.confirmTitle", "永久删除"),
                        T("photos.trash.confirmBody", "这些项目将被永久删除，无法撤销。"),
                        T("photos.preview.permanentDelete", "永久删除"),
                        true
                    );
                    if (proceed) deleteItems(deletedItems.map((item) => item.id));
                },
            });
        }
        createContextMenu(e.clientX, e.clientY, menu);
    }

    function onAlbumContextMenu(e) {
        const item = e.target.closest(".nav-album-dynamic");
        if (!item) return;
        e.preventDefault();
        const album = findAlbum(item.dataset.albumId);
        if (!album) return;
        createContextMenu(e.clientX, e.clientY, [
            { label: T("photos.menu.renameAlbum", "重命名相簿…"), action: () => renameAlbumPrompt(album) },
            { type: "separator" },
            { label: T("photos.menu.deleteAlbum", "删除相簿"), action: () => deleteAlbumPrompt(album) },
        ]);
    }

    /* ── 拖放 / 键盘 / 事件 ── */

    function hasFileDrag(e) {
        return !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files"));
    }

    function isFrontWindow() {
        if (!win.isConnected) return false;
        let top = null;
        let topZ = -Infinity;
        document.querySelectorAll("body > .window").forEach((node) => {
            if (node.classList.contains("minimized")) return;
            const z = parseInt(getComputedStyle(node).zIndex, 10) || 0;
            if (z >= topZ) {
                topZ = z;
                top = node;
            }
        });
        return top === win;
    }

    function isTypingTarget(target) {
        return !!(target && target.closest && target.closest("input, textarea, select, [contenteditable='true']"));
    }

    function onDocumentKeyDown(e) {
        if (disposed || !win.isConnected || win.classList.contains("minimized")) return;
        if (document.querySelector("swift-messagebox.system-dialog")) return;
        if (document.querySelector(".menu.contextmenu")) return;
        const targetWindow = e.target && e.target.closest ? e.target.closest(".window") : null;
        if (targetWindow && targetWindow !== win) return;
        if (!targetWindow && !isFrontWindow()) return;
        if (!isFrontWindow()) return;
        if (isTypingTarget(e.target)) return;

        const key = e.key;
        const meta = e.metaKey || e.ctrlKey;
        const inPreview = state.preview.open;

        // 空格 / 回车在按钮上交给原生激活，避免「点过播放后再按空格」被处理两次
        if ((key === " " || key === "Enter") && e.target.closest && e.target.closest("button")) return;

        if (key === "Escape") {
            if (inPreview && state.preview.slideshow) {
                e.preventDefault();
                stopSlideshow();
                return;
            }
            if (document.fullscreenElement === els.previewOverlay) {
                e.preventDefault();
                document.exitFullscreen().catch(() => {});
                return;
            }
            if (inPreview && state.preview.detailOpen) {
                e.preventDefault();
                toggleDetail();
                return;
            }
            if (inPreview) {
                e.preventDefault();
                closePreview();
                return;
            }
            if (state.selection.size) {
                e.preventDefault();
                clearSelection();
                return;
            }
            if (state.search) {
                e.preventDefault();
                state.search = "";
                els.searchInput.value = "";
                updateSearchClear();
                render();
            }
            return;
        }

        if (meta && key.toLowerCase() === "a" && !inPreview) {
            e.preventDefault();
            selectAllVisible();
            return;
        }
        if (meta && key.toLowerCase() === "f" && !inPreview) {
            e.preventDefault();
            els.searchInput.focus();
            els.searchInput.select();
            return;
        }
        if (meta && key.toLowerCase() === "i" && inPreview) {
            e.preventDefault();
            toggleDetail();
            return;
        }

        if (!inPreview) {
            if (key === "Enter" || key === " ") {
                const id = state.anchorId || Array.from(state.selection)[0];
                if (id) {
                    e.preventDefault();
                    openPreview(id);
                } else {
                    const items = getVisibleItems();
                    if (key === " " && items.length) {
                        e.preventDefault();
                        selectOnly(items[0].id);
                    }
                }
                return;
            }
            if (key === "ArrowLeft") { e.preventDefault(); moveSelection(-1, 0); return; }
            if (key === "ArrowRight") { e.preventDefault(); moveSelection(1, 0); return; }
            if (key === "ArrowUp") { e.preventDefault(); moveSelection(0, -1); return; }
            if (key === "ArrowDown") { e.preventDefault(); moveSelection(0, 1); return; }
            if (key === "Delete" || key === "Backspace") {
                if (!state.selection.size) return;
                e.preventDefault();
                if (!e.repeat) deleteItems(Array.from(state.selection));
                return;
            }
            return;
        }

        const item = currentPreviewItem();
        if (!item) return;
        if (key === "ArrowLeft" || key === "ArrowRight") {
            e.preventDefault();
            if (item.type === "video" && e.shiftKey) {
                skipVideo(key === "ArrowLeft" ? -10 : 10);
            } else {
                previewGo(key === "ArrowLeft" ? -1 : 1);
            }
            return;
        }
        if (key === " ") {
            e.preventDefault();
            if (item.type === "video") toggleVideoPlay();
            else if (state.preview.slideshow) stopSlideshow();
            else startSlideshow();
            return;
        }
        if (key === "+" || key === "=") { e.preventDefault(); zoomStep(0.25); return; }
        if (key === "-" || key === "_") { e.preventDefault(); zoomStep(-0.25); return; }
        if (key === "0") { e.preventDefault(); resetZoomState(); applyImageTransform(); return; }
        if (key.toLowerCase() === "r") {
            e.preventDefault();
            rotateCurrent(e.shiftKey ? -90 : 90);
            return;
        }
        if (key.toLowerCase() === "m" && item.type === "video") {
            e.preventDefault();
            els.vcMute.click();
            return;
        }
        if (key.toLowerCase() === "f") {
            e.preventDefault();
            togglePreviewFullscreen();
            return;
        }
        if (key === "ArrowUp" || key === "ArrowDown") {
            // 预览内没有纵向导航；不要吞掉按键，保留给浏览器/滚动条
            return;
        }
        if (key === "Delete" || key === "Backspace") {
            e.preventDefault();
            if (!e.repeat) deleteItems([item.id]);
            return;
        }
        if (key === "," && item.type === "video") { e.preventDefault(); skipVideo(-5); return; }
        if (key === "." && item.type === "video") { e.preventDefault(); skipVideo(5); return; }
    }

    function onFullscreenChange() {
        if (disposed) return;
        updateFullscreenUI();
    }

    function onLanguageChange() {
        if (disposed) return;
        applyStaticI18n();
        renderAlbumNav();
        render();
        if (state.preview.open) {
            const item = currentPreviewItem();
            if (item) {
                updatePreviewChrome(item);
                if (state.preview.detailOpen) renderDetail(item);
            }
        }
    }

    function onAppOpen(e) {
        const detail = e.detail || {};
        if (detail.id !== "photos" || !detail.file) return;
        openPath(String(detail.file));
    }

    function bindEvents() {
        els.sidebarNav.addEventListener("click", (e) => {
            const item = e.target.closest(".nav-item");
            if (!item) return;
            if (item.classList.contains("nav-add-album")) {
                promptNewAlbum().catch((err) => console.warn("[photos] 新建相簿失败", err));
                return;
            }
            if (item.dataset.view) setView(item.dataset.view);
        });
        els.sidebarNav.addEventListener("contextmenu", onAlbumContextMenu);
        els.sidebarNav.addEventListener("dblclick", (e) => {
            const item = e.target.closest(".nav-album-dynamic");
            if (!item) return;
            const album = findAlbum(item.dataset.albumId);
            if (album) renameAlbumPrompt(album);
        });

        els.searchInput.addEventListener("input", () => {
            state.search = els.searchInput.value;
            updateSearchClear();
            scheduleRender();
        });
        els.searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                els.searchInput.value = "";
                state.search = "";
                updateSearchClear();
                els.searchInput.blur();
                scheduleRender();
            }
        });
        els.searchClear.addEventListener("click", () => {
            els.searchInput.value = "";
            state.search = "";
            updateSearchClear();
            els.searchInput.focus();
            scheduleRender();
        });

        els.segBtns.forEach((btn) => btn.addEventListener("click", () => setMode(btn.dataset.mode)));

        els.btnImport.addEventListener("click", pickFiles);

        // 添加外部图片文件夹（目录选择器必须在点击手势里调用）
        if (els.btnExtMount) els.btnExtMount.addEventListener("click", mountExternalFolder);

        els.btnSelect.addEventListener("click", () => {
            if (state.selecting) {
                clearSelection();
            } else {
                state.selecting = true;
                updateSelectButton();
                refreshSelectionDOM();
            }
        });

        els.btnSelAlbum.addEventListener("click", () => {
            const rect = els.btnSelAlbum.getBoundingClientRect();
            openAlbumChooser(Array.from(state.selection), rect.left, rect.bottom + 4);
        });
        els.btnSelFavorite.addEventListener("click", () => {
            const ids = Array.from(state.selection);
            const selected = ids.map(findItem).filter(Boolean);
            const allFavorite = selected.length > 0 && selected.every((item) => item.favorite);
            setFavorite(ids, !allFavorite);
        });
        els.btnSelDelete.addEventListener("click", () => deleteItems(Array.from(state.selection)));
        els.btnSelCancel.addEventListener("click", clearSelection);

        els.emptyAction.addEventListener("click", () => {
            const action = els.emptyState.dataset.action;
            if (action === "import") pickFiles();
            else if (action === "clear") {
                els.searchInput.value = "";
                state.search = "";
                updateSearchClear();
                els.searchInput.focus();
                scheduleRender();
            } else if (action === "all") {
                setView("all");
            }
        });

        els.gridView.addEventListener("contextmenu", (e) => {
            if (e.target.closest(".grid-item")) return;
            onBlankContextMenu(e);
        });
        els.listView.addEventListener("contextmenu", (e) => {
            if (e.target.closest(".list-row")) return;
            onBlankContextMenu(e);
        });

        els.btnBack.addEventListener("click", closePreview);
        els.btnPrev.addEventListener("click", () => previewGo(-1));
        els.btnNext.addEventListener("click", () => previewGo(1));
        els.btnRotateLeft.addEventListener("click", () => rotateCurrent(-90));
        els.btnRotateRight.addEventListener("click", () => rotateCurrent(90));
        els.btnZoomOut.addEventListener("click", () => zoomStep(-0.25));
        els.btnZoomIn.addEventListener("click", () => zoomStep(0.25));
        els.zoomSlider.addEventListener("input", (e) => {
            const rect = els.previewStage.getBoundingClientRect();
            zoomAt(parseFloat(e.target.value), rect.left + rect.width / 2, rect.top + rect.height / 2);
        });
        els.btnSlideshow.addEventListener("click", (e) => {
            // 启动时按钮图标会被替换，原始 <path> 已脱离 DOM；事件继续冒泡到
            // overlay 时 target.closest("button") 会落空，被误判为「点击空白」而立即停止。
            e.stopPropagation();
            if (state.preview.slideshow) stopSlideshow();
            else startSlideshow();
        });
        els.btnFullscreen.addEventListener("click", togglePreviewFullscreen);
        els.btnFavorite.addEventListener("click", toggleCurrentFavorite);
        els.btnInfo.addEventListener("click", toggleDetail);
        els.btnDelete.addEventListener("click", () => {
            const item = currentPreviewItem();
            if (item) deleteItems([item.id]);
        });
        els.detailClose.addEventListener("click", toggleDetail);
        els.detailClose.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleDetail();
            }
        });
        els.slideshowExit.addEventListener("click", () => stopSlideshow());

        els.filmstripItems.addEventListener("click", (e) => {
            const cell = e.target.closest(".film-thumb");
            if (cell) goToPreview(Number(cell.dataset.index));
        });

        els.previewOverlay.addEventListener("click", (e) => {
            if (!state.preview.slideshow) return;
            if (e.target.closest("button, input, video, .video-controls, .slideshow-exit")) return;
            stopSlideshow();
        });

        // 视频控制
        els.vcPlay.addEventListener("click", toggleVideoPlay);
        els.vcStop.addEventListener("click", stopVideo);
        els.vcRewind.addEventListener("click", () => skipVideo(-10));
        els.vcForward.addEventListener("click", () => skipVideo(10));
        els.vcMute.addEventListener("click", () => {
            const video = els.previewVideo;
            video.muted = !video.muted;
            videoPrefs.muted = video.muted;
            storeVideoPrefs();
            syncMuteButton();
            syncVideoElementUI();
        });
        els.vcVolume.addEventListener("input", (e) => {
            const value = clamp(parseFloat(e.target.value) / 100, 0, 1);
            const video = els.previewVideo;
            video.volume = value;
            videoPrefs.volume = value;
            if (value > 0 && video.muted) {
                video.muted = false;
                videoPrefs.muted = false;
            }
            storeVideoPrefs();
            syncMuteButton();
        });
        els.vcFullscreen.addEventListener("click", togglePreviewFullscreen);

        els.vcProgress.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            seekingVideo = true;
            els.vcProgress.setPointerCapture(e.pointerId);
            seekVideoFromEvent(e);
        });
        els.vcProgress.addEventListener("pointermove", (e) => {
            if (seekingVideo) seekVideoFromEvent(e);
        });
        els.vcProgress.addEventListener("pointerup", (e) => {
            if (!seekingVideo) return;
            seekingVideo = false;
            try { els.vcProgress.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 */ }
            seekVideoFromEvent(e);
        });
        els.vcProgress.addEventListener("pointercancel", () => { seekingVideo = false; });
        els.vcProgress.addEventListener("keydown", (e) => {
            if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); skipVideo(-5); }
            else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); skipVideo(5); }
            else if (e.key === "Home") { e.preventDefault(); e.stopPropagation(); if (isCurrentVideo()) els.previewVideo.currentTime = 0; }
            else if (e.key === "End") { e.preventDefault(); e.stopPropagation(); if (isCurrentVideo() && Number.isFinite(els.previewVideo.duration)) els.previewVideo.currentTime = els.previewVideo.duration; }
        });

        // 视频元素事件
        els.previewVideo.addEventListener("loadeddata", () => {
            if (!isCurrentVideo()) return;
            const seq = state.preview.mediaSeq;
            if (state.preview.videoReadySeq === seq) return;
            state.preview.videoReadySeq = seq;
            finalizeVideoReady(seq).catch(() => {});
        });
        els.previewVideo.addEventListener("durationchange", () => {
            if (!isCurrentVideo()) return;
            const duration = els.previewVideo.duration;
            if (Number.isFinite(duration)) els.vcDuration.textContent = formatDuration(duration);
        });
        els.previewVideo.addEventListener("timeupdate", updateVideoProgress);
        els.previewVideo.addEventListener("progress", updateVideoBuffer);
        els.previewVideo.addEventListener("play", () => { syncPlayButton(); updateSlideshowUI(); });
        els.previewVideo.addEventListener("pause", syncPlayButton);
        els.previewVideo.addEventListener("volumechange", () => {
            syncMuteButton();
            if (isCurrentVideo()) {
                videoPrefs.volume = els.previewVideo.volume;
                videoPrefs.muted = els.previewVideo.muted;
            }
        });
        els.previewVideo.addEventListener("ended", () => {
            syncPlayButton();
            if (isCurrentVideo() && state.preview.slideshow) advanceSlide();
        });
        els.previewVideo.addEventListener("error", () => {
            if (!isCurrentVideo()) return;
            if (!els.previewVideo.getAttribute("src")) return;
            els.previewSpinner.hidden = true;
            showPreviewError(T("photos.video.errDecode", "视频无法解码或文件已损坏。"));
            syncPlayButton();
        });
        els.previewVideo.addEventListener("click", () => {
            if (!isCurrentVideo()) return;
            clearTimeout(videoClickTimer);
            videoClickTimer = setTimeout(toggleVideoPlay, 180);
        });
        els.previewVideo.addEventListener("dblclick", (e) => {
            e.stopPropagation();
            clearTimeout(videoClickTimer);
            togglePreviewFullscreen();
        });

        // 图片缩放 / 平移 / 滑动切换
        els.previewStage.addEventListener("pointerdown", (e) => {
            const item = currentPreviewItem();
            if (!item || item.type === "video" || e.button !== 0) return;
            state.preview.drag = {
                id: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                panX: state.preview.panX,
                panY: state.preview.panY,
                panning: state.preview.zoom > 1,
                moved: false,
            };
            try { els.previewStage.setPointerCapture(e.pointerId); } catch (err) { /* 指针已失效 */ }
            if (state.preview.drag.panning) els.previewOverlay.classList.add("dragging");
        });
        els.previewStage.addEventListener("pointermove", (e) => {
            const drag = state.preview.drag;
            if (!drag || drag.id !== e.pointerId) return;
            const dx = e.clientX - drag.startX;
            const dy = e.clientY - drag.startY;
            if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
            if (drag.panning) {
                state.preview.panX = drag.panX + dx;
                state.preview.panY = drag.panY + dy;
                clampPan();
                applyImageTransform();
            }
        });
        els.previewStage.addEventListener("pointerup", (e) => {
            const drag = state.preview.drag;
            if (!drag || drag.id !== e.pointerId) return;
            state.preview.drag = null;
            els.previewOverlay.classList.remove("dragging");
            try { els.previewStage.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 */ }
            if (drag.panning) return;
            const dx = e.clientX - drag.startX;
            const dy = e.clientY - drag.startY;
            if (Math.abs(dx) > 70 && Math.abs(dy) < 60) {
                previewGo(dx > 0 ? -1 : 1);
            }
        });
        els.previewStage.addEventListener("pointercancel", () => {
            state.preview.drag = null;
            els.previewOverlay.classList.remove("dragging");
        });
        els.previewStage.addEventListener("dblclick", (e) => {
            const item = currentPreviewItem();
            if (!item || item.type === "video") return;
            e.preventDefault();
            if (state.preview.zoom > 1.01) {
                resetZoomState();
                applyImageTransform();
            } else {
                zoomAt(2.5, e.clientX, e.clientY);
            }
        });
        els.previewContent.addEventListener("wheel", (e) => {
            if (!state.preview.open) return;
            const item = currentPreviewItem();
            if (!item || item.type === "video") return;
            e.preventDefault();
            const factor = Math.exp(-e.deltaY * 0.0015);
            zoomAt(state.preview.zoom * factor, e.clientX, e.clientY);
        }, { passive: false });

        // 拖放导入
        // 拖放只由照片消费：桌面在 document 上也有 drop 监听（会新建桌面图标），
        // 不 stopPropagation 时文件会同时被导入照片并丢到桌面。
        win.addEventListener("dragenter", (e) => {
            if (!hasFileDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
            dragDepth++;
            win.classList.add("dragover");
        });
        win.addEventListener("dragover", (e) => {
            if (!hasFileDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "copy";
            win.classList.add("dragover");
        });
        win.addEventListener("dragleave", (e) => {
            if (!hasFileDrag(e)) return;
            e.stopPropagation();
            dragDepth = Math.max(0, dragDepth - 1);
            if (!dragDepth) win.classList.remove("dragover");
        });
        win.addEventListener("drop", (e) => {
            if (!hasFileDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
            dragDepth = 0;
            win.classList.remove("dragover");
            const files = Array.from(e.dataTransfer.files || []);
            if (files.length) handleImportFiles(files);
        });

        document.addEventListener("keydown", onDocumentKeyDown);
        document.addEventListener("fullscreenchange", onFullscreenChange);
        document.addEventListener("languagechange", onLanguageChange);
        document.addEventListener("plugin-app-open", onAppOpen);
        document.addEventListener("plugin-unload", onPhotosUnload);
    }

    /* ── 生命周期 ── */

    function updateDynamicChrome() {
        if (!els.btnSlideshow) return;
        updateSlideshowUI();
        updateFullscreenUI();
        updateSelectButton();
        updateImportUI();
        const item = state.preview.open ? currentPreviewItem() : null;
        if (item) {
            updateFavoriteButton(item);
            const deleteTitle = item.deleted ? T("photos.preview.permanentDelete", "永久删除") : T("photos.preview.delete", "删除");
            els.btnDelete.title = deleteTitle;
            els.btnDelete.setAttribute("aria-label", deleteTitle);
        }
    }

    function onPhotosUnload(e) {
        if (!e.detail || e.detail.id !== "photos") return;
        document.removeEventListener("plugin-unload", onPhotosUnload);
        release();
    }

    function release() {
        if (disposed) return;
        stopChunkedRender();
        if (renderScheduled) {
            cancelAnimationFrame(renderScheduled);
            renderScheduled = 0;
        }
        closePreview();
        disposed = true;
        clearSlideTimer();
        clearTimeout(videoClickTimer);
        if (layoutQueued) {
            cancelAnimationFrame(layoutQueued);
            layoutQueued = 0;
        }
        if (metadataSaveTimer) {
            clearTimeout(metadataSaveTimer);
            metadataSaveTimer = 0;
        }
        thumbQueue.length = 0;
        document.removeEventListener("keydown", onDocumentKeyDown);
        document.removeEventListener("fullscreenchange", onFullscreenChange);
        document.removeEventListener("languagechange", onLanguageChange);
        document.removeEventListener("plugin-app-open", onAppOpen);
        if (layoutObserver) layoutObserver.disconnect();
        releaseAllMediaURLs();
        releaseAllThumbURLs();
    }

    let layoutObserver = null;

    function init() {
        state = createState();
        disposed = false;
        renderSeq++;
        previewSeq++;
        previewHeld.clear();
        previewPending.clear();
        previewKeep.clear();
        loadLibrary();
        // 启动自动扫描 /Picture/（Q2：唯一照片库）；扫描完成后重渲染一次
        libraryReady = scanIntoState()
            .catch((err) => console.warn("[photos] 建库扫描异常", err))
            .then(() => {
                if (disposed) return;
                render();
                renderAlbumNav();
            });
        applyStaticI18n();
        renderAlbumNav();
        setActiveNav(state.view);
        els.segBtns.forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === state.mode));
        bindEvents();
        updateSearchClear();
        updateImportUI();
        render();

        if (typeof ResizeObserver === "function") {
            layoutObserver = new ResizeObserver(() => {
                if (!state.preview.open || !currentPreviewItem()) return;
                if (currentPreviewItem().type === "video") return;
                if (layoutQueued) return;
                layoutQueued = requestAnimationFrame(() => {
                    layoutQueued = 0;
                    applyPreviewFit();
                    clampPan();
                    applyImageTransform();
                });
            });
            layoutObserver.observe(els.previewStage);
        }
    }

    init();
}
