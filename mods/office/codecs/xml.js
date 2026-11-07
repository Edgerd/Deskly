/**
 * xml.js — 编解码层共享的迷你 XML 读写件（压缩包读写在同目录 `zip.js`）。
 * 编解码模块要同时能在浏览器和 Node 里跑（Node 侧做生成→回读结构校验），而 Node 没有
 * DOMParser / XMLSerializer；用正则硬拆容易在嵌套、命名空间与属性值里的 `>` 上翻车，
 * 故自带一个不求完备的子集解析器。
 */

/**
 * XML 转义：写入任何用户文本前必过这里。
 * @param {string} value 原文
 * @returns {string} 转义后的文本
 */
export function escapeXml(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        // XML 1.0 不允许的控制字符（制表/换行/回车以外）直接丢掉，
        // 否则生成的包会被 Word/Excel 判为损坏。
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/**
 * 迷你 XML 节点。
 * @typedef {Object} XmlNode
 * @property {string} name 标签名（含命名空间前缀，如 `w:p`）
 * @property {Object<string,string>} attrs 属性表
 * @property {XmlNode[]} children 子元素
 * @property {string} text 本节点及其后代的拼接文本（元素之间不插分隔符）
 * @property {number} depth 深度（调试用）
 */

const NAME_RE = /[A-Za-z_:][A-Za-z0-9_.:\-]*/;

/**
 * 解析一小段 XML 为节点树。只支持 OOXML 读取所需的子集：
 * 元素、属性、文本、自闭合、注释、CDATA、XML 声明与 DOCTYPE（后三类被忽略）。
 * 不校验良构性（我们只读自己或 Word/Excel 生成的包）。
 * @param {string} xml XML 文本
 * @returns {XmlNode|null} 根节点；无元素时返回 null
 */
export function parseXml(xml) {
    const src = String(xml || "");
    let i = 0;
    const root = { name: "#root", attrs: {}, children: [], text: "", depth: 0 };
    const stack = [root];
    const flushText = (raw) => {
        const top = stack[stack.length - 1];
        if (!top) return;
        top.text += decodeEntities(stripTags(raw));
    };

    while (i < src.length) {
        const lt = src.indexOf("<", i);
        if (lt === -1) { flushText(src.slice(i)); break; }
        if (lt > i) flushText(src.slice(i, lt));

        if (src.startsWith("<!--", lt)) {
            const end = src.indexOf("-->", lt);
            i = end === -1 ? src.length : end + 3;
            continue;
        }
        if (src.startsWith("<![CDATA[", lt)) {
            const end = src.indexOf("]]>", lt);
            const body = src.slice(lt + 9, end === -1 ? src.length : end);
            stack[stack.length - 1].text += body;
            i = end === -1 ? src.length : end + 3;
            continue;
        }
        if (src.startsWith("<?", lt) || src.startsWith("<!", lt)) {
            const end = src.indexOf(">", lt);
            i = end === -1 ? src.length : end + 1;
            continue;
        }

        const gt = findTagEnd(src, lt);
        const body = src.slice(lt + 1, gt);
        if (body.startsWith("/")) { i = gt + 1; stack.pop(); continue; }
        // 合法的开标签必须紧跟名字起始字符；`a < b` 这种文本里的裸 `<`（严格说不良构）
        // 当普通字符吃掉一个 `<` 并前进一字节，否则正文会被误当标签截断。
        if (!/^[A-Za-z_:]/.test(body)) {
            stack[stack.length - 1].text += "<";
            i = lt + 1;
            continue;
        }
        const selfClose = body.endsWith("/");
        const parsed = parseTagBody(selfClose ? body.slice(0, -1) : body);
        i = gt + 1;
        if (!parsed) continue;
        stack[stack.length - 1].children.push(parsed);
        if (!selfClose) stack.push(parsed);
    }
    return root.children.length === 1 ? root.children[0] : root;
}

/** 找到标签的结束 `>`，跳过属性值里的 `>` */
function findTagEnd(src, lt) {
    let inQuote = null;
    for (let j = lt + 1; j < src.length; j++) {
        const ch = src[j];
        if (inQuote) { if (ch === inQuote) inQuote = null; continue; }
        if (ch === '"' || ch === "'") { inQuote = ch; continue; }
        if (ch === ">") return j;
    }
    return src.length - 1;
}

/** 解析标签名与属性 */
function parseTagBody(body) {
    const m = new RegExp(`^(${NAME_RE.source})`).exec(body.trim());
    if (!m) return null;
    const node = { name: m[1], attrs: {}, children: [], text: "", depth: 0 };
    const rest = body.trim().slice(m[1].length);
    const attrRe = /([A-Za-z_:][A-Za-z0-9_.:\-]*)\s*=\s*"([^"]*)"|([A-Za-z_:][A-Za-z0-9_.:\-]*)\s*=\s*'([^']*)'/g;
    let am;
    while ((am = attrRe.exec(rest))) {
        const key = am[1] || am[3];
        node.attrs[key] = decodeEntities(am[2] !== undefined ? am[2] : am[4]);
    }
    return node;
}

/** 去掉片段里残余的标签（只在文本节点里出现畸形片段时兜底） */
function stripTags(raw) {
    return raw.replace(/<[^>]*>/g, "");
}

/** 实体解码：XML/HTML 常见五实体 + 数字引用 */
export function decodeEntities(text) {
    return String(text || "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+|x[0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(
            n[0] === "x" || n[0] === "X" ? parseInt(n.slice(1), 16) : parseInt(n, 10)
        ))
        .replace(/&amp;/g, "&");
}

/** 取本节点直接子元素（可按完整标签名过滤） */
export function children(node, name) {
    if (!node) return [];
    return name ? node.children.filter((c) => c.name === name) : node.children.slice();
}

/** 递归收集所有后代文本（`a:t` 之类要用它取正文） */
export function allText(node) {
    if (!node) return "";
    let out = node.text;
    for (const c of node.children) out += allText(c);
    return out;
}

/** 按「本地名」（去掉命名空间前缀）递归查找后代 */
export function findAll(node, localName, out = []) {
    if (!node) return out;
    for (const c of node.children) {
        if (localNameOf(c) === localName) out.push(c);
        findAll(c, localName, out);
    }
    return out;
}

/** 取标签的本地名（`w:p` -> `p`） */
export function localNameOf(node) {
    if (!node || !node.name) return "";
    const ix = node.name.indexOf(":");
    return ix === -1 ? node.name : node.name.slice(ix + 1);
}

/** 按路径取第一个后代（本地名逐级匹配），取不到返回 null */
export function firstChild(node, ...localNames) {
    let cur = node;
    for (const ln of localNames) {
        if (!cur) return null;
        cur = (cur.children || []).find((c) => localNameOf(c) === ln) || null;
    }
    return cur;
}
