# 插件包格式规范

> 回到 [文档首页](index.md)

## 固定目录结构

每个插件是一个自包含目录，位于 `mods/{id}/`：

```
mods/{id}/
├── manifest.json   # 插件清单（唯一事实来源）
├── index.html      # 窗口/界面 HTML
├── style.css       # 样式
├── script.js       # 逻辑（ES Module）
└── icon.png        # 图标（程序坞/启动台/商店使用）
```

> **id 命名**：使用小写蛇形命名，如 `vs_code`、`system-settings`、`app-store`。

## manifest.json 字段

```json
{
  "id": "calculator",
  "name": "计算器",
  "version": "1.0.0",
  "type": "app",
  "entry": "window",
  "author": "Edgerd",
  "description": "标准计算器",
  "main": "index.html",
  "style": "style.css",
  "script": "script.js",
  "icon": "icon.png",
  "window": {
    "width": 320,
    "height": 520,
    "resizable": false,
    "centered": true
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 插件唯一标识，小写蛇形命名 |
| `name` | ✅ | 插件显示名（程序坞/启动台/菜单显示） |
| `version` | ✅ | 插件版本 |
| `type` | ✅ | 类型，当前固定为 `app` |
| `entry` | ✅ | 入口形态：`window`（窗口）/ `fullscreen`（全屏，如启动台） |
| `author` |  | 作者 |
| `description` |  | 插件描述（商店显示） |
| `main` | ✅ | 界面 HTML 文件名，默认 `index.html` |
| `style` | ✅ | 样式文件名，默认 `style.css` |
| `script` | ✅ | 逻辑脚本文件名，默认 `script.js` |
| `icon` | ✅ | 图标文件名，默认 `icon.png` |
| `window` |  | 窗口初始尺寸/是否可缩放/是否居中 |

## 相对路径约定

插件目录 `mods/{id}/` 与 `src/`、`assets/` 平级，引用根资源统一加 `../../`：

| 引用目标 | 写法 |
|----------|------|
| 根图片 | `../../assets/images/xxx.svg` |
| 根图标 | `../../assets/icons/xxx.png` |
| 共享 JS | `../../src/javascripts/xxx.js` |
| 共享 UI | `../../src/javascripts/ui/contextMenu.js` |

## 打包分发

插件目录打包为 ZIP 后，拖入应用商店即可安装。ZIP 内必须包含 `manifest.json`，安装时自动解压为 `mods/{id}/` 并注册。