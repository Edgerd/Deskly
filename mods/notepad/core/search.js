/**
 * search.js — 查找 / 替换（规划 §7-P1、§9 验收项）
 * 三种视图都可查找：源码/分屏直接操作 textarea，所见即所得按文本节点构造 Range。
 * 面板 DOM 在 index.html 内声明（.search-bar），本模块只做显隐与匹配逻辑。
 */

import { i18n } from '../../../src/javascripts/i18n.js';

const MAX_PASSES = 2000;   // 全部替换的兜底次数：替换词包含查找词时防止无限循环

function t(key, fallback) {
    return i18n.t('notepad.' + key, fallback);
}

/** 大小写不敏感匹配（不预先整体 toLowerCase：某些字符会改变长度，偏移会错位） */
function matchAt(text, idx, needle) {
    return text.slice(idx, idx + needle.length).toLowerCase() === needle.toLowerCase();
}

function searchForward(text, needle, from) {
    if (!needle) return -1;
    for (let i = Math.max(0, from); i + needle.length <= text.length; i++) {
        if (matchAt(text, i, needle)) return i;
    }
    return -1;
}

function searchBackward(text, needle, from) {
    if (!needle) return -1;
    for (let i = Math.min(from, text.length - needle.length); i >= 0; i--) {
        if (matchAt(text, i, needle)) return i;
    }
    return -1;
}

function countMatches(text, needle) {
    if (!needle) return 0;
    let n = 0;
    let at = searchForward(text, needle, 0);
    while (at !== -1 && n < MAX_PASSES) {
        n++;
        at = searchForward(text, needle, at + needle.length);
    }
    return n;
}

/** 收集元素内文本节点及其起始偏移（所见即所得的纯文本坐标） */
function collectText(el) {
    const nodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let text = '';
    let node;
    while ((node = walker.nextNode())) {
        if (!node.textContent) continue;
        nodes.push({ node, start: text.length });
        text += node.textContent;
    }
    return { text, nodes };
}

/** 纯文本偏移 → DOM 位置 */
function locate(nodes, pos) {
    for (let i = 0; i < nodes.length; i++) {
        const entry = nodes[i];
        const len = entry.node.textContent.length;
        if (pos <= entry.start + len) return { node: entry.node, offset: pos - entry.start };
    }
    const last = nodes[nodes.length - 1];
    return last ? { node: last.node, offset: last.node.textContent.length } : null;
}

/** 当前选区在纯文本坐标下的起止（选区不在编辑器内时返回 null） */
function domSelection(el) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
    return {
        start: domOffset(el, range.startContainer, range.startOffset),
        end: domOffset(el, range.endContainer, range.endOffset),
        text: range.toString(),
    };
}

function domOffset(el, node, offset) {
    try {
        const r = document.createRange();
        r.selectNodeContents(el);
        r.setEnd(node, offset);
        return r.toString().length;
    } catch (err) {
        return 0;
    }
}

/** 在所见即所得 DOM 中按纯文本偏移选中 [s, e) */
function domSelect(el, editor, s, e) {
    const { nodes } = collectText(el);
    const from = locate(nodes, s);
    const to = locate(nodes, e);
    if (!from || !to) return;
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    editor.selectRange(range);
}

export function createSearch(root, { store, resolveTarget }) {
    const bar = root.querySelector('.search-bar');
    const findInput = bar.querySelector('.search-input');
    const replaceInput = bar.querySelector('.replace-input');
    const countEl = bar.querySelector('.search-count');
    const btnPrev = bar.querySelector('.btn-search-prev');
    const btnNext = bar.querySelector('.btn-search-next');
    const btnReplace = bar.querySelector('.btn-replace');
    const btnReplaceAll = bar.querySelector('.btn-replace-all');
    const btnClose = bar.querySelector('.btn-search-close');

    /**
     * 统一适配器：三种视图收敛成「取文本 / 取选区 / 选中 / 替换」。
     * resolveTarget() 由 script.js 提供，返回当前视图的可编辑目标。
     */
    function adapter() {
        const tg = resolveTarget();
        if (!tg) return null;

        if (tg.kind === 'textarea') {
            const ta = tg.el;
            return {
                getText: () => ta.value,
                getSelection: () => ({
                    start: ta.selectionStart,
                    end: ta.selectionEnd,
                    text: ta.value.slice(ta.selectionStart, ta.selectionEnd),
                }),
                select: (s, e) => { ta.focus(); ta.setSelectionRange(s, e); },
                replace: (s, e, text) => {
                    ta.focus();
                    ta.setRangeText(text, s, e, 'end');
                    tg.afterChange();
                },
                focus: () => ta.focus(),
            };
        }

        const el = tg.el;
        const select = (s, e) => domSelect(el, tg.editor, s, e);
        return {
            getText: () => collectText(el).text,
            getSelection: () => domSelection(el),
            select,
            // 走编辑器的 insertText 通道，替换才会进入自维护的撤销栈
            replace: (s, e, text) => {
                select(s, e);
                tg.editor.replaceSelection(text);
            },
            focus: () => tg.editor.focus(),
        };
    }

    function updateCount(text, activeAt) {
        const needle = findInput.value;
        if (!needle) { countEl.textContent = ''; return; }
        const total = countMatches(text, needle);
        if (!total) { countEl.textContent = t('noMatch', '无匹配'); return; }
        const active = activeAt < 0 ? 0 : countActive(text, needle, activeAt);
        countEl.textContent = `${active}/${total}`;
    }

    function countActive(text, needle, at) {
        let n = 0;
        let pos = searchForward(text, needle, 0);
        while (pos !== -1 && pos <= at && n < MAX_PASSES) {
            n++;
            pos = searchForward(text, needle, pos + needle.length);
        }
        return n;
    }

    function find(backwards) {
        const a = adapter();
        if (!a) return;
        const needle = findInput.value;
        if (!needle) { countEl.textContent = ''; return; }
        const text = a.getText();
        const sel = a.getSelection();
        const from = sel ? (backwards ? sel.start - 1 : sel.end) : 0;
        let at = backwards ? searchBackward(text, needle, from) : searchForward(text, needle, from);
        if (at === -1) at = backwards ? searchBackward(text, needle, text.length) : searchForward(text, needle, 0);
        if (at === -1) { updateCount(text, -1); return; }
        a.select(at, at + needle.length);
        updateCount(a.getText(), at);
    }

    function replaceOne() {
        const a = adapter();
        if (!a) return;
        const needle = findInput.value;
        if (!needle) return;
        const sel = a.getSelection();
        // 仅当当前选区正好是一个匹配项时替换，否则只跳到下一处
        if (sel && sel.text.toLowerCase() === needle.toLowerCase()) {
            a.replace(sel.start, sel.end, replaceInput.value);
        }
        find(false);
    }

    function replaceAll() {
        const a = adapter();
        if (!a) return;
        const needle = findInput.value;
        if (!needle) return;
        const value = replaceInput.value;
        let cursor = 0;
        for (let guard = 0; guard < MAX_PASSES; guard++) {
            const text = a.getText();
            const at = searchForward(text, needle, cursor);
            if (at === -1) break;
            a.replace(at, at + needle.length, value);
            cursor = at + value.length;
        }
        updateCount(a.getText(), -1);
    }

    function open() {
        bar.hidden = false;
        findInput.focus();
        findInput.select();
        const a = adapter();
        if (a) updateCount(a.getText(), -1);
    }

    function close() {
        bar.hidden = true;
        const a = adapter();
        if (a) a.focus();
    }

    function toggle() {
        if (bar.hidden) open(); else close();
    }

    const refreshCount = () => {
        if (bar.hidden) return;
        const a = adapter();
        if (a) updateCount(a.getText(), -1);
    };

    const onFindKeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); find(e.shiftKey); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    };
    const onReplaceKeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); replaceOne(); find(false); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    };

    const listeners = [
        [btnNext, 'click', () => find(false)],
        [btnPrev, 'click', () => find(true)],
        [btnReplace, 'click', replaceOne],
        [btnReplaceAll, 'click', replaceAll],
        [btnClose, 'click', close],
        [findInput, 'input', refreshCount],
        [findInput, 'keydown', onFindKeydown],
        [replaceInput, 'keydown', onReplaceKeydown],
    ];
    listeners.forEach(([el, type, fn]) => el.addEventListener(type, fn));

    // 外部改动内容（切标签 / 撤销）后刷新计数
    const unsubscribe = store.subscribe('content-changed', refreshCount);

    function dispose() {
        listeners.forEach(([el, type, fn]) => el.removeEventListener(type, fn));
        unsubscribe();
        bar.hidden = true;
    }

    return { open, close, toggle, dispose, isOpen: () => !bar.hidden };
}
