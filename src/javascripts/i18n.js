/**
 * i18n.js — 多语言支持模块
 *
 * 支持中文（zh-CN）、English（en）、日本語（ja-JP）、萌猫语言（cat）四种语言。
 * 语言包为 JSON 键值对：文件内按命名空间嵌套，取用时用点分路径寻址（如 desktop.icon.finder）。
 * 萌猫语言规则：将界面文本美化，添加"喵~"后缀，称用户为"主人"。
 *
 * 插件自带文案：语言包按「内核 JSON + 插件注册表」两层合成，
 * 插件不必往内核的 assets/locales/*.json 里塞自己的键，也不必等内核先加载：
 * - registerMessages / registerMessagesAll 写进独立的 pluginMessages 表；
 * - 每次内核语言包拉取完都会把该表重新叠到底层之上，refetch 不会抹掉插件键；
 * - 合并是递归深合并，内核新增/更新某个键不会连带清空同命名空间下的插件键。
 *
 * 对外 API：
 *   i18n.init(lang)         初始化语言（默认读取上次持久化的选择）
 *   i18n.t(key, fallback)   获取指定键的翻译文本，缺失时回退 fallback
 *   i18n.setLanguage(lang)  切换语言、持久化并刷新界面
 *   i18n.getLanguage()      获取当前语言代号
 *   i18n.applyTranslations(root) 对（新注入的）子树应用翻译
 *   i18n.registerMessages(lang, messages)    注册一份插件文案，返回并入的叶子键数
 *   i18n.registerMessagesAll(byLang)         一次注册四种语言（{ "zh-CN": {…}, en: {…}, … }）
 *   i18n.hasKey(key)        当前语言（含插件文案）里是否存在该键
 *   i18n.onChange(fn)       订阅语言切换，返回退订函数（面板据此重建选项列表）
 */

import { assetPath } from "./paths.js";
import { callerFromStack, currentCaller } from "./caller-context.js";

// 语言包所在目录（相对 index.html 的路径）
const LOCALE_DIR = `${assetPath("locales")}/`;

// 语言选择的持久化键（与其他 webstartos_* 设置键同一命名空间）
const LANGUAGE_KEY = "webstartos_language";

const LANG_FILES = {
    "zh-CN": "zh-CN.json",
    "en": "en.json",
    "ja-JP": "ja-JP.json",
    "cat": "cat.json",
};

let currentLang = "zh-CN";

/** 语言切换序号：并发 setLanguage 时只有最后一次生效（BUG-47）。 */
let langSwitchSeq = 0;

// 内核语言包缓存：语言代号 -> assets/locales/<lang>.json 的原始内容
const localeCache = {};

// 插件注册表：语言代号 -> 插件自带的嵌套文案。与 localeCache 分开存，
// 这样 loadLocale 重新拉取内核 JSON 后仍能把它叠回顶层，注册先后顺序无关。
const pluginMessages = {};

// 生效字典：语言代号 -> 「内核包 + 插件包」深合并后的副本，t() 只读这一份。
// 每次底层或插件层变化时由 rebuildDict 重新生成，避免每次取值都现场合并。
const effectiveDicts = {};

/**
 * 递归深合并 source 到 target（就地修改），返回写入的叶子键数。
 * 数组与标量按整体替换：星期表若被逐元素合并会退化成 {0:"…"} 对象，t() 就拿不到数组了。
 * @param {Object} target 目标对象
 * @param {Object} [source] 来源对象
 * @returns {number} 并入的叶子键数量
 */
function deepMergeInto(target, source) {
    if (!source || typeof source !== "object") return 0;
    let count = 0;
    Object.keys(source).forEach((part) => {
        const value = source[part];
        if (value && typeof value === "object" && !Array.isArray(value)) {
            if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
                target[part] = {};
            }
            count += deepMergeInto(target[part], value);
            return;
        }
        target[part] = value;
        count += 1;
    });
    return count;
}

/** 语言包副本（合并基准必须是副本，不能改写 localeCache 里的原始 JSON）。 */
function cloneDict(dict) {
    if (typeof structuredClone === "function") return structuredClone(dict);
    try {
        return JSON.parse(JSON.stringify(dict));
    } catch {
        return { ...dict };
    }
}

/**
 * 重新生成某语言的生效字典：内核包为底，插件文案叠在上层。
 * @param {string} lang 语言代号
 */
function rebuildDict(lang) {
    const base = cloneDict(localeCache[lang] || {});
    deepMergeInto(base, pluginMessages[lang]);
    effectiveDicts[lang] = base;
}

/** 可选日志入口：log.js 尚未求值时退回 console（console 已被 log.js 接管归档）。 */
function writeLog(level, message, data) {
    const logger = globalThis.__log;
    if (logger && typeof logger[level] === "function") logger[level]("kernel/i18n", message, data);
    else (console[level] || console.log).call(console, `[i18n] ${message}`, data);
}

/**
 * 读取上次持久化的语言；无记录或值非法时回退中文。
 * @returns {string} 语言代号
 */
function storedLanguage() {
    try {
        const saved = localStorage.getItem(LANGUAGE_KEY);
        return saved && LANG_FILES[saved] ? saved : "zh-CN";
    } catch (err) {
        // 隐私模式 / 配额异常下 localStorage 可能不可用，语言功能降级为默认中文
        console.warn("[i18n] 无法读取语言设置:", err);
        return "zh-CN";
    }
}

function persistLanguage(lang) {
    try {
        localStorage.setItem(LANGUAGE_KEY, lang);
    } catch (err) {
        console.warn("[i18n] 无法保存语言设置:", err);
    }
}

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
 * 返回值是「内核 JSON + 插件注册文案」合并后的生效字典，而不是原始 JSON：
 * 调用方（init / setLanguage）拿到的应当是界面真正使用的文本表。
 * @param {string} lang 语言代号
 * @returns {Promise<Object>} 生效的翻译对象
 */
async function loadLocale(lang) {
    if (localeCache[lang]) return effectiveDicts[lang] || localeCache[lang];
    const file = LANG_FILES[lang] || LANG_FILES["zh-CN"];
    const response = await fetch(`${LOCALE_DIR}${file}`);
    if (!response.ok) throw new Error(`无法加载语言包：${file}`);
    const dict = await response.json();
    localeCache[lang] = dict;
    // 重新拉取会整份替换内核包，插件文案必须在此重新叠回，否则刷新后插件键全丢
    rebuildDict(lang);
    return effectiveDicts[lang];
}

/**
 * 语言代号 → `<html lang>` 的 BCP 47 值。
 * `cat` 是「萌猫语言」（中文基底 + 喵尾，见 assets/locales/cat.json 与 finderbar.js
 * INTL_LOCALES 的 zh-CN 映射），不是加泰罗尼亚语 —— 标成 ca 会让读屏按加泰罗尼亚语
 * 规则朗读整页中文喵语（CON-08）。
 */
const HTML_LANG = { "zh-CN": "zh-CN", en: "en", "ja-JP": "ja-JP", cat: "zh-CN" };

/**
 * 同步 `<html lang>`。
 * index.html 里写死的是 `lang="en"`，而 i18n 只替换文案 —— 不改这里的话，中文用户
 * 的读屏会按英文发音读整页，浏览器翻译也会给出错误的目标语言提示。
 */
function syncDocumentLang() {
    if (typeof document === "undefined" || !document.documentElement) return;
    document.documentElement.lang = HTML_LANG[currentLang] || currentLang || "zh-CN";
}

/**
 * 对子树内带 data-i18n 的元素应用翻译。
 * @param {ParentNode} [root=document] 作用范围
 */
function applyTranslations(root = document) {
    const nodes = root === document
        ? document.querySelectorAll("[data-i18n]")
        : (root.matches?.("[data-i18n]") ? [root, ...root.querySelectorAll("[data-i18n]")] : root.querySelectorAll("[data-i18n]"));
    nodes.forEach((el) => {
        const fallback = el.getAttribute("data-i18n-fallback") || el.textContent;
        el.textContent = i18n.t(el.getAttribute("data-i18n"), fallback);
    });
}

// 插件窗口是打开时才把 index.html 注入 DOM 的，早于任何静态初始化时机；
// 没有这个观察者，mods/* 里写的 data-i18n 永远不会被翻译。
let translateObserver = null;
function watchInjectedTranslations() {
    if (translateObserver || typeof MutationObserver !== "function") return;
    translateObserver = new MutationObserver((mutations) => {
        mutations.forEach((m) => {
            m.addedNodes.forEach((node) => {
                if (node.nodeType !== 1) return;
                if (node.matches?.("[data-i18n]") || node.querySelector?.("[data-i18n]")) {
                    applyTranslations(node);
                }
            });
        });
    });
    translateObserver.observe(document.body, { childList: true, subtree: true });
}

/** 多语言模块对象 */
const i18n = {
    /**
     * 初始化多语言系统。
     * @param {string} [lang] 语言代号，缺省时读取持久化设置
     * @returns {Promise<Object>} 语言包对象
     */
    async init(lang) {
        currentLang = LANG_FILES[lang] ? lang : storedLanguage();
        syncDocumentLang();
        watchInjectedTranslations();
        try {
            const dict = await loadLocale(currentLang);
            applyTranslations();
            return dict;
        } catch (err) {
            // 语言包拉取失败不应阻塞桌面：回退中文（此时 t() 会用调用方给的 fallback）
            console.warn(`[i18n] 语言包加载失败，回退中文：${currentLang}`, err);
            currentLang = "zh-CN";
            syncDocumentLang();
            applyTranslations();
            return effectiveDicts["zh-CN"] || localeCache["zh-CN"] || {};
        }
    },

    /**
     * 获取指定键的翻译文本。
     * @param {string} key 键（点分路径）
     * @param {string} [fallback] 缺失时的回退文本
     * @returns {string} 翻译文本
     */
    t(key, fallback = "") {
        const dict = effectiveDicts[currentLang] || localeCache[currentLang];
        const value = lookup(dict, key);
        return value !== undefined ? value : fallback;
    },

    /**
     * 当前语言（含插件注册的文案）里是否存在该键。
     * @param {string} key 键（点分路径）
     * @returns {boolean} 是否存在
     */
    hasKey(key) {
        const dict = effectiveDicts[currentLang] || localeCache[currentLang];
        return lookup(dict, key) !== undefined;
    },

    /**
     * 切换语言、持久化并刷新界面。
     * @param {string} lang 语言代号
     * @returns {Promise<Object>} 语言包对象
     */
    async setLanguage(lang) {
        if (!LANG_FILES[lang]) {
            throw new Error(`不支持的语言：${lang}`);
        }
        // 序号令牌：连续切换时只有最后一次派发事件与刷新（BUG-47）；
        // 失败时回滚 currentLang 与持久化（BUG-38：旧版失败即「语言已切、字典没有」的半损坏态）。
        const seq = ++langSwitchSeq;
        const prev = currentLang;
        currentLang = lang;
        syncDocumentLang();
        persistLanguage(lang);
        let dict;
        try {
            dict = await loadLocale(lang);
        } catch (err) {
            if (seq === langSwitchSeq) {
                currentLang = prev;
                syncDocumentLang();
                persistLanguage(prev);
            }
            throw err;
        }
        if (seq !== langSwitchSeq) return dict;
        // 派发语言变更事件：在 document 上派发并允许冒泡，
        // 这样 document 监听者（控制中心）与 window 监听者（菜单栏）都能收到。
        // 此前只在 window 上派发且不冒泡，document 上的监听者永远不会执行。
        const event = new CustomEvent("languagechange", { detail: { lang }, bubbles: true });
        document.dispatchEvent(event);
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

    /**
     * 受支持的语言列表（供设置界面渲染选项，避免各处硬编码）。
     * @returns {Array<{code: string, label: string}>}
     */
    getSupportedLanguages() {
        return [
            { code: "zh-CN", label: "简体中文" },
            { code: "en", label: "English" },
            { code: "ja-JP", label: "日本語" },
            { code: "cat", label: "萌猫语言" },
        ];
    },

    /**
     * 注册插件自带的文案（深合并进该语言的插件文案表，不动内核 JSON）。
     * 语言包尚未加载时也会先建好条目，因此插件与内核的注册先后顺序无关。
     * @param {string} lang 语言代号（须是 LANG_FILES 里的四种之一）
     * @param {Object} messages 嵌套文案，如 { "notepad": { "title": "记事本" } }
     * @returns {number} 并入的叶子键数量（非法入参返回 0）
     */
    registerMessages(lang, messages) {
        if (!LANG_FILES[lang]) {
            writeLog("warn", `忽略不支持语言的插件文案注册：${lang}`);
            return 0;
        }
        if (!messages || typeof messages !== "object" || Array.isArray(messages)) {
            writeLog("warn", `${lang} 的插件文案形态非法（需要嵌套对象），已忽略注册`);
            return 0;
        }
        // 命名空间约定（API-06）：插件键必须顶在「自己 id」的命名空间下（如 office.*），
        // 深合并会叠在内核包之上 —— 写别人的命名空间就是覆盖全系统文案。这里只告警不拒收
        // （存量插件可能依赖现状），但告警给了 static-check 与排查一个抓手。
        // 公认的别名命名空间：system-settings 的全部面板共用 ss.*（pane 自带语言包惯例）。
        const NAMESPACE_ALIAS = { "system-settings": ["ss"] };
        const caller = currentCaller() || callerFromStack();
        if (caller) {
            const accepted = [caller, ...(NAMESPACE_ALIAS[caller] || [])];
            const offNamespace = Object.keys(messages).filter((k) =>
                !accepted.some((ns) => k === ns || k.startsWith(`${ns}.`)));
            if (offNamespace.length) {
                writeLog("warn", `插件 ${caller} 注册了非自身命名空间的文案（${offNamespace.join(", ")}），可能覆盖内核或他人文案`);
            }
        }
        pluginMessages[lang] = pluginMessages[lang] || {};
        const merged = deepMergeInto(pluginMessages[lang], messages);
        rebuildDict(lang);
        // 只有注册进当前语言时才需要立刻重刷界面文案
        if (lang === currentLang) applyTranslations();
        if (merged) writeLog("info", `插件文案已注册：${lang} 新增/覆盖 ${merged} 个键`);
        return merged;
    },

    /**
     * 一次注册多语言文案的便捷入口。
     * @param {Record<string, Object>} byLang 形如 { "zh-CN": {…}, "en": {…}, "ja-JP": {…}, "cat": {…} }
     * @returns {number} 全部语言并入的叶子键总数
     */
    registerMessagesAll(byLang) {
        if (!byLang || typeof byLang !== "object") return 0;
        return Object.keys(byLang).reduce((total, lang) => total + i18n.registerMessages(lang, byLang[lang]), 0);
    },

    /**
     * 订阅语言切换：回调收到新的语言代号。
     * 供设置面板等「选项文本在模块求值期烘焙」的界面重建下拉列表 ——
     * 此前没有订阅入口，语言切换后选项文本永远停在旧语言上。
     * @param {(lang: string) => void} fn 回调
     * @returns {Function} 退订函数
     */
    onChange(fn) {
        if (typeof fn !== "function") return () => { };
        const handler = () => {
            try {
                fn(currentLang);
            } catch (err) {
                writeLog("error", "语言变更订阅者执行失败", err);
            }
        };
        document.addEventListener("languagechange", handler);
        return () => document.removeEventListener("languagechange", handler);
    },

    applyTranslations,
};

export { i18n };
