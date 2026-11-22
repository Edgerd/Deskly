/**
 * credentials.js — API 密钥的本机存放
 *
 * 用户已确认：密钥明文保存在 localStorage（经设置中枢的 ai.keys 槽）。
 * 这里只做读写与掩码，不做加密，也不把密钥回传给设置界面以外的消费者。
 */

import { settings } from "../settings.js";
import { byId } from "./providers.js";

const KEY = "ai.keys";

/** 读取全部密钥表；结构异常时按空表处理。 */
export function readKeys() {
    const value = settings.get(KEY);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value;
}

/** 取某个服务商的密钥；未配置返回空串。 */
export function keyOf(providerId) {
    const value = readKeys()[providerId];
    return typeof value === "string" ? value.trim() : "";
}

/** 该服务商当前是否具备调用条件（不需要密钥的本机服务视为已配置）。 */
export function hasKey(providerId) {
    const provider = byId(providerId);
    if (!provider) return false;
    return provider.keyRequired ? Boolean(keyOf(providerId)) : true;
}

/** 保存或覆盖密钥；空值等价于清除。 */
export function saveKey(providerId, apiKey) {
    const keys = { ...readKeys() };
    const value = String(apiKey || "").trim();
    if (value) keys[providerId] = value;
    else delete keys[providerId];
    return settings.set(KEY, keys, { source: "ai" });
}

/** 清除密钥。 */
export function clearKey(providerId) {
    const keys = { ...readKeys() };
    delete keys[providerId];
    return settings.set(KEY, keys, { source: "ai" });
}

/** 掩码：只露末四位，避免界面回显完整密钥。 */
export function maskKey(apiKey) {
    const value = String(apiKey || "");
    if (!value) return "";
    return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}
