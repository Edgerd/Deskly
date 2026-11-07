/**
 * fs/zip.js — ZIP 打包（store 模式：只归档不压缩，Q3 决策）。
 *
 * 不引入压缩算法：每个条目以 stored（method 0）写入，输出为标准 ZIP 容器，
 * macOS 归档实用工具 / Windows 资源管理器 / 7-Zip 都能直接解开。
 * 实现面：CRC32 + 本地文件头 + 中央目录 + EOCD，无外部依赖。
 */

/* CRC32 表：懒建一次，全模块复用 */
let CRC_TABLE = null;
function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
    }
    return CRC_TABLE;
}

function crc32(bytes) {
    const table = crcTable();
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** 文件名按 UTF-8 编码（ZIP 通用旗标 bit 11 随之置位，中文名不解码成乱码）。 */
function utf8(str) {
    return new TextEncoder().encode(str);
}

function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

/** DOS 日期时间（1980 起）。本地时区即可：解压方只把它当展示信息。 */
function dosDateTime(date = new Date()) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) >>> 0;
    return { time, day };
}

/**
 * 打一个 ZIP 包。
 * @param {Array<{name: string, data: Uint8Array, mtime?: Date}>} entries
 *   name 为包内路径（`/` 分层，目录以 `/` 结尾且 data 为空）
 * @returns {Uint8Array} 完整 ZIP 字节
 */
export function zipStore(entries) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const { time, day } = dosDateTime();

    for (const entry of entries) {
        const nameBytes = utf8(entry.name);
        const data = entry.data || new Uint8Array(0);
        const crc = crc32(data);
        const local = new Uint8Array([
            ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(time), ...u16(day),
            ...u32(crc), ...u32(data.length), ...u32(data.length),
            ...u16(nameBytes.length), ...u16(0),
        ]);
        chunks.push(local, nameBytes, data);
        central.push({ nameBytes, crc, size: data.length, offset, dir: entry.name.endsWith("/") });
        offset += local.length + nameBytes.length + data.length;
    }

    const centralStart = offset;
    for (const rec of central) {
        const recBytes = new Uint8Array([
            ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
            ...u16(time), ...u16(day), ...u32(rec.crc), ...u32(rec.size), ...u32(rec.size),
            ...u16(rec.nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
            ...u32(rec.dir ? 0x10 : 0), ...u32(rec.offset),
        ]);
        chunks.push(recBytes, rec.nameBytes);
        offset += recBytes.length + rec.nameBytes.length;
    }
    const centralSize = offset - centralStart;

    chunks.push(new Uint8Array([
        ...u32(0x06054b50), ...u16(0), ...u16(0),
        ...u16(central.length), ...u16(central.length),
        ...u32(centralSize), ...u32(centralStart), ...u16(0),
    ]));
    offset += 22;

    const out = new Uint8Array(offset);
    let at = 0;
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
    return out;
}

/**
 * 解析（探针/自检用）：读出中央目录的条目清单与正文。
 * 只认 store 模式（method 0），压缩条目抛错 —— 本模块不消费外来 ZIP。
 */
export function unzipList(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // 从尾部找 EOCD
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("不是 ZIP：找不到 EOCD");
    const count = view.getUint16(eocd + 10, true);
    let at = view.getUint32(eocd + 16, true);
    const out = [];
    for (let n = 0; n < count; n++) {
        if (view.getUint32(at, true) !== 0x02014b50) throw new Error("中央目录损坏");
        const method = view.getUint16(at + 10, true);
        if (method !== 0) throw new Error(`不支持的压缩方式：${method}`);
        const size = view.getUint32(at + 20, true);
        const nameLen = view.getUint16(at + 28, true);
        const extraLen = view.getUint16(at + 30, true);
        const commentLen = view.getUint16(at + 32, true);
        const localOffset = view.getUint32(at + 42, true);
        const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
        // 本地头再定位正文
        const lNameLen = view.getUint16(localOffset + 26, true);
        const lExtraLen = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + lNameLen + lExtraLen;
        out.push({ name, data: bytes.slice(dataStart, dataStart + size) });
        at += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}
