/**
 * finder-tabs.js — 标签页 UI 渲染与交互；数据（含每页独立历史与视图选项）由 FinderState 持有。
 * 标签栏仅在「标签页 > 1」或经「显示」菜单显式开启时浮现。
 * F-43：标签页列表持久化（localStorage，防抖落盘 + 版本号）、拖动重排、⌃Tab 循环切换。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { FinderState } from './finder-state.js';
import { FinderLayout } from './finder-layout.js';

const STORE_KEY = 'finder.tabs.v1'; // v1：仅存路径数组 + 激活序号（视图选项每页独立，不跨会话携带）
const SAVE_DELAY = 400;
/** 关闭标签的回退栈（⌘⇧T 重开用），窗口生命周期内有效 */
const closedStack = [];

const FinderTabs = (() => {
    let tabsBar = null, tabNewBtn = null, onTabSwitch = null;
    let saveTimer = 0;

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

    /** 防抖落盘：tab-changed 高频（每次导航都会 syncActiveTab），不能每敲一次写一次。 */
    function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            try {
                const s = FinderState.getState();
                const activeIdx = Math.max(0, s.tabs.findIndex(t => t.id === s.activeTabId));
                localStorage.setItem(STORE_KEY, JSON.stringify({
                    v: 1,
                    paths: s.tabs.map(t => t.path),
                    activeIdx,
                }));
            } catch { /* 隐私模式等写不进就算了，不影响使用 */ }
        }, SAVE_DELAY);
    }

    /** 读取持久化的标签页；无数据 / 版本不符 / 结构损坏时返回 null。 */
    function loadSaved() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (!data || data.v !== 1 || !Array.isArray(data.paths) || !data.paths.length) return null;
            return data;
        } catch { return null; }
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
        // F-43 恢复：reset() 只给一个落点标签，这里用持久化列表整表替换（含激活序号）
        const saved = loadSaved();
        if (saved) {
            const s = FinderState.getState();
            const keep = s.tabs.length === 1 && s.tabs[0].path === '/';
            if (keep) {
                const firstPath = FinderState.restoreTabs(saved.paths, saved.activeIdx);
                if (firstPath && firstPath !== '/') onTabSwitch?.(firstPath);
            }
        }
        renderTabs();
        FinderLayout.refreshTabBar();

        track(FinderState.on('tab-changed', () => { renderTabs(); scheduleSave(); }));
        track(FinderState.on('locale-changed', renderTabs));
    }

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

        // F-43 拖动重排：按下记起点，拖过相邻标签一半宽度即换位（实时重排，松手即定格）
        let dragId = 0, dragEl = null;
        const onPointerDown = (e) => {
            const tab = e.target.closest('.tab:not(.tab-new)');
            if (!tab || e.button !== 0) return;
            dragId = parseInt(tab.dataset.tabId, 10);
            dragEl = tab;
        };
        const onPointerMove = (e) => {
            if (!dragId || !dragEl || !tabsBar) return;
            const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.tab:not(.tab-new)');
            if (!over || over === dragEl) return;
            const tabs = [...tabsBar.querySelectorAll('.tab:not(.tab-new)')];
            const toIdx = tabs.indexOf(over);
            if (toIdx === -1) return;
            const rect = over.getBoundingClientRect();
            const before = e.clientX < rect.left + rect.width / 2;
            const target = tabs.findIndex(t => parseInt(t.dataset.tabId, 10) === dragId);
            const insertAt = before ? toIdx : toIdx + (target < toIdx ? 0 : 1);
            if (FinderState.reorderTabs(dragId, before ? toIdx : insertAt)) dragEl = tabsBar.querySelector(`.tab[data-tab-id="${dragId}"]`);
        };
        const onPointerUp = () => { dragId = 0; dragEl = null; };
        tabsBar?.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        track(() => tabsBar?.removeEventListener('pointerdown', onPointerDown));
        track(() => document.removeEventListener('pointermove', onPointerMove));
        track(() => document.removeEventListener('pointerup', onPointerUp));

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
        const s = FinderState.getState();
        const closing = s.tabs.find(t => t.id === tabId);
        if (closing) {
            closedStack.push(closing.path);
            if (closedStack.length > 16) closedStack.shift();
        }
        const next = FinderState.closeTab(tabId);
        FinderLayout.refreshTabBar();
        if (next) onTabSwitch?.(next.path);
    }

    /** ⌘⇧T（F-43）：重开上一次关闭的标签页。 */
    function reopenTab() {
        const path = closedStack.pop();
        if (!path) return;
        const id = FinderState.addTab(path);
        selectTab(id);
    }

    /** ⌃Tab（F-43）：循环切换到下一个标签（Shift 反向）。script.js 键盘分发调用。 */
    function cycleTab(delta = 1) {
        const s = FinderState.getState();
        if (s.tabs.length <= 1) return;
        const idx = s.tabs.findIndex(t => t.id === s.activeTabId);
        const n = s.tabs.length;
        const next = s.tabs[((idx + delta) % n + n) % n];
        selectTab(next.id);
    }

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

    return { init, dispose, cycleTab, reopenTab };
})();

export { FinderTabs };
