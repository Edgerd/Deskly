/**
 * panes/mouse.js — 「鼠标」面板：光标大小 / 阴影 + 真正生效光标的实时预览 + 各角色自定义
 *
 * 生效链路：cursor.size / cursor.shadow 的 apply 指向 cursor.js 的 setCursorSize / setCursorShadow，
 * 面板只写值不碰存储；预览用 getCursorURI(role) —— 实际贴到页面上的那一份，
 * 不是另画近似图，预览与实效果永远一致。
 *
 * 为什么需要预览：浏览器无法缩放系统原生光标，cursor.js 改用运行时生成的 SVG data-URI
 * 承载并按设定尺寸换算热点。生效后 cursor.js 广播 cursor-change，面板订阅重取光标串，
 * 订阅经 track() 登记、disposeAll() 释放（旧版每个控件挂一份永不摘的监听）。
 */

import {
    getCursorRoles, getCursorURI, getCursorImage, setCursorImage, clearCursorImage,
    previewCursorScale,
} from "../../../src/javascripts/cursor.js";
import { settings } from "../../../src/javascripts/settings.js";
import { log } from "../../../src/javascripts/log.js";
import {
    t, el, row, group, statusRow, bind, track,
    controlSwitch, controlSlider, usePaneStyle,
} from "../ui.js";

export const paneId = "mouse";

/** 面板语言包：四种语言，含面板标题键（外壳侧栏与工具栏用）。 */
export const messages = {
    "zh-CN": {
        ss: {
            pane: { mouse: "鼠标" },
            mouse: {
                cursor: "光标",
                size: "光标大小",
                shadow: "光标阴影",
                shake: "晃动指针以查找",
                shakeHint: "快速来回移动指针时临时放大",
                shakeScale: "晃动放大倍数",
                shakeGroup: "晃动查找指针",
                shakeAdvanced: "高级选项",
                shakeDistance: "触发所需移动距离",
                shakeHold: "放大后停留",
                shakeOvershoot: "回弹强度",
                shadowOn: "有阴影", shadowOff: "无阴影",
                live: "当前光标", preview: "预览",
                previewText: "把鼠标移到这里",
                customGroup: "自定义光标",
                roleDefault: "默认箭头", rolePointer: "手型指针", roleCopy: "拷贝",
                reset: "恢复内置",
                custom: "已自定义", builtin: "内置",
                invalid: "无法读取该文件，请选光标图片",
                saved: "自定义光标已保存", notPersisted: "未能写入本机存储，刷新后会回退",
            },
        },
    },
    "en": {
        ss: {
            pane: { mouse: "Mouse" },
            mouse: {
                cursor: "Cursor",
                size: "Cursor size",
                shadow: "Cursor shadow",
                shake: "Shake pointer to locate",
                shakeHint: "Briefly enlarges while you move it back and forth",
                shakeScale: "Shake magnification",
                shakeGroup: "Shake to Locate",
                shakeAdvanced: "Advanced",
                shakeDistance: "Travel needed to trigger",
                shakeHold: "Stay enlarged for",
                shakeOvershoot: "Bounce strength",
                shadowOn: "With shadow", shadowOff: "No shadow",
                live: "Current cursor", preview: "Preview",
                previewText: "Move the pointer here",
                customGroup: "Custom cursors",
                roleDefault: "Default arrow", rolePointer: "Pointing hand", roleCopy: "Copy",
                reset: "Restore built-in",
                custom: "Customized", builtin: "Built-in",
                invalid: "Couldn't read that file. Pick a cursor image.",
                saved: "Custom cursor saved", notPersisted: "Couldn't be stored locally; it reverts after a reload",
            },
        },
    },
    "ja-JP": {
        ss: {
            pane: { mouse: "マウス" },
            mouse: {
                cursor: "カーソル",
                size: "カーソルサイズ",
                shadow: "カーソルの影",
                shake: "ポインタを振って探す",
                shakeHint: "素早く往復すると一時的に大きくなります",
                shakeScale: "振ったときの拡大率",
                shakeGroup: "振って探す",
                shakeAdvanced: "詳細オプション",
                shakeDistance: "反応するまでの移動量",
                shakeHold: "拡大したままの時間",
                shakeOvershoot: "跳ね返りの強さ",
                shadowOn: "影あり", shadowOff: "影なし",
                live: "現在のカーソル", preview: "プレビュー",
                previewText: "ここにポインタを合わせてください",
                customGroup: "カスタムカーソル",
                roleDefault: "既定の矢印", rolePointer: "ポインタ", roleCopy: "コピー",
                reset: "既定に戻す",
                custom: "カスタム済み", builtin: "既定",
                invalid: "ファイルを読めません。カーソル画像を選んでください",
                saved: "カスタムカーソルを保存しました", notPersisted: "本機に保存できなかったため、再読み込みで戻ります",
            },
        },
    },
    cat: {
        ss: {
            pane: { mouse: "滑鼠喵" },
            mouse: {
                cursor: "貓掌喵",
                size: "貓掌多大喵",
                shadow: "給貓掌加影子喵",
                shake: "晃晃貓掌找它喵",
                shakeHint: "來回晃兩下就會變大喵",
                shakeScale: "晃大幾倍喵",
                shakeGroup: "晃晃找貓掌",
                shakeAdvanced: "進階嘅嘢",
                shakeDistance: "要晃多遠先算喵",
                shakeHold: "變大之後定多久喵",
                shakeOvershoot: "彈一下有多勁喵",
                shadowOn: "带影子喵", shadowOff: "没影子喵",
                live: "現在的貓掌喵", preview: "看看喵",
                previewText: "主人的手放這裡喵",
                customGroup: "主人自帶的貓掌喵",
                roleDefault: "預設的箭頭喵", rolePointer: "可以點的手喵", roleCopy: "拷貝喵",
                reset: "變回内置喵",
                custom: "已经换过啦喵", builtin: "内置的喵",
                invalid: "這張讀不出來喵，挑個光標圖片嘛",
                saved: "主人的光标收好啦喵~", notPersisted: "本機擱不下喵，刷新就變回去了",
            },
        },
    },
};

/** 面板私有样式：预览区与各角色行。 */
const PANE_CSS = `
.ss-pane-mouse .ss-mouse__preview {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 108px;
    border-radius: 9px;
    border: 1px dashed var(--ss-control-border);
    background: var(--ss-row-bg);
    color: var(--ss-text-secondary);
    font-size: 12px;
}
.ss-pane-mouse .ss-mouse__roles { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ss-pane-mouse .ss-mouse__swatch {
    min-width: 104px;
    height: 42px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--ss-control-border);
    border-radius: 8px;
    background: var(--ss-control-bg);
    font-size: 12px;
}
.ss-pane-mouse .ss-mouse__state { font-size: 12px; color: var(--ss-text-secondary); min-width: 68px; }
.ss-pane-mouse .ss-mouse__reset { font-size: 12px; }
.ss-pane-mouse .ss-mouse__advanced summary {
    cursor: pointer;
    font-size: 12.5px;
    color: var(--ss-text-secondary);
    padding: 2px 0;
    user-select: none;
}
.ss-pane-mouse .ss-mouse__advanced-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-top: 6px;
    border-top: 1px solid var(--ss-row-divider);
}
`;

/** 从文件名判断光标格式：cur / ani 原生渲染，其余按 png 走 SVG 缩放。 */
function detectFormat(name) {
    const lower = String(name || "").toLowerCase();
    if (lower.endsWith(".cur")) return "cur";
    if (lower.endsWith(".ani")) return "ani";
    return "png";
}

/** 每个角色行的刷新回调，build() 把它们收齐后由同一条 cursor-change 监听统一叫一遍。 */
const painters = [];

/**
 * 单个角色的「预览 + 上传 + 恢复内置」行。
 * @param {string} role 角色：default / pointer / copy
 * @param {string} label 已本地化的角色名
 * @returns {HTMLElement} 行元素
 */
function roleRow(role, label) {
    const swatch = el("div", { class: "ss-mouse__swatch", text: label });
    const state = el("span", { class: "ss-mouse__state" });
    const file = el("input", {
        class: "ss-mouse__file",
        attrs: { type: "file", accept: ".png,.cur,.ani,image/*", "aria-label": label },
    });
    const reset = el("button", { class: "ss-btn", attrs: { type: "button" }, text: t("ss.mouse.reset", "恢复内置") });

    const refresh = () => {
        swatch.style.cursor = getCursorURI(role) || "var(--deskly-cursor, default)";
        const customized = Boolean(getCursorImage(role));
        state.textContent = customized ? t("ss.mouse.custom", "已自定义") : t("ss.mouse.builtin", "内置");
        reset.hidden = !customized;
    };
    painters.push(refresh);

    const onFile = async () => {
        const picked = file.files && file.files[0];
        if (!picked) return;
        let dataUrl = "";
        try {
            dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(reader.error || new Error("read error"));
                reader.readAsDataURL(picked);
            });
        } catch (err) {
            state.textContent = t("ss.mouse.invalid", "无法读取该文件，请选光标图片");
            log.warn("plugin/system-settings", `读取自定义光标文件失败（${role}）`, err);
            return;
        }
        const saved = await setCursorImage(role, { format: detectFormat(picked.name), dataUrl, hotX: 0.375, hotY: 0.273 });
        state.textContent = saved ? t("ss.mouse.saved", "自定义光标已保存") : t("ss.mouse.notPersisted", "未能写入本机存储，刷新后会回退");
        file.value = "";
        refresh();
        log.info("plugin/system-settings", `已为「${role}」设置自定义光标（${detectFormat(picked.name)}）`);
    };

    file.addEventListener("change", onFile);
    reset.addEventListener("click", async () => {
        await clearCursorImage(role);
        refresh();
        log.info("plugin/system-settings", `已恢复「${role}」的内置光标`);
    });

    const control = el("div", { class: "ss-mouse__roles" }, swatch, state, file, reset);
    const node = row({ label, control, stack: true });
    refresh();
    return node;
}

/**
 * 「晃动放大倍数」滑块：拖动中把真实光标临时渲染成 base×倍数（预览所见即生效后的大小），
 * 松手（change）按设置重建还原。预览不经过设置中枢，不产生多余的 settings 写入。
 * @returns {HTMLElement} 行元素
 */
function shakeScaleRow() {
    const rowEl = controlSlider("mouse.shakeScale", {
        label: t("ss.mouse.shakeScale", "晃动放大倍数"),
        min: 1.1, max: 4, step: 0.1, units: "倍",
    });
    const input = rowEl.querySelector(".ss-slider");
    if (input) {
        input.addEventListener("input", () => previewCursorScale(Number(input.value)));
        input.addEventListener("change", () => previewCursorScale(null));
    }
    return rowEl;
}

/**
 * 「晃动查找指针」组：开关 + 幅度滑块默认可见；触发距离 / 停留时长 / 回弹强度
 * 收进 <details> 高级选项（折叠态只剩一行摘要，不把面板塞满）。
 * @returns {HTMLElement} 分组元素
 */
function shakeGroup() {
    const advanced = el("details", { class: "ss-mouse__advanced" },
        el("summary", { text: t("ss.mouse.shakeAdvanced", "高级选项") }),
        el("div", { class: "ss-mouse__advanced-body" },
            controlSlider("mouse.shakeDistance", {
                label: t("ss.mouse.shakeDistance", "触发所需移动距离"),
                min: 24, max: 200, step: 4, units: "px",
            }),
            controlSlider("mouse.shakeHold", {
                label: t("ss.mouse.shakeHold", "放大后停留"),
                min: 400, max: 3000, step: 100, units: "毫秒",
            }),
            controlSlider("mouse.shakeOvershoot", {
                label: t("ss.mouse.shakeOvershoot", "回弹强度"),
                min: 1, max: 1.4, step: 0.02, units: "倍",
            })));

    return group([
        controlSwitch("mouse.shakeToFind", {
            label: t("ss.mouse.shake", "晃动指针以查找"),
            hint: t("ss.mouse.shakeHint", "快速来回移动指针时临时放大"),
        }),
        shakeScaleRow(),
        row({ label: "", control: advanced, stack: true }),
    ], { title: t("ss.mouse.shakeGroup", "晃动查找指针") });
}

/**
 * 构建「鼠标」面板。
 * @param {object} ctx 外壳上下文
 * @returns {HTMLElement} 面板根元素
 */
export function build(ctx) {
    usePaneStyle(paneId, PANE_CSS);
    painters.length = 0;

    const root = el("div", { class: "ss-pane ss-pane-mouse", dataset: { pane: paneId } });
    const preview = el("div", { class: "ss-mouse__preview" }, el("span", { text: t("ss.mouse.previewText", "把鼠标移到这里") }));
    const liveRow = statusRow({ label: t("ss.mouse.live", "当前光标"), value: "—" });

    /** 把真正生效的默认光标串（含热点坐标）贴到预览区，并回显尺寸与阴影。 */
    const paint = () => {
        preview.style.cursor = getCursorURI("default") || "var(--deskly-cursor, default)";
        const size = settings.get("cursor.size");
        const shadow = settings.get("cursor.shadow");
        liveRow.setValue(`${size} px · ${shadow ? t("ss.mouse.shadowOn", "有阴影") : t("ss.mouse.shadowOff", "无阴影")}`);
        painters.forEach((fn) => fn());
    };

    // 三条通知源各管一段：bind 管 store 值变化、cursor-change 管重绘后的光标串
    bind("cursor.size", paint);
    bind("cursor.shadow", paint);
    const onChange = () => paint();
    window.addEventListener("cursor-change", onChange);
    track(() => window.removeEventListener("cursor-change", onChange));

    const roleLabels = {
        default: t("ss.mouse.roleDefault", "默认箭头"),
        pointer: t("ss.mouse.rolePointer", "手型指针"),
        copy: t("ss.mouse.roleCopy", "拷贝"),
    };

    root.append(
        group([
            controlSlider("cursor.size", {
                label: t("ss.mouse.size", "光标大小"),
                units: "px",
            }),
            controlSwitch("cursor.shadow", { label: t("ss.mouse.shadow", "光标阴影") }),
            liveRow,
            row({
                label: t("ss.mouse.preview", "预览"),
                control: preview,
                stack: true,
            }),
        ], { title: t("ss.mouse.cursor", "光标") }),

        shakeGroup(),

        group(
            getCursorRoles().map((item) => roleRow(item.role, roleLabels[item.role] || item.label)),
            { title: t("ss.mouse.customGroup", "自定义光标") }),
    );

    paint();
    return root;
}

/** 额外的收尾：painters 是模块级数组，必须清空，否则下一次打开会把上一面板的节点又画一遍。 */
export function destroy() {
    painters.length = 0;
}
