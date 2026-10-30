# 应用商店（App Store）

> 回到 [文档首页](index.md)

商店界面整个住在插件里（`mods/app-store/`：`index.html` + `script.js` + `style.css`），
宿主侧只有一份**不碰 DOM** 的数据与动作层 [`src/javascripts/store-api.js`](../../src/javascripts/store-api.js)。
分层曾经倒置过：宿主伸手进插件 DOM 画卡片、插件再用 MutationObserver 往宿主画的卡片上补按钮，
现在两边各自守自己的边界。

## 入口

- 菜单栏「App Store...」
- 程序坞的应用商店图标
- 启动台里的应用商店图标

## 界面

- **侧栏**：分类列表（全部 / 已内置 / 已安装 / 已禁用，外加各插件 `store.category` 自动聚合出来的分组）
  + 「安装记录」+ 资源代理（Service Worker）接管状态。计数每次注册表变化都会重算。
- **卡片网格**：图标、名称、`store.tagline`（没写就退回 `description`，最多两行）、版本、来源徽章，
  以及一颗动作按钮（启用态是「打开」，禁用态是「启用」）。点卡片进详情页。
- **详情页**：头部（大图标 + 名称 + tagline + 版本 / 分类 / 开发者 / 应用数 + 动作区）
  → 截图条 → 简介 → 能力 → 使用方法 → 包含的应用 → 权限 → 信息 → 主页。
  内容全部来自插件清单，**没声明的区块直接不渲染**，界面不编文案。
- **顶部工具条**：返回、当前分类标题与计数、「安装 ZIP…」（选文件），整个窗口也是拖放热区。
- **状态条**：安装进度、结果、启用 / 禁用与卸载回执；没有消息时整条隐藏。
- **键盘**：方向键在卡片间移动、`Enter` 进详情、`Esc` 返回列表。
- **主题**：明暗两套令牌（`html[data-theme="dark"]`），侧栏走系统亚克力令牌，
  关掉毛玻璃（`data-transparency="off"`）与墙纸着色都有对应档位。

## 顶栏菜单

`mods/app-store/manifest.json` 的 `menus.显示` 声明条目，命令由插件注册到 `window.__menuActions`
（`storeShowCategory` / `storeShowHistory` / `storePickZip` / `storeVerifyCurrent`），卸载时摘掉。
宿主 `finderbar.js` 里那份 `仅已安装 / 仅可更新 / 显示全部` 的 `disabled:true` 占位已删除——
「待更新」从来没有实现过（没有任何远程源可比对版本），留着只会让人以为有更新机制。

## 插件如何自声明商店内容（`manifest.store`）

商店里能看到的所有文字与图，都来自插件自己目录里的 `manifest.json`：

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

| 字段 | 上限与清洗（`store-api.js:storeMeta()`） |
| --- | --- |
| `category` | 24 字；相同分类在侧栏自动聚合成一组 |
| `tagline` | 120 字；卡片副标题，缺省用 `description` |
| `summary` | 600 字；详情页「简介」，缺省用 `description` |
| `features` | 最多 12 条，每条 120 字 |
| `usage` | 600 字 |
| `updated` | 20 字；展示在「信息」 |
| `homepage` | **只接受 `http(s)://`**，其它一律丢弃（`javascript:` 等不会进 DOM） |
| `author` | 60 字 |
| `screenshots` | 相对插件目录的路径；只收 `.png/.jpg/.jpeg/.webp` 且不含 `..`；先剔非法再截前 6 张 |

- 权限一栏**不读 `store`**，读 `manifest.permissions` 并经 `api-grants.js` 的 `describe()` 出人类可读文案，
  敏感项标「敏感」——这样商店显示的与实际授权账本对得上。
- 界面文案全部用 `textContent` 写入，清单里的任何字段都不会被当 HTML 解析。
- 截图路径按 `?v=` 加戳：内置插件按发布版本号，ZIP 安装的按安装时间戳（覆盖安装必然失效）。
- 已声明但取不到的截图：卡片图上 `onerror` 摘掉那一格；安装也不因此失败（见下）。

## ZIP 安装：要么完整成功，要么什么都没发生

`store-api.js:installZip()` 的顺序，任何一步失败都返回结构化原因且不留半成品：

1. **预检**：是不是 `.zip`、JSZip 在不在、`manifest.json` 是否在包根（或整包同一个顶层目录下）、
   `id` 合法性（`[A-Za-z0-9][A-Za-z0-9_-]{0,63}`，禁止路径与 `..`）、是否与内置插件撞名。
2. **解包**：按 Blob 收集（二进制安全），剥公共顶层目录前缀；只要包根有文件就不存在公共根
   （否则 `codecs/` 这类真实子目录会被当根剥掉，落库成扁平键，运行时必然 404）。
   累加字节超过 **10MB** 直接中止。
3. **权限确认**：`showPermissionChecklist(manifest)`（`api-grants.js`）列出声明的能力，
   点「取消」整段终止、不落库。
4. **落库并注册**：写 IndexedDB（库 `webstartos-plugins` / 表 `installed`）+ 注册表。
5. **回读校验**：`verifyInstall(id)` 逐个请求清单声明的**必需**资源——`style`、`script`、`icon`、
   `main`（或每个 `apps[].main` / `apps[].icon`），判定依据是响应上的 **`X-Deskly-Plugin` 标记头**
   （由 `sw.js` 在从 IndexedDB 返回时写上）。没有标记头＝请求根本没经过 SW（页面未被接管），
   有 404＝包内缺文件；两种都**回滚**刚写入的记录并回报缺哪个文件。
   截图这类可选资源缺失只进 `warnings` / `optionalMissing`，不拦安装。
6. **记账**：`store.meta`（安装时间、字节数、文件数、来源包名、版本）与 `store.history`（最近 50 条）。

同 `id` 已安装时返回 `already-installed`（附新包版本），界面先展示「当前 x → 新 y」再决定是否覆盖。

## 启用 / 禁用

- 状态落在设置中枢 `store.disabled`（定义在 `app-registry.js`，唯一读写口是
  `disabledIds()` / `isPluginEnabled()` / `setPluginEnabled()`），改了广播 `plugin-enabled-change`。
- **禁用是真的禁用**：`plugin-manager.load()` / `loadApp()` 直接拒绝；程序坞点击被拦下并给提示；
  启动台不渲染该应用（但布局条目保留，重新启用回到原位）；聚焦搜索过滤掉它；
  `getAppByExtension()` 也不再让它接管文件格式。
- 内置插件可以禁用、不能卸载；ZIP 安装的插件卸载时会先按正常关闭流程收掉它还开着的窗口
  （`window._closeWindow()`），避免「有小圆点没界面」的钉子户。
- 应用商店自身不可禁用——把它关掉就再没有界面能把任何插件打开。

## 发布与打包

- 插件以 ZIP 分发。**安装不写磁盘**：文件存 IndexedDB，`sw.js` 拦截 `/mods/<id>/<file>` 后从库里返回。
  刷新后由 `plugin-manager.init()` 还原注册。
- `chrome-extension://` 下 SW 注册与接管是**可用**的（早前文档里「会被 Chromium 拒绝」是未经证实的判断，已删）。
  真正需要防的是「注册成功但页面还没被接管」，所以安装路径靠标记头实测，不靠猜。
- 导出安装包：`node dev/package-plugin.mjs <id>` → `dist/<id>-<version>.zip`。
  导出前会校验清单声明的资源是否都在目录里，**包括 `store.screenshots`**（截图缺失在安装时只算提醒，
  但打进包之前应该齐）。

## 校验

- `node --experimental-vm-modules dev/store-check.mjs` — 数据层 80 条断言（清单清洗、分类与搜索、
  启用态与广播、SW 标记头判定、成功 / 失败 / 回滚 / 覆盖 / 卸载 / 历史上限）。
- `node dev/static-check.mjs` — 跨模块静态一致性（引用、资源、语言包、层级令牌）。
- 浏览器实测：见「启用 / 禁用」与「ZIP 安装」各条链路，需真实 SW 与 IndexedDB。

## 相关文档

- [插件包格式](plugin-format.md)
- [插件开发指南](plugin-development.md)
- [冷加载与插件生命周期](cold-load.md)
- [架构总览](architecture.md)
