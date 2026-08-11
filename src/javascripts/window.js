import { createAlert } from "./ui/alert.js";
import { updateMenu } from "./finderbar.js";
import { createContextMenu } from "./ui/contextMenu.js";

let fd = document.querySelector(".finderbar");
// 窗口 z-index 基准（2050 起递增），Dock 固定 9500（见 dock.css），
// 因此窗口必须封顶在 9000 以下，保证 Dock 永远置顶不被窗口遮挡。
export let zIndex = 2050;
export const WINDOW_Z_MIN = 2050; // 窗口层级下限
export const WINDOW_Z_MAX = 9000; // 窗口层级上限（严格低于 Dock 的 9500）
window.specialCloses = {};

/**
 * 窗口 z-index 达到上限时调用：将页面中所有已设层级的窗口按当前 z-index
 * 升序重新从 WINDOW_Z_MIN 起分配，回收层级空间，使窗口永远不会逼近 Dock。
 * 重排只改变绝对值，不改变窗口之间的相对层级（低者仍低、高者仍高）。
 */
function reflowWindowZIndexes() {
  const wins = Array.from(document.querySelectorAll(".window"))
    .map((w) => ({ w, z: parseInt(w.style.zIndex, 10) || 0 }))
    .filter((x) => x.z > 0)
    .sort((a, b) => a.z - b.z);
  let z = WINDOW_Z_MIN;
  for (const { w } of wins) {
    w.style.zIndex = ++z;
  }
  zIndex = z;
}

let activeDraggingWindow = null;
let activeResizingWindow = null;

/**
 * 根据当前打开的窗口自动切换顶栏菜单。
 * 规则：
 * 1. 若存在可见窗口，取 z-index 最高（最后打开/置顶）的窗口对应应用菜单；
 * 2. 若无可见窗口，默认切回「访达」菜单。
 * 优先使用各窗口 DOM 上的 id 作为应用名匹配 appMenu。
 */
export function updateActiveAppMenu() {
    const openWins = Array.from(document.querySelectorAll(".window"))
        .filter(w => !w.classList.contains("closing") && w.id);
    if (openWins.length === 0) {
        updateMenu("访达");
        return;
    }
    openWins.sort((a, b) => {
        const za = parseInt(window.getComputedStyle(a).zIndex, 10) || 0;
        const zb = parseInt(window.getComputedStyle(b).zIndex, 10) || 0;
        return zb - za;
    });
    const topWin = openWins[0];
    const appName = topWin.id;
    updateMenu(appName);
}

export function create(file, name, light = null, centered = false) {
  const cleanFile = file.split("/").pop().split(".")[0];
  name = name || cleanFile;
  const existing = document.getElementById(name);
  if (existing) {
    bringToFront(existing, name);
    return;
  }

  // 冷加载：若该应用已注册为插件，则走插件管理器按需加载
  if (window.__getPluginByName) {
    const plugin = window.__getPluginByName(name);
    if (plugin) {
      import("./plugin-manager.js").then(({ load }) => {
        load(plugin.id, { light, centered });
      }).catch((err) => {
        console.error("Error loading plugin:", plugin.id, err);
      });
      return;
    }
  }

  fetch(`${file}?v=${Date.now()}`)
    .then((response) => {
      if (response.status !== 200) {
        createAlert(
          "./assets/icons/Finder.png",
          "加载 App 时遇到错误",
          `此 App 仍在开发中<br/>服务器返回状态码: ${response.status}`,
          "好",
          "close",
        );
        // 加载失败时重置 dock 图标状态，避免残留运行指示器
        if (light) light.classList.remove("on");
        if (window.appStatus && name) window.appStatus[name] = false;
        return;
      }
      response.text().then((content) => {
        document.body.insertAdjacentHTML("beforeend", content);
        const wins = document.querySelectorAll(".window");
        if (wins.length) {
          const newWin = wins[wins.length - 1];
          if (newWin && !newWin.id) newWin.id = name;

          if (centered) {
            centerWindow(newWin);
          }
          bringToFront(newWin, name);

          const resizer = document.createElement("div");
          resizer.className = "resizer";
          newWin.appendChild(resizer);
          addResizeListener(newWin, resizer);
        }
        const script = document.createElement("script");
        script.src = `./src/javascripts/apps/${cleanFile}.js?v=${Date.now()}`;
        script.type = "module";
        script.setAttribute("app", cleanFile);
        document.body.appendChild(script);
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = `./assets/stylesheets/apps/${cleanFile}/index.css?v=${Date.now()}`;
        link.setAttribute("app-css", cleanFile);
        document.querySelector("head").appendChild(link);
      });
    })
    .catch((error) => {
      console.error("Error opening app:", error);
    });
  [150, 300, 450].forEach((t) => setTimeout(() => resetWindowListeners(name, light), t));
}

// 通用设置窗口位置（大小）的函数
export function setWindowPosition(win, left, top, width, height, zIndex) {
  [["left", left], ["top", top], ["width", width], ["height", height], ["zIndex", zIndex]]
    .forEach(([prop, val]) => val !== undefined && (win.style[prop] = val));
}

// 计算可放置窗口的桌面区域（排除顶部状态栏 finderbar 与底部程序坞 dock）
export function getDesktopRect() {
  const top = document.getElementById("finderbar")?.offsetHeight || 0;
  const bottom = document.getElementsByClassName("dockcontainer")[0]?.offsetHeight || 0;
  return { top, width: window.innerWidth, height: window.innerHeight - top - bottom };
}

/**
 * 将窗口居中放置在可用桌面区域内（排除 finderbar 与 dock）。
 * 若窗口尺寸超过可用区域，则贴边显示，避免遮挡 Dock 或超出视口。
 * @param {HTMLElement} win 窗口元素
 * @param {object} opts 可选参数 { animate: boolean }
 */
export function centerWindow(win, opts = {}) {
  const { animate = false } = opts;
  const rect = getDesktopRect();

  const set = () => {
    const w = win.offsetWidth;
    const h = win.offsetHeight;
    let left = (window.innerWidth - w) / 2;
    let top = rect.top + (rect.height - h) / 2;

    // 边界限制：不越过 finderbar 顶部，也不被 Dock 遮挡
    if (top < rect.top) top = rect.top + 4;
    if (top + h > rect.top + rect.height) top = rect.top + rect.height - h - 4;
    if (left < 0) left = 4;
    if (left + w > window.innerWidth) left = window.innerWidth - w - 4;

    if (animate) {
      win.style.transition = "left 0.2s ease, top 0.2s ease";
      setTimeout(() => { win.style.transition = ""; }, 220);
    }
    win.style.left = `${left}px`;
    win.style.top = `${top}px`;
  };

  set();
  // 再等待一帧布局稳定后二次校正，避免插件样式异步加载导致尺寸偏差
  requestAnimationFrame(() => requestAnimationFrame(set));
}

export function resetWindowListeners(name, light = null) {
  const windows = document.querySelectorAll(".window");
  windows.forEach((win) => {
    // 关键修复：以窗口自身 id 为准，避免多窗口场景下互相串名导致顶栏菜单错乱
    const winName = win.id || name;
    // Dock 指示灯仅在传入的 name 与当前窗口匹配时生效
    const winLight = (name && winName === name) ? light : null;

    const closeBtn = win.querySelector(".wintools .red");
    const miniBtn =
      win.querySelector(".wintools .yellow") ||
      win.querySelector(".wintools .gray");
    const zoomBtn =
      win.querySelector(".wintools .green") ||
      win.querySelectorAll(".wintools .gray")[1];

    if (!win.isStretched) win.isStretched = false;

    // 关闭窗口：先播放淡出动画，动画结束后再移除窗口与相关资源
    const closeWindow = () => {
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        win.remove();
        // 释放应用资源：插件走 plugin-manager.unload（移除 CSS/脚本 + 触发插件自检清理），
        // 旧式 create 应用移除脚本与样式，确保未激活的应用不保留任何实例 / 样式 / 脚本。
        const pid = win.dataset.pluginId;
        if (pid) {
          import("./plugin-manager.js").then(({ unload }) => {
            try { unload(pid); } catch (err) { console.warn("[window] 卸载插件失败:", pid, err); }
          });
        } else {
          const s = document.querySelector(`script[app="${winName}"]`);
          if (s) s.remove();
          const link = document.querySelector(`link[app-css="${winName}"]`);
          if (link) link.remove();
        }
        if (winLight) winLight.classList.remove("on");
        if (window.appStatus) window.appStatus[winName] = false;
        // 窗口移除后自动切换顶栏菜单到其他活动窗口或默认访达
        updateActiveAppMenu();
        // 通知程序坞：窗口已关闭，移除运行区残留项并复位状态
        if (window.__dock && typeof window.__dock.syncRunningApps === "function") {
          window.__dock.syncRunningApps();
        }
      };
      win.classList.add("closing");
      // 动画结束后移除；区分窗口自身动画，避免子元素动画冒泡误触发
      const onAnimEnd = (e) => {
        if (e.target === win) {
          win.removeEventListener("animationend", onAnimEnd);
          finish();
        }
      };
      win.addEventListener("animationend", onAnimEnd);
      // 兜底：若系统禁用动画等导致动画未触发，定时强制关闭
      setTimeout(finish, 300);
    };

    // 切换拉伸窗口至桌面空白（保留顶部状态栏和底部dock的全屏）
    const toggleStretchWindow = (withTransition = true) => {
      if (withTransition) {
        win.style.transition =
          "left 0.3s ease, top 0.3s ease, width 0.3s ease, height 0.3s ease";
      }
      if (!win.isStretched) {
        const finderbar = document.getElementById("finderbar");
        const dock = document.getElementsByClassName("dockcontainer")[0];
        const finderbarHeight = finderbar ? finderbar.offsetHeight : 0;
        const dockHeight = dock ? dock.offsetHeight : 0;
        win._preStretchState = {
          left: win.style.left,
          top: win.style.top,
          width: win.style.width,
          height: win.style.height,
        };
        setWindowPosition(
          win,
          "0",
          finderbarHeight + "px",
          "100vw",
          `calc(100vh - ${finderbarHeight}px - ${dockHeight}px)`,
        );
        win.isStretched = true;
      } else {
        if (win._preStretchState) {
          setWindowPosition(
            win,
            win._preStretchState.left,
            win._preStretchState.top,
            win._preStretchState.width,
            win._preStretchState.height,
          );
        }
        win.isStretched = false;
      }
      if (withTransition) {
        setTimeout(() => {
          win.style.transition = "";
        }, 300);
      }
    };
    // 切换全屏窗口至桌面
    const toggleFullscreenWindow = (withTransition = true) => {
      if (withTransition) {
        win.style.transition =
          "left 0.3s ease, top 0.3s ease, width 0.3s ease, height 0.3s ease";
      }
      if (!win.isFullscreen) {
        win._preFullscreenState = {
          left: win.style.left,
          top: win.style.top,
          width: win.style.width,
          height: win.style.height,
          zIndex: win.style.zIndex,
        };
        setWindowPosition(win, "0", "0", "100vw", `100vh`, 5000);
        win.isFullscreen = true;
      } else {
        if (win._preFullscreenState) {
          setWindowPosition(
            win,
            win._preFullscreenState.left,
            win._preFullscreenState.top,
            win._preFullscreenState.width,
            win._preFullscreenState.height,
            win._preFullscreenState.zIndex,
          );
        }
        win.isFullscreen = false;
      }
      if (withTransition) {
        setTimeout(() => {
          win.style.transition = "";
        }, 300);
      }
    };

    win._closeWindow = closeWindow;
    win._toggleStretchWindow = toggleStretchWindow;
    win._toggleFullscreenWindow = toggleFullscreenWindow;

    // 最小化窗口：走程序坞缩放淡出（dock.js fallBackFadeOut）吸入对应图标
    const toggleMinimizeWindow = (withTransition = true) => {
      const dock = window.__dock;
      if (!win._minimized) {
        win._preMinimizeState = {
          transform: win.style.transform,
          opacity: win.style.opacity,
        };
        win._minimized = true;
        if (dock && dock.minimizeToDock) {
          // 窗口被吸入程序坞图标
          dock.minimizeToDock(win, winName);
        } else {
          // 纯 opacity 淡出兜底（保留既有 .minimized 样式）；注意下文 transition 仅含 opacity，
          // 不叠加 transform，避免触发 Chrome 3D 合成层破坏 .window 内亚克力效果。
          if (withTransition) {
            win.style.transition =
              "opacity 0.3s ease, left 0.3s ease, top 0.3s ease, width 0.3s ease, height 0.3s ease";
          }
          win.classList.add("minimized");
          if (withTransition) {
            setTimeout(() => {
              win.style.transition = "";
            }, 300);
          }
        }
      } else {
        win._minimized = false;
        if (dock && dock.restoreFromDock) {
          // 从程序坞图标吐出还原
          dock.restoreFromDock(win, winName);
        } else {
          win.classList.remove("minimized");
          bringToFront(win, winName);
        }
      }
    };

    // 平铺窗口到指定区域（左/右/上/下、四角、居中）
    const tileWindow = (region) => {
      const r = getDesktopRect();
      win.isFullscreen = false;
      win.isStretched = false;
      win.style.transition =
        "left 0.3s ease, top 0.3s ease, width 0.3s ease, height 0.3s ease";
      if (!win._preTileState) {
        win._preTileState = {
          left: win.style.left,
          top: win.style.top,
          width: win.style.width,
          height: win.style.height,
          zIndex: win.style.zIndex,
        };
      }
      const halfW = Math.round(r.width / 2);
      const halfH = Math.round(r.height / 2);
      let left = 0;
      let top = r.top;
      let width = r.width;
      let height = r.height;
      const TILES = {
        left:        [0, r.top, halfW, r.height],
        right:       [halfW, r.top, halfW, r.height],
        top:         [0, r.top, r.width, halfH],
        bottom:      [0, r.top + halfH, r.width, halfH],
        leftTop:     [0, r.top, halfW, halfH],
        rightTop:    [halfW, r.top, halfW, halfH],
        leftBottom:  [0, r.top + halfH, halfW, halfH],
        rightBottom: [halfW, r.top + halfH, halfW, halfH],
        center:      [Math.round(r.width * 0.2), Math.round(r.top + r.height * 0.15), Math.round(r.width * 0.6), Math.round(r.height * 0.7)],
      };
      const t = TILES[region];
      if (!t) return;
      [left, top, width, height] = t;
      setWindowPosition(win, left + "px", top + "px", width + "px", height + "px");
      bringToFront(win, winName);
      setTimeout(() => {
        win.style.transition = "";
      }, 300);
    };

    // 绿色按钮右键菜单：排列窗口
    const showArrangeMenu = (x, y) => {
      const items = [
        { type: "header", label: "排列窗口" },
        { label: "缩放", action: () => win._toggleStretchWindow && win._toggleStretchWindow() },
        { label: "进入全屏", action: () => win._toggleFullscreenWindow && win._toggleFullscreenWindow() },
        { label: "平铺窗口左侧½", action: () => tileWindow("left") },
        { label: "平铺窗口右侧½", action: () => tileWindow("right") },
        { label: "平铺窗口顶部½", action: () => tileWindow("top") },
        { label: "平铺窗口底部½", action: () => tileWindow("bottom") },
        { type: "separator" },
        { label: "左上角", action: () => tileWindow("leftTop") },
        { label: "右上角", action: () => tileWindow("rightTop") },
        { label: "左下角", action: () => tileWindow("leftBottom") },
        { label: "右下角", action: () => tileWindow("rightBottom") },
        { type: "separator" },
        { label: "居中", action: () => tileWindow("center") },
      ];
      createContextMenu(x, y, items);
    };

    win._toggleMinimizeWindow = toggleMinimizeWindow;
    win._tileWindow = tileWindow;
    win._showArrangeMenu = showArrangeMenu;

    addWindowDrag(win, winName);

    // 点击关闭按钮关闭窗口
    if (closeBtn) closeBtn.addEventListener("click", () => closeWindow());
    // 点击最小（黄）按钮最小化窗口；带去重保护避免重复绑定
    if (miniBtn && !win._minBound) {
      miniBtn.addEventListener("click", () => toggleMinimizeWindow());
      win._minBound = true;
    }
    // 点击最大化（绿）按钮：Safari 风格 —— 普通点击缩放窗口填充桌面可用区域，
    // Option+点击进入全屏。带去重保护避免 setTimeout 重试导致重复绑定。
    if (zoomBtn && !win._zoomBound) {
      zoomBtn.addEventListener("click", (e) => {
        if (e.altKey) {
          // Option+点击 → 全屏（覆盖整个视口）
          toggleFullscreenWindow();
        } else {
          // 普通点击 → 缩放（填充 finderbar 与 dock 之间的桌面区域）
          toggleStretchWindow();
        }
      });
      win._zoomBound = true;
    }
    // 绿色按钮右键弹出「排列窗口」菜单；带去重保护避免重复绑定
    if (zoomBtn && !win._arrangeBound) {
      zoomBtn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        showArrangeMenu(e.clientX, e.clientY);
      });
      win._arrangeBound = true;
    }

    // 双击窗口标题栏切换拉伸窗口至桌面空白（保留顶部状态栏和底部dock的全屏）
    const wintools = win.querySelector(".wintools");
    if (wintools) {
      wintools.addEventListener("dblclick", (e) => {
        if (!e.target.closest(".red, .yellow, .green, .gray")) {
          toggleStretchWindow();
        }
      });
    }

    win.addEventListener("mousedown", function (e) {
      if (!e.target.closest(".wintools div")) {
        bringToFront(win, winName);
      }
    });
  });
}

// 拖拽控件排除清单：标题栏按钮、调整大小手柄及交互元素（输入框、按钮、下拉框等）。
// 仅排除"控件"本身，不限制必须从标题栏拖动 —— 允许从窗口内任意非控件区域触发拖拽（macOS 原生行为）。
const DRAG_EXCLUDES = ".wintools div, .resizer, input, textarea, select, button, swift-switch, a, label, .finder-no-drag";

function addWindowDrag(windowElement, name) {
  windowElement.addEventListener("mousedown", function (e) {
    // 命中任一控件即移交默认行为，不启动拖拽
    if (e.target.closest(DRAG_EXCLUDES)) return;

    // 若 mousedown 命中的就是红绿灯容器内的某个按钮（含其内部 ::before/::after 伪元素），
    // 也视为控件，阻止冒泡后再补一道保险，避免某些浏览器对 ::before 的命中差异。
    const trafficLight = e.target.closest(".wintools .red, .wintools .yellow, .wintools .green");
    if (trafficLight) return;

    const rect = windowElement.getBoundingClientRect();
    activeDraggingWindow = {
      element: windowElement,
      name: name,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    };
    bringToFront(windowElement, name);
    e.preventDefault();
  });
}

document.addEventListener("mousemove", function (e) {
  if (activeDraggingWindow) {
    const { element, offsetX, offsetY } = activeDraggingWindow;

    if (element.isStretched && element._toggleStretchWindow) {
      element._toggleStretchWindow(false);
    }
    if (element.isFullscreen && element._toggleFullscreenWindow) {
      element._toggleFullscreenWindow(false);
    }

    const newX = e.clientX - offsetX;
    const newY = e.clientY - offsetY;

    // 顶部不可越过 finderbar，底部至少留 40px 可见区域防止完全消失在 Dock 下方
    const minY = fd ? fd.offsetHeight : 0;
    const dockH = document.getElementsByClassName("dockcontainer")[0]?.offsetHeight || 0;
    const maxY = window.innerHeight - dockH - 40;
    const clampedY = Math.max(minY, Math.min(newY, maxY));

    element.style.left = newX + "px";
    element.style.top = clampedY + "px";
  }

  if (activeResizingWindow) {
    const rect = activeResizingWindow.getBoundingClientRect();
    const newWidth = e.clientX - rect.left;
    const newHeight = e.clientY - rect.top;

    if (newWidth > 200) activeResizingWindow.style.width = newWidth + "px";
    if (newHeight > 150) activeResizingWindow.style.height = newHeight + "px";
  }
});

function addResizeListener(windowElement, resizer) {
  resizer.addEventListener("mousedown", function (e) {
    activeResizingWindow = windowElement;
    e.preventDefault();
  });
}

document.addEventListener("mouseup", function () {
  if (activeDraggingWindow) {
    updateMenu(activeDraggingWindow.name);
    activeDraggingWindow = null;
  }
  activeResizingWindow = null;
});

export function bringToFront(windowElement, name) {
  // 若窗口处于最小化状态，先还原到原位置再置顶
  if (windowElement._minimized) {
    windowElement.classList.remove("minimized");
    windowElement._minimized = false;
  }
  zIndex += 1;
  // 达到窗口层级上限时重排回收，避免窗口 z-index 逼近/超过 Dock 的 9500
  if (zIndex > WINDOW_Z_MAX) {
    reflowWindowZIndexes();
  }
  windowElement.style.zIndex = zIndex;
  updateMenu(name);
}
