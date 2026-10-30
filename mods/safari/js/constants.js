/** 常量：插件身份、存储键、引擎与各类上限。 */

export const PLUGIN_ID = "safari";
export const HOME = "safari:start";

export const BOOKMARKS_KEY = "webstartos_safari_bookmarks";
export const HISTORY_KEY = "webstartos_safari_history";
export const READING_KEY = "webstartos_safari_reading";
export const SETTINGS_KEY = "webstartos_safari_settings";
export const ZOOM_KEY = "webstartos_safari_zoom";

export const SEARCH_NAME = "Bing";
export const SEARCH_URL = "https://www.bing.com/search?q=";
export const BACKGROUNDS = ["sequoia", "aurora", "sunset", "none"];
export const ZOOM_LEVELS = [50, 75, 100, 125, 150, 200];

export const HISTORY_LIMIT = 500;
export const CLOSED_LIMIT = 12;
export const TAB_HISTORY_LIMIT = 60;
export const LOAD_TIMEOUT = 15000;

export const SANDBOX = "allow-same-origin allow-scripts allow-popups allow-forms allow-modals allow-popups-to-escape-sandbox allow-downloads";

export const DEFAULT_BOOKMARKS = Object.freeze([
    { url: "https://www.bing.com", title: "Bing", addedAt: 0 },
    { url: "https://www.bilibili.com", title: "哔哩哔哩", addedAt: 0 },
    { url: "https://www.sogou.com", title: "搜狗搜索", addedAt: 0 },
    { url: "https://www.so.com", title: "360 搜索", addedAt: 0 },
    { url: "https://example.com", title: "Example", addedAt: 0 },
]);

export const DEFAULT_SETTINGS = Object.freeze({
    background: "sequoia",
    showFavorites: true,
    showFrequent: true,
    showReading: true,
});
