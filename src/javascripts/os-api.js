/**
 * os-api.js — window.Deskly：插件侧统一能力入口
 *
 * 定位：一层**薄壳**。每个方法都委托给仓库里已经存在的 owner，不重新实现任何能力：
 *   fs      -> osfs.js 的按插件沙箱句柄 OSFS.scope(id)
 *   apps    -> plugin-manager.js openApp() + app-registry.js listApps()/getApp()
 *   apps.default / fs.type -> default-apps.js（用户绑定 + 内置默认 + 清单声明三级回退）
 *   bus     -> document 上的具名 CustomEvent（与 app-registry.js broadcast() 同一形状）
 * 所以这里看不到第二个文件系统、第二条事件总线、第二份应用清单。
 *
 * 权限：每个受管方法用 guard(permission, fn) 显式包住，权限名写在定义处，
 * dev/static-check.mjs 能直接 lint 到。（计划原文想用 Proxy 统一拦截，但 Proxy 的
 * get 每次返回新对象、既冻不住也不好静态核对，显式包装更实在。）
 *
 * 返回形态：受管方法统一返回信封 `{ok, value?, reason?, permission?}`，**永不抛错**；
 * 免权限的查询方法（apps.list / bus.on / meta.*）直接返回原生值。
 * 信封与 window.__settings.set() 的约定一致（settings.js:348），插件写
 * `const r = await Deskly.fs.read("data/x.md"); if (!r.ok) return;` 即可 ——
 * 被拒绝时是 ok:false 带中文原因，不是崩、也不是静默拿到 undefined 继续往下跑。
 *
 * 它不是什么：插件和内核跑在同一个 document 里（devdoc/architecture.md「运行模型」），
 * 插件可以 `import { OSFS } from "../../src/javascripts/osfs.js"` 直接用，
 * 也能碰 localStorage / indexedDB / document。冻结 Deskly 只防住「重新赋值这个全局」，
 * 防不住绕行。**这是同意与记账机制，不是安全沙箱。**
 *
 * 命名：底层API改造分段提示词.md 里写的 `window.StartOS` 是品牌改名前的旧称呼，
 * 同一个东西，本仓库按现品牌实现为 `window.Deskly`。
 */

import { openApp } from "./plugin-manager.js";
import { listApps, resolveAppId, resolveAppRecord, getApp, displayNameFor } from "./app-registry.js";
import { i18n } from "./i18n.js";
import { OSFS } from "./osfs.js";
import {
    resolve as resolveDefaultApp, get as getDefaultApp, set as setDefaultApp,
    getAll as getAllBindings, listTypes, reset as resetDefaultApp, resetAll as resetAllDefaultApps,
} from "./default-apps.js";
import {
    ensurePermission, resolveCaller, describe, isActivated,
    listGrants, PERMISSION_NAMES, SENSITIVE,
} from "./api-grants.js";
import { withCaller } from "./caller-context.js";
import { VERSION } from "./version.js";

/** 调用者识别不出来时用的存储作用域名，不会写进任何插件的 AppData。 */
const KERNEL_SCOPE = "kernel";

/**
 * 权限包装：先认调用者，再要权限，最后才碰真实能力。
 *
 * 认不出调用者时**拒绝**，不再当作内核放行。上一版 `if (caller && !(await ...))`
 * 的语义是「认不出 = 内核自己调 = 全放行」，而认不出的来源是调用栈解析失败 ——
 * 内核派发的回调（设置订阅、事件总线）正好踩这条路径，等于给插件留了一道无检查的门。
 * 内核模块本身不经过 window.Deskly（直接 import OSFS / 各 owner），所以不受影响。
 * @param {string} permission 需要的权限名
 * @param {(ctx:{caller:string,permission:string}, ...args:any[])=>any} handler 真实实现
 * @returns {(...args:any[])=>Promise<object>} 返回信封的异步方法
 */
function guard(permission, handler) {
    return async (...args) => {
        const caller = resolveCaller();
        if (!caller) {
            window.__log?.warn("kernel/os-api", `拒绝 ${permission}：无法确认调用者`);
            return { ok: false, denied: true, permission, reason: "无法确认调用者（插件脚本必须位于 ./mods/<id>/ 下）" };
        }
        if (!(await ensurePermission(caller, permission))) {
            return { ok: false, denied: true, permission, reason: `未授权：${describe(permission).label}` };
        }
        try {
            const value = await handler({ caller, permission }, ...args);
            return { ok: true, value };
        } catch (err) {
            const message = err && err.message ? err.message : String(err);
            window.__log?.error(`plugin/${caller}`, `Deskly 调用失败（${permission}）：`, { message });
            return { ok: false, permission, reason: message };
        }
    };
}

/** 未落地分段的占位方法：返回信封而不是抛错，插件提前接入也不会崩。 */
function pending(segment) {
    return async () => ({ ok: false, reason: `未实现（改造提示词 ${segment}）` });
}

/**
 * 取调用者的文件句柄。OSFS.scope() 把相对路径一律锁在 /AppData/<id>/ 之下，
 * 越出时它自己抛错（osfs.js:587），这层不必再写一遍边界检查。
 */
const scopeOf = (caller) => OSFS.scope(caller || KERNEL_SCOPE);

/** 拒绝跨插件读别人的 AppData —— 这一条不给弹窗机会，权限也不给。 */
function assertNotOtherScope(caller, absPath) {
    const m = /^\/AppData\/([^/]+)/.exec(absPath);
    if (m && m[1] !== (caller || KERNEL_SCOPE)) {
        throw new Error(`不允许访问其它插件的 AppData：${absPath}`);
    }
    return absPath;
}

/**
 * 真正落盘/读盘前先把内核备齐。OSFS.init() 是幂等共享 Promise，只有内核自己的
 * 存储消费者（访达/文稿/聚焦搜索…）碰到文件时才懒触发；若插件只认 window.Deskly.fs，
 * 挂载句柄一直读不回来、mountHandle 停在 null，磁盘挂载会被虚拟树顶替，同一批路径
 * 就此出现两个真相。纯路径计算（temp/home）不需要。
 */
const withKernel = (handler) => (ctx, ...args) => OSFS.init().then(() => handler(ctx, ...args));

/* ── 一、应用 ── */

const appsDefault = {
    /** 绑定扩展名或协议到某个应用：set(".md","notepad") / set("http:","my-browser")。需 default-apps:write。 */
    set: guard("default-apps:write", (ctx, key, appId) => setDefaultApp(key, appId)),
    /** 查询某类型当前由谁打开（含三级回退）。需 default-apps:read。 */
    get: guard("default-apps:read", (ctx, key) => getDefaultApp(key)),
    /** 当前生效值 + 来源（user/system/manifest），界面用它区分「用户改过」与「出厂值」。需 default-apps:read。 */
    resolve: guard("default-apps:read", (ctx, key) => resolveDefaultApp(key)),
    /** 全部用户改绑记录。需 default-apps:read。 */
    getAll: guard("default-apps:read", () => getAllBindings()),
    /** 全部可管理类型（出厂默认 ∪ 用户改绑 ∪ 插件声明）。需 default-apps:read。 */
    list: guard("default-apps:read", () => listTypes()),
    /** 恢复某个键的系统默认。需 default-apps:write。 */
    reset: guard("default-apps:write", (ctx, key) => resetDefaultApp(key)),
    /** 全部恢复。需 default-apps:write。 */
    resetAll: guard("default-apps:write", () => resetAllDefaultApps()),
};

const apps = Object.freeze({
    /** 启动应用：接受 appId（office.word）、插件 id 或显示名（「文稿」）。需 apps:launch。 */
    launch: guard("apps:launch", (ctx, nameOrId, opts) => {
        const appId = resolveAppId(nameOrId);
        if (!appId) throw new Error(`找不到应用：${nameOrId}`);
        return openApp(appId, opts);
    }),
    /** 全部可启动应用的摘要。免权限（只是目录，不构成能力）。 */
    list() {
        return listApps().map((rec) => ({
            appId: rec.appId,
            pluginId: rec.id,
            name: rec.name,                    // 中文原名（身份，跨语言不变）
            displayName: rec.displayName,      // 当前语言的显示名（渲染用）
            entry: (rec.app && rec.app.entry) || rec.manifest.entry || "window",
        }));
    },
    /** 单个应用的记录（含 manifest 与 app 片段），查不到返回 null。免权限。 */
    info(nameOrId) {
        return resolveAppRecord(nameOrId) || null;
    },
    default: Object.freeze(appsDefault),
});

/* ── 二、文件（默认锁在自己的 AppData 沙箱里） ── */

const fs = Object.freeze({
    /** 读 data/x.md 这类相对路径，返回 File。需 files:read。 */
    read: guard("files:read", withKernel((ctx, rel) => scopeOf(ctx.caller).read(rel))),
    /** 写相对路径，目录自动补齐。需 files:write。 */
    write: guard("files:write", withKernel((ctx, rel, data) => scopeOf(ctx.caller).write(rel, data))),
    /** 列目录（缺省列沙箱根）。需 files:read。 */
    list: guard("files:read", withKernel((ctx, rel = "") => scopeOf(ctx.caller).list(rel))),
    /** 建目录。需 files:write。 */
    mkdir: guard("files:write", withKernel((ctx, rel) => scopeOf(ctx.caller).mkdir(rel))),
    /** 删除。需 files:write。 */
    remove: guard("files:write", withKernel((ctx, rel, opts) => scopeOf(ctx.caller).remove(rel, opts))),
    /** 是否存在。需 files:read。 */
    exists: guard("files:read", withKernel((ctx, rel) => scopeOf(ctx.caller).exists(rel))),
    /** 临时目录绝对路径（关窗即可丢的东西放这里）。免权限。 */
    temp(...segs) {
        // 归属走 resolveCaller（含内核声明的 ambient），不再直接读 window.__currentPluginId ——
        // 那是个插件自己能改写的全局，读它等于让插件把别人 / 内核的目录拿去用。
        return scopeOf(resolveCaller()).temp(...segs);
    },
    /**
     * 读写 /文档、/下载 这类公开绝对路径。
     * 读需 files:read、写需 files:write；指向其它插件 AppData 的路径一律拒绝。
     */
    at: guard("files:read", withKernel(async (ctx, absPath) => {
        const norm = assertNotOtherScope(ctx.caller, OSFS.normalizePath(absPath));
        const row = await OSFS.stat(norm);
        if (row && row.type === "folder") return OSFS.list(norm);
        return OSFS.read(norm);
    })),
    /** 写公开绝对路径。需 files:write（敏感，运行时确认）。 */
    writeAt: guard("files:write", withKernel(async (ctx, absPath, data) => {
        const norm = assertNotOtherScope(ctx.caller, OSFS.normalizePath(absPath));
        return OSFS.write(norm, data);
    })),
    /** 自己 AppData 的绝对路径与三个预建子目录。免权限。 */
    home() {
        const handle = scopeOf(resolveCaller());
        return { path: handle.path, temp: handle.temp(), config: handle.config(), data: handle.data() };
    },
    type: Object.freeze({
        /** 该扩展名归哪个应用打开（含用户改绑）。需 default-apps:read。 */
        get: guard("default-apps:read", (ctx, ext) => {
            const hit = resolveDefaultApp(ext);
            return hit.appId ? hit : undefined;
        }),
    }),
});

/* ── 三、事件总线：具名 DOM 事件的薄封装，不新建总线 ── */

/**
 * 与 app-registry.js broadcast():38 完全同形状（document + bubbles:true + CustomEvent.detail），
 * 所以内核已有的 settings-changed / plugin-unload / default-apps-changed 在这里都收得到。
 * `system:` 前缀的 topic 走 window —— 与内核那批 window 级事件（dock-size-change 等）对齐。
 */
function busTopic(raw) {
    const name = String(raw);
    return { type: name.replace(/^system:/, ""), onWindow: name.startsWith("system:") };
}

const bus = Object.freeze({
    /** 订阅，返回退订函数。插件必须在 plugin-unload 里调用，否则监听器永久累积。 */
    on(topic, handler) {
        const { type, onWindow } = busTopic(topic);
        const target = onWindow ? window : document;
        // 归属在**订阅时**定一次：回调由内核派发，派发期的调用栈不保证还认得出是谁注册的
        // （认不出就会落进 guard 的拒绝分支）。订阅这一刻插件帧一定在栈上。
        const owner = resolveCaller();
        const wrapped = (event) => withCaller(owner, () => handler(event.detail, event));
        target.addEventListener(type, wrapped);
        return () => target.removeEventListener(type, wrapped);
    },
    /** 取消订阅：只有拿不到 on() 返回值时才用这个。 */
    off(topic, handler) {
        const { type, onWindow } = busTopic(topic);
        (onWindow ? window : document).removeEventListener(type, handler);
    },
    /** 发事件，免权限。 */
    emit(topic, data) {
        const { type, onWindow } = busTopic(topic);
        (onWindow ? window : document).dispatchEvent(new CustomEvent(type, { detail: data, bubbles: true }));
        return true;
    },
});

/* ── 四、尚未落地的分段：签名先立住，后续段填实现 ── */

const widgets = Object.freeze({
    create: pending("4"),
    update: pending("4"),
    remove: pending("4"),
    on: pending("4"),
    emit: pending("4"),
});

/**
 * 选择器安全转义（CSS.escape 在老浏览器上可能缺）。
 * @param {string} value 插件 id
 * @returns {string} 可拼进属性选择器的值
 */
function cssEscapeId(value) {
    return (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(String(value)) : String(value).replace(/[^A-Za-z0-9_-]/g, "\\$&");
}

/**
 * 窗口：应用对自己窗口的声明权（尺寸 / 边界 / 可否缩放）。
 *
 * 与 markup 侧的 data-window 是同一份配置的两种写法：静态尺寸写在界面里，
 * 运行期才知道的尺寸（比如按文档内容决定初始大小）用这里改。
 * 只允许动自己的窗口：按 data-plugin-id 校验归属，避免一个插件把别的窗口改小。
 * 用动态 import 是为了不加入口循环 —— window-manager 静态依赖 finderbar，
 * 而 finderbar 这一支又回头依赖会话/控制中心模块。
 */
const windows = Object.freeze({
    /**
     * 声明本插件窗口的尺寸与缩放能力。
     * @param {HTMLElement|string|null} target 窗口元素或窗口 id / 应用显示名；null = 调用者自己的窗口
     * @param {{width?:number,height?:number,minWidth?:number,minHeight?:number,
     *          maxWidth?:number,maxHeight?:number,resizable?:boolean,
     *          minimizable?:boolean,maximizable?:boolean,centered?:boolean}} conf
     * @returns {Promise<object>} 信封 {ok, value?|reason?}
     */
    async configure(target, conf) {
        const caller = resolveCaller();
        const wm = await import("./window-manager.js");
        const el = target == null
            ? (caller ? document.querySelector(`.window[data-plugin-id="${cssEscapeId(caller)}"]`) : null)
            : (typeof target === "string" ? document.getElementById(target) : target);
        if (!el || !wm.isWindowElement(el)) return { ok: false, reason: "找不到该窗口" };
        // 归属校验不能有"字段缺失就放行"的旁门：上一版写成
        //   if (caller && el.dataset.pluginId && el.dataset.pluginId !== caller) 拒绝
        // 于是「认不出调用者」或「目标窗口没有 data-plugin-id」两种情况下整段被跳过 ——
        // 前者对应栈解析失败，后者对应 legacy create() 造的窗口。现在一律要求
        // 目标窗口的 data-plugin-id 与调用者严格相等（plugin-manager 给每个插件窗口都写了它）。
        if (!caller) return { ok: false, reason: "无法确认调用者，拒绝配置窗口" };
        if (el.dataset.pluginId !== caller) {
            return { ok: false, reason: `只能配置自己的窗口（该窗口属于 ${el.dataset.pluginId || "内核"}）` };
        }
        if (!conf || typeof conf !== "object") return { ok: false, reason: "缺少配置对象" };
        const ok = wm.configure(el, conf);
        return ok ? { ok: true, value: wm.stateOf(el) } : { ok: false, reason: "配置未生效" };
    },
    /**
     * 读窗口当前状态（框架 / 缩放态 / 全屏态 / 可否缩放）。免权限，直接返回原生值。
     * @param {HTMLElement|string} target 窗口元素或窗口 id
     * @returns {object|null}
     */
    state(target) {
        const el = typeof target === "string" ? document.getElementById(target) : target;
        return el && el.winctl ? el.winctl.state : null;
    },
    style: Object.freeze({
        set: pending("5"),
        applyTheme: pending("5"),
    }),
});

const icons = Object.freeze({ set: pending("6") });

/** target 白名单 dock/finderbar/desktop/wallpaper/menu，对应 system-patch:* 权限。 */
const system = Object.freeze({
    patch: Object.freeze({
        apply: pending("7"),
        remove: pending("7"),
    }),
});

/* ── 五、自省与诊断 ── */

const meta = Object.freeze({
    version: VERSION,
    /** 当前界面语言代号（zh-CN / en / ja-JP / cat）。插件据此本地化自己的文案。 */
    language: () => i18n.getLanguage(),
    /** 支持的语言列表 [{code,label}]，用来画语言选择器。 */
    languages: () => i18n.getSupportedLanguages(),
    /** 订阅语言切换，回调收到新代号；返回退订函数（插件须在 plugin-unload 里调用）。 */
    onLanguageChange: (fn) => i18n.onChange(fn),
    /** 把应用身份串（appId / 插件 id / 中文原名）翻成当前语言显示名；查不到原样返回。 */
    appName: (nameOrId) => displayNameFor(nameOrId),
    /** 权限名全表 + 中文描述 + 是否敏感；帮助文档与弹窗同源。 */
    permissions() {
        return PERMISSION_NAMES.map((name) => ({
            name,
            ...describe(name),
            sensitive: SENSITIVE.has(name) || name.startsWith("system-patch:"),
        }));
    },
    /** 自己的授权账本。跨插件查询一律不给：那只是把「谁被授予了 files:write」这份情报递出去。 */
    grants() {
        const caller = resolveCaller();
        return caller ? listGrants(caller) : [];
    },
    /** 账本里有记录的插件 id（只回当前调用者，理由同上）。 */
    grantedIds() {
        const caller = resolveCaller();
        return caller ? [caller] : [];
    },
    /** 现在能不能直接调（只查账，不弹窗、不改状态）。只查自己。 */
    can(permission) {
        const caller = resolveCaller();
        return caller ? isActivated(caller, permission) : false;
    },
    /** 调试用：当前识别出的调用者插件 id（null = 认不出）。 */
    caller() {
        return resolveCaller();
    },
});

const root = Object.freeze({ apps, fs, bus, widgets, windows, icons, system, meta });

Object.defineProperty(window, "Deskly", {
    value: root,
    writable: false,
    configurable: false,
    enumerable: true,
});

/** 内核侧引用：装配自检与非模块脚本用（不是给插件的第三入口，插件用 window.Deskly）。 */
globalThis.__desklyApi = { root, guard, getApp, openApp };

export { root as Deskly, guard, apps, fs, bus, meta };
