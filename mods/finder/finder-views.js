/**
 * finder-views.js — 四种视图（图标 / 列表 / 分栏 / 画廊）渲染：分组头部、标签 / 搜索过滤、图片缩略图（懒加载 + 缓存），
 * 监听 FinderState 事件重渲染。
 *
 * 本批次新增（保真清单 F-24 / F-34 / F-35 / F-38 / F-42）：
 *  - F-38 多选手势：⌘ 点选 / ⇧ 连选 / 框选橡皮筋（pointer 事件，位移 <4px 视为点击）；
 *  - F-24 拖拽：条目可拖起（携带整个选中集，ui/dnd.js 统一底座），落入文件夹 = 移动（⌥ 复制）；
 *  - F-34 分栏视图父链横排：每级一栏，点文件夹右侧展开；
 *  - F-35 画廊真缩略图 + 旋转落盘 + 文件名开关；
 *  - F-42 扩展名图标分派 + 文件夹角标计数 + 隐藏文件（finder-settings）。
 * 常驻单例：init() 先撤销上次订阅；缩略图 / 画廊预览的对象 URL 在 dispose() 时统一回收。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { FinderState } from './finder-state.js';
import { FinderTags } from './finder-tags.js';
import { FinderSettings } from './finder-settings.js';
import { groupEntries, kindLabel } from './finder-group.js';
import { FOLDER_ICON, GENERIC_DOC_ICON, GENERIC_APP_ICON, assetPath } from '../../src/javascripts/paths.js';
import { fileIconFor } from '../../src/javascripts/file-type-icons.js';
import { setInternalDrag, readInternalDrag, endInternalDrag, wantsCopy, dragGhost, ensureGhostStyle } from '../../src/javascripts/ui/dnd.js';

/* Q6 收口：只走 Deskly 公开 API（vfs 门面读文件与格式化） */
const Deskly = () => window.Deskly;
const unwrap = (env) => {
    if (!env || !env.ok) {
        const err = new Error((env && env.reason) || 'Deskly 调用失败');
        err.code = (env && env.code) || 'EIO';
        throw err;
    }
    return env.value;
};
const VFS = {
    readFile: async (p) => unwrap(await Deskly().vfs.readFile(p)),
    writeFile: async (p, data) => unwrap(await Deskly().fs.writeAt(p, data)),
    formatSize: (bytes) => Deskly().vfs.formatSize(bytes),
    formatDate: (ts) => Deskly().vfs.formatDate(ts),
};

// 图片名沿用原变量名，值统一由 paths.js 生成（运行时 URL 按站点根解析，见 paths.js 注释）
const ICON_FOLDER = FOLDER_ICON;
const ICON_DOC = GENERIC_DOC_ICON;
const ICON_APP = GENERIC_APP_ICON;
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'];

/** 文件夹角标计数缓存（F-42）：路径 → {count, at}；LRU 上限 200，失败不缓存。 */
const folderCountCache = new Map();
async function folderCount(path) {
    const hit = folderCountCache.get(path);
    if (hit && Date.now() - hit.at < 30_000) return hit.count;
    let count = 0;
    try {
        const list = unwrap(await Deskly().fs.listAt(path));
        count = (list || []).filter((e) => !String(e.name || '').endsWith('.deskly-origin')).length;
        folderCountCache.set(path, { count, at: Date.now() });
        if (folderCountCache.size > 200) folderCountCache.delete(folderCountCache.keys().next().value);
    } catch { /* 读不到就不显示数字，不缓存失败值 */ }
    return count;
}

const FinderViews = (() => {
    let listBody = null, listHeader = null, finderContent = null, emptyEl = null, emptyTextEl = null;
    let onEntryOpen = null, onContextMenu = null, onEmptyContextMenu = null;
    let onDropPaths = null;   // F-24：内部拖拽落入文件夹/空白（paths, targetDir, copy）→ 入口执行 move/copy
    let onRotateImage = null; // F-35：画廊旋转落盘（path, deltaDeg）→ 入口实现

    /** @type {Array} 最近一次渲染的可见条目（顺序与屏幕一致，Quick Look 据此计数与翻页） */
    let rendered = [];
    /** @type {Map<string, number>} 路径 → 渲染序号 */
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
        bandStart = null;
        if (band) { band.remove(); band = null; }
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
     * @param {Function} [options.dropPaths] 内部拖拽落入（paths, targetDir, copy）
     * @param {Function} [options.rotateImage] 画廊旋转（path, deltaDeg）
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
        onDropPaths = options.dropPaths || null;
        onRotateImage = options.rotateImage || null;

        ensureGhostStyle();
        bindEvents();

        // 监听状态变化实时重渲染
        track(FinderState.on('entries-changed', renderEntries));
        track(FinderState.on('view-changed', renderEntries));
        track(FinderState.on('sort-changed', renderEntries));
        track(FinderState.on('group-changed', renderEntries));
        track(FinderState.on('tags-changed', renderEntries));
        track(FinderState.on('search-changed', renderEntries));
        track(FinderState.on('search-results-changed', renderEntries));
        track(FinderState.on('selection-changed', applySelection));
        track(FinderState.on('locale-changed', renderEntries));
    }

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

        // 框选橡皮筋（F-38）：空白处按下拖动出现选框，松手选中相交条目
        const onBandStart = (e) => {
            if (e.button !== 0 || e.target.closest('.entry') || e.target.closest('.gallery-filmstrip')) return;
            const viewMode = FinderState.getViewMode();
            if (viewMode !== 'icon' && viewMode !== 'list') return;   // 分栏/画廊点击语义不同，不做框选
            startRubberBand(e);
        };
        listBody?.addEventListener('pointerdown', onBandStart);
        track(() => listBody?.removeEventListener('pointerdown', onBandStart));

        // 常驻 pointermove/pointerup：框选拖动与松手收尾（bandStart 为空时为空操作）
        document.addEventListener('pointermove', onBandMove);
        document.addEventListener('pointerup', onBandUp);
        track(() => {
            document.removeEventListener('pointermove', onBandMove);
            document.removeEventListener('pointerup', onBandUp);
        });

        // 点击条目之间的空白清除选中（框选刚收尾的 click 不算，否则会清掉刚框到的结果）
        const onBodyClick = (e) => {
            if (Date.now() - lastBandEndAt < 200) return;
            if (!e.target.closest('.entry')) FinderState.clearSelection();
        };
        listBody?.addEventListener('click', onBodyClick);
        track(() => listBody?.removeEventListener('click', onBodyClick));

        // F-24：空白处落下内部拖拽 = 移动/复制到当前目录（分栏视图落到对应栏目录）
        const onDrop = (e) => {
            const payload = readInternalDrag(e);
            if (!payload) return;
            e.preventDefault();
            e.stopPropagation();
            const pane = e.target.closest?.('.column-pane');
            const targetDir = pane?.dataset?.dir || FinderState.getState().currentPath;
            const dragged = payload.paths || [];
            // 拖到当前目录自身 = 原地放下，不动文件也不报错
            if (!dragged.length || dragged.includes(targetDir)) return;
            onDropPaths?.(dragged, targetDir, wantsCopy(e));
        };
        const onDragOver = (e) => {
            if (!readInternalDrag(e)) return;
            e.preventDefault();
            e.dataTransfer && (e.dataTransfer.dropEffect = wantsCopy(e) ? 'copy' : 'move');
        };
        listBody?.addEventListener('dragover', onDragOver);
        listBody?.addEventListener('drop', onDrop);
        track(() => listBody?.removeEventListener('dragover', onDragOver));
        track(() => listBody?.removeEventListener('drop', onDrop));
    }

    // ---------- 工具函数 ----------

    /** 取扩展名（idx > 0：'.gitignore' 这类隐藏文件没有扩展名） */
    function getExt(name) {
        const idx = name.lastIndexOf('.');
        return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
    }

    function isImage(name) { return IMG_EXTS.includes(getExt(name)); }

    /** 当前路径规范形（/a/b）。 */
    function normalizeCur() {
        try { return Deskly().fs.paths.normalize(FinderState.getState().currentPath || '/'); } catch { return '/'; }
    }

    /** 目录名（根显示「Deskly」）。 */
    function pathLabel(dir) {
        if (dir === '/') return i18n.t('finder.rootLabel', 'Deskly');
        return dir.split('/').filter(Boolean).pop() || dir;
    }

    /** 按扩展名取类型图标（F-42）：文件夹 / 应用 / 书签走专用图，其余生成「纸张 + 类型色条」。 */
    function iconFor(entry) {
        if (entry.type === 'folder') return entry.icon ? assetPath(`icons/${entry.icon}`) : ICON_FOLDER;
        if (entry.type === 'app') return entry.icon || ICON_APP;
        if (entry.type === 'bookmark') return entry.icon ? assetPath(`icons/${entry.icon}`) : ICON_DOC;
        return fileIconFor(entry.name);
    }

    /** 条目图标的安全回退目标 */
    function iconFallbackFor(entry) {
        if (entry.type === 'folder') return ICON_FOLDER;
        if (entry.type === 'app') return ICON_APP;
        return ICON_DOC;
    }

    /**
     * 图片地址失效时回退到静态图标（只回退一次，回退图本身再失败就停手，不制造 error 循环）。
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

    /** 搜索过滤：有递归结果集（F-36）时结果即列表；否则按名称匹配当前目录。 */
    function visibleEntries(all) {
        const s = FinderState.getState();
        if (s.searchQuery && Array.isArray(s.searchResults)) return s.searchResults;
        let list = all;
        if (!FinderSettings.bool('finder.showHidden')) {
            list = list.filter((e) => !(e.name || '').startsWith('.'));
        }
        return list.filter((e) => passesTagFilter(e) && passesSearch(e));
    }

    function passesSearch(entry) {
        const q = FinderState.getState().searchQuery;
        if (!q) return true;
        return entry.name.toLowerCase().includes(q.toLowerCase());
    }

    // ---------- 排序 ----------

    /**
     * 排序条目：先按字段，再强制文件夹前置。
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

        listBody.innerHTML = '';
        emptyEl.hidden = true;
        rendered = [];
        renderedIndex = new Map();

        if (s.error) {
            showEmptyState(s.error);
            return;
        }

        const filtered = visibleEntries(s.entries || []);
        if (!filtered.length) {
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
            renderColumnView();
            return;
        }

        setViewClass(viewMode);
        syncHeader();

        // 分组仅应用于图标 / 列表视图（分栏、画廊不分组）
        const groupBy = FinderState.getGroupBy();
        const groupable = groupBy && groupBy !== 'none';
        if (groupable) {
            const groups = groupEntries(sorted, groupBy);
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

    function buildGroupHeader(label) {
        const h = document.createElement('div');
        h.className = 'group-header';
        h.textContent = label;
        return h;
    }

    /**
     * 构建单个条目 DOM（含 F-38 多选手势 / F-24 拖拽 / F-42 角标与隐藏态）。
     */
    function buildEntry(entry, viewMode, dirForColumn) {
        const grid = viewMode === 'icon' || viewMode === 'grid';
        const column = viewMode === 'column';

        const row = document.createElement('div');
        row.className = 'entry';
        row.dataset.path = entry.path;
        // 桌面指针拖拽落在访达上时靠它判断「这是不是文件夹」（HTML5 拖拽有自己的载荷，不需要）
        row.dataset.type = entry.type;
        if ((entry.name || '').startsWith('.')) row.classList.add('hidden-file');

        const icon = document.createElement('img');
        icon.className = 'entry-icon';
        icon.src = iconFor(entry);
        icon.alt = '';
        icon.draggable = false;
        applyIconFallback(icon, iconFallbackFor(entry));
        row.appendChild(icon);

        if (entry.type === 'folder') {
            const n = document.createElement('span');
            n.className = 'entry-count-badge';
            folderCount(entry.path).then((c) => {
                if (c > 0 && n.isConnected) n.textContent = String(c);
            });
            row.appendChild(n);
        }

        const name = document.createElement('span');
        name.className = 'entry-name';
        name.textContent = entry.name;
        name.title = entry.name;
        row.appendChild(name);

        if (!grid && !column) {
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

        appendTagDots(row, entry, grid);

        // F-38 多选：⌘ 切换 / ⇧ 连选 / 普通单击单选。
        // 不要 stopPropagation —— window.js 的「按下即置顶」监听挂在窗口元素上，
        // 吞掉事件会让点击文件时 Finder 窗口留在其它窗口之下。
        row.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.metaKey || e.ctrlKey) { e.preventDefault(); FinderState.toggleSelect(entry.path); }
            else if (e.shiftKey) { e.preventDefault(); FinderState.selectRange(entry.path, rendered); }
            else markSelected(row, entry.path);
        });

        // F-24 拖拽：携带整个选中集走统一底座；目标文件夹高亮，落下移动（⌥ 复制）
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
            const sel = FinderState.getState().selectedPaths;
            if (!sel.has(entry.path)) FinderState.selectSingle(entry.path);
            const paths = [...FinderState.getState().selectedPaths];
            setInternalDrag(e, { paths, from: 'finder' });
            dragGhost(e, entry.name, paths.length);
        });
        row.addEventListener('dragend', () => endInternalDrag());
        if (entry.type === 'folder') {
            const onOver = (e) => {
                const payload = readInternalDrag(e);
                if (!payload) return;
                if (payload.paths.includes(entry.path)) return;   // 不能把自己拖进自己
                e.preventDefault();
                e.dataTransfer && (e.dataTransfer.dropEffect = wantsCopy(e) ? 'copy' : 'move');
                row.classList.add('dnd-drop-target');
            };
            const onLeave = () => row.classList.remove('dnd-drop-target');
            const onRowDrop = (e) => {
                row.classList.remove('dnd-drop-target');
                const payload = readInternalDrag(e);
                if (!payload) return;
                e.preventDefault();
                e.stopPropagation();
                const dragged = payload.paths.filter((p) => p !== entry.path);
                if (!dragged.length) return;
                onDropPaths?.(dragged, entry.path, wantsCopy(e));
            };
            row.addEventListener('dragover', onOver);
            row.addEventListener('dragleave', onLeave);
            row.addEventListener('drop', onRowDrop);
            row.addEventListener('dragend', onLeave);
        }

        row.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            if (onEntryOpen) onEntryOpen(entry);
        });

        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!FinderState.getState().selectedPaths.has(entry.path)) markSelected(row, entry.path);
            if (onContextMenu) onContextMenu(e.clientX, e.clientY, entry);
        });

        // 分栏视图记住所属目录（F-24 空白落点用）
        if (column && dirForColumn) row.dataset.dir = dirForColumn;
        return row;
    }

    /** 仅选中单个条目（清除同容器内其它选中项） */
    function markSelected(row, path) {
        row.parentElement.querySelectorAll('.entry.selected').forEach(el => el !== row && el.classList.remove('selected'));
        row.classList.add('selected');
        FinderState.selectSingle(path);
    }

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

    // ---------- 框选橡皮筋（F-38） ----------

    let band = null;
    let bandStart = null;   // 视口坐标
    let lastBandEndAt = 0;  // 框选收尾时间（click 事件据此跳过一次清空）
    const BAND_THRESHOLD = 4;

    /** 常驻 pointer 监听（bindEvents 里装一次）：bandStart 为空时是空操作。 */
    function onBandMove(e) {
        if (!bandStart || !listBody) return;
        const dx = Math.abs(e.clientX - bandStart.x);
        const dy = Math.abs(e.clientY - bandStart.y);
        if (!band && dx < BAND_THRESHOLD && dy < BAND_THRESHOLD) return;
        if (!band) {
            band = document.createElement('div');
            band.className = 'finder-rubber-band';
            listBody.appendChild(band);
        }
        const bodyRect = listBody.getBoundingClientRect();
        const x1 = Math.min(e.clientX, bandStart.x);
        const y1 = Math.min(e.clientY, bandStart.y);
        const x2 = Math.max(e.clientX, bandStart.x);
        const y2 = Math.max(e.clientY, bandStart.y);
        band.style.left = `${x1 - bodyRect.left + listBody.scrollLeft}px`;
        band.style.top = `${y1 - bodyRect.top + listBody.scrollTop}px`;
        band.style.width = `${x2 - x1}px`;
        band.style.height = `${y2 - y1}px`;
        selectInBand(x1, y1, x2, y2);
    }

    function onBandUp() {
        if (!bandStart) return;
        bandStart = null;
        lastBandEndAt = Date.now();
        if (band) { band.remove(); band = null; }
        applySelection();
    }

    function startRubberBand(e) {
        bandStart = { x: e.clientX, y: e.clientY };
    }

    /** 选中与选框相交的条目（统一视口坐标求交）。 */
    function selectInBand(x1, y1, x2, y2) {
        const hits = [];
        listBody.querySelectorAll('.entry').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (!(r.right < x1 || r.left > x2 || r.bottom < y1 || r.top > y2)) hits.push(el.dataset.path);
        });
        FinderState.setSelection(hits);
    }

    // ---------- 分栏视图（F-34：父链横排） ----------

    /** 分栏渲染令牌：导航后旧请求不得再往新布局里塞栏 */
    let columnSeq = 0;

    /**
     * 分栏视图：以当前路径拆父链（最多末 8 级），每级一栏横排；
     * 当前目录条目在末栏，父链里高亮所在子目录。点文件夹 = 导航进入（链路重建，历史/侧栏高亮同步）。
     */
    function renderColumnView() {
        const seq = ++columnSeq;
        const cur = normalizeCur();
        const parts = cur.split('/').filter(Boolean);
        // 父链：['/', '/a', '/a/b', ...]，>8 级时只留末 8 级（左侧给「…」回溯按钮）
        let chain = ['/'];
        parts.forEach((_, i) => chain.push('/' + parts.slice(0, i + 1).join('/')));
        if (chain.length > 8) chain = chain.slice(chain.length - 8);

        chain.forEach((dir, level) => {
            const pane = document.createElement('div');
            pane.className = 'column-pane';
            pane.dataset.dir = dir;

            const header = document.createElement('div');
            header.className = 'column-pane-header';
            if (level === 0 && chain.length === 8 && parts.length > 7) {
                const up = document.createElement('button');
                up.className = 'column-pane-more';
                up.textContent = '…';
                up.title = i18n.t('finder.columnUpMore', '回溯上级');
                up.addEventListener('click', () => onEntryOpen?.({ type: 'folder', path: chain[0] }));
                header.appendChild(up);
            }
            const title = document.createElement('span');
            title.textContent = pathLabel(dir);
            header.appendChild(title);
            pane.appendChild(header);

            const body = document.createElement('div');
            body.className = 'column-pane-body';
            pane.appendChild(body);
            listBody.appendChild(pane);

            // 逐栏取列表（走 FinderState 事件体系的同一数据源）
            const isLast = level === chain.length - 1;
            if (isLast) {
                // 末栏直接复用当前渲染数据（state.entries 已按过滤/排序前的方式给出）
                const s = FinderState.getState();
                const { field: sortBy, asc: sortAsc } = FinderState.getSort();
                const list = visibleEntries(s.entries || []);
                fillColumnPane(body, pane, dir, sortEntries(list, sortBy, sortAsc), seq);
            } else {
                (async () => {
                    try {
                        const list = unwrap(await Deskly().fs.listAt(dir));
                        if (seq !== columnSeq || !pane.isConnected) return;
                        let filtered = list.filter((e) => !(e.name || '').startsWith('.') || FinderSettings.bool('finder.showHidden'));
                        const { field: sortBy, asc: sortAsc } = FinderState.getSort();
                        fillColumnPane(body, pane, dir, sortEntries(filtered, sortBy, sortAsc), seq);
                    } catch {
                        if (seq !== columnSeq || !pane.isConnected) return;
                        const tip = document.createElement('div');
                        tip.className = 'column-pane-empty';
                        tip.textContent = i18n.t('finder.loadError', '无法读取该文件夹');
                        body.appendChild(tip);
                    }
                })();
            }
        });
        // 末栏滚入视野
        requestAnimationFrame(() => {
            const panes = listBody.querySelectorAll('.column-pane');
            const last = panes[panes.length - 1];
            last?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
    }

    /** 填一栏：文件夹点击 = 进入（导航由入口统一）；文件点击 = 选中（复用多选手势）。 */
    function fillColumnPane(body, pane, dir, entries, seq) {
        if (!entries.length) {
            const tip = document.createElement('div');
            tip.className = 'column-pane-empty';
            tip.textContent = i18n.t('finder.emptyFolder', '此文件夹为空');
            body.appendChild(tip);
            return;
        }
        const cur = normalizeCur();
        entries.forEach((e) => {
            const node = buildEntry(e, 'column', dir);
            if (dir !== '/' && cur === e.path) node.classList.add('active-in-chain');
            body.appendChild(node);
        });
    }

    // ---------- 画廊视图（F-35：真缩略图 + 旋转 + 文件名开关） ----------

    /** 画廊视图：预览 + 缩略图条 + 控件 */
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
     * 显示画廊中的某一项（真缩略图胶片条 + 类型化大预览 + 旋转/简介控件）。
     */
    function showGalleryItem(entry, preview, filmstrip, allEntries) {
        preview.innerHTML = '';
        releaseGalleryUrl();
        FinderState.selectSingle(entry.path);

        const stage = document.createElement('div');
        stage.className = 'gallery-stage';
        preview.appendChild(stage);

        const ext = getExt(entry.name);
        if (isImage(entry.name)) {
            const img = document.createElement('img');
            img.alt = '';
            img.draggable = false;
            VFS.readFile(entry.path).then((file) => {
                if (!file || !stage.isConnected) { img.src = iconFor(entry); return; }
                galleryUrl = URL.createObjectURL(file);
                img.src = galleryUrl;
            }).catch(() => { img.src = iconFor(entry); });
            stage.appendChild(img);
        } else if (['mp4', 'webm', 'mov', 'mkv'].includes(ext)) {
            const video = document.createElement('video');
            video.className = 'ql-media';
            video.controls = true;
            VFS.readFile(entry.path).then((file) => {
                if (!file || !stage.isConnected) return;
                galleryUrl = URL.createObjectURL(file);
                video.src = galleryUrl;
            }).catch(() => {});
            stage.appendChild(video);
        } else if (ext === 'pdf') {
            const frame = document.createElement('iframe');
            frame.className = 'ql-frame';
            VFS.readFile(entry.path).then((file) => {
                if (!file || !stage.isConnected) return;
                galleryUrl = URL.createObjectURL(file);
                frame.src = galleryUrl;
            }).catch(() => {});
            stage.appendChild(frame);
        } else if (['txt', 'md', 'json', 'js', 'ts', 'css', 'html', 'csv', 'xml', 'yml', 'yaml'].includes(ext)) {
            const pre = document.createElement('pre');
            pre.className = 'ql-text';
            VFS.readFile(entry.path).then((file) => file && file.text()).then((text) => {
                if (!stage.isConnected) return;
                const lines = (text || '').split('\n').slice(0, 100).join('\n');
                pre.textContent = lines;
            }).catch(() => { pre.textContent = ''; });
            stage.appendChild(pre);
        } else {
            const wrap = document.createElement('div');
            wrap.className = 'gallery-emptytype';
            const icon = document.createElement('img');
            icon.src = iconFor(entry);
            applyIconFallback(icon, iconFallbackFor(entry));
            const meta = document.createElement('p');
            meta.textContent = `${entry.name}${entry.size != null ? ' · ' + formatSize(entry.size) : ''}`;
            wrap.append(icon, meta);
            stage.appendChild(wrap);
        }

        // 文件名开关（⌘J 查看选项，原版点名）
        if (FinderState.getGalleryNames()) {
            const label = document.createElement('div');
            label.className = 'gallery-name';
            label.textContent = entry.name;
            preview.appendChild(label);
        }

        // 控件（大预览右下角）：左旋 / 右旋（仅图片）+ 更多（显示简介）
        const controls = document.createElement('div');
        controls.className = 'gallery-controls';
        if (isImage(entry.name)) {
            const rotL = document.createElement('button');
            rotL.textContent = '↺';
            rotL.title = i18n.t('finder.rotateLeft', '向左旋转');
            rotL.addEventListener('click', () => onRotateImage?.(entry.path, -90));
            const rotR = document.createElement('button');
            rotR.textContent = '↻';
            rotR.title = i18n.t('finder.rotateRight', '向右旋转');
            rotR.addEventListener('click', () => onRotateImage?.(entry.path, 90));
            controls.append(rotL, rotR);
        }
        const more = document.createElement('button');
        more.textContent = '⋯';
        more.title = i18n.t('finder.showInfo', '显示简介');
        more.addEventListener('click', () => {
            Deskly().ui.showGetInfo([{ path: entry.path, name: entry.name, type: entry.type }]);
        });
        controls.appendChild(more);
        preview.appendChild(controls);

        filmstrip.innerHTML = '';
        allEntries.forEach((e) => {
            const thumb = document.createElement('div');
            thumb.className = 'filmstrip-thumb' + (e.path === entry.path ? ' active' : '');
            buildFilmstripThumb(e, thumb);
            thumb.addEventListener('click', () => showGalleryItem(e, preview, filmstrip, allEntries));
            filmstrip.appendChild(thumb);
        });
    }

    /** 胶片条缩略：图片真图（缓存复用）、视频首帧（preload=metadata）、其余类型图标。 */
    function buildFilmstripThumb(entry, thumbEl) {
        if (isImage(entry.name)) {
            const img = document.createElement('img');
            img.alt = '';
            img.draggable = false;
            if (thumbCache.has(entry.path)) {
                const cached = thumbCache.get(entry.path);
                if (cached) img.src = cached;
                else img.src = iconFor(entry);
            } else {
                img.src = iconFor(entry);
                loadThumb(entry, img);
            }
            thumbEl.appendChild(img);
        } else if (['mp4', 'webm', 'mov', 'mkv'].includes(getExt(entry.name))) {
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.muted = true;
            VFS.readFile(entry.path).then((file) => {
                if (!file || !thumbEl.isConnected) return;
                const url = URL.createObjectURL(file);
                video.src = url;
                video.addEventListener('emptied', () => URL.revokeObjectURL(url), { once: true });
            }).catch(() => {});
            thumbEl.appendChild(video);
        } else {
            const img = document.createElement('img');
            img.src = iconFor(entry);
            img.alt = '';
            img.draggable = false;
            applyIconFallback(img, iconFallbackFor(entry));
            thumbEl.appendChild(img);
        }
    }

    /** 画廊键盘步进（←/→，script.js 调用）。 */
    function galleryStep(delta) {
        const filmstrip = document.getElementById('gallery-filmstrip');
        const preview = document.getElementById('gallery-preview');
        if (!filmstrip || !preview) return;
        const list = rendered;
        if (!list.length) return;
        const sel = FinderState.getState().selectedPaths;
        let idx = list.findIndex((e) => sel.has(e.path));
        if (idx < 0) idx = 0;
        const next = list[((idx + delta) % list.length + list.length) % list.length];
        showGalleryItem(next, preview, filmstrip, list);
    }

    // ---------- 缩略图懒加载 ----------

    /** 图标视图：为图片条目加载真实缩略图（失败回退图标） */
    function lazyLoadThumbs(entries, viewMode) {
        if (viewMode !== 'icon' && viewMode !== 'grid') return;
        if (!listBody) return;
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
     * URL 进缓存复用：重渲染（排序 / 分组 / 搜索每敲一次都会）不再重新读盘、重新建 URL。
     */
    function loadThumb(entry, imgEl) {
        if (thumbCache.has(entry.path)) {
            const cached = thumbCache.get(entry.path);
            if (cached) imgEl.src = cached;
            return;
        }
        VFS.readFile(entry.path).then((file) => {
            if (!file) {
                thumbCache.set(entry.path, null);
                return;
            }
            const url = URL.createObjectURL(file);
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

    /** 旋转落盘后失效该条目的缩略图缓存（F-35：再次进入仍是旋转后的状态）。 */
    function invalidateThumb(path) {
        const url = thumbCache.get(path);
        if (url) { URL.revokeObjectURL(url); thumbCache.delete(path); }
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

    return { init, dispose, getRenderedEntries, indexOfPath, galleryStep, invalidateThumb };
})();

export { FinderViews };
