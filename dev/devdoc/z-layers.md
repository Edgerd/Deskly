# 层级表（z-index）

> 回到 [文档首页](index.md)

全站浮层层级的**唯一定义处**是 [`src/javascripts/zindex.js`](../../src/javascripts/zindex.js)，
以 `export const Z`（`:23`）导出。JS 里 `import { Z } from "../zindex.js"`；CSS 无法 import，
只能把同一个数字硬写进样式表，改层级必须两处一起改，否则文档与代码会再次互相覆盖。

## 层级表

| 键 | 值 | 用途 | 现用位置 |
|----|----|------|----------|
| `Z.WINDOW_MIN` | 2050 | 窗口层级下限：焦点栈自底向上从这里起分配 | `window-manager.js:commitStack()` |
| `Z.WINDOW_MAX` | 9000 | 窗口层级上限（层级由栈序推导，窗口数不可能越到这里，Dock 恒在上） | `window-manager.js:commitStack()` |
| `Z.MENU_FLOAT_MAX` | 9499 | 普通浮层（顶栏下拉 `.menu`）提升封顶 | `zindex.js:26`（封顶常量 `MENU_Z_MAX` `:44`）；CSS 默认 `ui.css:18` = 7000 |
| `Z.MENU_HINT` | 9499 | 置灰菜单项的原因浮层（挂在 body，与菜单同层时按 DOM 顺序压在其上） | `zindex.js` 的 `MENU_HINT`；CSS `ui.css` 的 `#deskly-menu-reason` |
| `Z.DOCK` | 9500 | 程序坞 | `dock.css:107`、`:219` |
| `Z.DOCK_STACK` | 9510 | Dock 文件夹堆栈（需盖过窗口与 Dock） | `dock.css:274` |
| `Z.LAUNCHPAD` | 9600 | 启动台 | `mods/launchpad/style.css:49` |
| `Z.LAUNCHPAD_DOCK` | 9601 | 启动台打开时 Dock 的临时抬升（须越过启动台本身，低于 Z.MODAL） | `mods/launchpad/style.css`（注释引用本键） |
| `Z.LAUNCHPAD_DOCK_STACK` | 9602 | 启动台打开时 Dock 堆栈的临时抬升 | `mods/launchpad/style.css`（注释引用本键） |
| `Z.CLIENT_NOTICE` | 9605 | 客户端提示背板（移动端不兼容警示 `client.js` 创建的 `body > div.overlay`；压在窗口/Dock/启动台之上、弹窗之下，旧值 4000 落在窗口区间内已修） | `assets/stylesheets/main/main.css`（注释引用本键） |
| `Z.MODAL` | 9610 | 系统弹窗 / 通知 | `ui/alert.js:52`、`:118`；`ui/notification.js` |
| `Z.CONTEXT` | 9620 | 右键菜单（须盖过窗口与普通浮层，也盖过它所属的弹窗） | `ui/contextMenu.js:43`；`contextMenu.css:10` |
| `Z.CC_OVERLAY` | 9628 | 控制中心背板（须盖过右键菜单、低于控制中心面板） | `assets/stylesheets/ui/controlcenter.css`（注释引用本键） |
| `Z.PANEL` | 9630 | 控制中心 / 日期弹层（从顶栏垂下） | `controlcenter.css:99`；`datetime-popover.css:15` |
| `Z.POPOVER` | 9640 | **浮出层**：下拉菜单 portal 到这里，才能伸出所属窗口的 `overflow:hidden`；压在窗口 / Dock / 控制中心之上，菜单栏与各类系统遮罩之下 | `zindex.js:33`；CSS `assets/stylesheets/ui/popover.css:17`；用法 `ui/popover.js`，见 [系统 API 参考](os-api.md) §4.2 |
| `Z.MENU_BAR` | 9999 | 菜单栏 | `finderbar.css:6` |
| `Z.DOCK_TIP` | 9999 | Dock 悬停提示（`.tip`，与菜单栏同档） | `assets/stylesheets/dock/dock.css`（注释引用本键） |
| `Z.BRIGHTNESS` | 10000 | 显示亮度压暗层（盖过一切界面内容） | `controlcenter.js:442` |
| `Z.SESSION` | 10010 | 会话遮罩（锁屏 / 睡眠 / 关机，盖过压暗层） | `session.js:15` |

## 规则

1. **窗口层级只由 `window.js` 管理**：`bringToFront`（`zindex.js:61`）遇到 `.window` 直接返回，
   不越权改窗口 z-index，避免两套递增互相覆盖。
2. **固定层不参与动态提升**：`.contextmenu, .dock, .dock-stack, .launchpad, .finderbar,
   .controlcenter, .session-overlay, .os-overlay, .os-popover-layer`（`zindex.js:50`）的位置由本表决定。
   历史 bug：把右键菜单从 `INT_MAX` 一路降到 9499，结果被 Dock 和菜单栏盖住。
3. **普通浮层提升封顶 9499**：点击 `.menu` 内部时提升其所在菜单到「当前最高 + 1」，
   但绝不超过 Dock。
4. **新增浮层先改表再用**：在 `zindex.js` 的 `Z` 里加键，不要在其他文件里写裸数字。

## 历史偏差（已于 v0.2.94 修复）

v0.2.93 及之前存在 3 处未入表的裸数字，v0.2.94 已全部收编：

| 位置 | 旧值 | 处理 |
|------|----|------|
| `assets/stylesheets/dock/dock.css`（`.tip`） | 9999（未声明） | 入表 `Z.DOCK_TIP = 9999`（与菜单栏同档），CSS 加注释 |
| `assets/stylesheets/ui/controlcenter.css`（`.controlcenter-overlay`） | 9628（表外夹缝） | 入表 `Z.CC_OVERLAY = 9628`，CSS 加注释 |
| `assets/stylesheets/main/main.css`（`body > div.overlay`） | 4000（落在窗口区间 `2050–9000` 内，会被动态窗口压制） | 改值入表 `Z.CLIENT_NOTICE = 9605`：背板压在窗口/Dock/启动台之上、弹窗 Z.MODAL 之下，配套弹窗才浮得住 |

## 相关文档

- [架构总览](architecture.md)
- [插件开发指南](plugin-development.md)
