# 系统 API 参考（插件侧）

> 回到 [文档目录](index.md)

插件与宿主跑在**同一个 document** 里（[架构总览](architecture.md)「运行模型」），
所以系统能力有三种形态：**`window.*` 全局对象**、**可直接 `import` 的 ES 模块**、
以及**受权限门禁的 `window.Deskly`**（§六）。
本文每个接口都给出代码出处（`file:line`），没有出处的写法就是没实现，别照着别的文档写。

格式约定：每条 API = 一行说明 + 3 行以内示例 + 是否需要权限。

## 〇、关于权限

有两层「权限」，别混：**API 能力授权**与**浏览器自身权限**。

**API 能力授权**：`window.Deskly` 那组接口按权限名设防 —— 插件必须在 `manifest.json` 的
`permissions` 里声明，运行时由 `src/javascripts/api-grants.js` 记账与放行
（权限全量表 `api-grants.js:29`，共 15 条）。流程是「装时一次性授权 → 敏感能力首次调用再确认一次
→ 选『始终允许』后无感」：

| 阶段 | 发生什么 | 代码 |
|------|----------|------|
| 声明 | `registerPlugin` 广播 `plugin-registered`，账本按 `manifest.permissions` 记一条 granted | `app-registry.js:79` → `api-grants.js:249` |
| 安装清单 | ZIP 安装前展示权限清单，点「取消」整段终止、不落库 | `api-grants.js:showPermissionChecklist()`、`store-api.js:394`（确认在落库之前） |
| 运行激活 | 敏感能力弹「拒绝 / 仅此一次 / 始终允许」，三按钮由 `ui/dialog.js` 的权限对话统一渲染 | `api-grants.js:327`、`ui/dialog.js` |
| 拦截点 | 每个受管方法用 `guard(权限名, 实现)` 包着，权限名写在定义处 | `os-api.js:53` |

- **敏感**的只有 4 类外加 `system-patch:*`（`api-grants.js:73`）：改默认应用、跨应用窗口样式、
  主题包、文件存储。其余（读文件、启动应用、小组件、动态图标、自身样式）**装时就激活**、不弹窗 ——
  否则 14 个内置插件开机各弹一轮。
- **未声明的能力直接拒绝**：返回 `{ok:false, denied:true, reason:"未授权：…"}`，
  不会弹「要不要授权」，因为能弹窗就等于声明没有意义。
- 内置插件与 ZIP 走**同一个授权入口**（都经 `app-registry.js:55` 的 `registerPlugin`），
  差别只在装时那次清单展示由谁触发。
- 下文 §一–§五 的 `window.__*` 全局与 ES 模块**仍不设防**：装上就能调。

> ⚠️ **这套是同意与记账机制，不是安全沙箱。** 插件与内核跑在同一个 document 里
> （[架构总览](architecture.md)「运行模型」），插件可以 `import { OSFS } from "../../src/javascripts/osfs.js"`
> 直接用、也能碰 `localStorage` / `indexedDB` / `document`；冻结 `window.Deskly` 只防住重新赋值，
> 防不住绕行。`OSFS.scope(id)` 的目录边界（§4.1）同样是同一 realm 内的礼貌边界而非安全边界。
> 真正的硬边界只有 MV3 的 `script-src 'self'`（它顺带关掉了 `eval` / `new Function` 这条路）。
> 认调用者优先读**内核在派发插件回调时声明的归属**（`caller-context.js` 的
> `withCaller`，由 `settings.subscribe` 与 `Deskly.bus.on` 在订阅时定一次），读不到才回落到
> 解析调用栈里的 `mods/<id>/` 帧。**两步都认不出时一律拒绝**（`os-api.js` 的 `guard`），
> 不再把「认不出」当成「内核自己调用」放行 —— 那是旧版的权限检查缺口，已封。

**浏览器自身权限**与本节无关，接口只是**转达**它们的结果：

| 能力 | 入口 | 被拒时 |
|------|------|--------|
| 剪贴板写入 | `log.copy()`（`src/javascripts/log.js:514`） | 先 `warn` 一条（`log.js:523`），再退回选中 + `execCommand` 法（`log.js:526`–`:532`） |
| 本地文件夹 | `OSFS.mount()`（`src/javascripts/osfs.js`，`VFS.authorize()` 是它的转发） | 用户关拾取器即失败，由调用方提示；**不挂载也完全可用**，见 §4.1 |
| 系统级通知 | `Notification.requestPermission()`（`src/javascripts/permissions.js:156`） | 站内横幅 `window.__notify` 不依赖它，照常能弹 |

> `window.__notify`（`src/javascripts/ui/notification.js:211`）画的是**桌面右上角的站内横幅**，
> 全程不碰浏览器 `Notification`；要系统级通知就用 `window.__permissions.request("notifications")`
> （`permissions.js:298`、`:172`，内部即 `Notification.requestPermission()`，`permissions.js:156`）。
> 也别把 `window.__permissions`（`permissions.js:329`）当成 API 授权：它查的是上面这些**浏览器权限的只读状态**，
> 与「插件能不能调某个接口」无关。

## 可用时机

`index.html:71` 的 `main.js` 排在所有模块之前，而 `main.js:13` 的第一个 import 就是 `log.js`，
`bootstrap.js:27`–`:28` 再依次求值 `settings.js` / `settings-definitions.js`。
两者求值结束时就把 `window.__log`（`log.js:580`）和 `window.__settings`（`settings.js:602`）挂好了，
而插件入口脚本要晚得多才被注入（`plugin-manager.js:567`）。
结论：**插件里（含入口脚本顶层与模块求值期）直接读这两个全局即可**，不必 import；
先 import 再用也不坏，但 `settings.js` 自身是可选引用日志的（`settings.js:61`–`:63`），别反过来依赖它。

---

## 一、设置接口 `window.__settings`

全系统唯一的设置读写入口：校验 → 落盘 → 生效 → 广播 → 记日志走同一条链路（`settings.js:287`–`:597`）。

| 方法 | 一行说明 | 证据 |
|------|----------|------|
| `get(key, fallback?)` | 取值；未注册键按推导槽宽松解析，存储值非法时回退默认 | `settings.js:330`、`:334`、`:244` |
| `set(key, value, opts?)` | 写入并返回 `{ok, key, value, persisted, changed}`（拒绝时另带 `reason`）；`opts = {silent, source}` | `settings.js:348`、`:413` |
| `setMany(pairs, opts?)` | 批量写入，逐条校验与广播 | `settings.js:422` |
| `reset(key, opts?)` | 删存储槽回落内置默认（`jsonPath` 键改写默认值） | `settings.js:433`、`:438`、`:439` |
| `resetAll(scope?)` | 按 `{prefix, owner, pane}` 批量恢复默认，返回项数 | `settings.js:456` |
| `isDefault(key)` | 当前值是否等于默认值（未注册键恒为 `false`） | `settings.js:467`、`:469` |
| `has(key)` | 是否注册过该定义（不代表存储里有值） | `settings.js:478` |
| `info(key)` | 取定义副本（含界面元数据），无则 `null` | `settings.js:487` |
| `list(scope?)` | 列定义并按 `order`→`key` 排序，可按 `{prefix, owner, pane}` 过滤，每项带 `value` | `settings.js:497`、`:501`–`:506` |
| `all(scope?)` | 一组键的当前值表 | `settings.js:514` |
| `subscribe(fn)` | 订阅全部变更，返回退订函数 | `settings.js:525` |
| `on(key, fn)` | 订阅单键，回调签名 `fn(value, detail)`，返回退订函数 | `settings.js:537` |
| `define(def)` | 注册/合并一个设置项定义，非法返回 `null` | `settings.js:295`、`:307` |
| `defineMany(list)` | 批量注册，返回成功数 | `settings.js:320` |
| `snapshot(scope?)` | 导出**已注册**项的原始存储文本（槽名 → 字符串） | `settings.js:547` |
| `restore(data)` | 按槽名回灌备份，返回 `{restored, skipped}` | `settings.js:562` |
| `storage()` | 存储概览 `{keys, bytes, degraded}` | `settings.js:579` |
| `slot(key)` | 键对应的存储槽名（诊断/断言用） | `settings.js:594` |

权限：无，直接可用。

### 1.1 键名与存储槽

- **键名规则**：`命名空间.段[.段…]`，首段小写开头、后续段允许 camelCase，至少两段，
  由 `KEY_PATTERN` 校验（`settings.js:31`）。`office.showRuler` 合法，`badkey`、`Office.x`、`.a.b` 都会被 `define()` 拒绝并返回 `null`（`settings.js:296`–`:299`；`dev/settings-harness.mjs:75` 断言的是 `badkey` 这一条）。
- **槽名推导**：点号转连字符 —— `dock.zoom.amount` → `dock-zoom-amount`（`settings.js:66`–`:68`）。
  这条规则刻意与站内既有键重合，接入本接口不需要数据迁移（`settings.js:9`–`:11`）。
- **显式 `slot`**：历史键名对不上推导结果时才传，例如语言存的是 `webstartos_language`
  （`settings-definitions.js:104`）、程序坞顺序是 `webstartos_dock_order`（`settings-definitions.js:175`）。
  新插件**不要**传 `slot`，让推导名生效即可，否则 `slot()`/`snapshot()`/自检三方对不上。
- **`jsonPath`**：多个设置共用一个 JSON blob 时用，`slot` 指到那个 blob、`jsonPath` 指到子字段
  （读 `settings.js:249`–`:259`，写 `settings.js:388`–`:392`，只改这一个字段、同 blob 其它字段原样保留，
  断言见 `dev/settings-harness.mjs:109`–`:119`）。控制中心的 8 个卡片字段就是这么挂在同一个
  `webstartos_controlcenter` 槽上的（`settings-definitions.js:239`–`:247`、字段表 `src/javascripts/controlcenter.js:165`–`:179`）。

```js
__settings.define({ key: "myPlugin.zoom.amount", type: "number", default: 1.5, min: 1, max: 3 });
__settings.slot("myPlugin.zoom.amount");     // → "myPlugin-zoom-amount"（点号全部转连字符，段内大小写保留）
__settings.slot("general.language");         // → "webstartos_language"（内核用 slot 覆盖了推导名）
```

### 1.2 类型、校验与序列化

- `type` 只有 `boolean | number | string | json` 四种（`settings.js:28`），缺省时按 `default` 的 JS 类型推断（`settings.js:300`–`:302`）。
- **布尔落盘为 `"on"/"off"`**（`settings.js:207`），因为 owner 模块的既有读法是 `=== "on"` / `!== "off"`
  （`dock.js:221`–`:233`）；读回时 `on/true/1`、`off/false/0` 都认（`settings.js:110`–`:114`）。
  **未注册的裸键**例外：写的是 `"true"/"false"`，读回也还原成布尔（`settings.js:201`–`:207`、`:217`–`:226`，
  断言 `dev/settings-harness.mjs:137`–`:139`）。所以想让界面/owner 认出你的键，就先把定义 `define` 出来。
- **`values` 白名单**：不在候选值内的写入直接拒绝，`reason` 形如「取值 neon 不在候选值 light / dark / auto 内」
  （`settings.js:366`–`:368`；存储里已有非法值时 `get()` 回退默认并留一条 warn，`settings.js:190`–`:193`）。
  `values` 也可以是数字数组（`settings-definitions.js:128`–`:130`）。
- **`min/max/step` 钳制**：数字超界不是拒绝而是**钳到边界再按 step 取整**，返回的 `value` 就是钳后的值（`settings.js:158`–`:165`，写入路径 `settings.js:356`；断言 `dev/settings-harness.mjs:91`–`:93`）。
- `json` 值可以传对象也可以传 JSON 文本；坏文本被拒（`settings.js:358`–`:363`）。对象默认值与存储值做浅合并，
  新版本新增字段自动带默认值（`settings.js:135`–`:141`）。

### 1.3 `set()` 的返回值：三种失败要分开处理

`set()` 永远返回对象，不抛错（`settings.js:346`、`:413`）：

| 字段 | 含义 |
|------|------|
| `ok` | 值是否通过校验；`false` 时 `value` 是**当前值**（不是你传进来的值） |
| `key` | 回显写入的键名（成功与拒绝两条返回路径都带，`settings.js:377`、`:413`） |
| `value` | 校验/钳制之后真正生效的值 |
| `persisted` | 是否写进了 localStorage；`false` = **本次会话能用，刷新就回退** |
| `changed` | 是否与旧值不同；同值写入不广播、不记日志（`settings.js:385`、`:408`） |
| `reason` | 仅拒绝时出现，中文说明（同时进 `__log` 的 `error`，`settings.js:372`–`:377`） |

```js
// 前提：define 里写了 values: ["light", "dark"]
const r = __settings.set("myPlugin.theme", "neon", { source: "my-plugin" });
if (!r.ok) { __log.warn("plugin/my-plugin", `写入被拒：${r.reason}`); return; }   // r.value 仍是当前值
if (!r.persisted) __notify.show({ title: "未能保存", text: "本地存储写不进去，刷新后会回退" });
```

`persisted: false` 的来源是配额写满或隐私模式：中枢内部降级为内存替身并继续生效（`settings.js:82`–`:95`、`:39`–`:58`），
断言见 `dev/settings-harness.mjs:152`–`:158`。**不要**把它当成功默默吞掉，也不要当失败回滚。
系统设置的控件层就是这么处理的（`mods/system-settings/ui.js:83`–`:95`），照抄即可。

### 1.4 插件注册自己的设置项（系统设置自动渲染）

只要 `define()` 一个带界面元数据的键，系统设置就会替你把它画出来 —— 不必自绘设置界面。
元数据字段与读取方：

| 字段 | 说明 | 读取方 |
|------|------|--------|
| `owner` | 归属模块/插件 id，`list/all/resetAll` 的过滤维度 | `settings.js:502`、`debug.js:237` |
| `pane` | 归到系统设置哪个面板；**必须是注册表里 `implemented: true` 的 id** | `settings.js:503`、`mods/system-settings/registry.js:97`–`:223`（面板表）、`:230`–`:232`（只放行已实现项）；由 `dev/settings-fulltest.mjs:345`–`:349` 逐条校验 |
| `label` / `hint` | 行标题 / 灰字说明（缺省 `label` 用键名） | `mods/system-settings/ui.js:542` |
| `control` | 控件类型，见下表 | `mods/system-settings/ui.js:543`–`:552` |
| `values` / `valuesLabel` | 候选值 / 与 `values` 同序的显示文本；`values` 还可配 `valuesName`、`valueColors`、`valueImages` 三个可选映射 | `mods/system-settings/ui.js:562`–`:572` |
| `min` / `max` / `step` / `units` | 滑块区间与单位后缀（`units` 直接拼在读数后面） | `mods/system-settings/ui.js:545`、`:171`–`:195`、`:143` |
| `format` | 滑块读数格式，实测只有 `"percent"` 与 `"fixed1"` 两种 | `mods/system-settings/ui.js:140`–`:142` |
| `group` | 声明式分组名：被「调试 → 输出设置表」与聚焦搜索的匹配读，**面板内的分组仍由面板自己决定** | `debug.js:239`、`src/javascripts/spotlight.js:229` |
| `order` | 同面板内排序（小在前，缺省 0） | `settings.js:506` |
| `hidden` | 为真时不渲染行（键仍然有效，适合「程序读写、界面不给改」） | `mods/system-settings/ui.js:541`；用法 `settings-definitions.js:84`–`:88` |
| `requires` | 依赖另一个键：依赖为假时本行自动禁用（当前只有 `slider` / `segmented` 吃得到，细节见 §5.5） | `mods/system-settings/ui.js:122`–`:133`、触发点 `:149`；用法 `surface.js:495`、`:502` |

`control` 有真实控件的取值**只有 7 个**（逐条核对 `mods/system-settings/ui.js:543`–`:552`）：
`switch`、`slider`、`dropdown`、`segmented`、`radio`、`cards`、`swatches`。
**其它值走 `default: return null`（`ui.js:552`）—— 不渲染、不报错，界面上就是看不见这一行**。
写了自认为很合理的 `control: "colorpicker"` 而界面少一排，多半就是这个原因。
注意两件事：`ui.js` 另外导出的 `controlText()`（`:374`）**不在 `autoRow()` 的 switch 里**，
只有面板直接调它才有输入框；自检脚本的白名单 `SUPPORTED_CONTROLS`（`dev/settings-fulltest.mjs:346`）
比 `autoRow()` 宽（多了 `json` / `text`，且 `json` 在 `:350` 被显式跳过），
**自检绿了不代表界面画得出来**。

完整可复制的例子（假设插件 id 是 `myPlugin`，两个设置项都进「插件」面板）：

```js
// mods/myPlugin/script.js 顶部，或它 import 的子模块里
__settings.defineMany([
    {
        key: "myPlugin.enabled", type: "boolean", default: true, owner: "myPlugin", pane: "plugins",
        label: "启用我的插件", hint: "关闭后不再注入任何界面", control: "switch", group: "我的插件", order: 10,
    },
    {
        key: "myPlugin.opacity", type: "number", default: 0.8, min: 0.2, max: 1, step: 0.05,
        owner: "myPlugin", pane: "plugins", label: "浮层不透明度", control: "slider",
        format: "fixed1", group: "我的插件", order: 20,
    },
]);
// 读值与生效
const opacity = __settings.get("myPlugin.opacity");            // 拿到的是已钳制的数字
__log.info("plugin/myPlugin", `不透明度 = ${opacity}`);
```

`pane: "plugins"` 归到系统设置的「插件」面板：该面板在注册表里已登记（`mods/system-settings/registry.js:213`–`:217`），
收录规则是「`owner` 不是 `system`，且 `pane` 缺省或等于 `plugins`，且没被 `hidden`」（`panes/plugins.js:136`、`:174`–`:178`），
逐行交给 `autoRow()` 按 `control` 生成控件（`panes/plugins.js:141` → `mods/system-settings/ui.js:540`）。
同一条 `define → list → autoRow` 链路的内核实例是控制中心面板（`panes/controlcenter.js:126`、`:131`）。

**生命周期三条硬约束：**

1. **在插件初始化时就 `define`**，而不是等用户点开你的界面 —— 定义表在内核侧（`settings.js:34`），
   注册了才会出现在设置里；`define` 之前 `get()` 走的是未注册键的宽松通道（`settings.js:332`–`:334`）。
2. **`define` 必须可重复调用**：入口脚本每次打开都用全新 URL 重新执行（`plugin-manager.js:567` + `paths.js:39`），
   这段代码会跑 N 遍。`define()` 对同名定义做的是**字段合并**
   （`const merged = { ...(defs.get(def.key) || {}), ...def, type };`，`settings.js:307`），
   跑几遍都只有一份定义，所以照上面写就是幂等的；别在 `define` 里塞 `apply` 闭包捕获的外部状态。
3. 顺带一句：**没有撤销定义的接口**（`settings.js` 全文不删 `defs`）。插件卸载后它的定义仍留在表里、
   仍会在「插件」面板出现一行。要「关掉即隐藏」请用 `hidden` 或在自己的 `apply` 里兜住缺失状态。

### 1.5 `event` 与 `apply`：二选一

| 写法 | 行为 | 用在哪 |
|------|------|--------|
| `apply: (value, {previous, persisted, source}) => {}` | 落盘后由中枢调用，抛错只记 `error` 不打断写入（`settings.js:397`–`:406`） | owner 模块自己会把值应用到真实状态（`settings-definitions.js:48`、`:73`） |
| `event: "dock-size-change"` | 中枢在 window 上补发旧格式 CustomEvent，`detail` 是**序列化后的字符串**（json 类型例外，直接给对象）（`settings.js:269`–`:272`） | owner 只有监听、没有 setter 的历史模块：dock 的 7 个布局项（`settings-definitions.js:136`–`:171`，监听方 `dock.js:1003`–`:1040`）、启动台两项（`:194`–`:203`）、Siri 一项（`:232`–`:236`） |

**同一个定义里不要同时写 `event` 和 `apply`**：owner 的 `apply` 里往往自己就 `dispatchEvent`
（`settings-definitions.js:119`、`:254`），中枢再按 `event` 补发一次，同一个事件就派发两遍、监听方执行两遍。
这条约定的出处是 `settings-definitions.js:10`–`:12`，全表逐条遵守（有 `event` 的条目都没有 `apply`）。
**新插件两者都不必写**：需要即时生效就在自己代码里订阅 `settings-changed`（见 1.6），
`apply` 留给「值即状态」的 owner 模块用。

### 1.6 订阅变更（含别处的改动）

两条通道，都从中枢发出（`settings.js:267`–`:278`）：

```js
// 1) 推荐：接口级订阅，返回退订函数
const off = __settings.subscribe((d) => { if (d.key.startsWith("myPlugin.")) repaint(d.value); });
const offOne = __settings.on("myPlugin.opacity", (value, detail) => repaint(value));   // settings.js:537

// 2) document 上的统一事件：bubbles: true，detail 是对象 {key, value, previous, persisted, type}
document.addEventListener("settings-changed", onChanged);   // settings.js:273、:274
```

- 同值写入不会广播、不会记日志（`settings.js:385`、`:408`，断言 `dev/settings-harness.mjs:144`–`:150`），别指望它做心跳。
- `opts.silent` 的写入（批量恢复用）同样不广播也不通知订阅者（`settings.js:408`）。
- **必须在 `plugin-unload` 里释放**：入口脚本每次打开重跑一遍，而模块表不回收旧实例
  （`plugin-manager.js:566`、[冷加载机制](cold-load.md) 的硬约束 1），订阅函数连同它捕获的已卸载 DOM 会永久累积。

```js
const off = __settings.on("myPlugin.opacity", repaint);
window.addEventListener("plugin-unload", (e) => {
    if (e.detail?.id !== "myPlugin") return;
    off();                                     // subscribe/on 的返回值就是退订函数
    document.removeEventListener("settings-changed", onChanged);
});
```

### 1.7 别把密钥放进设置

`snapshot()` 会把**已注册项的原始存储文本**整份导出用于备份与诊断（`settings.js:547`–`:555`），
`settings-changed` 的 detail 与 `__log` 里的写入记录同样带着值（`settings.js:273`、`:411`）。
口令、token、私钥放进去等于明文抄送一遍。

仓库里的正确做法是锁屏口令：**哈希与盐存在设置中枢之外**，走自己的槽 `deskly-lock-hash` / `deskly-lock-salt`
（`src/javascripts/lock.js:28`–`:29`），由 `crypto.getRandomValues` 生成盐、`crypto.subtle.digest` 算
`SHA-256(盐:口令)` 后写入（`lock.js:183`–`:186`），校验时也只比对摘要（`lock.js:202`–`:208`），
日志里既不出现明文也不出现摘要（`lock.js:9`–`:11`）。

---

## 二、日志接口 `window.__log`

一份可查、可留存、可导出的运行记录（`log.js:339`–`:564`），并已把仓库里 300 余处裸 `console.*` 自动接住（清点见 `log.js:4`）。

| 方法 | 一行说明 | 证据 |
|------|----------|------|
| `info/warn/error/debug(source, msg, data?)` | 按级别写一条；被门槛过滤时返回 `null` | `log.js:355`–`:358`、`:175` |
| `entry(level, source, msg, data?)` | 级别用变量时的统一入口，非法级别按 `info` 归档 | `log.js:351` |
| `for(source)` | 生成绑定来源的子日志器（`.info/.warn/.error/.debug/.entry/.timer`） | `log.js:365`–`:376` |
| `timer(label)` | `timer("首屏").stop()` 以 info 记毫秒差并返回数字 | `log.js:383`–`:393` |
| `assert(cond, source, msg)` | 不成立时记一条 `error` 并返回 `false` | `log.js:402`–`:406` |
| `query(opts?)` | 条件筛选，返回记录副本数组 | `log.js:413`、选项 `log.js:410`、`:323`–`:337` |
| `recent(n = 100)` | 最近 n 条（时间正序） | `log.js:422` |
| `count()` / `stats()` | 缓冲条数 / 分级分来源统计（含 `capacity`、`dropped`、`restored`、`persisting`） | `log.js:427`、`:438`–`:452` |
| `subscribe(fn)` | 订阅新记录，返回退订函数（日志窗口实时刷新用） | `log.js:459` |
| `clear()` | 清空内存缓冲与留存 | `log.js:466` |
| `exportText(opts?)` / `exportJSON(opts?)` | 导出纯文本 / JSON 文本 | `log.js:474`、`:480` |
| `download(filename?, opts?)` | 触发浏览器下载 `.log` | `log.js:490` |
| `copy(opts?)` | 复制到剪贴板，返回 `Promise<boolean>` | `log.js:514` |
| `setLevel(level)` / `getLevel()` / `levels()` | 门槛读写与级别名单 | `log.js:548`、`:541`、`:341` |
| `config()` | 生效中的日志配置副本 | `log.js:554` |
| `plugins()` | 已注册插件 id 名单 | `log.js:432` |
| `flush()` | 强制立即落盘（debounce 900ms 不等了） | `log.js:560`、`:32` |

权限：无（`copy()` 例外，见「〇」表的剪贴板一行）。

### 2.1 级别与门槛

`debug < info < warn < error`（`log.js:24`）；低于 `debug.logLevel` 门槛的记录**直接丢弃**，
默认门槛是 `info`（`log.js:68`、`:175`，断言 `dev/settings-harness.mjs:169`–`:178`）。

```js
__log.debug("plugin/my-plugin", "只有开发者模式才看得到的细节");   // 默认门槛下不入库
__log.setLevel("debug");                                          // 等价于 settings.set("debug.logLevel","debug")
```

所以：排查自己插件时先把门槛放到 `debug`，别抱怨「我写的 debug 呢」。

### 2.2 来源分类：`kernel/<模块>` 与 `plugin/<id>`

来源统一带类别前缀（`log.js:137`–`:142`）：

- 已含斜杠的直接采用：`plugin/siri`、`kernel/dock`。
- **裸名按内核模块白名单判定**：命中 `KERNEL_MODULES`（`log.js:46`–`:53`）归 `kernel/`，
  **未命中一律归 `plugin/`**（`log.js:141`，断言 `dev/settings-harness.mjs:166`–`:167`、`:179`–`:181`）。
  白名单是封闭集合，插件 id 是开放集合 —— 反过来才会随新插件漂移。
- **插件请显式写 `plugin/<你的id>`**。裸名 `myPlugin` 今天会被归到 `plugin/myPlugin`，
  但哪天内核加一个同名模块、或有人把名字加进白名单，你的日志就会静默跑进 `kernel/` 里，
  「按程序分类」这条维度就废了。仓内示范：`mods/system-settings/app.js:164` 写的是 `plugin/system-settings`。

```js
const log = __log.for("plugin/my-plugin");      // 子日志器已归一化来源
log.info("界面就绪");                           // → source = "plugin/my-plugin"
log.source;                                     // "plugin/my-plugin"（可用于断言/自检）
```

### 2.3 已写好的代码不必改造

`console.*` 在 log.js 求值时就被包了一层（`log.js:289`–`:297`）：先归档再原样输出，浏览器控制台行为不变。
`[tag]` 开头的既有写法会被直接当作来源（`log.js:157`–`:162`），级别映射是 `log/info → info`、
`debug → debug`、`warn → warn`、`error → error`：

```js
console.warn("[my-plugin] 找不到配置文件");   // → warn，source = "plugin/my-plugin"
```

未捕获异常、Promise 拒绝、资源加载失败（`<img>`/`<link>` 404）都被捕获成 `error` 记录
（`log.js:299`–`:315`：资源 `kernel/loader` `log.js:306`，异常 `kernel/global` `log.js:309`、`:313`）。
`debug.captureConsole` 随时可关，关掉后 `console.*` 就只走浏览器控制台（`log.js:73`–`:78` 定义、`:269` 每次调用时复查）。
`debug.captureErrors` 只决定异常监听**挂不挂得上**（`log.js:79`–`:84` 定义、`:300` 与 `:318`）：默认 `true` 时启动即挂上，
之后在设置里取消勾选**并不会停止归档** —— `log.js:302`–`:314` 的回调里没有再读这个开关，与 `:317` 的注释不符（已知缺陷）。

### 2.4 缓冲在内核，日志跨窗口、跨刷新

- **环形缓冲是内核模块作用域里的一个数组**（`log.js:35`），不在插件侧 —— 因为插件入口脚本每次打开都重新执行，
  放在插件里等于每次关窗就丢一批记录（设计说明 `log.js:14`–`:16`）。你关窗、重开、再关，日志一直在累积。
- 容量由 `debug.bufferSize` 决定（默认 800，`log.js:86`），溢出丢最旧并计入 `dropped`（`log.js:164`–`:170`）。
- **尾部若干条落 localStorage**，槽 `deskly-log-buffer`（`log.js:28`、`:215`–`:229`），刷新后仍能看见
  「上一次会话的报错」并补一条分界说明（`log.js:247`–`:253`）。关掉 `debug.persist` 就不落盘（`log.js:92`–`:96`）。
  留存是异步 debounce（900ms）的，关页/切后台时由 `flush()` 兜底（`log.js:573`–`:574`）。
- 落盘失败（配额被壁纸 data-URL 占满是本项目的已知情形）**只关留存功能，不影响设置写入**（`log.js:224`–`:228`）。

### 2.5 查询与导出

```js
__log.query({ level: "error", source: "plugin/my-plugin", limit: 20, desc: true });
__log.query({ minLevel: "warn", contains: "404", since: Date.now() - 60000 });
__log.download();   // 文件名缺省 deskly-log-<时间戳>.log
```

`query` 支持的选项：`level`（逗号分隔也可）/ `levels` / `minLevel` / `source`（子串匹配，不区分大小写）/
`contains`（同时匹配消息与 data）/ `since` / `until` / `limit` / `offset` / `desc`（`log.js:410`、`:323`–`:337`）。

### 2.6 插件侧模板（贴在 `script.js` 最上面）

```js
const LOG = window.__log?.for("plugin/my-plugin") ?? console;   // log.js 求值更早，一般必在
LOG.info("脚本已执行", { openedAt: Date.now() });
if (!window.__settings?.has("myPlugin.enabled")) LOG.warn("设置定义未注册，界面将用默认值");
```

`plugin-unload` 里不用清什么 —— 日志不归插件持有，这正是缓冲放在内核的意义。

### 2.7 在哪里看

- **系统设置 › 调试**：运行记录主视图。「调试 → 查看运行记录」就是跳这个面板（`debug.js:131`–`:134`，
  面板 id `debug` 在注册表里已登记：`mods/system-settings/registry.js:218`–`:222`；外壳按需
  `import("./panes/<module>.js")`，见 `mods/system-settings/app.js:361`）。
- **顶栏「调试」菜单**：清记录、导出、复制、切门槛、重载当前插件、输出设置表/层级体检、运行设置自检
  （菜单项 `debug.js:447`–`:464`，命令实现 `debug.js:467`–`:481`）。
  这个菜单只在 `debug.developerMode` 为真时出现（`debug.js:81`–`:83`、`:90`–`:95`，接线 `finderbar.js:24`、`:320`）。
- 浏览器控制台照常可用（归档之后仍原样输出，`log.js:272`）。

---

## 三、多语言

`i18n` 不是全局对象，插件按站内惯例 import：`import { i18n } from '../../src/javascripts/i18n.js';`（用法见 `mods/about/script.js:10`、`mods/notepad/script.js:22`）。

| 方法 | 一行说明 | 证据 |
|------|----------|------|
| `t(key, fallback = "")` | 点分路径取值，缺失回退 `fallback` | `i18n.js:224`–`:228` |
| `hasKey(key)` | 当前语言（**含插件注册的文案**）里有没有这个键 | `i18n.js:235`–`:238` |
| `getSupportedLanguages()` | 受支持语言表 `[{code, label}]`，别在界面里硬编码四门语言 | `i18n.js:273`–`:280` |
| `getLanguage()` / `setLanguage(lang)` | 当前代号 / 切换并持久化、重刷界面 | `i18n.js:265`、`:245` |
| `applyTranslations(root = document)` | 对（新注入的）子树应用 `data-i18n` | `i18n.js:167`–`:175`、`:337` |
| `registerMessages(lang, obj)` | **注册插件自带文案**，返回并入的叶子键数 | `i18n.js:289`–`:305` |
| `registerMessagesAll(byLang)` | 一次注册多语言，返回总数 | `i18n.js:312`–`:315` |
| `onChange(fn)` | 订阅语言切换，回调收到新代号，返回退订函数 | `i18n.js:324`–`:335` |

权限：无。语言代号只有 `zh-CN` / `en` / `ja-JP` / `cat` 四种（`i18n.js:35`–`:40`），越界代号的处理**分三处**：
`registerMessages` 忽略并记一条 warn（`i18n.js:290`–`:293`），`setLanguage` 直接抛错（`i18n.js:246`–`:248`），
`init(lang)` 退回持久化过的选择（`i18n.js:203`）。

### 3.1 插件自带文案（不碰内核语言包）

内核语言包是 `assets/locales/*.json`，插件**不要往里面加自己的键**：
`registerMessages` 写进独立的 `pluginMessages` 表（`i18n.js:50`、`:289`），
生效字典由「内核包为底 + 插件包叠上」深合并生成（`i18n.js:95`–`:99`）。

**关键行为（这条是有意设计的，别怀疑）**：每次内核语言包被重新拉取（`loadLocale`，`i18n.js:151`–`:161`），
都会把 `pluginMessages` 重新叠回顶层（`i18n.js:159` 调 `rebuildDict`），
所以 **refetch / 切换语言都不会抹掉插件键**；合并是递归深合并，内核新增或改写同命名空间下的某个键
也不会清空你的兄弟键（`i18n.js:63`–`:79`，数组与标量整体替换以保留「星期表」这类数组值）。
注册与内核加载的先后顺序无关：语言包没到位时也会先建好条目（`i18n.js:298`，说明见 `i18n.js:8`–`:12`）。

```js
i18n.registerMessagesAll({
    "zh-CN": { myPlugin: { title: "我的插件", run: "运行" } },
    en: { myPlugin: { title: "My Plugin", run: "Run" } },
});
const title = i18n.t("myPlugin.title", "我的插件");   // 键缺失时靠 fallback，界面不会空
```

界面文案是**构建时算出来**的那一类（下拉选项、标签数组）必须订阅 `onChange` 重建，
否则会永远冻在切换前的语言上（这正是旧版缺陷，注释见 `i18n.js:319`–`:321`）：

```js
const off = i18n.onChange(() => rebuildMyOptionList());   // plugin-unload 里记得 off()
```

### 3.2 `data-i18n` 机制

静态标记写两个属性：`data-i18n` 是键，`data-i18n-fallback` 是缺键时的回退文本
（`i18n.js:172`；实际用法 `index.html:66`、`mods/notepad/index.html:12`）：

```html
<span data-i18n="myPlugin.run" data-i18n-fallback="运行">运行</span>
```

- 命中的元素被写 `textContent`（不是 `innerHTML`，`i18n.js:173`），所以标记里别放 HTML。
- **插件 HTML 是打开时才注入 DOM 的**，早于任何静态初始化时机；内核为此挂了一个 `MutationObserver`，
  新注入节点带 `data-i18n`（或子树里有）就就地翻译（`i18n.js:179`–`:193`，注册时机 `i18n.js:204`）。
  你自己动态插入片段时，若 observer 还没跑，可直接 `i18n.applyTranslations(node)`。
- 内核只读 `data-i18n` 与 `data-i18n-fallback` 这两个属性（`i18n.js:172`、`:173`），**不支持** `data-i18n-title`
  这类变体：记事本里的 `data-i18n-title` / `data-i18n-placeholder` 是它自己补的一轮翻译
  （`mods/notepad/script.js:501`–`:504`），抄了这段才有用；访达界面上写的 `data-i18n-placeholder`
  （`mods/finder/index.html:63`）没有任何代码读，是死标记。新插件别指望写上去就自动生效。
  JS 拼出来的文案走 `t(key, fallback)`，系统设置就是这个写法（`mods/system-settings/ui.js:44`–`:46`）。

---

## 四、既有全局接口

插件可直接用的站内既有能力。**只有下表里这些是真的**，每条都有 `file:line`。

| 接口 | 一行说明 | 证据 |
|------|----------|------|
| `window.__dialog` | 系统弹窗：`alert / error / confirm / messageBox / prompt`，替代原生 `alert/confirm/prompt` | `src/javascripts/ui/alert.js:220`（各方法 `:222`、`:232`、`:242`、`:256`、`:262`） |
| `window.__notify` | 站内通知：`show(opts)` 返回元素或 `null`、`dismissAll()`、`pendingCount()`、`resetPendingCount()` | `src/javascripts/ui/notification.js:211`–`:220`（`show` 参数注释 `:107`–`:117`） |
| `window.__popover` | **下拉浮层**：`open({anchor, content, …})` 把菜单搬到 `<body>` 的浮出层里显示，因此能伸出插件自己的窗口；`close / closeAll / openCount / z` | `src/javascripts/ui/popover.js:269`（`openPopover:215`、`closeAllPopovers:260`），详见 §4.2 |
| `window.__dock` | 程序坞：`minimizeToDock / restoreFromDock / getDockIconImg / setBadge / addToDock / updateRecents / syncRunningApps / resetDockLayout / getDockLayoutSnapshot` | `src/javascripts/dock.js:1587`–`:1597` |
| `window.__menuActions` | 顶栏菜单命令**注册表**：`cmd` 是这里的键名，不是可求值的 JS | `src/javascripts/finderbar.js:1242`（分发 `src/javascripts/ui/menuCommands.js:22`） |
| `registerFinderbarIcon / unregisterFinderbarIcon` | 在顶栏右侧挂/摘一个状态图标：`({id, icon, onClick, order})`，同 id 先摘后挂 | 模块导出 `src/javascripts/finderbar.js:819`、`:867`（需 `import`） |
| `window.__pendingSettingsPane` + `system-settings-open-pane` | 深链到系统设置某个面板：先写全局变量（窗口没开时的交接），已开则派发 document 事件（冒泡） | 写入与派发 `src/javascripts/debug.js:110`、`:113`（入口 `openSettingsPane(paneId)` `debug.js:109`）；聚焦搜索同样派发该事件 `src/javascripts/spotlight.js:222`；消费在 `mods/system-settings/app.js:29`（全局名常量）、`:197`（事件监听）、`:502`（挂载时读交接变量） |
| `OSFS` | **文件存储内核**：单一根目录、两种后端（应用内 / 挂载的真实文件夹）、按插件分仓。`TOP` / `list` / `read` / `write` / `mkdir` / `remove` / `scope(id)` / `mount` / `status` | 模块导出 `src/javascripts/osfs.js`（全局别名 `window.__osfs`），详见 §4.1 |
| `VFS` | 文件树的**展示门面**（不含存储本体）：`list`（根=固定顶层夹＋收藏夹＋最近使用）、`readFile`、`isFile`、`getRecentFiles`、`getBookmarkTree`、`formatSize/formatDate`、`getAuthStatus`、`authorize/reauthorize/unmount/decline`、`whereStored`、`TOP_FOLDERS`。**已无 `addVirtualFile`**，写入一律走 `OSFS` | 模块导出 `src/javascripts/vfs.js`（插件用法 `mods/finder/script.js:10`） |
| `getPlugins / openApp / load / unload` | 注册表查询与冷加载入口：`openApp(显示名|id|appId, opts)` 是统一入口 | `app-registry.js:95`（经 `plugin-manager.js:45` re-export）、`plugin-manager.js:358`、`:315`、`:621` |
| `Z`（`zindex.js`） | 全站唯一浮层层级表，插件的 `z-index` 只能取自它 | `src/javascripts/zindex.js:22`–`:39`，见 [层级表](z-layers.md) |
| `window.__surface` | 亚克力表面的**模糊等级与可读文字色**（文字色只有面板档 / 墙纸档两套）：样式表引用令牌即可，全局对象只做登记与自检 | `src/javascripts/surface.js:543`（模块另导出 `surface` / `BLUR_LEVELS` `:541`、`initSurface` `:532`），见 §五 |
| `paths.js` 的 `assetPath / assetIcon / glyph / modFile / modUrl / modDateUrl` | 站内资源路径唯一来源；`glyph(name)` 取 `assets/images/<name>.svg` 界面字形（应用图标仍只用 PNG） | `src/javascripts/paths.js:13`、`:16`、`:23`、`:29`、`:36`、`:39`；图标规则 [插件包格式](plugin-format.md) |
| 解析钩子 `window.__getPluginByName / __getAppByName / __pluginManagerReady` | 按显示名解析插件/应用记录、等注册表就绪 | `src/javascripts/app-registry.js:27`–`:29` |
| `window.__settings` / `window.__log` / `__sound` / `__display` / `__lock` / `__permissions` / `__spotlight` | 本文「一」「二」与各自模块的 owner 接口 | `settings.js:602`、`log.js:593`、`sound.js:193`、`display.js:202`、`lock.js:582`、`permissions.js:332`、`spotlight.js:770` |

**字符串**形态的 `cmd` 合法写法**只有两种**（`ui/menuCommands.js:15` 的正则）：`name` 与 `name('arg')` / `name("arg")`，
即「注册表键名 + 至多一个字符串实参」。其它任何 JS 表达式一律被拒绝并打日志（`ui/menuCommands.js:34`–`:38`）——
MV3 扩展页 CSP 是 `script-src 'self'`，`new Function` / `eval` 在打包环境里直接失败（`ui/menuCommands.js:4`–`:7`）。
唯一的例外是 JS 里写的菜单表可以直接把 `cmd` 放成函数（`ui/menuCommands.js:23`–`:31`），
但 HTML 上的 `cmd="…"` 属性读出来永远是字符串，插件界面只能写键名。
往 `window.__menuActions` 加键是允许的（`debug.js:488`–`:490` 就是这么合并命令的），
但那张表在 `finderbar.js` 求值期只挂一次，**你加的键不会随窗口关闭而消失**，必须在 `plugin-unload` 里 `delete`。

### 4.1 文件存储：单一根目录与插件作用域

存储本体在 `src/javascripts/osfs.js`（`import { OSFS } from "../../src/javascripts/osfs.js"`，
或直接用全局 `window.__osfs`）。**根目录只有一个**，`/文档`、`/AppData/notepad/temp/x.json`
这些路径永远相对它，两种后端可换、插件代码不感知差别：

| 后端 | 什么时候用 | 内容在哪 |
|------|-----------|----------|
| `virtual`（默认） | 没挂载真实文件夹；扩展形态（`chrome-extension://` 没有目录选择器）**恒是这个** | 应用自己的 IndexedDB（库 `webstartos-vfs`，仓库 `virtualfiles`，`keyPath: path`） |
| `disk` | 用户执行过「选择本地文件夹作为根目录」且读写权限在 | 那个真实文件夹，路径逐段映射；顶层骨架由内核 `create` 出来 |

根下的固定顶层目录取自 `OSFS.TOP`（`documents/downloads/pictures/desktop/appdata`，
`appdata.internal === true` 表示插件内部目录、不参与聚焦搜索）。**别在插件里写 `"/文档"` 字面量**，
一律 `OSFS.TOP.documents.path`。

插件私有数据走作用域，内核保证你写不出自己的目录：

```js
const me = OSFS.scope("notepad");          // → /AppData/notepad
await me.ensure();                          // 预建 temp / config / data
await me.write("temp/draft.json", text);    // 缓存
await me.write("config/layout.json", json); // 配置副本
await me.write("data/…", bytes);            // 业务数据（string / Blob / ArrayBuffer / TypedArray 都吃）
await me.clearTemp();                       // 只清 temp
```

四条约定，违反其中任何一条都会变成 bug：

1. **`temp` 不可依赖持久性**。它可能被用户手删、被「清空缓存」清掉、被浏览器回收——
   读不到就当缓存未命中，**不许当错误**，也不许拿它当数据库。
2. **设置（`config`）的真相源仍是 `window.__settings`**（localStorage 槽）。冷启动要同步读的东西
   不能搬到文件里；`config/` 只放插件主动写出的**副本/导出**，读它必须容忍缺失。
3. **权限过期不静默回落**。挂载存在但 readwrite 没批时，所有 disk 后端调用抛
   `NeedsReauthError`（按 `err.name` 判别，别匹配 message）。界面要如实说「需要重新授权」，
   绝不写「已保存」——同一批路径有两个互相覆盖的真相比报错严重得多。
4. **`OSFS.unmount()` 只忘掉句柄，不删磁盘上的任何东西**；`remove()` 拒删根与顶层夹。
   取消挂载也**不会**把磁盘上的内容搬回应用内根目录 —— 它留在那个文件夹里，重新挂载才看得见。
5. **读路径有一层 1 秒的元数据索引**（`osfs.js` 的 `metaIndex`，为了不再每次列举都把整棵树连正文
   `getAll` 一遍：实测 300 个文件的库里，一次目录渲染原先要反序列化 600 KB，一次「最近使用」要扫 13 遍全表）。
   本标签页写入立即生效；**另一个标签页的写入最坏 1 秒后可见**。写路径不受影响——它一律回库确认。

写入自动补父目录，所以不需要先 `mkdir`。用户可见的成果物（文档、导出的表格）写根级
`OSFS.write(OSFS.TOP.documents.path + "/x.md", text)`，在访达里立即可见；
`OSFS.mount()` / `reauthorize()` 必须在用户手势里调（非手势上下文 Chrome 直接拒）。

第三方插件的**代码**不在这里：ZIP 安装的插件仍然存 IndexedDB `webstartos-plugins.installed`
并由 `sw.js` 回源，`AppData/<id>/` 只是数据目录。见 [应用商店](app-store.md)。

### 4.2 下拉浮层 `window.__popover`

窗口框是 `overflow:hidden` 的（`.window`，`assets/stylesheets/ui/window.css:17`），面板滚动容器与卡片分组
通常也是（`.ss-panes{overflow-y:auto}`、`.ss-group{overflow:hidden}`，`mods/system-settings/style.css:510`、`:600`）。
**菜单只要是触发按钮的子节点，就一定被这些容器裁在窗口里** —— 把 `z-index` 调大没有用，裁剪与层级是两件事。

`__popover` 的做法是：打开时把菜单节点搬进 `<body>` 上的浮出层（`.os-popover-layer`，`Z.POPOVER` = 9640），
关闭时送回原父级。节点身份不变，所以挂在菜单项上的监听、闭包里的引用全部照用；
`hidden` 属性按**打开前**的样子还原（站内四个菜单都用 `hidden`，你用类名切换就不必管）。

```js
const handle = window.__popover.open({
    anchor: button,          // 触发元素：浮层按它的视口矩形定位（必填）
    content: menuEl,         // 要浮出的节点（必填）
    align: "end",            // "start" | "center" | "end"，水平对齐锚点哪条边；macOS 下拉默认右对齐
    gap: 4,                  // 与锚点的间距 px
    matchWidth: true,        // true 时至少与锚点等宽
    scope: ["myapp", "menu-dropdown"],   // 见下，不传则自动取 anchor.closest(".window") 的根类名
    onDismiss() { /* 关闭时回调（含被自动关闭） */ },
});
handle.close(); handle.refresh(); handle.isOpen(); handle.el;
```

`open()` 之后不需要自己管关闭：点浮层与锚点之外、按 Esc、锚点被移除或隐藏（关窗、最小化、切面板）
都会自动收起；窗口被拖动、缩放、面板滚动时浮层实时跟随（`popover.js:90` 的 rAF 循环）。
**不要再自己挂 `document` 的 click / mousedown 监听去关它**，两套关闭逻辑会互相抢。

`scope` 是唯一需要动脑的参数：菜单搬出窗口后，`.myapp .menu-item` 这类**后代选择器**和
`--myapp-*` 这类**定义在窗口根上的 CSS 变量**都不再命中。浮出层为此放了一个载体节点
（`.os-popover-scope`，`assets/stylesheets/ui/popover.css:30`），把 `scope` 里的类名抄到它身上，
选择器与令牌照旧生效。不传 `scope` 时自动取所属窗口根的类名，多数情况下够用；
菜单项样式挂在更里层的类上（记事本的 `.notepad .menu-dropdown .menu-item`）就要显式补全。
载体自身在 `popover.css` 里被清空成透明盒子，不会带回窗口外观。

两条限制：

1. **别给 `content` 写百分比 `min-width`**。portal 之后包含块成了视口，`min-width:100%` 会按视口宽度算，
   菜单直接撑满整屏。系统设置旧版正是这条（`.ss-menu{min-width:100%}`），已改成 `0` 并由
   `matchWidth` 用内联 px 给等宽（`mods/system-settings/style.css:797`–`:801`）。
2. **盒模型**：如果插件依赖 `.x.window *{box-sizing:border-box}` 这类「窗口内所有后代」的规则，
   portal 之后菜单不在窗口里了，需要为该菜单补一条同等声明
   （系统设置的写法：`.settings .ss-menu, .settings .ss-menu *`，`mods/system-settings/style.css:108`–`:111`）。

已迁移到本接口的四处下拉可作范例：`mods/system-settings/ui.js:248`（`wireDropdown`，七个控件里
`control: "dropdown"` 全走它）、`mods/system-settings/panes/default-apps.js:159`、
`mods/notepad/script.js:366`、`mods/finder/finder-actions.js:209`。
`mods/office/ribbon.js:105` 用的是原生 `<select>`，弹层由浏览器画，本来就不受 DOM 裁剪，无需迁移。

---

## 五、表面：模糊与可读文字

磨砂（亚克力）表面的**模糊值与文字色由系统分配，不由作者挑**：`src/javascripts/surface.js` 把结果写成挂在
`<html>` 上的一组 CSS 自定义属性，样式表只引用不解释。常规路径只有「用令牌」这一条，
`window.__surface`（`surface.js:543`）只用于登记局部表面与自检。

**文字色只有两套**，划分依据是「文字压在哪一层」，没有第三种档位（`surface.js:16`–`:23`、
`REPRESENTATIVE_ALPHA` 的注释 `:63`–`:78`）：`--surface-text*` 是**主题面板档**（菜单、弹层、提示条都不吃墙纸色），
`--surface-text-wallpaper*` 是**墙纸档**（背后就是墙纸的表面，含开着墙纸着色时的侧栏与控制中心）。
被墙纸染深的表面怎么切档是**样式表里的一条配方**，见 5.1 末尾。

**阶梯语义（先看这条再看 API）**：用户的「模糊等级」是设置项 `appearance.blurLevel`（0–4，定义 `surface.js:485`），
等级只决定**一个**基准步长 `--surface-blur-unit`（0/1/2/3/4 档 → unit 0/4/8/12/18px，`BLUR_LEVELS` `surface.js:41`–`:47`）；
每个表面再按自己的**角色**取 `--surface-blur-1..5` = unit × 1 / 1.75 / 2.75 / 4 / 6.5（`ROLE_STEPS` `surface.js:55`，
唯一定义处 `assets/stylesheets/main/main.css:113`–`:119`）。所以用户动一档 = 所有表面**等比**变糊或变清，
没有任何一处样式表需要被再改一遍；反过来，写死一个 px 就等于退出这个体系（代价见 5.4）。
第 5 档不是凑数：启动台展开态原本是 78px，只有四档时要么把它压进第 4 档（明显变薄）、要么和 45px 并档（丢层次），
加一档后两个素材在默认等级下都能原位表达。

### 5.1 令牌（CSS 侧，这是常用路径）

| 令牌 | 一行说明 | 证据（CSS 兜底定义 / JS 运行时写入 `<html>`） |
|------|----------|------|
| `--surface-blur-unit` | 基准步长，等级唯一直接决定的量 | `main.css:113`（兜底 `12px`）/ `surface.js:274` |
| `--surface-blur-1..5` | 五个角色档，越大越糊；侧栏取 `-1`、启动台展开取 `-5` 这类 | `main.css:114`–`:118` / `surface.js:275`–`:277` |
| `--surface-blur` | 「本表面用哪一档」的中间层，缺省 `var(--surface-blur-3)`；换档就覆盖它 | `main.css:119` / `surface.js:278` |
| `--surface-saturate` | 配套饱和度，静态 `1.6`，**不随等级变**（无 JS 写入方） | `main.css:120` |
| `--surface-text`（含 `-rgb` / `-secondary` / `-tertiary`） | **主题面板档**，全局默认，**只可能是 `#000` 或 `#fff`**。判定输入是 `effectiveBase().panel`——「主题面板固有色以 `REPRESENTATIVE_ALPHA`（0.6）压在有效底色上」，因为菜单 / 弹层 / 提示条**不吃墙纸着色**，拿墙纸底色判全局会给浅菜单推出白字 | `main.css:135`–`:138` / `inkTiers()` `surface.js:244`–`:253`、panel 合成 `:190`、写入 `:284`–`:285` |
| `--surface-text-wallpaper`（含 `-rgb` / `-secondary` / `-tertiary`） | **墙纸档**，给「背后就是墙纸」的表面：全屏浮层（启动台、图片预览、锁屏）**以及开着墙纸着色时的侧栏 / 控制中心 / 预览 chip**。共用面板档必然在某个组合下推出错色（浅色主题下黑字压深墙纸） | `main.css:139`–`:142` / `wallpaperBase()` `surface.js:261`–`:266`、写入 `:289`–`:291` |
| `--tint-color` / `--tint-rgb` | 着色表面的颜色入口，是一条回落链：`--tint-adjusted-*` → wallpaper.js 的 `--wallpaper-tint-*` → appearance.js 的 `--window-tint*` → 兜底中性蓝灰 | `main.css:94`、`:95`（链的定义处，CSS 里唯一写死这两条的地方） |
| `--tint-adjusted-rgb` / `--tint-adjusted-color` | 只旋转色相、不掺中性色的墙纸色（掺两次会把表面调成灰糊，浓度交给各表面自己）；CSS 里没有定义行，只在上面那条链的首位被引用。**两支都吃「色调偏移」**：`-rgb` 给 `rgba()`，`-color` 给 `color-mix(… var(--tint-color) …)` | 消费 `main.css:94`–`:95` / 写入 `surface.js:298`–`:300` |
| `--tint-strength` | `appearance.tintStrength`（着色浓度）的实时值，**真生效**：每条着色规则的固有浓度都写成 `calc(<固有浓度> * var(--tint-strength))` | `main.css:96`–`:99` / `surface.js:279` |

```css
.my-panel { backdrop-filter: blur(var(--surface-blur-3)) saturate(var(--surface-saturate)); color: var(--surface-text); }
.my-panel .muted { color: var(--surface-text-secondary); }        /* 弱化也来自同一支，别再抄 #333/#888 */
.my-drawer { --surface-blur: var(--surface-blur-1); }             /* 换档 = 覆盖中间层，仍然不写 px */
.my-overlay-on-wallpaper { color: var(--surface-text-wallpaper); } /* 背景是墙纸（全屏浮层）时用墙纸档 */

/* 表面被墙纸染深时切档：四条属性一起指过来，整棵子树跟着换（配方与例外判据见下面） */
html[data-wallpaper-tint="on"]:not([data-transparency="off"]) .my-sidebar {
    --surface-text: var(--surface-text-wallpaper);
    --surface-text-rgb: var(--surface-text-wallpaper-rgb);
    --surface-text-secondary: var(--surface-text-wallpaper-secondary);
    --surface-text-tertiary: var(--surface-text-wallpaper-tertiary);
}
```

**为什么只有两套，而且全局档不读墙纸**：`--surface-text` 判定的不是「墙纸有多暗」，而是「文字真正压着的那层面板有多暗」。
`surface.js:63`–`:78` 记着这条约束的来历：**旧实现直接拿墙纸底色推全局文字色**，于是「浅色主题 + 开着墙纸着色 + 深色壁纸」
给始终是浅面板色的菜单推出了白字，实测 107 个文字节点里 95 个对比度掉到 3:1 以下。修法是把判定输入换成
`effectiveBase().panel`（`surface.js:190`：`NEUTRAL[theme]` 以 `REPRESENTATIVE_ALPHA` = 0.6 压在有效底色上），
写全局档时用它而不是 `rgb`（`:284`–`:285`）。

**为什么着色表面归进墙纸档、而不是再造第三套**：那些表面的背景是 `rgba(墙纸色, 固有浓度 × --tint-strength)`，
透出来的又是同一支墙纸，合成后仍≈墙纸色（`surface.js:72`–`:74`、`main.css:131`–`:132`）。

**切档是样式表里一条可复制的配方，不是 JS 登记**：自定义属性沿继承树生效，在着色规则里把 `--surface-text` /
`-rgb` / `-secondary` / `-tertiary` 四条指向对应的 `--surface-text-wallpaper*`，整棵子树跟着换档，JS 不用逐个元素登记。

| 证据（真实选择器与行号） | 说明 |
|------|------|
| `assets/stylesheets/ui/window.css:39`–`:44` `html[data-wallpaper-tint="on"]:not([data-transparency="off"]) .window > .left` | 配方原型；注释在 `:35`–`:38`，说明「侧栏被墙纸染深之后文字该按墙纸那一层取」 |
| `assets/stylesheets/ui/controlcenter.css:169`–`:179` `html[data-wallpaper-tint="on"]:not([data-transparency="off"]) .controlcenter` | 写在容器上，靠继承覆盖 `.cc-*` 全部后代 |
| `mods/system-settings/style.css:185`–`:187`（`.settings > .ss-sidebar` 的着色规则 `:180`–`:188`） | 插件侧改的是**自己的** `--ss-text*`；这三条在 `:166`–`:168` 本来指向全局档 |
| `mods/app-store/style.css:163`–`:167`（`.appstore > .as-sidebar`） | 同款取舍，靠 `:not(…)` 收口；全局档在 `:148`–`:150` |
| `mods/system-settings/panes/appearance.js:224`–`:227`（`.ss-appearance__chip`） | 设置面板的预览小样也走这条配方（规则 `:222`–`:228`） |
| `assets/stylesheets/main/main.css:327`–`:331`（`.finder-sidebar`） | 唯一「重指**插件自己的**令牌」的写法，见下面第 2 条 |
| `assets/stylesheets/finderbar/finderbar.css:66`–`:70`、`:99`–`:103`（`.finderbar .left / .right`） | 菜单栏整条就是「背后是壁纸」的表面：文字直接读 `var(--surface-text-wallpaper)`，不需要着色开关参与 |
| `assets/stylesheets/finderbar/finderbar.css:111`–`:117`（`html[data-wallpaper-ink="black"]:not(…) .finderbar …`） | 图片图标不吃自定义属性，只能靠 `<html>` 上的档位属性补一条 `filter: invert(1)`，见下面第 3 条 |

**三个必须认的例外判据**：

1. **用 `:not([data-transparency="off"])` 收口**（`window.css:39`、`controlcenter.css:169`、`app-store/style.css:163`）：
   关掉毛玻璃后表面不再半透明，而是「实色面板 + 掺色」——`.window > .left` 是 `color-mix(… calc(45% * var(--tint-strength)) …)`
   （`main.css:453`–`:455`）、控制中心是 26%（`controlcenter.css:219`–`:221`），**仍以面板为主**，这时读墙纸档反而会白字压浅底。
   `mods/system-settings/style.css` 用的是等价的另一手段：不加 `:not(…)`，靠同特殊度的 `html[data-transparency="off"] .settings > .ss-sidebar`
   （`:196`–`:204`）排在更后来把 `--ss-text*` 换回不透明表面的主题色。
2. **插件 `mods/finder` 特例**：访达把侧栏底色收成插件自己的 `--finder-sidebar-bg`（内核只在 `.finder` 层改写它的值，
   `main.css:319`–`:324`），而它的 `--finder-text*` 在**插件 `:root`** 就已代入全局档（`mods/finder/style.css:24`–`:26`）。
   自定义属性是**按元素算一次**再被后代继承的：`:root` 上算好的值不会跟着后代变，所以内核在 `.finder-sidebar` 这一层
   **重指 `--finder-text*`**（`main.css:327`–`:331`），而不是重指 `--surface-text*`。
   **插件作者要注意同一条机制**：如果你的界面令牌在 `:root` 就指向 `--surface-text*`，切档时必须重指你自己那条令牌，
   在后代上改 `--surface-text*` 救不回已经在 `:root` 代入的值。
3. **单色 SVG 图标不看自定义属性**：`<img>` 里 `fill="white"` 的图标（菜单栏右侧那批，如 `wifi.svg`）颜色写死在文件里，
   换令牌换不动它。墙纸档推出手黑墨的那一刻，`writeTokens()` 会同时在 `<html>` 上落一个档位属性
   `data-wallpaper-ink="black|white"`（`surface.js:291`–`:294`），样式表按它补一条 `filter: invert(1)` 把图标翻过去
   （`finderbar.css:111`–`:117`），并顺手去掉那道为白字准备的深色投影。**这条属性只暴露墙纸档的结论**，
   主题面板档没有对应的属性 —— 需要按面板档翻图标的场合，请改用 CSS 遮罩（`mask-image`）让颜色回到 `currentColor`。

**今天真的在读墙纸档的表面**：内核窗口侧栏、控制中心、系统设置侧栏、应用商店侧栏、预览 chip、访达侧栏、菜单栏
（上面几张表逐条给了行号）。另外两处全屏浮层目前是在自己元素上把局部三档**钉成白**、不引用令牌 ——
启动台 `mods/launchpad/style.css:84`–`:86`（理由写在 `:78`–`:83`，那段说明用的还是「只有一套令牌」时代的口径）、
锁屏遮罩 `src/javascripts/lock.js:47`（写死在 `:53`，注释明确说这是**有意偏离**推导的唯一表面，因为它的底衬
`rgba(18,18,20,.35)` 不随主题变）。钉成白的那一处不会随壁纸明暗重算，**新做的全屏浮层请直接引用
`--surface-text-wallpaper*`**，别再抄第四份白字。

`--surface-text` 为什么不用你挑：`textColorFor()` 在黑与白里取 WCAG 对比度更高的那个、平局偏黑
（`surface.js:232`–`:235`），输入是 `effectiveBase()` 逐层合成的表面背后真实底色 ——
壁纸主色 → 色相偏移（`appearance.tintHue`）→ 着色浓度（`appearance.tintStrength`）→ 明暗主题中性色 →
显示器亮度（夜间护眼再叠一层暖色）（`surface.js:175`–`:199`、中性色表 `:61`、`inkTiers()` 只产出四支同源属性 `:244`–`:253`）。
**屏幕层 `applyScreen()`（`surface.js:208`–`:215`）现在同时作用在墙纸底色和面板底色上**（`rgb` 与 `panel` 都过它，
`:192`–`:193`），`wallpaperBase()` 直接复用它（`:265`）而不再各算一遍；亮度是等效 multiply 的压暗层，
夜间护眼再叠一层暖色（`display.nightShift` / `display.nightShiftIntensity`）。
换壁纸、动着色开关、动等级、切主题、调亮度都会重算（监听清单 `bindSignals()` `surface.js:509`–`:526`），
所以文字色是**推导结果而不是设置项**，作者手写黑白色号在这套表面上迟早会糊成一片。

**`appearance.tintStrength` 是真生效的**：每条着色规则的固有浓度都写成 `calc(<固有浓度> * var(--tint-strength))` ——
窗口外壳 `window.css:28`–`:34`、`color-mix` 掺色 `:46`–`:48`、控制中心 `controlcenter.css:180`–`:203`、
访达侧栏 `main.css:319`–`:324`、系统设置侧栏 `mods/system-settings/style.css:181`–`:182`、
应用商店侧栏 `mods/app-store/style.css:156`–`:159`、预览 chip `mods/system-settings/panes/appearance.js:223`。
**旧状态是只有预览 chip 乘了这个因子**，其余表面没乘，滑块拖了真实界面纹丝不动 —— 正是 5b 节 lint 要拦的缺陷。

| 证据 | 说明 |
|------|------|
| `dev/static-check.mjs:318`–`:354`（**5b 节「墙纸着色的浓度必须真的吃 --tint-strength」**） | 拦两类回退：① 着色浓度没乘 `var(--tint-strength)` → 「『着色浓度』滑块对该表面无效」（`:345`–`:347`）；② 着色表面直接读 `--window-tint-rgb`、绕过色相旋转链 → 应改用 `var(--tint-rgb)`（`:338`–`:340`） |
| `dev/static-check.mjs:351`–`:354` | 打印「墙纸着色浓度 N 处」；一处 `--tint-rgb` / `--tint-color` 用法都没扫到时判为「扫描失效」并报错，不许它假装通过 |
| `assets/stylesheets/main/main.css:94`–`:95` | 颜色来源只准走 `--tint-color` / `--tint-rgb` 这条链；链上新增的 `--tint-adjusted-color`（`surface.js:300`）让 `color-mix(… var(--tint-color) …)` 也吃「色调偏移」，此前只有 `-rgb` 通道吃得到 |

权限：无（纯自定义属性，不必 import 也不必等初始化；`bootstrap.js` 的 `initSurface()` 之前也有 `main.css:113`–`:142` 的兜底值可用）。

**带侧栏的窗口要分成两块表面（访达同款）**：`background: transparent` 写在**窗口根**上，
实色只铺在内容区，边栏用半透明档 —— 根上铺实色等于在边栏背后垫一块平色板，
`backdrop-filter` 就只是在糊自家底板，毛玻璃名存实亡（这正是系统设置与 App Store 之前的状态）。

| 证据 | 说明 |
|------|------|
| `mods/finder/style.css:102`–`:103`（`.finder.window` 根透明）、`:376`–`:382`（`.finder-sidebar` 0.62 + 第 3 档 + `saturate` + `isolation`）、`:498`–`:502`（`.finder-main` 实色） | 参照实现，三件事各归一块 |
| `mods/system-settings/style.css:39`、`:67`（`--ss-sidebar-glass` 0.62 / 深色 0.57）+ `:96`–`:99`（根透明）+ `:158`、`:173`（边栏用 glass）+ `:435`–`:442`（`.ss-content` 实色） | 与访达同浓度同档位；`--ss-sidebar-solid` 只服务 `appearance.transparency` 关掉后的实色档 |
| `mods/app-store/style.css:33`、`:62`、`:90`–`:95`、`:141`、`:153`、`:189`–`:197` | 同款；另外**删掉了根上的 `isolation: isolate`** |
| `assets/stylesheets/main/main.css:442`–`:444` | 关掉毛玻璃时内核给 `.window` 补的是 `--surface-content` **实色底**（不是 isolation），所以根透明的写法在四种组合下都不塌 |

两个坑：① **别在窗口根上写 `isolation: isolate`** —— `isolation` 会把该元素变成 backdrop root，
后代表面能采样的范围就被截进窗口内部，边栏又糊不到壁纸了（给带模糊的元素**自己**加 `isolation` 才是对的，
见 `dock.css` / `window.css` 顶部的亚克力禁忌）；② 根透明后，边栏与内容之间那条 1px 接缝不能用半透明分隔色，
也不能写 `color-mix(分隔色 45%, 内容色)`（alpha 会被一起插值，实测得 0.58，等于留一条露壁纸的发丝缝），
要写成「实色打底 + 分隔色叠一层」：`background: linear-gradient(var(--ss-row-divider), var(--ss-row-divider)), var(--ss-content-bg)`
（`mods/system-settings/style.css:206`–`:214`、`mods/app-store/style.css:178`–`:186`）。

### 5.2 读等级与改等级

| 接口 | 一行说明 | 证据 |
|------|----------|------|
| `__surface.getLevel()` | 当前等级数字；存储值非法时回落 `3` | `surface.js:364` → `currentLevel()` `:161`–`:164` |
| `__surface.setLevel(0..4)` | 写 `appearance.blurLevel`，返回**布尔**（就是 `settings.set().ok`）；越界值被中枢钳制而不是拒绝 | `surface.js:371`–`:373`、钳制 `settings.js:356` → `:158`–`:165` |
| `__surface.levels()` | 5 条 `{value, label, unit}`：关闭/极轻/轻柔/标准/浓重 → 0/4/8/12/18px | `surface.js:361`、表 `:41`–`:47` |
| `__surface.token(role)` | 返回 `var(--surface-blur-N)` 字符串，`role` 钳在 1–5，缺省 3 | `surface.js:380`–`:386` |

```js
__surface.setLevel(2);                 // true = 已写入；等价于 __settings.set("appearance.blurLevel", 2)
const lv = __surface.getLevel();       // 0..4
```

写这条链路是**走设置中枢**的：广播 `settings-changed`（`settings.js:274`）并通知订阅者（`:275`–`:277`），
所以绑在同一键上的界面控件会跟着改选中态（`mods/system-settings/ui.js:97` 的 `bind()`），
系统设置里改、代码里改，两边不会各说各话。等级项定义在 `surface.js:484`–`:490`
（`pane: "appearance"`、`control: "segmented"`），读写请认这个键，别去戳某个具体 DOM。

权限：无。

### 5.3 JS 侧接口（登记局部表面与自检）

不登记也能拿到全局 `--surface-text`（大多数样式表路径就是这条）；下面这些是给「自己底色和全局不一样」的浮层用的。
**被墙纸染深的侧栏不该走这里** —— 那条是样式表配方（5.1），`apply()` 只处理逐元素登记，且它的推导优先级高于两套全局档。

| 接口 | 一行说明 | 证据 |
|------|----------|------|
| `__surface.apply(el, {role})` | 登记为表面：给它写 `--surface-blur: var(--surface-blur-N)` 与**按它自己底色**算的局部四支文字令牌，返回注销函数 | `surface.js:398`–`:409`（局部底色算法 `surfaceBackdrop()` `:328`–`:343`）；站内用例 `spotlight.js:458`、`ui/notification.js:150` |
| `__surface.apply(el, {over:"wallpaper"})` | 告诉系统「这块表面的背景就是墙纸」，推导改走**墙纸档**底色（启动台/预览/锁屏这类） | 入参 `surface.js:392`、落地 `:405`、推导分支 `:303`、`wallpaperBase()` `:261`–`:266` |
| `__surface.apply(el, {blurPx})` | 逃生舱：内联写死 `--surface-blur: <px>` —— 不推荐，见 5.4 | `surface.js:402`–`:404` |
| `__surface.releaseAll()` | 清空登记表（`surfaces.clear()`）；**不撤销已写到元素上的内联样式**，销毁面板时请连内联一起清 | `surface.js:412`–`:414` |
| `__surface.syncText(el)` | 自建深色/浅色浮层时强制按该元素底色补一次文字色（三档同源写入），返回算出的色；元素带 `data-surface-over="wallpaper"` 时改读墙纸档底色 | `surface.js:438`–`:444`（分支 `:440`） |
| `__surface.textColorFor(bg)` | 任意底色该配黑还是白，返回 `"#000"｜"#fff"`；`#rgb`/`#rrggbb`/`rgb(…)`/`[r,g,b]` 都吃 | `surface.js:232`–`:235`、解析 `:90`–`:101` |
| `__surface.effectiveBase()` | 推导输入 `{rgb, panel, tinted, sampled, hue, strength}`。**`panel` 是本次新增的一项**：文字真正压在上面的那层主题面板色（`:190` 合成），全局 `--surface-text` 判定用它而不是 `rgb` | `surface.js:175`–`:199`（`REPRESENTATIVE_ALPHA` 常量 `:79`） |
| `__surface.currentTextColor(scope)` | 读 `<html>` 上当前的文字色令牌，读不到回 `#000`。`scope` **只有两个取值**：`"panel"`（缺省，主题面板档）与 `"wallpaper"`（墙纸档，**开着墙纸着色时的侧栏 / 控制中心也算这一类**） | `surface.js:425`–`:428`（说明 `:419`–`:424`） |
| `__surface.refresh()` | 立即重算并写令牌，不等下一帧（平时由 `scheduleRefresh()` 合帧） | `surface.js:458` → `writeTokens()` `:269`–`:320`、合帧 `:351`–`:357` |
| `__surface.stats()` | 诊断快照 `{level, unit, roles, base, panel, tinted, text, wallpaperBase, wallpaperText, surfaces, contrastWhite, contrastBlack}`。新增 `panel` = 面板档底色；`text` 现在是**面板档**文字色；`contrastWhite` / `contrastBlack` 是对**面板档底色**的对比度，不再是墙纸混合底色 | `surface.js:461`–`:478`（`panel` `:469`、`text` `:471`、两条对比度 `:475`–`:476`） |
| `__surface.subscribe(fn)` | 订阅重算：等级 / 着色 / 主题 / 壁纸 / 亮度 / 夜间护眼任一变化后回调 `fn({base, panel, text, wallpaperBase, wallpaperText, level, tinted})`（快照新增 `panel`），返回退订函数 | `surface.js:451`–`:455`、快照构造与派发 `:308`–`:319` |

```js
const offApply = __surface.apply(panel, { role: 4 });        // 深色浮层：按它自己的底色要文字色
const offWatch = __surface.subscribe(({ text, level }) => repaint(text, level));   // 重算完通知你
```

三档文字色**必须同源**：`inkTiers()`（`surface.js:244`–`:253`，注释说明了理由在 `:237`–`:243`）一次产出正文 / `.70` / `.48` 三支同支色。
早先版本 `apply()` 只写正文色，结果「白主字 + 半透明黑副字」在同一块表面上自相矛盾 ——
所以登记过的表面现在由 `writeTokens()` 统一补齐全套（`surface.js:301`–`:305`）。
两套全局档也是同一个 `inkTiers()` 出的，只是入参不同：面板档吃 `base.panel`（`:285`），墙纸档吃 `wallpaperBase()`（`:289`–`:291`）。

`subscribe` 的派发点刻意放在令牌写完之后（注释见 `surface.js:306`–`:307`），所以回调里读到的
`--surface-text` 与 `level` 已经是新值；回调抛错只记一条 `log.warn`（`surface.js:318`），不会打断重算本身。
触发源是 `writeTokens()`，而它由这些信号驱动：`settings-changed`（`surface.js:515`–`:518`，监听键清单 `:510`–`:514`）、
`wallpaper-tint-change` 与 `wallpaper-change`（`:521`–`:522`）、`appearance-tint-change` / `appearance-theme-change` /
`display-brightness-change`（`:523`–`:525`）。要更细的入参（谁改的、旧值）就订阅设置中枢（`settings.js:537`）。

**换壁纸要等 `wallpaper-tint-change`，不要只等 `wallpaper-change`**：`wallpaper-change` 是在
`applyConfig()` / `saveWallpaperConfig()` 里**先**广播的（`wallpaper.js:273`、`:427`），紧跟着才 fire-and-forget 调
`applyTint()`（`:276`、`:428`）—— 主色是异步解码采样回来的，所以只听前一件事的消费者读到的仍是**上一张**壁纸的颜色。
实测踩过：换到白昼壁纸后 `--surface-text-wallpaper` 停在暗壁纸的 `#fff`，整站文字色慢了一整轮，直到下一次任意设置变更才纠正。
`applyTint()` 现在在四支着色令牌落地之后补发一次 `wallpaper-tint-change`（`wallpaper.js:618`–`:622`），
那才是「颜色真的换了」的唯一可靠信号；surface 侧两个事件都监听（`surface.js:521`–`:522`），重算合帧，不会双跑。

**释放义务照旧**：入口脚本每次打开都重新执行（[冷加载机制](cold-load.md) 硬约束 1），
`apply()` 与 `subscribe()` 返回的注销/退订函数**必须在 `plugin-unload` 里调**，
否则登记的元素连同它捕获的已卸载 DOM 会永久留在 `surfaces` 集合里（`surface.js:82`），
订阅函数同样永久留在 `subscribers` 里（`:83`）：

```js
window.addEventListener("plugin-unload", (e) => {
    if (e.detail?.id !== "myPlugin") return;
    offApply(); offWatch();          // 两个返回值都是释放函数
});
```

权限：无。

### 5.4 逃生舱：确实要一个阶梯表达不了的模糊值

允许两条：元素上覆盖 `--surface-blur`，或 `apply(el, { blurPx })`。**都不推荐**，理由不是审美而是机制：
写死的 px 里不含 `--surface-blur-unit`，而调等级动的只有 unit（`surface.js:274`–`:277`），
于是用户的「模糊等级」对那个表面**静默失效** —— 正是本模块要清掉的那批 8/10/20/30/40/50px 与插件侧的
45/60/78px（`surface.js:4`–`:5`）。代码里给这条路的定性也是直白的：
「逃生舱：直接写像素值。API 不拦，但样式表里就不该再出现裸 px（static-check 会拦）」（`surface.js:401`），
令牌区块则写着「插件想自行调节请覆盖 `--surface-blur`，写裸 px 属于「可以但不推荐」」（`main.css:109`–`:111`）。

```css
/* 先自问是不是角色选错了（-1…-5 里换个更大的往往就够了），再考虑这一行 */
.my-odd-surface { --surface-blur: 26px; }
```

机器门禁是真的：`node dev/static-check.mjs` 里「模糊必须走系统令牌」这一节（`dev/static-check.mjs:268`–`:316`）会
- 扫 `blur(<数字>px)` 字面量（`BLUR_LITERAL` `:275`），除令牌定义行本身（豁免判定 `:297`）与注释行（`:288`–`:290`）外一律报
  「模糊值仍是硬编码字面量，应改用 `var(--surface-blur-N)`」（`:298`）；扫描范围是 `assets/stylesheets/**`、
  `mods/**` 与 `src/**` 的 `.css` 和 `.js`（`:276`–`:278`），JS 里含 `backdropFilter`/`backdrop-filter`/`--surface-blur`/`cssText`
  的行同样在看（`:287`）—— 所以**插件脚本里拼样式串写裸 px 一样会红**；
- CSS 里任何 `backdrop-filter` 有 `blur(` 却没引用 `var(--surface-blur`（`none` 与关闭态除外）就报
  「backdrop-filter 有 blur 但没引用系统令牌」（`:300`–`:309`，这条只判 `.css`）；
- 自检一条：字面量为 0 却**一处令牌引用都没数到**时判定为「扫描失效」并报错（`:312`–`:316`）——
  静默报 0 的检查器比报错的检查器更危险，所以这里不许它假装通过；
- 任一条命中即逐条列出并非 0 退出（`:447`–`:451`），构建直接红。

`blurPx` 是这条 lint 的盲区：它传的是数字，落到元素上成 `--surface-blur: 26px` 内联样式，源码里根本没有
`blur(<px>)` 这段文本，所以命不中 `BLUR_LITERAL`。**但代价一分没少**：用户的等级对它照样无感。

权限：无。

### 5.5 `requires`：只在别的开关打开才有意义的设置项

一行说明：定义里写 `requires: "<依赖键>"`，系统设置的行就会据此自动禁用（加 `ss-row--disabled` 类并把行内
`input, button, select, textarea` 全部 `disabled`），依赖键一变就重算 —— 面板不用写任何判断代码。

| 证据 | 说明 |
|------|------|
| `mods/system-settings/ui.js:122`–`:133` | `wireRequires(root, key)`：读 `settings.info(key).requires`，按 `Boolean(settings.get(dep))` 决定禁用，并 `track(settings.on(dep, apply))` 跟着依赖键变 |
| `mods/system-settings/ui.js:149` | 触发点在 `row({key})` 里 —— 七个**绑定设置**的控件（`controlSwitch:178`、`controlSlider:200`、`controlDropdown:277`、`controlSegmented:321`、`controlRadio:344`、`controlCards:372`、`controlSwatches:398`）都把 `key` 传进 `row()`，所以任何一种都能用 `requires`。`controlText` / `actionRow` / `statusRow` 不绑设置键，自然不参与 |
| `src/javascripts/surface.js:495`、`:502` | 仓内实例：`appearance.tintStrength`（着色浓度）与 `appearance.tintHue`（色调偏移）都写 `requires: "appearance.wallpaper.tint"` |
| `src/javascripts/settings-definitions.js:69` | 被依赖的那个开关（`appearance.wallpaper.tint`，默认 `false`）的 owner 定义 |

```js
__settings.define({
    key: "myPlugin.fade.duration", type: "number", default: 0.3, min: 0, max: 2, step: 0.1,
    owner: "myPlugin", pane: "plugins", label: "淡入时长", control: "slider", requires: "myPlugin.fade.enabled",
});
```

三点要拎清：
1. `requires` 只管**界面禁用**，值照旧可读写 —— 中枢不校验依赖关系（`ui.js:123`–`:124` 只是拿来算禁用态）。
   生效逻辑仍要自己兜住：surface 侧的做法是着色关时根本不掺墙纸色（`surface.js:178`–`:190`），
   于是「滑块没生效」这件事在界面上和逻辑上是一致的（设计说明 `surface.js:24`–`:26`）。
   「着色浓度」还多了一条机器门禁：`dev/static-check.mjs` 的 **5b 节**（`:318`–`:354`）会拦下
   没乘 `var(--tint-strength)` 的着色规则，详见 5.1 末尾那张表。
2. 依赖键必须是**已经 `define` 出来的键**，否则 `Boolean(settings.get(dep))` 走未注册键的宽松通道，
   禁用态就可能和你预期的不一致（未注册键的读法见 `settings.js:330`–`:334`）。
3. 子参数落在 `switch` / `dropdown` / `radio` / `cards` / `swatches` 上时别指望自动禁用（见上表的 `:191`、`:287`、
   `:338`、`:364`、`:392`），自己订阅依赖键处理：`__settings.on("myPlugin.fade.enabled", () => rebuild())`。

权限：无。

---

## 六、调试

### 6.1 在应用内读日志

顶栏「调试 → 查看运行记录」跳到 **系统设置 › 调试**（`debug.js:131`–`:134`）；
同一菜单可清空 / 导出文件 / 复制剪贴板 / 切门槛 / 重载当前插件 / 输出设置表 / 层级体检（`debug.js:447`–`:464`）。
要程序化取用就调 `__log.query()` / `__log.stats()` / `__log.recent()`；
「重载当前插件」（`debug.js:199`–`:224`）等价于关窗再开，用来验证你的 `plugin-unload` 是否真的清干净了。

### 6.2 自检：应用内 vs Node

| 手段 | 跑什么 | 什么时候用 |
|------|--------|-----------|
| `runSelfTest()`（`src/javascripts/debug.js:399`） | 遍历 `settings.list()`（`:400`），逐项「挑一个合法探针值（`:330`–`:345`）写入 → 回读比对 → 查存储槽 → 判 `isDefault` → 还原用户原值」（`:354`–`:391`） | 改完设置项**在真实浏览器存储上**验证；各项会被短暂改成探针值再改回，界面可能闪一下（`general.language` 例外：探针固定用当前值，不会来回切语言，`:45`），随后弹窗报告并可直接跳运行记录（`:417`–`:432`） |
| `node dev/settings-harness.mjs` | 设置中枢 + 日志系统**本身**的行为：槽名推导、on/off、钳制、拒绝、jsonPath、订阅与退订、门槛、留存、缓冲上限 | 动过 `settings.js` / `log.js` 就跑；零依赖、CI 可用 |
| `node dev/settings-fulltest.mjs` | **每一条具体设置项**：默认值合法、落盘文本、读回一致、非法值拒绝/钳制、`reset`、与 owner 历史键逐字一致、`pane`/`control` 与系统设置注册表对得上 | 增删设置项、改 `pane`/`control` 就跑；改一边忘改另一边会直接红 |
| `node dev/static-check.mjs` | 不执行任何模块的**磁盘一致性**检查：`import` 说明符指向的文件在不在、说明符与 `<script src>` 上有没有误挂 `?v=`、代码/HTML 引用的 assets 是否真存在（404）、四个语言包键位齐不齐、`data-i18n` 指向的键是否存在、面板 `paneId` 与插件自带语言包是否和 `registry.js` 对得上、`manifest.json` 声明的文件是否在插件目录里、模糊值是否走系统令牌（`:268`–`:316`，见 §5.4）、**墙纸着色的浓度是否真的乘了 `--tint-strength`**（5b 节 `:318`–`:354`，见 §5.1） | 新增插件、改名或移动资源、动过文案键或改过 `backdrop-filter` / 墙纸着色规则就跑（脚本头注释那份清单只列了 1–6 项，`dev/static-check.mjs:8`–`:13`；两条表面 lint 在正文 `:268`–`:354`） |

三个脚本都不启浏览器：两个断言脚本用最小 DOM 替身（原因见脚本头注释 `dev/settings-harness.mjs:3`–`:10`），
`static-check.mjs` 只读磁盘（`dev/static-check.mjs:4`–`:7`）。
全绿即退出码 0，任何一条失败都会列出条目并非 0 退出（`dev/settings-harness.mjs:207`–`:214`、
`dev/settings-fulltest.mjs:545`–`:552`、`dev/static-check.mjs:447`–`:451`）；断言条数随定义表增长，别把打印出来的数字当契约。

### 6.3 `debug.developerMode` 门控了什么

只门控一件事：**顶栏「调试」菜单是否出现**（`debug.js:81`–`:83` 的 `isDeveloperMode()`，
定义 `debug.js:90`–`:95`，菜单接线 `finderbar.js:24`、`:320`）。
关掉它不会关掉日志系统，也不会停止捕获 —— 门槛、缓冲、留存等由 `debug.logLevel` /
`debug.bufferSize` / `debug.persist` / `debug.captureConsole` / `debug.captureErrors` / `debug.persistCount`
各自控制，这 6 项由 `log.js` 自己注册（`log.js:65`–`:111`），`debug.js` 不重复声明（契约见 `debug.js:12`–`:14`）。

---

## 六、能力入口 `window.Deskly`

唯一**受权限门禁**的一组接口。它是薄壳：每个方法都委托给上文某个现有 owner，
不重新实现能力（`src/javascripts/os-api.js`，权限判定在 `src/javascripts/api-grants.js`）。

三条硬约定，先记住再往下读：

1. **受管方法一律返回信封** `{ok, value?, reason?, permission?}`，**永不抛错**：
   `const r = await Deskly.fs.read("data/a.md"); if (!r.ok) return r.reason;`
2. **调用前要在 `manifest.json` 的 `permissions` 里声明**，没声明＝直接 `ok:false`（不弹窗）。
3. **`fs` 的路径默认相对你自己的 `/AppData/<你的插件id>/`**，越不出这个目录（`osfs.js` 的 `scope(id)`，
   越界由它自己抛错；该文件正被频繁重写，这里按符号名引用而不是行号）。

免权限的只有 `apps.list` / `apps.info` / `bus.*` / `fs.home` / `fs.temp` / `meta.*`
—— 它们是目录、事件与自省，不构成能力。

### 6.1 应用 `Deskly.apps`

| 方法 | 说明 | 所需权限 | 出处 |
|------|------|----------|------|
| `launch(nameOrId, opts?)` | 启动应用，接受 appId / 插件 id / 显示名 | `apps:launch` | `os-api.js:111` → `plugin-manager.js:374` |
| `list()` | 全部可启动应用摘要：`appId/pluginId/name`（中文原名·身份）/`displayName`（当前语言）/`entry` | 无 | `os-api.js:117` → `app-registry.js:172` |
| `info(nameOrId)` | 单条应用记录，查不到返回 `null` | 无 | `os-api.js:126` → `app-registry.js:222` |
| `default.set(key, appId)` | 绑定扩展名/协议 | `default-apps:write`（敏感，首调弹窗） | `os-api.js:94` → `default-apps.js:157` |
| `default.get(key)` | 查当前生效的应用 | `default-apps:read` | `default-apps.js:169` |
| `default.resolve(key)` | 生效值 **+ 来源**（`user`/`system`/`manifest`） | `default-apps:read` | `default-apps.js:128` |
| `default.getAll()` | 仅用户改绑的那部分 | `default-apps:read` | `default-apps.js:174` |
| `default.list()` | 全部可管理类型，界面用 | `default-apps:read` | `default-apps.js:183` |
| `default.reset(key)` / `resetAll()` | 删掉改绑、回到出厂 | `default-apps:write`（敏感） | `default-apps.js:216`、`:228` |

```js
await Deskly.apps.launch("office.word");                 // appId 形式
await Deskly.apps.launch("文稿");                         // 显示名同样接受
await Deskly.apps.default.set(".md", "notepad");          // 键带点
await Deskly.apps.default.set("http:", "my-browser");     // 协议带冒号，第三方也能接管
```

键的写法只认两种：扩展名**带点**（`.md`，写成 `md` 会替你补上）、协议**带冒号**（`http:`）。
默认应用的解析是**三级回退**（`default-apps.js:128`）：用户改绑 → 出厂默认（`SYSTEM_DEFAULTS`，
`default-apps.js:33`）→ 插件在 `apps[].formats` / 根级 `formats` 的声明；三级都没有才返回 `undefined`。
所以「装了能打开 .png 的插件」不需要任何改绑就能被双击命中，而用户的手工改绑永远压过声明。

### 6.2 文件 `Deskly.fs`

委托 `osfs.js`，**不是**第二套文件系统；未挂载真实文件夹时全部落在 IndexedDB 虚拟树里，
挂载后同一批路径写到用户选的那个文件夹（`osfs.js` 的两个后端）。

| 方法 | 说明 | 所需权限 |
|------|------|----------|
| `read(rel)` / `write(rel, data)` / `list(rel?)` | 自己 AppData 内的读写与列目录 | `files:read` / `files:write` |
| `mkdir(rel)` / `remove(rel, opts?)` / `exists(rel)` | 建目录、删除、探测 | 同上 |
| `at(absPath)` / `writeAt(absPath, data)` | `/文档`、`/下载` 这类公开绝对路径 | `files:read` / `files:write` |
| `home()` / `temp(...segs)` | 自己沙箱的绝对路径（免权限） | 无 |
| `type.get(ext)` | 该扩展名归哪个应用（等价 `apps.default.resolve`） | `default-apps:read` |

```js
const dir = Deskly.fs.home();                            // {path,temp,config,data}
await Deskly.fs.write("data/notes.md", "# 标题");         // → /AppData/<你>/data/notes.md
const f = await Deskly.fs.read("data/notes.md");          // File 对象
await Deskly.fs.writeAt("/文档/导出.txt", "hello");        // 越出沙箱：按敏感处理
```

`write` 会**自动补父目录**，不必先 `mkdir`（`osfs.js` 的 `write(path, data)`）。
指向 `/AppData/<别人>` 的路径**无论有没有权限都拒绝**（`os-api.js:82`），这是唯一一条硬边界。

### 6.3 事件 `Deskly.bus`

`on(topic, fn)` 返回**退订函数**，`emit(topic, data)` 同步派发。形状与内核的
`broadcast()`（`app-registry.js:38`）完全一致：`document` + `bubbles:true` + `CustomEvent.detail`。

```js
const off = Deskly.bus.on("default-apps-changed", (detail) => repaint(detail));
Deskly.bus.emit("my-plugin:tick", { n: 1 });              // 插件之间默认走 document
window.addEventListener("plugin-unload", (e) => {
    if (e.detail?.id === "my-plugin") off();              // 必须退订，见下方硬约束
});
```

- 带 `system:` 前缀的 topic 走 `window`，用于对齐内核那批 window 级事件（`dock-size-change` 等）。
- **必须在 `plugin-unload` 里退订**：入口脚本每次打开都重跑一遍而模块表不回收
  （[冷加载机制](cold-load.md) 硬约束 1），订阅函数会连带它捕获的已卸载 DOM 永久累积。
- 内核既有事件在这里都收得到：`settings-changed`、`plugin-registered`、`plugin-unregistered`、
  `plugin-unload`、`plugin-app-load`、`plugin-app-unload`、`default-apps-changed`。
  注意 `appearance.js:100` 派发的是 `appearance-theme-change`，**不是** `theme-change`。

### 6.4 自省 `Deskly.meta`

免权限，用来在运行时对齐文档（`os-api.js:243`）：
`meta.permissions()` 给全部权限名＋中文描述＋是否敏感，`meta.grants()` 给当前插件的账本，
`meta.can("files:write")` 只查账不弹窗，`meta.caller()` 回显识别出的调用者插件 id
（返回 `null` 说明被判成内核调用 —— 排查「为什么我的调用没弹窗」先看这个）。

**语言 API**（`os-api.js` 的 `meta`，包装内核 `i18n.js`，免权限）：

| 方法 | 说明 |
|------|------|
| `meta.language()` | 当前界面语言代号（`zh-CN`/`en`/`ja-JP`/`cat`），插件据此本地化自己的文案 |
| `meta.languages()` | `[{code,label}]` 支持列表，画语言选择器用 |
| `meta.onLanguageChange(fn)` | 订阅语言切换（回调收到新代号），返回**退订函数**——须在 `plugin-unload` 里调用 |
| `meta.appName(nameOrId)` | 把应用身份串（appId / 插件 id / 中文原名）翻成当前语言显示名；查不到原样返回 |

```js
const lang = Deskly.meta.language();                 // "en"
const offLang = Deskly.meta.onLanguageChange((l) => rerender(l));
window.addEventListener("plugin-unload", () => offLang());
```

> 应用显示名由内核统一管：`app-registry.listApps()` 每条记录带 `name`（中文原名·跨语言不变的身份，
> 被 window DOM id / `appStatus` / dock `img.alt` / 已持久化的 dock 顺序与启动台布局当键用）与
> `displayName`（`i18n.t("apps.<appId>", name)`）。dock / 启动台 / 访达菜单栏 / 聚焦 / 商店都显示
> `displayName`，`zh` 词条须与 `manifest.name` 逐字一致；`apps.<id>` 缺失就回落原名——**内核绝不
> 替第三方插件改名**。给新应用加显示名：往四份 `assets/locales/*.json` 的顶层 `apps` 里补 `apps.<id>`
> 即可（多应用套件走 `apps.<id>.name` + `apps.<id>.<子应用>`）。身份串永远不要翻译。

### 6.5 还没实现的部分

以下分组**已占位但返回 `{ok:false, reason:"未实现（改造提示词 N）"}`**，别照着
`底层API改造分段提示词.md` 写代码，那文档描述的是目标态：

| 分组 | 状态 | 出处 |
|------|------|------|
| `Deskly.widgets.*` | 未实现（提示词 4） | `os-api.js:216` |
| `Deskly.windows.style.set` / `applyTheme` | 未实现（提示词 5） | `os-api.js:224` |
| `Deskly.icons.set` | 未实现（提示词 6） | `os-api.js:231` |
| `Deskly.system.patch.*` | 未实现（提示词 7） | `os-api.js:234` |

提示词 7 落地前，改顶栏与菜单仍走既有的**登记式**接口：`registerFinderbarIcon()`
（`finderbar.js:819`，需在 `plugin-unload` 里 `unregisterFinderbarIcon()`，卸载不会自动摘）
与 `window.__menuActions`（`finderbar.js:1243`，加的键必须自己 `delete`）。

---

## 相关文档

- [插件包格式](plugin-format.md)
- [插件开发指南](plugin-development.md)
- [架构总览](architecture.md)
- [冷加载机制](cold-load.md)
- [层级表](z-layers.md)
