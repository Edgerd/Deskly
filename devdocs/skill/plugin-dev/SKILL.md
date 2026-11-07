---
name: plugin-dev
description: Build a Deskly desktop plugin (mod) per this repo's conventions — use when asked to create, modify, or package a plugin under mods/ (triggers 写插件, 做 mod, 打包插件). Do not use for kernel changes under src/.
---

# Deskly 插件开发

你要为 Deskly（浏览器新标签页里的 macOS 桌面，MV3 扩展，纯 HTML/CSS/JS，无构建链）产出一个插件（mod）。
产出物是 `mods/<id>/` 下的一个自包含目录。先读完本文件再动手；模板文件在 `templates/` 下，复制后改名改文案即可。
交付前逐条过 `checklist.md`。

## 0. 运行模型（先纠正一个常见误解）

- **没有沙箱 iframe，也没有 postMessage 协议。** 插件由 plugin-manager 把 index.html / style.css / script.js
  **注入宿主主文档**运行：你的 `document` 就是整个桌面，选择器必须带自己的窗口类名前缀。
- 能力边界不是隔离，而是**权限账本**：`manifest.permissions` 声明 + `window.Deskly` 受管方法 +
  api-grants 账本（敏感权限首次调用弹「拒绝 / 仅此一次 / 始终允许」）。
- 因此「越权」的真实形态是：调用没声明的 Deskly 方法（直接 `ok:false`）、或绕过 Deskly 直接摸别处的
  DOM / 别的插件的 `/AppData`。前者系统拦，后者靠你自律——两者都算违规交付。
- 浏览器级硬边界只有 MV3 默认 CSP `script-src 'self'`：**eval / new Function / 内联 on* 属性 / 外链脚本一律不可用**。

## 1. 目录结构与文件清单

```
mods/<id>/
├── manifest.json   # 清单（唯一事实来源）
├── index.html      # 界面片段，恰好一个 .window 根
├── style.css       # 样式，选择器全部以你的窗口类开头
├── script.js       # ES Module，顶层 init() + plugin-unload 清理
└── icon.png        # PNG 图标（可选，缺省自动落占位图）
```

- id：小写蛇形，合法字符集 `[A-Za-z0-9][A-Za-z0-9._-]*`，不含 `..`，**必须等于目录名**。
- 文件名只能单层（`safeAssetName` 校验），禁止 `../../x` 这类越目录引用。
- 内置插件要把 id 加进 `src/javascripts/plugin-manager.js` 的 `BUILTIN_IDS`；商店分发不用。

## 2. manifest.json 字段

必填：`id`、`name`、`entry`（`window` 或 `fullscreen`）、`permissions`（**用不上也写 `[]`**）。
可选且有人读：`main`/`style`/`script`（缺省三个约定名）、`icon`（裸文件名）、`window.*`（尺寸，会被 HTML 的 `data-window` 覆盖）、
`apps[]`（多应用套件）、`menus`（顶栏菜单整组替换）、`version`/`type`/`description`（商店展示）、`store`（商店详情自声明）、
`formats`（文件类型接管：**单应用插件写根级**，多应用套件写 `apps[].formats`——内核两处都会读）。
**写了没人读的**：根级 `author`（要写 `store.author`）。
权限名只能来自 22 条：`apps:launch`、`default-apps:read`、`default-apps:write`、`widgets`、`dynamic-icons`、
`window-style:self`、`window-style:others`、`theme:apply`、`files:read`、`files:write`、
`system-patch:dock/finderbar/desktop/wallpaper/menu`、`window:read-others`、`window:manage-others`、
`window:chrome`、`window:level`、`quicklook:register`、`menus:register`、`shortcuts:write`。按需声明，不堆权限。

## 3. index.html（片段，不是完整网页）

- 恰好一个 `.window` 根；用 `data-window` 声明尺寸能力。键名 camelCase / kebab / 全小写都认，分四组：
  ① 尺寸简写 `size:WxH`、`min:WxH`、`max:WxH`，或按字段写数字 `width`、`height`、`minWidth`、`minHeight`、`maxWidth`、`maxHeight`；
  ② 布尔 `resizable`、`minimizable`、`maximizable`、`centered`、`draggable`、`fixed`、`modal`、`multiWindow`（写 `:true/:false`，裸键即 true）；
  ③ 字符串 `role`、`parent`、`level`、`dragAxis`、`resizeAxis`、`snap`、`titlebar`、`trafficLights`；
  ④ 特殊 `aspectRatio`（`16:9` 或数值）、`dragBounds`（`visible` 或 `x,y,w,h`）。
  表外键会被忽略并打 console 警告。
- 红绿灯：标题栏内放 `<deskly-traffic-lights class="wintools" placement="titlebar"></deskly-traffic-lights>`
  （父元素必须带 `data-titlebar`）；无标题栏的内容型界面用 `overlay`；对话框用 `variant="dialog"`；可用 `no-zoom` / `no-minimize` / `no-close` 收紧。
- 文案翻译：`data-i18n="ns.key" data-i18n-fallback="兜底文案"`，标记内不放 HTML。

## 4. script.js（冷加载两条铁律）

1. **入口脚本每次打开都重跑**（系统故意给全新 URL）。顶层做幂等 `init()`；所有全局资源
   （document/window 监听、定时器、`window.__*` 钩子、`__menuActions` 键、settings/i18n 订阅）
   必须在 `plugin-unload` 回调里按 `e.detail?.id === "<你的id>"` 认领并释放。
2. **被 import 的子模块只有一份实例**（URL 稳定跨打开复用）：init() 自己复位状态，订阅先去重。

多应用套件（`apps[]`）相反：顶层只登记全局监听与菜单命令，界面初始化写在 `plugin-app-load` 回调里
（detail = `{id, appId, windowName, el}`）；能打开文件的应用另听 `plugin-app-open`（detail 含 `file`）。

import 内核模块写 `../../src/javascripts/xxx.js`（相对文件自身）；**import 说明符永不带 `?v=`**。

## 5. 主题与 i18n

- 主题是 `html[data-theme="light"|"dark"]`（「自动」由系统解析成具体值落到该属性）。
  你的样式用 CSS 变量与 `html[data-theme="dark"] .your-window …` 选择器覆盖即可；不要写死浅色色值。
- 毛玻璃：`backdrop-filter: blur(var(--surface-blur-N))`（N=1..5，常规面板用 3）；文字色 `var(--surface-text)`；
  背后就是墙纸的表面用 `var(--surface-text-wallpaper)`。**禁手写 `blur(<px>)`**（static-check 判失败）。
- i18n 四语齐备（zh-CN / en / ja-JP / cat，cat = 中文 + 「喵」尾）：

```js
import { i18n } from "../../src/javascripts/i18n.js";
i18n.registerMessagesAll({
  "zh-CN": { myPlugin: { title: "我的插件" } },
  "en":    { myPlugin: { title: "My Plugin" } },
  "ja-JP": { myPlugin: { title: "マイプラグイン" } },
  "cat":   { myPlugin: { title: "我的插件喵" } },
});
i18n.t("myPlugin.title", "我的插件"); // 键必须字面量，每次必带兜底
```

构建期算出的文案（下拉项等）必须 `i18n.onChange()` 里重建，并在 `plugin-unload` 退订。

## 6. 样式与动画规范（macOS Sequoia 复刻）

- 缓动统一 `cubic-bezier(0.16, 1, 0.3, 1)`；窗口开合 160ms 量级；动画只用 `transform` 与 `opacity`。
- **`.window` 与任何带 backdrop-filter 的元素上禁 transform / filter / clip-path**（采样会断链）。
- 亚克力表面内部交互反馈只用纯绘制属性（background / box-shadow / color），**禁 `filter: brightness()`**。
- **界面禁 emoji**（图标用 `assets/icons/` 的 PNG 或 `assets/images/` 的 SVG glyph）；
  应用图标一律 PNG、复制进插件目录、manifest 只写裸文件名。
- 尊重减少动态效果：系统会置 `html[data-reduce-motion="on"]`，非必要动效在该属性下关闭。
- 层级：浮层 z 只取 `zindex.js` 的 Z 表（POPOVER 9640 等）；窗口 z 由 window-manager 焦点栈管，不手写。

## 7. 宿主 API 与权限边界

受管（需 permissions，返回信封 `{ok, value?, reason?}`，永不抛错）：
`Deskly.apps.launch`、`Deskly.apps.default.*`、`Deskly.fs.read/write/list/mkdir/remove/exists/stat/rename/copy`（沙箱相对路径）、
`Deskly.fs.at/writeAt/statAt/existsAt/mkdirAt/removeAt/renameAt/moveAt/copyAt/walkAt/watchAt`（公开绝对路径）、
`Deskly.windows.configure`（仅自己窗口）。
免权限：`Deskly.apps.list/info`、`Deskly.bus.on/off/emit`、`Deskly.fs.home/temp`、`Deskly.windows.state`、`Deskly.meta.*`
（`meta.version` 是属性不是函数）。
未落地占位（别用）：`Deskly.widgets.*`、`Deskly.icons.set`、`Deskly.system.patch.*`、`Deskly.windows.style.*`。

直用全局钩子（不走 Deskly）：`__settings`（define/get/set/on，设置项自动进系统设置面板）、`__log`
（来源写 `plugin/<id>`）、`__dialog`（alert/error/confirm/prompt/messageBox；新代码用 `Deskly.ui.dialog`，
权限框只能由内核弹）、`__notify`、`__popover`、
`__osfs` / `OSFS`（路径一律 `OSFS.TOP.*.path`，不写 `/文档` 字面量）、`__trash`（删除收口 moveToTrash/emptyTrash）。
顶栏图标：`registerFinderbarIcon({id, icon, onClick, order})`（finderbar.js 导出），plugin-unload 里 `unregisterFinderbarIcon(id)`。

JS 运行时资源 URL（`<img src>`、fetch）用 paths.js：`assetPath("icons/x.png")`、`modFile(id, "x.png")`
——运行时 URL 相对**文档**解析，写 `../../assets/…` 只是碰巧能用。

## 8. 安装与打包

1. 开发期：把 id 加进 `BUILTIN_IDS` → 重载扩展 → 程序坞点图标验证。
2. 自检：`node dev/static-check.mjs`（全绿才交付；仓库无 package.json，Node 20+ 直接跑）。
3. 打包：`node dev/package-plugin.mjs <id>` → `dist/<id>-<version>.zip`（打包即校验）。
4. 安装方：商店拖入 ZIP；JSZip 解包（≤10MB、manifest 在包根/公共根、POSIX 路径分隔符）→
   Blob 存 IndexedDB → sw.js 接管 `./mods/<id>/` 并回读 `X-Deskly-Plugin` 头验证，失败整体回滚。

## 9. 禁止事项

- 声明用不到的权限；调用未声明的 Deskly 方法。
- 把插件目录外的路径写死（`/文档`、`assets/...` 字面量）；运行时 URL 不走 paths.js。
- 引入需要联网的依赖（CDN 脚本/字体/图片）：扩展页 CSP 与离线要求都不允许；ZIP 包必须完全自包含。
- 乱动宿主 DOM 中不属于你的区域（别的插件窗口、内核元素）；裸选择器污染全站样式。
- 往内核语言包塞键、手写 localStorage 键、绕过 __settings / __log / trash 收口。
- import 说明符带 `?v=`；漏写 `plugin-unload` 清理；emoji 当图标；SVG 当应用图标。

## 10. 模板用法

复制 `templates/` 四个文件到 `mods/<id>/`，把 `my-plugin` / `MyPlugin` / `myPlugin` 全部替换成你的 id/类名/命名空间，
按上文填 manifest 与文案。模板已内置：permissions `[]`、红绿灯、data-i18n、四语注册、plugin-unload 清理框架。
交付前逐条过 `checklist.md`。
