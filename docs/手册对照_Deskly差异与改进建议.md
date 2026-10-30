# Deskly × 苹果《iMac 使用手册》对照：差异与改进建议

版本基线：Deskly v0.2.93（commit 8aa417a）· 手册基线：《iMac 入门指南》2024 年款 · macOS Sequoia 15
手册侧依据：[iMac-2024-macOS15-知识库](file:///E:/hello/StartOS/docs/iMac-2024-macOS15-知识库/README.md)（8 章 + 63 页原文 + 209 图）
插件侧依据：逐条代码走查，每条给 `文件:行号`；标「未找到」的项已用中英文同义词全仓（`src/`、`mods/`、`assets/locales/`、`index.html`）复搜无命中。

判定口径：**一致** / **部分** / **缺失** / **假象**（有 UI 无实现，或文案承诺超出实现）。
成本口径：**S** ≤0.5 天 · **M** 1–2 天 · **L** ≥3 天。

---

## 1. 结论摘要

壳层已经到位：窗口与平铺、程序坞分段与放大、控制中心骨架、系统设置 25 面板结构、OSFS 双后端、四语 i18n、浅深自动主题。与手册的差距集中在三类，按危害排序：

1. **假象最伤信任**（48 项置灰菜单 + 6 处"文案承诺了但不存在"）。用户点下去发现是演示，比压根没有这一项更糟。
2. **多任务与窗口组织**：手册第 4 章给了 6 种（全屏幕 / 分屏浏览 / 平铺 / 台前调度 / 调度中心 / 多个桌面空间），Deskly 只有**平铺是真的**，其余 4 种缺失、1 种是空壳。
3. **键盘落差最大**：菜单里印了 **90 条** `shortcut:` 字面量（`finderbar.js`）+ 各插件 manifest 38 条，但全站真正被监听的窗口/系统级按键只有 **4 个**：`⌃⌘F` 全屏、`⌃F3`/`⌘F3` 程序坞导航、`F4` 启动台、`⌃Space`（事实上 `⌘Space` 也能开）聚焦。`src/javascripts/finderbar.js:591-595` 与 `src/javascripts/window-manager.js:1581-1583` 都写明了「显示 ≠ 已绑定」的取舍，但界面上没有任何视觉区分。

### 建议的 5 个优先项

| # | 项 | 手册出处 | 成本 | 为什么排前面 |
| --- | --- | --- | --- | --- |
| 1 | 打通「帮助」入口，把知识库变成产品能力 | 第 7 章 45 页 | M | 6 张帮助菜单全是置灰项，而仓库里已躺着 463KB 现成手册 |
| 2 | 假象清理：置灰项视觉分级 + 演示文案改口 | 全章 | S | 一次性消除最不信任的来源，不动架构 |
| 3 | 窗口组织补齐：调度中心 + 点墙纸移开窗口 + 台前调度真实收纳 | 第 4 章 30 页 | L | macOS 核心心智，且已有 `bringAllWindowsToFront()` 等地基 |
| 4 | 废纸篓闭环（拖入→落库→状态图标→放回原处→真清倒） | 第 3 章 19-20 页 | M | `OSFS.move` 已存在但**无任何 UI 消费**，删除目前是硬删除 |
| 5 | 菜单栏状态项补齐（电池/音量/蓝牙）+「在菜单栏显示」真实化 | 第 3 章 18、22 页 | M | `navigator.getBattery()` 数据已读进内存却从不渲染，属于白捡 |

### 需要拍板的 3 个决策（见 §6）

- 知识库以哪种形态进产品：内嵌精选 / 商店 ZIP / 远程按需拉。
- 快捷键策略：给"绑不了的键"加提示与 `⌃` 替代，还是维持现状只靠菜单文案。
- 机型身份：`about` 面板写死 **Mac mini / Apple M4 Pro**（[mods/about/index.html:6,16](file:///E:/hello/StartOS/mods/about/index.html#L6)），是否统一改成与手册一致的 iMac，或做成可配置。

---

## 2. 差异矩阵

### A. 桌面与菜单栏（手册第 3 章 18 页）

| 手册要求 | Deskly 现状 | 判定 | 建议 |
| --- | --- | --- | --- |
| 三区块：桌面 / 顶部菜单栏 / 底部程序坞 | 齐 | 一致 | — |
| 苹果菜单：关于本机 / 系统设置 / App Store / 最近使用 / 强制退出 / 睡眠 / 重启 / 关机 / 锁屏 / 退出登录 | 齐（`index.html:47-64`），「最近使用的项目」真实持久化（`src/javascripts/dock.js:1707-1733`） | 一致 | — |
| 菜单栏右侧状态图标：Wi-Fi、电池、控制中心、聚焦、Siri、时钟，且**可自定义显隐** | 只有 5 个真实项：时钟、控制中心、聚焦、Siri、日期；`appControl = ["switch.2","magnifyingglass","wifi"]`（`src/javascripts/finderbar.js:461`）里的 wifi 是**无监听的装饰图**；电池/音量/蓝牙/专注/正在播放/屏幕镜像/隔空投送在菜单栏**未找到** | 部分 | 补电池（数据已在 `src/javascripts/controlcenter.js:855-883`）、音量、蓝牙；`wifi` 要么接点击要么删 |
| 「在菜单栏显示」逐项开关（手册 22 页） | 仅控制中心一项 `controlcenter.showInMenuBar`（`src/javascripts/controlcenter.js:735-771`） | 部分 | 按状态项逐个补开关，复用 `mods/system-settings/panes/controlcenter.js` 模式 |
| App 菜单随活跃 App 整体切换、菜单项随上下文变化 | 有应用菜单表（`src/javascripts/finderbar.js:74-267`），但 **48 项 `disabled: true`** | 部分 | 见 §4-P0-2 |
| 找不到指针时快速晃动可放大 | 未找到 | 缺失 | 低成本还原（`pointermove` 抖动检测 + 临时放大光标） |

### B. 程序坞与废纸篓（手册第 3 章 20 页）

| 手册要求 | Deskly 现状 | 判定 | 建议 |
| --- | --- | --- | --- |
| 分隔条 + 固定区 + 最小化窗口区 + 废纸篓 | 齐（`src/javascripts/dock.js:1129-1148`） | 一致 | — |
| 运行指示小圆点、放大、位置、自动隐藏、悬停名 | 齐，且设置面板真实生效并持久化（`mods/system-settings/panes/dock.js:213-229`） | 一致 | — |
| 文件夹在 Dock 里以网格/堆栈展开 | 真（`src/javascripts/dock.js:1528`） | 一致 | — |
| 拖文件到 Dock 图标 = 用该 App 打开该文件 | 接受真实文件拖放并提示「用 X 打开 Y」，但**文件并未交给应用**，代码自注「演示性」（`src/javascripts/dock.js:684-717`） | 假象 | 至少对 Safari/照片/办公/记事本做真实 `postMessage` 传参 |
| 拖文件到废纸篓 → 落入、图标变满、可"放回原处"、清倒真删除 | 无专门分支（走通用 `bindDropOpen` → 尝试 `openApp("废纸篓")`，而废纸篓不可启动，`src/javascripts/dock.js:317`）；`emptyTrash()` 只把提示条文字改成"已清倒（演示）"（`src/javascripts/finderbar.js:1240-1246`）；满/空图标由用户在设置里手选（`src/javascripts/trashIcon.js:88-90`），不按 `/废纸篓` 内容驱动；桌面「移到废纸篓」只是 `item.remove()`，不落 `/废纸篓`（`src/javascripts/desktop.js:63-70`）；访达删除走 `OSFS.remove()` **硬删除**（`src/javascripts/osfs.js:539-551`） | 缺失 | §4-P0-4，`OSFS.move` 能力已具备，缺的是 UI 接线 |
| `⌥` + 点按黄灯 = 最小化当前 App 全部窗口 | 未找到（黄灯路径从不读 `altKey`） | 缺失 | 小 |
| 键盘 `⌃F3` 进 Dock，再按继续跳窗口区 | 半：进出 + 四向移动 + 回车打开（`src/javascripts/dock.js:1634-1659`），不含跳区与操作菜单 | 部分 | — |

### C. 窗口管理（手册第 4 章 30 页）

| 手册要求 | Deskly 现状 | 判定 | 建议 |
| --- | --- | --- | --- |
| 全屏幕（菜单栏隐藏、边缘探出） | 真：`setFullscreen` + 根类收菜单栏/Dock + 边缘 2px 探出（`src/javascripts/window-manager.js:517-551,1598-1602`） | 一致 | 缺"始终显示菜单栏"选项 |
| 分屏浏览 Split View（两 App 共享一个全屏空间、中间分隔条、一侧退出另一侧跟随） | 未找到。左右半屏只是普通平铺，仍是独立浮窗 | 缺失 | §4-P0-3 |
| 平铺窗口（绿键菜单选取排列方式） | 真：`TILE_REGIONS` 9 分区（`src/javascripts/wm/frame.js:341`）+ 拖边吸附预览（`src/javascripts/window-manager.js:1105-1119`） | 一致 | 吸附覆盖面比菜单窄：`snapZoneAt`（`src/javascripts/wm/frame.js:376-382`）不识别**底边**，下半屏与居中只能走绿键菜单；顶栏「窗口」菜单只列左/右两项（`src/javascripts/finderbar.js:123-124`）→ 建议对齐 |
| 点按桌面墙纸把所有窗口移开，再点恢复 | 未找到（`#desktop`/`.wallpaper` 只绑 mousedown 取消选中、contextmenu、drop，`src/javascripts/desktop.js:14-19`）；已有 `hideOthers()/showAll()` 但入口是苹果菜单（`src/javascripts/session.js:203-212`） | 缺失 | 地基现成，接墙纸点击即可 |
| 台前调度（主窗口居中 + 左侧最近窗口条 + 分组） | **空壳**：`applyStageManager()` 只切一个 class，作用对象是桌面图标 `.item` 的透明度，对 `.window` 零规则（`src/javascripts/controlcenter.js:691-697` + `assets/stylesheets/main/desktop.css:47-56`） | 假象 | §4-P0-3 |
| 调度中心 / Exposé（一屏铺开所有窗口） | 未找到。最接近的是 `bringAllWindowsToFront()`（纯置顶，`src/javascripts/window-manager.js:357`）与 Safari 自己的**标签页**概览 | 缺失 | §4-P0-3 |
| 多个桌面 / 空间（新建、切换、跨空间拖窗） | 未找到，无 space 数据结构 | 缺失 | L，可最后做 |
| 绿键悬停菜单选项集合 | 15 项齐（`src/javascripts/window-manager.js:1200-1227`，悬停 400ms），但缺官方的「替换拼贴窗口」「将窗口移到桌面 N」「切换 App」 | 部分 | 依赖 Split View / Spaces 先落地 |
| 多窗口 / 同 App 多实例 | **不支持**：同 appId 复用置顶（`src/javascripts/plugin-manager.js:456-463`），所以 `⌘N 新建访达窗口` 只会前置旧窗口 | 缺失 | 手册里"每个 App 可开多个窗口"是基础心智，建议按 App 白名单放开 |
| 重启后恢复上次打开的窗口 | 未找到（全仓无 `sessionStorage`，`bootstrap.js` 不重载窗口） | 缺失 | 与"关机=reload"叠加后体验突兀 |

### D. 通知与专注模式（手册第 3 章 21 页）

| 手册要求 | Deskly 现状 | 判定 | 建议 |
| --- | --- | --- | --- |
| 通知中心面板：点日期/时间或双指从左缘滑入，含历史通知与小组件 | **完全没有**：点时间只弹月历（`src/javascripts/datetime_popover.js:152-241`），通知只有右上角横幅 + 一个计数（`ui/notification.js:41,64-103`），小组件 API 全是 `pending()` 占位（`src/javascripts/os-api.js:240-246`） | 缺失 | §4-P1-8 |
| 专注模式：多种模式各自可配 App/联系人白名单与定时 | 4 个模式名只是下拉标签，**选哪个都不改变行为**；真实生效的只有总开关（`src/javascripts/controlcenter.js:170-176` → `ui/notification.js:59-60`） | 假象 | 要么做过滤条件，要么把模式选择改成单一"勿扰"开关 |
| 通知可分组、可"稍后通知"、可在锁定屏幕显示 | 未找到 | 缺失 | — |

### E. 控制中心（手册第 3 章 22 页）

| 模块 | 现状 | 判定 |
| --- | --- | --- |
| 亮度 / 音量 / 静音 | 真实生效（`src/javascripts/controlcenter.js:656-679` 压暗层 + `src/javascripts/display.js:55` 共享存储；`src/javascripts/sound.js:87-97` 真写 `audio/video.volume`） | 一致 |
| Wi-Fi / 蓝牙 / 隔空投送 / 屏幕镜像 | 纯本地布尔，`getState()` 全仓无消费者；Wi-Fi 副标题硬编码 `"WebStartOS-Home"`（`src/javascripts/controlcenter.js:416`）；**二级面板（网络列表/设备列表）未找到** | 假象 |
| 飞行模式 | 只对上面几个布尔做互锁，无网络后果（`:349-361`） | 假象 |
| 正在播放 | 写死两首歌来回切（`:119-123,702-708`） | 假象 |
| 显示器 / 声音 卡片右侧圆按钮 | 弹窗文案承诺「可选择显示器**分辨率**、色彩」「可选择内置扬声器、耳机、**AirPlay** 输出设备」（`src/javascripts/controlcenter.js:629-630`），而显示器面板实际只有亮度 + Night Shift 4 项（`mods/system-settings/panes/display.js:151-161`），声音输出设备是只读"跟随浏览器"（`mods/system-settings/panes/sound.js:7-8,89-92`） | 假象（文案超出实现） |

### F. 聚焦与 Siri（手册第 3 章 23-24 页）

| 手册要求 | Deskly 现状 | 判定 | 建议 |
| --- | --- | --- | --- |
| 唤起键 `⌘Space` | 默认 `ctrl+space`（`src/javascripts/spotlight.js:117`），判定函数把 `ctrlKey\|\|metaKey` 并列（`:736`）→ `⌘Space` 事实上可用但**不在设置候选里**（候选只有 ctrl+space / alt+space / off） | 部分 | 把 `⌘Space` 正式列为选项（注意与 macOS 输入法切换冲突的说明） |
| 结果类型：App / 系统设置 / 文件与文件夹 / 建议 / 计算与换算 | 四类真实：app / setting+pane / **file（确实搜 OSFS）** / command（`src/javascripts/spotlight.js:376-385` + `src/javascripts/vfs.js:206-232`）；**无算术、无单位换算、无 Siri 建议** | 部分 | 手册 23 页明确"输入 `2*5` 或 `10 USD in CNY`"，计算器已有换算引擎（`mods/calculator/convert.js`），接进聚焦即可 |
| 搜图像内文字（实况文本）、按 `Return` 打开 App | 未找到 / 已实现 | 部分 | — |
| Siri：语音唤起、问答、执行操作 | **只有光球**：Three.js 装饰 + 提示音 + 尺寸三项设置（`mods/siri/script.js:1-14,58-74`），无 `SpeechRecognition`、无意图解析、与聚焦无联动 | 假象 | 见 §5：要么标注为装饰，要么接 Web Speech API |

### G. 系统设置（手册第 4 章 25-29 页）

面板权威清单：`mods/system-settings/registry.js:97-228` 共 **25 条，20 条 implemented**，5 条只留接口（`account` / `search`(网络) / `screenTime` / `users` / `icloud`），未实现项不进侧栏 DOM 也不参与搜索（`:235-247`）。

| 手册有的面板/能力 | Deskly 现状 | 判定 |
| --- | --- | --- |
| **辅助功能**（旁白 / 缩放 / 对比度 / 减少动态 / 键盘光标 / 听写 / 助听设备） | **registry 无该条目，全仓 `accessibility` 零命中**。仅 `appearance.reduceMotion` 一项真实现（`src/javascripts/settings-definitions.js:89-93` + `assets/stylesheets/main/main.css:353-404`，且 `src/javascripts/window-manager.js:1404` 还读系统 `prefers-reduced-motion`） | 缺失（面板级） |
| **屏幕使用时间** | `implemented:false`，`mods/system-settings/panes/screen-time.js` 不存在，界面上看不到这一项 | 缺失 |
| **网络 / 用户与群组 / iCloud / 账户** | 4 项 `implemented:false` | 缺失 |
| **软件更新** | 全仓零命中（连文案都没有） | 缺失 |
| 关于本机 / 版本信息 | 不在系统设置内，是独立 `mods/about/` 插件；且机型写死 Mac mini M4 Pro | 部分（且与手册机型不一致） |
| 语言与地区、日期与时间（独立面板） | 被压进「通用」：语言 4 语真实（`src/javascripts/i18n.js:36-39,264`），日期时间只有 24/12、显示秒、周起始日 3 项；无地区/时区/历法/单位 | 部分 |
| 墙纸（动态、相簿、原彩、叠加层、随浅深色自动切） | 静态内置仅 3 张 + URL + 本地上传 + Bing 每日（`src/javascripts/wallpaper.js:182-197,322,337,402`）；动态/轮播/叠加层/随主题切换**全部未找到** | 部分 |
| 显示器（分辨率 / 缩放 / 刷新率 / 排列 / 主显示器） | 只有亮度 + Night Shift 4 项 | 部分（受浏览器限制，见 §5） |
| 键盘（快捷键总表 + 修饰键映射） | 总表真实且可搜索/复制 TSV（`mods/system-settings/panes/keyboard.js:163-258`，数据源 `src/javascripts/finderbar.js:407-436` 合并 90 条内置 + 38 条 manifest）；**不可编辑**、**无修饰键映射** | 部分 |
| 鼠标 / 触控板（指针速度、自然滚动、辅助点按、三指拖移） | 只有光标外观：`cursor.size`/`cursor.shadow` + 三角色自定义光标上传（`mods/system-settings/panes/mouse.js:154-259`）；**无触控板面板**；速度/自然滚动等零命中 | 部分（多数受浏览器限制） |
| 存储（分类色条 + 优化存储 + 大文件建议） | 真实统计（逐插件 `OSFS.walk` 累加 size + `navigator.storage.estimate`，`mods/system-settings/panes/storage.js:202-375`）；无分类色条、无"优化存储"、无大文件建议 | 部分 |
| 锁定屏幕 / 密码 / 隐私与安全性 | 真实可操作：自动锁屏、立即锁定、SHA-256+盐口令（`src/javascripts/lock.js:27,121,177`）、权限表真调 `permissions.request()`、清除本地数据 | 一致 |

### H. 访达与文件（手册第 3 章 19 页）

| 手册要求 | Deskly 现状 | 判定 | 建议 |
| --- | --- | --- | --- |
| 四种视图 + `⌘1-4` | 真（`mods/finder/script.js:401-404`，`finder-views.js` 600 行） | 一致 | — |
| 拖拽移动/复制文件、跨窗口拖、拖到侧边栏 | **完全没有**：条目显式 `draggable = false`（`mods/finder/finder-views.js:366,516`），`mods/finder/` 全域无 `dragstart/drop`；侧边栏只绑 click | 缺失 | §4-P1-7 |
| 显示简介（`⌘I`，大小/创建时间/权限） | 5 处入口全 disabled（`src/javascripts/desktop.js:72,105`、`src/javascripts/finderbar.js:95`、`mods/finder/finder-contextmenu.js:48,66`）；`OSFS.stat()` 存在（`src/javascripts/osfs.js:1035`）但无消费方 | 缺失 | §4-P1-7 |
| 压缩 / 解压 zip 给用户用 | 引擎有（JSZip 按需加载 `src/javascripts/vendor.js:21`；App Store 拖 `.zip` 安装 `src/javascripts/store-api.js:343-359`；Office 写 OOXML），但**右键"压缩 N 项"/双击解压** 未找到 | 部分 | 复用现成 JSZip，成本 S |
| 删除 → 移入废纸篓 | 硬删除（`OSFS.remove()`，`src/javascripts/osfs.js:539-551`） | 缺失 | 与 B 组废纸篓一起做 |
| `⌘.` 显示隐藏文件、`Return` 重命名/打开、`Delete` 移入废纸篓 | 全部未找到（打开只走 dblclick；重命名在桌面/启动台有，访达无） | 缺失 | — |
| 「前往」菜单 / 排序 / 搜索 / 标签 / 快速查看 / 分组 | 真实且多数可用（`src/javascripts/finderbar.js:109-117`、`mods/finder/finder-actions.js:166-186`、`finder-search.js`、`finder-quicklook.js`、`finder-tags.js`）；仅「实用工具」置灰；图标大小调节与边栏显隐开关未找到 | 部分 | — |
| 桌面「叠放」自动归组散乱文件 | 未找到（访达内的 `groupBy` 不是桌面叠放） | 缺失 | P2 |

### I. App 覆盖（手册第 6 章 37-44 页）

手册描述 17 类 App。Deskly 实有 12 个 mods：关于本机 / App Store / 计算器 / 访达 / 启动台 / 记事本 / 办公（文稿·表格·演示）/ 照片 / Safari / Siri / 系统设置 / VS Code。

| 手册 App | 对应 | 判定 |
| --- | --- | --- |
| Safari 浏览器 | `mods/safari`（多标签、起始页、侧栏、阅读列表、`⌘T/⌘W` 等真绑） | 一致（覆盖面按手册 42 页看仍少：智能防跟踪报表、阅读列表离线、标签页组） |
| 照片 | `mods/photos`（导入、相簿、收藏、幻灯片、视频） | 部分（无"回忆"、无编辑工具、无 iCloud 同步） |
| Pages / Numbers / Keynote（iWork） | `mods/office` 用 **iWork 图标**承载，但读写 `.docx/.xlsx/.pptx` | 部分（图标与格式不一致，需注意别造成"能开 .pages"的误解） |
| 备忘录 / 文本编辑 | `mods/notepad`（由"备忘录"改名而来，见 `docs/产品更新信息.md:1443`），三视图 TXT/Markdown | 部分（对标"文本编辑"更准确） |
| 邮件 / 信息 / FaceTime / 日历 / 提醒事项 / 快捷指令 / 音乐 / 播客 / TV / iMovie | **无对应 App**；`src/javascripts/dock.js:117-150` 的 iconMap 里只有图标 | 缺失 |
| App Store | `mods/app-store`（启停/卸载/ZIP 安装） | 一致（本地语义） |
| 启动台分页 | 单张滚动网格，无分页与页点（`mods/launchpad/script.js:211-217`） | 部分 |

### J. 帮助与手册入口（手册第 7 章 45 页）

| 手册要求 | Deskly 现状 | 判定 |
| --- | --- | --- |
| 每个 App 的帮助菜单可打开对应手册；苹果菜单「macOS 帮助」；帮助菜单里可搜索 | **完全没有**：6 张帮助菜单各只有一行灰条目（`src/javascripts/finderbar.js:128,153,175,198,263,328`），全仓无 `openHelp`/帮助查看器；[知识库](file:///E:/hello/StartOS/docs/iMac-2024-macOS15-知识库/README.md) 已存在但运行时零引用 | 缺失（最高性价比的一项） |

### K. 键盘快捷键（手册第 7 章 48 页整表）

| 手册键 | 现状 | 判定 |
| --- | --- | --- |
| `⌃⌘F` 全屏 | 真绑（`src/javascripts/window-manager.js:1584-1591`） | 一致 |
| `⌃Space` / `⌘Space` 聚焦 | 真绑（`src/javascripts/spotlight.js:772`，捕获阶段） | 一致 |
| `F4` 启动台、`⌃F3` Dock 导航 | 真绑 | 一致 |
| `⌘Tab` 切 App / `⌘`` 同 App 切窗 | **未找到** | 缺失 |
| `⌘,` 打开设置 | 未找到（连 shortcut 字段都没写） | 缺失 |
| `⌃⌘Q` 锁屏、`⌘⌥Esc` 强制退出、`⌘H` 隐藏 | **能力都已实现，只差按键**（`src/javascripts/session.js:159-201`） | 部分 |
| `⌘W/⌘M/⌘Q` | 明确放弃绑定，理由已写在 `src/javascripts/window-manager.js:1581-1583`（浏览器保留键） | 有意差异 |
| `⌘⇧3/4/5` 截屏 | 未找到（且全站无任何形式截屏/录屏） | 缺失 |
| 访达 `⌘[ ⌘] ⌘↑ 空格` | 真绑（`mods/finder/script.js:406-417`） | 一致 |
| 统一快捷键分发器 | **不存在**：只有点击用的 `src/javascripts/ui/menuCommands.js:22-55` 注册表；`getShortcutMap()` 唯一消费者是设置面板展示 | 缺失（这是"90 条文案 vs 4 个真键"落差的根因） |

### L. 数据、备份与安全（手册第 2、4 章 16/32/33 页 + 第 7 章 49 页）

| 手册要求 | Deskly 现状 | 判定 |
| --- | --- | --- |
| iCloud 同步（照片/云盘/钥匙串/查找） | **完全没有**：`api.kobin.cn` 只是必应壁纸镜像（`src/javascripts/wallpaper.js:72`），`sw.js` 是本地资源代理；iCloud/账户面板 `implemented:false` | 缺失（见 §5） |
| 时间机器（全量备份 + 浏览恢复） | 备份只覆盖**设置槽**（`mods/system-settings/panes/general.js:284-341` 导出 JSON）；OSFS 无快照/版本/undo（`src/javascripts/osfs.js:1009-1045` 只有 CRUD+walk，`DB_VERSION=1` 从未升级） | 部分 |
| 迁移助理 / 从 PC 传输 | ZIP 安装链路真实（`src/javascripts/store-api.js:343-359`，10MB 上限），但只搬第三方 App 包不搬数据 | 部分 |
| 安全性功能（安全启动 / 安全储存 / 系统完整性 / 数据保护） | 硬件级无法对应；插件侧有锁屏口令 + 权限授权（`api-grants.js`）+ MV3 CSP | 有意差异 |
| 跨标签状态一致 | OSFS 用 `BroadcastChannel("deskly-osfs")` 真同步（`src/javascripts/osfs.js:917-928`）；剪贴板**不跨标签** | 部分 |

---

## 3. 设计与界面层面的差异

1. **机型身份不一致**：`about` 写死 Mac mini / Apple M4 Pro（`mods/about/index.html:6,16`），而本手册与插件视觉母版都是 24 英寸 iMac。建议把机型做成一处常量（或跟随 `wallpaper`/主题），否则"关于本机"与手册第 1 章对不上。
2. **菜单栏构成偏离手册描述**：手册 18 页把右侧状态项定义为"Wi-Fi / 电池 / 控制中心 / 聚焦 / 日期时间"，Deskly 目前是"控制中心 / 聚焦 / Siri / 日期时间 + 一张不可点的 Wi-Fi 图"。这是用户第一眼就会对照的地方。
3. **置灰项缺少分级语义**：48 项 disabled 里混着三类——"macOS 有但我们做不到"（打印、iCloud）、"能做但没做"（显示简介、拷贝粘贴）、"占位等接线"（清倒废纸篓）。界面上三者长得一样。建议加两类视觉：`即将推出`（tooltip 指向手册章节）与 `浏览器不支持`（tooltip 说明原因）。
4. **术语一致性总体好**：访达 / 程序坞 / 聚焦 / 控制中心 / 台前调度 / 墙纸 / 边栏 等中文规范名与手册一致（`assets/locales/zh-CN.json`）。需要补的只有 4 个新词：调度中心、分屏浏览、叠放、通知中心。
5. **图标语言**：手册用 `IL_*` 线性符号（苹果官方 SF Symbols 风格），Deskly 菜单栏沿用 `switch.2`/`magnifyingglass`/`wifi` 三张符号图 + 应用侧拟真 PNG（`assets/icons/`）。方向正确，缺的是**状态项覆盖面**而不是风格。
6. **深色模式**：手册图有 `~dark` 变体（知识库刻意只收浅色）。Deskly 有 light/dark/auto 三态且 auto 跟 `prefers-color-scheme`，比手册描述更灵活；计算器恒深色是既定决策，属有意偏离，建议在帮助里写明以免被当成 bug。
7. **动效**：新增浮层（通知中心、简介窗口、调度中心）需按既有约定加短促动效并受 `appearance.reduceMotion` 控制，`assets/stylesheets/main/main.css:353-404` 已有统一开关。

---

## 4. 改进建议清单

### P0（先做：消除假象 + 手册核心体验）

**P0-1 打通帮助入口，把知识库变成产品能力** · 成本 M · 手册：第 7 章 45 页
- 做什么：新增内置 App「Mac 使用手册」（建议 `mods/help/`，注册进 `app-registry`），左栏章 / 中栏小节 / 右栏正文 + 搜索；把 6 张帮助菜单的置灰项接到它（`src/javascripts/finderbar.js:128,153,175,198,263,328`），苹果菜单「macOS 帮助」直达；聚焦新增 `help` 结果类型（`src/javascripts/spotlight.js:376-385` 已是可扩展结构）。
- 验收：任意 App 菜单「X 帮助」→ 打开手册并定位到对应小节；`⌃Space` 搜"废纸篓"能命中手册条目；离线可用。
- 体积方案见 §6（**必须选一个，44MB 图片不能整包进扩展**）。

**P0-2 假象清理与诚实化** · 成本 S
- 做什么：
  - 删掉或接实 `src/javascripts/controlcenter.js:629-630` 两条超出实现的弹窗文案（显示器"分辨率"、声音"AirPlay 输出设备"）。
  - `src/javascripts/controlcenter.js:416` 硬编码 `"WebStartOS-Home"` 改为 i18n 文案 + 真实 `navigator.onLine` 状态，或明确标注"演示"。
  - 正在播放写死曲目（`:702-708`）→ 无播放器时整卡置灰并说明。
  - 48 项 disabled 按 §3-3 分两类加 tooltip，指向手册章节。
  - 全局搜 `演示` / `占位` / `TODO` 字样，统一收口成一种"演示态"视觉（见 §5）。
- 验收：`grep -rn "演示" src/javascripts` 命中数为 0 或全部带统一标记；控制中心每一项行为与文案一致。

**P0-3 窗口组织补齐（手册 30 页的核心 6 种）** · 成本 L，建议拆 3 段
- ① 点墙纸移开/恢复所有窗口（地基已有 `hideOthers/showAll`，`src/javascripts/session.js:203-212`）· M
- ② 调度中心：一屏铺开所有窗口 + 点按取回 + `⌃↑` 绑定（`bringAllWindowsToFront()` 可改造，`src/javascripts/window-manager.js:357`）· L
- ③ 台前调度真实收纳：左侧最近窗口条 + 主窗口居中，替换现在只淡出桌面图标的 class（`src/javascripts/controlcenter.js:691-697`）· L
- ④ 分屏浏览：两窗共享一个全屏容器 + 中间可拖分隔条 + 绿键菜单补「替换拼贴窗口」· L
- 附带修：`snapZoneAt` 补底边分区（`src/javascripts/wm/frame.js:376-382`），顶栏「窗口」菜单从 2 项对齐到 `TILE_REGIONS` 全集（`src/javascripts/finderbar.js:123-124`）。
- 验收：手册 30 页列的 6 种组织方式，除 Spaces 外全部可用且绿键菜单文案与手册一致。

**P0-4 废纸篓闭环** · 成本 M
- 做什么：桌面/访达删除改为 `OSFS.move` 到 `/废纸篓`（能力已在 `src/javascripts/osfs.js:688`，目前**无任何 UI 调用**）；Dock 废纸篓接真实 drop 分支（绕开通用 `bindDropOpen`，`src/javascripts/dock.js:655`）；`emptyTrash()` 真删（`src/javascripts/finderbar.js:1240-1246`）；满/空图标改由 `/废纸篓` 是否非空驱动（`src/javascripts/trashIcon.js:88-90` 现在读用户手选偏好）；右键补「放回原处」。
- 验收：拖文件到废纸篓 → 图标变满 → 打开可见 → 放回原处可撤销 → 清倒弹确认且真删除；`OSFS.remove` 不再被 UI 直接调用。

**P0-5 菜单栏状态项补齐** · 成本 M
- 做什么：电池（数据已真读进 `state.battery`，`src/javascripts/controlcenter.js:855-883`，`SVG.battery` 定义了却零引用——纯渲染缺失）、音量、蓝牙三项状态项；点击展开对应控制中心模块；每项接「在菜单栏显示」开关（复用 `controlcenter.showInMenuBar` 模式）。
- 验收：手册 18 页描述的右侧状态项集合齐；关掉某项后菜单栏与设置面板同步。

**P0-6 快捷键诚实化 + 可绑集合落地** · 成本 M
- 做什么：建一个真正的全局分发器（现有 `src/javascripts/ui/menuCommands.js:22-55` 只服务点击），把 `getShortcutMap()`（`src/javascripts/finderbar.js:407-436`）从"展示表"升级为"绑定表"；先实现**能力已有只差按键**的三条：`⌘,` 设置、`⌘H` 隐藏、`⌃Q` 锁屏、`⌘⌥Esc` 强制退出；再补 `⌘Tab`（窗口/App 切换器，可复用调度中心数据）与 `⌘``；对 `⌘W/⌘M/⌘Q` 这类浏览器保留键，菜单里加统一"浏览器保留"标记而不是静默显示。
- 验收：设置面板快捷键总表里每一条要么真能按出效果，要么显式标注"浏览器保留"；`⌘Tab` 可切换 App。

### P1

| # | 建议 | 手册出处 | 落点 | 成本 |
| --- | --- | --- | --- | --- |
| P1-7 | 访达拖拽（条目可拖、跨窗口、拖到侧边栏/废纸篓）+ 显示简介窗口（`OSFS.stat` 已有）+ 右键压缩/解压（JSZip 已按需加载）+ `⌘.` 隐藏文件 + `Return` 重命名 | 第 3 章 19 页 | `mods/finder/`、`mods/finder/finder-views.js:366` 解除 `draggable=false` | M–L |
| P1-8 | 通知中心面板（历史通知列表 + 小组件 + 锁定屏幕展示），把 `widgets.*` 从 `pending()` 变成实现 | 第 3 章 21 页 | `ui/notification.js`、`datetime_popover.js`、`src/javascripts/os-api.js:240-246` | L |
| P1-9 | 专注模式差异化：每模式可配允许 App / 定时；否则把 4 个模式名改成单一勿扰开关 | 第 3 章 21 页 | `src/javascripts/controlcenter.js:170-176`、`mods/system-settings/panes/focus.js:164-196` | M |
| P1-10 | 新增「辅助功能」面板（旁白占位说明、缩放、增强对比度、键盘光标、减少动态归口） | 第 4 章 29 页 | `registry.js` 加条目 + `mods/system-settings/panes/accessibility.js` | M |
| P1-11 | 屏幕使用时间（`mods/system-settings/registry.js:176` 已留位）：本地窗口焦点时长账本 + 报表 + App 限额 | 第 4 章 28 页 | `mods/system-settings/panes/screen-time.js` 新建 | M |
| P1-12 | 墙纸：相簿轮播 + 时段切换（昼/夜两张已存在，缺调度器）+ 随主题自动切 | 第 4 章 25 页 | `src/javascripts/wallpaper.js:182-197` | M |
| P1-13 | 聚焦支持算术与单位换算（复用 `mods/calculator/convert.js`） | 第 3 章 23 页 | `src/javascripts/spotlight.js:376-385` | S |
| P1-14 | 多窗口/多实例（按 App 白名单去掉 `src/javascripts/plugin-manager.js:456-463` 的 appId 去重）+ 刷新后恢复上次窗口布局 | 第 4 章 30 页 | `plugin-manager.js`、`bootstrap.js` | M |
| P1-15 | 启动台分页与页点（现在是单张滚动网格） | 第 6 章 37 页 | `mods/launchpad/script.js:211-217` | S |
| P1-16 | 拖文件到 Dock 图标真正传给应用（Safari/照片/办公/记事本先支持） | 第 3 章 20 页 | `src/javascripts/dock.js:684-717` | M |

### P2

| # | 建议 | 手册出处 | 成本 |
| --- | --- | --- | --- |
| P2-17 | 截屏工具条（`⌘⇧5` 语义：整屏/窗口/选区/定时/存到剪贴板）。全站目前**零截屏能力**；纯 DOM 截图可用 `html2canvas` 类方案，抓真实屏幕需 `getDisplayMedia` 授权 | 第 4 章 31 页 | L |
| P2-18 | OSFS 全量导出/导入（时间机器语义的最低可用版） | 第 4 章 33 页 | M |
| P2-19 | 软件更新：版本检查 + 变更说明（`docs/产品更新信息.md` 已有素材） | 第 4 章 26 页 | M |
| P2-20 | 桌面「叠放」自动归组 | 第 3 章 18 页 | M |
| P2-21 | 存储面板加分类色条 + "优化存储"建议（数据已在 `mods/system-settings/panes/storage.js`） | 第 7 章 50 页 | M |
| P2-22 | Spaces（多桌面）——依赖 Split View 先落地，最后做 | 第 4 章 30 页 | L |

---

## 5. 明确不做，以及"演示态"统一标注策略

下列手册能力受 MV3 / 浏览器 API 限制**无法真实实现**，建议不要继续伪装，统一降级为"演示态"：置灰 + 角标 + 点击给一句原因说明（并可跳手册章节）。

| 能力 | 做不到的原因 | 建议形态 |
| --- | --- | --- |
| 隔空投送 / 接力 / 通用剪贴板 / 随航 / 屏幕镜像 / 通用控制 | 需要系统级网络与蓝牙 | 控制中心里保留卡片但置灰 + 说明"需要原生系统" |
| iCloud 同步、账户体系、用户与群组 | 需要远端账户与服务器（`mods/system-settings/registry.js:203` 的理由已写明） | 保持 `implemented:false` 不上架，别做假面板 |
| 显示器分辨率 / 刷新率 / 多显示器排列 | 页面无法改系统显示模式 | 只保留亮度 + Night Shift（现状），并删掉 §4-P0-2 那条超范围文案 |
| 鼠标指针速度 / 自然滚动 / 三指拖移 | 浏览器不暴露 | 面板里标注"由系统设置控制" |
| 真实睡眠 / 关机 | 页面无法断电 | 保留遮罩，但文案改为"锁定并隐藏"之类不承诺断电的说法 |
| 硬件安全（安全启动 / 安全储存 / 系统完整性 / 数据保护） | 芯片级 | 在帮助里说明"Deskly 的对应机制是锁屏口令 + 权限授权账本" |
| 雷雳端口 / 妙控配件 / 充电 / 转换器 | 纯硬件 | 手册知识库保留原文即可，产品侧不做 |
| 邮件 / 信息 / FaceTime / 日历 / 提醒事项 / 音乐 / 播客 / TV / iMovie | 需要服务端或订阅 | 不要放"只有图标"的假入口（`src/javascripts/dock.js:117-150` 的 iconMap 目前有风险） |

---

## 6. 知识库接入产品的三个方案（体积账）

现状实测：文本 73 个 md 共 **463KB**（gzip 后 **139KB**）；图片 209 张共 **43.1MB**（其中最大的 50 张占 36.2MB，其余 159 张多为线性小图标）。`src/javascripts/store-api.js:42` 的 ZIP 安装上限是 **10MB**。

| 方案 | 内容 | 体积 | 优点 | 代价 |
| --- | --- | --- | --- | --- |
| A 内嵌精选 | 全部 8 章正文 + `INDEX.md`，图片只挑 40–60 张关键示意图（窗口管理/手势/控制中心/快捷键） | 约 150–200KB 文本 + 3–5MB 图 | 离线秒开、无网络权限、可被聚焦搜索索引 | 需人工挑图；`mods/` 体积明显增长 |
| A0 纯文本内嵌 | 同上但不带图（或只带 <20KB 的小图标） | gzip 139KB | 几乎零成本，可立刻上线 | 手势/界面类条目可读性下降 |
| B 商店 ZIP | 完整 8 章 + 全量图，做成可安装 App | 43MB，**超 10MB 上限** | 与手册 1:1 | 需先压图（WebP/降采样到 ~6MB）或放宽 `src/javascripts/store-api.js:42` 上限并加进度 UI |
| C 远程按需拉 | 运行时从 CDN 取 md/图 | 包体不变 | 内容可更新 | 新增 `host_permissions`、离线不可用、隐私成本最高 |

建议：**先 A0 打通链路（P0-1 的验收标准按纯文本算），再按使用数据决定是否升级到 A / B**。

体积与打包的两个事实（已核）：

- `docs/` 整个目录目前**未被 git 跟踪**（`git ls-files` 里 docs 命中 0 条），所以知识库不会自动进版本库；但扩展是以仓库根为扩展根的「加载已解压程序」形态运行，将来若把仓库根直接压成 zip 上传商店，这 43MB 会被一起带走——打包时需要显式排除 `docs/`。
- 仓库里现成的 `dev/package-plugin.mjs` 只负责 `mods/<id>/` → 可安装 ZIP，不裁剪扩展包；它注释里写的 10MB 上限常量位置已过期，实际在 [src/javascripts/store-api.js:42](file:///E:/hello/StartOS/src/javascripts/store-api.js#L42)（`MAX_TOTAL_BYTES`）。走方案 B 时这个上限是要跨过的坎。

---

## 7. 建议的落地顺序

| 版本 | 内容 | 判据 |
| --- | --- | --- |
| v0.2.94 | P0-2 假象清理 + P0-1 帮助入口（A0 纯文本）+ P1-13 聚焦换算 | 控制中心文案与实现一致；帮助菜单可点；`grep 演示` 归零 |
| v0.2.95 | P0-4 废纸篓闭环 + P0-5 菜单栏状态项 + P0-6 快捷键诚实化 | 删除可恢复；电池可见；总表每条可验证 |
| v0.3.0 | P0-3 窗口组织（①②③）+ P1-14 多实例与状态恢复 | 手册 30 页 6 种方式除 Spaces 外可用 |
| v0.3.x | P1-7 访达拖拽与简介、P1-8 通知中心、P1-10/P1-11 两个新面板、P0-1 升级到 A（带图） | 按 §4 各条验收 |

---

## 附录 A：已实现但容易被误判为"缺失"的项（复用清单，勿重复造）

| 能力 | 证据 |
| --- | --- |
| 聚焦确实搜文件（OSFS/VFS） | `src/javascripts/spotlight.js:376-385`、`src/javascripts/vfs.js:206-232` |
| 电池数据已真读（只差渲染） | `src/javascripts/controlcenter.js:855-883`（`navigator.getBattery()` + 4 个事件） |
| 亮度 / 音量 / 静音真实生效 | `src/javascripts/controlcenter.js:638-679`、`src/javascripts/sound.js:87-97`、`src/javascripts/display.js:53-80` |
| 强制退出、隐藏 App 已有命令，只差按键 | `src/javascripts/session.js:159-201` |
| 「最近使用」真实持久化（含苹果菜单子菜单） | `src/javascripts/dock.js:99,1086-1113,1707-1733` |
| 减少动态效果（含跟随系统 `prefers-reduced-motion`） | `src/javascripts/settings-definitions.js:89-93`、`src/javascripts/window-manager.js:1404` |
| 锁屏口令（SHA-256+盐、错 5 次冷却） | `src/javascripts/lock.js:27,121,177` |
| 跨标签文件系统同步 | `src/javascripts/osfs.js:917-928`（`BroadcastChannel("deskly-osfs")`） |
| 存储用量真实统计（逐插件累加文件 size） | `mods/system-settings/panes/storage.js:202-375` |
| ZIP 解包与打包引擎 | `src/javascripts/vendor.js:21-42`、`src/javascripts/store-api.js:343-359`、`mods/office/codecs/zip.js` |
| 快捷键总表可搜索/可复制 TSV | `mods/system-settings/panes/keyboard.js:163-258` |
| 访达 `⌘1-4`、`⌘[ ]`、`↑`、空格快速查看 | `mods/finder/script.js:401-417` |

## 附录 B：文案与实现不符清单（P0-2 的逐条工单）

| 位置 | 问题 |
| --- | --- |
| `src/javascripts/controlcenter.js:629` | 弹窗承诺"显示器分辨率、色彩"，实际只有亮度 + Night Shift |
| `src/javascripts/controlcenter.js:630` | 弹窗承诺"内置扬声器、耳机、AirPlay 输出设备"，实际声音面板是只读"跟随浏览器" |
| `src/javascripts/controlcenter.js:416` | Wi-Fi 名称硬编码 `"WebStartOS-Home"`（还带旧品牌名，与 Deskly 更名不一致） |
| `src/javascripts/controlcenter.js:119-123,702-708` | "正在播放"曲目写死循环 |
| `src/javascripts/controlcenter.js:691-697` | "台前调度"只淡出桌面图标，注释自称"示意" |
| `src/javascripts/finderbar.js:1240-1246` | "清倒废纸篓"只改提示文字，注释写"占位" |
| `src/javascripts/dock.js:699-717` | 拖文件到 Dock 提示"用 X 打开 Y"，实际不传文件，注释写"演示性" |
| `src/javascripts/finderbar.js:461` | 菜单栏 `wifi` 图标不可点击、无监听 |
| `mods/about/index.html:6,16` | 机型写死 Mac mini / M4 Pro，与 iMac 母版及本手册不一致 |
| `src/javascripts/finderbar.js:591-595` | 已承认"显示 ≠ 已绑定"，但界面未做任何区分 |
| `src/javascripts/dock.js:117-150` | iconMap 里存在 Mail/Messages/FaceTime/Calendar/Music 等图标但无对应 App，易被当成假入口 |

## 附录 C：手册侧还缺哪些来源（写下一版对照前补）

本知识库只覆盖《iMac 入门指南》，以下手册正文里出现但**内容在别的手册**，本次对照未纳入：FileVault、防火墙、Gatekeeper、锁定模式、系统设置逐面板细节、"Mac 使用手册"完整内容——它们都在 `guide/mac-help`。若要把 §4 的系统设置类建议做到与 macOS 逐面板一致，需要再抓一次 `https://support.apple.com/zh-cn/guide/mac-help/`（同一套脚本可直接复用，改 `imac` → `mac-help` 与版本路径即可）。
