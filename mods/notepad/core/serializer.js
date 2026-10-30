/**
 * serializer.js — Markdown ↔ HTML 双向转换（自研轻量版，核心层）
 * 支持：标题(H1-H3)、粗体、斜体、删除线、行内代码、代码块、引用、
 *       无序/有序列表（含嵌套）、链接、图片、分割线、表格。
 *
 * 安全约定：本模块输出的 HTML 会进入 contenteditable / innerHTML，
 * 因此所有文本与属性值一律转义（含引号），URL 仅允许安全协议。
 */

/** 文本 / 属性值 → HTML（含引号，属性插值必须走这里） */
export function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * URL 白名单过滤：允许 http(s)/mailto/锚点/相对路径，图片场景额外允许位图 data: URI。
 * 先剥离控制字符与空白，避免 `java\tscript:` 之类的绕过写法。
 */
export function safeUrl(raw, { allowDataImage = false } = {}) {
    const url = String(raw == null ? '' : raw).trim().replace(/[\u0000-\u0020\u007f]/g, '');
    if (!url) return '';
    const scheme = url.match(/^([a-z][a-z0-9+.-]*):/i);
    if (!scheme) return url;                      // 相对路径 / #锚点
    const name = scheme[1].toLowerCase();
    if (name === 'http' || name === 'https' || name === 'mailto') return url;
    if (allowDataImage && name === 'data' && /^data:image\/(png|jpe?g|gif|webp|bmp);/i.test(url)) return url;
    return '';
}

/** 占位符控制字符（inline() 内部保护已转义片段用） */
const PH_OPEN = '\u0002';
const PH_CLOSE = '\u0003';

/** 链接目标：拆出 URL 部分，丢弃 `"标题"` 与 <> 包裹（入参已完成 HTML 转义） */
function stripTitle(dest) {
    const s = String(dest).trim();
    if (s.startsWith('&lt;')) {
        const end = s.indexOf('&gt;');
        if (end >= 0) return s.slice(4, end).trim();
    }
    return s.split(/\s+/)[0];
}

/**
 * 行内语法解析。
 * 顺序：摘出反斜杠转义 → 摘出行内代码 → 整体转义 → 图片/链接/粗体/删除线/斜体 → 还原占位。
 * 前两步先占位，避免代码块与已转义文本被后续正则二次解析。
 */
function inline(text) {
    const stash = [];
    const keep = (html) => {
        stash.push(html);
        return PH_OPEN + (stash.length - 1) + PH_CLOSE;
    };

    // 占位符控制字符不得出现在原文中，否则还原阶段会错位
    let t = String(text).replace(/[\u0000-\u0003]/g, '');
    // 反斜杠转义：\* → 字面量 *
    t = t.replace(/\\([\\`*_~[\]()#>+.\-!|])/g, (m, ch) => keep(escapeHtml(ch)));
    // 行内代码：内容只转义不解析
    t = t.replace(/`([^`]+)`/g, (m, code) => keep('<code>' + escapeHtml(code) + '</code>'));

    t = escapeHtml(t);

    // 图片（必须在链接前）
    t = t.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (m, alt, dest) => {
        const safe = safeUrl(stripTitle(dest), { allowDataImage: true });
        // 不安全协议原样按文本输出（t 已完成转义，不可再次转义）
        if (!safe) return m;
        return `<img alt="${alt}" src="${safe}">`;
    });
    // 链接
    t = t.replace(/\[([^\]]+)\]\(([^)]*)\)/g, (m, label, dest) => {
        const safe = safeUrl(stripTitle(dest));
        if (!safe) return m;
        return `<a href="${safe}">${label}</a>`;
    });
    // 粗体
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // 删除线
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // 斜体 *x*
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    // 斜体 _x_：下划线不做词内强调，避免 a_b_c 被误解析
    t = t.replace(/(^|[^A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, '$1<em>$2</em>');

    return t.replace(new RegExp(PH_OPEN + '(\\d+)' + PH_CLOSE, 'g'), (m, i) => stash[Number(i)] ?? '');
}

/** 列表行解析（indent 用于嵌套层级） */function matchListItem(line) {
    const m = line.match(/^([ \t]*)([-*+]|\d{1,9}\.)\s+(.*)$/);
    if (!m) return null;
    return { indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), text: m[3] };
}

/**
 * 按缩进递归渲染列表，返回 [html, 消费到的行索引]。
 * 深层缩进的条目挂到前一个 <li> 内，保证嵌套结构不被拍平。
 */
function renderList(items, start, indent) {
    const ordered = items[start].ordered;
    let pos = start;
    let inner = '';
    while (pos < items.length && items[pos].indent === indent) {
        let text = inline(items[pos].text);
        pos++;
        if (pos < items.length && items[pos].indent > indent) {
            const [sub, next] = renderList(items, pos, items[pos].indent);
            text += sub;
            pos = next;
        }
        inner += `<li>${text}</li>`;
    }
    return [ordered ? `<ol>${inner}</ol>` : `<ul>${inner}</ul>`, pos];
}

/** Markdown → HTML */
export function mdToHtml(md) {
    if (!md) return '';
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // 代码块
        if (line.startsWith('```')) {
            let code = '';
            i++;
            while (i < lines.length && !lines[i].startsWith('```')) {
                code += lines[i] + '\n';
                i++;
            }
            i++; // 跳过闭合 ```
            html += `<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`;
            continue;
        }

        // 标题
        const h = line.match(/^(#{1,3})\s+(.*)$/);
        if (h) {
            const level = h[1].length;
            html += `<h${level}>${inline(h[2])}</h${level}>`;
            i++;
            continue;
        }

        // 分割线
        if (/^---+$/.test(line.trim()) || /^===+$/.test(line.trim())) {
            html += '<hr>';
            i++;
            continue;
        }

        // 引用
        if (line.startsWith('>')) {
            let quote = '';
            while (i < lines.length && lines[i].startsWith('>')) {
                quote += lines[i].slice(1).trim() + '\n';
                i++;
            }
            html += `<blockquote>${mdToHtml(quote.trim())}</blockquote>`;
            continue;
        }

        // 列表（连续列表行整体交给 renderList，含嵌套缩进）
        if (matchListItem(line)) {
            const items = [];
            while (i < lines.length) {
                const item = matchListItem(lines[i]);
                if (!item) break;
                items.push(item);
                i++;
            }
            // 缩进比首行更浅的条目无法并入首层，另起一个同级列表渲染
            let pos = 0;
            while (pos < items.length) {
                const [listHtml, next] = renderList(items, pos, items[pos].indent);
                html += listHtml;
                pos = Math.max(next, pos + 1);
            }
            continue;
        }

        // 表格（首行含 |，次行含 ---）
        if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
            const header = splitRow(line).map((c) => `<th>${inline(c)}</th>`).join('');
            i += 2;
            let rows = '';
            while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
                rows += `<tr>${splitRow(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`;
                i++;
            }
            html += `<table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
            continue;
        }

        // 空行
        if (!line.trim()) {
            i++;
            continue;
        }

        // 普通段落
        html += `<p>${inline(line)}</p>`;
        i++;
    }

    return html;
}

/** 表格行拆单元格（保留空单元，去掉首尾管道产生的空串） */
function splitRow(line) {
    return line.split('|')
        .map((c) => c.trim())
        .filter((c, idx, arr) => !(c === '' && (idx === 0 || idx === arr.length - 1)));
}

/** 文本节点 → Markdown：转义会改变语义的标点，保证纯文本回读不被解析成语法 */
function escapeMd(text) {
    return String(text)
        .replace(/[\\`*_[\]]/g, '\\$&')
        .replace(/~~/g, '\\~\\~')
        .replace(/!(?=\[)/g, '\\!')
        .replace(/^([ \t]*)(#{1,6}|[-*>+]|(\d{1,9}\.))([ \t]|$)/gm, (m, sp, marker, digits, tail) => {
            // 有序列表标记只转义句点，`\1.` 不是合法转义序列
            if (digits) return sp + marker.slice(0, -1) + '\\.' + tail;
            return sp + '\\' + marker + tail;
        });
}

/** 行内代码定界符：内容含反引号时加长定界符（CommonMark 规则） */
function inlineCode(text) {
    if (!text.includes('`')) return '`' + text + '`';
    const runs = text.match(/`+/g) || [];
    const longest = runs.reduce((max, r) => Math.max(max, r.length), 0);
    const fence = '`'.repeat(longest + 1);
    const pad = /^`|`$/.test(text) ? ' ' : '';
    return fence + pad + text + pad + fence;
}

/** 链接目标：含空格或括号时改用 <> 包裹形式 */
function mdUrl(url) {
    const safe = safeUrl(url) || '';
    return /[\s()]/.test(safe) ? `<${safe}>` : safe;
}

/** DOM 节点 → Markdown */
function nodeToMd(node) {
    if (node.nodeType === Node.TEXT_NODE) return escapeMd(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    const inner = Array.from(node.childNodes).map(nodeToMd).join('');

    switch (tag) {
        case 'h1': return '# ' + inner.trim() + '\n\n';
        case 'h2': return '## ' + inner.trim() + '\n\n';
        case 'h3': return '### ' + inner.trim() + '\n\n';
        case 'p': return inner + '\n\n';
        case 'div': return inner.trim() ? inner + '\n' : '\n';
        case 'br': return '\n';
        case 'strong':
        case 'b': return '**' + inner + '**';
        case 'em':
        case 'i': return '*' + inner + '*';
        case 'del':
        case 's':
        case 'strike': return '~~' + inner + '~~';
        case 'code': return inlineCode(node.textContent);
        case 'pre': return '```\n' + node.textContent + '\n```\n\n';
        case 'blockquote': return '> ' + inner.trim().replace(/\n/g, '\n> ') + '\n\n';
        case 'ul': return listToMd(node, false);
        case 'ol': return listToMd(node, true);
        case 'li': {
            // 子列表必须换行，否则与列表项文本粘连
            let out = '';
            Array.from(node.childNodes).forEach((child) => {
                const piece = nodeToMd(child);
                const isList = child.tagName && /^(ul|ol)$/i.test(child.tagName);
                if (isList && out && !out.endsWith('\n')) out += '\n';
                out += piece;
            });
            return out;
        }
        case 'a': return '[' + inner + '](' + mdUrl(node.getAttribute('href')) + ')';
        case 'img': return '![' + escapeMd(node.getAttribute('alt') || '') + '](' + mdUrl(node.getAttribute('src')) + ')';
        case 'hr': return '---\n\n';
        case 'table': return tableToMd(node) + '\n';
        case 'tbody':
        case 'thead':
        case 'tr':
        case 'span':
        case 'font': return inner;
        default: return inner;
    }
}

/** 列表 → Markdown：子列表整块缩进两格，保留层级 */
function listToMd(list, ordered) {
    const items = Array.from(list.children).filter((li) => li.tagName.toLowerCase() === 'li');
    if (!items.length) return '';
    const lines = items.map((li, idx) => {
        const marker = ordered ? `${idx + 1}. ` : '- ';
        const text = nodeToMd(li).replace(/^\s+|\s+$/g, '');
        return text.split('\n').map((ln, i) => (i === 0 ? marker : '  ') + ln).join('\n');
    });
    return lines.join('\n') + '\n\n';
}

/** 表格 → Markdown：单元格走 nodeToMd，加粗/行内代码等格式不丢失 */
function tableToMd(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return '';
    const cell = (td) => nodeToMd(td).trim().replace(/\|/g, '\\|');
    const headerCells = Array.from(rows[0].children).map(cell);
    if (!headerCells.length) return '';
    let md = '| ' + headerCells.join(' | ') + ' |\n';
    md += '| ' + headerCells.map(() => '---').join(' | ') + ' |\n';
    for (let i = 1; i < rows.length; i++) {
        const cells = Array.from(rows[i].children).map(cell);
        if (!cells.length) continue;
        md += '| ' + cells.join(' | ') + ' |\n';
    }
    return md;
}

/** HTML(DOM/字符串) → Markdown */
export function htmlToMd(root) {
    if (!root) return '';
    let el = root;
    if (typeof root === 'string') {
        el = document.createElement('div');
        el.innerHTML = root;
    }
    return Array.from(el.childNodes).map(nodeToMd).join('').replace(/\n{3,}/g, '\n\n').trim();
}
