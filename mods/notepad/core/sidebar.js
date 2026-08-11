/**
 * sidebar.js — 侧边栏笔记列表面板
 */

export function initSidebar(el, { store, onSelect }) {
    const listEl = el.querySelector('.note-list');
    const emptyEl = el.querySelector('.note-empty');

    function render() {
        listEl.innerHTML = '';
        if (!store.notes.length) {
            emptyEl.hidden = false;
            return;
        }
        emptyEl.hidden = true;

        store.notes.forEach(note => {
            const item = document.createElement('div');
            item.className = 'note-item' + (note.id === store.currentId ? ' active' : '');
            item.textContent = note.title || '未命名';
            item.title = note.title || '未命名';
            item.addEventListener('click', () => onSelect(note.id));
            listEl.appendChild(item);
        });
    }

    store.subscribe('notes-changed', render);
    store.subscribe('note-selected', render);

    render();

    return { render };
}
