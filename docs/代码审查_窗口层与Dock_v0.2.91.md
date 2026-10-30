# Deskly 代码审查报告 · 窗口层 + Dock

- **版本**：v0.2.91（`manifest.json:6`）
- **审查范围**：`src/javascripts/window-manager.js`、`window.js`、`dock.js`、`wm/frame.js`、`zindex.js` + `manifest.json`、`sw.js`、`index.html`
- **目标环境**：Chrome 稳定版 · 桌面端
- **交付方式**：只出报告与替换片段，**未改动任何代码**
- **日期**：2026-10-12

---

## 〇、本次实际读到 / 未读到的文件

**已完整读取（逐行）**：`manifest.json`、`index.html`、`sw.js`、`src/javascripts/window-manager.js`、`src/javascripts/window.js`、`src/javascripts/dock.js`、`src/javascripts/wm/frame.js`、`src/javascripts/zindex.js`。

**按需取证**：`assets/stylesheets/ui/window.css`（60–105）、`ui/windowframe.css`（50–120）、`dock/dock.css`（100–310、360–380）、`paths.js`（58–73）、`bootstrap.js`（135–155）、`assets/vendor/webswift.js`、`ui/notification.js`（1–12 注释）。

**未读实现、只核对了调用点（分析盲区）**：`plugin-manager.js` 的 `openApp/unloadApp/getIcon` 内部、`ui/trafficLights.js`、`finderbar.js` 的 `updateMenu`、`ui/contextMenu.js`、`settings.js`。涉及这五者的结论均已降级标注，未当成定论。

**结构复述**：`index.html` 用 12 个 `<script type="module">` 并列拉起内核，`window.js` 已退化为「旧式 App 装载 + 兼容门面」，窗口机制唯一实现在 `window-manager.js`（几何 / 焦点栈 / 拖动 / 八向缩放 / 平铺 / 全屏），纯函数几何全在 `wm/frame.js`。依赖方向是 `dock.js → window.js → window-manager.js → wm/frame.js`，反向由 `window-manager` 通过 `window.__dock` 全局桥回调 Dock（`minimizeToDock` / `restoreFromDock` / `syncRunningApps`）。关键数据流两条：① 图标列表来自 `localStorage` 的收藏 / 最近使用 + 插件注册表 → `makeContainer` 渲染 → `mouseup` → `openApp/launchApp` → `create()`；② 运行态对账从 `document.querySelectorAll(".window")` 反推 `appStatus` 与指示灯，由 `MutationObserver(body)` 驱动。层级由焦点栈 `stack` 数组推导，恒落在 `Z.WINDOW_MIN..MAX`（2050–9000，`zindex.js`）。

---

## 一、总体评估

**结论**：窗口层的核心机制（焦点栈、八向缩放、平铺/缩放脱开、iframe 遮罩）是经实测打磨过的、逻辑自洽的一层，**没有发现崩溃级缺陷**；但**窗口 ↔ Dock 之间的状态交接带**有 5 处会让界面与数据分叉的真实缺陷，全部集中在 `dock.js` 与 `fallBackFadeOut` / `syncRunningApps` / `keepInDock` 这几个交接点上，且都是「点了没反应 / 图标凭空消失 / 动画失效」这类用户能直接看见的问题。

| 严重度 | 数量 |
|---|---|
| P0（崩溃 / 数据丢失 / 权限绕过 / 新标签白屏） | **0** |
| P1（功能错误 / 窗口状态错乱） | **5** |
| P2（体验 / 性能 / 兼容 / 泄漏） | **9** |
| P3（代码质量 / 可维护） | **6** |

**风险集中区域**

1. Dock 运行态对账 —— `syncRunningApps` 只覆盖运行区、不回填最近区；
2. 最小化的内联 `transition` 所有权 —— dock.js 与 window.css 两处各写一份，互相覆盖；
3. `detachStates` 的状态集合不完整 —— 漏 `fullscreen`；
4. Dock 每帧几何读取 —— 提示跟随 + 放大动画 + body 变更全量对账三者叠加。

### 排查清单覆盖（A–M 逐项，不跳项）

| 项 | 结论 |
|---|---|
| **A 功能逻辑** | 发现问题：DOCK-03、WM-05。**未发现问题**：脚本加载顺序一致（内核 import 说明符全部不带 `?v=`，与 `bootstrap.js` / `window.js:17` 约定相符）；无隐式全局（`window.appStatus` / `window.__dock` / `window.specialCloses` 均为显式挂载）；无循环依赖死锁（`dock → window → window-manager → frame` 单向，反向走全局桥） |
| **B 窗口管理器** | 发现问题：WM-01、WM-02。**未发现问题**：`create/open/close/minimize/maximize/restore/destroy` 未见不可达状态或残留；z-index 由栈序推导、区间 6950 槽，`commitStack` 溢出回拉逻辑正确；`active window` 唯一性由 `setFocusedWindow` 全量 toggle 保证 |
| **C 新标签页专项** | 发现问题：DOCK-01（3 秒才启动）、DOCK-04。**未发现问题**：首屏无同步网络请求；`localStorage` 同步读 7 处（`dock.js:221-233`）量级可忽略 |
| **D VFS / 持久化** | **未发现问题**；范围内仅 `safeSetItem` 配额兜底（`dock.js:53-61`），写法正确。存储内核不在本次范围 |
| **E 权限层** | **未发现问题**；`window.Deskly` 不参与窗口 / Dock 链路 |
| **F 插件与动态代码** | 发现问题：CSP-01。**未发现问题**：`window.js:185` 的 `insertAdjacentHTML` 注入的是同源模板且失败路径已复位指示灯，脚本走 `<script src>` 而非内联，符合 CSP |
| **G Chrome MV3** | **权限声明已核实为最小必要**：`bookmarks` 确实被 `vfs.js:74/111/134` 使用（且有降级路径），三个 `host_permissions` 各有 fetch 调用点（`wallpaper.js:70/72/670`）；`src/` 内无 `eval` / `new Function` / 内联事件。发现问题：SW-01 |
| **H 网络与外部依赖** | 范围内（窗口 / Dock）**无网络调用**；Bing / kobin 归 `wallpaper.js`，本次未展开 |
| **I 安全通用** | **未发现问题**（有条件）：`window.js:171` 对拼进弹窗的 `file` 做了 `escapeHtml`，`dock.js` 全程 `textContent` / `createElement`。但 `create(file)` 的 `file` 由调用方传入，需核实无用户输入直达（见五-5） |
| **J 性能** | 发现问题：DOCK-04、DOCK-05、WM-04、DOCK-09 |
| **K 兼容响应式** | 发现问题：DOCK-06、WM-03 |
| **L 可访问性** | 发现问题：A11Y-01（`bootstrap.js` 的 `ensureImgAlt` 补了 `alt`，但 Dock 项仍非 `<button>`、无真实焦点） |
| **M 可维护与体验** | 发现问题：I18N-01、WM-06、WM-07、DOCK-07、DOCK-08 |

---

## 二、问题清单

### P1

| ID | 类别 | 位置 | 问题描述 | 触发条件 | 影响 |
|---|---|---|---|---|---|
| **WM-01** | B/A | `dock.js:1535` ↔ `assets/stylesheets/ui/window.css:67-72` | `fallBackFadeOut` 写内联 `transition: "opacity 0.35s ease"`，**内联优先级盖掉 `.window.minimized` 的 `visibility 0s linear 0.35s`**，`visibility:hidden` 因此在第一帧就生效。`window.css:66-68` 的注释恰好说明这个 bug 曾被修过一次，dock.js 的内联写入把它反向覆盖了 | 点黄键最小化任何窗口 | 最小化**没有任何淡出**，窗口瞬间消失 —— 而函数名与注释承诺的正是「绝不瞬间消失」 |
| **WM-01b** | B | `dock.js:1541-1548`、`window-manager.js:634-635` | 同一条内联 `transition` 的**还原只写在 `_hideTimer` 回调里**；`restoreFromDock:1522` 与 `window-manager.restore():634` 都会在 360ms 内 `clearTimeout(_hideTimer)` 却不还原 transition | 最小化后 360ms 内点 Dock 图标还原 | 该窗口永久带着 `transition: opacity 0.35s`，**把 `.wm-animating` 的 `left/top/width/height` 过渡整个盖掉** → 此后这扇窗口的缩放 / 平铺 / 全屏全部瞬移、无成组动画（且是 inline，刷新前修不回来） |
| **DOCK-01** | C/M | `dock.js:366-374`、`dock.css:369` | 点击 Dock 图标后 `setTimeout(..., 2980)` **才**调用 `launchApp`，且 `parabola` 是 `1s infinite` | 点任何不在 `noAnimation`（仅 `["启动台","访达"]`）里的图标 —— 即 Safari / 系统设置 / App Store / 计算器 / 全部第三方应用 | **每次开应用都要先干等 2.98 秒才开始加载**，指示灯也在 3 秒后才亮；用户第一反应是「没点上」，而 `dock.js:367` 的守卫还会把这段期间的重复点击吞掉，看起来更像完全无响应 |
| **DOCK-02** | B | `dock.js:848-894`（不调 `renderRecents`）、`dock.js:929`（`appStatus[app] === true` 则跳过） | `syncRunningApps` 第 2 步把已关闭应用的图标从**运行区**摘掉，但没有任何一处重新渲染**最近使用区**；而 `renderRecents` 又会跳过「正在运行」的项 | 打开一个非收藏应用（计算器）→ 关闭它 | 该图标**从 Dock 上彻底消失**（运行区已摘、最近区没重画），而 `recentApps` 数据里它还在。直到用户再打开**另一个**应用触发 `updateRecents → renderRecents` 才莫名其妙地回来 |
| **DOCK-03** | B | `dock.js:467-480` | `keepInDock` 把 `altName` push 进 `favorites` 并落盘，但只在「图标此刻正躺在运行区」时搬 DOM；不重画收藏区也不重画最近区 | 应用**未运行**时（图标在最近使用区或根本不在 Dock 上）右键 →「在程序坞中保留」 | 数据说它已固定，界面上**收藏区没有新图标**、最近区那份还留着，直到下一次 `renderFavorites()` 才突然多出来 —— 状态与界面分叉 |
| **WM-02** | B | `window-manager.js:396-404`（`detachStates` 只清 `zoomed`/`tiled`）、调用点 `window-manager.js:572`、`window-manager.js:1352-1356` | `detachStates` 不处理 `rec.fullscreen`，但 `el.winctl.frame = {...}`（元素侧公开 setter）和 `center()` 都会走它 | 任一窗口进入全屏后，插件调用 `el.winctl.frame = {x,y,w,h}`，或在全屏态下调 `center()` | 几何被改成普通尺寸，但 `rec.fullscreen` 仍为 `true`、`.wm-fullscreen` 与 `<html>.deskly-fullscreen` 都不摘 → **菜单栏与程序坞持续收起、指针探边才露出**；而 `resize` 处理器（`window-manager.js:1392-1397`）一看 `rec.fullscreen` 就 `applyFrame(el, displayFrame())`，**窗口在下次浏览器改宽度时自己弹回全屏** |

### P2

| ID | 类别 | 位置 | 问题描述 | 触发条件 | 影响 |
|---|---|---|---|---|---|
| **DOCK-04** | J | `dock.js:1120-1128`；生产者 `window-manager.js:837`(`showPreview`)、`:922`(`installShield`)、`dock.js:1322`(`openStack`) | Dock 对账观察器监听 `body` 的**全部** childList 增删，而拖动预览框和交互遮罩都是**临时挂 / 摘在 body 上**的游离元素 | 拖动窗口并划过屏幕边缘（`showPreview`/`hidePreview` 每换一个吸附区各一次），或任何一次拖动起手 / 收尾 | 拖动过程中反复触发整轮 `syncRunningApps()`：`querySelectorAll(".window")` + 每个收藏项一次 `querySelector` + 遍历运行区 + `refreshSeparators` + `refreshIconList`。与缩放 / 放大动画的每帧 rect 读取叠在一起，是拖动跟手性的直接损耗 |
| **DOCK-05** | J | `dock.js:683-697` | `updateTipPosition` 是一条**无条件自续的 rAF 循环**，每帧读 `currentImg.getBoundingClientRect()` + `tip.offsetWidth` + `tip.offsetHeight`（读写混合，触发强制同步布局），只要指针停在一个图标上不离开就一直跑 | 鼠标悬停 Dock 图标并保持静止 | 静止时也每帧一次强制布局；与 `DockAnimation` 的 rAF（`dock.js:1233-1237`）、`checkTipHit` 的 rAF（`dock.js:744-752`）构成**三条每帧读几何的循环**并行跑在同一个 mousemove 源上 |
| **DOCK-06** | K | `dock.css:102-108`（`.dockcontainer{width:75%}`）、`dock.css:138`（`.dock{overflow:visible}`）、`dock.js:176`（`SIZE_MAX=128`）、`dock.js:381-384`（放大 `maxScale` 到 3） | 底部程序坞**既不换行也不滚动**：容器只有 75% 视口宽、`justify-content:center`，`.dock` 是 `width:auto; overflow:visible`。图标总量 = 收藏 6 + 最近 3 + 废纸篓 1 + 运行区 N | 图标大小调到 96–128px，同时开着 5 个以上应用；或 1366px 宽的屏 | Dock 内容宽超过视口后**向两侧对称溢出**，最左的「访达 / 启动台」（受保护、移不掉）与最右的废纸篓被推出屏外，**无法滚动、无法点到**。`highlightDockNav` 的 `scrollIntoView`（`dock.js:1454`）因为没有滚动容器而完全无效 |
| **WM-03** | K/B | `wm/frame.js:30-51`（读 `.dockcontainer` 的 offset）、`dock.css:169-173`（`.dock.hidden` 只改 opacity/visibility）、`windowframe.css:108-115`（全屏态也只 `visibility:hidden`） | 程序坞隐藏时**只改可见性、不改布局盒**，`.dockcontainer` 仍占 `calc(--dock-size + 10px)` 高度（侧边时 64px 宽），于是 `visibleFrame()` 永远扣着这条带 | 打开「自动隐藏程序坞」后缩放 / 平铺任一窗口，或把窗口往底部拖 | 屏幕底部（或侧边）永久留一条约 60px 的**死区**：`zoomFrame` 填不满、`clampDrag` 不许窗口进入，而程序坞就躺在死区里且平时不可见。与 macOS「自动隐藏时窗口可占满」的预期相反 |
| **WM-04** | J | `window-manager.js:1392-1407` | `resize` 监听未做防抖 / 合帧，回调里对每扇窗口先 `frameOf`（rect 读）再 `applyFrame`（4 个内联写），读写在循环里交织 | 手动拖拽浏览器窗口边缘改变宽度（Chrome 连续派发 resize） | 每帧「N 扇窗口 × 强制同步布局」，是拖窗口时最明显的掉帧点；同时 `visibleFrame()` 在 `clampFrame` / `clampDrag` 内被重复求值（每次 `bar.offsetHeight` + `container.offsetWidth` 两次布局读） |
| **WM-05** | A/B | `dock.js:850`（`querySelectorAll(".window")`）、`dock.js:337`、`dock.js:405/429/459`（`getElementById(name)`）↔ `window-manager.js:89-93`（`isWindowElement` 明确排除 `.finderbar/.menu/.dockcontainer/.desktop/.launchpad`）、`:288`、`window.js:91`（`body > .window`） | 窗口层坚持「`.window` 类名不够，必须 `body > .window` 且不在固定层里」，Dock 的对账与查找却按**任意深度**的 `.window` 类名来 | 任何界面里出现带 `.window` 类的非窗口元素（`window-manager.js:84-86` 的注释说明顶栏菜单历史上就出现过 `<p class="window">`）；或两个应用同名导致 `getElementById` 命中他人窗口（`window.js:238-240` 已在防这件事） | 伪 `.window` 会让 Dock 凭空点亮一个小圆点并写 `appStatus=true`，点它又因 `isWindowElement` 判定不通过而毫无反应 —— 即「有圆点没界面」这一类老症状的新成因 |
| **SW-01** | G | `sw.js:126`（`indexedDB.open` 在 `getRecord` 内）、`:133-141`（`onsuccess` 后从不 `db.close()`） | 每一个被拦截的 `/mods/<id>/<file>` 请求都新开一次 IndexedDB 连接，且**从不关闭** | 打开一个 ZIP 安装的插件（其 HTML/CSS/JS/图片各是一个请求，几十个起步） | 一次开应用就攒下几十个未关闭的数据库连接；MV3 SW 被回收前会持续占资源，多标签并发时更易触发版本变更 / 连接阻塞类偶发失败 |
| **A11Y-01** | L | `dock.js:507-523`（图标是可点击 `<img>`）、`:546`（挂在 `mouseup` 上）、`:1449-1456`（`highlightDockNav` 只加 `.dock-focused` 类、不调 `.focus()`）、`:1376-1395`（`dock-stack-item` 是可点击 `<div>`） | Dock 项没有 `role` / `tabindex`，不是 `<button>`；键盘链路是自造的高亮类而不是真实焦点；栈项是 `div`+`click` | 纯键盘操作 / 读屏用户 | 读屏只读到一个 `alt` 文本、没有「按钮」语义也读不到运行状态（`.light`/`.badge` 是无文本的 `div`，`badge` 的数字不在可及性树里）；`Ctrl+F3` 导航不移动浏览器焦点，Tab 键仍从页面顶部开始；`mouseup` 而非 `click` 也让键盘 `Enter` 无法触发同一条路径 |
| **I18N-01** | M/A | `window-manager.js:373` `updateMenu("访达")` | 没有可见窗口时的兜底菜单名是**硬编码中文**，而同文件 1140–1165 行的排列菜单全部走 `i18n.t` | 桌面上一扇窗口都不开、语言设为 en / ja / cat | 顶栏应用菜单显示「访达」而非 "Finder"，与其他菜单项语言不一致；`updateMenu` 的入参语义（显示名 vs i18n key）也因此两处不统一 |
| **CSP-01** | F/G | `assets/vendor/webswift.js`（2 处 `new Function(this.command)`，其中一处在 `swift-notification` 的 `setup`）、`index.html:83`（每个新标签页都加载它） | MV3 扩展页 CSP 固定 `script-src 'self'`（无 `unsafe-eval`），`new Function` 必然抛 `EvalError`。`ui/notification.js:10-12` 的注释说明团队**已经**为此绕开 `<swift-notification>` | 目前**无调用点**（已 grep 确认 `swift-notification` 在 `src/`、`mods/` 均不使用）→ 潜伏 | 现在不发作；但插件或后续代码一旦 `createElement("swift-notification")` / `swift-messagebox` 带 `command`，就是构造函数里同步抛错、元素直接创建失败。同时把一段含 eval 的未使用第三方代码打进包里，是 Chrome Web Store 人工审核的常见质询点 |

### P3

| ID | 类别 | 位置 | 问题描述 | 修复建议 |
|---|---|---|---|---|
| **WM-06** | M | `window-manager.js:60` | `const ANIM_MS = 300` 声明后**全文件没有任何引用**（注释还声称「与样式表 .wm-animating 的过渡时长对齐」，实际时长硬编码在 `wm/frame.js:78` 的 `320`）。两处数字还不一致（300 vs 320） | 删掉它，或让 `applyFrame` 的摘类时长真正读这个常量 |
| **WM-07** | A | `window-manager.js:521` `!rec._tileAnchor` | `_tileAnchor` 在**整个代码库中从未被赋值**（已 grep），这个守卫恒为真，条件实际只剩 `!rec.tiled && !rec.zoomed`。行为碰巧是对的，但读代码的人会以为存在「平铺锚点」这层机制 | 删掉 `&& !rec._tileAnchor`，或补上赋值处 |
| **WM-08** | A | `window-manager.js:630-633` | `restore(el)` 无 `if (!el) return`（`setMinimized:612` 有）；`isMinimized(el)`（`:112`）同样直接访问 `el.classList`。外部经 `el.winctl` 拿到的是已托管元素，但 `Deskly.windows` 侧若传入已释放的元素就是 TypeError | `restore` / `isMinimized` 开头补 `if (!el) return` |
| **DOCK-07** | A/J | `dock.js:438-464`（`removeFromDock`）、`:1103-1109`（拖出移除）—— 都只调 `refreshSeparators()`，不调 `refreshIconList()` | `imgs` 数组（`dock.js:243`）留着已从文档摘掉的 `img`，`checkTipHit` 每帧对这些 detached 节点做 `getBoundingClientRect()`（返回全 0，永不命中）。同文件的 `DockAnimation.collectIcons`（`:1206`）**已经**加了 `isConnected` 复核 —— 两套图标缓存一处修了一处没修 | 两处移除后补 `refreshIconList()`；或让 `checkTipHit` 复用 `collectIcons` 的 `isConnected` 过滤，去掉第二份缓存 |
| **DOCK-08** | M | `dock.js:422-435`（`quitApp` 的 `else` 分支缺失）、`:362`/`:385`/`:416`（`light.classList` 未判空） | 「退出」时若 `appStatus[altName]` 为真但窗口已不存在，`if (win)` 不成立 → 什么都不做，`appStatus` 仍为 true，圆点仍亮（要等下一次 body 变更触发的对账才纠正）。另外 `light` 在三处被无判空地使用，而 `openSettings:486` 是判空的 —— 同文件两种姿势 | `quitApp` 补 `else` 分支复位状态；`light` 统一 `if (light)` |
| **DOCK-09** | J/M | `dock.js:747`、`dock.js:1233`、`window-manager.js:1422`；`dock.js:1073-1075` 与 `:1132` 重复设 transition；`window-manager.js:1114-1117`（`40`/`24`/`80`）、`:560`（`step=24`）内联魔法数 | 三处 `document` 级 mousemove 并存，而 `dock.js:1146` 的注释写着「mousemove 已由 bindGlobalTip 统一驱动（减少一个高频全局监听）」—— 注释与代码不符，后来人不敢合并。`if (!autoHide)` 那次 `setTimeout` 设 transition 紧接着被 `:1132` 行的 `emitDock → updateDockVisibility` 又同步设一遍，是多余的 | 把放大动画的坐标记录并入 `bindGlobalTip` 的同一个监听（只做「记坐标 + 唤醒帧」，零计算），或至少改正注释；删 `:1073-1075`；把边界余量提为带注释的常量（与 `frame.js` 已有的 `EDGE_BAND` / `KEEP_VISIBLE` 同一风格） |

---

## 三、修复代码（P1）

### 修复 1 · WM-01 / WM-01b —— 最小化淡出与内联 transition 所有权（一处根因，两个症状）

`window.css:67-72` 的 `.window.minimized` **已经**声明了正确的淡出，并且注释里专门解释了 `visibility 0s linear 0.35s` 这个延迟是为什么存在的。dock.js 的内联写入把它盖掉了，所以最小改动是**删掉内联写入**；同时给 `.wm-animating` 加 `:not(.minimized)`，避免「缩放动画还没摘类就点最小化」时反过来盖掉淡出。

`src/javascripts/dock.js` 第 1529–1549 行，整函数替换：

```js
// 兜底隐藏调度：只负责在淡出结束后补 display:none，不再自己写 transition。
// 淡出本身属于 .window.minimized（window.css）：那条规则里带 `visibility 0s linear 0.35s`，
// 而内联 transition 的优先级更高，一写下去就会把 visibility 延迟整段抹掉 ——
// 第一帧就不可见，本函数注释承诺的「绝不瞬间消失」反而从未成立。
// 早还原也无需再恢复什么：既然不覆盖，就没有被覆盖的东西要还原。
function fallBackFadeOut(winEl) {
    winEl.classList.add("minimized");
    // display:none 等淡出结束再设，避免动画被截断。必须可取消并复核状态：
    // 用户在 360ms 内还原窗口时，这个迟到的定时器会把刚恢复的窗口
    // 重新藏成 display:none，而 _minimized 已是 false，
    // 于是得到一个「指示灯亮着却永远点不出来」的隐形窗口。
    clearTimeout(winEl._hideTimer);
    winEl._hideTimer = setTimeout(() => {
        winEl._hideTimer = null;
        if (winEl._minimized || winEl.classList.contains("minimized")) {
            winEl.style.display = "none";
        }
    }, 360);
}
```

`assets/stylesheets/ui/windowframe.css` 第 82 行：

```css
/* 改前 */
.window.wm-animating {
/* 改后：最小化期间让位给 .window.minimized 的淡出，
   两条同权重类规则靠源码顺序决胜（windowframe.css 在 window.css 之后加载） */
.window.wm-animating:not(.minimized) {
```

> 说明：`window-manager.restore():634-635` 与 `dock.restoreFromDock:1522` 都清 `_hideTimer`，改完后两处都不再需要还原 transition —— 这正是选「删内联」而不是「补还原调用」的原因：不需要在跨模块的全局桥上再加一个 `endMinimizeFade` 出口。

### 修复 2 · DOCK-01 —— 点图标立刻启动，弹跳只做反馈

`src/javascripts/dock.js` 第 366–375 行：

```js
        if (!noAnimation.includes(img.alt)) {
            if (img.classList.contains("opening")) return; // 弹跳进行中：忽略重复点击，避免 N 次点击排入 N 个 launchApp
            img.classList.add("opening");
            // 先启动，再让图标自己弹完这一轮（parabola 是 1s infinite）。
            // 旧写法是等 2980ms 才 launchApp：用户看到图标连弹三下、三秒后应用才开始加载。
            setTimeout(() => img.classList.remove("opening"), 1000);
            launchApp(img, light, app);
        } else {
            launchApp(img, light, app);
        }
```

### 修复 3 · DOCK-02 —— 对账后统一重画最近区（顺带去掉每开一个应用重建一次 recentEl）

`src/javascripts/dock.js` 第 916–923 行，给 `updateRecents` 加一个「不要就地重画」的开关：

```js
function updateRecents(altName, rerender = true) {
    if (favorites.includes(altName) || altName === TRASH) return;
    recentApps = recentApps.filter(a => a !== altName);
    recentApps.unshift(altName);
    if (recentApps.length > 3) recentApps = recentApps.slice(0, 3);
    saveRecents();
    // 对账路径（syncRunningApps）会连着为每个新开的应用调一次这里，
    // 每次都 innerHTML="" 重建整个最近区是白白的 DOM 抖动；由调用方收尾时统一画一次。
    if (rerender && showRecentApps) renderRecents();
}
```

同文件第 873 行（`syncRunningApps` 第 3 步）：

```js
        if (!lastSyncIds.has(id)) updateRecents(id, false); // 仅在首次出现时记录最近使用
```

同文件第 892–893 行，在收尾处补一次重画：

```js
    // 关闭的应用要从运行区「搬回」最近区：上面第 2 步只负责摘，
    // 而 renderRecents 会跳过正在运行的项 —— 于是关掉的图标两个区都不在，
    // Dock 上看就是点完消失、再也找不回来。
    if (showRecentApps) renderRecents();
    refreshSeparators();
    refreshIconList();
```

> `window.__dock.updateRecents`（`dock.js:1614`）对外仍可用，老调用只传 1 个参数，`rerender` 默认 `true`，行为不变。

### 修复 4 · DOCK-03 —— 固定操作改成「改数据 + 重画」，不再手工搬 DOM

`src/javascripts/dock.js` 第 466–480 行，整函数替换：

```js
// 在程序坞中保留：将当前运行（非收藏）应用加入收藏项并持久化
function keepInDock(altName) {
    if (favorites.includes(altName) || altName === TRASH) return;
    favorites.push(altName);
    saveFavorites();
    // 旧实现只在「图标正躺在运行区」时把它搬进收藏区，不重画两个区。
    // 未运行的应用图标其实在最近区（或压根不在 Dock 上），那时搬运动作整个落空：
    // 收藏区不出现新图标、最近区还留着旧的，数据说已固定而界面看不出来。
    renderFavorites();
    renderRecents();
    refreshSeparators();
    refreshIconList();
}
```

### 修复 5 · WM-02 —— `detachStates` 把全屏一起脱管

`src/javascripts/window-manager.js` 第 395–404 行：

```js
/** 用户手动改了几何（拖动 / 缩放 / center / frame setter）即宣告托管状态结束。 */
function detachStates(rec, keepNormal) {
  const el = rec.el;
  if (rec.fullscreen) {
    // 全屏必须一并脱开：否则 el.winctl.frame = {...} 写完普通几何后
    // rec.fullscreen 仍为 true，<html>.deskly-fullscreen 不摘（菜单栏与程序坞
    // 一直收着），而下一次 resize 会按 displayFrame() 把窗口 snap 回全屏。
    rec.fullscreen = false;
  }
  if (rec.zoomed || rec.tiled) {
    if (!keepNormal) rec.normal = frameOf(el);
    rec.zoomed = false;
    rec.tiled = null;
  }
  syncState(el, rec);
}
```

同文件第 1084–1086 行，`startResize` 补一条与 `startDrag:1011` 对称的守卫（插件自带的 `.resizer` 在全屏窗口里仍可达，`windowframe.css:51-55` 只屏蔽了 `.wm-edge`）：

```js
  const el = rec.el;
  if (rec.fullscreen) return;   // 与 startDrag 一致：全屏窗口没有可缩的边框
  focusWindow(el);
```

> **落盘注意**：`startResize` 的原签名是 `(rec, edge, e)`，函数体靠闭包参数 `edge` 算 `anchor` / `EDGE_CURSOR[edge]` / `resizeFrame(base, edge, …)`，与 `bindInteractions:961` 的调用点对应。请**保留原三参签名**，只在 `const el = rec.el;` 之后插入 `if (rec.fullscreen) return;` 这一行。

---

## 四、优化建议（按收益 / 成本）

### 现在做（收益高、改动小）

1. **给 `dockSyncObserver` 加记录过滤（DOCK-04）** —— 收益高、约 5 行：回调里先看 `m.removedNodes` / `addedNodes` 是否含 `.window` 根元素，不含就直接 return。这一条同时消掉拖动预览框、交互遮罩、文件夹栈三类「与本模块无关的 body 变更」引发的全量对账。
2. **`visibleFrame()` 反映程序坞真实可见性（WM-03）** —— 自动隐藏和全屏两种态下都不再预留死带，`setZoom` / `tile` / `clampDrag` 一起受益，且解掉 `window-manager.js:1430` 那个恒真的 `vf.bottom > 0` 判定。注意 `frame.js:31-33` 每次调用读 `offsetHeight` / `offsetWidth`，在 `clampFrame` / `resizeFrame` / `tileFrame` 里会被反复求值 —— 顺手在 `startResize` 外循环里缓存一份（配合建议 3）。
3. **`resize` 合帧（WM-04）** —— 一个 rAF + 一个 pending 标志，把「每帧 N 次强制同步布局」压成 1 次。
4. **Dock 溢出兜底（DOCK-06）** —— CSS 一行 `overflow-x:auto` + 隐藏滚动条即可让图标「够得着」，比做滚动指示或分页便宜得多。
5. **`checkTipHit` 复用带 `isConnected` 复核的图标缓存（DOCK-07，与 WM-05 同一味道）** —— 现在 Dock 里有两份图标缓存，一份修过失效节点、一份没修；统一成一份能同时减掉一次 `querySelectorAll`。

### 长期可选

6. **把 `appStatus` 从「Dock 私有 + `window.appStatus` 全局」收成单一事实来源** —— 目前 Dock（`dock.js:384/417`）、window-manager（`window-manager.js:704`）、window.js（`window.js:178`）三处都在写同一个全局对象，而 `syncRunningApps` 已经证明「DOM 是不会说谎的账本」。让全局 `appStatus` 退化为只读派生值，DOCK-02 / DOCK-08 这一类缺陷会从根上失去成因。**成本中等偏大，建议单独立项，别夹在缺陷修复里做。**
7. **键盘链路换成真实焦点（A11Y-01）** —— `img.focus()` + `.container` 上的 `role="button" tabindex="0"`，`Ctrl+F3` 的自造高亮态可以保留为样式，但焦点必须真的移动，否则读屏与 Tab 顺序永远接不上。这条要连着改 Dock 的 CSS 焦点环，工作量比上面几条大。

---

## 五、需要确认的问题（已逐条查实，结论见第七、八章；原文保留作审计痕迹）

1. **DOCK-01 的 2980ms 是不是有意设计？** 代码与注释都写成「动画进行中忽略重复点击」，看起来更像「弹跳动画跑完再启动」的刻意节奏，但 `parabola` 是 `1s infinite`、2980 也不是它的整数倍，所以我判断是硬编码留错。改之前请确认产品意图是「弹一下再开」（那就该 launch 提前、弹跳作反馈，如修复 2）还是「必须等满 3 秒」（那也至少该把时长与动画周期对齐并在注释里写明理由）。
2. **`finderbar.updateMenu` 的入参语义**（I18N-01 依赖）：本次未读其实现。它按显示名匹配菜单，还是按 i18n key？若内部还会拿这个字符串去比 `data-*`，那 `updateMenu(i18n.t("app.finder", "访达"))` 在非中文语言下会匹配不到。**验证方法**：切到 `en` 后不打开任何窗口，看顶栏是否出 Finder 菜单；再对 `updateMenu` 打一处 `console.log` 看它拿到的是 key 还是显示名。
3. **`plugin-manager.js` 的 `unloadApp` 引用计数**（WM-05 的相关面）：`window-manager.js:694` 按存活窗口计数卸载。如果同一应用有两个同 id 窗口（`window.js:238-253` 承认这种显示名冲突会发生，只是打个 warn），卸载会不会把另一扇还开着的窗口背后资源也放掉？**验证方法**：用 `window.__desklyApi.openApp` 连续打开同一应用两次，关掉其一，看另一个的功能是否还在。
4. **`.dockcontainer` 的定位来源**（DOCK-06 依赖）：`dock.css:102` 的基规则里**没有** `position`，pos-left/right 才有 `fixed`。底部态它是普通流内元素，那「贴在屏幕底部」是靠 `body` 的 flex 列布局吗？我按 `width:75%` + `justify-content:center` + `overflow:visible` 得出溢出两侧不可达的结论，但如果 `body` 另有 `overflow` / 定位约束，实际表现会不同。**验证方法**：把图标大小拉到 128px、开 6 个以上应用，量 `document.querySelector(".dock").getBoundingClientRect()` 的 `left` 是否为负。
5. **`window.js:185` 的 `insertAdjacentHTML(content)`**：注入的是同源 `assets/apps/<name>.html`，而 `paths.js:67-71` 的注释说明该目录**已清空、走到这里必然 404**。所以这条路径今天是否还有活的上游调用方？请确认没有任何调用方能把用户输入或插件数据当 `file` 传进 `create()` —— 那样就是同源任意 HTML 注入。**验证方法**：`grep -rn "create(" src/javascripts/*.js` 逐个看第一个实参来源（我看到的 `dock.js:383/485` 都是 `legacyAppHtml(app)`，`app` 来自图标 `alt`）。
6. **目标环境细节**：已按「Chrome 稳定版桌面端」判定。请给出具体版本号 —— WM-01 的淡出是否发作、DOCK-06 的溢出边界都依赖 Chrome 的 `visibility` 过渡插值行为与典型视口宽度（1366 还是 1920）；若还要覆盖低配设备，J 类四项（DOCK-04/05、WM-04、对账频率）应按该口径升到 P1。

---

## 六、疑点查实结果（逐条定论，含证据）

第六章取代第五章的「待确认」。六条全部查实，**其中 3 条推翻了我原先的判断**。

### 查-1 · DOCK-01 的 2980ms → 判定：硬编码留错，不是有意设计

仓库只有 1 个提交（`git rev-list --count HEAD` = 1，`8aa417a Deskly: 品牌更名并初始化仓库`），`git log -S"2980"` 无任何命中 —— **历史给不出意图信号**，只能从代码本身判。四条依据一致指向「留错」：

1. `parabola` 是 `1s infinite`（`dock.css:369`），2980 不是它的整数倍，所以「等动画跑完」这个理由不成立；
2. `dock.js:367` 专门为这段等待加了「吞掉重复点击」的守卫 —— 作者知道这段时间长到会让人再点一次；
3. `noAnimation`（`dock.js:199`）只豁免 `["启动台","访达"]` 两个，其余 12 个内置应用无一例外要吃这 3 秒，看不出任何按应用区分的理由；
4. 整个窗口层的对标系统是 macOS（`window-manager.js:2-8` 写明「macOS 操作语义」），而 macOS 是**立刻启动 + 同时弹跳**。

**定论：按「弹一下再开」做，即第三章修复 2。** 弹跳降为一轮（1000ms），`launchApp` 提到同步执行。

### 查-2 · `finderbar.updateMenu` 的入参语义 → 判定：它是**键**，不是标签；我原先的修复方案是错的

`finderbar.js:427-430`：`getMenusForApp(app)` 直接 `appMenu[app]` 查表，表键就是中文显示名（`finderbar.js:255` `"访达": ["文件","编辑","显示","前往","窗口","帮助"]`，`finderbar.js:71` `"访达": {...}`）。而 `finderbar.js:669` 又把这同一个字符串 `textContent = app` 当**标签**渲染，菜单项标题反倒走了翻译（`finderbar.js:677` `i18n.t(MENU_KEYS[menu], menu)`）。

所以：

- 我原先给的 `updateMenu(i18n.t("app.finder","访达"))` **不能用** —— 传 "Finder" 会查不到 `appMenu` 表，掉进 `DEFAULT_APP_MENU` 通用默认集（`finderbar.js:430`），访达自己的「文件 / 前往」菜单就没了。
- `window-manager.js:373` 的 `updateMenu("访达")` **本身没错**，它是稳定的表键；`finderbar.js:485` 还有一处同样写法。
- **真正的缺陷在渲染点 `finderbar.js:669`**：表键被原样当标签输出，非中文语言下顶栏显示「访达」。I18N-01 的位置要挪。

### 查-3 · `plugin-manager.unloadApp` 引用计数 → 判定：**没有缺陷，撤回该疑点**

`plugin-manager.js:626-632` 的实现是对的：

```js
export function unloadApp(id, appId) {
    broadcast("plugin-app-unload", { id, appId });
    const survivors = Array.from(document.querySelectorAll(`.window[data-plugin-id="${id}"]`))
        .filter((w) => !w.classList.contains("closing"));
    if (survivors.length) return;
    unload(id);
}
```

再核对调用时序：`window-manager.js:671-674` 是 `release(el)` → `el.remove()` → `commitStack()` → `releaseResources(...)`，被关闭的那扇窗口在计数前已从 DOM 摘掉，不会被算进 survivors。同插件多实例（office 套件的文稿 / 表格）共享 `data-plugin-id`，关掉其一 → `survivors.length === 1` → 直接 return，不卸载。`unload()` 里 `:660` 的「按 `data-plugin-id` 一次清干净」只在 survivors 为 0 时才可达。**结论：引用计数正确，此疑点作废。**

### 查-4 · `.dockcontainer` 的定位与溢出边界 → 判定：结论成立，**且比我原先说的更严重，升 P1**

`main.css:36-54` 实测到三条关键事实：

```css
body, html {
    overflow: hidden;          /* :37  ← 决定性证据 */
    display: flex;             /* :43 */
    flex-direction: column;    /* :44 */
    justify-content: space-between;  /* :45 ← .dockcontainer 靠这个贴底 */
    align-items: center;       /* :46 */
    width: 100vw; height: 100dvh;
}
```

- 「贴在屏幕底部」确实靠 `body` 的 flex 列 + `space-between`（`.desktop{flex:1}`，`desktop.css:4`） —— 我原先的假设成立。
- **`overflow: hidden` 在 `body` 和 `html` 上**：Dock 溢出视口的部分不是「需要横向滚动才能看到」，而是**被直接裁掉、永远出不来、连滚动条都不给**。叠加 `.dockcontainer{width:75%}` + `align-items:center`，溢出是对称发生在两侧的 —— 被切掉的正是最左的**访达与启动台**，而这两个在 `DOCK_PROTECTED`（`dock.js:94`）里、用户既移不掉也点不到。
- 所以后果是「窄屏 + 大图标 + 多应用时，用户无法打开访达」，符合 P1 定义里的「特定场景不可用」。**DOCK-06 由 P2 升 P1。**

### 查-5 · `create()` 的调用方与 HTML 注入面 → 判定：无 XSS，但**查出两个新问题**

全仓 `create(` 只有 2 个调用点：`dock.js:383`（`create(legacyAppHtml(app), img.alt, …)`）与 `dock.js:485`（`legacyAppHtml("系统设置")` 硬编码）。`app` 的来源链是 `img.alt` ← `makeContainer(app)` ← `favorites`（`localStorage:webstartos_dock_order`）/ `recentApps` / `syncRunningApps` 的窗口 id ← 插件 manifest 名。

- **不构成 XSS / 任意读文件**：`assetPath(rel) = './assets/' + rel`（`paths.js:13`），`../` 会被浏览器按 URL 规范化拦在扩展包内，够不到别的源；`insertAdjacentHTML` 注入的只能是扩展自己包里的 HTML，本来就同源可信。**我原先设的「同源任意 HTML 注入」降级为不成立。**
- **新问题 A（P2）**：`assets/apps/` 已被清空（`paths.js:67-71` 自述「走到那里必然 404 并弹提示」），而 `pruneStaleRecents()`（`dock.js:286-293`）**只过滤 `recentApps`，`favorites` 从未被 `isKnownApp` 过**。于是卸载或改名一个 ZIP 插件后，残留在 `webstartos_dock_order` 里的旧显示名会一直留在收藏区，点它就走进这条死路 → 弹一个「加载 App 时遇到错误 / 未找到该应用的界面模板」的对话框。这是用户能实际撞到的。
- **新问题 B（P3）**：既然旧式分支是死的，`window.js:213-218` 的双 rAF + 300ms + 450ms 三次 `resetWindowListeners` 兜底重试，每次点 Dock 图标都会空跑三遍全量 `body > .window` 扫描。

### 查-6 · 目标环境 → 定为 Chrome 154.0.8037.98 稳定版 · 桌面端

本机实测：`C:\Program Files\Google\Chrome\Application\154.0.8037.98\`（未装 Edge）。基准口径确定为：**Chrome 154 稳定版、桌面端、最窄按 1366×768 考虑**。

- WM-01 成立性：`visibility` 的可插值延迟 Chrome 早已支持，版本不构成豁免，**P1 维持**。
- CSP-01：MV3 扩展页 `script-src 'self'`（无 `unsafe-eval`）到 154 未变，**维持**。
- 低配设备不纳入本轮：J 类四项（DOCK-04、DOCK-05、WM-04、DOCK-09）在 154 + 窗口数 ≤ 10 的前提下开销有界，**维持 P2**，不升 P1。若后续要覆盖低配，按此条改判即可。

---

## 七、修订后的严重度统计

| 严重度 | 原报 | 修订后 | 变动 |
|---|---|---|---|
| P0 | 0 | **0** | — |
| P1 | 5 | **6** | DOCK-06 自 P2 升上来（查-4 拿到 `body{overflow:hidden}`） |
| P2 | 9 | **10** | 新增 DOCK-10（favorites 不剪枝，查-5）；I18N-01 位置挪到 `finderbar.js:669`、CSP-01 / DOCK-05 / WM-05 维持 |
| P3 | 6 | **8** | 新增 DOCK-11（死代码三次兜底重试空跑，查-5）；WM-01 的撤回项不占位 |

撤回项：**查-3（unloadApp）经核实无缺陷，不列入清单**。

---

## 八、按 P 排序的修复方案（执行顺序 = 表内顺序）

> 全部为最小改动，不加依赖、不换技术栈、保持原风格（4 空格缩进 @ dock.js / 2 空格 @ window-manager.js、中文注释）。

### P1（6 项）

| 序 | ID | 文件:行 | 动作 | 工作量 |
|---|---|---|---|---|
| 1 | WM-01 / WM-01b | `dock.js:1529-1549` + `windowframe.css:82` | 删内联 `transition`，改由 `.window.minimized` 独占淡出；`.wm-animating` 加 `:not(.minimized)` | 小 |
| 2 | DOCK-01 | `dock.js:366-375` | `launchApp` 提到同步，弹跳降为 1000ms 一轮 | 小 |
| 3 | DOCK-06 | `dock.css:102-108 / 138` | 底部 Dock 补横向可滚动 + 上限收到 100vw | 小 |
| 4 | DOCK-02 | `dock.js:873 / 892 / 916-923` | `updateRecents` 加 `rerender` 开关，对账末尾统一重画最近区 | 小 |
| 5 | DOCK-03 | `dock.js:466-480` | `keepInDock` 改成「改数据 + 全量重画」，不再手工搬 DOM | 小 |
| 6 | WM-02 | `window-manager.js:395-404` + `:1084` | `detachStates` 一并清 `fullscreen`；`startResize` 补全屏守卫 | 小 |

第 1、2、4、5、6 项的完整替换代码见**第三章 修复 1–5**，逐字可用。这里补上第 3 项（原第四章建议，现升 P1）：

**P1-3 · DOCK-06 —— 让溢出的图标重新够得着**

`assets/stylesheets/dock/dock.css` 第 102–108 行与第 138 行：

```css
.dockcontainer {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 改：75% 是「居中留白」的视觉宽度，但两侧一旦溢出就被 body 的 overflow:hidden
     直接裁掉（main.css:37），被切的是移不掉的访达 / 启动台。给它视口上限 + 横向滚动。 */
  width: auto;
  max-width: 100vw;
  height: auto;
  padding-bottom: 5px;
}

.dock {
  /* …原有属性不动… */
  overflow-x: auto;
  overflow-y: visible;          /* 放大时图标必须能溢出上沿，竖向不能一起裁掉 */
  scrollbar-width: none;        /* Firefox 系隐藏条 */
}
.dock::-webkit-scrollbar { display: none; }   /* Chrome 154 走这条 */
```

> 两个约束不能破：① `.dock` 的 `overflow-y: visible` 是必需的 —— 放大动画靠图标向上溢出（`dock.js:1256` 的 `slack`），改成 `overflow:auto` 双向会把溢出部分一起裁掉；但 `overflow-x:auto` 与 `overflow-y:visible` 在 CSS 规范里会被计算成 `auto`/`auto`，**所以真要保上沿溢出，就得用「外层滚、内层不裁」两层结构**：`.dockcontainer` 承担 `overflow-x:auto`，`.dock` 保持 `overflow:visible`。上面的 `.dock` 两条改为挂在 `.dockcontainer` 上即可。② 亚克力禁忌：这条链路上不得引入 `transform`（`dock.js:1144`、`windowframe.css:96-97`）。
>
> 落盘后必须实测一次（静态推理到不了这里）：图标大小拉 128px、开 6 个应用，确认 `document.querySelector(".dock").getBoundingClientRect().left >= 0` 且访达仍可点。

### P2（10 项，按收益/成本排）

| 序 | ID | 文件:行 | 方案 | 工作量 |
|---|---|---|---|---|
| 7 | DOCK-04 | `dock.js:1120-1128` | 回调里过滤 records：`addedNodes`/`removedNodes` 无 `.window` 根元素就 return，消掉拖动预览框 / 遮罩引起的全量对账 | 5 行 |
| 8 | I18N-01（位置已改） | `finderbar.js:667-669` | **只翻标签、不动表键**（查-2）：`const LABEL_KEYS = { "访达": "dock.finder" }; appMenuElement.textContent = LABEL_KEYS[app] ? i18n.t(LABEL_KEYS[app], app) : app;`。`dock.finder` 四个语言包都已存在（已核）。第三方插件名由插件自己作名，内核不越权翻译 | 3 行 |
| 9 | DOCK-10（新） | `dock.js:286-293`、`769-782` | 把 `pruneStaleRecents` 的剪枝同样施加到 `favorites`：`loadFavorites()` 里 `favorites = saved.filter(isKnownApp)`（保住 `ensureProtectedFavorites` 的补回逻辑），并在 `refreshIconsFromRegistry` 里一并 `saveFavorites()`。顺序：`isKnownApp` 依赖注册表，必须在 `plugins-ready` 之后跑 | 中 |
| 10 | WM-03 | `wm/frame.js:30-51` | 程序坞不可见时不扣带：`hidden` / `deskly-fullscreen 且未 reveal` 时令 `bottom/left/right = 0`；顺带解掉 `window-manager.js:1430` 恒真的 `vf.bottom > 0` | 小 |
| 11 | SW-01 | `sw.js:124-142` | 模块级 `let dbPromise` 复用连接，事务 `oncomplete` 里 `db.close()` | 小 |
| 12 | WM-05 | `dock.js:850` | 与窗口层对齐成一份判据：改 `body > .window` 并过 `isWindowElement`（门面已导出，`window.js:59`） | 小 |
| 13 | WM-04 | `window-manager.js:1392-1407` | rAF 合帧 + pending 标志；`visibleFrame()` 提到循环外只求一次 | 小 |
| 14 | DOCK-05 | `dock.js:683-697` | 缓存 `tip.offsetWidth/Height`（仅 `textContent` 变化时重算）；位置与上帧相同则不再续 rAF | 中 |
| 15 | CSP-01 | `index.html:83` | 已核 `swift-notification` 无调用点 → 从入口摘掉 `webswift.js`，或裁掉 `new Function` 分支改注册表分发（与 `ui/menuCommands.js` 同法）。前者更省但要先确认 `swift-messagebox` 等的真实消费者 | 小 |
| 16 | A11Y-01 | `dock.js:507-523 / 546 / 1449-1456` | `.container` 加 `role="button" tabindex="0"`；`openApp` 补绑 `click`（保留 `mouseup` 会吞键盘 Enter）；`highlightDockNav` 里调 `img.focus()`；`.badge` 补 `aria-label` | 中 |

### P3（8 项）

| ID | 位置 | 动作 |
|---|---|---|
| WM-06 | `window-manager.js:60` | 删未引用的 `ANIM_MS`，或让 `wm/frame.js:78` 的 `320` 改读它（两处数字当前不一致） |
| WM-07 | `window-manager.js:521` | 删 `&& !rec._tileAnchor`（全仓从未赋值） |
| WM-08 | `window-manager.js:630 / 111` | `restore` / `isMinimized` 补 `if (!el) return` |
| DOCK-07 | `dock.js:438-464 / 1103-1109` | 两处移除后补 `refreshIconList()`；或与 `collectIcons` 合成一份带 `isConnected` 复核的缓存 |
| DOCK-08 | `dock.js:422-435` | `quitApp` 补 `else` 分支复位 `appStatus` 与圆点；`light` 统一判空 |
| DOCK-09 | `dock.js:747 / 1233`、`window-manager.js:1422` | 合并 document 级 mousemove（只「记坐标 + 唤醒帧」），或至少改正 `dock.js:1146` 那条与代码不符的注释；删 `dock.js:1073-1075` |
| DOCK-11（新） | `window.js:213-218` | `assets/apps/` 已空（`paths.js:67-71`），旧式装载分支与双 rAF + 300/450ms 三次兜底重试是死代码；确认 DOCK-10 剪枝生效后一并删除 |
| — | `window-manager.js:1114-1117 / 560` | `40` / `24` / `80` / `step=24` 提为带注释常量，与 `frame.js` 的 `EDGE_BAND` / `KEEP_VISIBLE` 同一风格 |

---

## 九、建议的落盘批次

按「一次改完可独立验证」切三批，每批跑一次静态闸（`node --experimental-vm-modules` + `dev/static-check.mjs`），第 3 项另需真 Chrome 复验：

1. **第一批（纯 dock.js，风险最低）**：P1-2、P1-4、P1-5，加 P2-7、P2-9、P2-12。
2. **第二批（跨 CSS，需渲染复验）**：P1-1（dock.js + windowframe.css）、P1-3（dock.css）—— 这批必须量 `getBoundingClientRect` 与动画实际是否成组，静态判不出来。
3. **第三批（碰窗口层核心）**：P1-6、P2-10、P2-13，然后跑 `.workbuddy/tmp/wm-check.cjs` 全量回归。

> 改 `mods/` 与设置插件文件前按项目惯例先 `ls -l --time-style=+%H:%M` 对 mtime（此前有并发会话覆写的记录）。本次审查全程只读，未触碰任何源文件。

---

## 十、修复完成性审查（落盘后回填）

第九章的三批已全部落盘，并新增两道真浏览器闸。**当前工作区实测：dock-check 28/28、wm-check 71/71、`dev/static-check.mjs` 通过，合计 99 项断言 0 失败。**

### 10.1 逐项状态

| ID | 落点 | 状态 | 凭据 |
|---|---|---|---|
| WM-01 | `dock.js` fallBackFadeOut + `windowframe.css:87` | ✅ 已修 + 已验 | 「最小化不再写内联 transition」/「visibility 带 0.35s 延迟」实测 `opacity, visibility / 0s, 0.35s` |
| WM-01b | 同上 | ✅ 已修 + 已验 | 「早还原后不留内联 transition」、「最小化过一次之后缩放仍有几何过渡」 |
| DOCK-01 | `dock.js:427-435` | ✅ 已修 + 已验 | 点击到窗口出现 **63ms**（旧值 ≥2980ms）；弹跳类 1s 后自动摘除 |
| DOCK-02 | `dock.js` syncRunningApps 收尾 + `updateRecents(altName, rerender)` | ✅ 已修 + 已验 | 关闭记事本后 `{running:false, recent:true, inData:true}` |
| DOCK-03 | `dock.js` keepInDock | ✅ 已修 + 已验 | 未运行应用点「在程序坞中保留」→ `{before:false, after:true, stale:false, saved:true}` |
| DOCK-06 | `dock.js` effectiveDockSize + `dock.css:111-121` | ✅ 已修 + 已验（**方案与第八章不同，见 10.2**） | 128px + 6 应用：dock 左 82 / 右 1358 均在 1440 视口内，图标回缩到 112px，访达仍可达 |
| WM-02 | `window-manager.js` detachStates + startResize 守卫 | ✅ 已修 + 已验 | 全屏中设 frame → `{fullscreenFlag:false, rootClass:false}`；随后 resize 不再弹回（仍 640×400） |
| WM-03 | `wm/frame.js` dockReservesSpace | ✅ 已修 + 已验 | 自动隐藏收起时 `bottom: 78 → 0`，可视高 `798 → 876` |
| WM-04 | `window-manager.js` resize 合帧 | ✅ 已修（间接验证） | wm-check 的「视口变小后窗口仍在可点范围」通过；未单独计量帧数 |
| WM-05 | `dock.js:874` + `window.js:184` + `session.js:20` + `debug.js:208` | ✅ 已修 + 已验 | 见 10.3 同类横向排查 |
| DOCK-04 | `dock.js` dockSyncObserver records 过滤 | ✅ 已修 + 已验 | 用「最近区节点身份」作探针：无关 body 变更不重绘、真窗口增删仍重绘 |
| DOCK-05 | `dock.js` updateTipPosition | ✅ 已修（放大行为回归已验） | 提示跟随未回归；未单独计量强制布局次数 |
| DOCK-09 | `dock.js` pointerMoveHooks | ✅ 已修 + 已验 | 三条 document mousemove 合成一条后，悬浮放大仍生效（50px → 89px） |
| DOCK-07 | `dock.js:484` + 拖出移除 | ✅ 已修 | `removeFromDock` / 拖出移除后补 `refreshIconList()` |
| DOCK-08 | `dock.js` quitApp / forceQuit / launchApp / openApp | ✅ 已修 | `light` 四处统一判空；quitApp 补 else 复位 + 主动对账 |
| DOCK-10 | `dock.js` pruneStaleFavorites + isResolvableApp | ✅ 已修 + 已验 | 冷启动注入假名 → 被剪掉、Dock 上不再渲染，且访达/启动台/Safari/系统设置/App Store 全部保留 |
| SW-01 | `sw.js` openDb + `plugin-manager.js` _openDb | ⚠️ 已修，运行时**未验** | 见 10.4 |
| I18N-01 | `finderbar.js` APP_NAME_KEYS + dataset.appKey | ✅ 已修 + 已验（**位置与第八章不同，见 10.2**） | 英文下顶栏显示 `Finder`，而 `dataset.appKey` 仍是 `访达`（菜单表没掉进默认集） |
| A11Y-01 | `dock.js` makeContainer / bindClickEvent / highlightDockNav / setBadge + `dock.css` 焦点环 | ✅ 已修 + 已验 | `role=button, tabindex=0, aria-label, aria-hidden(img), focusable`；键盘 Enter 实测能打开系统设置 |
| CSP-01 | `assets/vendor/webswift.js` 两处 | ✅ 已修 + 已验 | 剥注释后 `new Function` 计数 **0**（第八章原本写的是「包一层 try/catch」，见 10.2） |
| WM-06 / 07 / 08 | `window-manager.js` | ✅ 已修 | 删 `ANIM_MS` 并把权威值收进 `frame.js:WM_ANIM_MS`；删死条件 `_tileAnchor`；`restore`/`isMinimized` 补判空 |
| P3 魔法数 | `window-manager.js` | ✅ 已修 | `RESIZE_KEEP_GRABBABLE / RESIZE_KEEP_TITLE / RESIZE_MAX_OVERFLOW / CASCADE_STEP` |
| DOCK-11 | `window.js:205-214` | ✅ 已修（保守版） | 只把三趟 `resetWindowListeners` 兜底重试移进「真的注入了 HTML」那一支；**没有**删旧式装载分支本身 —— 它的 404 错误框是唯一能让用户看清「这个应用已不存在」的出口，删了会变成静默失败 |

### 10.2 落盘时改掉的三个原方案（都不是照抄第八章）

1. **DOCK-06 放弃 `overflow-x:auto`**。第八章写的是「给容器加横向滚动」，落盘前发现它**会连带裁掉放大溢出**：CSS 里 `overflow-x` 一旦非 `visible`，`overflow-y` 就被计算成 `auto`，而「图标放大时向上溢出底栏盒子」正是这套 Dock 的前提（玻璃面板下沉到 `.dock::before` 就是为了不裁它）。改成 `effectiveDockSize()` 按「可用带宽 ÷ 图标数」回缩 —— 溢出根本不发生，`visibleFrame()` 读到的高度也自动跟着变小。
2. **I18N-01 的修复点从调用方挪到渲染点**。第八章原写 `updateMenu(i18n.t("app.finder","访达"))`，查-2 已证伪（表键会变）。落盘时又发现两处回灌：`finderbar.js:704 currentMenuApp()` 与 `:753 languagechange` 处理器都是**拿标签当表键**再调 `updateMenu` —— 只翻译标签会让这两条链在非中文下查不到菜单表。所以标签与键拆开：标签走 `APP_NAME_KEYS`，键单独存进 `dataset.appKey`。
3. **CSP-01 直接删 eval，而不是包 try/catch**。安全扫描钩子提示得对：`try { new Function(...) } catch {}` 只是让它不崩，把字符串当代码编译这件事本身还在。`<swift-button>` / `<swift-notification>` 全仓零消费者，命令分发的正解是 `ui/menuCommands.js` 的注册表查表，所以直接移除 eval 路径、留注释禁止回退。

### 10.3 同类问题的横向排查结果（按「修一个 → 扫全仓同一模式」执行）

| 模式 | 扫到的其它位置 | 处置 |
|---|---|---|
| **内联 `style.transition` 覆盖类规则**（WM-01 同族） | `dock.js:1180/1369` 写 `DOCK_TRANSITION` | ✅ 同修：把 `DOCK_TRANSITION` 补成与 `.dock` 类规则同构（含 `visibility 0.4s ease`）——自动隐藏收起时程序坞此前也是**瞬间消失**，同一成因 |
| 同上 | `finderbar.js:913 / 953` 子菜单 `transition:"none"` / `:"opacity .15s"` | ⚠️ **已记账未修**，见 10.5 FINDER-01 |
| **`.window` 判据不统一**（WM-05 同族） | `session.js:20`（只排 `.finderbar`）、`window.js:184/186`、`plugin-manager.js:394/412` 与 `:546/560`、`debug.js:208/216`、`zindex.js:72` | ✅ 前四处统一改成 `body > .window`（`session.js` 另加了不引循环依赖的说明）；`debug.js` 两处是诊断读数，一并改准；`zindex.js:72` 只用于求一个 max 且对 `.window` 已早退，**判为不必改** |
| **「取最后一个 .window」的错取法** | `plugin-manager.js:412 / 560` —— 而 `:542` 的注释**早已写明这个坑**、代码却没跟上 | ✅ 改成与 `window.js:182` 同款的「注入前集合快照 → 注入后取差集」；`window.js:186` 同步补上 `body >` |
| **`indexedDB.open` 每次新开不缓存**（SW-01 同族） | `plugin-manager.js:720 _openDb`（同一个库 `webstartos-plugins` 的第 3 个读写方） | ✅ 照本仓正解（`osfs.js:84` / `api-grants.js:93`）补 `dbPromise` 缓存 + `onblocked` 释放 + `onversionchange/onclose → close` |
| **自续 rAF 无 `document.hidden` 守卫** | `dock.js:827` 提示跟随循环 | ✅ 补守卫，**正解样板就在本仓** `surface.js:355`（`document.hidden` 时退回 setTimeout） |
| **`updateX` 在循环里全量重建 DOM** | `syncRunningApps` 第 3 步每个新开应用各调一次 `updateRecents → renderRecents(innerHTML="")` | ✅ 加 `rerender` 开关，对账末尾统一画一次 |
| **MutationObserver 不做 record 过滤** | `bootstrap.js:129`（只处理 `addedNodes` 里的 IMG）、`cursor.js:318/330`（按 record 类型分流） | ✅ 复核后**判为已经过滤、不必改** |
| **状态标记设了不更新**（自查抓到的自伤） | 我给 `.container` 写了 `aria-pressed`，但 `syncRunningApps` 不同步它 → 对读屏永久谎报「运行中」 | ✅ 在收藏项循环与启动台分支里补 `setAttribute/removeAttribute` |
| **我自己引入的 ReferenceError** | 一次编辑把 `hostEl` 写进了 `setBadge`（该名字不存在） | ✅ 当场发现并改成 `img.parentElement`；随后靠「逐标记 grep 回读 + 全文件 vm 解析」兜住 |

### 10.4 明确记为 not-run（不计入通过）

| 项 | 原因 | 建议补验方式 |
|---|---|---|
| **SW-01 运行时连接计数** | 页面里探针跑出 `0 次` 是**假绿**：`webstartos-plugins` 只服务 ZIP 安装的插件，本轮打开的记事本 / 系统设置都是磁盘内置插件，整条路径根本不落 IDB。已把该断言降级成显式 `not-run` 行，并补一条 Node 侧静态断言（open 调用确实在缓存 promise 之后）| 用 `.workbuddy/tmp/make-zips.cjs` 造一个 ZIP 插件装进去、再 `IDBFactory.prototype.open` 计数 |
| DOCK-05 / WM-04 的**强制布局次数** | 只回归了行为（放大、视口变化后窗口仍可点），没有测帧数 | Performance 面板录一次拖动 + 一次 hover |
| `zindex.js:72` 判为不必改 | 静态推理，未实测伪 `.window` 对它求 max 的影响 | — |

### 10.5 落盘过程中新查出的两个问题（本轮未修，需单独排期）

| ID | 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| **FINDER-01** | P2 | `finderbar.js:913` + `:953` | 与 WM-01 **完全同族**：`closeAllMenus()` 在 300ms 后给每个 `.menu` 写内联 `transition:"none"` 并**永久留在元素上**；下一次打开时 `classList.add("visible")` 发生的时刻内联值仍是 `"none"`（代码要再过 50ms 才把它设回 `opacity .15s`），于是**第二次起菜单打开就没有淡入**。而那个 300ms 延时器还会掐掉 300ms 内重开动画 —— 与刚修的 `_hideTimer` 同一模式。已确认 `finderbar.css` 的 `.menu` 基规则**里没有** transition，所以过渡目前只由内联 JS 提供，不能照 dock.js 那样直接删 | 把 transition 落到 `.menu` / `.menu.visible` 样式表（单一权威），删掉两处内联写入与那个延时定时器。**不在本次商定范围内，且修法必须肉眼验一次菜单淡入，故只记账不盲改** |
| **VENDOR-01** | P3 | `assets/vendor/webswift.js`（`swift-button` / `swift-notification` 构造函数） | 移除 eval 后，这两个元素仍然**无法实例化**：Blink 在 `createElement` 期间若自定义元素构造函数给自己写属性就抛 `The result must not have attributes`（厂商库的 `syncProps` 机制使然）。这是独立于 CSP 的既有缺陷，本轮改动没有引入、也没有修复它 | 两个元素零消费者，最省事是从包里裁掉；若将来要用，需重写成「connectedCallback 里再同步属性」 |

### 10.6 落盘清单（按 mtime 取证，共 13 个源文件 + 1 份文档 + 1 个新验证脚本）

`src/javascripts/dock.js`、`src/javascripts/window-manager.js`、`src/javascripts/window.js`、`src/javascripts/plugin-manager.js`、`src/javascripts/finderbar.js`、`src/javascripts/session.js`、`src/javascripts/debug.js`、`src/javascripts/wm/frame.js`、`sw.js`、`assets/stylesheets/dock/dock.css`、`assets/stylesheets/ui/windowframe.css`、`assets/vendor/webswift.js`；新增 `.workbuddy/tmp/dock-check.cjs`（28 项断言，与 `wm-check.cjs` 并列成窗口层 + Dock 的常驻回归闸）。

> **git 不能当这轮的基线**：本仓只有 1 个提交，开工前工作区已有 69 个文件、+9169/−3639 的未提交改动（多数不是本轮产生），`git diff --stat` 会把它们混进来。上面的清单是按 `find -newermt` 逐个核对 mtime、再逐标记 grep 回读得到的。
>
> **并发覆写核查**：落盘后复查发现 `dock.js`、`finderbar.js` 的 mtime 被另一路会话刷新过（同时 `docs/产品更新信息.md` 也被改写）。逐个 grep 本轮新增标记确认**全部健在**，并据此**重跑三道闸**（28/28、71/71、静态检查通过）—— 表内所有实测数字都是当前工作区的，不是改完那一刻的。

---

## 附：关于实测口径的说明

审查阶段（第一～五章）**没有**把结论建立在浏览器运行环境上。项目已知：内置测试标签页是 0×0 隐藏视口、`requestAnimationFrame` 不派发、`setTimeout` 被钳到 ≥1s，而本轮这几类缺陷（淡出、每帧布局、3 秒延迟、横向溢出）恰好全部依赖动画与真实视口，在那个环境下测出来的一定是假结果。所以第一～五章的每条结论都以静态代码 + CSS 规则取证，都能指出具体行号。

落盘阶段（第十章）改用**真 Chrome + CDP**（`playwright-core` 驱动系统 Chrome 154，本地 http 源下 Service Worker 与 IndexedDB 行为等同扩展页），这才第一次实测到淡出的 `transition-delay`、启动延迟毫秒数、Dock 边界矩形、IDB 连接守卫这些必须跑起来才说得清的东西。两道闸留在仓里当常驻回归：

```
node .workbuddy/tmp/wm-check.cjs     # 窗口层 71 项
node .workbuddy/tmp/dock-check.cjs   # Dock / 交接带 28 项
node dev/static-check.mjs            # 导入解析 / 资源存在 / 四语言键齐平
```
