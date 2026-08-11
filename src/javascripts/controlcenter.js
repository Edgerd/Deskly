/**
 * controlcenter.js — macOS 15 控制中心逻辑模块
 *
 * 完全复刻 macOS 15 控制中心布局与配色：
 * - 连通性组（Wi-Fi / 蓝牙 / AirDrop / 飞行模式，蓝激活）
 * - Focus 大卡（橙激活）
 * - Stage Manager / Screen Mirroring 小卡
 * - Display / Sound 横滑块卡（毛玻璃轨道）
 * - Music 卡（歌曲封面显示区 + 播放控制）
 *
 * 整体背景为毛玻璃半透明，配色仅蓝（网络相关）+ 橙（Focus）两主色。
 * 所有状态经 localStorage 持久化，面板从菜单栏右侧图标弹出。
 */

import { i18n } from "./i18n.js";

// ========== SVG 图标库（内联，避免外链依赖） ==========
const SVG = {
  // 菜单栏控制中心图标（两排开关形状）
  controlcenter: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="3" width="9" height="5" rx="2.5"/><rect x="2" y="16" width="6" height="5" rx="2.5"/><circle cx="7" cy="5.5" r="1.5"/><rect x="13" y="3" width="9" height="5" rx="2.5"/><circle cx="17.5" cy="5.5" r="1.5"/><rect x="16" y="16" width="6" height="5" rx="2.5"/><circle cx="19" cy="18.5" r="1.5"/></svg>`,

  // Wi-Fi
  wifi: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 18a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm0-4a5.5 5.5 0 0 1 4.24 2.01l-1.42 1.42a3.5 3.5 0 0 0-5.64 0l-1.42-1.42A5.5 5.5 0 0 1 12 14zm0-4a9.5 9.5 0 0 1 7.78 3.82l-1.42 1.42a7.5 7.5 0 0 0-12.72 0L4.22 13.82A9.5 9.5 0 0 1 12 10zm0-4C17.18 6 22 7.9 25.46 11l-1.42 1.42C20.92 9.31 16.75 8 12 8S3.08 9.31-.04 12.42L-1.46 11C2 7.9 6.82 6 12 6z" transform="translate(-1.5 -1.5) scale(1.08)"/></svg>`,

  // 蓝牙
  bluetooth: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M14.88 16.29L12 19.17V14.12l2.88 2.17zm-5.77.41l2.89-2.18-2.89-2.17v4.35zM12 2l5.66 5.66L13.41 12l4.24 4.24L12 22l-6.71-6.71L8.59 13 6 10.41 12 2zm1.41 10.59l2.12-2.12L13.41 8.29 11 10.71V4.83L7.83 8 10.41 10.59 7.83 13.17 11 16.34v-3.75z"/></svg>`,

  // 隔空投送（3 道同心圆环，跟随参考图）
  airdrop: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="14" r="2.2"/><path d="M12 6c-3 0-5.6 1.9-7 4.6l1.2.5C7.4 9 9.5 7.5 12 7.5s4.6 1.5 5.8 3.6l1.2-.5C17.6 7.9 15 6 12 6zM12 3.5C16.6 3.5 20.7 6.2 22.6 10.3l-1.2.4C19.8 6.9 16.2 4.8 12 4.8S4.2 6.9 2.6 10.7l-1.2-.4C3.3 6.2 7.4 3.5 12 3.5z"/></svg>`,

  // 飞行模式（飞机）
  airplane: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>`,

  // 专注模式（月亮）
  focus: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a.5.5 0 0 1 .6.6A7 7 0 0 0 19.9 14a.5.5 0 0 1 .6.5z"/></svg>`,

  // 台前调度（层叠窗口）
  stage: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="6" width="16" height="11" rx="2"/><rect x="2" y="3" width="12" height="5" rx="1.5" opacity=".55"/><rect x="2" y="17" width="8" height="3" rx="1.2" opacity=".4"/></svg>`,

  // 屏幕镜像（显示器 + 向上三角）
  mirroring: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="4" width="20" height="14" rx="2"/><rect x="9" y="19" width="6" height="2" rx="1"/><path d="M12 7v5M9.5 9.5L12 7l2.5 2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,

  // 太阳（显示器亮度）：中心圆 + 8 道描边光芒
  sun: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,

  // 音量（扬声器 + 波形）
  volume: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4 10v4h4l5 4V6L8 10H4z"/><path d="M15 8a5 5 0 0 1 0 8M17.5 5.5a9 9 0 0 1 0 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,

  // 音量静音
  volumeMute: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4 10v4h4l5 4V6L8 10H4zM18 10l4 4M22 10l-4 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,

  // AirPlay 显示器（Display 滑块右侧小圆）
  airplayDisplay: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M12 14l3.5-3.5h-7z"/></svg>`,

  // 输出设备（Sound 滑块右侧小圆）
  airpods: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3a8 8 0 0 0-8 8v5a3 3 0 0 0 5 0v-3a1 1 0 0 0-1-1H7v-1a5 5 0 0 1 10 0v1h-1a1 1 0 0 0-1 1v3a3 3 0 0 0 5 0v-5a8 8 0 0 0-8-8z"/></svg>`,

  // 音乐音符（无封面占位）
  music: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M9 17V5l12-2v12"/><circle cx="6" cy="17" r="3"/><circle cx="18" cy="15" r="3"/></svg>`,

  // 电池
  battery: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="8" width="19" height="9" rx="2"/><rect x="22" y="10.5" width="1.5" height="4" rx=".5"/></svg>`,

  // 上一曲
  prev: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M6 6h2v12H6zM9.5 12l9.5 6V6z"/></svg>`,

  // 下一曲
  next: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M16 6h2v12h-2zM5 18l9.5-6L5 6z"/></svg>`,

  // 播放
  play: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M7 5v14l12-7z"/></svg>`,

  // 暂停
  pause: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`,

  // 隐私条右侧箭头（chevron-right，替代误用的控制中心主图标）
  chevronRight: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

// ========== 默认状态（localStorage 存储键前缀） ==========
const STORAGE_KEY = "webstartos_controlcenter";

const DEFAULT_STATE = {
  wifi: true,            // Wi-Fi 开启（蓝色）
  bluetooth: true,       // 蓝牙开启（蓝色）
  airdrop: true,         // 隔空投送开启（蓝色，模式 everyone）
  airplane: false,       // 飞行模式（关闭）
  focus: true,           // 专注模式（橙色）
  focusMode: "work",     // 专注模式名称（工作）
  stage: false,          // 台前调度
  mirroring: false,      // 屏幕镜像
  displayBrightness: 0.85,
  volume: 0.65,
  volumeMuted: false,
  battery: 100,
  batteryCharging: true,
  batteryHasBattery: false,
  nowPlaying: {
    song: "Night Drive",
    artist: "The Midnight",
    playing: true,
  },
  privacy: {
    mic: false,
    camera: false,
    location: false,
  },
};

// ========== 模块变量 ==========
let state = { ...DEFAULT_STATE };
let panelEl = null;
let overlayEl = null;
let iconEl = null;
let finderbarEl = null;

// i18n 简写
const t = (key, fallback) => i18n.t(key, fallback);

// ========== 存储读写 ==========
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state = {
      ...DEFAULT_STATE,
      ...parsed,
      nowPlaying: { ...DEFAULT_STATE.nowPlaying, ...parsed?.nowPlaying },
      privacy: { ...DEFAULT_STATE.privacy, ...parsed?.privacy },
    };
  } catch {
    state = { ...DEFAULT_STATE };
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* 忽略配额错误 */ }
}

// ========== 状态广播（供外部监听） ==========
function notifyChange(key, value) {
  document.dispatchEvent(new CustomEvent("controlcenter-change", { detail: { key, value } }));
}

// ========== 控制中心面板构建 ==========
function createPanel() {
  if (panelEl) return panelEl;

  overlayEl = document.createElement("div");
  overlayEl.className = "controlcenter-overlay";
  overlayEl.addEventListener("click", hide);
  document.body.appendChild(overlayEl);

  panelEl = document.createElement("div");
  panelEl.className = "controlcenter";
  panelEl.addEventListener("click", (e) => e.stopPropagation());
  document.body.appendChild(panelEl);

  return panelEl;
}

function renderPanel() {
  if (!panelEl) createPanel();

  // 隐私指示条（若有任一激活，沿用既有逻辑；不固定显示 Voice Memos 顶条）
  const privacyActive = state.privacy.mic || state.privacy.camera || state.privacy.location;
  let privacyHtml = "";
  if (privacyActive) {
    let dotType = state.privacy.camera ? "camera" : (state.privacy.mic ? "mic" : "location");
    let label = state.privacy.camera ? "摄像头正在被 Safari 使用"
      : state.privacy.mic ? "麦克风正在被 Safari 使用"
      : "位置服务正在使用中";
    privacyHtml = `
      <div class="cc-privacy-bar" data-action="privacy">
        <span class="cc-privacy-dot ${dotType}"></span>
        <span class="cc-privacy-text">${label}</span>
        <span class="cc-privacy-chev">${SVG.chevronRight}</span>
      </div>`;
  }

  // 第一行：左连通性组（Wi-Fi / 蓝牙 / AirDrop / 飞行模式）+ 右 Focus 大卡
  const connectivityHtml = `
    <div class="cc-grid">
      <div class="cc-card cc-connectivity">
        ${renderConnRow("wifi", SVG.wifi, state.wifi, t("controlcenter.wifi", "Wi-Fi"), state.wifi ? "WebStartOS-Home" : t("controlcenter.off", "关闭"))}
        ${renderConnRow("bluetooth", SVG.bluetooth, state.bluetooth, t("controlcenter.bluetooth", "蓝牙"), state.bluetooth ? t("controlcenter.on", "开启") : t("controlcenter.off", "关闭"))}
        ${renderConnRow("airdrop", SVG.airdrop, state.airdrop, t("controlcenter.airdrop", "隔空投送"), state.airdrop ? t("controlcenter.everyone", "所有人") : t("controlcenter.off", "关闭"))}
        ${renderConnRow("airplane", SVG.airplane, state.airplane, t("controlcenter.airplane", "飞行模式"), state.airplane ? t("controlcenter.on", "开启") : t("controlcenter.off", "关闭"))}
      </div>
      <div class="cc-card cc-focus-card" data-action="focus">
        <div class="cc-focus-icon ${state.focus ? "active" : ""}">${SVG.focus}</div>
        <div class="cc-focus-title">${t("controlcenter.focus", "Focus")}</div>
      </div>
    </div>`;

  // 第二行：Stage Manager / Screen Mirroring 小卡
  const stageRow = `
    <div class="cc-grid" style="margin-top:8px">
      <div class="cc-card cc-small-card" data-action="stage">
        <div class="cc-small-icon ${state.stage ? "active" : ""}">${SVG.stage}</div>
        <div class="cc-small-title">${t("controlcenter.stageManager", "台前调度")}</div>
      </div>
      <div class="cc-card cc-small-card" data-action="mirroring">
        <div class="cc-small-icon ${state.mirroring ? "active" : ""}">${SVG.mirroring}</div>
        <div class="cc-small-title">${t("controlcenter.screenMirroring", "屏幕镜像")}</div>
      </div>
    </div>`;

  // 第三 / 四行：Display / Sound 横滑块卡
  const sliderRow = `
    ${renderSlider(
      "display",
      t("controlcenter.display", "显示器"),
      SVG.sun,
      state.displayBrightness,
      false,
      SVG.airplayDisplay
    )}
    ${renderSlider(
      "volume",
      t("controlcenter.sound", "声音"),
      state.volumeMuted ? SVG.volumeMute : SVG.volume,
      state.volume,
      state.volumeMuted,
      SVG.airpods
    )}
  `;

  // 第五行：Music 卡（歌曲封面显示区 + 播放控制）
  const hasNowPlaying = state.nowPlaying.playing || (state.nowPlaying.song && state.nowPlaying.song.length > 0);
  let musicHtml = "";
  if (hasNowPlaying) {
    musicHtml = `
    <div class="cc-nowplaying" data-action="nowplaying">
      <div class="cc-np-art">${SVG.music}</div>
      <div class="cc-np-info">
        <div class="cc-np-song">${state.nowPlaying.song || "未播放音乐"}</div>
        <div class="cc-np-artist">${state.nowPlaying.artist || ""}</div>
      </div>
      <div class="cc-np-controls">
        <div class="cc-np-btn" data-np="prev">${SVG.prev}</div>
        <div class="cc-np-btn play" data-np="toggle">${state.nowPlaying.playing ? SVG.pause : SVG.play}</div>
        <div class="cc-np-btn" data-np="next">${SVG.next}</div>
      </div>
    </div>`;
  }

  panelEl.innerHTML = privacyHtml + connectivityHtml + stageRow + sliderRow + musicHtml;

  // 绑定连通性行点击
  panelEl.querySelectorAll(".cc-conn-row").forEach((el) => {
    el.addEventListener("click", () => handleCardAction(el.getAttribute("data-action")));
  });

  // 隐私条点击
  const privacyBar = panelEl.querySelector(".cc-privacy-bar");
  if (privacyBar) {
    privacyBar.addEventListener("click", () => alert("隐私设置：请前往系统设置查看详细信息。"));
  }

  // Focus / Stage / Screen 点击
  panelEl.querySelectorAll(".cc-focus-card, .cc-small-card").forEach((el) => {
    el.addEventListener("click", () => handleCardAction(el.getAttribute("data-action")));
  });

  // 正在播放按钮
  panelEl.querySelectorAll(".cc-np-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleNowPlaying(btn.getAttribute("data-np"));
    });
  });

  // 正在播放整体点击（打开音乐）
  const npCard = panelEl.querySelector('[data-action="nowplaying"]');
  if (npCard) {
    npCard.addEventListener("click", () => {
      hide();
      alert("音乐 App：此处可打开内置音乐播放器。");
    });
  }

  bindSliders();
}

// ========== 连通性行（左大蓝圆 + 右标题/副标题） ==========
function renderConnRow(action, iconSvg, active, title, sub) {
  return `
    <div class="cc-conn-row" data-action="${action}">
      <div class="cc-conn-icon ${active ? "active" : ""}">${iconSvg}</div>
      <div class="cc-conn-text">
        <div class="cc-conn-title">${title}</div>
        <div class="cc-conn-sub">${sub}</div>
      </div>
    </div>`;
}

// ========== 滑块渲染（macOS 15：小标题 + 左大圆 + 轨道 + 右小圆，无 head 标签行） ==========
function renderSlider(key, label, leftIconSvg, value, muted, rightBtnSvg) {
  const pct = Math.round(value * 100);
  const mutedClass = muted ? "cc-slider-icon-muted" : "";
  return `
    <div class="cc-slider-card" data-slider="${key}">
      <div class="cc-slider-label ${mutedClass}">${label}</div>
      <div class="cc-slider-row">
        <div class="cc-slider-left-icon ${mutedClass}" data-slider-left="${key}">
          ${leftIconSvg}
        </div>
        <div class="cc-slider-track" data-slider-track="${key}">
          <div class="cc-slider-fill" style="width:calc(${pct}% - 6px)"></div>
          <div class="cc-slider-thumb" style="left:${pct}%"></div>
        </div>
        <div class="cc-slider-right-btn" data-slider-right="${key}">
          ${rightBtnSvg}
        </div>
      </div>
    </div>`;
}

// ========== 滑块拖拽绑定 ==========
function bindSliders() {
  panelEl.querySelectorAll(".cc-slider-card").forEach((card) => {
    const key = card.getAttribute("data-slider");
    const track = card.querySelector(".cc-slider-track");
    const fill = card.querySelector(".cc-slider-fill");
    const thumb = card.querySelector(".cc-slider-thumb");
    const leftIcon = card.querySelector(".cc-slider-left-icon");
    const rightBtn = card.querySelector(".cc-slider-right-btn");
    let dragging = false;

    function setFromClientX(clientX) {
      const rect = track.getBoundingClientRect();
      let ratio = (clientX - rect.left) / rect.width;
      ratio = Math.max(0, Math.min(1, ratio));
      const pct = Math.round(ratio * 100);
      fill.style.width = `calc(${pct}% - 6px)`;
      thumb.style.left = `${pct}%`;
      applySliderValue(key, ratio);
    }

    track.addEventListener("click", (e) => setFromClientX(e.clientX));

    thumb.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      dragging = true;
      e.preventDefault();
    });

    const moveHandler = (e) => { if (dragging) setFromClientX(e.clientX); };
    const upHandler = () => { dragging = false; };

    window.addEventListener("mousemove", moveHandler);
    window.addEventListener("mouseup", upHandler);

    // 左侧大圆图标点击：显示器=最低亮度/恢复，声音=静音切换
    if (leftIcon) {
      leftIcon.addEventListener("click", (e) => {
        e.stopPropagation();
        if (key === "volume") {
          state.volumeMuted = !state.volumeMuted;
          saveState();
          notifyChange("volumeMuted", state.volumeMuted);
          renderPanel();
        } else if (key === "display") {
          state.displayBrightness = state.displayBrightness > 0.05 ? 0 : 0.85;
          applyDisplayBrightness();
          saveState();
          notifyChange("displayBrightness", state.displayBrightness);
          renderPanel();
        }
      });
    }

    // 右侧小圆按钮点击：显示器=AirPlay 设置，声音=输出设备选择
    if (rightBtn) {
      rightBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (key === "display") alert("显示器设置：可选择显示器分辨率、色彩、Night Shift 等。");
        else if (key === "volume") alert("声音输出：可选择内置扬声器、耳机、AirPlay 等输出设备。");
      });
    }
  });
}

function applySliderValue(key, ratio) {
  switch (key) {
    case "display":
      state.displayBrightness = ratio;
      applyDisplayBrightness();
      break;
    case "volume":
      state.volume = ratio;
      if (ratio > 0.01 && state.volumeMuted) state.volumeMuted = false;
      break;
  }
  saveState();
  notifyChange(key, ratio);
}

// 将亮度映射到 CSS 覆盖层（屏幕变暗效果）
function applyDisplayBrightness() {
  let overlay = document.getElementById("webstartos-brightness-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "webstartos-brightness-overlay";
    Object.assign(overlay.style, {
      position: "fixed", top: 0, left: 0,
      width: "100vw", height: "100vh",
      background: "#000",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity 0.1s ease",
      zIndex: "2147483646",
      mixBlendMode: "multiply",
    });
    document.body.appendChild(overlay);
  }
  const b = state.displayBrightness;
  overlay.style.opacity = String(Math.max(0, 1 - b) * 0.55);
}

// ========== 卡片点击处理 ==========
function handleCardAction(action) {
  switch (action) {
    case "wifi": state.wifi = !state.wifi; break;
    case "bluetooth": state.bluetooth = !state.bluetooth; break;
    case "airdrop": state.airdrop = !state.airdrop; break;
    case "airplane": state.airplane = !state.airplane; break;
    case "focus": state.focus = !state.focus; break;
    case "stage": state.stage = !state.stage; applyStageManager(); break;
    case "mirroring": state.mirroring = !state.mirroring; break;
  }
  saveState();
  notifyChange(action, state[action]);
  renderPanel();
}

// ========== 台前调度实现（窗口层级模式切换示意） ==========
function applyStageManager() {
  const desktop = document.getElementById("desktop");
  if (!desktop) return;
  if (state.stage) {
    desktop.classList.add("stage-manager-on");
    document.documentElement.style.setProperty("--stage-enabled", "1");
  } else {
    desktop.classList.remove("stage-manager-on");
    document.documentElement.style.removeProperty("--stage-enabled");
  }
}

// ========== 正在播放按钮处理 ==========
function handleNowPlaying(action) {
  if (action === "toggle") state.nowPlaying.playing = !state.nowPlaying.playing;
  else if (action === "prev") { state.nowPlaying.song = "Night Drive"; state.nowPlaying.artist = "The Midnight"; }
  else if (action === "next") { state.nowPlaying.song = "Sunset Lover"; state.nowPlaying.artist = "Petit Biscuit"; }
  saveState();
  renderPanel();
}

// ========== 显示/隐藏 ==========
export function show() {
  if (!panelEl) createPanel();
  renderPanel();
  requestAnimationFrame(() => {
    overlayEl.classList.add("visible");
    panelEl.classList.add("visible");
  });
  iconEl?.classList.add("active");
  if (finderbarEl && typeof refreshFinderbarTextColor === "function") refreshFinderbarTextColor();
}

export function hide() {
  if (!panelEl) return;
  overlayEl.classList.remove("visible");
  panelEl.classList.remove("visible");
  iconEl?.classList.remove("active");
}

export function toggle() {
  if (panelEl && panelEl.classList.contains("visible")) hide();
  else show();
}

// ========== 菜单栏图标注入 ==========
export function mountToFinderbar(rightContainer, bar) {
  if (iconEl) return;
  finderbarEl = bar;

  const existingSwitch = [...rightContainer.querySelectorAll("img")].find(
    (img) => /switch/i.test(img.getAttribute("src") || "")
  );
  if (!existingSwitch) {
    iconEl = document.createElement("div");
    iconEl.className = "controlcenter-icon";
    iconEl.title = "控制中心";
    iconEl.innerHTML = SVG.controlcenter;
    rightContainer.appendChild(iconEl);
  } else {
    iconEl = existingSwitch;
    iconEl.classList.add("controlcenter-icon");
    iconEl.title = "控制中心";
  }

  iconEl.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });
}

// ========== 对外 API：读取状态 ==========
export function getState() {
  return { ...state };
}

export function setValue(key, value) {
  if (Object.prototype.hasOwnProperty.call(state, key)) {
    state[key] = value;
    saveState();
    notifyChange(key, value);
    if (panelEl?.classList.contains("visible")) renderPanel();
    if (key === "displayBrightness") applyDisplayBrightness();
    if (key === "stage") applyStageManager();
  }
}

// ========== 电池 API：读取系统真实电量，但本次不渲染电池卡片 ==========
async function initBattery() {
  try {
    if (typeof navigator?.getBattery !== "function") {
      state.batteryHasBattery = false;
      return;
    }
    const bat = await navigator.getBattery();
    const updateFromBattery = () => {
      state.battery = bat.level * 100;
      state.batteryCharging = bat.charging;
      const ct = bat.chargingTime;
      const dt = bat.dischargingTime;
      const chargingTimeMissing = ct === 0 || ct === Infinity || ct < 0 || ct == null;
      const dischargingTimeMissing = dt === null || dt === Infinity || dt < 0;
      const fullyCharged = Math.abs(bat.level - 1) < 0.001;
      state.batteryHasBattery = !(fullyCharged && bat.charging && chargingTimeMissing && dischargingTimeMissing);
      saveState();
      if (panelEl?.classList.contains("visible")) renderPanel();
    };
    updateFromBattery();
    bat.addEventListener("levelchange", updateFromBattery);
    bat.addEventListener("chargingchange", updateFromBattery);
    bat.addEventListener("chargingtimechange", updateFromBattery);
    bat.addEventListener("dischargingtimechange", updateFromBattery);
  } catch {
    state.batteryHasBattery = false;
  }
}

// ========== 初始化 ==========
export function init() {
  loadState();
  applyDisplayBrightness();
  applyStageManager();
  initBattery();

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panelEl?.classList.contains("visible")) hide();
  });

  document.addEventListener("languagechange", () => {
    if (panelEl?.classList.contains("visible")) renderPanel();
  });
}

init();
