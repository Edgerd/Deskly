# Deskly 开发文档

> 基于 macOS Sequoia 视觉风格的浏览器主页插件（Chrome MV3 新标签页），采用 **插件化架构** 组织应用。
> 本文档是开发者的第一站：了解架构、插件格式、开发流程与冷加载机制。

---

## 目录

| 文档 | 说明 |
|------|------|
| [架构总览](architecture.md) | 系统分层、模块职责、运行模型（同文档注入，非 iframe） |
| [系统 API 参考](os-api.md) | 插件侧接口：`window.__settings` / `window.__log` / 多语言 / 表面令牌 / 既有全局 / 调试 |
| [插件包格式](plugin-format.md) | `manifest.json` 字段（含哪些字段真被读取）与插件目录固定结构 |
| [插件开发指南](plugin-development.md) | 从零开发一个插件，含示例与常见问题 |
| [冷加载机制](cold-load.md) | 启动注册清单、点击才加载内容的原理与缓存语义 |
| [应用商店](app-store.md) | 应用商店界面、分类真实语义、ZIP 安装与发布流程 |
| [层级表](z-layers.md) | 全站唯一 z-index 层级表 `Z`（`src/javascripts/zindex.js`） |

---

## 快速上手

1. 阅读 [插件包格式](plugin-format.md) 了解插件目录结构。
2. 复制最小完整骨架 `mods/about/` 作为模板，改名为 `mods/你的插件id/`（要看有计算逻辑的插件怎么拆：`mods/calculator/`）。
3. 按 [插件开发指南](plugin-development.md) 编写 `manifest.json` + `index.html` + `style.css` + `script.js` + `icon.png`。
4. 要用系统能力（设置项、日志、多语言、弹窗、通知、层级）时查 [系统 API 参考](os-api.md)。
5. 将目录打包为 ZIP 拖入 [应用商店](app-store.md) 即可安装。
6. 使用 [冷加载机制](cold-load.md) 了解按需加载原理。

---

## 编程规范

- 每个插件一个自包含目录，位于 `mods/{id}/`。
- 插件 id 使用小写蛇形命名（如 `vs_code`、`system-settings`）。
- 一个功能一个文件，不在单文件内堆叠多个独立模块。
- **可执行代码里的资源路径一律走 `src/javascripts/paths.js`**，不要在各处再拼 `./assets/…`、`./mods/<id>/…` 字符串。
  只有两类例外必须保留字面量：ES module 的 `import` / 动态 `import()` 说明符，以及 CSS 里的 `url()`
  —— 它们相对**文件自身**解析，而运行时 URL（`<img src>`、`fetch()`、`Notification.icon`）相对**文档**解析，
  所以插件里同样用站点根相对写法（`./assets/…`），不需要 `../../`。
- 所有类、方法、模块需编写中文 docstring 注释。
- **文件路径只有一个来源**：根下的顶层目录取 `OSFS.TOP`（`src/javascripts/osfs.js`），插件私有数据走
  `OSFS.scope(id)`（`/AppData/<id>/{temp,config,data}`）。不要在界面或插件里写 `"/文档"`、`"/桌面/x.md"`
  这类字面量，也不要再造「虚拟目录层」—— 内核的树已能存目录行。
- **设置读写只走 `window.__settings`**（`src/javascripts/settings.js:602`），**日志只走 `window.__log`**
  或已被自动归档的 `console.*`（`src/javascripts/log.js:580`）：不要再往 `localStorage` 里手写第三个键，
  也不要再 `console.log` 一条没人能回看的记录。冷启动要同步读的值**不要搬到文件里**，
  `AppData/<id>/config/` 只放插件主动写出的副本/导出。接口清单与元数据字段见 [系统 API 参考](os-api.md)。
- **API 能力门禁只有一个入口**：`window.Deskly`（`src/javascripts/os-api.js`）的受管方法都用
  `guard("权限名", 实现)` 包着，权限名与中文描述一律取自 `src/javascripts/api-grants.js:29` 的
  `PERMISSION_NAMES`。不要在 `Deskly` 之外再造一层「插件能力接口」，也不要在内核方法体里手写
  `if (callerIsAllowed…)` —— 那会绕过账本，弹窗与「未声明即拒绝」两条约定当场失效。
  新增一条能力 = 补 `PERMISSION_NAMES` + 补 `PERMISSION_LABELS` + 用 `guard()` 包，
  `node dev/static-check.mjs` 第 7 节会核对三方是否对齐。
- **模糊值也只有一个来源**：`backdrop-filter` 一律写 `var(--surface-blur-1..5)`、磨砂上的文字一律写
  `var(--surface-text)`，不要手写 `blur(<px>)` —— 等级由系统统一分配（`src/javascripts/surface.js:273`–`:280`），
  裸 px 会被 `node dev/static-check.mjs` 判为失败（`dev/static-check.mjs:275`、`:298`），且让用户设的
  「模糊等级」对那个表面静默失效。令牌与接口见 [系统 API 参考](os-api.md) §五。
- **文字色只有两套令牌，按「文字压在哪一层」划分**：`--surface-text*` 是**主题面板档**（判定输入是
  `effectiveBase().panel`，菜单 / 弹层 / 提示条都不吃墙纸着色），`--surface-text-wallpaper*` 是**墙纸档**
  （背后就是墙纸的表面：全屏浮层，以及开着墙纸着色时的侧栏 / 控制中心 / 预览 chip）。切档**不是 JS 登记而是样式表里
  一条可复制的配方**：在 `html[data-wallpaper-tint="on"]` 的规则里把四条 `--surface-text*` 指向 `--surface-text-wallpaper*`
  （`assets/stylesheets/ui/window.css:39`–`:44`、`assets/stylesheets/ui/controlcenter.css:169`–`:179`），自定义属性沿继承树生效。
- **带侧栏的窗口分两块表面**：窗口根 `background: transparent`、实色只铺内容区、边栏用半透明档做真毛玻璃
  （`mods/finder/style.css:102`–`:103` 是参照，`mods/system-settings/style.css:96`–`:99`、`mods/app-store/style.css:90`–`:95` 已同款）。
  根上铺实色等于在边栏背后垫平色板，`backdrop-filter` 只是糊自家底板；同时**别在窗口根写 `isolation: isolate`**
  （它把根变成 backdrop root，采样范围被截进窗口内部）。细则与两个坑见 [系统 API 参考](os-api.md) §5.1 末。
- **着色浓度也必须真的乘上**：每条墙纸着色规则的固有浓度写成 `calc(<固有浓度> * var(--tint-strength))`，颜色只走
  `var(--tint-rgb)` / `var(--tint-color)` 那条链（`assets/stylesheets/main/main.css:94`–`:95`）。没乘因子或绕过链直接读
  `--window-tint-rgb` 都由 `dev/static-check.mjs` 的 5b 节拦下（`:318`–`:354`）—— 旧状态只有预览 chip 乘了这个因子，
  于是「着色浓度」滑块拖着真实界面不动。配方与三个例外判据见 [系统 API 参考](os-api.md) §5.1。
- **设置文案按苹果口径写**：标题是 ≤12 显示单位的名词短语（一串拉丁字母算一个词，"Night Shift 强度" 合法），
  提示行默认不写 —— 只在「不写会造成不可逆后果或明显误解」时留一句 ≤18 单位、不含实现词
  （系统 / 令牌 / 像素 / 静态检查 / 面板 / 卡片 / 归档 / 事件 / 槽 / console / 插件 …）的话；
  整段的 `note()` 只留给空态与风险句。页内骨架只有 `group(rows, { title })` 与 `section(key, 兜底, box)` 两种
  （同一个构造，见 `mods/system-settings/ui.js:100`–`:115`），不再有 `.ss-heading` 第二套标题。
  违反其中任何一条由 `dev/static-check.mjs` 第 8 节拦下；页名唯一来源是 `mods/system-settings/registry.js`
  的 LABELS，面板与外壳都不许再自带一份 `ss.pane.*`（曾因此漂成「存储 / 本地存储」两个名字）。
- 无构建步骤：源码即产物，纯 ES Module，浏览器直接执行（`index.html` 以 `<script type="module">` 加载入口）。
- 遵循代码整洁原则，避免冗余注释。

## 版本与更新

`src/javascripts/version.js` 导出的 `VERSION` 是版本号的唯一来源，且确实被使用：
`bootstrap.js:43`、`plugin-manager.js:16`（清单与资源缓存戳）、`session.js:12`（锁屏/会话文案）、
`mods/about/script.js:11`（关于本机显示的版本）。`bootstrap.js:160`–`:166` 在启动时拉 `manifest.json`
比对 `VERSION`，不一致打 `[bootstrap] 版本漂移` 警告。

### 缓存戳规则（重要）

`?v=` **只允许用在非模块资源上**（CSS / HTML / JSON / 图片）。
所有 **JS 模块 URL 与 `import` 说明符一律不带 `?v=`**：带串与不带串在浏览器眼里是两个不同模块，
会让同一份核心代码被求值两次，产生两份 `dock.js` / `window.js` / `finderbar.js` 实例互相覆盖全局钩子
——这是历史上一系列「功能静默失效」的根因，注释固化在 `bootstrap.js:17`–`:20`、
`finderbar.js:466`、`dock.js:965`。

现状：`index.html:71`–`:80` 与 `:82` 的模块脚本一律不带查询串（`:81` 的 JSZip 是普通脚本，同样不带），
只有 CSS（`index.html:9`–`:21`）保留 `?v=<版本>`。

### 版本更新仪式

1. 改 `src/javascripts/version.js` 的 `VERSION`。
2. 同步 `manifest.json` 的 `version` / `version_name` 与 `version.py`。
3. 更新 `index.html` 里 CSS 的 `?v=` 串（仅非模块资源）。
4. 每次代码更新必须同步编写 `产品更新信息.md`。

- 正式功能更新按 `0.01` 步长升小版本号。
- 预发布版本仅递增 `Alpha/Beta/RC` 标识，到 9 进位升级小版本。

### 菜单命令

菜单项的 `cmd` 不是可求值的 JS 代码。分发是**注册表查表**：`ui/menuCommands.js:22`，
合法形态只有 `name` 或 `name('arg')`（`:15`），实现挂在 `window.__menuActions`（`finderbar.js:1242`，
`debug.js:488`–`:490` 演示了往同一张表里合并命令）。
MV3 扩展页 CSP 为 `script-src 'self'`，`new Function` / `eval` 被拒（`ui/menuCommands.js:4`），
旧的「字符串交给 `new Function` 执行」写法在打包环境里会静默失败，不要再写回去。
