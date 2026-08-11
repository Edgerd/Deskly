/**
 * i18n.js — 多语言支持模块
 *
 * 支持中文（zh-CN）、English（en）、日本語（ja-JP）、萌猫语言（cat）四种语言。
 * 语言包为 JSON 键值对，采用扁平命名（如 desktop.icon.finder）。
 * 萌猫语言规则：将界面文本美化，添加"喵~"后缀，称用户为"主人"。
 *
 * 对外 API：
 *   i18n.init(lang)         初始化语言（默认中文）
 *   i18n.t(key, fallback)   获取指定键的翻译文本，缺失时回退 fallback
 *   i18n.setLanguage(lang)  切换语言并刷新界面
 *   i18n.getLanguage()      获取当前语言代号
 */

// 语言包所在目录（相对 index.html 的路径）
const LOCALE_DIR = "./assets/locales/";

// 语言文件映射：代号 -> 文件名
const LANG_FILES = {
    "zh-CN": "zh-CN.json",
    "en": "en.json",
    "ja-JP": "ja-JP.json",
    "cat": "cat.json",
};

// 当前语言
let currentLang = "zh-CN";

// 已加载的语言包缓存
const localeCache = {};

/**
 * 根据键路径（如 "desktop.icon.finder"）从翻译对象中取值。
 * @param {Object} dict 语言包对象
 * @param {string} key 点分路径键
 * @returns {string|undefined} 找到的翻译文本，未找到返回 undefined
 */
function lookup(dict, key) {
    if (!dict) return undefined;
    return key.split(".").reduce((acc, part) => {
        return acc && typeof acc === "object" ? acc[part] : undefined;
    }, dict);
}

/**
 * 加载指定语言的翻译文本。
 * @param {string} lang 语言代号
 * @returns {Promise<Object>} 翻译对象
 */
async function loadLocale(lang) {
    if (localeCache[lang]) return localeCache[lang];
    const file = LANG_FILES[lang] || LANG_FILES["zh-CN"];
    const response = await fetch(`${LOCALE_DIR}${file}`);
    if (!response.ok) throw new Error(`无法加载语言包：${file}`);
    const dict = await response.json();
    localeCache[lang] = dict;
    return dict;
}

/**
 * 替换页面中带 data-i18n 属性的元素文本。
 * 元素可通过 data-i18n 指定键，data-i18n-fallback 指定回退文本。
 */
function applyTranslations() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
        const fallback = el.getAttribute("data-i18n-fallback") || el.textContent;
        el.textContent = i18n.t(el.getAttribute("data-i18n"), fallback);
    });
}

/** 多语言模块对象 */
const i18n = {
    /**
     * 初始化多语言系统。
     * @param {string} [lang="zh-CN"] 语言代号，默认中文
     * @returns {Promise<Object>} 语言包对象
     */
    async init(lang = "zh-CN") {
        currentLang = LANG_FILES[lang] ? lang : "zh-CN";
        const dict = await loadLocale(currentLang);
        applyTranslations();
        return dict;
    },

    /**
     * 获取指定键的翻译文本。
     * @param {string} key 键（点分路径）
     * @param {string} [fallback] 缺失时的回退文本
     * @returns {string} 翻译文本
     */
    t(key, fallback = "") {
        const dict = localeCache[currentLang];
        const value = lookup(dict, key);
        return value !== undefined ? value : fallback;
    },

    /**
     * 切换语言并刷新界面文本。
     * @param {string} lang 语言代号
     * @returns {Promise<Object>} 语言包对象
     */
    async setLanguage(lang) {
        if (!LANG_FILES[lang]) {
            throw new Error(`不支持的语音：${lang}`);
        }
        currentLang = lang;
        const dict = await loadLocale(lang);
        // 派发语言变更事件，供其他模块监听并刷新
        window.dispatchEvent(new CustomEvent("languagechange", { detail: { lang } }));
        applyTranslations();
        return dict;
    },

    /**
     * 获取当前语言代号。
     * @returns {string} 语言代号
     */
    getLanguage() {
        return currentLang;
    },
};

export { i18n };