/**
 * finder-layout.js — 访达布局管理
 *
 * 管理侧边栏宽度拖拽、标签栏显隐、布局尺寸记忆。
 * 注：路径栏 / 状态栏自 0.2.22 起已从 DOM 中移除，相关 toggle 方法保留为 no-op 以兼容旧调用方。
 */

import { FinderState } from './finder-state.js';

const STORAGE_KEY = 'webstartos_finder_layout';

const FinderLayout = (() => {
    /** @type {object} 布局配置 */
    let config = {
        sidebarWidth: 200,
        // 历史字段保留（仅用于读取 localStorage 的旧数据），不再写入或使用
        pathBarVisible: false,
        statusBarVisible: false,
        tabBarVisible: false,     // 标签栏默认隐藏（仅多标签时浮现）
    };

    let sidebar = null, splitter = null, tabsBar = null;
    let dragging = false;

    /**
     * 初始化布局管理器。
     * @param {HTMLElement} finderEl Finder 窗口根元素
     */
    function init(finderEl) {
        sidebar = finderEl.querySelector('.finder-sidebar');
        splitter = finderEl.querySelector('.finder-splitter');
        tabsBar = finderEl.querySelector('.finder-tabs-bar');

        loadConfig();
        applyConfig();
        bindSplitter();
    }

    /**
     * 从 localStorage 加载配置。
     */
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

    /**
     * 保存配置到 localStorage。
     */
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

    /**
     * 应用配置到 DOM。
     */
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

    /**
     * 绑定分割线拖拽事件。
     */
    function bindSplitter() {
        if (!splitter || !sidebar) return;

        splitter.addEventListener('mousedown', (e) => {
            dragging = true;
            splitter.classList.add('active');
            e.preventDefault();
        });

        const onSplitterMove = (e) => {
            if (!dragging || !sidebar || !splitter) return;
            const finderBody = sidebar.closest('.finder-body');
            if (!finderBody) return;
            const rect = finderBody.getBoundingClientRect();
            let newWidth = e.clientX - rect.left;
            newWidth = Math.max(120, Math.min(400, newWidth));
            sidebar.style.width = newWidth + 'px';
            config.sidebarWidth = newWidth;
        };

        const onSplitterUp = () => {
            if (dragging) {
                dragging = false;
                if (splitter) splitter.classList.remove('active');
                saveConfig();
            }
        };

        document.addEventListener('mousemove', onSplitterMove);
        document.addEventListener('mouseup', onSplitterUp);

        // 资源释放：访达窗口关闭时移除本模块注册的全局监听，避免常驻内存
        const onLayoutUnload = (e) => {
            if (e.detail.id !== 'finder') return;
            window.removeEventListener('plugin-unload', onLayoutUnload);
            document.removeEventListener('mousemove', onSplitterMove);
            document.removeEventListener('mouseup', onSplitterUp);
        };
        window.addEventListener('plugin-unload', onLayoutUnload);
    }

    /**
     * 切换路径栏显隐。0.2.22 起路径栏已移除，保留为 no-op 以兼容旧调用方（菜单项已下线）。
     * @param {boolean} [visible] 不传则切换
     */
    function togglePathBar(_visible) {
        // no-op：路径栏已从 DOM 移除
    }

    /**
     * 切换状态栏显隐。0.2.22 起状态栏已移除，保留为 no-op 以兼容旧调用方（菜单项已下线）。
     * @param {boolean} [visible]
     */
    function toggleStatusBar(_visible) {
        // no-op：状态栏已从 DOM 移除
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

    /** @returns {object} */
    function getConfig() { return { ...config }; }

    return {
        init, togglePathBar, toggleStatusBar, toggleTabBar, refreshTabBar, getConfig,
    };
})();

export { FinderLayout };
