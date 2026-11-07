/**
 * dev/static-check.mjs — 跨模块静态一致性检查（磁盘即权威）。
 * 本项目无构建步骤、浏览器是唯一运行时，而浏览器实测有两个已知坑（`?v=Date.now()` 绕缓存、扩展页视口 0×0），
 * 能在磁盘上查出来的错就在这里查：import 目标不存在、import 说明符带 `?v=`（会把内核模块求值两次）、
 * assets 资源 404、四语言包键位与 data-i18n、插件面板 paneId/自带语言包对 registry.js、manifest 声明的资源存在性。
 * 用法：`node dev/static-check.mjs`（有问题退出码 1 并逐条列出）
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolvePath(import.meta.url.replace(/^file:\/\/\/?/, ""), "..", "..");
const REPO = process.cwd().replace(/\\/g, "/");

function walk(dir, out = []) {
    let items = [];
    try { items = readdirSync(dir); } catch { return out; }
    items.forEach((name) => {
        if (["node_modules", "dist", ".git", "vendor", "新建文件夹"].includes(name)) return;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (/\.(js|mjs|css|html|json)$/.test(name)) out.push(full);
    });
    return out;
}

const files = walk(resolvePath(REPO, "src")).concat(walk(resolvePath(REPO, "mods")), walk(resolvePath(REPO, "assets", "locales")));
const problems = [];
const info = [];
const posix = (p) => String(p).replace(/\\/g, "/");

const IMPORT_RE = /(?:^|\n)\s*(?:import\s+(?:[\w*{}\s,]+?)\s+from\s*|import\s*|export\s+(?:[\w*{}\s,]+?)\s+from\s*)["']([^"']+)["']/g;
const DYNAMIC_RE = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
const CSS_URL_RE = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
const IMG_SRC_RE = /<img[^>]+src\s*=\s*["']([^"']+)["']/g;
const I18N_ATTR_RE = /data-i18n\s*=\s*["']([^"']+)["']/g;
const ASSET_FN_RE = /(?:assetPath|assetIcon|glyph|modFile|modUrl)\s*\(\s*["']([^"']+)["']\s*(?:,\s*["']([^"']+)["'])?\s*\)/g;

function resolveSpecifier(spec, fromFile) {
    if (!spec.startsWith(".")) return null;
    return resolvePath(dirname(fromFile), spec.split("?")[0]);
}

// ── 1/2 import 解析与 ?v= 违规 ───────────────────────────────────────────
let importCount = 0;
files.forEach((file) => {
    if (!/\.(js|mjs)$/.test(file)) return;
    const text = readFileSync(file, "utf8");
    const rel = posix(relative(REPO, file));
    [...text.matchAll(IMPORT_RE), ...text.matchAll(DYNAMIC_RE)].forEach((m) => {
        const spec = m[1];
        importCount += 1;
        if (spec.includes("?")) problems.push(`${rel}：import 说明符带查询串（会另起一份模块实例）：${spec}`);
        // 模板串形式 ./panes/${name}.js 由 registry 的 module 字段覆盖（下面单独查存在性）
        if (/[$<>]/.test(spec)) return;
        const target = resolveSpecifier(spec, file);
        if (target && !existsSync(target)) problems.push(`${rel}：import 目标不存在 → ${spec}`);
    });
});
info.push(`解析 ${importCount} 处 import 说明符`);

// ── 3 资源路径存在性 ─────────────────────────────────────────────────────
let assetRefs = 0;
function checkSiteRootPath(rawPath, from) {
    if (!rawPath || rawPath.startsWith("data:") || /^https?:/.test(rawPath) || rawPath.startsWith("blob:")) return;
    // 模板串里的占位名（./assets/apps/<name>.html、`.../${x}`）不是真实路径，跳过
    if (/[<>]|\$\{/.test(rawPath)) return;
    const text = posix(rawPath).split("?")[0];
    // 浏览器把越过站根的路径（../../assets/…）截断回站根，这里用同一套语义：
    // 从第一次出现 assets/ 或 mods/ 的位置开始解析，才不会再报假 404。
    const cut = ["assets/", "mods/", "src/"].map((p) => text.indexOf(p)).filter((i) => i >= 0);
    if (!cut.length) return;
    const clean = text.slice(Math.min(...cut)).replace(/^\.\//, "");
    assetRefs += 1;
    if (!existsSync(join(REPO, clean))) problems.push(`${from}：资源不存在 → ${rawPath}`);
}

files.forEach((file) => {
    const rel = posix(relative(REPO, file));
    const text = readFileSync(file, "utf8");
    if (/\.(js|mjs|html)$/.test(file)) {
        [...text.matchAll(ASSET_FN_RE)].forEach((m) => {
            const base = m[1].replace(/\/$/, "");
            const sub = m[2];
            if (/\b(assetPath|modUrl|modFile|assetIcon|glyph)$/.test(m[0])) {
                const isIcon = m[0].includes("assetIcon");
                const isGlyph = m[0].includes("glyph(");
                const leaf = sub ? `${base}/${sub}` : base;
                if (isIcon) checkSiteRootPath(`./assets/icons/${leaf}.png`, rel);
                else if (isGlyph) checkSiteRootPath(`./assets/images/${leaf}.svg`, rel);
                else checkSiteRootPath(`./${leaf.startsWith("assets/") || leaf.startsWith("mods/") ? leaf : `assets/${leaf}`}`, rel);
            }
        });
        [...text.matchAll(IMG_SRC_RE)].forEach((m) => checkSiteRootPath(m[1], rel));
        // 直接拼出来的站内路径字符串（插件 HTML 里常见）
        [...text.matchAll(/["'](\.{0,2}\/?(?:assets|mods|src)\/[^"']+)["']/g)].forEach((m) => checkSiteRootPath(m[1], rel));
    }
    if (file.endsWith(".css")) {
        [...text.matchAll(CSS_URL_RE)].forEach((m) => {
            const url = m[1];
            if (/^(data:|#|https?:)/.test(url)) return;
            const target = resolvePath(dirname(file), url.split("?")[0]);
            assetRefs += 1;
            if (!existsSync(target)) problems.push(`${rel}：CSS url() 指向不存在的文件 → ${url}`);
        });
    }
});
info.push(`校验 ${assetRefs} 处资源引用`);

// ── 4 语言包键位对齐 + data-i18n 覆盖 ────────────────────────────────────
function flatKeys(obj, prefix = "", out = []) {
    Object.entries(obj || {}).forEach(([k, v]) => {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v)) flatKeys(v, key, out);
        else out.push(key);
    });
    return out;
}
const localeDir = resolvePath(REPO, "assets", "locales");
const locales = {};
try {
    readdirSync(localeDir).filter((f) => f.endsWith(".json")).forEach((f) => {
        locales[f.replace(/\.json$/, "")] = new Set(flatKeys(JSON.parse(readFileSync(join(localeDir, f), "utf8"))));
    });
} catch (err) {
    problems.push(`语言包目录读取失败：${err.message}`);
}
const langs = Object.keys(locales);
info.push(`语言包：${langs.join("/")}`);
langs.forEach((lang) => {
    const missing = [...locales["zh-CN"]].filter((k) => !locales[lang].has(k));
    if (missing.length) problems.push(`语言包 ${lang}.json 缺少 ${missing.length} 个 zh-CN 已有的键：${missing.slice(0, 12).join(", ")}${missing.length > 12 ? " …" : ""}`);
    const extra = [...locales[lang]].filter((k) => !locales["zh-CN"].has(k));
    if (extra.length) problems.push(`语言包 ${lang}.json 有 ${extra.length} 个 zh-CN 没有的键：${extra.slice(0, 12).join(", ")}${extra.length > 12 ? " …" : ""}`);
});

const usedI18nKeys = new Map();
const dataI18nKeys = new Set();
files.forEach((file) => {
    if (!/\.(html|js)$/.test(file)) return;
    const rel = posix(relative(REPO, file));
    // 只对本次重写的范围负责：内核 + 系统设置插件。其它 mods 的历史用词不在门禁内
    // （它们的既有惯例是 t("key","中文兜底")，缺兜底的旧问题另案处理，不在本次报告里刷噪音）。
    if (!rel.startsWith("src/javascripts") && !rel.startsWith("mods/system-settings")) return;
    const text = readFileSync(file, "utf8");
    // 站内既有惯例是 t("key", "中文兜底")：给了兜底就不会出现空白界面。
    // 真正会静默失效的是「无兜底 + 四语皆缺」，所以按有没有第二个实参来判。
    [...text.matchAll(/(?:i18n\s*\.\s*)?\bt\(\s*["']([^"']+)["']\s*(,)?/g)].forEach((m) => {
        if (!m[2] && !usedI18nKeys.has(m[1])) usedI18nKeys.set(m[1], rel);
    });
    [...text.matchAll(I18N_ATTR_RE)].forEach((m) => dataI18nKeys.add(m[1]));
});
/** 插件自带语言包（面板模块里的 messages）也算已定义，不参与内核 JSON 的缺失判定。 */
const pluginKeys = new Set();
const settingsDir = resolvePath(REPO, "mods", "system-settings");

/** 迷你 DOM：够让插件/内核模块在 Node 里求值。 */
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = []; this.dataset = {}; this.attrs = {}; this._text = "";
        this.style = { cssText: "", setProperty() { } };
        this.classList = { add() { }, remove() { }, toggle() { }, contains() { return false; } };
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    hasAttribute(k) { return k in this.attrs; }
    appendChild(n) { this.children.push(n); return n; }
    append(...ns) { this.children.push(...ns); }
    remove() { } addEventListener() { } removeEventListener() { }
    // 同样返回替身节点：内核里大量 `x.querySelector(...)` 链式取值，读成 null 会伪装成模块缺陷
    querySelector() { return new FakeNode("div"); } querySelectorAll() { return []; }
    closest() { return new FakeNode("div"); }
    matches() { return false; }
    set textContent(v) { this._text = String(v); } get textContent() { return this._text; }
}
const evt = new Map();
const target = {
    addEventListener: (t, fn) => { if (!evt.has(t)) evt.set(t, []); evt.get(t).push(fn); },
    removeEventListener: () => { },
    dispatchEvent: (e) => { (evt.get(e.type) || []).forEach((fn) => fn(e)); return true; },
};
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true, writable: true });
globalThis.document = Object.assign(target, {
    documentElement: new FakeNode("html"), head: new FakeNode("head"), body: new FakeNode("body"),
    createElement: (t) => new FakeNode(t),
    // getElementById 也给替身节点：内核里有 `getElementById(x).querySelector(...)` 的链式写法，
    // 返回 null 会让「模块能否求值」变成检查器的假阴性。
    getElementById: () => new FakeNode("div"),
    // 返回替身节点而不是 null：插件面板会静态 import finderbar 这类求值期就摸 DOM 的内核模块，
    // 真实页面里这些元素一定存在，读成 null 反而会把「模块能否求值」测成假阴性。
    querySelector: () => new FakeNode("div"),
    querySelectorAll: () => [], createDocumentFragment: () => new FakeNode("frag"), visibilityState: "visible",
});
globalThis.window = Object.assign(target, { innerWidth: 1440, innerHeight: 900, matchMedia: () => ({ matches: false, addEventListener() { } }), getComputedStyle: () => ({ getPropertyValue: () => "" }) });
globalThis.CustomEvent = class { constructor(t, o = {}) { this.type = t; this.detail = o.detail; this.bubbles = !!o.bubbles; } };
// 窗口层在模块求值期就 new MutationObserver（观察器随窗口建立）。浏览器里必然存在，
// Node 里没有这个全局，缺替身会把「模块能否求值」测成假阴性。
globalThis.MutationObserver = class {
    observe() { } disconnect() { } takeRecords() { return []; }
};
globalThis.getComputedStyle = globalThis.window.getComputedStyle;
globalThis.self = globalThis;

if (existsSync(join(settingsDir, "panes"))) {
    const { PANES } = await import(pathToFileURL(join(settingsDir, "registry.js")).href);
    const implemented = new Set(PANES.filter((p) => p.implemented).map((p) => p.id));
    const moduleFiles = new Set(readdirSync(join(settingsDir, "panes")).map((f) => f.replace(/\.js$/, "")));
    PANES.forEach((p) => {
        if (!p.implemented) return;
        if (!moduleFiles.has(p.module)) problems.push(`registry.js：面板 ${p.id} 标记已实现但缺 panes/${p.module}.js`);
    });
    [...moduleFiles].forEach((m) => {
        if (!PANES.some((p) => p.module === m)) problems.push(`panes/${m}.js 存在但没有任何注册条目指向它`);
    });

    for (const name of readdirSync(join(settingsDir, "panes"))) {
        const full = join(settingsDir, "panes", name);
        let mod;
        try {
            mod = await import(pathToFileURL(full).href);
        } catch (err) {
            problems.push(`panes/${name}：无法在 Node 中求值 → ${err.message}`);
            continue;
        }
        if (!mod.paneId) problems.push(`panes/${name}：没有导出 paneId`);
        else if (!implemented.has(mod.paneId)) problems.push(`panes/${name}：paneId "${mod.paneId}" 不在注册表的已实现面板里`);
        if (typeof mod.build !== "function") problems.push(`panes/${name}：没有导出 build() 函数`);
        const perLang = mod.messages || {};
        const present = Object.keys(perLang);
        ["zh-CN", "en", "ja-JP", "cat"].forEach((lang) => {
            if (!perLang[lang]) problems.push(`panes/${name}：messages 缺少 ${lang}`);
        });
        const base = flatKeys(perLang["zh-CN"] || {});
        const withPrefix = new Set(base);
        present.forEach((lang) => {
            const keys = new Set(flatKeys(perLang[lang] || {}));
            [...base].filter((k) => !keys.has(k)).forEach((k) => problems.push(`panes/${name}：${lang} 缺键 ${k}`));
            [...keys].filter((k) => !base.includes(k)).forEach((k) => problems.push(`panes/${name}：${lang} 多出键 ${k}`));
        });
        base.forEach((k) => pluginKeys.add(k));
    }
    info.push(`插件面板：${(existsSync(join(settingsDir, "panes")) ? readdirSync(join(settingsDir, "panes")).length : 0)} 个模块，自带 ${withSize(pluginKeys)} 条键`);
}

function withSize(set) { return set.size; }

/** 内核 JSON + 插件自带键 共同构成可用译文；两处都没有才算缺失。 */
[...usedI18nKeys.entries()].sort().forEach(([key, where]) => {
    if (key.startsWith("ss.")) return; // 插件自带语言包，已按面板逐个校验
    const inKernel = langs.some((lang) => locales[lang]?.has(key));
    if (!inKernel && !pluginKeys.has(key)) problems.push(`${where}：译文键 ${key} 无兜底且四个语言包都没有`);
});
info.push(`引用到的译文键 ${usedI18nKeys.size} 个（无兜底调用）+ data-i18n ${dataI18nKeys.size} 个`);

// ── 5 模糊必须走系统令牌（lint 掉硬编码 blur） ─────────────────────────────
/**
 * 规则：除令牌定义处（--surface-blur-* 那几行）外，任何 CSS / JS 里都不得再出现
 * `blur(<数字>px)` 字面量；带 backdrop-filter 的声明必须引用 var(--surface-blur…)。
 * 这是「模糊由系统统一分配」唯一能被机器守住的形式 —— 只靠文档约定，
 * 下一轮改动就会把 30px / 45px 重新抄回各处。
 */
const BLUR_LITERAL = /blur\(\s*(\d+(?:\.\d+)?)px\b/g;
const cssFiles = walk(resolvePath(REPO, "assets", "stylesheets")).concat(walk(resolvePath(REPO, "mods")), walk(resolvePath(REPO, "src")))
    .filter((f) => /\.(css|js)$/.test(f));
let blurSites = 0;
let tokenizedSites = 0;
let tokenRefs = 0;
cssFiles.forEach((file) => {
    const rel = posix(relative(REPO, file));
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
        const isCss = file.endsWith(".css");
        // JS 里只关心写成样式串/自定义属性的模糊值
        if (!isCss && !/backdropFilter|backdrop-filter|--surface-blur|cssText/.test(line)) return;
        // 注释行不参与判定（说明「为什么原来是 30px」这类文字是有效信息）
        const trimmed = line.trim();
        if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("//")) return;
        // 先数令牌引用：它是「迁移确实发生过」的证据，没有它 0 字面量毫无意义
        tokenRefs += (line.match(/var\(--surface-blur[-\w]*/g) || []).length;
        const hits = [...line.matchAll(BLUR_LITERAL)];
        if (!hits.length) return;
        blurSites += hits.length;
        // 令牌定义行本身就带 px 兜底，属于唯一允许点
        if (/--surface-blur(-unit|-\d)?\s*:/.test(line)) { tokenizedSites += hits.length; return; }
        problems.push(`${rel}:${index + 1}：模糊值仍是硬编码字面量，应改用 var(--surface-blur-N) → ${trimmed.slice(0, 90)}`);
    });
    // backdrop-filter 声明必须引用令牌（none / 关闭态除外）
    lines.forEach((line, index) => {
        if (!file.endsWith(".css")) return;
        const m = line.match(/(?:^|[\s;{])(-webkit-)?backdrop-filter\s*:\s*([^;}]+)/);
        if (!m) return;
        const value = m[2];
        if (/^\s*none\b/.test(value) || /var\(--surface-blur/.test(value)) return;
        if (!/blur\(/.test(value)) return; // saturate/brightness 之类的配套函数不管
        problems.push(`${rel}:${index + 1}：backdrop-filter 有 blur 但没引用系统令牌 → ${value.trim().slice(0, 80)}`);
    });
});
info.push(`模糊点 ${blurSites} 处字面量 / 令牌引用 ${tokenRefs} 处（定义处 ${tokenizedSites} 处）`);
// 自校验：字面量为 0 但一处令牌引用都没有，说明要么扫描没覆盖到文件、要么整批迁移被回退，
// 这两种情况报「通过」都比报失败更危险，所以直接判失败。
if (blurSites === 0 && tokenRefs === 0) {
    problems.push("模糊 lint 自检失败：既没找到 blur 字面量也没找到任何 var(--surface-blur…) 引用，判定为扫描失效");
}

// ── 5b 墙纸着色的浓度必须真的吃 --tint-strength ────────────────────────────
/**
 * 规则：着色表面的固有浓度一律写成 calc(<固有浓度> * var(--tint-strength))。
 * 这条 lint 是被真实缺陷逼出来的：appearance.tintStrength（着色浓度）滑块刚接上时
 * 只有「外观」面板的预览 chip 乘了这个因子，窗口侧栏 / 控制中心 / 访达全部没乘 ——
 * 滑块拖动只让预览动，真实界面纹丝不动，正是「界面在动、其实没生效」的假设置。
 * 顺带管住颜色来源：着色只准读 --tint-rgb（它优先取 surface.js 色相旋转后的
 * --tint-adjusted-rgb），直接写 --window-tint-rgb 会让「色调偏移」滑块对该表面失效。
 */
let tintSites = 0;
cssFiles.forEach((file) => {
    const rel = posix(relative(REPO, file));
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("//")) return;
        const hits = [...line.matchAll(/rgba\(\s*var\(--(tint|window-tint)-rgb\)\s*,\s*([^)]+)\)/g)]
            .concat([...line.matchAll(/var\(--tint-color\)\s+(\d+(?:\.\d+)?)%/g)]);
        hits.forEach((m) => {
            tintSites += 1;
            const where = `${rel}:${index + 1}`;
            if (m[1] === "window-tint") {
                problems.push(`${where}：着色表面直接读 --window-tint-rgb，绕过色相推导，应改用 var(--tint-rgb) → ${trimmed.slice(0, 90)}`);
                return;
            }
            const alpha = m[2] || m[1];
            // 注意用子串判定而不是 var\(--tint-strength\)：外层正则的 [^)]+ 会在
            // calc(… * var(--tint-strength)) 的第一个右括号处截断，捕获组里没有收尾括号。
            if (!/--tint-strength/.test(String(alpha))) {
                problems.push(`${where}：墙纸着色浓度没乘 var(--tint-strength)，「着色浓度」滑块对该表面无效 → ${trimmed.slice(0, 90)}`);
            }
        });
    });
});
info.push(`墙纸着色浓度 ${tintSites} 处`);
if (tintSites === 0) {
    problems.push("着色 lint 自检失败：一处 --tint-rgb / --tint-color 用法都没扫到，判定为扫描失效");
}

// ── 6 manifest 声明的资源存在性 ───────────────────────────────────────────
const modsDir = resolvePath(REPO, "mods");
readdirSync(modsDir).forEach((id) => {
    const mf = join(modsDir, id, "manifest.json");
    if (!existsSync(mf)) { problems.push(`mods/${id}：缺少 manifest.json`); return; }
    let manifest;
    try { manifest = JSON.parse(readFileSync(mf, "utf8")); } catch (err) { problems.push(`mods/${id}/manifest.json：JSON 解析失败 ${err.message}`); return; }
    if (manifest.id !== id) problems.push(`mods/${id}/manifest.json：id "${manifest.id}" 与目录名不一致（安装会落到另一个 id）`);
    ["main", "style", "script", "icon"].forEach((field) => {
        if (!manifest[field]) return;
        if (/^(https?:|data:|blob:)/.test(manifest[field])) return;
        if (!existsSync(join(modsDir, id, manifest[field]))) problems.push(`mods/${id}：manifest.${field} 指向不存在的文件 → ${manifest[field]}`);
    });
    (manifest.apps || []).forEach((app) => {
        ["main", "style", "script", "icon"].forEach((field) => {
            if (app[field] && !existsSync(join(modsDir, id, app[field]))) problems.push(`mods/${id}：apps[${app.id}].${field} 不存在 → ${app[field]}`);
        });
    });
});

// ── 7 插件 API 权限声明（api-grants / os-api / default-apps 三方对齐）─────────
// 这一节是「声明了却没人校验」和「校验了却没声明」两类漂移的唯一门禁：
// 权限名表在 api-grants.js 里，弹窗文案也在它里面，而实际拦截点在 os-api.js 的 guard()。
const { PERMISSION_NAMES, PERMISSION_LABELS } = await import("../src/javascripts/api-grants.js");
const PERM_SET = new Set(PERMISSION_NAMES);
const modsIds = readdirSync(modsDir);

readdirSync(modsDir).forEach((id) => {
    const mf = join(modsDir, id, "manifest.json");
    if (!existsSync(mf)) return;
    let manifest;
    try { manifest = JSON.parse(readFileSync(mf, "utf8")); } catch (err) { return; }
    if (!Array.isArray(manifest.permissions)) {
        problems.push(`mods/${id}/manifest.json：缺少 permissions 数组（内置插件必须显式声明，空能力写 []）`);
        return;
    }
    manifest.permissions.forEach((p) => {
        if (!PERM_SET.has(p)) problems.push(`mods/${id}：permissions 里的 "${p}" 不是已定义的权限名`);
    });
    if (new Set(manifest.permissions).size !== manifest.permissions.length) {
        problems.push(`mods/${id}：permissions 有重复项`);
    }
    (manifest.apps || []).forEach((app) => {
        (app.permissions || []).forEach((p) => {
            if (!manifest.permissions.includes(p)) {
                problems.push(`mods/${id}：apps[${app.id}].permissions 的 "${p}" 超出插件级声明范围`);
            }
        });
    });
});

// 每个权限名都要有中文描述：弹窗正文和帮助文档共用这张表，缺一条就弹英文键名。
PERMISSION_NAMES.forEach((p) => {
    if (!PERMISSION_LABELS[p]) problems.push(`api-grants.js：权限 ${p} 没有中文描述（PERMISSION_LABELS 缺项）`);
});
Object.keys(PERMISSION_LABELS).forEach((p) => {
    if (!PERM_SET.has(p)) problems.push(`api-grants.js：PERMISSION_LABELS 里的 "${p}" 不是已定义权限名`);
});

// os-api.js 的 guard("…") 只能用已定义的名字；写错一个字母等于该能力永不设防。
const osApiText = readFileSync(join(REPO, "src/javascripts/os-api.js"), "utf8");
[...osApiText.matchAll(/guard\(\s*"([^"]+)"/g)].forEach(([, p]) => {
    if (!PERM_SET.has(p)) problems.push(`os-api.js：guard("${p}") 的权限名未在 api-grants.js 定义`);
});

// default-apps.js 的出厂默认必须指向真实可启动的应用，否则双击文件会落到空 appId。
const daText = readFileSync(join(REPO, "src/javascripts/default-apps.js"), "utf8");
const defaultsBlock = (daText.match(/const SYSTEM_DEFAULTS = \{([\s\S]*?)\n\};/) || [])[1] || "";
[...defaultsBlock.matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)].forEach(([, key, appId]) => {
    const [pluginId, subApp] = appId.split(".");
    if (!modsIds.includes(pluginId)) {
        problems.push(`default-apps.js：SYSTEM_DEFAULTS 的 "${key}" 指向不存在的插件 ${appId}`);
        return;
    }
    if (!subApp) return;
    const mf = join(modsDir, pluginId, "manifest.json");
    const manifest = existsSync(mf) ? JSON.parse(readFileSync(mf, "utf8")) : null;
    if (!manifest || !(manifest.apps || []).some((a) => a.id === subApp)) {
        problems.push(`default-apps.js：SYSTEM_DEFAULTS 的 "${key}" 指向 ${appId}，但该插件没有这个子应用`);
    }
});
// 键文法（设计决策 5）：扩展名带点、协议带冒号，混进第三种写法就永远匹配不上。
[...defaultsBlock.matchAll(/"([^"]+)"\s*:/g)].forEach(([, key]) => {
    if (!(/^\.[a-z0-9]+$/.test(key) || /^[a-z][a-z0-9+.-]*:$/.test(key))) {
        problems.push(`default-apps.js：SYSTEM_DEFAULTS 键 "${key}" 既不像是 .md 也不像是 http:`);
    }
});
info.push(`权限名 ${PERMISSION_NAMES.length} 条、内置插件 permissions 声明 ${modsIds.length} 个、默认应用出厂值 ${defaultsBlock.split("\n").filter((l) => l.includes('": "')).length} 条`);

// ── 8 设置界面文案（苹果风格，无 AI 味）───────────────────────────────────
/**
 * 规则：设置面板的文案是给用户看的，不是给工程师看的。
 *  A. 提示行（hint）默认不该存在；确实要留的必须是一句、≤18 字、且不出现实现词
 *     （系统 / 令牌 / 像素 / 静态检查 / 设置中枢 / 面板 / 卡片 / 归档 / 广播 / 事件 / 槽 / schema / console / json / IndexedDB / 插件）。
 *     这类句子写的是「不写就会误解的后果」，不是「这东西怎么工作」。
 *  B. 标题（label）≤12 字、不以句读结尾、不带引号堆叠 —— 开关的标题写被打开的东西本身。
 * 扫描范围：内核里所有会 `settings.define` 的模块（只扫 settings-definitions.js 会漏掉 controlcenter /
 *  display / lock 这些自注册模块）+ 系统设置插件的 registry 与全部面板模块。
 *  排除 api-grants.js：它的 {label, hint} 是授权弹窗正文，要写清楚「谁要做什么」，不适用短句口径。
 */
const copyFiles = walk(resolvePath(REPO, "src", "javascripts")).filter((f) => f.endsWith(".js")
    && !f.endsWith("api-grants.js"))
    .concat([resolvePath(REPO, "mods", "system-settings", "registry.js")])
    .concat(readdirSync(resolvePath(REPO, "mods", "system-settings", "panes")).map((f) => join(resolvePath(REPO, "mods", "system-settings", "panes"), f)))
    .filter((f) => f.endsWith(".js"));
const BANNED_IN_HINT = /系统|令牌|像素|静态检查|设置中枢|面板|卡片|归档|广播|事件|槽|schema|console|IndexedDB|json|插件/i;
/** 取 `label:` / `hint:` 冒号之后第一个字符串字面量的内容：
 *  `hint: "…"` 直接取到正文；`hint: t("ss.k", "…")` 第一段是译文键，跳过它取正文。
 *  必须从键名之后开始找 —— 同一行往往还有 event: / apply: 之类的字符串，取整行最后一段会抓到它们。 */
function literalAfter(line, key) {
    const at = line.indexOf(`${key}:`);
    if (at < 0) return null;
    const hits = [...line.slice(at + key.length + 1).matchAll(/(["`])((?:\\.|(?!\1)[^\\])*?)\1/g)].map((m) => m[2]);
    let text = hits[0];
    // 译文键的判定要允许连字符：ss.lock-screen.goto / ss.default-apps.* 这类键名带短横，
    // 早先只写 [\w.]* 会把键本身当成正文，报出「标题 22 字」的假红。
    // 带 ${…} 的是拼出来的模板键（`ss.appearance.blurLevels.${i}`），同样不是文案。
    const isMessageKey = (s) => typeof s === "string" && !/[\u4e00-\u9fff]/.test(s) && !s.includes("${")
        && (/^[A-Za-z][\w.-]*$/.test(s) || s.startsWith("ss."));
    if (isMessageKey(text)) text = hits[1];
    if (isMessageKey(text) || text === undefined) return null;
    // 拼出来的文案（`${meta.label}面板`）长度取决于运行时，量不了，也不该量
    if (text.includes("${")) return null;
    return text;
}
/** 文案长度按「显示单位」计：一串拉丁字母/数字算一个词（macOS 中文界面里 "Night Shift" 就是一个词）。 */
const len = (s) => [...String(s).replace(/[A-Za-z0-9]+/g, "◊")].length;
let hintSites = 0;
let labelSites = 0;
copyFiles.forEach((file) => {
    const rel = posix(relative(REPO, file));
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        const where = `${rel}:${index + 1}`;
        if (/\bhint:/.test(line)) {
            const text = literalAfter(line, "hint");
            if (text === null) return;
            hintSites += 1;
            if (len(text) > 18) problems.push(`${where}：提示行 ${len(text)} 字（上限 18），或应直接删掉 → ${text.slice(0, 40)}`);
            if (BANNED_IN_HINT.test(text)) problems.push(`${where}：提示行写了实现细节，用户不需要知道 → ${text.slice(0, 40)}`);
        }
        if (/\blabel:/.test(line)) {
            const text = literalAfter(line, "label");
            if (text === null) return;
            labelSites += 1;
            if (len(text) > 12) problems.push(`${where}：标题 ${len(text)} 字（上限 12）→ ${text}`);
            if (/[。！？]$/.test(text)) problems.push(`${where}：标题不应以句读结尾 → ${text}`);
        }
    });
});
info.push(`设置文案：提示行 ${hintSites} 处、标题 ${labelSites} 处`);
if (labelSites === 0) {
    problems.push("文案 lint 自检失败：一处 label 都没扫到，判定为扫描失效");
}

// ── 术语禁用词（以 dev/devdoc/glossary.md 为准） ─────────────────────────
// 只扫「会显示给用户」的三类来源：zh-CN 语言包值、i18n.t 的兜底文案、label/title 字面量。
// 注释里的历史用词不参与——它们不面向用户。
const BANNED_TERMS = [
    ["回收站", "废纸篓"],
    ["壁纸", "墙纸"],
    ["侧边栏", "边栏"],
    ["任务栏", "程序坞"],
    ["Dock 栏", "程序坞"],
    ["舞台管理器", "台前调度"],
    ["小部件", "小组件"],
    ["清空废纸篓", "清倒废纸篓"],
];
const bannedHits = [];
function checkText(text, where) {
    const s = String(text || "");
    BANNED_TERMS.forEach(([bad, good]) => {
        if (s.includes(bad)) bannedHits.push(`${where}：「${bad}」应为「${good}」→ ${s.slice(0, 40)}`);
    });
}
try {
    const zh = JSON.parse(readFileSync(resolvePath(localeDir, "zh-CN.json"), "utf8"));
    const walkJson = (node, path) => {
        if (node === null || node === undefined) return;
        if (typeof node === "string") { checkText(node, `assets/locales/zh-CN.json#${path}`); return; }
        if (typeof node !== "object") return;
        Object.entries(node).forEach(([k, v]) => walkJson(v, path ? `${path}.${k}` : k));
    };
    walkJson(zh, "");
} catch { /* 语言包读取失败已在上面报过 */ }
const JS_LITERAL = /(?:i18n\.t\(|[\s{](?:label|title|placeholder|buttonText|hint|desc|description)\s*[:=]\s*)["']([^"']*[\u4e00-\u9fff][^"']*)["']/g;
files.filter((f) => f.endsWith(".js")).forEach((file) => {
    const rel = posix(relative(REPO, file));
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        let m;
        JS_LITERAL.lastIndex = 0;
        while ((m = JS_LITERAL.exec(line))) checkText(m[1], `${rel}:${index + 1}`);
    });
});
bannedHits.forEach((hit) => problems.push(hit));
info.push(`术语守卫：禁用词命中 ${bannedHits.length} 处（${BANNED_TERMS.map(([bad]) => bad).join("/")}）`);

// ── 9 动态拼 i18n 键（redlines 的机器兜底）────────────────────────────────
/**
 * 规则：t("a." + x) / t(`a.${x}`) 这类动态拼键逃过四语键集比对与「无兜底才拦」规则，
 * 是漏键高发形态，一律标记。有边界的拼键（前缀包装器、七种标签色查表）在代码行尾
 * 加 `i18n-dynamic-ok` 豁免并写清边界。
 * 扫描范围：src/javascripts + mods。并发重写中的目录暂不入扫（结束后应逐个去掉排除
 * 再全量过一遍）：mods/office、mods/finder、mods/spotlight、app-registry.js。
 */
const DYN_KEY_CONCAT = /\bt\(\s*["'][^"']*["']\s*\+/;
const DYN_KEY_TEMPLATE = /\bt\(\s*`[^`]*\$\{/;
/** 并发重写排除（文件级）：这些路径正被其它任务线改写，规则暂不覆盖。 */
const DYN_KEY_SKIP = /mods[\/\\]office|mods[\/\\]finder|mods[\/\\]spotlight|app-registry\.js$/;
let dynKeySites = 0;
files.filter((f) => f.endsWith(".js") && !DYN_KEY_SKIP.test(posix(f))).forEach((file) => {
    const rel = posix(relative(REPO, file));
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        if (!DYN_KEY_CONCAT.test(line) && !DYN_KEY_TEMPLATE.test(line)) return;
        dynKeySites += 1;
        if (line.includes("i18n-dynamic-ok")) return;
        problems.push(`${rel}:${index + 1}：动态拼 i18n 键（漏键高发形态），改为静态键表或在行尾加 i18n-dynamic-ok 豁免 → ${trimmed.slice(0, 90)}`);
    });
});
info.push(`动态拼键扫描：命中 ${dynKeySites} 处`);

// ── 10 运行时资源文件名 ASCII ─────────────────────────────────────────────
/**
 * 规则：assets/ 与 mods/ 下被运行时引用的资源文件名只允许 ASCII。
 * SW 回源链是百分号编码的（sw.js decodeName 注释），非 ASCII 名在 ZIP 插件与
 * 磁盘插件两条安装路径上行为不一致——这条过去只靠口头约束（CON-06）。
 */
let nonAsciiAssets = 0;
/** 全文件 walker（walk() 只收代码扩展名，图片/字体等资源收不到）。 */
function walkAll(dir, out = []) {
    let items = [];
    try { items = readdirSync(dir); } catch { return out; }
    items.forEach((name) => {
        if (["node_modules", "dist", ".git", "vendor", "新建文件夹"].includes(name)) return;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walkAll(full, out);
        else out.push(full);
    });
    return out;
}
["assets", "mods"].forEach((top) => {
    walkAll(resolvePath(REPO, top)).forEach((file) => {
        const rel = posix(relative(REPO, file));
        const segs = rel.split("/");
        if (segs.some((seg) => /[^\x00-\x7F]/.test(seg))) {
            nonAsciiAssets += 1;
            problems.push(`${rel}：资源路径含非 ASCII 字符（SW 百分号编码链路风险点），改名为 ASCII`);
        }
    });
});
info.push(`资源名 ASCII 扫描：${nonAsciiAssets} 处违规`);

// ── 11 scss → css 漂移 ────────────────────────────────────────────────────
/**
 * 规则：assets/stylesheets 下同名的 .scss 不得比 .css 新。
 * 编译器与编译命令未入库（GEN-02），改 scss 忘重编译时浏览器加载的是旧 css，
 * 表现为「改了不生效」，diff 也看不出来。
 */
let scssDrift = 0;
walkAll(resolvePath(REPO, "assets", "stylesheets")).filter((f) => f.endsWith(".scss")).forEach((scss) => {
    const css = scss.replace(/\.scss$/, ".css");
    if (!existsSync(css)) return; // 无同名产物（如只被其它 scss import 的 partial）不参与
    if (statSync(scss).mtimeMs > statSync(css).mtimeMs) {
        scssDrift += 1;
        problems.push(`${posix(relative(REPO, scss))}：scss 新于同名 css 产物，需重新编译（漂移会让「改了不生效」）`);
    }
});
info.push(`scss→css 漂移：${scssDrift} 对`);

// ── 12 文档版本与 version.js 对齐（CON-02 回归门禁）────────────────────────
/**
 * 规则：devdocs 自述「以 version.js 的 VERSION 常量为准」，所以每次发版后
 * 页脚 data-version、README 适用版本、API 示例与 changelog 首段必须同步。
 * 人工每版对一次迟早漏（CON-02 就是这么漂移的），这里当成机器门禁。
 */
const versionText = readFileSync(join(REPO, "src/javascripts/version.js"), "utf8");
const VERSION = (versionText.match(/const VERSION\s*=\s*["']([^"']+)["']/) || [])[1] || "";
if (!VERSION) {
    problems.push("src/javascripts/version.js：找不到 VERSION 常量，文档版本门禁无法判定");
} else {
    let docPages = 0;
    walk(resolvePath(REPO, "devdocs")).filter((f) => f.endsWith(".html")).forEach((file) => {
        const matches = [...readFileSync(file, "utf8").matchAll(/data-version="([^"]*)"/g)];
        if (!matches.length) return; // 片段模板（templates/index.html）不是成页
        docPages += 1;
        matches.forEach((m) => {
            if (m[1] !== VERSION) problems.push(`${posix(relative(REPO, file))}：data-version="${m[1]}" 与 version.js 的 ${VERSION} 不一致`);
        });
    });
    const readme = resolvePath(REPO, "devdocs", "README.md");
    const readmeVer = existsSync(readme) && (readFileSync(readme, "utf8").match(/适用版本：([0-9]+\.[0-9]+\.[0-9]+)/) || [])[1];
    if (!readmeVer) problems.push("devdocs/README.md：找不到「适用版本：X.Y.Z」声明");
    else if (readmeVer !== VERSION) problems.push(`devdocs/README.md：适用版本 ${readmeVer} 与 version.js 的 ${VERSION} 不一致`);
    const changelog = resolvePath(REPO, "devdocs", "reference", "changelog.html");
    const changelogVer = existsSync(changelog) && (readFileSync(changelog, "utf8").match(/<h2>v([0-9]+\.[0-9]+\.[0-9]+)/) || [])[1];
    if (!changelogVer) problems.push("devdocs/reference/changelog.html：找不到版本摘要条目");
    else if (changelogVer !== VERSION) problems.push(`devdocs/reference/changelog.html：最新条目 v${changelogVer} 与 version.js 的 ${VERSION} 不一致`);
    const deskly = resolvePath(REPO, "devdocs", "api", "deskly.html");
    const desklyLine = existsSync(deskly) ? readFileSync(deskly, "utf8").split("\n").find((l) => l.includes("meta.version")) || "" : "";
    const desklyVer = (desklyLine.match(/"([0-9]+\.[0-9]+\.[0-9]+)"/) || [])[1];
    if (!desklyVer) problems.push("devdocs/api/deskly.html：meta.version 示例缺 X.Y.Z 版本串");
    else if (desklyVer !== VERSION) problems.push(`devdocs/api/deskly.html：meta.version 示例 ${desklyVer} 与 version.js 的 ${VERSION} 不一致`);
    info.push(`文档版本对齐：${docPages} 页 data-version + README / changelog / deskly 示例均对照 ${VERSION}`);
}

// ── 12b 会随代码增长的计数：文档写死就必须与代码事实源一致 ───────────────
/**
 * 「13 个内置插件」漂成 14 个的教训：枚举型数字不进代码就必然再漂。
 * 规则：数字必须等于事实源（BUILTIN_IDS / src/javascripts/*.js / PERMISSION_NAMES），
 * 要么干脆不写数字、只指向事实源。这里只拦「写死了但对不上」的情况。
 */
const pluginManagerText = readFileSync(join(REPO, "src/javascripts/plugin-manager.js"), "utf8");
const builtinBlock = (pluginManagerText.match(/const BUILTIN_IDS = \[([\s\S]*?)\];/) || [])[1] || "";
const BUILTIN_COUNT = (builtinBlock.match(/"[^"]+"/g) || []).length;
const TOP_MODULE_COUNT = readdirSync(join(REPO, "src/javascripts")).filter((f) => f.endsWith(".js")).length;
const grantsText = readFileSync(join(REPO, "src/javascripts/api-grants.js"), "utf8");
const permissionBlock = (grantsText.match(/const PERMISSION_NAMES = \[([\s\S]*?)\];/) || [])[1] || "";
const PERMISSION_COUNT = (permissionBlock.match(/"[^"]+"/g) || []).length;
const countDocs = [...new Set([
    ...walk(resolvePath(REPO, "devdocs")).filter((f) => f.endsWith(".html") || f.endsWith(".md")),
    resolvePath(REPO, "devdocs", "README.md"),
])];
const countRules = [
    { re: /(\d+)\s*个内置(?:插件|mod)/g, actual: BUILTIN_COUNT, what: "内置插件数", hint: "不要写死，指向 plugin-manager.js 的 BUILTIN_IDS" },
    { re: /BUILTIN_IDS\s*(?:共|有)?\s*(\d+)\s*个/g, actual: BUILTIN_COUNT, what: "内置插件数", hint: "同上" },
    { re: /(\d+)\s*个顶层模块/g, actual: TOP_MODULE_COUNT, what: "顶层模块数", hint: "以 src/javascripts/*.js 实测为准" },
    { re: /(\d+)\s*条权限名/g, actual: PERMISSION_COUNT, what: "权限条数", hint: "以 api-grants.js 的 PERMISSION_NAMES 为准" },
];
let countClaims = 0;
countDocs.forEach((file) => {
    const text = readFileSync(file, "utf8");
    countRules.forEach((rule) => {
        [...text.matchAll(rule.re)].forEach((m) => {
            countClaims += 1;
            if (Number(m[1]) !== rule.actual) problems.push(`${posix(relative(REPO, file))}：写着 ${m[1]}（${rule.what}），代码事实源是 ${rule.actual}——${rule.hint}`);
        });
    });
});
info.push(`计数门禁：内置插件 ${BUILTIN_COUNT} / 顶层模块 ${TOP_MODULE_COUNT} / 权限名 ${PERMISSION_COUNT}；文档中写死的 ${countClaims} 处计数已比对`);

// ── 13 首帧门控（FOUC）：样式/内容就绪前不得显示 ──────────────────────────
/**
 * 两类中间态都在真机上被看到过：
 * 1) 应用窗口插入 DOM 后先按无样式块级流画一帧（没亚克力、元素乱堆），CSS 到了才正常；
 * 2) 系统设置切面板先清空宿主，await import 期间露出空白面板区。
 * 这里守住三条结构不变量；亚克力与观感本身仍需真机确认：
 * - 开窗兜底不得短于冷加载（否则插件入口脚本求值前就会显示骨架）；
 * - 旧式 App 注入 app-css 后必须等 sheet 就绪再 revealOpen；
 * - 设置面板的宿主清空与挂载新节点必须在同一个同步任务里，且晚于 await import。
 */
const lifecycleText = readFileSync(join(REPO, "src/javascripts/wm/lifecycle.js"), "utf8");
const fallbackMs = Number((lifecycleText.match(/const OPEN_REVEAL_FALLBACK_MS\s*=\s*(\d+)/) || [])[1]);
if (!Number.isFinite(fallbackMs)) {
    problems.push("wm/lifecycle.js：找不到 OPEN_REVEAL_FALLBACK_MS，首帧门控失守");
} else if (fallbackMs < 1000) {
    problems.push(`wm/lifecycle.js：开窗兜底 ${fallbackMs}ms 太短，冷加载会在插件初始化前显示骨架（应 ≥1000ms）`);
}

const windowJsText = readFileSync(join(REPO, "src/javascripts/window.js"), "utf8");
const styleWaitAt = windowJsText.indexOf("whenStyleReady(link)");
const legacyRevealAt = windowJsText.indexOf("wm.revealOpen(newWin)");
if (styleWaitAt < 0) {
    problems.push("window.js：旧式 App 路径没有等待 app-css 就绪（会把无样式首帧画出来）");
} else if (legacyRevealAt < styleWaitAt) {
    problems.push("window.js：旧式 App 在 app-css 就绪前就 revealOpen，首帧是无样式布局");
}

const settingsAppText = readFileSync(join(settingsDir, "app.js"), "utf8");
const selStart = settingsAppText.indexOf("async function selectPane");
const selEnd = settingsAppText.indexOf("\nfunction ", selStart + 1);
const selBody = selStart >= 0 ? settingsAppText.slice(selStart, selEnd > 0 ? selEnd : undefined) : "";
if (!selBody) {
    problems.push("system-settings/app.js：找不到 selectPane，面板切换时序无法校验");
} else {
    const importAt = selBody.indexOf("await import(");
    const clearAt = selBody.indexOf('shell.host.textContent = ""');
    const appendAt = selBody.indexOf("shell.host.append(node)");
    if (importAt < 0 || clearAt < 0 || appendAt < 0) {
        problems.push("system-settings/app.js：selectPane 结构变了，面板切换时序校验失效（需同步更新本检查）");
    } else {
        if (!selBody.includes("releasePane(true)")) {
            problems.push("system-settings/app.js：切面板没有保留旧面板画面（缺少 releasePane(true)），await import 期间会露出空白");
        }
        if (clearAt < importAt) {
            problems.push("system-settings/app.js：await import 之前就清空了面板宿主 → 会先闪一帧空白");
        }
        if (appendAt < clearAt) {
            problems.push("system-settings/app.js：先挂载新面板再清空宿主，新内容会被自己清掉");
        }
        if (/\bawait\b/.test(selBody.slice(clearAt, appendAt))) {
            problems.push("system-settings/app.js：清空宿主与挂载新面板之间有 await → 中间存在绘制机会");
        }
    }
}
info.push("首帧门控：开窗兜底 ≥1000ms、旧式 App 等 app-css、设置面板同步交换 ✓");

// ── 输出 ─────────────────────────────────────────────────────────────────
info.forEach((i) => console.log(`  · ${i}`));
if (problems.length) {
    console.log(`\n发现 ${problems.length} 个问题：`);
    [...new Set(problems)].forEach((p) => console.log("  ✗ " + p));
    process.exit(1);
}
console.log("\n静态一致性检查通过 ✓");
