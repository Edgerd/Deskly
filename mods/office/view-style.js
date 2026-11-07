/**
 * view-style.js — 视图模块的私有样式装载件：`manifest.style` 只有一份（宿主注入），每个视图各带一个 CSS，
 * 用 `new URL(..., import.meta.url)` 挂进文档 —— 磁盘插件与 ZIP 安装（SW 按同路径回源）两种分发形态通用。
 * 幂等：同一 URL 只挂一次（外壳脚本常驻，重复挂载会叠加同名规则）。
 */

const mounted = new Set();

/**
 * 装载一个与调用模块同目录的 CSS 文件。
 * @param {string} metaUrl 调用方的 `import.meta.url`
 * @param {string} file 文件名，如 `view-excel.css`
 * @returns {void}
 */
export function useStyle(metaUrl, file) {
    const href = new URL(file, metaUrl).href;
    if (mounted.has(href)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.officeView = file;
    document.querySelector("head").appendChild(link);
    mounted.add(href);
}

/**
 * 建一个带类名的元素，可选写入文本。
 * 视图层统一用它建 DOM，一律走 `textContent`，不拼 innerHTML。
 * @param {string} tag 标签名
 * @param {string} cls 类名（可含多个，空格分隔）
 * @param {string} [text] 文本
 * @returns {HTMLElement} 元素
 */
export function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}
