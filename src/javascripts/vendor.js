/**
 * vendor.js — 第三方库的按需加载
 *
 * jszip 曾写死在 index.html 里，于是**每个新标签页**都要下载并解析约 98KB，
 * 而它只在两条路径上用到：商店安装 ZIP 插件、office 读写 docx/xlsx。
 * 改成首次使用时注入 <script>，之后复用同一个 Promise（同一个标签页只加载一次）。
 *
 * Node 侧校验脚本的做法不变：先 `globalThis.JSZip = require('./assets/vendor/jszip.min.js')`
 * 再 import 本模块 —— 已存在时直接返回，完全不碰 DOM。
 */

import { JSZIP_SCRIPT } from "./paths.js";

/** 加载中的 Promise；成功或失败后按需复位（失败要允许重试）。 */
let pending = null;

/**
 * 取得 JSZip 构造器（必要时按需加载）。
 * @returns {Promise<Function>} JSZip 构造器
 */
export function ensureJSZip() {
    if (typeof globalThis.JSZip === "function") return Promise.resolve(globalThis.JSZip);
    if (pending) return pending;
    if (typeof document === "undefined") {
        return Promise.reject(new Error("缺少 JSZip：当前上下文没有 document，无法按需加载"));
    }
    pending = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = JSZIP_SCRIPT;
        script.onload = () => {
            if (typeof globalThis.JSZip === "function") {
                resolve(globalThis.JSZip);
            } else {
                pending = null;
                reject(new Error("JSZip 已加载但未挂到全局"));
            }
        };
        script.onerror = () => {
            pending = null;
            reject(new Error(`JSZip 资源加载失败：${JSZIP_SCRIPT}`));
        };
        document.head.appendChild(script);
    });
    return pending;
}
