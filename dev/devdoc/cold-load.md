# 冷加载机制

> 回到 [文档首页](index.md)

## 目标

**启动时只注册清单，点击启动时才加载对应内容**，实现「启动插件程序后再加载内容」的按需加载，减少首屏加载开销。

## 两个阶段

### 阶段一：启动注册（仅清单）

启动时 `plugin-manager.init()` 逐个 `fetch('./mods/{id}/manifest.json')`，建立注册表 `registry`，并派发 `plugins-ready` 事件。

- 只拉取 6 个小 JSON 清单，不加载任何界面。
- 程序坞、启动台、应用商店据此渲染图标与名称。

### 阶段二：点击加载（按需）

点击已注册插件时，`plugin-manager.load(id)` 才拉取：

1. `index.html` → 注入 `<body>`。
2. `style.css` → 追加 `<link>` 到 `<head>`（去重）。
3. `script.js` → 追加 `<script type="module">`（去重）。
4. 调用 `window.js` 的 `resetWindowListeners` 绑定窗口行为。

若窗口已存在，则直接 `bringToFront` 置顶，不重复注入。

## 入口接线

`window.js` 的 `create()` 检测到应用已注册为插件时，自动转交给插件管理器：

```js
if (window.__getPluginByName) {
  const plugin = window.__getPluginByName(name);
  if (plugin) {
    import("./plugin-manager.js").then(({ load }) => load(plugin.id, { light, centered }));
    return;
  }
}
```

程序坞、启动台、菜单栏共用同一个 `create()`，因此冷加载对所有入口生效。

## 验证方法

1. 打开 DevTools 的 Network 面板。
2. 刷新页面：应只看到 6 个 `manifest.json` 请求。
3. 点击程序坞「计算器」：此时才出现 `mods/calculator/index.html`、`style.css`、`script.js` 请求。

## 相关文档

- [架构总览](architecture.md)
- [插件包格式](plugin-format.md)