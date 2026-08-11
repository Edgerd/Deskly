/**
 * finder-vfs-write.js — 虚拟写能力层
 *
 * VFS 为只读（showDirectoryPicker 模式为 read），本模块用 localStorage 记录
 * 用户在各路径下新建的「虚拟文件夹」，注入到目录列表中，刷新后仍在。
 * 不影响 VFS 真实目录，未来 VFS 支持写后可作为迁移层移除。
 */

const FinderVfsWrite = (() => {
    const KEY = 'webstartos_finder_vdirs';

    /** 读取全部虚拟目录映射：{ "/下载": ["未命名文件夹"], ... } */
    function load() {
        try {
            return JSON.parse(localStorage.getItem(KEY)) || {};
        } catch (e) {
            return {};
        }
    }

    /** 持久化 */
    function save(obj) {
        try {
            localStorage.setItem(KEY, JSON.stringify(obj));
        } catch (e) {
            // 忽略容量异常
        }
    }

    /** 构造虚拟文件夹条目（路径与 mergeFolders/addFolder 共用同一规则） */
    function virtualEntry(path, name) {
        return {
            name, type: 'folder',
            path: (path === '/' ? '' : path) + '/' + name,
            virtual: true, modified: Date.now(), size: null, icon: 'folder',
        };
    }

    /**
     * 取某路径下的虚拟文件夹名列表。
     * @param {string} path
     * @returns {string[]}
     */
    function getVirtualFolders(path) {
        return load()[path] || [];
    }

    /**
     * 在指定路径下新建虚拟文件夹（自动去重）。
     * @param {string} path 父目录（如 "/" 或 "/下载"）
     * @param {string} name 建议名称
     * @returns {object} 新建的条目对象
     */
    function addFolder(path, name) {
        const data = load();
        const base = name || '未命名文件夹';
        let finalName = base, i = 1;
        while ((data[path] ||= []).includes(finalName)) finalName = `${base} ${++i}`;
        data[path].push(finalName);
        save(data);
        return virtualEntry(path, finalName);
    }

    /**
     * 将某路径下的虚拟文件夹合并进 VFS 列表结果。
     * @param {string} path 当前目录
     * @param {Array} entries VFS.list 返回的原始条目
     * @returns {Array} 合并后的条目
     */
    function mergeFolders(path, entries) {
        return entries.concat(getVirtualFolders(path).map(n => virtualEntry(path, n)));
    }

    return { getVirtualFolders, addFolder, mergeFolders };
})();

export { FinderVfsWrite };
