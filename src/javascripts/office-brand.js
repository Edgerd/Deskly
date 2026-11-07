/**
 * office-brand.js — 办公套件的「名称 + 图标」品牌包（iWork / Microsoft Office）
 *
 * 背景：办公套件读写的是 .docx/.xlsx/.pptx，却沿用了 Pages/Numbers/Keynote 的图标，
 * 用户会以为能打开 .pages（保真清单 F-49）。这里提供两套品牌包：
 *   - iwork（默认）：维持现有 i18n 名称与 Pages/Numbers/Keynote 图标；
 *   - ms：Word / Excel / PowerPoint 名称与对应图标。
 *
 * 图标由用户后续补齐（遵循项目规则：图标只用 PNG、不自绘）：
 *   assets/icons/Microsoft Word.png
 *   assets/icons/Microsoft Excel.png
 *   assets/icons/Microsoft PowerPoint.png
 * 缺任何一张时该项自动回退到 iWork 同名图标，不会出现裂图；补齐后刷新即生效。
 *
 * 切换入口：系统设置 › App ›「办公套件名称与图标」。
 */

import { settings } from "./settings.js";
import { assetPath } from "./paths.js";

/** 设置键：品牌包。 */
export const BRAND_SETTING = "office.brandPack";

/**
 * 两套品牌包。label 为 null 表示沿用 i18n 里的 `apps.office.<key>.name`
 * （iWork 包不覆盖译文，保持四语一致）。
 */
const PACKS = {
    iwork: {
        word: { label: null, icon: "Pages.png" },
        excel: { label: null, icon: "Numbers.png" },
        ppt: { label: null, icon: "Keynote.png" },
    },
    ms: {
        word: { label: "Word", icon: "Microsoft Word.png" },
        excel: { label: "Excel", icon: "Microsoft Excel.png" },
        ppt: { label: "PowerPoint", icon: "Microsoft PowerPoint.png" },
    },
};

/** 已确认存在的 MS 图标：缺省视为不存在，探测成功后才放行（避免 404 裂图）。 */
const msIconAvailable = new Map();
/** 探测结果缓存键：只在用户选过 MS 包后才探测，且每个标签页只探一次。 */
const PROBE_CACHE = "office-brand-ms-probe";

/** 当前品牌包 id；非法值回退 iwork。 */
export function getBrandPack() {
    const value = settings.get(BRAND_SETTING, "iwork");
    return PACKS[value] ? value : "iwork";
}

/**
 * 办公子应用在当前品牌包下的名称。
 * @param {string} appId 形如 office.word
 * @returns {string|null} null 表示不覆盖（交给 i18n）
 */
export function brandLabel(appId) {
    const key = String(appId || "").split(".").pop();
    const entry = PACKS[getBrandPack()]?.[key];
    return entry?.label || null;
}

/**
 * 办公子应用在当前品牌包下的图标路径。
 * MS 图标尚未补齐时回退到 iWork 图标，保证任何时刻都不裂图。
 * @param {string} appId 形如 office.excel
 * @returns {string|null} 图标资源路径
 */
export function brandIcon(appId) {
    const key = String(appId || "").split(".").pop();
    const packId = getBrandPack();
    const entry = PACKS[packId]?.[key];
    if (!entry) return null;
    if (packId === "iwork" || msIconAvailable.get(entry.icon) === true) {
        return assetPath(`icons/${entry.icon}`);
    }
    return assetPath(`icons/${PACKS.iwork[key].icon}`);
}

/** 广播一次刷新：Dock / 启动台 / 菜单据此重取名称与图标。 */
function announce() {
    window.dispatchEvent(new CustomEvent("deskly-brand-pack-changed", { detail: { pack: getBrandPack() } }));
}

/**
 * 探测 MS 图标是否已由用户补齐；探测完成后广播一次，让已渲染的界面换成新图标。
 * @returns {Promise<void>}
 */
export function probeBrandIcons() {
    const cached = readProbeCache();
    if (cached) {
        Object.entries(cached).forEach(([file, ok]) => msIconAvailable.set(file, ok === true));
        announce();
        return Promise.resolve();
    }
    const files = [...new Set(Object.values(PACKS.ms).map((entry) => entry.icon))];
    return Promise.all(files.map(async (file) => {
        try {
            const res = await fetch(assetPath(`icons/${file}`), { method: "HEAD", cache: "no-store" });
            msIconAvailable.set(file, res.ok);
            if (!res.ok) {
                console.info(`[office-brand] 未找到 assets/icons/${file}，暂时使用 iWork 图标`);
            }
        } catch {
            msIconAvailable.set(file, false);
        }
    })).then(() => {
        // 只有「全部命中」才写缓存：缓存 false 会让「补齐图标后刷新即生效」落空 ——
        // 同标签页刷新仍读旧缓存继续用 iWork 图标（BUG-45）。探测失败下次重探，
        // 代价只是每次新标签页几个 404（HEAD），比永远看不到新图标便宜。
        const allOk = [...msIconAvailable.values()].every((ok) => ok === true);
        if (allOk) {
            try {
                sessionStorage.setItem(PROBE_CACHE, JSON.stringify(Object.fromEntries(msIconAvailable)));
            } catch { /* 隐私模式：下次再探，不影响功能 */ }
        }
        announce();
    });
}

/** 读取本次会话的探测缓存。 */
function readProbeCache() {
    try {
        const raw = sessionStorage.getItem(PROBE_CACHE);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

/**
 * 启动模块：探测图标 + 订阅品牌切换。
 * @returns {void}
 */
export function initOfficeBrand() {
    // 默认是 iWork：不探测，避免每次开新标签页都产生 3 个 404（MS 图标未补齐时）。
    if (getBrandPack() === "ms") probeBrandIcons();
    settings.subscribe((detail) => {
        if (!detail || detail.key !== BRAND_SETTING) return;
        if (getBrandPack() === "ms") probeBrandIcons();
        else announce();
    });
}
