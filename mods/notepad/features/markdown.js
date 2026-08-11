/**
 * markdown.js — Markdown ↔ HTML 双向转换（自研轻量版）
 * 支持：标题(H1-H3)、粗体、斜体、删除线、行内代码、代码块、
 *       引用、无序/有序列表、链接、图片、分割线、表格。
 */

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeHtml(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** 行内语法解析 */
function inline(text) {
    let t = escapeHtml(text);
    // 图片（必须在链接前）
    t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">');
    // 链接
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    // 粗体
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // 删除线
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // 斜体 *x*
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    // 斜体 _x_
    t = t.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
    // 行内代码
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    return t;
}

/** Markdown → HTML */
export function mdToHtml(md) {
    if (!md) return '';
    const lines = md.replace(/\r\n/g, '\n').split('\n');
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
            html += `<pre><code>${escapeHtml(code.trim('\n'))}</code></pre>`;
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

        // 无序列表
        if (/^[-*+]\s+/.test(line)) {
            let items = '';
            while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
                items += `<li>${inline(lines[i].replace(/^[-*+]\s+/, ''))}</li>`;
                i++;
            }
            html += `<ul>${items}</ul>`;
            continue;
        }

        // 有序列表
        if (/^\d+\.\s+/.test(line)) {
            let items = '';
            while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
                items += `<li>${inline(lines[i].replace(/^\d+\.\s+/, ''))}</li>`;
                i++;
            }
            html += `<ol>${items}</ol>`;
            continue;
        }

        // 表格（首行含 |，次行含 ---）
        if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
            const header = line.split('|').filter(c => c.trim()).map(c => `<th>${inline(c.trim())}</th>`).join('');
            i += 2;
            let rows = '';
            while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
                const cells = lines[i].split('|').filter(c => c.trim()).map(c => `<td>${inline(c.trim())}</td>`).join('');
                rows += `<tr>${cells}</tr>`;
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

/** DOM 节点 → Markdown */
function nodeToMd(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
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
        case 'code': return '`' + node.textContent + '`';
        case 'pre': return '```\n' + node.textContent + '\n```\n\n';
        case 'blockquote': return '> ' + inner.trim().replace(/\n/g, '\n> ') + '\n\n';
        case 'ul': return Array.from(node.children).map(li => '- ' + nodeToMd(li).trim() + '\n').join('') + '\n';
        case 'ol': return Array.from(node.children).map((li, idx) => (idx + 1) + '. ' + nodeToMd(li).trim() + '\n').join('') + '\n';
        case 'li': return inner;
        case 'a': return '[' + inner + '](' + (node.getAttribute('href') || '') + ')';
        case 'img': return '![' + (node.getAttribute('alt') || '') + '](' + (node.getAttribute('src') || '') + ')';
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

function tableToMd(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return '';
    const headerCells = Array.from(rows[0].children).map(td => td.textContent.trim());
    let md = '| ' + headerCells.join(' | ') + ' |\n';
    md += '| ' + headerCells.map(() => '---').join(' | ') + ' |\n';
    for (let i = 1; i < rows.length; i++) {
        const cells = Array.from(rows[i].children).map(td => td.textContent.trim());
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
