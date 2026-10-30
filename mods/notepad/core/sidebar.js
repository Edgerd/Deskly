/**
 * sidebar.js — 侧边栏「已保存的笔记」列表
 * 只列已落盘的笔记（与标签条上的「编辑中」区分），右键提供删除（规划里缺失的删除入口）。
 */

import { createContextMenu } from '../../../src/javascripts/ui/contextMenu.js';
import { i18n } from '../../../src/javascripts/i18n.js';
import { confirmBox } from './dialog.js';

function t(key, fallback) {
    return i18n.t('notepad.' + key, fallback);
}

export function initSidebar(el, { store, onSelect, onDelete }) {
    const listEl = el.querySelector('.note-list');
    const emptyEl = el.querySelector('.note-empty');

    function render() {
        listEl.innerHTML = '';
        const notes = store.savedNotes;
        if (!notes.length) {
            emptyEl.hidden = false;
            return;
        }
        emptyEl.hidden = true;

        notes.forEach((note) => {
            const item = document.createElement('div');
            item.className = 'note-item' + (note.id === store.currentId ? ' active' : '');
            item.dataset.id = note.id;
            item.textContent = note.title || t('untitled', '未命名');
            item.title = note.path || note.title;
            listEl.appendChild(item);
        });
    }

    /** 事件委托：列表每次重建都逐个 addEventListener 会随渲染次数累积 */
    function onClick(e) {
        const item = e.target.closest('.note-item');
        if (item) onSelect(item.dataset.id);
    }

    function onContextMenu(e) {
        const item = e.target.closest('.note-item');
        if (!item) return;
        e.preventDefault();
        const id = item.dataset.id;
        const note = store.notes.find((n) => n.id === id);
        const title = note ? note.title : '';
        createContextMenu(e.clientX, e.clientY, [
            { type: 'header', label: title },
            { type: 'separator' },
            {
                label: i18n.t('common.delete', '删除'),
                action: () => {
                    confirmBox(t('deleteTitle', '删除笔记'), t('deleteConfirm', '确定删除「{title}」？').replace('{title}', title))
                        .then((ok) => { if (ok) onDelete(id); })
                        .catch((err) => console.warn('[notepad] 删除笔记失败：', err));
                },
            },
        ]);
    }

    listEl.addEventListener('click', onClick);
    listEl.addEventListener('contextmenu', onContextMenu);

    const unsubscribes = [
        store.subscribe('notes-changed', render),
        store.subscribe('note-selected', render),
        store.subscribe('save-state-changed', render),
    ];

    render();

    return {
        render,
        dispose: () => {
            listEl.removeEventListener('click', onClick);
            listEl.removeEventListener('contextmenu', onContextMenu);
            unsubscribes.forEach((off) => off());
        },
    };
}
