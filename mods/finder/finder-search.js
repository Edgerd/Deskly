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

    /**
     * 初始化搜索。
     */
    function init() {
        searchWrap = document.querySelector('.tb-search');
        searchInput = document.getElementById('finder-search');
        toggleBtn = document.getElementById('search-toggle');

        toggleBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            searchWrap?.classList.contains('expanded') ? collapse() : expand();
        });

        if (searchInput) {
            searchInput.addEventListener('input', () => {
                clearTimeout(debounce);
                debounce = setTimeout(() => {
                    FinderState.setSearch(searchInput.value.trim());
                }, 280);
            });
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    e.stopPropagation();
                    collapse();
                }
            });
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

    return { init, expand, collapse };
})();

export { FinderSearch };
