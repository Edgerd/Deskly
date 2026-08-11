# StartOS 底层 API 改造 — 分段提示词

版本基线：0.2.43 ｜ 编制日期：2026-08-09
本文件是本次底层改造的唯一设计依据，所有决策均已逐条确认。按编号顺序逐段执行，每段完成后必须：升版本号（0.01 步长）→ 写产品更新信息.md → 跑通验收标准 → 再进入下一段。

---

## 一、设计决策（29 条，已确认）

1. API 暴露形式：全局命名空间 window.StartOS（"所有人去同一个前台自取"）。对象不可篡改（Object.defineProperty 锁定 + 内层 Proxy），每次调用时识别调用者身份并按权限放行。
2. 权限粒度：操作级（"按书名"）。敏感模块读写分离（files:read / files:write、window-style:self / window-style:others）；不敏感的打包（widgets、dynamic-icons）。
3. 权限确认机制：安装时一次性展示清单并授权（granted=true, activated=false）→ 运行时首次调用对应 API 时弹窗激活（拒绝 / 仅这次 / 始终允许）→ 激活后写入 IndexedDB 无感通行。内置插件与第三方 ZIP 插件完全同等流程。
4. 可修改面：finderbar / dock / desktop / wallpaper / 窗口 / 菜单全部可读写，但一律走权限激活（system-patch:* 系列）。
5. 默认应用绑定维度 = 文件扩展名（带点 .md）+ 协议（带冒号 http:）；需实现文件存取（files:read / files:write）与文件类型注册表。
6. 默认应用冲突裁决：系统设置 → 通用 → 默认应用页面由用户手动修改。
7. 协议 http: / https: 可被第三方插件覆盖（不作系统锁定）。
8. 桌面小组件渲染方式沿用 insertAdjacentHTML 注入式（与现有插件一致，不引入 iframe）。
9. 小组件摆放：桌面网格固定位，同时支持自由拖放（可设置）。
10. widget ↔ 宿主应用可通信（事件总线）。
11. manifest 引入 apps: [{id, name, icon, entry, window}] 数组；appId 命名 = 插件id.应用名（如 office.xls），防跨插件冲突。
12. 显示粒度：App Store 按插件粒度（Office 一个入口）；dock / 启动台按 app 粒度（三件套各显各名、各亮小圆点）。插件本身不在 dock/启动台显示。
13. 多应用生命周期：每 app 独立窗口实例（窗口 id = appId），共享插件级 style.css 与公共资源；引用计数卸载——所有 app 窗口关闭后才移除共享 CSS/脚本，单个 app 关闭只移除自己的 DOM 与事件。
14. entry 取值范围扩展为 "window" / "fullscreen" / "widget" 三种。
15. 动态图标推模式：插件自维护图标状态，需要时调 StartOS.icons.set(appId, dataURL)；内核持久化到 IndexedDB 并同步刷新 dock / 启动台 / 应用商店 / 访达四个入口。
16. 动态图标持久化，刷新/重启不丢；永远不出现消息角标（不做 badge 系统）。
17. "项目记忆"为 AI 侧概念，本次不实现。
18. 窗口样式声明式：manifest 根级 windowStyle + apps[].windowStyle 可选；可控制标题栏颜色、圆角、毛玻璃出现位置、浅/深色。
19. 样式可改自身（window-style:self）也可跨应用修改（window-style:others）；激活一次权限即可覆盖所有后续调用；支持"主题包"式全量统一样式。
20. 深色模式两套都支持：① manifest 声明 darkStyle: "dark.css"，系统切深色时自动换 link href；② 系统给应用窗口加 .dark 类，应用用 .dark 选择器自适配。
21. 系统统一控制浅/深切换；内核层写死兜底规则（深色下 .window 文字变浅、背景变暗，不依赖插件配合），并预留主题包接口。
22. 系统代码对插件只读：插件不能直接改内核 DOM/脚本；修改系统组件必须走命令式补丁 API StartOS.system.patch(target, patch)。
23. 补丁持久化（IndexedDB 独立补丁表），启动时按序重放；卸载插件时移除该插件全部补丁记录。
24. appId 命名用 office.xls 形式（带插件前缀，防两个插件都叫 editor 冲突）。
25. App Store 按插件粒度、dock/启动台按 app 粒度——此双粒度逻辑正确，照此实现。
26. 图标状态源放插件里：插件自己维护状态变量，变化时主动调 icons.set 推送。
27. 窗口样式字段名自行决定：manifest 根级 windowStyle + apps[].windowStyle，字段为 titlebarColor / borderRadius / glass（titlebar|sidebar|both|none）/ theme（auto|light|dark）。
28. 系统补丁可修改单一程序，也可像主题包一样修改所有软件的样式；window-style:others 激活一次权限即可。
29. 补丁 API 自行决定形态：命令式 system.patch(target, {action, selector, html, patchId})，target 白名单 dock/finderbar/desktop/wallpaper/menu；插入内容仅接受 HTML 字符串 + 相对资源路径，不接受 script（防注入）。

---

## 二、权限清单（全量枚举）

1. apps:launch —— 启动其他应用
2. default-apps:read —— 读默认应用设置
3. default-apps:write —— 写默认应用设置（含协议覆盖）
4. widgets —— 使用桌面小组件（创建/渲染/通信）
5. dynamic-icons —— 推送动态图标
6. window-style:self —— 修改自身窗口样式
7. window-style:others —— 修改其他应用窗口样式（激活一次即可）
8. theme:apply —— 应用主题包
9. files:read —— 读文件
10. files:write —— 写文件
11. system-patch:dock —— 给 Dock 打补丁
12. system-patch:finderbar —— 给顶栏打补丁
13. system-patch:desktop —— 给桌面打补丁
14. system-patch:wallpaper —— 给壁纸打补丁
15. system-patch:menu —— 给菜单打补丁

---

## 三、StartOS API 速查表（帮助文档同源）

1. StartOS.apps.launch("office.xls") —— 启动应用（可跨插件，需 apps:launch）
2. StartOS.apps.list() —— 全部可启动应用
3. StartOS.apps.default.set(".md", "notepad") —— 绑定扩展名（需 default-apps:write）
4. StartOS.apps.default.set("http:", "browser-app") —— 绑定协议
5. StartOS.apps.default.get(".md") —— 查询默认应用（需 default-apps:read）
6. StartOS.apps.default.getAll() —— 全部映射
7. StartOS.apps.default.reset(extOrProto) —— 重置为系统默认
8. StartOS.widgets.create({ title, html, grid: [x, y], draggable: true }) —— 创建小组件（需 widgets）
9. StartOS.widgets.update(widgetId, { html }) —— 更新小组件
10. StartOS.widgets.remove(widgetId) —— 移除小组件
11. StartOS.widgets.on(topic, fn) —— 监听宿主事件
12. StartOS.widgets.emit(topic, data) —— 向宿主发事件
13. StartOS.windows.style.set(appId, { titlebarColor, borderRadius, glass, theme }) —— 设窗口样式（appId 省略=自身；跨应用需 window-style:others）
14. StartOS.windows.style.applyTheme(packId) —— 应用主题包（需 theme:apply）
15. StartOS.icons.set(appId, dataURL) —— 推送图标，四入口同步刷新（需 dynamic-icons）
16. StartOS.system.patch("dock", { action: "insertAfter", target: "#finder-icon", html: "..." }) —— 打系统补丁（需对应 system-patch:*）
17. StartOS.system.patch.remove(patchId) —— 移除补丁
18. StartOS.fs.read(path) —— 读文件（需 files:read）
19. StartOS.fs.write(path, content) —— 写文件（需 files:write）
20. StartOS.fs.list(dir) —— 列目录
21. StartOS.fs.type.get(ext) —— 该扩展名绑定的应用
22. StartOS.bus.on("theme-change", fn) —— 系统事件订阅
23. StartOS.bus.emit("my-topic", data) —— 自定义事件

---

## 四、分段提示词（按顺序执行，段间不可跳）

### 提示词 1：权限系统与 API 命名空间基座

1. 目标：建立 window.StartOS 全局 API 骨架 + 完整权限模型（安装声明 → 运行激活 → 校验放行）。所有后续模块都挂在这个骨架上。
2. 涉及文件：新增 src/javascripts/os-api.js；新增 src/javascripts/permissions.js；修改 src/javascripts/plugin-manager.js；修改 src/javascripts/bootstrap.js；修改 src/javascripts/app-store.js；修改全部内置插件 manifest.json（补 permissions 字段，按第二部分清单声明）。
3. 实施要求：
   1. permissions.js 新增 IndexedDB 库 webstartos-permissions，表 grants（keyPath pluginId），记录 { pluginId, grants: [{ permission, granted, activated }] }。
   2. permissions.js 导出 grantAll(pluginId, permissions)（安装时全量授权）、isActivated(pluginId, permission)、activate(pluginId, permission, mode)（mode: once/always）。
   3. permissions.js 导出 ensurePermission(pluginId, permission)：返回 Promise<boolean>——已激活直接 true；未激活弹确认框（「插件名 想要使用「权限名」，是否允许？」三按钮：拒绝 / 仅这次 / 始终允许），按选择写库并返回结果，拒绝返回 false。
   4. permissions.js 提供权限中文名映射表（permission → 人类可读描述，帮助文档与弹窗共用）。
   5. os-api.js 用 Object.defineProperty(window, "StartOS", { value: apiRoot, writable: false, configurable: false }) 锁定命名空间，防止插件覆盖。
   6. apiRoot 用 Proxy 包裹：每个 API 方法调用前通过 _getCallerId() 识别调用者（取 document.currentScript?.getAttribute("plugin")，兜底查最近注入的 script[plugin]），再调 ensurePermission。
   7. 本段先挂 4 个基础分组（其余后续段补充）：apps.launch/list（需 apps:launch）、bus（无需权限）、fs 骨架（files:read/write）、占位 apps.default / widgets / windows.style / icons / system.patch。
   8. _getCallerId() 识别不到调用者时按"内核自身调用"放行，不弹窗。
   9. plugin-manager.js 的 registerPlugin 同步 permissions.grantAll（内置插件安装即授权 = 与 ZIP 插件走同一 grantAll 入口）。
   10. plugin-manager.js 的 load() 注入脚本前记录 window.__currentPluginId = id 供调用者识别，脚本执行后清空。
   11. bootstrap.js 初始化顺序：permissions.init() → 再 initPlugins()。
   12. app-store.js 安装流程插入权限清单展示面板（列出 permissions 人类可读描述，底部「安装并授权」按钮），确认后 grantAll 并继续安装，取消则终止。
4. 验收标准：
   1. 打开任意插件，调用带权限的 API 首次弹窗、选「始终允许」后二次无感。
   2. 选「拒绝」后 API 返回 false 且插件不崩溃。
   3. window.StartOS 不可被插件重新赋值/删除。
   4. 内置插件与 ZIP 插件安装时都走权限清单面板。

### 提示词 2：appId 解耦与一插件多应用

1. 目标：引入独立 appId（插件id.应用名），窗口 id、dock 状态、菜单全部从中文显示名迁移到 appId；支持 apps[] 数组；引用计数卸载。
2. 涉及文件：修改 src/javascripts/plugin-manager.js；修改 src/javascripts/window.js；修改 src/javascripts/dock.js；修改 src/javascripts/finderbar.js（菜单匹配逻辑如涉及）；修改 mods/launchpad/（按 app 粒度显示）。
3. 实施要求：
   1. manifest 解析：无 apps 字段 → 单应用插件，appId = 插件id，兼容现有全部内置插件（不加 apps 不改行为）。
   2. 有 apps 数组 → 每个 app：{ id, name, icon, entry, window, main?, script?, style? }；appId = 插件id.app.id；app 未声明 main/script/style 时继承插件根级声明。
   3. apps[].entry 支持 "window" / "fullscreen" / "widget" 三种。
   4. plugin-manager.js 新增 appRegistry: Map<appId, { app, plugin }>；registerPlugin 时展开 apps[] 逐条注册。
   5. resolveName / getIcon 兼容 appId 与显示名双向解析；getPlugin(appId) 返回 { plugin, app }。
   6. 窗口 id = appId（不再用 manifest.name）；newWin.dataset.pluginId = pluginId（插件级）+ dataset.appId = appId（应用级）。
   7. window.js 的 updateActiveAppMenu / bringToFront / resetWindowListeners 使用 appId。
   8. plugin-manager.js 维护 pluginRefCount: Map<pluginId, number>；load() 打开 app 时 +1，窗口关闭时 -1。
   9. 某 app 窗口关闭：移除该 app 自己的 DOM（按 appId 定位），计数 -1；计数归 0 才执行 unload（移除共享 plugin-style-<id> 与 script[plugin]）。
   10. 单应用插件保持现状行为（计满即卸载）。
   11. dock.js 的 appStatus 键全部改为 appId；运行区、小圆点按 appId 对账。
   12. 插件级（manifest 根级）不产生 dock 项；apps[] 的每个 app 独立生成 dock 图标与小圆点。
   13. 启动台按 app 粒度渲染网格项（图标/名称来自 app 级配置）。
   14. App Store 多应用插件只显示一个卡片（插件名 + 插件图标），展开显示 app 列表，点击打开具体 app。
4. 验收标准：
   1. 现有 11 个内置插件（无 apps）行为完全不变。
   2. 构造含 apps:[{id:"xls",...},{id:"ppt",...},{id:"word",...}] 的测试插件：dock 显示三个图标、分别亮小圆点、窗口 id 为 office.xls 等；关闭两个窗口后共享 CSS 仍在，关闭第三个才卸载。
   3. window.StartOS.apps.list() 返回全部 appId。

### 提示词 3：默认应用设置 API

1. 目标：文件类型/协议注册表 + 默认应用读写；系统设置新增「通用 → 默认应用」管理页。
2. 涉及文件：新增 src/javascripts/default-apps.js；修改 src/javascripts/os-api.js（挂 apps.default 完整实现）；修改 mods/system-settings/（新增「通用 → 默认应用」页）；修改 mods/finder/（可选：打开未知类型文件时用注册表解析应用）。
3. 实施要求：
   1. 数据模型：IndexedDB 库 webstartos-settings，表 default-apps（keyPath key），记录 { key: ".md" | "http:", appId }。
   2. key 规则：扩展名带点（.md）、协议带冒号（http:）。
   3. os-api.js 挂载 set(key, appId)：校验 default-apps:write → 写库 → 派发 default-apps-changed 事件。
   4. 挂载 get(key)：default-apps:read → 查库，无记录返回系统内置默认（.md→记事本等）。
   5. 挂载 getAll() / reset(key)：reset 删除记录恢复系统默认。
   6. 协议可被第三方覆盖：set("http:", appId) 不做系统锁定。
   7. 系统设置页「通用 → 默认应用」：列出全部已注册文件类型 + 协议，每行显示当前绑定应用，下拉/列表选择可改，提供「重置」。
   8. 系统设置修改时调 apps.default.set（走同一权限，system-settings 需声明 default-apps:write）。
   9. 文件类型注册表：fs.type.get(ext) 返回绑定应用；未知扩展名返回 undefined，由调用方走系统默认逻辑。
4. 验收标准：
   1. 在系统设置把 .md 绑定到 A 应用，访达打开 .md 文件解析到 A 应用。
   2. set("http:", "appId") 成功（协议可覆盖）。
   3. 重置后恢复系统内置默认。

### 提示词 4：桌面小组件 API

1. 目标：桌面网格小组件（注入式渲染 + 网格/自由拖放 + widget↔宿主通信）。
2. 涉及文件：新增 src/javascripts/widgets.js；修改 src/javascripts/os-api.js（挂 widgets）；修改 src/javascripts/desktop.js（桌面层容纳组件容器）；修改 src/javascripts/sortable.js 或新增拖放逻辑（网格吸附 + 自由模式）。
3. 实施要求：
   1. 渲染沿用 insertAdjacentHTML 注入；widget 根元素带 data-widget-id、data-plugin-id。
   2. 默认网格固定位：{ grid: [col, row] } 定位，参考桌面图标网格实现。
   3. 可选 draggable: true 启用自由拖放：拖动后落点吸附最近网格位；配置 { free: true } 可完全自由定位。
   4. 生命周期：create → 渲染 + 入库（webstartos-settings 表 widgets，持久化位置/大小）；update 改 html/位置；remove 删 DOM + 记录；插件卸载时删除该插件全部 widget。
   5. 通信：widgets.on(topic, fn) / widgets.emit(topic, data) 走统一事件总线（os-api.js 的 bus）。
   6. 约定宿主事件：widget-open（点击 widget 唤起指定应用）、widget-close。
   7. 权限：创建/更新/移除需 widgets 权限（激活一次）。
4. 验收标准：
   1. 测试插件创建一个 grid 定位 widget，刷新后位置保留。
   2. 拖拽 widget 到新位置，松手吸附网格。
   3. widget 调 emit("widget-open", { appId: "notepad" })，宿主收到后 apps.launch。

### 提示词 5：窗口样式 API 与主题系统

1. 目标：声明式窗口样式（标题栏/圆角/毛玻璃/深浅色）+ 深色模式双通道 + 内核兜底 + 主题包接口预留。
2. 涉及文件：新增 src/javascripts/window-style.js；修改 src/javascripts/os-api.js（挂 windows.style）；修改 src/javascripts/plugin-manager.js（注入时应用 manifest windowStyle）；修改 src/javascripts/window.js（样式应用点：标题栏/圆角/毛玻璃）；修改 src/javascripts/appearance.js（主题切换统一下发 theme-change 事件）；修改 assets/stylesheets/ui/window.css（样式变量化，供声明式覆盖）。
3. 实施要求：
   1. 声明式字段：manifest 根级 windowStyle / apps[].windowStyle：{ titlebarColor, borderRadius, glass: "titlebar"|"sidebar"|"both"|"none", theme: "auto"|"light"|"dark" }。
   2. 加载时经权限校验后应用；CSS 变量化实现（如 --win-titlebar-color、--win-radius、--win-glass）。
   3. 运行时 API：windows.style.set(appId, style)：appId 省略=自身窗口；指定其他 appId 需 window-style:others（激活一次权限后所有后续调用放行）。
   4. windows.style.applyTheme(packId)：主题包接口（theme:apply）；本段先实现接口骨架 + 内置 2 个主题包（浅色/深色），外部主题包注册表留待后续（预留）。
   5. 深色模式通道①：manifest 声明 darkStyle: "dark.css" → 系统切深色时 plugin-manager 把该插件 link href 换成 dark.css，切浅色换回。
   6. 深色模式通道②：系统给所有应用窗口加 .dark 类 → 插件 CSS 用 .dark 选择器自适配；两套并存（优先①存在则换文件，否则②加类）。
   7. 内核兜底：appearance.js 切主题时，对未实现任何适配的窗口强制兜底（深色下 .window 文字变浅、背景变暗），并派发 theme-change 事件供 StartOS.bus 订阅。
   8. 系统统一控制：主题切换入口保持系统级（finderbar 控制中心），不提供应用级独立切换按钮（应用只能声明/适配，不能抢系统开关）。
4. 验收标准：
   1. 插件声明 windowStyle.titlebarColor 后标题栏颜色生效。
   2. 切深色：有 darkStyle 的插件换 CSS 文件；无则靠 .dark 类；两者皆无走内核兜底变暗。
   3. 主题包 applyTheme 切换后全部窗口样式统一变化，且可恢复默认。

### 提示词 6：动态图标 API

1. 目标：推模式动态图标——icons.set(appId, dataURL) 持久化 + 四入口同步刷新。
2. 涉及文件：新增 src/javascripts/icons.js；修改 src/javascripts/os-api.js（挂 icons）；修改 src/javascripts/dock.js（刷新点）；修改 mods/launchpad/（刷新点）；修改 src/javascripts/app-store.js（刷新点）；修改 mods/finder/（侧边栏/图标刷新点）。
3. 实施要求：
   1. 数据：IndexedDB webstartos-settings 表 icons，记录 { appId, dataURL, updatedAt }；启动时 bootstrap 读取并应用。
   2. API：icons.set(appId, dataURL) 需 dynamic-icons 权限 → 写库 → 派发 icon-changed 事件。
   3. dock：getIcon 改为先查动态图标覆盖（有则用之，无则回退静态路径）。
   4. 启动台网格项、应用商店卡片/列表、访达侧边栏与图标视图：监听 icon-changed 或提供统一 refreshIcon(appId) 入口，命中即更新 img.src。
   5. 插件侧约定：插件自行维护图标状态（如运行中/忙碌），状态变化时主动调 icons.set 推送；不提供角标/badge 通道。
   6. 卸载清理：插件卸载时删除该插件全部图标记录。
4. 验收标准：
   1. 插件调 icons.set("office.xls", dataURL) 后，dock/启动台/App Store/访达四处图标立即同步更换。
   2. 刷新页面后图标仍是动态值（持久化生效）。
   3. 卸载插件后动态图标清除，回退静态图标。

### 提示词 7：系统补丁 API

1. 目标：系统代码对插件只读；修改系统组件一律走命令式补丁；持久化 + 启动重放 + 卸载还原。
2. 涉及文件：新增 src/javascripts/system-patch.js；修改 src/javascripts/os-api.js（挂 system.patch）；修改 src/javascripts/bootstrap.js（启动重放补丁）；修改 src/javascripts/plugin-manager.js（卸载时清补丁）。
3. 实施要求：
   1. 只读保护：插件不得直接操作 finderbar/dock/desktop/wallpaper 的内核 DOM（文档写明，权限模型上不提供这类直通能力）。
   2. 系统组件修改唯一入口 = system.patch。
   3. system.patch(target, patch)：target 白名单 ["dock", "finderbar", "desktop", "wallpaper", "menu"]，分别对应 system-patch:dock 等权限。
   4. patch 结构：{ action: "insertAfter"|"insertBefore"|"append"|"prepend"|"replace"|"remove", selector, html?, patchId? }；返回 patchId（不传则自动生成）。
   5. 插入内容仅接受 HTML 字符串 + 相对资源路径，不接受 script（防注入）。
   6. 持久化：IndexedDB webstartos-settings 表 patches：{ patchId, pluginId, target, patch, applied: false }。
   7. 重放：bootstrap 启动时按 target 分组、组内按时间顺序重放；重放失败标记 applied:false 并告警，不阻塞系统启动。
   8. 卸载还原：unload(pluginId) 时删除该插件全部补丁记录并逆向还原（insertAfter 撤销=remove 该节点等），还原失败告警。
   9. system.patch.remove(patchId)：单条移除 + 还原。
4. 验收标准：
   1. 插件给 dock 插入一个自定义图标（补丁），刷新后仍在（持久化重放）。
   2. 卸载该插件后 dock 恢复原状。
   3. 补丁 html 带 script 时被拒绝。
   4. 直接操作内核 DOM 的尝试不影响系统（只读隔离生效，或文档明确禁止 + 代码不提供路径）。

### 提示词 8：插件开发帮助文档

1. 目标：更新 dev/devdoc/ 帮助文档，API 简单易懂、利于开发。
2. 涉及文件：dev/devdoc/plugin-format.md（manifest 新字段：permissions、apps[]、windowStyle、darkStyle）；dev/devdoc/plugin-development.md（开发流程：安装授权 → 运行时权限激活 → API 调用示例）；新增 dev/devdoc/os-api.md（StartOS API 全量参考，含权限对应表、每 API 最小可运行示例）；新增 dev/devdoc/permissions.md（权限清单 + 中文描述 + 激活交互说明）。
3. 实施要求：
   1. 每个 API 配「1 行说明 + 3 行以内示例 + 所需权限」三段式，禁止堆术语。
   2. 示例统一使用 office.xls / 记事本等真实存在的 appId，保证开发者复制即可跑。
   3. 文档与 os-api.js 导出结构一一对应（导出前自动核对一遍，避免文档与实现脱节）。
   4. 权限中文名映射表（permissions.js 内）与文档同源。
4. 验收标准：
   1. 新开发者只读 os-api.md + plugin-format.md 即可在 10 分钟内写出一个能跑的通插件。
   2. 文档中的每个 API 签名与 window.StartOS 实际结构一致。

---

## 五、段间依赖与顺序说明

1. 提示词 1（权限+命名空间基座）是提示词 3/4/5/6/7 的共同前置，必须最先完成。
2. 提示词 2（appId 解耦）建议在提示词 3 之前完成，因为默认应用 API 的 appId 参数依赖 appId 体系。
3. 提示词 8（文档）最后做，且须与实现核对一致。

## 六、每段收尾必做（项目规范）

1. 按 0.01 步长升版本号：manifest.json + version.js + version.py + index.html 的 ?v= 缓存参数。
2. 产品更新信息.md 顶部新增条目：日期、版本号、更新类型（新增功能/优化改进/问题修复）、变更描述、影响范围。
3. 只允许用 Edit/Write 工具改文件，禁止任何脚本改文件。
