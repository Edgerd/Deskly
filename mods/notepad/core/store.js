/**
 * store.js — 记事本单一数据源
 * 负责笔记列表、当前笔记、视图模式、格式的状态管理与事件分发。
 */

const listeners = {};

function genId() {
    return 'note-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

export const store = {
    notes: [],
    currentId: null,
    view: 'wysiwyg',   // 'wysiwyg' | 'source' | 'split'
    format: 'md',      // 'txt' | 'md'

    /** 订阅事件 */
    subscribe(event, fn) {
        (listeners[event] || (listeners[event] = [])).push(fn);
        return () => {
            listeners[event] = (listeners[event] || []).filter(f => f !== fn);
        };
    },

    /** 触发事件 */
    emit(event, payload) {
        (listeners[event] || []).forEach(fn => fn(payload));
    },

    /** 当前笔记对象 */
    get current() {
        return this.notes.find(n => n.id === this.currentId) || null;
    },

    /** 当前笔记内容（Markdown 文本） */
    get content() {
        const n = this.current;
        return n ? n.content : '';
    },

    /** 设置当前笔记内容 */
    setContent(text) {
        const n = this.current;
        if (!n) return;
        n.content = text;
        n.updatedAt = Date.now();
        if (n.title === '未命名' && text.trim()) {
            n.title = text.trim().split('\n')[0].slice(0, 20) || '未命名';
            this.emit('notes-changed', this.notes);
        }
        this.emit('content-changed', text);
    },

    /** 设置视图模式 */
    setView(view) {
        if (this.view === view) return;
        this.view = view;
        this.emit('view-changed', view);
    },

    /** 新增笔记 */
    addNote(note = {}) {
        const n = {
            id: genId(),
            title: note.title || '未命名',
            content: note.content || '',
            format: note.format || this.format,
            updatedAt: Date.now(),
        };
        this.notes.push(n);
        this.currentId = n.id;
        this.emit('notes-changed', this.notes);
        this.emit('content-changed', n.content);
        return n;
    },

    /** 选择笔记 */
    selectNote(id) {
        if (this.currentId === id) return;
        this.currentId = id;
        const n = this.current;
        if (n) this.format = n.format;
        this.emit('note-selected', n);
        this.emit('content-changed', this.content);
        this.emit('format-changed', this.format);
    },

    /** 删除笔记 */
    removeNote(id) {
        this.notes = this.notes.filter(n => n.id !== id);
        if (this.currentId === id) {
            if (this.notes.length) {
                this.currentId = this.notes[0].id;
            } else {
                this.currentId = null;
                this.addNote();
                return;
            }
        }
        this.emit('notes-changed', this.notes);
        const n = this.current;
        if (n) {
            this.format = n.format;
            this.emit('content-changed', n.content);
            this.emit('format-changed', this.format);
        }
    },

    /** 设置格式 */
    setFormat(format) {
        if (this.format === format) return;
        this.format = format;
        const n = this.current;
        if (n) n.format = format;
        this.emit('format-changed', format);
    }
};
