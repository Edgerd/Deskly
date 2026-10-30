/** 数据层：书签 / 历史 / 阅读列表 / 设置 / 缩放的持久化与纯数据查询。 */

import {
    BOOKMARKS_KEY,
    DEFAULT_BOOKMARKS,
    DEFAULT_SETTINGS,
    HISTORY_KEY,
    HISTORY_LIMIT,
    READING_KEY,
    SETTINGS_KEY,
    ZOOM_KEY,
    ZOOM_LEVELS,
    BACKGROUNDS,
    HOME,
} from "./constants.js";
import { hostOf, isHttpUrl, searchQueryOfUrl } from "./utils.js";

function readJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) return fallback;
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function writeJSON(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}

function sanitizeEntries(list, extra) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
        if (!item || !isHttpUrl(item.url)) continue;
        const entry = {
            url: String(item.url),
            title: String(item.title || hostOf(item.url)),
            addedAt: Number.isFinite(Number(item.addedAt)) ? Number(item.addedAt) : 0,
        };
        if (extra) Object.assign(entry, extra(item));
        out.push(entry);
    }
    return out;
}

/* ── 书签 ── */

export function loadBookmarks() {
    if (localStorage.getItem(BOOKMARKS_KEY) === null) {
        const seeded = DEFAULT_BOOKMARKS.map((item) => ({ ...item }));
        writeJSON(BOOKMARKS_KEY, seeded);
        return seeded;
    }
    return sanitizeEntries(readJSON(BOOKMARKS_KEY, []), () => ({}));
}

export function saveBookmarks(list) {
    writeJSON(BOOKMARKS_KEY, sanitizeEntries(list, () => ({})));
}

export function bookmarkFor(url) {
    return loadBookmarks().find((item) => item.url === url) || null;
}

/* ── 历史 ── */

export function loadHistory() {
    const raw = readJSON(HISTORY_KEY, []);
    if (!Array.isArray(raw)) return [];
    return sanitizeEntries(raw, (item) => ({
        visitedAt: Number.isFinite(Number(item.visitedAt)) ? Number(item.visitedAt) : 0,
        visits: Math.min(Math.max(Math.round(Number(item.visits) || 1), 1), 99999),
    }));
}

export function saveHistory(list) {
    writeJSON(HISTORY_KEY, list.slice(0, HISTORY_LIMIT));
}

export function recordVisit(url, title) {
    if (!isHttpUrl(url)) return;
    const history = loadHistory();
    const existing = history.find((item) => item.url === url);
    if (existing) {
        existing.visits = (existing.visits || 1) + 1;
        existing.visitedAt = Date.now();
        if (title) existing.title = title;
    } else {
        history.unshift({
            url,
            title: title || titleOfUrl(url),
            visitedAt: Date.now(),
            visits: 1,
        });
    }
    history.sort((a, b) => b.visitedAt - a.visitedAt);
    saveHistory(history);
}

export function frequentItems(limit = 8) {
    return loadHistory()
        .filter((item) => isHttpUrl(item.url))
        .sort((a, b) => (b.visits || 1) - (a.visits || 1) || b.visitedAt - a.visitedAt)
        .slice(0, limit)
        .map((item) => ({
            url: item.url,
            title: item.title || titleOfUrl(item.url),
            host: hostOf(item.url),
            visits: item.visits || 1,
        }));
}

/* ── 阅读列表 ── */

export function loadReading() {
    const raw = readJSON(READING_KEY, []);
    if (!Array.isArray(raw)) return [];
    return sanitizeEntries(raw, (item) => ({ read: item.read === true }))
        .sort((a, b) => b.addedAt - a.addedAt);
}

export function saveReading(list) {
    writeJSON(READING_KEY, list);
}

export function readingFor(url) {
    return loadReading().find((item) => item.url === url) || null;
}

/* ── 起始页设置 ── */

export function loadSettings() {
    const raw = readJSON(SETTINGS_KEY, {});
    const value = raw && typeof raw === "object" ? raw : {};
    return {
        background: BACKGROUNDS.includes(value.background) ? value.background : DEFAULT_SETTINGS.background,
        showFavorites: value.showFavorites !== false,
        showFrequent: value.showFrequent !== false,
        showReading: value.showReading !== false,
    };
}

export function saveSettings(settings) {
    writeJSON(SETTINGS_KEY, settings);
}

/* ── 缩放 ── */

export function loadZoomMap() {
    const raw = readJSON(ZOOM_KEY, {});
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [origin, value] of Object.entries(raw)) {
        const number = Number(value);
        if (ZOOM_LEVELS.includes(number)) out[origin] = number;
    }
    return out;
}

export function zoomFor(zoomMap, url) {
    try {
        const origin = new URL(url).origin;
        return zoomMap[origin] || 100;
    } catch {
        return 100;
    }
}

export function setZoomFor(zoomMap, url, value) {
    try {
        const origin = new URL(url).origin;
        zoomMap[origin] = value;
        writeJSON(ZOOM_KEY, zoomMap);
    } catch { /* 非 http(s) 地址不记缩放 */ }
}

/* ── 标题 ── */

export function titleOfUrl(url) {
    if (url === HOME) return "起始页";
    const bookmark = bookmarkFor(url);
    if (bookmark && bookmark.title) return bookmark.title;
    const reading = readingFor(url);
    if (reading && reading.title) return reading.title;
    const query = searchQueryOfUrl(url);
    if (query) return `搜索：${query}`;
    return hostOf(url);
}

export function titleOfTab(tab) {
    if (!tab) return "";
    if (tab.url === HOME) return "起始页";
    return tab.title || titleOfUrl(tab.url);
}
