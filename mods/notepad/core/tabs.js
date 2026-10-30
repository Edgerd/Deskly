/**
 * tabs.js — 多标签管理（规划 §6/§9：新建 / 切换 / 关闭）
 * 数据在 store.tabs（note id 顺序表），本模块只负责标签条 DOM 与交互。
 */

import { i18n } from '../../../src/javascripts/i18n.js';

export function initTabs(root, { store, onSelect, onClose, onNew }) {
    const bar = root.querySelector('.tabbar');
    const listEl = bar.querySelector('.tab-list');
    const newBtn = bar.querySelector('.tab-new');

    function render() {
        listEl.innerHTML = '';
        store.tabs.forEach((id) => {
            const note = store.notes.find((n) => n.id === id);
            if (!note) return;
            const active = id === store.currentId;
            const tab = document.createElement('div');
            tab.className = 'tab' + (note.dirty ? ' is-dirty' : '');
            tab.dataset.id = id;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
            tab.title = note.title;

            const label = document.createElement('span');
            label.className = 'tab-label';
            label.textContent = note.title;
            tab.appendChild(label);

            const close = document.createElement('button');
            close.className = 'tab-close';
            close.type = 'button';
            close.dataset.close = id;
            close.setAttribute('aria-label', i18n.t('notepad.closeTab', '关闭标签'));
            close.textContent = '×';
            tab.appendChild(close);

            if (active) tab.classList.add('active');
            listEl.appendChild(tab);
        });
        // 单标签时不占版面，避免在三层工具栏之外再添视觉噪音
        bar.hidden = store.tabs.length < 2;
    }

    /** 脏点随保存状态变化，不重建整条列表 */
    function updateDirty() {
        Array.from(listEl.children).forEach((tab) => {
            const note = store.notes.find((n) => n.id === tab.dataset.id);
            tab.classList.toggle('is-dirty', !!(note && note.dirty));
        });
    }

    function onClick(e) {
        const closeBtn = e.target.closest('.tab-close');
        if (closeBtn) {
            onClose(closeBtn.dataset.close);
            return;
        }
        const tab = e.target.closest('.tab');
        if (tab) onSelect(tab.dataset.id);
    }

    listEl.addEventListener('click', onClick);
    newBtn.addEventListener('click', onNew);

    const unsubscribes = [
        store.subscribe('tabs-changed', render),
        store.subscribe('notes-changed', render),
        store.subscribe('note-selected', render),
        store.subscribe('save-state-changed', updateDirty),
    ];

    render();

    return { render, dispose: () => unsubscribes.forEach((off) => off()) };
}
