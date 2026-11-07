/**
 * app-rules-check.mjs — 「应用禁用」与启动台拖拽落点的规则回归。
 *
 * 覆盖两类断言：
 * 1) 纯顺序逻辑：可见槽位 ↔ 权威数组下标、隐藏项在拖拽后保留原槽位；
 * 2) 静态约束：禁用后不进程序坞/启动台、启动台不可禁用、拖拽落点在清空躲闪快照之前计算。
 *
 * 运行：node dev/app-rules-check.mjs
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { slotToIndex, reorderKeepingHidden } from "../src/javascripts/core/visibleOrder.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

let passed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed += 1; return; }
    failures.push(`${name}${extra === undefined ? "" : ` — 实得 ${JSON.stringify(extra)}`}`);
}
function eq(name, actual, expected) {
    check(`${name}（期望 ${JSON.stringify(expected)}）`, actual === expected, actual);
}

/* ───────── 1. 可见槽位 → 权威下标 ───────── */

const app = (name, disabled = false) => ({ type: "app", name, disabled });
const isVisible = (it) => (it.type === "app" ? !it.disabled : (it.apps || []).some((n) => !n.disabled));

// 中间夹一个被禁用应用：它不占可见格，但仍在权威数组里
const withHidden = [app("A"), app("B", true), app("C")];
eq("隐藏居中：插到最前", slotToIndex(withHidden, 0, isVisible), 0);
eq("隐藏居中：插到 A/C 之间（落到隐藏项之后）", slotToIndex(withHidden, 1, isVisible), 2);
eq("隐藏居中：插到末尾", slotToIndex(withHidden, 2, isVisible), 3);

// 整个文件夹的成员都被禁用时不占格
const hiddenFolder = { type: "folder", name: "资料", apps: [app("X", true), app("Y", true)] };
const withFolder = [app("A"), hiddenFolder];
eq("隐藏文件夹不占可见格：插到前", slotToIndex(withFolder, 0, isVisible), 0);
eq("隐藏文件夹不占可见格：插到后", slotToIndex(withFolder, 1, isVisible), 2);

/* ───────── 2. 程序坞拖拽保留隐藏收藏位 ───────── */

const favorites = ["A", "B", "C"];
const hidden = (key) => key === "B";
eq(
    "拖拽后隐藏收藏仍在原槽位",
    reorderKeepingHidden(favorites, ["C", "A"], hidden).join(","),
    "C,B,A"
);
eq(
    "可见项数量对不上时不动数据",
    reorderKeepingHidden(favorites, ["C"], hidden).join(","),
    "A,B,C"
);

/* ───────── 3. 静态约束 ───────── */

const manifest = JSON.parse(read("mods/launchpad/manifest.json"));
eq("启动台标记为 system 应用", manifest.visibility && manifest.visibility.system, true);

const launchpad = read("mods/launchpad/script.js");
const dock = read("src/javascripts/dock.js");
const storeApi = read("src/javascripts/store-api.js");
const settingsPane = read("mods/system-settings/panes/plugins.js");
const appStore = read("mods/app-store/script.js");

check("启动台渲染跳过禁用应用", launchpad.includes("function visibleItems") && launchpad.includes("if (appEnabled(it.name))"));
check("启动台监听启用态变化", launchpad.includes('document.addEventListener("plugin-enabled-change"'));
check(
    "根网格落点在 clearDodge 之前计算",
    (() => {
        const start = launchpad.indexOf("// 根网格：命中判定");
        if (start === -1) return false;
        const slotAt = launchpad.indexOf("const slot = insertionIndexSnap", start);
        const clearAt = launchpad.indexOf("clearDodge();", slotAt);
        return slotAt > -1 && clearAt > slotAt;
    })()
);
check("根网格写回时保留隐藏项", launchpad.includes("moveItemToVisibleSlot(moving, globalVisibleSlot("));

check("程序坞收藏区过滤禁用应用", dock.includes("favorites.filter((name) => !isDisabledApp(name))"));
check("程序坞运行区过滤禁用应用", dock.includes("isAppRunning(name) && !isDisabledApp(name)"));
check("程序坞最近应用过滤禁用应用", dock.includes("!runningSet.has(name) && !isDisabledApp(name)"));
check("程序坞拖拽保留隐藏收藏", dock.includes("reorderKeepingHidden(favorites, keys, isDisabledApp)"));
check("程序坞监听启用态变化", dock.includes('document.addEventListener("plugin-enabled-change", syncRunningApps)'));

check("商店不再特判自身禁用", !storeApi.includes('id === SELF_ID'));
check("商店用 system 守卫拒绝禁用", storeApi.includes("!on && isSystemApp(id)"));
check("条目暴露可禁用位与原因", storeApi.includes("disableable: !system") && storeApi.includes("disableReason"));

check("设置的禁用按钮尊重 disableable", settingsPane.includes("entry.enabled && entry.disableable !== false"));
check("设置展示禁用原因", settingsPane.includes("entry.disableReason"));
check("App Store 的禁用按钮尊重 disableable", appStore.includes("e.enabled && e.disableable !== false"));

/* ───────── 4. 文件夹磁贴：几何与 App 图标逐项相等 + 浅色磨砂材质 ───────── */

const launchpadCss = read("mods/launchpad/style.css");

/** 取某个唯一选择器首次出现处的声明块（本项目 CSS 的块内没有嵌套大括号）。 */
function declBlock(selector) {
    const at = launchpadCss.indexOf(selector);
    if (at === -1) return "";
    const open = launchpadCss.indexOf("{", at);
    const close = launchpadCss.indexOf("}", open);
    if (open === -1 || close === -1) return "";
    return launchpadCss.slice(open + 1, close);
}

/** 从某条声明（标记）向前找最近的 {、向后找最近的 }，用于选择器列表共用的块。 */
function declAt(marker) {
    const at = launchpadCss.indexOf(marker);
    if (at === -1) return "";
    const open = launchpadCss.lastIndexOf("{", at);
    const close = launchpadCss.indexOf("}", at);
    if (open === -1 || close === -1) return "";
    return launchpadCss.slice(open + 1, close);
}

const tileBase = declAt("--lp-folder-fill:");
const tilePaint = declBlock(".launchpad .folder-tile::before {");
const sharedGeom = declBlock(".launchpad .container > img,");
const hoverBlock = declBlock(".launchpad .container:hover > img,");
const appIcon = declBlock(".launchpad .container img {");
const previewBase = declBlock(".launchpad .folder-preview {");
const previewImg = declBlock(".launchpad .folder-preview img {");
const labelBlock = declBlock(".launchpad .container p {");
const rootBlock = declBlock(".launchpad {");
const reduceBlock = declBlock('html[data-transparency="off"] .launchpad .folder-tile::before {');
const containerBase = declBlock(".launchpad .container {");

// 图标 PNG 的不透明内容占比：用 PowerShell/System.Drawing 对 15 枚内置图标取 alpha 包围盒实测，
// 结果 84.0%–84.8%（Finder/Safari/Photos/Keynote 均为 84.4%，Siri 80.4% 为特例）。
// 真机量到的「磁贴 85、图标画面 70」差的就是这圈透明边，不是磁贴尺寸错。
const ARTWORK_RATIO = 0.844;

check(
    "磁贴排版盒存在、无外描边、无外投影（不再像浮起的一张卡片）",
    tileBase.length > 0
    && tileBase.includes("border: 0")
    && tileBase.includes("box-shadow: none")
    && tileBase.includes("background: none")
    && !tileBase.includes("inset 0 0 0")
    && !tileBase.includes("0 6px 16px")
);
check(
    "排版盒尺寸显式且被 min/max 钳死（内容/网格轨道无法撑开）",
    tileBase.includes("inline-size: var(--lp-icon)")
    && tileBase.includes("block-size: var(--lp-icon)")
    && tileBase.includes("min-inline-size: 0")
    && tileBase.includes("min-block-size: 0")
    && tileBase.includes("max-inline-size: var(--lp-icon)")
    && tileBase.includes("max-block-size: var(--lp-icon)")
    && tileBase.includes("box-sizing: border-box")
    && tileBase.includes("aspect-ratio: auto")
);
check(
    "排版盒零内边距 / 零边框 / 零外边距（padding 不参与尺寸）",
    tileBase.includes("padding: 0")
    && tileBase.includes("margin: 0")
    && sharedGeom.includes("margin: 0")
);
check(
    "图标与磁贴不用 flex-basis（避免列向容器里 basis=高度 与 width 语义打架）",
    sharedGeom.includes("flex: none")
    && !sharedGeom.includes("flex: 0 0")
    && /width:\s*var\(--lp-icon\)/.test(appIcon)
    && /height:\s*var\(--lp-icon\)/.test(appIcon)
);
check(
    "预览层绝对定位且 inset: 0（不参与外框尺寸）",
    previewBase.includes("position: absolute")
    && previewBase.includes("inset: 0")
    && previewBase.includes("box-sizing: border-box")
);
check(
    "预览内边距/间距由 --lp-icon 推导，不写死 px",
    tileBase.includes("--lp-folder-pad: calc(var(--lp-icon)")
    && tileBase.includes("--lp-folder-gap: calc(var(--lp-icon)")
    && !/padding:\s*[\d.]+px/.test(tileBase)
    && previewBase.includes("padding: var(--lp-folder-pad)")
);
check(
    "预览小图标随单元格缩放且不溢出",
    /width:\s*100%/.test(previewImg) && /height:\s*100%/.test(previewImg) && previewImg.includes("object-fit: contain")
);
check("预览块整体垂直居中", previewBase.includes("align-content: center"));

// 涂装层：可见方块按图标内容的透明边内缩，与图标画面同尺寸；排版盒保持不变。
const paintInset = Number((tileBase.match(/--lp-folder-paint-inset:\s*calc\(var\(--lp-icon\)\s*\*\s*([\d.]+)\)/) || [])[1]);
check(
    `涂装内缩比例 ${paintInset} = (1 − 图标内容占比 ${ARTWORK_RATIO}) / 2`,
    Math.abs(paintInset - (1 - ARTWORK_RATIO) / 2) <= 0.002
);
check(
    "涂装层绝对定位、不写死尺寸、只有内高光（无外描边/外投影）",
    tilePaint.includes("position: absolute")
    && tilePaint.includes("inset: var(--lp-folder-paint-inset)")
    && !tilePaint.includes("inset 0 0 0")
    && !tilePaint.includes("0 6px 16px")
);
const icon = Number((launchpadCss.match(/--lp-icon:\s*(\d+)px/) || [])[1]);
const painted = icon * ARTWORK_RATIO;
check(
    `默认档：排版盒 ${icon}px，可见涂装 ${painted.toFixed(1)}px（≈ 图标不透明画面，不再大一圈）`,
    icon > 0 && Math.abs(painted - 70.9) <= 1.5
);
const previewInner = icon - 2 * Number((tileBase.match(/--lp-folder-pad:\s*calc\(var\(--lp-icon\)\s*\*\s*([\d.]+)\)/) || [])[1]) * icon;
check(
    `预览内容区 ${previewInner.toFixed(1)}px 完整落在涂装方块 ${painted.toFixed(1)}px 内`,
    previewInner > 0 && previewInner < painted
);

check(
    "标签上外边距与图标同源（两种格子的标签顶边由同一个规则决定）",
    labelBlock.includes("margin: 8px 0 0") && !declBlock(".launchpad .container p {").includes("position")
);
check("悬停规则同时覆盖图标与磁贴", hoverBlock.includes("transform: scale(1.07)"));
check("悬停绕同一中心缩放", sharedGeom.includes("transform-origin: center center"));
const cellGap = Number((launchpadCss.match(/--lp-cell:\s*calc\(var\(--lp-icon\)\s*\+\s*(\d+)px\)/) || [])[1]) / 2;
const expansion = icon * (Number((hoverBlock.match(/scale\(([0-9.]+)\)/) || [])[1]) - 1) / 2;
check(
    `悬停外扩 ${expansion.toFixed(2)}px < 行内留白 ${cellGap}px、标签间距 8px（不会盖住邻格/标签）`,
    expansion < cellGap - 0.5 && expansion < 8 - 0.5
);

const measureScript = read("dev/launchpad-folder-measure.js");
const measureScriptHas = (text) => measureScript.includes(text);
check(
    "测量脚本分别量排版盒与图标不透明画面，并标注 hover 影响",
    measureScriptHas("offsetWidth")
    && measureScriptHas(":hover")
    && measureScriptHas('"--lp-folder-artwork"')
    && measureScriptHas("getImageData")
    && measureScriptHas("getBoundingClientRect")
);
// ── 材质：浅色半透明叠在根表面模糊上；最坏情况（深色/彩色壁纸）仍为浅灰 ──
const rgba = (text) => {
    const m = (text || "").match(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\s*\)/);
    return m ? { rgb: [+m[1], +m[2], +m[3]], a: +m[4] } : null;
};
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const composite = (fg, a, bg) => fg.map((v, i) => v * a + bg[i] * (1 - a));

const fill = rgba((tileBase.match(/--lp-folder-fill:\s*(rgba\([^)]*\))/) || [])[1]);
const scrim = rgba((rootBlock.match(/background:\s*(rgba\([^)]*\))/) || [])[1]);
check("磁贴使用浅色低透明填充（不再是中灰实色）", !!fill && fill.a <= 0.5 && fill.rgb.every((v) => v >= 240));
check("启动台根表面仍提供模糊（磁贴背后即模糊后的壁纸）",
    launchpadCss.includes("--surface-blur: var(--surface-blur-4)")
    && !tileBase.includes("backdrop-filter")
);

if (fill && scrim) {
    // 壁纸采样：深色 / 彩色 / 浅色；先过根表面 scrim，再叠磁贴填充。
    const wallpapers = {
        dark: [42, 32, 58],
        colorful: [88, 44, 130],
        light: [234, 230, 240],
    };
    const seen = {};
    for (const [name, wp] of Object.entries(wallpapers)) {
        const backdrop = composite(scrim.rgb, scrim.a, wp);
        seen[name] = luma(composite(fill.rgb, fill.a, backdrop));
    }
    const oldDark = luma(composite([104, 104, 112], 0.58, composite(scrim.rgb, scrim.a, wallpapers.dark)));
    check(
        `最坏情况亮度：深色 ${seen.dark.toFixed(1)} / 彩色 ${seen.colorful.toFixed(1)} / 浅色 ${seen.light.toFixed(1)}（0–255）`,
        seen.dark >= 105 && seen.colorful >= 100 && seen.light >= 185 && seen.light <= 230
    );
    check(
        `深色壁纸上比旧中灰材质亮 ${(seen.dark - oldDark).toFixed(1)}（≥ 35）`,
        seen.dark - oldDark >= 35
    );
}

const solid = (tileBase.match(/--lp-folder-fill-solid:\s*(#[0-9a-fA-F]{6})/) || [])[1];
const solidRgb = solid ? [1, 3, 5].map((i) => parseInt(solid.slice(i, i + 2), 16)) : [];
check(
    "降低透明度时退回浅色实底（不随深色主题变深）",
    !!solid && luma(solidRgb) >= 225 && reduceBlock.includes("var(--lp-folder-fill-solid)")
    && !reduceBlock.includes("--surface-panel")
);

// 成员数 → 行列数：成员少时不留整块空位，3×3 只在 7–9 枚时使用。
// 单行/两行用 auto 行高，配合 align-content:center 保证图标块垂直居中。
const previewLayouts = [
    ["2", "repeat(2, 1fr)", "auto"],
    ["3", "repeat(3, 1fr)", "auto"],
    ["4", "repeat(2, 1fr)", "repeat(2, 1fr)"],
    ["5", "repeat(3, 1fr)", "repeat(2, auto)"],
    ["6", "repeat(3, 1fr)", "repeat(2, auto)"],
    ["7", "repeat(3, 1fr)", "repeat(3, 1fr)"],
    ["8", "repeat(3, 1fr)", "repeat(3, 1fr)"],
    ["9", "repeat(3, 1fr)", "repeat(3, 1fr)"],
];
for (const [count, cols, rows] of previewLayouts) {
    const block = declBlock(`.launchpad .folder-preview[data-count="${count}"]`);
    check(
        `成员数 ${count}：列 ${cols} / 行 ${rows}`,
        block.length > 0
        && block.includes(`grid-template-columns: ${cols}`)
        && block.includes(`grid-template-rows: ${rows}`),
        block
    );
}

check("预览成员数写在内层容器上", launchpad.includes("preview.dataset.count = String(previews.length)"));
check("外框不再携带成员数（尺寸与成员数解耦）", !launchpad.includes("tile.dataset.count"));
check("单成员文件夹摊平成普通应用（不会出现 1 枚的空磁贴）", launchpad.includes("live.length === 1"));
check(
    "对账时只剩一个成员的文件夹同样解散为应用",
    launchpad.includes("if (it.apps.length === 1)") && launchpad.includes("cleaned.push({ type: \"app\", name: it.apps[0] })")
);
check(
    "拖拽幽灵沿用同一磁贴尺寸",
    /\.launchpad \.drag-ghost \.folder-tile \{[^}]*inline-size: var\(--lp-icon\)/.test(launchpadCss)
);

/* ───────── 5. 拖拽全程不得出现矩形底色（桌面框选 / 选中类 / 占位格） ───────── */

const desktopJs = read("src/javascripts/desktop.js");

// 根因：桌面框选把「任何 .container」都当成桌面空白，而启动台图标格用的是同一个类名。
// 于是在启动台按下图标 → 桌面在磨砂背景后画出 .desktop-lasso 矩形，拖拽结束还会留下选中态。
check(
    "桌面框选只认属于桌面的 .container（启动台图标格不再触发框选）",
    desktopJs.includes("const inDesktop = (el) => !!desktop && desktop.contains(el);")
    && desktopJs.includes('target.classList.contains("container") && inDesktop(target)')
);
check("框选矩形在 mouseup 时移除（不残留）", desktopJs.includes("lasso.rectEl.remove()"));

const cssRules = [...launchpadCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1].trim(), body: m[2].replace(/\s+/g, " ") }));
const dragRules = cssRules.filter((r) => /\.(dragging|merge-hint|dodging|drag-ghost|pop-in|flip)\b/.test(r.selector));
check(
    "拖拽 / 占位 / 幽灵 / 放置动画的规则都不画矩形底色",
    dragRules.length > 0
    && dragRules.every((r) => !/(^|;)\s*(background|outline|box-shadow|border)\s*:/.test(r.body))
);
check(
    "图标格本身没有底色与焦点环（指针拖动无可显示的选中框，键盘焦点仍走系统默认环）",
    containerBase.length > 0 && !/background|outline|box-shadow/.test(containerBase)
);
check(
    "拖拽代码只加位移/提示类，不加选中/激活/焦点类",
    !launchpad.includes('cell.classList.add("selected"')
    && !launchpad.includes('cell.classList.add("active"')
    && !launchpad.includes('cell.classList.add("focus"')
);
const popFrames = launchpadCss.slice(launchpadCss.indexOf("@keyframes cell-pop"), launchpadCss.indexOf("@keyframes jiggle"));
check(
    "放置动画只做 transform（落定瞬间不会闪一下底色）",
    popFrames.length > 0 && !/background|box-shadow|opacity/.test(popFrames)
);
check(
    "拖拽幽灵与磁贴都不挂 backdrop-filter（不触发亚克力 + transform 退化）",
    !declBlock(".launchpad .drag-ghost {").includes("backdrop-filter")
    && !tileBase.includes("backdrop-filter")
);


/* ───────── 结果 ───────── */

const unverified = [
    "真实 getBoundingClientRect：Node 无布局引擎，本检查只验证 CSS 契约；真机请跑 dev/launchpad-folder-measure.js",
    "真机曾量到磁贴 85 / 图标画面 70：已由图标 PNG 透明边（实测 84.0%–84.8%）解释；修后需再量一次确认可见方块≈图标画面",
    "键盘焦点态：图标格不可聚焦，指针拖动不会触发焦点环；键盘导航外观需真机确认",
];

if (failures.length) {
    console.error(`\napp-rules-check: ${failures.length} 项失败，${passed} 项通过`);
    failures.forEach((f) => console.error(`  ✗ ${f}`));
    process.exit(1);
}
console.log(`app-rules-check: ${passed} 项全部通过`);
unverified.forEach((note) => console.log(`  ⚠ 未验证：${note}`));
