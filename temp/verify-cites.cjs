const fs = require('fs');
const path = require('path');
const ROOT = 'E:/hello/StartOS';
const skip = new Set(['.git', 'node_modules', 'dist', '.workbuddy', '.qoder-credits', 'images']);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(p.replace(/\\/g, '/'));
  }
})(ROOT);

const doc = fs.readFileSync(path.join(ROOT, 'docs/手册对照_Deskly差异与改进建议.md'), 'utf8');
const cites = [...doc.matchAll(/([A-Za-z0-9_.\-\/]+\.(?:js|json|html|css|mjs)):(\d+)(?:-(\d+))?/g)]
  .map((m) => ({ f: m[1], a: +m[3], b: +(m[4] || m[3]) }));
const uniq = [...new Map(cites.map((c) => [c.f + ':' + c.a, c])).values()];
const ok = [];
const bad = [];
for (const c of uniq) {
  const matches = files.filter((p) => p.endsWith('/' + c.f) || p === ROOT + '/' + c.f);
  if (!matches.length) { bad.push('NOT FOUND  ' + c.f + ':' + c.a); continue; }
  const lines = fs.readFileSync(matches[0], 'utf8').split('\n');
  if (c.b > lines.length) bad.push('OUT OF RANGE ' + c.f + ':' + c.b + ' > ' + lines.length + '  (' + matches[0] + ')');
  else ok.push(c.f + ':' + c.a);
}
console.log('唯一引用', uniq.length, '| 行号有效', ok.length, '| 异常', bad.length);
bad.forEach((b) => console.log('  ' + b));
