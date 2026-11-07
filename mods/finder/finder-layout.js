/**
 * finder-layout.js — 侧边栏宽度拖拽、标签栏显隐、布局尺寸记忆。
 * 常驻单例：init() 先撤销上次注册的监听，窗口关闭时由入口脚本（script.js）的 plugin-unload 回调调 dispose()。
 */

import { FinderState } from './finder-state.js';

const STORAGE_KEY = 'webstartos_finder_layout';

const FinderLayout = (() => {
    /** @type {object} 布局配置 */
    let config = {
        sidebarWidth: 200,
        tabBarVisible: false,     // 标签栏默认隐藏（仅多标签时浮现）
    };

    let sidebar = null, splitter = null, tabsBar = null;
    let dragging = false;

    /** @type {Function[]} 资源释放回调 */
    let disposers = [];

    /** 登记一个释放回调。 */
    function track(fn) { disposers.push(fn); }

    /** 执行并清空全部释放回调（可重复调用）。 */
    function dispose() {
        const list = disposers;
        disposers = [];
        list.forEach(fn => fn());
        dragging = false;
    }

    /**
     * 初始化布局管理器。
     * @param {HTMLElement} finderEl Finder 窗口根元素
     */
    function init(finderEl) {
        dispose();

        sidebar = finderEl.querySelector('.finder-sidebar');
        splitter = finderEl.querySelector('.finder-splitter');
        tabsBar = finderEl.querySelector('.finder-tabs-bar');

        loadConfig();
        applyConfig();
        bindSplitter();
    }

    function loadConfig() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) {
                const parsed = JSON.parse(saved);
                // 旧版本可能缺字段，逐字段合并并兜底
                config.sidebarWidth = typeof parsed.sidebarWidth === 'number' ? parsed.sidebarWidth : 200;
                config.tabBarVisible = !!parsed.tabBarVisible;
            }
        } catch (e) { /* 忽略损坏数据 */ }
    }

    function saveConfig() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                sidebarWidth: config.sidebarWidth,
                tabBarVisible: config.tabBarVisible,
            }));
        } catch (e) {
            // 忽略
        }
    }

    function applyConfig() {
        if (sidebar) sidebar.style.width = config.sidebarWidth + 'px';
        applyTabBar();
    }

    /**
     * 根据配置与标签页数量决定标签栏显隐。
     * 规则：显式开启 OR 标签页 > 1。
     */
    function applyTabBar() {
        if (!tabsBar) return;
        const tabs = FinderState.getState().tabs;
        tabsBar.classList.toggle('visible', !!(config.tabBarVisible || (tabs && tabs.length > 1)));
    }

    function bindSplitter() {
        if (!splitter || !sidebar) return;

        const onDown = (e) => {
            dragging = true;
            splitter.classList.add('active');
            e.preventDefault();
            // window.js 的窗口拖拽监听在窗口元素上冒泡，不阻断会连带拖动整个窗口
            e.stopPropagation();
        };
        splitter.addEventListener('mousedown', onDown);

        const onMove = (e) => {
            if (!dragging || !sidebar || !splitter) return;
            const finderBody = sidebar.closest('.finder-body');
            if (!finderBody) return;
            const rect = finderBody.getBoundingClientRect();
            let newWidth = e.clientX - rect.left;
            newWidth = Math.max(120, Math.min(400, newWidth));
            sidebar.style.width = newWidth + 'px';
            config.sidebarWidth = newWidth;
        };

        const onUp = () => {
            if (dragging) {
                dragging = false;
                if (splitter) splitter.classList.remove('active');
                saveConfig();
            }
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);

        track(() => splitter.removeEventListener('mousedown', onDown));
        track(() => document.removeEventListener('mousemove', onMove));
        track(() => document.removeEventListener('mouseup', onUp));
    }

    /**
     * 切换标签栏显隐（经「显示」菜单）。
     * @param {boolean} [visible]
     */
    function toggleTabBar(visible) {
        config.tabBarVisible = visible ?? !config.tabBarVisible;
        saveConfig();
        applyTabBar();
        FinderState.emit('layout-changed', { tabBar: config.tabBarVisible });
    }

    /** 供标签页模块在数量变化时刷新标签栏显隐 */
    function refreshTabBar() {
        applyTabBar();
    }

    return {
        init, toggleTabBar, refreshTabBar, dispose,
    };
})();

export { FinderLayout };
