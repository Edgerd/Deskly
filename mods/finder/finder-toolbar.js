/**
 * finder-toolbar.js — 合并标题栏：绑定前进/后退与四个视图按钮，同步导航禁用态、视图高亮与居中标题。
 */

import { FinderState } from './finder-state.js';

const FinderToolbar = (() => {
    let navBack = null, navForward = null, viewBtns = null, titleEl = null;
    let onGoBack = null, onGoForward = null;

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
     * 初始化标题栏。
     * @param {object} options
     * @param {Function} [options.goBack]
     * @param {Function} [options.goForward]
     */
    function init(options = {}) {
        // 本模块为常驻单例：重开窗口时先撤销上一次注册的订阅，避免监听无限累积
        dispose();

        navBack = document.getElementById('nav-back');
        navForward = document.getElementById('nav-forward');
        viewBtns = document.querySelectorAll('.view-btn');
        titleEl = document.getElementById('finder-title');

        onGoBack = options.goBack || null;
        onGoForward = options.goForward || null;

        bindEvents();

        // 后退/前进可用性只随 navigated 变化；标题只随 path-changed 变化（一次导航各更新一次）
        track(FinderState.on('navigated', (data) => updateNavButtons(data.canGoBack, data.canGoForward)));
        track(FinderState.on('path-changed', updateTitle));
        track(FinderState.on('view-changed', updateViewButtons));
        track(FinderState.on('locale-changed', () => updateTitle(FinderState.getState().currentPath)));
    }

    function bindEvents() {
        const onBack = () => onGoBack?.();
        const onForward = () => onGoForward?.();
        navBack?.addEventListener('click', onBack);
        navForward?.addEventListener('click', onForward);
        track(() => {
            navBack?.removeEventListener('click', onBack);
            navForward?.removeEventListener('click', onForward);
        });

        const onViewClick = (e) => {
            const btn = e.target.closest('.view-btn');
            if (btn) FinderState.setViewMode(btn.dataset.view);
        };
        viewBtns?.forEach(bar => bar.addEventListener('click', onViewClick));
        track(() => viewBtns?.forEach(bar => bar.removeEventListener('click', onViewClick)));
    }

    /**
     * 更新导航按钮状态。
     * @param {boolean} canBack
     * @param {boolean} canForward
     */
    function updateNavButtons(canBack, canForward) {
        if (navBack) navBack.classList.toggle('disabled', !canBack);
        if (navForward) navForward.classList.toggle('disabled', !canForward);
    }

    /**
     * 更新视图按钮高亮。
     * @param {string} mode
     */
    function updateViewButtons(mode) {
        if (!viewBtns) return;
        const current = mode || FinderState.getViewMode();
        viewBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.view === current));
    }

    /**
     * 根据路径更新窗口标题（根目录显示应用名，否则显示当前文件夹名）。
     * @param {string} path
     */
    function updateTitle(path) {
        if (!titleEl) return;
        titleEl.textContent = FinderState.pathLabel(path);
    }

    /** 从当前状态同步所有按钮与标题 */
    function sync() {
        updateNavButtons(FinderState.canGoBack(), FinderState.canGoForward());
        updateViewButtons(FinderState.getViewMode());
        updateTitle(FinderState.getState().currentPath);
    }

    return { init, sync, dispose };
})();

export { FinderToolbar };
