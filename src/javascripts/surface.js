/**
 * surface.js — 亚克力表面：系统分配的模糊等级 + 强制可读文字色 + 墙纸着色联动
 *
 * 要解决的问题：模糊值此前是各处硬编码的私有数字（站内实测 8/10/20/30/40/50px，
 * 插件侧还多出 45/60/78px，共 83 处 `backdrop-filter`）。于是「让用户调模糊」
 * 只能一个一个改样式表；更糟的是文字色也各写各的（#333 / rgba(0,0,0,.85) /
 * 硬白），壁纸一旦换成深色或用户开了着色，那些写死的文字就糊成一片看不见。
 *
 * 本模块把三件事收成一套令牌，全部挂在 <html> 上，样式表只引用不解释：
 *
 * 1. **模糊等级**（`appearance.blurLevel`，0–4）：等级只决定一个基准步长
 *    `--surface-blur-unit`，各表面按自己的角色取 `--surface-blur-1..5`
 *    （= unit × 1 / 1.75 / 2.75 / 4 / 6.5）。用户调等级时所有表面**等比**变化，
 *    谁也不需要被单独改一遍；`--surface-blur` 是「本表面的模糊」中间层，
 *    插件想自定义就在元素上覆盖它（可以，但不推荐，见 dev/devdoc/os-api.md）。
 * 2. **可读文字色**（`--surface-text`）：只允许黑或白。由「壁纸主色 → 色相偏移 →
 *    着色浓度 → 明暗主题 → 显示器亮度」逐层合成出表面背后的真实底色，再按 WCAG
 *    对比度取黑白里赢的那个。壁纸换、着色开关动、等级动、主题动、夜间护眼动，
 *    都会重算 —— 文字色不是设置项，是**推导结果**，所以不暴露给用户调。
 *    推导按「文字压在哪一层」分两套：`--surface-text*` 是主题面板（菜单、弹层都不吃墙纸色），
 *    `--surface-text-wallpaper*` 是背后就是墙纸的表面 —— 全屏浮层（启动台、图片预览、锁屏）
 *    以及开着墙纸着色时的侧栏与控制中心。共用一套必然在某个组合下推出错误颜色，
 *    见下方 REPRESENTATIVE_ALPHA 的实测记录。
 * 3. **色调调节**（`appearance.tintStrength` / `appearance.tintHue`）：与
 *    `appearance.wallpaper.tint`（允许墙纸为主窗口着色）绑定 —— 开关关掉时，
 *    浓度与色相滑块禁用且不参与合成，避免「界面在动、其实没生效」的假设置。
 *
 * 依赖方向：surface.js → settings.js（读设置）与 log.js（记日志）；它对 wallpaper.js 只有
 * 「读同一批自定义属性」这一层耦合（--wallpaper-tint-rgb / --window-tint-rgb 由那边写），
 * 不 import 它，所以壁纸与外观两侧都不会与本模块成环。采样与原始令牌（--wallpaper-tint-*）
 * 仍归 wallpaper.js；本模块只负责「怎么用」。
 */

import { settings } from "./settings.js";
import { log } from "./log.js";

/** 来源标签（进日志用）。 */
const SOURCE = "kernel/surface";

/** 模糊等级：0 关闭，4 最糊。步长单位是 px。 */
const BLUR_LEVELS = [
    { value: 0, label: "关闭", unit: 0 },
    { value: 1, label: "极轻", unit: 4 },
    { value: 2, label: "轻柔", unit: 8 },
    { value: 3, label: "标准", unit: 12 },
    { value: 4, label: "浓重", unit: 18 },
];

/**
 * 各角色相对基准步长的倍数。
 * 第 5 档（×6.5）是被真实素材逼出来的：启动台展开态原来是 78px，
 * 只有四档时要么把它压进第 4 档（78 → 48，明显变薄），要么和 45px 并档（丢层次）。
 * 加一档之后 45/78 都能在当前等级下原位表达，等级 3 时分别得 33px 与 78px。
 */
const ROLE_STEPS = [1, 1.75, 2.75, 4, 6.5];

/**
 * 主题面板的固有色（站内浅色面板基本都是 246 系，深色是 30 系）。
 * 一个常量两种用途：着色时它是「墙纸色被掺向哪边」的中性终点，着色关闭时它本身就是表面底色。
 */
const NEUTRAL = { light: [246, 246, 246], dark: [30, 30, 30] };

/**
 * 典型亚克力表面的自身浓度（文字色推导的代表值）。
 * 关键：全局 --surface-text 要判定的不是「墙纸有多暗」，而是「文字真正所在的那层面板有多暗」。
 * 菜单 / 弹层 / 提示条这些表面**不参与墙纸着色**（它们的背景始终是主题面板色），
 * 拿墙纸底色去推全局文字色，就会在开着色的浅色主题下推出白字压在浅面板上 —— 实测 95/107 个
 * 文字节点对比度掉到 3:1 以下。
 *
 * 于是推导按「文字压在哪一层」分两套，各出一组令牌：
 * - `--surface-text*`（全局默认）：主题面板色以 REPRESENTATIVE_ALPHA 压在有效底色上 —— 菜单、弹层。
 * - `--surface-text-wallpaper*`：背后就是墙纸的表面。除全屏浮层（启动台、图片预览、锁屏），
 *   **开着墙纸着色时的侧栏与控制中心也算这一类**：那些表面的背景是
 *   `rgba(墙纸色, 固有浓度 × 着色浓度)`，透出来的又是同一支墙纸，合成后仍≈墙纸色。
 *   样式表在着色规则里把三个属性指过来即可（自定义属性沿继承树生效，整棵子树跟着换），
 *   不需要 JS 逐个登记。逐元素登记的表面（`apply()` / `syncText()`）走 `surfaceBackdrop()`
 *   读元素自己的 background-color 精确合成，优先级高于以上两套。
 */
const REPRESENTATIVE_ALPHA = 0.6;

/** 已注册需要局部文字色的元素。 */
const surfaces = new Set();
const subscribers = new Set();

/** 采样/主题/等级变动很快连环触发，重算合到一帧里做一次。 */
let queued = false;
let lastBase = null;

/** 解析 `#rgb` / `#rrggbb` / `r, g, b` / `rgba(...)` 中的任意一种为三通道数组。 */
function toRgb(input) {
    if (Array.isArray(input)) return [Number(input[0]) || 0, Number(input[1]) || 0, Number(input[2]) || 0];
    const text = String(input || "").trim();
    if (text.startsWith("#")) {
        const hex = text.slice(1);
        const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
        return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0);
    }
    const nums = text.match(/-?\d+(\.\d+)?/g);
    if (!nums) return [0, 0, 0];
    return [Number(nums[0]) || 0, Number(nums[1]) || 0, Number(nums[2]) || 0];
}

const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));
const triple = (rgb) => `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`;

/** sRGB 相对亮度（WCAG 定义，含 gamma）。 */
function luminance(rgb) {
    const ch = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG 对比度。 */
function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 前景按 alpha 压到背景上。 */
function composite(fg, bg, alpha) {
    return [0, 1, 2].map((i) => clamp255(fg[i] * alpha + bg[i] * (1 - alpha)));
}

/** 色相旋转（HSL 里改 H，保留 S/L），范围 ±180。 */
function rotateHue(rgb, degrees) {
    if (!degrees) return rgb.slice();
    const [r, g, b] = rgb.map((v) => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return rgb.slice();
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (((h / 6) * 360 + degrees) % 360 + 360) % 360 / 360;
    const hue2rgb = (p, q, t) => {
        let tt = t;
        if (tt < 0) tt += 1;
        if (tt > 1) tt -= 1;
        if (tt < 1 / 6) return p + (q - p) * 6 * tt;
        if (tt < 1 / 2) return q;
        if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [clamp255(hue2rgb(p, q, h + 1 / 3) * 255), clamp255(hue2rgb(p, q, h) * 255), clamp255(hue2rgb(p, q, h - 1 / 3) * 255)];
}

/** 当前明暗主题（`auto` 由 appearance.js 解析成 light/dark 写在 data-theme 上）。 */
function currentTheme() {
    return document.documentElement.dataset.themeResolved
        || document.documentElement.getAttribute("data-theme")
        || "light";
}

/** 当前模糊等级（数字，容错回落到标准档）。 */
function currentLevel() {
    const value = Number(settings.get("appearance.blurLevel", 3));
    return BLUR_LEVELS.some((l) => l.value === value) ? value : 3;
}

/**
 * 表面背后的有效底色：明暗主题中性色 <- 墙纸主色（色相偏移 + 浓度）<- 亮度压暗。
 * 着色关闭时返回中性色，文字色推导与视觉效果因此天然一致，不需要各面板自己判断。
 * 中间量一并返回：`sampled` 是原始采样、`hue` 是色相偏移，样式表侧的
 * --tint-adjusted-rgb 要用它们，而不是在外部再算一遍（两处算法迟早分叉）。
 * `panel` 是「文字真正压在上面的那层主题面板色」—— 全局 --surface-text 判定用它，
 * 不用 rgb：开着色的时候 rgb 是墙纸色，而菜单根本不吃着色。
 * @returns {{rgb:number[], panel:number[], tinted:boolean, sampled:number[], hue:number, strength:number}} 底色与推导输入
 */
function effectiveBase() {
    const theme = currentTheme();
    const neutral = NEUTRAL[theme] || NEUTRAL.light;
    const tintOn = settings.get("appearance.wallpaper.tint", false) === true;
    const strength = Math.max(0, Math.min(1, Number(settings.get("appearance.tintStrength", 1)) || 0));
    const hue = Number(settings.get("appearance.tintHue", 0)) || 0;
    const sampled = toRgb(document.documentElement.style.getPropertyValue("--wallpaper-tint-rgb")
        || document.documentElement.style.getPropertyValue("--window-tint-rgb")
        || getCssVar("--tint-rgb")
        || neutral);
    let base = neutral;
    if (tintOn && strength > 0) {
        base = composite(rotateHue(sampled, hue), neutral, strength);
    }
    // 文字真正压在上面的那层：主题面板色以代表浓度叠在（着色后的）底色之上。
    const panel = composite(neutral, base, REPRESENTATIVE_ALPHA);
    return {
        rgb: applyScreen(base),
        panel: applyScreen(panel),
        tinted: tintOn && strength > 0,
        sampled,
        hue,
        strength,
    };
}

/**
 * 屏幕层：显示器亮度是压在整屏上的 multiply 层（等效于把底色按比例压暗），
 * 夜间护眼再叠一层暖色。任何底色在参与文字判定前都要过这里，否则「亮度调最低 +
 * 开夜间」会让判定停在错误的一侧。
 * @param {number[]} rgb 未经屏幕层处理的底色
 * @returns {number[]} 屏幕上真正呈现的底色
 */
function applyScreen(rgb) {
    const brightness = Math.max(0.2, Math.min(1, Number(settings.get("display.brightness", 0.85)) || 0.85));
    const shift = settings.get("display.nightShift", false) === true
        ? Math.min(0.6, Number(settings.get("display.nightShiftIntensity", 0.25)) || 0) : 0;
    const dim = 0.55 + 0.45 * brightness;
    const dark = rgb.map((v) => clamp255(v * dim));
    return shift ? composite([255, 170, 90], dark, shift) : dark;
}

/** 样式表上某个自定义属性的当前值（含 <html> 内联与继承）。 */
function getCssVar(name) {
    try {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch {
        return "";
    }
}

/**
 * 给定底色，返回该用的文字色 —— **只有黑与白两种可能**。
 * 取 WCAG 对比度更高的那个；平局偏黑（站内浅色表面居多）。
 * @param {number[]|string|{r:number,g:number,b:number}} bg 底色
 * @returns {"#000"|"#fff"} 文字色
 */
function textColorFor(bg) {
    const rgb = toRgb(bg);
    return contrast([255, 255, 255], rgb) > contrast([0, 0, 0], rgb) ? "#fff" : "#000";
}

/**
 * 由底色生成三档文字色令牌值。
 * 三档必须同源：只换主字色、弱化档仍指全局，就会出现「白主字 + 半透明黑副字」
 * 这种在同一块表面上自相矛盾的配色（登记过的表面尤其容易踩到）。
 * @param {number[]} rgb 有效底色
 * @returns {Record<string,string>} 四个自定义属性的值
 */
function inkTiers(rgb) {
    const text = textColorFor(rgb);
    const ink = text === "#fff" ? "255, 255, 255" : "0, 0, 0";
    return {
        "--surface-text": text,
        "--surface-text-rgb": ink,
        "--surface-text-secondary": `rgba(${ink}, .70)`,
        "--surface-text-tertiary": `rgba(${ink}, .48)`,
    };
}

/**
 * 「背景就是墙纸」的表面（启动台、图片预览、锁屏）专用的底色推导。
 * 这些表面下面不是主题面板色而是墙纸本身加一层薄压暗，所以不能共用按主题中性色
 * 算出的全局 --surface-text —— 浅色主题下那是黑字，压在深色墙纸上直接看不清。
 * @returns {number[]} 墙纸有效底色
 */
function wallpaperBase() {
    const base = effectiveBase();
    // 墙纸上的浮层不掺中性色：着色只体现为「色相偏移后的墙纸色」，浓度由各表面自己决定。
    const raw = base.tinted ? rotateHue(base.sampled, base.hue) : base.sampled.slice();
    return applyScreen(raw);
}

/** 把令牌写进 <html>，并把局部文字色发给注册过的元素。 */
function writeTokens() {
    const root = document.documentElement;
    const level = currentLevel();
    const unit = (BLUR_LEVELS.find((l) => l.value === level) || BLUR_LEVELS[3]).unit;
    root.dataset.blur = String(level);
    root.style.setProperty("--surface-blur-unit", `${unit}px`);
    ROLE_STEPS.forEach((step, index) => {
        root.style.setProperty(`--surface-blur-${index + 1}`, unit ? `calc(${unit}px * ${step})` : "0px");
    });
    root.style.setProperty("--surface-blur", "var(--surface-blur-3)");
    root.style.setProperty("--tint-strength", String(Math.max(0, Math.min(1, Number(settings.get("appearance.tintStrength", 1)) || 0))));
    root.style.setProperty("--surface-blur-role", String(level));

    const base = effectiveBase();
    lastBase = base;
    // 全局档判定的是「主题面板上」的可读性：菜单 / 弹层 / 提示条都不吃墙纸色。
    Object.entries(inkTiers(base.panel)).forEach(([name, value]) => root.style.setProperty(name, value));
    // 第二套：背后就是墙纸的表面 —— 全屏浮层（启动台、预览、锁屏）**以及开着墙纸着色时的
    // 侧栏 / 控制中心**（着色后的表面 ≈ 墙纸色，因为面板透明度本身就是墙纸色 + 底下透出来的
    // 同一支墙纸色）。样式表用一条 `--surface-text: var(--surface-text-wallpaper)` 指过来。
    const onWallpaper = wallpaperBase();
    const wallpaperInk = inkTiers(onWallpaper);
    Object.entries(wallpaperInk).forEach(([name, value]) => root.style.setProperty(name.replace("--surface-text", "--surface-text-wallpaper"), value));
    // 墙纸档的黑白结论还要额外暴露成一个属性：菜单栏右侧那些图标是 fill="white" 的单色 SVG，
    // 自定义属性换不掉图片里的颜色，只能靠 CSS 按档位补一条 filter: invert(1)（见 finderbar.css）。
    root.dataset.wallpaperInk = wallpaperInk["--surface-text"] === "#fff" ? "white" : "black";
    // 派生后的墙纸色给样式表用：只旋转色相、不掺中性色 —— 浓度由各表面自己的
    // calc(alpha * var(--tint-strength)) 决定，掺两次会把表面调成灰糊。
    // 着色关闭时写回原始采样值，让 --tint-rgb 的回退链等价于迁移前（不引入新色偏）。
    const adjusted = base.tinted ? rotateHue(base.sampled, base.hue) : base.sampled;
    root.style.setProperty("--tint-adjusted-rgb", triple(adjusted));
    root.style.setProperty("--tint-adjusted-color", `rgb(${triple(adjusted)})`);
    surfaces.forEach((el) => {
        if (!el.isConnected) { surfaces.delete(el); return; }
        const over = el.dataset.surfaceOver === "wallpaper" ? onWallpaper : base.rgb;
        Object.entries(inkTiers(surfaceBackdrop(el, over))).forEach(([name, value]) => el.style.setProperty(name, value));
    });
    // 订阅者必须在令牌写完后才收到通知：早一步它们读到的是旧 --surface-text，
    // 界面上就表现为「改完设置，预览颜色慢半拍」。
    const snapshot = {
        base: triple(base.rgb),
        panel: triple(base.panel),
        text: root.style.getPropertyValue("--surface-text"),
        wallpaperBase: triple(onWallpaper),
        wallpaperText: root.style.getPropertyValue("--surface-text-wallpaper"),
        level,
        tinted: base.tinted,
    };
    subscribers.forEach((fn) => {
        try { fn(snapshot); } catch (err) { log.warn(SOURCE, "表面订阅者抛错", err); }
    });
}

/**
 * 单个表面的有效底色：把它自己的 background-color（含 alpha）压在全局底色上。
 * @param {HTMLElement} el 表面元素
 * @param {number[]} baseRgb 全局有效底色
 * @returns {number[]} 该表面的实际底色
 */
function surfaceBackdrop(el, baseRgb) {
    let bg = baseRgb;
    try {
        const color = getComputedStyle(el).backgroundColor;
        const nums = color.match(/-?\d+(\.\d+)?/g);
        if (nums && nums.length >= 4) {
            const alpha = Number(nums[3]);
            if (Number.isFinite(alpha) && alpha > 0 && alpha < 1) {
                bg = composite([Number(nums[0]), Number(nums[1]), Number(nums[2])], baseRgb, alpha);
            } else if (alpha >= 1 && nums.length >= 3) {
                bg = [Number(nums[0]), Number(nums[1]), Number(nums[2])];
            }
        }
    } catch { /* 元素已脱离文档或样式不可读：退回全局底色，不抛 */ }
    return bg;
}

/**
 * 排到下一帧统一重算（壁纸解码、开关连点都不该触发多次全表写入）。
 * 隐藏标签页里 requestAnimationFrame 会被暂停（实测：改完等级令牌一动不动），
 * 所以 document.hidden 时改用 setTimeout —— 壁纸主色是异步采样回来的，
 * 采样完成那一刻页面很可能正是后台状态，令牌必须照样落地。
 */
function scheduleRefresh() {
    if (queued) return;
    queued = true;
    const run = () => { queued = false; writeTokens(); };
    if (typeof requestAnimationFrame === "function" && document.visibilityState !== "hidden") requestAnimationFrame(run);
    else setTimeout(run, 16);
}

const surface = {
    /** 等级清单（供设置面板渲染下拉/滑块说明）。 */
    levels: () => BLUR_LEVELS.map((l) => ({ ...l })),

    /** 当前等级数字。 */
    getLevel: currentLevel,

    /**
     * 设置模糊等级（写设置项，真正的落地由设置中枢回调 apply 完成）。
     * @param {number} level 0–4
     * @returns {boolean} 是否生效
     */
    setLevel(level) {
        return settings.set("appearance.blurLevel", Number(level), { source: "surface" }).ok;
    },

    /**
     * 该用哪个模糊档：返回可直接写进样式的令牌引用。
     * @param {number} role 角色 1–5（越大越糊，5 是启动台展开这类全屏重素材）
     * @returns {string} CSS 值
     */
    token(role = 3) {
        // 不能用 `Number(role) || 3`：0 是合法入参（调用方想要最轻的一档），
        // 布尔假值判断会把 0 悄悄当成缺省，返回最重的第 3 档。
        const raw = Number(role);
        const n = Number.isFinite(raw) ? raw : 3;
        return `var(--surface-blur-${Math.max(1, Math.min(ROLE_STEPS.length, Math.round(n)))})`;
    },

    /**
     * 把元素登记为亚克力表面：局部文字色按它自己的底色算，并随任何上游变化重算。
     * 不登记也能拿到全局 `--surface-text`（大多数样式表路径就是这条）。
     * @param {HTMLElement} el 表面元素
     * @param {{role?:number, blurPx?:number, over?:"panel"|"wallpaper"}} [opts]
     *        role=角色档（1–5）；blurPx 仅用于「插件自行调节」的逃生舱；
     *        over="wallpaper" 表示这块表面的背景就是墙纸（全屏浮层、启动台、预览），
     *        推导文字色时不能用主题中性色，否则浅色主题下会推出黑字压在深墙纸上。
     * @returns {Function} 取消登记
     */
    apply(el, opts = {}) {
        if (!el || !el.style) return () => { };
        if (opts.role) el.style.setProperty("--surface-blur", surface.token(opts.role));
        // 逃生舱：直接写像素值。API 不拦，但样式表里就不该再出现裸 px（static-check 会拦）。
        if (opts.blurPx !== undefined && opts.blurPx !== null) {
            el.style.setProperty("--surface-blur", `${Number(opts.blurPx) || 0}px`);
        }
        if (opts.over === "wallpaper") el.dataset.surfaceOver = "wallpaper";
        surfaces.add(el);
        scheduleRefresh();
        return () => surfaces.delete(el);
    },

    /** 释放全部登记（面板销毁时调用；令牌本身留在 <html> 上）。 */
    releaseAll() {
        surfaces.clear();
    },

    /** 底色 + 是否着色（设置面板做预览、插件做自检用）。 */
    effectiveBase,

    /**
     * 当前文字色。
     * @param {"panel"|"wallpaper"} [scope] 主题面板表面（菜单/弹层）取 "panel"；
     *        背后就是墙纸的表面取 "wallpaper" —— 开着墙纸着色时的侧栏、控制中心也算这一类。
     * @returns {string} `#000` 或 `#fff`
     */
    currentTextColor(scope = "panel") {
        const name = scope === "wallpaper" ? "--surface-text-wallpaper" : "--surface-text";
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#000";
    },

    /** 任意底色该配黑字还是白字。 */
    textColorFor,

    /**
     * 强制把某个元素内所有文本的 `--surface-text` 补齐 —— 供面板在自建深色/浅色浮层时调用。
     * @param {HTMLElement} el 元素
     * @returns {string} 计算出的文字色
     */
    syncText(el) {
        if (!el || !el.style) return "#000";
        const over = el.dataset.surfaceOver === "wallpaper" ? wallpaperBase() : (lastBase || effectiveBase()).rgb;
        const tiers = inkTiers(surfaceBackdrop(el, over));
        Object.entries(tiers).forEach(([name, value]) => el.style.setProperty(name, value));
        return tiers["--surface-text"];
    },

    /**
     * 订阅重算（等级 / 着色 / 主题 / 壁纸 / 亮度 / 夜间护眼 任一变化都会来）。
     * @param {Function} fn fn({base, text, wallpaperBase, wallpaperText, level, tinted})
     * @returns {Function} 退订
     */
    subscribe(fn) {
        if (typeof fn !== "function") return () => { };
        subscribers.add(fn);
        return () => subscribers.delete(fn);
    },

    /** 立即重算（外部已知底层变了、不想等下一帧时用）。 */
    refresh: writeTokens,

    /** 诊断快照，供「调试」面板与自检使用。 */
    stats() {
        const base = lastBase || effectiveBase();
        const onWallpaper = wallpaperBase();
        return {
            level: currentLevel(),
            unit: (BLUR_LEVELS.find((l) => l.value === currentLevel()) || BLUR_LEVELS[3]).unit,
            roles: ROLE_STEPS.length,
            base: triple(base.rgb),
            panel: triple(base.panel),
            tinted: base.tinted,
            text: textColorFor(base.panel),
            wallpaperBase: triple(onWallpaper),
            wallpaperText: textColorFor(onWallpaper),
            surfaces: surfaces.size,
            contrastWhite: Math.round(contrast([255, 255, 255], base.panel) * 100) / 100,
            contrastBlack: Math.round(contrast([0, 0, 0], base.panel) * 100) / 100,
        };
    },
};

/** 注册本模块自己的设置项（owner 即取值范围权威）。 */
function defineSettings() {
    settings.defineMany([
        {
            key: "appearance.blurLevel", type: "number", default: 3, min: 0, max: 4, step: 1,
            values: [0, 1, 2, 3, 4], valuesLabel: BLUR_LEVELS.map((l) => l.label),
            control: "segmented", pane: "appearance", group: "外观", order: 45,
            label: "模糊等级",
            apply: () => scheduleRefresh(),
        },
        {
            key: "appearance.tintStrength", type: "number", default: 1, min: 0, max: 1, step: 0.05,
            control: "slider", format: "percent", pane: "appearance", group: "外观", order: 51,
            label: "着色浓度",
            requires: "appearance.wallpaper.tint",
            apply: () => scheduleRefresh(),
        },
        {
            key: "appearance.tintHue", type: "number", default: 0, min: -60, max: 60, step: 5,
            control: "slider", units: "°", pane: "appearance", group: "外观", order: 52,
            label: "色调偏移",
            requires: "appearance.wallpaper.tint",
            apply: () => scheduleRefresh(),
        },
    ]);
}

/** 订阅一切会影响底色推导的信号。 */
function bindSignals() {
    const watched = new Set([
        "appearance.blurLevel", "appearance.tintStrength", "appearance.tintHue",
        "appearance.wallpaper.tint", "appearance.theme", "display.brightness",
        "display.nightShift", "display.nightShiftIntensity", "appearance.transparency",
    ]);
    document.addEventListener("settings-changed", (event) => {
        const key = event.detail && event.detail.key;
        if (!key || watched.has(key)) scheduleRefresh();
    });
    // 壁纸主色是异步采样的：--wallpaper-tint-rgb 落地的那一刻才发 wallpaper-tint-change，
    // 这是「颜色真的换了」的唯一可靠信号（wallpaper-change 早于采样完成，拿它刷新只能读到上一张）。
    window.addEventListener("wallpaper-tint-change", scheduleRefresh);
    window.addEventListener("wallpaper-change", scheduleRefresh);
    window.addEventListener("appearance-tint-change", scheduleRefresh);
    window.addEventListener("appearance-theme-change", scheduleRefresh);
    window.addEventListener("display-brightness-change", scheduleRefresh);
}

/**
 * 初始化：注册设置项 -> 写第一帧令牌 -> 挂信号。
 * @returns {{level:number, text:string, surfaces:number}} 初始快照
 */
export function initSurface() {
    defineSettings();
    writeTokens();
    bindSignals();
    const snapshot = surface.stats();
    log.info(SOURCE, `表面系统就绪：模糊等级 ${snapshot.level}，底色 ${snapshot.base}，文字色 ${snapshot.text}，墙纸着色 ${snapshot.tinted ? "开" : "关"}`, snapshot);
    return snapshot;
}

export { surface, BLUR_LEVELS };

globalThis.__surface = surface;
