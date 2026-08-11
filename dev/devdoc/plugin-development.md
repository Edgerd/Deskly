# 插件开发指南

> 回到 [文档首页](index.md)

## 一、创建目录

以 `mods/calculator/` 为模板，复制并改名为 `mods/你的插件id/`。

## 二、编写 manifest.json

按 [插件包格式](plugin-format.md) 填写清单。关键字段：

- `id`：唯一标识，小写蛇形。
- `name`：显示名，如「计算器」。
- `entry`：`window` 普通窗口 / `fullscreen` 全屏。
- `window.centered`：打开时是否居中。

## 三、编写 index.html

写一个窗口根元素，需带 `window` 类与唯一 id（用 `name`）：

```html
<div class="window" id="我的应用">
  <div class="wintools">
    <div class="red"></div>
    <div class="yellow"></div>
    <div class="green"></div>
  </div>
  <!-- 应用内容 -->
  <div class="content">你好，世界</div>
</div>
```

> 红绿黄三个按钮用于触发 window.js 的关闭/最小化/最大化逻辑。

## 四、编写 style.css

样式沿用其他插件风格，可复用根目录的 CSS 变量（如 `--bg-color`）。如需引用根图片，用 `../../assets/...`。

## 五、编写 script.js

ES Module 逻辑，在插件注入后执行。可以导入共享模块：

```js
import { getPlugins, load as loadPlugin } from '../../src/javascripts/plugin-manager.js';
import { updateMenu } from '../../src/javascripts/finderbar.js';

const root = document.querySelector('#我的应用');
// ... 应用逻辑
```

🚫 不要在插件里重复实现窗口拖拽/缩放/关闭——这些由 `window.js` 统一处理。

## 六、放入图标

将 `icon.png` 放入插件目录，供程序坞/启动台/商店显示。

## 七、打包与安装

1. 将整个 `mods/{id}/` 目录打包为 ZIP。
2. 打开应用商店，把 ZIP 拖入底部安装热区。
3. 系统自动解压、读取 `manifest.json`、注册插件。

## 常见问题

| 问题 | 解决 |
|------|------|
| 图标不显示 | 确认 `icon.png` 存在于插件目录，且 `manifest.icon` 正确 |
| 图片 404 | 插件内引用根资源需加 `../../` 前缀 |
| 窗口无法拖动 | 确认 html 根元素带 `window` 类 |
| 重复打开 | 窗口已存在时统一切换到最前，无需重复注入 |

## 相关文档

- [插件包格式](plugin-format.md)
- [冷加载机制](cold-load.md)