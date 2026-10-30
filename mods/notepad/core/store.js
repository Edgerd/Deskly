/**
 * store.js — 记事本单一数据源
 * 负责笔记列表、打开的标签、当前笔记、视图/格式/编码/保存状态的管理与事件分发。
 *
 * 注意：本模块是跨「打开/关闭」常驻的单例（plugin-manager 每次打开只重新注入 script.js），
 * 因此状态必须由 reset()/clearSubscribers() 显式复位，否则旧订阅会写已脱离文档的 DOM。
 */

import { i18n } from '../../../src/javascripts/i18n.js';

const listeners = {};

// 保存状态（状态栏指示器）
export const SAVE_STATE = {
    SAVED: 'saved',
    UNSAVED: 'unsaved',
    SAVING: 'saving',
    ERROR: 'error',
};

function untitledText() {
    return i18n.t('notepad.untitled', '未命名');
}

function genId() {
    return 'note-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

export const store = {
    notes: [],          // 全部笔记（含未保存）
    tabs: [],           // 打开的标签（note id 顺序表）
    currentId: null,
    view: 'wysiwyg',    // 'wysiwyg' | 'source' | 'split'
    format: 'md',       // 'txt' | 'md'
    markdown: true,     // Markdown 模式开关（所见即所得即时渲染 + 格式化工具栏）
    encoding: 'UTF-8',  // 当前内容的文本编码（打开文件时按实际解码结果更新）
    dirty: false,
    saveState: SAVE_STATE.SAVED,

    /** 订阅事件，返回取消订阅函数 */
    subscribe(event, fn) {
        (listeners[event] || (listeners[event] = [])).push(fn);
        return () => {
            listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
        };
    },

    /** 触发事件（slice 允许订阅者在回调里安全退订） */
    emit(event, payload) {
        (listeners[event] || []).slice().forEach((fn) => fn(payload));
    },

    /** 清空全部订阅：窗口重新打开时由 init() 调用，避免旧闭包继续写旧 DOM */
    clearSubscribers() {
        Object.keys(listeners).forEach((key) => { delete listeners[key]; });
    },

    /** 重置为初始状态（跨打开的单例必须显式复位） */
    reset() {
        this.notes = [];
        this.tabs = [];
        this.currentId = null;
        this.view = 'wysiwyg';
        this.format = 'md';
        this.markdown = true;
        this.encoding = 'UTF-8';
        this.dirty = false;
        this.saveState = SAVE_STATE.SAVED;
    },

    /** 当前笔记对象 */
    get current() {
        return this.notes.find((n) => n.id === this.currentId) || null;
    },

    /** 当前笔记内容（Markdown 文本） */
    get content() {
        const n = this.current;
        return n ? n.content : '';
    },

    /** 已保存到文件系统的笔记（侧边栏「已保存的笔记」数据源） */
    get savedNotes() {
        return this.notes.filter((n) => !!n.path);
    },

    /** 当前笔记标题（未命名走 i18n） */
    get title() {
        const n = this.current;
        return n ? (n.title || untitledText()) : untitledText();
    },

    /** 设置当前笔记内容（用户编辑路径，一律标脏） */
    setContent(text) {
        const n = this.current;
        if (!n || n.content === text) return;
        n.content = text;
        n.updatedAt = Date.now();
        n.dirty = true;
        if (n.untitled && text.trim()) {
            n.title = text.trim().split('\n')[0].slice(0, 20) || untitledText();
            n.untitled = false;
            this.emit('notes-changed', this.notes);
        }
        this.markDirty();
        this.emit('content-changed', text);
    },

    /** 设置视图模式 */
    setView(view) {
        if (this.view === view) return;
        this.view = view;
        this.emit('view-changed', view);
    },

    /** 设置文本编码标签 */
    setEncoding(encoding) {
        const label = encoding || 'UTF-8';
        if (this.encoding === label) return;
        this.encoding = label;
        this.emit('encoding-changed', label);
    },

    /** 新增笔记并作为标签打开 */
    addNote(note = {}) {
        const fmt = note.format === 'txt' ? 'txt' : 'md';
        const title = note.title || '';
        const n = {
            id: note.id || genId(),
            title: title || untitledText(),
            untitled: !title,
            content: note.content || '',
            format: fmt,
            markdown: note.markdown !== undefined ? !!note.markdown : (fmt === 'md'),
            path: note.path || null,
            updatedAt: note.updatedAt || Date.now(),
            dirty: note.dirty !== false,
        };
        this.notes.push(n);
        this.tabs.push(n.id);
        this.currentId = n.id;
        // 格式属于「新建的这条笔记」：必须建好再同步全局态，否则改写上一条
        this.format = fmt;
        this.markdown = n.markdown;
        if (note.encoding) this.setEncoding(note.encoding);
        this.applySaveState(n.dirty ? SAVE_STATE.UNSAVED : SAVE_STATE.SAVED);
        this.emit('tabs-changed', this.tabs);
        this.emit('notes-changed', this.notes);
        this.emit('content-changed', n.content);
        this.emit('format-changed', this.format);
        this.emit('markdown-changed', this.markdown);
        return n;
    },

    /** 选择笔记（未在标签中的笔记会被重新打开） */
    selectNote(id) {
        if (!this.notes.some((n) => n.id === id)) return;
        if (!this.tabs.includes(id)) {
            this.tabs.push(id);
            this.emit('tabs-changed', this.tabs);
        }
        if (this.currentId === id) return;
        this.currentId = id;
        const n = this.current;
        if (n) {
            this.format = n.format;
            this.markdown = !!n.markdown;
        }
        this.emit('note-selected', n);
        this.emit('content-changed', this.content);
        this.emit('format-changed', this.format);
        this.emit('markdown-changed', this.markdown);
        this.refreshSaveState();
    },

    /**
     * 关闭标签。
     * 已落盘的笔记留在侧边栏列表（可从「已保存的笔记」重新打开）；
     * 从未保存过的笔记随标签一并移除，避免在 store 里堆积孤儿条目。
     */
    closeTab(id) {
        const idx = this.tabs.indexOf(id);
        if (idx < 0) return;
        const note = this.notes.find((n) => n.id === id) || null;
        const isCurrent = this.currentId === id;
        this.tabs.splice(idx, 1);
        if (isCurrent) this.currentId = null;
        this.emit('tabs-changed', this.tabs);
        if (note && !note.path) {
            this.removeNote(id);
            return;
        }
        if (!isCurrent) return;
        if (this.tabs.length) this.selectNote(this.tabs[Math.min(idx, this.tabs.length - 1)]);
        else this.addNote();
    },

    /** 删除笔记 */
    removeNote(id) {
        const idx = this.notes.findIndex((n) => n.id === id);
        if (idx < 0) return;
        const wasCurrent = this.currentId === id;
        this.notes.splice(idx, 1);
        this.tabs = this.tabs.filter((t) => t !== id);
        if (wasCurrent) this.currentId = null;
        this.emit('notes-changed', this.notes);
        this.emit('tabs-changed', this.tabs);
        if (!wasCurrent) return;
        if (this.tabs.length) this.selectNote(this.tabs[0]);
        else this.addNote();
    },

    /** 设置格式（作用于当前笔记） */
    setFormat(format) {
        if (this.format === format) return;
        this.format = format;
        const n = this.current;
        if (n) n.format = format;
        this.emit('format-changed', format);
    },

    /** 切换 Markdown 模式（所见即所得即时渲染 + 格式化工具栏） */
    setMarkdown(bool) {
        bool = !!bool;
        if (this.markdown === bool) return;
        this.markdown = bool;
        const n = this.current;
        if (n) n.markdown = bool;
        this.emit('markdown-changed', bool);
    },

    /** 保存状态流转（指示器 + dirty） */
    applySaveState(state) {
        this.saveState = state;
        this.dirty = state !== SAVE_STATE.SAVED;
        this.emit('save-state-changed', state);
    },

    markDirty() {
        const n = this.current;
        if (n) n.dirty = true;
        this.applySaveState(SAVE_STATE.UNSAVED);
    },

    markSaving() {
        this.applySaveState(SAVE_STATE.SAVING);
    },

    /** 保存成功：清脏位，必要时记录落盘路径（侧边栏「已保存的笔记」随之出现该条） */
    markSaved(path) {
        const n = this.current;
        if (n) {
            n.dirty = false;
            if (path) n.path = path;
        }
        this.applySaveState(SAVE_STATE.SAVED);
        if (path) this.emit('notes-changed', this.notes);
    },

    markSaveError() {
        this.applySaveState(SAVE_STATE.ERROR);
    },

    /** 按当前笔记的 dirty 刷新指示器（切标签 / 载入草稿后用） */
    refreshSaveState() {
        const n = this.current;
        this.applySaveState(n && n.dirty ? SAVE_STATE.UNSAVED : SAVE_STATE.SAVED);
    },

    /** 导出可持久化快照（core/storage.js 写草稿用） */
    snapshot() {
        return {
            notes: this.notes.map((n) => ({
                id: n.id, title: n.title, untitled: !!n.untitled, content: n.content,
                format: n.format, markdown: n.markdown, path: n.path || null,
                updatedAt: n.updatedAt, dirty: n.dirty !== false,
            })),
            tabs: this.tabs.slice(),
            currentId: this.currentId,
            view: this.view,
            format: this.format,
            markdown: this.markdown,
            encoding: this.encoding,
        };
    },

    /**
     * 载入草稿快照（恢复上次会话）。
     * @param {object} state snapshot() 结构
     * @returns {boolean} 是否成功载入
     */
    loadSnapshot(state) {
        if (!state || !Array.isArray(state.notes) || !state.notes.length) return false;
        const untitled = untitledText();
        this.notes = state.notes.map((n) => ({
            id: n.id || genId(),
            title: n.untitled ? untitled : (n.title || untitled),
            untitled: !!n.untitled,
            content: typeof n.content === 'string' ? n.content : '',
            format: n.format === 'txt' ? 'txt' : 'md',
            markdown: n.markdown !== false,
            path: n.path || null,
            updatedAt: n.updatedAt || Date.now(),
            dirty: n.dirty !== false,
        }));
        const ids = new Set(this.notes.map((n) => n.id));
        this.tabs = (Array.isArray(state.tabs) ? state.tabs : []).filter((id) => ids.has(id));
        if (!this.tabs.length) this.tabs = [this.notes[0].id];
        this.currentId = ids.has(state.currentId) ? state.currentId : this.tabs[0];
        const n = this.current;
        this.view = ['wysiwyg', 'source', 'split'].includes(state.view) ? state.view : 'wysiwyg';
        this.format = (n && n.format) || 'md';
        this.markdown = n ? !!n.markdown : true;
        this.encoding = state.encoding || 'UTF-8';
        this.applySaveState(n && n.dirty ? SAVE_STATE.UNSAVED : SAVE_STATE.SAVED);
        return true;
    },
};
