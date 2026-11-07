/**
 * core/shortcuts.js — 桌面快捷方式（第 5 期）。
 *
 * 快捷方式就是 /桌面 下的真实文件 `<应用名>.webloc.json`：
 *   { kind: 'deskly-shortcut', appId, name, createdAt }
 * 因此重命名/拖进文件夹/移到废纸篓全部免费获得，重启后由桌面视图自然渲染。
 * 内容损坏或与文件名不符的 .webloc.json 按普通文件对待（不假装是快捷方式）。
 */

import { FS } from "../fs/index.js";
import { resolveAppRecord } from "../app-registry.js";

const EXT = ".webloc.json";
const KIND = "deskly-shortcut";

function isShortcutName(name) {
    return String(name || "").toLowerCase().endsWith(EXT);
}

/** 桌面唯一落点名：文稿.webloc.json → 文稿 (1).webloc.json 顺延。 */
async function uniqueShortcutPath(name) {
    const base = FS.sanitizeName(name, "未命名");
    const dir = FS.TOP.desktop.path;
    let candidate = FS.joinPath(dir, `${base}${EXT}`);
    for (let i = 1; await FS.exists(candidate); i++) candidate = FS.joinPath(dir, `${base} (${i})${EXT}`);
    return candidate;
}

/**
 * 给应用创建桌面快捷方式（启动台右键「添加到桌面」的处理）。
 * @param {string} appId 应用 id（插件 id 或 插件id.appId）
 * @returns {Promise<string>} 落点路径
 */
async function add(appId) {
    const rec = resolveAppRecord(appId);
    if (!rec) throw new Error(`找不到应用：${appId}`);
    const name = rec.name || rec.appId;
    const path = await uniqueShortcutPath(name);
    await FS.write(path, JSON.stringify({ kind: KIND, appId: rec.appId, name, createdAt: Date.now() }));
    return path;
}

/**
 * 移除桌面快捷方式（「从桌面移除」）：进废纸篓而不是硬删，与 macOS 一致可反悔。
 * @param {string} path 快捷方式路径
 */
async function remove(path) {
    const { moveToTrash } = await import("../trash.js");
    return moveToTrash(path);
}

/** 该应用的桌面快捷方式是否已存在（返回规范名命中路径或 null）。 */
async function findExisting(appId) {
    const entries = await FS.list(FS.TOP.desktop.path).catch(() => []);
    const hits = [];
    for (const entry of entries) {
        if (!isShortcutName(entry.name)) continue;
        const parsed = await read(entry.path);
        if (parsed && parsed.appId === appId) hits.push(entry.path);
    }
    if (!hits.length) return null;
    // 同名顺延副本可能存在多个：优先返回无 (n) 后缀的规范名，结果对调用方稳定
    hits.sort((a, b) => a.length - b.length);
    return hits[0];
}

/**
 * 读快捷方式内容。不是快捷方式（缺 kind / 内容损坏）返回 null——
 * 调用方据此把它当普通文件处理。
 */
async function read(path) {
    try {
        const file = await FS.read(path);
        if (!file) return null;
        const obj = JSON.parse(await file.text());
        if (!obj || obj.kind !== KIND || typeof obj.appId !== "string") return null;
        return obj;
    } catch (err) {
        return null;
    }
}

export const Shortcuts = Object.freeze({ EXT, KIND, isShortcutName, add, remove, findExisting, read });
globalThis.__shortcuts = Shortcuts;
