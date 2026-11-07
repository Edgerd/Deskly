# 03 · 插件 API 可优化性审查报告

> 审查时点：2026-11-04 · 版本 0.3.6 · 只读审查，未修改任何项目文件。
> 并发声明：`mods/office/`（view-word.js mtime 2026-11-03 22:02、view-excel.js 22:05）与 `devdocs/`（多数 2026-11-03 22:1x，reference/redlines.html 与 z-layers.html 为 2026-11-04 21:18）在审查时点可能正被其他任务改写，涉及这些文件的结论以当时磁盘内容为准。

---

## 1. 审查范围与覆盖文件清单

审查对象是「宿主暴露给插件的能力面」全链路，逐文件覆盖如下：

| 层 | 文件 | 角色 |
|----|------|------|
| 能力门面 | `src/javascripts/os-api.js` | `window.Deskly` 统一定义（apps/fs/bus/widgets/windows/icons/system/meta 八组） |
| 权限 | `src/javascripts/api-grants.js` | 15 条权限名、授权账本（IndexedDB `webstartos-grants`）、运行时激活弹窗 |
| 调用者识别 | `src/javascripts/caller-context.js` | 调用栈解析 + `withCaller` 归属传递 |
| 加载/注册 | `src/javascripts/plugin-manager.js`、`app-registry.js` | 冷加载、多应用外壳、生命周期广播、注册表索引 |
| 商店/安装 | `src/javascripts/store-api.js`、`sw.js` | ZIP 安装/校验/回滚、插件资源 SW 回源 |
| 文件 | `src/javascripts/osfs.js`、`vfs.js` | 单一根目录存储内核 + 界面门面 |
| 默认应用 | `src/javascripts/default-apps.js` | 三级回退绑定表 |
| i18n/设置 | `src/javascripts/i18n.js`、`settings.js`、`settings-definitions.js` | 插件文案注册、设置中枢 |
| 窗口 | `src/javascripts/window-manager.js`、`window.js` | `Deskly.windows.*` 的落地端 |
| 浏览器权限 | `src/javascripts/permissions.js` | 隐私面板真权限（与 api-grants 无关，仅核边界） |
| 13 个内置 mod | `mods/{about,app-store,calculator,finder,launchpad,manual,notepad,office,photos,safari,siri,system-settings,vs_code}/**` | API 的真实使用方 |
| 文档 | `devdocs/api/deskly.html`、`devdocs/api/events.html`、`devdocs/guides/*.html`、`devdocs/skill/plugin-dev/*` | 开发者文档对齐度 |

**运行模型确认（审查前提）**：插件并非跑在沙箱 iframe —— plugin-manager 把插件 HTML/CSS/JS **注入主文档同一 DOM 与同一 JS realm**（`plugin-manager.js:697,847,899`）。全仓 `postMessage` 仅用于页面↔SW 握手（`plugin-manager.js:997`、`osfs.js:933`），不存在「宿主↔插件 postMessage 协议」。因此本报告的"消息校验"落点是 **DOM CustomEvent 总线 + 模块直接 import** 这一对真实通道；os-api.js 头注与 devdocs/architecture 也明示「这是同意与记账机制，不是安全沙箱」。

## 2. 审查方法与判断依据

1. 通读 API 面八个模块全文；对 13 个 mod 逐一核对 manifest.permissions 声明与实际能力调用（全仓 grep `Deskly\.` 与 `from '../../src/javascripts/`）。
2. 机械扫描：导出-引用对照（291 个导出逐一数引用点）、事件 emit/listen 对照、settings define/get 对照。
3. 与 devdocs/api/deskly.html（刚对齐 0.3.6 的重写版）交叉验证 API 名称与语义一致性。
4. 判断依据：同 document 模型下，「权限弹窗是否挡得住真实能力」是唯一硬标准；命名/返回形态以 `devdocs/api/deskly.html` 已公示的约定为基线。

## 3. 总体结论

Deskly 门面本身设计干净（信封约定、守卫包装、沙箱边界 assertNotOtherScope 都立得住），但存在一条贯穿性裂缝：**全部 13 个内置 mod 都绕过 Deskly 直接 import 内核模块**，权限账本对真实能力几乎没有约束力（API-01）；同时内核在 document 上监听生命周期事件做授权记账，而**任何插件都能伪造这些事件**（API-02）。这两个问题不修，ZIP 第三方插件开放之日就是账本失效之时。其余为一致性与开发者体验问题。

## 4. 问题清单

### API-01 · 权限账本空转：全部内置 mod 绕过 Deskly 直连内核模块
- **级别**：高
- **证据**：
  - 全仓 `Deskly.` 真实调用仅 1 处：`mods/calculator/script.js:952`（`window.Deskly.windows`）；`mods/system-settings/panes/default-apps.js:5,225` 两处只是注释提及。
  - 直接 import 内核的 mod（节选）：
    - `mods/notepad/core/storage.js:13` — `import { OSFS } from '../../../src/javascripts/osfs.js'`（声明了 files:read/files:write，但写文件不过 `guard("files:write")`）
    - `mods/office/office-io.js:11` — `import { OSFS } ...`，`saveToDocuments()` 直接 `OSFS.write("/文档/...")`（office manifest.json:8 声明 files:write）
    - `mods/photos/script.js:16`、`mods/finder/script.js:10-15`、`mods/finder/finder-contextmenu.js:10`、`mods/app-store/script.js:14,28`（openApp/store-api 直连，不经 `apps:launch` 守卫）
  - 各 mod manifest 权限声明（PowerShell 批量读取）：finder `[files:read,files:write,default-apps:read,apps:launch]`、office `[files:read,files:write,apps:launch,default-apps:read]`、photos `[files:read,files:write]`、notepad `[files:read,files:write,default-apps:read]` —— 这些声明从未触发过一次 `guard()`。
- **影响分析**：`api-grants.js` 精心实现的「安装时确认 + 敏感权限运行时弹窗」对系统里真实发生的文件读写/应用启动**零约束**；账本里记录的是「名义授权」，实际能力走的是 import 直通。system-settings 详情页的「权限」一栏（store-api.js:151 permissionsOf）展示的是从未被强制执行的声明。对内置插件这只是语义混乱；一旦第三方 ZIP 插件照猫画虎（文档也没拦着），账本形同虚设。
- **修复建议**（二选一，建议 A 先行）：
  - **A. 承认双层模型（低风险，可先落）**：文档与商店详情明确「内置插件 = 受信内核组件，permissions 字段仅作展示；账本只对未来受限运行时的插件生效」。同时把内置 mod 的 manifest.permissions 裁剪到真实 Deskly 用量（当前多数可删空），消除「声明了却不走」的假信号。
  - **B. 收敛到门面（高价值，工程量大）**：notepad/office/photos/finder 的文件操作改走 `Deskly.fs.*`；需要先在 Deskly.fs 补 rename/stat/公开树读写等缺口（见 API-09），否则 finder 这类必须管整棵树的应用迁不动。
  - 兼容策略：A 是纯文档+清单裁剪，无代码行为变化；B 建议按 mod 逐个迁移，guard 失败信封已不抛错，迁移期不会崩。
- **验证方式**：迁移/裁剪后，在 `dev/static-check.mjs` 增加一条断言——「manifest.permissions 非空的 mod，其代码必须出现 `Deskly.` 调用」，CI 直接卡住回归。
- **修复状态**：待协调

### API-02 · 授权记账挂在可伪造的 DOM 事件上
- **级别**：高
- **证据**：
  - `api-grants.js:496-500` — `document.addEventListener("plugin-registered", e => grantAll(manifest.id, manifest.permissions))`
  - `api-grants.js:501-504` — `plugin-unregistered` → `clearGrants(id)`
  - `default-apps.js:304-307` — `plugin-unregistered` → `removeApp(id)`（清掉该插件全部默认应用绑定）
  - 事件由 `app-registry.js:102 broadcast()` 在 document 上派发且 `bubbles:true` —— 与任何插件都能 `document.dispatchEvent(new CustomEvent("plugin-registered", {detail:{id:"自己", permissions:["files:read",...]}}))` 同通道。
- **影响分析**：插件可 (1) 给自己伪造 `plugin-registered` 自我授予**未声明的非敏感权限**（非敏感权限 grantAll 时直接 `activated=true`，连弹窗都没有，api-grants.js:269,274）；(2) 伪造 `plugin-unregistered` 清掉**别的插件**的授权账本与默认应用绑定，造成拒绝服务式干扰。敏感权限（files:write 等）仍有运行时弹窗兜底，所以危害上限是「非敏感能力偷渡 + 账本破坏」，但这与账本「同意机制」的自我定位直接冲突。
- **修复建议**：把记账从事件监听改为**直接函数调用**——`registerPlugin()`（app-registry.js:114）内部 `await grantAll(...)`、`unregisterPlugin()` 内调 `clearGrants/removeApp`；广播事件保留给纯 UI 刷新方。改法是 app-registry 动态 import api-grants（或 api-grants 导出的注册钩子注入 app-registry，同 `setExtensionResolver` 的赋值式防环手法，default-apps.js:301 已有先例）。
- **验证方式**：Node 侧 deep-check 已有模块表；新增断言「api-grants.js 源码不含 `addEventListener(\"plugin-`」，并手工在控制台伪造事件验证账本不再变化。
- **修复状态**：已修复（其他会话）

### API-03 · 9/15 条权限名没有任何实现，授权即空头支票
- **级别**：高（对插件开发者体验）
- **证据**：
  - 权限全表 `api-grants.js:31-47` 共 15 条；其中 `widgets`、`dynamic-icons`、`window-style:self`、`window-style:others`、`theme:apply`、`system-patch:dock/finderbar/desktop/wallpaper/menu` 共 9 条对应的能力全部是 `os-api.js:81-83 pending()` 占位：
    - `os-api.js:240-246` widgets.\*、`os-api.js:304-307` windows.style.\*、`os-api.js:310` icons.set、`os-api.js:313-318` system.patch.\*
  - devdocs/api/deskly.html:94-101 已诚实标注「未实现占位（别照着写）」。
- **影响分析**：ZIP 插件声明这些权限会走完安装确认、落账、甚至敏感权限运行时弹窗（theme:apply、window-style:others、system-patch:\* 都在 SENSITIVE 里，api-grants.js:75-83），然后调用永远拿到 `{ok:false, reason:"未实现（改造提示词 N）"}`。用户被弹窗问了一次又一次「是否允许」，换来的能力不存在——弹窗信用被透支。
- **修复建议**：短期：`meta.permissions()` 与安装清单面板（api-grants.js:409 showPermissionChecklist）给未落地权限打 `implemented:false` 标记并显示「能力尚未开放」；`pending()` 信封增加机器可读 `code:"UNIMPLEMENTED"`（见 API-08）。中期：按提示词 4/5/6/7 分段落地时同步启用权限检查。
- **验证方式**：`Deskly.meta.permissions()` 输出含 implemented 字段；写一个声明 `widgets` 的测试 ZIP 走完安装流程，界面明示「该能力未开放」。
- **修复状态**：已修复

### API-04 · `windows.configure` 不经权限守卫，`window-style:self` 形同虚设
- **级别**：中
- **证据**：`os-api.js:275-294` —— `configure` 是裸 async 方法，只做调用者识别与 `data-plugin-id` 归属校验，没有 `guard("window-style:self", ...)` 包装；而 `window-style:self` 却占着权限表一席（api-grants.js:37）。
- **影响分析**：权限语义自相矛盾——声明了某个权限，对应能力却免费；未来若给 configure 补守卫会变成「行为变更」，早补比晚补便宜。
- **修复建议**：给 `configure` 包 `guard("window-style:self", ...)`（非敏感，安装时即激活，内置插件无感）。`windows.state` 保持免权限。
- **验证方式**：无该权限的测试插件调 configure 收到 `ok:false, denied:true`。
- **修复状态**：已修复

### API-05 · `bus.emit` 无主题保留字，插件可冒充内核广播
- **级别**：中
- **证据**：`os-api.js:231-235` — `emit(topic, data)` 免权限、无校验，可 emit `settings-changed`、`plugin-unload`、`controlcenter:change` 等内核主题。内核监听方（如 settings 订阅者、各 UI 刷新）不验证来源。
- **影响分析**：伪造 `plugin-unload` 会触发 office（`mods/office/script.js:700`）、photos（`mods/photos/script.js:3185`）等插件的自清理逻辑——窗口还在、资源先被拆，表现为莫名状态错乱。伪造 `settings-changed` 可让界面显示与存储漂移。
- **修复建议**：emit 设保留清单（`plugin-*`、`settings-changed`、`controlcenter:*`、`default-apps-changed` 等内核主题拒发，或强制插件主题加前缀 `plugin:`）；`system:` 前缀逻辑（os-api.js:208-211）同理收紧。配套文档写清保留字。
- **验证方式**：插件 emit "plugin-unload" 返回 false/信封拒绝；自有主题不受影响。
- **修复状态**：待协调

### API-06 · `i18n.registerMessages` 无归属、无命名空间，可覆盖内核与他人文案
- **级别**：中
- **证据**：`i18n.js:307-333` —— 注册不进 caller 校验，深合并把插件键**叠在内核包之上**（`rebuildDict` i18n.js:93-97：内核为底、插件为顶层覆盖）。插件注册 `{menu:{about:"恶搞"}}` 会污染全系统菜单文案。
- **影响分析**：文案注入面；插件间键冲突后注册者赢，无告警。
- **修复建议**：注册时要求顶层命名空间等于调用者插件 id（栈解析此刻可用——注册发生在插件脚本求值/回调期），或至少对覆盖既有内核键的行为 `writeLog("warn")`；office 当前用 `office.` 前缀（mods/office/t.js:22）正好是这个约定的自然形态，可顺势固化。
- **验证方式**：插件注册非自身前缀的键被拒/告警；office 现有键不受影响。
- **修复状态**：已修复

### API-07 · `window.__settings` 完整暴露 `define/set`，插件可重定义内核设置键
- **级别**：中
- **证据**：`settings.js:684` — `globalThis.__settings = settings`；`define()`（settings.js:337-357）对同名键做**字段合并**，无 owner 校验。插件可 `__settings.define({key:"dock.size", min:0, max:9999})` 改坏内核定义，或 `__settings.set("store.disabled", [...])` 直接禁用别的插件。
- **影响分析**：设置中枢是大量 UI 的事实源；插件可静默改写。注释里把这类全局当「内核便利」处理，但同 realm 里它对所有插件可达。
- **修复建议**：收窄全局为只读+受限写（`get/subscribe/onKey`），`define/set` 仅保留 ESM 导出给内核；或 define 时校验 `owner` 与调用者一致、内核键禁止二次定义。兼容：siri 等插件在用 `__settings.set`（mods/siri/script.js:487-490），需先给 Deskly 加 `settings.setSelf(key,value)`（键强制 `插件id.` 前缀）再收窄。
- **验证方式**：控制台 `__settings.define` 不可达；siri 尺寸滑块照常工作。
- **修复状态**：待协调

### API-08 · 错误信封不可编程：只有中文 reason，没有 code
- **级别**：中
- **证据**：`os-api.js:64-76` —— 拒绝/失败/未实现三种形态都是 `{ok:false, reason:"中文"}；denied:true` 只在权限拒绝时有。`pending()`（:81-83）与真拒绝同形，插件无法用代码区分「没权限」与「能力不存在」。
- **影响分析**：插件想做「未实现就隐藏入口、拒绝就引导授权」的分支只能匹配中文字符串，语言与措辞一改就崩。
- **修复建议**：信封加 `code` 枚举（`DENIED / UNIMPLEMENTED / NOT_FOUND / INVALID_ARG / INTERNAL`），reason 保留给人看。deskly.html 补一张 code 表。纯增量字段，向后兼容。
- **验证方式**：静态检查断言所有 guard/pending 出口都带 code；插件示例按 code 分支。
- **修复状态**：已修复

### API-09 · `Deskly.fs` 能力面缺口逼插件绕行
- **级别**：中
- **证据**：`os-api.js:153-199` —— 只有 read/write/list/mkdir/remove/exists/at/writeAt/temp/home/type。**没有** rename/move/copy/stat/watch；`read` 返回完整 `File`，无流式与大文件分片。现实后果：notepad 自动保存（core/storage.js）、office 保存（office-io.js:144）需要 `OSFS.TOP.documents`、`joinPath`、NeedsReauthError 判别等，Deskly.fs 给不了，只能 import OSFS。
- **影响分析**：缺口是 API-01 的直接诱因之一；每缺一个动词就多一个绕门面的理由。
- **修复建议**：补 `fs.stat`、`fs.rename`、`fs.copy`（OSFS 均已有底层实现，薄封装即可）；`fs.at/writeAt` 的错误把 `NeedsReauthError` 翻成 `code:"REAUTH"` 而不是消息文本。先补这五个再谈 API-01 方案 B。
- **验证方式**：dev/osfs-check.mjs 既有断言保持绿；用 Deskly.fs 改写 notepad 的保存路径做冒烟。
- **修复状态**：部分修复

### API-10 · 插件↔宿主无版本协商
- **级别**：中
- **证据**：`store-api.js:343 installZip` 只校验 id 合法性/内置冲突/资源完整性，不读任何宿主兼容声明；manifest 格式（devdocs/guides/plugin-format.html）无 `host`/`minHost` 字段；`Deskly.meta.version`（os-api.js:323）只是只读信息。
- **影响分析**：Deskly 任何 breaking change（如 API-05 收紧 emit）都没有拒绝旧插件的机制，只能现场崩给开发者看。
- **修复建议**：manifest 增加可选 `host: "0.3.x"` 语义化区间；installZip 不满足即拒装并给出「该插件需要 Deskly ≥ x.y」；`Deskly.meta` 已有 version，插件侧零成本自查。
- **验证方式**：装一个声明 `host:"9.9"` 的包，商店给出明确拒绝原因。
- **修复状态**：已修复

### API-11 · 调用者识别依赖栈帧 URL，属脆弱契约且只在部分通道打了补丁
- **级别**：中
- **证据**：`caller-context.js:35-46` —— 从 `new Error().stack` 正则匹配 `mods/<id>/` 帧；已知缺口由 `withCaller` 补丁覆盖（bus.on 订阅时绑定，os-api.js:218-223；settings 订阅同理）。但**任何新的「插件注册回调、内核稍后调用」通道都要记得打这个补丁**，目前没有静态守卫——例如 `finderbar.js:976-979` 的插件图标 onClick 是裸调用（当前碰巧可识别，因为插件函数自身帧在栈上；一旦未来经过内核包装转发就会静默失效，落到 guard 的拒绝分支）。
- **影响分析**：失败形态是「偶发 ok:false 无法确认调用者」，插件作者无法自诊；且栈格式是未标准化行为，Firefox/Safari 兼容性仅靠正则巧合成立（两家的栈字符串里都含 URL，但格式均未受静态检查覆盖）。
- **修复建议**：(1) 建立「注册点必包 withCaller」 lint 规则（static-check 扫描 `addEventListener(` 内核侧注册插件回调的位置）；(2) 长期把 ZIP 插件脚本注入改为带 `//# sourceURL=/mods/<id>/script.js` 保证帧 URL 稳定，并在 deskly.html 写明「哪些回调路径保证有归属」。
- **验证方式**：在 finderbar 图标 onClick 里调 `Deskly.fs.list()` 实测各浏览器；static-check 新增规则通过。
- **修复状态**：待协调

### API-12 · ZIP 安装无来源校验与完整性校验，密码字段设计已漂移
- **级别**：中
- **证据**：`store-api.js:343-430` —— installZip 校验：扩展名 .zip、id 合法、非内置、10MB 上限、manifest 可解析、资源回读。**没有**签名/sha256/来源白名单。项目记忆中的商店 JSON 格式含 `password` 字段（蓝奏云下载密码），现行实现已无任何远程源与密码逻辑（`mods/app-store/script.js` 无 fetch/远程源），本地商店 manifest 也已改写为「只认本机注册表」（mods/app-store/manifest.json:8）。
- **影响分析**：本地拖放安装的场景下无签名可接受（用户自己拖的包自己负责）；但权限清单面板（showPermissionChecklist）是唯一的信任闸门，门上没有「包指纹」可核对。设计文档里的密码字段已成死设计，需文档收口。
- **修复建议**：短期不动安装逻辑；把 docs 中「password/远程源」相关描述标记为「未实装」或删除。中期若要远程源，manifest 增加 `sha256` 并在 installZip 校验。
- **验证方式**：文档 grep 无密码字段残留描述；装改造包按预期工作。
- **修复状态**：待协调

### API-13 · 返回形态与空值语义不统一
- **级别**：低
- **证据**：受管方法返回信封（`fs.read`），免权限方法返回原生值（`apps.list` os-api.js:135、`apps.info` :145 查不到给 `null`），而 `fs.type.get` miss 时给 `undefined`（os-api.js:192-198）；`windows.state` 查不到给 `null`（:300-303）。`bus.emit` 同步返回 `true`，其余受管方法全是 Promise。
- **影响分析**：同一门面里 `null`/`undefined`/信封三种「没有」的语义并存，插件作者要逐个记。
- **修复建议**：统一「查无」为 `null`；在 deskly.html 加一节「返回形态总表」。不急着改代码（涉及兼容），先把文档写全。
- **验证方式**：文档评审 + 新插件开发者走查。
- **修复状态**：已修复

### API-14 · `fs.home()/fs.temp()` 在认不出调用者时回落 kernel 作用域
- **级别**：低
- **证据**：`os-api.js:167-191` —— `scopeOf(resolveCaller())`，`resolveCaller()` 为 null 时 `scopeOf(null)` → `KERNEL_SCOPE`（os-api.js:46,89），把 `/AppData/kernel` 的路径交给了一个身份不明的调用者。
- **影响分析**：信息泄漏面极小（只是路径字符串），但与 guard「认不出即拒绝」的原则自相矛盾——同类情况在 guard 里是拒绝，在这两个免权限方法里是放行到 kernel 命名空间。
- **修复建议**：`resolveCaller()` 为 null 时这两个方法返回 `null`（或抛给调用方一个明确信封），不写进 kernel 目录。
- **验证方式**：控制台直接调 `Deskly.fs.home()`（无插件帧）观察返回值。
- **修复状态**：已修复

### API-15 · 订阅/注册资源清理全靠插件自觉，内核已握有归属却不帮忙
- **级别**：低
- **证据**：`bus.on` 订阅时已捕获 owner（os-api.js:218-223 注释明说「归属在订阅时定一次」），但内核没有在任何地方按 owner 归账——`plugin-unload` 时不自动退订，靠每个插件手写 removeEventListener（office/script.js:677-700、notepad/script.js:482-492 等，13 个 mod 各有各的摘法）。`registerFinderbarIcon`/`__menuActions` 同样「卸载不自动摘」（devdocs/api/deskly.html:103-105 自己承认）。
- **影响分析**：这是冷加载模型下内存/监听泄漏的最大结构性来源；目前内置 mod 都写对了，但第三方插件写漏即泄漏，且无任何兜底。
- **修复建议**：`bus.on` 返回退订的同时把 `{owner, off}` 登进内核表，`plugin-manager.unload(id)` 时统一补退（幂等，插件自己退过就跳过）；`registerFinderbarIcon`/`__menuActions` 同理按 data-plugin-id 归属自动回收。纯增量兜底，不破坏现有手写清理。
- **验证方式**：装一个故意不清理的测试插件，反复开关 50 次，DevTools 监听器计数不增。
- **修复状态**：已修复

### API-16 · 插件侧小数据无门面，散落 localStorage 裸键
- **级别**：低
- **证据**：`mods/office/office-io.js:26-27,163-171`（`webstartos_office_recent` 最近打开表）、`vfs.js:23`（`webstartos_vfs_bookmarks` 虚拟书签）等直接读写 localStorage。这些键不进设置中枢，因此**不在通用面板的导出/恢复快照里**（default-apps.js:7-13 注释专门论证过进中枢才自动进备份）。
- **影响分析**：用户「导出设置」换机后，office 最近打开列表等插件数据静默丢失；各 mod 键名约定无约束，迟早撞名。
- **修复建议**：Deskly 增 `kv`（或 `settings.self`）小存储：键强制 `插件id.` 前缀、走设置中枢、纳入快照。存量键写一行迁移即可。
- **验证方式**：导出→清站→恢复后 office 最近列表仍在。
- **修复状态**：待协调

### API-17 · 大二进制无插件级通道：photos 自立 IndexedDB，文件体系外循环
- **级别**：低（有意权衡 + 能力缺口并存）
- **证据**：`mods/photos/photo-store.js:1-20` —— 原图/缩略图存独立库 `webstartos-photos`，理由是 OSFS 树（webstartos-vfs）与配额/性能考虑；结果是访达/Spotlight 看不到照片库内容，权限面板上这个库与 vfs 并列（permissions.js:44 DATABASES 四库）。
- **影响分析**：当前自洽且注释诚实；但它证明 `Deskly.fs` 缺「插件私有二进制仓」这一档（AppData 里的 Blob 与大文件集合），下一个要做相册/音视频库的插件还得再自立一个库。
- **修复建议**：不动 photos；在 Deskly.fs 增加 `blob` 子面（put/get/delete/list，仅存自己 AppData 对应的 IDB 子仓）时把 photo-store 作为首个迁移对象。
- **验证方式**：新 API 下 photos 迁移后缩略图/原图读写断言全绿。
- **修复状态**：待协调

### API-18 · 文档缺口与过时注释
- **级别**：低
- **证据**：
  - devdocs/api/deskly.html 已对齐 0.3.6（未实现占位如实标注 :94-101），但缺：信封 `code` 表（依赖 API-08）、bus 内核保留主题清单、调用者归属在哪些回调路径有保证（API-11）、`mods/office` 这类多应用插件的 `plugin-app-load/open/unload` 三事件契约时序图（events.html 有清单无时序）。
  - 过时注释：`controlcenter.js:693-694` 声称「插件在自己的 iframe 里，跨文档读取会被同源策略挡住」——与同 document 注入模型直接矛盾（现在播卡恰恰靠扫主文档的 `<audio>/<video>` 工作）。
  - README/项目记忆中的「沙箱 iframe + postMessage 通信」描述与实现（注入式同 realm）不一致。
- **影响分析**：新插件开发者按过时模型写代码（比如以为有 postMessage 通道）会走不通；注释矛盾会误导后续维护。
- **修复建议**：补上述四节文档；改 controlcenter.js:693 注释；README 架构段对齐 devdocs/architecture.html。
- **验证方式**：文档评审 + 新手指引用 ZIP 样例插件实操一遍。
- **修复状态**：部分修复

### API-19 · `window.__currentPluginId` 只写不读的残留全局
- **级别**：低
- **证据**：`plugin-manager.js:759,764,768,886,889` 五处写/清；api-grants 已明确不再读它（api-grants.js:185-191 注释）。全仓无真实读点。docs/代码审查_全量分层_v0.2.92.md 已建议「下一轮直接删掉写入点」。
- **影响分析**：死全局本身无害，但它是一个「插件可自由改写」的身份提示物，留着就是诱导后来者误用的陷阱。
- **修复建议**：删除全部写入点与清理点（5 行），无需替代。
- **验证方式**：grep 归零；开关各应用回归正常。
- **修复状态**：已修复

### API-20 · 插件无主动生命周期 API（只能听天由命）
- **级别**：低
- **证据**：Deskly 八组里没有 lifecycle 面；插件想「自我卸载/请求重启/询问自己是否将被卸载」只能监听 document 的 `plugin-unload` 广播（plugin-manager.js:953）。多应用插件的引用计数（`unloadApp` :929-935）对插件完全不可见。
- **影响分析**：当前内置插件够用；但「长任务插件想在卸载前申请 3 秒收尾」这类正当需求没有通道。
- **修复建议**：加 `Deskly.lifecycle.onBeforeUnload(fn)`（同步收尾窗口）与 `Deskly.lifecycle.state()`，窗口关闭前给一次同步机会。可与 API-15 的自动清理共用归属表。
- **验证方式**：测试插件在关窗时完成一次 IndexedDB 落盘再消失。
- **修复状态**：已修复

## 5. 汇总

| 级别 | 数量 | ID |
|------|-----:|----|
| 高 | 3 | API-01、API-02、API-03 |
| 中 | 9 | API-04 ~ API-12 |
| 低 | 8 | API-13 ~ API-20 |

合计 20 条。

**最优先 5 项**：API-02（事件伪造→账本失守，改动小收益大）→ API-01（明确双层模型，文档+清单裁剪先落）→ API-03（未实现权限打标 + UNIMPLEMENTED code）→ API-05（bus 保留字）→ API-08（信封 code 枚举，是后续一切可编程错误处理的底座）。
