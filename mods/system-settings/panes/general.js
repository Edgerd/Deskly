/**
 * panes/general.js — 「通用」面板：子页导航（储存 / 时间与地区 / 关于本机）+ 备份恢复 + 软件更新
 *
 * 语言与时间设置已经拆到子面板「时间与地区」，存储明细拆到「储存」，更新日志拆到「关于本机」。
 * 三个子页在本页顶部以 iOS 式跳转行（图标 + 标题 + >）列出，点整行进入子页；
 * 返回走工具栏后退键。
 */

import { settings } from "../../../src/javascripts/settings.js";
import { log } from "../../../src/javascripts/log.js";
import { VERSION } from "../../../src/javascripts/version.js";
import { getSystemChangelog, latestGroup, versionLabel } from "../../../src/javascripts/changelog.js";
import {
    el, t, group, note, statusRow, actionRow, paneLink, usePaneStyle, track,
} from "../ui.js";
import { childPanes } from "../registry.js";


export const paneId = "general";

/** 面板语言包：四种语言都给全；注册失败时每个调用点还有中文回退。 */
export const messages = {
    "zh-CN": {
        ss: {
            general: {
                lastWrite: "最近写入",
                backup: "备份与恢复", backupTitle: "备份设置",
                backupButton: "导出备份", backupBusy: "正在导出…",
                backupDone: "已备份 {n} 项", backupEmpty: "没有可导出的设置值",
                restoreTitle: "恢复设置",
                restoreButton: "选择备份文件", restoreBusy: "正在读取…",
                restoreDone: "已恢复 {n} 项", restoreSkipped: "，跳过 {m} 项未识别",
                restoreCancelled: "已取消选择", restoreFailed: "备份文件读取失败",
                resetTitle: "恢复全部默认",
                resetButton: "恢复默认", resetBusy: "正在恢复…",
                resetAsk: "确定要把全部设置恢复默认吗？",
                resetAskBody: "此操作不可撤销，请先导出备份。",
                resetCancelled: "已取消，未改动任何设置",
                resetOk: "已恢复 {n} 项默认值",
                updateTitle: "软件更新",
                updateCurrent: "当前版本",
                updateLatest: "最新发布",
                updateState: "更新状态",
                updateUpToDate: "已是最新",
                updateNewer: "有新版本 {v}",
                updateCheckFailed: "未能读取发布信息",
                updateNote: "Deskly 是网页应用，没有应用内检查更新的通道；新版本随仓库发布，可在「关于本机」里查看更新日志。",
            },
        },
    },
    en: {
        ss: {
            general: {
                lastWrite: "Last Change",
                backup: "Backup & Restore", backupTitle: "Back Up Settings",
                backupButton: "Export Backup", backupBusy: "Exporting…",
                backupDone: "Backed up {n} items", backupEmpty: "Nothing to export",
                restoreTitle: "Restore Settings",
                restoreButton: "Choose Backup File", restoreBusy: "Reading…",
                restoreDone: "Restored {n} items", restoreSkipped: ", {m} unrecognized items skipped",
                restoreCancelled: "Selection cancelled", restoreFailed: "Could not read the backup file",
                resetTitle: "Reset All Settings",
                resetButton: "Reset", resetBusy: "Resetting…",
                resetAsk: "Reset every setting to its default?",
                resetAskBody: "This cannot be undone. Export a backup first.",
                resetCancelled: "Cancelled; nothing was changed",
                resetOk: "{n} settings reset to default",
                updateTitle: "Software Update",
                updateCurrent: "Current version",
                updateLatest: "Latest release",
                updateState: "Update status",
                updateUpToDate: "Up to date",
                updateNewer: "New version {v} available",
                updateCheckFailed: "Release info unavailable",
                updateNote: "Deskly is a web app with no in-app update channel; releases ship with the repository. See About This Mac for the changelog.",
            },
        },
    },
    "ja-JP": {
        ss: {
            general: {
                lastWrite: "最終変更",
                backup: "バックアップと復元", backupTitle: "設定をバックアップ",
                backupButton: "バックアップを書き出す", backupBusy: "書き出し中…",
                backupDone: "{n} 項目をバックアップしました", backupEmpty: "書き出せる設定値がありません",
                restoreTitle: "設定を復元",
                restoreButton: "ファイルを選ぶ", restoreBusy: "読み込み中…",
                restoreDone: "{n} 項目を復元しました", restoreSkipped: "、不明な {m} 項目をスキップ",
                restoreCancelled: "選択を中止しました", restoreFailed: "バックアップファイルを読み込めませんでした",
                resetTitle: "すべて初期状態に戻す",
                resetButton: "初期化", resetBusy: "初期化中…",
                resetAsk: "すべての設定を初期状態に戻しますか？",
                resetAskBody: "取り消せません。先にバックアップをおすすめします。",
                resetCancelled: "中止しました。変更はありません",
                resetOk: "{n} 項目を初期化しました",
                updateTitle: "ソフトウェア・アップデート",
                updateCurrent: "現在のバージョン",
                updateLatest: "最新リリース",
                updateState: "更新状態",
                updateUpToDate: "最新です",
                updateNewer: "新バージョン {v}",
                updateCheckFailed: "リリース情報を読めません",
                updateNote: "Deskly はウェブアプリのため、アプリ内の更新確認はありません。更新履歴は「この Mac について」で確認できます。",
            },
        },
    },
    cat: {
        ss: {
            general: {
                lastWrite: "最後寫咗邊項喵",
                backup: "备份與恢復喵", backupTitle: "幫主人存一份喵",
                backupButton: "导出备份喵", backupBusy: "正在打包喵…",
                backupDone: "存咗 {n} 項喵~", backupEmpty: "也沒有能存的東西喵~",
                restoreTitle: "把备份撿回來喵",
                restoreButton: "選备份文件喵", restoreBusy: "正在翻喵…",
                restoreDone: "撿回 {n} 項喵~", restoreSkipped: "，{m} 個認不出來的跳過了喵",
                restoreCancelled: "主人按了取消喵~", restoreFailed: "备份文件讀不出來喵~",
                resetTitle: "全部退回默認喵",
                resetButton: "全部重置喵", resetBusy: "正在清空喵…",
                resetAsk: "主人真的要把全部設定還原喵？",
                resetAskBody: "清晒就翻唔返㗎，建議先存一份备份喵~",
                resetCancelled: "沒動任何東西喵~",
                resetOk: "{n} 項回到初始喵~",
                updateTitle: "軟體更新喵",
                updateCurrent: "現在的版本喵",
                updateLatest: "最新發布喵",
                updateState: "更新狀態喵",
                updateUpToDate: "已經是最新喵",
                updateNewer: "有新版本 {v} 喵",
                updateCheckFailed: "發布資訊讀不出喵",
                updateNote: "Deskly 是網頁喵，冇有應用內檢查更新的通道喵；最近改動看「呢部機嘅檔案喵」喵。",
            },
        },
    },
};

/** 面板私有样式：只影响本面板；样式节点由 ui.usePaneStyle 按面板 id 复用。 */
const PANE_CSS = `
.ss-pane-general .ss-pane-general__file { display: none; }
`;

/**
 * 把译文里的 {占位符} 换成值。
 * i18n 只提供取值，不做插值，涉及数量的句子在这里补一次替换。
 * @param {string} key 词条键
 * @param {string} fallback 中文回退
 * @param {object} values {占位符: 值}
 * @returns {string} 成品文本
 */
function tf(key, fallback, values) {
    return Object.entries(values || {}).reduce(
        (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
        t(key, fallback),
    );
}

/** 备份文件名里的时间戳（本地时区；不用 ISO 的冒号，免得 Windows 落盘失败）。 */
function stamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** 语义化版本比较：a 大于 b 返回 1，相等 0，小于 -1；非数字段按 0 处理。 */
function compareVersions(a, b) {
    const pa = String(a || "").split(/[.\-]/).map((part) => Number(part) || 0);
    const pb = String(b || "").split(/[.\-]/).map((part) => Number(part) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff) return diff > 0 ? 1 : -1;
    }
    return 0;
}

/**
 * 用本面板自己造的 Blob 触发一次下载，不经任何外部服务。
 * @param {string} text 文件内容
 * @param {string} filename 落盘文件名
 * @returns {void}
 */
function download(text, filename) {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = el("a", { attrs: { href: url, download: filename } });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * 等用户在一个隐藏 <input type=file> 里选完文件。
 * change 与 cancel 都要接：只接 change 时用户按「取消」，动作会永远挂在那里不返回，
 * 面板上的按钮也就一直停在「正在读取…」。
 * @param {HTMLInputElement} input 文件输入
 * @returns {Promise<File|null>} 选中的文件；取消时为 null
 */
function pickFile(input) {
    return new Promise((resolve) => {
        const done = (file) => {
            input.removeEventListener("change", onChange);
            input.removeEventListener("cancel", onCancel);
            resolve(file);
        };
        const onChange = () => done(input.files && input.files[0] ? input.files[0] : null);
        const onCancel = () => done(null);
        input.addEventListener("change", onChange);
        input.addEventListener("cancel", onCancel);
        input.value = "";
        input.click();
    });
}

/** 系统弹窗入口：alert.js 由宿主早于插件加载，缺失时退回日志而不是抛错。 */
function showInfo(title, message) {
    if (globalThis.__dialog) globalThis.__dialog.alert(title, message);
    else log.info("plugin/system-settings", `${title}：${message}`);
}

/** 错误弹窗：文案以 textContent 形态给出，不参与 HTML 解析。 */
function showErrorDialog(title, message) {
    if (globalThis.__dialog) globalThis.__dialog.error(title, message);
    else log.error("plugin/system-settings", `${title}：${message}`);
}

/** 确认弹窗；没有弹窗能力时按「未确认」处理——危险操作绝不默认放行。 */
async function askConfirm(title, message, opts = {}) {
    if (globalThis.__dialog && typeof globalThis.__dialog.confirm === "function") {
        return Boolean(await globalThis.__dialog.confirm(title, message, opts));
    }
    log.warn("plugin/system-settings", "系统弹窗不可用，已取消「恢复全部默认」");
    return false;
}

/**
 * 构建「通用」面板。
 * @param {object} ctx 外壳给的上下文 {paneId, selectPane, openPane, t}
 * @returns {HTMLElement} 面板根元素
 */
export function build(ctx) {
    usePaneStyle(paneId, PANE_CSS);
    const root = el("div", { class: "ss-pane ss-pane-general", dataset: { pane: paneId } });

    const lastRow = statusRow({ label: t("ss.general.lastWrite", "最近写入"), value: "—" });

    const fileInput = el("input", {
        class: "ss-pane-general__file",
        attrs: { type: "file", accept: "application/json,.json", tabindex: "-1", "aria-hidden": "true" },
    });

    const backupRow = actionRow({
        label: t("ss.general.backupTitle", "备份设置"),
        buttonText: t("ss.general.backupButton", "导出备份"),
        busyText: t("ss.general.backupBusy", "正在导出…"),
        onAction: () => {
            const data = settings.snapshot();
            const count = Object.keys(data).length;
            if (!count) {
                showInfo(t("ss.general.backup", "备份与恢复"), t("ss.general.backupEmpty", "没有可导出的设置值"));
                return;
            }
            download(JSON.stringify(data, null, 2), `deskly-settings-${stamp()}.json`);
            lastRow.setValue(tf("ss.general.backupDone", `已备份 ${count} 项`, { n: count }));
            log.info("plugin/system-settings", `已导出设置备份，共 ${count} 个存储槽`);
        },
    });

    const restoreRow = actionRow({
        label: t("ss.general.restoreTitle", "恢复设置"),
        buttonText: t("ss.general.restoreButton", "选择备份文件"),
        busyText: t("ss.general.restoreBusy", "正在读取…"),
        onAction: async () => {
            const file = await pickFile(fileInput);
            if (!file) {
                lastRow.setValue(t("ss.general.restoreCancelled", "已取消选择"));
                return;
            }
            let data = null;
            try {
                data = JSON.parse(await file.text());
            } catch (err) {
                showErrorDialog(t("ss.general.restoreFailed", "备份文件读取失败"), String((err && err.message) || err));
                return;
            }
            const result = settings.restore(data);
            const text = tf("ss.general.restoreDone", `已恢复 ${result.restored} 项`, { n: result.restored })
                + (result.skipped.length ? tf("ss.general.restoreSkipped", `，跳过 ${result.skipped.length} 项未识别`, { m: result.skipped.length }) : "");
            lastRow.setValue(text);
            log.info("plugin/system-settings", `从备份恢复设置：${text}`);
        },
    });

    const resetRow = actionRow({
        label: t("ss.general.resetTitle", "恢复全部默认"),
        buttonText: t("ss.general.resetButton", "恢复默认"),
        busyText: t("ss.general.resetBusy", "正在恢复…"),
        tone: "danger",
        onAction: async () => {
            const confirmed = await askConfirm(
                t("ss.general.resetAsk", "要把全部设置恢复默认吗？"),
                t("ss.general.resetAskBody", "此操作无法撤销。建议先导出备份。"),
                { danger: true, okText: t("ss.general.resetButton", "恢复默认") },
            );
            if (!confirmed) {
                lastRow.setValue(t("ss.general.resetCancelled", "已取消，未改动任何设置"));
                return;
            }
            const count = settings.resetAll();
            lastRow.setValue(tf("ss.general.resetOk", `已恢复 ${count} 项默认值`, { n: count }));
            log.info("plugin/system-settings", `已按用户要求恢复全部默认，共 ${count} 项`);
        },
    });

    // ── 软件更新：版本单一来源是 version.js；最新发布号来自更新日志。
    //    网页应用没有应用内检查更新的通道，这里只做「当前版本 ↔ 日志最新发布」的对比，
    //    不假装能下载安装 —— 状态行只给事实。
    const currentVerRow = statusRow({ label: t("ss.general.updateCurrent", "当前版本"), value: `v${VERSION}` });
    const latestVerRow = statusRow({ label: t("ss.general.updateLatest", "最新发布"), value: "…" });
    const updateStateRow = statusRow({ label: t("ss.general.updateState", "更新状态"), value: "…" });

    let updateAlive = true;
    track(() => { updateAlive = false; });
    getSystemChangelog().then((data) => {
        if (!updateAlive) return;
        const latest = latestGroup(data);
        if (!latest) {
            latestVerRow.setValue(t("ss.general.updateCheckFailed", "未能读取发布信息"));
            updateStateRow.setValue(t("ss.general.updateCheckFailed", "未能读取发布信息"));
            return;
        }
        const latestText = latest.unreleased ? versionLabel(latest.version) : `v${latest.version}`;
        latestVerRow.setValue(latestText);
        // 未发布组意味着当前工作区就是最新；已发布组再做一次语义化版本比较
        if (latest.unreleased || compareVersions(VERSION, latest.version) >= 0) {
            updateStateRow.setValue(t("ss.general.updateUpToDate", "已是最新"));
        } else {
            updateStateRow.setValue(tf("ss.general.updateNewer", `有新版本 ${latestText}`, { v: latestText }));
        }
    }).catch((err) => {
        log.debug("plugin/system-settings", "读取更新日志失败", err);
        latestVerRow.setValue("—");
        updateStateRow.setValue(t("ss.general.updateCheckFailed", "未能读取发布信息"));
    });

    // 子页入口：顺序与注册表 order 一致（储存 → 时间与地区 → 关于本机）。
    const links = childPanes(paneId).map((child) => paneLink({
        label: t(child.i18nKey, child.label),
        icon: child.icon,
        onOpen: () => { if (ctx && typeof ctx.selectPane === "function") ctx.selectPane(child.id); },
    }));

    root.append(...[
        links.length ? group(links) : null,
        group([backupRow, restoreRow, resetRow, lastRow], { title: t("ss.general.backup", "备份与恢复") }),
        fileInput,
        group([currentVerRow, latestVerRow, updateStateRow], { title: t("ss.general.updateTitle", "软件更新") }),
        note("ss.general.updateNote", "Deskly 是网页应用，没有应用内检查更新的通道；新版本随仓库发布，可在「关于本机」里查看更新日志。"),
    ].filter(Boolean));

    return root;
}
