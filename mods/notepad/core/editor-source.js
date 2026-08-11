/**
 * editor-source.js — 源码/纯文本编辑器（textarea + 行号）
 * 用于 TXT 模式与 MD 的源码视图、分屏左栏。
 */

export function createSourceEditor(textarea, lineNumbersEl, { store, onStats }) {
    function render() {
        textarea.value = store.content;
        updateLineNumbers();
        updateCursor();
        updateStats();
    }

    function sync() {
        store.setContent(textarea.value);
    }

    function updateLineNumbers() {
        const n = textarea.value.split('\n').length || 1;
        lineNumbersEl.innerHTML = Array.from({ length: n }, (_, i) => `<div>${i + 1}</div>`).join('');
    }

    function updateCursor() {
        const pos = textarea.selectionStart;
        const text = textarea.value.substring(0, pos);
        const lines = text.split('\n');
        const line = lines.length;
        const col = lines[lines.length - 1].length + 1;
        if (onStats) onStats({ line, col });
    }

    function updateStats() {
        const text = textarea.value;
        const lines = text.split('\n').length;
        const chars = text.length;
        if (onStats) onStats({ lines, chars });
    }

    textarea.addEventListener('input', () => {
        updateLineNumbers();
        updateStats();
        sync();
    });

    textarea.addEventListener('click', updateCursor);
    textarea.addEventListener('keyup', updateCursor);

    textarea.addEventListener('scroll', () => {
        lineNumbersEl.scrollTop = textarea.scrollTop;
    });

    // Tab 缩进
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, start) + '    ' + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + 4;
            updateLineNumbers();
            updateStats();
            sync();
        }
    });

    return { render, sync, updateLineNumbers, updateCursor, updateStats };
}
