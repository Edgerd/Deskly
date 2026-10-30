/**
 * zip.js — OOXML 包的压缩层
 *
 * .docx / .xlsx / .pptx 都是 zip 包，office 各编解码模块只通过本文件读写包。
 * `JSZip` 由宿主页按需加载（`src/javascripts/vendor.js` 的 ensureJSZip，走 paths.js 的
 * JSZIP_SCRIPT）。Node 侧跑校验脚本时仍可 `globalThis.JSZip = require(...)` 预注入，
 * ensureJSZip 见到已存在的全局会直接返回，不碰 DOM。
 */

import { ensureJSZip } from "../../../src/javascripts/vendor.js";

/**
 * 解开一个 OOXML 包。
 * @param {ArrayBuffer|Uint8Array} bytes 包字节
 * @returns {Promise<Map<string, string|null>>} 部件路径 -> 文本；非 xml/rels 部件值为 null（只记名字）
 */
export async function unzipXmlParts(bytes) {
    const Zip = await ensureJSZip();
    const zip = await Zip.loadAsync(bytes);
    const parts = new Map();
    const jobs = [];
    zip.forEach((path, entry) => {
        if (entry.dir) return;
        if (!/\.(xml|rels)$/i.test(path)) {
            parts.set(path, null);
            return;
        }
        jobs.push(entry.async("string").then((text) => parts.set(path, text)));
    });
    await Promise.all(jobs);
    return parts;
}

/**
 * 把若干部件打成一个包。
 * @param {Record<string, string>} parts 部件路径 -> 文本
 * @returns {Promise<Uint8Array>} 包字节
 */
export async function zipParts(parts) {
    const Zip = await ensureJSZip();
    const zip = new Zip();
    Object.keys(parts).forEach((path) => zip.file(path, parts[path]));
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
