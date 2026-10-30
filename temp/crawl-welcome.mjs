import fs from 'fs';
import path from 'path';
const { parseHTML } = await import('file:///E:/hello/tools/node_modules/linkedom/esm/index.js');
const OUT = 'E:/hello/StartOS/docs/iMac-2024-macOS15-知识库';
const src = fs.readFileSync('E:/hello/StartOS/temp/imac_welcome.html', 'utf8');
const m = src.match(/<body[^>]*id="apd16d505399xy"[^>]*>([\s\S]*?)<\/body>/);
if (!m) { console.log('not found'); process.exit(1); }

const imageMap = new Map();
function textOf(n) { let s = ''; for (const c of n.childNodes) { if (c.nodeName === '#text') s += c.textContent; else if (c.nodeName !== '#comment' && c.childNodes) s += textOf(c); } return s; }
const BLOCK = new Set(['P', 'UL', 'OL', 'LI', 'DIV', 'FIGURE', 'TABLE', 'TR', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'PRE', 'HR', 'MAIN', 'TBODY', 'THEAD']);
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
      if (!url) continue;
      let fname = original.split('/').pop() || path.basename(new URL(url).pathname);
      if (!/\.\w+$/.test(fname)) fname += '.png';
      imageMap.set(url, fname);
      const alt = (c.getAttribute('alt') || '').trim() || fname.replace(/\.\w+$/, '');
      s += `\n\n![${alt}](../images/${fname})\n\n*图：${alt}*\n\n`;
      continue;
    }
    if (t === 'BR') { s += '  \n'; continue; }
    if (t === 'PICTURE' || t === 'SPAN' || t === 'SOURCE' || t === 'SMALL') { s += inline(c); continue; }
    if (t === 'EM' || t === 'I') { const i2 = inline(c).trim(); s += i2 ? `*${i2}*` : ''; continue; }
    if (t === 'STRONG' || t === 'B') { const i2 = inline(c).trim(); s += i2 ? `**${i2}**` : ''; continue; }
    if (t === 'A') { const href = c.getAttribute('href') || ''; const label = inline(c).trim(); s += href ? `[${label}](${href})` : label; continue; }
    if (t === 'SCRIPT' || t === 'STYLE') continue;
    if (BLOCK.has(t)) { s += '\n\n' + block(c).trim() + '\n\n'; continue; }
    s += inline(c);
  }
  return s;
}
function block(el) {
  const t = el.tagName.toUpperCase();
  const kids = () => Array.from(el.childNodes).filter((c) => c.nodeName !== '#comment');
  const childBlocks = () => kids().map((c) => (c.tagName && BLOCK.has(c.tagName.toUpperCase()) ? block(c) : inline(c).trim())).filter(Boolean).join('\n\n');
  if (/^H[1-6]$/.test(t)) return '#'.repeat(+t[1]) + ' ' + textOf(el).trim();
  if (t === 'P') return inline(el).trim();
  if (t === 'FOOTER') return '*' + inline(el).trim() + '*';
  if (t === 'UL' || t === 'OL') return kids().filter((c) => c.tagName === 'LI').map((li) => `- ${inline(li).trim()}`).join('\n');
  if (t === 'FIGURE') return inline(el).trim();
  return childBlocks();
}
const { document } = parseHTML(`<html><body>${m[1]}</body></html>`);
let md = block(document.body).replace(/\n{3,}/g, '\n\n').trim() + '\n';
md = `> 来源：https://support.apple.com/zh-cn/guide/imac/welcome/2024/mac/15\n> 章节：欢迎使用\n\n# 欢迎使用\n\n${md}`;
fs.writeFileSync(path.join(OUT, 'pages', '01-欢迎使用.md'), md);
for (const [url, fname] of imageMap) {
  const buf = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).arrayBuffer());
  fs.writeFileSync(path.join(OUT, 'images', fname), buf);
}
console.log(md);
