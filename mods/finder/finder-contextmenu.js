/**
 * finder-contextmenu.js — 访达右键菜单（macOS 15 还原）
 *
 * 提供条目右键菜单与空白区域右键菜单。书签树与虚拟写文件已移除，
 * 空白菜单改为「新建文件夹」（走虚拟写层 FinderVfsWrite）+「刷新」。
 * 依赖外部注入的 createContextMenu(x, y, items) 函数。
 */

import { FinderState } from './finder-state.js';
import { FinderVfsWrite } from './finder-vfs-write.js';

const FinderContextMenu = (() => {
    let _createContextMenu = null, onOpenEntry = null, onRefresh = null;

    /**
     * 初始化右键菜单。
     * @param {object} options
     * @param {Function} options.createContextMenu 创建菜单函数
     * @param {Function} [options.openEntry] 打开条目回调
     * @param {Function} [options.refresh] 刷新回调
     */
    function init(options = {}) {
        _createContextMenu = options.createContextMenu || null;
        onOpenEntry = options.openEntry || null;
        onRefresh = options.refresh || null;
    }

    /**
     * 显示空白区域右键菜单。
     * @param {number} x
     * @param {number} y
     */
    function showEmpty(x, y) {
        if (!_createContextMenu) return;
        const items = [
            { label: '新建文件夹', action: () => newFolder() },
            { type: 'separator' },
            { label: '显示简介', disabled: true },
            { type: 'separator' },
            { label: '刷新', action: () => onRefresh?.() },
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
            { label: '打开', action: () => onOpenEntry?.(entry) },
            { type: 'separator' },
            { label: '显示简介', disabled: true },
            { type: 'separator' },
            { label: '刷新', action: () => onRefresh?.() },
        ];
        _createContextMenu(x, y, items);
    }

    /** 在当前目录新建虚拟文件夹（刷新后仍在）。 */
    function newFolder() {
        const name = window.prompt('新建文件夹名称：', '未命名文件夹');
        if (name && name.trim()) {
            FinderVfsWrite.addFolder(FinderState.getState().currentPath, name.trim());
            if (onRefresh) onRefresh();
        }
    }

    return { init, showEmpty, showEntry };
})();

export { FinderContextMenu };
