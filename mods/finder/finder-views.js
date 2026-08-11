/**
 * finder-views.js — 访达视图渲染（macOS 15 还原）
 *
 * 职责：
 *  - 四种视图：图标 / 列表 / 分栏 / 画廊
 *  - 分组（种类 / 日期 / 大小 / 标签）：调用 finder-group.groupEntries 生成分组头部
 *  - 标签过滤（FinderState.tagFilter）与搜索过滤（FinderState.searchQuery）
 *  - 列表视图「种类」列、条目标签色点、图片真实缩略图（懒加载）
 *  - 监听 FinderState 事件实时重渲染
 */

import { FinderState } from './finder-state.js';
import { FinderTags } from './finder-tags.js';
import { groupEntries, kindLabel } from './finder-group.js';
import { VFS } from '../../src/javascripts/vfs.js';

const ICON_FOLDER = '../../assets/icons/folder/Folder.png';
const ICON_DOC = '../../assets/images/GenericDocumentIcon.png';
const ICON_IMG = '../../assets/images/photo.circle.svg';
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'];

const FinderViews = (() => {
    let listBody = null, listHeader = null, finderContent = null, emptyEl = null;
    let onEntryOpen = null, onContextMenu = null, onEmptyContextMenu = null, onSort = null;

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
     * @param {Function} [options.sort] 排序回调(field)
     */
    function init(options = {}) {
        listBody = document.getElementById('list-body');
        listHeader = document.getElementById('list-header');
        finderContent = document.getElementById('finder-content');
        emptyEl = document.getElementById('finder-empty');

        onEntryOpen = options.entryOpen || null;
        onContextMenu = options.contextMenu || null;
        onEmptyContextMenu = options.emptyContextMenu || null;
        onSort = options.sort || null;

        bindEvents();

        // 监听状态变化实时重渲染
        FinderState.on('entries-changed', renderEntries);
        FinderState.on('view-changed', renderEntries);
        FinderState.on('sort-changed', renderEntries);
        FinderState.on('group-changed', renderEntries);
        FinderState.on('tags-changed', renderEntries);
        FinderState.on('search-changed', renderEntries);
        FinderState.on('selection-changed', applySelection);
    }

    /** 绑定事件。 */
    function bindEvents() {
        // 列表表头排序
        if (listHeader) {
            listHeader.addEventListener('click', (e) => {
                const col = e.target.closest('.col-sortable');
                if (col) { FinderState.setSort(col.dataset.sort); onSort?.(col.dataset.sort); }
            });
        }

        // 主内容区右键空白区域
        if (finderContent) {
            finderContent.addEventListener('contextmenu', (e) => {
                if (e.target === finderContent || e.target === listBody || e.target === emptyEl) {
                    e.preventDefault();
                    e.stopPropagation();
                    FinderState.clearSelection();
                    onEmptyContextMenu?.(e.clientX, e.clientY);
                }
            });
        }

        // 点击条目之间的空白清除选中
        if (listBody) {
            listBody.addEventListener('click', (e) => {
                if (e.target === listBody) FinderState.clearSelection();
            });
        }
    }

    // ---------- 工具函数 ----------

    /** 取扩展名 */
    function getExt(name) {
        const idx = name.lastIndexOf('.');
        return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
    }

    /** 是否为图片 */
    function isImage(name) { return IMG_EXTS.includes(getExt(name)); }

    /** 根据条目返回图标路径 */
    function iconFor(entry) {
        if (entry.type === 'folder') {
            return entry.icon ? `../../assets/icons/${entry.icon}` : ICON_FOLDER;
        }
        if (isImage(entry.name)) return ICON_IMG;
        return ICON_DOC;
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
        const f = FinderState.getState().tagFilter;
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

        const filtered = all.filter(e => passesTagFilter(e) && passesSearch(e));
        if (!all.length || !filtered.length) {
            emptyEl.hidden = false;
            setViewClass('');
            syncHeader();
            return;
        }

        const sorted = sortEntries(filtered, s.sortBy, s.sortAsc);

        // 分栏 / 画廊视图单独布局
        if (s.viewMode === 'gallery') {
            setViewClass('gallery');
            syncHeader();
            renderGalleryView(sorted);
            return;
        }
        if (s.viewMode === 'column') {
            setViewClass('column');
            syncHeader();
            renderColumnView(sorted);
            return;
        }

        setViewClass(s.viewMode);
        syncHeader();

        // 分组仅应用于图标 / 列表视图（分栏、画廊不分组）
        const groupable = s.groupBy && s.groupBy !== 'none';
        if (groupable) {
            const groups = groupEntries(sorted, s.groupBy);
            groups.forEach((g) => {
                if (g.label) listBody.appendChild(buildGroupHeader(g.label));
                g.items.forEach(e => listBody.appendChild(buildEntry(e, s.viewMode)));
            });
        } else {
            sorted.forEach(e => listBody.appendChild(buildEntry(e, s.viewMode)));
        }

        applySelection();
        lazyLoadThumbs(sorted, s.viewMode);
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
        const s = FinderState.getState();
        listHeader.style.display = (s.viewMode === 'list') ? '' : 'none';
        listHeader.querySelectorAll('.col-sortable').forEach((col) => {
            col.classList.remove('asc', 'desc');
            if (col.dataset.sort === s.sortBy) {
                col.classList.add(s.sortAsc ? 'asc' : 'desc');
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
        icon.draggable = false;
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

        // 单击选中
        row.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
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
        header.textContent = FinderState.getState().currentPath.split('/').pop() || '/';
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
        const img = document.createElement('img');
        if (isImage(entry.name) && entry.path) {
            VFS.readFile(entry.path).then((file) => {
                if (file) img.src = URL.createObjectURL(file);
                else img.src = iconFor(entry);
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
            tImg.draggable = false;
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
        const nodes = listBody.querySelectorAll('.entry');
        nodes.forEach(node => {
            const entry = entries.find(e => e.path === node.dataset.path);
            if (!entry || !isImage(entry.name)) return;
            const img = node.querySelector('.entry-icon');
            img && loadThumb(entry, img);
        });
    }

    /** 读取文件并以对象 URL 设为图标（异常则保持图标不变） */
    function loadThumb(entry, imgEl) {
        VFS.readFile(entry.path).then((file) => {
            if (file) {
                const url = URL.createObjectURL(file);
                imgEl.src = url;
                imgEl.onload = () => URL.revokeObjectURL(url);
            }
        }).catch(() => { /* 保持图标 */ });
    }

    /** 根据选中集合同步 .selected 高亮 */
    function applySelection() {
        if (!listBody) return;
        const sel = FinderState.getState().selectedPaths;
        listBody.querySelectorAll('.entry').forEach(el => el.classList.toggle('selected', sel.has(el.dataset.path)));
    }

    return { init, renderEntries, getExt, iconFor, buildEntry };
})();

export { FinderViews };
