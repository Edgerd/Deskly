/**
 * finder-views.js — 访达视图渲染（macOS 15 还原）
 *
 * 职责：
 *  - 四种视图：图标 / 列表 / 分栏 / 画廊
 *  - 分组（种类 / 日期 / 大小 / 标签）：调用 finder-group.groupEntries 生成分组头部
 *  - 标签过滤（FinderState 每标签页的 tagFilter）与搜索过滤（FinderState.searchQuery）
 *  - 列表视图「种类」列、条目标签色点、图片真实缩略图（懒加载 + 缓存）
 *  - 监听 FinderState 事件实时重渲染
 *
 * 生命周期：本模块是常驻单例，init() 会先撤销上一次注册的订阅；
 * 图片缩略图 / 画廊预览的对象 URL 在 dispose()（重开窗口或 plugin-unload）时统一回收。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { FinderState } from './finder-state.js';
import { FinderTags } from './finder-tags.js';
import { groupEntries, kindLabel } from './finder-group.js';
import { VFS } from '../../src/javascripts/vfs.js';
import { FOLDER_ICON, GENERIC_DOC_ICON, assetPath } from '../../src/javascripts/paths.js';

// 图片名沿用原变量名，值统一由 paths.js 生成（运行时 URL 按站点根解析，见 paths.js 注释）
const ICON_FOLDER = FOLDER_ICON;
const ICON_DOC = GENERIC_DOC_ICON;
const ICON_IMG = assetPath('images/photo.circle.svg');
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'];

const FinderViews = (() => {
    let listBody = null, listHeader = null, finderContent = null, emptyEl = null, emptyTextEl = null;
    let onEntryOpen = null, onContextMenu = null, onEmptyContextMenu = null;

    /** @type {Array} 最近一次渲染的可见条目（顺序与屏幕一致，Quick Look 据此计数与翻页） */
    let rendered = [];
    /** @type {Map<string, number>} 路径 → 渲染序号，避免逐项 indexOf 的 O(n²) */
    let renderedIndex = new Map();

    /** @type {Map<string, string|null>} 图片缩略图对象 URL 缓存（null = 读失败，保持图标不再重读） */
    const thumbCache = new Map();
    /** @type {string|null} 画廊预览当前持有的对象 URL */
    let galleryUrl = null;

    /** @type {Function[]} 资源释放回调 */
    let disposers = [];

    /** 登记一个释放回调。 */
    function track(fn) { disposers.push(fn); }

    /** 执行并清空全部释放回调（可重复调用）。 */
    function dispose() {
        releaseThumbs();
        // 上一次开窗的渲染序列不得留给下一个实例（Quick Look 会以它作翻页列表）
        rendered = [];
        renderedIndex = new Map();
        const list = disposers;
        disposers = [];
        list.forEach(fn => fn());
    }

    /** 标签色名 → 十六进制（取自 FinderTags.TAG_COLORS） */
    const tagHexCache = {};
    function tagHex(name) {
        if (tagHexCache[name]) return tagHexCache[name];
        const c = (FinderTags.TAG_COLORS || []).find(t => t.name === name);
        return (tagHexCache[name] = c ? c.hex : '#8e8e93');
    }

    /**
     * 初始化视图模块。
     * @param {object} options
     * @param {Function} [options.entryOpen] 条目打开回调(entry)
     * @param {Function} [options.contextMenu] 条目右键回调(x, y, entry)
     * @param {Function} [options.emptyContextMenu] 空白区域右键回调(x, y)
     */
    function init(options = {}) {
        // 常驻单例：重开窗口先撤销上一次的订阅，否则一次 setEntries 会触发 N 次重渲染
        dispose();

        listBody = document.getElementById('list-body');
        listHeader = document.getElementById('list-header');
        finderContent = document.getElementById('finder-content');
        emptyEl = document.getElementById('finder-empty');
        emptyTextEl = document.getElementById('finder-empty-text');

        onEntryOpen = options.entryOpen || null;
        onContextMenu = options.contextMenu || null;
        onEmptyContextMenu = options.emptyContextMenu || null;

        bindEvents();

        // 监听状态变化实时重渲染
        track(FinderState.on('entries-changed', renderEntries));
        track(FinderState.on('view-changed', renderEntries));
        track(FinderState.on('sort-changed', renderEntries));
        track(FinderState.on('group-changed', renderEntries));
        track(FinderState.on('tags-changed', renderEntries));
        track(FinderState.on('search-changed', renderEntries));
        track(FinderState.on('selection-changed', applySelection));
        track(FinderState.on('locale-changed', renderEntries));
    }

    /** 绑定事件。 */
    function bindEvents() {
        // 列表表头排序
        const onHeaderClick = (e) => {
            const col = e.target.closest('.col-sortable');
            if (col) FinderState.setSort(col.dataset.sort);
        };
        listHeader?.addEventListener('click', onHeaderClick);
        track(() => listHeader?.removeEventListener('click', onHeaderClick));

        // 主内容区右键空白区域（分栏 / 画廊的空白在 .column-pane / .gallery-preview 内，故按「不在条目内」判定）
        const onContentContext = (e) => {
            if (e.target.closest('.entry') || e.target.closest('.list-header')) return;
            e.preventDefault();
            e.stopPropagation();
            FinderState.clearSelection();
            onEmptyContextMenu?.(e.clientX, e.clientY);
        };
        finderContent?.addEventListener('contextmenu', onContentContext);
        track(() => finderContent?.removeEventListener('contextmenu', onContentContext));

        // 点击条目之间的空白清除选中
        const onBodyClick = (e) => {
            if (!e.target.closest('.entry')) FinderState.clearSelection();
        };
        listBody?.addEventListener('click', onBodyClick);
        track(() => listBody?.removeEventListener('click', onBodyClick));
    }

    // ---------- 工具函数 ----------

    /** 取扩展名（idx > 0：'.gitignore' 这类隐藏文件没有扩展名） */
    function getExt(name) {
        const idx = name.lastIndexOf('.');
        return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
    }

    /** 是否为图片 */
    function isImage(name) { return IMG_EXTS.includes(getExt(name)); }

    /** 根据条目返回图标路径 */
    function iconFor(entry) {
        if (entry.type === 'folder') {
            return entry.icon ? assetPath(`icons/${entry.icon}`) : ICON_FOLDER;
        }
        if (isImage(entry.name)) return ICON_IMG;
        return ICON_DOC;
    }

    /** 条目图标的安全回退目标 */
    function iconFallbackFor(entry) {
        return entry.type === 'folder' ? ICON_FOLDER : ICON_DOC;
    }

    /**
     * 图片地址失效时回退到静态图标（只回退一次，回退图本身再失败就停手，不制造 error 循环）。
     * @param {HTMLImageElement} imgEl
     * @param {string} fallbackSrc
     */
    function applyIconFallback(imgEl, fallbackSrc) {
        const onError = () => {
            imgEl.removeEventListener('error', onError);
            if (imgEl.getAttribute('src') !== fallbackSrc) imgEl.src = fallbackSrc;
        };
        imgEl.addEventListener('error', onError);
    }

    /** 格式化修改日期（优先用 VFS，回退本地格式） */
    function formatDate(ts) {
        if (!ts) return '';
        return VFS.formatDate?.(ts) ?? new Date(ts).toLocaleDateString();
    }

    /** 格式化大小（文件夹显示占位） */
    function formatSize(size) {
        if (size == null) return '--';
        return VFS.formatSize?.(size) ?? (size + ' B');
    }

    // ---------- 过滤 ----------

    /** 标签过滤：tagFilter 为空则不过滤 */
    function passesTagFilter(entry) {
        const f = FinderState.getTagFilter();
        if (!f) return true;
        return FinderTags.getTags(entry.path).includes(f);
    }

    /** 搜索过滤：按名称包含匹配（不区分大小写） */
    function passesSearch(entry) {
        const q = FinderState.getState().searchQuery;
        if (!q) return true;
        return entry.name.toLowerCase().includes(q.toLowerCase());
    }

    // ---------- 排序 ----------

    /**
     * 排序条目：先按字段，再强制文件夹前置。
     * @param {Array} entries
     * @param {string} sortBy
     * @param {boolean} sortAsc
     * @returns {Array}
     */
    function sortEntries(entries, sortBy, sortAsc) {
        const sorted = [...entries].sort((a, b) => {
            let cmp = 0;
            if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
            else if (sortBy === 'date') cmp = (a.modified || 0) - (b.modified || 0);
            else if (sortBy === 'size') cmp = a.size == null ? -1 : (b.size == null ? 1 : a.size - b.size);
            else if (sortBy === 'kind') cmp = kindLabel(a).localeCompare(kindLabel(b));
            return sortAsc ? cmp : -cmp;
        });
        sorted.sort((a, b) => {
            if (a.type === 'folder' && b.type !== 'folder') return -1;
            if (a.type !== 'folder' && b.type === 'folder') return 1;
            return 0;
        });
        return sorted;
    }

    // ---------- 渲染 ----------

    /** 渲染当前视图。 */
    function renderEntries() {
        if (!listBody || !finderContent || !emptyEl) return;
        const s = FinderState.getState();
        const all = s.entries || [];

        listBody.innerHTML = '';
        emptyEl.hidden = true;
        rendered = [];
        renderedIndex = new Map();

        if (s.error) {
            // 错误文案由调用方（script.js）按当前语言生成，这里只做呈现
            showEmptyState(s.error);
            return;
        }

        const filtered = all.filter(e => passesTagFilter(e) && passesSearch(e));
        if (!filtered.length) {
            // 搜索无结果与空文件夹是两回事，不能都报「此文件夹为空」
            showEmptyState(s.searchQuery
                ? i18n.t('finder.noResults', '没有找到匹配的项目')
                : i18n.t('finder.emptyFolder', '此文件夹为空'));
            return;
        }

        const { field: sortBy, asc: sortAsc } = FinderState.getSort();
        const viewMode = FinderState.getViewMode();
        const sorted = sortEntries(filtered, sortBy, sortAsc);

        // 分栏 / 画廊视图单独布局
        if (viewMode === 'gallery') {
            setRendered(sorted);
            setViewClass('gallery');
            syncHeader();
            renderGalleryView(sorted);
            return;
        }
        if (viewMode === 'column') {
            setRendered(sorted);
            setViewClass('column');
            syncHeader();
            renderColumnView(sorted);
            return;
        }

        setViewClass(viewMode);
        syncHeader();

        // 分组仅应用于图标 / 列表视图（分栏、画廊不分组）
        const groupBy = FinderState.getGroupBy();
        const groupable = groupBy && groupBy !== 'none';
        if (groupable) {
            const groups = groupEntries(sorted, groupBy);
            // 屏幕顺序 = 各组顺序拼接，Quick Look 的上下翻页必须跟随这个顺序
            setRendered(groups.reduce((acc, g) => acc.concat(g.items), []));
            groups.forEach((g) => {
                if (g.label) listBody.appendChild(buildGroupHeader(g.label));
                g.items.forEach(e => listBody.appendChild(buildEntry(e, viewMode)));
            });
        } else {
            setRendered(sorted);
            sorted.forEach(e => listBody.appendChild(buildEntry(e, viewMode)));
        }

        applySelection();
        lazyLoadThumbs(sorted, viewMode);
    }

    /** 记录本次渲染的可见顺序（供 Quick Look 计数与翻页）。 */
    function setRendered(list) {
        rendered = list;
        renderedIndex = new Map();
        list.forEach((e, i) => { if (!renderedIndex.has(e.path)) renderedIndex.set(e.path, i); });
    }

    /**
     * 条目在当前渲染序列中的序号（不在渲染结果里时返回 -1）。
     * @param {string} path
     * @returns {number}
     */
    function indexOfPath(path) {
        const i = renderedIndex.get(path);
        return i === undefined ? -1 : i;
    }

    /** 空 / 错误状态：复用空状态浮层，只换文案（浮层 pointer-events:none，事件不会落在它身上）。 */
    function showEmptyState(message) {
        setViewClass('');
        syncHeader();
        if (emptyTextEl) emptyTextEl.textContent = message;
        emptyEl.hidden = false;
    }

    /** 设置内容区视图 class */
    function setViewClass(mode) {
        finderContent.className = 'finder-content';
        if (mode === 'icon' || mode === 'grid') finderContent.classList.add('grid-view');
        else if (mode === 'column') finderContent.classList.add('column-view');
        else if (mode === 'gallery') finderContent.classList.add('gallery-view');
    }

    /** 同步列表表头显隐与排序箭头 */
    function syncHeader() {
        if (!listHeader) return;
        const viewMode = FinderState.getViewMode();
        const { field: sortBy, asc: sortAsc } = FinderState.getSort();
        listHeader.style.display = (viewMode === 'list') ? '' : 'none';
        listHeader.querySelectorAll('.col-sortable').forEach((col) => {
            col.classList.remove('asc', 'desc');
            if (col.dataset.sort === sortBy) {
                col.classList.add(sortAsc ? 'asc' : 'desc');
            }
        });
    }

    /** 分组头部 */
    function buildGroupHeader(label) {
        const h = document.createElement('div');
        h.className = 'group-header';
        h.textContent = label;
        return h;
    }

    /**
     * 构建单个条目 DOM。
     * @param {object} entry
     * @param {string} viewMode
     * @returns {HTMLElement}
     */
    function buildEntry(entry, viewMode) {
        const grid = viewMode === 'icon' || viewMode === 'grid';
        const column = viewMode === 'column';

        const row = document.createElement('div');
        row.className = 'entry';
        row.dataset.path = entry.path;

        const icon = document.createElement('img');
        icon.className = 'entry-icon';
        icon.src = iconFor(entry);
        icon.alt = '';
        icon.draggable = false;
        applyIconFallback(icon, iconFallbackFor(entry));
        row.appendChild(icon);

        const name = document.createElement('span');
        name.className = 'entry-name';
        name.textContent = entry.name;
        name.title = entry.name;
        row.appendChild(name);

        if (!grid && !column) {
            // 列表视图：日期 / 大小 / 种类
            const date = document.createElement('span');
            date.className = 'entry-date';
            date.textContent = formatDate(entry.modified);
            row.appendChild(date);

            const size = document.createElement('span');
            size.className = 'entry-size';
            size.textContent = entry.type === 'folder' ? '--' : formatSize(entry.size);
            row.appendChild(size);

            const kind = document.createElement('span');
            kind.className = 'entry-kind';
            kind.textContent = kindLabel(entry);
            row.appendChild(kind);
        }

        // 标签色点（列表视图置于最左，图标视图以叠加层呈现）
        appendTagDots(row, entry, grid);

        // 单击选中：不要 stopPropagation —— window.js 的「按下即置顶」监听挂在窗口元素上，
        // 吞掉事件会让点击文件时 Finder 窗口留在其它窗口之下。
        row.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            markSelected(row, entry.path);
        });

        // 双击打开
        row.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            if (onEntryOpen) onEntryOpen(entry);
        });

        // 右键菜单
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            markSelected(row, entry.path);
            if (onContextMenu) onContextMenu(e.clientX, e.clientY, entry);
        });

        return row;
    }

    /** 仅选中单个条目（清除同容器内其它选中项） */
    function markSelected(row, path) {
        row.parentElement.querySelectorAll('.entry.selected').forEach(el => el !== row && el.classList.remove('selected'));
        row.classList.add('selected');
        FinderState.selectSingle(path);
    }

    /** 标签色点渲染 */
    function appendTagDots(row, entry, grid) {
        const tags = FinderTags.getTags(entry.path);
        if (!tags.length) return;
        if (grid) {
            const wrap = document.createElement('div');
            wrap.className = 'tag-dot-wrap';
            tags.forEach(t => {
                const dot = document.createElement('span');
                dot.className = 'entry-tag-dot';
                dot.style.background = tagHex(t);
                wrap.appendChild(dot);
            });
            row.appendChild(wrap);
        } else {
            const dot = document.createElement('span');
            dot.className = 'entry-tag-dot';
            dot.style.background = tagHex(tags[0]);
            row.insertBefore(dot, row.firstChild);
        }
    }

    /** 分栏视图：单栏呈现当前目录（点击文件夹由 openEntry 导航） */
    function renderColumnView(entries) {
        const pane = document.createElement('div');
        pane.className = 'column-pane';

        const header = document.createElement('div');
        header.className = 'column-pane-header';
        header.textContent = FinderState.pathLabel(FinderState.getState().currentPath);
        pane.appendChild(header);

        entries.forEach(e => pane.appendChild(buildEntry(e, 'column')));
        listBody.appendChild(pane);
    }

    // ---------- 画廊视图 ----------

    /** 画廊视图：预览 + 缩略图条 */
    function renderGalleryView(entries) {
        const preview = document.createElement('div');
        preview.className = 'gallery-preview';
        preview.id = 'gallery-preview';

        const filmstrip = document.createElement('div');
        filmstrip.className = 'gallery-filmstrip';
        filmstrip.id = 'gallery-filmstrip';

        if (entries.length) showGalleryItem(entries[0], preview, filmstrip, entries);

        listBody.appendChild(preview);
        listBody.appendChild(filmstrip);
    }

    /**
     * 显示画廊中的某一项。
     * @param {object} entry
     * @param {HTMLElement} preview
     * @param {HTMLElement} filmstrip
     * @param {Array} allEntries
     */
    function showGalleryItem(entry, preview, filmstrip, allEntries) {
        preview.innerHTML = '';
        releaseGalleryUrl();
        const img = document.createElement('img');
        img.alt = '';
        applyIconFallback(img, iconFallbackFor(entry));
        if (isImage(entry.name) && entry.path) {
            VFS.readFile(entry.path).then((file) => {
                if (file) {
                    galleryUrl = URL.createObjectURL(file);
                    img.src = galleryUrl;
                } else {
                    img.src = iconFor(entry);
                }
            }).catch(() => { img.src = iconFor(entry); });
        } else {
            img.src = iconFor(entry);
        }
        preview.appendChild(img);

        filmstrip.innerHTML = '';
        allEntries.forEach((e) => {
            const thumb = document.createElement('div');
            thumb.className = 'filmstrip-thumb' + (e === entry ? ' active' : '');
            const tImg = document.createElement('img');
            tImg.src = iconFor(e); // 缩略图占位（真实图在点击时加载）
            tImg.alt = '';
            tImg.draggable = false;
            applyIconFallback(tImg, iconFallbackFor(e));
            thumb.appendChild(tImg);
            thumb.addEventListener('click', () => showGalleryItem(e, preview, filmstrip, allEntries));
            filmstrip.appendChild(thumb);
        });
    }

    // ---------- 缩略图懒加载 ----------

    /** 图标视图：为图片条目加载真实缩略图（失败回退图标） */
    function lazyLoadThumbs(entries, viewMode) {
        if (viewMode !== 'icon' && viewMode !== 'grid') return;
        if (!listBody) return;
        // 一次建索引再遍历节点，避免逐节点 entries.find 的 O(n²)
        const byPath = new Map(entries.map(e => [e.path, e]));
        listBody.querySelectorAll('.entry').forEach(node => {
            const entry = byPath.get(node.dataset.path);
            if (!entry || !isImage(entry.name)) return;
            const img = node.querySelector('.entry-icon');
            img && loadThumb(entry, img);
        });
    }

    /**
     * 读取文件并以对象 URL 设为图标。
     * URL 进缓存复用：重渲染（排序 / 分组 / 搜索每敲一次都会）不再重新读盘、重新建 URL，
     * 否则每次渲染都留下一个没人回收的对象 URL。
     */
    function loadThumb(entry, imgEl) {
        if (thumbCache.has(entry.path)) {
            const cached = thumbCache.get(entry.path);
            if (cached) imgEl.src = cached; // null = 上次读取失败，保持静态图标
            return;
        }
        VFS.readFile(entry.path).then((file) => {
            if (!file) {
                thumbCache.set(entry.path, null);
                return;
            }
            const url = URL.createObjectURL(file);
            // 并发读同一路径时后到的结果不能覆盖键、把先建好的 URL 变成孤儿；
            // 已有缓存 URL 就复用它并回收本次多余的 URL。
            const existing = thumbCache.get(entry.path);
            if (existing) {
                URL.revokeObjectURL(url);
                if (imgEl.isConnected) imgEl.src = existing;
                return;
            }
            thumbCache.set(entry.path, url);
            if (imgEl.isConnected) imgEl.src = url;
        }).catch(() => { thumbCache.set(entry.path, null); });
    }

    /** 回收全部缩略图 / 画廊对象 URL。 */
    function releaseThumbs() {
        thumbCache.forEach((url) => { if (url) URL.revokeObjectURL(url); });
        thumbCache.clear();
        releaseGalleryUrl();
    }

    /** 回收画廊预览持有的对象 URL。 */
    function releaseGalleryUrl() {
        if (galleryUrl) {
            URL.revokeObjectURL(galleryUrl);
            galleryUrl = null;
        }
    }

    /** 根据选中集合同步 .selected 高亮 */
    function applySelection() {
        if (!listBody) return;
        const sel = FinderState.getState().selectedPaths;
        listBody.querySelectorAll('.entry').forEach(el => el.classList.toggle('selected', sel.has(el.dataset.path)));
    }

    /** 当前渲染的可见条目（Quick Look 的计数与上下翻页以此为准）。 */
    function getRenderedEntries() {
        return rendered;
    }

    return { init, dispose, getRenderedEntries, indexOfPath };
})();

export { FinderViews };
