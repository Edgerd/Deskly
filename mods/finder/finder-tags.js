/**
 * finder-tags.js — 访达标签管理（macOS 15 七色标签）
 *
 * - 侧边栏「标签」分区：七色圆点，点击按颜色过滤当前目录。
 * - 标记弹层：对选中条目切换七色标签，localStorage 持久化。
 *
 * 标签以路径为键存放在插件私有 localStorage（VFS 无标注能力，见改造需求说明）。
 * 读取走内存缓存：一次渲染会逐条目取标签，若每次都 getItem + JSON.parse，
 * 500 个文件的目录里按一次键就要解析上千次。写操作后立即失效缓存。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { FinderState } from './finder-state.js';

const TAG_COLORS = [
    { name: '红色', hex: '#ff3b30' },
    { name: '橙色', hex: '#ff9500' },
    { name: '黄色', hex: '#ffcc00' },
    { name: '绿色', hex: '#34c759' },
    { name: '蓝色', hex: '#007aff' },
    { name: '紫色', hex: '#af52de' },
    { name: '灰色', hex: '#8e8e93' },
];

const FinderTags = (() => {
    const KEY = 'webstartos_finder_tags';
    const COLOR_KEY_MAP = { '红色': 'red', '橙色': 'orange', '黄色': 'yellow', '绿色': 'green', '蓝色': 'blue', '紫色': 'purple', '灰色': 'gray' };
    let sidebarContainer = null;

    /** @type {object|null} 标签映射内存缓存（null 表示需重新解析） */
    let mapCache = null;

    /** @type {Function[]} 资源释放回调（重开窗口 / plugin-unload 时执行） */
    let disposers = [];

    /** 登记一个释放回调。 */
    function track(fn) { disposers.push(fn); }

    /** 执行并清空全部释放回调（可重复调用）。 */
    function dispose() {
        const list = disposers;
        disposers = [];
        list.forEach(fn => fn());
    }

    /** 读取标签映射 { path: ["红色", ...] }，命中缓存时不重复解析 JSON。 */
    function loadMap() {
        if (mapCache) return mapCache;
        try {
            mapCache = JSON.parse(localStorage.getItem(KEY)) || {};
        } catch (e) {
            mapCache = {};
        }
        return mapCache;
    }

    /** 持久化并刷新缓存 */
    function saveMap(map) {
        mapCache = map;
        try {
            localStorage.setItem(KEY, JSON.stringify(map));
        } catch (e) { /* ignore */ }
    }

    /**
     * 取某路径的标签色名数组。
     * @param {string} path
     * @returns {string[]}
     */
    function getTags(path) {
        if (!path) return [];
        return loadMap()[path] || [];
    }

    /**
     * 切换某路径的单个标签色。
     * @param {string} path
     * @param {string} color 色名
     */
    function toggleTag(path, color) {
        if (!path) return;
        const map = loadMap();
        const arr = map[path] || [];
        const idx = arr.indexOf(color);
        idx >= 0 ? arr.splice(idx, 1) : arr.push(color);
        if (arr.length) map[path] = arr;
        else delete map[path];
        saveMap(map);
        FinderState.emit('tags-changed', FinderState.getTagFilter());
    }

    /**
     * 清除某路径的全部标签（条目删除后调用，避免映射里残留永不显示的孤儿键）。
     * @param {string} path
     */
    function clearTagsForPath(path) {
        if (!path) return;
        const map = loadMap();
        if (!(path in map)) return;
        delete map[path];
        saveMap(map);
        FinderState.emit('tags-changed', FinderState.getTagFilter());
    }

    /** 渲染侧边栏标签列表 */
    function renderTags() {
        if (!sidebarContainer) return;
        sidebarContainer.innerHTML = '';
        const current = FinderState.getTagFilter();
        TAG_COLORS.forEach((tag) => {
            const el = document.createElement('div');
            // finder-no-drag：标签行是点击控件，不该连带拖动窗口
            el.className = 'sidebar-tag finder-no-drag' + (current === tag.name ? ' active' : '');
            el.dataset.tag = tag.name;

            const dot = document.createElement('span');
            dot.className = 'tag-dot';
            dot.style.background = tag.hex;
            el.appendChild(dot);

            const label = document.createElement('span');
            label.className = 'item-label';
            label.textContent = i18n.t('finder.tags.' + colorKey(tag.name), tag.name);
            el.appendChild(label);

            el.addEventListener('click', () => {
                FinderState.setTagFilter(tag.name);
            });
            sidebarContainer.appendChild(el);
        });
    }

    /** 渲染标记弹层（按当前选中条目显示勾选态） */
    function renderTagPop(container) {
        if (!container) return;
        container.innerHTML = '';
        const sel = [...FinderState.getState().selectedPaths];
        // 以首个选中条目的标签为基准显示勾选
        const baseTags = sel.length ? getTags(sel[0]) : [];

        TAG_COLORS.forEach((tag) => {
            const row = document.createElement('div');
            row.className = 'pop-item tag-pop-row' + (baseTags.includes(tag.name) ? ' active' : '');
            row.dataset.color = tag.name;

            const dot = document.createElement('span');
            dot.className = 'tag-dot';
            dot.style.background = tag.hex;
            row.appendChild(dot);

            const name = document.createElement('span');
            name.textContent = i18n.t('finder.tags.' + colorKey(tag.name), tag.name);
            row.appendChild(name);

            const check = document.createElement('span');
            check.className = 'pop-check';
            check.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20"><path d="M4 10l4 4 8-8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            row.appendChild(check);

            row.addEventListener('click', () => {
                if (!sel.length) {
                    // 无选中项时直接对当前文件夹打标签（用于过滤演示）
                    toggleTag(FinderState.getState().currentPath, tag.name);
                    renderTagPop(container);
                    return;
                }
                sel.forEach((p) => toggleTag(p, tag.name));
                renderTagPop(container);
                FinderState.emit('entries-changed', FinderState.getState().entries);
            });
            container.appendChild(row);
        });
    }

    /** 色名 → i18n 键后缀 */
    function colorKey(name) {
        return COLOR_KEY_MAP[name] || name;
    }

    /**
     * 初始化。
     */
    function init() {
        dispose();
        // 常驻单例：重开窗口时丢弃上一次缓存，读取磁盘上的最新映射
        mapCache = null;
        sidebarContainer = document.getElementById('finder-tags-sidebar');
        renderTags();
        track(FinderState.on('tags-changed', renderTags));
        track(FinderState.on('locale-changed', renderTags));
    }

    return { init, dispose, renderTagPop, getTags, toggleTag, clearTagsForPath, TAG_COLORS };
})();

export { FinderTags };
