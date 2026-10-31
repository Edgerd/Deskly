/**
 * dev/static-check.mjs — 跨模块静态一致性检查（磁盘即权威）
 *
 * 为什么需要它：本项目无构建步骤、无打包器，浏览器又是唯一的运行时，
 * 而浏览器实测在这里有两个已知坑 —— 模块 URL 带 `?v=Date.now()` 会绕过缓存但也让
 * 「刷新后是否持久」难以断言，扩展页在 http 下视口还会读成 0×0。
 * 所以能在磁盘上查出来的错，就该在这里查出来，而不是等肉眼在浏览器里撞：
 *   1 import 说明符指向的文件不存在（插件重写最常见的静默失效）
 *   2 import 说明符或 <script src> 上挂了 `?v=`（会把内核模块求值两次）
 *   3 JS/HTML 里引用的 assets 资源路径实际不存在（404）
 *   4 四个语言包键位不齐，或 data-i18n 指向不存在的键
 *   5 插件面板的 paneId / 自带语言包与 registry.js 对不上，或四语键位不齐
 *   6 manifest.json 声明的资源在插件目录里不存在
 *
 * 用法：`node dev/static-check.mjs`（有问题退出码 1 并逐条列出）
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolvePath(import.meta.url.replace(/^file:\/\/\/?/, ""), "..", "..");
const REPO = process.cwd().replace(/\\/g, "/");

/** 递归收集源码文件（跳过 vendor 与打包产物）。 */
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

/** 把说明符解析成磁盘路径；bare/URL 说明符跳过。 */
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
/** 站内根相对路径（./assets/…、./mods/…）以仓库根为基准判定。 */
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
/** 把嵌套语言包压成点分键列表。 */
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
 * 规则（0.2.90 起）：设置面板的文案是给用户看的，不是给工程师看的。
 *  A. 提示行（hint）默认不该存在；确实要留的必须是一句、≤18 字、且不出现实现词
 *     （系统 / 令牌 / 像素 / 静态检查 / 设置中枢 / 面板 / 卡片 / 归档 / 广播 / 事件 / 槽 / schema / console / json / IndexedDB / 插件）。
 *     这类句子写的是「不写就会误解的后果」，不是「这东西怎么工作」。
 *  B. 标题（label）≤12 字、不以句读结尾、不带引号堆叠 —— 开关的标题写被打开的东西本身。
 *  扫描范围：内核的两份定义（settings-definitions.js / surface.js）+ 全部面板模块 + registry。
 */
/**
 * 扫描范围：内核里所有会 `settings.define` 的模块（面板的行标题/提示很多直接取自定义，
 * 只扫 settings-definitions.js 会漏掉 controlcenter / display / lock 这些自注册模块）
 * + 系统设置插件的 registry 与全部面板模块。
 * 排除 api-grants.js：它的 {label, hint} 是**授权弹窗正文**，要写清楚「谁要做什么」，
 * 不适用设置行的短句口径。
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

// ── 输出 ─────────────────────────────────────────────────────────────────
info.forEach((i) => console.log(`  · ${i}`));
if (problems.length) {
    console.log(`\n发现 ${problems.length} 个问题：`);
    [...new Set(problems)].forEach((p) => console.log("  ✗ " + p));
    process.exit(1);
}
console.log("\n静态一致性检查通过 ✓");
