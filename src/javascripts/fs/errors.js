/**
 * fs/errors.js — 文件系统错误码体系：全层统一用 FSError.code 说话，
 * 调用方不靠 message 猜。osfs.js 的历史错误类（NeedsReauthError/ConflictError）
 * 与 DOMException 在这里归一成错误码；name 保留原名，旧调用方不受影响。
 *
 * 本模块不 import 任何项目内模块（与 osfs.js 同一约束：避免循环依赖）。
 */

/** 错误码清单。改/加都要同步更新 devdocs（收口期）与 fs-check 探针。 */
const CODES = Object.freeze({
    ENOENT: "ENOENT",           // 路径不存在
    ENOTDIR: "ENOTDIR",         // 期望目录、实际是文件
    EISDIR: "EISDIR",           // 期望文件、实际是目录
    EEXIST: "EEXIST",           // 目标已存在（默认不覆盖）
    EPERM: "EPERM",             // 保护路径 / 越界 AppData / 未授权的操作
    EREAUTH: "EREAUTH",         // 挂载句柄权限待补（需要一次用户手势）
    EQUOTA: "EQUOTA",           // 存储配额不足
    EMOVEFAIL: "EMOVEFAIL",     // 移动中途失败（已尽力回滚）
    EREADONLY: "EREADONLY",     // 只读后端/只读视图上的写操作
    EIO: "EIO",                 // 其余读写故障的兜底
});

class FSError extends Error {
    /**
     * @param {string} code CODES 之一
     * @param {string} message 给人看的描述
     * @param {string} [path] 相关路径（可编程处理的锚点）
     */
    constructor(code, message, path) {
        super(message);
        this.name = "FSError";
        this.code = code;
        if (path !== undefined) this.path = path;
    }
}

/**
 * 把任意来源的错误归一成 FSError（已经是 FSError 的原样返回）。
 * 归一规则按 name 判别，与 osfs.js「不要靠 message 猜」同一约定。
 * @param {*} err 原始错误
 * @param {string} [path] 出错路径
 * @returns {FSError}
 */
function toFSError(err, path) {
    if (err instanceof FSError) return err;
    const name = err && err.name;
    const msg = (err && err.message) || String(err);
    switch (name) {
        case "NeedsReauthError": return new FSError(CODES.EREAUTH, msg, path ?? err.path);
        case "ConflictError": return new FSError(CODES.EEXIST, msg, path ?? err.path);
        case "NotFoundError": return new FSError(CODES.ENOENT, msg, path);
        case "TypeMismatchError": return new FSError(CODES.ENOTDIR, msg, path);
        case "QuotaExceededError": return new FSError(CODES.EQUOTA, msg, path);
        case "NotAllowedError": return new FSError(CODES.EPERM, msg, path);
        default: break;
    }
    // osfs 内部守卫抛的是普通 Error，按消息特征归一，兜不住的一律 EIO
    if (/不允许删除顶层目录|不允许移动顶层目录|目标位置是顶层目录|不能把目录移进它自己|根目录不能移动|越出插件目录/.test(msg)) {
        return new FSError(CODES.EPERM, msg, path);
    }
    if (/目标是目录/.test(msg)) return new FSError(CODES.EISDIR, msg, path);
    if (/同路径上已有文件/.test(msg)) return new FSError(CODES.ENOTDIR, msg, path);
    if (/目录非空/.test(msg)) return new FSError(CODES.EPERM, msg, path);
    return new FSError(CODES.EIO, msg, path);
}

/** 谓词：`err` 是否某个错误码（任意来源错误先归一再比）。 */
function isCode(err, code) {
    return err instanceof FSError ? err.code === code : toFSError(err).code === code;
}

export { CODES, FSError, toFSError, isCode };
