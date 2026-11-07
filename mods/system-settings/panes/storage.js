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
import {
    el, t, row, group, section, note, statusRow, actionRow, usePaneStyle,
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
            },
        },
    },
};

/** 面板私有样式：存储位置状态、配额进度条。 */
const PANE_CSS = `
.ss-pane-storage .ss-storage__cell { display: flex; align-items: center; gap: 8px; }
.ss-pane-storage .ss-storage__where { font-size: 13px; }
.ss-pane-storage .ss-storage__status { font-size: 12px; color: var(--ss-text-secondary); }
.ss-pane-storage .ss-storage__status--granted { color: var(--accent); font-weight: 600; }
.ss-pane-storage .ss-storage__status--warn { color: var(--ss-danger); font-weight: 600; }
.ss-pane-storage .ss-storage__meter { width: 100%; height: 6px; border-radius: 3px; background: var(--ss-track); overflow: hidden; }
.ss-pane-storage .ss-storage__meter-fill { height: 100%; width: 0%; border-radius: 3px; background: var(--accent); transition: width 0.18s ease; }
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
    const root = el("div", { class: "ss-pane ss-pane-storage", dataset: { pane: paneId } });

    // 路径不写字面量：AppData 一律从 OSFS.TOP 取。
    const appdataPath = OSFS.TOP.appdata.path;

    const rootBox = group([]);
    const pluginBox = group([]);
    const quotaBox = group([]);

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
            return;
        }
        navigator.storage.estimate()
            .then((estimate) => {
                // formatBytes 返回的是 "1.5 KB" 这种字符串：再喂回 formatBytes 得 NaN → "—"，
                // 字符串比大小也恒 false（进度条恒 0%）。显示与比例都必须用原始数值（BUG-59）。
                const usage = Number(estimate.usage) || 0;
                const quota = Number(estimate.quota) || 0;
                quotaRow.setValue(`${formatBytes(usage)} / ${formatBytes(quota)}`);
                meterFill.style.width = quota > 0 ? `${Math.min(100, (usage / quota) * 100).toFixed(2)}%` : "0%";
            })
            .catch((err) => {
                log.debug("plugin/system-settings", "查询存储配额失败", err);
                quotaRow.setValue(t("ss.storage.quotaUnknown", "无法查询"));
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

    async function render() {
        await renderRoot();
        await renderPlugins();
        readQuota();
    }

    root.append(
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
