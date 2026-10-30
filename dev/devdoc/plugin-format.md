# 插件包格式规范

> 回到 [文档首页](index.md)

## 固定目录结构

每个插件是一个自包含目录，位于 `mods/{id}/`：

```
mods/{id}/
├── manifest.json   # 插件清单（唯一事实来源）
├── index.html      # 窗口/界面 HTML
├── style.css       # 样式
├── script.js       # 逻辑（ES Module）
└── icon.png        # 图标（程序坞/启动台/商店使用）
```

> **id 命名**：使用小写蛇形命名，如 `vs_code`、`system-settings`、`app-store`。
> `id` 会被直接拼进 `./mods/<id>/` 路径与 `script[plugin="<id>"]` 选择器，
> 因此只允许 `[A-Za-z0-9][A-Za-z0-9._-]*` 且不得含 `..`，否则拒绝注册
> （`src/javascripts/plugin-manager.js:65`、`:190`）。

## manifest.json 字段

```json
{
  "id": "calculator",
  "name": "计算器",
  "version": "1.0.0",
  "type": "app",
  "entry": "window",
  "author": "Edgerd",
  "description": "标准计算器",
  "main": "index.html",
  "style": "style.css",
  "script": "script.js",
  "icon": "icon.png",
  "window": {
    "width": 320,
    "height": 520,
    "resizable": false,
    "centered": true
  }
}
```

## 字段读取情况（以代码为准）

下表的「读取方」是对当前代码逐字段 grep 的结果。**没被读取的字段写了也没有任何效果**，
不要指望它们能改变行为。

| 字段 | 必填 | 读取方（file:line） | 说明 |
|------|------|--------------------|------|
| `id` | ✅ | `plugin-manager.js:185`（校验并作注册表键）、`:360`/`:371`/`:416`（拼资源路径） | 唯一标识 |
| `name` | ✅ | `app-registry.js`（注册表键与按名解析）；商店卡片/详情标题 `mods/app-store/script.js:card()` | 显示名（程序坞/启动台/菜单/商店） |
| `entry` | ✅ | `plugin-manager.js:337`（存在性判断分流）、`:462`（卸载时按入口定位根元素）；`mods/launchpad/script.js:104` 只列 `window` | `window` / `fullscreen` |
| `main` | ✅ | `plugin-manager.js:371`，经 `safeAssetName()`（`:77`）校验，缺省 `index.html` | 界面 HTML 文件名 |
| `style` | ✅ | `plugin-manager.js:360`，同上，缺省 `style.css` | 样式文件名 |
| `script` | ✅ | `plugin-manager.js:416`，同上，缺省 `script.js` | 逻辑脚本文件名 |
| `icon` |  | `plugin-manager.js:292` → `resolveManifestIcon()`（`:123`） | 见下方「图标解析顺序」 |
| `window.width` / `window.height` |  | `plugin-manager.js` 收进 `_wmKernelConf`，交 `window-manager.js:applyConfig()` 落实 | 初始尺寸（px）。**优先级低于应用自己在 index.html 根元素上写的 `data-window="size:…"`**，见 [插件开发](plugin-development.md) |
| `window.centered` |  | `plugin-manager.js`（与调用方传的 `centered` 取或）→ `window-manager.js:center()` | 打开时是否居中；同尺寸的第二个窗口按 24px 层叠错开 |
| `window.resizable` |  | `window-manager.js:setResizable()` 加 `.no-resize`：八条缩放边带不响应、绿键随之熄灭 | 缺省 `true`（可缩放）。同样可写在 `data-window="resizable:false"` 里，且以它为准 |
| `windowName` |  | `plugin-manager.js`（`doLoad` / `doLoadApp` 取窗口 id） | 可选：显式指定窗口元素 id，覆盖 `name`。当前无内置插件使用 |
| `apps` |  | `app-registry.js:listApps()`；消费方 `plugin-manager.loadApp/openApp`、`mods/launchpad/script.js`、`finderbar.getManifestMenus`、`plugin-manager.getIconForName` | 可选：声明本插件为**多应用插件**，形态见下方「多应用插件」 |
| `menus` |  | `finderbar.js:311`（`getManifestMenus`） | 可选：自定义该应用的顶栏菜单，形态 `{"文件":[{label, i18nKey?, shortcut?, cmd?, disabled?, separator?}]}`；`cmd` 走注册表分发（见 [架构总览](architecture.md)）。多应用插件可在每个 `apps[]` 条目里再写一份 `menus`，**同名菜单以应用级为准**，未声明的菜单保留宿主默认集 |
| `version` |  | `store-api.js:listEntries()`（卡片显示 `v<version>`）、`installZip()`（写进 `store.meta` 与安装历史，覆盖安装时给出版本差异）、`dev/package-plugin.mjs`（导出文件名 `<id>-<version>.zip`） | 展示与记账用；**不做自动更新比对**（没有远程源） |
| `type` |  | **不被 `plugin-manager` 读取**；仅 `mods/launchpad/script.js:readRegistryApps()` 过滤 `=== "app"` | 目前只有 `app` |
| `description` |  | **不被 `plugin-manager` 读取**；商店卡片与详情的缺省文案（`store.tagline` / `store.summary` 没写时用它，`store-api.js:listEntries()`） | 展示用 |
| `author` |  | **无任何读取方**（根级这个字段是死的）。要在商店详情页显示作者，写 `store.author` | 写了不显示 |
| `store` |  | `store-api.js:storeMeta()` 清洗后交 `mods/app-store/script.js:renderDetail()` 渲染 | 可选：插件在 App Store 里自声明的商店内容（分类、一句话、简介、能力、使用方法、截图等），形态见下方「商店自声明（`store`）」 |
| `formats` |  | `app-registry.js:307` `getAppByExtension()`（单应用读根级、多应用读 `apps[].formats`）、`default-apps.js:128` 回退链第三级 | 声明本应用能打开的扩展名，数组元素写 `".docx"` 或 `"docx"` 都接受。**这是声明不是绑定**：用户或插件改过默认应用后以 `defaultapps.bindings` 为准 |
| `permissions` | ✅ | `api-grants.js:249` `grantAll()`（经 `plugin-registered` 广播，内置与 ZIP 同一个入口）、`dev/static-check.mjs` 第 7 节校验；实际拦截点在 `os-api.js:53` `guard()` | 声明要用的能力，取值必须来自 `api-grants.js:29` `PERMISSION_NAMES`（15 条）。**没声明的能力调用会被直接拒绝**（返回 `ok:false`），所以哪怕无能力也要写 `"permissions": []` |
| `_installed` |  | `plugin-manager.js:168`/`:486` 由安装与还原流程写入，非用户可填 | 标记 ZIP 安装插件（缓存策略与 HTML 净化按它分流） |

## 多应用插件（`apps[]`）

一个插件目录可以对外呈现为**多个应用**（例：`mods/office/` = 文稿 / 表格 / 演示，
共享一份样式与逻辑外壳，但在启动台、Dock 运行区、顶栏菜单里各是独立应用）。
参考实现就是 `mods/office/`。

```json
{
  "id": "office",
  "name": "办公",
  "style": "style.css",
  "script": "script.js",
  "icon": "icons/suite.svg",
  "apps": [
    {
      "id": "word",
      "name": "文稿",
      "type": "app",
      "entry": "window",
      "main": "word.html",
      "icon": "icons/word.svg",
      "window": { "width": 820, "height": 720, "centered": true },
      "menus": { "文件": [{ "label": "新建文稿", "cmd": "officeNewDocument('office.word')" }] }
    }
  ]
}
```

规则（以代码为准）：

- **appId** = `<插件id>.<app.id>`（`app-registry.js:listApps()`）。`app.id` 与插件 `id`
  走同一套 `SAFE_ID` 校验，不合法的条目在注册时即被丢弃并告警。
- **不声明顶层 `main`**：每个应用一个 HTML 片段文件（缺省 `<app.id>.html`），
  片段必须**恰好含一个 `.window` 根元素**；宿主注入后把它的 `id` 强制写成
  `app.windowName || app.name`，并打上 `data-plugin-id` / `data-app-id`。
  窗口 id 是去重键，所以应用名不能与其它应用（含插件自身）的显示名相同。
- **外壳只注入一次**：首个应用打开时注入 `style` 与 `script`，之后每个应用只注入自己的
  片段。因此 `script.js` 顶层**只允许登记全局监听与菜单命令**，界面初始化必须写在
  `plugin-app-load` 回调里（事件 `detail` 为 `{ id, appId, windowName, el }`）。
  这与单应用插件「每次打开重注入脚本、顶层直接 `init()`」的约定相反，别照搬旧写法。
- **生命周期**：关单个应用派发 `plugin-app-unload`（`{ id, appId }`）；只有当该插件
  已无存活窗口时才派发 `plugin-unload` 并移除样式表与脚本元素（`plugin-manager.js:unloadApp()`
  以 `.window[data-plugin-id]` 的存活数为引用计数，不用内部账本，避免与真实 DOM 漂移）。
  全局资源（`window.__menuActions` 键、`document`/`window` 监听、定时器）仍只在 `plugin-unload` 里释放。
- **能力声明合并**：`app.window` 覆盖同名插件级 `window` 字段。
- **图标**：`apps[].icon` 与 `manifest.icon` 同一套解析与白名单；
  取图标走 `plugin-manager.getIconForName(名称或 appId)`，单应用回落到 `getIcon(id)`。
- **顶栏菜单**：`apps[].menus` 优先于插件级 `menus`；两者都只**整组替换自己声明的顶层标题**，
  未声明的标题（应用 / 编辑 / 显示 / 前往 / 窗口 / 帮助）保留宿主默认集，
  所以改一个菜单不必重抄七项（`finderbar.js:getMenusForApp`）。
- **入口分布**：启动台按 appId 展开成多格；App Store 仍是一张插件卡片，其「打开」调
  `load(插件id)` 会落到 `apps[0]`；Dock / 菜单 / 旧式 `create()` 都按显示名经
  `openApp()` 解析，不需要知道 appId 的形态。
- **接管文件类型**：`apps[].formats`（如 `[".docx", ".txt"]`，带不带点都行）声明本应用能打开哪些扩展名。
  访达双击文件时经 `app-registry.js:getAppByExtension()` 问路，命中就 `openApp(appId, { file: 路径 })`，
  并给插件派发 **`plugin-app-open`**（`detail = { id, appId, windowName, file }`）——
  窗口已存在时也会派发（换文件复用窗口）。**只有实现了 `plugin-app-open` 的应用才该声明 formats**；
  没装对应插件时 `getAppByExtension` 返回 undefined，访达行为原样退回 Quick Look 预览。
  插件级 `formats` 仍是纯文档字段（无人读取），接管只认应用级。
- **带路径启动**：宿主侧统一入口是 `plugin-manager.openApp(名称或appId, { file })`，
  `file` 是内核根目录下的路径字符串（`/文档/x.docx`，见 [系统 API 参考](os-api.md) §4.1）；单应用插件暂时收不到该参数（没有消费方，未接通）。

## 图标规则（硬性）

1. **应用图标一律 PNG，不准使用 SVG**。自绘 SVG 与 macOS 拟物图标混在一起会立刻露馅，
   且 Dock / 启动台 / 商店用的是同一张位图，缩放语义也不同。
   限制的只是**应用图标**：顶栏菜单栏的单色 glyph（如 `mods/siri/icon.svg`，
   由 `finderbar.js:registerSiriIcon()` 单独注册，与 `manifest.icon` 无关）不受此约束。
2. **新应用的图标先到 `assets/icons/` 里找**（含 `assets/icons/dock/`、`assets/icons/folder/` 子目录）。
3. **找到就复制进插件目录**（`mods/{id}/X.png`），`manifest.icon` / `apps[].icon` 只写裸文件名。
   复制而不是跨目录引用：插件要能整目录打包成 ZIP 安装，图标留在 `assets/` 里就成了包外依赖。
   （`assets/icons/` 是共享图标库，按名字被 `dock.js` 的 `iconMap` 兜底引用，**不要把库里的原文件移走**。）
4. **库里没有合适的就不声明 `icon` 字段**——不引用、不凑数、不自绘。系统会自动用占位图标：
   `plugin-manager.js` 的 `GENERIC_APP_ICON`（当前为 `assets/icons/dock/Launcher.png`），
   Dock / 启动台 / 应用商店都在 `img.onerror` 里回退到它。占位图只有一个来源，不要在别处再写死路径。

## 图标解析顺序

`getIcon(id)`（`plugin-manager.js`）按两级回退：

1. `manifest.icon` —— 插件自己的声明，**权威来源**；
2. `./mods/<id>/icon.png` —— 目录约定兜底，文件不存在时由调用方的 `img.onerror` 落到 `GENERIC_APP_ICON`。

历史上这里还夹着一张 `PLUGIN_ICON` 人工映射表（内置插件的 id → `assets/icons/X.png`）。
它存在的唯一理由是内置插件不写 `manifest.icon`；现在 14 个内置插件全部把图标带在自己
目录里（ZIP 安装要求插件目录自包含），映射表已删。

`manifest.icon` 的解析规则（`resolveManifestIcon()`）：

- `assets/…`（可带 `./` 前缀）按**站点根**相对解析；
- 其它值相对**插件目录 `./mods/<id>/`** 解析，因此 `icon.png` 与历史的
  `../../assets/icons/X.png` 写法都可用（新插件按上面的规则写裸文件名）；
- 只接受最终落在 `./mods/<id>/` 或 `./assets/` 内的结果，越界（含带 `..` 的伪装写法、绝对 URL）一律回退到下一级。

多应用插件用 `getIconForName(名称或 appId)`：`apps[].icon` 优先，未声明则继承插件级 `icon`，
再落回上面三级 —— 所以套件里某个应用缺图时显示的是套件图标，而不是占位图。

## 相对路径约定

插件目录 `mods/{id}/` 与 `src/`、`assets/` 平级，引用根资源统一加 `../../`：

| 引用目标 | 写法 |
|----------|------|
| 根图片 | `../../assets/images/xxx.svg` |
| 根图标 | `../../assets/icons/xxx.png` |
| 共享 JS | `../../src/javascripts/xxx.js` |
| 共享 UI | `../../src/javascripts/ui/contextMenu.js` |

> import 说明符**不要带 `?v=` 查询串**：带串与不带串会被浏览器当成两个不同模块，
> 导致核心模块被求值两次（两份状态互相覆盖全局钩子）。规则见 [开发文档首页](index.md) 的「版本与更新」。

上表的 `../../` 只对两类引用是必需的：**`import` 说明符**与 **CSS 的 `url()`** —— 它们相对文件自身解析。
而 JS 代码里产生的运行时 URL（`<img src>`、`fetch()`、`Notification.icon`、`new Image().src`）
相对**文档**解析，插件里写 `../../assets/…` 只是越过根目录后被浏览器截断回同一处，
看起来能用、实为巧合。因此 **JS 内的资源路径一律 import `src/javascripts/paths.js`**
（站点根相对的 `./assets/…` / `./mods/<id>/…`，宿主与插件共用同一份定义），
HTML 片段里沿用的 `../../assets/…` 标记保持不动。

## 商店自声明（`store`）

App Store 的详情页只渲染插件**自己声明**的内容，没写的区块就不出现（界面不编文案，也不放占位说明）：

```json
"store": {
  "category": "办公",
  "tagline": "文稿 / 表格 / 演示三件套",
  "summary": "详情页「简介」正文，可换行。",
  "features": ["能力一", "能力二"],
  "usage": "详情页「使用方法」。",
  "updated": "2026-10-06",
  "author": "Edgerd",
  "homepage": "https://example.com",
  "screenshots": ["screens/one.png", "screens/two.png"]
}
```

清洗规则在 `store-api.js:storeMeta()`，越界的部分会被静默丢掉，别指望写超长能显示全：
`category` 24 字、`tagline` 120 字、`summary` / `usage` 600 字、`author` 60 字、`updated` 20 字、
`features` 最多 12 条（每条 120 字）。

- **`screenshots` 是插件目录内的相对路径**，由宿主拼成 `./mods/<id>/<file>` 并按来源加 `?v=` 戳；
  只接受 `.png/.jpg/.jpeg/.webp`、拒绝含 `..` 的路径，先剔非法再截前 6 张。
  用 PNG（与应用图标同一条硬性规则）。
- 截图取不到**不会**让安装失败（`verifyInstall()` 把它归进 `optionalMissing`），
  但 `dev/package-plugin.mjs` 在导出 ZIP 时会因为「声明了却不在目录里」直接拒绝打包。
- `homepage` 只接受 `http(s)://` 开头，其它协议（`javascript:` 等）一律丢弃。
- **权限不写在 `store` 里**：详情页的权限一栏读 `manifest.permissions`，
  经 `api-grants.js:describe()` 出人类可读文案，与真正的授权账本同源。
- 所有文案都以 `textContent` 写入 DOM —— 清单是不可信输入，商店不解析 HTML。

## 打包分发

插件目录打包为 ZIP 后，拖入应用商店（或点「安装 ZIP…」选文件）即可安装。
**ZIP 内 `manifest.json` 必须位于包根**，或者整包放在同一个顶层目录下
（`store-api.js:commonRoot()`：只要包根有文件就不存在公共根，否则 `codecs/` 这类真实子目录
会被误当公共根剥掉、落库成扁平键，运行时按 `mods/<id>/codecs/x.js` 请求必然 404）。
安装不会把文件写到磁盘的 `mods/{id}/`：文件以 Blob 存入 IndexedDB（`plugin-manager.js:registerInstalledPlugin()`），
由 `sw.js` 拦截 `./mods/<id>/<file>` 请求后从库里返回，并在响应上写 `X-Deskly-Plugin` 标记头。
安装器靠这个标记头判断「页面到底有没有被 SW 接管」，接管不了就整段失败并回滚。详见 [应用商店](app-store.md)。

## 导出 ZIP 安装包

内置插件的**唯一真源就是 `mods/<id>/`**（扩展加载时整目录一起打进去）。需要把同一个插件
分享给别人、或走 App Store 安装链验证时，再导出一次 ZIP：

```
node dev/package-plugin.mjs office      # 产物 dist/office-<version>.zip
```

- 不存在第二份源码目录：ZIP 只是 `mods/<id>/` 的导出物，避免「改了 mods/ 却拿旧 ZIP 去装」的分裂。
- 打包脚本用宿主页同一份 `assets/vendor/jszip.min.js`，包内条目一律 POSIX `/` 分隔；
  不用 PowerShell `Compress-Archive`（其条目名历史上带 `\`，安装器与 SW 的 `/` 路径命中不了）。
- 打包即校验：`manifest.id` 必须等于目录名（否则装成另一个 id）、`manifest.json` 必须在包根、
  解包总字节数不得超过安装器上限 10MB（`app-store.js:MAX_TOTAL_BYTES`）；并扫描代码里的相对依赖 ——
  `./x.js`、`useStyle(import.meta.url, "x.css")`、CSS `@import` 必须落在插件目录内，
  `../../src/…` 宿主依赖必须在仓库里存在。少打一个文件在运行时只会表现为「窗口开出来但空白」，
  这一关必须在构建期断掉。
- `dist/` 已在 `.gitignore` 里：它是构建产物。
