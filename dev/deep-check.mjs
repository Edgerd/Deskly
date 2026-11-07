/**
 * dev/deep-check.mjs — 深度静态审计（磁盘即权威，浏览器不参与）。
 * 补 static-check.mjs 不看、却最常整模块崩溃的两类：具名导入与导出对不上（白屏）、成员访问不存在（点了没反应）。
 * 所有判定跑在掩码后的源码上（注释/字符串/模板串/正则挖空成等长空格），避免字符串内容被误读成代码造成假警报。
 *   A 语法门　B/C 具名与默认导入对导出　D 对象字面量/静态类成员存在性　E 未声明名字调用　F eval/new Function/document.write/条件赋值
 * 用法：node --experimental-vm-modules dev/deep-check.mjs
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, resolve as resolvePath } from "node:path";
import vm from "node:vm";

const REPO = process.cwd().replace(/\\/g, "/");
const posix = (p) => String(p).replace(/\\/g, "/");
const rel = (p) => posix(relative(REPO, p));
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "vendor", "新建文件夹"]);

function walk(dir, out = []) {
    let items = [];
    try { items = readdirSync(dir); } catch { return out; }
    items.forEach((name) => {
        if (SKIP_DIRS.has(name)) return;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (/\.(js|mjs)$/.test(name)) out.push(full);
    });
    return out;
}

const jsFiles = walk(resolvePath(REPO, "src")).concat(walk(resolvePath(REPO, "mods")));

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`✗ ${where} — ${msg}`);
const warn = (where, msg) => warnings.push(`! ${where} — ${msg}`);

// ── 源码掩码：注释/字符串/模板串/正则字面量 → 空格（长度不变，行号不变） ──────
const GLOBALS = new Set([
    "Object", "Array", "String", "Number", "Boolean", "JSON", "Math", "Date", "RegExp", "Map", "Set",
    "WeakMap", "WeakSet", "Promise", "Symbol", "Proxy", "Reflect", "BigInt", "Error", "TypeError",
    "RangeError", "SyntaxError", "URIError", "EvalError", "Function", "isNaN", "isFinite", "parseInt",
    "parseFloat", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "structuredClone",
    "setTimeout", "setInterval", "clearTimeout", "clearInterval", "requestAnimationFrame", "queueMicrotask",
    "cancelAnimationFrame", "addEventListener", "removeEventListener", "fetch", "console", "alert", "confirm",
    "prompt", "localStorage", "sessionStorage", "indexedDB", "document", "window", "navigator", "location",
    "history", "screen", "performance", "URL", "URLSearchParams", "Blob", "File", "FileReader", "FileList",
    "FormData", "Headers", "Request", "Response", "AbortController", "AbortSignal", "TextEncoder",
    "TextDecoder", "Image", "Audio", "Option", "Worker", "ServiceWorker", "caches", "crypto", "matchMedia",
    "getComputedStyle", "elementFromPoint", "customElements", "MutationObserver", "IntersectionObserver",
    "ResizeObserver", "Intl", "Infinity", "NaN", "undefined", "null", "true", "false", "this", "arguments",
    "globalThis", "module", "exports", "require", "process", "import", "export", "new", "typeof", "instanceof",
    "void", "delete", "return", "throw", "try", "catch", "finally", "if", "else", "for", "while", "do",
    "switch", "case", "default", "break", "continue", "function", "class", "extends", "super", "let", "const",
    "var", "async", "await", "yield", "of", "in", "from", "as", "static", "get", "set", "node", "item",
    "items", "length", "name", "test", "exec", "call", "apply", "bind", "includes", "indexOf", "slice",
    "split", "join", "map", "filter", "reduce", "forEach", "find", "findIndex", "some", "every", "sort",
    "reverse", "concat", "push", "pop", "shift", "unshift", "splice", "keys", "values", "entries", "assign",
    "create", "defineProperty", "freeze", "stringify", "parse", "round", "floor", "ceil", "abs", "min", "max",
    "random", "pow", "sqrt", "sign", "trunc", "hypot", "now", "toISOString", "getTime", "Date", "WeakRef",
    "CSS", "Path2D", "DOMParser", "XMLSerializer", "Text", "Comment", "Node", "Element", "HTMLElement",
    "KeyboardEvent", "MouseEvent", "PointerEvent", "DragEvent", "ClipboardEvent", "CustomEvent", "Event",
    "EventTarget", "MutationObserver", "DataTransfer", "DataTransferItem", "Notification", "ServiceWorkerRegistration",
    "IDBDatabase", "IDBTransaction", "IDBRequest", "IDBCursor", "DOMRect", "DOMMatrix", "matchAll", "at",
    "Uint8Array", "Uint8ClampedArray", "Int8Array", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
    "Float32Array", "Float64Array", "BigUint64Array", "BigInt64Array", "ArrayBuffer", "SharedArrayBuffer", "DataView",
    "atob", "btoa", "requestIdleCallback", "cancelIdleCallback", "createImageBitmap", "offscreenCanvas",
    "ImageBitmap", "ImageBitmapRenderingContext", "CanvasRenderingContext2D", "WebGLRenderingContext",
    "WebSocket", "BroadcastChannel", "MessageChannel", "MessagePort", "Worker", "SharedWorker", "crypto",
    "structuredClone", "CompressionStream", "DecompressionStream", "Gzip", "DOMException", "CountQueuingStrategy",
    "ReadableStream", "WritableStream", "TransformStream", "ByteLengthQueuingStrategy", "TextEncoderStream",
    "trim", "trimStart", "trimEnd", "padStart", "padEnd", "replace", "replaceAll", "match", "search", "charCodeAt",
    "startsWith", "endsWith", "localeCompare", "toLowerCase", "toUpperCase", "repeat", "toString", "valueOf",
    "hasOwnProperty", "isArray", "of", "flat", "flatMap", "fill", "at", "copyWithin", "fromEntries", "with",
    "toSorted", "toReversed", "toSpliced", "groupBy", "aggregate", "finally", "all", "race", "allSettled",
    "any", "resolve", "reject", "normalize", "codePointAt", "fromCharCode", "fromCodePoint",
]);

function mask(src, keepStrings = false) {
    const out = src.split("");
    const blank = (from, to) => {
        for (let i = from; i < Math.min(to, out.length); i++) if (out[i] !== "\n") out[i] = " ";
    };
    let i = 0;
    const templateStack = [];
    let prevCode = "";
    while (i < src.length) {
        const c = src[i];
        const c2 = src[i + 1];
        if (c === "/" && c2 === "/") {
            let j = i + 2;
            while (j < src.length && src[j] !== "\n") j++;
            blank(i, j); i = j; continue;
        }
        if (c === "/" && c2 === "*") {
            let j = i + 2;
            while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
            blank(i, Math.min(j + 2, src.length)); i = j + 2; continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1;
            let closed = false;
            while (j < src.length) {
                if (src[j] === "\\") { j += 2; continue; }
                if (src[j] === c) { closed = true; break; }
                if (src[j] === "\n") break;
                j++;
            }
            if (!keepStrings) blank(i + 1, closed ? j : j + 1);
            i = closed ? j + 1 : j;
            prevCode = "s"; continue;
        }
        if (c === "`") {
            let j = i + 1;
            while (j < src.length) {
                if (src[j] === "\\") { j += 2; continue; }
                if (src[j] === "`") { j++; break; }
                if (src[j] === "$" && src[j + 1] === "{") {
                    blank(i, j);
                    templateStack.push(j);
                    i = j + 1; prevCode = "{";
                    j = -1; break;
                }
                j++;
            }
            if (j >= 0) { blank(i, j); prevCode = "s"; i = j; continue; }
            continue;
        }
        if (c === "}" && templateStack.length) {
            // 模板串 ${...} 结束，回到模板文本
            templateStack.pop();
            let j = i + 1;
            while (j < src.length) {
                if (src[j] === "\\") { j += 2; continue; }
                if (src[j] === "`") { j++; break; }
                if (src[j] === "$" && src[j + 1] === "{") { blank(i + 1, j); templateStack.push(j); i = j + 1; prevCode = "{"; j = -1; break; }
                j++;
            }
            if (j >= 0) { blank(i + 1, j); prevCode = "s"; i = j; continue; }
            continue;
        }
        if (c === "/" && /[({[,;:=!&|?+\-*%~^<>\n]\s*$/.test(src.slice(Math.max(0, i - 3), i)) ) {
            // 正则字面量：前面是运算符/括号才可能是 regex
            let j = i + 1, inClass = false, ok = false;
            while (j < src.length && src[j] !== "\n") {
                if (src[j] === "\\") { j += 2; continue; }
                if (src[j] === "[") inClass = true;
                else if (src[j] === "]") inClass = false;
                else if (src[j] === "/" && !inClass) { ok = true; break; }
                j++;
            }
            if (ok) { let k = j + 1; while (k < src.length && /[a-z]/.test(src[k])) k++; blank(i, k); prevCode = "s"; i = k; continue; }
        }
        if (!/\s/.test(c)) prevCode = c;
        i++;
    }
    return out.join("");
}

// ── A 语法门 ───────────────────────────────────────────────────────────────
const sources = new Map();
const masked = new Map();
const codeViews = new Map();
jsFiles.forEach((file) => {
    const src = readFileSync(file, "utf8");
    sources.set(file, src);
    masked.set(file, mask(src));
    codeViews.set(file, mask(src, true));
    try {
        new vm.SourceTextModule(src, { identifier: posix(file) });
    } catch (e) {
        if (/SourceTextModule is not a constructor/.test(String(e))) {
            console.error("harness 需要 `node --experimental-vm-modules`");
            process.exit(2);
        }
        err(rel(file), `语法/模块解析失败：${String(e.message).split("\n")[0]}`);
    }
});

// ── 导出符号表（跑在掩码源码上） ─────────────────────────────────────────────
function balancedBraces(src, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(openIndex + 1, i); }
    }
    return null;
}
function depthAt(body) {
    const d = new Array(body.length);
    let cur = 0;
    for (let i = 0; i < body.length; i++) {
        if (body[i] === "{") { d[i] = cur; cur++; continue; }
        if (body[i] === "}") { cur--; d[i] = cur; continue; }
        d[i] = cur;
    }
    return (at) => d[Math.max(0, Math.min(at, d.length - 1))] ?? 0;
}

function analyzeExports(file) {
    const src = masked.get(file) ?? mask(readFileSync(file, "utf8"));
    const names = new Set();
    let hasDefault = false;
    const stars = [];
    let m;
    const funRe = /(?:^|\n)\s*export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g;
    while ((m = funRe.exec(src))) names.add(m[1]);
    const clsRe = /(?:^|\n)\s*export\s+class\s+([A-Za-z_$][\w$]*)/g;
    while ((m = clsRe.exec(src))) names.add(m[1]);
    const declRe = /(?:^|\n)\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
    while ((m = declRe.exec(src))) names.add(m[1]);
    const listRe = /(?:^|\n)\s*export\s*\{([^}]*)\}(?!\s*from)/g;
    while ((m = listRe.exec(src))) {
        m[1].split(",").forEach((raw) => {
            const parts = raw.trim().split(/\s+as\s+/);
            const outName = (parts[1] || parts[0]).trim();
            if (/^[A-Za-z_$][\w$]*$/.test(outName)) names.add(outName);
        });
    }
    const reExportRe = /export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g; // 掩码后字符串已空 → 另行处理
    if (/export\s+default\b/.test(src)) hasDefault = true;
    // 原始源码里补 default / export {} from / export * from（需要字符串内容）
    const raw = sources.get(file) ?? readFileSync(file, "utf8");
    let rm;
    const rawReExport = /export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
    while ((rm = rawReExport.exec(raw))) {
        rm[1].split(",").forEach((piece) => {
            const parts = piece.trim().split(/\s+as\s+/);
            const outName = (parts[1] || parts[0]).trim();
            if (/^[A-Za-z_$][\w$]*$/.test(outName)) names.add(outName);
        });
    }
    const rawStar = /export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*))?\s*from\s*["']([^"']+)["']/g;
    while ((rm = rawStar.exec(raw))) { stars.push(rm[2]); if (rm[1]) names.add(rm[1]); }
    // 对象字面量导出的成员（一层）
    const members = new Map();
    const objRe = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
    while ((m = objRe.exec(src))) {
        const open = src.indexOf("{", m.index + m[0].length - 1);
        const body = balancedBraces(src, open);
        if (body == null) continue;
        const at = depthAt(body);
        const keys = new Set();
        const keyRe = /([{},;])\s*(?:(async|get|set|\*)\s+)?([A-Za-z_$][\w$]*)\s*(?::|\()/g;
        let k;
        while ((k = keyRe.exec(body))) {
            if (at(k.index) !== 0) continue;
            const key = k[3];
            if (["if", "for", "while", "switch", "return", "catch", "function", "else", "do", "try"].includes(key)) continue;
            keys.add(key);
        }
        const firstKeyRe = /^\s*(?:(async|get|set|\*)\s+)?([A-Za-z_$][\w$]*)\s*(?::|\()/;
        const fk = body.match(firstKeyRe);
        if (fk) keys.add(fk[2]);
        if (keys.size) members.set(m[1], keys);
        // 也登记 `export const X = { ... }` 里的 X
        if (keys.size) names.add(m[1]);
    }
    // 类的静态成员
    const statClsRe = /(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)[^{;]*\{/g;
    while ((m = statClsRe.exec(src))) {
        const open = src.indexOf("{", m.index + m[0].length - 1);
        const body = balancedBraces(src, open);
        if (body == null) continue;
        const keys = new Set();
        let s;
        const stRe = /(?:^|\n)\s*static\s+(?:async\s+|get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|=|;)/g;
        while ((s = stRe.exec(body))) keys.add(s[1]);
        const instRe = /(?:^|\n)\s{2,}(?:async\s+|get\s+|set\s+|\*\s*)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
        while ((s = instRe.exec(body))) keys.add(s[1]);
        const fldRe = /(?:^|\n)\s{2,}([A-Za-z_$][\w$]*)\s*=/g;
        while ((s = fldRe.exec(body))) keys.add(s[1]);
        if (keys.size) members.set(m[1], keys);
    }
    return { names, hasDefault, stars, members, isModule: /(?:^|\n)\s*(?:import|export)\s/.test(src) };
}

const exportMap = new Map();
jsFiles.forEach((f) => exportMap.set(f, analyzeExports(f)));

function resolveSpecifier(spec, fromFile) {
    if (!spec.startsWith(".")) return null;
    const clean = spec.split("?")[0].split("#")[0];
    const base = resolvePath(dirname(fromFile), clean);
    if (existsSync(base) && statSync(base).isFile()) return base;
    for (const ext of [".js", ".mjs", ".json"]) if (existsSync(base + ext)) return base + ext;
    for (const idx of ["/index.js", "/index.mjs"]) if (existsSync(base + idx)) return base + idx;
    return null;
}

const IMPORT_CLAUSE_RE = /(?:^|\n)\s*import\s+([^;]*?)\s*from\s*["']([^"']+)["']/g;

// ── B/C 具名导入 ───────────────────────────────────────────────────────────
let importCount = 0;
jsFiles.forEach((file) => {
    const src = codeViews.get(file);
    const raw = sources.get(file);
    let m;
    IMPORT_CLAUSE_RE.lastIndex = 0;
    const seen = new Set();
    while ((m = IMPORT_CLAUSE_RE.exec(src))) {
        const clause = m[1].trim();
        // codeView 保留了字符串内容，跨行 import 的说明符可直接取 m[2]
        // （早先回 raw 按行找 from，m.index 落在被消费的换行上 → 具名校验实际没覆盖，等于没检查）。
        const spec = m[2];
        if (!spec) continue;
        if (seen.has(m.index)) continue;
        seen.add(m.index);
        importCount++;
        if (/^\.\.?\//.test(spec) && /\?v=/.test(spec)) err(rel(file), `相对导入带 ?v=，会把内核模块求值两次：${spec}`);
        const target = resolveSpecifier(spec, file);
        if (!target) {
            if (/^\.\.?\//.test(spec)) err(rel(file), `import 指向不存在的文件：${spec}`);
            continue;
        }
        const info = exportMap.get(target) || analyzeExports(target);
        if (info.stars.length) continue;   // 再导出：静态不可判定，保守跳过
        if (!info.isModule) continue;      // 经典脚本非模块
        let named = [];
        let wantsDefault = false;
        const braceMatch = clause.match(/\{([\s\S]*)\}/);
        if (braceMatch) {
            named = braceMatch[1].split(",").map((s) => s.trim()).filter(Boolean)
                .map((s) => s.split(/\s+as\s+/)[0].trim()).filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
        }
        const head = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim();
        if (head && !head.startsWith("*") && /^[A-Za-z_$][\w$]*$/.test(head)) wantsDefault = true;
        if (wantsDefault && !info.hasDefault) err(rel(file), `默认导入，但 ${rel(target)} 没有 default 导出：${spec}`);
        named.forEach((name) => {
            if (name === "default") { if (!info.hasDefault) err(rel(file), `import { default } 但 ${rel(target)} 无 default`); return; }
            if (!info.names.has(name) && !info.members.has(name)) {
                err(rel(file), `${rel(target)} 并未导出「${name}」→ 模块加载时抛 does-not-provide-an-export`);
            }
        });
    }
});

// ── D 成员存在性（只看调用点，且绑定必须是本文件导入进来的对象/类） ──────────
jsFiles.forEach((file) => {
    const src = codeViews.get(file);
    const raw = sources.get(file);
    const bindings = [];
    let m;
    IMPORT_CLAUSE_RE.lastIndex = 0;
    while ((m = IMPORT_CLAUSE_RE.exec(src))) {
        const clause = m[1].trim();
        const lineStart = raw.lastIndexOf("\n", m.index) + 1;
        const lineEnd = raw.indexOf("\n", m.index);
        const rawLine = raw.slice(lineStart, lineEnd === -1 ? raw.length : lineEnd);
        const specMatch = rawLine.match(/from\s*["']([^"']+)["']/);
        if (!specMatch) continue;
        const target = resolveSpecifier(specMatch[1], file);
        if (!target) continue;
        const info = exportMap.get(target);
        if (!info) continue;
        const braceMatch = clause.match(/\{([\s\S]*)\}/);
        if (!braceMatch) continue;
        braceMatch[1].split(",").map((s) => s.trim()).filter(Boolean).forEach((piece) => {
            const parts = piece.split(/\s+as\s+/);
            const orig = parts[0].trim();
            const local = (parts[1] || parts[0]).trim();
            if (info.members.has(orig) && /^[A-Za-z_$][\w$]*$/.test(local)) bindings.push({ local, members: info.members.get(orig), from: rel(target) });
        });
    }
    bindings.forEach(({ local, members, from }) => {
        const re = new RegExp(`\\b${local.replace(/\$/g, "\\$")}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, "g");
        let u;
        while ((u = re.exec(src))) {
            const prop = u[1];
            if (members.has(prop)) continue;
            if (["call", "apply", "bind", "toString", "valueOf", "then"].includes(prop)) continue;
            const lineNo = src.slice(0, u.index).split("\n").length;
            warn(`${rel(file)}:${lineNo}`, `${local}.${prop}() 在 ${from} 里找不到对应成员（该模块可见成员：${[...members].slice(0, 14).join(", ")}）`);
        }
    });
});

// ── E 调用了未声明 / 未导入 / 非全局的名字 ───────────────────────────────────
// 关键是把「绑定位置」收干净：解构参数、解构赋值、方法简写、catch 形参、
// window.X = 挂上去的全局。不收全会造出几百条假警报，检查器就废了。
function findClose(src, openIdx, openCh, closeCh) {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        if (src[i] === openCh) depth++;
        else if (src[i] === closeCh) { depth--; if (depth === 0) return i; }
    }
    return -1;
}
function collectPattern(text, set) {
    let i = 0;
    const parts = [];
    while (i < text.length) {
        const c = text[i];
        // 先吞掉空白：否则 `root, { a, b }` 里的解构体会被当成一个叶子片段整块丢掉
        if (/\s/.test(c)) { i++; continue; }
        if (c === "{" || c === "[") {
            const close = findClose(text, i, c, c === "{" ? "}" : "]");
            if (close === -1) { i++; continue; }
            parts.push({ kind: "nested", body: text.slice(i + 1, close) });
            i = close + 1; continue;
        }
        if (c === "(") { const close = findClose(text, i, "(", ")"); i = close === -1 ? i + 1 : close + 1; continue; }
        let j = i, depth = 0;
        while (j < text.length) {
            const d = text[j];
            if (d === "{" || d === "[" ) depth++;
            else if (d === "}" || d === "]") depth--;
            else if (d === "," && depth === 0) break;
            j++;
        }
        parts.push({ kind: "leaf", body: text.slice(i, j) });
        i = j + 1;
    }
    parts.forEach((p) => {
        if (p.kind === "nested") { collectPattern(p.body, set); return; }
        let leaf = p.body.trim();
        if (!leaf) return;
        leaf = leaf.split("=")[0].trim();            // 去默认值
        leaf = leaf.replace(/^\.\.\./, "").trim();   // 去 rest
        if (!leaf) return;
        if (leaf.includes(":")) {                    // key: binding
            const binding = leaf.split(":").pop().trim();
            if (/^[A-Za-z_$][\w$]*$/.test(binding)) { set.add(binding); return; }
            if (/^[{[]/.test(binding)) { collectPattern(binding.slice(1), set); return; }
        }
        if (/^[A-Za-z_$][\w$]*$/.test(leaf)) set.add(leaf);
    });
}
function harvestBindings(src) {
    const declared = new Set();
    let m;
    // function 声明（含匿名）与它自己的名字
    const fnRe = /(?:^|[^.\w$])function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/g;
    while ((m = fnRe.exec(src))) {
        if (m[1]) declared.add(m[1]);
        const open = src.indexOf("(", m.index + m[0].length - 1);
        const close = findClose(src, open, "(", ")");
        if (close !== -1) collectPattern(src.slice(open + 1, close), declared);
    }
    const classRe = /(?:^|[^.\w$])class\s+([A-Za-z_$][\w$]*)/g;
    while ((m = classRe.exec(src))) declared.add(m[1]);
    // var/let/const 声明与解构
    const declRe = /(?:^|[^.\w$])(?:const|let|var)\s*/g;
    while ((m = declRe.exec(src))) {
        let at = m.index + m[0].length;
        // `let a = null, b = null, c = null;` 这种多声明子句必须逐个收到 binding：
        // 早先只取第一个名字，于是 onContextMenu 这类被误报成未声明。
        for (let guard = 0; at < src.length && guard < 40; guard++) {
            while (at < src.length && /\s/.test(src[at])) at++;
            const ch = src[at];
            if (ch === "{" || ch === "[") {
                const close = findClose(src, at, ch, ch === "{" ? "}" : "]");
                if (close === -1) break;
                collectPattern(src.slice(at + 1, close), declared);
                at = close + 1;
            } else {
                const idm = src.slice(at).match(/^([A-Za-z_$][\w$]*)/);
                if (!idm) break;
                declared.add(idm[1]);
                at += idm[1].length;
            }
            // 跳过初始化表达式，直到顶层 `,`（下一个子句）或 `;`（声明结束）
            let k = at, advanced = false;
            while (k < src.length) {
                const c = src[k];
                if (c === "{" || c === "[" || c === "(") {
                    const close = findClose(src, k, c, c === "{" ? "}" : c === "[" ? "]" : ")");
                    if (close === -1) { k = src.length; break; }
                    k = close + 1; advanced = true; continue;
                }
                if (c === ",") { at = k + 1; advanced = true; break; }
                if (c === ";" || c === "}") { at = k; advanced = true; break; }
                if (c === "\n" && !advanced) { at = k; advanced = true; break; }
                k++;
            }
            if (!advanced) break;
            if (src[at] === ";" || src[at] === "}") break;
        }
    }
    // 方法简写 name(...) {  与 箭头函数 (…) =>
    const arrowRe = /\(([^()]*)\)\s*=>/g;
    while ((m = arrowRe.exec(src))) collectPattern(m[1], declared);
    const arrowMultiRe = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*=>/g;
    while ((m = arrowMultiRe.exec(src))) declared.add(m[1]);
    // 方法简写 / 顶层具名函数体：name(...) { —— 参数表可能跨行、也可能含模板串里的括号，
    // 所以用配对扫描而不是 [^()]* 正则
    const methodRe = /(?:^|\n)[ \t]*(?:(?:static|async|get|set)[ \t]+|\*[ \t]*)*([A-Za-z_$][\w$]*)[ \t]*\(/g;
    while ((m = methodRe.exec(src))) {
        const open = src.indexOf("(", m.index + m[0].length - 1);
        const close = findClose(src, open, "(", ")");
        if (close === -1) continue;
        const gap = src.slice(close + 1).match(/^[ \t\n]*/)[0].length;
        if (src[close + 1 + gap] !== "{") continue;
        declared.add(m[1]);
        collectPattern(src.slice(open + 1, close), declared);
    }
    const catchRe = /catch\s*\(\s*([A-Za-z_$][\w$]*)/g;
    while ((m = catchRe.exec(src))) declared.add(m[1]);
    const impRe = /import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+([A-Za-z_$][\w$]*))?[^;\n]*from/g;
    while ((m = impRe.exec(src))) {
        if (m[1]) declared.add(m[1]);
        if (m[3]) declared.add(m[3]);
        if (m[2]) m[2].split(",").forEach((p) => { const q = p.split(/\s+as\s+/).pop().trim(); if (/^[A-Za-z_$][\w$]*$/.test(q)) declared.add(q); });
    }
    // 显式挂到 window / globalThis 上的全局
    const globRe = /(?:window|globalThis|self)\s*(?:\.\s*([A-Za-z_$][\w$]*)\s*=|\[\s*["']([^"']+)["']\s*\]\s*=)/g;
    while ((m = globRe.exec(src))) { if (m[1]) declared.add(m[1]); if (m[2]) declared.add(m[2]); }
    return declared;
}
const KEYWORD_NOISE = new Set(["return", "typeof", "await", "new", "if", "for", "while", "switch", "catch", "do", "else", "function", "yield", "delete", "void", "throw", "case", "in", "of", "super", "import", "export", "async", "get", "set", "static", "class", "const", "let", "var"]);
jsFiles.forEach((file) => {
    const src = masked.get(file);
    const declared = harvestBindings(src);
    const calls = new Map();
    const callRe = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = callRe.exec(src))) {
        const name = m[1];
        if (KEYWORD_NOISE.has(name) || declared.has(name) || GLOBALS.has(name)) continue;
        const lineNo = src.slice(0, m.index).split("\n").length;
        if (!calls.has(name)) calls.set(name, lineNo);
    }
    calls.forEach((lineNo, name) => {
        warn(`${rel(file)}:${lineNo}`, `调用了「${name}()」，但本文件没有任何声明/导入能解释它（疑似拼写错误或漏导入）`);
    });
});


// ── F 安全 / CSP / 逻辑陷阱 ────────────────────────────────────────────────
jsFiles.forEach((file) => {
    const src = masked.get(file);
    const lines = src.split("\n");
    lines.forEach((line, i) => {
        const at = `${rel(file)}:${i + 1}`;
        if (/\beval\s*\(/.test(line)) err(at, "eval() 违反 CSP");
        if (/new\s+Function\s*\(/.test(line)) err(at, "new Function() 违反 CSP");
        if (/document\.write\s*\(/.test(line)) err(at, "document.write 易注入且破坏解析");
        if (/=\s*[^=]\s*==/.test(line) === false && /\bif\s*\(\s*[A-Za-z_$][\w$.[\]]*\s*=\s*[^=]/.test(line)) err(at, "条件里用了单等号赋值（疑似笔误）");
    });
});

// ── 输出 ───────────────────────────────────────────────────────────────────
console.log(`  · 掩码并解析 ${jsFiles.length} 个 JS 模块，${importCount} 处 import`);
console.log(`  · 导出符号表覆盖 ${exportMap.size} 个模块`);
const byKind = {};
warnings.forEach((w) => { const k = (w.split("— ")[1] || w).slice(0, 24); byKind[k] = (byKind[k] || 0) + 1; });
if (warnings.length) {
    console.log(`\n提示 ${warnings.length} 条（需人工判定，不计失败）：`);
    warnings.forEach((w) => console.log(`  ${w}`));
}
if (errors.length) {
    console.log(`\n发现 ${errors.length} 个硬错误：`);
    errors.forEach((e) => console.log(`  ${e}`));
    process.exit(1);
} else {
    console.log(`\n深度静态审计通过 ✓（0 硬错误，${warnings.length} 条提示）`);
    process.exit(0);
}
