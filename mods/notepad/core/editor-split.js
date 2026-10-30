/**
 * editor-split.js — 分屏视图（左源码 / 右预览）
 * 组合 core/editor-source.js 与预览 DOM，并做左右滚动联动（规划 §6 该模块的职责）。
 */

import { createSourceEditor } from './editor-source.js';
import { mdToHtml } from './serializer.js';

export function createSplitView({ root, textarea, lineNumbers, preview, store, onCursor }) {
    const source = createSourceEditor(textarea, lineNumbers, { store, onCursor });
    let rendered = false;

    function renderPreview() {
        preview.innerHTML = mdToHtml(store.content);
    }

    function render() {
        source.render();
        renderPreview();
        rendered = true;
    }

    /** 未渲染时禁止写回：此时 textarea 还是空的 */
    function flush() {
        if (!rendered) return;
        source.flush();
    }

    function refresh() {
        if (rendered) renderPreview();
    }

    /** 外部（查找替换）直接改写了 textarea 值之后：补行号 + 写回 store */
    function afterChange() {
        source.updateLineNumbers();
        source.flush();
    }

    /** 滚动联动：按滚动比例映射另一侧（两侧高度不同，比例法足够且无 DOM 依赖） */
    function sync(from, to) {
        const max = from.scrollHeight - from.clientHeight;
        if (max <= 0) return;
        const ratio = from.scrollTop / max;
        const toMax = to.scrollHeight - to.clientHeight;
        if (toMax <= 0) return;
        to.scrollTop = ratio * toMax;
    }

    const onSourceScroll = () => sync(textarea, preview);
    const onPreviewScroll = () => sync(preview, textarea);
    textarea.addEventListener('scroll', onSourceScroll);
    preview.addEventListener('scroll', onPreviewScroll);

    function dispose() {
        textarea.removeEventListener('scroll', onSourceScroll);
        preview.removeEventListener('scroll', onPreviewScroll);
        source.dispose();
        rendered = false;
    }

    return { textarea, preview, render, flush, refresh, afterChange, isRendered: () => rendered, dispose };}
