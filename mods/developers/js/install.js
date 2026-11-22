/**
 * install.js — 与系统插件库之间的安装、卸载与启动。
 *
 * 安装不自己写 IndexedDB：把编译好的文件打成 ZIP，交给 store-api.installZip，
 * 由它做 id 校验、权限确认、写入、回读校验与失败回滚。这样创建的插件和商店装的
 * 插件走同一条路径，卸载也能用同一份记录。
 */

import { ensureJSZip } from "../../../src/javascripts/vendor.js";
import { installZip, installMany, uninstall, verifyInstall } from "../../../src/javascripts/store-api.js";
import { buildFiles } from "./templates.js";
import { dataUrlToBlob, iconDataUrl } from "./icon.js";

/** 记录当前是否已经有运行副本。 */
export function installedInfo(record) {
    try {
        const info = Deskly.apps.info(record.id);
        if (!info) return null;
        return {
            id: record.id,
            name: info.name || record.name,
            version: (info.manifest && info.manifest.version) || "",
        };
    } catch (_) {
        return null;
    }
}

export function isInstalled(record) {
    return !!installedInfo(record);
}

async function packRecord(record) {
    const iconData = await iconDataUrl(record);
    const iconBlob = dataUrlToBlob(iconData);
    const files = buildFiles(record, iconBlob);

    const JSZip = await ensureJSZip();
    const zip = new JSZip();
    for (const [name, blob] of Object.entries(files)) zip.file(name, blob);
    const payload = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    return new File([payload], `${record.id}.zip`, { type: "application/zip" });
}

/**
 * 安装或覆盖安装。
 * @param {object} record 归一化记录
 * @param {{overwrite?:boolean, onProgress?:(phase:string,text:string)=>void}} opts
 * @returns {Promise<{ok:boolean, reason?:string, code?:string, id?:string, problems?:Array}>}
 */
export async function installRecord(record, opts = {}) {
    let file;
    try {
        file = await packRecord(record);
    } catch (err) {
        return { ok: false, reason: (err && err.message) || String(err) };
    }
    const result = await installZip(file, {
        overwrite: opts.overwrite === true,
        onProgress: opts.onProgress,
    });
    if (!result.ok) return result;
    // installZip 内部已回读校验；这里再确认一次注册表里确实能查到，防止索引与 IDB 不同步。
    const check = await verifyInstall(record.id);
    if (!check.ok) {
        return { ok: false, reason: "verify", problems: check.problems, code: "VERIFY" };
    }
    return result;
}

/**
 * 批量安装 / 重新安装：所有包一起交给系统层，只弹一次确认框。
 * @param {object[]} records 归一化记录
 * @param {{overwrite?:boolean, onProgress?:Function}} opts
 */
export async function installRecords(records, opts = {}) {
    const files = [];
    for (const record of records) {
        try {
            files.push(await packRecord(record));
        } catch (err) {
            return { ok: false, reason: (err && err.message) || String(err) };
        }
    }
    return installMany(files, { overwrite: opts.overwrite === true, onProgress: opts.onProgress });
}

/**
 * 卸载：确认框由系统层弹（apps:uninstall），这里不再自己弹第二次。
 * @param {string} id 插件 id
 * @param {{confirm?:boolean}} opts
 */
export async function uninstallRecord(id, opts = {}) {
    try {
        const res = await Deskly.apps.uninstall(id, opts);
        if (res && typeof res === "object") {
            if (res.ok) return { ok: true, ...(res.value || {}) };
            return { ok: false, reason: res.reason || "uninstall-failed", code: res.code, denied: !!res.denied };
        }
    } catch (err) {
        return { ok: false, reason: (err && err.message) || String(err), code: err && err.code };
    }
    return uninstall(id);
}

/** 快捷方式直接在宿主浏览器开新标签页；窗口/页面走系统启动入口。 */
export async function launchRecord(record) {
    if (record.kind === "shortcut") {
        const win = window.open(record.url, "_blank", "noopener,noreferrer");
        if (!win) return { ok: false, reason: "popup-blocked" };
        return { ok: true };
    }
    const res = await Deskly.apps.launch(record.id);
    if (res && res.ok) return { ok: true };
    return { ok: false, reason: (res && res.reason) || "launch-failed", denied: !!(res && res.denied) };
}
