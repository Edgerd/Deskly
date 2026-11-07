/**
 * finder-search.js — 展开式搜索框：输入防抖写入 FinderState.searchQuery 供 finder-views 实时过滤；Esc / 再次点击收起并清空。
 */

import { FinderState } from './finder-state.js';

const FinderSearch = (() => {
    let searchWrap = null, searchInput = null, toggleBtn = null;
    let debounce = null;

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

    function expand() {
        if (!searchWrap) return;
        searchWrap.classList.add('expanded');
        if (searchInput) {
            searchInput.focus();
            // 选中已有内容便于覆盖
            searchInput.select();
        }
    }

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
