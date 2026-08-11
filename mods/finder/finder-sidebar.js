/**
 * finder-sidebar.js — 访达侧边栏管理（macOS 15 还原）
 *
 * 侧边栏四个分区（个人收藏 / iCloud / 位置 / 标签）均为静态结构，
 * 本模块仅负责：分区内「快速访问项」点击导航、按当前路径高亮。
 * 标签分区由 FinderTags 动态渲染；重新授权改由「更多」菜单触发（见 finder-actions）。
 */

import { FinderState } from './finder-state.js';

const FinderSidebar = (() => {
    let sidebarRoot = null, onNavigate = null;

    /**
     * 初始化侧边栏。
     * @param {object} options
     * @param {Function} [options.navigate] 导航回调
     */
    function init(options = {}) {
        onNavigate = options.navigate || null;
        sidebarRoot = document.querySelector('.finder-sidebar');
        sidebarRoot?.addEventListener('click', (e) => {
            const item = e.target.closest('.sidebar-item[data-path]');
            if (item) onNavigate?.(item.dataset.path);
        });

        FinderState.on('path-changed', (p) => updateHighlight(p));
        FinderState.on('navigated', () => updateHighlight(FinderState.getState().currentPath));
    }

    /**
     * 更新侧边栏高亮项（前缀匹配当前路径）。
     * @param {string} currentPath
     */
    function updateHighlight(currentPath) {
        if (!sidebarRoot) return;
        sidebarRoot.querySelectorAll('.sidebar-item[data-path]').forEach(item => {
            const p = item.dataset.path;
            item.classList.toggle('active', p !== '/' && (currentPath === p || currentPath.startsWith(p + '/')));
        });
    }

    return { init, updateHighlight };
})();

export { FinderSidebar };
