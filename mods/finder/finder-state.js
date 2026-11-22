/**
 * finder-state.js — 访达共享状态：标签页列表、当前路径、条目缓存、选中项、搜索词与事件总线。
 * 导航历史与视图选项（视图模式 / 分组 / 排序 / 标签过滤）按标签页独立存放在标签页对象上，避免 ⌘[ 回退到另一个标签页的路径。
 * 常驻单例（仅入口脚本每次开窗重新执行）：每次开窗必须先 reset()，否则残留上次的条目 / 选中 / 搜索词。
 */

import { i18n } from '../../src/javascripts/i18n.js';

/** 新建标签页在无历史标签可继承时使用的默认视图选项 */
const DEFAULT_VIEW = {
    viewMode: 'icon',          // icon | list | column | gallery（macOS 15 默认图标视图）
    groupBy: 'none',           // none | kind | date | size | tag
    tagFilter: null,           // 当前标签过滤色（如 '红色'），null 表示不过滤
    sortBy: 'name',            // name | date | size | kind
    sortAsc: true,             // 排序方向
    galleryNames: true,        // 画廊视图显示文件名（⌘J 查看选项，原版点名）
};

const FinderState = (() => {
    /** @type {object} 跨标签页唯一的全局状态 */
    const state = {
        currentPath: '/',
        entries: [],               // 当前目录条目缓存
        selectedPaths: new Set(),  // 选中项路径集合
        anchorPath: null,          // Shift 连选锚点
        searchQuery: '',           // 搜索关键词
        searchResults: null,       // 递归搜索结果集（F-36）：null = 未启用，数组 = 优先渲染
        error: null,               // 最近一次目录读取失败的可见提示（null 表示无错误）
        tabs: [],                  // 标签页列表 [{ id, path, history, historyIndex, 视图选项 }]
        activeTabId: null,         // 当前激活标签页 ID
        tabSeq: 0,                 // 标签页 ID 自增序列
    };

    /** @type {Map<string, Function[]>} 事件监听器 */
    const listeners = new Map();

    /**
     * 触发事件。
     * @param {string} event 事件名
     * @param {*} [data] 事件数据
     */
    function emit(event, data) {
        listeners.get(event)?.forEach(fn => fn(data));
    }

    /**
     * 注册事件监听。
     * @param {string} event 事件名
     * @param {Function} fn 回调函数
     * @returns {Function} 取消订阅函数（可重复调用）
     */
    function on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
        return () => off(event, fn);
    }

    /**
     * 移除事件监听。
     * @param {string} event 事件名
     * @param {Function} fn 回调函数
     */
    function off(event, fn) {
        const fns = listeners.get(event);
        if (!fns) return;
        const idx = fns.indexOf(fn);
        if (idx >= 0) fns.splice(idx, 1);
    }

    /**
     * 获取全局状态快照（不含每个标签页独立的历史与视图选项）。
     * @returns {object}
     */
    function getState() {
        return state;
    }

    /** @returns {object|null} 当前激活标签页 */
    function activeTab() {
        return state.tabs.find(t => t.id === state.activeTabId) || null;
    }

    /** 视图选项的读取源：激活标签页，无标签页时回退默认值（只读，不承接写入） */
    function viewOf() {
        return activeTab() || DEFAULT_VIEW;
    }

    /**
     * 路径 → 显示名（根目录用应用名）。路径转标题的唯一实现，勿再各自硬编码。
     * @param {string} path
     * @returns {string}
     */
    function pathLabel(path) {
        if (!path || path === '/') return i18n.t('finder.title', '访达');
        return path.split('/').filter(Boolean).pop() || i18n.t('finder.title', '访达');
    }

    // ---------- 标签页 ----------

    /**
     * 新建标签页（视图选项继承当前标签页，与 macOS 一致）。
     * @param {string} path
     * @returns {number} 新标签 ID
     */
    function addTab(path) {
        const base = viewOf();
        const tab = {
            id: ++state.tabSeq,
            path,
            history: [path],
            historyIndex: 0,
            viewMode: base.viewMode,
            groupBy: base.groupBy,
            tagFilter: base.tagFilter,
            sortBy: base.sortBy,
            sortAsc: base.sortAsc,
            galleryNames: base.galleryNames,
        };
        state.tabs.push(tab);
        emit('tab-changed', state.tabs);
        return tab.id;
    }

    /**
     * 激活指定标签页（不触发导航，调用方按 tab.path 自行导航）。
     * @param {number} tabId
     * @returns {object|null} 激活的标签页
     */
    function setActiveTab(tabId) {
        const tab = state.tabs.find(t => t.id === tabId);
        if (!tab) return null;
        state.activeTabId = tabId;
        emit('tab-changed', state.tabs);
        return tab;
    }

    /**
     * 关闭标签页（至少保留一个）。
     * @param {number} tabId
     * @returns {object|null} 仅当关闭的是激活标签时返回需要导航到的相邻标签
     */
    function closeTab(tabId) {
        if (state.tabs.length <= 1) return null;
        const idx = state.tabs.findIndex(t => t.id === tabId);
        if (idx === -1) return null;
        const wasActive = state.activeTabId === tabId;
        state.tabs.splice(idx, 1);
        if (!wasActive) {
            emit('tab-changed', state.tabs);
            return null;
        }
        const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
        state.activeTabId = next ? next.id : null;
        emit('tab-changed', state.tabs);
        return next || null;
    }

    /**
     * 恢复持久化的标签页（F-43）：用路径数组整表重建（每页历史从落点重新开始）。
     * @param {string[]} paths
     * @param {number} [activeIdx] 恢复后激活的序号
     * @returns {string|null} 激活标签的路径（调用方导航过去）
     */
    function restoreTabs(paths, activeIdx = 0) {
        state.tabs = [];
        state.tabSeq = 0;
        (paths && paths.length ? paths : ['/']).forEach((p) => {
            const base = viewOf();
            state.tabs.push({
                id: ++state.tabSeq,
                path: p,
                history: [p],
                historyIndex: 0,
                viewMode: base.viewMode,
                groupBy: base.groupBy,
                tagFilter: base.tagFilter,
                sortBy: base.sortBy,
                sortAsc: base.sortAsc,
                galleryNames: base.galleryNames,
            });
        });
        const idx = Math.min(Math.max(activeIdx, 0), state.tabs.length - 1);
        state.activeTabId = state.tabs[idx].id;
        emit('tab-changed', state.tabs);
        return state.tabs[idx].path;
    }

    /**
     * 拖动重排标签页（F-43）：把 fromId 挪到 toIndex 位置（其余相对顺序不变）。
     * @param {number} fromId
     * @param {number} toIndex
     */
    function reorderTabs(fromId, toIndex) {
        const from = state.tabs.findIndex(t => t.id === fromId);
        if (from === -1) return false;
        const clamped = Math.min(Math.max(toIndex, 0), state.tabs.length - 1);
        if (clamped === from) return false;
        const [tab] = state.tabs.splice(from, 1);
        state.tabs.splice(clamped, 0, tab);
        emit('tab-changed', state.tabs);
        return true;
    }

    // ---------- 路径与历史 ----------

    /**
     * 设置当前路径（同路径不重复广播，避免一次导航触发两次重渲染）。
     * @param {string} path
     */
    function setCurrentPath(path) {
        if (state.currentPath === path) return;
        state.currentPath = path;
        emit('path-changed', path);
    }

    /** 把当前路径写回激活标签页，并通知标签栏刷新标题。 */
    function syncActiveTab(path) {
        const tab = activeTab();
        if (!tab) return;
        tab.path = path;
        emit('tab-changed', state.tabs);
    }

    /** 广播导航态（前进/后退可用性）。 */
    function emitNavigated(path) {
        emit('navigated', { path, canGoBack: canGoBack(), canGoForward: canGoForward() });
    }

    /**
     * 导航到新路径（压入当前标签页的历史栈；连续相同路径不入栈）。
     * @param {string} path
     */
    function navigate(path) {
        const tab = activeTab();
        if (tab && tab.history[tab.historyIndex] !== path) {
            tab.history = tab.history.slice(0, tab.historyIndex + 1);
            tab.history.push(path);
            tab.historyIndex = tab.history.length - 1;
        }
        setCurrentPath(path);
        syncActiveTab(path);
        emitNavigated(path);
    }

    /**
     * 历史栈移动到指定位置后广播（goBack / goForward 共用）。
     * @param {object} tab
     * @returns {boolean} 恒为 true（调用方已校验边界）
     */
    function applyHistory(tab) {
        const path = tab.history[tab.historyIndex];
        setCurrentPath(path);
        syncActiveTab(path);
        emitNavigated(path);
        return true;
    }

    /**
     * 返回上一级（当前标签页历史）。
     * @returns {boolean} 是否成功
     */
    function goBack() {
        const tab = activeTab();
        if (!tab || tab.historyIndex <= 0) return false;
        tab.historyIndex--;
        return applyHistory(tab);
    }

    /**
     * 前进到下一级（当前标签页历史）。
     * @returns {boolean} 是否成功
     */
    function goForward() {
        const tab = activeTab();
        if (!tab || tab.historyIndex >= tab.history.length - 1) return false;
        tab.historyIndex++;
        return applyHistory(tab);
    }

    /** 跳转到父目录。 */
    function goUp() {
        const parent = parentPath(state.currentPath);
        if (parent !== state.currentPath) navigate(parent);
    }

    /**
     * 计算父目录路径。
     * @param {string} path
     * @returns {string}
     */
    function parentPath(path) {
        if (!path || path === '/') return '/';
        const idx = path.lastIndexOf('/');
        return idx <= 0 ? '/' : path.slice(0, idx);
    }

    /** @returns {boolean} */
    function canGoBack() {
        const tab = activeTab();
        return !!tab && tab.historyIndex > 0;
    }

    /** @returns {boolean} */
    function canGoForward() {
        const tab = activeTab();
        return !!tab && tab.historyIndex < tab.history.length - 1;
    }

    // ---------- 视图选项（每标签页独立） ----------

    /**
     * 设置视图模式。
     * @param {string} mode icon | list | column | gallery
     */
    function setViewMode(mode) {
        const tab = activeTab();
        if (tab) tab.viewMode = mode;
        emit('view-changed', mode);
    }

    /** @returns {string} 当前标签页视图模式 */
    function getViewMode() { return viewOf().viewMode; }

    /**
     * 设置分组方式。
     * @param {string} by none | kind | date | size | tag
     */
    function setGroupBy(by) {
        const tab = activeTab();
        if (tab) tab.groupBy = by;
        emit('group-changed', by);
    }

    /** @returns {string} 当前标签页分组方式 */
    function getGroupBy() { return viewOf().groupBy; }

    /**
     * 设置标签过滤（再次点击同色切换取消）。
     * @param {string|null} color 标签色名，null 表示清除过滤
     */
    function setTagFilter(color) {
        const tab = activeTab();
        const current = viewOf().tagFilter;
        const next = current === color ? null : color;
        if (tab) tab.tagFilter = next;
        emit('tags-changed', next);
    }

    /** @returns {string|null} 当前标签页标签过滤 */
    function getTagFilter() { return viewOf().tagFilter; }

    /**
     * 设置排序。
     * @param {string} field name | date | size | kind
     * @param {boolean} [asc]
     */
    function setSort(field, asc) {
        const tab = activeTab();
        const view = viewOf();
        const sortAsc = view.sortBy === field ? !view.sortAsc : (asc ?? true);
        if (tab) { tab.sortBy = field; tab.sortAsc = sortAsc; }
        emit('sort-changed', { field, asc: sortAsc });
    }

    /** @returns {{field: string, asc: boolean}} 当前标签页排序 */
    function getSort() {
        const view = viewOf();
        return { field: view.sortBy, asc: view.sortAsc };
    }

    // ---------- 条目与选中 ----------

    /**
     * 设置当前目录条目。
     * @param {Array} entries
     * @param {string} [error] 读取失败提示；为空表示本次读取成功
     */
    function setEntries(entries, error) {
        state.entries = entries || [];
        state.error = error || null;
        state.selectedPaths.clear();
        state.anchorPath = null;
        emit('entries-changed', state.entries);
    }

    /**
     * 选中单项（清除其他）。
     * @param {string} path
     */
    function selectSingle(path) {
        state.selectedPaths.clear();
        state.selectedPaths.add(path);
        state.anchorPath = path;
        emit('selection-changed', state.selectedPaths);
    }

    /** 清除所有选中。 */
    function clearSelection() {
        if (!state.selectedPaths.size) return;
        state.selectedPaths.clear();
        state.anchorPath = null;
        emit('selection-changed', state.selectedPaths);
    }

    /** Command/Ctrl 点选：切换单项，锚点落到该项。 */
    function toggleSelect(path) {
        if (state.selectedPaths.has(path)) state.selectedPaths.delete(path);
        else state.selectedPaths.add(path);
        state.anchorPath = path;
        emit('selection-changed', state.selectedPaths);
    }

    /** Shift 连选：anchor → path 的可见顺序区间（ordered 为当前渲染序列）。 */
    function selectRange(path, ordered) {
        const from = state.anchorPath || path;
        const a = ordered.findIndex((e) => e.path === from);
        const b = ordered.findIndex((e) => e.path === path);
        if (a < 0 || b < 0) { selectSingle(path); return; }
        const [lo, hi] = a < b ? [a, b] : [b, a];
        state.selectedPaths.clear();
        ordered.slice(lo, hi + 1).forEach((e) => state.selectedPaths.add(e.path));
        emit('selection-changed', state.selectedPaths);
    }

    /** 整组替换选中集（框选 / 全选 / 键盘扩选共用）。 */
    function setSelection(paths, anchor) {
        state.selectedPaths.clear();
        (paths || []).forEach((p) => state.selectedPaths.add(p));
        if (anchor !== undefined) state.anchorPath = anchor;
        emit('selection-changed', state.selectedPaths);
    }

    /** 全选给定路径集合。 */
    function selectAll(paths) {
        setSelection(paths, paths && paths.length ? paths[0] : null);
    }

    /** 画廊「显示文件名」开关（按标签页记忆）。 */
    function setGalleryNames(on) {
        const tab = activeTab();
        if (tab) tab.galleryNames = Boolean(on);
        emit('view-changed', getViewMode());
    }
    function getGalleryNames() { return viewOf().galleryNames !== false; }

    /**
     * 设置搜索关键词。
     * @param {string} query
     */
    function setSearch(query) {
        state.searchQuery = query;
        emit('search-changed', { query });
    }

    /**
     * 写入递归搜索结果集（F-36）：views 在 searchQuery 非空时优先渲染这份列表。
     * @param {Array|null} results null = 清空（回落到当前目录过滤）
     */
    function setSearchResults(results) {
        state.searchResults = Array.isArray(results) ? results : null;
        emit('search-results-changed', state.searchResults);
    }

    /**
     * 复位上一次开窗会话的易变状态（入口脚本每次 init 时调用）。
     * 标签页列表在同一页面会话内保留（保留用户的多标签浏览状态），
     * 路径归位到「上次激活标签」，使重开窗口不再把标签路径覆盖成根目录。
     */
    function reset() {
        state.entries = [];
        state.selectedPaths.clear();
        state.searchQuery = '';
        state.searchResults = null;
        state.error = null;
        if (!state.tabs.length) addTab('/');
        if (!activeTab()) state.activeTabId = state.tabs[state.tabs.length - 1].id;
        state.currentPath = activeTab().path;
        emit('state-reset', state.currentPath);
    }

    return {
        getState, pathLabel,
        addTab, setActiveTab, closeTab, restoreTabs, reorderTabs,
        setCurrentPath, navigate, goBack, goForward, goUp,
        canGoBack, canGoForward, parentPath,
        setViewMode, getViewMode, setGroupBy, getGroupBy,
        setTagFilter, getTagFilter, setSort, getSort,
        setEntries, selectSingle, clearSelection, setSearch, reset,
        toggleSelect, selectRange, setSelection, selectAll,
        setGalleryNames, getGalleryNames,
        setSearchResults,
        on, off, emit,
    };
})();

export { FinderState };
