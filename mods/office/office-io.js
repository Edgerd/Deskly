/**
 * office-io.js — 文件通道（打开 / 读取 / 保存 / 下载 / 最近使用）。
 * 打开两条来路：系统选择器给的真实 File；访达「打开方式」递来的内核路径经 Deskly.fs.at 取回。
 * 保存统一落 Deskly.fs.paths.documents（根目录 /文档），原子写同时吃 string 与 Uint8Array/Blob/ArrayBuffer；
 * 权限未批时信封回 EREAUTH，如实返回「需要重新授权」，不假装成功。
 * `download` 是显式的「导出到根目录之外」（浏览器下载）。
 *
 * Q6 收口：只走 window.Deskly 公开 API，不直接 import 内核模块。
 */

import { t } from './t.js';

/** Deskly 信封 → 值/异常：ok:false 抛带 code 的错误（EREAUTH 等可编程识别）。 */
function unwrap(env) {
    if (!env || !env.ok) {
        const err = new Error((env && env.reason) || "Deskly 调用失败");
        err.code = (env && env.code) || "EIO";
        // 与旧 NeedsReauthError 判别路径兼容（调用方按 name 判）
        if (err.code === "EREAUTH" || err.code === "REAUTH") err.name = "NeedsReauthError";
        throw err;
    }
    return env.value;
}

const Deskly = () => {
    const api = window.Deskly;
    if (!api) throw new Error("Deskly 尚未就绪");
    return api;
};

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

/** 各写出格式可原地回写的来源扩展名（同一份正文语义一致才允许覆盖原文件） */
const INPLACE_EXTS = {
    [KIND.DOCX]: ["docx"],
    [KIND.TXT]: ["txt", "md"],
    [KIND.XLSX]: ["xlsx"],
    [KIND.CSV]: ["csv", "tsv"],
    [KIND.PPTX]: ["pptx"],
};

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
        // 没有可挂载的宿主 DOM（纯 Node 探针 / 非浏览器环境）时按「用户取消」返回，
        // 避免在桩环境里留下悬空的文件框与监听
        if (typeof document === "undefined" || !document.body) {
            resolve(null);
            return;
        }
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accepts.join(",");
        input.style.display = "none";
        if (typeof input.click !== "function") {
            resolve(null);
            return;
        }
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

/** 插入图片允许的扩展名（svg 不支持，选择器也不接受） */
const IMAGE_ACCEPTS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
/** 图片自然尺寸取不到时的兜底（px），与三个视图/编码器的兜底一致 */
const IMAGE_FALLBACK_W = 200;
const IMAGE_FALLBACK_H = 150;

/**
 * File → data URL。
 * @param {File} file 图片文件
 * @returns {Promise<string>} data:image/…;base64,…
 */
export function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(String(reader.result || "")));
        reader.addEventListener("error", () => reject(reader.error || new Error("图片读取失败")));
        reader.readAsDataURL(file);
    });
}

/**
 * 取图片自然尺寸（`new Image()` 的 onload）。
 * @param {string} src data URL
 * @returns {Promise<{width: number, height: number}>} px；加载失败给 200×150 兜底
 */
export function measureImage(src) {
    return new Promise((resolve) => {
        const img = new Image();
        img.addEventListener("load", () => {
            const w = img.naturalWidth;
            const h = img.naturalHeight;
            resolve({
                width: Number.isFinite(w) && w > 0 ? w : IMAGE_FALLBACK_W,
                height: Number.isFinite(h) && h > 0 ? h : IMAGE_FALLBACK_H,
            });
        });
        img.addEventListener("error", () => resolve({ width: IMAGE_FALLBACK_W, height: IMAGE_FALLBACK_H }));
        img.src = src;
    });
}

/**
 * 选一张图片并转成模型可用的 `{src,width,height}`（取消返回 null）。
 * @returns {Promise<{src: string, width: number, height: number}|null>}
 */
export async function pickImage() {
    const file = await pickFile(IMAGE_ACCEPTS);
    if (!file) return null;
    const src = await readAsDataUrl(file);
    if (!src || !/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) return null;
    const size = await measureImage(src);
    return { src, width: size.width, height: size.height };
}

/**
 * 读内核路径下的文件（访达「打开方式」送来的路径）。
 * @param {string} path 内核路径，如 `/文档/x.docx`
 * @returns {Promise<File|null>} 不存在 / 已删除为 null；挂载未授权时抛 NeedsReauthError
 */
export async function readVfsFile(path) {
    return unwrap(await Deskly().fs.at(path));
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
 * 计算保存落点：来源是 VFS 路径、且其扩展名与本次写出的格式语义一致时原地回写；
 * 其余情况（本地选择器来的 File 没有可写回句柄、格式转换）落 /文档，
 * 绝不把新字节写进另一种格式的文件。
 * @param {string} currentPath 当前文档的来源 VFS 路径（无则空串）
 * @param {string} kind 本次写出的格式种类
 * @param {string} name 当前文件名
 * @param {string} documents /文档 的绝对路径
 * @returns {string} 绝对落点
 */
export function saveTargetPath(currentPath, kind, name, documents) {
    const fallback = `${String(documents || "").replace(/\/+$/, "")}/${fileName(kind, baseOf(name))}`;
    if (!currentPath) return fallback;
    const allowed = INPLACE_EXTS[kind] || [];
    return allowed.includes(extOf(currentPath)) ? currentPath : fallback;
}

/**
 * 保存当前文档：能原地回写就写回来源文件，否则写到 /文档；文本传 string，
 * OOXML 传 Uint8Array/Blob/ArrayBuffer，内核 write 都吃。
 * @param {string} name 文件名
 * @param {string|Uint8Array|ArrayBuffer|Blob} data 内容
 * @param {string} kind 本次写出的格式种类
 * @param {string} currentPath 当前文档的来源 VFS 路径（无则空串）
 * @returns {Promise<{ok:boolean, path?:string, inPlace?:boolean, reauth?:boolean, error?:string}>}
 *   ok 时 path 为规范化落点，inPlace 表示是否写回了打开时的文件
 */
export async function saveDocumentFile(name, data, kind, currentPath) {
    const path = saveTargetPath(currentPath, kind, name, Deskly().fs.paths.documents);
    try {
        const written = unwrap(await Deskly().fs.writeAt(path, data));
        return { ok: true, path: written, inPlace: Boolean(currentPath) && path === currentPath && written === path };
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
