# 应用商店（App Store）

> 回到 [文档首页](index.md)

## 入口

- 菜单栏「App Store...」
- 程序坞的应用商店图标
- 启动台中的应用商店图标

应用商店本体也是一个插件（`mods/app-store/`），通过冷加载打开。

## 界面

- **顶部搜索框**：按名称实时过滤插件。
- **左侧分类**：全部 / 已安装 / 待更新。
- **主区卡片网格**：图标、名称、版本、描述、操作按钮。
- **底部 ZIP 安装热区**：拖入 ZIP 自动安装。

## ZIP 安装流程

1. 将插件目录打包为 ZIP（内含 `manifest.json`）。
2. 把 ZIP 拖入商店底部热区，热区高亮。
3. 系统调用 JSZip 解压，读取 `manifest.json` 校验。
4. 校验 `id` 字段后收集包内文件，写入 IndexedDB 并注册到注册表。
5. 提示安装结果，刷新插件列表。

## 发布说明

- 插件以 ZIP 分发，安装后即解压为 `mods/{id}/`。
- 当前版本仅支持本地已安装插件展示与 ZIP 安装；**远程插件源加载暂未实现**（界面占位）。

## 依赖

- **JSZip**：ZIP 解压所需，已本地化引入（`assets/vendor/jszip.min.js`，v3.10.1），满足 MV3 `script-src 'self'` 限制，离线可用。
- 错误弹窗依赖的 WebSwift（`<swift-messagebox>`）同样已本地化至 `assets/vendor/webswift.js`。

## 相关文档

- [插件包格式](plugin-format.md)
- [插件开发指南](plugin-development.md)
- [架构总览](architecture.md)