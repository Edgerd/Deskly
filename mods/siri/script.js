/**
 * script.js — Siri Orb 生命周期（Canvas 2D）：右上角悬浮面板、设置联动、开关与关闭交互。
 *
 * 球体本身全部交给 orb-renderer.js：这里只负责面板 DOM、尺寸、可见性与资源释放，
 * 不再在脚本里堆场景/着色器/后期处理，渲染参数全部集中在 orb-renderer.js。
 * 打开即可绘制（无异步加载），关闭只停帧，plugin-unload 时才 dispose 画布并移除面板。
 * 设置走设置中枢：siri.orb.size（内核定义）、siri.wakeSound / siri.orbGlow（本插件注册）。
 */

import { OrbRenderer } from "./orb-renderer.js";

(function () {
  "use strict";

  // 单实例守卫：本脚本既被顶栏（finderbar 直接 import）加载，也会被 plugin-manager
  // 每次打开注入一份新实例（?v= 不同 → 不同模块）。重复绑定全局监听会永久累积，
  // 故已有实例时直接复用其接口，本实例立即退出。
  if (window.__siri) return;

  // 注入插件样式。Siri 不创建窗口，plugin-manager 的 load() 同样会注入 plugin-style-siri，
  // 因此仅在被顶栏直接 import（无 loader 参与）时才自注入，避免同一份 CSS 进两次 CSSOM。
  function ensureStyle() {
    if (document.getElementById("siri-style") || document.getElementById("plugin-style-siri")) return;
    const link = document.createElement("link");
    link.id = "siri-style";
    link.rel = "stylesheet";
    link.href = new URL("./style.css", import.meta.url).href;
    document.head.appendChild(link);
  }
  ensureStyle();

  // 悬浮面板边长（正方形，Orb 居中渲染）；可由系统设置「Siri」页调整
  const DEFAULT_ORB_SIZE = 120;
  const ORB_SIZE_MIN = 64;
  const ORB_SIZE_MAX = 240;

  /** 插件自有设置的当前值（由 registerPluginSettings 与设置中枢对齐）。 */
  const FLAGS = { wakeSound: true, orbGlow: true };

  /**
   * 注册本插件自带的两个设置项（siri.wakeSound / siri.orbGlow）。
   * owner 标为 "siri"、pane 标为 "plugins"：系统设置的「插件」面板据此自动渲染开关，
   * 插件不必自绘任何设置界面。设置中枢缺席（被单独页面引用）时整体跳过，功能不缺。
   * @returns {boolean} 是否完成注册
   */
  function registerPluginSettings() {
    const api = globalThis.__settings;
    if (!api || typeof api.defineMany !== "function") return false;
    api.defineMany([
      {
        key: "siri.wakeSound", type: "boolean", default: true,
        owner: "siri", pane: "plugins", group: "Siri", order: 20, control: "switch",
        label: "唤醒提示音", hint: "打开光球时播一声提示音（音量跟随系统主音量）",
        apply: (value) => { FLAGS.wakeSound = Boolean(value); },
      },
      {
        key: "siri.orbGlow", type: "boolean", default: true,
        owner: "siri", pane: "plugins", group: "Siri", order: 30, control: "switch",
        label: "光球辉光", hint: "球体外的近白柔光；关闭后只保留球体与高光",
        apply: (value) => { FLAGS.orbGlow = Boolean(value); applyGlow(); },
      },
    ]);
    FLAGS.wakeSound = Boolean(api.get("siri.wakeSound"));
    FLAGS.orbGlow = api.get("siri.orbGlow") !== false;
    return true;
  }

  /** 读取已保存的 Orb 边长（px），越界或缺失回退默认值。设置中枢优先，退回旧槽名。 */
  function getStoredSize() {
    const api = globalThis.__settings;
    if (api && typeof api.get === "function") {
      const value = Number(api.get("siri.orb.size", DEFAULT_ORB_SIZE));
      if (Number.isFinite(value)) return Math.max(ORB_SIZE_MIN, Math.min(ORB_SIZE_MAX, Math.round(value)));
    }
    let v = DEFAULT_ORB_SIZE;
    try {
      const raw = localStorage.getItem("siri-orb-size");
      if (raw != null) {
        const n = parseInt(raw, 10);
        if (!isNaN(n)) v = n;
      }
    } catch (e) {}
    return Math.max(ORB_SIZE_MIN, Math.min(ORB_SIZE_MAX, v));
  }

  const STATE = window.__siriState || (window.__siriState = {
    isOpen: false,
    isClosing: false,
    panelEl: null,
    renderer: null,
    closeTimer: null,
    bindFrame: null, // 延迟挂载全局监听的 rAF 句柄
    size: getStoredSize(), // 当前 Orb 边长（px），由设置调整
  });

  /**
   * 确保悬浮面板 DOM 存在且唯一（幂等）。
   * 面板可能来自 index.html 注入，也可能由本函数创建；本插件无窗口，
   * plugin-manager 的 unload 按 id 找不到它，所以重复注入留下的多余节点须自行收敛。
   * @returns {HTMLDivElement}
   */
  function ensurePanel() {
    let panel = STATE.panelEl && STATE.panelEl.isConnected ? STATE.panelEl : document.querySelector(".siri-panel");
    document.querySelectorAll(".siri-panel").forEach((el) => { if (el !== panel) el.remove(); });
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "siri-panel";
      panel.id = "siri-panel";
      const canvas = document.createElement("canvas");
      canvas.id = "siri-canvas";
      panel.appendChild(canvas);
      document.body.appendChild(panel);
    }
    if (panel.id !== "siri-panel") panel.id = "siri-panel";
    // 内联尺寸可能来自上一次会话或静态标记，统一按当前 STATE.size 对齐
    panel.style.width = STATE.size + "px";
    panel.style.height = STATE.size + "px";
    STATE.panelEl = panel;
    return panel;
  }

  /**
   * 确保渲染器与面板里的 canvas 对应；缺失时同步创建（Canvas 2D 没有异步加载阶段）。
   * @param {HTMLDivElement} panel
   * @returns {OrbRenderer|null}
   */
  function ensureRenderer(panel) {
    let canvas = panel.querySelector("canvas");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.id = "siri-canvas";
      panel.appendChild(canvas);
    }
    if (STATE.renderer && STATE.renderer.canvas !== canvas) {
      STATE.renderer.dispose();
      STATE.renderer = null;
    }
    if (!STATE.renderer) {
      STATE.renderer = new OrbRenderer(canvas);
      STATE.renderer.configure(STATE.size, FLAGS.orbGlow !== false);
    }
    return STATE.renderer;
  }

  /**
   * 调整 Orb 尺寸（运行时实时生效，持久化走设置中枢的 siri.orb.size）。
   * 同时更新面板内联宽高与画布缓冲，发光分辨率随尺寸一起变化。
   * @param {number} size 目标边长（px），会被钳制到 [ORB_SIZE_MIN, ORB_SIZE_MAX]
   */
  function applySize(size) {
    const v = Math.max(ORB_SIZE_MIN, Math.min(ORB_SIZE_MAX, Math.round(size) || DEFAULT_ORB_SIZE));
    STATE.size = v;
    if (STATE.panelEl) {
      STATE.panelEl.style.width = v + "px";
      STATE.panelEl.style.height = v + "px";
    }
    if (STATE.renderer) STATE.renderer.configure(v, FLAGS.orbGlow !== false);
    const api = globalThis.__settings;
    if (api && typeof api.set === "function") {
      // 单一写入方：校验、落盘、广播都由设置中枢完成（它会补发 siri-orb-size-change，
      // 值未变化时不广播，因此回到本函数的 applySize 不会形成回环）
      api.set("siri.orb.size", v, { source: "siri" });
      return;
    }
    try { localStorage.setItem("siri-orb-size", String(v)); } catch (e) {}
  }

  /**
   * 系统设置「Siri」页拖动尺寸滑块的响应。
   * 仅在面板打开期间挂载（见 openSiri / closeSiri）：设置页同时会直接调用
   * window.__siri.setSize()，关闭态不需要这个监听，避免常驻。
   */
  function _onOrbSizeChange(e) {
    const v = parseInt(e.detail, 10);
    if (!isNaN(v)) applySize(v);
  }

  /**
   * 按 siri.orbGlow 归位辉光：关闭时外圈光晕不烘焙，sheen / specular 不受影响；
   * 球体本身的青蓝紫粉流体层始终保持。
   * @returns {void}
   */
  function applyGlow() {
    if (STATE.renderer) STATE.renderer.setGlow(FLAGS.orbGlow !== false);
  }

  /**
   * 唤醒提示音：声音本体与主音量归 kernel 的 sound.js 管，插件只决定「要不要响」。
   * 动态 import 而不是顶部 import：内核模块的路径不该在求值期就把插件绑上去。
   * @returns {void}
   */
  function playWake() {
    if (FLAGS.wakeSound === false) return;
    import("../../src/javascripts/sound.js")
      .then(({ sound }) => sound.playTone("alert"))
      .catch(() => { /* 声音模块缺席：光球照常打开 */ });
  }

  /** 打开 Siri 面板 */
  function openSiri() {
    if (STATE.isOpen || STATE.isClosing) return;

    // 上一次经 loader 打开时注入的 plugin-style-siri 会在卸载时被摘掉，这里补齐样式
    ensureStyle();
    const panel = ensurePanel();
    const renderer = ensureRenderer(panel);
    if (!renderer) return;
    // 跨显示器拖动后 devicePixelRatio 可能变化：同步一次，尺寸不变就不重建
    renderer.syncPixelRatio();

    panel.classList.remove("closing");
    void panel.offsetWidth; // 强制 reflow 重启 transition
    panel.classList.add("visible");
    STATE.isOpen = true;
    renderer.start();
    playWake();
    window.__log?.info("plugin/siri", `光球已打开：边长 ${STATE.size}px，辉光${FLAGS.orbGlow ? "开" : "关"}，提示音${FLAGS.wakeSound ? "开" : "关"}`);

    window.addEventListener("siri-orb-size-change", _onOrbSizeChange);
    // 延迟一帧再挂「点击外部关闭」，避免本次打开用的那次点击立刻把它自己关掉
    STATE.bindFrame = requestAnimationFrame(() => {
      STATE.bindFrame = null;
      if (!STATE.isOpen) return; // 期间已关闭：不再挂载
      document.addEventListener("click", _onGlobalClick, true);
      document.addEventListener("keydown", _onEscKey, true);
    });
  }

  /** 释放本次会话的全部常驻资源：全局监听、关闭计时器、画布与面板 DOM */
  function releaseSession() {
    if (STATE.closeTimer != null) {
      clearTimeout(STATE.closeTimer);
      STATE.closeTimer = null;
    }
    if (STATE.bindFrame != null) {
      cancelAnimationFrame(STATE.bindFrame);
      STATE.bindFrame = null;
    }
    document.removeEventListener("click", _onGlobalClick, true);
    document.removeEventListener("keydown", _onEscKey, true);
    window.removeEventListener("siri-orb-size-change", _onOrbSizeChange);
    if (STATE.renderer) {
      STATE.renderer.dispose();
      STATE.renderer = null;
    }
    if (STATE.panelEl && STATE.panelEl.isConnected) STATE.panelEl.remove();
    STATE.panelEl = null;
    // 自注入的样式表：plugin-manager 只回收 plugin-style-siri，siri-style 需自行摘除
    const style = document.getElementById("siri-style");
    if (style) style.remove();
    STATE.isOpen = false;
    STATE.isClosing = false;
  }

  /** 关闭 Siri 面板（淡出由 CSS opacity 过渡完成，期间停止渲染） */
  function closeSiri() {
    if (!STATE.isOpen || STATE.isClosing) return;

    const panel = STATE.panelEl;
    if (!panel) return;

    STATE.isClosing = true;
    panel.classList.add("closing");
    if (STATE.renderer) STATE.renderer.stop();

    document.removeEventListener("click", _onGlobalClick, true);
    document.removeEventListener("keydown", _onEscKey, true);
    window.removeEventListener("siri-orb-size-change", _onOrbSizeChange);

    STATE.closeTimer = setTimeout(() => {
      STATE.closeTimer = null;
      panel.classList.remove("visible", "closing");
      STATE.isOpen = false;
      STATE.isClosing = false;
    }, 280);
  }

  /** 切换开关 */
  function toggleSiri() {
    if (STATE.isOpen) closeSiri();
    else openSiri();
  }

  /** 点击面板外部关闭 */
  function _onGlobalClick(e) {
    if (!STATE.panelEl) return;
    if (STATE.panelEl.contains(e.target)) return;
    closeSiri();
  }

  /** ESC 关闭 */
  function _onEscKey(e) {
    if (e.key === "Escape") closeSiri();
  }

  // 插件自有设置：注册即生效（apply 里改 FLAGS / 重画辉光）
  registerPluginSettings();

  // 对外暴露接口（与 launchpad 的 __launchpad 风格一致）
  window.__siri = {
    open: openSiri,
    close: closeSiri,
    toggle: toggleSiri,
    setSize: applySize,
    /** 由设置中枢驱动的开关当前值（只读，改它请走 __settings.set("siri.orbGlow", …)） */
    get orbGlow() { return FLAGS.orbGlow !== false; },
    get wakeSound() { return FLAGS.wakeSound !== false; },
    get size() { return STATE.size; },
    get isOpen() { return STATE.isOpen; },
  };

  // 资源释放：Siri 无窗口，卸载由 plugin-manager.unload("siri") 通知。
  // 该监听常驻不摘除：Siri 由顶栏图标长期持有（window.__siri 始终可用），
  // 摘掉后就再也收不到下一次卸载通知了；卸载后 STATE 已复位，下次打开重建画布与面板。
  const onSiriUnload = (e) => {
    if (e.detail.id !== "siri") return;
    releaseSession();
  };
  window.addEventListener("plugin-unload", onSiriUnload);

  console.log("[siri] 模块已加载（Canvas 2D 版 Orb），接口: window.__siri.toggle()");
})();
