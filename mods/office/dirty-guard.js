/**
 * dirty-guard.js — 未保存文档的三选确认闸：新建 / 打开 / 从模板新建 / 双击文件打开共用。
 * 会覆盖当前文档的入口统一先过这一关：选「取消」或「保存并继续」但保存失败都中止整条操作，
 * 不允许「没保存成却照样换新文档」。弹窗走系统 window.__dialog（与记事本同一通道）；
 * 系统弹窗不可用时宁可中止，也不静默覆盖。
 *
 * 独立成模块是为了能在 Node 探针里单测三条分支（不拖起整个外壳与视图）。
 */

import { t } from "./t.js";

/** 三选的取值（也是按钮的 value 与 dismissValue 的口径） */
export const DISCARD_SAVE = "save";
export const DISCARD_DISCARD = "discard";
export const DISCARD_CANCEL = "cancel";

/**
 * 有未保存改动时弹「保存并继续 / 不保存 / 取消」三选。
 * @param {object} inst 应用实例（读 dirty 与 name 供展示）
 * @param {() => Promise<boolean>} save 保存动作，返回是否真正落盘
 * @returns {Promise<boolean>} true = 可以覆盖当前文档继续；false = 留在当前文档
 */
export async function confirmDiscardIfDirty(inst, save) {
    if (!inst || !inst.dirty) return true;
    const d = typeof window !== "undefined" ? window.__dialog : null;
    if (!d || typeof d.messageBox !== "function") return false;
    const choice = await d.messageBox({
        title: t("confirmDiscardTitle", "有未保存的更改"),
        message: t("confirmDiscardMessage", "「{name}」有未保存的更改。继续操作会丢弃这些更改。")
            .replace("{name}", inst.name || t("unnamed", "未命名")),
        dismissValue: DISCARD_CANCEL,
        // 覆盖会丢内容：初始焦点落在「取消」，回车不会顺手丢弃更改
        danger: true,
        buttons: [
            { label: t("confirmDiscardDiscard", "不保存"), value: DISCARD_DISCARD, style: "destructive" },
            { label: t("confirmDiscardCancel", "取消"), value: DISCARD_CANCEL, style: "secondary" },
            { label: t("confirmDiscardSave", "保存并继续"), value: DISCARD_SAVE, style: "primary" },
        ],
    });
    if (choice === DISCARD_DISCARD) return true;
    // 保存失败（含抛错）一律当中止：留在当前文档，错误由保存动作自己如实上报
    if (choice === DISCARD_SAVE && typeof save === "function") {
        try {
            return (await save()) === true;
        } catch (err) {
            console.warn("[office] 「保存并继续」保存失败，已留在当前文档：", err);
            return false;
        }
    }
    return false;
}
