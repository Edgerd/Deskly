const fs = require('fs');
const path = require('path');
const ROOT = 'E:/hello/StartOS';
const doc = path.join(ROOT, 'docs/原版设计保真清单_修复方法与提示词.md');
const s = fs.readFileSync(doc, 'utf8');

// 1. 结构
const fences = (s.match(/^```/gm) || []).length;
console.log('代码围栏数', fences, fences % 2 === 0 ? '(配对 OK)' : '!! 不配对');
console.log('H2', (s.match(/^## /gm) || []).length, 'H3', (s.match(/^### /gm) || []).length);
console.log('残留哨兵', /CONTINUE-F25|<!--[^>]*-->/.test(s) ? '有 !!' : '无');

// 2. 条目与严重度
const items = [...s.matchAll(/^### (F-\d\d) · (.+)$/gm)].map((m) => m[1]);
const rows = [...s.matchAll(/^\| (F-\d\d) \| (\*?\*?P\d)\*?\*? \|/gm)].map((m) => ({ id: m[1], sev: m[2].replace(/\*/g, '') }));
const tally = {};
rows.forEach((r) => (tally[r.sev] = (tally[r.sev] || 0) + 1));
console.log('明细条目', items.length, '总表行', rows.length, '严重度分布', JSON.stringify(tally));
const missing = items.filter((i) => !rows.some((r) => r.id === i));
const extra = rows.filter((r) => !items.includes(r.id)).map((r) => r.id);
console.log('总表缺条目', missing.join(',') || '无', '| 明细缺条目', extra.join(',') || '无');
const prompts = (s.match(/```text\n任务：/g) || []).length;
console.log('提示词块', prompts, prompts === items.length ? '(每条一份 OK)' : '!! 与条目数不符');

// 3. 行号引用
const files = [];
const skip = new Set(['.git', 'node_modules', 'dist', '.workbuddy', '.qoder-credits', 'images']);
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(p.replace(/\\/g, '/'));
  }
})(ROOT);
const cites = [...s.matchAll(/([A-Za-z0-9_\-\/\.]+\.(?:js|json|css|html|md)):(\d+)(?:-(\d+))?/g)].map((m) => ({ f: m[1], a: +m[2], b: +(m[3] || m[2]) }));
const uniq = [...new Map(cites.map((c) => [c.f + ':' + c.a, c])).values()];
const bad = [];
for (const c of uniq) {
  const m = files.filter((p) => p.endsWith('/' + c.f));
  if (!m.length) { bad.push('NOT FOUND ' + c.f); continue; }
  const n = fs.readFileSync(m[0], 'utf8').split('\n').length;
  if (c.b > n) bad.push('OUT OF RANGE ' + c.f + ':' + c.b + ' > ' + n);
}
console.log('唯一行号引用', uniq.length, '异常', bad.length);
bad.forEach((b) => console.log('   ' + b));

// 4. 本地链接
let broken = 0;
for (const m of s.matchAll(/\]\((file:\/\/\/[^)]+)\)/g)) {
  const p = decodeURI(m[1].replace(/^file:\/\/\//, '')).replace(/#.*$/, '');
  if (!fs.existsSync(p)) { console.log('BROKEN', m[1]); broken++; }
}
console.log('本地链接失效', broken, '| 文档字数', s.replace(/\s/g, '').length, '| 行数', s.split('\n').length);
