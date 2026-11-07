/**
 * zip.js — OOXML 包的压缩层：.docx/.xlsx/.pptx 都是 zip 包，office 各编解码模块只通过本文件读写包。
 * `JSZip` 由宿主页按需加载；Node 侧校验脚本可 `globalThis.JSZip = require(...)` 预注入，
 * ensureJSZip 见到已存在的全局会直接返回，不碰 DOM。
 */

import { ensureJSZip } from "../../../src/javascripts/vendor.js";

/** 允许进包/被读出的图片扩展名（svg 不支持插入，读写都不认） */
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|webp)$/i;

/**
 * 解开一个 OOXML 包，同时保留图片的二进制通道。
 * xml/rels 部件解成文本；常见图片扩展名解成 `{base64}`；其余部件值为 null（只记名字）。
 * @param {ArrayBuffer|Uint8Array} bytes 包字节
 * @returns {Promise<Map<string, string|{base64: string}|null>>} 部件路径 -> 文本 / 图片 base64 / null
 */
export async function unzipPackage(bytes) {
    const Zip = await ensureJSZip();
    const zip = await Zip.loadAsync(bytes);
    const parts = new Map();
    const jobs = [];
    zip.forEach((path, entry) => {
        if (entry.dir) return;
        if (/\.(xml|rels)$/i.test(path)) {
            jobs.push(entry.async("string").then((text) => parts.set(path, text)));
            return;
        }
        if (IMAGE_EXT_RE.test(path)) {
            jobs.push(entry.async("base64").then((base64) => parts.set(path, { base64 })));
            return;
        }
        parts.set(path, null);
    });
    await Promise.all(jobs);
    return parts;
}

/**
 * 解开一个 OOXML 包，只取 xml/rels 文本（旧语义：非文本部件值为 null）。
 * @param {ArrayBuffer|Uint8Array} bytes 包字节
 * @returns {Promise<Map<string, string|null>>} 部件路径 -> 文本；非 xml/rels 部件值为 null
 */
export async function unzipXmlParts(bytes) {
    const all = await unzipPackage(bytes);
    const parts = new Map();
    all.forEach((value, path) => parts.set(path, typeof value === "string" ? value : null));
    return parts;
}

/**
 * 把若干部件打成一个包。值可以是文本，也可以是 `{base64}`（图片等二进制部件）。
 * @param {Record<string, string|{base64: string}>} parts 部件路径 -> 文本 / base64
 * @returns {Promise<Uint8Array>} 包字节
 */
export async function zipParts(parts) {
    const Zip = await ensureJSZip();
    const zip = new Zip();
    Object.keys(parts).forEach((path) => {
        const value = parts[path];
        if (value && typeof value === "object" && typeof value.base64 === "string") {
            zip.file(path, value.base64, { base64: true });
        } else {
            zip.file(path, value);
        }
    });
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
