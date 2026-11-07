# 01 · Bug 审查报告

> 审查时点：2026-11-04/05 · 基线版本 0.3.10（version.js / index.html 缓存戳；manifest.json 停 0.3.9，见 02 报告 CON-01）
> 审查方式：只读。未修改项目任何文件；未执行 git 写操作；未启动浏览器，全部为静态代码走查 + 项目自带 Node 校验脚本结论（见 05 报告 §4）。
> 并发声明：`mods/office/` 在审查时点可能正被其他任务改写（manifest.json mtime 2026-11-04 21:21、view-excel.js mtime 2026-11-04 21:17），涉及 office 的条目（BUG-66、BUG-67、BUG-70、BUG-73）均需在该任务结束后复核；`devdocs/` 已于 2026-11-04 重写完毕，本报告未对其做 Bug 审查（文档归 02 报告对照）。
> 去重声明：与 05 报告 GEN-01~GEN-10 不重复；与本组 02 报告（矛盾性）不重复编号。

---

## 1. 审查范围与覆盖文件清单

全量逐文件清单见 [00-文件清单与覆盖矩阵.md](./00-文件清单与覆盖矩阵.md)（264 个代码/配置文件，149,529 行）。本报告覆盖其中全部「B（Bug 审查）」列标记 ✓ 的文件，逐文件归属结论见 §5 覆盖归属表：

| 归属 | 范围 | 文件数 |
|------|------|-------:|
| 内核 JS | `src/javascripts/**`（含 dock/、ui/、wm/ 子目录，64 文件） | 64 |
| 内核入口 | `index.html`、`manifest.json`、`sw.js` | 3 |
| 内核样式 | `assets/stylesheets/**`（scss 源 + css 产物，27 文件） | 27 |
| 内置 mod | `mods/*` 13 个插件全部自有文件（不含 vendor） | 121 |
| 开发工具 | `dev/*.mjs`、`dev/*.py` | 12 |
| 豁免 | `assets/locales/*`（纯数据，键位齐整性由 static-check 机械校验 + 02 报告矛盾审查）、第三方依赖（仅核完整性） | — |

## 2. 审查方法与判断依据

1. 逐行通读：全部目标文件由 6 路并行审查流逐行读完（大文件分段），每路输出问题清单后由本报告统一合并、重编号、复核证据。
2. 交叉验证：对存疑条目回读原文件核对行号与上下文；对照宿主 API（os-api.js / vfs.js / osfs.js）验证插件侧调用签名。
3. 机械校验：直接采用 05 报告 §4 实测结论（static-check / deep-check / store-check / calc 三件套 / osfs / genie / settings 两套断言全部通过），本轮未重复执行。
4. 判断依据：仅收录「代码中可直接指证、能给出可操作复现条件」的问题；推测性、风格性条目不收。
5. 严重级别定义：致命=数据丢失/安全边界击穿/核心功能完全不可用；高=功能错误或有明确用户可感知损害；中=状态不一致/边界条件失效/泄漏累积；低=边缘场景或暂无症状的隐患。

## 3. 问题清单

### 3.1 窗口 / Dock / 桌面 / UI 组件（BUG-01 ~ BUG-15）

---

**BUG-01** ｜ 高 ｜ 修复状态：已修复
- 位置：`src/javascripts/finderbar.js:1041-1048`
- 证据：
```js
const curApp = (document.querySelectorAll(".finderbar .left p")[1] || {}).innerHTML;
const nomatch = subMenu.getAttribute("nomatchapp");
if (curApp && curApp !== subApp) { if (!nomatch) return; }
```
- 问题：`curApp` 取顶栏应用名段落的 `innerHTML`，该文本是 `displayNameFor(app)` 的**译后显示名**；而子菜单 `app` 属性写的是中文身份键（"访达"）。同文件 795-798、880-882 注释承认「标签已翻译，不能当键用」，此处却恰恰拿译文当键比对。
- 复现：语言切到 English → 任意内置应用的「File/Edit」等顶层菜单点击无任何反应（绑定被 return 跳过）。
- 影响：非中文语言下整个下拉菜单系统瘫痪，只能靠 Dock/红绿灯操作。
- 修复：改读 `document.querySelector("#finderbar p.appname")?.dataset.appKey` 与子菜单 app 属性比对。
- 验证：切到 English，点击「File」应弹出子菜单。

---

**BUG-02** ｜ 高 ｜ 修复状态：待协调
- 位置：`src/javascripts/desktop.js:268-297`（叠加 `src/javascripts/dock.js:896-932`）
- 证据：
```js
document.addEventListener("drop", (event) => {
    event.preventDefault(); event.stopPropagation();
    const items = event.dataTransfer && event.dataTransfer.items; ...
```
- 问题：document 级 `drop`/`dragover` 监听没有落点限定。Dock 图标的 drop 处理器（`bindDropOpen`）只 `preventDefault` 不 `stopPropagation`，事件继续冒泡到 document → 同一批文件再被 desktop 处理一遍。
- 复现：把 OS 文件拖到 Dock 废纸篓图标上 → 文件既进 /废纸篓，又在桌面生成图标并写入 /桌面；拖到任意应用窗口内容上同样会在桌面落一份图标。
- 影响：文件被双写、桌面图标幽灵增生，任何插件自己的 drop 区都会被桌面劫持。
- 修复：desktop 的 drop/dragover 处理器先判定 `e.target` 落在桌面/壁纸区域（与 contextmenu 处理器同一套判据），否则直接 return。
- 验证：拖文件到废纸篓图标，桌面不应新增图标，`/桌面` 目录不应新增记录。

---

**BUG-03** ｜ 中 ｜ 修复状态：已修复
- 位置：`src/javascripts/finderbar.js:728-733`
- 证据：
```js
p.addEventListener("click", (e) => {
    e.stopPropagation();
    dispatchMenuCommand(item.cmd);
});
```
- 问题：动态子菜单项点击后 `stopPropagation` 挡住 document 级 `closeAllMenus`（1079 行），自身也不关菜单。静态菜单项走 `ui/menu.js clickMenuItem`（先 closeAllMenus 再执行），两条路径行为不一致。
- 复现：访达「前往 → 下载」等不触发菜单重建的命令（finderNewFolder、finderGoToFolder、finderViewMode）执行完后下拉菜单悬留不收。
- 影响：菜单残留盖住内容，需再点空白才关。
- 修复：点击处理器开头加 `closeAllMenus()`（先关再 dispatch）。
- 验证：执行「前往文件夹...」后下拉菜单应收起。

---

**BUG-04** ｜ 中 ｜ 修复状态：已修复
- 位置：`src/javascripts/controlcenter.js:634-641`（源头 601 行 mousedown）
- 证据：
```js
if (!persist) {
    state[path] = value;
    else if (value > 0.01 && state.volumeMuted) state.volumeMuted = false;
    return;
}
if (key === "volume" && value > 0.01 && state.volumeMuted) {
    commitToSettings("sound.muted", "volumeMuted", false);
}
```
- 问题：拖动过程中（persist=false）已把内存态 `state.volumeMuted` 置 false；到 mouseup 的 persist 分支时条件恒为 false，`commitToSettings("sound.muted", false)` 永远执行不到。
- 复现：静音状态下拖动音量滑块 → 面板显示有声，但设置中枢与 menubar-status 读的 `sound.muted` 仍是 true（菜单栏喇叭仍划线、sound.js 仍按静音输出）。
- 影响：控制中心与菜单栏/声音模块状态永久分叉，刷新后回到静音。
- 修复：persist 分支改读设置中枢当前值判断是否需要解静音，或拖动分支只记标记位不直写。
- 验证：静音下拖音量后查 localStorage 的 sound 槽，muted 应为 false。

---

**BUG-05** ｜ 中 ｜ 修复状态：已修复
- 位置：`src/javascripts/dock.js:1869-1872`
- 证据：
```js
stack.style.left = (dockPosition === "left" ? rect.right + 12
    : dockPosition === "right" ? rect.left - stackW - 12 : left) + "px";
stack.style.bottom = (window.innerHeight - rect.top + 12) + "px";
```
- 问题：`bottom` 三种 Dock 位置都按「图标上方 12px」算，只对底部 Dock 成立。侧边 Dock 时堆栈向上生长，顶部图标的弹栈顶边为负，被视口裁掉，且无钳制。
- 复现：Dock 放左侧/右侧，点顶部区域的「下载」图标 → 堆栈上半截在屏幕外。
- 影响：侧边 Dock 下堆栈不可用。
- 修复：侧边 Dock 改用 `top` 定位并夹进视口（`Math.max(10, Math.min(rect.top, innerHeight - stackH - 10))`）。
- 验证：左/右 Dock 下展开下载栈，内容完整可见。

---

**BUG-06** ｜ 中 ｜ 修复状态：已修复
- 位置：`src/javascripts/menubar-status.js:72-104, 152-166`
- 证据：
```js
navigator.getBattery().then((bat) => {
    bat.addEventListener("levelchange", paint);
    bat.addEventListener("chargingchange", paint); ...×4
```
- 问题：`refreshBattery` 在每次 `bRec.apply()` 时重跑（settings-changed、plugins-ready、languagechange 都触发）。BatteryManager 是页面级单例，每次叠加 4 个新 paint 闭包，旧监听从不移除。
- 复现：切几次语言或改几次设置后，一次 levelchange 触发 N 次重复 paint/写 title。
- 影响：监听器随会话操作线性增长，重复 DOM 写。
- 修复：getBattery Promise 缓存一次，paint 监听只注册一次（模块级标记）。
- 验证：连续切语言 5 次后确认 paint 只执行一次。

---

**BUG-07** ｜ 中 ｜ 修复状态：已修复
- 位置：`src/javascripts/trash.js:147-161`
- 证据：
```js
await OSFS.remove(e.path, { recursive: true }).catch(() => { });
await OSFS.remove(e.path + TRASH_ORIGIN_SUFFIX).catch(() => { });
removed++;
...
dispatchChanged(false);
```
- 问题：① 每条 remove 的失败被吞且仍计入 `removed`；② 收尾恒 `dispatchChanged(false)`（detail.empty 永远 = false），与同文件 putBack 的 `dispatchChanged(await isTrashNotEmpty())`（117 行）自相矛盾。
- 复现：清倒废纸篓后，信任 `detail.empty` 的消费方仍认为非空；某条 remove 真实失败时事件与返回值都谎报「已清空」。
- 影响：废纸篓满/空态可能错误（Dock 目前重查所以侥幸正确，访达等其它 trash-changed 消费方会被误导）。
- 修复：收集每条成败，`dispatchChanged(await isTrashNotEmpty())`，`removed` 只计真实成功条数。
- 验证：清倒后监听 trash-changed 的 detail.empty 应为 true。

---

**BUG-08** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/ui/notification.js:144, 179-189`
- 证据：`el.style.cssText = \`...top:${TOP_OFFSET + visible.size * ITEM_HEIGHT}px;...\``
- 问题：堆叠 top 只在创建时按 `visible.size` 计算；中间通知关闭后其余通知不回填位置，新通知按新 size 定位，可能与残留通知重叠。
- 复现：快速触发 3 条通知，点掉最上面一条，再触发一条 → 两条重叠。
- 影响：通知互相遮挡。
- 修复：close 后重排剩余通知 top（或维护空位栈）。
- 验证：按上述步骤观察无重叠。

---

**BUG-09** ｜ 低 ｜ 修复状态：待协调
- 位置：`src/javascripts/desktop.js:47-54`
- 证据：
```js
nameEl.addEventListener("blur", commit, { once: true });
nameEl.addEventListener("keydown", function onKey(e) { ... });
```
- 问题：keydown 监听只在按 Enter 时 `removeEventListener`；点击外部走 blur 提交时该监听残留并闭包钉住 oldName 等。多次重命名同一图标会叠加多份，之后某次按 Enter 旧监听全部触发。
- 复现：对同一图标「重命名→点空白提交」重复 5 次，再重命名按 Enter，旧闭包全部执行。
- 影响：监听器/闭包缓慢累积，行为重复执行。
- 修复：commit 内一并 `removeEventListener("keydown", onKey)`（onKey 命名提升）。
- 验证：重复改名后 Enter 只触发一次提交。

---

**BUG-10** ｜ 低 ｜ 修复状态：待协调
- 位置：`src/javascripts/window-manager.js:369-374`
- 证据：
```js
if (g.z !== undefined && ...) {
    el.style.zIndex = String(g.z);
    zCounter = Math.max(zCounter, parseInt(g.z, 10) || 0);
}
const rec = records.get(el);
if (rec && !rec.mode) rec.normal = frameOf(el);
```
- 问题：① 直写 zIndex 与栈序层级（commitStack）双轨并行，调用方可把窗口抬到 WINDOW_Z_MAX 之上或造成两窗同层，直到下一次 commitStack 才纠正；② `!rec.mode` 只排除拖动/缩放，对 zoomed/tiled 窗口调 setGeometry 会把「用户框架」rec.normal 覆盖成缩放框，取消缩放后回不去。
- 复现：窗口缩放态下经 `setWindowPosition`（会话恢复/插件调用）写入几何 → 再点绿键还原，窗口仍停在缩放框。
- 影响：层级瞬时错乱 + 状态窗口还原目标被毁。
- 修复：z 写入走 pushStack+commitStack；normal 仅在 `!rec.zoomed && !rec.tiled && !rec.fullscreen` 时更新。
- 验证：缩放态调 setWindowPosition 后 toggleZoom 能回到原位置。

---

**BUG-11** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/window.js:124-128, 180-225`
- 证据：
```js
const existing = findAppWindow(name, plugin ? plugin.id : "");
if (existing) { wm.bringToFront(existing, name); return; }
...
response.text().then((content) => { ... })   // 未 return、未 catch
```
- 问题：①「查重→fetch→注入」非原子：两次快速调用（慢盘下 fetch 窗口期）都通过查重，注入两扇同 id 窗口；② 内层 `response.text().then` 未链回外层 catch，text() 拒绝或注入回调抛错成未处理拒绝，且 dock 侧 `appStatus[name]=true`/指示灯无复位路径（插件路径才有 resetOpening）。
- 复现：弱网/慢盘下连点同一旧式应用；或 fetch 响应体读取中途失败。
- 影响：重复窗口 /「有小圆点没界面」残留（需下次窗口对账才自愈）。
- 修复：入口加 per-name 进行中标记；内层 then 链 return 并在外层 catch 里复位 appStatus/指示灯。
- 验证：throttle 网络后双击打开只出现一扇窗口；断网时指示灯熄灭。

---

**BUG-12** ｜ 低 ｜ 修复状态：待协调
- 位置：`src/javascripts/wm/genie-capture.js:124-130`
- 证据：
```js
const img = new Image();
img.src = URL.createObjectURL(blob);
await img.decode();
return img;
```
- 问题：无 `createImageBitmap` 的回退路径创建的 blob URL 全程不 `revokeObjectURL`，每次原生截图裁剪泄漏一个整页截图大小的 blob。
- 复现：在不支持 createImageBitmap 的环境反复最小化/预热窗口。
- 影响：内存随最小化次数线性增长（仅回退路径）。
- 修复：`finally { URL.revokeObjectURL(img.src) }`（在 drawImage 完成之后）。
- 验证：老浏览器连续最小化 20 次，blob URL 数不增长。

---

**BUG-13** ｜ 低 ｜ 修复状态：部分修复
- 位置：`src/javascripts/controlcenter.js:842-845`；`src/javascripts/datetime_popover.js:356-358`
- 证据：
```js
requestAnimationFrame(() => {
    overlayEl.classList.add("visible");
    panelEl.classList.add("visible");
});
```
- 问题：两处「rAF 里加显示类」都不可取消。同帧内 show→hide（如时钟快速双击、setMenuBarIconVisible(false) 紧随 show）后，rAF 仍把 visible/open 加回 → 面板可见而内部状态认为已关，点击行为反转。
- 复现：程序化或极速连点控制中心图标/时钟。
- 影响：面板卡在「显示但状态为关」的错位态。
- 修复：rAF 回调前再判一次意图标记（showToken），hide/close 时使 token 失效。
- 验证：同帧 show+hide 后面板保持隐藏。

---

**BUG-14** ｜ 低 ｜ 修复状态：待协调
- 位置：`src/javascripts/window-manager.js:1265-1266`
- 证据：
```js
menu.addEventListener("mouseleave", () => setTimeout(close, 160));
setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
```
- 问题：mouseleave 的 160ms 关闭定时器不跟踪、不取消：指针在 160ms 内重新移回菜单，菜单仍被关掉（macOS 悬停面板可移回保持）。
- 复现：悬停绿键出排列菜单 → 指针滑出又迅速滑回（<160ms）→ 菜单照样消失。
- 影响：悬停菜单手感抖动，难把指针移进菜单。
- 修复：记录 timer，menu 的 mouseenter 里 clearTimeout。
- 验证：滑出滑回后菜单仍在。

---

**BUG-15** ｜ 低 ｜ 修复状态：待协调
- 位置：`src/javascripts/wm/genie-effect.js:127-147`
- 证据：
```js
const box = el.getBoundingClientRect();
const model = buildGenieModel(rect, gatherOf(iconEl, side), side);
const snap = await snapshotFor(el, rect);   // 等待期间几何可变
```
- 问题：model 在快照 await 之前按旧 rect 构建；快照等待期间用户拖动/缩放窗口（未禁用交互），动画仍从旧矩形起播，shouldAbort 只看 `_minimized`，不管几何变化。
- 复现：点最小化后立刻拖动窗口（原生截图慢时窗口期更明显）→ 动画起点与窗口实际位置错位。
- 影响：短时视觉错位（动画播完即自愈）。
- 修复：await 后重读 getBoundingClientRect，差异超阈值则重建 model 或走淡出兜底。
- 验证：慢速快照条件下拖动中窗口最小化无错位动画。

---

### 3.2 插件系统 / 权限 / 存储（BUG-16 ~ BUG-32）

---

**BUG-16** ｜ 高 ｜ 修复状态：已修复
- 位置：`src/javascripts/plugin-manager.js:742-774`（`ensureShell`），触发点 632-647（`loadApp`/`doLoadApp`）
- 证据：
```js
async function ensureShell(id, manifest, stamp) {
    if (liveShells.has(id)) return;
    await ensurePluginStyle(...);            // ← 挂起点，无 in-flight 锁
    const old = document.querySelector(`script[plugin="${id}"]`);
    if (old) old.remove();
```
- 问题：`appLoading` 只按 appId 去重，外壳注入无互斥。同一套件两个子应用首次并发打开（会话恢复、快速连点 office.word / office.excel）时，两个 ensureShell 都通过 `liveShells.has` 检查后交错执行：B 会把 A 尚在加载中的 `<script>` remove 掉——被移除的未加载脚本既不 fire load 也不 fire error，A 的 `await new Promise` **永不结算**，`appLoading` 留下永久 pending 的 Promise，该子应用此后再也打不开；若 A 已加载完，则两个不同 URL 的模块各求值一次，全局监听挂双份。
- 复现：`Promise.all([loadApp("office.word"), loadApp("office.excel")])`（在 ensurePluginStyle 挂起点有延迟时必现）。
- 影响：多应用套件并发首开死锁或逻辑重复执行。
- 修复：ensureShell 按插件 id 缓存 in-flight Promise（`shellLoading: Map<id,Promise>`），第二调用方复用。
- 验证：插桩延迟 style await 后并发首开两个子应用，A 的 Promise 不悬挂、`script[plugin]` 只求值一次。

---

**BUG-17** ｜ 高 ｜ 修复状态：已修复（其他会话）
- 位置：`src/javascripts/os-api.js:231-235`（`bus.emit` 免权限）+ `api-grants.js:496-504` + `default-apps.js:304-307` + `app-registry.js:102-104`
- 证据：
```js
emit(topic, data) {
    (onWindow ? window : document).dispatchEvent(new CustomEvent(type, { detail: data, bubbles: true }));
}
```
- 问题：内核把授权记账挂在 document 的 `plugin-registered`/`plugin-unregistered` 事件上，而 `Deskly.bus.emit` 是免权限的，发出的 CustomEvent 与内核 broadcast() 形状完全相同。任意插件可 `Deskly.bus.emit("plugin-registered", {id:"自己", permissions:["files:read","apps:launch",...]})`——所有非敏感权限被 grantAll 直接激活，绕过安装确认；也可 emit("plugin-unregistered") 清掉他人授权账本与默认应用绑定。`event.isTrusted` 无法区分（内核自己也是合成事件）。
- 复现：任意插件控制台执行上述 emit，然后 `Deskly.meta.can("files:read")` 返回 true。
- 影响：同意/记账机制被同一条事件总线正面击穿（非敏感权限自我授予 + 对他人授权的 DoS）。
- 修复：生命周期通知不走开放 DOM 总线——app-registry 提供注册式钩子（模块导出），api-grants/default-apps 改挂钩子。
- 验证：插件 emit 伪造事件后权限不应变化。

---

**BUG-18** ｜ 高 ｜ 修复状态：已修复（其他会话）
- 位置：`src/javascripts/caller-context.js:65-72`（`withCaller` 导出）+ `api-grants.js:194-198`（ambient 优先）+ `os-api.js:221`
- 证据：
```js
export function withCaller(pluginId, fn) {
    const prev = ambient;
    ambient = pluginId || null;
```
- 问题：`resolveCaller()` 顺序是「ambient → 栈解析」，而 withCaller 是普通命名导出。插件与内核同 realm，可直接 `import { withCaller } from "../../src/javascripts/caller-context.js"`，然后 `withCaller("victim", () => Deskly.fs.write(...))`——文件写进受害者 AppData，权限扣在受害者账上。api-grants.js:187-190 注释删掉 `window.__currentPluginId` 时明确拒绝过「身份冒用」，但同一个洞以导出 API 形式留着。
- 影响：调用者归属机制整体失效，授权账本记错对象。
- 修复：withCaller 取消导出（bus.on/settings.subscribe 改闭包引用）；文档承认 ambient 只能作为提示；根治需栈解析失败即拒绝 + 订阅时绑定归属 token 化。
- 验证：插件脚本内 import 包裹调用后 `Deskly.meta.caller()` 不应返回被冒用的 id。

---

**BUG-19** ｜ 高 ｜ 修复状态：已修复
- 位置：`src/javascripts/default-apps.js:311-314`、`src/javascripts/os-api.js:371`、`src/javascripts/osfs.js:1047`
- 证据：
```js
globalThis.__defaultApps = { ..., set, reset, resetAll, removeApp, ... };
globalThis.__desklyApi = { root, guard, getApp, openApp };
globalThis.__osfs = OSFS;
```
- 问题：api-grants 特意把 `__grants` 收窄为只读（注释明言防止自我提权），但这三处把**写能力**挂到全局：`__defaultApps.set("http:", "evil")` 绕过敏感权限 `default-apps:write` 的运行时弹窗；`__desklyApi.openApp(...)` 绕过 `apps:launch`；`__osfs.write(...)` 绕过 `files:write` 弹窗。
- 复现：控制台 `__defaultApps.set("http:", "notepad")` 后 `resolve("http:").source === "user"`，全程无弹窗。
- 影响：敏感权限的运行时确认被一行全局调用跳过。
- 修复：全局只挂只读诊断面（对照 `__grants`），写入口只保留模块导出。
- 验证：全局调用写入口后授权账本/弹窗应照常拦截。

---

**BUG-20** ｜ 高 ｜ 修复状态：已修复（其他会话）
- 位置：`src/javascripts/os-api.js:92-98`（`assertNotOtherScope`），调用点 176-186（`fs.at`/`fs.writeAt`）
- 证据：
```js
const m = /^\/AppData\/([^/]+)/.exec(absPath);
if (m && m[1] !== (caller || KERNEL_SCOPE)) { throw ... }
```
- 问题：正则大小写敏感、不剥尾点尾空格，而 osfs.js:36-47 自己的注释承认 Windows/APFS 大小写不敏感、尾点尾空格等价。磁盘后端下，插件持 `files:read`（非敏感，安装即激活）调 `Deskly.fs.at("/appdata/受害者/data/秘密")` 或 `/AppData./受害者/...`：正则不命中 → 放行 → FileSystemHandle 按大小写不敏感命中受害者真实目录。另：`/AppData` 根路径本身不匹配该正则，任何插件可列出全部插件 scope 名。
- 复现：挂载磁盘后端后，插件 A 写 `/AppData/a/data/x`，插件 B 用 `/appdata/a/data/x` 读出同一份内容。
- 影响：磁盘挂载（Windows 主平台）下跨插件读/写他人 AppData，沙箱边界被路径拼写绕过。
- 修复：比较前对路径做与 topKey 同规则的归一（小写 + 去尾点尾空格）再匹配；`/AppData` 根拒绝列出。
- 验证：归一化拼写变体访问应被拒绝。

---

**BUG-21** ｜ 中 ｜ 修复状态：待协调
- 位置：`src/javascripts/osfs.js:697`（`move` 自包含检查）+ 665-681（`diskMove`）+ 653-659（`diskCopyTree`）
- 证据：`if (dst === src || dst.startsWith(\`${src}/\`)) throw new Error("不能把目录移进它自己");`
- 问题：检查按原始大小写比较，磁盘后端所在文件系统（Windows/macOS）大小写不敏感。`move("/Foo", "/foo/bar")`：检查放行 → 在 `/Foo` 内建 `bar` → `diskCopyTree("/Foo", "/Foo/bar")` 列举 `/Foo` 时已含 `bar` → 递归把 bar 复制进 bar/bar……直至路径长度上限，UI 线程长期占用、留下深层垃圾嵌套。
- 复现：挂载磁盘后端，建 `/Foo`，执行 `OSFS.move("/Foo", "/foo/bar")`。
- 影响：一次大小写不同的「移入自身」即可造成失控递归。
- 修复：自包含判断改用与 topKey 一致的小写归一比较。
- 验证：上述调用应立即抛错而非递归。

---

**BUG-22** ｜ 中 ｜ 修复状态：已修复
- 位置：`src/javascripts/plugin-manager.js:443-458`（init 索引分支）+ 1070-1094（`_writeInstalledIndex` 失败仅告警）
- 证据：
```js
const indexed = _readInstalledIndex();
const installedPromise = indexed ? null : _getAllInstalled()...
```
- 问题：只要 localStorage 索引存在（可解析的非 null 对象）就完全跳过 IndexedDB 回退。但索引写失败只 `console.warn`：安装时 IDB 落库成功、索引写失败（配额/隐私模式）后，索引里没有该插件——下次启动走索引分支，插件静默从注册表消失（IDB 里其实有完整数据）。空对象 `{}` 也 truthy，同样吞掉回退。
- 复现：安装任一 ZIP 插件后在 DevTools 把 `deskly.installed.plugins` 改成 `{}`，刷新——插件消失。
- 影响：ZIP 插件「装了重启就没」，且无任何报错指向原因。
- 修复：索引与 IDB 廉价对账（记录 count 或逐 id 校验），不一致时回退 `_getAllInstalled()` 补写索引；或索引写失败时删除索引键强制全量回退。
- 验证：按复现步骤插件应仍从 IDB 恢复。

---

**BUG-23** ｜ 中 ｜ 修复状态：已修复
- 位置：`src/javascripts/plugin-manager.js:1124-1137`（`unregisterInstalledPlugin`）+ `src/javascripts/store-api.js:448-458`（`uninstall`）
- 证据：
```js
try { await _tx("readwrite", (store) => store.delete(id)); removed = true; }
catch (err) { console.warn(...); }
if (removed) _updateInstalledIndex(id, null);
await notifyInstalledChanged();
return unregisterPlugin(id);
```
- 问题：IDB 删除失败时（removed=false，索引也不摘）仍 `unregisterPlugin(id)` 并返回 true，商店据此提示卸载成功；但库与索引都还在，下次启动完整「复活」。失败路径的返回值对调用方撒谎。
- 复现：DevTools 占用/锁住 `webstartos-plugins` 库使 delete 失败，卸载插件，刷新后重新出现。
- 影响：卸载看似成功、重启复现。
- 修复：removed===false 时返回 false 并保留注册表条目（或返回值区分「仅内存摘除」）。
- 验证：删除失败时商店提示卸载失败。

---

**BUG-24** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/plugin-manager.js:1124-1137` + `src/javascripts/store-api.js:448-458`
- 问题：uninstall/unregisterInstalledPlugin 只摘注册表与持久层，不关闭运行中实例：打开的该插件窗口、样式、`script[plugin]` 全部残留，窗口内逻辑还能跑，但资源已被 SW 404。同 id 立刻重装时残留旧窗口触发 doLoadApp 的复用分支，出现「新版已装、界面还是旧版」。
- 复现：打开某 ZIP 插件窗口，商店里卸载它——窗口仍在且可操作。
- 修复：卸载前先 `unload(id)`（关窗 + 拆样式脚本）再走持久化删除。
- 验证：卸载后窗口应关闭。

---

**BUG-25** ｜ 低 ｜ 修复状态：已修复（其他会话）
- 位置：`src/javascripts/default-apps.js:139-149`（`resolve`）对照 `src/javascripts/app-registry.js:433-450`（`getAppByExtension`）
- 问题：`getAppByExtension` 对解析器命中显式做了 `isPluginEnabled` 检查，但 `resolve` 三级回退链全程不查启用态：绑定指向已禁用插件时，`Deskly.apps.default.get/resolve`、系统设置面板仍显示该应用，双击打开走到 load() 才被拦下并静默返回 null。两处同源逻辑给出两种答案。
- 复现：把 `.md` 绑到某插件后禁用它，`__defaultApps.resolve(".md").appId` 仍是它，而 `getAppByExtension("md")` 已跳过。
- 修复：resolve 三级命中后统一过 `isPluginEnabled`，未启用则继续下一级。
- 验证：禁用后 resolve 应落到下一级或 null。

---

**BUG-26** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/os-api.js:129-133`（`apps.launch`）
- 问题：`openApp → load/loadApp` 对「插件被禁用」返回 `Promise.resolve(null)` 且不抛错，guard 包装后信封是 `{ok:true, value:null}`——插件侧 `if (!r.ok) return;` 惯用写法会认为启动成功。与文件头承诺的「被拒绝时 ok:false 带中文原因」不一致。
- 复现：禁用 safari 后从另一插件 `Deskly.apps.launch("safari")`，返回 `ok:true`。
- 修复：handler 内检查返回值，为 null 时抛「应用被禁用或未注册」。
- 验证：上述调用返回 `ok:false`。

---

**BUG-27** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/plugin-manager.js:898`（doLoad 脚本 error 分支）+ 617-619（load 补发分支）
- 证据：`script.addEventListener("error", () => revealOpen(newWin), { once: true });`
- 问题：① 入口脚本加载失败时只把窗口显示出来——裸窗口无逻辑、`announceFile` 不发，用户双击的文件静默丢失；② `load()` 装载期第二次带文件打开的 `loadingMap.get(id).then(...)` 未挂 `.catch`，首次装载失败时产生 unhandledrejection，第二次的文件同样无声丢失。
- 复现：断网或改名插件 script.js 后双击关联文件打开：窗口出现但文件事件不到达，控制台未处理拒绝。
- 修复：error 分支补 announceFile 或广播 `plugin-app-error`；`.then` 链补 `.catch(()=>{})`。
- 验证：失败时有无拒绝噪音、有错误提示。

---

**BUG-28** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/os-api.js:269-281`（`windows.configure`）
- 问题：文档声称字符串 target 可为「应用显示名」，实现只有 `getElementById`。窗口 id 是中文原名，本地化显示名与它不同——插件按文档传显示名必然得到「找不到该窗口」。API 声明与实现不一致。
- 复现：英文语言下插件传本地化应用名调用 configure，返回 `ok:false`。
- 修复：字符串入参先过 `resolveAppRecord` 取 windowName 再 getElementById，或收窄文档。
- 验证：传显示名应能命中窗口。

---

**BUG-29** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/permissions.js:287-292`（`resetAll` 结果判定）
- 证据：
```js
result.databases = deletes;
result.ok = result.keptKeys.length === 0;
```
- 问题：`ok` 只看 localStorage 残留，`deleteDatabase` 失败（onblocked/onerror 都 resolve 成 `{deleted:false}`）不影响 ok。隐私面板据此可向用户报告「已清空」而 `webstartos-vfs` 等库实际还在。
- 复现：另一标签页占住 `webstartos-vfs` 连接使 deleteDatabase blocked，执行 resetAll，返回值 `ok:true` 且 databases 里有 `deleted:false`。
- 修复：`ok` 加上 `deletes.every(d => d.deleted)`。
- 验证：blocked 场景 resetAll 返回 ok:false。

---

**BUG-30** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/plugin-manager.js:1173-1180`（`_tx`）对照 `src/javascripts/api-grants.js:124-132`（`runTx`）
- 问题：`_tx` 缺 `tx.onabort`。事务被 abort 而非 error 时（如 onversionchange 里 db.close() 掐断在飞事务），Promise 既不 resolve 也不 reject——安装/卸载链永久悬挂。api-grants 的同款函数有 onabort，本文件是四处读写方里唯一漏的。
- 修复：补 `tx.onabort = () => reject(tx.error || new Error("事务被中止"))`。
- 验证：安装过程中触发版本变更令事务 abort，installZip 的 await 能以失败返回。

---

**BUG-31** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/store-api.js:343-430`（`installZip` 无并发互斥）
- 问题：同一 id 两次并发 installZip（双击确认、两个入口同时触发）都通过 existed 检查，各自解包、各弹一次权限清单、互相覆盖落库、写两条历史；中途一次失败触发的回滚会把另一次刚装好的记录一并删掉。无 per-id in-flight 锁。
- 修复：模块级 `installing: Map<id, Promise>`，同 id 复用/拒绝并发。
- 验证：对同一 zip 连续触发两次 installZip，无双记录、无误删。

---

**BUG-32** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/plugin-manager.js:759, 764, 768, 886, 889`（`window.__currentPluginId` 残留写入）
- 问题：全仓 grep 确认该全局已无任何读方（api-grants.js:187 注释明确删除、os-api.js:168 注释明确不读）。它仍是插件可自由读写的全局，ensureShell 与 doLoad 并发注入时相互覆盖——现无消费者所以无实际危害，但属「已废弃却仍维护」的死通道，任何未来代码误读它就立刻引入身份冒用。
- 修复：删除全部 5 处写/清语句。
- 验证：全仓搜索 `__currentPluginId` 应零命中。

---

### 3.3 基础设施（设置/外观/壁纸/i18n/锁屏/声音等，BUG-33 ~ BUG-47）

---

**BUG-33** ｜ 中 ｜ 修复状态：已修复
- 位置：`src/javascripts/settings.js:503-512`
- 证据：
```js
removeSlot(slot);
invalidateSlot(slot);
const previous = settings.get(key);   // 槽已删，这里读到的一定是 default
```
- 问题：注释声称「先失效再读 previous」，但槽删除后 get() 只回退默认值，`apply(..., { previous })` 与事件里的 previous 永远是 default 而非恢复前的真实旧值。
- 复现：设 `dock.size=80` → `settings.reset("dock.size")` → 订阅回调里 `detail.previous` 是 50 而非 80。
- 影响：依赖 previous 的撤销/同步逻辑拿到错误数据。
- 修复：把 `const previous = settings.get(key)` 挪到 removeSlot 之前。
- 验证：reset 后事件 detail.previous === 80。

---

**BUG-34** ｜ 中 ｜ 修复状态：已修复
- 位置：`src/javascripts/settings.js:619-645`（snapshot/restore）
- 问题：snapshot() 对 `webstartos_controlcenter` 这类共享槽导出整个 JSON blob；restore() 按槽名只匹配第一个定义（defs.forEach 找到即停），再 `decode(hit.key, hit, raw)`——raw 是整段容器 JSON，对 boolean/number 类型的 jsonPath 定义必然解码失败回退默认值，然后 settings.set 把这个默认值写回容器。结果：音量/亮度/专注模式等全部 jsonPath 设置恢复后只剩一个字段被写成默认值，其余字段实际值丢失。
- 复现：改音量 → snapshot → 改亮度/静音 → restore → 音量等被重置为默认且只有首个字段被处理。
- 影响：备份/恢复功能对控制中心、声音共约十余项设置实质失效且有破坏性。
- 修复：restore 按「槽→该槽全部 jsonPath 定义」分组，逐字段 readPath 解码后写回；或 snapshot 按 key 导出子字段。
- 验证：修改 `sound.master` 与 `display.brightness` 后往返 snapshot/restore，两者均还原。

---

**BUG-35** ｜ 中 ｜ 修复状态：已修复
- 位置：`src/javascripts/appearance.js:108-110`
- 证据：`if (localStorage.getItem(LS.highlight) === "accent") applyHighlight("accent");`
- 问题：`appearance-highlight` 默认值是 `"accent"` 但从不落盘，所以 getItem 对默认用户返回 null，条件不成立 → 改强调色时 `--highlight` 停留在旧色。只有用户曾显式把高亮设为「主题色」才正常。
- 复现：全新档案 → 设置中把强调色从 multicolor 改为 purple → `--highlight` 仍是 `#0a82ff`。
- 影响：默认配置下界面高亮色与强调色永久不一致。
- 修复：条件改为 `(localStorage.getItem(LS.highlight) || "accent") === "accent"`。
- 验证：默认状态 setAccent("purple") 后 `--highlight` 应为 `#8a358b`。

---

**BUG-36** ｜ 中 ｜ 修复状态：已修复
- 位置：`src/javascripts/debug.js:329-344, 398-434`；联动 `src/javascripts/wallpaper.js:430-464`
- 问题：设置自检 `probeValueFor` 对 boolean 取 `!current`。`wallpaper.autoBing=false` 时探针为 true → apply → setAutoBing(true) → applyDailyBing()：发起 Bing 网络请求；若成功则 setWallpaper + 写 `wallpaper-config` 槽。自检的「还原」走 `settings.set("wallpaper.config", before)`，但该定义没有 apply，不会重画壁纸——屏幕上已是 Bing 图，存储里却是旧配置。
- 复现：关闭「Bing 每日墙纸」状态下运行 调试→运行设置自检（联网）→ 桌面壁纸被换成 Bing，刷新后才回来。
- 影响：诊断操作未经同意改变用户可视状态并产生网络流量；当天壁纸记账被消耗。
- 修复：把 `wallpaper.autoBing` 加入 SELFTEST_QUIET_KEYS（或对有网络/视觉副作用的 apply 统一静默）。
- 验证：自检前后 wallpaper-config 槽与屏幕壁纸均不变，无 Bing 请求。

---

**BUG-37** ｜ 高 ｜ 修复状态：已修复（其他会话）
- 位置：`src/javascripts/keyboard.js:153-163`、`src/javascripts/spotlight.js:841`（onHotkey）、`src/javascripts/lock.js`（无门控）
- 问题：keyboard.js 在 document 捕获阶段直接分发 forceQuit（⌘⌥Esc）、hideActiveApp（⌘H）、openAppByName('系统设置')（⌘,）；spotlight 热键（⌘Space/F4）同样不查锁屏状态。lock.js 只在自身遮罩上挂监听，不拦截。锁屏（含已设口令）下按 ⌘⌥Esc 可调出强制退出并关闭全部窗口，按 ⌘, 打开系统设置。
- 复现：菜单→锁定屏幕 → 按 ⌘⌥Esc → 强制退出对话框出现，确认后全部应用在锁屏后被杀。
- 影响：锁屏安全语义被绕过，口令闸门形同虚设。
- 修复：keyboard.js/spotlight 分发前检查 `window.__lock?.isLocked?.()`；或 lock 遮罩捕获阶段对非解锁键 stopPropagation。
- 验证：锁定后按各全局快捷键，无命令分发、无聚焦面板打开。

---

**BUG-38** ｜ 中 ｜ 修复状态：已修复
- 位置：`src/javascripts/i18n.js:262-277`；`src/javascripts/settings-definitions.js:106`
- 问题：`setLanguage` 在 `await loadLocale(lang)` **之前**就写 currentLang、syncDocumentLang()、persistLanguage()；fetch 失败时 Promise reject。定义表 apply 是 `i18n.setLanguage(value)` 浮动调用（无 .catch）→ unhandledrejection；且失败后不回滚：当前语言已切、存储已写、字典没有 → 全界面 t() 落到 fallback 文本。
- 复现：断网（或 locales 文件 404）后切换语言 → 控制台未处理拒绝，界面只剩兜底文案。
- 影响：语言功能在弱网/资源缺失下进入半损坏状态，且持久化了不可用的语言。
- 修复：setLanguage 内 try/catch，失败时回滚 currentLang/持久化；apply 侧补 .catch。
- 验证：mock fetch 失败后 setLanguage("en") 无未处理拒绝、getLanguage() 不变。

---

**BUG-39** ｜ 中 ｜ 修复状态：已修复
- 位置：`src/javascripts/wallpaper.js:637-653`（applyTint）+ 501-513（getDominantColor 缓存只对同 URL 去重）
- 问题：applyTint 是 fire-and-forget async，去重只在同一 URL 的 Promise 上。快速连续切换壁纸 A→B 时，若 A 的采样后于 B 完成，A 的结果最后落笔，`--wallpaper-tint-*`/`--window-tint*` 写成旧壁纸的颜色，直到下次换壁纸才纠正。
- 复现：系统壁纸列表快速连点两张图，着色令牌与当前壁纸不符。
- 影响：窗口/控制中心着色与壁纸错位。
- 修复：applyTint 加单调递增 token，落地前比对最新一次调用。
- 验证：连续触发两次不同 URL 的 applyTint，慢者先完成后令牌为后发起者之色。

---

**BUG-40** ｜ 中 ｜ 修复状态：已修复
- 位置：`src/javascripts/bootstrap.js:215-223`
- 证据：
```js
initPlugins();
const i18nPromise = Promise.resolve(i18n.init(i18n.getLanguage()));
await Promise.all([pluginsReady(), i18nPromise]);
whenIdle(() => startOptionalModules(defined));
```
- 问题：initPlugins() 同步抛错会让后面的 i18n 初始化直接跳过（整页无翻译）；pluginsReady() 若 reject，`await` 之后的 whenIdle 不再执行 → 声音/显示器/锁屏/聚焦/调试/滚动条六个可选内核模块永远不被点亮，整个 IIFE 以未处理拒绝收场。注释声称「任何一份没到位都不能把整个桌面带崩」，但动态 import 只保护了模块加载，没保护这条串行门槛。
- 复现：让插件清单 fetch 失败且 plugin-manager ready Promise 拒绝 → 锁屏看门狗、⌘Space 聚焦均不可用。
- 影响：单个非关键子系统故障级联成多个内核功能静默缺失。
- 修复：Promise.allSettled 或给 pluginsReady 单独 .catch 记日志后继续；initPlugins() 包 try。
- 验证：注入 pluginsReady 拒绝，可选模块照常初始化且只有一条告警。

---

**BUG-41** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/lock.js:405-411`（rerenderIfLocked）与 469-475（clockTimer）
- 问题：lockNow 的 setInterval 闭包固定引用首次 buildOverlay() 的 refs.clock/date。rerenderIfLocked()（锁屏中改「解锁需要密码」或改口令时触发）replaceWith 换新遮罩后，interval 仍每秒往旧元素写文本——屏幕上的时钟不再更新。
- 复现：锁定状态下经 `__lock.setPassword(...)` 触发重渲染 → 时钟冻结。
- 修复：interval 内改读 state.refs，或 rerender 时重启时钟计时器。
- 验证：触发 rerenderIfLocked 后等 61 秒，界面时钟文本变化。

---

**BUG-42** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/appearance.js:46-52, 148-155`；`src/javascripts/contextMenuSettings.js:39`；`src/javascripts/cursor.js:88, 93, 447`
- 问题：多处直接 localStorage 读写未兜底（getScrollbars 每次滚动都调；contextmenu 每事件都读；clearCursorImage 的 removeItem 无 try）。存储访问本身抛 SecurityError 的环境（禁用 Cookie/存储的嵌入上下文）会把异常抛进滚动/右键/指针事件处理器；settings.js 已为此做了内存替身，owner 模块却绕过它。
- 复现：`Object.defineProperty(window,'localStorage',{get(){throw new Error()}})` 后滚动页面/右键 → 事件处理器抛错。
- 修复：统一改走 settings.get（这些键均已注册）或本地 try/catch。
- 验证：阻断 localStorage 后无未捕获异常，设置按默认值生效。

---

**BUG-43** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/sound.js:87-97, 185`
- 证据：`document.addEventListener("play", (event) => applyVolume(event.target), true);` + `el.muted = isMuted()`
- 问题：任何 audio/video 起播或主音量变动时，元素 muted 被强制改写成全局 `sound.muted`——全局未静音时，应用自己设为静音的媒体（视频插件内点过静音键）会被解除静音。
- 复现：全局静音关；某插件视频元素 muted=true → 触发播放或调一次音量 → 视频出声。
- 修复：只在全局静音开启时置 muted=true，关闭时不主动改媒体自身 muted。
- 验证：元素 muted=true、全局未静音时 applyVolume(el) 后 el.muted 仍 true。

---

**BUG-44** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/session.js:83-105`
- 证据：
```js
const existing = document.getElementById(OVERLAY_ID);
if (existing) existing.remove();   // 只摘元素，旧 finish/onInput 仍挂在 window 上
```
- 问题：showSessionOverlay 第二次调用只移除旧 DOM，不移除旧 `window.addEventListener("keydown", onInput, true)`。泄漏的监听在下一次任意按键时仍执行旧 onDismiss（对 sleep 即再次 delegateToLock("sleep")）。delegateToLock 里 `getElementById(OVERLAY_ID)?.remove()` 同样绕过 finish。
- 复现：控制台连续调两次 `__menuActions.sleep()`（中间不按键）→ 按任意键 → 锁屏逻辑执行两次。
- 修复：复用旧遮罩或移除前调用其 finish；模块内保存当前 finish 句柄统一清理。
- 验证：连续两次 showSessionOverlay 后按键一次，onDismiss 只执行一次。

---

**BUG-45** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/office-brand.js:44, 108-122`
- 问题：探测结果缓存在 sessionStorage（同标签页刷新后仍在），注释却承诺「补齐后刷新即生效」。首次探测失败后放入图标文件，同标签页刷新仍命中旧缓存 → 继续用 iWork 图标。
- 复现：选 ms 包（图标缺失）→ 探测缓存 false → 补上 PNG → 同标签页刷新 → 图标不变。
- 修复：换 localStorage 并带版本/时间戳失效，或失败后不写缓存。
- 验证：补图标后刷新同标签页，brandIcon("office.word") 返回 MS 图标路径。

---

**BUG-46** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/wallpaper.js:276-282, 59, 443-448`（三处合并）
- 问题：
  - a) `setWallpaper`：`` `url("${url}")` `` 未转义，含 `"` 的自定义网络壁纸 URL 使整条声明失效（静默不生效）。
  - b) `dominantCache`：以完整 data-URL（上传壁纸可达数 MB 字符串）为 Map 键且从不清理 → 会话级内存只增不减。
  - c) `applyDailyBing`：跨标签页无锁——两个标签页同一天先后通过日期检查会各拉一次 Bing（第二次浪费请求并覆盖第一次的记账/壁纸）。
- 修复：a) 用 JSON.stringify 包裹 URL（同 wallpaper-boot.js:46 的做法）；b) 缓存限定容量/仅非 data URL 缓存；c) 拉取前先把日期槽写成「进行中」标记或加 navigator.locks。
- 验证：a) 含引号 URL 后计算样式 backgroundImage 生效；b) 多次 upload 后 dominantCache.size 有界；c) 双标签页同日只发一次请求。

---

**BUG-47** ｜ 低 ｜ 修复状态：已修复
- 位置：`src/javascripts/i18n.js:262-277`
- 问题：setLanguage 同步改 currentLang 后 await loadLocale。连续 setLanguage("en") → setLanguage("ja-JP") 时，若 en 的包后下载完，它最后派发 `languagechange(detail:{lang:"en"})` 并 applyTranslations()——事件 detail 是 en，而 currentLang 已是 ja-JP（且 ja-JP 字典可能未就绪，本轮翻译落到 fallback）。
- 复现：脚本连续触发两次 setLanguage，人为延迟第一个语言包响应。
- 影响：onChange 订阅者按错误语言重建界面；短暂整页兜底文案。
- 修复：setLanguage 加序号/取消令牌，只有最后一次调用派发事件与刷新。
- 验证：并发两次切换后，最后一次 languagechange 的 detail.lang === getLanguage()。

---

### 3.4 index.html / manifest.json / sw.js / 样式（BUG-48 ~ BUG-57）

---

**BUG-48** ｜ 中 ｜ 修复状态：已修复
- 位置：`src/javascripts/wm/genie-capture.js:89, 107`；`manifest.json:12-17`
- 证据：
```js
tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
    const err = globalThis.chrome.runtime && globalThis.chrome.runtime.lastError;
    if (err || !dataUrl) { markNativeOff(); ... }
```
```json
"permissions": ["bookmarks"],
```
- 问题：Chrome 平台要求 `tabs.captureVisibleTab` 必须有 `activeTab` 或 `<all_urls>` 权限，manifest 只声明了 bookmarks + 三个 wallpaper host_permissions。原生截图路径第一次调用即收到 lastError，`markNativeOff()` 永久关断，60 秒冷却后重试再失败。
- 复现：扩展安装后打开任意窗口并最小化，控制台可观察到权限错误。
- 影响：Genie 快照永远走不到设计的第一优先级（浏览器合成截图），恒定降级为 snapdom——更慢、低保真，且预热在 idle 期消耗主线程。功能不崩（有兜底），原生路径是死代码。
- 修复：manifest.json permissions 增加 `"activeTab"`。
- 验证：新标签页控制台执行 `chrome.tabs.captureVisibleTab(null,{format:"png"},r=>console.log(chrome.runtime.lastError))`，修复前 lastError 非空，修复后返回 dataURL。

---

**BUG-49** ｜ 低 ｜ 修复状态：已修复（其他会话）
- 位置：`src/javascripts/bootstrap.js:254-275`（runVersionCheck）；`index.html:27-41`（15 处 `?v=` 样式表缓存戳）
- 问题：runVersionCheck 注释声称「manifest.json / version.js / index.html 的版本号在发布时必须一致」，但实现只比对 manifest 与 version.js，index.html 的缓存参数恰是该注释点名「历史上多次漂移」的位置，却永远不被校验。审查时点的实际漂移方向是 manifest.json（详见 02 报告 CON-01），正说明这条自检护栏缺口会持续漏放此类漂移。
- 影响：扩展页资源本地加载，`?v=` 实际无缓存作用，当前无直接功能损害；但既定不变量无机器兜底，下次漂移仍不会被发现。
- 修复：把 index.html 的版本参数纳入 runVersionCheck（fetch 自身 URL 或解析 link 查询串比对）。
- 验证：人为改乱 index.html 一处 `?v=` 后开新标签页应见 `[bootstrap] 版本漂移` 告警。

---

**BUG-50** ｜ 低 ｜ 修复状态：已修复
- 位置：`assets/stylesheets/ui/controlcenter.css:50-56`（产物）、`assets/stylesheets/ui/controlcenter.scss:58-64`、`assets/stylesheets/finderbar/finderbar.scss:34-48`
- 证据：`.finderbar.black-text .right .controlcenter-icon:hover { background: rgba(0, 0, 0, 0.08); }`
- 问题：全仓 JS/HTML grep `black-text` 零命中（finderbar.css:66 注释自己也写明「全仓库没有任何 JS 写过这个 class」）。finderbar 产物已删除该族规则，但 controlcenter 的 scss 与 css 双份都还在；finderbar.scss 里残留的那份重编译时会回流进产物。
- 影响：永不匹配的死字节。
- 修复：删除三处全部 `.black-text` 规则。
- 验证：删除后 grep 无残留；图标悬停样式不受影响（真路径走 `data-wallpaper-ink`）。

---

**BUG-51** ｜ 低 ｜ 修复状态：待协调
- 位置：`assets/stylesheets/ui/controlcenter.scss`（:141、:161、:195、:226 等约 40 处）与产物 controlcenter.css
- 证据：`html[data-theme="dark"] .cc-card, body.dark-mode .cc-card { background: rgba(60, 60, 66, 0.55); }`
- 问题：主题只由 `html[data-theme="dark"]` 承载（appearance.js），grep 全仓 JS/HTML 无 `dark-mode` 写入点。每条暗色规则都以 `body.dark-mode` 孪生形式白写一遍。
- 影响：纯死字节，约占该文件暗色节一半体量；误导后来者以为存在第二套主题开关。
- 修复：批量删除 `body.dark-mode …` 分支。
- 验证：删除后暗色主题外观逐像素一致。

---

**BUG-52** ｜ 低 ｜ 修复状态：已修复
- 位置：`sw.js:58-72, 77-81`
- 证据：
```js
idsPromise = openDb().then(...).then((set) => { installedIds = set; return set; })
// message: resetInstalledIds(); ports[0].postMessage("ok");
```
- 问题：装/卸插件的消息处理器清空 installedIds/idsPromise 即回 ack，但不清空在途旧 idsPromise 的 `.then` 回写。若消息到达时恰有一个 /mods/ 请求的 getAllIds 在途（其 readonly 事务快照早于安装写库提交），它在 ack 之后才 resolve，把安装前的旧 id 集合写回 installedIds。随后 verifyInstall 回读新插件资源 → 集合未命中 → 透传网络 → 404 → 安装回滚。触发窗口苛刻（首个 /mods/ 请求在飞的窗口期）。
- 影响：偶发「装完打不开/安装失败回滚」。
- 修复：代际令牌——resetInstalledIds() 时 ++generation，回写前比较闭包捕获的代际值。
- 验证：模拟「getAllIds 挂起 → installed-changed → 旧集合 resolve」，断言 installedIds 仍为 null。

---

**BUG-53** ｜ 低 ｜ 修复状态：已修复
- 位置：`sw.js:192-203`
- 证据：`req.onblocked = () => { dbPromise = null; reject(...); };` 后无防护的 `req.onsuccess = () => { const db = req.result; ... resolve(db); }`
- 问题：Promise 已 reject 后 resolve 是 no-op，但若阻塞方随后关闭连接、升级事务继续完成，onsuccess 仍触发并拿到 db 句柄——无人持有引用、不 close、dbPromise 已置 null，连接挂到下一次 versionchange 才自愈。多标签并发升级场景下加剧后续 blocked。
- 修复：onsuccess 内检查 settled 标志，已失效则立即 db.close()。
- 验证：构造双上下文并发 open 触发 blocked→success 序列，断言无未关闭连接。

---

**BUG-54** ｜ 低 ｜ 修复状态：已修复
- 位置：`sw.js:132-137`
- 证据：`const hit = Object.keys(files).find((k) => k === fileName || k.endsWith("/" + fileName));`
- 问题：ZIP 无公共根目录且含 `a/index.html` 与 `b/index.html` 这类同尾文件时，请求 `./mods/<id>/index.html` 命中哪个取决于对象键插入顺序，非确定性。
- 修复：多后缀命中时取键长最短者，或安装期（store-api.js 解包处）拒绝同尾冲突。
- 验证：构造含 `a/x.png`、`b/x.png` 的测试包，断言请求结果稳定。

---

**BUG-55** ｜ 低 ｜ 修复状态：已修复
- 位置：`sw.js:142-167`
- 证据：`return map[ext] || "application/octet-stream";`（map 无 mp3/mp4/webm/ogg/wav/m4a/avif）
- 问题：ZIP 插件若携带音频/视频（通知音、预览视频），SW 回源统一给 `application/octet-stream`，`<audio>/<video>` 依赖 MIME 嗅探在 Chrome 下可能拒播；磁盘插件走网络不受影响，两种安装路径行为不一致。
- 修复：补 mp3→audio/mpeg、mp4→video/mp4、webm/ogg/wav/m4a/avif 等映射。
- 验证：安装含 mp3 的测试插件，fetch 该资源 Content-Type 应为 audio/mpeg。

---

**BUG-56** ｜ 低 ｜ 修复状态：待协调
- 位置：`assets/stylesheets/main/desktop.scss:10-12`；产物 desktop.css:10-13
- 证据：
```css
.desktop { display: flex; direction: rtl; flex-direction: row-reverse; }
```
- 问题：按 Flexbox 规范，`direction: rtl` 下 row 主轴为右→左，`row-reverse` 再反转一次 = 左→右。净效果是普通 LTR 横排——桌面图标锚定在左上并向右延展，而 macOS 桌面图标从右上开始。若右上锚定才是意图，`row-reverse` 是多余的错误项；同时 `direction: rtl` 会把 rtl 文本方向继承进图标标签。
- 复现：桌面放两个图标，第一个出现在左侧而非右侧。
- 影响：与 macOS 保真目标不符（或若左排是有意的，该组合自抵消，应删一条）。
- 修复：保真：`direction: rtl` + `flex-direction: row`；维持现状：删 `direction: rtl` 并补注。
- 验证：新建 2 个桌面文件，首图标应贴右上缘（保真修复后）。

---

**BUG-57** ｜ 低 ｜ 修复状态：待协调
- 位置：`assets/stylesheets/ui/window.scss:267`；产物 window.css:292
- 证据：`.row { ... justify-content: space-between; z-index: -2; }`（无 position）
- 问题：z-index 对 position: static 元素不生效，该声明是死代码；若本意是让行背景沉到某层之下，该层叠意图从未成立。
- 修复：直接删除；若确有层叠意图，补 `position: relative`。
- 验证：删除后系统设置/关于本机的行渲染无差异。

---

### 3.5 内置插件组 A（finder / app-store / launchpad / safari / system-settings，BUG-58 ~ BUG-63）

---

**BUG-58** ｜ 高 ｜ 修复状态：已修复
- 位置：`mods/launchpad/script.js:485-505`（beginPress）与 529-531（onPointerUp）
- 证据：
```js
function beginPress(e, item, scope, cell) {
    if (press) return;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
```
- 问题：指针会话只监听 pointermove/pointerup，完全没监听 pointercancel。press 一经置位，只有 onPointerUp 能清空并摘掉 window 级监听。
- 复现：触摸屏/触控笔按住图标开始拖拽，被系统手势打断（pointercancel，不会再有 pointerup）；此后点击任何图标 beginPress 都因 `if (press) return` 直接返回——启动台既不能点开应用也不能拖拽，只能 Esc 关闭恢复。桌面端拖拽被 OS 抢走指针时同样发生。
- 影响：启动台交互整体假死，残留 ghost 节点与 window 指针监听。
- 修复：beginPress 里同时挂 `pointercancel`（清 press、摘 ghost、清 dodge 而不走 endDrag 落盘），onPointerUp/onLaunchpadUnload 里同步摘除。
- 验证：触发 pointercancel 后再点击图标应能正常打开；press === null 且无残留监听。

---

**BUG-59** ｜ 中 ｜ 修复状态：已修复
- 位置：`mods/system-settings/panes/storage.js:209-215`
- 证据：
```js
const usage = formatBytes(estimate.usage || 0);
const quota = formatBytes(estimate.quota || 0);
quotaRow.setValue(`${formatBytes(usage)} / ${formatBytes(quota)}`);
meterFill.style.width = quota > 0 ? `${Math.min(100, (usage / quota) * 100).toFixed(2)}%` : "0%";
```
- 问题：formatBytes() 返回字符串（如 "1.5 KB"）被再次喂回 formatBytes()：`Number("1.5 KB")` 为 NaN → 恒返回 "—"。读数恒显示 "— / —"；`quota > 0` 对字符串比较得 false → 进度条恒 0%。（对照 panes/general.js:265-267 写法正确。）
- 复现：系统设置 → 存储，等 navigator.storage.estimate() 返回，读数恒 "— / —"，进度条恒空。
- 影响：存储面板配额读数与占用条完全坏死，且与 general 面板同类读数自相矛盾。
- 修复：`quotaRow.setValue(\`${usage} / ${quota}\`)`；比例条用原始数值 `estimate.usage / (estimate.quota || 0)`。
- 验证：面板显示真实「xx MB / yy GB」且进度条按占比填充。

---

**BUG-60** ｜ 中 ｜ 修复状态：待协调
- 位置：`mods/finder/finder-views.js:482-515`（showGalleryItem）、538-561（loadThumb）
- 证据：
```js
VFS.readFile(entry.path).then((file) => {
    if (file) { galleryUrl = URL.createObjectURL(file); img.src = galleryUrl; } ...
```
- 问题：两处异步读盘回调都没有「已释放/已被取代」守卫：
  1. 画廊快速连点缩略图：先发请求后返回时覆盖 galleryUrl，后建的 URL 成无人跟踪的孤儿，永不 revoke。每快速点一次泄漏一个 Blob 对象 URL。
  2. 图标缩略图：VFS.readFile 在窗口关闭后才 resolve 时 thumbCache 已被 dispose() 清空，回调又重新 set 写入新 URL，要等下一次开窗的 dispose() 才回收。
- 复现：画廊视图快速连点多张缩略图；或含大量图片目录打开图标视图后立即关窗。chrome://blob-internals 可见残留 blob URL。
- 影响：Blob 句柄随操作次数累积；与本文件自己注释宣称的「不留孤儿 URL」相反。
- 修复：showGalleryItem 加序号令牌（回调里序号不符则 revoke 并 return）；loadThumb 回调先检查 disposed/isConnected，不连通时直接 revoke 不写 thumbCache。
- 验证：连点 N 次后关窗 blob 计数归零；快速关窗后 blob 计数不增长。

---

**BUG-61** ｜ 低 ｜ 修复状态：已修复
- 位置：`mods/launchpad/script.js:1042-1049`（getDockImg）
- 证据：`let img = document.querySelector(\`#dock img[alt="${name}"]\`);`
- 问题：应用名未 CSS 转义直接拼进属性选择器（对照 dock.js:1090 同款查询走了 cssEscape()，本模块 findCell 也用了 CSS.escape，唯独这里裸拼）。ZIP 插件 manifest.name 是任意文本，含 `"` 或 `\` 时选择器直接抛 SyntaxError。
- 复现：安装名称含英文双引号的插件（如 `My "App"`），从启动台首次点击打开：zoomLaunch 动画已播，但 getDockImg 抛错导致 openApp 不执行、启动台也不关闭。
- 影响：「图标飞了但应用没开、启动台还挂着」。
- 修复：改 `CSS.escape(name)`，或取 #dock 后 querySelectorAll("img") 按 alt 过滤。
- 验证：含引号名称插件从启动台正常打开、启动台正常关闭。

---

**BUG-62** ｜ 低 ｜ 修复状态：已修复
- 位置：`mods/safari/js/events.js:59-84`（onDocumentKeyDown）
- 证据：
```js
if (event.key === "Escape") {
    if (!app.dom.confirm.hidden) { ... settleConfirm(false); return; }
    if (!app.dom.contextMenu.hidden || ...) { ... closeMenus(); return; }
    if (app.state.overviewOpen) { ... app.api.overview.close(); return; }
    ...
}
if (!isSafariFrontmost()) return;
```
- 问题：Esc 分支在 `isSafariFrontmost()` 检查之前执行。Safari 窗口在后台时，在别的窗口里按 Esc 也会把 Safari 的确认框/右键菜单/标签页概览/搜索建议全部收掉。其余按键都正确做了前台判断，只有 Esc 例外。
- 复现：Safari 打开标签页概览，点开另一窗口使其置顶，按 Esc——后台 Safari 的概览被悄悄关掉。
- 修复：Esc 各子分支包进 isSafariFrontmost() 判断之后（确认框可保留无条件 Esc）。
- 验证：Safari 后台开概览，前台窗口按 Esc，概览保持打开。

---

**BUG-63** ｜ 低 ｜ 修复状态：已修复
- 位置：`mods/system-settings/panes/plugins.js:844-885`（reloadButton + runAction）
- 证据：
```js
if (kind === "reload") {
    unload(id);
    await load(id);
```
- 问题：App 列表含「系统设置」自身，其「重新加载」按钮只按 enabled 置灰，没有「重载自己」保护。对 system-settings 点重新加载：unload 立即把用户正在看的窗口整体移除，load() 重开新窗口落在默认面板；flash(status, ...) 写入已 detach 的节点，用户看不到任何反馈。
- 复现：系统设置 → App →「系统设置」→ 点「重新加载」——窗口当场消失再重开，详情页上下文丢失。
- 修复：runAction 里 `id === "system-settings"` 时禁用或改为仅提示「重开窗口以重载」。
- 验证：对自身点「重新加载」应被拦下并提示，而非窗口闪灭。

---

### 3.6 内置插件组 B（about / calculator / manual / notepad / photos / siri / vs_code / office，BUG-64 ~ BUG-74）

> office 条目均标注「审查时点可能正被改写，需复核」（manifest.json mtime 2026-11-04 21:21、view-excel.js mtime 2026-11-04 21:17）。

---

**BUG-64** ｜ 高 ｜ 修复状态：已修复（其他会话）
- 位置：`mods/photos/script.js:2821`
- 证据：
```js
if (key === "Delete" || key === "Backspace") { ... return; }
if (key === ",", item.type === "video") { e.preventDefault(); skipVideo(-5); return; }
```
- 问题：`key === ",", item.type === "video"` 是逗号运算符，`key === ","` 的结果被丢弃，条件恒等于 `item.type === "video"`。走到这一行的任何按键（字母、数字、F5、Home、Tab……）在预览视频时都会 preventDefault() + skipVideo(-5)。
- 复现：导入任意视频 → 双击预览 → 按 x / 5 / Home 等任意未绑定键 → 视频回退 5 秒且默认行为被吞。
- 影响：视频预览下键盘行为完全错乱。
- 修复：改为 `if (key === "," && item.type === "video")`。
- 验证：预览视频时按 `,` 快退 5 秒、按 x 无反应。

---

**BUG-65** ｜ 高 ｜ 修复状态：已修复
- 位置：`mods/calculator/script.js:994-1031`（bindKeyboard / onKeyDown）
- 证据：
```js
document.addEventListener("keydown", onKeyDown, true);
if (!root.isConnected || root.classList.contains("minimized")) return;
if (meta && event.key.toLowerCase() === "c" && !event.altKey) {
    event.preventDefault();
    return copyToClipboard($("value").textContent);
}
```
- 问题：捕获阶段挂在 document 上，只检查窗口存在与未最小化，不检查本窗口是否活动窗口（宿主 window-manager.js:319 用 is-active 标记，photos 自己做了 isFrontWindow 判定，calculator 没有）。
- 复现：打开计算器后点选手册窗口里的一段文字按 ⌘C → 剪贴板得到的是计算器显示值，真实复制被 preventDefault 杀掉；在照片窗口聚焦时敲 1+1 直接打进计算器；⌘1/⌘2/⌘3/⌘R/⌘H 也被全局拦截。
- 影响：开着计算器就系统性破坏其它应用的复制与快捷键。
- 修复：onKeyDown 开头加 `root.classList.contains("is-active")` 检查（或复用 front-window 判定）。
- 验证：计算器在后台时于手册选中文本按 ⌘C，剪贴板应为所选文字。

---

**BUG-66** ｜ 高 ｜ 修复状态：待协调
- 位置：`mods/office/ribbon.js:222-232`（update）、130（buildControl）；状态源 `mods/office/view-ppt.js:1287-1294`
- 证据：
```js
function update(state = {}) {
    for (const btn of body.querySelectorAll(".rb-type-toggle .rb-btn")) {
        if (state[`!${id}`]) btn.disabled = true;   // 只置真，从不还原；且只扫 toggle
    }
}
```
- 问题：① update() 只遍历 `.rb-type-toggle`，而 ppt 的 `!ppt.undo/!ppt.redo/!ppt.deleteSlide/...` 全部是普通 button；结构签名不含状态，日常 syncRibbon 走「结构未变 → 仅 update」路径，这些按钮的 disabled 永远停在最近一次全量重建时的值；② 即便是 toggle，update 也只 `disabled = true`、从不设回 false。
- 复现：新建演示文档，撤销/重做初始即灰，打字后依然灰；切一次标签页后以 {} 状态重建，单页时「删除当前页」反而可点。
- 影响：功能区核心按钮可用态与真实状态脱节；undo 只剩快捷键与 QAT 兜底。
- 修复：update() 遍历全部 `.rb-btn`，按控件声明与 `state["!"+id]` 双向赋值 `btn.disabled = !!(item.disabled || state["!"+id])`。
- 验证：新演示打一个字撤销按钮变亮；剩一页时「删除当前页」恒为灰。

---

**BUG-67** ｜ 高 ｜ 修复状态：待协调
- 位置：`mods/office/script.js:333`（newDocument）、350（applyTemplate）、383（openByPicker）、390（openByPath，经 plugin-app-open 触发）
- 证据：
```js
async function openBytes(inst, bytes, name, path) {
    inst.view.load(model);   // 直接替换文档，undo 栈清空，无 dirty 确认
    inst.dirty = false;
```
- 问题：四条入口都不检查 inst.dirty。访达里双击第二个 .docx 时宿主 doLoadApp 对已存在窗口只做置顶 + announceFile（plugin-manager.js:672-676），窗口里未保存的编辑被直接冲掉，无「存储/不存储/取消」提示。
- 复现：打开文稿输入内容（标题栏出现「未保存」）→ 不保存 → 访达双击任意 .docx → 原文档内容消失且不可撤销（视图历史栈随 load 清空）。
- 影响：真实数据丢失路径，且是最容易触发的入口（双击文件）。
- 修复：四条入口统一先判 inst.dirty，经 `window.__dialog.messageBox` 给「存储/不存储/取消」三选。
- 验证：脏文档状态下双击新文件应弹确认；选「取消」后原文档原样保留。

---

**BUG-68** ｜ 中 ｜ 修复状态：已修复
- 位置：`mods/manual/script.js:99-101`（bind 阶段挂 document 监听）与 67（卸载监听在 await fetch + await open() 之后才注册）
- 证据：
```js
document.addEventListener("manual-open", onManualOpen);   // bind() 里，同步注册
...
await open(first.id, ...);
window.addEventListener("plugin-unload", onUnload);       // 全部异步完成后才注册
```
- 问题：content/index.json 加载失败时 init 在 59 行直接 return，onUnload 永远不被注册；加载缓慢期间用户关窗同理。manual-open/languagechange/content scroll 三个监听持续引用已脱离文档的 root。
- 复现：断网或改名 index.json 使 fetch 失败 → 关闭手册窗口 → 触发一次 languagechange → 旧实例仍执行 renderChapters() 写已卸载 DOM；重复开关累积实例。
- 影响：内存泄漏 + 旧实例继续响应全局事件。
- 修复：把 plugin-unload 注册挪到 bind() 同步段。
- 验证：制造索引 404 → 关窗 → 切语言，控制台无二次渲染、监听器计数不增长。

---

**BUG-69** ｜ 中 ｜ 修复状态：已修复
- 位置：`mods/vs_code/script.js:170-173`、`mods/vs_code/index.html:9-16`
- 证据：
```js
function onError() { titlebar.classList.add("errored"); }
frame.addEventListener("error", onError);
```
- 问题：iframe 的 error 事件只对极少数嵌入级失败触发；目标站 4xx/5xx、被 X-Frame-Options/frame-ancestors 拒绝、DNS/断网超时等情况浏览器照常触发 load（或什么都不触发），onLoad 反而清掉 errored 标记。文件头注释承诺的「加载失败时标题栏提示」基本不会生效。
- 复现：断网或修改 iframe src 为拒绝嵌入的地址 → 标题栏无 errored 提示，窗口白屏。
- 影响：github1s 不可用（GEN-08）时用户拿不到任何失败反馈。
- 修复：加超时看门狗或 navigator.onLine + 超时组合判定。
- 验证：断网打开 VS Code 窗口，标题栏应出现错误标记。

---

**BUG-70** ｜ 低 ｜ 修复状态：待协调
- 位置：`mods/office/office-io.js:79-95`
- 证据：
```js
input.addEventListener("cancel", () => { input.remove(); resolve(null); });
```
- 问题：`<input type=file>` 的 cancel 事件只有较新 Chrome/Edge/Safari 支持；老内核里用户取消选择后 change/cancel 都不触发，Promise 永不 resolve，隐藏 input 节点残留在 body。
- 修复：补 window 聚焦 + 延时回退检测（focus 后检查 input.files.length）。
- 验证：不支持 cancel 的浏览器里「打开…」后取消，再次点「打开…」正常且 body 无残留 input。

---

**BUG-71** ｜ 低 ｜ 修复状态：已修复
- 位置：`mods/calculator/script.js:413-419`
- 证据：
```js
try {
    navigator.clipboard.writeText(String(text).replace(/,/g, ""));
} catch (err) { ... }
```
- 问题：writeText 返回 Promise，try/catch 捕不到异步拒绝（权限被拒、文档失焦时 reject），产生 unhandledrejection 噪音。
- 修复：`navigator.clipboard.writeText(...).catch(...)`（office view-excel.js:1643 已是正确写法）。
- 验证：拒掉剪贴板权限后 ⌘C，控制台无未处理 rejection。

---

**BUG-72** ｜ 低 ｜ 修复状态：已修复
- 位置：`mods/notepad/core/dialog.js:55-62`
- 证据：
```js
const btns = document.querySelectorAll('swift-messagebox.system-dialog .alert-btn');
if (btns.length) btns[btns.length - 1].click();
```
- 问题：选择器不限定本次 prompt 的弹窗实例，多个 system-dialog 并存时（如同时有别的应用的 alert）回车会点到另一个弹窗的按钮。
- 修复：按 DOM 末尾（最新）的 system-dialog 过滤，或由 messageBox 返回值关联具体实例。
- 验证：先触发一个常驻 alert，再开记事本「插入链接」回车，应只关闭输入弹窗。

---

**BUG-73** ｜ 低 ｜ 修复状态：待协调
- 位置：`mods/office/script.js:333-342`（newDocument 缺 openFindGuard(inst)，而 applyTemplate/openByPicker/openByPath 都有）
- 问题：查找浮层开着时点「新建」，浮层留在新文档上；与其它入口行为不一致。
- 修复：newDocument 开头补 openFindGuard(inst)。
- 验证：⌘F 打开查找 → ⌘N 新建 → 浮层应消失。

---

**BUG-74** ｜ 低 ｜ 修复状态：已修复
- 位置：`mods/siri/script.js:604-608` 配合 581-583
- 证据：
```js
function toggleSiri() {
    if (STATE.isOpen || STATE.isOpening) closeSiri();
    else openSiri();
}
```
- 问题：isOpening 期间（首次加载 three 的数百毫秒）closeSiri 因 `!STATE.isOpen` 直接返回，用户连点两次 Siri 图标（想取消打开）第二次点击被吞。
- 修复：isOpening 时记 pendingClose 标记，openSiri 完成后立即关闭；或允许 closeSiri 中断 isOpening。
- 验证：首次冷启 Siri 瞬间连点两次顶栏图标，面板最终为关闭态。

---

## 4. 统计

| 级别 | 数量 |
|------|-----:|
| 致命 | 0 |
| 高 | 13 |
| 中 | 20 |
| 低 | 41 |
| **合计** | **74** |

## 5. 覆盖归属表（与 00 矩阵逐条对应）

图例：`BUG-xx` = 本报告命中；`CON` = 移交 02 矛盾性审查；`已审·无问题` = 逐行通读未发现问题；`豁免` = 矩阵规定方式（第三方仅核完整性 / locales 机械校验）。

### 内核 JS（src/javascripts）

| 文件 | 结论 |
|------|------|
| api-grants.js | BUG-17、BUG-18（另见 02 权限比对） |
| app-registry.js | BUG-17、BUG-25 |
| appearance.js | BUG-35、BUG-42 |
| bootstrap.js | BUG-40 |
| caller-context.js | BUG-18 |
| client.js | 已审·无问题 |
| contextMenuSettings.js | BUG-42 |
| controlcenter.js | BUG-04、BUG-13 |
| cursor.js | BUG-42 |
| datetime_popover.js | BUG-13 |
| debug.js | BUG-36 |
| default-apps.js | BUG-17、BUG-19、BUG-25 |
| desktop.js | BUG-02、BUG-09 |
| display.js | 已审·无问题 |
| dock.js | BUG-02、BUG-05 |
| dock/drag.js | 已审·无问题 |
| dock/icons.js | 已审·无问题 |
| dock/menu.js | 已审·无问题 |
| finderbar.js | BUG-01、BUG-03 |
| i18n.js | BUG-38、BUG-47 |
| image-drag-guard.js | 已审·无问题 |
| keyboard.js | BUG-37 |
| lock.js | BUG-37、BUG-41 |
| log.js | 已审·无问题 |
| main.js | 已审·无问题 |
| menubar-status.js | BUG-06 |
| office-brand.js | BUG-45 |
| os-api.js | BUG-17、BUG-19、BUG-20、BUG-26、BUG-28 |
| osfs.js | BUG-19、BUG-21 |
| paths.js | 已审·无问题 |
| permissions.js | BUG-29（另见 02 权限比对） |
| plugin-manager.js | BUG-16、BUG-22、BUG-23、BUG-24、BUG-27、BUG-30、BUG-32 |
| pointer-shake.js | 已审·无问题 |
| scrollWatch.js | 已审·无问题 |
| session.js | BUG-44 |
| settings-definitions.js | BUG-38（另见 02 默认值比对） |
| settings.js | BUG-33、BUG-34 |
| sound.js | BUG-43 |
| spotlight.js | BUG-37 |
| store-api.js | BUG-23、BUG-24、BUG-31 |
| surface.js | 已审·无问题 |
| trash.js | BUG-07 |
| trashIcon.js | 已审·无问题 |
| ui/alert.js | 已审·无问题 |
| ui/contextMenu.js | 已审·无问题 |
| ui/desktopItems.js | 已审·无问题 |
| ui/menu.js | 已审·无问题 |
| ui/menuCommands.js | 已审·无问题 |
| ui/notification.js | BUG-08 |
| ui/popover.js | 已审·无问题 |
| ui/trafficLights.js | 已审·无问题 |
| vendor.js | 已审·无问题 |
| version.js | 已审·无问题（漂移见 BUG-49） |
| vfs.js | 已审·无问题 |
| wallpaper-boot.js | 已审·无问题 |
| wallpaper.js | BUG-36、BUG-39、BUG-46 |
| window-manager.js | BUG-10、BUG-14 |
| window.js | BUG-11 |
| wm/frame.js | 已审·无问题 |
| wm/genie-capture.js | BUG-12、BUG-48 |
| wm/genie-effect.js | BUG-15 |
| wm/genie-geometry.js | 已审·无问题 |
| wm/genie-renderer.js | 已审·无问题 |
| zindex.js | 已审·无问题 |

### 内核入口与样式

| 文件 | 结论 |
|------|------|
| index.html | BUG-49 |
| manifest.json | BUG-48（另见 02 权限比对） |
| sw.js | BUG-52、BUG-53、BUG-54、BUG-55 |
| assets/stylesheets/cursor/cursor.{scss,css} | 已审·无问题 |
| assets/stylesheets/dock/dock.{scss,css} | 已审·无问题 |
| assets/stylesheets/finderbar/finderbar.{scss,css} | BUG-50（scss 残留死规则） |
| assets/stylesheets/main/desktop.{scss,css} | BUG-56 |
| assets/stylesheets/main/main.{scss,css} | 已审·无问题 |
| assets/stylesheets/ui/alert.{scss,css} | 已审·无问题（scss→css 漂移见 GEN-02 补充证据） |
| assets/stylesheets/ui/contextMenu.{scss,css} | 已审·无问题 |
| assets/stylesheets/ui/controlcenter.{scss,css} | BUG-50、BUG-51 |
| assets/stylesheets/ui/datetime-popover.{scss,css} | 已审·无问题（scss→css 漂移见 GEN-02 补充证据） |
| assets/stylesheets/ui/popover.css | 已审·无问题 |
| assets/stylesheets/ui/trafficlights.css | 已审·无问题 |
| assets/stylesheets/ui/ui.{scss,css} | 已审·无问题 |
| assets/stylesheets/ui/window.{scss,css} | BUG-57 |
| assets/stylesheets/ui/windowframe.css | 已审·无问题 |
| assets/stylesheets/ui/windowtraffic.{scss,css} | 已审·无问题 |

### locales 与第三方依赖

| 文件 | 结论 |
|------|------|
| assets/locales/{zh-CN,en,ja-JP,cat}.json | 豁免（键位齐整性 static-check 机械校验；键值矛盾见 02） |
| assets/vendor/{jszip.min.js, snapdom.mjs, snapdom.LICENSE, webswift.js} | 豁免（第三方仅核完整性） |
| mods/siri/vendor/**（9 文件） | 豁免（第三方仅核完整性） |

### 内置 mod

| 文件 | 结论 |
|------|------|
| mods/about/{index.html, manifest.json, script.js, style.css} | 已审·无问题 |
| mods/app-store/{index.html, manifest.json, script.js, style.css} | 已审·无问题 |
| mods/calculator/script.js | BUG-65、BUG-71 |
| mods/calculator/{convert.js, engine.js, history.js, programmer.js, rpn.js, index.html, manifest.json, style.css} | 已审·无问题（除零/溢出/精度边界均有显式处理，calc 三件套 1,843 断言通过） |
| mods/finder/finder-views.js | BUG-60 |
| mods/finder 其余 15 文件（finder-actions/contextmenu/group/layout/quicklook/search/sidebar/state/tabs/tags/toolbar、script.js、index.html、manifest.json、style.css） | 已审·无问题 |
| mods/launchpad/script.js | BUG-58、BUG-61 |
| mods/launchpad/{index.html, manifest.json, style.css} | 已审·无问题 |
| mods/manual/script.js | BUG-68 |
| mods/manual/{index.html, manifest.json, style.css, content/index.json} | 已审·无问题 |
| mods/notepad/core/dialog.js | BUG-72 |
| mods/notepad 其余 15 文件（core/{editor-source, editor-split, editor-wysiwyg, search, serializer, shortcuts, sidebar, storage, store, tabs}.js、features/{toolbar-format, toolbar-view}.js、index.html、manifest.json、script.js、style.css） | 已审·无问题 |
| mods/office/ribbon.js | BUG-66（需复核） |
| mods/office/script.js | BUG-67、BUG-73（需复核） |
| mods/office/office-io.js | BUG-70（需复核） |
| mods/office/manifest.json | 见 02（usage 多窗口宣称矛盾，需复核） |
| mods/office 其余文件（codecs/{docx, pptx, xlsx, xml, zip}.js、view-{excel, word, ppt}.{js, css}、view-style.js、templates.js、t.js、{word, excel, ppt}.html、style.css、ribbon.css） | 已审·无发现问题（撤销栈/监听器对账/XML 转义无明显缺陷；view-excel/view-word 需改写结束后复核） |
| mods/photos/script.js | BUG-64 |
| mods/photos/{index.html, manifest.json, photo-store.js, style.css} | 已审·无问题（blob 引用计数、预览代次守卫、卸载释放、导入回滚均正确） |
| mods/safari/js/events.js | BUG-62 |
| mods/safari 其余 16 文件（js/{actions, app, boot, constants, menus, overview, sidebar, start, store, suggestions, tabs, ui, utils}.js、script.js、index.html、manifest.json、style.css） | 已审·无问题 |
| mods/siri/script.js | BUG-74 |
| mods/siri/{index.html, manifest.json, style.css} | 已审·无问题 |
| mods/system-settings/panes/storage.js | BUG-59 |
| mods/system-settings/panes/plugins.js | BUG-63 |
| mods/system-settings 其余 23 文件（app.js、registry.js、script.js、ui.js、index.html、manifest.json、style.css、panes/{appearance, controlcenter, debug, default-apps, display, dock, focus, general, keyboard, lock-screen, mouse, notifications, password, privacy, siri, sound, spotlight, wallpaper}.js） | 已审·无问题 |
| mods/vs_code/script.js、index.html | BUG-69 |
| mods/vs_code/{manifest.json, style.css} | 已审·无问题 |

### 开发工具

| 文件 | 结论 |
|------|------|
| dev/{build-manual-content, calc-check, calc-convert-check, calc-programmer-check, deep-check, genie-check, osfs-check, package-plugin, settings-fulltest, settings-harness, static-check, store-check}.mjs、dev/optimize-manual-images.py | 已审·无问题（运行条件问题见 GEN-04；本组另在 02 做脚本自述比对） |

## 6. 附：GEN-02 实例级补充证据（非独立问题）

- `datetime-popover.scss:261-315` 仍保留暗色硬编码文字色（含其自身注释声称"已删"的 `#48484a` out-month 规则），产物 css 已移除——按 scss 头注明的 `npx sass` 命令重编译会把暗色低对比缺陷带回来。
- `alert.css:19-41` 暗色/降透明规则、`finderbar.css:179` 之后 menubar-status 段、`desktop.css:47-56` stage-manager 段均无 scss 对应。
