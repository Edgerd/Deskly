/**
 * finder-quicklook.js — 访达 Quick Look 预览（macOS 15 还原）
 *
 * 支持图片、文本预览。通过 'quicklook-navigate' 事件向 script.js 请求加载上/下一项。
 * 预览用的对象 URL 由本模块托管：换项 / 关闭 / 卸载时回收，否则每次预览都泄漏一个 Blob。
 */

import { i18n } from '../../src/javascripts/i18n.js';

const FinderQuickLook = (() => {    let qlEl = null, qlContent = null, qlName = null, qlCounter = null, qlClose = null, qlPrev = null, qlNext = null;
    let finderEl = null;
    let items = []; // 渲染后的条目列表（决定计数与上下翻页顺序）
    let currentIndex = 0; // 当前索引
    let ownedUrl = null; // 本次预览创建的对象 URL，需在替换/关闭时 revoke

    /** @type {Function[]} 资源释放回调（重开窗口 / plugin-unload 时执行） */
    let disposers = [];

    /** 登记一个释放回调。 */
    function track(fn) { disposers.push(fn); }

    /** 执行并清空全部释放回调（可重复调用）。 */
    function dispose() {
        releaseUrl();
        const list = disposers;
        disposers = [];
        list.forEach(fn => fn());
    }

    /** 回收当前持有的对象 URL。 */
    function releaseUrl() {
        if (ownedUrl) {
            URL.revokeObjectURL(ownedUrl);
            ownedUrl = null;
        }
    }

    /** 初始化 Quick Look。 */
    function init() {
        dispose();

        qlEl = document.getElementById('finder-quicklook');
        qlContent = document.getElementById('ql-content');
        qlName = document.getElementById('ql-name');
        qlCounter = document.getElementById('ql-counter');
        qlClose = document.getElementById('ql-close');
        qlPrev = document.getElementById('ql-nav-prev');
        qlNext = document.getElementById('ql-nav-next');
        finderEl = qlEl ? qlEl.closest('.finder.window') : null;

        const onClose = () => hide();
        const onBackdrop = (e) => {
            if (e.target === qlEl || e.target.closest('.ql-backdrop')) hide();
        };
        const onPrev = () => navigate(-1);
        const onNext = () => navigate(1);
        qlClose?.addEventListener('click', onClose);
        qlEl?.addEventListener('click', onBackdrop);
        qlPrev?.addEventListener('click', onPrev);
        qlNext?.addEventListener('click', onNext);
        track(() => qlClose?.removeEventListener('click', onClose));
        track(() => qlEl?.removeEventListener('click', onBackdrop));
        track(() => qlPrev?.removeEventListener('click', onPrev));
        track(() => qlNext?.removeEventListener('click', onNext));

        const onQuickLookKeydown = (e) => {
            if (!qlEl || qlEl.hidden) return;
            const t = e.target;
            // 输入框里的按键属于打字：在 #finder-search 里敲方向键不该翻预览
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
            // 焦点在别的窗口里时不抢它的方向键
            if (t && t !== document.body && finderEl && !finderEl.contains(t)) return;
            // 快捷键处理同样挂在 document 上：stopPropagation 拦不住同节点监听，用 stopImmediatePropagation
            if (e.key === 'Escape') { e.stopImmediatePropagation(); hide(); return; }
            if (e.key === 'ArrowLeft') { e.stopImmediatePropagation(); e.preventDefault(); navigate(-1); return; }
            if (e.key === 'ArrowRight') { e.stopImmediatePropagation(); e.preventDefault(); navigate(1); }
        };
        document.addEventListener('keydown', onQuickLookKeydown);
        track(() => document.removeEventListener('keydown', onQuickLookKeydown));
    }

    /** 不支持预览时的占位节点（纯 DOM 构造，无需转义）。 */
    function unsupportedNode() {
        const div = document.createElement('div');
        div.className = 'ql-unsupported';
        div.textContent = i18n.t('finder.unsupportedPreview', '暂不支持预览该类型文件');
        return div;
    }

    /**
     * 显示预览。
     * @param {object} options
     * @param {string} options.name 文件名
     * @param {string} [options.content] HTML 内容
     * @param {string} [options.objectUrl] content 中用到的对象 URL（由本模块负责 revoke）
     * @param {Array} [options.allItems] 渲染后的条目列表（用于导航）
     * @param {number} [options.index] 当前索引
     */
    function show(options) {
        if (!qlEl || !qlContent || !qlName) return;
        const { name, content, objectUrl, allItems, index } = options;
        // 先回收上一项的 URL，再替换 innerHTML（旧 img 节点已脱离文档，onload 不会再触发）
        releaseUrl();
        ownedUrl = objectUrl || null;
        items = allItems || [];
        currentIndex = index !== undefined ? index : 0;

        qlName.textContent = name;
        if (content) qlContent.innerHTML = content;
        else { qlContent.innerHTML = ''; qlContent.appendChild(unsupportedNode()); }

        updateCounter();
        updateNavButtons();
        qlEl.hidden = false;
    }

    /** 隐藏预览。 */
    function hide() {
        if (!qlEl) return;
        qlEl.hidden = true;
        releaseUrl();
        if (qlContent) qlContent.innerHTML = '';
    }

    /** 预览是否正在显示。 */
    function isOpen() {
        return !!qlEl && !qlEl.hidden;
    }

    /**
     * 导航到上/下一个项目。
     * @param {number} direction -1 或 1
     */
    function navigate(direction) {
        if (!items.length) return;
        const newIndex = currentIndex + direction;
        if (newIndex < 0 || newIndex >= items.length) return;
        currentIndex = newIndex;
        const item = items[currentIndex];
        const event = new CustomEvent('quicklook-navigate', { detail: { item, index: currentIndex, items } });
        document.dispatchEvent(event);
    }

    /** 更新计数器。 */
    function updateCounter() {
        if (qlCounter) qlCounter.textContent = items.length ? `${currentIndex + 1} / ${items.length}` : '1 / 1';
    }

    /** 更新导航按钮状态。 */
    function updateNavButtons() {
        if (qlPrev) qlPrev.classList.toggle('disabled', currentIndex <= 0);
        if (qlNext) qlNext.classList.toggle('disabled', currentIndex >= items.length - 1);
    }

    return { init, show, isOpen, dispose };
})();

export { FinderQuickLook };
