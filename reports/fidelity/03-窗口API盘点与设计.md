# 03 窗口 API 盘点与设计

- 审查日期：2026-11-05
- 审查对象：窗口系统对外接口全貌（内核导出 / 元素侧 API / `Deskly.windows` / 声明式 `data-window` 与 `manifest.window`）
- 审查方式：静态代码走查（只读）+ Node 脚本核对接线（导出被引用面、`data-window` 解析白名单、旧钩子存活面）
- 口径衔接：绿键单击/⌥单击语义反转、全屏/分屏/台前调度的行为差距已在 [02-全屏分屏空间与台前调度一致性审查](file:///e:/hello/StartOS/reports/fidelity/02-全屏分屏空间与台前调度一致性审查.md)（FS-01 等）记录，本文不重复定级，只在其涉及接口设计处引用
- 修复状态：全部「待修复」；本文件同时是窗口调度重写的接口规格

---

## 0. 结论速览

- 现状缺陷 **14 条**（WAPI-01 ~ WAPI-14）：高 1 / 中 5 / 低 7 / 信息 1。
- 新 API **9 组**（NW-1 ~ NW-9），全部贴合现有实现（焦点栈、`data-window` 声明链、信封返回、`guard()` 权限），旧调用零破坏。
- 最该先落地的 3 条：**NW-1 母子窗口关系**（WAPI-04 的直接解药，Dock/菜单过滤都挂在它上面）、**NW-8 状态查询与事件**（WAPI-03，插件唯一可观测通道）、**NW-7 同应用多窗口**（WAPI-05，办公套件已在清单里向用户承诺）。

---

## A. 现状盘点

判定口径：**符合** = 与 macOS 语义一致或为有意的合理自有设计；**偏离** = 行为与 macOS 或自身声明不符；**缺失** = 没有该能力。

### A.1 打开窗口

- 两条装载路径：插件统一走 `openApp(nameOrId, {light, centered, file})`（[plugin-manager.js](file:///e:/hello/StartOS/src/javascripts/plugin-manager.js#L657-L662)），内部分单应用 `doLoad`（[L792-L917](file:///e:/hello/StartOS/src/javascripts/plugin-manager.js#L792-L917)）与多应用 `doLoadApp`（[L664-L731](file:///e:/hello/StartOS/src/javascripts/plugin-manager.js#L664-L731)）；旧式模板路径 `create(file, name, light, centered)` 仍在（[window.js](file:///e:/hello/StartOS/src/javascripts/window.js#L119-L226)），但 `assets/apps/` 已是空目录，该路径事实上只剩 404 报错分支（见 WAPI-14）。
- 入场序列：`prepareOpen` 隐藏 → `manage` 接管+居中 → `revealOpen` 逐帧等几何稳定后显示（[window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L1352-L1421)），慢脚本有 250ms 兜底。
- 判定：**符合**。缺口：插件侧没有任何「开窗口」API，只能由内核按清单代开（→ NW-7）。

### A.2 关闭窗口

- `close(el)`（[window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L698-L734)）：幂等（`rec.closing`），淡出动画 + 300ms 兜底，收尾 `release` → 摘 DOM → `releaseResources`（插件走 `unloadApp` 引用计数，旧式移除脚本/样式表，[L740-L755](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L740-L755)）。
- 拦截能力：仅 `window.specialCloses` 全局钩子（[window.js](file:///e:/hello/StartOS/src/javascripts/window.js#L80)），普通可写全局、按名字匹配，插件无法对「未保存内容」做关闭确认。
- 判定：**偏离**（缺可取消的关闭拦截 → NW-9）。

### A.3 最小化 / 恢复

- `setMinimized(el, minimize)` / `restore(el)` / `toggleMinimize(el)`（[window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L647-L690)）：genie 吸入 Dock 图标（`window.__dock.minimizeToDock`），三处标记（`_minimized` / `.minimized` / `display:none`）合并判定。
- 判定：**符合**。事件外发缺失（→ NW-8）。

### A.4 缩放态（绿键「最大化」）

- `setZoom(target, {animate, on})` / `toggleZoom`（[window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L467-L501)）：用户框架 ↔ 填充可视区，`zoomFrame` 过 `limitsOf` 夹尺寸。
- 绿键单击 = 缩放、⌥单击 = 全屏，与 macOS 相反——**偏离**，已记 02 报告 FS-01，接口重写时一并翻转。
- `maximizable:false` 只熄灭绿键，不拦 `setZoom`/`tile`/双击标题栏以外的路径（WAPI-02）。

### A.5 边框缩放（resize）

- 八向边带 `.wm-edge`（[window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L909-L918)）解决 iframe 内容吃事件；`resizeFrame` 对侧边锚定、⌥ 临时锁宽高比（[wm/frame.js](file:///e:/hello/StartOS/src/javascripts/wm/frame.js#L241-L287)）；`setResizable` 落 `.no-resize` + `data-wm-resizable`（[window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L635-L639)）。
- 判定：**符合**。缺口：无常驻宽高比、无单轴缩放（→ NW-3）。

### A.6 拖拽与边界约束

- 拖动只认 `[data-titlebar]`，无标题栏退顶部灯区带 `bandOf`（[window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L846-L875)）；`clampDrag` 保证标题栏不进菜单栏、窗口留 120px 可抓（[wm/frame.js](file:///e:/hello/StartOS/src/javascripts/wm/frame.js#L189-L199)）；推到边缘出平铺预览。
- `draggable:false` 声明经 `applyConfig` 落 `data-wm-draggable="false"`（[window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L223)），`inDragZone` 唯一消费点（[L848](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L848)）。
- 判定：**符合**。缺口：无 `dragAxis`/`dragBounds`/`fixed`；`draggable:false` 不豁免视口 resize 时的强制回拉（WAPI-13）。

### A.7 窗口尺寸约束（min/max）

- 三处声明源，优先级 `data-window` > `manifest.window` > 应用 CSS（[window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L205-L227)）；`limitsOf` 统一读计算样式（[wm/frame.js](file:///e:/hello/StartOS/src/javascripts/wm/frame.js#L142-L152)）。
- 判定：**符合**。缺陷：`data-window` 里写 `minWidth:600` 会被解析器 warn 忽略（WAPI-07）；`configure` 部分字段持久化丢失（WAPI-08）。

### A.8 层级与焦点栈

- 焦点栈 `stack` + `commitStack` 按栈序在 [2050, 9000] 内重排（[window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L288-L309)、[zindex.js](file:///e:/hello/StartOS/src/javascripts/zindex.js#L27-L29)）；Dock 9500 压顶。
- 判定：**符合**（普通窗）。缺失：窗口区间内无 normal/floating/panel/modal 分级（WAPI-04 关联，→ NW-4）；`setGeometry` 的 z 参数虚假（WAPI-06）；`zCounter`/`zIndex` 语义过时（WAPI-12）。

### A.9 活动窗口判定

- `setFocusedWindow` 切 `.is-active` + 红绿灯灰化（[window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L315-L322)）；`updateActiveAppMenu` 无窗时回「访达」（[L398-L409](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L398-L409)）。
- 判定：**符合**。

### A.10 全屏与分屏现状

- 全屏：`setFullscreen` / `displayFrame` 覆盖整视口，`<html>.deskly-fullscreen` 收起菜单栏与 Dock，探边临时显隐（[window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L1616-L1625)）。行为差距见 02（FS-02~FS-07）。
- 分屏浏览（Split View）：**缺失**（02 已记，判定可降级）。
- 平铺：`tile`/`untile` 九分区 + 拖动吸附（[window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L547-L578)、[wm/frame.js](file:///e:/hello/StartOS/src/javascripts/wm/frame.js#L296-L341)）。**符合**。
- 接口缺陷：⌃⌘F 与 `setFullscreen` 不查 `maximizable`/`resizable`（WAPI-02）。

### A.11 台前调度现状

- 仅控制中心开关切 `.desktop.stage-manager-on` 桌面图标布局（[controlcenter.js](file:///e:/hello/StartOS/src/javascripts/controlcenter.js#L693-L700)），窗口侧无实现。**缺失**，02 已给最小规格；本文 NW-1/NW-4 的 role/level 是其分组与层级的接口前提。

### A.12 标题栏与红绿灯行为

- 组件 `<deskly-traffic-lights>`：`ACTION_EVENT` 分发 close/minimize/zoom/arrange（[window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L1277-L1287)）；`variant="dialog"` 禁最小化/缩放，`no-close/no-minimize/no-zoom` 单灯熄灭（[ui/trafficLights.js](file:///e:/hello/StartOS/src/javascripts/ui/trafficLights.js#L305-L309)）；悬停 900ms 弹排列菜单（[window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L58-L58)）；旧 `.red/.yellow/.green` 标记兼容（[L1309-L1334](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L1309-L1334)）。
- 无标题栏窗口：`mountTrafficLights` 退 overlay 悬浮（[ui/trafficLights.js](file:///e:/hello/StartOS/src/javascripts/ui/trafficLights.js#L150-L174)）+ 顶部带拖动兜底。
- 判定：**符合**（FS-01 的绿键映射除外）。缺口：按钮动作映射写死、无自定义回调；无整组隐藏声明（→ NW-5）。

### A.13 同应用多窗口复用策略

- 去重：`getElementById(windowName)` 命中即置顶复用（单应用 [plugin-manager.js](file:///e:/hello/StartOS/src/javascripts/plugin-manager.js#L814-L821)，多应用 [L672-L677](file:///e:/hello/StartOS/src/javascripts/plugin-manager.js#L672-L677)）；窗口 id = 显示名。
- 判定：**偏离**。macOS 支持 ⌘N 多窗；office manifest 已向用户承诺「每个应用可以开多个窗口」，机制上做不到（WAPI-05）。

### A.14 窗口与插件生命周期

- 引用计数以 DOM 为准（`.window[data-plugin-id]` 存活数），最后一窗关闭才 `unload`（[plugin-manager.js](file:///e:/hello/StartOS/src/javascripts/plugin-manager.js#L929-L935)）；事件只有 `plugin-app-load` / `plugin-app-open` / `plugin-app-unload` / `plugin-unload` 四个应用粒度广播。
- 判定：**符合**。缺口：无窗口粒度事件（WAPI-03）。

### A.15 窗口内 iframe / 注入关系

- 插件与内核同 document，`Deskly` 是同意与记账机制而非沙箱（[os-api.js](file:///e:/hello/StartOS/src/javascripts/os-api.js#L21-L24)）；ZIP 插件 HTML 经 `sanitizePluginHtml` 剥内联事件；Safari 插件的网页内容走 `<iframe>`，缩放靠宿主侧边带命中（[window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L896-L918) 注释为证）。
- 隐含依赖实测：mods 直接 import 内核模块而非走 `Deskly` —— `mods/safari/js/tabs.js:3` import `closeWindow`；`mods/app-store/script.js:622`、`mods/office/script.js:261` 调 `el._closeWindow`；`mods/finder/script.js:389` 调 `el._toggleMinimizeWindow`；`mods/manual/script.js:47` 直接调 `attachTrafficLights`。这些私有/半私有过渡钩子是重写时必须保留或替代的接线面。
- 判定：**符合**（已知边界），隐含依赖多。

### A.16 缺陷清单（WAPI-01 ~ WAPI-14）

| ID | 级别 | 缺陷 | 证据 |
|---|---|---|---|
| WAPI-01 | **高** | `center()` 把 `_wmPlaced` 写在 rec 上，`applyConfig` 却读 `el._wmPlaced`：托管窗口该标记永远不落元素，凡生效配置带 `centered:true` 的窗口，每次 `configure()` 都被重新居中（用户挪过位置也会被拽回），并连带 `detachStates` | [window-manager.js:224](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L224) vs [L604-L610](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L604-L610)；触发方 [calculator/script.js:954](file:///e:/hello/StartOS/mods/calculator/script.js#L954) + [calculator/index.html:15](file:///e:/hello/StartOS/mods/calculator/index.html#L15) |
| WAPI-02 | 中 | `minimizable/maximizable/resizable:false` 只熄灭红绿灯；`setFullscreen`（含 ⌃⌘F）、`setZoom`、`tile`、finderbar 菜单命令全不查能力位，仅双击标题栏查 `.no-resize` | [window-manager.js:509-L526](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L509-L526)、[L1606-L1613](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L1606-L1613)、[L1045](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L1045)；[finderbar.js:1291-L1299](file:///e:/hello/StartOS/src/javascripts/finderbar.js#L1291-L1299) |
| WAPI-03 | 中 | 窗口层零事件：window-manager 全文无一处 `dispatchEvent`；插件只能轮询 `stateOf` | [window-manager.js](file:///e:/hello/StartOS/src/javascripts/window-manager.js)（Grep `dispatchEvent\|CustomEvent` 无命中） |
| WAPI-04 | 中 | 无母子/模态概念：所有 `.window` 皆顶层；`syncRunningApps` 把每个带 id 的真窗口计入 Dock 运行区与 `appStatus`，辅助窗/面板必然污染 Dock 与「窗口」菜单 | [dock.js:1265-L1302](file:///e:/hello/StartOS/src/javascripts/dock.js#L1265-L1302) |
| WAPI-05 | 中 | 同应用按窗口 id 去重，无多窗口机制；与 office manifest 的用户承诺矛盾 | [plugin-manager.js:814-L821](file:///e:/hello/StartOS/src/javascripts/plugin-manager.js#L814-L821)；[office/manifest.json](file:///e:/hello/StartOS/mods/office/manifest.json) `store.usage` |
| WAPI-06 | 中 | `setGeometry` 的 `z` 参数写内联并推 `zCounter`，但不入焦点栈，下一次 `commitStack` 即被覆盖——旧签名 `setWindowPosition(..., order)` 的 `order` 语义虚假 | [window-manager.js:359-L375](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L359-L375) vs [L288-L303](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L288-L303) |
| WAPI-07 | 低 | `readDeclaration` 把 key 小写化后与 camelCase 白名单比对：`data-window="minWidth:600"` 落入「未识别字段」warn 被忽略；只有 `min:`/`max:`/`size:` 简写可用，与 `configure()` 接受的字段名不一致 | [window-manager.js:166-L186](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L166-L186) |
| WAPI-08 | 低 | `serializeDecl` 只有宽高**成对**才写 `size:`/`min:`/`max:`，单独 `configure({width})` 不落 `data-window`，重开即丢；白名单外的键静默丢弃，与注释承诺「声明仍在」不符 | [window-manager.js:258-L267](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L258-L267) |
| WAPI-09 | 低 | `setTrafficLightsEnabled` 只收紧不放宽（只 setAttribute 不 remove），而 `applyConfig` 每次都按最新配置重放——`minimizable` 从 false 改回 true 灯不会复亮，两处语义矛盾 | [trafficLights.js:204-L210](file:///e:/hello/StartOS/src/javascripts/ui/trafficLights.js#L204-L210)；[window-manager.js:219-L222](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L219-L222) |
| WAPI-10 | 低 | `Deskly.windows.state(target)` 无归属校验、无权限，任意插件可读他窗几何；与同对象 `configure` 的严格自窗校验不对称 | [os-api.js:300-L303](file:///e:/hello/StartOS/src/javascripts/os-api.js#L300-L303) vs [L275-L294](file:///e:/hello/StartOS/src/javascripts/os-api.js#L275-L294) |
| WAPI-11 | 低 | 死接口：`snapshotGeometry` 全仓零调用；`cancelOpenAnimation` 导出但无外部调用；`_toggleStretchWindow/_toggleFullscreenWindow/_tileWindow/_untileWindow/_showArrangeMenu` 五个旧钩子零调用 | Node 接线核对结果；[window-manager.js:382](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L382)、[L1542-L1548](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L1542-L1548) |
| WAPI-12 | 低 | [zindex.js:7](file:///e:/hello/StartOS/src/javascripts/zindex.js#L7) 注释「window.js 递增分配，到顶重排回收」已过时（栈序推导）；`zCounter` 实为「栈底+窗口数」，门面再导出名为 `zIndex` 更误导 | [window-manager.js:104](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L104)；[window.js:65](file:///e:/hello/StartOS/src/javascripts/window.js#L65) |
| WAPI-13 | 低 | 视口 resize 时普通窗一律 `clampDrag` 强制回拉（[window-manager.js:1589-L1593](file:///e:/hello/StartOS/src/javascripts/window-manager.js#L1589-L1593)），没有「固定定位窗」豁免声明；`draggable:false` 不挡这次重排 | 同上 |
| WAPI-14 | 信息 | 旧式 `create()` 模板路径事实死代码（`assets/apps/` 为空目录，只剩 404 分支与三次兜底绑定）；`window.specialCloses` 是插件可改写的普通全局 | [window.js:119-L226](file:///e:/hello/StartOS/src/javascripts/window.js#L119-L226)、[L80](file:///e:/hello/StartOS/src/javascripts/window.js#L80) |

---

## B. 新增窗口 API 设计

总约定（与现状一致，不重起炉灶）：

- 声明三通道优先级不变：`data-window` > `manifest.window` > 应用 CSS；新增字段三通道同名（camelCase），`data-window` 解析器先修 WAPI-07（同时接受 `minWidth`/`min-width`/小写）。
- 运行期 API 全部挂在 `Deskly.windows` 下，受管方法统一信封 `{ok, value?, reason?, denied?, permission?}`、永不抛错；`guard(permission, handler)` 复用 [os-api.js:59-L78](file:///e:/hello/StartOS/src/javascripts/os-api.js#L59-L78)。
- 默认目标即「调用者自己的窗口」（`data-plugin-id` 严格相等），动别人的窗一律要权限——沿用 `configure` 的归属判据。
- 新增权限名 4 个（须登记进 [api-grants.js](file:///e:/hello/StartOS/src/javascripts/api-grants.js#L31-L47) 的 `PERMISSION_NAMES`/`PERMISSION_LABELS`/`SENSITIVE`）：

| 权限名 | 敏感 | 用途 |
|---|---|---|
| `window:read-others` | 否 | 读/订阅其它应用窗口的状态与事件 |
| `window:manage-others` | **是** | 改/关/置顶其它应用的窗口、把别人的窗设为自己的母窗 |
| `window:chrome` | **是** | 隐藏整组红绿灯或关闭钮（有困住用户的风险） |
| `window:level` | 否 | 把自己的窗提到 floating/panel 层 |

### NW-1 窗口关系（母窗 / 子窗 / 模态）

- **声明**：`data-window="role:child parent:文稿 modal:true"`；`manifest.window: { role, parent, modal }`。
- **运行时**：
  - `Deskly.windows.attach(el, { parent?, modal? })` → 信封，`value` 为 `stateOf` 快照。`el` 必须是调用者自己的已托管窗口；`parent` 缺省 = 调用者的主窗（同插件第一个 `role:"normal"` 窗）。
  - `Deskly.windows.detach(el)` → 解除关系，退回普通窗。
  - `Deskly.windows.parent(target)` / `Deskly.windows.children(target)` → 免权限，仅自己插件的窗口树。
- **参数与默认值**：`role: "normal"|"child"|"sheet"`（默认 `"normal"`）；`modal: false`；`parent: null`。
- **行为语义**：
  - 子窗跟随母窗移动（保持相对偏移）、随母窗关闭/最小化/恢复；置前母窗时子窗紧随其后（子恒在母上一层，栈内相邻）。
  - `modal:true`：母窗 inert（`pointer-events:none` + `aria-hidden` 内容区），模态子窗恒置顶于母窗，母窗关闭/最小化被拦到模态关闭后；模态自动获得 modal 层级（见 NW-4），不可直接声明给普通窗。
  - `role:"sheet"`：模态子窗的几何变体——顶边贴母窗标题栏下缘、水平居中于母窗、宽不超过母窗宽。
  - 子窗/sheet **不进** Dock 运行区、「窗口」菜单与将来的任务切换（`syncRunningApps` 与 `getVisibleWindows` 的菜单消费侧按 `role !== "normal"` 过滤）。
  - 拒绝情形（信封 `ok:false`）：母窗不存在、母子成环、`el` 非己窗、跨插件且未授权 `window:manage-others`。
- **降级**：样式/动画不支持时退化为普通跟随子窗，不失效。
- **兼容**：默认 `role:"normal"`，存量窗口零变化；`manage()` 签名不动，关系落在 rec 新增字段。

### NW-2 拖动约束（不可拖动 / 单轴 / 限区 / 固定）

- **配置键**（`configure` 与声明通道共用）：
  - `draggable: true`（已有，保留；`false` = 完全不可拖）
  - `dragAxis: "both"|"x"|"y"`（默认 `"both"`；`"x"` = 只许水平移动）
  - `dragBounds: "visible" | {x, y, w, h}`（默认 `"visible"` = 现有 `clampDrag` 规则；对象 = 硬区域，拖不出该矩形）
  - `fixed: false`（`true` = `draggable:false` + 不参与边缘吸附平铺 + 视口 resize 不强制回拉 + `configure` 不触发居中——通知窗/固定面板用语义，一并解 WAPI-01/WAPI-13）
- **实现点**：`startDrag` 的 `move` 里 `clampDrag` 之后再按轴/区域夹；`relayoutOnResize` 跳过 `fixed` 窗；`snapZoneAt` 结果对 `fixed` 不预览。
- **权限**：自己的窗免权限。
- **降级**：`dragBounds` 越出视口时与视口求交并 `console.warn`。
- **兼容**：四键全部缺省即现状。

### NW-3 缩放约束（不可缩放 / 尺寸范围 / 固定宽高比 / 单轴）

- **配置键**：`resizable`（已有）、`minWidth/minHeight/maxWidth/maxHeight`（已有）、新增：
  - `resizeAxis: "both"|"x"|"y"|"none"`（默认 `"both"`；`"none"` ≡ `resizable:false`）
  - `aspectRatio: "16:9" | 1.777`（常驻锁比例；复用 `resizeFrame` 的 `keepAspect` 路径，不再依赖 ⌥）
- **行为**：`resizeAxis:"x"` 时 n/s/角边带隐藏（`ensureEdgeBands` 按轴过滤）；`aspectRatio` 与 min/max 冲突时 min/max 为硬边界并 warn。
- **权限**：免权限。**兼容**：缺省即现状；`resizeAxis` 与 `resizable:false` 同时给时取更严者。

### NW-4 窗口层级（normal / floating / panel / modal）

- **声明**：`data-window="level:floating"`；运行时 `Deskly.windows.setLevel(target, level)`（需 `window:level`）。
- **分带方案**（兼容 [zindex.js](file:///e:/hello/StartOS/src/javascripts/zindex.js) 现有区间，窗口总段 [2050, 9000] 不变）：

| level | 区间 | 语义 |
|---|---|---|
| normal | 2050–4499 | 默认，现状全部窗口 |
| floating | 4500–5999 | 浮动工具窗，恒在 normal 之上 |
| panel | 6000–7499 | 面板（如取色器、字符检视），恒在 floating 之上 |
| modal | 7500–9000 | 仅 NW-1 模态子窗自动获得，**不开放直接声明** |

- **行为**：`commitStack` 改为按带内栈序分配；同带内仍是焦点栈序；全部仍低于 `Z.GENIE`(9450) 与 Dock(9500)。子窗不占独立层级，恒为母窗 +1（同带内）。
- **查询**：`stateOf` 增加 `level` / `role` / `parent` 字段（向后兼容：纯新增键）。
- **降级**：带内溢出（>1500 窗）按现状整体回拉逻辑处理，相对序不变。
- **兼容**：缺省 `normal`；`WINDOW_Z_MIN/MAX` 常量不变。

### NW-5 标题栏与红绿灯形态

- **配置键**：
  - `titlebar: "default"|"hidden"|"custom"`（默认 `"default"`：有 `[data-titlebar]` 用之，否则顶部灯区带——即现状，名字显式化）。`"hidden"` = 不挂标题栏元素、红绿灯退 overlay 悬浮（`attachTrafficLights` 的 `placement:"overlay"` 已支持）、顶部带拖动保留；`"custom"` = 应用自绘 `[data-titlebar]`（现状）。
  - `trafficLights: "all"|"close-only"|"none"`（默认 `"all"`；`"none"` 需 `window:chrome`，且内核强制保留菜单栏 ⌘W 与 Dock 右键的关闭入口，防止窗口无法关闭）。
  - 单灯隐藏继续走 `no-close/no-minimize/no-zoom` 属性与 `variant="dialog"`，与新键求交（收紧优先）。
- **按钮自定义回调**：`Deskly.windows.onAction(el, { close?, minimize?, zoom? })` —— 回调返回 `false` 即拦截默认动作（`close` 拦截走 NW-9 同一取消通道）；缺省不拦。**权限**：免权限（自己的窗）。
- **兼容**：旧 `.red/.yellow/.green` 标记形态不动；`variant="dialog"` 语义不变。

### NW-6 吸附与跟随

- 现有边缘吸附平铺保留；新增 `snap: "tile"|"edges"|"none"`（默认 `"tile"`）：`"edges"` = 只在屏边停驻（钳到可视区边），不弹平铺预览；`"none"` = 拖动不触发任何吸附（`fixed` 窗隐含 `"none"`）。
- 窗间跟随 = NW-1 非模态子窗默认行为（`follow` 不单独设键）；sheet 几何见 NW-1。
- **权限**：免权限。**兼容**：缺省 `"tile"` 即现状。

### NW-7 同应用多窗口

- **打开**：`Deskly.apps.launch(appId, { newWindow: true, file? })`（复用 `apps:launch` 权限，无新增）；`newWindow` 缺省 `false` = 现状去重置顶。
- **内核改动点**：`doLoad`/`doLoadApp` 的去重判断加 `!opts.newWindow` 前置；多窗时窗口 id 加实例后缀（`文稿#2`），`data-app-id` 不变；`syncRunningApps` 运行区按键从窗口 id 改为 `data-app-id` 聚合（一应用一颗灯，现状即一窗时行为不变）；`releaseResources`/`unloadApp` 引用计数天然按 DOM 存活数，无需改。
- **菜单**：⌘N 现为「浏览器保留」（[keyboard.js:76](file:///e:/hello/StartOS/src/javascripts/keyboard.js#L76)），留在菜单命令层分发 `launch(activeApp, {newWindow:true})`，不与浏览器抢键。
- **降级**：插件未适配多窗（脚本顶层单例假设）时 `newWindow` 返回信封 `{ok:false, reason:"该应用未声明多窗口"}`——以 manifest 新字段 `multiWindow:true` 为准入，缺省 `false`，**这是不破旧插件的关键闸**。
- **兼容**：缺省行为与现状逐字节一致。

### NW-8 状态查询与事件

- **查询**：
  - `Deskly.windows.list({ scope })` → `[{id, appId, pluginId, frame, state...}]`；`scope:"self"`（默认，免权限）/ `"all"`（需 `window:read-others`）。
  - `Deskly.windows.state(target)` 保留；读自己的窗免权限不变，读别人的窗收紧为需 `window:read-others`（修 WAPI-10；过渡：未授权时返回 `null` 并一次性 `console.warn`，不弹窗）。
- **事件契约**（统一走 `Deskly.bus`，topic 前缀 `window:`，`document` 派发、`bubbles:true`，`detail` 形状固定）：
  - 主题：`window:open` / `window:close` / `window:focus` / `window:blur` / `window:resize` / `window:move` / `window:minimize` / `window:restore` / `window:fullscreen` / `window:zoom` / `window:tile` / `window:level-change`。
  - `detail = { id, appId, pluginId, frame: {x,y,w,h}, state: stateOf快照 }`；`window:fullscreen`/`zoom`/`tile` 的目标态读 `state` 字段区分进入/退出。
  - 频度约束：拖动/缩放**过程中不逐帧发**，`pointerup` 收尾发一次；交互期间如需流式，按 100ms 节流。派发钩子集中在 `close/finish/applyFrame 收尾点`，不侵入 move 热循环。
  - 订阅：`Deskly.windows.on(event, handler, { scope: "self" })` → 返回退订函数（`scope:"all"` 需 `window:read-others`）；`off` 同理。退订纪律与 `bus.on` 一致（`plugin-unload` 时必须退订）。
- **降级**：事件是附加通道，丢事件不影响窗口本体操作。
- **兼容**：纯新增，不改现有四个 `plugin-app-*` 广播。

### NW-9 关闭拦截（可取消的 close）

- `Deskly.windows.onClose(el, handler)`：`close()` 流程在 `rec.closing = true` 之前派发可取消事件，handler 返回 `false`（或 `event.preventDefault()`）即中止关闭；典型用法「未保存更改」确认框。
- 兼容：`window.specialCloses`（WAPI-14）保留为旧钩子，存在时先调它，再发新事件；两者都放行才真关。
- **权限**：免权限（自己的窗）。**降级**：handler 抛错视为放行并记 `__log.warn`，绝不让异常把窗口卡成关不掉。

---

## C. 实施拆分建议

### C.1 模块边界（window-manager.js 现 1628 行，按职责拆）

| 文件 | 职责 | 来源 |
|---|---|---|
| `src/javascripts/wm/frame.js` | 几何原语（保留）；新增 `dragBounds`/`aspectRatio`/`resizeAxis` 计算 | 现有，小幅扩 |
| `src/javascripts/wm/stack.js`（新） | 焦点栈、分带 `commitStack`、level 管理、`zCounter` | 从 window-manager 抽出（L99-L137、L281-L351） |
| `src/javascripts/wm/relations.js`（新） | 母子/sheet 关系图、跟随移动、级联关闭/最小化、模态 inert | 新写（NW-1） |
| `src/javascripts/wm/interactions.js`（新） | `bindInteractions`/`startDrag`/`startResize`/边带/遮罩/吸附预览 | 从 window-manager 抽出（L757-L1209） |
| `src/javascripts/wm/lifecycle.js`（新） | `manage`/`release`/`close`/`prepareOpen`/`revealOpen`/入场动画 | 从 window-manager 抽出（L1340-L1510、L692-L755） |
| `src/javascripts/wm/events.js`（新） | `window:*` 事件派发契约与节流 | 新写（NW-8） |
| `src/javascripts/window-manager.js` | 编排 + 对外导出聚合（保持现有导出名一个不少） | 瘦身 |
| `src/javascripts/window.js` | 兼容门面（旧名不动）；`create()` 旧式路径随 WAPI-14 评估删除 | 现状保留 |

### C.2 外围改动点

- `src/javascripts/os-api.js`：`windows` 段扩展 NW-1~NW-9；`Deskly.apps.launch` 透传 `newWindow`。
- `src/javascripts/api-grants.js`：`PERMISSION_NAMES` +4，`PERMISSION_LABELS` +4，`SENSITIVE` +2（`window:manage-others`、`window:chrome`）。
- `src/javascripts/plugin-manager.js`：去重判断加 `!opts.newWindow`；`multiWindow` 准入闸；窗口 id 实例后缀。
- `src/javascripts/dock.js`：`syncRunningApps` 按 `data-app-id` 聚合并过滤 `role !== "normal"`（**热路径**，每次开窗/关窗/入场都跑）。
- `src/javascripts/finderbar.js`：「窗口」菜单与 `updateActiveAppMenu` 过滤子窗（**热路径**，每次焦点切换都跑）。
- `src/javascripts/ui/trafficLights.js`：`setTrafficLightsEnabled` 改为可双向（修 WAPI-09）；`trafficLights` 可见性三态。
- `src/javascripts/zindex.js`：区间注释更新（WAPI-12），分带常量入表。
- 顺带修复：WAPI-01（`_wmPlaced` 统一落 el）、WAPI-06（`setGeometry` 删 z 参数或文档化无效）、WAPI-07、WAPI-08、WAPI-11（死接口随重写下线，删除前发一次 deprecate warn 观察一个版本）。

### C.3 触碰内核热路径的改动与回归验证

| 改动 | 热路径 | 回归验证 |
|---|---|---|
| 分带 `commitStack` | 每次置顶/焦点切换 | 连点开 20 窗轮转置顶，层级序与焦点栈一致；Dock/菜单/控制中心不被压 |
| `syncRunningApps` 聚合+过滤 | 开窗/关窗/入场显示 | 办公三件套+子窗同开，Dock 运行区数量与指示灯正确；最小化还原后灯不丢 |
| 子窗过滤进「窗口」菜单 | 焦点切换 | 子窗不出现在菜单与 `getTopWindow`；模态母窗不可被菜单置顶 |
| `startDrag` 轴/区域钳 | 拖动 move 每帧 | `dragAxis:"x"` 竖直位置不变；`fixed` 窗拖不动、视口缩放不回拉 |
| 边带按轴过滤 | 缩放 hover/按下 | `resizeAxis:"x"` 时 n/s 边带不存在，e/w 正常；Safari iframe 两边仍可缩（边带方案不回退） |
| WAPI-01 修复 | `configure()` 每次调用 | 计算器挪开后切模式不再回中；首开仍居中 |
| NW-9 可取消 close | 红灯/⌘W/强制退出 | handler 返回 false 时三类入口全被拦；handler 抛错窗口仍可关 |
| 事件派发收尾点 | close/drag/resize finish | 事件不重复、不遗漏；`plugin-unload` 后退订无残留监听 |

既有保真用例必须重跑：01 报告的红绿灯全矩阵、02 报告的全屏/平铺用例（FS-01 翻转与本报告 NW-5 同一改动窗口，建议同批落地）。

---

## 附：devdocs 增删清单（重写完成后由文档任务统一执行，本文不动 devdocs）

**新增/更新**：
- `devdocs/api/deskly.html`：`windows.*` 全部新方法、`window:*` 事件契约、4 个新权限名。
- `devdocs/api/events.html`：12 个 `window:*` 主题、detail 形状、频度与退订纪律。
- `devdocs/api/trafficlights.html`：`titlebar` 三态、`trafficLights` 可见性、`onAction` 回调。
- `devdocs/guides/plugin-format.html`：`manifest.window` / `data-window` 新字段全表（含 `role/parent/modal/level/fixed/multiWindow`）。
- `devdocs/reference/z-layers.html`：窗口区间分带表。
- `devdocs/guides/architecture.html`：窗口关系模型一节（母子/sheet/模态）。
- `devdocs/guides/cold-load.html`：`openApp` 的 `newWindow`/`multiWindow` 一节。
- `devdocs/reference/redlines.html`：新增红线「子窗不入 Dock/任务切换」「模态层级不越 Z.GENIE」「fixed 窗不参与视口重排」。

**删除/改写**：
- 各处「递增分配，到顶重排回收」式层级描述（z-layers.html 等）改为栈序+分带。
- `window.js` 门面条目中的 `snapshotGeometry`/`zIndex` 说明（若随 WAPI-11/WAPI-12 下线）。
- 无整页删除。
