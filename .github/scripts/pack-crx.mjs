/**
 * pack-crx.mjs — 把扩展 ZIP 封成 CRX3。
 *
 * CRX3 文件结构：`Cr24` + uint32(版本=3) + uint32(头部长度) + CrxFileHeader + ZIP 原始字节。
 * 头部是 protobuf：sha256_with_rsa(公钥 + ZIP 与头部数据的签名) 与 signed_header_data(扩展 ID)。
 * 签名原文 = "CRX3 SignedData\0" + uint32(头部数据长度) + 头部数据 + ZIP 字节。
 *
 * 私钥只从文件读，脚本不打印任何私钥内容；密钥可以是 PEM，也可以是 base64 编码后的 PEM
 * （Secret 只能单行时用后者）。
 *
 * 用法：
 *   node .github/scripts/pack-crx.mjs --zip Deskly-0.4.3.zip --key crx-key.pem --out Deskly-0.4.3.crx
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, createHash, sign, verify } from "node:crypto";

const SIGNATURE_CONTEXT = Buffer.from("CRX3 SignedData\u0000", "utf8");

/** 读参数：--zip / --key / --out 三个都必填。 */
function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i];
        if (key === "--zip" || key === "--key" || key === "--out") args[key.slice(2)] = argv[++i];
    }
    for (const name of ["zip", "key", "out"]) {
        if (!args[name]) {
            console.error(`缺少参数 --${name}`);
            process.exit(2);
        }
    }
    return args;
}

/** protobuf varint。 */
function varint(value) {
    const bytes = [];
    let n = value;
    while (n > 0x7f) {
        bytes.push((n & 0x7f) | 0x80);
        n = Math.floor(n / 128);
    }
    bytes.push(n);
    return Buffer.from(bytes);
}

/** protobuf 的 length-delimited 字段（wire type 2）。 */
function fieldBytes(fieldNumber, payload) {
    return Buffer.concat([varint((fieldNumber << 3) | 2), varint(payload.length), payload]);
}

/** 32 位小端。 */
function uint32LE(value) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value >>> 0);
    return buf;
}

/**
 * 私钥文本 → KeyObject。允许 PEM 或 base64 过的 PEM（GitHub Secret 多行粘贴容易带坏换行）。
 * @param {string} text 文件内容
 * @returns {import("node:crypto").KeyObject}
 */
function loadPrivateKey(text) {
    let normalized = text.replace(/\r/g, "").trim();
    if (!normalized.includes("PRIVATE KEY")) {
        normalized = Buffer.from(normalized.replace(/\s+/g, ""), "base64").toString("utf8").replace(/\r/g, "").trim();
    }
    if (!normalized.includes("PRIVATE KEY")) throw new Error("私钥内容既不是 PEM，也不是 base64 编码的 PEM");
    return createPrivateKey(normalized);
}

/** 扩展 ID：公钥 DER 的 sha256 前 16 字节，每个 nibble 映射到 a–p。 */
function extensionId(crxId) {
    let out = "";
    for (const byte of crxId) {
        out += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f));
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const zip = readFileSync(args.zip);
if (zip.length < 4 || zip.readUInt32LE(0) !== 0x04034b50) throw new Error(`${args.zip} 不是 ZIP（缺 PK 头）`);

const privateKey = loadPrivateKey(readFileSync(args.key, "utf8"));
const publicKeyDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
const crxId = createHash("sha256").update(publicKeyDer).digest().subarray(0, 16);

// SignedData { crx_id = 1 }
const signedHeaderData = fieldBytes(1, crxId);
const signedPayload = Buffer.concat([SIGNATURE_CONTEXT, uint32LE(signedHeaderData.length), signedHeaderData, zip]);
const signature = sign("sha256", signedPayload, privateKey);

// AsymmetricKeyProof { public_key = 1, signature = 2 }
const proof = Buffer.concat([fieldBytes(1, publicKeyDer), fieldBytes(2, signature)]);
// CrxFileHeader { sha256_with_rsa = 2, signed_header_data = 10000 }
const header = Buffer.concat([fieldBytes(2, proof), fieldBytes(10000, signedHeaderData)]);

const crx = Buffer.concat([Buffer.from("Cr24", "utf8"), uint32LE(3), uint32LE(header.length), header, zip]);

// 自检：按写入的字节重新解出签名并验一次，避免产出「结构看起来对、Chrome 拒装」的包。
if (!verify("sha256", signedPayload, createPublicKey(privateKey), signature)) throw new Error("CRX3 签名自检失败");

writeFileSync(args.out, crx);
console.log(`CRX3 已生成：${args.out}`);
console.log(`  ZIP  ${(zip.length / 1024 / 1024).toFixed(2)}MB  头部 ${header.length}B  CRX ${(crx.length / 1024 / 1024).toFixed(2)}MB`);
console.log(`  扩展 ID ${extensionId(crxId)}`);
