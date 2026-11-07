# 三件套功能扩充文档

本文档按应用分章，逐项列出候选功能的入口、对应的文件格式特性、能否存进文件并回读、依赖的浏览器/宿主能力，以及「做 / 不做 / 降级做」的结论与理由。

实施顺序即本文档顺序：**文稿 → 表格 → 演示**；同章内按优先级从上到下。

## 0. 共同前提

- **保存链路（先修的地基）**：保存不再一律写 `/文档`，而是原地回写打开时的来源路径（`office-io.js` 的 `saveTargetPath` + `writeAt`）；`inst.path` 贯穿新建 / 打开 / 保存；表格保存前先 `endEdit(true)` 提交内联编辑。此项已修复并有 `office_save_reopen_probe.mjs`（63 项）覆盖。
- **读回口径**：每个功能都必须有 `build → parse` 往返断言；涉及包结构的还要断言部件齐全、rels 命中、`[Content_Types]` 覆盖与 schema 顺序。
- **验证方式**：禁用 Chrome；编解码用 Node 直接 import（`node .workbuddy/office_*_probe.mjs`），视图用最小 DOM 桩（`node --experimental-vm-modules .workbuddy/office_*_view_probe.mjs`）。
- **写包方式**：三个 codec 都是从模型**从零重建** OOXML 包，不复制来源包的未知部件。因此「真实文件里存在但模型没承载」的元素，保存后会丢失——这是本批优先补「格式里已有/常见但界面不可编辑」的根本原因。

## 1. 文稿（Pages 文稿 / `.docx`）

| # | 功能 | 入口 | 格式特性 | 落盘回读 | 依赖 | 结论 |
|---|------|------|----------|----------|------|------|
| W1 | 页边距 | 视图 → 页面 → 页边距 | `w:sectPr/w:pgMar` 的 top/right/bottom/left（twip） | 写 `pgMar`，读回四边；纸张渲染内缩、正文宽度随之变化 | 无（纯模型 + CSS） | **做**。真实 .docx 几乎都设了页边距，目前模型没有承载处，保存即丢；改动面小、风险低。 |
| W2 | 行距与段前/段后 | 开始 → 段落 | `w:pPr/w:spacing` 的 `w:line`/`w:lineRule`、`w:before`/`w:after`（twip） | 读写 `spacing`；行距支持单倍/1.5/2 倍，段前段后 0–72pt | 无 | **做**。段落样式的基础项，属「文件里常见但界面不能编辑」；只做整段粒度，不拆 run。 |
| W3 | 项目符号与编号 | 开始 → 段落 → 项目符号/编号 | `w:pPr/w:numPr` + `word/numbering.xml` 的 `abstractNum`/`num` | 写 numbering 部件（bullet / decimal 两种）、rels、Content Types、`numPr`；读回按 `numFmt` 映射成 bullet/number | 无 | **做**。目前 parse 直接忽略编号，真实文档的列表保存后会变成纯段落；只承载一级列表，多级与自定义编号样式降级为一级。 |
| W4 | 文档内表格（`w:tbl`）读写 | 无 | `w:tbl`/`w:tr`/`w:tc`、`gridSpan`、`vMerge` | 当前 parse 把表格拆成普通段落（单元格间插制表符），回写不可逆 | 无 | **不做（本批）**。需要单元格级模型 + 网格视图 + 合并单元格编辑，工作量和回归面都远大于 W1–W3；先列入下一批，本批不动，避免半成品破坏现有段落编辑。 |
| W5 | 样式继承（styles.xml / docDefaults） | 无 | `w:styles`、`w:docDefaults`、`w:basedOn` | 当前只读显式 `w:rPr`/`w:pPr`；生成包只写 Normal/Heading1..3 | 无 | **不做**。完整样式继承需要样式表模型与级联求值，收益主要在「打开别人的文档」，与下一批的表格/分节一起做更划算。 |
| W6 | 脚注/批注/书签/域代码 | 无 | `w:footnote`、`w:comment`、`w:bookmarkStart`、`w:fldSimple` | 不建模，读时丢弃 | 无 | **不做**。批注/修订需要跨 run 的锚点模型与独立部件生命周期，属于「协同/审阅」范畴，超出当前单文档编辑器定位。 |
| W7 | 分节与多栏 | 无 | `w:sectPr` 多节、`w:cols` | 只保留最后一个 `sectPr` 的页面设置 | 无 | **不做**。分节影响页码、页眉页脚与页面设置的作用域，需先有 W4/W5 的块级模型。 |
| W8 | 超链接 | 无 | `w:hyperlink r:id` | 只取显示文本，目标地址丢弃 | 宿主打开外部链接 | **降级做（不做）**。保留文本已够用；要保真需关系表与点击协议，且纯前端打开外链需宿主授权，收益低。 |

已具备（本批前完成，不重复实施）：纸张大小、页面背景色、页眉/页脚、插入图片、查找替换、缩放、标尺缩进、标题级别与字符格式。

## 2. 表格（Numbers 表格 / `.xlsx`）

| # | 功能 | 入口 | 格式特性 | 落盘回读 | 依赖 | 结论 |
|---|------|------|----------|----------|------|------|
| X1 | 行高 | 数据 → 行高 +/−/默认 | `w:row/@ht` + `customHeight="1"` | 读写行高（点值，模型存 px 近似或字符高）；网格按行高渲染 | 无 | **做**。与已完成的列宽对称，真实表格几乎都调过行高；目前行高完全不承载，保存即丢。 |
| X2 | 单元格字体与字号 | 开始 → 字体 / 字号 | `styles.xml` 的 `w:font/w:rFonts`、`w:sz`（半磅） | CellStyle 扩 `font`/`fontSize`；读写样式表并回读 | 无 | **做**。「单元格格式」缺口里最常用的一项，目前模型只承载布尔格式与颜色。 |
| X3 | 冻结窗格落盘 | 视图 → 冻结首行/首列（已有开关） | `w:sheetView/w:pane` 的 `ySplit`/`xSplit`、`topLeftCell`、`state="frozen"` | 把现有视图态开关写进 `pane`，打开时还原 | 无 | **做（降级：只支持冻结首行 / 首列两种预设）**。现在开关只活在本次会话，重开就没了；格式特性现成，成本低。 |
| X4 | 合并单元格 | 开始 → 合并 / 取消合并 | `w:mergeCells/w:mergeCell ref`、隐藏被并单元格 | Sheet 扩 `merges: [r1,c1,r2,c2][]`；读写 `mergeCells`；网格按合并区渲染、只保留左上格可编辑 | 无 | **做**。真实 .xlsx 最常见的结构特性，目前解析后合并信息丢失、保存即拆散；只做矩形区域合并，不做跨表/跨行内联富文本。 |
| X5 | 边框 | 开始 → 边框 | `styles.xml` 的 `w:border`（left/right/top/bottom） | CellStyle 扩边框字段；CSS 边框矩阵 | 无 | **不做（本批）**。需要每格四边独立 + 样式/颜色/粗细，视图侧渲染组合多、回归面大；与 X2 一起做更稳，列入下一批。 |
| X6 | 数据验证 / 条件格式 | 无 | `w:dataValidations`、`w:conditionalFormatting` | 不建模 | 无 | **不做**。属于规则引擎，涉及公式求值与多规则优先级，不属于「扩充常用编辑功能」。 |
| X7 | 超链接 / 批注 / 多工作表标签页 | 无 | `w:hyperlink`、`w:comment`、`workbook.xml` 多 sheet | 只编辑第一张工作表；超链接取文本 | 宿主打开外链 | **不做**。多表切换需要工作表标签 UI 与跨表引用，本批先聚焦单表编辑质量。 |

已具备（本批前完成）：值/公式（含 SUM/AVG/COUNT/MAX/MIN/ABS/ROUND/SQRT/MEDIAN/COUNTA）、数字格式、字符格式、填充色、对齐/换行、区域选择、排序、筛选、列宽、插入图片、冻结视图态。

## 3. 演示（Keynote 讲演 / `.pptx`）

| # | 功能 | 入口 | 格式特性 | 落盘回读 | 依赖 | 结论 |
|---|------|------|----------|----------|------|------|
| P1 | 图片定位 | 页内拖动图片（已有图片区） | `p:pic/p:spPr/a:xfrm/a:off` + `a:ext`（EMU） | ImageItem 扩 `x`/`y`（px）；写 `a:off`，读回位置与尺寸 | 指针事件（拖动） | **做**。现在图片位置不建模、回写固定排布，真实文件中的图片位置保存即丢；拖动 + 坐标落盘是本批性价比最高的一项。 |
| P2 | 幻灯片切换效果 | 切换 → 效果（无 / 淡出 / 推进 / 擦除） | `p:transition`（`p:fade` / `p:push` / `p:wipe`，`advClick`） | Slide 扩 `transition`；写/读 `p:transition`；放映视图用 CSS 过渡近似 | 放映视图已有 | **做（降级：只做 4 种基础切换，无音效/时长/触发方式）**。真实 .pptx 常带切换，目前完全丢弃；基础切换可读可写、放映能感知。 |
| P3 | 幻灯片编号 | 无 | `p:ph type="sldNum"` + 域 | 占位符需要版式配合，生成包只有一套最简版式 | 无 | **不做**。页码依赖母版/版式占位符链，写不完整会让 PowerPoint 提示修复；等母版体系重建后再做。 |
| P4 | 表格 / 图表 / SmartArt | 无 | `p:graphicFrame`、`c:chart`、`dgm` | 不建模 | 无 | **不做**。图表需要独立 chart 部件与数据缓存，SmartArt 需要图形树；属于「新建图形对象」而非本批的编辑缺口。 |
| P5 | 动画与时序 | 无 | `p:timing` / `p:anim*` | 不建模 | 时间轴引擎 | **不做**。需要完整动画时间轴模型与播放器，纯浏览器内实现成本极高、收益边缘。 |
| P6 | 母版/主题保真 | 无 | `ppt/slideMasters`、`ppt/theme` | 生成包固定最小母版+一套版式+主题，原文件的母版细节不保留 | 无 | **降级（已知边界）**。真实文件的母版样式会在保存后归一为最小主题；彻底保真需母版模型，列入下一批。 |

已具备（本批前完成）：标题/要点/双栏、四种版式、页背景色、文字颜色与字号、图片、演讲者备注、幻灯片尺寸（16:9 / 4:3）、复制页、放映、查找替换。

## 4. 实施与验收清单

1. 文稿 W1 页边距：`docx.js` 读写 `pgMar`；`view-word.js` 页面组对话框 + 纸张内缩；`office_word_ext_probe.mjs` 往返 + 边界（负值/超大值规整）。
2. 文稿 W2 行距/段间距：`docx.js` 读写 `spacing`；视图段落组控件；探针覆盖 1 / 1.5 / 2 倍与 0–72pt。
3. 文稿 W3 项目符号/编号：`docx.js` 读写 `numbering.xml` + `numPr`；视图两个命令；探针覆盖 bullet/number 互转与无编号旧包零新增部件。
4. 表格 X1 行高：`xlsx.js` 读写 `row@ht`；视图行高命令；探针覆盖默认值不写、合法值往返。
5. 表格 X2 字体/字号：`xlsx.js` styles 读写 `rFonts`/`sz`；视图字体字号控件；探针覆盖中文字体名、字号 1–400 半磅边界。
6. 表格 X3 冻结落盘：`xlsx.js` 读写 `pane`；视图沿用现有冻结开关；探针覆盖 frozen/frozenSplit 与打开还原。
7. 表格 X4 合并单元格：Sheet `merges`；`xlsx.js` 读写 `mergeCells`；视图合并渲染 + 合并/取消合并；探针覆盖单区/多区/重叠规整与旧包兼容。
8. 演示 P1 图片定位：Slide 图片项扩 `x/y`；`pptx.js` 读写 `a:off`；视图拖动；探针覆盖坐标往返与越界规整。
9. 演示 P2 切换效果：Slide `transition`；`pptx.js` 读写 `p:transition`；视图切换下拉 + 放映过渡；探针覆盖 4 种效果与无效果旧包零新增元素。

每项完成后跑：`node dev/static-check.mjs`、`node --experimental-vm-modules dev/deep-check.mjs` 与全部 Office 探针（exit 0）；新增断言写进对应应用的 `office_*_ext_probe.mjs`。

## 5. 实施结果（2026-11-07）

| 分组 | 落地内容 | 主要探针 | 结果 |
| --- | --- | --- | --- |
| 文稿 W1 页边距 | `docx.js` 读写 `w:pgMar`（pt，0–288，默认 72）；视图页面组对话框，纸张内缩用 CSS 变量 | `office_word_ext_probe.mjs` | 54 通过 / 0 失败 |
| 文稿 W2 行距/段间距 | `docx.js` 读写 `w:spacing`（倍数 1/1.5/2，段前段后 0–72 pt）；视图段落组下拉 | 同上 + `office_docx_probe.mjs` | 通过 |
| 文稿 W3 项目符号/编号 | `docx.js` 读写 `w:numPr` + `word/numbering.xml`；视图两个命令，列表前缀渲染 | 同上 + `office_page_probe.mjs`（21） | 通过 |
| 表格 X1 行高 | `xlsx.js` 读写 `row@ht`（12–200 pt）；视图行高 +/−/默认 | `office_excel_ext_probe.mjs` | 69 通过 / 0 失败 |
| 表格 X2 字体/字号 | `xlsx.js` styles 读写 `rFonts`/`sz`；视图字体与字号下拉 | 同上 + `office_xlsx_probe.mjs`（110） | 通过 |
| 表格 X3 冻结落盘 | `xlsx.js` 读写 `pane`；视图沿用冻结开关 | 同上 + `office_xlsx_view_probe.mjs`（280） | 通过 |
| 表格 X4 合并单元格 | Sheet `merges`；`xlsx.js` 读写 `mergeCells`；视图合并渲染 + 合并/取消合并 | 同上 + `office_grid_logic_probe.mjs`（21） | 通过 |
| 演示 P1 图片定位 | Slide 图片项扩 `x/y`；`pptx.js` 读写 `a:off`（960×540 基准）；视图拖动 | `office_ppt_ext_probe.mjs` | 38 通过 / 0 失败 |
| 演示 P2 切换效果 | Slide `transition`；`pptx.js` 读写 `p:transition`；视图下拉 + 放映过渡 | 同上 + `office_ppt_view_probe.mjs`（223） | 通过 |
| 共享回归 | 保存链路 / 图片 / 常用功能 / 多窗 / 脏守卫 / 改名 / 图标 / 强调色 | `office_save_reopen_probe.mjs`（63）、`office_image_probe.mjs`（79）、`office_features_probe.mjs`（90）、`office_multi_window_probe.mjs`（37）、`office_dirty_guard_probe.mjs`（36）、`office_rename_probe.mjs`（12）、`office_icons_probe.mjs`（10）、`office_appearance_probe.mjs`（10） | 全部 exit 0 |
| 全局校验 | 静态与深度审计 | `node dev/static-check.mjs`、`node --experimental-vm-modules dev/deep-check.mjs` | 0 硬错误 / 0 提示 |

四语言文案：新增 62 键 × 4 份语言包（`zh-CN` / `en` / `ja-JP` / `cat`），并由 `office_features_probe.mjs` 扫描视图/脚本里全部 `t("…")` 字面键逐语言断言，缺键即失败（不再静默回退中文）。

已知降级（与第 1–3 章的「不做/降级做」结论一致，本批未变）：

- 文稿：表格 `w:tbl`、样式继承、脚注/批注/书签/域、分节多栏、超链接仍不建模；打开含这些元素的真实 `.docx` 后保存会丢失（写包从零重建）。
- 表格：边框、数据验证、条件格式、超链接/批注/多工作表引用不建模；图片锚点统一落在 A1 附近，不保留裁剪/旋转。
- 演示：表格/图表/SmartArt、动画时序不建模；母版与版式细节在保存后归一为最小母版 + 一套版式；图片不保留环绕/裁剪/旋转。

