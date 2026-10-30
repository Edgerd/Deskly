/**
 * panes/appearance.js — 「外观」面板：主题、强调色、高亮色、边栏尺寸、亚克力表面与动效
 *
 * 四项硬约束：
 * 1. 只渲染设置定义里存在、且没有 hidden 的键。`appearance.scroll.click` 是浏览器原生
 *    滚动条行为（网页既不能接管也无法用 CSS 表达「点按位置」），定义里标了 hidden，
 *    这里就不给它任何界面位置 —— 与 registry 里 implemented:false 的面板同一个道理。
 * 2. 色值以内核为准：强调色取 settings 定义里的 valueColors，缺失时回退到与
 *    appearance.js 的 COLOR_MAP 同序同值的一份本地镜像（内核值是 #0a82ff，绝不另起一个蓝）。
 * 3. 所有选项表都在 build() 里现算：模块只有一份实例、build 每次切换面板都会重跑，
 *    所以语言切换后选项标签一定跟着换（旧版算在模块求值时，从此冻在中文）。
 * 4. 表面系统（src/javascripts/surface.js）的三档参数只做「读写设置 + 展示推导结果」：
 *    模糊等级的五个档位取自定义（values / valuesLabel，缺失时退到 __surface.levels()），
 *    着色浓度与色调偏移把 key 交给 row()，由 ui.js 的 wireRequires 依 `requires` 禁用，
 *    预览小样的底色 / 文字色 / 等级一律读 __surface.stats() 与 <html> 上的令牌，
 *    面板自己不再算第二遍 —— 两处算法迟早分叉，分叉了界面就变成假读数。
 */

import { settings } from "../../../src/javascripts/settings.js";
import { assetPath } from "../../../src/javascripts/paths.js";
import {
    el, t, group, statusRow,
    controlCards, controlSwatches, controlDropdown, controlRadio, controlSwitch,
    controlSegmented, controlSlider, track,
    usePaneStyle,
} from "../ui.js";

export const paneId = "appearance";

/** 强调色候选键，与 settings-definitions.js 的 ACCENT_KEYS 同序。 */
const ACCENT_KEYS = ["multicolor", "blue", "purple", "pink", "red", "orange", "yellow", "green", "gray"];

/**
 * 强调色的界面镜像值：与 src/javascripts/appearance.js 的 COLOR_MAP 一一对应。
 * 只在定义没给 valueColors 时使用；生效函数、存储值仍然只认内核那一份。
 */
const COLOR_MAP = {
    multicolor: "#0a82ff",
    blue: "#0a82ff",
    purple: "#8a358b",
    pink: "#F64694",
    red: "#DB3136",
    orange: "#f67719",
    yellow: "#FFC022",
    green: "#57B13D",
    gray: "#8D8D8D",
};

/** 面板语言包。 */
export const messages = {
    "zh-CN": {
        ss: {
            pane: { appearance: "外观" },
            appearance: {
                theme: "外观",
                light: "浅色", dark: "深色", auto: "自动",
                themeResolved: "当前生效",
                accent: "强调色",
                highlight: "高亮颜色",
                sidebar: "边栏图标大小",
                small: "小", medium: "中", large: "大",
                blur: "模糊等级",
                blurLevels: { 0: "关闭", 1: "极轻", 2: "轻柔", 3: "标准", 4: "浓重" },
                surfaceSecondary: "次要文字",
                tint: "允许墙纸为窗口着色",
                strength: "着色浓度",
                hue: "色调偏移",
                scrollbars: "显示滚动条", scrollbarsAuto: "自动",
                scrollbarsWhenScrolling: "滚动时", scrollbarsAlways: "始终",
                motion: "减少动态效果",
                transparency: "降低透明度时关闭毛玻璃",
                colors: {
                    accent: "主题色", multicolor: "多彩", blue: "蓝色", purple: "紫色", pink: "粉色",
                    red: "红色", orange: "橙色", yellow: "黄色", green: "绿色", gray: "灰色",
                },
            },
        },
    },
    en: {
        ss: {
            pane: { appearance: "Appearance" },
            appearance: {
                theme: "Appearance",
                light: "Light", dark: "Dark", auto: "Auto",
                themeResolved: "In effect",
                accent: "Accent colour",
                highlight: "Highlight colour",
                sidebar: "Sidebar icon size",
                small: "Small", medium: "Medium", large: "Large",
                blur: "Blur level",
                blurLevels: { 0: "Off", 1: "Barely", 2: "Light", 3: "Standard", 4: "Heavy" },
                surfaceSecondary: "Secondary text",
                tint: "Tint windows with wallpaper",
                strength: "Tint strength",
                hue: "Hue shift",
                scrollbars: "Show scroll bars", scrollbarsAuto: "Automatically based on mouse or trackpad",
                scrollbarsWhenScrolling: "When scrolling", scrollbarsAlways: "Always",
                motion: "Reduce motion",
                transparency: "Reduce transparency",
                colors: {
                    accent: "Accent", multicolor: "Multicolour", blue: "Blue", purple: "Purple", pink: "Pink",
                    red: "Red", orange: "Orange", yellow: "Yellow", green: "Green", gray: "Gray",
                },
            },
        },
    },
    "ja-JP": {
        ss: {
            pane: { appearance: "外観" },
            appearance: {
                theme: "外観",
                light: "ライト", dark: "ダーク", auto: "自動",
                themeResolved: "適用中",
                accent: "アクセントカラー",
                highlight: "ハイライトの色",
                sidebar: "サイドバーのアイコンサイズ",
                small: "小", medium: "中", large: "大",
                blur: "ぼかしレベル",
                blurLevels: { 0: "オフ", 1: "ごく薄く", 2: "軽く", 3: "標準", 4: "濃く" },
                surfaceSecondary: "補助テキスト",
                tint: "壁紙でウィンドウを着色",
                strength: "着色の濃さ",
                hue: "色相オフセット",
                scrollbars: "スクロールバーを表示", scrollbarsAuto: "自動",
                scrollbarsWhenScrolling: "スクロール時", scrollbarsAlways: "常に",
                motion: "動きを減らす",
                transparency: "透明効果をオフ",
                colors: {
                    accent: "アクセント", multicolor: "マルチカラー", blue: "ブルー", purple: "パープル", pink: "ピンク",
                    red: "レッド", orange: "オレンジ", yellow: "イエロー", green: "グリーン", gray: "グレー",
                },
            },
        },
    },
    cat: {
        ss: {
            pane: { appearance: "外觀喵" },
            appearance: {
                theme: "外觀喵",
                light: "亮堂喵", dark: "黑燈喵", auto: "自動喵",
                themeResolved: "現在生效喵",
                accent: "強調色喵",
                highlight: "亮亮色喵",
                sidebar: "側欄圖示大小喵",
                small: "小喵", medium: "中等喵", large: "大喵",
                blur: "糊糊等級喵",
                blurLevels: { 0: "不糊喵", 1: "一點點喵", 2: "輕輕糊喵", 3: "剛剛好喵", 4: "濃濃糊喵" },
                surfaceSecondary: "次要文字喵",
                tint: "讓窗戶跟著壁紙變色喵",
                strength: "調多少色喵",
                hue: "色偏向哪邊喵",
                scrollbars: "顯示捲軸喵", scrollbarsAuto: "自動喵",
                scrollbarsWhenScrolling: "捲動時喵", scrollbarsAlways: "都顯示喵",
                motion: "少動一點喵",
                transparency: "不要毛玻璃喵",
                colors: {
                    accent: "主題色喵", multicolor: "五彩斑斕喵", blue: "藍色喵", purple: "紫色喵", pink: "粉色喵",
                    red: "紅色喵", orange: "橙色喵", yellow: "黃色喵", green: "綠色喵", gray: "灰色喵",
                },
            },
        },
    },
};

/**
 * 颜色名的中文回退：与 messages 里的 ss.appearance.colors.* 一一对应，
 * 语言包没注册上时界面仍是正确的中文而不是裸键名。
 */
const COLOR_FALLBACK = {
    accent: "主题色", multicolor: "多彩", blue: "蓝色", purple: "紫色", pink: "粉色",
    red: "红色", orange: "橙色", yellow: "黄色", green: "绿色", gray: "灰色",
};

/** 面板私有样式：卡片缩略图、表面小样，以及 requires 依赖未满足时的禁用观感。 */
const PANE_CSS = `
.ss-pane-appearance .ss-cards { gap: 12px; }
/* 预览卡尺寸对着原版收小：截图里三张卡约 62×44（窗口 850pt），本窗口 715pt 等比约 52×37，
   取 84×54 是不再把「浅色/深色」细节糊成一团的下限。选中环用 outline-offset 留空隙（见 style.css）。 */
.ss-pane-appearance .ss-cards__img { width: 84px; height: 54px; }

/* 依附禁用：ui.js 的 wireRequires 会给整行加 ss-row--disabled 并把行内 input/button
   置 disabled，但插件的 style.css 里没有这条类的任何样式（它是通用类，不属于本面板），
   所以在面板自带样式里补上观感：整行压暗、控件不再响应输入，读起来才是「灰掉了」。 */
.settings .ss-pane-appearance .ss-row--disabled .ss-row__main { opacity: 0.55; }
.settings .ss-pane-appearance .ss-row--disabled .ss-row__control,
.settings .ss-pane-appearance .ss-row--disabled .ss-row__stack { opacity: 0.42; }
.settings .ss-pane-appearance .ss-row--disabled .ss-slider,
.settings .ss-pane-appearance .ss-row--disabled .ss-slider__value { cursor: default; }

/* 表面小样：真亚克力，用的就是 <html> 上那一组令牌，不另起平行变量。
   禁忌照旧：带 backdrop-filter 的元素不加 transform / filter，否则采样会截断成白块。
   只留视觉小样本身（底色芯片 + Aa），读数与说明不再呈现。 */
.settings .ss-pane-appearance .ss-appearance__surface {
    display: flex; align-items: center; gap: 14px;
    padding: 10px 12px; border-top: 1px solid var(--ss-row-divider);
}
/* style.css 的分隔线只写在 .ss-row + .ss-row 上，小样不是 .ss-row，
   它后面那一行会漏掉上边框，这里补回来（否则开关行看起来像贴着上一行）。 */
.settings .ss-pane-appearance .ss-appearance__surface + .ss-row {
    border-top: 1px solid var(--ss-row-divider);
}
.settings .ss-pane-appearance .ss-appearance__chip {
    display: flex; flex-direction: column; gap: 2px; flex: 0 0 auto;
    min-width: 132px; padding: 8px 14px; border-radius: 12px;
    background: var(--group-bg);
    box-shadow: inset 0 0 0 1px var(--hairline);
    backdrop-filter: blur(var(--surface-blur)) saturate(var(--surface-saturate));
    -webkit-backdrop-filter: blur(var(--surface-blur)) saturate(var(--surface-saturate));
}
/* 着色开着才用墙纸色上色，浓度与全站表面同一个算法（0.84 是这条浓度链的代表值）。
   同时把文字档指到「墙纸」那一套：芯片这时候的底就是墙纸色，继续读全局 --surface-text
   （为不吃色的菜单算的）会在深色墙纸 + 浅色主题下给出黑字压在深芯片上。 */
html[data-wallpaper-tint="on"] .settings .ss-pane-appearance .ss-appearance__chip {
    background: rgba(var(--tint-rgb), calc(0.84 * var(--tint-strength)));
    --surface-text: var(--surface-text-wallpaper);
    --surface-text-rgb: var(--surface-text-wallpaper-rgb);
    --surface-text-secondary: var(--surface-text-wallpaper-secondary);
    --surface-text-tertiary: var(--surface-text-wallpaper-tertiary);
}
html[data-wallpaper-tint="on"][data-theme="dark"] .settings .ss-pane-appearance .ss-appearance__chip {
    background: rgba(var(--tint-rgb), calc(0.8 * var(--tint-strength)));
}
.settings .ss-pane-appearance .ss-appearance__chip-aa {
    font-size: 19px; font-weight: 600; line-height: 1.1; color: var(--surface-text);
}
.settings .ss-pane-appearance .ss-appearance__chip-sub {
    font-size: 11.5px; color: var(--surface-text-secondary);
}
`;

/**
 * 取某个颜色键的显示名。
 * @param {string} key 颜色键（accent / 强调色候选名）
 * @returns {string} 当前语言的名称
 */
function colorName(key) {
    return t(`ss.appearance.colors.${key}`, COLOR_FALLBACK[key] || key);
}

/**
 * 取某个强调色的界面用色：定义里的 valueColors 优先，缺失时用本地镜像。
 * @param {object} definition 设置定义（settings.info 的返回）
 * @param {string} key 颜色键
 * @returns {string} CSS 颜色
 */
function accentColor(definition, key) {
    const fromDefinition = definition && definition.valueColors ? definition.valueColors[key] : undefined;
    return fromDefinition || COLOR_MAP[key] || COLOR_MAP.multicolor;
}

/**
 * 模糊等级的档位表：值与标签都来自设置定义（owner 是 surface.js），面板这里不数 0–4。
 * 标签先查当前语言的 ss.appearance.blurLevels.<值>，没有就用定义里的 valuesLabel ——
 * 于是「语言切换后重建面板」一定换新词，而内核改了档位文案时这里自动跟上。
 * 定义还没注册（内核未就绪的极端时序）时退到 __surface.levels()，同样是那一份来源。
 * @returns {Array<{value:number,label:string}>} 分段选项
 */
function blurOptions() {
    const api = globalThis.__surface;
    const definition = settings.info("appearance.blurLevel") || {};
    const levels = typeof api?.levels === "function" ? api.levels() : [];
    const values = definition.values || levels.map((level) => level.value);
    return (values || []).map((value, index) => {
        const levelKey = `ss.appearance.blurLevels.${value}`;
        const levelFallback = definition.valuesLabel?.[index] ?? levels[index]?.label ?? String(value);
        return { value, label: t(levelKey, levelFallback) };
    });
}

/**
 * 亚克力表面小样：一块真磨砂芯片，文字色随底色自动推导。
 * 芯片登记进 __surface 后，它拿到的文字色与全站其它磨砂表面走同一条局部推导；
 * apply() 返回的注销函数交给 track()，面板销毁时由 disposeAll() 释放，避免监听泄漏。
 * @returns {HTMLElement} 小样行
 */
function surfaceStrip() {
    const api = globalThis.__surface;
    const chip = el("div", { class: "ss-appearance__chip" },
        el("span", { class: "ss-appearance__chip-aa", text: "Aa" }),
        el("span", { class: "ss-appearance__chip-sub", text: t("ss.appearance.surfaceSecondary", "次要文字") }));

    if (typeof api?.apply === "function") {
        const release = api.apply(chip, { role: 3 });
        track(typeof release === "function" ? release : () => { });
    }
    return el("div", { class: "ss-appearance__surface" }, chip);
}

/**
 * 构建「外观」面板。
 * @param {object} ctx 外壳上下文
 * @returns {HTMLElement} 面板根元素
 */
export function build(ctx) {
    usePaneStyle(paneId, PANE_CSS);
    const root = el("div", { class: "ss-pane ss-pane-appearance", dataset: { pane: paneId } });

    const themeLabel = {
        light: t("ss.appearance.light", "浅色"),
        dark: t("ss.appearance.dark", "深色"),
        auto: t("ss.appearance.auto", "自动"),
    };
    const themeImages = {
        light: assetPath("images/sequoia.shape.day.jpg"),
        dark: assetPath("images/sequoia.shape.night.jpg"),
        auto: assetPath("images/Wallpaper.png"),
    };
    const themeOptions = (settings.info("appearance.theme") && settings.info("appearance.theme").values)
        || ["light", "dark", "auto"];

    const accentDefinition = settings.info("appearance.accent") || {};
    const accentValues = accentDefinition.values || ACCENT_KEYS;
    const swatches = accentValues.map((key) => ({
        value: key,
        color: accentColor(accentDefinition, key),
        name: colorName(key),
        multicolor: key === "multicolor",
    }));

    const highlightDefinition = settings.info("appearance.highlight") || {};
    const highlightValues = highlightDefinition.values || ["accent", ...ACCENT_KEYS];
    const highlightOptions = highlightValues.map((key) => ({
        value: key,
        label: colorName(key),
        color: key === "accent" ? undefined : accentColor(highlightDefinition, key),
    }));

    const sidebarDefinition = settings.info("appearance.sidebar.size") || {};
    const sidebarLabels = {
        small: t("ss.appearance.small", "小"),
        medium: t("ss.appearance.medium", "中"),
        large: t("ss.appearance.large", "大"),
    };
    const sidebarOptions = (sidebarDefinition.values || ["small", "medium", "large"])
        .map((value) => ({ value, label: sidebarLabels[value] || value }));

    const scrollbarDefinition = settings.info("appearance.scrollbars") || {};
    const scrollbarLabels = {
        auto: t("ss.appearance.scrollbarsAuto", "自动"),
        "when-scrolling": t("ss.appearance.scrollbarsWhenScrolling", "滚动时"),
        always: t("ss.appearance.scrollbarsAlways", "始终"),
    };
    const scrollbarOptions = (scrollbarDefinition.values || ["auto", "when-scrolling", "always"])
        .map((value) => ({ value, label: scrollbarLabels[value] || value }));

    // 表面系统（src/javascripts/surface.js）的三项参数：档位、取值范围、格式化都从定义里读，
    // 这一层只管排位置与给译文，绝不在这儿再抄一份 0/1/2/3/4 或 min/max/step。
    const strengthDefinition = settings.info("appearance.tintStrength") || {};
    const hueDefinition = settings.info("appearance.tintHue") || {};
    const surfacePreviewRow = surfaceStrip();

    // 「自动」到底解析成了哪一档，由 appearance.js 写在 <html data-theme-resolved> 上；
    // 订阅它广播的事件，面板里的读数就永远和真实生效值一致（包括系统明暗变化的时候）。
    const resolvedRow = statusRow({
        label: t("ss.appearance.themeResolved", "当前生效"),
        value: document.documentElement.dataset.themeResolved || "—",
    });
    const onThemeResolved = () => {
        resolvedRow.setValue(document.documentElement.dataset.themeResolved
            || document.documentElement.getAttribute("data-theme") || "—");
    };
    window.addEventListener("appearance-theme-change", onThemeResolved);
    track(() => window.removeEventListener("appearance-theme-change", onThemeResolved));

    root.append(
        group([
            controlCards("appearance.theme", {
                label: t("ss.appearance.theme", "外观"),
                options: themeOptions.map((value) => ({
                    value,
                    label: themeLabel[value] || value,
                    image: themeImages[value] || themeImages.light,
                })),
            }),
            resolvedRow,
            controlSwatches("appearance.accent", {
                label: t("ss.appearance.accent", "强调色"),
                colors: swatches,
            }),
            controlDropdown("appearance.highlight", {
                label: t("ss.appearance.highlight", "高亮颜色"),
                options: highlightOptions,
            }),
            controlDropdown("appearance.sidebar.size", {
                label: t("ss.appearance.sidebar", "边栏图标大小"),
                options: sidebarOptions,
            }),
            // 顺序沿用定义里的 order（边栏 40 -> 模糊等级 45 -> 着色开关 50 -> 浓度 51 -> 色相 52），
            // 小样紧跟在模糊等级后面：滑块拨的是令牌，小样就在下面一行，不用来回找。
            controlSegmented("appearance.blurLevel", {
                label: t("ss.appearance.blur", "模糊等级"),
                options: blurOptions(),
            }),
            surfacePreviewRow,
            controlSwitch("appearance.wallpaper.tint", {
                label: t("ss.appearance.tint", "允许墙纸为窗口着色"),
            }),
            // 这两个滑块与上面的开关是一个单元：定义里写着 requires: "appearance.wallpaper.tint"，
            // 控件工厂把 key 转交给 row()，ui.js 的 wireRequires 就会读依赖、给整行加
            // ss-row--disabled 并禁用行内 input/button，开关拨回来时自动恢复。
            controlSlider("appearance.tintStrength", {
                label: t("ss.appearance.strength", "着色浓度"),
                // min/max/step 由 controlSlider 自己从定义取；format / units 它只认调用方传的，
                // 所以把定义里的原值转交过来，不在面板里重写。
                format: strengthDefinition.format,
                units: strengthDefinition.units,
            }),
            controlSlider("appearance.tintHue", {
                label: t("ss.appearance.hue", "色调偏移"),
                format: hueDefinition.format,
                units: hueDefinition.units,
            }),
        ]),

        group([
            controlRadio("appearance.scrollbars", {
                label: t("ss.appearance.scrollbars", "显示滚动条"),
                options: scrollbarOptions,
            }),
        ]),

        group([
            controlSwitch("appearance.reduceMotion", {
                label: t("ss.appearance.motion", "减少动态效果"),
            }),
            controlSwitch("appearance.transparency", {
                label: t("ss.appearance.transparency", "降低透明度时关闭毛玻璃"),
            }),
        ]),
    );

    return root;
}

/**
 * 面板销毁：本模块不持有跨面板的资源。
 * 设置订阅（bind）、依赖禁用（wireRequires）、小样的 __surface.subscribe / apply
 * 与所有 document·window 监听都在 build 里经 track() 登记，由 ui.js 的 disposeAll()
 * 统一释放——入口脚本每次打开都会重跑，漏登记的那一个就会一直拖着旧的 DOM。
 * @returns {void}
 */
export function destroy() { }

