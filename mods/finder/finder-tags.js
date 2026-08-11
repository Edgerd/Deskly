/**
 * finder-tags.js — 访达标签管理（macOS 15 七色标签）
 *
 * - 侧边栏「标签」分区：七色圆点，点击按颜色过滤当前目录。
 * - 标记弹层：对选中条目切换七色标签，localStorage 持久化。
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

    /** 读取标签映射 { path: ["红色", ...] } */
    function loadMap() {
        try {
            return JSON.parse(localStorage.getItem(KEY)) || {};
        } catch (e) {
            return {};
        }
    }

    /** 持久化 */
    function saveMap(map) {
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
        return loadMap()[path] || [];
    }

    /**
     * 切换某路径的单个标签色。
     * @param {string} path
     * @param {string} color 色名
     */
    function toggleTag(path, color) {
        const map = loadMap();
        const arr = map[path] || [];
        const idx = arr.indexOf(color);
        idx >= 0 ? arr.splice(idx, 1) : arr.push(color);
        if (arr.length) map[path] = arr;
        else delete map[path];
        saveMap(map);
        FinderState.emit('tags-changed', FinderState.getState().tagFilter);
    }

    /** 渲染侧边栏标签列表 */
    function renderTags() {
        if (!sidebarContainer) return;
        sidebarContainer.innerHTML = '';
        const current = FinderState.getState().tagFilter;
        TAG_COLORS.forEach((tag) => {
            const el = document.createElement('div');
            el.className = 'sidebar-tag' + (current === tag.name ? ' active' : '');
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
        sidebarContainer = document.getElementById('finder-tags-sidebar');
        renderTags();
        FinderState.on('tags-changed', renderTags);
        FinderState.on('path-changed', renderTags);
    }

    return { init, renderTags, renderTagPop, getTags, toggleTag, TAG_COLORS };
})();

export { FinderTags };
