# 交付前自检清单（Deskly 插件）

逐条核对，任一「否」都不交付。条目编号与 SKILL.md 章节对应。

## 结构与清单
- [ ] 目录 `mods/<id>/` 与 manifest 的 `id` 完全一致，小写蛇形、无 `..`
- [ ] 四个文件齐备（manifest.json / index.html / style.css / script.js），图标为 PNG 或缺省不声明
- [ ] `permissions` 字段存在（哪怕 `[]`），且每条都在 22 条权限名内、每条都真的用到
- [ ] 根级没写 `author`（无人读取，商店作者写到 `store.author`）；`formats` 单应用插件写根级、多应用套件写 `apps[].formats`

## 界面
- [ ] index.html 恰好一个 `.window` 根；`data-window` 只用系统认识的键（尺寸简写 size/min/max 或 width/height/minWidth/minHeight/maxWidth/maxHeight；布尔 resizable/minimizable/maximizable/centered/draggable/fixed/modal/multiWindow；字符串 role/parent/level/dragAxis/resizeAxis/snap/titlebar/trafficLights；特殊 aspectRatio/dragBounds）
- [ ] 红绿灯为 `<deskly-traffic-lights>`，标题栏形态带 `data-titlebar`，无标题栏用 `overlay`
- [ ] 所有用户可见文案走 `data-i18n` 或 `t(key, fallback)`；四语（zh-CN/en/ja-JP/cat）都注册
- [ ] 界面无 emoji；图标为站内 PNG/SVG 资源

## 样式与动画
- [ ] 无裸 `blur(<px>)`；毛玻璃用 `var(--surface-blur-N)`，文字色用 `var(--surface-text*)`
- [ ] `.window` 与毛玻璃元素上无 transform / filter / clip-path；亚克力内交互无 `filter: brightness()`
- [ ] 缓动统一 `cubic-bezier(0.16, 1, 0.3, 1)`；动画只用 transform/opacity；`data-reduce-motion="on"` 下无非必要动效
- [ ] 所有选择器带窗口类名前缀；无裸 z-index（浮层用 Z 表键值）
- [ ] 浅色 / 深色两种 `html[data-theme]` 下都看过一遍

## 逻辑与生命周期
- [ ] import 说明符无 `?v=`；运行时资源 URL 走 paths.js
- [ ] `plugin-unload` 按 id 认领并释放全部全局资源（监听/定时器/__钩子/__menuActions/订阅）
- [ ] init() 幂等，可重复执行不叠加状态；i18n.onChange 重建构建期文案
- [ ] 设置读写走 `__settings`，日志走 `__log`（来源 `plugin/<id>`），删除走 trash 收口
- [ ] 无 eval / new Function / 内联 on* / 外链脚本或 CDN 资源
- [ ] 用「调试 → 重载当前插件」验证：界面不叠影、菜单不重复、日志不翻倍

## 门禁
- [ ] `node dev/static-check.mjs` 退出码 0
- [ ] 需要打包时 `node dev/package-plugin.mjs <id>` 成功出包
