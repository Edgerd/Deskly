/**
 * finder-tabs.js — 访达标签页管理（macOS 15）
 *
 * 管理标签页的增删切换。标签栏仅在「标签页 > 1」或用户经「显示」菜单显式开启时浮现。
 */

import { FinderState } from './finder-state.js';
import { FinderLayout } from './finder-layout.js';

const FinderTabs = (() => {
    let tabsBar = null, tabNewBtn = null, onTabSwitch = null;
    let activeTabId = null; // 当前激活标签 ID

    /**
     * 初始化标签页管理。
     * @param {object} options
     * @param {Function} [options.tabSwitch] 标签切换回调(path)
     */
    function init(options = {}) {
        tabsBar = document.getElementById('finder-tabs-bar');
        tabNewBtn = document.getElementById('tab-new');
        onTabSwitch = options.tabSwitch || null;

        const state = FinderState.getState();
        if (!state.tabs.length) activeTabId = addTab('/', '访达');
        else activeTabId = state.tabs[state.tabs.length - 1].id;

        bindEvents();
        renderTabs();
        FinderLayout.refreshTabBar();
    }

    /** 绑定事件 */
    function bindEvents() {
        if (!tabsBar) return;

        tabsBar.addEventListener('click', (e) => {
            const closeBtn = e.target.closest('.tab-close');
            if (closeBtn) {
                const tab = closeBtn.closest('.tab');
                if (tab && tab.dataset.tabId) closeTab(parseInt(tab.dataset.tabId, 10));
                e.stopPropagation();
                return;
            }
            const tab = e.target.closest('.tab:not(.tab-new)');
            if (tab && tab.dataset.tabId) switchTab(parseInt(tab.dataset.tabId, 10));
        });

        if (tabNewBtn) {
            tabNewBtn.addEventListener('click', () => {
                const id = addTab('/', '访达');
                switchTab(id);
            });
        }
    }

    /**
     * 添加标签页。
     * @param {string} path
     * @param {string} label
     * @returns {number} 新标签 ID
     */
    function addTab(path, label) {
        const state = FinderState.getState();
        const id = ++state.tabId;
        state.tabs.push({ id, path, label });
        FinderState.emit('tab-added', { id, path, label });
        return id;
    }

    /**
     * 切换标签并导航。
     * @param {number} tabId
     */
    function switchTab(tabId) {
        const state = FinderState.getState();
        const tab = state.tabs.find(t => t.id === tabId);
        if (!tab) return;
        activeTabId = tabId;
        renderTabs();
        FinderLayout.refreshTabBar();
        if (onTabSwitch) onTabSwitch(tab.path);
    }

    /**
     * 关闭标签。
     * @param {number} tabId
     */
    function closeTab(tabId) {
        const state = FinderState.getState();
        if (state.tabs.length <= 1) return; // 至少保留一个
        const idx = state.tabs.findIndex(t => t.id === tabId);
        if (idx === -1) return;
        state.tabs.splice(idx, 1);
        FinderState.emit('tab-closed', tabId);

        if (tabId === activeTabId) {
            const newIdx = Math.min(idx, state.tabs.length - 1);
            const newTab = state.tabs[newIdx];
            if (newTab) switchTab(newTab.id);
        } else {
            renderTabs();
            FinderLayout.refreshTabBar();
        }
    }

    /**
     * 更新当前激活标签的路径与标题（常规导航时调用）。
     * @param {string} path
     * @param {string} label
     */
    function setCurrentTabPath(path, label) {
        const state = FinderState.getState();
        const tab = state.tabs.find(t => t.id === activeTabId);
        if (tab) {
            tab.path = path;
            tab.label = label;
            renderTabs();
        }
    }

    /** 渲染标签栏 DOM */
    function renderTabs() {
        if (!tabsBar) return;
        const state = FinderState.getState();
        // 移除旧标签（保留新建按钮）
        tabsBar.querySelectorAll('.tab').forEach(t => t.remove());

        const frag = document.createDocumentFragment();
        state.tabs.forEach((tab) => {
            const tabEl = document.createElement('div');
            tabEl.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
            tabEl.dataset.path = tab.path;
            tabEl.dataset.tabId = tab.id;

            const label = document.createElement('span');
            label.className = 'tab-label';
            label.textContent = tab.label;
            tabEl.appendChild(label);

            const close = document.createElement('button');
            close.className = 'tab-close';
            close.setAttribute('aria-label', '关闭标签页');
            close.innerHTML = '<svg width="9" height="9" viewBox="0 0 10 10"><path d="M2 2L8 8M8 2L2 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
            tabEl.appendChild(close);

            frag.appendChild(tabEl);
        });
        tabsBar.insertBefore(frag, tabNewBtn);
    }

    return { init, addTab, switchTab, closeTab, setCurrentTabPath, renderTabs };
})();

export { FinderTabs };
