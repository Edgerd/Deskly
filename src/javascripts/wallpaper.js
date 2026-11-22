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
 * 持久化（0.4.0 重构）：
 *   图片本体进 IndexedDB（库 deskly-wallpaper / 表 images，blob 直存，不走 base64），
 *   localStorage 只存引用 { type, url, name?, sourceUrl?, thumb?, bytes? }：
 *     url = "idb:<id>"  →  本体在 IndexedDB（upload / network / bing 三类都落盘缓存）；
 *     url = 直链        →  站内系统壁纸或缓存失败时的网络外链（旧行为兼容）；
 *     thumb             →  48px JPEG 小图，wallpaper-boot.js 首帧先铺它（模糊但同色同图），
 *                          全尺寸图由 init 异步从 IndexedDB 换回，不再先闪默认壁纸。
 *   旧的 base64 data: 配置在启动时懒迁移进 IndexedDB（localStorage 配额因此释放）。
 *   写入 IndexedDB 失败（隐私模式 / 配额）会弹一次可见提示，不静默丢失。
 *   Bing 自动更新另用一个记账槽 wallpaper-bing-date（最近一次成功应用的日期）。
 *
 * 着色令牌由本模块统一产出：壁纸主色只有这里能算（采样器在本文件），所以
 * `--wallpaper-tint-color` / `--wallpaper-tint-rgb` 与样式表正在消费的旧令牌
 * `--window-tint` / `--window-tint-rgb` 都在 `applyTint()` 里写，着色开关关着时
 * 也照样更新，拨开即变色。
 */

import { assetPath } from "./paths.js";
import { settings } from "./settings.js";

// 系统内置壁纸资源（默认壁纸同时是列表第一项，也是取不到配置时的回退）
const WALLPAPER_DEFAULT = assetPath("images/Wallpaper.png");
const WALLPAPER_DAY = assetPath("images/sequoia.shape.day.jpg");
const WALLPAPER_NIGHT = assetPath("images/sequoia.shape.night.jpg");
const DEFAULT_WALLPAPER = WALLPAPER_DEFAULT;

const WALLPAPER_CONFIG_KEY = "wallpaper-config";
// 「每天自动更新 Bing 壁纸」开关的存储槽（= 设置项 wallpaper.autoBing 的推导槽名）
const AUTO_BING_SLOT = "wallpaper-autoBing";
// 最近一次成功应用 Bing 壁纸的自然日（记账槽，不是设置项）
const BING_DATE_SLOT = "wallpaper-bing-date";
// 每日 Bing 的跨标签页在途锁（值为毫秒时间戳）：双标签同日只拉一次（BUG-46c）
const BING_LOCK_SLOT = "wallpaper-bing-daily-lock";
// 主色采样取不到值时的兜底 RGB（中性蓝灰，与 macOS 窗口底色同调，样式表里也有一份同名兜底）
const TINT_FALLBACK_RGB = [107, 124, 147];
// 同一色的十六进制形态（着色令牌 --*-tint-color 用它）
const TINT_FALLBACK = rgbToHex(TINT_FALLBACK_RGB);
// 主色采样画布边长：16x16 只是「取平均色」，不是缩略图
const SAMPLE_EDGE = 16;

const UPLOAD_MAX_EDGE = 2560;
const UPLOAD_JPEG_QUALITY = 0.85;

// IndexedDB：壁纸本体（blob）的持久层。localStorage 配置里只留 "idb:<id>" 引用。
const IDB_NAME = "deskly-wallpaper";
const IDB_STORE = "images";
const IDB_PREFIX = "idb:";
// 首帧引导小图边长（px）：48px JPEG 约 2–4KB，localStorage 毫无压力
const BOOT_THUMB_EDGE = 48;

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

// ---- IndexedDB 本体层（探针直接测这四个函数） ----

/** 会话内 objectURL 缓存：同一 id 只 create 一次，避免重复分配与泄漏。 */
const objectUrlCache = new Map();

/** 已弹过的提示（按标题去重）：同一失败不连环弹窗。 */
const notifiedTitles = new Set();

/**
 * 可见提示：写入/恢复失败必须可感知。优先系统弹窗，弹窗不可用退到运行记录。
 * @param {string} title 标题
 * @param {string} message 正文
 * @returns {void}
 */
function notifyOnce(title, message) {
    if (notifiedTitles.has(title)) return;
    notifiedTitles.add(title);
    if (window.__dialog && typeof window.__dialog.error === "function") {
        window.__dialog.error(title, message);
    } else {
        warnLog(`${title}：${message}`);
    }
}

/**
 * 打开壁纸库（首次创建对象仓库）。
 * @returns {Promise<IDBDatabase>} 数据库句柄
 */
function idbOpen() {
    return new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) {
            reject(new Error("IndexedDB 不可用"));
            return;
        }
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("IndexedDB 打开失败"));
    });
}

/**
 * 写入一张壁纸本体。
 * @param {string} id 图片 id（upload / network / bing）
 * @param {Blob} blob 图片本体
 * @returns {Promise<boolean>} 是否写入成功
 */
async function idbPutImage(id, blob) {
    const db = await idbOpen();
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).put(blob, id);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error || new Error("IndexedDB 写入失败"));
        });
        return true;
    } finally {
        db.close();
    }
}

/**
 * 读一张壁纸本体。
 * @param {string} id 图片 id
 * @returns {Promise<Blob|null>} 图片本体；不存在为 null
 */
async function idbGetImage(id) {
    const db = await idbOpen();
    try {
        return await new Promise((resolve, reject) => {
            const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error || new Error("IndexedDB 读取失败"));
        });
    } finally {
        db.close();
    }
}

/**
 * 由本体取（或建）会话级 objectURL。
 * @param {string} id 图片 id
 * @param {Blob} blob 图片本体
 * @returns {string} objectURL
 */
function objectUrlFor(id, blob) {
    let url = objectUrlCache.get(id);
    if (!url) {
        url = URL.createObjectURL(blob);
        objectUrlCache.set(id, url);
    }
    return url;
}

/**
 * 把配置里的 url 解析成可显示地址："idb:<id>" → objectURL，其余原样返回。
 * @param {{url?: string}} config 壁纸配置
 * @returns {Promise<string>} 可用于 CSS 的地址
 */
async function resolveConfigUrl(config) {
    const url = String(config?.url || "");
    if (!url.startsWith(IDB_PREFIX)) return url;
    const id = url.slice(IDB_PREFIX.length);
    if (objectUrlCache.has(id)) return objectUrlCache.get(id);
    const blob = await idbGetImage(id);
    if (!blob) throw new Error(`本地壁纸数据缺失（${id}）`);
    return objectUrlFor(id, blob);
}

/**
 * 生成首帧引导小图（48px JPEG dataURL，失败为空串 —— 没有小图就退回直链引导）。
 * @param {Blob} blob 图片本体
 * @returns {Promise<string>} dataURL 或 ""
 */
async function buildThumb(blob) {
    try {
        const url = URL.createObjectURL(blob);
        try {
            const img = await new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error("缩略图解码失败"));
                image.src = url;
            });
            const scale = BOOT_THUMB_EDGE / Math.max(img.width, img.height, 1);
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
            return canvas.toDataURL("image/jpeg", 0.6);
        } finally {
            URL.revokeObjectURL(url);
        }
    } catch (err) {
        warnLog("缩略图生成失败（首帧引导退回直链）：", err);
        return "";
    }
}

/**
 * 拉取网络壁纸本体并落盘 IndexedDB（离线/限频时的显示保障）。
 * 跨域被拒、非图片响应、IDB 写失败都返回 null —— 调用方退回「只存外链」的旧行为。
 * @param {string} id 图片 id
 * @param {string} url 远程地址
 * @returns {Promise<{blob: Blob}|null>} 成功为本体，失败为 null
 */
async function cacheRemoteImage(id, url) {
    try {
        const response = await fetch(url, { mode: "cors" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (!blob || !String(blob.type || "").startsWith("image/")) throw new Error("响应不是图片");
        await idbPutImage(id, blob);
        return { blob };
    } catch (err) {
        warnLog(`网络壁纸缓存失败，退回只存外链（${url.slice(0, 60)}）：`, err);
        return null;
    }
}

/**
 * 旧版 base64（data:）配置懒迁移进 IndexedDB：本体搬走、配置换成引用 + 小图。
 * 迁移失败保持原样（旧的 data: 配置本次仍能显示，只是继续占配额）。
 * @param {object} config 当前配置
 * @returns {Promise<void>}
 */
async function migrateLegacyDataUrl(config) {
    try {
        const blob = await (await fetch(config.url)).blob();
        await idbPutImage("upload", blob);
        const thumb = await buildThumb(blob);
        safeSetItem(WALLPAPER_CONFIG_KEY, JSON.stringify({
            ...config, url: `${IDB_PREFIX}upload`, thumb, bytes: blob.size,
        }));
        logWallpaper("info", "旧版 base64 墙纸已迁移到 IndexedDB，localStorage 配额已释放");
    } catch (err) {
        warnLog("旧版墙纸迁移失败（保持原样）：", err);
    }
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
        // 恢复上次的壁纸：idb: 引用要异步取本体（首帧已由 wallpaper-boot 用 thumb 兜住，
        // 这里异步换回全尺寸图）；直链 / 默认图维持原同步路径。
        restoreConfig(config);
        // 内联样式已接管（或确认就是默认图），释放 head 引导脚本留下的 CSS 变量覆盖，
        // 避免同一张壁纸存在两个写主。
        const boot = window.__desklyWallpaperBoot;
        if (boot && typeof boot.release === "function") boot.release();
        bindTintEvents();
        // 动态墙纸 / 图集轮换 / 主题配对 / 屏幕保护程序四台引擎随 init 一起点亮
        startWallpaperEngines(config);
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
            title: "墙纸未能保存",
            message: "本地存储空间不足（自定义图片过大），本次墙纸在当前页面内已生效，但刷新后会恢复为上次保存的壁纸。请改用体积更小的图片。",
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
            // JSON.stringify 自带转义：含引号/反斜杠的自定义 URL 不会把整条声明弄失效（BUG-46a）
            backgroundImage: `url(${JSON.stringify(url)})`,
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
     * 本体尽力落盘 IndexedDB：成功则离线也能显示；跨域/写盘失败退回「只存外链」旧行为。
     * @param {string} url 网络图片地址
     * @returns {Promise<boolean>} 是否成功应用
     */
    async setNetworkWallpaper(url) {
        const trimmed = (url || "").trim();
        if (!trimmed) return false;
        const validUrl = await wallpaper.preloadImage(trimmed);
        const cached = await cacheRemoteImage("network", validUrl);
        if (cached) {
            const thumb = await buildThumb(cached.blob);
            wallpaper.setWallpaper(objectUrlFor("network", cached.blob));
            wallpaper.saveWallpaperConfig({
                type: "network", url: `${IDB_PREFIX}network`, sourceUrl: validUrl,
                thumb, bytes: cached.blob.size,
            });
        } else {
            wallpaper.setWallpaper(validUrl);
            wallpaper.saveWallpaperConfig({ type: "network", url: validUrl, sourceUrl: validUrl });
        }
        return true;
    },

    /**
     * 上传本地图片并设为壁纸。
     * 压缩后的本体写入 IndexedDB（不再是 base64 塞 localStorage —— 那是 5MB 配额下
     * 「看着生效、刷新就丢」的根因），配置里只留 "idb:upload" 引用与 48px 引导小图。
     * 写盘失败（隐私模式 / 配额）弹一次可见提示，本次会话内壁纸仍生效但不持久化。
     * @param {File} file 本地图片文件
     * @returns {Promise<{url: string, bytes: number, persisted: boolean}>} 显示地址与体积信息
     */
    async uploadLocal(file) {
        if (!file || !file.type.startsWith("image/")) throw new Error("请选择有效的图片文件");
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error("读取图片失败"));
            reader.readAsDataURL(file);
        });
        const compressed = await compressImage(dataUrl, file.type);
        const blob = await (await fetch(compressed)).blob();
        try {
            await idbPutImage("upload", blob);
        } catch (err) {
            warnLog("上传壁纸写入 IndexedDB 失败，本次不持久化：", err);
            wallpaper.setWallpaper(compressed);
            applyTint(compressed);
            notifyOnce("墙纸未能保存",
                "本地存储不可用或已满，本次墙纸只在当前页面生效，刷新后会恢复为上次保存的墙纸。");
            return { url: compressed, bytes: blob.size, persisted: false };
        }
        const thumb = await buildThumb(blob);
        const viewUrl = objectUrlFor("upload", blob);
        wallpaper.setWallpaper(viewUrl);
        wallpaper.saveWallpaperConfig({ type: "upload", url: `${IDB_PREFIX}upload`, thumb, bytes: blob.size });
        return { url: viewUrl, bytes: blob.size, persisted: true };
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
        let finalName = "Bing 每日墙纸";
        try {
            const result = await fetchBingOfficial();
            finalUrl = result.url;
            if (result.title) finalName = `Bing：${result.title}`;
        } catch {
            const altResult = await fetchBingAlt();
            finalUrl = altResult.url;
            if (altResult.title) finalName = `Bing：${altResult.title}`;
        }
        // 预加载一次，避免跨域/失效时界面空白；本体落盘缓存，离线/限频时仍能显示
        await wallpaper.preloadImage(finalUrl);
        const cached = await cacheRemoteImage("bing", finalUrl);
        if (cached) {
            const thumb = await buildThumb(cached.blob);
            wallpaper.setWallpaper(objectUrlFor("bing", cached.blob));
            wallpaper.saveWallpaperConfig({
                type: "bing", url: `${IDB_PREFIX}bing`, sourceUrl: finalUrl,
                name: finalName, thumb, bytes: cached.blob.size,
            });
        } else {
            wallpaper.setWallpaper(finalUrl);
            wallpaper.saveWallpaperConfig({ type: "bing", url: finalUrl, sourceUrl: finalUrl, name: finalName });
        }
        return finalUrl;
    },

    /**
     * 开关动态墙纸（设置项 wallpaper.dynamic 的 apply）。实现见下方引擎段。
     * @param {boolean|string} on 是否开启
     * @returns {boolean} 生效的开关状态
     */
    setDynamicEnabled(on) {
        return setDynamicEnabled(on);
    },

    /**
     * 用当前「图集墙纸」设置开始轮换并持久化 album 配置；列表为空返回 false。
     * @returns {Promise<boolean>} 是否成功进入图集模式
     */
    async startAlbum() {
        return startAlbumWallpaper();
    },

    /**
     * 应用「随主题切换」的浅色/深色两张壁纸并持久化 themePair 配置。
     * @param {string} light 浅色侧地址（系统壁纸 id 或任意图片地址）
     * @param {string} dark 深色侧地址
     * @returns {Promise<boolean>} 是否成功保存并应用
     */
    async setThemePair(light, dark) {
        return saveThemePair(light, dark);
    },
};

/**
 * 启动恢复：把配置解析成可显示地址并铺到壁纸元素。
 * idb: 引用异步取本体；读失败（数据缺失 / IndexedDB 不可用）回退默认壁纸并弹一次
 * 可见提示 —— 不白屏、不静默丢。直链配置维持同步路径，旧 base64 配置顺手懒迁移。
 * @param {{type?: string, url?: string, name?: string}} config 壁纸配置
 * @returns {Promise<void>}
 */
async function restoreConfig(config) {
    const url = String(config?.url || "");
    if (!url || url === DEFAULT_WALLPAPER) {
        applyTint(url || DEFAULT_WALLPAPER);
        return;
    }
    if (url.startsWith(IDB_PREFIX)) {
        try {
            const objectUrl = await resolveConfigUrl(config);
            wallpaper.setWallpaper(objectUrl);
            applyTint(objectUrl);
        } catch (err) {
            warnLog("本地壁纸恢复失败，回退默认壁纸：", err);
            wallpaper.setWallpaper(DEFAULT_WALLPAPER);
            applyTint(DEFAULT_WALLPAPER);
            notifyOnce("墙纸未能恢复",
                "本地保存的墙纸数据读不出来，已回退到默认墙纸。网络墙纸可在系统设置中重新拉取。");
        }
        return;
    }
    wallpaper.setWallpaper(url);
    applyTint(url);
    if (url.startsWith("data:")) migrateLegacyDataUrl(config);
}

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
    if (url.startsWith(IDB_PREFIX)) {
        // 设置中枢回放 idb: 配置：异步取本体再铺，失败回退默认并复用同一提示路径
        resolveConfigUrl(config)
            .then((objectUrl) => {
                wallpaper.setWallpaper(objectUrl);
                applyTint(objectUrl);
            })
            .catch((err) => {
                warnLog("墙纸配置应用失败，回退默认壁纸：", err);
                wallpaper.setWallpaper(DEFAULT_WALLPAPER);
                applyTint(DEFAULT_WALLPAPER);
                notifyOnce("墙纸未能恢复",
                    "本地保存的墙纸数据读不出来，已回退到默认墙纸。网络墙纸可在系统设置中重新拉取。");
            });
        window.dispatchEvent(new CustomEvent("wallpaper-change", { detail: { ...config, url } }));
        return true;
    }
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
    // 跨标签页互斥（BUG-46c）：两个标签页同一天先后通过日期检查会各拉一次 Bing。
    // 拉取前先落「在途」时间戳，另一标签页看到近 2 分钟内的锁即放弃；完成/失败都释放。
    const lockRaw = readSlot(BING_LOCK_SLOT);
    if (lockRaw && Date.now() - Number(lockRaw) < 2 * 60 * 1000) return false;
    writeSlotQuietly(BING_LOCK_SLOT, String(Date.now()));
    try {
        let config = null;
        try {
            const found = await fetchBingOfficial().catch(fetchBingAlt);
            config = { type: "bing", url: found.url, name: found.title ? `Bing：${found.title}` : "Bing 每日墙纸" };
            await wallpaper.preloadImage(config.url);
        } catch (err) {
            // 失败绝不 blank 桌面：不碰 setWallpaper，当前壁纸原样留着
            errorLog(`Bing 每日壁纸拉取失败，保留当前壁纸：${String((err && err.message) || err)}`, err);
            return false;
        }
        // 与用户手动拉取同一条落盘缓存路径：明天断网也能看到今天的 Bing
        const cached = await cacheRemoteImage("bing", config.url);
        if (cached) {
            const thumb = await buildThumb(cached.blob);
            wallpaper.setWallpaper(objectUrlFor("bing", cached.blob));
            persistConfigQuietly({
                ...config, url: `${IDB_PREFIX}bing`, sourceUrl: config.url, thumb, bytes: cached.blob.size,
            });
        } else {
            wallpaper.setWallpaper(config.url);
            persistConfigQuietly({ ...config, sourceUrl: config.url });
        }
        writeSlotQuietly(BING_DATE_SLOT, today);
        logWallpaper("info", `已应用 Bing 每日壁纸（${today}）`);
        return true;
    } finally {
        try { localStorage.removeItem(BING_LOCK_SLOT); } catch { /* 存储被禁用时锁自然过期 */ }
    }
}

/**
 * 落盘壁纸配置并广播变更，但不做失败弹窗：调用方是自动行为（每日 Bing），
 * 用户没发起任何操作，此时弹「未能保存」只会造成困惑。
 * @param {{type: string, url: string, name?: string}} config 壁纸配置
 * @returns {boolean} 是否持久化成功
 */
// ---- 动态墙纸 / 图集 / 主题配对 / 屏幕保护程序引擎 ----
//
// 四台引擎都挂在同一个事实源上：localStorage 的壁纸配置（WALLPAPER_CONFIG_KEY）
// 与设置中枢的 wallpaper.* / screensaver.* 定义。约束：
//   1. 配置里的 url 一律是「可重放」的地址（系统资源路径 / 外链 / idb: 引用），
//      objectURL 只用于当次显示，绝不落盘 —— 刷新后还能画回来；
//   2. 动态墙纸开启时会「托管」配置（type:"dynamic"），关闭时按默认壁纸恢复；
//   3. 屏保把 idleMinutes 当倒计时，activity 重置，与 lock.js 的空闲看门狗同思路。

/** 动态墙纸默认时段表（与 settings-definitions.js 的 wallpaper.dynamicSet default 保持一致）。 */
const DYNAMIC_FALLBACK_SLOTS = [
    { from: 5, systemId: "sequoia-default" },
    { from: 8, systemId: "sequoia-day" },
    { from: 17, systemId: "sequoia-night" },
];

/** 屏幕保护程序的活动事件（任意一个都视为「有人的痕迹」）。 */
const SCREENSAVER_IDLE_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"];

/** 引擎运行期状态（模块单例；init 幂等，重复调用不会叠加定时器）。 */
const engine = {
    started: false,
    dynamicTimer: null,
    dynamicOn: false,
    dynamicCurrent: "",      // 最近一次铺上的 systemId，避免每分钟重复淡入
    albumTimer: null,
    fadeTimer: null,
    screensaverActive: false,
    screensaverIdleTimer: null,
    screensaverClockTimer: null,
    screensaverNode: null,
    screensaverSource: "overlay", // overlay（全屏盖住）/ wallpaper（铺进墙纸层）
};

/** 系统壁纸 id -> 资源地址；未知 id 返回 null。 */
function systemIdToUrl(id) {
    const hit = SYSTEM_WALLPAPERS.find((item) => item.id === String(id || ""));
    return hit ? hit.url : null;
}

/**
 * 把图集/主题配对里的「条目」归一成可持久化的地址：系统壁纸 id 换成资源路径，
 * 其余（外链 / idb: 引用）原样返回。空输入返回空串。
 * @param {string} entry 条目原文
 * @returns {string} 可持久化地址
 */
function normalizeWallpaperEntry(entry) {
    const text = String(entry || "").trim();
    if (!text) return "";
    return systemIdToUrl(text) || text;
}

/**
 * 把条目解析成当次可显示地址：idb: 引用异步取本体换 objectURL，其余原样。
 * @param {string} entry 已归一化条目
 * @returns {Promise<string>} 可显示地址
 */
async function resolveWallpaperEntry(entry) {
    const text = String(entry || "");
    if (!text.startsWith(IDB_PREFIX)) return text;
    const id = text.slice(IDB_PREFIX.length);
    if (objectUrlCache.has(id)) return objectUrlCache.get(id);
    const blob = await idbGetImage(id);
    if (!blob) throw new Error(`图集条目本体缺失（${id}）`);
    return objectUrlFor(id, blob);
}

/**
 * 交叉淡入：把新地址铺到壁纸元素上的临时图层，淡入完成后换成正式背景并清图层。
 * @param {string} url 可显示地址
 * @returns {void}
 */
function crossFadeTo(url) {
    if (!wallpaperElement) return;
    ensureEngineStyle();
    const layer = document.createElement("div");
    layer.className = "wallpaper-fade";
    layer.style.backgroundImage = `url("${String(url).replace(/"/g, "%22")}")`;
    wallpaperElement.appendChild(layer);
    // 双 rAF 确保初始透明度先被样式收编，再切到 1 才有过渡
    requestAnimationFrame(() => {
        requestAnimationFrame(() => { layer.style.opacity = "1"; });
    });
    if (engine.fadeTimer) clearTimeout(engine.fadeTimer);
    engine.fadeTimer = setTimeout(() => {
        wallpaper.setWallpaper(url);
        layer.remove();
        engine.fadeTimer = null;
    }, 1300);
}

/**
 * 按小时挑动态时段（纯函数，探针直接测）：取「from <= hour」里最近的一个；
 * 凌晨（0-4 点）落在最后一个时段（夜色）。
 * @param {Array<{from:number,systemId:string}>} slots 时段表
 * @param {number} hour 当前小时 0-23
 * @returns {{from:number,systemId:string}|null} 命中的时段
 */
function dynamicSlotForHour(slots, hour) {
    const sorted = (Array.isArray(slots) ? slots : [])
        .filter((slot) => slot && Number.isFinite(Number(slot.from)) && systemIdToUrl(slot.systemId))
        .sort((a, b) => Number(a.from) - Number(b.from));
    if (!sorted.length) return null;
    let hit = sorted[0];
    sorted.forEach((slot) => { if (hour >= Number(slot.from)) hit = slot; });
    return hit;
}

/** 读图集地址列表（设置项 wallpaper.album，条目先归一化，空串丢弃）。 */
function albumEntries() {
    const raw = settings.get("wallpaper.album");
    return (Array.isArray(raw) ? raw : [])
        .map((entry) => normalizeWallpaperEntry(entry))
        .filter(Boolean);
}

/** 读图集换图间隔（分钟，钳在 5-120；异常回退 30）。 */
function albumIntervalMinutes() {
    const value = Number(settings.get("wallpaper.albumInterval"));
    if (!Number.isFinite(value)) return 30;
    return Math.min(120, Math.max(5, Math.round(value)));
}

/** 停掉图集轮换定时器（配置被改成非 album 时自动收摊）。 */
function stopAlbumRotation() {
    if (engine.albumTimer) {
        clearInterval(engine.albumTimer);
        engine.albumTimer = null;
    }
}

/** 图集轮换一步：算下一张、交叉淡入、把进度写回配置。 */
async function advanceAlbum() {
    const config = wallpaper.getWallpaperConfig();
    if (!config || config.type !== "album") {
        stopAlbumRotation();
        return false;
    }
    const entries = albumEntries();
    if (!entries.length) return false;
    const nextIndex = ((Number(config.index) || 0) + 1) % entries.length;
    const url = await resolveWallpaperEntry(entries[nextIndex]);
    crossFadeTo(url);
    persistConfigQuietly({ type: "album", url: entries[nextIndex], index: nextIndex, name: "图集" });
    return true;
}

/**
 * 进入图集模式：校验列表非空、铺第一张、持久化 album 配置并启动轮换定时器。
 * @returns {Promise<boolean>} 是否成功
 */
async function startAlbumWallpaper() {
    const entries = albumEntries();
    if (!entries.length) {
        warnLog("图集为空，未进入图集模式");
        return false;
    }
    stopAlbumRotation();
    const url = await resolveWallpaperEntry(entries[0]);
    crossFadeTo(url);
    persistConfigQuietly({ type: "album", url: entries[0], index: 0, name: "图集" });
    engine.albumTimer = setInterval(() => { advanceAlbum(); }, albumIntervalMinutes() * 60 * 1000);
    logWallpaper("info", `图集墙纸开始轮换：${entries.length} 张 / ${albumIntervalMinutes()} 分钟`);
    return true;
}

/**
 * 动态墙纸一步：按时段挑系统壁纸；配置未被托管（用户手选过其它壁纸）时先收编。
 * @returns {Promise<void>}
 */
async function applyDynamicSlot() {
    const slotsRaw = settings.get("wallpaper.dynamicSet");
    const slots = (slotsRaw && Array.isArray(slotsRaw.slots) && slotsRaw.slots.length)
        ? slotsRaw.slots
        : DYNAMIC_FALLBACK_SLOTS;
    const slot = dynamicSlotForHour(slots, new Date().getHours());
    if (!slot) return;
    const config = wallpaper.getWallpaperConfig();
    if (!config || config.type !== "dynamic") {
        const url = systemIdToUrl(slot.systemId);
        persistConfigQuietly({ type: "dynamic", url, systemId: slot.systemId, name: "macOS 动态" });
        wallpaper.setWallpaper(url);
        engine.dynamicCurrent = slot.systemId;
        return;
    }
    if (engine.dynamicCurrent === slot.systemId) return;
    engine.dynamicCurrent = slot.systemId;
    const url = systemIdToUrl(slot.systemId);
    crossFadeTo(url);
    persistConfigQuietly({ type: "dynamic", url, systemId: slot.systemId, name: "macOS 动态" });
}

/**
 * 开关动态墙纸。开启时立即铺当前时段并启动分钟级定时器；
 * 关闭时停表并把配置交还给默认壁纸（用户随后可以再手选）。
 * @param {boolean|string} on 是否开启
 * @returns {boolean} 生效后的开关状态
 */
function setDynamicEnabled(on) {
    const enabled = Boolean(on) && on !== "off" && on !== "false" && on !== "0";
    engine.dynamicOn = enabled;
    if (engine.dynamicTimer) {
        clearInterval(engine.dynamicTimer);
        engine.dynamicTimer = null;
    }
    if (!enabled) {
        engine.dynamicCurrent = "";
        return false;
    }
    applyDynamicSlot();
    engine.dynamicTimer = setInterval(() => { applyDynamicSlot(); }, 60 * 1000);
    return true;
}

/** 当前主题侧（浅色/深色）：<html data-theme> 是 appearance.js 的产出。 */
function currentThemeSide() {
    return (document.documentElement.dataset.theme === "dark") ? "dark" : "light";
}

/**
 * 按当前主题铺 themePair 对应侧的壁纸（配置不是 themePair 时直接返回 false）。
 * @returns {Promise<boolean>} 是否应用了
 */
async function applyThemePair() {
    const config = wallpaper.getWallpaperConfig();
    if (!config || config.type !== "themePair") return false;
    const entry = config[currentThemeSide()];
    if (!entry || !entry.url) return false;
    try {
        const url = await resolveWallpaperEntry(entry.url);
        wallpaper.setWallpaper(url);
        applyTint(entry.url);
        return true;
    } catch (err) {
        warnLog("主题配对壁纸读取失败：", err);
        return false;
    }
}

/**
 * 保存并应用 themePair 配置（墙纸面板「随主题切换」的入口）。
 * @param {string} light 浅色侧条目
 * @param {string} dark 深色侧条目
 * @returns {Promise<boolean>} 是否成功
 */
async function saveThemePair(light, dark) {
    const lightUrl = normalizeWallpaperEntry(light);
    const darkUrl = normalizeWallpaperEntry(dark);
    if (!lightUrl && !darkUrl) return false;
    const resolvedLight = lightUrl || darkUrl;
    const resolvedDark = darkUrl || lightUrl;
    persistConfigQuietly({
        type: "themePair",
        url: currentThemeSide() === "dark" ? resolvedDark : resolvedLight,
        light: { url: resolvedLight, name: "浅色" },
        dark: { url: resolvedDark, name: "深色" },
        name: "随主题切换",
    });
    return applyThemePair();
}

/** 引擎公共样式（交叉淡入图层 / 屏保层），一次注入。 */
function ensureEngineStyle() {
    if (document.getElementById("deskly-wallpaper-engine-style")) return;
    const style = document.createElement("style");
    style.id = "deskly-wallpaper-engine-style";
    style.textContent = `
.wallpaper-fade { position: absolute; inset: 0; background-size: cover; background-position: center; opacity: 0; transition: opacity 1.2s ease; pointer-events: none; }
.wallpaper-screensaver { position: absolute; inset: 0; overflow: hidden; }
.ss-screensaver-overlay { position: fixed; inset: 0; z-index: 2147482000; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.ss-screensaver-inner { position: absolute; inset: -6%; background-size: cover; background-position: center; }
.ss-screensaver-kenburns { animation: ss-kenburns 36s ease-in-out infinite alternate; }
@keyframes ss-kenburns { from { transform: scale(1); } to { transform: scale(1.12) translate(1.5%, -1.5%); } }
.ss-screensaver-gradient { position: absolute; inset: -20%; background: linear-gradient(120deg, #0f2027, #203a43 30%, #2c5364 55%, #1a2980 80%, #26d0ce); background-size: 300% 300%; animation: ss-gradient-pan 26s ease-in-out infinite; }
@keyframes ss-gradient-pan { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
.ss-screensaver-clock { position: relative; color: #fff; text-shadow: 0 2px 24px rgba(0, 0, 0, 0.45); text-align: center; font: 600 96px/1.1 -apple-system, "SF Pro Display", "PingFang SC", sans-serif; letter-spacing: 0.02em; font-variant-numeric: tabular-nums; }
.ss-screensaver-clock small { display: block; margin-top: 10px; font: 400 20px/1.4 -apple-system, "SF Pro Text", "PingFang SC", sans-serif; opacity: 0.85; }
html[data-reduce-motion="on"] .ss-screensaver-kenburns,
html[data-reduce-motion="on"] .ss-screensaver-gradient { animation: none; }
`;
    document.head.appendChild(style);
}

/** 屏保素材：图集优先，其次三张系统壁纸；返回已归一化的条目列表。 */
function screensaverEntries() {
    const album = albumEntries();
    if (album.length) return album;
    return SYSTEM_WALLPAPERS.map((item) => item.url);
}

/** 结束屏保并按当前模式重新排程。 */
function stopScreensaver() {
    if (!engine.screensaverActive) return;
    engine.screensaverActive = false;
    if (engine.screensaverClockTimer) {
        clearInterval(engine.screensaverClockTimer);
        engine.screensaverClockTimer = null;
    }
    if (engine.screensaverNode) {
        engine.screensaverNode.remove();
        engine.screensaverNode = null;
    }
    armScreensaver();
}

/**
 * 启动屏保：按模式构建时钟/渐变/照片内容，铺进全屏层或墙纸层。
 * @returns {boolean} 是否真的启动了
 */
function startScreensaver() {
    const mode = settings.get("screensaver.mode");
    if (!mode || mode === "none" || engine.screensaverActive) return false;
    ensureEngineStyle();
    engine.screensaverActive = true;

    const asWallpaper = Boolean(settings.get("screensaver.asWallpaper"));
    const host = asWallpaper ? wallpaperElement : document.body;
    if (!host) {
        engine.screensaverActive = false;
        return false;
    }
    engine.screensaverSource = asWallpaper ? "wallpaper" : "overlay";

    const node = document.createElement("div");
    node.className = asWallpaper ? "wallpaper-screensaver" : "ss-screensaver-overlay";

    if (mode === "clock") {
        const clock = document.createElement("div");
        clock.className = "ss-screensaver-clock";
        const paint = () => {
            const now = new Date();
            const pad = (n) => String(n).padStart(2, "0");
            clock.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
            const text = `${now.getMonth() + 1} 月 ${now.getDate()} 日 星期${"日一二三四五六"[now.getDay()]}`;
            const dateLine = clock.querySelector("small");
            if (dateLine) dateLine.textContent = text;
            else clock.appendChild(Object.assign(document.createElement("small"), { textContent: text }));
        };
        paint();
        node.appendChild(clock);
        engine.screensaverClockTimer = setInterval(paint, 1000);
    } else if (mode === "gradient") {
        const gradient = document.createElement("div");
        gradient.className = "ss-screensaver-gradient";
        node.appendChild(gradient);
    } else {
        // 照片档：随机挑一张（图集优先，其次系统三张），Ken Burns 缓推
        const entries = screensaverEntries();
        const pick = entries[Math.floor(Math.random() * entries.length)] || DEFAULT_WALLPAPER;
        const inner = document.createElement("div");
        inner.className = "ss-screensaver-inner";
        node.appendChild(inner);
        resolveWallpaperEntry(pick).then((url) => {
            inner.style.backgroundImage = `url("${String(url).replace(/"/g, "%22")}")`;
            const reduceMotion = document.documentElement.dataset.reduceMotion === "on";
            if (!reduceMotion) inner.classList.add("ss-screensaver-kenburns");
        }).catch(() => {
            inner.style.backgroundImage = `url("${DEFAULT_WALLPAPER}")`;
        });
    }

    engine.screensaverNode = node;
    host.appendChild(node);
    return true;
}

/** 重新排程屏保空闲倒计时（模式为 none 或分钟数非法时不排）。 */
function armScreensaver() {
    if (engine.screensaverIdleTimer) {
        clearTimeout(engine.screensaverIdleTimer);
        engine.screensaverIdleTimer = null;
    }
    const mode = settings.get("screensaver.mode");
    if (!mode || mode === "none") return;
    const minutes = Number(settings.get("screensaver.idleMinutes"));
    const delay = (Number.isFinite(minutes) && minutes >= 1 ? Math.min(60, minutes) : 10) * 60 * 1000;
    engine.screensaverIdleTimer = setTimeout(() => {
        engine.screensaverIdleTimer = null;
        startScreensaver();
    }, delay);
}

/** 活动回调：屏保在场就熄掉，无论如何重排倒计时。 */
function handleScreensaverActivity() {
    if (engine.screensaverActive) stopScreensaver();
    else armScreensaver();
}

/** 绑定屏保活动监听与设置跟随（幂等：engine.eventsBound 守卫）。 */
function bindEngineEvents() {
    if (engine.eventsBound) return;
    engine.eventsBound = true;
    SCREENSAVER_IDLE_EVENTS.forEach((type) => {
        window.addEventListener(type, handleScreensaverActivity, { passive: true, capture: true });
    });
    document.addEventListener("settings-changed", (event) => {
        const key = String(event.detail?.key || "");
        if (key === "screensaver.mode" || key === "screensaver.idleMinutes" || key === "screensaver.asWallpaper") {
            if (engine.screensaverActive) stopScreensaver();
            armScreensaver();
        }
        if (key === "wallpaper.albumInterval" && engine.albumTimer) {
            stopAlbumRotation();
            const config = wallpaper.getWallpaperConfig();
            if (config && config.type === "album") {
                engine.albumTimer = setInterval(() => { advanceAlbum(); }, albumIntervalMinutes() * 60 * 1000);
            }
        }
        if (key === "appearance.theme") applyThemePair();
    });
    document.addEventListener("visibilitychange", () => {
        // 转后台时不让屏保空转：停掉并重排（回来后再计一次完整空闲）
        if (document.visibilityState === "hidden" && engine.screensaverActive) stopScreensaver();
    });
}

/**
 * 引擎总开关：init 时调用一次。
 * 动态墙纸按设置点亮；图集模式残留配置续摆；themePair 按当前主题校正；屏保排程。
 * @param {object} [config] init 已解析的当前配置
 * @returns {void}
 */
function startWallpaperEngines(config) {
    if (engine.started) return;
    engine.started = true;
    bindEngineEvents();
    ensureEngineStyle();

    if (settings.get("wallpaper.dynamic")) setDynamicEnabled(true);
    if (config && config.type === "album" && albumEntries().length) {
        engine.albumTimer = setInterval(() => { advanceAlbum(); }, albumIntervalMinutes() * 60 * 1000);
    }
    if (config && config.type === "themePair") applyThemePair();
    armScreensaver();
}

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
    // data URL（上传壁纸可达数 MB 字符串）不做缓存键：Map 只增不减就是会话级内存泄漏（BUG-46b）
    const cacheable = !target.startsWith("data:") && target.length < 2048;
    let job = cacheable ? dominantCache.get(target) : null;
    if (!job) {
        job = sampleAverageColor(target).catch((err) => {
            warnLog(`主色采样失败，回退 ${TINT_FALLBACK}：${target.slice(0, 80)}`, err);
            return [...TINT_FALLBACK_RGB];
        });
        if (cacheable) {
            // 容量上限：超出就淘汰最早一条（Map 迭代序即插入序），缓存只增不减同样是泄漏
            if (dominantCache.size >= 64) dominantCache.delete(dominantCache.keys().next().value);
            dominantCache.set(target, job);
        }
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
    // blob: 一定同源（只能由本页面创建），IndexedDB 取回的壁纸本体因此也可采样 —
    // 网络壁纸落盘缓存后，着色取色不再受跨域画布污染限制。
    if (url.startsWith("blob:")) return true;
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
    const { image, release } = await decodeForSampling(url);
    try {
        const canvas = document.createElement("canvas");
        canvas.width = SAMPLE_EDGE;
        canvas.height = SAMPLE_EDGE;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        // 关掉平滑缩放：这里要的是「16x16 个点的平均」，插值只会把相邻像素糊进采样集
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(image, 0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
        return averageRgb(ctx.getImageData(0, 0, SAMPLE_EDGE, SAMPLE_EDGE).data);
    } finally {
        // 位图占的是解码后的内存，取完平均色就立刻还给浏览器
        release();
    }
}

/**
 * 解码一张用于采样的位图，尽量在缩小阶段就解码。
 *
 * 为什么不用 img 走全程：`new Image()` 会先把整张 4K 壁纸按原尺寸解码进内存，之后
 * drawImage 才缩到 16x16 —— 首屏多出来的几百 MB 与一次全尺寸解码都是白花的。
 * fetch 成 Blob 再 `createImageBitmap(blob, { resizeWidth, resizeHeight })`，浏览器
 * 可以在解码时直接产出 16x16 位图，内存与耗时都只与采样尺寸相关。
 *
 * 兼容性：resize 选项不是所有环境都认（旧版会忽略或直接抛错）。抛错、或拿回来的
 * 位图尺寸没被缩小（说明选项被忽略），都释放位图并回退到原来的 img + drawImage
 * 路径，采样结果与失败回退语义完全不变。
 * @param {string} url 图片地址
 * @returns {Promise<{image: CanvasImageSource, release: Function}>} 采样源与释放函数
 */
async function decodeForSampling(url) {
    if (typeof fetch === "function" && typeof createImageBitmap === "function") {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob, {
                resizeWidth: SAMPLE_EDGE,
                resizeHeight: SAMPLE_EDGE,
            });
            if (bitmap.width === SAMPLE_EDGE && bitmap.height === SAMPLE_EDGE) {
                return { image: bitmap, release: () => bitmap.close() };
            }
            if (typeof bitmap.close === "function") bitmap.close();
        } catch (err) {
            // fetch 被拒 / Blob 解码失败：交给 img 路径复现原来的错误判定与日志
        }
    }
    const img = await loadForSampling(url);
    return { image: img, release: () => {} };
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
/** 着色序号：快速连换壁纸时，慢采样的旧结果不得覆盖新结果（BUG-39）。 */
let tintSeq = 0;

export async function applyTint(url) {
    const target = url || wallpaper.getWallpaperConfig()?.url || "";
    const seq = ++tintSeq;
    const [r, g, b] = await getDominantColor(target);
    if (seq !== tintSeq) return null; // 期间又发起了更新的着色：丢弃这次过期结果
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

/** 测试探针专用：持久化闭环（存 → 重开 → 读回）与动态/图集引擎纯函数的最小面。生产代码不应引用。 */
export const __wallpaperInternals = {
    idbPutImage, idbGetImage, resolveConfigUrl, restoreConfig,
    IDB_PREFIX, IDB_NAME, IDB_STORE,
    DYNAMIC_FALLBACK_SLOTS, systemIdToUrl, normalizeWallpaperEntry,
    dynamicSlotForHour, albumEntries, albumIntervalMinutes, screensaverEntries,
};