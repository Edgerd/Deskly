/**
 * finder-search.js — 访达搜索（macOS 15 展开式搜索框）
 *
 * 点击放大镜展开输入框并聚焦；输入防抖后写入 FinderState.searchQuery，
 * 由 finder-views 按当前目录条目实时过滤。Esc 或再次点击收起并清空。
 */

import { FinderState } from './finder-state.js';

const FinderSearch = (() => {
    let searchWrap = null, searchInput = null, toggleBtn = null;
    let debounce = null; // 防抖计时器

    /** @type {Function[]} 资源释放回调（重开窗口 / plugin-unload 时执行） */
    let disposers = [];

    /** 登记一个释放回调。 */
    function track(fn) { disposers.push(fn); }

    /** 执行并清空全部释放回调（可重复调用）：清计时器 + 摘监听，避免计时器写入已脱离文档的 DOM。 */
    function dispose() {
        clearTimeout(debounce);
        debounce = null;
        const list = disposers;
        disposers = [];
        list.forEach(fn => fn());
    }

    /**
     * 初始化搜索。
     */
    function init() {
        dispose();

        searchWrap = document.querySelector('.tb-search');
        searchInput = document.getElementById('finder-search');
        toggleBtn = document.getElementById('search-toggle');

        const onToggle = (e) => {
            e.stopPropagation();
            searchWrap?.classList.contains('expanded') ? collapse() : expand();
        };
        toggleBtn?.addEventListener('click', onToggle);
        track(() => toggleBtn?.removeEventListener('click', onToggle));

        if (searchInput) {
            const onInput = () => {
                clearTimeout(debounce);
                debounce = setTimeout(() => {
                    FinderState.setSearch(searchInput.value.trim());
                }, 280);
            };
            const onKeydown = (e) => {
                if (e.key === 'Escape') {
                    e.stopPropagation();
                    collapse();
                }
            };
            searchInput.addEventListener('input', onInput);
            searchInput.addEventListener('keydown', onKeydown);
            track(() => searchInput.removeEventListener('input', onInput));
            track(() => searchInput.removeEventListener('keydown', onKeydown));
        }
    }

    /** 展开搜索框 */
    function expand() {
        if (!searchWrap) return;
        searchWrap.classList.add('expanded');
        if (searchInput) {
            searchInput.focus();
            // 选中已有内容便于覆盖
            searchInput.select();
        }
    }

    /** 收起并清空搜索 */
    function collapse() {
        searchWrap?.classList.remove('expanded');
        if (searchInput) {
            searchInput.value = '';
            searchInput.blur();
        }
        FinderState.setSearch('');
    }

    return { init, dispose };
})();

export { FinderSearch };
