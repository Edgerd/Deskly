# 插件开发指南

> 回到 [文档首页](index.md)

## 一、创建目录

最小完整骨架看 `mods/about/`（`index.html` 27 行 + `manifest.json` 13 行 + `script.js` 52 行 +
`style.css` 100 行 + 一枚 PNG 图标），照它复制一份改名 `mods/你的插件id/` 即可。
要看**有计算逻辑**的插件怎么拆，看下面「七点七、范例：计算器」。

## 二、编写 manifest.json

按 [插件包格式](plugin-format.md) 填写清单。**只有该文档表格里列出的字段会被读取**，
例如 `author` 当前没有任何读取方，写了不显示。

关键字段：

- `id`：唯一标识，小写蛇形；只允许 `[A-Za-z0-9][A-Za-z0-9._-]*` 且不含 `..`（`app-registry.js:43`、校验 `:55`）。
- `name`：显示名，如「计算器」；同时是缺省的窗口元素 id（`plugin-manager.js:483`）。
- `entry`：`window` 普通窗口 / `fullscreen` 全屏（`plugin-manager.js:491`）。
- `window.width` / `window.height` / `window.centered`：初始尺寸与是否居中（`plugin-manager.js:267`、`:553`）；
  `window.resizable: false` 也真被读 —— 据此给窗口根元素加 `no-resize`（`plugin-manager.js:272`）。
- `icon`：相对插件目录的文件名（`plugin-manager.js:142` 解析，只接受落在 `mods/<id>/` 或 `assets/` 内）。
- `menus`（可选）：自定义该应用的顶栏菜单，见 [插件包格式](plugin-format.md)。

## 三、编写 index.html

写一个窗口根元素，需带 `window` 类；id 可以留空，`plugin-manager.js` 会在注入后补成 `name`
（或 `windowName`）。尺寸与可缩放性由**应用自己**在根元素上声明（`data-window`），
标题栏用 `data-titlebar` 标出来 —— 这两件事内核不再替你决定：

```html
<div class="window" id="我的应用" data-window="size:820x560 min:520x360 centered">
  <deskly-traffic-lights class="wintools"></deskly-traffic-lights>
  <div class="titlebar" data-titlebar>我的应用</div>
  <div class="content">你好，世界</div>
</div>
```

### `data-window`：应用侧声明窗口

空格或分号分隔的 `键:值` 列表，由 `window-manager.js` 的 `readDeclaration()` 解析：

| 键 | 写法 | 作用 |
|----|------|------|
| `size` | `size:820x560` | 初始宽高（px）。落实为内联样式，所以能盖过插件 CSS 的 `width:100%` 之类 |
| `width` / `height` | `width:820 height:560` | 与 `size` 同义，分开写也行 |
| `min` / `max` | `min:520x360` | 缩放边界。写进内联 `min-width`/`max-height`，与样式表里的同类声明走同一套读取 |
| `resizable` | `resizable:false` | 关掉八向缩放，并熄灭绿键 |
| `minimizable` / `maximizable` | `minimizable:false` | 单独熄灭黄键 / 绿键 |
| `centered` | `centered`（裸键即为真） | 打开时居中；同尺寸的第二个窗口按 24px 层叠错开（macOS cascade） |
| `draggable` | `draggable:false` | 完全禁止拖动（面板类浮层用） |

优先级：**`data-window`（应用界面）> `manifest.window`（清单）> 应用 CSS 的自然尺寸**。
尺寸属于「这个应用长什么样」，归应用自己：改一处只动一个文件，不必再去清单里对第二份数字。
运行期要改（比如按文档内容决定初始大小）走
`await Deskly.windows.configure(null, { width: 900, height: 640, resizable: false })`，
它会同时把声明写回 `data-window`，下次打开仍然生效；`Deskly.windows.state(el)` 读当前框架与状态。
只能配置自己的窗口（按 `data-plugin-id` 校验归属），免权限。

### 窗口行为的归属（macOS 语义）

内核的窗口层是 `src/javascripts/window-manager.js`（几何原语在 `wm/frame.js`），
`window.js` 只剩旧式 App 装载与同名转发。**以下都由内核实现，插件不要再写一遍**：

- **红绿灯**：优先用组件 `<deskly-traffic-lights class="wintools">`；按旧文档手写
  `.wintools > .red/.yellow/.green` 的第三方包继续可用。两者都没有时内核补挂一组。
  自己再绑 click 会与内核的绑定叠加，一次点击执行两次。
- **拖动**：只认标题栏 —— `[data-titlebar]` 里的空白处（按钮、输入框、标签等控件不算）。
  一个窗口可以标多条标题栏（如 App Store 的标题条 + 工具条）。
  标题栏没认领这次按下时（窗口根本没有 `[data-titlebar]`，或它被应用自己的样式写成
  `pointer-events:none` 的装饰条 —— 系统设置的 `.ss-titlebar` 就是），内核退回「顶部灯区带」兜底，
  所以不存在「整扇窗口一点都拖不动」；但真正在滚的容器仍把手势还给内容。
  内置应用仍应显式标出标题栏，别长期靠兜底。
- **缩放**：内核给窗口注入 8 条透明边带（四边 + 四角，`.window > .wm-edge-*`），
  命中即按对侧锚点缩放，⌥ 锁宽高比。之所以是真实元素而不是坐标判定：
  Safari 这类整面 `iframe` 的内容会吞掉宿主页面的指针事件，坐标方案在它的左右两边直接失效。
  边带压在内容之上，但内核在 hover 时会把「底下是滚动条槽 / 输入框 / 红绿灯」的那条边带让回去。
- **绿键**：普通点击 = 缩放（填充菜单栏与程序坞之间的可视区）；⌥ 点击 = 全屏（覆盖视口，
  菜单栏与程序坞收起，指针顶到边缘临时探出）；悬停约 0.9s（`window-manager.js` 的 `HOVER_MENU_DELAY`，故意比 macOS 的 0.5s 钝一档：指针只是扫过标题栏去抓边框时不该弹菜单）或右键 = 窗口排列菜单（平铺左右半屏 / 四角 / 居中 / 还原）。
- **双击标题栏** = 缩放。内核在按下入口自己数两次点击：拖动起手会 `preventDefault()`，
  浏览器的 `dblclick` 根本不会再派发，插件绑 `dblclick` 在标题栏上是无效的。
- **拖动推到屏幕边缘** = 平铺吸附（带预览框）。
- **缩放手柄**：核心不再注入 `.resizer`；老插件自带的右下角 `.resizer` 仍被当东南手柄识别。

禁止缩放有等效的三种写法：根元素 `data-window="resizable:false"`、清单 `window.resizable: false`、
或直接给根元素加 `no-resize` 类 —— 最终都收敛到内核的 `setResizable()`。

## 四、编写 style.css

样式沿用其他插件风格，可复用根目录的 CSS 变量（如 `--bg-color`）。如需引用根图片，用 `../../assets/...`。
浮层层级只能取自 `src/javascripts/zindex.js` 的层级表 `Z`，见 [层级表](z-layers.md)。

## 五、编写 script.js

ES Module 逻辑，在插件注入后执行。**插件与宿主运行在同一个 document 里**
（`plugin-manager.js:533` 用 `insertAdjacentHTML` 注入界面，脚本直接 `import` 宿主模块），
没有 iframe，也没有 postMessage 协议：

```js
import { getPlugins, load as loadPlugin } from '../../src/javascripts/plugin-manager.js';
import { updateMenu } from '../../src/javascripts/finderbar.js';
import { Z } from '../../src/javascripts/zindex.js';

const root = document.querySelector('#我的应用');
// ... 应用逻辑
```

硬性约束（违反会造成重复实例 / 监听永久累积）：

1. **import 说明符不得带 `?v=`**：带串与不带串是两个不同模块，宿主模块会被求值两次。
2. **入口脚本每次打开都是全新 URL**（`plugin-manager.js:567` 用 `Date.now()` 强制重新执行 `init()`），
   所以插件**必须监听 `plugin-unload` 并释放全局资源**：
   ```js
   const onUnload = (e) => {
       if (e.detail?.id !== "我的插件id") return;   // 事件带的是 id，别卸别人的窗
       window.removeEventListener("resize", onResize);
       clearInterval(timer);
   };
   window.addEventListener("plugin-unload", onUnload);
   ```
   事件在 `document` 上派发且 `bubbles: true`（`app-registry.js:38`–`:40`），
   挂 `window` 或挂 `document` 都能收到；内置插件一律挂 `window`
   （如 `mods/finder/script.js:443`、`mods/notepad/script.js:454`）。
3. **被入口 import 的子模块跨多次打开只有一份实例**：入口的 `init()` 必须自己复位状态、
   并对订阅去重，不能假设「重新执行 = 干净状态」。
4. `<img>` 请带 `alt`（装饰图用 `alt=""`）。

系统弹窗 / 通知统一走全局接口，不要用浏览器原生 `alert/confirm/prompt`：
`window.__dialog`（`ui/alert.js:220`：alert / error / confirm / messageBox / prompt）、
`window.__notify`（`ui/notification.js:211`：show / dismissAll / pendingCount / resetPendingCount）。

同一个 document 里还能直接用的系统接口（本仓库没有 iframe、没有 postMessage，也没有权限申请这一层）：

- `window.__settings`：读写设置 + 用 `define()` 注册你自己的设置项，系统设置会自动长出一行控件。
- `window.__log`：运行记录（缓冲区在内核侧，关窗、重开都不丢；`console.*` 已被自动归档，无需改造旧代码）。
- `window.__surface` + 一组 CSS 令牌：磨砂背景的模糊值与上面的文字色都由系统等级分配，样式表只写
  `var(--surface-blur-N)` / `var(--surface-text)`；**文字档只有两套**——主题面板档 `--surface-text*` 与
  墙纸档 `--surface-text-wallpaper*`，表面被墙纸染深时在自己的着色规则里把前者指向后者即可，
  见 [系统 API 参考](os-api.md) §五。
- `import { i18n } from '../../src/javascripts/i18n.js'`：`t(key, fallback)` 取文案，
  `registerMessagesAll(byLang)` 带插件自己的语言包。

全部签名、元数据字段、`file:line` 出处见 [系统 API 参考](os-api.md)。

🚫 不要在插件里重复实现窗口拖拽/缩放/关闭——这些由 `window-manager.js` 统一处理（见上文第三节）。
🚫 不要用 `innerHTML` 拼接用户输入；插件 HTML 在注入前会被净化
（`plugin-manager.js:115` 剥掉 `<script>`、`on*` 内联处理器与 `javascript:`/`data:` 链接，仅对 ZIP 安装的插件执行：`:532`、多应用路径 `:396`），
自建 DOM 时请沿用 `textContent`。

## 六、放入图标

规则见 [插件包格式](plugin-format.md) 的「图标规则（硬性）」：**应用图标只用 PNG，不准 SVG**。
从 `assets/icons/`（含 `dock/`、`folder/`）挑一枚合适的，**复制**进 `mods/{id}/`，
`manifest.icon` 写裸文件名；库里没有对得上的就**不要写 `icon` 字段**，
系统会回退占位图（`plugin-manager.js` 的 `GENERIC_APP_ICON`）。
解析顺序：`manifest.icon` → `mods/<id>/icon.png` → 占位图。
多应用插件还可以给每个 `apps[]` 条目写 `icon`，未写则继承插件级图标。

## 七、打包与安装

1. 打包 ZIP：**`manifest.json` 必须在 ZIP 根目录**（`store-api.js:341` `installZip()` 只认包根，
   取不到就报「包里找不到 manifest.json」）。其余文件放在根目录、或全部放在同一个顶层目录
   （如 `myplugin/index.html`）都可以，公共顶层前缀会被剥掉（`store-api.js:327` `commonRoot()`：
   只要包根有文件就不存在公共根，否则 `codecs/` 这类真实子目录会被误当根剥掉、运行时必然 404）。
   把 `mods/` 整层目录一起打包会报「包里找不到 manifest.json」。
2. 打开应用商店，把 ZIP 拖进窗口（整窗都是热区），或点右上角「安装 ZIP…」选文件。
3. 系统解压、校验 `id`、弹权限清单确认后把文件以 Blob 写入 IndexedDB 并注册
   （`store-api.js:394` 权限确认 → `plugin-manager.js:registerInstalledPlugin()` 落库并注册，
   `id` 合法性在 `app-registry.js:55`）；资源不落盘，`./mods/<id>/<file>` 请求由 `sw.js` 从库里返回。
4. **落库后还会逐个回读校验**：清单声明的入口 HTML / 样式 / 脚本 / 图标（多应用插件含每个
   `apps[].main` 与 `apps[].icon`）必须都能取到，且响应带 `X-Deskly-Plugin` 标记头
   （`store-api.js:304` `verifyInstall()`）。任一项失败就删掉刚写入的记录并点名缺哪个文件 ——
   装一个打不开的插件比装不上更糟。详情图（`store.screenshots`）缺失只算提醒，不拦安装。

## 七点五、让商店把你的插件介绍清楚（`manifest.store`）

商店详情页的内容全部来自插件自己声明的 `store` 块：分类、一句话、简介、能力清单、使用方法、
更新时间、作者、主页，以及**详情图**（`screenshots`，写插件目录内的相对路径，只收 PNG/JPG/WEBP）。
字段上限与清洗规则、以及「权限为什么不在这里写」见 [插件包格式](plugin-format.md) 的
「商店自声明（`store`）」一节。没声明的区块不会出现在详情页，界面也不替你编文案。

## 七点七、范例：计算器（`mods/calculator`）—— 有计算逻辑的插件怎么拆

计算器是这仓库里唯一把「算」和「画」彻底分开的插件，值得照抄的不是它的键帽，是它的**拆法**。

**1. 内核模块不碰 DOM，才能在 Node 里逐条断言。** `engine.js` / `rpn.js` / `programmer.js` /
`convert.js` 四个模块只做纯函数与纯状态（`createState()`、`evaluateTokens(tokens, state)`、
`convert(value, from, to)`），没有一处 `document` / `window`。界面 `script.js` 只干三件事：
键位表、渲染、事件路由。于是逻辑可以这样验，不用起浏览器：

```bash
node dev/calc-check.mjs          # 引擎 + RPN + 历史 + 跨模块一致性
node dev/calc-programmer-check.mjs
node dev/calc-convert-check.mjs
```

**2. 表达式求值必须自写，别指望 `eval`。** 清单的 CSP 是 `script-src 'self'`，
`eval` / `new Function` 在扩展页面里直接被拒。`engine.js:760` 的 `evaluateTokens()` 是
调度场算法 + RPN；`2 EE 5` 这类记法在求值前先折成 `2×10⁵`（`foldEE():733`）。
基础模式还要保留 macOS 的**立即执行**语义（`8+3×2=` 得 22），所以按 `state.mode` 分流而不是共用一套。

**3. 键位表是唯一权威，包括 `2nd` 层。** 每个键写 `t`（正层字形）+ `s`/`sa`（第二层字形与动作），
`KEY_INDEX:89` 反查。引擎里不要藏第二份 `SECOND_MAP` —— 两处定义一定会漂。

**4. 尺寸只在 `data-window` 声明，高度要量不要查表。** 见第三节的归属规则；
但多模式面板高度差很多（转换块、RPN 块、位网格各自加高），写死一张「模式→尺寸」表必然漏组合。
`resizeForMode():935` 的做法：只给宽度，临时放开高度、把键帽行高先钉成真实值（`minmax(0,1fr)`
的行在放开高度时会塌成 `min-height`，量出来永远偏小），再 `getBoundingClientRect()` 量，
最后交还 `1fr`。运行期改尺寸走 `Deskly.windows.configure(null, {width, height})`（免权限）。

**5. 自绘菜单要走浮出层并带 `scope`。** 单位选择与模式菜单都是 `openPopover({..., scope:["calculator"]})`
（`openUnitMenu():851`），否则窗口 `overflow:hidden` 会把菜单裁掉；`scope` 决定
`.calculator .calc-menu` 这类后代选择器与 `--calc-*` 令牌还命不命中（见「常见问题」表）。

**6. 顶栏菜单项的 `cmd` 是注册表键名，不是 JS。** `manifest.menus` 里写
`"calcSetMode('basic')"` 这种 `name('arg')` 形式，实现挂在 `window.__menuActions`
（`MENU_COMMANDS:1053`），并**必须**在 `plugin-unload` 时摘掉。

**7. 应用记忆与用户设置走同一套定义，用 `hidden` 区分。**
`calculator.background/thousands/decimals/keepHistory` 是给用户改的（`pane:"plugins"`，进「设置 › 扩展」）；
`calculator.mode/rpn/convert/units` 是应用自己的状态，`hidden: true` 让它不出现在面板里但照样持久化。

**8. 一块表面可以故意不跟随主题。** 计算器恒为深色：底色写自己的 `--calc-glass` / `--calc-solid`
（`style.css:39`–`:40`）而不是 `--panel-bg`，只把**模糊与饱和**引用系统令牌
（`blur(var(--surface-blur-3)) saturate(var(--surface-saturate))`），文字用推导出的 `--surface-text*`。
这样「模糊等级」「降低透明度」仍然管得住它，而系统切浅色主题不会把它翻成白底 ——
代价是这块表面上的文字永远是亮墨，别在浅底上复用同一组令牌。

## 常见问题

| 问题 | 解决 |
|------|------|
| 图标不显示 | 看 `manifest.icon` 是否被解析成越界路径（只允许 `mods/<id>/` 或 `assets/` 内），以及该 PNG 是否真在插件目录里；两者都没有则显示 `GENERIC_APP_ICON` 占位图 |
| 图片 404 | 运行时 URL（`<img src>`、`fetch()`、通知图标）相对**文档**解析，插件里同样写站点根相对形式 `./assets/…`，或直接 import `assetPath()` / `assetIcon()`（`src/javascripts/paths.js:13`、`:16`）；`../../assets/…` 只是越过根目录后被浏览器截断回同一处才碰巧能用（`paths.js:41`–`:48`）。只有 `style.css` 里的 `url()` 必须写 `../../assets/…`（相对 CSS 文件自身解析）。缺文件的现场记录在运行记录里，来源 `kernel/loader`（`src/javascripts/log.js:306`） |
| 窗口无法拖动 | 确认 html 根元素带 `window` 类 |
| 二次打开没反应 | 入口脚本每次都是新实例，`init()` 必须复位状态；子模块只有一份实例，订阅要先摘再挂 |
| 关窗后全局监听还在 | 没监听 `plugin-unload` 做释放，见「五」的约束 2 |
| 菜单项点了没反应 | `cmd` 只能是注册表键名 `name` 或 `name('arg')`（`ui/menuCommands.js:15`），任何别的 JS 表达式都会被拒绝并打日志 |
| 自己画的下拉菜单被窗口裁掉、只能在窗口里露半截 | 窗口框是 `overflow:hidden` 的（`assets/stylesheets/ui/window.css:17`），菜单只要是触发按钮的子节点就一定被裁，**调大 `z-index` 没用**（裁剪与层级是两件事）。调 `window.__popover.open({anchor, content})` 把菜单搬进 `<body>` 上的浮出层，关闭 / 跟随 / Esc 都由内核统一管；`scope` 参数决定 `.你的类 菜单项` 这类后代选择器与 `--你的令牌` 还命不命中。范例 `mods/notepad/script.js:366`、`mods/finder/finder-actions.js:209`，参数与两条限制（百分比 `min-width`、盒模型）见 [系统 API 参考](os-api.md) §4.2 |
| 插件想有自己的设置项怎么办 | 别自绘界面：在插件初始化时调 `window.__settings.define({ key: "你的插件id.某项", type, default, owner: "你的插件id", pane: "plugins", label, control })`，系统设置 › 插件 就会自动出现一行（`mods/system-settings/panes/plugins.js:136`、`:174`–`:178` → `ui.js:540`）。`control` 只认 `switch/slider/dropdown/segmented/radio/cards/swatches` 七个值，写别的会被 `autoRow()` 直接返回 `null`（`ui.js:552`），界面上静默少一排；细节见 [系统 API 参考](os-api.md) |
| 插件里的磨砂背景怎么跟随系统的模糊等级？我确实需要别的模糊值怎么办 | 只引用令牌：`backdrop-filter: blur(var(--surface-blur-3)) saturate(var(--surface-saturate)); color: var(--surface-text);` —— 用户的等级只改基准步长 `--surface-blur-unit`，各表面按角色 1–5 等比变化（`src/javascripts/surface.js:274`–`:277`），文字色永远是推导出来的 `#000`/`#fff`，不用自己挑。**文字档只有两套**，按「文字压在哪一层」分：主题面板档 `--surface-text*`（菜单 / 弹层都不吃墙纸色）与墙纸档 `--surface-text-wallpaper*`；你的表面背景若是墙纸本身（全屏浮层）、或被墙纸染深的侧栏，就在那条着色规则里把四条 `--surface-text*` 指向 `--surface-text-wallpaper*`（现成写法 `assets/stylesheets/ui/window.css:39`–`:44`，靠继承覆盖整棵子树）。**注意一个坑**：如果你的插件令牌在插件 `:root` 就已代入 `--surface-text*`（如 `mods/finder/style.css:24`–`:26` 的 `--finder-text*`），自定义属性是按元素算一次再由后代继承的，后代里改 `--surface-text*` 救不回那份值 —— 得重指你自己那条（内核给访达就是这么做的：`assets/stylesheets/main/main.css:327`–`:331` 重指 `--finder-text*`）。着色表面的固有浓度还要写成 `calc(<固有浓度> * var(--tint-strength))`、颜色只走 `var(--tint-rgb)`，否则「着色浓度」滑块对这块表面静默失效（`dev/static-check.mjs` 的 5b 节会拦：`:318`–`:354`）。真要阶梯表达不了的值，就在自己元素上覆盖 `--surface-blur`（或 `__surface.apply(el, {blurPx})`）——**不推荐**：写死的 px 不含 unit，用户的「模糊等级」对这个表面静默失效（代码原话见 `surface.js:401`、`assets/stylesheets/main/main.css:109`–`:111`），而样式表里的裸 `blur(<px>)` 还会让 `node dev/static-check.mjs` 直接红（`dev/static-check.mjs:275`、`:298`）。细节与全部令牌见 [系统 API 参考](os-api.md) §五 |
| 插件里怎么看报错 / 怎么排查 | 顶栏「调试 → 查看运行记录」跳到系统设置 › 调试（`src/javascripts/debug.js:131`–`:134`），或代码里 `__log.query({ source: "plugin/你的id", minLevel: "warn" })`；日志缓冲在内核侧（`log.js:35`），关窗重开都在。写日志请显式带 `plugin/<你的id>` 前缀（裸名按 `log.js:46`–`:53` 的内核白名单归类）。自查设置项可用「调试 → 运行设置自检」（`debug.js:399`），改过设置中枢则跑 `node dev/settings-harness.mjs` |

## 相关文档

- [系统 API 参考](os-api.md)
- [插件包格式](plugin-format.md)
- [冷加载机制](cold-load.md)
- [架构总览](architecture.md)
- [层级表](z-layers.md)
