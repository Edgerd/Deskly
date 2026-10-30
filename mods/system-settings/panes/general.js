/**
 * panes/general.js — 「通用」面板：语言、时间、设置存储读数，以及备份 / 恢复 / 恢复默认三条真实动作
 *
 * 与旧版的区别：这个文件里没有一处 localStorage 字面量。
 * 读写全部经 ui.js 的 bind()（它只调 settings.get/set），动作全部调设置中枢自己的
 * snapshot / restore / resetAll / storage —— 备份出来的就是中枢能认回去的格式，
 * 界面不再复制一遍键名（旧版界面与内核各写各的键，写错一个字符就静默失效）。
 *
 * 语言下拉的选项在每次 build() 时重新取自 i18n.getSupportedLanguages()：
 * 旧版把选项表算在模块求值时，切换语言后界面就永远冻在旧语言里。
 */

import { settings } from "../../../src/javascripts/settings.js";
import { i18n } from "../../../src/javascripts/i18n.js";
import { log } from "../../../src/javascripts/log.js";
import {
    el, t, group, note, statusRow, actionRow,
    controlSwitch, controlSegmented, controlDropdown, usePaneStyle, track,
} from "../ui.js";

export const paneId = "general";

/** 面板语言包：四种语言都给全；注册失败时每个调用点还有中文回退。 */
export const messages = {
    "zh-CN": {
        ss: {
            general: {
                language: "语言",
                time: "日期与时间", timeFormat: "时间格式", time24: "24 小时", time12: "12 小时",
                showSeconds: "显示秒",
                weekStart: "周起始日", sunday: "周日", monday: "周一",
                storage: "存储", storageKeys: "已登记设置项", storageBytes: "占用空间",
                storageEstimate: "存储配额", storageUnavailable: "不可用",
                storageDegraded: "本机存储不可用，改动刷新后会丢失。",
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
            },
        },
    },
    en: {
        ss: {
            general: {
                language: "Language",
                time: "Date & Time", timeFormat: "Time Format", time24: "24-hour", time12: "12-hour",
                showSeconds: "Show Seconds",
                weekStart: "First Day of Week", sunday: "Sunday", monday: "Monday",
                storage: "Storage", storageKeys: "Registered Settings", storageBytes: "Space Used",
                storageEstimate: "Storage Quota", storageUnavailable: "Unavailable",
                storageDegraded: "Local storage is unavailable; changes are lost on reload.",
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
            },
        },
    },
    "ja-JP": {
        ss: {
            general: {
                language: "言語",
                time: "日付と時刻", timeFormat: "時刻の形式", time24: "24時間", time12: "12時間",
                showSeconds: "秒を表示",
                weekStart: "週の始まり", sunday: "日曜日", monday: "月曜日",
                storage: "ストレージ", storageKeys: "登録済みの設定項目", storageBytes: "使用量",
                storageEstimate: "ストレージ割当", storageUnavailable: "利用できません",
                storageDegraded: "端末の保存領域が使えず、変更は再読み込みで失われます。",
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
            },
        },
    },
    cat: {
        ss: {
            general: {
                language: "主人要用的語言喵",
                time: "日期與時間喵", timeFormat: "時間怎麼讀喵", time24: "24 小時喵", time12: "12 小時喵",
                showSeconds: "把秒也露出來喵",
                weekStart: "一週從哪天開始喵", sunday: "星期日喵", monday: "星期一喵",
                storage: "存储喵", storageKeys: "記在冊的設定項喵", storageBytes: "占地兒多少喵",
                storageEstimate: "存储配额喵", storageUnavailable: "喵用不上喵",
                storageDegraded: "本機存储唔聽用，改動一刷新就冇咗喵~",
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

/** 字节数说成人类可读的一段文本。 */
function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 备份文件名里的时间戳（本地时区；不用 ISO 的冒号，免得 Windows 落盘失败）。 */
function stamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
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
async function askConfirm(title, message) {
    if (globalThis.__dialog && typeof globalThis.__dialog.confirm === "function") {
        return Boolean(await globalThis.__dialog.confirm(title, message));
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

    // 语言选项每次构建重新取一遍；当前值不在支持列表里（历史遗留值）也要能显示出来
    const languageOptions = i18n.getSupportedLanguages().map((item) => ({ value: item.code, label: item.label }));
    const currentLanguage = String(settings.get("general.language") || "zh-CN");
    if (!languageOptions.some((option) => option.value === currentLanguage)) {
        languageOptions.unshift({ value: currentLanguage, label: currentLanguage });
    }

    const keysRow = statusRow({ label: t("ss.general.storageKeys", "已登记设置项"), value: "—" });
    const bytesRow = statusRow({ label: t("ss.general.storageBytes", "占用空间"), value: "—" });
    const quotaRow = statusRow({ label: t("ss.general.storageEstimate", "存储配额"), value: "…" });
    const lastRow = statusRow({ label: t("ss.general.lastWrite", "最近写入"), value: "—" });
    const degradedNote = note("ss.general.storageDegraded", "本机存储不可用，改动刷新后会丢失。");
    degradedNote.hidden = true;

    /** 刷新存储读数；订阅者会在任何一次写入后被叫到。 */
    const refreshStorage = (detail) => {
        const info = settings.storage();
        keysRow.setValue(String(info.keys));
        bytesRow.setValue(formatBytes(info.bytes));
        degradedNote.hidden = !info.degraded;
        if (detail && detail.key) lastRow.setValue(detail.key);
    };
    refreshStorage();
    track(settings.subscribe(refreshStorage));

    if (navigator.storage && typeof navigator.storage.estimate === "function") {
        navigator.storage.estimate()
            .then((estimate) => {
                const usage = formatBytes(estimate.usage || 0);
                const quota = formatBytes(estimate.quota || 0);
                quotaRow.setValue(`${usage} / ${quota}`);
            })
            .catch((err) => log.debug("plugin/system-settings", "存储配额查询失败", err));
    } else {
        quotaRow.setValue(t("ss.general.storageUnavailable", "不可用"));
    }

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
            refreshStorage();
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
                t("ss.general.resetAsk", "确定要把全部设置恢复默认吗？"),
                t("ss.general.resetAskBody", "此操作不可撤销，请先导出备份。"),
            );
            if (!confirmed) {
                lastRow.setValue(t("ss.general.resetCancelled", "已取消，未改动任何设置"));
                return;
            }
            const count = settings.resetAll();
            lastRow.setValue(tf("ss.general.resetOk", `已恢复 ${count} 项默认值`, { n: count }));
            refreshStorage();
            log.info("plugin/system-settings", `已按用户要求恢复全部默认，共 ${count} 项`);
        },
    });

    root.append(
        group([
            controlDropdown("general.language", {
                label: t("ss.general.language", "语言"),
                options: languageOptions,
            }),
        ]),

        group([
            controlSegmented("general.timeFormat", {
                label: t("ss.general.timeFormat", "时间格式"),
                options: [
                    { value: "24h", label: t("ss.general.time24", "24 小时") },
                    { value: "12h", label: t("ss.general.time12", "12 小时") },
                ],
            }),
            controlSwitch("general.showSeconds", {
                label: t("ss.general.showSeconds", "显示秒"),
            }),
            controlSegmented("general.weekStart", {
                label: t("ss.general.weekStart", "周起始日"),
                options: [
                    { value: 0, label: t("ss.general.sunday", "周日") },
                    { value: 1, label: t("ss.general.monday", "周一") },
                ],
            }),
        ], { title: t("ss.general.time", "日期与时间") }),

        group([keysRow, bytesRow, quotaRow, lastRow], { title: t("ss.general.storage", "存储") }),
        degradedNote,

        group([backupRow, restoreRow, resetRow], { title: t("ss.general.backup", "备份与恢复") }),
        fileInput,
    );

    return root;
}
