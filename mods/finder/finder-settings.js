/**
 * finder-settings.js — 访达的持久化偏好（保真清单 F-26 / F-39 / F-42 / F-44）。
 * 统一走内核 settings.js（G7：单一 owner，槽位与系统设置共用一份真相），
 * 访达内部只 import 本模块，不各写各的 localStorage。
 * 这些项暂无系统设置面板行（本批次不铺 UI），仅提供 API 与快捷键切换；
 * 「访达 > 设置」面板留给后续批次（接口已就绪：settings.list({owner:'finder'})）。
 */

import { settings } from '../../src/javascripts/settings.js';

const DEFS = [
    // 键名须过 settings.KEY_PATTERN（段内禁连字符，驼峰即可）
    { key: 'finder.showHidden', type: 'boolean', default: false, owner: 'finder', label: '显示隐藏文件' },
    { key: 'finder.showStatusBar', type: 'boolean', default: true, owner: 'finder', label: '显示状态栏' },
    { key: 'finder.showPathBar', type: 'boolean', default: false, owner: 'finder', label: '显示路径栏' },
    { key: 'finder.showPreview', type: 'boolean', default: false, owner: 'finder', label: '显示预览' },
    { key: 'finder.searchScope', type: 'string', default: 'folder', values: ['folder', 'disk'], owner: 'finder', label: '搜索范围' },
    { key: 'finder.sidebarFavorites', type: 'json', default: [], owner: 'finder', label: '边栏收藏' },
];

settings.defineMany(DEFS);

const FinderSettings = {
    /** 读布尔偏好（缺省回落 default）。 */
    bool(key) {
        try { return settings.get(key) !== false; } catch { return true; }
    },
    /** 读任意偏好。 */
    get(key) {
        try { return settings.get(key); } catch { return null; }
    },
    /** 写偏好（settings-changed 会从 document 冒泡，订阅方自行刷新）。 */
    set(key, value) {
        try { settings.set(key, value); } catch (err) { console.warn('[finder] 偏好写入失败：', key, err); }
    },
    /** 切换布尔偏好并返回新值。 */
    toggle(key) {
        const next = !this.bool(key);
        this.set(key, next);
        return next;
    },
};

export { FinderSettings, DEFS };
