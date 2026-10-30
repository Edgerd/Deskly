/**
 * finder-actions.js — 访达工具栏弹层与操作
 *
 * 负责「分组 / 共享 / 标记 / 更多」四个按钮的下拉弹层，以及更多菜单中的
 * 新建文件夹、排序、显示标签栏、刷新、重新授权等操作。全部为 macOS 15 真实功能。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { VFS } from '../../src/javascripts/vfs.js';
import { openPopover, closeAllPopovers } from '../../src/javascripts/ui/popover.js';
import { FinderState } from './finder-state.js';
import { FinderLayout } from './finder-layout.js';
import { FinderTags } from './finder-tags.js';

const FinderActions = (() => {
    let cb = {}; // 外部回调
    /** @type {{close:Function, el:HTMLElement}|null} 当前打开的弹层句柄 */
    let openPop = null;
    let toastTimer = null;

    /** @type {Function[]} 资源释放回调（重开窗口 / plugin-unload 时执行） */
    let disposers = [];

    /** 登记一个释放回调。 */
    function track(fn) { disposers.push(fn); }

    /** 执行并清空全部释放回调（可重复调用）。 */
    function dispose() {
        clearTimeout(toastTimer);
        toastTimer = null;
        closeAll();
        const list = disposers;
        disposers = [];
        list.forEach(fn => fn());
    }

    /**
     * 初始化动作模块。
     * @param {object} options
     * @param {Function} [options.navigate]
     * @param {Function} [options.refresh]
     * @param {Function} [options.reauth]
     * @param {Function} [options.createFolder] 新建文件夹（真 mkdir 走入口，菜单只负责触发）
     */
    function init(options = {}) {
        // 常驻单例：重开窗口先撤销上一次的订阅与全局监听
        dispose();

        cb = options;

        bindTriggers();
        bindGroupPop();
        bindMorePop();
        // 弹层的「点外部 / Esc 关闭」不再自己挂 document 监听：见 ui/popover.js

        // 标记弹层由 FinderTags 渲染
        const tagPop = document.getElementById('pop-tag');
        if (tagPop) FinderTags.renderTagPop(tagPop);

        // 分组高亮随状态同步
        track(FinderState.on('group-changed', syncGroupActive));
        // 选中项变化后标记弹层的勾选态失效，重开时会重建，无需常驻监听
    }

    /** 绑定三个触发按钮 */
    function bindTriggers() {
        const group = document.getElementById('action-group');
        const share = document.getElementById('action-share');
        const tag = document.getElementById('action-tag');
        const more = document.getElementById('action-more');

        const onGroup = (e) => { e.stopPropagation(); togglePop('pop-group', group); };
        const onShare = (e) => { e.stopPropagation(); doShare(); };
        const onTag = (e) => {
            e.stopPropagation();
            const tagPop = document.getElementById('pop-tag');
            if (tagPop) FinderTags.renderTagPop(tagPop);
            togglePop('pop-tag', tag);
        };
        const onMore = (e) => { e.stopPropagation(); syncReauthItem(); togglePop('pop-more', more); };

        group?.addEventListener('click', onGroup);
        share?.addEventListener('click', onShare);
        tag?.addEventListener('click', onTag);
        more?.addEventListener('click', onMore);
        track(() => {
            group?.removeEventListener('click', onGroup);
            share?.removeEventListener('click', onShare);
            tag?.removeEventListener('click', onTag);
            more?.removeEventListener('click', onMore);
        });
    }

    /** 「重新授权」项要说清此刻文件存在哪，否则用户要点下去才知道这是在做什么。 */
    function syncReauthItem() {
        const item = document.querySelector('#pop-more [data-action="reauth"]');
        if (!item) return;
        const action = VFS.getAuthStatus().needsReauth
            ? i18n.t('finder.auth.reauthorize', '重新授权')
            : i18n.t('finder.mountFolder', '挂载本地文件夹');
        const where = VFS.whereStored();
        // 文案在界面层取键：数据层只给结构化状态（vfs.whereStored），
        // 不再返回成品中文 —— 否则非中文界面会漏出整句中文。
        const whereText = where.kind === 'disk'
            ? i18n.t('finder.auth.whereDisk', '本地文件夹 {name}').replace('{name}', where.name)
            : i18n.t('finder.auth.useInApp', '就用应用内根目录');
        item.textContent = `${action} · ${whereText}`;
    }

    /** 绑定分组弹层项 */
    function bindGroupPop() {
        const pop = document.getElementById('pop-group');
        if (!pop) return;
        const onClick = (e) => {
            const item = e.target.closest('.pop-item');
            if (!item) return;
            FinderState.setGroupBy(item.dataset.group);
            closeAll();
        };
        pop.addEventListener('click', onClick);
        track(() => pop.removeEventListener('click', onClick));
        syncGroupActive();
    }

    /** 同步分组弹层高亮（当前分组项打勾） */
    function syncGroupActive(by) {
        const pop = document.getElementById('pop-group');
        if (!pop) return;
        const current = by || FinderState.getGroupBy();
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
        const onClick = (e) => {
            const item = e.target.closest('.pop-item');
            if (!item) return;
            const action = item.dataset.action;
            if (!action) return;
            handleMoreAction(action, item).catch((err) => console.error('[finder] 菜单动作失败：', action, err));
            closeAll();
        };
        pop.addEventListener('click', onClick);
        track(() => pop.removeEventListener('click', onClick));
    }

    /** 处理更多菜单动作 */
    async function handleMoreAction(action, item) {
        switch (action) {
            case 'new-folder':
                await cb.createFolder?.();
                break;
            case 'sort': {
                const field = item.dataset.sort;
                if (field) FinderState.setSort(field);
                break;
            }
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

    /** 切换弹层（同一时间仅一个）。
     * 弹层经 src/javascripts/ui/popover.js 搬进 body 上的浮出层显示：`.window` 样式表里
     * 有 overflow:hidden，本窗口根虽然刻意不再声明它，但那条 0,1,0 的声明没人压得住，
     * 弹层照样被裁 —— 旧版把它挪到 .finder-clip 之外只是躲过了内层裁剪容器。
     * 浮层载体自动带上窗口根的 finder 类（--finder-* 令牌定义在 :root，本来就继承得到），
     * 所以 .tb-pop / .pop-item 这些选择器照旧命中。 */
    function togglePop(id, trigger) {
        const pop = document.getElementById(id);
        if (!pop) return;
        if (openPop && openPop.el === pop) return closeAll();
        closeAll();
        openPop = openPopover({
            anchor: trigger,
            content: pop,
            align: 'start',
            gap: 5,
            onDismiss: () => { openPop = null; },
        });
    }

    /** 关闭全部弹层（「点外部 / Esc」这些关闭时机由浮出层统一负责） */
    function closeAll() {
        closeAllPopovers();
        openPop = null;
    }

    /** 简易 toast 提示 */
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

    return { init, dispose };
})();

export { FinderActions };
