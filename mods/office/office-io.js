/**
 * office-io.js — 文件通道（打开 / 读取 / 保存 / 下载 / 最近使用）
 *
 * 打开两条来路：系统选择器给的真实 File；访达「打开方式」递来的内核路径经 `OSFS.read` 取回。
 * 保存统一落 `OSFS.TOP.documents`（单一根目录下的 /文档），内核 write 同时吃 string 与
 * Uint8Array/Blob/ArrayBuffer，文本与 OOXML 二进制走同一条路径；未挂载时整棵树存 IndexedDB。
 * `download` 是显式的「导出到根目录之外」（浏览器下载）。挂载存在但权限未批时内核抛
 * NeedsReauthError，保存如实返回「需要重新授权」，不假装成功。
 */

import { OSFS } from '../../src/javascripts/osfs.js';
import { t } from './t.js';

/** 支持判定的格式种类 */
export const KIND = { DOCX: "docx", TXT: "txt", XLSX: "xlsx", CSV: "csv", PPTX: "pptx", UNKNOWN: "unknown" };

/** 扩展名 -> 种类 */
const EXT_KIND = {
    docx: KIND.DOCX,
    txt: KIND.TXT, md: KIND.TXT,
    xlsx: KIND.XLSX, xls: KIND.XLSX,
    csv: KIND.CSV, tsv: KIND.CSV,
    pptx: KIND.PPTX, ppt: KIND.PPTX,
};

const RECENT_KEY = "webstartos_office_recent";
const RECENT_LIMIT = 8;

/**
 * 取文件名的扩展名（小写、不带点）。
 * @param {string} name 文件名
 * @returns {string} 扩展名，无则空串
 */
export function extOf(name) {
    const s = String(name || "");
    const ix = s.lastIndexOf(".");
    return ix > 0 ? s.slice(ix + 1).toLowerCase() : "";
}

/**
 * 文件名 -> 格式种类。
 * @param {string} name 文件名
 * @returns {string} KIND 之一
 */
export function kindOf(name) {
    return EXT_KIND[extOf(name)] || KIND.UNKNOWN;
}

/**
 * 去掉扩展名的主干。
 * @param {string} name 文件名
 * @returns {string} 主干
 */
export function baseOf(name) {
    const s = String(name || "");
    const ix = s.lastIndexOf(".");
    return ix > 0 ? s.slice(0, ix) : s;
}

/** 种类 -> 默认扩展名（新建时用） */
const KIND_EXT = { [KIND.DOCX]: "docx", [KIND.TXT]: "txt", [KIND.XLSX]: "xlsx", [KIND.CSV]: "csv", [KIND.PPTX]: "pptx" };

/**
 * 生成合法文件名：去掉路径分隔与控制字符。
 * @param {string} stem 主干
 * @param {string} kind 格式种类
 * @returns {string} 带扩展名的文件名
 */
export function fileName(kind, stem) {
    const clean = String(stem || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
    return `${clean || t("unnamed", "未命名")}.${KIND_EXT[kind] || "dat"}`;
}

/**
 * 用系统文件选择器取一个文件。
 * @param {string[]} accepts 允许的后缀，如 [".docx", ".txt"]
 * @returns {Promise<File|null>} 用户取消时为 null
 */
export function pickFile(accepts = []) {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accepts.join(",");
        input.style.display = "none";
        input.addEventListener("change", () => {
            const file = input.files && input.files[0];
            input.remove();
            resolve(file || null);
        });
        // 取消不触发 change：窗口元素移除后靠一次微任务回收，避免节点残留
        input.addEventListener("cancel", () => { input.remove(); resolve(null); });
        document.body.appendChild(input);
        input.click();
    });
}

/**
 * 读内核路径下的文件（访达「打开方式」送来的路径）。
 * @param {string} path 内核路径，如 `/文档/x.docx`
 * @returns {Promise<File|null>} 不存在 / 已删除为 null；挂载未授权时抛 NeedsReauthError
 */
export async function readVfsFile(path) {
    await OSFS.init();
    return await OSFS.read(path);
}

/**
 * File → Uint8Array。
 * @param {File} file 文件
 * @returns {Promise<Uint8Array>} 字节
 */
export async function toBytes(file) {
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
}

/**
 * 字节或文本 → 浏览器下载（导出到根目录之外的显式通道）。
 * @param {string} name 落盘文件名
 * @param {Uint8Array|string} data 内容
 * @param {string} mime 类型
 * @returns {void}
 */
export function download(name, data, mime) {
    const blob = data instanceof Uint8Array ? new Blob([data], { type: mime }) : new Blob([data], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 下载已开始后才能回收对象 URL；留足时间给浏览器取数据
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * 保存到根目录 /文档：文本传 string，OOXML 传 Uint8Array/Blob/ArrayBuffer，内核 write 都吃。
 * 路径从 OSFS.TOP.documents 生成，不写 "/文档" 字面量。
 * @param {string} name 文件名
 * @param {string|Uint8Array|ArrayBuffer|Blob} data 内容
 * @returns {Promise<{ok:boolean, path?:string, reauth?:boolean, error?:string}>} ok 时 path 为规范化落点
 */
export async function saveToDocuments(name, data) {
    const path = OSFS.joinPath(OSFS.TOP.documents.path, name);
    try {
        await OSFS.init();
        const written = await OSFS.write(path, data);
        return { ok: true, path: written };
    } catch (err) {
        if (err && err.name === "NeedsReauthError") return { ok: false, reauth: true, path };
        console.warn("[office] 保存失败：", name, err);
        return { ok: false, error: (err && err.message) || String(err) };
    }
}

/**
 * 记录最近打开（按 appId 分栏，localStorage 持久）。
 * @param {string} appId 应用 id
 * @param {object} item { name, path, kind }
 * @returns {void}
 */
export function rememberRecent(appId, item) {
    const list = listRecent(appId).filter((r) => r.name !== item.name);
    list.unshift({ ...item, at: Date.now() });
    try {
        localStorage.setItem(RECENT_KEY, JSON.stringify({ ...readAll(), [appId]: list.slice(0, RECENT_LIMIT) }));
    } catch (err) {
        console.warn("[office] 最近打开写入失败（配额？）", err);
    }
}

/**
 * 取某应用的最近打开列表。
 * @param {string} appId 应用 id
 * @returns {Array<object>} 列表（新在前）
 */
export function listRecent(appId) {
    return readAll()[appId] || [];
}

/** 读全量最近打开表（损坏时视为空表） */
function readAll() {
    try {
        return JSON.parse(localStorage.getItem(RECENT_KEY) || "{}") || {};
    } catch (err) {
        return {};
    }
}
