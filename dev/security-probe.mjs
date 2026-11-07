/**
 * dev/security-probe.mjs — BUG-17 / BUG-18 / BUG-20 修复探针（Node，无需浏览器）。
 *
 * 用法：node dev/security-probe.mjs
 *
 * 证明四件事：
 *   1. BUG-17 伪造 plugin-registered / plugin-unregistered 事件不再授予权限、不清账本、
 *      不动默认应用绑定；真实注册/注销路径照常记账与清理。
 *   2. BUG-18 withCaller 不再导出；runAs 拒绝字符串与自造对象（CALLER_FORGED）；
 *      claimCaller 在插件栈帧下正常认领，runAs 正常注入与恢复。
 *   3. BUG-20 12+ 组 AppData 拼写变体（大小写 / 尾点尾空格 / 反斜杠 / 双斜杠 /
 *      `..` 回绕 / 尾随斜杠 / Unicode 分解形 / 根列举）越界全部被拒；正常路径不受影响。
 *   4. 公共总线保留字：isKernelTopic 命中内核主题，os-api.js 的 bus.emit 确实接线。
 *
 * 退出码：全部通过 0，任一失败 1。
 */

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolvePath(import.meta.url.replace(/^file:\/\/\/?/, ""), "..", "..");
const SRC = join(ROOT, "src", "javascripts");

/* ── 结果收集 ── */
let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; failures.push(name); console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}
async function checkAsync(name, fn) {
    try { check(name, await fn()); }
    catch (err) { check(name, false, err && err.message); }
}

/* ── 迷你宿主环境（与 dev/static-check.mjs 同款思路，只补探针用到的面） ── */
const evt = new Map();
const target = {
    addEventListener: (t, fn) => { if (!evt.has(t)) evt.set(t, []); evt.get(t).push(fn); },
    removeEventListener: (t, fn) => { const l = evt.get(t) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
    dispatchEvent: (e) => { (evt.get(e.type) || []).slice().forEach((fn) => fn(e)); return true; },
};
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
};
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true, writable: true });
globalThis.document = Object.assign(target, {
    documentElement: { lang: "", dataset: {}, style: { setProperty() { } } },
    querySelector: () => null,
    querySelectorAll: () => [],
});
globalThis.window = Object.assign(target, { innerWidth: 1440, innerHeight: 900 });
globalThis.CustomEvent = class {
    constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; this.bubbles = !!opts.bubbles; }
};

/* ── BUG-18：调用者身份不可冒用 ── */
console.log("\n■ BUG-18 身份冒用");
const cc = await import(pathToFileURL(join(SRC, "caller-context.js")).href);

check("withCaller 不再导出", !("withCaller" in cc));
check("claimCaller / runAs / CALLER_FORGED 已导出",
    typeof cc.claimCaller === "function" && typeof cc.runAs === "function" && cc.CALLER_FORGED === "CALLER_FORGED");

for (const [label, forged] of [
    ["字符串身份", "victim"],
    ["自造裸对象", { id: "victim" }],
    ["冻结裸对象", Object.freeze({ id: "victim" })],
]) {
    let code = null;
    try { cc.runAs(forged, () => { }); } catch (err) { code = err && err.code; }
    check(`runAs 拒绝${label}（code=CALLER_FORGED）`, code === "CALLER_FORGED", `实际 ${code}`);
}
check("runAs(null) 直接执行（不声明归属）", cc.runAs(null, () => 42) === 42);
check("无插件帧时 claimCaller 返回 null", cc.claimCaller() === null);

// 正向：造一个路径里带 /mods/probe-plugin/ 的临时模块，栈帧即插件身份。
const fixtureRoot = mkdtempSync(join(tmpdir(), "deskly-probe-"));
const fixtureDir = join(fixtureRoot, "mods", "probe-plugin");
mkdirSync(fixtureDir, { recursive: true });
const callerHref = pathToFileURL(join(SRC, "caller-context.js")).href;
writeFileSync(join(fixtureDir, "entry.mjs"), [
    `import { claimCaller, runAs, currentCaller } from ${JSON.stringify(callerHref)};`,
    `export function probeSelf() {`,
    `    const claim = claimCaller();`,
    `    if (!claim) return { ok: false, reason: "no-claim" };`,
    `    const inside = runAs(claim, () => currentCaller());`,
    `    // 同凭证嵌套：内层退出后外层归属恢复；runAs(null) 按文档不改动归属（null = 不声明）`,
    `    const nested = runAs(claim, () => {`,
    `        const inner = runAs(claim, () => currentCaller());`,
    `        const passthrough = runAs(null, () => currentCaller());`,
    `        return { inner, passthrough, outerAgain: currentCaller() };`,
    `    });`,
    `    return { ok: true, id: claim.id, inside, nested, after: currentCaller() };`,
    `}`,
].join("\n"));
const fixture = await import(pathToFileURL(join(fixtureDir, "entry.mjs")).href);
const self = fixture.probeSelf();
check("插件栈帧认领到自己 id", self.ok && self.id === "probe-plugin", JSON.stringify(self));
check("runAs 注入归属，嵌套/退出正确恢复",
    self.inside === "probe-plugin"
    && self.nested && self.nested.inner === "probe-plugin"
    && self.nested.passthrough === "probe-plugin"
    && self.nested.outerAgain === "probe-plugin"
    && self.after === null,
    JSON.stringify(self));

/* ── BUG-20：AppData 越界归一化 ── */
console.log("\n■ BUG-20 AppData 边界");
const { OSFS } = await import(pathToFileURL(join(SRC, "osfs.js")).href);

const rejected = [
    ["/appdata/victim/data/x", "全小写"],
    ["/APPDATA/VICTIM/DATA/X", "全大写"],
    ["/AppData./victim/data/x", "AppData 尾点"],
    ["/AppData /victim/data/x", "AppData 尾空格"],
    ["/AppData/victim./data/x", "scope 名尾点"],
    ["/AppData/victim/data/../../victim/data/x", ".. 回绕"],
    ["\\\\AppData\\victim\\data\\x", "反斜杠"],
    ["/AppData//victim//data//x", "重复斜杠"],
    ["/AppData/victim/data/x/", "尾随斜杠"],
    ["/AppData/café/data/x", "Unicode 组合形（NFC）"],
    ["/AppData/café/data/x", "Unicode 分解形（NFD）"],
    ["/AppData", "AppData 根列举"],
    ["/AppData/", "AppData 根（尾随斜杠）"],
    ["/AppData/attacker/../victim/x", "从自己 scope 回绕到他人"],
];
for (const [path, label] of rejected) {
    check(`越界被拒（${label}）：${path}`, OSFS.isOtherAppData(path, "attacker") === true);
}
const allowed = [
    ["/AppData/attacker/data/x", "attacker", "自己 scope"],
    ["/APPDATA/ATTACKER/DATA/X", "attacker", "自己 scope 大写变体"],
    ["/AppData/café/data/x", "café", "自己 scope 的 NFC/NFD 收敛"],
    ["/AppData/kernel/temp/y", "kernel", "内核 scope"],
    ["/文档/report.md", "attacker", "公开目录"],
    ["/下载", "attacker", "公开顶层目录"],
    ["/AppData2/victim/x", "attacker", "同前缀但非 AppData"],
    ["/", "attacker", "根"],
];
for (const [path, selfId, label] of allowed) {
    check(`正常放行（${label}）：${path}`, OSFS.isOtherAppData(path, selfId) === false);
}
// os-api.js 必须真的接上这个判定（而不是只导出了没人用）
const osApiSrc = readFileSync(join(SRC, "os-api.js"), "utf8");
check("os-api.js 边界检查走 OSFS.isOtherAppData", /OSFS\.isOtherAppData\(/.test(osApiSrc));
check("os-api.js 旧的大小写敏感正则已移除", !/\/\^\\\/AppData\\\//.test(osApiSrc));

/* ── BUG-17：伪造事件不再授予权限 ── */
console.log("\n■ BUG-17 授权伪造");
const registry = await import(pathToFileURL(join(SRC, "app-registry.js")).href);
const grants = await import(pathToFileURL(join(SRC, "api-grants.js")).href);
const defaults = await import(pathToFileURL(join(SRC, "default-apps.js")).href);

defaults.initDefaultApps();
await grants.initGrants();

// 记账不再挂开放 DOM 事件：初始化后 document 上不应有这两个监听
check("document 上无 plugin-registered 监听", !(evt.get("plugin-registered") || []).length);
check("document 上无 plugin-unregistered 监听", !(evt.get("plugin-unregistered") || []).length);

// 真实注册 → 钩子直接记账
registry.registerPlugin({ id: "attacker", name: "攻击者", permissions: ["files:read", "apps:launch"] });
const attackerGrants = grants.listGrants("attacker");
check("真实注册即记账（非敏感权限直接激活）",
    attackerGrants.some((g) => g.permission === "files:read" && g.granted && g.activated)
    && attackerGrants.some((g) => g.permission === "apps:launch" && g.granted));

// 伪造 registered：不授予任何权限
document.dispatchEvent(new CustomEvent("plugin-registered", {
    detail: { id: "forged", permissions: ["files:read", "apps:launch"] },
}));
check("伪造 plugin-registered 不授予权限", grants.listGrants("forged").length === 0);

// 伪造 unregistered：不清账本、不动默认应用绑定
defaults.set(".md", "attacker");
document.dispatchEvent(new CustomEvent("plugin-unregistered", { detail: { id: "attacker" } }));
check("伪造 plugin-unregistered 不清授权账本", grants.listGrants("attacker").length === attackerGrants.length);
check("伪造 plugin-unregistered 不动默认应用绑定", defaults.getAll()[".md"] === "attacker");

// 真实注销 → 钩子清账 + 清绑定
registry.unregisterPlugin("attacker");
check("真实注销清掉授权账本", grants.listGrants("attacker").length === 0);
check("真实注销清掉默认应用绑定", defaults.getAll()[".md"] === undefined);

// 公共总线保留字
const { isKernelTopic } = registry;
for (const t of ["plugin-registered", "plugin-unregistered", "plugin-unload", "plugins-ready",
    "settings-changed", "languagechange", "default-apps-changed", "window:focus", "lock-screen-change"]) {
    check(`保留主题拦截：${t}`, isKernelTopic(t) === true);
}
for (const t of ["my-plugin:hello", "plugin:note", "demo-refresh", ""]) {
    check(`插件自有主题放行：${JSON.stringify(t)}`, isKernelTopic(t) === false);
}
check("os-api.js 的 bus.emit 已接 isKernelTopic", /isKernelTopic\(type\)/.test(osApiSrc));

/* ── 汇总 ── */
console.log(`\n${passed} 通过 / ${failed} 失败`);
if (failed) {
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
}
console.log("安全探针全部通过 ✓");
