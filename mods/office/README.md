# 办公套件插件（office）

Deskly 的**内置多应用插件**（`BUILTIN_IDS` 里的 `office`），一个插件目录对外是三个应用：
文稿 / 表格 / 演示，清单里用 `apps[]` 声明，注册表展开成 `office.word` / `office.excel` / `office.ppt`。

```
node dev/package-plugin.mjs office     # 需要分享或走安装链验证时导出 ZIP（打包即校验）
```

## 分层

| 文件 | 职责 |
|------|------|
| `manifest.json` | 插件与三个应用（`apps[]`）的声明：窗口尺寸、图标、`formats`、顶栏菜单 |
| `script.js` | 外壳：生命周期、Ribbon 装配与命令路由、文件（Backstage）页、新建/打开/保存/下载/打印/最近打开、查找替换、快捷键 |
| `ribbon.js` / `ribbon.css` | Office 2016 功能区框架：只画控件、转命令、回灌状态，不懂任何格式语义 |
| `view-*.js` / `view-*.css` | 三个应用的文档渲染与编辑，并**声明自己的功能区** |
| `office-io.js` | 文件通道：系统选择器、内核读取（`OSFS.read`）、导出下载、写入 `/文档`、最近打开 |
| `codecs/` | `docx` / `xlsx`+`csv` / `pptx` 编解码，`xml.js`（自带迷你 XML，不用 DOMParser）、`zip.js`（JSZip 封装） |
| `view-style.js` | 视图私有 CSS 的装载件与建 DOM 助手 |

## 视图必须实现的契约

```js
createView(viewEl, opts) -> {
  load(model), read(), clear(), focus(), dispose(), metric(),
  ribbon(),                  // 标签页与控件声明（结构见 ribbon.js 顶部注释）
  command(id, value),        // 执行控件命令；必须显式返回 true / false
  state(),                   // {控件id: 值}，key 与控件 id 完全一致
  canUndo(), canRedo(), undo(), redo(),
  applyEdit(mutate),         // 外壳做查找替换的唯一入口，必须进撤销栈
}
opts = { onInput(), onSelectionChange() }
```

三条约定：命令**显式返回 true/false**（外壳据此判断是否落到「未实现的命令」）；
所有会改模型的动作（含 `applyEdit`）都要进撤销栈，输入按 400ms 合并；
`dispose()` 必须与注册监听一一对账，插件可能反复开关。

## 数据模型（视图 ↔ 编解码的唯一接口）

- 文稿：`{ blocks: [{ kind:"paragraph"|"heading", level, text, bold, italic, underline, strike, align, indent, font, size, color, highlight }] }`
- 表格：`{ name, rows: string[][], styles: CellStyle[][] }`（`styles` 与 `rows` 同矩形；以 `=` 开头的值按公式处理，显示由视图层求值，存储保持原始串）
- 演示：`{ slides: [{ title, bullets: string[], bulletsRight: string[], layout, background, color, titleColor, size }] }`

## 保存去向

写入走内核 `OSFS`：单一根目录下的 `/文档`（路径由 `OSFS.TOP.documents` 生成，不写死字面量）。未挂载时整棵树（含二进制）存 IndexedDB，挂载后映射到真实目录（readwrite）。文本与 OOXML 二进制同走 `OSFS.write`——文本传 string、`.docx`/`.xlsx`/`.pptx` 传 `Uint8Array`，存得下字节。`下载副本` 是显式导出到根目录之外（浏览器下载）。挂载存在但权限未批时抛 `NeedsReauthError`，状态栏如实报「需要重新授权」，不做「假装已保存」。

## 校验

- 编解码与纯逻辑：`node .workbuddy/office_base_probe.mjs`、`office_docx_probe.mjs`、`office_xlsx_probe.mjs`、
  `office_pptx_probe.mjs`、`office_grid_logic_probe.mjs`、`office_ppt_logic_probe.mjs` 等，
  全部要求 exit 0。这些探针是插件质量的主证据（仓内约定：静态磁盘校验优先，浏览器视口不可靠）。
- 视图依赖 DOM，用最小 DOM 桩探针跑命令矩阵与撤销栈（`office_xlsx_view_probe.mjs` 等）。
  **这类探针必须带 `--experimental-vm-modules` 运行**（它用 `vm.SourceTextModule` 真解析视图模块），
  不带这个 flag 会报 `vm.SourceTextModule is not a constructor`，是跑法问题不是代码问题。
- 结构校验：OOXML 包只保证「部件齐全 + rels 命中 + ContentTypes 覆盖 + schema 顺序」，
  **未在真实 Word / Excel / PowerPoint 里打开验证过**（本机没有安装）。
