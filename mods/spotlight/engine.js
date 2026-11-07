/**
 * engine.js — 聚焦结果提供者（Spotlight Provider）注册表与查询引擎
 *
 * 这是聚焦对插件开放的核心接口（第一个实验对象：计算器，见
 * mods/calculator/spotlight-provider.js）。设计约束：
 *
 * - **异步**：provider 的 search 可返回数组或 Promise；用 ctx.emit 还能流式回传。
 * - **可取消**：每次查询发一枚 AbortSignal（ctx.signal），输入一变旧查询即 abort；
 *   引擎自身也用代数令牌兜底，异步迟到结果绝不渲染。
 * - **错误隔离**：单个 provider 抛错/超时只记进 failures，绝不让整次搜索空白。
 * - **可失效**：provider 可带 invalidate()，外部事件（插件装卸、设置变更、语言切换）
 *   由 shell 统一广播进来。
 *
 * 排序（macOS 手感）：分组保持连续（组次序见 GROUPS，计算/换算天然在最前），
 * 组内按命中程度（精确 > 前缀 > 包含）→ 条内权重（最近使用提升）→ 本地化字典序。
 *
 * @typedef {Object} SpotlightResult
 * @property {string} type            结果类型（状态表与分组用，如 "app" / "calculation"）
 * @property {string} label           标题（渲染一律走 textContent）
 * @property {string} [sub]           副标题
 * @property {string} [hint]          右侧操作提示
 * @property {string} [icon]          图标 URL
 * @property {0|1|2} [score]          命中程度：0 精确 / 1 前缀 / 2 包含（缺省 2）
 * @property {number} [weight]        条内排序权重（缺省继承 provider.weight，小者靠前）
 * @property {string} [copyText]      回车优先复制它（计算/换算结果）
 * @property {Function} [action]      回车执行动作（可无：纯展示 + 复制）
 *
 * @typedef {Object} SpotlightQueryContext
 * @property {string} query           原始查询（已 trim）
 * @property {string} lower           小写查询
 * @property {AbortSignal} signal     作废信号：输入变化/面板关闭时触发
 * @property {number} limit           建议单 provider 返回上限
 * @property {(items: SpotlightResult[]) => void} emit 流式回传部分结果（可选）
 *
 * @typedef {Object} SpotlightProvider
 * @property {string} id              唯一 id（插件 provider 约定 "<插件id>" 或 "<插件id>/<名>"）
 * @property {string} group           分组 id（须在 GROUPS 中；未知分组按 "other" 处理）
 * @property {number} [weight=50]     组内排序权重（小者靠前）
 * @property {boolean} [async]        声明会产生异步结果（状态表用；实现上返回 Promise 即可）
 * @property {string[]} types         声明的结果类型（设置开关与状态表对齐用）
 * @property {(ctx: SpotlightQueryContext) => (SpotlightResult[]|Promise<SpotlightResult[]>|void)} search
 * @property {() => void} [invalidate] 索引失效钩子（可选）
 */

/** 分组次序：计算类结果是 macOS 的 top hit，天然压过应用；网页回退永远垫底。 */
export const GROUPS = Object.freeze({
    calculation: { order: 0, labelKey: "spotlight.group.calculation", label: "计算" },
    app: { order: 1, labelKey: "spotlight.group.app", label: "应用程序" },
    command: { order: 2, labelKey: "spotlight.group.command", label: "系统命令" },
    setting: { order: 3, labelKey: "spotlight.group.setting", label: "系统设置" },
    file: { order: 4, labelKey: "spotlight.group.file", label: "文件" },
    bookmark: { order: 5, labelKey: "spotlight.group.bookmark", label: "书签" },
    manual: { order: 6, labelKey: "spotlight.group.manual", label: "使用手册" },
    websearch: { order: 9, labelKey: "spotlight.group.websearch", label: "网页" },
    other: { order: 8, labelKey: "spotlight.group.other", label: "其他" },
});

/** provider 注册表：id -> { provider, source }（source 用于状态表标注内置/插件）。 */
const providers = new Map();

/** 订阅注册表变化的监听（注册/注销时 shell 刷新状态行）。 */
const watchers = new Set();

function notify() {
    watchers.forEach((fn) => {
        try { fn(); } catch { /* 单个监听抛错不影响注册本身 */ }
    });
}

/**
 * 注册一个结果提供者。同 id 重复注册视为替换（插件热重载场景），
 * 返回注销函数；注册失败（缺 id/search）抛 TypeError，宁早不晚。
 * @param {SpotlightProvider} provider 提供者
 * @param {{source?: string}} [meta] 来源标注（"builtin" / 插件 id）
 * @returns {() => boolean} 注销函数（幂等）
 */
export function registerSpotlightProvider(provider, meta = {}) {
    if (!provider || typeof provider !== "object" || typeof provider.search !== "function" || !provider.id) {
        throw new TypeError("SpotlightProvider 需要 id 与 search(ctx)");
    }
    const id = String(provider.id);
    providers.set(id, { provider, source: meta.source || "builtin" });
    notify();
    let gone = false;
    return () => {
        if (gone) return false;
        gone = true;
        return unregisterSpotlightProvider(id);
    };
}

/**
 * 注销一个提供者。
 * @param {string} id 提供者 id
 * @returns {boolean} 是否确实注销了
 */
export function unregisterSpotlightProvider(id) {
    const existed = providers.delete(String(id));
    if (existed) notify();
    return existed;
}

/**
 * 当前注册表快照（状态表 / 设置开关数据源）。
 * @returns {Array<{id:string, group:string, weight:number, async:boolean, types:string[], source:string}>}
 */
export function listSpotlightProviders() {
    return [...providers.entries()].map(([id, { provider, source }]) => ({
        id,
        group: provider.group || "other",
        weight: Number.isFinite(provider.weight) ? provider.weight : 50,
        async: Boolean(provider.async),
        types: Array.isArray(provider.types) ? provider.types.slice() : [],
        source,
    }));
}

/**
 * 订阅注册表变化。
 * @param {() => void} fn 回调
 * @returns {() => void} 退订函数
 */
export function onProvidersChanged(fn) {
    watchers.add(fn);
    return () => watchers.delete(fn);
}

/**
 * 广播索引失效：逐 provider 调 invalidate()，单个抛错不影响其它。
 * @param {string} [reason] 失效原因（日志用）
 * @returns {void}
 */
export function invalidateProviders(reason) {
    providers.forEach(({ provider }) => {
        if (typeof provider.invalidate !== "function") return;
        try { provider.invalidate(); } catch (err) {
            console.warn(`[spotlight] provider ${provider.id} 索引失效处理失败（${reason}）：`, err);
        }
    });
}

/**
 * 单条字段命中程度：0 精确、1 前缀、2 包含、3 未命中。
 * @param {string} lower 小写查询
 * @param {...*} fields 候选字段
 * @returns {0|1|2|3}
 */
export function rankOf(lower, ...fields) {
    let best = 3;
    for (const field of fields) {
        const text = String(field || "").toLowerCase();
        if (!text) continue;
        let rank = 3;
        if (text === lower) rank = 0;
        else if (text.startsWith(lower)) rank = 1;
        else if (text.includes(lower)) rank = 2;
        if (rank < best) best = rank;
    }
    return best;
}

/** 统一排序：分组次序（组连续，macOS 分区手感）→ 命中程度 → 条内权重 → 字典序。 */
function sortResults(items) {
    return items.sort((a, b) =>
        ((GROUPS[a.group]?.order ?? GROUPS.other.order) - (GROUPS[b.group]?.order ?? GROUPS.other.order))
        || ((a.score ?? 2) - (b.score ?? 2))
        || ((a.weight ?? 50) - (b.weight ?? 50))
        || String(a.label).localeCompare(String(b.label), "zh-CN"));
}

/**
 * 执行一次查询：并发问全部 provider，逐家隔离错误，支持流式部分结果。
 * @param {string} query 查询文本
 * @param {{signal?: AbortSignal, onPartial?: (items: SpotlightResult[]) => void, limit?: number, only?: Set<string>}} [opts]
 * @returns {Promise<{results: SpotlightResult[], failures: Array<{id:string, error:string}>}>}
 */
export async function runSpotlightQuery(query, opts = {}) {
    const text = String(query || "").trim();
    const ctx = {
        query: text,
        lower: text.toLowerCase(),
        signal: opts.signal || new AbortController().signal,
        limit: opts.limit || 6,
        emit: () => {},
    };
    const collected = [];
    const failures = [];
    const push = (provider, items) => {
        if (!Array.isArray(items)) return;
        for (const item of items) {
            if (!item || typeof item.label !== "string") continue;
            collected.push({
                score: 2,
                ...item,
                group: provider.group || "other",
                weight: item.weight ?? (Number.isFinite(provider.weight) ? provider.weight : 50),
                providerId: provider.id,
            });
        }
    };
    const emitAll = () => {
        if (typeof opts.onPartial === "function" && !ctx.signal.aborted) {
            opts.onPartial(sortResults(collected.slice()));
        }
    };
    ctx.emit = (items) => { push({ group: "other", id: "stream" }, items); emitAll(); };

    const jobs = [];
    for (const { provider } of providers.values()) {
        if (opts.only && !opts.only.has(provider.id)) continue;
        const job = (async () => {
            try {
                const out = await provider.search({
                    ...ctx,
                    emit: (items) => { push(provider, items); emitAll(); },
                });
                push(provider, out);
            } catch (err) {
                // 错误隔离：一家挂了这个搜索只是少一类结果，绝不空白
                failures.push({ id: provider.id, error: String((err && err.message) || err) });
            }
        })();
        jobs.push(job);
    }
    await Promise.all(jobs);
    if (ctx.signal.aborted) return { results: [], failures, aborted: true };
    return { results: sortResults(collected), failures };
}
