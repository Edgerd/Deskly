/**
 * panes/default-apps.js — 「系统设置 › 通用 › 默认应用」面板
 *
 * 这里是默认应用**唯一**的手工修改入口（设计决策 6）：插件可以调
 * Deskly.apps.default.set，但用户想改回去、想看清现在归谁，就来这页。
 *
 * 控件不复用 ui.js 的 controlDropdown：那个组件是「一个设置键 ↔ 一个值」的绑定，
 * 而本页是一张 map（.md/.docx/http: … 各一条），没有对应的单键。
 * 但外观类名（.ss-dropdown/.ss-menu）沿用组件层那套，界面不会长出一个孤例。
 *
 * 每行的候选项来自 app-registry 的 listApps()，所以下拉里出现的都是真实可启动的 app；
 * 「跟随系统默认」不是选项之一而是**删除用户绑定**（回到三级回退链的第二、三级）。
 */

import {
    t, el, note, group, actionRow, statusRow, usePaneStyle, track, wireDropdown,
} from "../ui.js";
import { listTypes, resolve, set as setBinding, reset, resetAll } from "../../../src/javascripts/default-apps.js";
import { listApps } from "../../../src/javascripts/app-registry.js";
import { closeAllPopovers } from "../../../src/javascripts/ui/popover.js";

export const paneId = "default-apps";

/** 四语言文案。 */
export const messages = {
    "zh-CN": {
        ss: {
            defaultApps: {
                files: "文件类型",
                protocols: "协议与网页",
                follow: "跟随系统默认",
                srcUser: "已自定义",
                empty: "暂无可打开的文件类型。",
                restoreGroup: "恢复默认",
                restoreAll: "全部恢复默认",
                restored: " 项已恢复默认",
                countRow: "已自定义",
                missingHint: "该应用当前不可启动。",
            },
        },
    },
    "en": {
        ss: {
            defaultApps: {
                files: "File types",
                protocols: "Protocols & web",
                follow: "Follow system default",
                srcUser: "Custom",
                empty: "No openable file types yet.",
                restoreGroup: "Defaults",
                restoreAll: "Reset to defaults",
                restored: " overrides reset",
                countRow: "Customized",
                missingHint: "That app can't launch right now.",
            },
        },
    },
    "ja-JP": {
        ss: {
            defaultApps: {
                files: "ファイル形式",
                protocols: "プロトコルとウェブ",
                follow: "システム既定に従う",
                srcUser: "カスタム",
                empty: "開けるファイル形式はありません。",
                restoreGroup: "リセット",
                restoreAll: "すべて既定に戻す",
                restored: " 件を既定に戻しました",
                countRow: "カスタム済み",
                missingHint: "そのアプリは現在起動できません。",
            },
        },
    },
    "cat": {
        ss: {
            defaultApps: {
                files: "文件格式喵",
                protocols: "协议跟网页喵",
                follow: "跟系统的一样",
                srcUser: "主人改过喵",
                empty: "还没有登记过文件格式呢。",
                restoreGroup: "擦回去喵",
                restoreAll: "全部擦回去",
                restored: " 条擦回去啦",
                countRow: "改过的格式",
                missingHint: "这个应用现在开不了喵。",
            },
        },
    },
};

const CSS = `
.ss-defaultapps .ss-dropdown__wrap { min-width: 200px; }
.ss-defaultapps .ss-da-key { font-variant-numeric: tabular-nums; }
.ss-defaultapps .ss-da-src { color: var(--text-secondary, var(--text-primary)); opacity: .68; margin-left: 6px; }
.ss-da-open { display: flex; flex-direction: column; gap: 10px; }
`;

/** 候选应用列表（appId + 显示名）。 */
function appOptions() {
    return listApps().map((rec) => ({ value: rec.appId, label: rec.name }));
}

/**
 * 一个「选应用」的下拉控件（外观沿用 ui.js 的 .ss-dropdown/.ss-menu，
 * 开合与浮出层也共用 ui.js 的 wireDropdown，不再自己挂 document 监听）。
 * @param {string} key 扩展名或协议
 * @param {Array<{value:string,label:string}>} options 候选应用
 * @param {string} current 当前绑定的 appId
 * @returns {HTMLElement} 控件根元素
 */
function picker(key, options, current) {
    const labels = new Map(options.map((o) => [o.value, o.label]));
    const current$ = el("span", { class: "ss-dropdown__value" });
    const button = el("button", {
        class: "ss-dropdown",
        attrs: { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" },
    }, current$, el("i", { class: "ss-dropdown__chev" }));
    const list = el("div", { class: "ss-menu", attrs: { role: "listbox", hidden: "" } });
    const wrap = el("div", { class: "ss-dropdown__wrap" }, button, list);

    const paint = (value) => {
        current$.textContent = labels.get(value) || t("ss.defaultApps.follow", "跟随系统默认");
        button.dataset.unbound = value ? "false" : "true";
    };
    paint(current);

    const item = (value, label) => {
        const node = el("button", {
            class: "ss-menu__item", attrs: { type: "button", role: "option" }, dataset: { value: value ?? "" },
        }, el("span", { text: label }));
        node.addEventListener("click", () => {
            dropdown.close();
            // 写入走内核的 default-apps 模块：本页是系统设置自己的界面，
            // 不弹「允许 system-settings 修改默认应用」这种确认框（内核调用者免弹窗）。
            if (value === null) reset(key);
            else setBinding(key, value);
            // 绑定变了，整页要重画：行内的「当前应用/来源」两列都是从 resolve() 现算的，
            // 只重画这一个下拉的话，同一行另一侧与其余行会停在旧值上。
            render();
        });
        list.append(node);
        return node;
    };
    options.forEach((opt) => item(opt.value, opt.label));
    item(null, t("ss.defaultApps.follow", "跟随系统默认"));

    const dropdown = wireDropdown(button, list);
    return wrap;
}

/**
 * 一种文件类型/协议的一行。
 * 来源只在「用户改过」时才标一次：以前每行都挂一行「系统默认」，21 行就是 21 条同样的
 * 小字 —— 那是数据不是说明，原版把它放在值的位置，从不占一行正文。
 */
function typeRow(entry, options) {
    const hit = resolve(entry.key);
    const known = options.some((o) => o.value === hit.appId);
    const hintParts = [];
    if (hit.source === "user") hintParts.push(t("ss.defaultApps.srcUser", "已自定义"));
    if (hit.appId && !known) hintParts.push(t("ss.defaultApps.missingHint", "该应用当前不可启动。"));
    const label = el("p", { class: "ss-row__label" },
        el("span", { class: "ss-da-key", text: entry.key }),
        entry.friendly && entry.friendly !== entry.key ? el("span", { class: "ss-da-src", text: `· ${entry.friendly}` }) : null,
    );
    const control = picker(entry.key, options, hit.source === "user" ? hit.appId : "");
    const main = el("div", { class: "ss-row__main" }, label,
        hintParts.length ? el("p", { class: "ss-row__hint", text: hintParts.join(" · ") }) : null);
    return el("div", { class: "ss-row" }, main, el("div", { class: "ss-row__control" }, control));
}

/** 重建整页内容（改绑后要刷新来源标签与计数）。 */
let paneRoot = null;
let countRow = null;

function render() {
    if (!paneRoot) return;
    const options = appOptions();
    const entries = listTypes();
    const exts = entries.filter((e) => !e.key.endsWith(":"));
    const protos = entries.filter((e) => e.key.endsWith(":"));

    paneRoot.textContent = "";
    paneRoot.append(
        exts.length
            ? group(exts.map((e) => typeRow(e, options)), { title: t("ss.defaultApps.files", "文件类型") })
            : null,
        protos.length
            ? group(protos.map((e) => typeRow(e, options)), { title: t("ss.defaultApps.protocols", "协议与网页") })
            : null,
        !entries.length ? note("ss.defaultApps.empty", "暂无可打开的文件类型。") : null,
        group([
            countRow = statusRow({
                label: t("ss.defaultApps.countRow", "已自定义"),
                value: String(exts.concat(protos).filter((e) => e.source === "user").length),
            }),
            actionRow({
                label: t("ss.defaultApps.restoreAll", "全部恢复默认"),
                buttonText: t("ss.defaultApps.restoreAll", "全部恢复默认"),
                onAction: async () => {
                    const done = resetAll();
                    countRow.setValue(String(0));
                    window.__notify?.show({
                        title: t("ss.defaultApps.restoreAll", "全部恢复默认"),
                        text: `${done.count}${t("ss.defaultApps.restored", " 项已恢复默认")}`,
                    });
                    render();
                },
            }),
        ], { title: t("ss.defaultApps.restoreGroup", "恢复默认") }),
    );
}

/**
 * 构建面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    usePaneStyle(paneId, CSS);
    const root = el("div", { class: "ss-pane ss-defaultapps ss-da-open" });
    paneRoot = root;
    render();

    // 改绑可能来自插件调用 Deskly.apps.default.set，界面要跟着动，
    // 所以订阅内核事件而不是只在自己点按钮后刷新。
    // 重建整页前先把浮层收掉：旧行的下拉菜单还挂在浮出层里，等 rAF 发现
    // 触发元素消失才关，会有一帧的错位的菜单留在屏幕上。
    const onChanged = () => { closeAllPopovers(); render(); };
    document.addEventListener("default-apps-changed", onChanged);
    track(() => document.removeEventListener("default-apps-changed", onChanged));
    // 装/卸插件会改变候选应用与已声明的格式类型，同样要重建。
    ["plugin-registered", "plugin-unregistered"].forEach((type) => {
        document.addEventListener(type, onChanged);
        track(() => document.removeEventListener(type, onChanged));
    });
    // 「点别处收起下拉」不在这里挂监听：由 src/javascripts/ui/popover.js 统一负责。

    return root;
}

/** 释放面板持有的引用。 */
export function destroy() {
    paneRoot = null;
    countRow = null;
}
