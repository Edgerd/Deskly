/**
 * editor-source.js — 源码/纯文本编辑器（textarea + 行号）
 * 用于 TXT 模式与 MD 的源码视图、分屏左栏。
 *
 * 状态栏的行数/字数由 store 统一计算（见 script.js），本模块只上报光标位置，
 * 避免两个模块各写同一组 DOM 造成状态互相覆盖。
 */

export function createSourceEditor(textarea, lineNumbersEl, { store, onCursor }) {
    let rendered = false;

    function render() {
        textarea.value = store.content;
        rendered = true;
        updateLineNumbers();
        updateCursor();
    }

    /** 只有真正渲染过内容的编辑器才允许写回 store：空 textarea 同步会抹掉笔记 */
    function isRendered() {
        return rendered;
    }

    function flush() {
        if (!rendered) return;
        store.setContent(textarea.value);
    }

    function updateLineNumbers() {
        const n = textarea.value.split('\n').length || 1;
        lineNumbersEl.innerHTML = Array.from({ length: n }, (_, i) => `<div>${i + 1}</div>`).join('');
    }

    function updateCursor() {
        if (!onCursor) return;
        const lines = textarea.value.substring(0, textarea.selectionStart).split('\n');
        onCursor({ line: lines.length, col: lines[lines.length - 1].length + 1 });
    }

    function onInput() {
        updateLineNumbers();
        updateCursor();
        flush();
    }

    function onScroll() {
        lineNumbersEl.scrollTop = textarea.scrollTop;
    }

    /** Tab 缩进（规划 §9） */
    function onKeyDown(e) {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + '    ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 4;
        updateLineNumbers();
        updateCursor();
        flush();
    }

    const listeners = [
        ['input', onInput],
        ['click', updateCursor],
        ['keyup', updateCursor],
        ['blur', flush],
        ['scroll', onScroll],
        ['keydown', onKeyDown],
    ];
    listeners.forEach(([type, fn]) => textarea.addEventListener(type, fn));

    function dispose() {
        listeners.forEach(([type, fn]) => textarea.removeEventListener(type, fn));
        rendered = false;
    }

    return { textarea, render, flush, isRendered, updateLineNumbers, updateCursor, dispose };
}
