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
| `Z.DOCK` | 9500 | 程序坞 | `dock.css:107`、`:219` |
| `Z.DOCK_STACK` | 9510 | Dock 文件夹堆栈（需盖过窗口与 Dock） | `dock.css:274` |
| `Z.LAUNCHPAD` | 9600 | 启动台 | `mods/launchpad/style.css:49` |
| `Z.MODAL` | 9610 | 系统弹窗 / 通知 | `ui/alert.js:52`、`:118`；`ui/notification.js` |
| `Z.CONTEXT` | 9620 | 右键菜单（须盖过窗口与普通浮层，也盖过它所属的弹窗） | `ui/contextMenu.js:43`；`contextMenu.css:10` |
| `Z.PANEL` | 9630 | 控制中心 / 日期弹层（从顶栏垂下） | `controlcenter.css:99`；`datetime-popover.css:15` |
| `Z.POPOVER` | 9640 | **浮出层**：下拉菜单 portal 到这里，才能伸出所属窗口的 `overflow:hidden`；压在窗口 / Dock / 控制中心之上，菜单栏与各类系统遮罩之下 | `zindex.js:33`；CSS `assets/stylesheets/ui/popover.css:17`；用法 `ui/popover.js`，见 [系统 API 参考](os-api.md) §4.2 |
| `Z.MENU_BAR` | 9999 | 菜单栏 | `finderbar.css:6` |
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

## 未入表的现存数字（已知偏差）

| 位置 | 值 | 说明 |
|------|----|------|
| `assets/stylesheets/dock/dock.css:66`（`.tip`） | 9999 | 与 `Z.MENU_BAR` 同值，未在表中声明 |
| `assets/stylesheets/ui/controlcenter.css:78` | 9628 | 落在 `Z.CONTEXT`(9620) 与 `Z.PANEL`(9630) 之间，不在表上 |
| `assets/stylesheets/main/main.css:74`（`body > div.overlay`） | 4000 | 落在窗口区间 `2050–9000` 内，会与动态窗口层级互相压制 |

## 相关文档

- [架构总览](architecture.md)
- [插件开发指南](plugin-development.md)
