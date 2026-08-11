/**
 * editor-wysiwyg.js — 所见即所得编辑器内核
 * 基于 contentEditable，配合 markdown.js 做 MD ↔ HTML 双向转换。
 * 支持轻量即时渲染：输入 # / - / > 等行首标记时实时转换块级元素。
 */

import { mdToHtml, htmlToMd } from '../features/markdown.js?v=0.2.60';

export function createWysiwygEditor(el, { store }) {
    let debounceTimer = null;

    /** 渲染 store.content 到编辑器（空内容保证一个可聚焦块，并显示占位符） */
    function render() {
        const html = mdToHtml(store.content);
        el.innerHTML = html || '<p><br></p>';
        el.classList.toggle('is-empty', !store.content.trim());
    }

    /** 序列化当前 DOM → store.content */
    function serialize() {
        store.setContent(htmlToMd(el));
    }

    let formatScheduled = false;
    function onInput() {
        // 推迟到下一帧：等浏览器提交完本次输入再转换，避开退化块态与逐字插入竞争
        if (!formatScheduled) {
            formatScheduled = true;
            requestAnimationFrame(() => {
                formatScheduled = false;
                autoFormatCurrentBlock();
            });
        }
        el.classList.toggle('is-empty', !el.textContent.trim());
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(serialize, 300);
    }

    el.addEventListener('input', onInput);

    /** 定位光标所在块级元素 */
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

    /** 把光标放到块末尾 */
    function placeCursorEnd(block) {
        const r = document.createRange();
        r.selectNodeContents(block);
        r.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
    }

    /** 删除块内首个文本节点的前缀标记（len 个字符），光标置于块末尾 */
    function stripMarkerPrefix(block, len) {
        if (!block) return;
        const tn = block.firstChild;
        if (!tn || tn.nodeType !== Node.TEXT_NODE) return;
        const range = document.createRange();
        range.setStart(tn, 0);
        range.setEnd(tn, Math.min(len, tn.textContent.length));
        range.deleteContents();
        placeCursorEnd(block);
    }

    /** 即时渲染：当前块以 Markdown 行首标记开头时，移动子节点换块标签（保留文本，剥离标记） */
    function autoFormatCurrentBlock() {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        let node = getBlockFrom(sel.anchorNode);

        // 裸文本节点场景：包裹成 <p> 再处理
        if (!node) {
            const anchor = sel.anchorNode;
            if (anchor && anchor.nodeType === Node.TEXT_NODE && anchor.parentNode === el) {
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
        let m;

        // 已格式化的块（标题/引用/列表项等）：若文本以标记开头，仅剥离标记，避免嵌套转换
        if (['h1', 'h2', 'h3', 'blockquote', 'ul', 'ol', 'li', 'pre'].includes(tag)) {
            const mm = text.match(/^(#{1,3}|[-*+]|\d+\.|>)\s+/);
            if (mm) stripMarkerPrefix(node, mm[0].length);
            return;
        }

        // 标题（h1-h3）：原生命令转换块标签（原子操作，不分离节点），再 Range 剥离标记
        if ((m = text.match(/^(#{1,3})\s+(.*)$/))) {
            if (!m[2]) return; // 仅有标记无内容时不转换（避开退化块态）
            if (tag === 'h' + m[1].length) return;
            document.execCommand('formatBlock', false, 'h' + m[1].length);
            stripMarkerPrefix(getBlockFrom(sel.anchorNode), m[0].length - m[m.length - 1].length);
        }
        // 无序列表
        else if ((m = text.match(/^[-*+]\s+(.*)$/))) {
            if (!m[1]) return;
            document.execCommand('insertUnorderedList');
            stripMarkerPrefix(getBlockFrom(sel.anchorNode), m[0].length - m[m.length - 1].length);
        }
        // 有序列表
        else if ((m = text.match(/^\d+\.\s+(.*)$/))) {
            if (!m[1]) return;
            document.execCommand('insertOrderedList');
            stripMarkerPrefix(getBlockFrom(sel.anchorNode), m[0].length - m[m.length - 1].length);
        }
        // 引用
        else if ((m = text.match(/^>\s+(.*)$/))) {
            if (!m[1]) return;
            document.execCommand('formatBlock', false, 'blockquote');
            stripMarkerPrefix(getBlockFrom(sel.anchorNode), m[0].length - m[m.length - 1].length);
        }
    }

    /** 执行 execCommand 类命令并同步 */
    function exec(command, value = null) {
        el.focus();
        document.execCommand(command, false, value);
        serialize();
    }

    /** 插入 HTML 片段到光标处 */
    function insertHtml(html) {
        el.focus();
        document.execCommand('insertHTML', false, html);
        serialize();
    }

    /** 设置标题级别（h1/h2/h3，重复点击降级为段落） */
    function heading(level) {
        el.focus();
        const current = getCurrentBlockTag();
        if (current === 'h' + level) {
            document.execCommand('formatBlock', false, 'p');
        } else {
            document.execCommand('formatBlock', false, 'h' + level);
        }
        serialize();
    }

    /** 获取光标所在块级标签名 */
    function getCurrentBlockTag() {
        const sel = window.getSelection();
        if (!sel.rangeCount) return 'p';
        let node = sel.anchorNode;
        while (node && node !== el) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName.toLowerCase();
                if (['p', 'h1', 'h2', 'h3', 'blockquote', 'li', 'pre', 'div'].includes(tag)) {
                    return tag;
                }
            }
            node = node.parentNode;
        }
        return 'p';
    }

    /** 插入代码块 */
    function codeBlock() {
        insertHtml('<pre><code>\n\n</code></pre><br>');
    }

    /** 插入引用块 */
    function quote() {
        exec('formatBlock', 'blockquote');
    }

    /** 插入链接 */
    function link() {
        const url = prompt('输入链接地址：', 'https://');
        if (!url) return;
        const sel = window.getSelection();
        const text = sel.toString() || url;
        insertHtml(`<a href="${url}">${text}</a>`);
    }

    /** 插入图片 */
    function image() {
        const url = prompt('输入图片地址（URL 或 data:）：', '');
        if (!url) return;
        insertHtml(`<img src="${url}" alt="">`);
    }

    /** 插入分割线 */
    function hr() {
        insertHtml('<hr><p><br></p>');
    }

    /** 插入 2×2 表格 */
    function table() {
        insertHtml(
            '<table><thead><tr><th>表头 1</th><th>表头 2</th></tr></thead>' +
            '<tbody><tr><td>单元格</td><td>单元格</td></tr>' +
            '<tr><td>单元格</td><td>单元格</td></tr></tbody></table><p><br></p>'
        );
    }

    return {
        render,
        serialize,
        setMd: (md) => { el.innerHTML = mdToHtml(md); },
        getMd: () => htmlToMd(el),
        focus: () => el.focus(),
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
    };
}
