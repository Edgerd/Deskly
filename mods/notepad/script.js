/**
 * script.js — 记事本入口（ES module）
 * 装配 store / 编辑器 / 侧边栏 / 工具栏，处理视图切换、文件操作、快捷键与状态栏。
 */

import { store } from './core/store.js?v=0.2.60';
import { createWysiwygEditor } from './core/editor-wysiwyg.js?v=0.2.60';
import { createSourceEditor } from './core/editor-source.js?v=0.2.60';
import { initSidebar } from './core/sidebar.js?v=0.2.60';
import { initFormatToolbar } from './features/toolbar-format.js?v=0.2.60';
import { initViewSwitch } from './features/toolbar-view.js?v=0.2.60';
import { mdToHtml } from './features/markdown.js?v=0.2.60';

const notepadWindow = document.querySelector('.notepad');

// ── DOM 引用 ──
const wysiwygEl = notepadWindow.querySelector('.editor-wysiwyg:not(.split-preview)');
const sourceTextarea = notepadWindow.querySelector('.editor-source');
const sourceLineNumbers = notepadWindow.querySelector('.editor-source-wrap .line-numbers');
const splitSourceTextarea = notepadWindow.querySelector('.editor-source-split');
const splitSourceLineNumbers = notepadWindow.querySelector('.editor-split .split-source-pane .line-numbers');
const splitPreview = notepadWindow.querySelector('.split-preview');
const sidebarEl = notepadWindow.querySelector('.sidebar');

const fileInfo = notepadWindow.querySelector('.file-info');
const fileNameEl = notepadWindow.querySelector('.file-name');
const lineCount = notepadWindow.querySelector('.line-count');
const wordCount = notepadWindow.querySelector('.word-count');
const cursorInfo = notepadWindow.querySelector('.cursor-info');
const formatBadge = notepadWindow.querySelector('.format-badge');

// ── 编辑器实例 ──
function updateStats({ lines, chars, line, col } = {}) {
    if (lines !== undefined) lineCount.textContent = `行数 ${lines}`;
    if (chars !== undefined) wordCount.textContent = `字数 ${chars}`;
    if (line !== undefined && col !== undefined) cursorInfo.textContent = `行 ${line}, 列 ${col}`;
}

const wysiwyg = createWysiwygEditor(wysiwygEl, { store });
const sourceEditor = createSourceEditor(sourceTextarea, sourceLineNumbers, { store, onStats: updateStats });
const splitSourceEditor = createSourceEditor(splitSourceTextarea, splitSourceLineNumbers, { store, onStats: updateStats });

// ── 视图切换 ──
function switchView(view) {
    // 离开当前视图前，先把内容同步进 store
    if (store.view === 'wysiwyg') wysiwyg.serialize();
    else if (store.view === 'source') sourceEditor.sync();
    else if (store.view === 'split') splitSourceEditor.sync();

    store.setView(view);
    notepadWindow.dataset.view = view;

    // 渲染目标视图
    if (view === 'wysiwyg') {
        wysiwyg.render();
        wysiwyg.focus();
    } else if (view === 'source') {
        sourceEditor.render();
        sourceTextarea.focus();
    } else if (view === 'split') {
        splitSourceEditor.render();
        splitPreview.innerHTML = mdToHtml(store.content);
        splitSourceTextarea.focus();
    }
}

// ── 笔记选择 ──
function selectNote(id) {
    if (store.view === 'wysiwyg') wysiwyg.serialize();
    else if (store.view === 'source') sourceEditor.sync();
    else if (store.view === 'split') splitSourceEditor.sync();

    store.selectNote(id);
    wysiwyg.render();
    sourceEditor.render();
    splitSourceEditor.render();
    splitPreview.innerHTML = mdToHtml(store.content);
    updateFileName();
}

// ── 文件名 / 格式更新 ──
function updateFileName() {
    const note = store.current;
    const name = note ? (note.title || '未命名') : '未命名';
    const ext = store.format === 'md' ? 'md' : 'txt';
    fileInfo.textContent = `${name}.${ext}`;
    fileNameEl.textContent = name;
    formatBadge.textContent = store.format.toUpperCase();
}

// ── 文件操作 ──
function newNote() {
    store.addNote();
    wysiwyg.render();
    sourceEditor.render();
    splitSourceEditor.render();
    splitPreview.innerHTML = mdToHtml(store.content);
    updateFileName();
}

function saveFile() {
    const note = store.current;
    if (!note) return;
    // 同步当前视图内容
    if (store.view === 'wysiwyg') wysiwyg.serialize();
    else if (store.view === 'source') sourceEditor.sync();
    else if (store.view === 'split') splitSourceEditor.sync();

    const ext = store.format === 'md' ? 'md' : 'txt';
    const blob = new Blob([store.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(note.title || '未命名')}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
}

function openFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.md,.markdown';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const text = await file.text();
        const isMd = /\.(md|markdown)$/i.test(file.name);
        const format = isMd ? 'md' : 'txt';
        store.setFormat(format);
        store.addNote({
            title: file.name.replace(/\.(md|txt|markdown)$/i, ''),
            content: text,
            format,
        });
        notepadWindow.dataset.format = format;
        wysiwyg.render();
        sourceEditor.render();
        splitSourceEditor.render();
        splitPreview.innerHTML = mdToHtml(store.content);
        updateFileName();
    };
    input.click();
}

// ── 模块初始化 ──
initSidebar(sidebarEl, { store, onSelect: selectNote });
initFormatToolbar(notepadWindow, { wysiwyg });
initViewSwitch(notepadWindow, { onViewChange: switchView });

// ── 事件绑定（文件操作工具栏）──
notepadWindow.querySelector('.btn-new').addEventListener('click', newNote);
notepadWindow.querySelector('.btn-save').addEventListener('click', saveFile);
notepadWindow.querySelector('.btn-download').addEventListener('click', saveFile);
notepadWindow.querySelector('.btn-open').addEventListener('click', openFile);

// ── 快捷键 ──
notepadWindow.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === 'n') { e.preventDefault(); newNote(); }
    else if (key === 's') { e.preventDefault(); saveFile(); }
    else if (key === 'o' && e.shiftKey) { e.preventDefault(); openFile(); }
    else if (key === 'b' && store.view === 'wysiwyg') { e.preventDefault(); wysiwyg.bold(); }
    else if (key === 'i' && store.view === 'wysiwyg') { e.preventDefault(); wysiwyg.italic(); }
});

// ── 状态栏：内容变化 ──
store.subscribe('content-changed', (text) => {
    const lines = text.split('\n').length || 1;
    const chars = text.length;
    lineCount.textContent = `行数 ${lines}`;
    wordCount.textContent = `字数 ${chars}`;
});
store.subscribe('note-selected', updateFileName);
store.subscribe('format-changed', (format) => {
    notepadWindow.dataset.format = format;
    updateFileName();
});

// ── 启动：创建初始空笔记并渲染 ──
store.addNote();
wysiwyg.render();
sourceEditor.render();
splitSourceEditor.render();
updateFileName();
