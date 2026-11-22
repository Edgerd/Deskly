/**
 * finder-contextmenu.js — 访达条目与空白区域右键菜单（保真清单 F-37）。
 * 条目集合与动作内核共用 core/fileMenu.js（与桌面同一 provider 模型，同一命令语义），
 * 访达只注入 hooks：打开 / 预览 / 重命名 / 新建文件夹 / 排序 / 简介 / 刷新。
 * /废纸篓 的「放回原处」「清倒」与书签/应用条目的只读分支在本模块收口。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { FinderState } from './finder-state.js';
import { FinderTags } from './finder-tags.js';
import { buildFileMenuItems } from '../../src/javascripts/core/fileMenu.js';
import { MenuProviders } from '../../src/javascripts/core/menuProviders.js';

/* Q6 收口：只走 Deskly 公开 API（废纸篓/路径工具/存在性判定） */
const Deskly = () => window.Deskly;
const unwrap = (env) => {
    if (!env || !env.ok) {
        const err = new Error((env && env.reason) || 'Deskly 调用失败');
        err.code = (env && env.code) || 'EIO';
        if (err.code === 'EREAUTH' || err.code === 'REAUTH') err.name = 'NeedsReauthError';
        throw err;
    }
    return env.value;
};
const normalizePath = (p) => Deskly().fs.paths.normalize(p);
const putBack = async (p) => unwrap(await Deskly().fs.trash.putBack(p));
const emptyTrash = async () => unwrap(await Deskly().fs.trash.empty());
// 常量在模块顶层立即求值：Deskly 未就绪（裸页单测 / node 冒烟）时退回内核同值，
// 浏览器内核启动后由 os-api.js 提供真实值（trash.js:26 / osfs.js:33 一致）。
const TRASH_ORIGIN_SUFFIX = Deskly()?.fs?.trash?.originSuffix ?? '.deskly-origin';
const existsAt = async (p) => unwrap(await Deskly().fs.existsAt(p));

const TRASH_ROOT = Deskly()?.fs?.paths?.trash ?? '/废纸篓'; // /废纸篓

const FinderContextMenu = (() => {
    let onOpenEntry = null, onRefresh = null, onCreateFolder = null;
    let hooks = {}; // { open, quickLook, rename, getInfo, sortBy, getSort }

    /** @type {Function[]} 资源释放回调 */
    let disposers = [];
    function track(fn) { disposers.push(fn); }
    function dispose() {
        const list = disposers;
        disposers = [];
        list.forEach(fn => fn());
    }

    /**
     * 初始化右键菜单。
     * @param {object} options
     * @param {Function} [options.openEntry] 打开单条目回调(entry)
     * @param {Function} [options.refresh] 刷新回调
     * @param {Function} [options.createFolder] 新建文件夹回调
     * @param {object} [options.hooks] fileMenu 动作钩子（open/quickLook/rename/getInfo/sortBy/getSort）
     */
    function init(options = {}) {
        dispose();
        onOpenEntry = options.openEntry || null;
        onRefresh = options.refresh || null;
        onCreateFolder = options.createFolder || null;
        hooks = options.hooks || {};
        track(FinderState.on('locale-changed', () => { /* 菜单每次右键重建，无需常驻刷新 */ }));
    }

    /** 当前目录是不是 /废纸篓。 @returns {boolean} */
    function inTrash() {
        const cur = FinderState.getState().currentPath;
        return normalizePath(cur || '/') === TRASH_ROOT;
    }

    /** 选中集（含传入条目所在的多选）；menuItems 的 sel 形状见 menuProviders.js 文件头。 */
    function selectionFor(entry) {
        const sel = FinderState.getState().selectedPaths;
        const rendered = FinderState.getState().entries || [];
        let items;
        if (entry && sel.size > 1 && sel.has(entry.path)) {
            items = rendered.filter((e) => sel.has(e.path)).map(({ path, name, type }) => ({ path, name, type }));
        } else {
            const hit = rendered.find((e) => e.path === entry?.path);
            items = [{ path: entry?.path, name: (hit && hit.name) || Deskly().fs.paths.baseName(entry?.path || ''), type: (hit && hit.type) || entry?.type || 'file' }];
        }
        return { location: 'finder', items, isBackground: false };
    }

    /** 书签 / 应用条目走只读分支：只留打开类动作，不出现移动/删除（F-40）。 */
    function buildVirtualItems(sel) {
        const item = sel.items[0];
        const items = [{ label: i18n.t('common.open', '打开'), action: () => onOpenEntry?.(item) }];
        if (item.type === 'app') {
            items.push({ type: 'separator' });
            items.push({ label: i18n.t('finder.showInfo', '显示简介'), action: () => hooks.getInfo?.(sel.items) });
        }
        return items;
    }

    /**
     * 显示空白区域右键菜单。
     * @param {number} x
     * @param {number} y
     */
    function showEmpty(x, y) {
        const sel = { location: 'finder', items: [], isBackground: true };
        const items = buildFileMenuItems(sel, {
            newFolder: () => onCreateFolder?.(),
            sortBy: (field) => hooks.sortBy?.(field),
            getSort: () => hooks.getSort?.(),
        });
        if (inTrash()) {
            items.push({ type: 'separator' });
            items.push({ label: i18n.t('finder.emptyTrash', '清倒废纸篓...'), action: () => confirmEmptyTrash() });
        }
        items.push({ type: 'separator' });
        items.push({ label: i18n.t('common.refresh', '刷新'), action: () => onRefresh?.() });
        Deskly().ui.contextMenu(x, y, items);
    }

    /** 清倒确认：__dialog.confirm 未就绪（裸页单测）时直接执行，不把用户卡在没反应。 */
    async function confirmEmptyTrash() {
        const dialog = window.__dialog;
        if (dialog && typeof dialog.confirm === 'function') {
            const ok = await dialog.confirm(
                i18n.t('finder.emptyTrash', '清倒废纸篓…'),
                i18n.t('finder.emptyTrashConfirm', '废纸篓里的项目将被永久删除，无法撤销。'),
                { danger: true });
            if (!ok) return;
        }
        try {
            await emptyTrash();
            onRefresh?.();
        } catch (err) {
            if (err && err.name === 'NeedsReauthError') {
                window.__dialog?.error?.(i18n.t('finder.title', '访达'),
                    i18n.t('finder.auth.needsReauth', '根目录的读写权限需要重新授权，在此之前访达动不了里面的文件。'));
            } else {
                console.warn('[finder] 清倒废纸篓失败：', err);
            }
        }
    }

    /**
     * 显示条目右键菜单（多选时文案随数量变化，走 fileMenu 的批量语义）。
     * @param {number} x
     * @param {number} y
     * @param {object} entry
     */
    async function showEntry(x, y, entry) {
        // 先把点击项纳入选中（不破坏既有多选：已在选中集里则保持整组）
        const selState = FinderState.getState();
        if (!selState.selectedPaths.has(entry.path)) FinderState.selectSingle(entry.path);

        const sel = selectionFor(entry);
        if (entry.type === 'bookmark' || entry.type === 'app') {
            Deskly().ui.contextMenu(x, y, buildVirtualItems(sel));
            return;
        }
        const items = buildFileMenuItems(sel, {
            open: (its) => { its.forEach((it) => onOpenEntry?.(it)); },
            quickLook: (its) => hooks.quickLook?.(its),
            rename: (item) => hooks.rename?.(item),
            getInfo: (its) => hooks.getInfo?.(its),
            refresh: () => onRefresh?.(),
        });
        if (inTrash()) {
            // P0-4：废纸篓里的条目给「放回原处」（有溯源伴生才可用）；只能清倒，不能再次入篓
            const trashItem = items.find((it) => it.id === 'trash');
            if (trashItem) items.splice(items.indexOf(trashItem), 1);
            let hasOrigin = false;
            try { hasOrigin = await existsAt(entry.path + TRASH_ORIGIN_SUFFIX); } catch { hasOrigin = false; }
            items.push({
                label: i18n.t('finder.putBack', '放回原处'),
                disabled: !hasOrigin,
                action: hasOrigin ? () => putBackAndRefresh(entry) : null,
            });
        }
        // 把 fileMenu 的「移到废纸篓」挪到菜单尾部（原版顺序：…拷贝路径/共享 → 分隔 → 删除）
        const trashItem = items.find((it) => it.id === 'trash');
        if (trashItem) {
            items.splice(items.indexOf(trashItem), 1);
            items.push({ type: 'separator' }, trashItem);
        }
        Deskly().ui.contextMenu(x, y, items);
    }

    /** 放回原处（P0-4）。 @param {object} entry */
    async function putBackAndRefresh(entry) {
        const r = await putBack(entry.path).catch(() => ({ ok: false }));
        if (r.ok) {
            FinderTags.clearTagsForPath(entry.path);
            onRefresh?.();
        } else {
            window.__dialog?.error?.(i18n.t('finder.title', '访达'),
                i18n.t('finder.putBackFailed', '放回原处失败（原位置可能已不存在），请移入其他文件夹。'));
        }
    }

    return { init, dispose, showEmpty, showEntry };
})();

export { FinderContextMenu };
