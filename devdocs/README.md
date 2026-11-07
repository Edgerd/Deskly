# Deskly 开发者文档站

独立静态站（不打进插件包），双击 `index.html` 即可离线打开，也可用任意静态服务器托管。

**适用版本：0.4.3**（以 `src/javascripts/version.js` 的 `VERSION` 常量为准）。

## 目录

```
devdocs/
├── index.html               总览与架构
├── guides/                  入门与流程（quickstart / architecture / plugin-format / cold-load / app-store）
├── api/                     接口参考（deskly / settings / log / i18n / osfs / events / surface / trafficlights / trash / menubar）
├── reference/               规范与工具（redlines / z-layers / dev-tools / changelog）
├── skill/
│   ├── index.html           AI 技能包介绍页（站内导航）
│   └── plugin-dev/          ★ 面向 AI 的插件开发技能包（SKILL.md + 模板 + 自检清单）
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
2. **写内容**：每个页面 `<main>` 里直接写 HTML；标题用 h1（页题）/h2/h3（自动进「本页」目录）。
   可用的版式组件：表格、`pre>code`、`.note` / `.warn` / `.okbox`（三种提示框）、`.pill`（徽标）、`kbd`。
3. **事实口径**：一切 API 名、事件名、字段、数值以仓库源码为准；源码注释与旧文档冲突时以源码为准。
   无法从代码证实的说法直接删除，不保留。

## 最近一次核对

**2026-11-03**，对当时的 19 个页面逐条核对（页面数随后增长，以目录实测为准），依据与方法：

- 版本号：`src/javascripts/version.js`（0.4.3）、根 `manifest.json`、根 `index.html` 的全部 `?v=` 缓存戳（数量以实测为准）；
- 插件系统：`plugin-manager.js`（`BUILTIN_IDS` 内置清单、装载时序、缓存戳）、`app-registry.js`（事件与 detail 形状）、`store-api.js`（安装链路与清洗限额）、`sw.js`（X-Deskly-Plugin 接管验证）；
- API 面：`os-api.js`（Deskly 全方法）、`api-grants.js`（22 条权限名与敏感集）、`settings.js`、`log.js`、`i18n.js`、`osfs.js`、`surface.js`、`trash.js`、`menubar-status.js`、`zindex.js`、`paths.js`、`ui/trafficLights.js`、`ui/dialog.js`（弹窗唯一实现；`ui/alert.js` 为旧门面）、`ui/notification.js`、`ui/popover.js`、`finderbar.js`、`debug.js`、`window-manager.js`（data-window 键表）、`bootstrap.js`（启动顺序）；
- 实例数据：每个 `mods/*/manifest.json` 的 permissions 声明逐个导出核对；
- 实测取证：`node dev/static-check.mjs`、`node --experimental-vm-modules dev/deep-check.mjs`、`node dev/settings-fulltest.mjs` 三个脚本真实跑过一遍，文中数量为当日输出。

**会随版本漂移的内容**：版本号本身、模块/断言/设置项数量（已注明「以脚本实测为准」）、`?v=` 处数、内置插件数（BUILTIN_IDS 长度）、changelog 页的版本摘要。改版时优先核对这些点。

## 事实来源（随仓库演进，过期了就去改这里）

| 本站页面 | 仓库来源 |
| --- | --- |
| guides/architecture | src/javascripts/bootstrap.js + plugin-manager.js + dev/devdoc/architecture.md |
| guides/quickstart | mods/about/ + src/javascripts/plugin-manager.js + window-manager.js |
| guides/plugin-format | src/javascripts/plugin-manager.js + store-api.js + paths.js + dev/package-plugin.mjs |
| guides/cold-load | src/javascripts/plugin-manager.js + paths.js |
| guides/app-store | src/javascripts/store-api.js + sw.js + mods/app-store/ |
| api/deskly | src/javascripts/os-api.js + api-grants.js |
| api/settings | src/javascripts/settings.js |
| api/log | src/javascripts/log.js |
| api/i18n | src/javascripts/i18n.js |
| api/osfs | src/javascripts/osfs.js |
| api/events | src/javascripts/app-registry.js + 各模块 CustomEvent |
| api/surface | src/javascripts/surface.js |
| api/trafficlights | src/javascripts/ui/trafficLights.js |
| api/trash | src/javascripts/trash.js |
| api/menubar | src/javascripts/menubar-status.js |
| reference/z-layers | src/javascripts/zindex.js |
| reference/redlines | dev/static-check.mjs + 上表各模块 |
| reference/dev-tools | dev/*.mjs |
| reference/changelog | docs/产品更新信息.md |

## 自检（纯静态，无依赖）

- **链接完整性**：任意可运行环境里跑
  `node -e "const fs=require('fs');let f=[];(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){e.isDirectory()?w(d+'/'+e.name):f.push(d+'/'+e.name)}}('devdocs'));const broken=[];for(const p of f.filter(x=>x.endsWith('.html'))){const s=fs.readFileSync(p,'utf8');const m=[...s.matchAll(/href=&quot;([^&quot;#]+?\.(?:html|md))/g)].map(x=>x[1]).concat([...s.matchAll(/src=&quot;([^&quot;#]+\.(?:js|css))&quot;/g)].map(x=>x[1]));for(const h of m){if(h.includes('://'))continue;const t=require('path').resolve(require('path').dirname(p),h);if(!fs.existsSync(t))broken.push(p+' -> '+h)}};console.log(broken.length?('BROKEN:\n'+broken.join('\n')):'all links ok');"`
- **事实基线**：内容过期时对照「事实来源」表改，改完把各页 `<body data-version>` 提上去。
