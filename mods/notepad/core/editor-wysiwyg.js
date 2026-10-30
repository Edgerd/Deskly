/**
 * editor-wysiwyg.js — 所见即所得编辑器内核
 * 基于 contentEditable，转换由 core/serializer.js 提供（core 不依赖 features）。
 * 支持轻量即时渲染：输入 # / - / > 等行首标记时实时转换块级元素。
 *
 * 撤销/重做：contentEditable 的原生栈会被 innerHTML 重建与 Range 手术作废（规划 §5.4 的假设不成立），
 * 因此这里自维护文本快照栈，并接管 ⌘Z / ⌘Y，保证 store 与 DOM 不脱节。
 */

import { mdToHtml, htmlToMd, escapeHtml, safeUrl } from './serializer.js';
import { promptBox, alertBox } from './dialog.js';
import { i18n } from '../../../src/javascripts/i18n.js';

const HISTORY_LIMIT = 200;
const DEBOUNCE = 300;      // 输入 → 序列化节流
const BURST_MS = 600;      // 连续输入合并为一次撤销步骤

function t(key, fallback) {
    return i18n.t('notepad.' + key, fallback);
}

export function createWysiwygEditor(el, { store, onCursor }) {
    let debounceTimer = null;
    let formatScheduled = false;
    let formatFrame = 0;
    let rendered = false;      // 未渲染过的 DOM 是空的，flush 会反向抹掉笔记

    // ── 历史栈 ──
    let committed = '';            // 与 store 同步的文本
    let lastCaret = 0;             // committed 对应的光标位置
    let lastCommitAt = 0;
    const undoStack = [];
    const redoStack = [];

    // ── 光标工具 ──
    /** 光标相对编辑器纯文本的偏移（Range.toString 与 TreeWalker 文本求和同构） */
    function caretOffset() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return 0;
        const { anchorNode, anchorOffset } = sel;
        if (!anchorNode || !el.contains(anchorNode)) return 0;
        try {
            const r = document.createRange();
            r.selectNodeContents(el);
            r.setEnd(anchorNode, anchorOffset);
            return r.toString().length;
        } catch (err) {
            return 0;
        }
    }

    /** 纯文本偏移 → 光标位置 */
    function setCaretOffset(offset) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node;
        let total = 0;
        while ((node = walker.nextNode())) {
            const len = node.textContent.length;
            if (total + len >= offset) {
                const range = document.createRange();
                range.setStart(node, Math.max(0, offset - total));
                range.collapse(true);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                return;
            }
            total += len;
        }
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    /** 光标所在块级元素 */
    function getBlockFrom(node) {
        while (node && node !== el) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName.toLowerCase();
                if (['p', 'div', 'h1', 'h2', 'h3', 'blockquote', 'li', 'pre'].includes(tag)) return node;
            }
            node = node.parentNode;
        }
        return null;
    }

    /**
     * 行/列（规划 §9 要求三种视图都有光标位置）。
     * WYSIWYG 没有「源码行」概念：行 = 顶层块序号，列 = 光标在块内纯文本中的位置。
     */
    function cursorInfo() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return null;
        const anchor = sel.anchorNode;
        if (!anchor || !el.contains(anchor)) return null;
        const block = getBlockFrom(anchor) || el;
        const top = topmostBlock(block);
        const line = Math.max(1, Array.from(el.children).indexOf(top) + 1);
        const inBlock = plainOffsetWithin(block);
        const before = blockTextWithin(block, inBlock);
        const nl = before.lastIndexOf('\n');
        return { line: line + countNewlinesWithin(block, inBlock), col: inBlock - nl };
    }

    function topmostBlock(block) {
        let node = block;
        while (node && node.parentNode && node.parentNode !== el) node = node.parentNode;
        return node;
    }

    /** 光标在所属块内的纯文本偏移 */
    function plainOffsetWithin(block) {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return 0;
        try {
            const r = document.createRange();
            r.selectNodeContents(block);
            r.setEnd(sel.anchorNode, sel.anchorOffset);
            return r.toString().length;
        } catch (err) {
            return 0;
        }
    }

    function blockTextWithin(block, endOffset) {
        let out = '';
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const remain = endOffset - out.length;
            if (remain <= 0) break;
            out += node.textContent.slice(0, remain);
        }
        return out;
    }

    /** 代码块等含换行的块：行号需加上光标之前的换行数 */
    function countNewlinesWithin(block, endOffset) {
        const text = blockTextWithin(block, endOffset);
        let n = 0;
        for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++;
        return n;
    }

    function reportCursor() {
        if (!onCursor) return;
        const info = cursorInfo();
        if (info) onCursor(info);
    }

    // ── 序列化 / 历史 ──
    function commit(md, { coalesce = true } = {}) {
        if (md === committed) return;
        const now = Date.now();
        const caret = caretOffset();
        const sameBurst = coalesce && (now - lastCommitAt) < BURST_MS;
        if (!sameBurst) {
            undoStack.push({ text: committed, caret: lastCaret });
            if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
        }
        redoStack.length = 0;
        committed = md;
        lastCaret = caret;
        lastCommitAt = now;
        store.setContent(md);
    }

    /** DOM → store（立即），并取消待执行的防抖提交 */
    function serialize() {
        clearTimeout(debounceTimer);
        debounceTimer = null;
        if (!rendered) return;
        el.classList.toggle('is-empty', !el.textContent.trim());
        commit(htmlToMd(el));
    }

    /** 切换标签/视图/关闭前调用：把编辑中的内容刷进 store */
    function flush() {
        serialize();
    }

    function isRendered() {
        return rendered;
    }

    /** 渲染 store.content（重建 DOM，历史归零） */
    function render() {
        clearTimeout(debounceTimer);
        debounceTimer = null;
        rendered = true;
        const md = store.content;
        el.innerHTML = mdToHtml(md) || '<p><br></p>';
        el.classList.toggle('is-empty', !md.trim());
        committed = md;
        lastCaret = 0;
        lastCommitAt = 0;
        undoStack.length = 0;
        redoStack.length = 0;
    }

    function applySnapshot(snap) {
        committed = snap.text;
        lastCaret = snap.caret;
        lastCommitAt = 0;      // 断开连按，下一步编辑另起一个撤销步骤
        el.innerHTML = mdToHtml(snap.text) || '<p><br></p>';
        el.classList.toggle('is-empty', !snap.text.trim());
        store.setContent(snap.text);
        setCaretOffset(snap.caret);
        reportCursor();
    }

    function undo() {
        serialize();
        if (!undoStack.length) return false;
        redoStack.push({ text: committed, caret: caretOffset() });
        applySnapshot(undoStack.pop());
        return true;
    }

    function redo() {
        serialize();          // DOM 若与 committed 不一致，说明用户又编辑过，redo 栈已被 commit() 作废
        if (!redoStack.length) return false;
        undoStack.push({ text: committed, caret: caretOffset() });
        if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
        applySnapshot(redoStack.pop());
        return true;
    }

    // ── 即时渲染 ──
    /**
     * 删除块内开头的 len 个字符（跨文本节点，兼容 `# **bold**` 这类首子节点非文本的情况），
     * 并把光标回退到标记之后的位置——不能把光标传送到块末尾。
     */
    function stripMarkerPrefix(block, len, caretBefore) {
        if (!block) return;
        let remaining = len;
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let node;
        while (remaining > 0 && (node = walker.nextNode())) {
            const take = Math.min(remaining, node.textContent.length);
            node.deleteData(0, take);
            remaining -= take;
        }
        // 清掉被删空的文本节点，避免 DOM 里留下无意义空隙
        Array.from(block.childNodes).forEach((child) => {
            if (child.nodeType === Node.TEXT_NODE && !child.textContent) child.remove();
        });
        if (typeof caretBefore === 'number') setCaretOffset(Math.max(0, caretBefore - len));
    }

    /** 即时渲染：当前块以 Markdown 行首标记开头时，换块标签并剥离标记 */
    function autoFormatCurrentBlock(anchor) {
        // Markdown 模式关闭时，不自动转换块级元素（纯文本输入）
        if (!store.markdown) return;
        // rAF 期间用户可能已点选别处：只处理仍在编辑器内的捕获节点
        if (!anchor || !el.contains(anchor)) return;

        let node = getBlockFrom(anchor);

        // 裸文本节点场景：包裹成 <p> 再处理
        if (!node) {
            if (anchor.nodeType === Node.TEXT_NODE && anchor.parentNode === el) {
                const p = document.createElement('p');
                el.replaceChild(p, anchor);
                p.appendChild(anchor);
                node = p;
            } else {
                return;
            }
        }

        const tag = node.tagName.toLowerCase();
        const text = node.textContent;
        const caretBefore = caretOffset();
        let m;

        // 已格式化的块（标题/引用/列表项/代码）：若文本仍以标记开头，仅剥离标记，避免嵌套转换
        if (['h1', 'h2', 'h3', 'blockquote', 'li', 'pre'].includes(tag)) {
            const mm = text.match(/^(#{1,3}|[-*+]|\d+\.|>)\s+/);
            if (mm) {
                stripMarkerPrefix(node, mm[0].length, caretBefore);
                serialize();
            }
            return;
        }

        let markerLen = 0;
        let converted = false;

        if ((m = text.match(/^(#{1,3})\s+(.*)$/))) {
            if (!m[2]) return;                       // 仅有标记无内容时不转换（避开退化块态）
            if (tag === 'h' + m[1].length) return;
            converted = execBlock('formatBlock', 'h' + m[1].length);
            markerLen = m[0].length - m[2].length;
        }
        // 无序列表
        else if ((m = text.match(/^[-*+]\s+(.*)$/))) {
            if (!m[1]) return;
            converted = execBlock('insertUnorderedList');
            markerLen = m[0].length - m[1].length;
        }
        // 有序列表
        else if ((m = text.match(/^\d+\.\s+(.*)$/))) {
            if (!m[1]) return;
            converted = execBlock('insertOrderedList');
            markerLen = m[0].length - m[1].length;
        }
        // 引用
        else if ((m = text.match(/^>\s+(.*)$/))) {
            if (!m[1]) return;
            converted = execBlock('formatBlock', 'blockquote');
            markerLen = m[0].length - m[1].length;
        }

        if (!converted) return;
        stripMarkerPrefix(getBlockFrom(anchor) || node, markerLen, caretBefore);
        serialize();
    }

    function execBlock(command, value) {
        try {
            return document.execCommand(command, false, value === undefined ? null : value);
        } catch (err) {
            console.warn('[notepad] 块级命令失败：', command, err);
            return false;
        }
    }

    function onInput() {
        // 立即捕获光标锚点：rAF 时 window.getSelection() 可能已指向别处
        const anchor = window.getSelection()?.anchorNode || null;
        el.classList.toggle('is-empty', !el.textContent.trim());
        // 推迟到下一帧：等浏览器提交完本次输入再转换，避开退化块态与逐字插入竞争
        if (!formatScheduled) {
            formatScheduled = true;
            formatFrame = requestAnimationFrame(() => {
                formatScheduled = false;
                autoFormatCurrentBlock(anchor);
            });
        }
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(serialize, DEBOUNCE);
        reportCursor();
    }

    /** 粘贴一律按纯文本插入：剪贴板 HTML 不进 DOM，避免绕过 serializer 的转义 */
    function onPaste(e) {
        const text = e.clipboardData && e.clipboardData.getData('text/plain');
        if (text === '' || text == null) return;
        e.preventDefault();
        beginStep();
        document.execCommand('insertText', false, text);
        serialize();
    }

    function onBlur() {
        serialize();
    }

    el.addEventListener('input', onInput);
    el.addEventListener('paste', onPaste);
    el.addEventListener('blur', onBlur);
    el.addEventListener('keyup', reportCursor);
    el.addEventListener('mouseup', reportCursor);

    // ── 编辑命令 ──
    /** 命令式改动先落一次快照，让撤销栈以「整步」为单位 */
    function beginStep() {
        serialize();
        lastCommitAt = 0;
    }

    function exec(command, value = null) {
        beginStep();
        el.focus();
        execBlock(command, value);
        serialize();
    }

    function insertHtml(html) {
        beginStep();
        el.focus();
        execBlock('insertHTML', html);
        serialize();
        reportCursor();
    }

    /** 设置标题级别（h1/h2/h3，重复点击降级为段落） */
    function heading(level) {
        beginStep();
        el.focus();
        const current = getCurrentBlockTag();
        execBlock('formatBlock', current === 'h' + level ? 'p' : 'h' + level);
        serialize();
        reportCursor();
    }

    /** 获取光标所在块级标签名 */
    function getCurrentBlockTag() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return 'p';
        let node = sel.anchorNode;
        while (node && node !== el) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName.toLowerCase();
                if (['p', 'h1', 'h2', 'h3', 'blockquote', 'li', 'pre', 'div'].includes(tag)) return tag;
            }
            node = node.parentNode;
        }
        return 'p';
    }

    /** 插入代码块 */
    function codeBlock() {
        insertHtml('<pre><code>\n\n</code></pre><p><br></p>');
    }

    /** 插入引用块 */
    function quote() {
        exec('formatBlock', 'blockquote');
    }

    /** 插入链接（弹窗输入是异步的，工具栏不 await，异常在本地收敛） */
    function link() {
        promptBox(t('linkPrompt', '输入链接地址：'), t('linkHint', '支持 http/https 链接'), 'https://')
            .then((input) => {
                if (!input) return;
                const url = safeUrl(input);
                if (!url) { notifyUnsafeUrl(); return; }
                const sel = window.getSelection();
                const text = sel && sel.toString() ? sel.toString() : url;
                insertHtml(`<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`);
            })
            .catch((err) => console.warn('[notepad] 插入链接失败：', err));
    }

    /** 插入图片 */
    function image() {
        promptBox(t('imagePrompt', '输入图片地址：'), t('imageHint', 'http/https 或 data:image 图片地址'), '')
            .then((input) => {
                if (!input) return;
                const url = safeUrl(input, { allowDataImage: true });
                if (!url) { notifyUnsafeUrl(); return; }
                insertHtml(`<img src="${escapeHtml(url)}" alt="">`);
            })
            .catch((err) => console.warn('[notepad] 插入图片失败：', err));
    }

    function notifyUnsafeUrl() {
        alertBox(t('badUrlTitle', '无法插入'), t('badUrl', '仅支持 http/https/mailto 链接与图片 data URI'));
    }

    /** 插入分割线 */
    function hr() {
        insertHtml('<hr><p><br></p>');
    }

    /** 插入 2×2 表格 */
    function table() {
        const head = t('tableHeader', '表头');
        const cell = t('tableCell', '单元格');
        insertHtml(
            `<table><thead><tr><th>${head} 1</th><th>${head} 2</th></tr></thead>`
            + `<tbody><tr><td>${cell}</td><td>${cell}</td></tr>`
            + `<tr><td>${cell}</td><td>${cell}</td></tr></tbody></table><p><br></p>`
        );
    }

    function dispose() {
        clearTimeout(debounceTimer);
        if (formatFrame) cancelAnimationFrame(formatFrame);
        el.removeEventListener('input', onInput);
        el.removeEventListener('paste', onPaste);
        el.removeEventListener('blur', onBlur);
        el.removeEventListener('keyup', reportCursor);
        el.removeEventListener('mouseup', reportCursor);
        undoStack.length = 0;
        redoStack.length = 0;
        rendered = false;
    }

    return {
        el,
        render,
        flush,
        serialize,
        isRendered,
        focus: () => el.focus(),
        undo,
        redo,
        cursorInfo,
        reportCursor,
        dispose,
        bold: () => exec('bold'),
        italic: () => exec('italic'),
        strike: () => exec('strikeThrough'),
        heading,
        codeBlock,
        quote,
        unorderedList: () => exec('insertUnorderedList'),
        orderedList: () => exec('insertOrderedList'),
        link,
        image,
        hr,
        table,
        /** 查找替换：选中匹配项 */
        selectRange: (range) => {
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            el.focus();
        },
        /** 查找替换：用纯文本替换当前选区（保留原生/自维护撤销语义） */
        replaceSelection: (text) => {
            beginStep();
            el.focus();
            execBlock('insertText', text);
            serialize();
        },
    };
}
