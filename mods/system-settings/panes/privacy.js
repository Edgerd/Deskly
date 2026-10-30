/**
 * panes/privacy.js — 「系统设置 › 隐私与安全性」面板
 *
 * permissions.js 的 list/query/request/storageEstimate **全是异步**的，所以表格先按
 * `permissions.rows()` 的定义立刻铺出骨架（通知、位置、摄像头、麦克风、剪贴板、持久存储），
 * 状态列再等 `list()` 回来整体重绘 —— 打开面板不白屏，也不拿猜测值冒充真实状态。
 *
 * `unsupported` 就写「不支持」并把请求按钮禁掉：网页无法替用户预先授权，
 * 装成能授权才是问题。底部的「清除所有本地数据」必须先过 __dialog.confirm，
 * 再交给 permissions.resetAll({confirm:true})：面板自己不删任何东西，
 * 而它清完会重载页面（owner 的行为）。
 */

import { permissions } from "../../../src/javascripts/permissions.js";
import {
    t, el, group, controlSwitch, actionRow, statusRow, table, usePaneStyle,
} from "../ui.js";

export const paneId = "privacy";

/** 权限状态到可读文案的映射键。 */
const STATE_KEYS = {
    granted: { key: "ss.privacy.stateGranted", fallback: "已允许" },
    denied: { key: "ss.privacy.stateDenied", fallback: "已拒绝" },
    prompt: { key: "ss.privacy.statePrompt", fallback: "未询问" },
    default: { key: "ss.privacy.statePrompt", fallback: "未询问" },
    unsupported: { key: "ss.privacy.stateUnsupported", fallback: "不支持" },
    unknown: { key: "ss.privacy.stateUnknown", fallback: "未知" },
    pending: { key: "ss.privacy.statePending", fallback: "正在查询" },
};

/** permissions.js 没及时给出行定义时的兜底清单（站内真实用到的能力）。 */
const FALLBACK_ROWS = [
    { name: "notifications", label: "通知" },
    { name: "geolocation", label: "位置" },
    { name: "camera", label: "摄像头" },
    { name: "microphone", label: "麦克风" },
    { name: "persistent-storage", label: "持久存储" },
];

/** 四语言文案。 */
export const messages = {
    "zh-CN": {
        ss: {
            privacy: {
                listGroup: "权限",
                nameColumn: "权限",
                stateColumn: "状态",
                actionColumn: "操作",
                requestBtn: "请求",
                requestingBtn: "等待授权…",
                grantedBtn: "已允许",
                unsupportedBtn: "不支持",
                empty: "没有权限记录。",
                storageGroup: "存储",
                storage: "存储占用",
                storageUnknown: "无法估算",
                storageValue: "已用 {usage} / 配额 {quota}（{percent}%）",
                persistedLabel: "持久存储",
                persistedYes: "不会被清理",
                persistedNo: "可能被清理",
                diagnosticsGroup: "诊断数据",
                captureConsole: "记录控制台输出",
                persist: "保留运行记录",
                dangerGroup: "危险操作",
                wipe: "清除所有本地数据",
                wipeHint: "清除后无法恢复。",
                wipeBtn: "清除",
                wipeTitle: "确定要清除所有本地数据吗？",
                wipeMessage: "清除后无法恢复，挂载的文件夹不会被删除。",
                wipeOk: "清除",
                wipeCancel: "取消",
                wipeDone: "已清除 {n} 项，正在重新加载。",
                wipeKept: "部分数据未清除，保留 {n} 项。",
                wipeMissing: "此操作暂不可用。",
                stateGranted: "已允许",
                stateDenied: "已拒绝",
                statePrompt: "未询问",
                stateUnsupported: "不支持",
                stateUnknown: "未知",
                statePending: "正在查询",
            },
        },
    },
    en: {
        ss: {
            privacy: {
                listGroup: "Permissions",
                nameColumn: "Permission",
                stateColumn: "Status",
                actionColumn: "Action",
                requestBtn: "Request",
                requestingBtn: "Waiting…",
                grantedBtn: "Allowed",
                unsupportedBtn: "Unsupported",
                empty: "No permissions found.",
                storageGroup: "Storage",
                storage: "Storage Used",
                storageUnknown: "No estimate available",
                storageValue: "{usage} used of {quota} ({percent}%)",
                persistedLabel: "Persistent Storage",
                persistedYes: "Will not be evicted",
                persistedNo: "May be evicted",
                diagnosticsGroup: "Diagnostics",
                captureConsole: "Record Console Output",
                persist: "Keep Log Across Reloads",
                dangerGroup: "Danger Zone",
                wipe: "Erase All Local Data",
                wipeHint: "Cannot be undone.",
                wipeBtn: "Erase",
                wipeTitle: "Erase all local data?",
                wipeMessage: "This cannot be undone. Your mounted folder is not deleted.",
                wipeOk: "Erase",
                wipeCancel: "Cancel",
                wipeDone: "Removed {n} items; reloading.",
                wipeKept: "Some data survived: {n} items kept.",
                wipeMissing: "Not available.",
                stateGranted: "Allowed",
                stateDenied: "Denied",
                statePrompt: "Not Asked",
                stateUnsupported: "Unsupported",
                stateUnknown: "Unknown",
                statePending: "Checking…",
            },
        },
    },
    "ja-JP": {
        ss: {
            privacy: {
                listGroup: "権限",
                nameColumn: "権限",
                stateColumn: "状態",
                actionColumn: "操作",
                requestBtn: "要求",
                requestingBtn: "承認待ち…",
                grantedBtn: "許可済み",
                unsupportedBtn: "未対応",
                empty: "権限がありません。",
                storageGroup: "ストレージ",
                storage: "ストレージ使用量",
                storageUnknown: "推定値を利用できません",
                storageValue: "使用 {usage} / 上限 {quota}（{percent}%）",
                persistedLabel: "永続ストレージ",
                persistedYes: "削除されません",
                persistedNo: "削除され得ます",
                diagnosticsGroup: "診断データ",
                captureConsole: "コンソールを記録",
                persist: "実行記録を保持",
                dangerGroup: "危険な操作",
                wipe: "すべてのデータを消去",
                wipeHint: "消去すると元に戻せません。",
                wipeBtn: "消去",
                wipeTitle: "すべてのデータを消去しますか？",
                wipeMessage: "消去すると元に戻せません。マウントしたフォルダは削除されません。",
                wipeOk: "消去",
                wipeCancel: "取り消す",
                wipeDone: "{n} 件を削除しました。再読み込みします。",
                wipeKept: "一部消去できず {n} 件残りました。",
                wipeMissing: "現在実行できません。",
                stateGranted: "許可済み",
                stateDenied: "拒否",
                statePrompt: "未確認",
                stateUnsupported: "未対応",
                stateUnknown: "不明",
                statePending: "確認中",
            },
        },
    },
    cat: {
        ss: {
            privacy: {
                listGroup: "权限喵",
                nameColumn: "哪个权限",
                stateColumn: "现在怎么样",
                actionColumn: "动手",
                requestBtn: "去要一下",
                requestingBtn: "等主人点头喵…",
                grantedBtn: "已经答应啦",
                unsupportedBtn: "浏览器不会",
                empty: "问唔着权限状态喵。",
                storageGroup: "占地方喵",
                storage: "存储占用喵",
                storageUnknown: "估不出来喵",
                storageValue: "用了 {usage} / 一共 {quota}（{percent}%）",
                persistedLabel: "持久存储喵",
                persistedYes: "说好不清我的",
                persistedNo: "随时可能被清",
                diagnosticsGroup: "诊断数据喵",
                captureConsole: "记下控制台的话喵",
                persist: "刷新后仲记得运行记录喵",
                dangerGroup: "很危险的操作喵",
                wipe: "把本地数据全清掉",
                wipeHint: "清晒就翻唔返㗎。",
                wipeBtn: "全清掉",
                wipeTitle: "真的要把本地数据全清掉吗喵？",
                wipeMessage: "清晒翻唔返㗎，你自己挂嘅文件夹唔会郁。",
                wipeOk: "清掉",
                wipeCancel: "先不要",
                wipeDone: "清咗 {n} 项，正喺重开页面喵。",
                wipeKept: "有 {n} 项没清掉喵。",
                wipeMissing: "暂时做唔到喵。",
                stateGranted: "已经答应",
                stateDenied: "被拒了",
                statePrompt: "还没问过",
                stateUnsupported: "浏览器不会",
                stateUnknown: "不太清楚",
                statePending: "正在问喵",
            },
        },
    },
};

const CSS = `
.ss-privacy .ss-table { width: 100%; }
.ss-privacy .ss-privacy__hint { font-size: 11px; opacity: .6; }
.ss-privacy .ss-privacy__state--granted { color: #2cd058; }
.ss-privacy .ss-privacy__state--denied { color: #ff453a; }
.ss-privacy .ss-privacy__state--neutral { opacity: .7; }
`;

/**
 * 构建隐私与安全性面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    usePaneStyle(paneId, CSS);

    /** 行状态表 name -> {state, supported}：异步回读写回后整体重绘。 */
    const live = new Map();
    const skeleton = rowDefs();
    skeleton.forEach((row) => live.set(row.name, { state: "pending", supported: true }));

    const permissionTable = table({
        columns: [
            {
                key: "name",
                label: t("ss.privacy.nameColumn", "权限"),
                width: "38%",
                render: (row) => el("div", {},
                    el("div", { text: String(row.label || row.name) }),
                    row.hint ? el("p", { class: "ss-privacy__hint", text: String(row.hint) }) : null),
            },
            {
                key: "state",
                label: t("ss.privacy.stateColumn", "状态"),
                width: "26%",
                render: (row) => {
                    const info = live.get(row.name) || { state: "unknown" };
                    return el("span", {
                        class: `ss-privacy__state ss-privacy__state--${toneOf(info.state)}`,
                        text: stateLabel(info.state),
                    });
                },
            },
            {
                key: "action",
                label: t("ss.privacy.actionColumn", "操作"),
                width: "36%",
                render: (row) => buildRequestButton(row, live, () => permissionTable.setRows(currentRows(skeleton, live))),
            },
        ],
        rows: currentRows(skeleton, live),
        empty: t("ss.privacy.empty", "没有权限记录。"),
    });

    /** 等 permissions.list() 回来，把每行状态填进表格。 */
    async function refreshStates() {
        if (typeof permissions?.list !== "function") return;
        const rows = await permissions.list();
        (rows || []).forEach((raw) => {
            const entry = normalizePermission(raw);
            if (entry) live.set(entry.name, { state: entry.state, supported: entry.supported });
        });
        permissionTable.setRows(currentRows(skeleton, live));
    }
    refreshStates().catch(() => permissionTable.setRows(currentRows(skeleton, live)));

    const storageRow = statusRow({ label: t("ss.privacy.storage", "存储占用"), value: "…" });
    const persistedRow = statusRow({ label: t("ss.privacy.persistedLabel", "持久存储") });

    /** 读一次占用与持久化状态。 */
    async function refreshStorage() {
        const estimate = await readStorageEstimate();
        storageRow.setValue(estimate.text);
        persistedRow.setValue(estimate.persisted === null
            ? t("ss.privacy.storageUnknown", "无法估算")
            : (estimate.persisted ? t("ss.privacy.persistedYes", "不会被清理") : t("ss.privacy.persistedNo", "可能被清理")));
    }
    refreshStorage();

    const wipeRow = actionRow({
        label: t("ss.privacy.wipe", "清除所有本地数据"),
        hint: t("ss.privacy.wipeHint", "清除后无法恢复。"),
        buttonText: t("ss.privacy.wipeBtn", "清除"),
        tone: "danger",
        onAction: async () => {
            if (typeof permissions?.resetAll !== "function") {
                storageRow.setValue(t("ss.privacy.wipeMissing", "此操作暂不可用。"));
                return;
            }
            const ok = await window.__dialog?.confirm?.(
                t("ss.privacy.wipeTitle", "确定要清除所有本地数据吗？"),
                t("ss.privacy.wipeMessage", "清除后无法恢复，挂载的文件夹不会被删除。"),
                { okText: t("ss.privacy.wipeOk", "清除"), cancelText: t("ss.privacy.wipeCancel", "取消") }
            );
            if (!ok) return;
            const result = await permissions.resetAll({ confirm: true });
            const kept = Number(result?.keptKeys?.length) || 0;
            storageRow.setValue(kept
                ? t("ss.privacy.wipeKept", "部分数据未清除，保留 {n} 项。").replace("{n}", String(kept))
                : t("ss.privacy.wipeDone", "已清除 {n} 项，正在重新加载。").replace("{n}", String(Number(result?.removedKeys) || 0)));
        },
    });
    if (typeof permissions?.resetAll !== "function") wipeRow.querySelector(".ss-btn")?.setAttribute("disabled", "");

    return el("div", { class: "ss-pane ss-privacy" },
        group([permissionTable], { title: t("ss.privacy.listGroup", "权限") }),

        group([storageRow, persistedRow], { title: t("ss.privacy.storageGroup", "存储") }),

        group([
            controlSwitch("debug.captureConsole", {
                label: t("ss.privacy.captureConsole", "记录控制台输出"),
            }),
            controlSwitch("debug.persist", {
                label: t("ss.privacy.persist", "保留运行记录"),
            }),
        ], { title: t("ss.privacy.diagnosticsGroup", "诊断数据") }),

        group([wipeRow], { title: t("ss.privacy.dangerGroup", "危险操作") })
    );
}

/**
 * 权限行骨架：优先 permissions.rows()，缺失时退回内置的五项清单。
 * @returns {Array<{name:string, label:string, hint?:string}>} 行定义
 */
function rowDefs() {
    const rows = typeof permissions?.rows === "function" ? permissions.rows() : null;
    if (Array.isArray(rows) && rows.length) return rows.map((row) => ({ ...row }));
    return FALLBACK_ROWS.map((row) => ({ ...row }));
}

/**
 * 把骨架与实时状态合成表格数据。
 * @param {Array<object>} skeleton 行定义
 * @param {Map<string, object>} live 状态表
 * @returns {Array<object>} 表格行
 */
function currentRows(skeleton, live) {
    return skeleton.map((row) => ({ ...row, state: (live.get(row.name) || {}).state || "pending" }));
}

/**
 * 生成一行的「请求」按钮：不支持、未询问完、已允许的都禁用，请求完立刻回读整表。
 * @param {object} row 行定义
 * @param {Map<string, object>} live 状态表
 * @param {Function} repaint 重绘表格
 * @returns {HTMLElement} 按钮元素
 */
function buildRequestButton(row, live, repaint) {
    const info = live.get(row.name) || { state: "pending", supported: true };
    const canAsk = info.supported && info.state !== "granted" && info.state !== "pending";
    const button = el("button", {
        class: "ss-btn ss-btn--small",
        attrs: { type: "button", disabled: canAsk ? false : "" },
        text: info.state === "granted"
            ? t("ss.privacy.grantedBtn", "已允许")
            : (info.supported ? t("ss.privacy.requestBtn", "请求") : t("ss.privacy.unsupportedBtn", "不支持")),
    });
    button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = t("ss.privacy.requestingBtn", "等待授权…");
        try {
            const entry = normalizePermission(await permissions?.request?.(row.name), row.name);
            if (entry) live.set(entry.name, { state: entry.state, supported: entry.supported !== false });
        } finally {
            repaint();
        }
    });
    return button;
}

/**
 * 把一条权限记录归一成 {name, state, supported}，容忍缺字段与不同命名。
 * @param {*} raw query()/list()/request() 的返回
 * @param {string} [nameHint] 调用方已知的权限名
 * @returns {{name:string, state:string, supported:boolean}|null} 归一结果
 */
function normalizePermission(raw, nameHint) {
    if (typeof raw === "string") return { name: raw, state: "unknown", supported: true };
    if (!raw || typeof raw !== "object") return null;
    const name = String(raw.name || raw.permission || nameHint || "");
    if (!name) return null;
    const state = String(raw.state || raw.status || (raw.ok === true ? "granted" : raw.ok === false ? "denied" : "unknown"));
    const supported = raw.supported !== false && state !== "unsupported";
    return { name, state, supported };
}

/**
 * 状态对应的颜色类别。
 * @param {string} state 权限状态
 * @returns {string} 类别名
 */
function toneOf(state) {
    if (state === "granted") return "granted";
    if (state === "denied") return "denied";
    return "neutral";
}

/**
 * 权限状态文案；未知取值原样显示，便于对齐 permissions.js 的实现。
 * @param {string} state 权限状态
 * @returns {string} 文案
 */
function stateLabel(state) {
    const entry = STATE_KEYS[state];
    return entry ? t(entry.key, entry.fallback) : state;
}

/**
 * 读取本站存储占用估算（含持久化标记）。
 * @returns {Promise<{text:string, persisted:boolean|null}>} 展示数据
 */
async function readStorageEstimate() {
    if (typeof permissions?.storageEstimate !== "function") {
        return { text: t("ss.privacy.storageUnknown", "无法估算"), persisted: null };
    }
    try {
        const estimate = await permissions.storageEstimate();
        if (!estimate || estimate.supported === false) {
            return { text: t("ss.privacy.storageUnknown", "无法估算"), persisted: null };
        }
        const text = t("ss.privacy.storageValue", "已用 {usage} / 配额 {quota}（{percent}%）")
            .replace("{usage}", formatBytes(Number(estimate.usage) || 0))
            .replace("{quota}", formatBytes(Number(estimate.quota) || 0))
            .replace("{percent}", String(estimate.percent ?? 0));
        return { text, persisted: typeof estimate.persisted === "boolean" ? estimate.persisted : null };
    } catch {
        return { text: t("ss.privacy.storageUnknown", "无法估算"), persisted: null };
    }
}

/**
 * 字节数转可读单位（保留一位小数）。
 * @param {number} bytes 字节数
 * @returns {string} 文本
 */
function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / (1024 ** index);
    return `${index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/** 面板不持有全局资源；表格重绘与权限查询都是面板内的局部状态。 */
export function destroy() { }
