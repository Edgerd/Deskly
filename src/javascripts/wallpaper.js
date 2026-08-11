/**
 * wallpaper.js — 桌面背景系统模块
 *
 * 功能：
 *   1. 默认使用项目内置的 macOS Sequoia 壁纸（assets/images/Wallpaper.png）。
 *   2. 支持自定义网络壁纸源：输入任意图片 URL 应用并持久化，可随时恢复默认。
 *   3. 支持本地上传图片：读取本地图片，压缩后转为 base64 持久化，刷新后仍生效。
 *   4. 支持 Bing 每日壁纸：官方 JSON 接口 + 备选第三方接口，失败自动回退。
 *   5. 支持系统默认壁纸切换：提供多套内置 macOS 风格壁纸供用户选择。
 *
 * 持久化：
 *   使用 localStorage 存储当前壁纸配置 { type, url, name? }，type 取值：
 *     "default"    项目内置默认壁纸（第1套系统壁纸）
 *     "system"     系统内置壁纸（通过 getSystemWallpapers() 选择）
 *     "network"    网络壁纸源
 *     "upload"     本地上传
 *     "bing"       Bing 每日壁纸
 *
 * 对外 API：
 *   wallpaper.init()                        初始化并恢复上次壁纸
 *   wallpaper.getWallpaperConfig()          读取当前壁纸配置
 *   wallpaper.setWallpaper(url)             直接应用壁纸（不持久化）
 *   wallpaper.setNetworkWallpaper(url)      设置网络壁纸源并持久化（含图片预加载校验）
 *   wallpaper.uploadLocal(file)             上传本地图片并持久化
 *   wallpaper.resetWallpaper()              恢复项目默认壁纸
 *   wallpaper.fetchBingWallpaper()          获取 Bing 每日壁纸并设为壁纸（持久化）
 *   wallpaper.getSystemWallpapers()         获取系统内置壁纸列表
 *   wallpaper.setSystemWallpaper(id)        按 ID 切换系统内置壁纸并持久化
 */

// 默认壁纸（项目内置 macOS Sequoia 壁纸，也是系统壁纸列表的第一项）
const DEFAULT_WALLPAPER = "./assets/images/Wallpaper.png";

// 壁纸配置存储键名
const WALLPAPER_CONFIG_KEY = "wallpaper-config";

// 上传压缩参数：最大边长与 JPEG 质量
const UPLOAD_MAX_EDGE = 2560;
const UPLOAD_JPEG_QUALITY = 0.85;

// Bing 壁纸接口
const BING_API_URL = "https://cn.bing.com/hpimagearchive.aspx?format=js&idx=0&n=1&mkt=zh-CN";
// 备选第三方接口（注意请求频率限制）
const BING_API_ALT_URL = "https://api.kobin.cn/bing/";

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
        url: "./assets/images/Wallpaper.png",
        thumb: "./assets/images/Wallpaper.png",
    },
    {
        id: "sequoia-day",
        name: "Sequoia 白昼",
        url: "./assets/images/sequoia.shape.day.jpg",
        thumb: "./assets/images/sequoia.shape.day.jpg",
    },
    {
        id: "sequoia-night",
        name: "Sequoia 夜色",
        url: "./assets/images/sequoia.shape.night.jpg",
        thumb: "./assets/images/sequoia.shape.night.jpg",
    },
];

/** 壁纸模块对象 */
const wallpaper = {
    /**
     * 初始化桌面背景系统。
     * 定位壁纸元素，并恢复上次保存的壁纸配置（无则应用默认壁纸）。
     */
    init() {
        wallpaperElement = document.querySelector("body > div.wallpaper") || Object.assign(document.createElement("div"), { className: "wallpaper" });
        if (!wallpaperElement.parentNode) document.body.appendChild(wallpaperElement);
        const config = wallpaper.getWallpaperConfig();
        wallpaper.setWallpaper(config?.url || DEFAULT_WALLPAPER);
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
     * @param {{type: string, url: string, name?: string}} config 壁纸配置对象
     */
    saveWallpaperConfig(config) {
        localStorage.setItem(WALLPAPER_CONFIG_KEY, JSON.stringify(config));
        window.dispatchEvent(new CustomEvent("wallpaper-change", { detail: config }));
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