/**
 * finder-toolbar.js — 访达合并标题栏管理
 *
 * 绑定前进/后退、四个视图按钮；同步导航禁用态与视图高亮；
 * 根据当前路径更新居中的窗口标题。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { FinderState } from './finder-state.js';

const FinderToolbar = (() => {
    let navBack = null, navForward = null, viewBtns = null, titleEl = null;
    let onGoBack = null, onGoForward = null;

    /**
     * 初始化标题栏。
     * @param {object} options
     * @param {Function} [options.goBack]
     * @param {Function} [options.goForward]
     */
    function init(options = {}) {
        navBack = document.getElementById('nav-back');
        navForward = document.getElementById('nav-forward');
        viewBtns = document.querySelectorAll('.view-btn');
        titleEl = document.getElementById('finder-title');

        onGoBack = options.goBack || null;
        onGoForward = options.goForward || null;

        bindEvents();
        FinderState.on('navigated', (data) => {
            updateNavButtons(data.canGoBack, data.canGoForward);
            updateTitle(FinderState.getState().currentPath);
        });
        FinderState.on('view-changed', updateViewButtons);
        FinderState.on('path-changed', updateTitle);
    }

    /** 绑定事件 */
    function bindEvents() {
        navBack?.addEventListener('click', () => onGoBack?.());
        navForward?.addEventListener('click', () => onGoForward?.());
        viewBtns?.forEach(btn => btn.addEventListener('click', () => FinderState.setViewMode(btn.dataset.view)));
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
        viewBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.view === mode));
    }

    /**
     * 根据路径更新窗口标题（根目录显示「访达」，否则显示当前文件夹名）。
     * @param {string} path
     */
    function updateTitle(path) {
        if (!titleEl) return;
        const label = (path === '/' || !path)
            ? i18n.t('finder.title', '访达')
            : path.split('/').filter(Boolean).pop();
        titleEl.textContent = label;
    }

    /** 从当前状态同步所有按钮与标题 */
    function sync() {
        const s = FinderState.getState();
        updateNavButtons(s.canGoBack ? s.canGoBack() : false, s.canGoForward ? s.canGoForward() : false);
        updateViewButtons(s.viewMode);
        updateTitle(s.currentPath);
    }

    return { init, sync, updateNavButtons, updateViewButtons, updateTitle };
})();

export { FinderToolbar };
