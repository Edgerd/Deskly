/**
 * finder-contextmenu.js — 访达右键菜单（macOS 15 还原）
 *
 * 提供条目右键菜单与空白区域右键菜单。新建文件夹与刷新走入口注入的回调（与工具栏
 * 菜单同一实现），删除直接作用在真实目录上——插件私有的伪目录层已随存储重构移除。
 * 依赖外部注入的 createContextMenu(x, y, items) 函数。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { OSFS } from '../../src/javascripts/osfs.js';
import { FinderTags } from './finder-tags.js';

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
            { type: 'separator' },
            { label: i18n.t('finder.showInfo', '显示简介'), disabled: true },
            { type: 'separator' },
            { label: i18n.t('common.refresh', '刷新'), action: () => onRefresh?.() },
        ];
        _createContextMenu(x, y, items);
    }

    /**
     * 显示条目右键菜单。
     * @param {number} x
     * @param {number} y
     * @param {object} entry
     */
    function showEntry(x, y, entry) {
        if (!_createContextMenu) return;
        const items = [
            { label: i18n.t('common.open', '打开'), action: () => onOpenEntry?.(entry) },
            { type: 'separator' },
            { label: i18n.t('finder.showInfo', '显示简介'), disabled: true },
        ];
        // 内置顶层夹、书签、最近使用都是内核现算出来的节点，背后没有可删的实体
        if (isDeletableFolder(entry)) {
            items.push({ type: 'separator' });
            items.push({ label: i18n.t('common.delete', '删除'), action: () => removeFolder(entry) });
        }
        items.push({ type: 'separator' });
        items.push({ label: i18n.t('common.refresh', '刷新'), action: () => onRefresh?.() });
        _createContextMenu(x, y, items);
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

    /**
     * 删除目录。递归一律不开：非空目录必须由用户先清空（两个后端都为此抛错）。
     * @param {object} entry
     */
    async function removeFolder(entry) {
        const outcome = await OSFS.remove(entry.path, { recursive: false }).catch((err) => {
            console.warn('[finder] 删除文件夹失败：', entry.path, err);
            return err && err.name === 'NeedsReauthError'
                ? i18n.t('finder.auth.needsReauth', '根目录的读写权限需要重新授权，在此之前访达动不了里面的文件。')
                : i18n.t('finder.folderNotEmpty', '文件夹非空，请先移走或删除里面的项目。');
        });
        // false 只意味着「本来就不在」（列表可能是旧的），重画一下就对齐了，不算失败
        if (typeof outcome === 'string') {
            window.__dialog?.error?.(i18n.t('finder.title', '访达'), outcome);
            return;
        }
        FinderTags.clearTagsForPath(entry.path);
        onRefresh?.();
    }

    return { init, showEmpty, showEntry };
})();

export { FinderContextMenu };
