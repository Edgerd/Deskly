/**
 * finder-state.js — 访达共享状态管理
 *
 * 管理当前路径、历史栈、视图模式、分组方式、标签过滤、选中项、标签页状态等，
 * 提供事件总线供跨模块通信。
 */

const FinderState = (() => {
    /** @type {object} 共享状态 */
    const state = {
        currentPath: '/',
        history: ['/'],
        historyIndex: 0,
        viewMode: 'icon',          // icon | list | column | gallery（macOS 15 默认图标视图）
        groupBy: 'none',           // none | kind | date | size | tag
        tagFilter: null,           // 当前标签过滤色（如 '红色'），null 表示不过滤
        entries: [],               // 当前目录条目缓存
        selectedPaths: new Set(),  // 选中项路径集合
        tabId: 0,                  // 当前标签页 ID
        tabs: [],                  // 标签页列表 [{ id, path, label }]
        searchQuery: '',           // 搜索关键词
        isSearching: false,        // 是否处于搜索模式
        sortBy: 'name',            // name | date | size | kind
        sortAsc: true,             // 排序方向
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
     */
    function on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
    }

    /**
     * 移除事件监听。
     * @param {string} event 事件名
     * @param {Function} fn 回调函数
     */
    function off(event, fn) {
        const fns = listeners.get(event);
        if (fns) {
            const idx = fns.indexOf(fn);
            if (idx >= 0) fns.splice(idx, 1);
        }
    }

    /**
     * 获取当前状态快照。
     * @returns {object}
     */
    function getState() {
        return state;
    }

    /**
     * 设置当前路径。
     * @param {string} path
     */
    function setCurrentPath(path) {
        state.currentPath = path;
        emit('path-changed', path);
    }

    /**
     * 导航到新路径（压入历史栈）。
     * @param {string} path
     */
    function navigate(path) {
        state.history = state.history.slice(0, state.historyIndex + 1);
        state.history.push(path);
        state.historyIndex = state.history.length - 1;
        setCurrentPath(path);
        emit('navigated', { path, canGoBack: canGoBack(), canGoForward: canGoForward() });
    }

    /**
     * 返回上一级。
     * @returns {boolean} 是否成功
     */
    function goBack() {
        if (state.historyIndex > 0) {
            state.historyIndex--;
            setCurrentPath(state.history[state.historyIndex]);
            emit('navigated', { path: state.currentPath, canGoBack: canGoBack(), canGoForward: canGoForward() });
            return true;
        }
        return false;
    }

    /**
     * 前进到下一级。
     * @returns {boolean} 是否成功
     */
    function goForward() {
        if (state.historyIndex < state.history.length - 1) {
            state.historyIndex++;
            setCurrentPath(state.history[state.historyIndex]);
            emit('navigated', { path: state.currentPath, canGoBack: canGoBack(), canGoForward: canGoForward() });
            return true;
        }
        return false;
    }

    /**
     * 跳转到父目录。
     */
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
    function canGoBack() { return state.historyIndex > 0; }

    /** @returns {boolean} */
    function canGoForward() { return state.historyIndex < state.history.length - 1; }

    /** @returns {boolean} */
    function canGoUp() { return state.currentPath !== '/'; }

    /**
     * 设置视图模式。
     * @param {string} mode icon | list | column | gallery
     */
    function setViewMode(mode) {
        state.viewMode = mode;
        emit('view-changed', mode);
    }

    /**
     * 设置分组方式。
     * @param {string} by none | kind | date | size | tag
     */
    function setGroupBy(by) {
        state.groupBy = by;
        emit('group-changed', by);
    }

    /**
     * 设置标签过滤（再次点击同色切换取消）。
     * @param {string|null} color 标签色名，null 表示清除过滤
     */
    function setTagFilter(color) {
        state.tagFilter = state.tagFilter === color ? null : color;
        emit('tags-changed', state.tagFilter);
    }

    /**
     * 设置当前目录条目。
     * @param {Array} entries
     */
    function setEntries(entries) {
        state.entries = entries;
        state.selectedPaths.clear();
        emit('entries-changed', entries);
    }

    /**
     * 切换选中项。
     * @param {string} path
     */
    function toggleSelect(path) {
        if (state.selectedPaths.has(path)) state.selectedPaths.delete(path);
        else state.selectedPaths.add(path);
        emit('selection-changed', state.selectedPaths);
    }

    /**
     * 选中单项（清除其他）。
     * @param {string} path
     */
    function selectSingle(path) {
        state.selectedPaths.clear();
        state.selectedPaths.add(path);
        emit('selection-changed', state.selectedPaths);
    }

    /**
     * 清除所有选中。
     */
    function clearSelection() {
        state.selectedPaths.clear();
        emit('selection-changed', state.selectedPaths);
    }

    /**
     * 设置排序。
     * @param {string} field name | date | size | kind
     * @param {boolean} [asc]
     */
    function setSort(field, asc) {
        if (field === state.sortBy) state.sortAsc = !state.sortAsc;
        else { state.sortBy = field; state.sortAsc = asc ?? true; }
        emit('sort-changed', { field: state.sortBy, asc: state.sortAsc });
    }

    /**
     * 设置搜索状态。
     * @param {string} query
     */
    function setSearch(query) {
        state.searchQuery = query;
        state.isSearching = !!query;
        emit('search-changed', { query, active: state.isSearching });
    }

    /**
     * 重置状态到初始值。
     */
    function reset() {
        state.currentPath = '/';
        state.history = ['/'];
        state.historyIndex = 0;
        state.entries = [];
        state.selectedPaths.clear();
        state.searchQuery = '';
        state.isSearching = false;
        state.groupBy = 'none';
        state.tagFilter = null;
        emit('state-reset');
    }

    return {
        getState, setCurrentPath, navigate, goBack, goForward, goUp,
        canGoBack, canGoForward, canGoUp, parentPath,
        setViewMode, setGroupBy, setTagFilter,
        setEntries, toggleSelect, selectSingle, clearSelection,
        setSort, setSearch, reset,
        on, off, emit,
    };
})();

export { FinderState };
