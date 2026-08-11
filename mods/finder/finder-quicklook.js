/**
 * finder-quicklook.js — 访达 Quick Look 预览（macOS 15 还原）
 *
 * 支持图片、文本预览。通过 'quicklook-navigate' 事件向 script.js 请求加载上/下一项。
 */

const FinderQuickLook = (() => {
    let qlEl = null, qlContent = null, qlName = null, qlCounter = null, qlClose = null, qlPrev = null, qlNext = null;
    let items = []; // 全部条目
    let currentIndex = 0; // 当前索引

    /** 初始化 Quick Look。 */
    function init() {
        qlEl = document.getElementById('finder-quicklook');
        qlContent = document.getElementById('ql-content');
        qlName = document.getElementById('ql-name');
        qlCounter = document.getElementById('ql-counter');
        qlClose = document.getElementById('ql-close');
        qlPrev = document.getElementById('ql-nav-prev');
        qlNext = document.getElementById('ql-nav-next');

        qlClose?.addEventListener('click', hide);
        qlEl?.addEventListener('click', (e) => {
            if (e.target === qlEl || e.target.closest('.ql-backdrop')) hide();
        });
        qlPrev?.addEventListener('click', () => navigate(-1));
        qlNext?.addEventListener('click', () => navigate(1));

        const onQuickLookKeydown = (e) => {
            if (!qlEl || qlEl.hidden) return;
            if (e.key === 'Escape') hide();
            if (e.key === 'ArrowLeft') navigate(-1);
            if (e.key === 'ArrowRight') navigate(1);
        };
        document.addEventListener('keydown', onQuickLookKeydown);

        // 资源释放：访达窗口关闭时移除本模块注册的全局监听，避免常驻内存
        const onQuickLookUnload = (e) => {
            if (e.detail.id !== 'finder') return;
            window.removeEventListener('plugin-unload', onQuickLookUnload);
            document.removeEventListener('keydown', onQuickLookKeydown);
        };
        window.addEventListener('plugin-unload', onQuickLookUnload);
    }

    /**
     * 显示预览。
     * @param {object} options
     * @param {string} options.name 文件名
     * @param {string} [options.content] HTML 内容
     * @param {Array} [options.allItems] 全部条目列表（用于导航）
     * @param {number} [options.index] 当前索引
     */
    function show(options) {
        if (!qlEl || !qlContent || !qlName) return;
        const { name, content, allItems, index } = options;
        items = allItems || [];
        currentIndex = index !== undefined ? index : 0;

        qlName.textContent = name;
        qlContent.innerHTML = content || '<div class="ql-unsupported">暂不支持预览该类型文件</div>';

        updateCounter();
        updateNavButtons();
        qlEl.hidden = false;
    }

    /** 隐藏预览。 */
    function hide() {
        if (qlEl) qlEl.hidden = true;
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

    return { init, show, hide, navigate };
})();

export { FinderQuickLook };
