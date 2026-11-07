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
 * 信封与 window.__settings.set() 的约定一致（settings.js 的 set() 返回形态），插件写
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

import { openApp, registerBeforeUnload } from "./plugin-manager.js";
import { listApps, resolveAppId, resolveAppRecord, getApp, displayNameFor, isKernelTopic, getAppVisibility } from "./app-registry.js";
import { i18n } from "./i18n.js";
import { OSFS } from "./osfs.js";
import { FS } from "./fs/index.js";
import { QuickLook } from "./core/quicklook.js";
import { GetInfo } from "./core/getInfo.js";
import { MenuProviders } from "./core/menuProviders.js";
import { Shortcuts } from "./core/shortcuts.js";
import { moveToTrash, putBack, emptyTrash, TRASH_ORIGIN_SUFFIX } from "./trash.js";
import { VFS } from "./vfs.js";
import { createContextMenu } from "./ui/contextMenu.js";
import {
    resolve as resolveDefaultApp, get as getDefaultApp, set as setDefaultApp,
    getAll as getAllBindings, listTypes, reset as resetDefaultApp, resetAll as resetAllDefaultApps,
} from "./default-apps.js";
import {
    ensurePermission, resolveCaller, describe, isActivated,
    listGrants, PERMISSION_NAMES, SENSITIVE,
} from "./api-grants.js";
import { claimCaller, runAs } from "./caller-context.js";
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
            return { ok: false, denied: true, code: "DENIED", permission, reason: "无法确认调用者（插件脚本必须位于 ./mods/<id>/ 下）" };
        }
        if (!(await ensurePermission(caller, permission))) {
            return { ok: false, denied: true, code: "DENIED", permission, reason: `未授权：${describe(permission).label}` };
        }
        try {
            const value = await handler({ caller, permission }, ...args);
            return { ok: true, value };
        } catch (err) {
            const message = err && err.message ? err.message : String(err);
            window.__log?.error(`plugin/${caller}`, `Deskly 调用失败（${permission}）：`, { message });
            // code 可编程识别（DENIED/UNIMPLEMENTED/NOT_FOUND/INVALID_ARG/REAUTH/INTERNAL），
            // reason 只给人看 —— 插件分支判断别再匹配中文文案。
            return { ok: false, code: (err && err.code) || "INTERNAL", permission, reason: message };
        }
    };
}

/** 未落地分段的占位方法：返回信封而不是抛错，插件提前接入也不会崩。 */
function pending(segment) {
    return async () => ({ ok: false, code: "UNIMPLEMENTED", reason: `未实现（改造提示词 ${segment}）` });
}

/** 能力尚未开放的权限名（对应 pending 占位的方法面）：安装清单与 meta.permissions() 据它打「尚未开放」标。 */
const UNIMPLEMENTED_PERMISSIONS = new Set([
    "widgets", "dynamic-icons", "window-style:others", "theme:apply",
    "system-patch:dock", "system-patch:finderbar", "system-patch:desktop", "system-patch:wallpaper", "system-patch:menu",
]);

/**
 * 取调用者的文件句柄。OSFS.scope() 把相对路径一律锁在 /AppData/<id>/ 之下，
 * 越出时它自己抛错（osfs.js 的 scope() 内 `越出插件目录`，当前在 :1004），这层不必再写一遍边界检查。
 */
const scopeOf = (caller) => OSFS.scope(caller || KERNEL_SCOPE);

/**
 * 拒绝跨插件读别人的 AppData —— 这一条不给弹窗机会，权限也不给。
 * 归一化在 osfs 内做（大小写 / 分隔符 / Unicode / 尾随斜杠 / `..` 全部收敛）：
 * 磁盘后端（Windows/APFS）下 `/appdata`、`/AppData.` 等拼写变体命中同一个真实目录，
 * 按原样正则比较会被绕过（BUG-20）；`/AppData` 根本身也拒绝（列出根 = 拿到全部 scope 名）。
 */
function assertNotOtherScope(caller, absPath) {
    if (OSFS.isOtherAppData(absPath, caller || KERNEL_SCOPE)) {
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
    /**
     * 启动应用：接受 appId（office.word）、插件 id 或显示名（「文稿」）。需 apps:launch。
     * opts.newWindow = true 时另开新窗（NW-7）：以 manifest 的 multiWindow:true 为准入闸，
     * 未声明的插件直接拒绝（信封 ok:false），这是不破旧插件的关键闸。
     */
    launch: guard("apps:launch", async (ctx, nameOrId, opts) => {
        const appId = resolveAppId(nameOrId);
        if (!appId) { const err = new Error(`找不到应用：${nameOrId}`); err.code = "NOT_FOUND"; throw err; }
        if (opts && opts.newWindow) {
            const rec = resolveAppRecord(appId);
            const allowed = !!(rec && ((rec.app && rec.app.multiWindow === true) || (rec.manifest && rec.manifest.multiWindow === true)));
            if (!allowed) { const err = new Error("该应用未声明多窗口（需要 manifest.multiWindow: true）"); err.code = "INVALID_ARG"; throw err; }
        }
        // openApp 对「插件被禁用 / 未注册」是静默 resolve(null)：信封不能报 ok:true（BUG-26）。
        const win = await openApp(appId, opts);
        if (!win) { const err = new Error(`应用被禁用或未注册：${appId}`); err.code = "NOT_FOUND"; throw err; }
        return win;
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
    /** 应用可见性（启动台/设置/访达/可卸载/系统应用），免权限查询（只读声明，不含他人隐私）。 */
    visibility: (nameOrId) => {
        const appId = resolveAppId(nameOrId);
        return appId ? getAppVisibility(appId) : null;
    },
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
    /** 元信息（大小 / 修改时间 / 类型）。需 files:read。 */
    stat: guard("files:read", withKernel(async (ctx, rel) => OSFS.stat(scopeOf(ctx.caller).resolve(rel || "")))),
    /** 重命名 / 移动（同沙箱内）。需 files:write。 */
    rename: guard("files:write", withKernel((ctx, fromRel, toRel) => scopeOf(ctx.caller).move(fromRel, toRel))),
    /** 复制（文件或目录，同沙箱内；目标是完整目标路径而非父目录）。需 files:write。 */
    copy: guard("files:write", withKernel(async (ctx, fromRel, toRel) => {
        const scope = scopeOf(ctx.caller);
        const src = scope.resolve(fromRel), dst = scope.resolve(toRel);
        const st = await OSFS.stat(src);
        if (!st) { const err = new Error(`找不到源路径：${fromRel}`); err.code = "NOT_FOUND"; throw err; }
        if (st.type === "folder") {
            if (dst === src || dst.startsWith(src + "/")) { const err = new Error("不能把目录复制进它自己"); err.code = "INVALID_ARG"; throw err; }
            await OSFS.mkdir(dst);
            const walk = async (from, to) => {
                for (const entry of await OSFS.list(from)) {
                    if (entry.type === "folder") { await OSFS.mkdir(to + "/" + entry.name); await walk(entry.path, to + "/" + entry.name); }
                    else await OSFS.write(to + "/" + entry.name, await OSFS.read(entry.path));
                }
            };
            await walk(src, dst);
            return { ok: true };
        }
        return OSFS.write(dst, await OSFS.read(src));
    })),
    /** 临时目录绝对路径（关窗即可丢的东西放这里）。免权限；认不出调用者时返回 null，不落进 kernel 作用域。 */
    temp(...segs) {
        // 归属走 resolveCaller（含内核声明的 ambient），不再直接读 window.__currentPluginId ——
        // 那是个插件自己能改写的全局，读它等于让插件把别人 / 内核的目录拿去用。
        const caller = resolveCaller();
        if (!caller) return null; // 与 guard「认不出即拒绝」同一原则（API-14）
        return scopeOf(caller).temp(...segs);
    },
    /**
     * 读写 /文档、/下载 这类公开绝对路径。
     * 读需 files:read、写需 files:write；指向其它插件 AppData 的路径一律拒绝。
     */
    at: guard("files:read", withKernel(async (ctx, absPath) => {
        const norm = assertNotOtherScope(ctx.caller, OSFS.normalizePath(absPath));
        try {
            const row = await OSFS.stat(norm);
            if (row && row.type === "folder") return await OSFS.list(norm);
            return await OSFS.read(norm);
        } catch (err) {
            // 授权过期要可编程识别：插件据此引导「重新授权」，而不是拿消息文本猜（API-09）
            if (err && err.name === "NeedsReauthError") { err.code = "REAUTH"; }
            throw err;
        }
    })),
    /** 写公开绝对路径。需 files:write（敏感，运行时确认）。 */
    writeAt: guard("files:write", withKernel(async (ctx, absPath, data) => {
        const norm = assertNotOtherScope(ctx.caller, OSFS.normalizePath(absPath));
        try {
            return await OSFS.write(norm, data);
        } catch (err) {
            if (err && err.name === "NeedsReauthError") { err.code = "REAUTH"; }
            throw err;
        }
    })),
    /** 自己 AppData 的绝对路径与三个预建子目录。免权限；认不出调用者时返回 null（API-14）。 */
    home() {
        const caller = resolveCaller();
        if (!caller) return null;
        const handle = scopeOf(caller);
        return { path: handle.path, temp: handle.temp(), config: handle.config(), data: handle.data() };
    },
    type: Object.freeze({
        /** 该扩展名归哪个应用打开（含用户改绑），查无返回 null（与其余门面方法一致）。需 default-apps:read。 */
        get: guard("default-apps:read", (ctx, ext) => {
            const hit = resolveDefaultApp(ext);
            return hit.appId ? hit : null;
        }),
    }),
    /** 读公开绝对路径的元信息（不读内容）。需 files:read。 */
    statAt: guard("files:read", withKernel(async (ctx, absPath) => {
        const norm = assertNotOtherScope(ctx.caller, OSFS.normalizePath(absPath));
        return FS.stat(norm);
    })),
    /** 存在性判定。需 files:read。 */
    existsAt: guard("files:read", withKernel(async (ctx, absPath) => {
        const norm = assertNotOtherScope(ctx.caller, OSFS.normalizePath(absPath));
        return FS.exists(norm);
    })),
    /** 建公开绝对路径目录（父级自动补齐）。需 files:write（敏感，运行时确认）。 */
    mkdirAt: guard("files:write", withKernel(async (ctx, absPath) => {
        const norm = assertNotOtherScope(ctx.caller, OSFS.normalizePath(absPath));
        return FS.mkdir(norm);
    })),
    /** 删公开绝对路径（默认进废纸篓可放回；{trash:false} 直接删）。需 files:write（敏感）。 */
    removeAt: guard("files:write", withKernel(async (ctx, absPath, opts) => {
        const norm = assertNotOtherScope(ctx.caller, OSFS.normalizePath(absPath));
        if (!opts || opts.trash !== false) return moveToTrash(norm);
        return FS.remove(norm, { recursive: Boolean(opts && opts.recursive) });
    })),
    /** 同目录重命名。需 files:write（敏感）。 */
    renameAt: guard("files:write", withKernel(async (ctx, absPath, newName) => {
        const norm = assertNotOtherScope(ctx.caller, OSFS.normalizePath(absPath));
        return FS.rename(norm, newName);
    })),
    /** 移动（跨后端自动；目标重名抛 EEXIST）。需 files:write（敏感）。 */
    moveAt: guard("files:write", withKernel(async (ctx, src, dest) => {
        const from = assertNotOtherScope(ctx.caller, OSFS.normalizePath(src));
        const to = assertNotOtherScope(ctx.caller, OSFS.normalizePath(dest));
        return FS.move(from, to);
    })),
    /** 复制到目标路径（目录整棵递归）。需 files:write（敏感）。 */
    copyAt: guard("files:write", withKernel(async (ctx, src, dest) => {
        const from = assertNotOtherScope(ctx.caller, OSFS.normalizePath(src));
        const to = assertNotOtherScope(ctx.caller, OSFS.normalizePath(dest));
        return FS.copy(from, to);
    })),
    /** 递归收集文件条目（最近使用/导出/统计）。需 files:read。 */
    walkAt: guard("files:read", withKernel(async (ctx, absPath, depth) => {
        const norm = assertNotOtherScope(ctx.caller, OSFS.normalizePath(absPath));
        return FS.walk(Number.isFinite(depth) ? depth : 3, norm);
    })),
    /** 订阅子树文件变化（fs-changed），返回退订函数。需 files:read。 */
    watchAt: guard("files:read", withKernel(async (ctx, absPath, cb) => {
        const norm = assertNotOtherScope(ctx.caller, OSFS.normalizePath(absPath));
        const claim = claimCaller();
        return FS.watch(norm, (detail) => runAs(claim, () => cb(detail)));
    })),
    /** 路径工具与顶层目录常量：纯计算，免权限。 */
    paths: Object.freeze({
        join: OSFS.joinPath,
        normalize: OSFS.normalizePath,
        baseName: OSFS.baseName,
        parentOf: OSFS.parentOf,
        sanitizeName: OSFS.sanitizeName,
        documents: OSFS.TOP.documents.path,
        downloads: OSFS.TOP.downloads.path,
        pictures: OSFS.TOP.pictures.path,
        desktop: OSFS.TOP.desktop.path,
        trash: OSFS.TOP.trash.path,
        appdata: OSFS.TOP.appdata.path,
        photos: "/Picture",
    }),
    /** 废纸篓。list 需 files:read；putBack/empty 需 files:write（敏感）。 */
    trash: Object.freeze({
        list: guard("files:read", withKernel(async () => FS.list(OSFS.TOP.trash.path))),
        moveToTrash: guard("files:write", withKernel(async (ctx, absPath) => {
            const norm = assertNotOtherScope(ctx.caller, OSFS.normalizePath(absPath));
            return moveToTrash(norm);
        })),
        putBack: guard("files:write", withKernel(async (ctx, trashPath) => {
            const norm = OSFS.normalizePath(trashPath);
            return putBack(norm);
        })),
        empty: guard("files:write", withKernel(async () => emptyTrash())),
        /** 溯源伴生文件后缀（渲染废纸篓列表时据此过滤），免权限。 */
        originSuffix: TRASH_ORIGIN_SUFFIX,
    }),
});

/* ── 三、事件总线：具名 DOM 事件的薄封装，不新建总线 ── */

/**
 * 与 app-registry.js 的 broadcast() 完全同形状（document + bubbles:true + CustomEvent.detail），
 * 所以内核已有的 settings-changed / plugin-unload / default-apps-changed 在这里都收得到。
 * `system:` 前缀的 topic 走 window —— 与内核那批 window 级事件（dock-size-change 等）对齐。
 */
function busTopic(raw) {
    const name = String(raw);
    return { type: name.replace(/^system:/, ""), onWindow: name.startsWith("system:") };
}

/**
 * 订阅归属登记：owner -> Set<退订函数>。插件卸载（plugin-unload）时内核统一补退，
 * 插件手写退订漏了也不泄漏（API-15）；退订幂等，插件自己退过的从这里一并清掉。
 */
const busOwners = new Map();

function trackBus(owner, off) {
    if (!owner) return;
    let set = busOwners.get(owner);
    if (!set) { set = new Set(); busOwners.set(owner, set); }
    const wrapped = () => { set.delete(wrapped); off(); };
    set.add(wrapped);
    return wrapped;
}

// 内核自己监听卸载广播做兜底回收。监听挂在 os-api（归属表的 owner）而不是各插件。
document.addEventListener("plugin-unload", (event) => {
    const id = event && event.detail && event.detail.id;
    if (!id) return;
    const set = busOwners.get(id);
    if (!set) return;
    busOwners.delete(id);
    for (const off of set) { try { off(); } catch { /* 单个退订失败不拖垮其余 */ } }
});

const bus = Object.freeze({
    /** 订阅，返回退订函数。插件卸载时内核会兜底补退（手写退订仍是推荐做法）。 */
    on(topic, handler) {
        const { type, onWindow } = busTopic(topic);
        const target = onWindow ? window : document;
        // 归属在**订阅时**认领成不可伪造凭证：回调由内核派发，派发期的调用栈不保证还认得出
        // 是谁注册的（认不出就会落进 guard 的拒绝分支）。订阅这一刻插件帧一定在栈上。
        const claim = claimCaller();
        const wrapped = (event) => runAs(claim, () => handler(event.detail, event));
        target.addEventListener(type, wrapped);
        const off = () => target.removeEventListener(type, wrapped);
        return trackBus(resolveCaller(), off) || off;
    },
    /** 取消订阅：只有拿不到 on() 返回值时才用这个。 */
    off(topic, handler) {
        const { type, onWindow } = busTopic(topic);
        (onWindow ? window : document).removeEventListener(type, handler);
    },
    /**
     * 发事件，免权限 —— 但内核保留主题拒发（isKernelTopic，app-registry 维护名单）。
     * 伪造 plugin-registered 曾可自我授予权限、伪造 settings-changed 可让界面与存储漂移
     * （BUG-17 / API-05）。内核自己不经过这里（broadcast / dispatchEvent 直发），不受影响。
     * @returns {boolean} false = 主题被保留字拦截
     */
    emit(topic, data) {
        const { type, onWindow } = busTopic(topic);
        if (isKernelTopic(type)) {
            window.__log?.warn("kernel/os-api", `已拒发内核保留主题：${type}（插件请用自己的主题名）`);
            return false;
        }
        (onWindow ? window : document).dispatchEvent(new CustomEvent(type, { detail: data, bubbles: true }));
        return true;
    },
});

/* ── 三、Quick Look / 菜单 / 打开方式 / 快捷方式 / 访达门面 / UI 原语 ── */

/** Quick Look：注册预览 provider 需 quicklook:register；open/close/isOpen 是界面行为，免权限。 */
const quicklook = Object.freeze({
    registerProvider: guard("quicklook:register", (ctx, provider) => {
        if (!provider || typeof provider !== "object") { const err = new Error("provider 必须是对象"); err.code = "INVALID_ARG"; throw err; }
        return QuickLook.registerProvider({ ...provider, id: `${ctx.caller}.${provider.id || "preview"}` });
    }),
    open: (items, index) => QuickLook.open(items, index),
    close: () => QuickLook.close(),
    isOpen: () => QuickLook.isOpen(),
});

/** 文件右键菜单 provider：桌面与访达共用。需 menus:register。 */
const menus = Object.freeze({
    registerProvider: guard("menus:register", (ctx, provider) => {
        if (!provider || typeof provider !== "object") { const err = new Error("provider 必须是对象"); err.code = "INVALID_ARG"; throw err; }
        return MenuProviders.registerProvider({ ...provider, id: `${ctx.caller}.${provider.id || "menu"}` });
    }),
    listProviders: () => MenuProviders.listProviders(),
});

/** 打开方式：查询候选需 default-apps:read；打开需 apps:launch；改绑需 default-apps:write（敏感）。 */
const openWith = Object.freeze({
    appsFor: guard("default-apps:read", (ctx, ext) => {
        const bare = String(ext || "").replace(/^\./, "").toLowerCase();
        if (!bare) return [];
        const hits = [];
        for (const rec of listApps()) {
            const formats = (rec.app && rec.app.formats) || (!rec.app && rec.manifest && rec.manifest.formats);
            if (!Array.isArray(formats)) continue;
            if (formats.some((f) => String(f || "").trim().toLowerCase().replace(/^\./, "") === bare)) {
                hits.push({ appId: rec.appId, name: rec.name || rec.appId });
            }
        }
        const defaultAppId = getDefaultApp(ext);
        hits.sort((a, b) => (a.appId === defaultAppId ? -1 : 0) - (b.appId === defaultAppId ? -1 : 0));
        return hits.map((h) => ({ ...h, isDefault: h.appId === defaultAppId }));
    }),
    open: guard("apps:launch", async (ctx, absPath, appId) => {
        const norm = assertNotOtherScope(ctx.caller, OSFS.normalizePath(absPath));
        const target = appId || resolveDefaultApp((norm.match(/\.([^.]+)$/) || [])[1] || "").appId;
        if (!target) { const err = new Error(`没有能打开该类型的应用：${norm}`); err.code = "NOT_FOUND"; throw err; }
        return openApp(target, { file: norm });
    }),
    setDefault: guard("default-apps:write", (ctx, ext, appId) => setDefaultApp(ext, appId)),
});

/** 桌面快捷方式：add/remove/findExisting 需 shortcuts:write；read 免权限。 */
const shortcuts = Object.freeze({
    add: guard("shortcuts:write", (ctx, appId) => Shortcuts.add(appId)),
    remove: guard("shortcuts:write", (ctx, absPath) => {
        assertNotOtherScope(ctx.caller, OSFS.normalizePath(absPath));
        return Shortcuts.remove(absPath);
    }),
    findExisting: guard("shortcuts:write", (ctx, appId) => Shortcuts.findExisting(appId)),
    read: (absPath) => Shortcuts.read(absPath),
});

/**
 * 访达门面：顶层节点/书签/最近使用的合并视图（与访达同一数据源）。
 * list/readFile 需 files:read；decline（放弃挂载）需 files:write（敏感）。
 */
const vfs = Object.freeze({
    list: guard("files:read", withKernel((ctx, absPath) => VFS.list(assertNotOtherScope(ctx.caller, OSFS.normalizePath(absPath))))),
    readFile: guard("files:read", withKernel((ctx, absPath) => VFS.readFile(assertNotOtherScope(ctx.caller, OSFS.normalizePath(absPath))))),
    recentFiles: guard("files:read", withKernel((ctx, limit) => VFS.getRecentFiles(limit || 50))),
    authStatus: () => VFS.getAuthStatus(),
    whereStored: () => VFS.whereStored(),
    topFolders: () => VFS.TOP_FOLDERS,
    bookmarksPath: () => VFS.BOOKMARKS_PATH,
    recentPath: () => VFS.RECENT_PATH,
    formatSize: (bytes) => VFS.formatSize(bytes),
    formatDate: (ts) => VFS.formatDate(ts),
    init: guard("files:read", withKernel(() => VFS.init())),
    authorize: guard("files:write", withKernel(() => VFS.authorize())),
    reauthorize: guard("files:write", withKernel(() => VFS.reauthorize())),
    decline: guard("files:write", withKernel(() => VFS.decline())),
});

/**
 * 插件可用的弹窗子集。
 *
 * 实现统一在 ui/dialog.js，但这里**只放安全方法**：权限授权框不在其中 ——
 * 插件不能自己弹一枚「始终允许」的系统授权，那只能由内核在敏感能力首次被调用时发起。
 * 动态 import 避免把 i18n / 弹窗样式提前拉进入口关键路径。
 */
const pluginDialog = Object.freeze({
    alert: (opts) => import("./ui/dialog.js").then((m) => m.dialog.alert(opts)),
    error: (opts) => import("./ui/dialog.js").then((m) => m.dialog.error(opts)),
    confirm: (opts) => import("./ui/dialog.js").then((m) => m.dialog.confirm(opts)),
    prompt: (opts) => import("./ui/dialog.js").then((m) => m.dialog.prompt(opts)),
    choose: (opts) => import("./ui/dialog.js").then((m) => m.dialog.choose(opts)),
    progress: (opts) => import("./ui/dialog.js").then((m) => m.dialog.progress(opts)),
});

/** UI 原语：右键菜单与浮层（纯界面，免权限）。 */
const ui = Object.freeze({
    contextMenu: (x, y, items) => createContextMenu(x, y, items),
    openPopover: (...args) => import("./ui/popover.js").then((m) => m.openPopover(...args)),
    closeAllPopovers: () => import("./ui/popover.js").then((m) => m.closeAllPopovers()),
    // 「显示简介」是文件系统的通用视图：访达/桌面/插件共用同一个单例面板
    showGetInfo: (items) => GetInfo.open(items),
    // 系统弹窗：确认 / 输入 / 提示 / 进度。权限请求不在此列。
    dialog: pluginDialog,
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
/**
 * 归属校验：解析目标窗口并确认它属于调用者。
 * @returns {{el: HTMLElement|null, reason?: string}}
 */
function ownWindow(wm, caller, target) {
    let el = target == null
        ? (caller ? document.querySelector(`.window[data-plugin-id="${cssEscapeId(caller)}"]`) : null)
        : (typeof target === "string" ? document.getElementById(target) : target);
    // 字符串也可以是应用显示名（文档承诺的形态）：窗口 id 是中文原名，本地化显示名
    // 与它不同 —— 先按 id 查，查不到再经注册表把显示名解析成 windowName 再查（BUG-28）。
    if (!el && typeof target === "string") {
        const rec = resolveAppRecord(target);
        const winName = rec ? (rec.app?.windowName || rec.manifest?.windowName || rec.app?.name || rec.manifest?.name) : null;
        if (winName && winName !== target) el = document.getElementById(winName);
    }
    if (!el || !wm.isWindowElement(el)) return { el: null, reason: "找不到该窗口" };
    // 归属校验不能有"字段缺失就放行"的旁门：上一版写成
    //   if (caller && el.dataset.pluginId && el.dataset.pluginId !== caller) 拒绝
    // 于是「认不出调用者」或「目标窗口没有 data-plugin-id」两种情况下整段被跳过 ——
    // 前者对应栈解析失败，后者对应 legacy create() 造的窗口。现在一律要求
    // 目标窗口的 data-plugin-id 与调用者严格相等（plugin-manager 给每个插件窗口都写了它）。
    if (!caller) return { el: null, reason: "无法确认调用者，拒绝配置窗口" };
    if (el.dataset.pluginId !== caller) {
        return { el: null, reason: `只能操作自己的窗口（该窗口属于 ${el.dataset.pluginId || "内核"}）` };
    }
    return { el };
}

/** WAPI-10 过渡：跨窗读被拒时只 warn 一次，不刷屏。 */
let crossReadWarned = false;

const windows = Object.freeze({
    /**
     * 声明本插件窗口的尺寸与缩放能力。
     * 配置键与 data-window / manifest.window 同名（含 NW-1~NW-6 新键：
     * role/parent/modal/level/dragAxis/dragBounds/resizeAxis/aspectRatio/snap/titlebar/fixed）。
     * trafficLights:"none" 需 window:chrome（敏感，隐藏整组红绿灯有困住用户的风险）。
     * @param {HTMLElement|string|null} target 窗口元素或窗口 id / 应用显示名；null = 调用者自己的窗口
     * @param {object} conf
     * @returns {Promise<object>} 信封 {ok, value?|reason?}
     */
    configure: guard("window-style:self", async (ctx, target, conf) => {
        const wm = await import("./window-manager.js");
        const { el, reason } = ownWindow(wm, ctx.caller, target);
        if (!el) { const err = new Error(reason); err.code = "NOT_FOUND"; throw err; }
        if (!conf || typeof conf !== "object") { const err = new Error("缺少配置对象"); err.code = "INVALID_ARG"; throw err; }
        if (conf.trafficLights === "none" && !(await ensurePermission(ctx.caller, "window:chrome"))) {
            return { ok: false, denied: true, code: "DENIED", permission: "window:chrome", reason: `未授权：${describe("window:chrome").label}` };
        }
        const ok = wm.configure(el, conf);
        if (!ok) { const err = new Error("配置未生效"); err.code = "INTERNAL"; throw err; }
        return wm.stateOf(el);
    }),
    /**
     * 读窗口当前状态（框架 / 缩放态 / 全屏态 / 层级 / 母子关系）。
     * 读自己的窗免权限；读别人的窗需 window:read-others（WAPI-10，
     * 未授权返回 null 并一次性 console.warn，不弹窗）。
     * @param {HTMLElement|string} target 窗口元素或窗口 id
     * @returns {object|null}
     */
    state(target) {
        const caller = resolveCaller();
        const el = typeof target === "string" ? document.getElementById(target) : target;
        if (!el || !el.winctl) return null;
        if (caller && el.dataset.pluginId && el.dataset.pluginId !== caller && !isActivated(caller, "window:read-others")) {
            if (!crossReadWarned) {
                crossReadWarned = true;
                window.__log?.warn("kernel/os-api", `插件 ${caller} 读取其它应用窗口状态需 window:read-others`);
            }
            return null;
        }
        return el.winctl.state;
    },
    /**
     * 窗口清单。scope:"self"（默认，免权限）只列自己的窗；scope:"all" 需 window:read-others。
     * 每项：{id, appId, pluginId, frame, state}。
     */
    async list(opts = {}) {
        const caller = resolveCaller();
        if (!caller) return { ok: false, reason: "无法确认调用者" };
        const scope = opts && opts.scope === "all" ? "all" : "self";
        if (scope === "all" && !(await ensurePermission(caller, "window:read-others"))) {
            return { ok: false, denied: true, permission: "window:read-others", reason: `未授权：${describe("window:read-others").label}` };
        }
        const wm = await import("./window-manager.js");
        const rows = wm.getWindows()
            .filter((el) => scope === "all" || el.dataset.pluginId === caller)
            .map((el) => ({
                id: el.id || null,
                appId: el.dataset.appId || null,
                pluginId: el.dataset.pluginId || null,
                frame: wm.stateOf(el).frame,
                state: wm.stateOf(el),
            }));
        return { ok: true, value: rows };
    },
    /**
     * 订阅窗口事件（12 个 window:* 主题，见 wm/events.js）。
     * scope:"self"（默认）只收自己的窗；scope:"all" 需 window:read-others。
     * @returns {Function|object} 退订函数；未授权返回 {ok:false} 信封
     */
    on(topic, handler, opts = {}) {
        const caller = resolveCaller();
        const claim = claimCaller();
        const scope = opts && opts.scope === "all" ? "all" : "self";
        if (scope === "all" && (!caller || !isActivated(caller, "window:read-others"))) {
            window.__log?.warn("kernel/os-api", `订阅全部窗口事件需 window:read-others（${caller || "未知调用者"}）`);
            return { ok: false, denied: true, permission: "window:read-others", reason: "未授权：读取其他窗口" };
        }
        const name = String(topic || "");
        const wrapped = (event) => {
            const detail = event.detail || {};
            if (scope === "self" && caller && detail.pluginId && detail.pluginId !== caller) return;
            runAs(claim, () => handler(detail, event));
        };
        document.addEventListener(name, wrapped);
        return () => document.removeEventListener(name, wrapped);
    },
    /** 取消订阅：只有拿不到 on() 返回值时才用这个。 */
    off(topic, handler) {
        document.removeEventListener(String(topic || ""), handler);
    },
    /**
     * NW-1：把已托管窗口挂为子窗 / sheet / 模态窗。
     * parent 缺省 = 调用者的第一个普通窗；跨插件挂母窗需 window:manage-others。
     * @returns {Promise<object>} 信封，value 为 stateOf 快照
     */
    async attach(target, opts = {}) {
        const caller = resolveCaller();
        const wm = await import("./window-manager.js");
        const { el, reason } = ownWindow(wm, caller, target);
        if (!el) return { ok: false, reason };
        let parent = null;
        if (opts.parent) {
            parent = typeof opts.parent === "string" ? document.getElementById(opts.parent) : opts.parent;
            if (!parent || !wm.isWindowElement(parent)) return { ok: false, reason: "母窗不存在" };
            if (parent.dataset.pluginId !== caller && !(await ensurePermission(caller, "window:manage-others"))) {
                return { ok: false, denied: true, permission: "window:manage-others", reason: `未授权：${describe("window:manage-others").label}` };
            }
        } else {
            parent = wm.getWindows().find((w) => w !== el && w.dataset.pluginId === caller
                && (!w.dataset.wmRole || w.dataset.wmRole === "normal")) || null;
            if (!parent) return { ok: false, reason: "找不到可挂的母窗（本插件没有普通窗）" };
        }
        const value = wm.attach(el, { parent, modal: !!opts.modal, role: opts.role });
        return value ? { ok: true, value } : { ok: false, reason: "挂载失败（母子成环或未托管）" };
    },
    /** NW-1：解除母子关系，退回普通窗。 */
    async detach(target) {
        const caller = resolveCaller();
        const wm = await import("./window-manager.js");
        const { el, reason } = ownWindow(wm, caller, target);
        if (!el) return { ok: false, reason };
        wm.detach(el);
        return { ok: true, value: wm.stateOf(el) };
    },
    /** NW-1：母窗（仅自己插件的窗口树，免权限）。 */
    async parent(target) {
        const caller = resolveCaller();
        const wm = await import("./window-manager.js");
        const { el, reason } = ownWindow(wm, caller, target);
        if (!el) return { ok: false, reason };
        return { ok: true, value: wm.parentOf(el) };
    },
    /** NW-1：全部直接子窗（仅自己插件的窗口树，免权限）。 */
    async children(target) {
        const caller = resolveCaller();
        const wm = await import("./window-manager.js");
        const { el, reason } = ownWindow(wm, caller, target);
        if (!el) return { ok: false, reason };
        return { ok: true, value: wm.childrenOf(el) };
    },
    /** NW-4：把自己的窗提到 floating / panel 层（normal 可降回）。需 window:level。 */
    setLevel: guard("window:level", async (ctx, target, level) => {
        const wm = await import("./window-manager.js");
        const { el, reason } = ownWindow(wm, ctx.caller, target);
        if (!el) throw new Error(reason || "找不到该窗口");
        if (!wm.setLevel(el, level)) throw new Error(`不支持的层级：${level}（可选 normal / floating / panel）`);
        return wm.stateOf(el);
    }),
    /** NW-5：红绿灯动作自定义回调；回调返回 false 即拦截默认动作。自己的窗免权限。 */
    async onAction(target, handlers = {}) {
        const caller = resolveCaller();
        const wm = await import("./window-manager.js");
        const { el, reason } = ownWindow(wm, caller, target);
        if (!el) return { ok: false, reason };
        return wm.setWindowActions(el, handlers) ? { ok: true } : { ok: false, reason: "窗口未托管" };
    },
    /**
     * NW-9：可取消的关闭。handler 返回 false（或调 event.preventDefault()）即中止关闭；
     * handler 抛错视为放行。典型用法「未保存更改」确认框。自己的窗免权限。
     */
    async onClose(target, handler) {
        const caller = resolveCaller();
        const wm = await import("./window-manager.js");
        const { el, reason } = ownWindow(wm, caller, target);
        if (!el) return { ok: false, reason };
        return wm.setWindowOnClose(el, handler) ? { ok: true } : { ok: false, reason: "窗口未托管" };
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

/* ── 四·五、生命周期 ── */

/** 卸载前钩子与存活窗口查询（API-20）。 */
const lifecycle = Object.freeze({
    /**
     * 注册「卸载前」同步回调：插件被卸载 / 覆盖安装前，内核先同步调用这些钩子，
     * 再广播 plugin-unload，给一次同步落盘的机会。
     * 只适合同步收尾；耗时的异步工作在 plugin-unload 里做（那时窗口还没拆）。
     * @param {Function} fn 无参回调
     * @returns {Function} 退订函数（重复注册同一函数会去重）
     */
    onBeforeUnload(fn) {
        const caller = resolveCaller();
        if (!caller) {
            window.__log?.warn("kernel/os-api", "lifecycle.onBeforeUnload 被拒绝：无法确认调用者");
            return () => { };
        }
        return registerBeforeUnload(caller, fn);
    },
    /**
     * 当前调用者的生命周期状态。
     * @returns {{pluginId:string, hasWindow:boolean}|null} 认不出调用者时 null
     */
    state() {
        const caller = resolveCaller();
        if (!caller) return null;
        return {
            pluginId: caller,
            hasWindow: Boolean(document.querySelector(`.window[data-plugin-id="${cssEscapeId(caller)}"]`)),
        };
    },
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
    /** 权限名全表 + 中文描述 + 是否敏感 + 能力是否已开放；帮助文档与弹窗同源。 */
    permissions() {
        return PERMISSION_NAMES.map((name) => ({
            name,
            ...describe(name),
            sensitive: SENSITIVE.has(name) || name.startsWith("system-patch:"),
            // 占位权限声明了也调不出东西（pending 信封）：安装面板与插件自诊都该看见这一格（API-03）
            implemented: !UNIMPLEMENTED_PERMISSIONS.has(name),
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

const root = Object.freeze({ apps, fs, bus, quicklook, menus, openWith, shortcuts, vfs, ui, widgets, windows, icons, system, lifecycle, meta });

Object.defineProperty(window, "Deskly", {
    value: root,
    writable: false,
    configurable: false,
    enumerable: true,
});

// 全局只挂**只读**诊断面（与 __grants 同一条边界）：openApp 一旦全局可达，任何插件都能
// 绕过 apps:launch 守卫直接启动应用（BUG-19）。写入口只保留模块导出，由内核调用点显式 import。
globalThis.__desklyApi = Object.freeze({ root });

export { root as Deskly, guard, apps, fs, bus, meta };
