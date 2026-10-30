/**
 * finder-tabs.js — 访达标签页 UI（macOS 15）
 *
 * 标签数据（含每页独立的历史与视图选项）由 FinderState 持有，本模块只做渲染与交互。
 * 标签栏仅在「标签页 > 1」或用户经「显示」菜单显式开启时浮现。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { FinderState } from './finder-state.js';
import { FinderLayout } from './finder-layout.js';

const FinderTabs = (() => {
    let tabsBar = null, tabNewBtn = null, onTabSwitch = null;

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
     * 初始化标签页 UI。
     * @param {object} options
     * @param {Function} [options.tabSwitch] 标签切换回调(path)
     */
    function init(options = {}) {
        // 常驻单例：重开窗口先撤销上一次的订阅
        dispose();

        tabsBar = document.getElementById('finder-tabs-bar');
        tabNewBtn = document.getElementById('tab-new');
        onTabSwitch = options.tabSwitch || null;

        bindEvents();
        renderTabs();
        FinderLayout.refreshTabBar();

        track(FinderState.on('tab-changed', renderTabs));
        track(FinderState.on('locale-changed', renderTabs));
    }

    /** 绑定事件 */
    function bindEvents() {
        const onClick = (e) => {
            const closeBtn = e.target.closest('.tab-close');
            if (closeBtn) {
                const tab = closeBtn.closest('.tab');
                if (tab && tab.dataset.tabId) removeTab(parseInt(tab.dataset.tabId, 10));
                e.stopPropagation();
                return;
            }
            const tab = e.target.closest('.tab:not(.tab-new)');
            if (tab && tab.dataset.tabId) selectTab(parseInt(tab.dataset.tabId, 10));
        };
        tabsBar?.addEventListener('click', onClick);

        // 新建标签页从根目录开始（与 macOS「新建标签页」一致）
        const onNew = () => selectTab(FinderState.addTab('/'));
        tabNewBtn?.addEventListener('click', onNew);

        track(() => tabsBar?.removeEventListener('click', onClick));
        track(() => tabNewBtn?.removeEventListener('click', onNew));
    }

    /**
     * 激活标签并导航到它的路径。
     * @param {number} tabId
     */
    function selectTab(tabId) {
        const alreadyActive = FinderState.getState().activeTabId === tabId;
        const tab = FinderState.setActiveTab(tabId);
        if (!tab) return;
        FinderLayout.refreshTabBar();
        // 点击当前标签不必重新列目录
        if (!alreadyActive) onTabSwitch?.(tab.path);
    }

    /**
     * 关闭标签并导航到相邻标签。
     * @param {number} tabId
     */
    function removeTab(tabId) {
        const next = FinderState.closeTab(tabId);
        FinderLayout.refreshTabBar();
        if (next) onTabSwitch?.(next.path);
    }

    /** 渲染标签栏 DOM */
    function renderTabs() {
        if (!tabsBar) return;
        const activeId = FinderState.getState().activeTabId;
        // 移除旧标签（保留新建按钮）
        tabsBar.querySelectorAll('.tab').forEach(t => t.remove());

        const frag = document.createDocumentFragment();
        FinderState.getState().tabs.forEach((tab) => {
            const tabEl = document.createElement('div');
            tabEl.className = 'tab' + (tab.id === activeId ? ' active' : '');
            tabEl.dataset.path = tab.path;
            tabEl.dataset.tabId = tab.id;

            const label = document.createElement('span');
            label.className = 'tab-label';
            label.textContent = FinderState.pathLabel(tab.path);
            tabEl.appendChild(label);

            const close = document.createElement('button');
            close.className = 'tab-close';
            close.setAttribute('aria-label', i18n.t('finder.closeTab', '关闭标签页'));
            close.innerHTML = '<svg width="9" height="9" viewBox="0 0 10 10"><path d="M2 2L8 8M8 2L2 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
            tabEl.appendChild(close);

            frag.appendChild(tabEl);
        });
        tabsBar.insertBefore(frag, tabNewBtn);
    }

    return { init, dispose };
})();

export { FinderTabs };
