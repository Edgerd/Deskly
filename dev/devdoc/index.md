# Web Start OS 开发文档

> 基于 macOS Sequoia 视觉风格的浏览器主页插件，采用 **插件化架构** 组织应用。
> 本文档是开发者的第一站：了解架构、插件格式、开发流程与冷加载机制。

---

## 目录

| 文档 | 说明 |
|------|------|
| [架构总览](architecture.md) | 系统分层、模块职责、运行模型 |
| [插件包格式](plugin-format.md) | `manifest.json` 字段与插件目录固定结构 |
| [插件开发指南](plugin-development.md) | 从零开发一个插件，含示例与常见问题 |
| [冷加载机制](cold-load.md) | 启动注册清单、点击才加载内容的原理 |
| [应用商店](app-store.md) | 应用商店界面、ZIP 安装与发布流程 |

---

## 快速上手

1. 阅读 [插件包格式](plugin-format.md) 了解插件目录结构。
2. 复制 `mods/calculator/` 作为模板，改名为 `mods/你的插件id/`。
3. 按 [插件开发指南](plugin-development.md) 编写 `manifest.json` + `index.html` + `style.css` + `script.js` + `icon.png`。
4. 将目录打包为 ZIP 拖入 [应用商店](app-store.md) 即可安装。
5. 使用 [冷加载机制](cold-load.md) 了解按需加载原理。

---

## 编程规范

- 每个插件一个自包含目录，位于 `mods/{id}/`。
- 插件 id 使用小写蛇形命名（如 `vs_code`、`system-settings`）。
- 一个功能一个文件，不在单文件内堆叠多个独立模块。
- 所有类、方法、模块需编写中文 docstring 注释。
- 遵循 PEP 8 / 代码整洁原则，避免冗余注释。

## 版本与更新

- 正式功能更新按 `0.01` 步长升小版本号。
- 预发布版本仅递增 `Alpha/Beta/RC` 标识，到 9 进位升级小版本。
- 每次代码更新必须同步编写 `产品更新信息.md` 并更新 `version.js`。