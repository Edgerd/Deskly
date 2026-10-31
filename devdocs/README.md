# Deskly 开发者文档站

独立静态站（不在插件包内），可直接双击 `index.html` 离线打开，也可任意静态服务器托管。

## 目录

```
devdocs/
├── index.html               总览与架构
├── guides/                  入门与流程（quickstart / architecture / plugin-format / cold-load / app-store）
├── api/                     接口参考（deskly / settings / log / i18n / osfs / events / surface / trash / menubar）
├── reference/               规范与工具（redlines / z-layers / dev-tools / changelog）
└── assets/
    ├── style.css            共享样式（自动明暗主题）
    ├── pages.js             ★ 页面注册表（扩展点）
    └── docs.js              布局引擎（顶栏/侧栏/本页目录/上下页，读 pages.js）
```

## 扩展指南（三处约定）

1. **加页面**：新建 `xxx.html`，body 写 `data-page="id"`（必须与 pages.js 的 id 一致）与
   `data-base="${前缀}"`（根目录页 = 空；一级目录 = `../`；二级 = `../../`）。
   然后到 `assets/pages.js` 对应 section 里加一行 `{ id, title, href }`。
   侧栏、顶栏、面包屑、上/下页导航、过滤框全部自动生效，不用改 docs.js。
2. **写内容**：每个页面 `<main>` 里直接写 HTML；标题用 h1（站名）/h2/h3（自动进「本页」目录）。
   可用的版式组件：表格、`pre>code`、`.note` / `.warn` / `.okbox`（三种提示框）、
   `.pill`（徽标）、`kbd`。事实口径：仓库内权威文档在 `E:\hello\StartOS\dev\devdoc\`（md 原文），
   本站是其结构化转写 + 本会话新增内核（trash.js / menubar-status.js）的参考页；
   两边冲突时以源码注释为准。
3. **加页面目录层级**：pages.js 里的 href 是站点根相对；docs.js 按 data-base 补前缀，
   所以新目录只要把 data-base 设对就行（目前最深一级）。

## 事实来源（随仓库演进，过期了就去改这里）

| 本站页面 | 仓库来源 |
| --- | --- |
| guides/architecture | dev/devdoc/architecture.md |
| guides/quickstart | dev/devdoc/plugin-development.md + mods/about/ |
| guides/plugin-format | dev/devdoc/plugin-format.md |
| guides/cold-load | dev/devdoc/cold-load.md |
| guides/app-store | dev/devdoc/app-store.md |
| api/deskly | dev/devdoc/os-api.md §6 + src/javascripts/os-api.js + api-grants.js |
| api/settings | dev/devdoc/os-api.md §1 + src/javascripts/settings.js |
| api/log | dev/devdoc/os-api.md §2 + src/javascripts/log.js |
| api/i18n | dev/devdoc/os-api.md §3 + src/javascripts/i18n.js |
| api/osfs | dev/devdoc/os-api.md §4 + src/javascripts/osfs.js |
| api/events | src/javascripts/app-registry.js + 各模块 CustomEvent |
| api/surface | dev/devdoc/os-api.md §5 + src/javascripts/surface.js |
| api/trash | src/javascripts/trash.js（v0.2.95 新增，无 md 原文） |
| api/menubar | src/javascripts/menubar-status.js（v0.2.95 新增，无 md 原文） |
| reference/z-layers | dev/devdoc/z-layers.md + src/javascripts/zindex.js |
| reference/dev-tools | dev/*.mjs + os-api.md §6 |

## 自检（纯静态，无依赖）

- **链接完整性**：任意可运行环境里跑
  `node -e "const fs=require('fs');let f=[];(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){e.isDirectory()?w(d+'/'+e.name):f.push(d+'/'+e.name)}}('devdocs'));const broken=[];for(const p of f.filter(x=>x.endsWith('.html'))){const s=fs.readFileSync(p,'utf8');const m=[...s.matchAll(/href=&quot;([^&quot;#]+.html)/g)].map(x=>x[1]).concat([...s.matchAll(/src=&quot;([^&quot;#]+\.js|[^&quot;#]+\.css)&quot;/g)].map(x=>x[1]));for(const h of m){if(h.includes('://'))continue;const t=require('path').resolve(require('path').dirname(p),h);if(!fs.existsSync(t))broken.push(p+' -> '+h)}};console.log(broken.length?('BROKEN:\n'+broken.join('\n')):'all links ok');"`;
- **事实基线**：内容过期时对照「事实来源」表改，改完在本页脚把 <code>data-version</code> 提上去。
