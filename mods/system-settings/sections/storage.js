/**
 * panes/storage.js — 「存储与根目录」面板：单一根目录的挂载状态、插件私有数据与浏览器配额
 *
 * 数据来源只有 VFS / OSFS：getAuthStatus() 给后端与挂载状态，authorize()/reauthorize()/unmount()/
 * decline() 是四个需要用户手势的动作入口，OSFS.list / scope().clearTemp 负责读插件目录。
 * 这里不读写任何 localStorage（「不再询问」标记由 OSFS 内部维护）—— 一切状态来自内核。
 *
 * 新模型：根只有一个，`/文档`、`/AppData/<id>/temp` 都相对它。不挂载真实文件夹时整棵树就在应用
 * 自己的存储里、完全可用（这是常态，不是降级）；挂载后同一批路径逐段映射到那个真实文件夹（readwrite）。
 * 权限过期时内核抛 NeedsReauthError，面板如实显示「需要重新授权」，不伪装正常，也不在渲染路径里弹授权框。
 */

import { VFS } from "../../../src/javascripts/vfs.js";
import { OSFS } from "../../../src/javascripts/osfs.js";
import { settings } from "../../../src/javascripts/settings.js";
import { log } from "../../../src/javascripts/log.js";
import { openApp } from "../../../src/javascripts/plugin-manager.js";
import { moveToTrash, pruneOldTrash } from "../../../src/javascripts/trash.js";
import {
    el, t, row, group, section, note, statusRow, actionRow, controlSwitch, usePaneStyle,
} from "../ui.js";

export const paneId = "storage";

/** 面板语言包（四个语言的键位必须一致，static-check 双向比对）。 */
export const messages = {
    "zh-CN": {
        ss: {
            storage: {
                rootTitle: "根目录",
                where: "当前存储位置",
                mounted: "已挂载", notMounted: "未挂载", reauth: "需要重新授权",
                mountTitle: "挂载本地文件夹",
                mountButton: "选择文件夹…", mountBusy: "等待选择…",
                whereDisk: "本地文件夹 {name}",
                reauthTitle: "重新授权根目录",
                reauthButton: "重新授权", reauthBusy: "正在请求权限…",
                unmountTitle: "取消挂载", unmountHint: "只解除关联，磁盘上的文件不会被删除。",
                unmountButton: "取消挂载", unmountBusy: "正在取消…",
                declineTitle: "不再询问",
                declineButton: "不再询问", declineBusy: "正在处理…",
                refresh: "重新检测", refreshButton: "刷新状态",
                cancelled: "已取消，存储位置未变", failed: "操作失败",
                topTitle: "根目录结构",
                pluginsTitle: "App 数据",
                pluginsEmpty: "暂无缓存。",
                pluginsNeedReauth: "重新授权后可查看缓存。",
                pluginsError: "缓存读取失败。",
                itemSummary: "{n} 项 · {size}",
                clearButton: "清空缓存", clearHint: "只清缓存，配置与数据不会被删除。",
                clearBusy: "正在清理…", clearDone: "已清空「{id}」的缓存",
                quota: "存储配额", quotaUsed: "已用 / 总额", quotaUnknown: "无法查询",
                settingsBytes: "设置占用", meterLabel: "占用比例",
                whereVirtual: "应用内根目录",
                categoryTitle: "储存空间分布",
                categoryTotal: "合计 {size}",
                catAppData: "应用数据", catDocuments: "文稿", catImages: "图片", catVideos: "视频", catOther: "其他",
                categoryNote: "按文件类型估算，已排除废纸篓。",
                recTitle: "推荐",
                lowSpaceTitle: "储存空间不足",
                lowSpaceNote: "剩余不足 5%，建议先清理大文件。",
                autoEmpty: "自动清倒废纸篓",
                autoEmptyHint: "抹掉超过 30 天的项目",
                autoEmptyClean: "清理过期项目",
                autoEmptyRun: "立即清倒过期项目", autoEmptyRunBusy: "正在清倒…",
                autoEmptyDone: "已清倒 {n} 项", autoEmptyNone: "没有超过 30 天的项目",
                cleanTitle: "优化储存空间",
                cleanHint: "勾选后一并移除，无法撤销。",
                cleanEmpty: "没有可清理的安装包或缓存。",
                cleanTotal: "可释放 {size}",
                cleanButton: "移除所选", cleanBusy: "正在清理…",
                cleanConfirmTitle: "移除所选项目？",
                cleanConfirmBody: "共 {n} 项、{size}，移除后不可恢复。",
                cleanDone: "已释放 {size}",
                icloud: "储存在 iCloud 中", icloudUnavailable: "不可用",
                icloudNote: "当前环境没有云端写入通道，可改为挂载本地文件夹。",
                largeTitle: "大文件", largeHint: "超过 10 MB 的文件。",
                largeEmpty: "没有超过 10 MB 的文件。",
                reveal: "在访达中显示", moveToTrash: "移入废纸篓",
                movedToTrash: "已移入废纸篓", trashFailed: "移入废纸篓失败",
                dupTitle: "重复下载", dupNote: "下载文件夹里有 {n} 组重复文件。",
                dupOpen: "打开下载文件夹",
            },
        },
    },
    en: {
        ss: {
            storage: {
                rootTitle: "Root Folder",
                where: "Stored In",
                mounted: "Mounted", notMounted: "Not Mounted", reauth: "Needs Re-Authorization",
                mountTitle: "Mount Local Folder",
                mountButton: "Choose Folder…", mountBusy: "Waiting for selection…",
                whereDisk: "Local folder {name}",
                reauthTitle: "Re-Authorize Root",
                reauthButton: "Re-Authorize", reauthBusy: "Requesting permission…",
                unmountTitle: "Unmount", unmountHint: "Detaches only. Files on disk are not deleted.",
                unmountButton: "Unmount", unmountBusy: "Unmounting…",
                declineTitle: "Stop Asking",
                declineButton: "Stop Asking", declineBusy: "Working…",
                refresh: "Check Again", refreshButton: "Refresh",
                cancelled: "Cancelled; storage location unchanged", failed: "Operation failed",
                topTitle: "Root Structure",
                pluginsTitle: "App Data",
                pluginsEmpty: "No cache yet.",
                pluginsNeedReauth: "Re-authorize the root to view caches.",
                pluginsError: "Could not read the cache folder.",
                itemSummary: "{n} items · {size}",
                clearButton: "Clear Cache", clearHint: "Clears the cache only. Config and data are kept.",
                clearBusy: "Clearing…", clearDone: "Cleared the cache of “{id}”",
                quota: "Storage Quota", quotaUsed: "Used / Total", quotaUnknown: "Not available",
                settingsBytes: "Settings Size", meterLabel: "Usage",
                whereVirtual: "In-app root folder",
                categoryTitle: "Storage Breakdown",
                categoryTotal: "Total {size}",
                catAppData: "App Data", catDocuments: "Documents", catImages: "Images", catVideos: "Videos", catOther: "Other",
                categoryNote: "Estimated by file type; the Trash is excluded.",
                recTitle: "Recommendations",
                lowSpaceTitle: "Storage Almost Full",
                lowSpaceNote: "Less than 5% left. Clear large files first.",
                autoEmpty: "Auto-Empty Trash",
                autoEmptyHint: "Removes items older than 30 days",
                autoEmptyClean: "Clean Up Expired Items",
                autoEmptyRun: "Empty Expired Items Now", autoEmptyRunBusy: "Emptying…",
                autoEmptyDone: "Removed {n} items", autoEmptyNone: "Nothing older than 30 days",
                cleanTitle: "Optimize Storage",
                cleanHint: "Selected items are removed permanently.",
                cleanEmpty: "No installers or caches to clean up.",
                cleanTotal: "{size} can be freed",
                cleanButton: "Remove Selected", cleanBusy: "Cleaning…",
                cleanConfirmTitle: "Remove selected items?",
                cleanConfirmBody: "{n} items, {size} in total. This cannot be undone.",
                cleanDone: "Freed {size}",
                icloud: "Store in iCloud", icloudUnavailable: "Unavailable",
                icloudNote: "No cloud write channel here; mount a local folder instead.",
                largeTitle: "Large Files", largeHint: "Files larger than 10 MB.",
                largeEmpty: "No files larger than 10 MB.",
                reveal: "Show in Finder", moveToTrash: "Move to Trash",
                movedToTrash: "Moved to the Trash", trashFailed: "Could not move to the Trash",
                dupTitle: "Duplicate Downloads", dupNote: "{n} duplicate groups in Downloads.",
                dupOpen: "Open Downloads",
            },
        },
    },
    "ja-JP": {
        ss: {
            storage: {
                rootTitle: "ルートフォルダ",
                where: "現在の保存場所",
                mounted: "マウント済み", notMounted: "未マウント", reauth: "再許可が必要",
                mountTitle: "ローカルフォルダをマウント",
                mountButton: "フォルダを選択…", mountBusy: "選択をお待ちください…",
                whereDisk: "ローカルフォルダ {name}",
                reauthTitle: "ルートを再許可",
                reauthButton: "再許可", reauthBusy: "権限を要求中…",
                unmountTitle: "マウント解除", unmountHint: "関連付けを外すだけで、ディスク上のファイルは消去しません。",
                unmountButton: "マウント解除", unmountBusy: "解除中…",
                declineTitle: "今後尋ねない",
                declineButton: "今後尋ねない", declineBusy: "処理中…",
                refresh: "再チェック", refreshButton: "状態を更新",
                cancelled: "中止しました。保存場所は変わっていません", failed: "操作に失敗しました",
                topTitle: "ルート構造",
                pluginsTitle: "App データ",
                pluginsEmpty: "キャッシュはまだありません。",
                pluginsNeedReauth: "再許可後にキャッシュを一覧できます。",
                pluginsError: "キャッシュを読み取れませんでした。",
                itemSummary: "{n} 件 · {size}",
                clearButton: "キャッシュを消去", clearHint: "キャッシュのみ消去し、設定とデータは消去しません。",
                clearBusy: "消去中…", clearDone: "「{id}」のキャッシュを消去しました",
                quota: "ストレージ割当", quotaUsed: "使用 / 全体", quotaUnknown: "取得できません",
                settingsBytes: "設定の占有", meterLabel: "使用率",
                whereVirtual: "アプリ内ルート",
                categoryTitle: "ストレージの内訳",
                categoryTotal: "合計 {size}",
                catAppData: "App データ", catDocuments: "書類", catImages: "画像", catVideos: "ビデオ", catOther: "その他",
                categoryNote: "ファイル種別による概算です。ゴミ箱は除外しています。",
                recTitle: "推奨",
                lowSpaceTitle: "ストレージが不足しています",
                lowSpaceNote: "残り 5% 未満です。大きいファイルから整理してください。",
                autoEmpty: "ゴミ箱を自動で空にする",
                autoEmptyHint: "30 日を超えた項目を消去します",
                autoEmptyClean: "期限切れを整理",
                autoEmptyRun: "期限切れを今すぐ消去", autoEmptyRunBusy: "消去中…",
                autoEmptyDone: "{n} 件を消去しました", autoEmptyNone: "30 日を超えた項目はありません",
                cleanTitle: "ストレージを最適化",
                cleanHint: "選択した項目は完全に削除されます。",
                cleanEmpty: "整理できるインストーラやキャッシュはありません。",
                cleanTotal: "{size} を解放できます",
                cleanButton: "選択項目を削除", cleanBusy: "整理中…",
                cleanConfirmTitle: "選択した項目を削除しますか？",
                cleanConfirmBody: "合計 {n} 件、{size}。削除すると元に戻せません。",
                cleanDone: "{size} を解放しました",
                icloud: "iCloud に保存", icloudUnavailable: "利用できません",
                icloudNote: "この環境にはクラウド書き込み経路がありません。ローカルフォルダをマウントしてください。",
                largeTitle: "大きいファイル", largeHint: "10 MB を超えるファイルです。",
                largeEmpty: "10 MB を超えるファイルはありません。",
                reveal: "Finder に表示", moveToTrash: "ゴミ箱に入れる",
                movedToTrash: "ゴミ箱に入れました", trashFailed: "ゴミ箱に入れられませんでした",
                dupTitle: "重複ダウンロード", dupNote: "ダウンロードに {n} 組の重複があります。",
                dupOpen: "ダウンロードを開く",
            },
        },
    },
    cat: {
        ss: {
            storage: {
                rootTitle: "根夾子喵",
                where: "而家擱邊度喵",
                mounted: "掛上了喵", notMounted: "未掛喵", reauth: "得再批一次喵",
                mountTitle: "掛個本地夾子喵",
                mountButton: "揀夾子喵…", mountBusy: "等主人揀喵…",
                whereDisk: "本地夾子 {name} 喵",
                reauthTitle: "再批根夾子喵",
                reauthButton: "再批一次喵", reauthBusy: "正喺問准批喵…",
                unmountTitle: "摘咗佢喵", unmountHint: "淨係解開關係，磁盘上嘅檔案唔會冇咗喵~",
                unmountButton: "摘咗佢喵", unmountBusy: "正喺摘喵…",
                declineTitle: "以後唔好問喵",
                declineButton: "唔好問喵", declineBusy: "正喺記下喵…",
                refresh: "再看一眼喵", refreshButton: "重新查喵",
                cancelled: "主人按了取消，擱邊度冇變喵~", failed: "搞唔掂喵~",
                topTitle: "根夾子嘅結構喵",
                pluginsTitle: "App 嘅嘢喵",
                pluginsEmpty: "仲冇快取喵~",
                pluginsNeedReauth: "再批一次就列得出快取喵~",
                pluginsError: "快取讀唔到喵~",
                itemSummary: "{n} 件 · {size}",
                clearButton: "清快取喵", clearHint: "淨係清快取，設定同數據唔會冇咗喵~",
                clearBusy: "正喺清喵…", clearDone: "清咗「{id}」嘅快取喵~",
                quota: "擱嘅地方喵", quotaUsed: "用了 / 一共有", quotaUnknown: "問不出來喵",
                settingsBytes: "設定占了點滴喵", meterLabel: "占比喵",
                whereVirtual: "App 入面嘅根夾子喵",
                categoryTitle: "儲存空間點分喵",
                categoryTotal: "夾埋 {size} 喵",
                catAppData: "App 嘅嘢喵", catDocuments: "文稿喵", catImages: "圖片喵", catVideos: "影片喵", catOther: "其他喵",
                categoryNote: "按檔案類型估吓，廢紙篓唔計喵~",
                recTitle: "提議喵",
                lowSpaceTitle: "儲存空間唔夠啦喵",
                lowSpaceNote: "淨返唔夠 5%，不如先清大檔案喵~",
                autoEmpty: "自動清倒廢紙篓喵",
                autoEmptyHint: "抹走超過 30 日嘅嘢喵",
                autoEmptyClean: "清理過期嘅嘢喵",
                autoEmptyRun: "即刻清走過期嘅喵", autoEmptyRunBusy: "正喺清喵…",
                autoEmptyDone: "清走咗 {n} 件喵", autoEmptyNone: "冇超過 30 日嘅嘢喵",
                cleanTitle: "優化儲存空間喵",
                cleanHint: "剔咗就一路移走，冇得返轉頭喵~",
                cleanEmpty: "冇安裝包同快取可以清喵~",
                cleanTotal: "可以放返 {size} 喵",
                cleanButton: "移走剔咗嘅喵", cleanBusy: "正喺清喵…",
                cleanConfirmTitle: "真係移走剔咗嘅嘢喵？",
                cleanConfirmBody: "一共 {n} 件、{size}，移走就冇咗喵~",
                cleanDone: "放返咗 {size} 喵",
                icloud: "擱去 iCloud 喵", icloudUnavailable: "用唔到喵",
                icloudNote: "呢度冇得寫上雲，不如掛個本地夾子喵~",
                largeTitle: "大檔案喵", largeHint: "大過 10 MB 嘅檔案喵。",
                largeEmpty: "冇大過 10 MB 嘅檔案喵~",
                reveal: "喺訪達度睇喵", moveToTrash: "掉入廢紙篓喵",
                movedToTrash: "掉入廢紙篓咗喵~", trashFailed: "掉唔入廢紙篓喵~",
                dupTitle: "重複下載喵", dupNote: "下載夾子有 {n} 組重複喵~",
                dupOpen: "開下載夾子喵",
            },
        },
    },
};

/** 大文件门槛：≥10 MB 才进「大文件」列表（与系统口径一致）。 */
const LARGE_FILE_MIN = 10 * 1024 * 1024;
/** 大文件列表上限：只列最大的 20 项，再多就不是「推荐」而是文件管理器了。 */
const LARGE_FILE_LIMIT = 20;
/** 自动清倒的保留天数（与 trash.js 的 pruneOldTrash 默认口径一致）。 */
const AUTO_EMPTY_DAYS = 30;
/** 空间不足阈值：剩余低于 5% 时给提示。 */
const LOW_SPACE_RATIO = 0.05;
/** 安装器残留的扩展名：下载完成后留着也不用的那一类。 */
const INSTALLER_EXTS = new Set(["dmg", "pkg", "iso", "msi", "exe", "zip"]);
/** 缓存/日志判定：路径段与扩展名两条线索。 */
const CACHE_SEGMENTS = ["/temp/", "/cache/", "/logs/"];
/** 分类色条：顺序即图例顺序（应用数据 / 文稿 / 图片 / 视频 / 其他）。 */
const CATEGORY_META = [
    { key: "appdata", color: "#5e5ce6" },
    { key: "documents", color: "#0a84ff" },
    { key: "images", color: "#30d158" },
    { key: "videos", color: "#ff9f0a" },
    { key: "other", color: "#8e8e93" },
];
/** 按扩展名归类：未命中的一律进「其他」，不猜内容。 */
const CATEGORY_EXTS = {
    images: new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "bmp", "tif", "tiff", "svg"]),
    videos: new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi", "ogv"]),
    documents: new Set(["txt", "md", "markdown", "pdf", "rtf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key", "csv", "json", "xml", "html", "htm", "epub"]),
};
/** 分类图例文案：键名写死（动态拼键逃不过四语键集比对）。 */
const CATEGORY_TEXT = {
    appdata: { key: "ss.storage.catAppData", fallback: "应用数据" },
    documents: { key: "ss.storage.catDocuments", fallback: "文稿" },
    images: { key: "ss.storage.catImages", fallback: "图片" },
    videos: { key: "ss.storage.catVideos", fallback: "视频" },
    other: { key: "ss.storage.catOther", fallback: "其他" },
};

/** 取路径扩展名（小写，无扩展名返回空串）。 */
function extOf(path) {
    const match = String(path || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "";
}

/**
 * 把一条文件归入分类桶：/AppData 下的算「应用数据」，其余按扩展名。
 * @param {string} path 文件绝对路径
 * @param {string} appdataPath AppData 根路径
 * @returns {string} appdata / documents / images / videos / other
 */
function categoryOf(path, appdataPath) {
    if (path === appdataPath || path.startsWith(appdataPath + "/")) return "appdata";
    const ext = extOf(path);
    if (CATEGORY_EXTS.images.has(ext)) return "images";
    if (CATEGORY_EXTS.videos.has(ext)) return "videos";
    if (CATEGORY_EXTS.documents.has(ext)) return "documents";
    return "other";
}

/** 是否是安装器残留（下载目录里的安装包 / 压缩包）。 */
function isInstallerLeftover(file) {
    return INSTALLER_EXTS.has(extOf(file.path));
}

/** 是否是缓存或日志文件（路径段或扩展名命中）。 */
function isCacheFile(file) {
    const path = String(file.path || "");
    if (extOf(path) === "log") return true;
    return CACHE_SEGMENTS.some((seg) => path.includes(seg));
}

/**
 * 找出下载目录里的重复下载：把「 (1)」这类副本后缀归一，同组 ≥2 份算重复。
 * @param {Array<object>} files 全部文件
 * @param {string} downloadsPath 下载目录
 * @returns {Array<Array<object>>} 重复组
 */
function duplicateDownloads(files, downloadsPath) {
    const groups = new Map();
    files.forEach((file) => {
        if (!String(file.path).startsWith(downloadsPath + "/")) return;
        const stem = String(file.name).replace(/ \(\d+\)(\.[^.]*)?$/, "$1").toLowerCase();
        if (!groups.has(stem)) groups.set(stem, []);
        groups.get(stem).push(file);
    });
    return [...groups.values()].filter((group) => group.length > 1);
}

/** 面板私有样式：存储位置状态、配额进度条、分类色条、推荐清单。 */
const PANE_CSS = `
.ss-pane-storage .ss-storage__cell { display: flex; align-items: center; gap: 8px; }
.ss-pane-storage .ss-storage__where { font-size: 13px; }
.ss-pane-storage .ss-storage__status { font-size: 12px; color: var(--ss-text-secondary); }
.ss-pane-storage .ss-storage__status--granted { color: var(--accent); font-weight: 600; }
.ss-pane-storage .ss-storage__status--warn { color: var(--ss-danger); font-weight: 600; }
.ss-pane-storage .ss-storage__meter { width: 100%; height: 6px; border-radius: 3px; background: var(--ss-track); overflow: hidden; }
.ss-pane-storage .ss-storage__meter-fill { height: 100%; width: 0%; border-radius: 3px; background: var(--accent); transition: width 0.18s ease; }
.ss-pane-storage .ss-storage__cats { display: flex; width: 100%; height: 10px; border-radius: 5px; overflow: hidden; background: var(--ss-track); }
.ss-pane-storage .ss-storage__catseg { height: 100%; }
.ss-pane-storage .ss-storage__legend { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 6px 2px 0; }
.ss-pane-storage .ss-storage__legend-item { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--ss-text-secondary); }
.ss-pane-storage .ss-storage__dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.ss-pane-storage .ss-storage__rec { display: flex; flex-direction: column; gap: 8px; }
.ss-pane-storage .ss-storage__check { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.ss-pane-storage .ss-storage__check input { margin: 0; }
.ss-pane-storage .ss-storage__check-path { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-pane-storage .ss-storage__check-size { color: var(--ss-text-secondary); font-variant-numeric: tabular-nums; }
`;

/** 字节数说成人类可读的文本。 */
function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 译文插值（i18n 只取值不插值）。 */
function tf(key, fallback, values) {
    return Object.entries(values || {}).reduce(
        (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
        t(key, fallback),
    );
}

/**
 * 构建「存储与根目录」面板。
 * @param {object} ctx 外壳上下文
 * @returns {HTMLElement} 面板根元素
 */
export function build(ctx) {
    usePaneStyle(paneId, PANE_CSS);
    const root = el("div", { class: "ss-pane-storage", dataset: { pane: paneId } });

    // 路径不写字面量：AppData 一律从 OSFS.TOP 取。
    const appdataPath = OSFS.TOP.appdata.path;

    const rootBox = group([]);
    const pluginBox = group([]);
    const quotaBox = group([]);
    const categoryBox = group([]);
    const recBox = group([]);
    const largeBox = group([]);

    /** 最近一次全树扫描的文件清单与配额，供分类 / 推荐 / 大文件三块共用。 */
    let lastFiles = [];
    const downloadsPath = OSFS.TOP.downloads.path;

    /** 顶层结构是内核常量，界面只列路径本身。 */
    const topBox = group(Object.entries(OSFS.TOP).map(([, def]) => row({ label: def.path })));

    const quotaRow = statusRow({ label: t("ss.storage.quotaUsed", "已用 / 总额"), value: "…" });
    const settingsRow = statusRow({ label: t("ss.storage.settingsBytes", "设置占用"), value: "—" });
    const meterFill = el("div", { class: "ss-storage__meter-fill" });
    const meter = el("div", { class: "ss-storage__meter" }, meterFill);
    quotaBox.append(
        row({ label: t("ss.storage.meterLabel", "占用比例"), control: meter, stack: true }),
        quotaRow,
        settingsRow,
    );

    /** 一次配额查询：navigator.storage.estimate 不是所有环境都有。 */
    const readQuota = () => {
        settingsRow.setValue(formatBytes(settings.storage().bytes));
        if (!navigator.storage || typeof navigator.storage.estimate !== "function") {
            quotaRow.setValue(t("ss.storage.quotaUnknown", "无法查询"));
            meterFill.style.width = "0%";
            return Promise.resolve(null);
        }
        return navigator.storage.estimate()
            .then((estimate) => {
                // formatBytes 返回的是 "1.5 KB" 这种字符串：再喂回 formatBytes 得 NaN → "—"，
                // 字符串比大小也恒 false（进度条恒 0%）。显示与比例都必须用原始数值（BUG-59）。
                const usage = Number(estimate.usage) || 0;
                const quota = Number(estimate.quota) || 0;
                quotaRow.setValue(`${formatBytes(usage)} / ${formatBytes(quota)}`);
                meterFill.style.width = quota > 0 ? `${Math.min(100, (usage / quota) * 100).toFixed(2)}%` : "0%";
                return { usage, quota };
            })
            .catch((err) => {
                log.debug("plugin/system-settings", "查询存储配额失败", err);
                quotaRow.setValue(t("ss.storage.quotaUnknown", "无法查询"));
                return null;
            });
    };

    /**
     * 根目录动作的统一包装：「用户取消」（AbortError）不是故障，与真实失败分开记；
     * 权限过期只重画让徽标显示「需要重新授权」，不在这里追加弹窗。
     * @param {Function} fn 实际动作（VFS.authorize 等，都要在用户手势里）
     * @param {Function} [doneMsg] 成功后写入运行记录的文案
     */
    const rootAction = (fn, doneMsg) => async () => {
        try {
            await fn();
            if (doneMsg) log.info("plugin/system-settings", doneMsg());
        } catch (err) {
            if (err && err.name === "AbortError") {
                log.info("plugin/system-settings", t("ss.storage.cancelled", "已取消，存储位置未变"));
            } else if (err && err.name === "NeedsReauthError") {
                log.info("plugin/system-settings", t("ss.storage.reauth", "需要重新授权"));
            } else {
                if (globalThis.__dialog) {
                    globalThis.__dialog.error(t("ss.storage.failed", "操作失败"), String((err && err.message) || err));
                }
                log.error("plugin/system-settings", "根目录操作失败", err);
            }
        }
        await render();
    };

    /** 依据 VFS 状态重画根目录行与动作行。 */
    async function renderRoot() {
        const status = VFS.getAuthStatus();
        rootBox.textContent = "";

        const tone = status.needsReauth ? "warn" : (status.mounted ? "granted" : "");
        const badge = status.needsReauth
            ? t("ss.storage.reauth", "需要重新授权")
            : status.mounted ? t("ss.storage.mounted", "已挂载") : t("ss.storage.notMounted", "未挂载");
        // whereStored 返回结构化状态（数据层不做文案），这里按 kind 取键。
        const where = VFS.whereStored();
        const whereText = where.kind === "disk"
            ? t("ss.storage.whereDisk", "本地文件夹 {name}").replace("{name}", where.name)
            : t("ss.storage.whereVirtual", "应用内根目录");
        const cell = el("div", { class: "ss-storage__cell" },
            el("span", { class: "ss-storage__where", text: whereText }),
            el("span", { class: `ss-storage__status ss-storage__status--${tone || "plain"}`, text: badge }));
        rootBox.append(row({
            label: t("ss.storage.where", "当前存储位置"),
            control: cell,
        }));

        if (status.supported) {
            // 「不再询问」之后仍然给挂载入口：declined 只表示别自动弹框，不是永久封口
            if (!status.mounted) {
                rootBox.append(actionRow({
                    label: t("ss.storage.mountTitle", "挂载本地文件夹"),
                    buttonText: t("ss.storage.mountButton", "选择文件夹…"),
                    busyText: t("ss.storage.mountBusy", "等待选择…"),
                    onAction: rootAction(VFS.authorize, () => "已挂载本地文件夹作为根目录"),
                }));
            }
            if (status.mounted && status.needsReauth) {
                rootBox.append(actionRow({
                    label: t("ss.storage.reauthTitle", "重新授权根目录"),
                    buttonText: t("ss.storage.reauthButton", "重新授权"),
                    busyText: t("ss.storage.reauthBusy", "正在请求权限…"),
                    onAction: rootAction(VFS.reauthorize, () => "根目录权限已刷新"),
                }));
            }
            if (status.mounted) {
                rootBox.append(actionRow({
                    label: t("ss.storage.unmountTitle", "取消挂载"),
                    hint: t("ss.storage.unmountHint", "只解除关联，磁盘上的文件不会被删除。"),
                    buttonText: t("ss.storage.unmountButton", "取消挂载"),
                    busyText: t("ss.storage.unmountBusy", "正在取消…"),
                    tone: "danger",
                    onAction: rootAction(VFS.unmount, () => "已取消挂载，磁盘文件未改动"),
                }));
            }
            if (!status.declined) {
                rootBox.append(actionRow({
                    label: t("ss.storage.declineTitle", "不再询问"),
                    buttonText: t("ss.storage.declineButton", "不再询问"),
                    busyText: t("ss.storage.declineBusy", "正在处理…"),
                    onAction: rootAction(VFS.decline, () => "已选择不再提示挂载"),
                }));
            }
        }

        rootBox.append(actionRow({
            label: t("ss.storage.refresh", "重新检测"),
            buttonText: t("ss.storage.refreshButton", "刷新状态"),
            onAction: async () => { await render(); },
        }));
    }

    /** 列出 AppData 下各插件目录的条目数与合计大小；只读，不弹任何授权框。 */
    async function renderPlugins() {
        pluginBox.textContent = "";
        if (VFS.getAuthStatus().needsReauth) {
            pluginBox.append(note("ss.storage.pluginsNeedReauth", "重新授权后可查看缓存。"));
            return;
        }
        let dirs = [];
        try {
            dirs = (await OSFS.list(appdataPath)).filter((e) => e.type === "folder");
        } catch (err) {
            if (err && err.name === "NeedsReauthError") {
                pluginBox.append(note("ss.storage.pluginsNeedReauth", "重新授权后可查看缓存。"));
            } else {
                log.error("plugin/system-settings", "读取 App 缓存目录失败", err);
                pluginBox.append(note("ss.storage.pluginsError", "缓存读取失败。"));
            }
            return;
        }
        if (!dirs.length) {
            pluginBox.append(note("ss.storage.pluginsEmpty", "暂无缓存。"));
            return;
        }

        for (const dir of dirs) {
            const id = dir.name;
            let files = [];
            try { files = await OSFS.walk(3, dir.path); } catch { files = []; }
            const total = files.reduce((n, f) => n + (Number(f.size) || 0), 0);
            const summary = tf("ss.storage.itemSummary", "{n} 项 · {size}", { n: files.length, size: VFS.formatSize(total) });
            const button = el("button", { class: "ss-btn", attrs: { type: "button" }, text: t("ss.storage.clearButton", "清空缓存") });
            button.addEventListener("click", async () => {
                const original = button.textContent;
                button.disabled = true;
                button.textContent = t("ss.storage.clearBusy", "正在清理…");
                try {
                    await OSFS.scope(id).clearTemp();
                    log.info("plugin/system-settings", tf("ss.storage.clearDone", `已清空「${id}」的缓存`, { id }));
                } catch (err) {
                    if (err && err.name === "NeedsReauthError") {
                        log.info("plugin/system-settings", t("ss.storage.reauth", "需要重新授权"));
                    } else {
                        if (globalThis.__dialog) {
                            globalThis.__dialog.error(t("ss.storage.failed", "操作失败"), String((err && err.message) || err));
                        }
                        log.error("plugin/system-settings", `清空 App「${id}」缓存失败`, err);
                    }
                } finally {
                    button.disabled = false;
                    button.textContent = original;
                }
                await render();
            });
            const control = el("div", { class: "ss-storage__cell" },
                el("span", { class: "ss-storage__status", text: summary }), button);
            pluginBox.append(row({
                label: id,
                hint: t("ss.storage.clearHint", "只清缓存，配置与数据不会被删除。"),
                control,
            }));
        }
    }

    /**
     * 让访达打开到指定目录：先确保访达在，再派发导航命令。
     * @param {string} path OSFS 绝对路径
     */
    async function revealPath(path) {
        try {
            await openApp("finder");
            document.dispatchEvent(new CustomEvent("finder-command", {
                detail: { command: "navigate", args: { path } },
            }));
        } catch (err) {
            log.error("plugin/system-settings", "打开访达失败", err);
        }
    }

    /** 全树扫描一次，排除废纸篓（清倒入口在推荐里，不在统计口径里）。 */
    async function collectFiles() {
        if (VFS.getAuthStatus().needsReauth) {
            lastFiles = [];
            return;
        }
        const trashRoot = OSFS.TOP.trash.path;
        try {
            const all = await OSFS.walk(6, "/");
            lastFiles = (all || []).filter((file) => !String(file.path).startsWith(trashRoot + "/"));
        } catch (err) {
            if (err && err.name === "NeedsReauthError") {
                lastFiles = [];
            } else {
                log.error("plugin/system-settings", "统计储存空间失败", err);
                lastFiles = [];
            }
        }
    }

    /** 顶部分类色条：按扩展名把文件分进五类，宽度即占比。 */
    function renderCategories() {
        categoryBox.textContent = "";
        const totals = new Map(CATEGORY_META.map((meta) => [meta.key, 0]));
        lastFiles.forEach((file) => {
            const key = categoryOf(file.path, appdataPath);
            totals.set(key, (totals.get(key) || 0) + (Number(file.size) || 0));
        });
        const total = CATEGORY_META.reduce((sum, meta) => sum + (totals.get(meta.key) || 0), 0);
        const bar = el("div", { class: "ss-storage__cats" });
        const legend = el("div", { class: "ss-storage__legend" });
        CATEGORY_META.forEach((meta) => {
            const size = totals.get(meta.key) || 0;
            const share = total > 0 ? (size / total) * 100 : 0;
            const text = CATEGORY_TEXT[meta.key];
            const label = t(text.key, text.fallback);
            bar.append(el("div", {
                class: "ss-storage__catseg",
                style: `width:${share.toFixed(2)}%;background:${meta.color}`,
                attrs: { title: `${label} · ${formatBytes(size)}` },
            }));
            legend.append(el("span", { class: "ss-storage__legend-item" },
                el("span", { class: "ss-storage__dot", style: `background:${meta.color}` }),
                el("span", { text: `${label} ${formatBytes(size)}` })));
        });
        categoryBox.append(
            row({ label: tf("ss.storage.categoryTotal", "合计 {size}", { size: formatBytes(total) }), control: bar, stack: true }),
            row({ control: legend, stack: true }),
            note("ss.storage.categoryNote", "按文件类型估算，已排除废纸篓。"),
        );
    }

    /** 「优化储存空间」清单：安装器残留 + 缓存日志，勾选后一起移除。 */
    function renderCleanup() {
        const inDownloads = (file) => String(file.path).startsWith(downloadsPath + "/");
        const candidates = lastFiles.filter((file) => (inDownloads(file) && isInstallerLeftover(file)) || isCacheFile(file));
        if (!candidates.length) {
            recBox.append(note("ss.storage.cleanEmpty", "没有可清理的安装包或缓存。"));
            return;
        }
        const cleanable = candidates.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
        const selected = new Set(candidates.map((file) => file.path));
        const list = el("div", { class: "ss-storage__rec" });
        candidates.slice(0, 30).forEach((file) => {
            const box = el("input", { attrs: { type: "checkbox", checked: true }, aria: { label: file.name } });
            box.checked = true;
            box.addEventListener("change", () => {
                if (box.checked) selected.add(file.path);
                else selected.delete(file.path);
            });
            list.append(el("label", { class: "ss-storage__check" },
                box,
                el("span", { class: "ss-storage__check-path", text: file.path }),
                el("span", { class: "ss-storage__check-size", text: formatBytes(file.size) })));
        });
        const totalLine = el("p", { class: "ss-note", text: tf("ss.storage.cleanTotal", "可释放 {size}", { size: formatBytes(cleanable) }) });
        const button = el("button", { class: "ss-btn", attrs: { type: "button" }, text: t("ss.storage.cleanButton", "移除所选") });
        button.addEventListener("click", async () => {
            const picked = candidates.filter((file) => selected.has(file.path));
            if (!picked.length) return;
            const bytes = picked.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
            const confirmed = globalThis.__dialog
                ? await globalThis.__dialog.confirm(
                    t("ss.storage.cleanConfirmTitle", "移除所选项目？"),
                    tf("ss.storage.cleanConfirmBody", "共 {n} 项、{size}，移除后不可恢复。", { n: picked.length, size: formatBytes(bytes) }),
                )
                : true;
            if (!confirmed) return;
            button.disabled = true;
            button.textContent = t("ss.storage.cleanBusy", "正在清理…");
            let freed = 0;
            for (const file of picked) {
                const done = await OSFS.remove(file.path, { recursive: true }).then(() => true).catch(() => false);
                if (done) freed += Number(file.size) || 0;
            }
            button.disabled = false;
            button.textContent = t("ss.storage.cleanButton", "移除所选");
            log.info("plugin/system-settings", tf("ss.storage.cleanDone", "已释放 {size}", { size: formatBytes(freed) }));
            await render();
        });
        recBox.append(row({
            label: t("ss.storage.cleanTitle", "优化储存空间"),
            hint: t("ss.storage.cleanHint", "勾选后一并移除，无法撤销。"),
            control: el("div", { class: "ss-storage__rec" }, list, totalLine, button),
            stack: true,
        }));
    }

    /** 推荐区：空间不足提示、自动清倒、优化储存空间、iCloud 降级说明、重复下载。 */
    function renderRecommendations(quota) {
        recBox.textContent = "";
        const usage = quota ? Number(quota.usage) || 0 : 0;
        const capacity = quota ? Number(quota.quota) || 0 : 0;
        if (capacity > 0 && (capacity - usage) / capacity < LOW_SPACE_RATIO) {
            recBox.append(row({
                label: t("ss.storage.lowSpaceTitle", "储存空间不足"),
                hint: t("ss.storage.lowSpaceNote", "剩余不足 5%，建议先清理大文件。"),
            }));
        }

        recBox.append(controlSwitch("trash.autoEmpty", {
            label: t("ss.storage.autoEmpty", "自动清倒废纸篓"),
            hint: t("ss.storage.autoEmptyHint", "抹掉超过 30 天的项目"),
        }));
        recBox.append(actionRow({
            label: t("ss.storage.autoEmptyClean", "清理过期项目"),
            buttonText: t("ss.storage.autoEmptyRun", "立即清倒过期项目"),
            busyText: t("ss.storage.autoEmptyRunBusy", "正在清倒…"),
            onAction: async () => {
                let removed = 0;
                try {
                    const result = await pruneOldTrash(AUTO_EMPTY_DAYS);
                    removed = (result && result.removed) || 0;
                } catch (err) {
                    log.info("plugin/system-settings", t("ss.storage.reauth", "需要重新授权"));
                    return;
                }
                if (globalThis.__dialog) {
                    globalThis.__dialog.alert(
                        t("ss.storage.autoEmpty", "自动清倒废纸篓"),
                        removed
                            ? tf("ss.storage.autoEmptyDone", "已清倒 {n} 项", { n: removed })
                            : t("ss.storage.autoEmptyNone", "没有超过 30 天的项目"),
                    );
                }
                await render();
            },
        }));

        renderCleanup();

        recBox.append(statusRow({
            label: t("ss.storage.icloud", "储存在 iCloud 中"),
            value: t("ss.storage.icloudUnavailable", "不可用"),
        }));
        recBox.append(note("ss.storage.icloudNote", "当前环境没有云端写入通道，可改为挂载本地文件夹。"));

        const dupGroups = duplicateDownloads(lastFiles, downloadsPath);
        if (dupGroups.length) {
            recBox.append(actionRow({
                label: t("ss.storage.dupTitle", "重复下载"),
                hint: tf("ss.storage.dupNote", "下载文件夹里有 {n} 组重复文件。", { n: dupGroups.length }),
                buttonText: t("ss.storage.dupOpen", "打开下载文件夹"),
                onAction: () => revealPath(downloadsPath),
            }));
        }
    }

    /** 大文件 Top 20：每条都能在访达定位或移入废纸篓。 */
    function renderLargeFiles() {
        largeBox.textContent = "";
        const big = lastFiles
            .filter((file) => (Number(file.size) || 0) >= LARGE_FILE_MIN)
            .sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0))
            .slice(0, LARGE_FILE_LIMIT);
        if (!big.length) {
            largeBox.append(note("ss.storage.largeEmpty", "没有超过 10 MB 的文件。"));
            return;
        }
        largeBox.append(note("ss.storage.largeHint", "超过 10 MB 的文件。"));
        big.forEach((file) => {
            const reveal = el("button", { class: "ss-btn", attrs: { type: "button" }, text: t("ss.storage.reveal", "在访达中显示") });
            reveal.addEventListener("click", () => revealPath(OSFS.parentOf(file.path)));
            const trashButton = el("button", { class: "ss-btn ss-btn--danger", attrs: { type: "button" }, text: t("ss.storage.moveToTrash", "移入废纸篓") });
            trashButton.addEventListener("click", async () => {
                try {
                    const result = await moveToTrash(file.path);
                    if (result && result.ok) {
                        log.info("plugin/system-settings", t("ss.storage.movedToTrash", "已移入废纸篓"));
                        await render();
                        return;
                    }
                } catch (err) {
                    if (err && err.name === "NeedsReauthError") {
                        log.info("plugin/system-settings", t("ss.storage.reauth", "需要重新授权"));
                        return;
                    }
                }
                if (globalThis.__dialog) {
                    globalThis.__dialog.error(t("ss.storage.trashFailed", "移入废纸篓失败"), file.path);
                }
            });
            largeBox.append(row({
                label: file.name,
                hint: formatBytes(file.size),
                control: el("div", { class: "ss-storage__cell" }, reveal, trashButton),
            }));
        });
    }

    async function render() {
        await renderRoot();
        await renderPlugins();
        const quota = await readQuota();
        await collectFiles();
        renderCategories();
        renderRecommendations(quota);
        renderLargeFiles();
    }

    root.append(
        section("ss.storage.categoryTitle", "储存空间分布", categoryBox),
        section("ss.storage.recTitle", "推荐", recBox),
        section("ss.storage.largeTitle", "大文件", largeBox),
        section("ss.storage.rootTitle", "根目录", rootBox),
        section("ss.storage.topTitle", "根目录结构", topBox),
        section("ss.storage.quota", "存储配额", quotaBox),
        section("ss.storage.pluginsTitle", "App 数据", pluginBox),
    );

    // VFS.init 幂等（内部走 OSFS.init 读回挂载句柄、复核权限、铺骨架）；等它完成后再画。
    const start = async () => {
        try {
            await VFS.init();
        } catch (err) {
            log.error("plugin/system-settings", "VFS 初始化失败，存储状态无法读取", err);
        }
        if (!root.isConnected) return;
        await render();
    };
    start();

    return root;
}
