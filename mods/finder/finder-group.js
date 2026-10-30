/**
 * finder-group.js — 访达分组逻辑
 *
 * 按「种类 / 日期 / 大小 / 标签」将当前目录条目分组，供四种视图渲染分组头部。
 * 分组为 macOS 15「排列」功能的等价呈现。
 */

import { i18n } from '../../src/javascripts/i18n.js';
import { FinderTags } from './finder-tags.js';

const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'];
const DOC_EXTS = ['txt', 'md', 'json', 'js', 'css', 'html', 'htm', 'xml', 'log', 'ini', 'yaml', 'yml', 'csv', 'py', 'ts', 'pdf', 'doc', 'docx', 'pages', 'rtf'];
const AUDIO_EXTS = ['mp3', 'wav', 'aac', 'flac', 'm4a'];
const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv'];

/**
 * 取扩展名。
 * idx > 0 是有意的：'.gitignore' 这类隐藏文件的点号不是扩展名分隔符。
 * 因此调用方不能拿 '.xxx' 拼假文件名（见 bucketLabel 的 'kind' 分支）。
 * @param {string} name
 * @returns {string}
 */
function getExt(name) {
    const idx = name.lastIndexOf('.');
    return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
}

/**
 * 取条目的「种类」标签。
 * @param {object} entry
 * @returns {string}
 */
function kindLabel(entry) {
    if (entry.type === 'folder') return i18n.t('finder.kind.folder', '文件夹');
    const ext = getExt(entry.name);
    if (IMG_EXTS.includes(ext)) return i18n.t('finder.kind.image', '图像');
    if (VIDEO_EXTS.includes(ext)) return i18n.t('finder.kind.video', '视频');
    if (AUDIO_EXTS.includes(ext)) return i18n.t('finder.kind.audio', '音频');
    if (DOC_EXTS.includes(ext)) return i18n.t('finder.kind.document', '文稿');
    return i18n.t('finder.kind.other', '其他');
}

/**
 * 取条目日期分桶。
 * @param {number} ts 修改时间戳
 * @returns {string} today | yesterday | previous7Days | earlier
 */
function dateBucket(ts) {
    if (!ts) return 'earlier';
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 86400000;
    const sevenDaysAgo = startOfToday - 7 * 86400000;
    if (ts >= startOfToday) return 'today';
    if (ts >= startOfYesterday) return 'yesterday';
    if (ts >= sevenDaysAgo) return 'previous7Days';
    return 'earlier';
}

/**
 * 取条目大小分桶。
 * @param {number} bytes
 * @returns {string}
 */
function sizeBucket(bytes) {
    if (bytes == null) return 'other';
    if (bytes < 100 * 1024) return 'small';
    if (bytes < 10 * 1024 * 1024) return 'medium';
    return 'large';
}

/**
 * 分组标签（头部显示文本）。
 * @param {string} by 分组键
 * @param {string} key 桶 key
 * @returns {string}
 */
function bucketLabel(by, key) {
    if (by === 'kind') {
        // 分组键本身就是「文件夹 / 扩展名 / other」，直接映射，
        // 不要再拼 '.' + key 的假文件名（getExt 对以点开头的名字返回空串，会让所有分组落到「其他」）
        if (key === 'folder') return i18n.t('finder.kind.folder', '文件夹');
        if (key === 'other') return i18n.t('finder.kind.other', '其他');
        return kindLabel({ type: 'file', name: 'x.' + key });
    }
    if (by === 'date') {
        return { today: i18n.t('finder.today', '今天'), yesterday: i18n.t('finder.yesterday', '昨天'), previous7Days: i18n.t('finder.previous7Days', '前 7 天'), earlier: i18n.t('finder.earlier', '更早') }[key] || key;
    }
    if (by === 'size') {
        return { small: i18n.t('finder.size.small', '小于 100 KB'), medium: i18n.t('finder.size.medium', '小于 10 MB'), large: i18n.t('finder.size.large', '大于 10 MB'), other: i18n.t('finder.size.other', '未知大小') }[key] || key;
    }
    if (by === 'tag') {
        if (key === '__none__') return i18n.t('finder.tags.none', '未标记');
        return i18n.t('finder.tags.' + colorKey(key), key);
    }
    return key;
}

/** 标签色名 → i18n 键后缀（红/橙/黄/绿/蓝/紫/灰） */
function colorKey(name) {
    return { '红色': 'red', '橙色': 'orange', '黄色': 'yellow', '绿色': 'green', '蓝色': 'blue', '紫色': 'purple', '灰色': 'gray' }[name] || name;
}

/**
 * 将条目按指定方式分组。
 * @param {Array} entries
 * @param {string} by none | kind | date | size | tag
 * @returns {Array<{key:string,label:string,items:Array}>}
 */
function groupEntries(entries, by) {
    if (!by || by === 'none') {
        return [{ key: 'all', label: '', items: entries }];
    }

    const map = new Map();
    entries.forEach((entry) => {
        let key;
        if (by === 'kind') {
            key = entry.type === 'folder' ? 'folder' : getExt(entry.name) || 'other';
        } else if (by === 'date') {
            key = dateBucket(entry.modified);
        } else if (by === 'size') {
            key = sizeBucket(entry.size);
        } else if (by === 'tag') {
            const tags = FinderTags.getTags(entry.path);
            key = tags.length ? tags[0] : '__none__';
        }
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(entry);
    });

    // 设定分组顺序
    let order;
    if (by === 'kind') {
        // 文件夹优先，其余按字母
        order = ['folder', ...Object.keys(map).filter(k => k !== 'folder').sort()];
    } else if (by === 'date') {
        order = ['today', 'yesterday', 'previous7Days', 'earlier'].filter(k => map.has(k));
    } else if (by === 'size') {
        order = ['small', 'medium', 'large', 'other'].filter(k => map.has(k));
    } else if (by === 'tag') {
        const colorOrder = ['红色', '橙色', '黄色', '绿色', '蓝色', '紫色', '灰色'];
        order = colorOrder.filter(k => map.has(k));
        if (map.has('__none__')) order.push('__none__');
    } else {
        order = [...map.keys()];
    }

    return order.map((key) => ({ key, label: bucketLabel(by, key), items: map.get(key) }));
}

export { groupEntries, kindLabel };
