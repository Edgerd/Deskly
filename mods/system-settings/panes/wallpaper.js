/**
 * panes/wallpaper.js — 「墙纸」面板：系统内置壁纸、Bing 每日壁纸、网络地址、本地上传与恢复默认
 *
 * 状态归属：壁纸配置与 wallpaper.config 用的是同一个存储槽，权威在 wallpaper.js。
 * 本面板一律通过 wallpaper 的接口读写（setSystemWallpaper / setNetworkWallpaper /
 * uploadLocal / resetWallpaper / fetchBingWallpaper），只让「开关」这一项走设置中枢
 * （wallpaper.autoBing 的定义里 apply 就指向 wallpaper.setAutoBing）；
 * 界面自己绝不 setItem —— 两处各写一次正是旧版「看着生效了、刷新后没了」的根因。
 * 刷新界面的时机是 wallpaper 广播的 wallpaper-change，因此控制中心、开机自动 Bing
 * 等任何来源换了壁纸，这里的预览都会跟着动。
 *
 * 旧版那块「在所有空间中显示」开关没有任何绑定与生效方，属于死控件，本次不再出现。
 */

import { wallpaper } from "../../../src/javascripts/wallpaper.js";
import { log } from "../../../src/javascripts/log.js";
import {
    el, t, row, group, statusRow, actionRow,
    controlSwitch, controlText, usePaneStyle, track,
} from "../ui.js";

export const paneId = "wallpaper";

/** 面板语言包。 */
export const messages = {
    "zh-CN": {
        ss: {
            pane: { wallpaper: "墙纸" },
            wallpaper: {
                current: "当前墙纸", currentName: "名称", currentType: "来源",
                type: { default: "内置默认", system: "系统内置", network: "网络地址", upload: "本地上传", bing: "Bing 每日" },
                system: "系统内置墙纸",
                bing: "Bing 每日壁纸", bingTitle: "每日自动更新",
                bingAction: "获取今日图片", bingBusy: "正在获取…",
                bingFailed: "获取 Bing 壁纸失败", bingFailedBody: "无法连接，已保留当前墙纸。",
                custom: "自定义墙纸", networkTitle: "网络壁纸地址",
                networkPlaceholder: "https://…/image.jpg", networkButton: "应用", networkEmpty: "请先填入图片地址",
                networkFailed: "这张图片没能载入", uploadTitle: "本地图片",
                uploadButton: "选择图片",
                uploadBusy: "正在压缩…", uploadFailed: "本地图片设置失败",
                uploadSize: "压缩后约 {v}，已写入本机存储", uploadNotPersisted: "本次未持久化，刷新后会恢复",
                resetTitle: "默认墙纸", resetButton: "恢复默认",
                quota: "本机存储占用",
            },
        },
    },
    en: {
        ss: {
            pane: { wallpaper: "Wallpaper" },
            wallpaper: {
                current: "Current wallpaper", currentName: "Name", currentType: "Source",
                type: { default: "Built-in default", system: "Built-in", network: "Network URL", upload: "Local upload", bing: "Bing daily" },
                system: "Built-in wallpapers",
                bing: "Bing daily wallpaper", bingTitle: "Update automatically every day",
                bingAction: "Get today's picture", bingBusy: "Fetching…",
                bingFailed: "Could not fetch the Bing wallpaper", bingFailedBody: "Couldn't connect; your current wallpaper is kept.",
                custom: "Custom wallpaper", networkTitle: "Network wallpaper URL",
                networkPlaceholder: "https://…/image.jpg", networkButton: "Apply", networkEmpty: "Enter an image URL first",
                networkFailed: "That image could not be loaded", uploadTitle: "Local image",
                uploadButton: "Choose image",
                uploadBusy: "Compressing…", uploadFailed: "Could not apply the local image",
                uploadSize: "Compressed to about {v} and stored locally", uploadNotPersisted: "Not persisted; it reverts after a reload",
                resetTitle: "Default wallpaper", resetButton: "Restore default",
                quota: "Local storage used",
            },
        },
    },
    "ja-JP": {
        ss: {
            pane: { wallpaper: "壁紙" },
            wallpaper: {
                current: "現在の壁紙", currentName: "名前", currentType: "取得元",
                type: { default: "既定", system: "内蔵", network: "ネットワーク", upload: "ローカル", bing: "Bing 毎日" },
                system: "内蔵壁紙",
                bing: "Bing 毎日壁紙", bingTitle: "毎日自動で更新",
                bingAction: "今日の画像を取得", bingBusy: "取得中…",
                bingFailed: "Bing 壁紙の取得に失敗しました", bingFailedBody: "接続できません。現在の壁紙はそのままです。",
                custom: "カスタム壁紙", networkTitle: "ネットワーク上の画像 URL",
                networkPlaceholder: "https://…/image.jpg", networkButton: "適用", networkEmpty: "URL を入力してください",
                networkFailed: "画像を読み込めませんでした", uploadTitle: "ローカルの画像",
                uploadButton: "画像を選ぶ",
                uploadBusy: "圧縮中…", uploadFailed: "ローカル画像を適用できませんでした",
                uploadSize: "圧縮後およそ {v}、本機に保存しました", uploadNotPersisted: "今回は永続化されず、再読み込みで戻ります",
                resetTitle: "既定の壁紙", resetButton: "既定に戻す",
                quota: "本機保存の使用量",
            },
        },
    },
    cat: {
        ss: {
            pane: { wallpaper: "壁紙喵" },
            wallpaper: {
                current: "主人現在看的壁紙喵", currentName: "叫什麼喵", currentType: "從哪兒來的喵",
                type: { default: "自帶默認喵", system: "自帶喵", network: "網路地址喵", upload: "主人自己傳的喵", bing: "Bing 每日喵" },
                system: "自帶的壁紙喵",
                bing: "Bing 每日壁紙喵", bingTitle: "每天自動換喵",
                bingAction: "撿今天的圖喵", bingBusy: "正在網外頭看喵…",
                bingFailed: "Bing 的圖沒撻回來喵~", bingFailedBody: "網路不通喵，主人的壁紙還留著原樣。",
                custom: "主人自己挑的壁紙喵", networkTitle: "網路上的圖片地址喵",
                networkPlaceholder: "https://…/image.jpg", networkButton: "就它了喵", networkEmpty: "主人還沒填地址喵~",
                networkFailed: "這張圖打不開喵~", uploadTitle: "主人的圖片喵",
                uploadButton: "選張圖喵",
                uploadBusy: "正在壓小喵…", uploadFailed: "主人的圖放不上去喵~",
                uploadSize: "壓完大約 {v}，已經收進本機喵~", uploadNotPersisted: "今次冇存落去喵，刷新會變返",
                resetTitle: "默認壁紙喵", resetButton: "換回默認喵",
                quota: "本機被占了多少喵",
            },
        },
    },
};

/** 面板私有样式：预览块与系统壁纸网格。 */
const PANE_CSS = `
.ss-pane-wallpaper .ss-wp__preview {
    width: 100%;
    aspect-ratio: 16 / 9;
    border-radius: 9px;
    border: 1px solid var(--ss-row-divider);
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
    background-color: var(--ss-row-bg);
}
.ss-pane-wallpaper .ss-wp__preview-text { display: flex; flex-direction: column; gap: 2px; }
.ss-wp__grid { display: flex; flex-wrap: wrap; gap: 10px; width: 100%; }
.ss-wp__cell {
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    padding: 0; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer;
}
.ss-wp__cell img {
    width: 92px; height: 58px; object-fit: cover; border-radius: 7px;
    border: 2px solid transparent; outline: 1px solid var(--ss-control-border);
    background: var(--ss-row-bg);
}
.ss-wp__cell--on img { border-color: var(--accent); outline-color: transparent; }
.ss-wp__cell span { font-size: 11.5px; color: var(--ss-text-secondary); }
.ss-wp__cell--on span { color: var(--ss-text); font-weight: 600; }
.ss-wp__file { display: none; }
`;

/** 字节数说成人类可读的文本。 */
function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 译文插值（i18n 只取值不插值）。 */
function tf(key, fallback, values) {
    return Object.entries(values || {}).reduce(
        (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
        t(key, fallback),
    );
}

/** 错误弹窗：文案以 textContent 形态给出。 */
function showErrorDialog(title, message) {
    if (globalThis.__dialog) globalThis.__dialog.error(title, message);
    else log.error("plugin/system-settings", `${title}：${message}`);
}

/**
 * 等一个隐藏 <input type=file> 选完文件；change 与 cancel 都接，用户取消也要让动作返回。
 * @param {HTMLInputElement} input 文件输入
 * @returns {Promise<File|null>} 选中的文件，取消时 null
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

/**
 * 构建「墙纸」面板。
 * @param {object} ctx 外壳上下文
 * @returns {HTMLElement} 面板根元素
 */
export function build(ctx) {
    usePaneStyle(paneId, PANE_CSS);
    const root = el("div", { class: "ss-pane ss-pane-wallpaper", dataset: { pane: paneId } });

    const preview = el("div", { class: "ss-wp__preview", attrs: { role: "img" } });
    const nameRow = statusRow({ label: t("ss.wallpaper.currentName", "名称"), value: "—" });
    const typeRow = statusRow({ label: t("ss.wallpaper.currentType", "来源"), value: "—" });
    const grid = el("div", { class: "ss-wp__grid" });
    const fileInput = el("input", {
        class: "ss-wp__file",
        attrs: { type: "file", accept: "image/*", tabindex: "-1", "aria-hidden": "true" },
    });

    const typeName = (() => {
        const table = {
            default: t("ss.wallpaper.type.default", "内置默认"),
            system: t("ss.wallpaper.type.system", "系统内置"),
            network: t("ss.wallpaper.type.network", "网络地址"),
            upload: t("ss.wallpaper.type.upload", "本地上传"),
            bing: t("ss.wallpaper.type.bing", "Bing 每日"),
        };
        return (type) => table[type] || type;
    })();

    /** 按 wallpaper 模块的当前配置重画预览、名称、来源与网格选中态。 */
    const refresh = () => {
        const config = wallpaper.getWallpaperConfig();
        preview.style.backgroundImage = config.url ? `url("${config.url}")` : "";
        preview.setAttribute("aria-label", config.name || typeName(config.type));
        nameRow.setValue(config.name || typeName(config.type));
        typeRow.setValue(typeName(config.type));
        grid.querySelectorAll(".ss-wp__cell").forEach((cell) => {
            cell.classList.toggle("ss-wp__cell--on", cell.dataset.url === config.url);
        });
    };

    wallpaper.getSystemWallpapers().forEach((item) => {
        const cell = el("button", {
            class: "ss-wp__cell", attrs: { type: "button" }, dataset: { url: item.url },
        }, el("img", { attrs: { src: item.thumb, alt: "" } }), el("span", { text: item.name }));
        cell.addEventListener("click", () => {
            if (!wallpaper.setSystemWallpaper(item.id)) {
                showErrorDialog(t("ss.wallpaper.system", "系统内置墙纸"), `${item.name}`);
                return;
            }
            refresh();
            log.info("plugin/system-settings", `墙纸已切换为系统内置：${item.name}`);
        });
        grid.append(cell);
    });

    const bingRow = actionRow({
        label: t("ss.wallpaper.bing", "Bing 每日壁纸"),
        buttonText: t("ss.wallpaper.bingAction", "获取今日图片"),
        busyText: t("ss.wallpaper.bingBusy", "正在获取…"),
        tone: "accent",
        onAction: async () => {
            try {
                const url = await wallpaper.fetchBingWallpaper();
                refresh();
                log.info("plugin/system-settings", `已应用 Bing 每日壁纸：${String(url).slice(0, 80)}`);
            } catch (err) {
                showErrorDialog(
                    t("ss.wallpaper.bingFailed", "获取 Bing 壁纸失败"),
                    `${t("ss.wallpaper.bingFailedBody", "无法连接，已保留当前墙纸。")} ${String((err && err.message) || err)}`,
                );
                throw err;
            }
        },
    });

    const networkRow = controlText({
        label: t("ss.wallpaper.networkTitle", "网络壁纸地址"),
        placeholder: t("ss.wallpaper.networkPlaceholder", "https://…/image.jpg"),
        buttonText: t("ss.wallpaper.networkButton", "应用"),
        onSubmit: async (value) => {
            if (!value) {
                showErrorDialog(t("ss.wallpaper.networkTitle", "网络壁纸地址"), t("ss.wallpaper.networkEmpty", "请先填入图片地址"));
                return;
            }
            try {
                await wallpaper.setNetworkWallpaper(value);
                refresh();
            } catch (err) {
                showErrorDialog(
                    t("ss.wallpaper.networkFailed", "这张图片没能载入"),
                    String((err && err.message) || err),
                );
            }
        },
    });

    const quotaRow = statusRow({ label: t("ss.wallpaper.quota", "本机存储占用"), value: "—" });

    const uploadRow = actionRow({
        label: t("ss.wallpaper.uploadTitle", "本地图片"),
        buttonText: t("ss.wallpaper.uploadButton", "选择图片"),
        busyText: t("ss.wallpaper.uploadBusy", "正在压缩…"),
        onAction: async () => {
            const file = await pickFile(fileInput);
            if (!file) return;
            try {
                const result = await wallpaper.uploadLocal(file);
                const sizeText = formatBytes(result.bytes || 0);
                refresh();
                quotaRow.setValue(sizeText);
                // 本体在 IndexedDB（不再挤 localStorage 配额），persisted=false 时
                // wallpaper.js 自己已弹过提示，这里只把结果写进运行记录。
                const message = result.persisted
                    ? tf("ss.wallpaper.uploadSize", `压缩后约 ${sizeText}，已写入本机存储`, { v: sizeText })
                    : t("ss.wallpaper.uploadNotPersisted", "本次未持久化，刷新后会恢复");
                log.info("plugin/system-settings", message);
            } catch (err) {
                showErrorDialog(
                    t("ss.wallpaper.uploadFailed", "本地图片设置失败"),
                    String((err && err.message) || err),
                );
                throw err;
            }
        },
    });

    const resetRow = actionRow({
        label: t("ss.wallpaper.resetTitle", "默认墙纸"),
        buttonText: t("ss.wallpaper.resetButton", "恢复默认"),
        onAction: () => {
            wallpaper.resetWallpaper();
            refresh();
            log.info("plugin/system-settings", "已恢复默认墙纸");
        },
    });

    root.append(
        group([row({ label: "", control: preview, stack: true }), nameRow, typeRow, quotaRow], { tone: "plain", title: t("ss.wallpaper.current", "当前墙纸") }),

        group([row({ label: "", control: grid, stack: true })], { tone: "plain", title: t("ss.wallpaper.system", "系统内置墙纸") }),

        group([controlSwitch("wallpaper.autoBing", {
            label: t("ss.wallpaper.bingTitle", "每日自动更新"),
        }), bingRow], { title: t("ss.wallpaper.bing", "Bing 每日壁纸") }),

        group([networkRow, uploadRow, resetRow], { title: t("ss.wallpaper.custom", "自定义墙纸") }),
        fileInput,
    );

    refresh();

    // 任何来源换壁纸（本面板、控制中心、开机自动 Bing）都走这一条；订阅登记进 ui.js，
    // 切面板或关窗时由 disposeAll() 摘掉。
    const onChange = () => refresh();
    window.addEventListener("wallpaper-change", onChange);
    track(() => window.removeEventListener("wallpaper-change", onChange));

    return root;
}
