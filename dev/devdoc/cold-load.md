# 冷加载机制

> 回到 [文档首页](index.md)

## 目标

**启动时只注册清单，点击启动时才加载对应内容**，实现「启动插件程序后再加载内容」的按需加载，减少首屏加载开销。

## 两个阶段

### 阶段一：启动注册（仅清单）

启动时 `plugin-manager.init()`（`src/javascripts/plugin-manager.js:408`，由 `bootstrap.js:215` 调用）
按 `BUILTIN_IDS` 逐个 `fetch('./mods/{id}/manifest.json?v=<VERSION>')`（`:411`）建立注册表 `registry`，
再从 localStorage 的已安装清单索引还原 ZIP 插件（索引缺失时回退 IndexedDB，`:417`），最后派发 `plugins-ready`（`:448`）。

- `BUILTIN_IDS` 当前是 **13 个**内置 id：calculator、finder、launchpad、system-settings、about、
  app-store、notepad、photos、vs_code、siri、safari、office、manual。
  刷新首屏的 Network 面板因此应看到 **13 个 `manifest.json` 请求**。
  （图片 / 视频查看能力已并入「照片」，不再单独发布查看器插件。）
  （`office` 是**多应用插件**：一份清单里声明文稿 / 表格 / 演示三个应用，注册表会展开成
  `office.word` / `office.excel` / `office.ppt` 三条应用记录，见 [插件包格式](plugin-format.md)。）
- 清单请求带 `?v=<VERSION>`：`VERSION` 来自 `version.js`，同一发布内可复用 HTTP 缓存，随发布自动失效。
- 只注册清单，不加载任何界面 / 样式 / 脚本。
- 程序坞监听 `plugins-ready` 后校准图标（`dock.js:956`），启动台与 App Store 据注册表渲染。

### 阶段二：点击加载（按需）

点击已注册插件时，`plugin-manager.load(id)`（`:309`）按**顺序**拉取并注入三件资源
（不是并行：样式先追加，HTML 必须 fetch 完才能注入，脚本要在 HTML 就位后才执行）：

1. `style.css` → 追加 `<link id="plugin-style-<id>">` 到 `<head>`，**按 id 去重**（`:355`、`:360`）。
2. `index.html` → fetch 后 `document.body.insertAdjacentHTML("beforeend", html)`（`:371`、`:379`）。
3. `script.js` → 追加 `<script type="module" plugin="<id>">`，**每次都先删旧脚本再注入新的**（`:416`）。
4. 若注入了新的 `.window`，交给 `window.js` 的 `resetWindowListeners`（转调 `window-manager.manage()`）绑定窗口行为，并按 `data-window` / `manifest.window` 落实尺寸与能力。

`load()` 自带并发去重：同一 id 在加载中时复用同一个 Promise（`loadingMap`，`:300`），
避免连点两次注入两份界面与两个脚本实例。

## 缓存戳的真实语义（重要）

三件资源的 `?v=` 取值各不相同，是有意为之（`plugin-manager.js:326`）：

| 资源 | 戳值 | 语义 |
|------|------|------|
| `manifest.json` | `VERSION`（`:152`） | 随发布失效，同一发布内复用 |
| `style.css` / `index.html` | 内置插件用 `VERSION`，ZIP 安装插件用 `Date.now()`（`:326`） | 已安装资源可被同 id 覆盖安装，必须每次取新 |
| `script.js`（入口） | **永远 `Date.now()`**（`:416`） | 见下 |

入口脚本**故意不去重**：插件都在脚本顶层执行 `init()`，若 URL 稳定，ES module 缓存会命中，
第二次打开不再运行任何逻辑（表现为「二次打开失效」）。代价是模块表不会回收旧实例 —— 由此产生两条硬约束：

1. **插件必须在 `plugin-unload` 回调里释放自己注册的全局资源**（`document`/`window` 监听、定时器、轮询、
   `window.__*` 钩子）。旧实例的监听不会随脚本元素被移除而消失，会永久累积。
   现内置插件均遵守此约定，例：`mods/finder/script.js:427`、`mods/notepad/script.js:446`、
   `mods/system-settings/script.js:453`、`mods/photos/script.js:1171`。
2. **被入口脚本 import 的子模块只有一份实例**（它们的 URL 稳定，跨多次打开复用）。
   因此入口的 `init()` 必须自己复位状态，并对订阅去重 —— 不能假设「新实例 = 干净状态」。

## 卸载

窗口关闭时由 `window.js` 的 `finish()` 调 `plugin-manager.unloadApp(pluginId, appId)`
（读 `win.dataset.pluginId` / `win.dataset.appId`），依次：
派发 `plugin-app-unload` → 数一遍 `.window[data-plugin-id=<id>]` 的存活窗口（排除 `.closing`）→
**仍有兄弟应用存活就到此为止**（外壳样式与脚本留着）；只剩 0 个才转 `unload(id)`，
依次派发 `plugin-unload` → 移除该插件的全部窗口 DOM（`fullscreen` 入口按 `.launchpad` 类名找，无 id）→
移除 `plugin-style-<id>` → 移除 `script[plugin=<id>]`。

引用计数取 DOM 而非内部账本：窗口可能被关闭动画、插件自身或强制退出摘除，账本会漂移。

`plugin-unload` / `plugin-app-unload` / `plugin-app-load` 都在 **`document` 上派发且 `bubbles: true`**
（`app-registry.js:broadcast()`），所以挂在 `window` 或挂 `document` 上的监听都能收到；内置插件一律挂 `window`。

## 入口接线

`window.js` 的 `create()`（现为 `async`）先按显示名查注册表
（`lookupPlugin()` → `window.__getPluginByName`，`app-registry.js` 模块顶层挂出），命中就转交插件管理器：

```js
if (plugin) {
  import("./plugin-manager.js").then(({ openApp }) => {
    openApp(name, { light, centered });
  }).catch((err) => {
    console.error("Error loading plugin:", plugin.id, err);
  });
  return;
}
```

程序坞、启动台、菜单栏共用同一条链路，因此冷加载对所有入口生效。
交给 `openApp()` 而不是 `load()`：它按名称解析 appId，多应用插件的子应用名
（`mods/office/` 的「文稿 / 表格 / 演示」）才不会永远落到套件的首个应用。

注册表是异步建立的：启动瞬间点开的插件应用会因 registry 仍为空而落到旧式 App 分支，
去 `fetch` 一个不存在的 `./assets/apps/<name>.html`，弹出假的「此 App 仍在开发中」404。
`create()` 因此在未命中时 `await window.__pluginManagerReady()` 再判一次
（钩子在 `app-registry.js` 模块顶层挂出）。已存在窗口的复用判断也不再裸用 `getElementById`，
而是 `findAppWindow()` 校验 `.window` 类与 `dataset.pluginId`，避免同名应用互相抢窗口。

## 验证方法

1. 打开 DevTools 的 Network 面板。
2. 刷新页面：应只看到 **13 个** `mods/*/manifest.json` 请求（已安装插件的还原走本地索引，不产生网络请求）。
3. 点击程序坞「计算器」：此时才出现 `mods/calculator/index.html`、`style.css`、`script.js` 请求。
4. 关闭计算器再打开：`index.html` / `style.css` 命中缓存（URL 相同），`script.js` 必然重新请求
   （URL 带新时间戳）—— 这是设计行为，不是泄漏。
5. 多应用套件（`mods/office/`）：依次打开文稿、表格、演示，Network 里应有 **一份**
   `style.css` + 一份 `script.js` 与 **三份** 各自的 `word.html` / `excel.html` / `ppt.html`；
   关掉其中两个后样式与脚本仍在，关掉最后一个时 `plugin-style-office`、`script[plugin="office"]`
   与 `window.__menuActions.officeNewDocument` 一起消失。

## 相关文档

- [架构总览](architecture.md)
- [插件包格式](plugin-format.md)
- [插件开发指南](plugin-development.md)
