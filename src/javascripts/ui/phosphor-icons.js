/**
 * phosphor-icons.js — 全项目统一的界面图标取用入口（Phosphor Icons，regular 字重）
 *
 * 为什么要有这一层：界面里的单色小图标原先各写各的（有的塞在 mod 目录，有的直接内联 SVG），
 * 同一套侧栏里字号、线宽、留白对不齐。这里把「图标从哪来、怎么命名、怎么取」固定下来：
 * **以后所有要图标的地方都用这套**，宿主界面与内置应用一视同仁；需要新图标时往公共资产里加，
 * 不要往 `mods/<id>/` 里单独放一份，也不要用任何 CDN（本项目是浏览器插件，离线必须能用）。
 *
 * ── 资产与命名 ──────────────────────────────────────────────
 * · 原版 SVG 放在 `assets/ui/phosphor/<name>.svg`，`<name>` 就是 Phosphor 官方的
 *   kebab-case 名称（`squares-four`、`puzzle-piece`、`clock-counter-clockwise`…），
 *   不做二次改名，查官方站名即可对上文件。
 * · 运行时路径数据由 `node dev/phosphor-build.mjs` 从这些 SVG 生成到
 *   `src/javascripts/ui/phosphor-icons-data.js`；改图标只改 SVG 再生成，不要手改生成文件。
 * · 校验：`node dev/phosphor-build.mjs --check`，不一致直接报错。
 * · 新增图标：拷 Phosphor 官方 regular 版 SVG 到 `assets/ui/phosphor/` → 跑生成器 → 跑校验。
 *
 * ── 使用约定 ────────────────────────────────────────────────
 * · 只收 regular 字重；需要 bold / fill 变体时另存文件并用后缀区分（目前未引入）。
 * · 颜色一律 currentColor：图标跟随所在控件的文字色（含 hover / active / 禁用态），
 *   不要给 SVG 写死 fill，也不要给图标单独设 color。
 * · 尺寸：16px 用于侧栏行、列表行、按钮内；20px 用于工具条与标题旁；24px 用于空状态。
 * · 与文字并排时只交给容器的 flex `gap` 控制间距，图标自身不加 margin。
 * · 纯装饰图标自动 `aria-hidden`；有语义时传 `label`，会输出 role="img" + aria-label。
 */

import { PHOSPHOR_ICONS } from "./phosphor-icons-data.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const warned = new Set();

/** 图标的默认像素尺寸（与 13px 侧栏文字基线对齐）。 */
export const ICON_SIZE = Object.freeze({ inline: 16, toolbar: 20, empty: 24 });

function warnMissing(name) {
    if (warned.has(name)) return;
    warned.add(name);
    console.warn(`[icons] 没有名为「${name}」的 Phosphor 图标，请检查 assets/ui/phosphor/ 与生成文件`);
}

/** 该名字是否有对应图标。 */
export function hasIcon(name) {
    return Object.prototype.hasOwnProperty.call(PHOSPHOR_ICONS, name);
}

/** 已收录的图标名（调试与校验用）。 */
export function iconNames() {
    return Object.keys(PHOSPHOR_ICONS);
}

/**
 * 取图标为 SVG 字符串（用于拼模板字符串或写 innerHTML 的场合）。
 * 名字不存在时返回空串，并只告警一次。
 */
export function iconSvg(name, { size = ICON_SIZE.inline, className = "", label } = {}) {
    const body = PHOSPHOR_ICONS[name];
    if (!body) {
        warnMissing(name);
        return "";
    }
    const cls = className ? `ui-icon ${className}` : "ui-icon";
    const a11y = label ? `role="img" aria-label="${String(label).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"` : `aria-hidden="true"`;
    return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 256 256" fill="currentColor" ${a11y} focusable="false">${body}</svg>`;
}

/**
 * 取图标为 `<svg>` 元素（界面里优先用它，避免拼 HTML）。
 * 名字不存在时返回 null，调用方跳过即可，界面不会因此中断。
 */
export function iconEl(name, { size = ICON_SIZE.inline, className = "", label } = {}) {
    const body = PHOSPHOR_ICONS[name];
    if (!body) {
        warnMissing(name);
        return null;
    }
    const el = document.createElementNS(SVG_NS, "svg");
    el.setAttribute("class", className ? `ui-icon ${className}` : "ui-icon");
    el.setAttribute("width", String(size));
    el.setAttribute("height", String(size));
    el.setAttribute("viewBox", "0 0 256 256");
    el.setAttribute("fill", "currentColor");
    el.setAttribute("focusable", "false");
    if (label) {
        el.setAttribute("role", "img");
        el.setAttribute("aria-label", String(label));
    } else {
        el.setAttribute("aria-hidden", "true");
    }
    // 只用内部常量拼装，路径数据来自受控资产表，不接任何外部输入
    el.innerHTML = body;
    return el;
}
