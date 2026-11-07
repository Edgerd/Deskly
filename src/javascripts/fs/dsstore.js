/**
 * fs/dsstore.js — 目录级 sidecar `.DS_Store`：桌面/访达的自由摆放坐标持久化（Q1 决策）。
 *
 * 契约：
 * - 格式：`{ version: 1, positions: { "<条目名>": { "x": n, "y": n } } }`，JSON 文本。
 * - 完全隐藏：文件名经 FS.isHiddenName 过滤，不进列表/搜索/选中/右键（见 fs/index.js）。
 * - 容错：读不到、JSON 损坏、结构不符一律回退空表（调用方落回默认网格），绝不抛错。
 * - 外来文件保护：已存在的 `.DS_Store` 若不是我们的格式（比如用户从 Mac 拷来的真身），
 *   标记为外来并拒绝覆盖——坐标只活在内存里，不毁用户的文件。
 * - 跨后端：只走 OSFS 公开读写，虚拟/挂载后端自动生效；移动/复制目录时它作为
 *   普通子项随目录走（OSFS.move 的目录语义），本模块不特殊处理。
 */

import { OSFS } from "../osfs.js";

const STORE_NAME = ".DS_Store";
const FORMAT_VERSION = 1;

/**
 * 解析 sidecar 文本。
 * @param {string} text
 * @returns {{version:number, positions:Object, foreign:boolean}}
 *   foreign=true 表示文件存在但不是我们的格式（不许覆盖）
 */
function parse(text) {
    try {
        const obj = JSON.parse(text);
        if (!obj || obj.version !== FORMAT_VERSION || !obj.positions || typeof obj.positions !== "object") {
            return { version: FORMAT_VERSION, positions: {}, foreign: true };
        }
        const positions = {};
        for (const [name, pos] of Object.entries(obj.positions)) {
            // 单条坐标损坏只丢那一条，不连累整表
            if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) positions[name] = { x: pos.x, y: pos.y };
        }
        return { version: FORMAT_VERSION, positions, foreign: false };
    } catch (err) {
        // JSON 都解不开：按外来文件对待（可能是真 .DS_Store 的二进制内容），不写
        return { version: FORMAT_VERSION, positions: {}, foreign: true };
    }
}

/**
 * 读目录的坐标表。任何失败（含目录不存在、权限待补之外）都回退空表。
 * @param {string} dir 目录绝对路径
 * @returns {Promise<{positions: Object, foreign: boolean}>}
 */
async function read(dir) {
    const storePath = OSFS.joinPath(OSFS.normalizePath(dir), STORE_NAME);
    try {
        const file = await OSFS.read(storePath);
        if (!file) return { positions: {}, foreign: false };
        return parse(await file.text());
    } catch (err) {
        // 权限待补要向调用方透传（界面要提示重新授权），其余损坏一律静默回退
        if (err && err.name === "NeedsReauthError") throw err;
        return { positions: {}, foreign: false };
    }
}

/**
 * 写目录的坐标表。外来文件在场时拒绝覆盖并返回 false（调用方按「坐标未持久化」继续）。
 * @param {string} dir 目录绝对路径
 * @param {Object} positions { 条目名: {x, y} }
 * @returns {Promise<boolean>} 是否真正落盘
 */
async function write(dir, positions) {
    const norm = OSFS.normalizePath(dir);
    const storePath = OSFS.joinPath(norm, STORE_NAME);
    try {
        const existing = await OSFS.read(storePath);
        if (existing && parse(await existing.text()).foreign) return false;
        const body = JSON.stringify({ version: FORMAT_VERSION, positions: positions || {} });
        await OSFS.write(storePath, body);
        return true;
    } catch (err) {
        if (err && err.name === "NeedsReauthError") throw err;
        console.warn("[dsstore] 坐标写入失败（本次只在内存生效）：", norm, err);
        return false;
    }
}

/** 单条更新：读-改-写。条目改名/删除时由调用方用 prune 清掉死坐标。 */
async function setPosition(dir, name, pos) {
    const { positions, foreign } = await read(dir);
    if (foreign) return false;
    positions[name] = { x: Math.round(pos.x), y: Math.round(pos.y) };
    return write(dir, positions);
}

/** 清理已经不存在的条目名对应的坐标，顺手裁剪体积。 */
async function prune(dir, liveNames) {
    const { positions, foreign } = await read(dir);
    if (foreign) return false;
    const live = new Set(liveNames);
    const next = {};
    for (const [name, pos] of Object.entries(positions)) {
        if (live.has(name)) next[name] = pos;
    }
    return write(dir, next);
}

/** 清空整目录坐标（「整理」操作）：外来文件同样不碰。 */
async function clear(dir) {
    const { foreign } = await read(dir);
    if (foreign) return false;
    return write(dir, {});
}

export const DSStore = { STORE_NAME, FORMAT_VERSION, read, write, setPosition, prune, clear };
