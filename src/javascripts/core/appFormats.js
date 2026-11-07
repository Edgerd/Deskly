/**
 * core/appFormats.js — 「哪个应用能打开这个扩展名」的单一判定口径。
 *
 * 三处消费方必须给出同一答案，否则同一个文件在三个入口表现不一致：
 *   core/fileMenu.js   「打开方式」子菜单与默认应用打勾
 *   core/openWith.js   未知类型双击时的选择器候选
 *   desktop.js         拖到程序坞应用图标时「能不能接」的判定
 *
 * 记录形状来自 app-registry.listApps()：多应用插件读 apps[].formats，
 * 单应用插件读根级 manifest.formats（两者以前只读前者，根级声明曾长期是死代码）。
 */

/** 扩展名归一：去空白、去前导点、小写。 */
export function normalizeExtension(ext) {
    return String(ext || "").trim().toLowerCase().replace(/^\./, "");
}

/** 应用记录声明的可打开扩展名（已归一，空值剔除）。 */
export function formatsOf(record) {
    if (!record) return [];
    const formats = (record.app && record.app.formats) || (!record.app && record.manifest && record.manifest.formats);
    if (!Array.isArray(formats)) return [];
    return formats.map(normalizeExtension).filter(Boolean);
}

/** 该应用是否声明能打开这个扩展名。 */
export function acceptsExtension(record, ext) {
    const want = normalizeExtension(ext);
    if (!want) return false;
    return formatsOf(record).includes(want);
}

/**
 * 一组条目是否全部能被该应用打开。
 * 文件夹一律不接受：没有任何应用在清单里声明目录格式，假装接受会把「拖到 Dock」变成静默失败。
 * @param {object} record 应用记录
 * @param {Array<{name:string,type:string}>} items 拖拽/选中项
 */
export function acceptsItems(record, items) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!list.length) return false;
    return list.every((item) => item.type !== "folder" && acceptsExtension(record, item.name));
}

/** 从应用记录里筛出声明能打开该扩展名的（顺序保持原序，默认应用由调用方再排）。 */
export function acceptingApps(records, ext) {
    const want = normalizeExtension(ext);
    if (!want) return [];
    return (records || []).filter((record) => acceptsExtension(record, want));
}
