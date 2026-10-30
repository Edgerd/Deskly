/**
 * finder-sidebar.js — 访达侧边栏管理（macOS 15 还原）
 *
 * 侧边栏分区（个人收藏 / 位置 / 标签）为静态结构，
 * 本模块仅负责：分区内「快速访问项」点击导航、按当前路径高亮。
 * 标签分区由 FinderTags 动态渲染；重新授权改由「更多」菜单触发（见 finder-actions）。
 */

import { FinderState } from './finder-state.js';

const FinderSidebar = (() => {
    let sidebarRoot = null, onNavigate = null;

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

    /**
     * 初始化侧边栏。
     * @param {object} options
     * @param {Function} [options.navigate] 导航回调
     */
    function init(options = {}) {
        // 常驻单例：重开窗口先撤销上一次的订阅
        dispose();

        onNavigate = options.navigate || null;
        sidebarRoot = document.querySelector('.finder-sidebar');

        const onClick = (e) => {
            const item = e.target.closest('.sidebar-item[data-path]');
            if (item) onNavigate?.(item.dataset.path);
        };
        sidebarRoot?.addEventListener('click', onClick);
        track(() => sidebarRoot?.removeEventListener('click', onClick));

        track(FinderState.on('path-changed', updateHighlight));
        // 打开时的高亮：path-changed 只在路径真正变化时广播，初始态需显式同步一次
        updateHighlight(FinderState.getState().currentPath);
    }

    /**
     * 更新侧边栏高亮项（前缀匹配当前路径）。
     * @param {string} currentPath
     */
    function updateHighlight(currentPath) {
        if (!sidebarRoot || !currentPath) return;
        sidebarRoot.querySelectorAll('.sidebar-item[data-path]').forEach(item => {
            const p = item.dataset.path;
            item.classList.toggle('active', p !== '/' && (currentPath === p || currentPath.startsWith(p + '/')));
        });
    }

    return { init, dispose };
})();

export { FinderSidebar };
