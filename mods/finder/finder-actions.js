/**
 * finder-actions.js — 访达工具栏弹层与操作
 *
 * 负责「分组 / 共享 / 标记 / 更多」四个按钮的下拉弹层，以及更多菜单中的
 * 新建文件夹、排序、显隐切换、刷新、重新授权等操作。全部为 macOS 15 真实功能。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { FinderState } from './finder-state.js';
import { FinderLayout } from './finder-layout.js';
import { FinderTags } from './finder-tags.js';
import { FinderVfsWrite } from './finder-vfs-write.js';
import { VFS } from '../../src/javascripts/vfs.js';

const FinderActions = (() => {
    let titlebar = null;
    /** @type {HTMLElement[]} 全部弹层 */
    let pops = [];
    let cb = {}; // 外部回调
    let openPop = null; // 当前打开的弹层

    /**
     * 初始化动作模块。
     * @param {object} options
     * @param {Function} [options.navigate]
     * @param {Function} [options.refresh]
     * @param {Function} [options.reauth]
     */
    function init(options = {}) {
        cb = options;
        titlebar = document.querySelector('.finder-titlebar');
        pops = Array.from(document.querySelectorAll('.tb-pop'));

        bindTriggers();
        bindGroupPop();
        bindMorePop();
        bindOutsideClose();

        // 标记弹层由 FinderTags 渲染
        const tagPop = document.getElementById('pop-tag');
        if (tagPop) FinderTags.renderTagPop(tagPop);

        // 分组高亮随状态同步
        FinderState.on('group-changed', syncGroupActive);
    }

    /** 绑定三个触发按钮 */
    function bindTriggers() {
        const group = document.getElementById('action-group');
        const share = document.getElementById('action-share');
        const tag = document.getElementById('action-tag');
        const more = document.getElementById('action-more');

        if (group) group.addEventListener('click', (e) => { e.stopPropagation(); togglePop('pop-group', group); });
        if (share) share.addEventListener('click', (e) => { e.stopPropagation(); doShare(); });
        if (tag) tag.addEventListener('click', (e) => {
            e.stopPropagation();
            const tagPop = document.getElementById('pop-tag');
            if (tagPop) FinderTags.renderTagPop(tagPop);
            togglePop('pop-tag', tag);
        });
        if (more) more.addEventListener('click', (e) => { e.stopPropagation(); togglePop('pop-more', more); });
    }

    /** 绑定分组弹层项 */
    function bindGroupPop() {
        const pop = document.getElementById('pop-group');
        if (!pop) return;
        pop.querySelectorAll('.pop-item').forEach(item => {
            item.addEventListener('click', () => { FinderState.setGroupBy(item.dataset.group); closeAll(); });
        });
        syncGroupActive();
    }

    /** 同步分组弹层高亮（当前分组项打勾） */
    function syncGroupActive(by) {
        const pop = document.getElementById('pop-group');
        if (!pop) return;
        const current = by || FinderState.getState().groupBy;
        pop.querySelectorAll('.pop-item').forEach((item) => {
            const active = item.dataset.group === current;
            item.classList.toggle('active', active);
            ensureCheck(item, active);
        });
    }

    function ensureCheck(item, active) {
        let check = item.querySelector('.pop-check');
        if (active && !check) {
            check = document.createElement('span');
            check.className = 'pop-check';
            check.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20"><path d="M4 10l4 4 8-8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            item.appendChild(check);
        } else if (!active && check) {
            check.remove();
        }
    }

    /** 绑定更多弹层项 */
    function bindMorePop() {
        const pop = document.getElementById('pop-more');
        if (!pop) return;
        pop.querySelectorAll('.pop-item').forEach(item => {
            const action = item.dataset.action;
            if (!action) return;
            item.addEventListener('click', () => { handleMoreAction(action, item); closeAll(); });
        });
    }

    /** 处理更多菜单动作 */
    function handleMoreAction(action, item) {
        switch (action) {
            case 'new-folder': {
                const name = window.prompt(i18n.t('finder.newFolderPrompt', '新建文件夹名称：'), i18n.t('finder.newFolderDefault', '未命名文件夹'));
                if (name && name.trim()) {
                    FinderVfsWrite.addFolder(FinderState.getState().currentPath, name.trim());
                    cb.refresh?.();
                }
                break;
            }
            case 'sort': {
                const field = item.dataset.sort;
                if (field) FinderState.setSort(field);
                break;
            }
            // 注：toggle-path-bar / toggle-status-bar 已从「更多」菜单下线，
            // 但保留 switch 分支兼容旧菜单命令（FinderLayout 内对应方法为 no-op）。
            case 'toggle-path-bar':
                FinderLayout.togglePathBar();
                break;
            case 'toggle-status-bar':
                FinderLayout.toggleStatusBar();
                break;
            case 'toggle-tab-bar':
                FinderLayout.toggleTabBar();
                break;
            case 'refresh':
                cb.refresh?.();
                break;
            case 'reauth':
                cb.reauth?.();
                break;
        }
    }

    /** 共享：优先 navigator.share，失败回退复制路径 */
    async function doShare() {
        const sel = FinderState.getState().selectedPaths;
        const target = sel.size ? [...sel][0] : FinderState.getState().currentPath;
        const data = { title: 'Deskly', text: target };
        try {
            if (navigator.share) {
                await navigator.share(data);
                return;
            }
        } catch (e) {
            // 用户取消或不可用，继续回退
        }
        try {
            await navigator.clipboard.writeText(target);
            toast(i18n.t('finder.copied', '已复制路径'));
        } catch (e) {
            toast(i18n.t('finder.shareFailed', '共享失败，已复制路径'));
        }
    }

    /** 切换弹层（同一时间仅一个） */
    function togglePop(id, trigger) {
        const pop = document.getElementById(id);
        if (!pop) return;
        if (openPop === pop) return closeAll();
        closeAll();
        positionPop(pop, trigger);
        pop.hidden = false;
        openPop = pop;
    }

    /** 定位弹层到触发按钮下方（以 .finder.window 为定位基准，可超出窗口边界显示） */
    function positionPop(pop, trigger) {
        const windowEl = document.querySelector('.finder.window');
        if (!windowEl || !titlebar) return;
        const tr = trigger.getBoundingClientRect();
        const wr = windowEl.getBoundingClientRect();
        // 相对 .finder.window 的水平位置
        let left = tr.left - wr.left;
        // 相对 .finder.window 的垂直位置：触发按钮底部 + 5px 间隙
        const top = tr.bottom - wr.top + 5;
        // 防止右侧溢出窗口
        const maxLeft = wr.width - pop.offsetWidth - 8;
        if (left > maxLeft) left = Math.max(8, maxLeft);
        // 防止左侧溢出
        if (left < 8) left = 8;
        // 防止底部溢出窗口（若超出则改为向上弹出）
        if (top + pop.offsetHeight > wr.height) {
            const aboveTop = tr.top - wr.top - pop.offsetHeight - 5;
            pop.style.top = Math.max(8, aboveTop) + 'px';
        } else {
            pop.style.top = top + 'px';
        }
        pop.style.left = left + 'px';
    }

    /** 关闭全部弹层 */
    function closeAll() {
        pops.forEach((p) => { p.hidden = true; });
        openPop = null;
    }

    /** 点击空白处 / Esc 关闭 */
    function bindOutsideClose() {
        const onOutsideClick = (e) => {
            if (!openPop) return;
            if (openPop.contains(e.target)) return;
            if (e.target.closest('.tb-btn')) return; // 触发按钮自身已处理
            closeAll();
        };
        const onOutsideKey = (e) => {
            if (e.key === 'Escape' && openPop) closeAll();
        };
        document.addEventListener('click', onOutsideClick);
        document.addEventListener('keydown', onOutsideKey);

        // 资源释放：访达窗口关闭时移除本模块注册的全局监听，避免常驻内存
        const onActionsUnload = (e) => {
            if (e.detail.id !== 'finder') return;
            window.removeEventListener('plugin-unload', onActionsUnload);
            document.removeEventListener('click', onOutsideClick);
            document.removeEventListener('keydown', onOutsideKey);
        };
        window.addEventListener('plugin-unload', onActionsUnload);
    }

    /** 简易 toast 提示 */
    let toastTimer = null;
    function toast(msg) {
        let el = document.getElementById('finder-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'finder-toast';
            el.style.cssText = 'position:absolute;left:50%;bottom:18px;transform:translateX(-50%);background:rgba(0,0,0,.8);color:#fff;font-size:12px;padding:6px 14px;border-radius:8px;z-index:80;opacity:0;transition:opacity .2s;pointer-events:none;';
            const root = document.querySelector('.finder.window');
            if (root) root.appendChild(el);
        }
        el.textContent = msg;
        el.style.opacity = '1';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1600);
    }

    return { init, closeAll, doShare };
})();

export { FinderActions };
