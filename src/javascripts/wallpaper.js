/**
 * wallpaper.js — 桌面背景系统模块
 *
 * 功能：
 *   1. 默认使用项目内置的 macOS Sequoia 壁纸（assets/images/Wallpaper.png）。
 *   2. 支持自定义网络壁纸源：输入任意图片 URL 应用并持久化，可随时恢复默认。
 *   3. 支持本地上传图片：读取本地图片，压缩后转为 base64 持久化，刷新后仍生效。
 *   4. 支持 Bing 每日壁纸：官方 JSON 接口 + 备选第三方接口，失败自动回退。
 *   5. 支持系统默认壁纸切换：提供多套内置 macOS 风格壁纸供用户选择。
 *   6. 支持「每天自动更新 Bing 壁纸」：由设置项 wallpaper.autoBing 驱动，
 *      每个自然日最多拉取一次，失败静默降级（只记运行日志，不打扰用户）。
 *
 * 持久化：
 *   使用 localStorage 存储当前壁纸配置 { type, url, name? }，type 取值：
 *     "default"    项目内置默认壁纸（第1套系统壁纸）
 *     "system"     系统内置壁纸（通过 getSystemWallpapers() 选择）
 *     "network"    网络壁纸源
 *     "upload"     本地上传
 *     "bing"       Bing 每日壁纸
 *   Bing 自动更新另用一个记账槽 wallpaper-bing-date（最近一次成功应用的日期），
 *   它不是设置项，只是防止同一天重复拉取的书签。
 *
 * 对外 API：
 *   wallpaper.init()                        初始化并恢复上次壁纸（含每日 Bing 检查）
 *   wallpaper.getWallpaperConfig()          读取当前壁纸配置
 *   wallpaper.applyConfig(config)           按配置对象应用壁纸（只应用、不落盘）
 *   wallpaper.setWallpaper(url)             直接应用壁纸（不持久化）
 *   wallpaper.setNetworkWallpaper(url)      设置网络壁纸源并持久化（含图片预加载校验）
 *   wallpaper.uploadLocal(file)             上传本地图片并持久化
 *   wallpaper.resetWallpaper()              恢复项目默认壁纸
 *   wallpaper.fetchBingWallpaper()          获取 Bing 每日壁纸并设为壁纸（持久化）
 *   wallpaper.setAutoBing(on)               开关「每天自动更新 Bing 壁纸」
 *   wallpaper.getSystemWallpapers()         获取系统内置壁纸列表
 *   wallpaper.setSystemWallpaper(id)        按 ID 切换系统内置壁纸并持久化
 *   getDominantColor(url)                   取图片平均色，返回 Promise<[r, g, b]>
 *   applyTint()                            按当前壁纸刷新 <html> 上的着色令牌
 *
 * 着色令牌由本模块统一产出：壁纸主色只有这里能算（采样器在本文件），所以
 * `--wallpaper-tint-color` / `--wallpaper-tint-rgb` 与样式表正在消费的旧令牌
 * `--window-tint` / `--window-tint-rgb` 都在 `applyTint()` 里写，着色开关关着时
 * 也照样更新，拨开即变色。
 */

import { assetPath } from "./paths.js";

// 系统内置壁纸资源（默认壁纸同时是列表第一项，也是取不到配置时的回退）
const WALLPAPER_DEFAULT = assetPath("images/Wallpaper.png");
const WALLPAPER_DAY = assetPath("images/sequoia.shape.day.jpg");
const WALLPAPER_NIGHT = assetPath("images/sequoia.shape.night.jpg");
const DEFAULT_WALLPAPER = WALLPAPER_DEFAULT;

// 壁纸配置存储键名
const WALLPAPER_CONFIG_KEY = "wallpaper-config";
// 「每天自动更新 Bing 壁纸」开关的存储槽（= 设置项 wallpaper.autoBing 的推导槽名）
const AUTO_BING_SLOT = "wallpaper-autoBing";
// 最近一次成功应用 Bing 壁纸的自然日（记账槽，不是设置项）
const BING_DATE_SLOT = "wallpaper-bing-date";
// 主色采样取不到值时的兜底 RGB（中性蓝灰，与 macOS 窗口底色同调，样式表里也有一份同名兜底）
const TINT_FALLBACK_RGB = [107, 124, 147];
// 同一色的十六进制形态（着色令牌 --*-tint-color 用它）
const TINT_FALLBACK = rgbToHex(TINT_FALLBACK_RGB);
// 主色采样画布边长：16x16 只是「取平均色」，不是缩略图
const SAMPLE_EDGE = 16;

// 上传压缩参数：最大边长与 JPEG 质量
const UPLOAD_MAX_EDGE = 2560;
const UPLOAD_JPEG_QUALITY = 0.85;

// Bing 壁纸接口
const BING_API_URL = "https://cn.bing.com/hpimagearchive.aspx?format=js&idx=0&n=1&mkt=zh-CN";
// 备选第三方接口（注意请求频率限制）
const BING_API_ALT_URL = "https://api.kobin.cn/bing/";

// 主色缓存：url -> 采样 Promise。同一张壁纸反复开关着色、以及 appearance.js 与本模块
// 同时来取色时，只解码一次；缓存 Promise 而不是结果，也顺带做了并发去重。
const dominantCache = new Map();

/** `[r, g, b]` -> `#rrggbb`（越界分量钳进 0..255，避免异常数据写出非法颜色）。 */
function rgbToHex([r, g, b]) {
    const hex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * 可选日志入口：log.js 尚未加载时退回 console（站内 console.* 已被 log.js 接管，
 * 两条路最终都进同一份运行记录）。来源固定 kernel/wallpaper，可按模块检索。
 * @param {string} level warn / error / info
 * @param {string} message 说明文本
 * @param {*} [data] 附加上下文
 * @returns {void}
 */
function logWallpaper(level, message, data) {
    const api = window.__log;
    const method = level === "debug" ? "log" : level;
    if (api && typeof api[level] === "function") api[level]("kernel/wallpaper", message, data);
    else if (data === undefined) console[method](`[wallpaper] ${message}`);
    else console[method](`[wallpaper] ${message}`, data);
}

/** 告警出口（读图失败、写盘失败等不影响当前画面的问题）。 */
function warnLog(message, data) {
    logWallpaper("warn", message, data);
}

/** 错误出口（每日 Bing 拉取失败这类「功能没做成」的情况）。 */
function errorLog(message, data) {
    logWallpaper("error", message, data);
}

/** 读原始存储值，读不到（隐私模式 / 配额异常）时返回 null。 */
function readSlot(slot) {
    try {
        return localStorage.getItem(slot);
    } catch (err) {
        warnLog(`读取 ${slot} 失败：`, err);
        return null;
    }
}

/** 写原始存储值，失败只记日志不上抛（记账类小键不值得打断界面）。 */
function writeSlotQuietly(slot, text) {
    try {
        localStorage.setItem(slot, text);
        return true;
    } catch (err) {
        warnLog(`写入 ${slot} 失败：`, err);
        return false;
    }
}

/** 今天的自然日字符串（本地时区，形如 2026-08-11），用作每日拉取的记账键。 */
function todayKey() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 「每天自动更新 Bing 壁纸」是否开启：优先问设置中枢（它才知道类型），
 * 中枢未注册该键时按存储文本兜底判断（on / true / 1 均视为开）。
 * @returns {boolean} 是否开启
 */
function isAutoBingEnabled() {
    const api = window.__settings;
    if (api && typeof api.has === "function" && api.has("wallpaper.autoBing")) return Boolean(api.get("wallpaper.autoBing"));
    const raw = readSlot(AUTO_BING_SLOT);
    return raw === "on" || raw === "true" || raw === "1";
}

/**
 * 安全写入 localStorage。
 * 这一层只兜底读取、不兜底写入：配额超限（例如上传的 2560px 大图 base64 超过 ~5MB 配额）
 * 时 setItem 抛 QuotaExceededError，一路冒泡到点击处理器，界面表现为「壁纸看着生效了、
 * 刷新后却没了」且没有任何提示。失败时记一条 warn，并在调用方给出提示文案时用系统弹窗告知。
 * @param {string} key 存储键
 * @param {string} value 待存储字符串
 * @param {{title?: string, message?: string}} [notify] 传入则在失败时经 window.__dialog 提示用户
 * @returns {boolean} 是否写入成功
 */
function safeSetItem(key, value, notify) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (err) {
        warnLog(`写入 localStorage 失败（${key}）：`, err);
        if (notify && window.__dialog) {
            window.__dialog.error(notify.title || "设置未能保存", notify.message || String(err && err.message || err));
        }
        return false;
    }
}

// 壁纸承载元素（body 下的 .wallpaper 层）
let wallpaperElement = null;

/**
 * 系统内置壁纸列表。
 * 每套壁纸提供一个 id、展示名称、缩略图与实际图片路径。
 * 若需要新增系统壁纸，在此数组中追加条目即可，界面会自动渲染。
 * @type {Array<{id: string, name: string, url: string, thumb: string}>}
 */
const SYSTEM_WALLPAPERS = [
    {
        id: "sequoia-default",
        name: "Sequoia 经典",
        url: WALLPAPER_DEFAULT,
        thumb: WALLPAPER_DEFAULT,
    },
    {
        id: "sequoia-day",
        name: "Sequoia 白昼",
        url: WALLPAPER_DAY,
        thumb: WALLPAPER_DAY,
    },
    {
        id: "sequoia-night",
        name: "Sequoia 夜色",
        url: WALLPAPER_NIGHT,
        thumb: WALLPAPER_NIGHT,
    },
];

/** 壁纸模块对象 */
const wallpaper = {
    /**
     * 初始化桌面背景系统。
     * 定位壁纸元素，恢复上次保存的壁纸配置（无则应用默认壁纸），
     * 在「每天自动更新 Bing 壁纸」开启时做一次当日检查（每个自然日最多拉一次），
     * 并把着色令牌按当前壁纸算好，同时挂上着色开关的跟随监听。
     * @returns {void}
     */
    init() {
        wallpaperElement = document.querySelector("body > div.wallpaper") || Object.assign(document.createElement("div"), { className: "wallpaper" });
        if (!wallpaperElement.parentNode) document.body.appendChild(wallpaperElement);
        const config = wallpaper.getWallpaperConfig();
        // 默认壁纸已由 main.css（body > div.wallpaper 的 background-image）在渲染时直接呈现，
        // 若配置与默认一致则跳过 JS 重写：避免 LCP 元素初始渲染后二次样式调整与
        // 重复图片请求，缩短 LCP 渲染耗时。仅当用户配置了自定义壁纸时才覆盖。
        // 自定义壁纸其实早在首帧前就由 wallpaper-boot.js 写进 CSS 变量了，这里写内联
        // 样式是为了把「当前壁纸」收敛到壁纸元素自身（后续切换壁纸只改这一处）。
        if (config?.url && config.url !== DEFAULT_WALLPAPER) {
            wallpaper.setWallpaper(config.url);
        }
        // 内联样式已接管（或确认就是默认图），释放 head 引导脚本留下的 CSS 变量覆盖，
        // 避免同一张壁纸存在两个写主。
        const boot = window.__desklyWallpaperBoot;
        if (boot && typeof boot.release === "function") boot.release();
        bindTintEvents();
        applyTint(config?.url);
        logWallpaper("info", `壁纸就绪：${config?.type || "default"}${config?.name ? `（${config.name}）` : ""}`);
        if (isAutoBingEnabled()) applyDailyBing();
    },

    /**
     * 按配置对象应用壁纸：只改界面，不再写存储（实现见模块级 applyConfig）。
     * @param {{type?: string, url: string, name?: string}} config 壁纸配置
     * @returns {boolean} 是否已应用（缺少 url 时返回 false）
     */
    applyConfig(config) {
        return applyConfig(config);
    },

    /**
     * 开关「每天自动更新 Bing 壁纸」（实现见模块级 setAutoBing）。
     * @param {boolean} on 是否开启
     * @returns {boolean} 生效的开关状态
     */
    setAutoBing(on) {
        return setAutoBing(on);
    },

    /**
     * 读取当前壁纸配置。
     * @returns {{type: string, url: string, name?: string}} 壁纸配置对象
     */
    getWallpaperConfig() {
        try {
            const raw = localStorage.getItem(WALLPAPER_CONFIG_KEY);
            if (raw) {
                const config = JSON.parse(raw);
                if (config && config.url) return config;
            }
        } catch { /* 配置损坏时忽略，回退默认 */ }
        return { type: "default", url: DEFAULT_WALLPAPER, name: "Sequoia 经典" };
    },

    /**
     * 保存壁纸配置并广播变更事件。
     * 所有调用点都是用户主动操作（上传 / 网络地址 / 系统壁纸 / Bing / 恢复默认），
     * 因此写入失败必须显式提示，而不是静默丢失。
     * @param {{type: string, url: string, name?: string}} config 壁纸配置对象
     * @returns {boolean} 是否持久化成功（失败时当前会话内壁纸仍已生效，但刷新后会回退）
     */
    saveWallpaperConfig(config) {
        const saved = safeSetItem(WALLPAPER_CONFIG_KEY, JSON.stringify(config), {
            title: "壁纸未能保存",
            message: "本地存储空间不足（自定义图片过大），本次壁纸在当前页面内已生效，但刷新后会恢复为上次保存的壁纸。请改用体积更小的图片。",
        });
        window.dispatchEvent(new CustomEvent("wallpaper-change", { detail: config }));
        // 排在广播之后：appearance.js 也监听 wallpaper-change 并要重算同一批着色令牌，
        // 同一个采样 Promise 的后注册者后完成，于是最终落笔的始终是这里的采样结果。
        applyTint(config?.url);
        return saved;
    },

    /**
     * 设置壁纸（支持网络地址 / Object URL / base64 / 相对路径）。
     * @param {string} url 壁纸图片地址
     */
    setWallpaper(url) {
        if (!wallpaperElement) {
            wallpaper.init();
        }
        Object.assign(wallpaperElement.style, {
            backgroundImage: `url("${url}")`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            backgroundColor: "#1e1e1e",
        });
    },

    /**
     * 预加载图片，校验 URL 是否可以正常加载。
     * @param {string} url 图片地址
     * @returns {Promise<string>} 校验通过后返回原 URL
     */
    preloadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(url);
            img.onerror = () => reject(new Error("图片加载失败，请检查地址是否正确或是否允许跨域访问"));
            img.src = url;
        });
    },

    /**
     * 设置自定义网络壁纸源并持久化（先预加载校验图片有效性）。
     * @param {string} url 网络图片地址
     * @returns {Promise<boolean>} 是否成功应用
     */
    async setNetworkWallpaper(url) {
        const trimmed = (url || "").trim();
        if (!trimmed) return false;
        const validUrl = await wallpaper.preloadImage(trimmed);
        wallpaper.setWallpaper(validUrl);
        wallpaper.saveWallpaperConfig({ type: "network", url: validUrl });
        return true;
    },

    /**
     * 上传本地图片并设为壁纸（持久化为 base64）。
     * 图片尺寸过大时会先压缩，避免超出 localStorage 容量。
     * @param {File} file 本地图片文件
     * @returns {Promise<string>} 生成的 base64 数据
     */
    uploadLocal(file) {
        return new Promise((resolve, reject) => {
            if (!file || !file.type.startsWith("image/")) {
                reject(new Error("请选择有效的图片文件"));
                return;
            }
            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    const dataUrl = await compressImage(reader.result, file.type);
                    wallpaper.setWallpaper(dataUrl);
                    wallpaper.saveWallpaperConfig({ type: "upload", url: dataUrl });
                    resolve(dataUrl);
                } catch (err) {
                    reject(err);
                }
            };
            reader.onerror = () => reject(new Error("读取图片失败"));
            reader.readAsDataURL(file);
        });
    },

    /**
     * 恢复项目默认壁纸（即系统列表中的 Sequoia 经典）。
     */
    resetWallpaper() {
        wallpaper.setWallpaper(DEFAULT_WALLPAPER);
        wallpaper.saveWallpaperConfig({
            type: "default",
            url: DEFAULT_WALLPAPER,
            name: "Sequoia 经典",
        });
    },

    /**
     * 获取系统内置壁纸列表。
     * @returns {Array<{id: string, name: string, url: string, thumb: string}>} 系统壁纸数组
     */
    getSystemWallpapers() {
        return SYSTEM_WALLPAPERS.slice();
    },

    /**
     * 按 ID 切换系统内置壁纸并持久化。
     * @param {string} id 系统壁纸 ID
     * @returns {boolean} 是否切换成功
     */
    setSystemWallpaper(id) {
        const target = SYSTEM_WALLPAPERS.find((w) => w.id === id);
        if (!target) return false;
        wallpaper.setWallpaper(target.url);
        wallpaper.saveWallpaperConfig({
            type: id === "sequoia-default" ? "default" : "system",
            url: target.url,
            name: target.name,
            systemId: target.id,
        });
        return true;
    },

    /**
     * 获取 Bing 每日壁纸并设为壁纸，成功后持久化。
     * 优先使用官方接口，失败时回退到备选第三方接口。
     * @returns {Promise<string>} 壁纸完整地址
     */
    async fetchBingWallpaper() {
        let finalUrl = "";
        let finalName = "Bing 每日壁纸";
        try {
            const result = await fetchBingOfficial();
            finalUrl = result.url;
            if (result.title) finalName = `Bing：${result.title}`;
        } catch {
            const altResult = await fetchBingAlt();
            finalUrl = altResult.url;
            if (altResult.title) finalName = `Bing：${altResult.title}`;
        }
        // 预加载一次，避免跨域/失效时界面空白
        await wallpaper.preloadImage(finalUrl);
        wallpaper.setWallpaper(finalUrl);
        wallpaper.saveWallpaperConfig({ type: "bing", url: finalUrl, name: finalName });
        return finalUrl;
    },
};

/**
 * 按配置对象应用壁纸：只画界面、不再写存储。
 * 设置中枢是 `wallpaper.config` 的唯一写入方（落盘由它完成），owner 侧只需要
 * 「把这个配置画出来」，避免两处各写一次 localStorage。
 * @param {{type?: string, url: string, name?: string}} config 壁纸配置
 * @returns {boolean} 是否已应用（缺少 url 时返回 false）
 */
export function applyConfig(config) {
    const url = config && typeof config === "object" ? String(config.url || "") : "";
    if (!url) return false;
    wallpaper.setWallpaper(url);
    window.dispatchEvent(new CustomEvent("wallpaper-change", { detail: { ...config, url } }));
    applyTint(url);
    return true;
}

/**
 * 开关「每天自动更新 Bing 壁纸」。落盘由设置中枢负责（本函数是它的 apply），
 * 这里只让它真的生效：打开时立即做一次当日检查，与开机检查共用
 * 「每个自然日最多拉取一次」的记账规则，所以当天已经自动换过时不会重复请求；
 * 关闭时不需要撤销已应用的壁纸。
 * 开关形态与 cursor.js 一致：显式的 "off" / "false" / "0" 才算关，其余按真值判断，
 * 这样老调用方传字符串也不会被 Boolean("off") 误判成开启。
 * @param {boolean|string} on 是否开启
 * @returns {boolean} 生效的开关状态
 */
export function setAutoBing(on) {
    const enabled = Boolean(on) && on !== "off" && on !== "false" && on !== "0";
    if (enabled) applyDailyBing();
    return enabled;
}

/**
 * 开启自动更新时的当日检查：页面不可见或今日已应用过就跳过，失败保持当前壁纸不动。
 * 与用户主动点「获取 Bing 壁纸」的区别在于不打扰：走 fetchBingOfficial /
 * fetchBingAlt 取地址，落盘用不带弹窗的 quiet 路径（自动换壁纸失败却弹一个
 * 错误框，比不换壁纸更糟）。离线 / 接口变更 / 配额异常只记一条 error 进运行记录。
 * @returns {Promise<boolean>} 是否换了新壁纸
 */
async function applyDailyBing() {
    // 后台标签页 / 锁屏时不发请求：反正没人看，省下流量与一次解码，
    // 下一个自然日的开机检查照常进行（记账槽没写，日期到了还会再试）。
    if (document.visibilityState === "hidden") return false;
    const today = todayKey();
    if (readSlot(BING_DATE_SLOT) === today) return false;
    let config = null;
    try {
        const found = await fetchBingOfficial().catch(fetchBingAlt);
        config = { type: "bing", url: found.url, name: found.title ? `Bing：${found.title}` : "Bing 每日壁纸" };
        await wallpaper.preloadImage(config.url);
    } catch (err) {
        // 失败绝不 blank 桌面：不碰 setWallpaper，当前壁纸原样留着
        errorLog(`Bing 每日壁纸拉取失败，保留当前壁纸：${String((err && err.message) || err)}`, err);
        return false;
    }
    wallpaper.setWallpaper(config.url);
    persistConfigQuietly(config);
    writeSlotQuietly(BING_DATE_SLOT, today);
    logWallpaper("info", `已应用 Bing 每日壁纸（${today}）`);
    return true;
}

/**
 * 落盘壁纸配置并广播变更，但不做失败弹窗：调用方是自动行为（每日 Bing），
 * 用户没发起任何操作，此时弹「未能保存」只会造成困惑。
 * @param {{type: string, url: string, name?: string}} config 壁纸配置
 * @returns {boolean} 是否持久化成功
 */
function persistConfigQuietly(config) {
    const saved = safeSetItem(WALLPAPER_CONFIG_KEY, JSON.stringify(config));
    window.dispatchEvent(new CustomEvent("wallpaper-change", { detail: config }));
    applyTint(config?.url);
    return saved;
}

/**
 * 让着色令牌跟随「外观 - 墙纸着色」开关：开关只是 data-wallpaper-tint 的显隐，
 * 令牌由本模块常驻维护，所以监听它翻动时重算一次（换过壁纸却没触发过着色时也不会漏）。
 * 只绑一次，模块重载 / 多次 import 都复用同一监听。
 * @returns {void}
 */
function bindTintEvents() {
    if (bindTintEvents.bound) return;
    bindTintEvents.bound = true;
    window.addEventListener("appearance-tint-change", () => applyTint());
}

/**
 * 取图片平均色（窗口着色用），返回 `[r, g, b]`。
 * 把图缩到 16x16 后对所有采样点求均值：着色要的是「整体色调」而不是最亮那块，
 * 均值最直接，而且 256 个像素的成本可以忽略。
 * 只允许同源资源与 data URL —— 跨域地址没给 CORS 头时画布会被污染（getImageData 抛
 * SecurityError），与其每次白跑一遍解码，不如在入口就判定不可采样。加载失败、解码失败、
 * 画布不可用一律回退中性灰，并缓存该结果，绝不让取色把界面卡住或抛错。
 * @param {string} url 图片地址（站内相对路径 / data URL）
 * @returns {Promise<[number, number, number]>} 平均色通道值（0..255）
 */
export async function getDominantColor(url) {
    const target = String(url || "");
    if (!target || !isSamplable(target)) return [...TINT_FALLBACK_RGB];
    let job = dominantCache.get(target);
    if (!job) {
        job = sampleAverageColor(target).catch((err) => {
            warnLog(`主色采样失败，回退 ${TINT_FALLBACK}：${target.slice(0, 80)}`, err);
            return [...TINT_FALLBACK_RGB];
        });
        dominantCache.set(target, job);
    }
    return [...(await job)];
}

/**
 * 是否允许取样：同源资源（含 `./assets/...` 这类站内相对地址）与 data URL。
 * 比对的是协议 + 主机 + 端口，而不是 `URL.origin` —— 后者在 `chrome-extension://`
 * 这类非标准协议下会给出 "null"（扩展页恰恰就是这种 URL），会把站内壁纸全误判成跨域。
 * @param {string} url 图片地址
 * @returns {boolean} 是否可以安全读取像素
 */
function isSamplable(url) {
    if (url.startsWith("data:")) return true;
    try {
        const abs = new URL(url, document.baseURI);
        return abs.protocol === window.location.protocol && abs.host === window.location.host;
    } catch {
        return false;
    }
}

/**
 * 实际的采样：解码 -> 画进 16x16 画布 -> 求平均。
 * @param {string} url 图片地址
 * @returns {Promise<[number, number, number]>} 平均色通道值
 */
async function sampleAverageColor(url) {
    const img = await loadForSampling(url);
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_EDGE;
    canvas.height = SAMPLE_EDGE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    // 关掉平滑缩放：这里要的是「16x16 个点的平均」，插值只会把相邻像素糊进采样集
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
    return averageRgb(ctx.getImageData(0, 0, SAMPLE_EDGE, SAMPLE_EDGE).data);
}

/**
 * 以匿名跨域模式加载图片（不带 crossOrigin 时画布会被判定为被污染而无法取样）。
 * @param {string} url 图片地址
 * @returns {Promise<HTMLImageElement>} 加载完成的图片
 */
function loadForSampling(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.decoding = "async";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("图片加载失败或不允许跨域取样"));
        img.src = url;
    });
}

/**
 * 从 RGBA 像素数组求平均色（跳过近乎全透明的像素）。
 * @param {Uint8ClampedArray} data RGBA 像素数据
 * @returns {[number, number, number]} 平均色通道值（无有效像素时返回兜底）
 */
function averageRgb(data) {
    let count = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 32) continue;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count += 1;
    }
    if (!count) return [...TINT_FALLBACK_RGB];
    return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
}

/**
 * 按当前壁纸刷新 <html> 上的着色令牌。
 * 令牌**常驻写入**（着色开关关着时也算好写上），这样用户拨开开关是即时变色，
 * 而不是「第一次打开先闪一下灰」。新令牌 `--wallpaper-tint-color` / `-rgb` 给
 * 壁纸侧的界面用；`--window-tint` / `--window-tint-rgb` 是样式表（window.css、
 * controlcenter.css、main.css 的设置侧栏）当前实际消费的旧令牌，两处一起写，
 * 于是所有着色令牌都出自同一个采样器。
 * @param {string} [url] 指定取色图片；缺省取当前壁纸配置里的 url
 * @returns {Promise<string>} 实际写入的十六进制色值
 */
export async function applyTint(url) {
    const target = url || wallpaper.getWallpaperConfig()?.url || "";
    const [r, g, b] = await getDominantColor(target);
    const hex = rgbToHex([r, g, b]);
    const rgbText = `${r}, ${g}, ${b}`;
    const root = document.documentElement;
    root.style.setProperty("--wallpaper-tint-color", hex);
    root.style.setProperty("--wallpaper-tint-rgb", rgbText);
    root.style.setProperty("--window-tint", hex);
    root.style.setProperty("--window-tint-rgb", rgbText);
    // 着色令牌落地的这一刻必须单独广播一次：wallpaper-change 是在这里之前发的
    // （applyConfig / setWallpaper / init 都是先 dispatch 再 fire-and-forget 调本函数），
    // 只听那一件事的消费者拿到的一直是上一张壁纸的颜色 —— 实测：换成白昼壁纸后
    // --surface-text-wallpaper 仍停在暗壁纸的 #fff，整站文字色慢了一整轮。
    window.dispatchEvent(new CustomEvent("wallpaper-tint-change", { detail: { rgb: rgbText, hex } }));
    return hex;
}

/**
 * 将 dataURL 图片压缩为 JPEG dataURL（最大边长不超过限制）。
 * 若原图已小于限制且为 JPEG，则直接返回，避免不必要的转码。
 * @param {string} dataUrl 原始图片 dataURL
 * @param {string} mimeType 原始图片 MIME 类型
 * @returns {Promise<string>} 压缩后的 base64 dataURL
 */
function compressImage(dataUrl, mimeType) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            const { width, height } = image;
            const scale = Math.min(1, UPLOAD_MAX_EDGE / Math.max(width, height));
            if (scale === 1 && mimeType === "image/jpeg") {
                resolve(dataUrl);
                return;
            }
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(width * scale);
            canvas.height = Math.round(height * scale);
            const ctx = canvas.getContext("2d");
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/jpeg", UPLOAD_JPEG_QUALITY));
        };
        image.onerror = () => reject(new Error("图片解码失败"));
        image.src = dataUrl;
    });
}

/**
 * 从 Bing 官方接口获取当日壁纸地址及标题。
 * @returns {Promise<{url: string, title: string}>} 包含完整地址与图片标题的对象
 */
async function fetchBingOfficial() {
    const response = await fetch(BING_API_URL);
    if (!response.ok) {
        throw new Error(`Bing 接口请求失败：${response.status}`);
    }
    const data = await response.json();
    const image = data.images && data.images[0];
    if (!image || !image.url) {
        throw new Error("Bing 接口返回数据异常");
    }
    // 接口返回的 url 为相对路径，需拼接域名；同时提升为高清 UHD 分辨率
    const url = `https://www.bing.com${image.url.replace("1920x1080", "UHD")}`;
    const title = (image.copyright || image.title || "").replace(/\s*\(.*?\)\s*$/, "").trim();
    return { url, title };
}

/**
 * 从备选第三方接口获取 Bing 壁纸地址及标题。
 * @returns {Promise<{url: string, title: string}>} 包含完整地址与图片标题的对象
 */
async function fetchBingAlt() {
    const response = await fetch(BING_API_ALT_URL);
    if (!response.ok) {
        throw new Error(`备选接口请求失败：${response.status}`);
    }
    const data = await response.json();
    // 备选接口常见返回结构：{ data: { url: "..." } } 或 { img: "..." }
    const url = (data && (data.url || data.img || (data.data && data.data.url))) || "";
    if (!url) {
        throw new Error("备选接口返回数据异常");
    }
    const title = (data && (data.title || (data.data && data.data.title))) || "";
    return { url, title };
}

export { wallpaper };