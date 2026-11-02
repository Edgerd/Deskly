/**
 * bootstrap.js — 入口引导模块
 *
 * 取代 index.html 中的内联 <script> 与内联 onclick 处理器，
 * 以满足 MV3 扩展 CSP（script-src 'self'，禁止远程脚本与内联脚本）要求。
 *
 * 职责：
 * 1. 设置全局钩子 window.moduleItems（菜单/窗口/桌面文件创建入口）。
 * 2. 为 index.html 的静态菜单项绑定 JS 事件（内联处理器会被 CSP 拦截）。
 * 3. 按顺序点亮内核：日志 -> 设置中枢 -> 设置定义表 -> 外观 -> 表面令牌 -> 光标 ->
 *    权限账本 + API 命名空间 -> 插件 -> 壁纸/多语言 -> 可选内核模块
 *    （声音 / 显示器 / 锁屏 / 浏览器权限 / 聚焦 / 调试 / 滚动条）。
 *
 * import 顺序是硬性约定：ES module 的求值顺序 = 说明符出现顺序，
 * log.js / settings.js / settings-definitions.js 必须排在最前，
 * 否则后面的 dock、controlcenter、各插件在求值期读不到 window.__log / __settings。
 *
 * 注意：本文件内所有 import 说明符都不得带 ?v= 查询串。带查询串与不带查询串
 * 会被浏览器视为两个不同模块，导致核心模块被求值两次（两份 dock/window/finderbar
 * 实例互相覆盖全局钩子），这是 0.2.7x 一系列「功能静默失效」的根因。
 * 缓存刷新只对非模块资源（CSS/HTML）使用版本参数。
 */

// —— 顺序敏感的前三个 import：日志、设置中枢、设置定义表 ——
// 只取副作用：log.js / settings.js 求值时把 window.__log / window.__settings 挂好，
// 后面任何模块（含插件）在求值期就能读它们，不必各自 import。
import "./log.js";
import "./settings.js";
import { initSettingsSchema } from "./settings-definitions.js";
// 全局图片拖拽守卫：捕获阶段兜底，应用与系统各处动态插入的 <img> 都覆盖。
import "./image-drag-guard.js";

import { clickMenuItem } from "./ui/menu.js";
// 红绿灯组件注册（window.js / plugin-manager.js 也各自导入，此处显式声明：
// 首屏解析 index.html 里可能出现的静态标记前，元素定义必须已就绪。不带 ?v=。）
import "./ui/trafficLights.js";
import { parentMenuStates, updateMenu } from "./finderbar.js";
import { create, resetWindowListeners } from "./window.js";
import { createDesktopFile } from "./ui/contextMenu.js";
import { init as initPlugins, prefetchManifests, whenReady as pluginsReady } from "./plugin-manager.js";
import { getPlugins } from "./app-registry.js";
import { i18n } from "./i18n.js";
import { wallpaper } from "./wallpaper.js";
import { initAppearance } from "./appearance.js";
// surface.js 必须在 appearance 之后、首帧之前初始化：它按 data-theme 与壁纸主色推导
// --surface-text（黑或白），晚一步就会有一帧「深色磨砂上是深灰字」的不可读文本。
import { initSurface } from "./surface.js";
import { initCursor } from "./cursor.js";
// 权限账本与 API 命名空间必须在插件注册之前就绪：registerPlugin 会广播
// plugin-registered，api-grants 挂在这个广播上做安装时授权，监听器晚挂一步
// 内置插件就会漏记权限。os-api 只挂全局、无异步，紧随其后。
import { initGrants } from "./api-grants.js";
import "./os-api.js";
import { initDefaultApps } from "./default-apps.js";
import { initOfficeBrand } from "./office-brand.js";
import { initKeyboard } from "./keyboard.js";
// 菜单栏状态项（P0-5）：模块求值期就把电池 / 音量 / 蓝牙挂到 .finderbar .right，
// 依赖上方 finderbar.js 已静态求值（.right 与 .time 已建好）。
import "./menubar-status.js";
import { VERSION } from "./version.js";

/**
 * 可选内核模块：由各自的文件定义自己的设置项与初始化函数。
 * 用动态 import 而不是静态 import：这几项能力彼此独立，任何一份没到位
 * （未创建 / 语法错误 / 资源被拦截）都不能把整个桌面带崩，静态 import 会。
 */
const OPTIONAL_KERNEL_MODULES = [
    { specifier: "./sound.js", label: "声音" },
    { specifier: "./display.js", label: "显示器" },
    { specifier: "./lock.js", label: "锁屏" },
    { specifier: "./permissions.js", label: "权限" },
    { specifier: "./spotlight.js", label: "聚焦搜索" },
    { specifier: "./pointer-shake.js", label: "晃动查找指针" },
    { specifier: "./debug.js", label: "调试" },
    { specifier: "./scrollWatch.js", label: "滚动条活动监听" },
];

/** sessionStorage 里「本会话已做过版本自检」的标记键。 */
const VERSION_CHECKED_KEY = "webstartos_version_checked";

/** 引导期告警出口：优先写运行日志（可按来源检索），日志未就绪时退回 console。 */
function warn(message, data) {
    if (window.__log && typeof window.__log.warn === "function") window.__log.warn("bootstrap", message, data);
    else console.warn(`[bootstrap] ${message}`, data);
}

/** 模块初始化函数的候选名：`init` / `initSound` / `initPermissions` 这类驼峰式。 */
function starterNamesOf(specifier) {
    const base = specifier.replace(/^\.\//, "").replace(/\.js$/, "");
    const camel = base.replace(/[-_](\w)/g, (_, ch) => ch.toUpperCase());
    return ["init", `init${camel.charAt(0).toUpperCase()}${camel.slice(1)}`];
}

/**
 * 点亮一个可选内核模块：加载后按约定名找初始化函数（init / initXxx）调用，
 * 找不到就当作「该模块无需初始化」，不去猜别的导出。
 * @param {{specifier:string, label:string}} entry 模块条目
 * @returns {Promise<boolean>} 是否调用到了初始化函数
 */
async function initOptionalModule(entry) {
    try {
        const mod = await import(entry.specifier);
        const name = starterNamesOf(entry.specifier).find((key) => typeof mod[key] === "function");
        if (!name) return false;
        await mod[name]();
        return true;
    } catch (err) {
        warn(`${entry.label}模块未启用：`, err);
        return false;
    }
}

// 1. 暴露全局钩子（原内联脚本逻辑）
window.moduleItems = {
    clickMenuItem,
    parentMenuStates,
    create,
    resetWindowListeners,
    updateMenu,
    createDesktopFile,
};

// 2. 绑定 index.html 静态菜单项：凡带 cmd 的段落都走统一分发。
//    旧实现只绑 `.menu p[cmd]`，而绝大多数静态菜单项没有 cmd 属性，
//    内联 onclick 又被 CSP 拦截，于是这些项目点了没有任何反应。
document.querySelectorAll(".menu p").forEach((p) => {
    if (!p.hasAttribute("cmd")) return; // 由其它模块自绑的项（如「最近使用的项目」）不重复绑定
    p.addEventListener("click", () => clickMenuItem(p));
});

// 2.5 可访问性：为缺失 alt 的 <img> 补默认 alt=""（装饰性/图标图片语义正确）。
// 初始全量扫描一次 + MutationObserver 只处理新增节点，避免每次变更全页重扫。
function ensureImgAlt(root) {
    const nodes = root.nodeType === 1 ? [root] : Array.from(root.querySelectorAll("*"));
    nodes.forEach((node) => {
        if (node.nodeType !== 1 || node.tagName !== "IMG") return;
        if (!node.hasAttribute("alt")) node.setAttribute("alt", "");
    });
}
// 新增节点先入队、空闲时一次性处理：启动期插件与界面模块会成批插 DOM，
// 每次突变回调里同步遍历子树会把主线程切成碎片（回调本身也可能被同一批插入触发多次）。
// 合批只改变「何时遍历」，语义不变：仍然只给缺 alt 的 img 补 alt=""。
let imgAltQueue = [];
let imgAltScheduled = false;
function flushImgAltQueue() {
    imgAltScheduled = false;
    const queue = imgAltQueue;
    imgAltQueue = [];
    queue.forEach((node) => ensureImgAlt(node));
}
function scheduleImgAltFlush() {
    if (imgAltScheduled) return;
    imgAltScheduled = true;
    if (typeof requestIdleCallback === "function") {
        // 与可选模块同一套兜底：空闲回调被超时强制触发，不会因为页面一直忙而漏处理。
        requestIdleCallback(flushImgAltQueue, { timeout: 2000 });
    } else {
        // 无空闲 API 时退到微任务：仍在当前任务末尾处理，比同步遍历省，又不拖延到下一帧。
        Promise.resolve().then(flushImgAltQueue);
    }
}
const imgAltObserver = new MutationObserver((mutations) => {
    let added = false;
    mutations.forEach((m) => m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        imgAltQueue.push(node);
        added = true;
    }));
    if (added) scheduleImgAltFlush();
});
imgAltObserver.observe(document.body, { childList: true, subtree: true });
ensureImgAlt(document.body);

// 3. Service Worker：让已安装（ZIP）插件的资源请求从 IndexedDB 返回。
//    「chrome-extension:// 下注册 SW 会被 Chromium 拒绝」是早前的猜测，实测不成立
//    （扩展页里 register 成功并接管页面）；真正的风险是**注册成功但当前页面没被接管**
//    （首次安装那一次），所以商店会显式探测接管状态，ZIP 安装失败时给回原因。
//    这里既不阻塞后续初始化，也不等待 ready（ready 在 SW 未 activate 时永不 resolve）。
function ensureServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("./sw.js").catch((err) => {
        warn("Service Worker 注册失败，已安装插件将无法持久化加载：", err);
    });
}

(async () => {
    ensureServiceWorker();
    // 先注册定义表再初始化外观：定义表把「默认值 / 候选值 / 钳制区间」装进中枢，
    // 之后任何模块读设置走的都是这套校验；它顺手把 reduceMotion / transparency 两个
    // 「只有 CSS 消费者」的开关落到 <html>，早于首帧渲染才不会闪一下没套样式的界面。
    const defined = initSettingsSchema();
    initAppearance();
    // 模糊等级与可读文字色令牌要在任何表面绘制前就位：晚一步就是深色磨砂配深灰字。
    initSurface();
    // 壁纸必须紧跟外观/表面初始化：它是首屏第一层视觉，不能排在「等待插件注册表
    // + 读取已安装插件」之后。首帧本身由 head 里的 wallpaper-boot.js 用 CSS 变量兜住，
    // 这里负责把当前配置落到壁纸元素、算好着色令牌并释放引导覆盖。
    wallpaper.init();
    // initCursor 是异步的（读取并内联光标资源）；不等待它，避免光标问题阻塞整个桌面。
    initCursor().catch?.((err) => warn("光标初始化失败：", err));
    // 插件清单 fetch 与授权账本的 IndexedDB 读取并行：initPlugins() 之后会复用
    // 这批已下载的清单，注册表就绪时间不再叠加在网络往返后面。
    prefetchManifests();
    // 权限账本读回 + 默认应用钩子接线都必须在插件注册之前完成：
    // 插件清单一经 registerPlugin 就广播 plugin-registered，api-grants 靠它记授权。
    // 但「监听器已同步挂好」不等于「必须等账本读完」：initGrants() 内部先挂监听再读
    // IndexedDB，所以这里不再 await —— 全量读取不再充当启动硬屏障。读取失败只在
    // 内存里表现成空账本，本次会话敏感能力会重新询问，不必拖住插件注册。
    initGrants().catch((err) => warn("授权账本初始化失败，本次会话按空账本继续：", err));
    initDefaultApps();
    // 办公套件品牌包：探测 MS 图标是否已补齐，并订阅切换（Dock 图标/名称随之刷新）
    initOfficeBrand();
    // 全局快捷键分发：键位表的唯一真源，必须在任何应用开始监听之前就位
    initKeyboard();
    initPlugins();
    // 多语言与插件注册互不依赖，并行起来：语言包是一次网络往返，串行执行等于把它
    // 叠在插件清单加载之后。init 是 async 的，但公开 API 没承诺一定返回 Promise，
    // 包一层 Promise.resolve 兜住同步实现（同步实现被包进 Promise 后仍然会执行）。
    const i18nPromise = Promise.resolve(i18n.init(i18n.getLanguage()));
    await Promise.all([pluginsReady(), i18nPromise]);
    // 可选内核模块不占启动关键路径：此时桌面已可绘制与交互，把它们挪到空闲帧再并行点亮。
    whenIdle(() => startOptionalModules(defined));
})();

/**
 * 在浏览器空闲时执行：requestIdleCallback 带 2s 超时，保证再忙也会轮到；
 * 不支持该 API 的环境（旧版 Chromium / 非扩展页面）退回 setTimeout。
 * 超时值取 2000ms 是「桌面可交互后最多等两秒」的体感上限，不算启动关键路径。
 * @param {Function} callback 待执行函数
 */
function whenIdle(callback) {
    if (typeof requestIdleCallback === "function") {
        requestIdleCallback(callback, { timeout: 2000 });
    } else {
        setTimeout(callback, 300);
    }
}

/**
 * 空闲期点亮可选内核模块，并在全部结束后输出就绪汇总。
 * 各模块的初始化函数由 initOptionalModule 各自吞异常，Promise.all 不会因单个失败中断；
 * 汇总日志放在这里而不是启动链里：它的意义是「全部可选模块有结论了」，提前打印就是假消息。
 * @param {number} defined 设置定义项数
 */
function startOptionalModules(defined) {
    // 版本一致性自检与可选模块同属空闲期杂务，一起调度，不抢桌面首帧。
    runVersionCheck();
    Promise.all(OPTIONAL_KERNEL_MODULES.map(initOptionalModule)).then((optional) => {
        window.__log?.info("bootstrap",
            `桌面就绪：设置定义 ${defined} 项、插件 ${getPlugins().length} 个、可选模块 ${optional.filter(Boolean).length}/${OPTIONAL_KERNEL_MODULES.length} 个已初始化`);
    });
}

/**
 * 版本一致性自检：manifest.json / version.js / index.html 的版本号在发布时必须一致，
 * 历史上多次出现「version.py 已改但 index.html 缓存参数没改」的漂移。
 * 每个标签页都会打开这个页面，用 sessionStorage 记「本会话已校验」避免每个新标签页
 * 都发一次请求；存储不可用（隐私模式 / 被策略禁用）时按未校验处理，多一次请求而已。
 */
function runVersionCheck() {
    try {
        if (sessionStorage.getItem(VERSION_CHECKED_KEY) === "1") return;
    } catch (err) { /* 会话存储读不到：继续校验，不因存储异常跳过自检 */ }
    fetch("./manifest.json")
        .then((res) => (res.ok ? res.json() : null))
        .then((manifest) => {
            if (manifest && manifest.version !== VERSION) {
                warn(`版本漂移：manifest.json=${manifest.version} version.js=${VERSION}`);
            }
            try {
                sessionStorage.setItem(VERSION_CHECKED_KEY, "1");
            } catch (err) { /* 写不进就算了：下次最多重复一次自检 */ }
        })
        .catch(() => { /* 非扩展环境下取不到 manifest，不影响启动 */ });
}
