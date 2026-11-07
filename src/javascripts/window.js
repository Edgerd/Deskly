/**
 * window.js — 旧式 App 装载入口 + 窗口层兼容门面
 *
 * 窗口机制本身（拖动 / 八向缩放 / 缩放态 / 全屏 / 最小化 / 平铺 / 焦点层级 /
 * 应用侧尺寸声明）已全部搬进 window-manager.js，本文件只做两件事：
 *   1. create()：旧式「assets/apps/<name>.html 模板 + 同名脚本」的装载路径
 *      （Dock 启动历史应用仍走它；插件一律转交 plugin-manager.openApp）。
 *   2. 门面：内核其它模块历史上 import 的都是 window.js 里的这些名字，
 *      保持说明符不变，一律转调 window-manager，不再自带第二套实现。
 *
 * 新增代码请直接 import window-manager.js；这里保留的旧名字只服务既有调用方。
 */

import { createAlert } from "./ui/alert.js";
import { i18n } from "./i18n.js";
import { FINDER_ICON, legacyAppCss, legacyAppScript } from "./paths.js";
// 说明符不得带 ?v=，否则会被当作第二个模块重复求值（见 bootstrap.js 顶部约定）。
import * as wm from "./window-manager.js";

// 红绿灯组件：注册自定义元素（副作用）+ 供下方按动作事件绑定窗口逻辑。
import "./ui/trafficLights.js";

/** 旧式装载的在途应用名：fetch 窗口期内的重复打开请求直接短路（BUG-11）。 */
const legacyOpening = new Set();

// 门面转调：既有调用方的 import 说明符不变，实现只有 window-manager 一份。
// 用 `export { x as y } from` 的形式而不是 const 别名 —— zCounter 这类
// 值绑定要跟着窗口操作实时变化，const 拷贝会在第一次置顶后失真。
export {
  // 可视桌面区（扣掉菜单栏与程序坞）：旧名 getDesktopRect
  visibleFrame as getDesktopRect,
  getVisibleWindows,
  getTopWindow,
  getWindows,
  updateActiveAppMenu,
  setFocusedWindow,
  focusWindow,
  bringToFront,
  bringAllWindowsToFront,
  // 旧名 centerWindow
  center as centerWindow,
  // 旧名 closeWindow
  close as closeWindow,
  isMinimized,
  setMinimized,
  restore,
  toggleMinimize,
  setZoom,
  toggleZoom,
  toggleStretch,
  setFullscreen,
  toggleFullscreen,
  tile,
  untile,
  stateOf,
  configure,
  readDeclaration,
  applyConfig,
  setResizable,
  setGeometry,
  snapshotGeometry,
  isWindowElement,
  manage,
  release,
  WINDOW_Z_MIN,
  WINDOW_Z_MAX,
  // 上一次分配的窗口层级（旧名 zIndex）
  zCounter as zIndex,
} from "./window-manager.js";

/**
 * 转义写入 innerHTML 的动态文本（弹窗正文由 alert.js 用 innerHTML 注入）。
 * @param {*} value 任意值
 * @returns {string} 可安全拼接的文本
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

/** 特殊应用的关闭回调（如启动台有自己的退出动画）：由这些应用自己登记。 */
window.specialCloses = {};

/**
 * 接管页面上所有真窗口（幂等）：绑定拖动 / 缩放 / 红绿灯 / 标题栏双击。
 * 旧名 resetWindowListeners —— 名字留着是因为 dock / bootstrap / plugin-manager
 * 三处都按它调用，且 create() 的多次兜底重试正是靠它的幂等才不重复挂监听。
 * @param {string} [name] 本次装载对应的应用名（只有 id 匹配的窗口拿得到 light）
 * @param {HTMLElement|null} [light] Dock 上对应的运行指示灯
 * @returns {void}
 */
export function resetWindowListeners(name, light = null) {
  document.querySelectorAll("body > .window").forEach((win) => {
    if (!wm.isWindowElement(win)) return;
    const matched = !name || !win.id || win.id === name;
    wm.manage(win, matched ? { name: win.id || name, light: matched && name ? light : null } : {});
  });
}

/**
 * 通用设置窗口位置与尺寸（旧签名，值原样落内联样式，undefined / 空串表示不动）。
 * @param {HTMLElement} win 窗口
 * @param {string|number|undefined} left left
 * @param {string|number|undefined} top top
 * @param {string|number|undefined} width width
 * @param {string|number|undefined} height height
 * @param {string|number|undefined} order zIndex
 */
export function setWindowPosition(win, left, top, width, height, order) {
  wm.setGeometry(win, { x: left, y: top, w: width, h: height, z: order });
}

/**
 * 打开一个应用：已注册为插件的转交 plugin-manager，其余走旧式模板装载。
 * @param {string} file 模板路径
 * @param {string} name 应用显示名（同时作为窗口 id）
 * @param {HTMLElement|null} [light] Dock 指示灯
 * @param {boolean} [centered] 是否居中
 * @returns {Promise<void>}
 */
export async function create(file, name, light = null, centered = false) {
  const cleanFile = file.split("/").pop().split(".")[0];
  name = name || cleanFile;

  let plugin = lookupPlugin(name);
  const existing = findAppWindow(name, plugin ? plugin.id : "");
  if (existing) {
    wm.bringToFront(existing, name);
    return;
  }

  // 冷加载：已注册为插件的统一走 openApp（按名称解析 appId）——多应用插件的子应用名
  // （如「文稿」）交给 load() 会被当成插件 id 而落到该套件的首个应用。
  if (plugin) {
    import("./plugin-manager.js").then(({ openApp }) => {
      openApp(name, { light, centered });
    }).catch((err) => {
      console.error("Error loading plugin:", plugin.id, err);
    });
    return;
  }

  // 注册表是异步初始化的：启动瞬间点开的插件应用会因注册表为空而落到下面的
  // 旧式 App 分支，去 fetch 一个根本不存在的 ./assets/apps/<name>.html，
  // 最终弹出一个「此 App 仍在开发中」的假 404。等它就绪后再判定。
  if (typeof window.__pluginManagerReady === "function") {
    try {
      await window.__pluginManagerReady();
      plugin = lookupPlugin(name);
    } catch (err) {
      console.warn("[window] 等待插件注册表就绪失败:", name, err);
    }
    if (plugin) {
      if (findAppWindow(name, plugin.id)) return;
      import("./plugin-manager.js").then(({ openApp }) => {
        openApp(name, { light, centered });
      }).catch((err) => {
        console.error("Error loading plugin:", plugin.id, err);
      });
      return;
    }
  }

  // 「查重 → fetch → 注入」不是原子的：慢盘下两次快速调用都通过查重，注入两扇同 id
  // 窗口（BUG-11）。per-name 在途标记把第二次调用直接短路到「已存在则置顶」的语义上。
  if (legacyOpening.has(name)) {
    const win = findAppWindow(name, "");
    if (win) wm.bringToFront(win, name);
    return;
  }
  legacyOpening.add(name);
  try {
    const response = await fetch(`${file}?v=${Date.now()}`);
    if (response.status !== 200) {
      // 走到这里说明它既不是插件也没有旧式模板：报真实原因，不要再谎称「仍在开发中」。
      createAlert(
        FINDER_ICON,
        i18n.t("app.loadErrorTitle", "加载 App 时遇到错误"),
        i18n.t("app.loadErrorText", "未找到该应用的界面模板")
          + `<br/>${i18n.t("app.pathLabel", "请求路径")}: ${escapeHtml(file)}`
          + `<br/>${i18n.t("app.httpStatusLabel", "服务器返回状态码")}: ${Number(response.status) || 0}`,
        i18n.t("common.ok", "好"),
        "close",
      );
      // 加载失败时重置 dock 图标状态，避免残留运行指示器
      if (light) light.classList.remove("on");
      if (window.appStatus && name) window.appStatus[name] = false;
      return;
    }
    try {
      const content = await response.text();
        // 注入前记下已有窗口，注入后取「本次新增」的那个（不能按「最后一个 .window」取，
        // 页面里存在非窗口的 .window 元素）。选择器必须是 body > .window，与
        // window-manager.isWindowElement 同一判据：否则顶栏菜单里的 <p class="window">
        // 会混进差集被绑上窗口逻辑并写 id，真窗口反而没人管。
        const before = new Set(document.querySelectorAll("body > .window"));
        document.body.insertAdjacentHTML("beforeend", content);
        const added = Array.from(document.querySelectorAll("body > .window"))
          .filter((w) => !before.has(w));
        const newWin = added.length ? added[added.length - 1] : null;
        if (newWin) {
          // 与插件冷加载同一套：先藏起来，等几何/居中落实后再显示，避免首帧错位。
          wm.prepareOpen(newWin);
          if (!newWin.id) newWin.id = name;
          if (centered) wm.center(newWin);
          wm.bringToFront(newWin, name);
        } else {
          console.warn(`[window] ${file} 未包含 .window 根元素，已注入但无法绑定窗口逻辑`);
        }
        const script = document.createElement("script");
        script.src = `${legacyAppScript(cleanFile)}?v=${Date.now()}`;
        script.type = "module";
        script.setAttribute("app", cleanFile);
        document.body.appendChild(script);
        const link = document.createElement("link");
        link.rel = "stylesheet";
        // 约定：旧式 App 的样式源为 assets/stylesheets/apps/<name>/index.scss，
        // 编译产物同名 index.css 在此按需注入（Safari 浏览器即走此路径）。
        link.href = `${legacyAppCss(cleanFile)}?v=${Date.now()}`;
        link.setAttribute("app-css", cleanFile);
        document.querySelector("head").appendChild(link);
        // 注入完成后再绑窗口逻辑：双 rAF（≈下一帧）先试一次，再以 300ms / 450ms
        // 两次兜底重试；manage() 幂等，多次调用不会重复挂监听。
        // 放在这一支里而不是 create() 末尾：404 分支（assets/apps/ 已清空）不必
        // 白跑三遍全量 body > .window 扫描。
        const bindLater = () => resetWindowListeners(name, light);
        requestAnimationFrame(() => requestAnimationFrame(bindLater));
        setTimeout(bindLater, 300);
        setTimeout(bindLater, 450);
        // 样式表是运行时注入的：<link> 挂上 DOM 不等于样式已进入渲染管线。
        // 旧实现在 append 后立刻 revealOpen，慢盘下会先按无样式块级流画一帧
        // （「打开瞬间没毛玻璃、排版错乱」）。等 sheet 可用（或超时）再显示；
        // 等待期间窗口仍是 .wm-preparing（visibility:hidden），不参与绘制。
        try {
          const { whenStyleReady } = await import("./plugin-manager.js");
          await whenStyleReady(link);
        } catch (err) {
          console.warn("[window] 等待旧式 App 样式表就绪失败，按当前样式显示：", err);
        }
        // 样式已就绪，可以一次性显示并播放入场。
        wm.revealOpen(newWin);
    } catch (injectErr) {
      // text() 读取失败或注入回调抛错都要复位 dock 指示灯与 appStatus：
      // 否则残留「有小圆点没界面」，要等下次窗口对账才自愈（BUG-11）
      if (light) light.classList.remove("on");
      if (window.appStatus && name) window.appStatus[name] = false;
      throw injectErr;
    }
  } catch (error) {
    console.error("Error opening app:", error);
  } finally {
    legacyOpening.delete(name);
  }
}

/**
 * 按显示名解析插件（注册表未就绪 / 未挂钩子时返回 undefined）。
 * @param {string} name 应用显示名
 * @returns {object|undefined} 插件清单
 */
function lookupPlugin(name) {
  if (typeof window.__getPluginByName !== "function") return undefined;
  try {
    return window.__getPluginByName(name);
  } catch (err) {
    console.warn("[window] 插件注册表查询失败:", name, err);
    return undefined;
  }
}

/**
 * 找到 name 对应的、确实属于该应用的窗口。
 * 窗口 id 就是显示名（manifest.windowName || manifest.name），两个应用同名时
 * getElementById 会命中别人的窗口并把人家置顶，表现为「点了没反应」。
 * 因此这里额外校验：必须是 .window，且带插件标记时插件 id 必须一致。
 * @param {string} name 应用显示名
 * @param {string} pluginId 插件 id（旧式 App 传空串）
 * @returns {HTMLElement|null}
 */
function findAppWindow(name, pluginId) {
  const el = document.getElementById(name);
  if (!wm.isWindowElement(el)) return null;
  const pid = el.dataset ? el.dataset.pluginId : "";
  if (pid && pluginId && pid !== pluginId) {
    console.warn(`[window] 显示名冲突：${name} 已属于插件 ${pid}，无法打开插件 ${pluginId}`);
    return null;
  }
  return el;
}
