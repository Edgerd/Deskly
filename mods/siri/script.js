/**
 * script.js — Siri Orb 开关状态机
 *
 * 通过 window.__siri 暴露 open / close / toggle / isOpen 接口。
 * 复用 launchpad 的页面级单例模式，避免重复创建 DOM。
 */

(function () {
  "use strict";

  // 注入插件样式：Siri 不创建窗口，plugin-manager 不会自动注入 style.css，
  // 必须自己加载，否则 orb 完全无样式（不可见）。
  (function ensureStyle() {
    if (document.getElementById("siri-style")) return;
    const link = document.createElement("link");
    link.id = "siri-style";
    link.rel = "stylesheet";
    // 用 import.meta.url 解析，确保无论从何处 import 都能定位到同目录 style.css
    link.href = new URL("./style.css", import.meta.url).href;
    document.head.appendChild(link);
  })();

  const STATE = window.__siriState || (window.__siriState = {
    isOpen: false,
    isClosing: false,
    orbEl: null,
  });

  /**
   * 确保 orb DOM 存在且唯一（幂等）。
   * @returns {HTMLElement} .siri-orb 元素
   */
  function ensureOrb() {
    if (STATE.orbEl && STATE.orbEl.isConnected) return STATE.orbEl;

    let orb = document.getElementById("siri-orb");
    if (!orb) {
      // 插件注入时 index.html 内容已被 plugin-manager 加载到隐藏容器，
      // 这里把 orb 移到 body 下成为真正的悬浮层。
      const src = document.querySelector(".siri-orb");
      if (src) {
        orb = src;
        document.body.appendChild(orb);
      } else {
        orb = document.createElement("div");
        orb.className = "siri-orb";
        orb.id = "siri-orb";
        orb.innerHTML = '<div class="siri-orb-inner"></div>';
        document.body.appendChild(orb);
      }
    }

    // 点击球体自身不关闭（留给后续交互逻辑）
    orb.addEventListener("click", (e) => {
      e.stopPropagation();
      // 当前：点击球体也关闭；后续可改为呼出对话面板
      closeSiri();
    });

    STATE.orbEl = orb;
    return orb;
  }

  /** 打开 Siri Orb */
  function openSiri() {
    if (STATE.isOpen) return;
    if (STATE.isClosing) return; // 关闭动画中忽略

    const orb = ensureOrb();
    orb.classList.remove("closing");
    // 强制 reflow 以重启 CSS transition
    void orb.offsetWidth;
    orb.classList.add("visible");
    STATE.isOpen = true;

    // 全局点击关闭（点击 orb 外任意位置）
    requestAnimationFrame(() => {
      document.addEventListener("click", _onGlobalClick, true);
      document.addEventListener("keydown", _onEscKey, true);
    });
  }

  /** 关闭 Siri Orb */
  function closeSiri() {
    if (!STATE.isOpen) return;
    if (STATE.isClosing) return;

    const orb = STATE.orbEl;
    if (!orb) return;

    STATE.isClosing = true;
    orb.classList.add("closing");

    document.removeEventListener("click", _onGlobalClick, true);
    document.removeEventListener("keydown", _onEscKey, true);

    setTimeout(() => {
      orb.classList.remove("visible", "closing");
      STATE.isOpen = false;
      STATE.isClosing = false;
    }, 280); // 略长于 CSS transition 0.25s
  }

  /** 切换开关 */
  function toggleSiri() {
    if (STATE.isOpen) {
      closeSiri();
    } else {
      openSiri();
    }
  }

  /** 全局点击处理器：点击 orb 外部时关闭 */
  function _onGlobalClick(e) {
    if (!STATE.orbEl) return;
    if (STATE.orbEl.contains(e.target)) return;
    closeSiri();
  }

  /** ESC 键关闭 */
  function _onEscKey(e) {
    if (e.key === "Escape") closeSiri();
  }

  // ---- 对外暴露统一接口（与 launchpad 的 __launchpad 风格一致） ----
  window.__siri = {
    open: openSiri,
    close: closeSiri,
    toggle: toggleSiri,
    get isOpen() { return STATE.isOpen; },
  };

  console.log("[siri] 模块已加载，接口: window.__siri.toggle()");
})();
