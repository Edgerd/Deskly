/**
 * finder-search.js — 展开式搜索框（F-36）：
 *  - 输入防抖写入 FinderState.searchQuery 供 finder-views 实时过滤当前目录（即时反馈）；
 *  - 同时启动递归搜索（fs.walkAt，结果上限 200），完成后 FinderState.setSearchResults 全量替换；
 *  - 范围切换：当前文件夹 / 整个 Deskly（按钮循环切换，finder-settings 持久化）；
 *  - Esc / 再次点击收起并清空；导航后自动取消进行中的搜索任务（seq 令牌）。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { FinderState } from './finder-state.js';
import { FinderSettings } from './finder-settings.js';

const Deskly = () => window.Deskly;
const SEARCH_CAP = 200;    // 递归结果上限（保真清单 F-36 点名）
const SCOPE_KEY = 'finder.searchScope';

const FinderSearch = (() => {
    let searchWrap = null, searchInput = null, toggleBtn = null, scopeBtn = null;
    let debounce = null;
    /** 搜索任务序号：导航 / 清空后旧任务作废，不得写入新状态 */
    let seq = 0;
    /** 搜索发起时的目录（「当前文件夹」范围的根） */
    let searchRoot = '/';

    /** @type {Function[]} 资源释放回调（重开窗口 / plugin-unload 时执行） */
    let disposers = [];

    /** 登记一个释放回调。 */
    function track(fn) { disposers.push(fn); }

    /** 执行并清空全部释放回调（可重复调用）：清计时器 + 摘监听，避免计时器写入已脱离文档的 DOM。 */
    function dispose() {
        clearTimeout(debounce);
        debounce = null;
        seq++;
        FinderState.setSearchResults(null);
        const list = disposers;
        disposers = [];
        list.forEach(fn => fn());
    }

    function init() {
        dispose();

        searchWrap = document.querySelector('.tb-search');
        searchInput = document.getElementById('finder-search');
        toggleBtn = document.getElementById('search-toggle');
        scopeBtn = document.getElementById('search-scope');

        const onToggle = (e) => {
            e.stopPropagation();
            searchWrap?.classList.contains('expanded') ? collapse() : expand();
        };
        toggleBtn?.addEventListener('click', onToggle);
        track(() => toggleBtn?.removeEventListener('click', onToggle));

        // 范围切换（F-36）：循环 当前文件夹 ⇄ 整个 Deskly
        const onScope = (e) => {
            e.stopPropagation();
            const next = FinderSettings.get(SCOPE_KEY) === 'disk' ? 'folder' : 'disk';
            FinderSettings.set(SCOPE_KEY, next);
            syncScope();
            const q = (searchInput?.value || '').trim();
            if (q) FinderState.setSearch(q), runRecursive(q);
        };
        scopeBtn?.addEventListener('click', onScope);
        track(() => scopeBtn?.removeEventListener('click', onScope));

        // 导航后：取消进行中的递归搜索，并把范围根切到新目录
        track(FinderState.on('path-changed', (path) => {
            seq++;
            searchRoot = path || '/';
            const q = (searchInput?.value || '').trim();
            if (!q) return;
            FinderState.setSearchResults(null);
            runRecursive(q);
        }));

        syncScope();

        if (searchInput) {
            const onInput = () => {
                clearTimeout(debounce);
                debounce = setTimeout(() => {
                    const q = searchInput.value.trim();
                    FinderState.setSearch(q);
                    if (q) runRecursive(q);
                    else FinderState.setSearchResults(null);
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

    /** 范围按钮文案与状态同步。 */
    function syncScope() {
        if (!scopeBtn) return;
        const disk = FinderSettings.get(SCOPE_KEY) === 'disk';
        scopeBtn.textContent = disk
            ? i18n.t('finder.searchScopeDisk', '整个 Deskly')
            : i18n.t('finder.searchScopeFolder', '当前文件夹');
        scopeBtn.title = i18n.t('finder.searchScopeTitle', '点击切换搜索范围');
        scopeBtn.classList.toggle('scope-disk', disk);
    }

    /**
     * 递归搜索：walkAt(当前文件夹, 4 层) 或 walkAt('/', 6 层)，按名称包含过滤，200 条封顶。
     * 只吞超时/权限类失败，把能拿到的部分留给用户（结果集为空就回落当前目录过滤）。
     */
    async function runRecursive(query) {
        const mySeq = ++seq;
        const root = FinderSettings.get(SCOPE_KEY) === 'disk' ? '/' : searchRoot;
        const depth = root === '/' ? 6 : 4;
        try {
            const list = await Deskly().fs.walkAt(root, depth);
            if (mySeq !== seq) return;
            const q = query.toLowerCase();
            const hits = (list || [])
                .filter((e) => (e.name || '').toLowerCase().includes(q))
                .slice(0, SEARCH_CAP);
            FinderState.setSearchResults(hits);
        } catch (err) {
            if (mySeq !== seq) return;
            // 递归失败不弹窗：当前目录的即时过滤仍在，避免一次 IO 抖动打断输入
            console.warn('[finder] 递归搜索失败：', err);
            FinderState.setSearchResults(null);
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
        seq++;
        FinderState.setSearch('');
        FinderState.setSearchResults(null);
    }

    return { init, dispose };
})();

export { FinderSearch };
