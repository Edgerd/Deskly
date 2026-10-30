# 架构总览

> 回到 [文档首页](index.md)

## 系统分层

```
┌─────────────────────────────────────────────┐
│              应用层（插件窗口）              │
│  访达 / 计算器 / 系统设置 / 关于本机 / 商店  │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│               插件管理器                     │
│   注册表 · 冷加载 · 注入 · ZIP 安装          │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│              窗口 / 桌面层                    │
│   window.js · dock.js · finderbar.js        │
│   desktop.js · ui/（contextMenu · alert ·   │
│   menuCommands · notification） · zindex.js │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│                基础能力层                    │
│   i18n · wallpaper · appearance · surface   │
│   osfs · vfs · session · cursor · version   │
└─────────────────────────────────────────────┘
```

## 模块职责

| 模块 | 职责 |
|------|------|
| [plugin-manager.js](../../src/javascripts/plugin-manager.js) | 插件注册表、冷加载、注入、卸载、ZIP 安装接口 |
| [window-manager.js](../../src/javascripts/window-manager.js) | 窗口机制全部：焦点层级、拖动、八向缩放、缩放/全屏/最小化、平铺吸附、应用侧 `data-window` 声明 |
| [window.js](../../src/javascripts/window.js) | 旧式 App 装载 `create()` + 窗口层兼容门面（同名转调 window-manager） |
| [dock.js](../../src/javascripts/dock.js) | 程序坞图标、启动、右键菜单、缩放动画 |
| [finderbar.js](../../src/javascripts/finderbar.js) | 顶部菜单栏、应用菜单、系统状态；命令实现挂在 `window.__menuActions`（`:1242`）、顶栏右侧插件图标由 `registerFinderbarIcon()`（`:819`）挂 |
| [ui/menuCommands.js](../../src/javascripts/ui/menuCommands.js) | 菜单命令分发：注册表查表调用，不做任何字符串求值 |
| [store-api.js](../../src/javascripts/store-api.js) | 应用商店的数据与动作层（不碰 DOM）：列表聚合、分类与搜索、ZIP 安装（预检 → 权限确认 → 落库 → 逐个回读校验 → 失败回滚）、卸载、启用/禁用、安装历史。界面在 `mods/app-store/` |
| [settings.js](../../src/javascripts/settings.js) | 设置中枢：全系统唯一的设置读写链路（校验 → 落盘 → 生效 → 广播 → 记日志），定义表带界面元数据供系统设置自动渲染，挂 `window.__settings`（`:602`）。**分层：不 import 任何模块**，日志只经 `window.__log` 可选引用（契约 `:19`，实现 `:61`–`:63`），所以它躺在依赖图最底层，谁都能引它 |
| [settings-definitions.js](../../src/javascripts/settings-definitions.js) | 既有 owner 模块的设置定义表（键名 / 存储槽 / 默认值 / 生效函数 / 控件元数据的单一来源），由 `bootstrap.js:142` 注册。**只登记历史 owner**：锁屏 / 声音 / 显示器 / 聚焦搜索等新模块在自己文件里 `settings.define()` 自注册（约定见 `:13`–`:14`），owner 才是取值范围的权威 |
| [log.js](../../src/javascripts/log.js) | 运行记录：分级（debug<info<warn<error）+ 分来源（`kernel/<模块>` / `plugin/<id>`）的环形缓冲与跨刷新留存，并自动接管 `console.*` 与未捕获异常，挂 `window.__log`（`:593`）。**分层：只 import `settings.js`**（`:23`），自己的 6 项 `debug.*` 在 `:65`–`:111` 注册，不反向依赖任何 owner 模块 |
| [surface.js](../../src/javascripts/surface.js) | 亚克力表面：把「模糊等级」换算成 `--surface-blur-unit` 与 `--surface-blur-1..4` 写到 `<html>`，并按推导出的底色强制黑/白文字色 `--surface-text`；三项设置 `appearance.blurLevel` / `tintStrength` / `tintHue` 在自己文件里自注册（`:366`–`:390`），挂 `window.__surface`（`:428`，另导出 `surface` / `BLUR_LEVELS` `:426`、`initSurface` `:417`）。**分层：import `settings.js` + `log.js` + `wallpaper.js`**（`:29`–`:31`，取壁纸主色），`wallpaper.js` 只 import `paths.js`（`:44`）、`appearance.js` 只 import `wallpaper.js`（`:20`），都不反向依赖它，所以无环；全仓唯一的静态 import 方是 `bootstrap.js:45`（排在 `initAppearance()` `:153` 之后调 `initSurface()` `:155`），其余消费者只读全局：`spotlight.js:456`、`ui/notification.js:150`，样式表侧只引用令牌（`assets/stylesheets/main/main.css:101`–`:126`）。插件用法见 [系统 API 参考](os-api.md) §五 |
| [osfs.js](../../src/javascripts/osfs.js) | **存储内核**：单一根目录 + 两种后端（未挂载时整棵树在 IndexedDB `webstartos-vfs.virtualfiles`，挂载后逐段映射到用户选的真实文件夹）+ 按插件分仓的 `scope(id)`。路径约定（`/文档`、`/AppData/<id>/{temp,config,data}`）的唯一来源，`globalThis.__osfs`。**分层：不 import 任何项目模块**，避免与 vfs/log 成环 |
| [vfs.js](../../src/javascripts/vfs.js) | 文件树的**展示门面**：把内核条目翻成访达/聚焦/Dock 需要的形状，加上内核特有的收藏夹（`chrome.bookmarks`，不支持时 localStorage 虚拟书签）与「最近使用」魔法路径。存储本体不在这里 |
| [zindex.js](../../src/javascripts/zindex.js) | 全站唯一浮层层级表 `Z` 与普通浮层提升逻辑 |
| [version.js](../../src/javascripts/version.js) | 版本号唯一来源 `VERSION`（`bootstrap.js`、`plugin-manager.js`、`session.js`、`mods/about` 都从这里取） |
| [main.js](../../src/javascripts/main.js) | 入口，仅串联初始化，不写业务逻辑 |

## 运行模型

- **同文档注入，不是 iframe**：插件的 `index.html` 被 `document.body.insertAdjacentHTML("beforeend", …)`
  注入宿主文档（`plugin-manager.js:533`，多应用路径 `:397`），插件脚本是宿主页面里的普通 `<script type="module">`
  （`plugin-manager.js:567`），**直接 `import` 宿主的 ES 模块**（`../../src/javascripts/...`）。
  不存在宿主与插件之间的 `postMessage` 协议，也没有沙箱 —— 历史文档这么写过，是错的。
- **带来的安全后果**：ZIP 安装的插件是不可信输入，而它与宿主同权限运行，能读写 `localStorage`、
  IndexedDB、`window.*` 全局。代码层只做了两件事收紧边界：
  1. 注入前净化 HTML：`sanitizePluginHtml()`（`plugin-manager.js:115`）剥掉 `<script>`、
     `on*` 内联事件处理器与 `javascript:`/`data:` 链接，仅对 `_installed` 插件执行（`:532`、多应用 `:396`）；
  2. MV3 扩展页 CSP 为 `script-src 'self'`，内联脚本与 `new Function`/`eval` 在运行时被拒
     （这就是菜单命令改为注册表分发的原因，见 `ui/menuCommands.js:4`）；
  3. 文件写入有作用域：`OSFS.scope(id)` 只允许活动在本插件的 `/AppData/<id>/` 之内
     （`osfs.js` 的 `inside()` 先规范化再比前缀，`..` 在规范化阶段就被丢掉）。
  **这三条都不构成安全边界** —— 插件照样能 `import { OSFS }` 用根级 API 写任何路径，
  作用域只是让「按插件分仓」在正常写法下自然成立，别把它当沙箱。
  净化只针对「HTML 里的可执行内容」，**不校验插件脚本本身的逻辑** —— 安装第三方 ZIP 等同于运行第三方 JS。
- **窗口控制集中**：拖拽/缩放/关闭/最小化/缩放与全屏/置顶统一由 `window-manager.js` 负责（红绿灯组件的 `deskly:window-action` 即其接口，窗口元素上的 `winctl` 是实例侧入口），插件与内核其它模块都不自带第二套。尺寸与可缩放性由应用自己在窗口根元素的 `data-window` 上声明，清单只是缺省。
- **插件自包含**：每个插件只依赖 `mods/{id}/` 目录内的文件，根资源通过 `../../` 相对路径引用。

## 关键决策

1. **冷启动**：启动时只拉取各插件 `manifest.json` 建立注册表（内置 id 清单见
   `plugin-manager.js:62` 的 `BUILTIN_IDS`），不加载任何界面内容。
2. **点击加载**：点击已注册插件时才拉取资源，且是**顺序**而非并行 ——
   样式 `<link>` 先追加（`plugin-manager.js:514`），`index.html` 必须 await 完才能注入（`:525`、`:533`），
   脚本在 DOM 就位后才追加（`:567`）。见 [冷加载机制](cold-load.md)。
3. **入口脚本每次打开都重新执行**：URL 带 `Date.now()` 强制新实例（`:567`），
   由此要求插件在 `plugin-unload` 里自清全局资源。
4. **Safari 已并入插件**：Safari 现为 `mods/safari/` 标准插件（`BUILTIN_IDS` 成员，
   多标签 / 书签 / 历史 / 新标签页），与其余内置应用一致。旧式 `window.js create()`
   遗留路径（`assets/apps/Safari浏览器.html` + `src/javascripts/apps/Safari浏览器.js`）
   已移除。
5. **层级单一来源**：所有浮层层级取自 `zindex.js` 的 `Z` 表，见 [层级表](z-layers.md)。

## 相关文档

- [系统 API 参考](os-api.md)
- [插件包格式](plugin-format.md)
- [插件开发指南](plugin-development.md)
- [冷加载机制](cold-load.md)
- [应用商店](app-store.md)
- [层级表](z-layers.md)
