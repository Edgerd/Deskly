/**
 * system-actions.js — 系统动作注册表（可执行命令的单一来源）
 *
 * 定位与 app-registry 同款：纯数据层、无加载副作用。内核模块与其它应用（mods）
 * 都可以注册一条「系统动作」，聚焦搜索只负责检索与调用，不再硬编码清单、也不再
 * 反向依赖 controlcenter 之类的具体 owner 模块 —— 拥有某项能力的模块自己把动作
 * 注册进来，检索方零改动即可搜到（台前调度即走这条路径）。
 *
 * 一条动作：
 * @typedef {Object} SystemAction
 * @property {string} id              唯一 id（重复注册视为替换，热重载友好）
 * @property {string} label           标题（检索主字段）
 * @property {string} [sub]           副标题（缺省显示 group）
 * @property {string} [icon]          图标 URL
 * @property {string} [group]         分组名（如 "session"/"window"/"appearance"，展示与归类用）
 * @property {string[]} [aliases]     关键字别名（英文/俗称，参与匹配）
 * @property {() => boolean} [available] 可用性判定：返回 false 时不出现在检索结果（缺省恒可用）
 * @property {() => any} run          执行函数（抛错由调用方隔离记录，不得拖垮检索）
 *
 * 变更事件：注册/注销时在 document 派发 `system-actions-changed`（内核保留主题，
 * 插件无法经 Deskly.bus 伪造）。
 */

/** 动作表：id -> SystemAction。 */
const actions = new Map();

/** 广播注册表变更（与 app-registry.broadcast 同一形状：document + 冒泡）。 */
function broadcastChange(detail) {
    if (typeof document === "undefined" || typeof document.dispatchEvent !== "function") return;
    document.dispatchEvent(new CustomEvent("system-actions-changed", { detail, bubbles: true }));
}

/**
 * 注册一条系统动作。
 * @param {SystemAction} action 动作定义
 * @returns {() => boolean} 注销函数（幂等）
 */
export function registerSystemAction(action) {
    if (!action || typeof action !== "object"
        || typeof action.id !== "string" || !action.id
        || typeof action.label !== "string" || !action.label
        || typeof action.run !== "function") {
        throw new TypeError("SystemAction 需要 id / label / run");
    }
    const normalized = {
        id: action.id,
        label: action.label,
        sub: typeof action.sub === "string" ? action.sub : "",
        icon: typeof action.icon === "string" ? action.icon : "",
        group: typeof action.group === "string" && action.group ? action.group : "session",
        aliases: Array.isArray(action.aliases) ? action.aliases.filter((a) => typeof a === "string") : [],
        available: typeof action.available === "function" ? action.available : null,
        run: action.run,
    };
    actions.set(normalized.id, normalized);
    broadcastChange({ type: "registered", id: normalized.id });
    let gone = false;
    return () => {
        if (gone) return false;
        gone = true;
        return unregisterSystemAction(normalized.id);
    };
}

/**
 * 注销一条系统动作。
 * @param {string} id 动作 id
 * @returns {boolean} 是否确实注销了
 */
export function unregisterSystemAction(id) {
    const existed = actions.delete(String(id));
    if (existed) broadcastChange({ type: "unregistered", id: String(id) });
    return existed;
}

/**
 * 当前动作表快照。默认只输出当前可用（available 缺省或返回 true）的动作；
 * 可用性判定本身抛错按不可用处理（判定向来不许拖垮检索）。
 * 传 includeUnavailable 可拿全量（设置/调试界面列出所有动作与可用态时用）。
 * @param {{includeUnavailable?: boolean}} [opts]
 * @returns {Array<SystemAction>} 动作数组（共享对象，调用方只读）
 */
export function listSystemActions(opts = {}) {
    const out = [];
    for (const action of actions.values()) {
        if (opts.includeUnavailable || !action.available) { out.push(action); continue; }
        let ok = false;
        try { ok = Boolean(action.available()); } catch { ok = false; }
        if (ok) out.push(action);
    }
    return out;
}

/**
 * 按 id 执行一条动作。执行抛错在这里隔离并返回 false，绝不抛给调用方
 * （聚焦回车、快捷键分发、菜单点击共用这条通道）。
 * @param {string} id 动作 id
 * @returns {Promise<boolean>} 是否成功发起（异步动作的后续成败由动作自己负责）
 */
export async function runSystemAction(id) {
    const action = actions.get(String(id));
    if (!action) return false;
    try {
        const result = action.run();
        if (result && typeof result.catch === "function") {
            result.catch((err) => console.warn(`[system-actions] 动作 ${id} 执行失败：`, err));
        }
        return true;
    } catch (err) {
        console.warn(`[system-actions] 动作 ${id} 执行失败：`, err);
        return false;
    }
}
