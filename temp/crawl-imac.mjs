import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
const { parseHTML } = await import('file:///E:/hello/tools/node_modules/linkedom/esm/index.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TOC_HTML = 'E:/hello/StartOS/temp/imac_toc.html';
const OUT_ROOT = 'E:/hello/StartOS/docs/iMac-2024-macOS15-知识库';
const PAGES_DIR = path.join(OUT_ROOT, 'pages');
const IMG_DIR = path.join(OUT_ROOT, 'images');
fs.mkdirSync(PAGES_DIR, { recursive: true });
fs.mkdirSync(IMG_DIR, { recursive: true });

const slug = (s) => s.replace(/[\s/\\:*?"<>|]+/g, '_').replace(/^_+|_+$/g, '');

/* ---------- 1. parse TOC ---------- */
const tocSrc = fs.readFileSync(TOC_HTML, 'utf8');
const nodes = [];
{
  const re = /<ul[^>]*>|<\/ul>|<(button|a)\b[^>]*class='(section|toc-item)'[^>]*>[\s\S]*?<\/\1>/g;
  let level = 0, m;
  while ((m = re.exec(tocSrc))) {
    if (m[0].startsWith('<ul')) level++;
    else if (m[0].startsWith('</ul')) level--;
    else {
      const title = ((m[0].match(/<span class='name'>([\s\S]*?)<\/span>/) || [])[1] || '').replace(/&amp;/g, '&').trim();
      const href = (m[0].match(/href='([^']+)'/) || [])[1] || '';
      nodes.push({ kind: m[1] === 'a' ? 'page' : 'section', title, url: href, depth: Math.max(0, level - 1) });
    }
  }
}

/* ---------- 2. html -> markdown ---------- */
const imageMap = new Map();
const ICONS = { 'GlobalArt/IL_AppleLogo.png': '' };

function inlineName(img) {
  const o = img.getAttribute('originalImageName') || '';
  return ICONS[o] || null;
}

function imgLocalName(url, original) {
  let base = (original || '').split('/').pop() || path.basename(new URL(url).pathname) || 'img.png';
  base = base.replace(/[~]/g, '-');
  if (!/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(base)) base += '.png';
  return base;
}

function textOf(node) {
  let out = '';
  for (const c of node.childNodes) {
    if (c.nodeName === '#text') out += c.textContent;
    else if (c.nodeName !== '#comment' && c.childNodes) out += textOf(c);
  }
  return out;
}

const BLOCK = new Set(['P', 'UL', 'OL', 'LI', 'DIV', 'FIGURE', 'TABLE', 'TR', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'PRE', 'HR', 'MAIN', 'TBODY', 'THEAD']);

function cls(el) { return (el.getAttribute('class') || '').split(/\s+/); }

function inline(el) {
  let s = '';
  for (const c of el.childNodes) {
    const n = c.nodeName;
    if (n === '#text') { s += c.textContent.replace(/\s+/g, ' '); continue; }
    if (n === '#comment' || !c.tagName) continue;
    const t = c.tagName.toUpperCase();
    if (t === 'IMG') {
      const url = c.getAttribute('src') || '';
      const original = c.getAttribute('originalImageName') || c.getAttribute('originalimagename') || '';
      const icon = inlineName(c);
      if (icon) { s += icon; continue; }
      if (!url) continue;
      const fname = imgLocalName(url, original);
      if (!imageMap.has(url)) imageMap.set(url, { fname, original, alt: c.getAttribute('alt') || '' });
      const alt = (c.getAttribute('alt') || '').trim() || original.replace(/^Art\//, '').replace(/\.\w+$/, '');
      s += `\n\n![${alt}](${path.posix.join('..', 'images', fname)})\n\n*图：${alt}*\n\n`;
      continue;
    }
    if (t === 'BR') { s += '  \n'; continue; }
    if (t === 'PICTURE' || t === 'SPAN' || t === 'SMALL' || t === 'SUP' || t === 'SUB' || t === 'Q' || t === 'CITE' || t === 'DFN') { s += inline(c); continue; }
    if (t === 'EM' || t === 'I') { const inner = inline(c).trim(); s += inner ? `*${inner}*` : ''; continue; }
    if (t === 'STRONG' || t === 'B') { const inner = inline(c).trim(); s += inner ? `**${inner}**` : ''; continue; }
    if (t === 'CODE' || t === 'KBD' || t === 'SAMP' || t === 'VAR') { const inner = textOf(c).trim(); s += inner ? '`' + inner + '`' : ''; continue; }
    if (t === 'A') {
      const href = c.getAttribute('href') || '';
      const label = inline(c).trim() || textOf(c).trim();
      s += href && !href.startsWith('help:') ? `[${label}](${href})` : label;
      continue;
    }
    if (t === 'SCRIPT' || t === 'STYLE' || t === 'SOURCE') continue;
    if (BLOCK.has(t) || /^H[1-6]$/.test(t)) { s += '\n\n' + block(c).trim() + '\n\n'; continue; }
    s += inline(c);
  }
  return s;
}

function block(el) {
  const t = el.tagName.toUpperCase();
  const kids = () => Array.from(el.childNodes).filter((c) => c.nodeName !== '#comment');
  const childBlocks = () => kids().map((c) => (c.tagName && BLOCK.has(c.tagName.toUpperCase()) ? block(c) : (() => { const i = inline(c).trim(); return i ? i : ''; })())).filter(Boolean).join('\n\n');
  switch (t) {
    case 'H1': return `# ${textOf(el).trim()}`;
    case 'H2': return `## ${textOf(el).trim()}`;
    case 'H3': return `### ${textOf(el).trim()}`;
    case 'H4': return `#### ${textOf(el).trim()}`;
    case 'H5': case 'H6': return `##### ${textOf(el).trim()}`;
    case 'P': { const s = inline(el).trim(); return s ? s.replace(/ {2,}/g, ' ') : ''; }
    case 'UL': case 'OL': return listToMd(el);
    case 'LI': {
      const head = inline(el).trim().replace(/\n{2,}/g, '\n\n');
      return `- ${head.replace(/\n/g, '\n  ')}`;
    }
    case 'FIGURE': { const s = inline(el).trim(); return s; }
    case 'TABLE': return tableToMd(el);
    case 'DIV': case 'SECTION': case 'ARTICLE': case 'MAIN': return childBlocks();
    case 'BLOCKQUOTE': return childBlocks().split('\n').map((l) => `> ${l}`).join('\n');
    case 'HR': return '---';
    case 'FOOTER': return `*${inline(el).trim()}*`;
    default: return inline(el).trim();
  }
}

let listDepth = 0;
function listToMd(el) {
  const ordered = el.tagName.toUpperCase() === 'OL';
  const items = Array.from(el.children).filter((c) => c.tagName && /^(LI)$/.test(c.tagName.toUpperCase()));
  const out = [];
  listDepth++;
  items.forEach((li, i) => {
    const marker = ordered ? `${i + 1}. ` : '- ';
    const parts = [];
    for (const c of li.childNodes) {
      if (c.nodeName === '#comment') continue;
      const tn = c.tagName ? c.tagName.toUpperCase() : null;
      if (tn === 'UL' || tn === 'OL') { const s = listToMd(c); parts.push('\u0000' + s); continue; }
      if (tn === 'DIV' && /Alert|Note|Warning/.test(c.getAttribute('class') || '')) { parts.push(block(c)); continue; }
      const s = (tn && BLOCK.has(tn) ? block(c) : inline(c)).trim();
      if (s) parts.push(s);
    }
    let text = parts.join('\n\n');
    const pad = ' '.repeat(marker.length);
    text = text.split('\n').map((l) => (l.startsWith('\u0000') ? pad + l.slice(1).replace(/\n(?!$)/g, '\n' + pad) : (l.trim() ? pad + l : l))).join('\n');
    text = text.replace(/\u0000/g, '');
    out.push(marker + text.replace(/^\s*/, ''));
  });
  listDepth--;
  return out.join('\n');
}

function tableToMd(table) {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return '';
  const md = rows.map((tr) => {
    const cells = Array.from(tr.children).map((td) => inline(td).replace(/\s*\n\s*/g, ' ').trim().replace(/\|/g, '\\|') || ' ');
    return '| ' + cells.join(' | ') + ' |';
  });
  const cols = (md[0].match(/\|/g) || []).length - 1;
  md.splice(1, 0, '|' + ' --- |'.repeat(Math.max(1, cols)));
  return md.join('\n');
}

function normalize(md) {
  return md
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, '').replace(/\*\s*\*\n/g, '\n'))
    .join('\n')
    .trim() + '\n';
}

/* ---------- 3. crawl ---------- */
const pages = nodes.filter((n) => n.kind === 'page' && n.url);
const results = [];
let idx = 0;
for (const node of pages) {
  idx++;
  const url = node.url.endsWith('/welcome/mac') ? node.url.replace('/welcome/mac', '/welcome/2024/mac/15') : node.url;
  let html;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { html = await (await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } })).text(); break; }
    catch (e) { if (attempt === 2) throw e; await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
  }
  const anchor = Math.max(html.lastIndexOf("<div id='article-section-wrapper'"), html.lastIndexOf('<div id="content-section">'));
  const bm = (anchor > 0 ? html.slice(anchor) : html).match(/<body[^>]*id="apd[^"]*"[^>]*>([\s\S]*?)<\/body>/);
  if (!bm) { results.push({ title: node.title, url, error: 'no-body' }); continue; }
  const frag = bm[1];
  const { document } = parseHTML(`<html><body>${frag}</body></html>`);
  const body = document.body;
  const title = (body.querySelector('h1') ? textOf(body.querySelector('h1')).trim() : node.title);
  const md = normalize(block(body));
  results.push({ title, url, chars: md.length, images: (md.match(/!\[/g) || []).length });
  const fname = `${String(idx).padStart(2, '0')}-${slug(title)}.md`;
  fs.writeFileSync(path.join(PAGES_DIR, fname), `> 来源：${url}\n> 章节：${node.title}\n\n${md}`);
  node.file = `pages/${fname}`;
  process.stdout.write(`[${idx}/${pages.length}] ${title} (${md.length} chars)\n`);
}

/* ---------- 4. images ---------- */
let ok = 0, fail = 0, bytes = 0;
for (const [url, info] of imageMap) {
  const target = path.join(IMG_DIR, info.fname);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(target, buf);
    bytes += buf.length; ok++;
  } catch (e) { fail++; console.log('FAIL', url, e.message, '->', info.fname); }
}

/* ---------- 5. index ---------- */
const lines = ['# iMac 使用手册（2024 年款 · macOS Sequoia 15）目录索引', '', `抓取时间：${new Date().toISOString().slice(0, 10)} · 页面 ${pages.length} · 图片 ${ok}`, ''];
for (const n of nodes) {
  const indent = '  '.repeat(n.depth);
  if (n.kind === 'section') lines.push(`${indent}- **${n.title}**`);
  else lines.push(`${indent}- [${n.title}](${n.file || '#'}) · [原文](${n.url})`);
}
fs.writeFileSync(path.join(OUT_ROOT, 'INDEX.md'), lines.join('\n') + '\n');
fs.writeFileSync(path.join(OUT_ROOT, 'crawl-report.json'), JSON.stringify({ results, images: { ok, fail, bytes }, imageMap: [...imageMap.entries()].map(([u, v]) => ({ url: u, ...v })) }, null, 2));
console.log(`\nDONE pages=${pages.length} images ok=${ok} fail=${fail} bytes=${(bytes / 1048576).toFixed(1)}MB`);
