/**
 * finder-contextmenu.js — 访达右键菜单（macOS 15 还原）
 *
 * 提供条目右键菜单与空白区域右键菜单。新建文件夹与刷新走入口注入的回调（与工具栏
 * 菜单同一实现），删除直接作用在真实目录上——插件私有的伪目录层已随存储重构移除。
 * 依赖外部注入的 createContextMenu(x, y, items) 函数。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { OSFS } from '../../src/javascripts/osfs.js';
import { moveToTrash, putBack, emptyTrash, TRASH_ORIGIN_SUFFIX } from '../../src/javascripts/trash.js';
import { FinderState } from './finder-state.js';
import { FinderTags } from './finder-tags.js';

const TRASH_ROOT = OSFS.TOP.trash.path; // /废纸篓

/**
 * 内置顶层夹的路径集合（/文档、/下载、/图片、/桌面、/AppData、/废纸篓）。
 * 这些是内核现算、背后没有可删实体的节点；用户建在根上的普通文件夹不在此列，可以删。
 */
const BUILTIN_TOP_PATHS = new Set(Object.values(OSFS.TOP).map((t) => t.path));
const isBuiltInTopPath = (path) => BUILTIN_TOP_PATHS.has(OSFS.normalizePath(path));

const FinderContextMenu = (() => {
    let _createContextMenu = null, onOpenEntry = null, onRefresh = null, onCreateFolder = null;

    /**
     * 初始化右键菜单。
     * @param {object} options
     * @param {Function} options.createContextMenu 创建菜单函数
     * @param {Function} [options.openEntry] 打开条目回调
     * @param {Function} [options.refresh] 刷新回调
     * @param {Function} [options.createFolder] 新建文件夹回调
     */
    function init(options = {}) {
        _createContextMenu = options.createContextMenu || null;
        onOpenEntry = options.openEntry || null;
        onRefresh = options.refresh || null;
        onCreateFolder = options.createFolder || null;
    }

    /**
     * 显示空白区域右键菜单。
     * @param {number} x
     * @param {number} y
     */
    function showEmpty(x, y) {
        if (!_createContextMenu) return;
        const items = [
            { label: i18n.t('finder.newFolder', '新建文件夹'), action: () => onCreateFolder?.() },
        ];
        // P0-4：在废纸篓里，空白处右键给出「清倒废纸篓」（真清倒，带确认）
        if (inTrash()) {
            items.push({ label: i18n.t('finder.emptyTrash', '清倒废纸篓...'), action: () => confirmEmptyTrash() });
        }
        items.push(
            { type: 'separator' },
            { label: i18n.t('finder.showInfo', '显示简介'), disabled: true },
            { type: 'separator' },
            { label: i18n.t('common.refresh', '刷新'), action: () => onRefresh?.() },
        );
        _createContextMenu(x, y, items);
    }

    /** 当前目录是不是 /废纸篓。 @returns {boolean} */
    function inTrash() {
        const cur = FinderState.getState().currentPath;
        return OSFS.normalizePath(cur || '/') === TRASH_ROOT;
    }

    /** 清倒确认：__dialog.confirm 未就绪（裸页单测）时直接执行，不把用户卡在没反应。 */
    async function confirmEmptyTrash() {
        const dialog = window.__dialog;
        if (dialog && typeof dialog.confirm === 'function') {
            const ok = await dialog.confirm(
                i18n.t('finder.emptyTrash', '清倒废纸篓...'),
                i18n.t('finder.emptyTrashConfirm', '要永久删除废纸篓里的所有项目吗？此操作无法撤销。'));
            if (!ok) return;
        }
        try {
            const r = await emptyTrash();
            if (r && r.ok) onRefresh?.();
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
     * 显示条目右键菜单。
     * @param {number} x
     * @param {number} y
     * @param {object} entry
     */
    async function showEntry(x, y, entry) {
        if (!_createContextMenu) return;
        const items = [
            { label: i18n.t('common.open', '打开'), action: () => onOpenEntry?.(entry) },
            { type: 'separator' },
            { label: i18n.t('finder.showInfo', '显示简介'), disabled: true },
        ];
        if (isInTrash(entry)) {
            // P0-4：废纸篓里的条目给「放回原处」（有溯源伴生才可用，拖入的原生文件没有）；
            // 不提供「删除」——在废纸篓里只能清倒，与 macOS 一致。
            let hasOrigin = false;
            try { hasOrigin = await OSFS.exists(entry.path + TRASH_ORIGIN_SUFFIX); } catch { hasOrigin = false; }
            items.push({ type: 'separator' });
            items.push({
                label: i18n.t('finder.putBack', '放回原处'),
                disabled: !hasOrigin,
                action: hasOrigin ? () => putBackAndRefresh(entry) : null,
            });
        } else if (isDeletableFolder(entry) || entry.type === 'file') {
            // P0-4：删除 = 移入废纸篓（可放回、访达可见），不再 OSFS.remove 硬删除。
            // 文件此前整列右键都没有删除入口（手册 19 页「Delete 移入废纸篓」缺失），一并补上。
            items.push({ type: 'separator' });
            items.push({ label: i18n.t('common.delete', '删除'), action: () => moveToTrashAndRefresh(entry) });
        }
        items.push({ type: 'separator' });
        items.push({ label: i18n.t('common.refresh', '刷新'), action: () => onRefresh?.() });
        _createContextMenu(x, y, items);
    }

    /** 条目是否位于 /废纸篓 内（含直接子项）。 @param {object} entry @returns {boolean} */
    function isInTrash(entry) {
        const p = OSFS.normalizePath(entry.path || '');
        return p === TRASH_ROOT || p.startsWith(TRASH_ROOT + '/');
    }

    /** 删除 = 移入废纸篓（P0-4）。移动失败时弹错误而不是静默。 @param {object} entry */
    async function moveToTrashAndRefresh(entry) {
        const r = await moveToTrash(entry.path).catch(() => ({ ok: false }));
        if (!r.ok) {
            window.__dialog?.error?.(i18n.t('finder.title', '访达'),
                i18n.t('finder.trashMoveFailed', '移入废纸篓失败，请重试或重新授权。'));
            return;
        }
        FinderTags.clearTagsForPath(entry.path);
        onRefresh?.();
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

    /**
     * 是否给删除入口。
     * @param {object} entry
     * @returns {boolean}
     */
    function isDeletableFolder(entry) {
        if (entry.type !== 'folder') return false;
        // 收藏夹/最近使用是虚拟节点，背后没有可删实体
        if (entry.bookmark || entry.bookmarkRoot || entry.recent) return false;
        // 只保护内置顶层夹；用户建在根上的普通文件夹照删不误
        return !isBuiltInTopPath(entry.path);
    }

    return { init, showEmpty, showEntry };
})();

export { FinderContextMenu };
