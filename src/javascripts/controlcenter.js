/**
 * controlcenter.js — macOS 15 控制中心逻辑模块
 *
 * 完全重写为 macOS Sequoia 风格布局：
 * - 顶部连通性 2×2 磁贴（Wi-Fi / 蓝牙 / 隔空投送 / 飞行模式，蓝激活）
 * - 右侧专注模式大卡（橙激活）
 * - 台前调度 / 屏幕镜像 / 锁定屏幕快捷小卡
 * - 显示器 / 声音横滑块卡
 * - 正在播放卡（仅当页面里真的有媒体在播时出现）
 *
 * 图标全部来自 ui/phosphor-icons.js（与 App Store 同源），不再自绘 SVG。
 *
 * 整体背景为毛玻璃半透明，配色仅蓝（网络相关）+ 橙（专注模式）两主色。
 * 所有状态经设置中枢（window.__settings）读写并持久化在 webstartos_controlcenter
 * JSON 槽里，面板从菜单栏右侧图标弹出。
 *
 * 与「系统设置」的双向一致：
 * - 面板上的每一次点击/拖动都调 `settings.set(key, next, { source: "controlcenter" })`，
 *   由设置中枢落盘后回调本模块的 `setValue(path, value)` 生效；
 * - 本模块订阅 `settings-changed`，别的界面改了同一个键时面板重绘；
 * - 设置中枢尚未注册对应键（声音/亮度模块未加载、或纯静态页跑单测）时回落到
 *   直接写内存状态 + localStorage，功能不缺。
 *
 * 两条联动与一项显隐：
 * - 飞行模式与 Wi-Fi / 蓝牙 / 隔空投送 / 屏幕镜像互锁（开飞行断无线，开无线退飞行）；
 * - 菜单栏图标本身是否占位由 `controlcenter.showInMenuBar` 决定（本模块自己 define），
 *   图标常驻 DOM，只是按设置显隐，来回拨开关不需要重新挂载。
 */

import { i18n } from "./i18n.js";
import { Z } from "./zindex.js";
import { dispatchMenuCommand } from "./ui/menuCommands.js";
import { iconSvg } from "./ui/phosphor-icons.js";

/**
 * 取一枚 Phosphor 图标（与 App Store 同源：256 网格、currentColor、`.ui-icon`）。
 * @param {string} name 官方 kebab-case 名称
 * @param {number} [size=20] 像素尺寸
 * @param {string} [className] 额外类名
 * @returns {string} SVG 字符串
 */
const icon = (name, size = 20, className = "") => iconSvg(name, { size, className });

/* 图标名映射：全部指向 Phosphor 官方资产（assets/ui/phosphor/）。 */
const ICON_NAME = {
  controlcenter: "sliders-horizontal",
  stage: "squares-four",
  mirroring: "monitor-arrow-up",
  sun: "sun",
  volume: "speaker-high",
  volumeMute: "speaker-slash",
  airplayDisplay: "airplay",
  airpods: "headphones",
  music: "music-notes",
  play: "play",
  pause: "pause",
  chevronRight: "caret-right",
  lock: "lock",
};

// ── 默认状态（localStorage 存储键前缀） ──
const STORAGE_KEY = "webstartos_controlcenter";
/** 菜单栏图标显隐的存储槽（= 设置项 controlcenter.showInMenuBar 的推导槽名）。 */
const MENU_BAR_SLOT = "controlcenter-showInMenuBar";
/** 本模块自己登记的两个键：不进 CONTROL_CENTER_FIELDS（它们不是卡片开关）。 */
const MENU_BAR_KEY = "controlcenter.showInMenuBar";
const NOW_PLAYING_KEY = "controlcenter.nowPlaying";

const DEFAULT_STATE = {
  stage: false,          // 台前调度
  mirroring: false,      // 屏幕镜像
  displayBrightness: 0.85,
  volume: 0.65,
  volumeMuted: false,
  battery: 100,
  batteryCharging: true,
  batteryHasBattery: false,
  // 不预置演示曲目：没有真实 <audio>/<video> 在播时不渲染「正在播放」卡片（F-20）。
  nowPlaying: { song: "", artist: "", playing: false },
  privacy: {
    mic: false,
    camera: false,
    location: false,
  },
};

// ── 模块变量 ──
let state = { ...DEFAULT_STATE };
let panelEl = null;
let overlayEl = null;
let iconEl = null;
let finderbarEl = null;
// 菜单栏图标是否占位（由 controlcenter.showInMenuBar 驱动，默认显示）
let menuBarIconVisible = true;

const t = (key, fallback) => i18n.t(key, fallback);

/**
 * 纯文本 -> HTML 转义。面板整块用模板字符串渲染（见 renderPanel），
 * 其中「曲目名 / 艺术家 / 语言文案」都是可变文本，必须转义后再进 innerHTML
 * —— 任何插件经 `setValue("nowPlaying.song", …)` 传进来的字符串都不该被当标记解析
 * （同 ui/alert.js / window.js 的处理）。
 * @param {*} value 任意值
 * @returns {string} 可安全插入 HTML 文本节点位置的字符串
 */
function escapeText(value) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, (ch) => map[ch]);
}

// ── 设置字段表（设置中枢注册定义的唯一来源） ──
/**
 * 控制中心卡片与开关的状态字段，一条一个开关；`path` 是值在
 * webstartos_controlcenter JSON 槽里的路径，`default` 逐项取自 DEFAULT_STATE，
 * 这样「卡片初始态」与「设置项默认值」不可能各写各的。
 * 音量 / 静音 / 显示器亮度不在此列：它们由 `sound.master` / `sound.muted` /
 * `display.brightness` 三个设置项托管（各自的 owner 模块定义），与本槽共用存储。
 * @type {Array<{key: string, path: string, type: string, default: *, label: string, hint?: string, owner: string, values?: Array<string>, valuesLabel?: Array<string>, min?: number, max?: number, step?: number, format?: string}>}
 */
export const CONTROL_CENTER_FIELDS = [
  { key: "controlcenter.stage", path: "stage", type: "boolean", default: DEFAULT_STATE.stage, label: "台前调度", owner: "system" },
  { key: "controlcenter.mirroring", path: "mirroring", type: "boolean", default: DEFAULT_STATE.mirroring, label: "屏幕镜像", owner: "system", unavailable: true },
];

/** 路径 -> 字段定义（含由其它内核模块托管的声音 / 亮度字段）。 */
const FIELD_BY_PATH = new Map(CONTROL_CENTER_FIELDS.map((f) => [f.path, f]));

/** 存储路径 -> 设置键。音量、静音、亮度住在同一个 JSON 槽里，但键归别的 owner。 */
const PATH_TO_KEY = new Map([
  ...CONTROL_CENTER_FIELDS.map((f) => [f.path, f.key]),
  ["volume", "sound.master"],
  ["volumeMuted", "sound.muted"],
  ["displayBrightness", "display.brightness"],
  ["nowPlaying", NOW_PLAYING_KEY],
]);

/** 设置键 -> 存储路径（`settings-changed` 反查用）。 */
const KEY_TO_PATH = new Map([...PATH_TO_KEY].map(([path, key]) => [key, path]));

/** 无设置定义可参考时的数字区间兜底（滑块类一律 0..1）。 */
const FALLBACK_BOUNDS = { battery: [0, 100] };

/** 卡片动作 -> 存储字段（handleCardAction 的分发表）。 */
const CARD_ACTION = {
  stage: "stage",
  mirroring: "mirroring",
};

function readPath(obj, path) {
  return path.split(".").reduce((acc, part) => (acc && typeof acc === "object" ? acc[part] : undefined), obj);
}

/** 写点号路径，途中的非对象节点替换成新对象，其余字段原样保留。 */
function writePath(obj, path, value) {
  const parts = path.split(".");
  let node = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
  return obj;
}

/** 数字字段的合法区间：优先用设置定义里的 min/max。 */
function numberBounds(path) {
  const def = window.__settings?.info?.(PATH_TO_KEY.get(path));
  if (def && (typeof def.min === "number" || typeof def.max === "number")) {
    return [typeof def.min === "number" ? def.min : 0, typeof def.max === "number" ? def.max : 1];
  }
  return FALLBACK_BOUNDS[path] || [0, 1];
}

/**
 * 按字段类型归一化写入值：布尔取值、数字钳制、枚举校验，非法值返回 undefined。
 * @param {string} path 字段路径
 * @param {*} value 原始值
 * @returns {*} 归一化后的值；无法归一化时 undefined（调用方据此放弃写入）
 */
function normalizeFieldValue(path, value) {
  const field = FIELD_BY_PATH.get(path);
  const current = readPath(state, path);
  const type = field?.type || (value !== null && typeof value === "object" ? "object" : typeof current);
  if (type === "boolean") return Boolean(value);
  if (type === "number") {
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num)) return undefined;
    const [min, max] = numberBounds(path);
    return Number(Math.min(max, Math.max(min, num)).toFixed(6));
  }
  if (type === "object") return value;
  const text = String(value ?? "");
  if (Array.isArray(field?.values) && !field.values.includes(text)) return undefined;
  return text;
}

// ── 存储读写 ──
/**
 * 本模块的日志出口：优先写运行记录（可按 kernel/controlcenter 检索），
 * log.js 尚未加载时退回 console —— 站内 console.* 已被 log.js 接管，
 * 两条路最终都进同一份运行记录。
 * @param {string} level debug/info/warn/error
 * @param {string} message 说明文本
 * @param {*} [data] 附加上下文
 * @returns {void}
 */
function logCC(level, message, data) {
    const api = window.__log;
    const method = level === "debug" ? "log" : level;
    if (api && typeof api[level] === "function") api[level]("kernel/controlcenter", message, data);
    else if (data === undefined) console[method](`[controlcenter] ${message}`);
    else console[method](`[controlcenter] ${message}`, data);
}

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

/**
 * 把整份内存状态写回共享 JSON 槽。
 * 设置项的**校验与落盘由设置中枢完成**（它按 jsonPath 只改一个字段），这里是 owner
 * 侧的镜像落盘：电池、正在播放、隐私这些「非设置」状态也住在这同一个槽里，
 * 只能整份写。配额超限（站内已知情形：壁纸 base64 占满存储）时只记一条 warn：
 * 内存状态已经改好，本次会话的功能不缺，刷新后才回退到上次成功的镜像。
 * @returns {boolean} 是否写入成功
 */
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    logCC("warn", `写入 ${STORAGE_KEY} 失败（配额或权限）：`, err);
    return false;
  }
}

// ── 状态广播（供外部监听） ──
function notifyChange(key, value) {
  document.dispatchEvent(new CustomEvent("controlcenter-change", { detail: { key, value } }));
}

/** 面板当前是否可见（可见才重绘，避免后台渲染浪费）。 */
const panelVisible = () => Boolean(panelEl?.classList.contains("visible"));

/**
 * 把一次用户操作交给设置中枢：中枢里有该键的定义时走 set()（校验 -> 落盘 ->
 * 回调 setValue 生效 -> 广播），没有定义时退回直接写状态，保证控制中心单独可用。
 * @param {string} key 设置键（如 "controlcenter.wifi"）
 * @param {string} path 存储字段路径（如 "wifi"）
 * @param {*} value 新值
 * @returns {void}
 */
function commitToSettings(key, path, value) {
  const api = globalThis.__settings;
  if (api && typeof api.set === "function" && typeof api.has === "function" && api.has(key)) {
    api.set(key, value, { source: "controlcenter" });
    return;
  }
  setValue(path, value);
}

/**
 * 飞行模式互锁已随四个连通性磁贴一并移除。
 */

// ── 控制中心面板构建 ──
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
    let label = state.privacy.camera ? t("controlcenter.cameraInUse", "摄像头正在被使用")
      : state.privacy.mic ? t("controlcenter.micInUse", "麦克风正在被使用")
      : t("controlcenter.locationInUse", "位置服务正在使用中");
    privacyHtml = `
      <div class="cc-privacy-bar" data-action="privacy">
        <span class="cc-privacy-dot ${dotType}"></span>
        <span class="cc-privacy-text">${label}</span>
        <span class="cc-privacy-chev">${icon(ICON_NAME.chevronRight, 14)}</span>
      </div>`;
  }

  // 状态读取走「设置中枢优先」：亮度 / 音量的键（display.brightness、sound.master、
  // sound.muted）由其它内核模块托管，面板显示中枢里的值而不是内存镜像，
  // 避免控制中心与系统设置各显示各的。
  const stageOn = Boolean(currentValueOf("stage"));
  const brightness = Number(currentValueOf("displayBrightness"));
  const volume = Number(currentValueOf("volume"));
  const muted = Boolean(currentValueOf("volumeMuted"));

  // 顶部：台前调度 / 屏幕镜像 / 锁定屏幕
  const quickHtml = `
    <div class="cc-quick">
      ${renderQuick("stage", ICON_NAME.stage, t("controlcenter.stageManager", "台前调度"), stageOn)}
      ${renderQuick("mirroring", ICON_NAME.mirroring, t("controlcenter.screenMirroring", "屏幕镜像"), false, true)}
      ${renderQuick("lockscreen", ICON_NAME.lock, t("controlcenter.lockScreen", "锁定屏幕"), false)}
    </div>`;

  const sliderHtml = `
    ${renderSlider(
      "display",
      t("controlcenter.display", "显示器"),
      icon(ICON_NAME.sun, 18),
      brightness,
      false,
      icon(ICON_NAME.airplayDisplay, 16)
    )}
    ${renderSlider(
      "volume",
      t("controlcenter.sound", "声音"),
      icon(muted ? ICON_NAME.volumeMute : ICON_NAME.volume, 18),
      volume,
      muted,
      icon(ICON_NAME.airpods, 16)
    )}
  `;

  // 最后一行：正在播放（只显示页面里真实在播的媒体；没有就整卡隐藏，绝不预置假曲目）
  const playingMedia = findPlayingMedia();
  const musicHtml = playingMedia ? renderNowPlaying(playingMedia) : "";

  panelEl.innerHTML = privacyHtml + quickHtml + sliderHtml + musicHtml;

  const privacyBar = panelEl.querySelector(".cc-privacy-bar");
  if (privacyBar) privacyBar.addEventListener("click", () => openSettingsPane("privacy"));

  panelEl.querySelectorAll(".cc-quick-card").forEach((el) => {
    el.addEventListener("click", () => {
      const action = el.getAttribute("data-action");
      if (action === "stage") handleCardAction(action);
      else if (action === "lockscreen") lockFromControlCenter();
      // 屏幕镜像受系统能力限制：卡片已标注不可用，点击不做假动作
    });
  });

  panelEl.querySelectorAll(".cc-np-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMedia(playingMedia);
    });
  });

  bindSliders();
}

// ── 快捷小卡（台前调度 / 屏幕镜像 / 锁定屏幕） ──
/**
 * @param {string} action 动作标识
 * @param {string} iconName Phosphor 图标名
 * @param {string} title 标题
 * @param {boolean} active 是否处于开启态
 * @param {boolean} [unavailable=false] 是否标注为系统能力不可用
 * @returns {string} 小卡 HTML
 */
function renderQuick(action, iconName, title, active, unavailable = false) {
  return `
    <button type="button" class="cc-quick-card${active ? " is-active" : ""}${unavailable ? " is-unavailable" : ""}"
            data-action="${action}" aria-pressed="${active ? "true" : "false"}"
            ${unavailable ? 'aria-disabled="true"' : ""}>
      <span class="cc-quick-icon" aria-hidden="true">${icon(iconName, 20)}</span>
      <span class="cc-quick-title">${escapeText(title)}</span>
      ${unavailable ? `<span class="cc-quick-sub">${escapeText(t("controlcenter.unavailable", "不可用"))}</span>` : ""}
    </button>`;
}

// ── 滑块渲染（小标题 + 左圆按钮 + 轨道 + 右圆按钮） ──
function renderSlider(key, label, leftIconSvg, value, muted, rightBtnSvg) {
  const pct = Math.round(value * 100);
  const mutedClass = muted ? "cc-slider-icon-muted" : "";
  return `
    <div class="cc-slider-card" data-slider="${key}">
      <div class="cc-slider-label ${mutedClass}">${escapeText(label)}</div>
      <div class="cc-slider-row">
        <div class="cc-slider-left-icon ${mutedClass}" data-slider-left="${key}">
          ${leftIconSvg}
        </div>
        <div class="cc-slider-track" data-slider-track="${key}">
          <div class="cc-slider-fill" style="width:${pct}%"></div>
          <div class="cc-slider-thumb" style="left:clamp(10px, ${pct}%, calc(100% - 10px))"></div>
        </div>
        <div class="cc-slider-right-btn" data-slider-right="${key}">
          ${rightBtnSvg}
        </div>
      </div>
    </div>`;
}

// ── 滑块拖拽（模块级单例委托） ──
// 原实现每次 renderPanel → bindSliders 都会为每个滑块重新绑定 window 级
// mousemove/mouseup，旧监听从不移除 → 监听器与旧面板 DOM 引用无限累积泄漏。
// 现改为全局唯一的拖拽状态 + window 监听各绑定一次，拖动中只更新 UI 与广播，
// localStorage 在 mouseup 统一落盘，避免 mousemove 高频写存储。
let sliderDrag = null; // { key, track, fill, thumb }

window.addEventListener("mousemove", (e) => {
    if (!sliderDrag) return;
    const { track, fill, thumb, key } = sliderDrag;
    const rect = track.getBoundingClientRect();
    let ratio = (e.clientX - rect.left) / rect.width;
    ratio = Math.max(0, Math.min(1, ratio));
    const pct = Math.round(ratio * 100);
    fill.style.width = `calc(${pct}% - 6px)`;
    thumb.style.left = `${pct}%`;
    sliderDrag.ratio = ratio; // 同步最新值，供 mouseup 统一落盘
    applySliderValue(key, ratio, false); // 拖动中不落盘
});

window.addEventListener("mouseup", () => {
    if (sliderDrag) {
        applySliderValue(sliderDrag.key, sliderDrag.ratio, true); // 松手统一落盘
        sliderDrag = null;
    }
});

// ── 滑块拖拽绑定 ──
function bindSliders() {
  panelEl.querySelectorAll(".cc-slider-card").forEach((card) => {
    const key = card.getAttribute("data-slider");
    const track = card.querySelector(".cc-slider-track");
    const fill = card.querySelector(".cc-slider-fill");
    const thumb = card.querySelector(".cc-slider-thumb");
    const leftIcon = card.querySelector(".cc-slider-left-icon");
    const rightBtn = card.querySelector(".cc-slider-right-btn");

    function setFromClientX(clientX) {
      const rect = track.getBoundingClientRect();
      let ratio = (clientX - rect.left) / rect.width;
      ratio = Math.max(0, Math.min(1, ratio));
      const pct = Math.round(ratio * 100);
      fill.style.width = `calc(${pct}% - 6px)`;
      thumb.style.left = `${pct}%`;
      applySliderValue(key, ratio, true);
    }

    track.addEventListener("click", (e) => setFromClientX(e.clientX));

    thumb.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      // 起点取当前值：原先写 state[key]（key 是 "display" / "volume"，与存储字段名
      // displayBrightness 不同名），按下不动直接松手会把 ratio=undefined 当成 0，
      // 表现为「点一下亮度滑块头屏幕就全黑」。
      sliderDrag = { key, track, fill, thumb, ratio: key === "display" ? state.displayBrightness : state.volume };
    });

    // 左侧大圆图标点击：显示器=最低亮度/恢复，声音=静音切换（都经设置中枢写入）
    if (leftIcon) {
      leftIcon.addEventListener("click", (e) => {
        e.stopPropagation();
        if (key === "volume") {
          commitToSettings("sound.muted", "volumeMuted", !state.volumeMuted);
        } else if (key === "display") {
          commitToSettings("display.brightness", "displayBrightness", state.displayBrightness > 0.05 ? 0 : 0.85);
        }
      });
    }

    // 右侧小圆按钮点击：显示器=AirPlay 设置，声音=输出设备选择
    if (rightBtn) {
      rightBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        // 不再用弹窗承诺做不到的能力（分辨率 / AirPlay 输出）：直接打开真实存在的设置面板。
        openSettingsPane(key === "display" ? "controlcenter" : "sound");
      });
    }
  });
}

// persist 为 false 表示拖动中间过程（仅更新内存状态 + 即时视觉，不落盘、不写设置中枢，
// 由 mouseup 统一提交，避免 mousemove 高频写存储造成卡顿）
function applySliderValue(key, ratio, persist = true) {
  const path = key === "display" ? "displayBrightness" : "volume";
  const value = Math.max(0, Math.min(1, Number(ratio) || 0));
  if (!persist) {
    state[path] = value;
    if (key === "display") applyDisplayBrightness();
    else if (value > 0.01 && state.volumeMuted) {
      state.volumeMuted = false;
      // 记下「拖动中已解静音」：松手时 state.volumeMuted 已是 false，
      // 只按当前值判断就永远提交不到 sound.muted（旧版持久化分支从未执行）。
      if (sliderDrag) sliderDrag.unmuted = true;
    }
    notifyChange(path, value);
    return;
  }
  // 拖动结束时把音量从静音里救出来（与旧的直接改状态行为一致）
  if (key === "volume" && value > 0.01 && (state.volumeMuted || (sliderDrag && sliderDrag.unmuted))) {
    commitToSettings("sound.muted", "volumeMuted", false);
  }
  commitToSettings(PATH_TO_KEY.get(path), path, value);
}

// 将亮度映射到 CSS 覆盖层（屏幕变暗效果）
function applyDisplayBrightness() {
  let overlay = document.getElementById("deskly-brightness-overlay") || document.getElementById("webstartos-brightness-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "deskly-brightness-overlay";
    Object.assign(overlay.style, {
      position: "fixed", top: 0, left: 0,
      width: "100vw", height: "100vh",
      background: "#000",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity 0.1s ease",
      // 统一层级表里的压暗层：曾经是 2147483646，把 contextMenu 的
      // 「全页最高 z-index + 1」一路顶到 INT_MAX，随后又被 zindex.js 封顶
      // 拉回 9499，右键菜单因此会被 Dock 盖住。
      //
      // 纯黑压层不需要 mix-blend-mode：multiply 对纯黑是数学恒等（任何色乘黑得黑），
      // 而页面里一旦出现 mix-blend-mode 元素，Chromium 会让 backdrop-filter 采样失效，
      // 设置窗口侧栏的毛玻璃会整块退化成平色 —— 所以这里只用普通 alpha 合成。
      zIndex: String(Z.BRIGHTNESS),
    });
    overlay.classList.add("os-overlay");
    document.body.appendChild(overlay);
  }
  const b = state.displayBrightness;
  overlay.style.opacity = String(Math.max(0, 1 - b) * 0.55);
}

// ── 卡片点击处理 ──
// 所有卡片开关都经设置中枢写入：中枢落盘后回调 setValue() 生效并广播，
// 于是「控制中心」与「系统设置」面板共用一份状态，永远不会各写各的。
function handleCardAction(action) {
  const path = CARD_ACTION[action];
  if (!path) return;
  commitToSettings(PATH_TO_KEY.get(path), path, !readPath(state, path));
}

// ── 台前调度：唯一改动点（FS-05）——开关落到 wm/stage-manager.js 的真实现 ──
// 桌面图标淡出逻辑已迁入 stage-manager（按 desktop.stage.showDesktopItems 决定）。
// 动态 import 只为把模块拉进依赖图，不做样式热补丁。
function applyStageManager() {
  import("./wm/stage-manager.js")
    .then((m) => m.setEnabled(!!state.stage))
    .catch((err) => console.warn("[controlcenter] 台前调度模块不可用:", err));
}

// ── 正在播放：只认真实在播的页面媒体 ──
/**
 * 找出页面里正在播放的 <audio>/<video>。
 * 只扫描主文档：插件在自己的 iframe 里，跨文档读取会被同源策略挡住；
 * 需要让控制中心看到播放状态的插件应给媒体元素加 `data-deskly-title`，
 * 并通过 window.parent 广播（后续接 Deskly.nowPlaying 时再补）。
 * @returns {HTMLMediaElement|null}
 */
function findPlayingMedia() {
  const list = Array.from(document.querySelectorAll("audio, video"));
  return list.find((m) => !m.paused && !m.ended && m.readyState > 0) || null;
}

/** 媒体标题：优先 data-deskly-title，其次 title 属性，最后用通用文案。 */
function mediaTitle(media) {
  return media.dataset.desklyTitle || media.getAttribute("title") || t("controlcenter.nowPlaying", "正在播放");
}

/** 正在播放卡片：只有一个播放/暂停按钮（没有播放列表，就不放上一首/下一首）。 */
function renderNowPlaying(media) {
  const paused = media.paused;
  return `
    <div class="cc-nowplaying" data-action="nowplaying">
      <div class="cc-np-art">${icon(ICON_NAME.music, 20)}</div>
      <div class="cc-np-info">
        <div class="cc-np-song">${escapeText(mediaTitle(media))}</div>
        <div class="cc-np-artist">${escapeText(t("controlcenter.inPageMedia", "页面内正在播放的媒体"))}</div>
      </div>
      <div class="cc-np-controls">
        <div class="cc-np-btn play" data-np="toggle" role="button" tabindex="0"
             aria-label="${escapeText(paused ? t("controlcenter.play", "播放") : t("controlcenter.pause", "暂停"))}">${icon(paused ? ICON_NAME.play : ICON_NAME.pause, 18)}</div>
      </div>
    </div>`;
}

/** 播放/暂停真实媒体；结束后控制中心会通过 play/pause 监听自行重绘。 */
function toggleMedia(media) {
  if (!media) return;
  if (media.paused) media.play().catch(() => { /* 自动播放被拒：保持暂停态即可 */ });
  else media.pause();
}

// ── 系统设置跳转 ──
/**
 * 打开系统设置的某个面板（与聚焦的 openPane 同一套深链）。
 * @param {string} pane 面板 id
 * @returns {Promise<void>}
 */
async function openSettingsPane(pane) {
  if (!pane) return;
  hide();
  try {
    if (typeof globalThis.__pluginManagerReady === "function") await globalThis.__pluginManagerReady();
    // 必须等应用真正打开并挂上“打开面板”的监听后再派发：dispatchMenuCommand 是同步的，
    // 早派发的事件会落在监听注册之前（实测会停在默认面板）。
    const opener = window.__menuActions && window.__menuActions.openAppByName;
    if (typeof opener === "function") await opener("系统设置");
    else dispatchMenuCommand("openAppByName('系统设置')");
    // 等侧栏真正渲染出来（插件按需加载，固定延时在慢机器上会赶在监听注册之前）
    for (let i = 0; i < 40; i += 1) {
      const ready = [...document.querySelectorAll(".ss-nav__btn")].some((btn) => btn.textContent.trim());
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch { /* 打开失败由命令分发记日志 */ }
  const jump = () => document.dispatchEvent(new CustomEvent("system-settings-open-pane", { detail: { pane }, bubbles: true }));
  jump();
  // 再补一次：外壳可能在首次派发后才完成监听注册（幂等，后到的会覆盖前一次）
  setTimeout(jump, 300);
}

// ── 显示/隐藏 ──
/**
 * 控制中心入口的「锁定屏幕」：先收起面板，再走与菜单栏完全相同的 lock.lockNow 链路。
 * 动态导入而不是顶部 import：lock.js 反向经 ui/notification.js 依赖核心层，
 * 静态说明符会把 controlcenter <-> lock 拉成循环（与 session.js 同款规避）。
 */
async function lockFromControlCenter() {
  hide();
  try {
    const { lock } = await import("./lock.js");
    lock?.lockNow?.("controlcenter");
  } catch (err) {
    logCC("warn", "锁屏模块不可用，控制中心锁定未执行：", err);
  }
}

export function show() {
  if (!panelEl) createPanel();
  renderPanel();
  requestAnimationFrame(() => {
    overlayEl.classList.add("visible");
    panelEl.classList.add("visible");
  });
  iconEl?.classList.add("active");
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

// ── 菜单栏图标显隐（设置项 controlcenter.showInMenuBar） ──
/** 当前是否应在菜单栏显示控制中心图标：优先问设置中枢，未接管时读推导槽。 */
function readMenuBarIconFlag() {
  const api = globalThis.__settings;
  if (api && typeof api.has === "function" && api.has(MENU_BAR_KEY) && typeof api.get === "function") {
    return Boolean(api.get(MENU_BAR_KEY));
  }
  let raw = null;
  try { raw = localStorage.getItem(MENU_BAR_SLOT); } catch { /* 隐私模式：按默认显示处理 */ }
  return raw !== "off" && raw !== "false" && raw !== "0";
}

/** 把显隐落到菜单栏图标上（图标还没挂上来时什么也不做，挂载时会再同步一次）。 */
function applyMenuBarIconVisibility() {
  if (!iconEl) return;
  iconEl.style.display = menuBarIconVisible ? "" : "none";
  if (!menuBarIconVisible) hide();
}

/**
 * 设置「在菜单栏显示控制中心图标」。
 * 落盘由设置中枢完成（本函数是它的 apply），只有中枢没接管这个键时才自己写一次，
 * 因此调用方不需要再补第二次写。
 * @param {boolean} on 是否显示
 * @returns {boolean} 实际生效的开关
 */
export function setMenuBarIconVisible(on) {
  menuBarIconVisible = Boolean(on) && on !== "off" && on !== "false" && on !== "0";
  const api = globalThis.__settings;
  if (!api || typeof api.has !== "function" || !api.has(MENU_BAR_KEY)) {
    try {
      localStorage.setItem(MENU_BAR_SLOT, menuBarIconVisible ? "on" : "off");
    } catch (err) {
      logCC("warn", `写入 ${MENU_BAR_SLOT} 失败（配额或权限）：`, err);
    }
  }
  applyMenuBarIconVisibility();
  return menuBarIconVisible;
}

// ── 菜单栏图标注入 ──
/**
 * 把控制中心图标挂进菜单栏右端。
 * 显隐由 controlcenter.showInMenuBar 决定：关闭时图标仍然创建（这样再打开时不必
 * 重走一遍挂载），只是不占位。
 * @param {HTMLElement} rightContainer 菜单栏右侧容器
 * @param {HTMLElement} bar 菜单栏元素
 * @returns {void}
 */
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
    iconEl.innerHTML = icon(ICON_NAME.controlcenter, 16);
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

  menuBarIconVisible = readMenuBarIconFlag();
  applyMenuBarIconVisibility();
}

// ── 对外 API：读取状态 ──
export function getState() {
  return { ...state };
}

/**
 * 写入控制中心状态字段（支持点号路径，如 "nowPlaying.song"）。
 * 读-改-写整份内存状态：电池、正在播放、隐私等未涉及的字段原样保留，
 * 数字按设置定义的 min/max 钳制，枚举值非法时放弃写入。
 * 本函数是设置中枢的 apply 目标：**落盘由中枢完成，生效由这里一次做完**，
 * 调用方（含面板处理器）不需要再补第二次写。
 * @param {string} path 字段路径
 * @param {*} value 新值
 * @returns {*} 实际生效的值；路径非法或取值不合法时返回 undefined
 */
export function setValue(path, value) {
  if (typeof path !== "string" || !path) return undefined;
  const next = normalizeFieldValue(path, value);
  if (next === undefined) return undefined;
  writePath(state, path, next);
  saveState();
  notifyChange(path, next);
  if (path === "displayBrightness") applyDisplayBrightness();
  if (path === "stage") applyStageManager();
  if (panelVisible()) renderPanel();
  return next;
}

/**
 * 按设置键读取当前状态：优先取设置中枢的值（中枢是唯一写入方），
 * 未注册时回落到内存状态，供面板渲染取用。
 * @param {string} path 字段路径
 * @returns {*} 当前值
 */
function currentValueOf(path) {
  const key = PATH_TO_KEY.get(path);
  const api = window.__settings;
  if (key && api && typeof api.has === "function" && api.has(key) && typeof api.get === "function") {
    const stored = api.get(key);
    if (stored !== undefined) return stored;
  }
  return readPath(state, path);
}

// ── 麦克风活动：包装 getUserMedia，统计活动音轨 ──
/**
 * 浏览器不暴露全局麦克风是否在被使用，只能在自家调用点统计：
 * 包装 navigator.mediaDevices.getUserMedia，成功返回后按音轨数计数，
 * 音轨 ended / 流 inactive 时递减。插件与页面内代码都走同一个 API，因此都能被看到。
 * 拿不到 mediaDevices（无权限、非安全上下文）时静默跳过，指示器保持不显示。
 * @returns {void}
 */
function installMicActivity() {
  const md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== "function" || md.__desklyMicPatched) return;
  let activeTracks = 0;
  const sync = () => {
    const active = activeTracks > 0;
    if (state.privacy.mic === active) return;
    state.privacy.mic = active;
    saveState();
    if (panelVisible()) renderPanel();
  };
  try {
    const original = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      const tracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
      if (tracks.length) {
        activeTracks += tracks.length;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          activeTracks = Math.max(0, activeTracks - tracks.length);
          sync();
        };
        tracks.forEach((track) => track.addEventListener("ended", release, { once: true }));
        if (typeof stream.addEventListener === "function") stream.addEventListener("inactive", release, { once: true });
        sync();
      }
      return stream;
    };
    md.__desklyMicPatched = true;
  } catch (err) {
    logCC("warn", "无法安装麦克风活动监听：", err);
  }
}

// ── 电池 API：读取系统真实电量，但本次不渲染电池卡片 ──
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

// ── 本模块自持的设置定义 ──
/**
 * 登记不属于「卡片开关字段表」的两项：菜单栏图标显隐、正在播放状态。
 * 约定见 settings-definitions.js 顶部第 3 条 —— owner 才是取值范围的权威，
 * 所以这两项在本文件里 define，不进 CONTROL_CENTER_FIELDS（那张表只 surface
 * 控制中心的开关，字段形态由设置中枢按 jsonPath 映射到同一个 JSON 存储槽）。
 * @returns {boolean} 是否登记成功（设置中枢未加载时返回 false，功能按默认值运行）
 */
function defineOwnSettings() {
  const api = globalThis.__settings;
  if (!api || typeof api.define !== "function") return false;
  api.defineMany([
    {
      key: MENU_BAR_KEY, type: "boolean", default: true,
      label: "菜单栏图标", owner: "system", pane: "controlcenter",
      group: "控制中心", order: 20, control: "switch",
      apply: (value) => setMenuBarIconVisible(value),
    },
    {
      key: NOW_PLAYING_KEY, slot: STORAGE_KEY, jsonPath: "nowPlaying",
      type: "json", default: { ...DEFAULT_STATE.nowPlaying },
      label: "正在播放",
      owner: "system", pane: "controlcenter", group: "控制中心", order: 990,
      control: "json", hidden: true,
      apply: (value) => setValue("nowPlaying", value),
    },
  ]);
  return true;
}

// ── 初始化 ──
export function init() {
  loadState();
  applyDisplayBrightness();
  applyStageManager();
  initBattery();
  const defined = defineOwnSettings();
  menuBarIconVisible = readMenuBarIconFlag();

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panelEl?.classList.contains("visible")) hide();
  });

  document.addEventListener("languagechange", () => {
    if (panelVisible()) renderPanel();
  });

  // 页面媒体开始/结束播放时重绘：卡片只反映真实在播的东西（F-20）
  ["play", "pause", "ended"].forEach((type) => {
    document.addEventListener(type, () => {
      if (panelVisible()) renderPanel();
    }, true);
  });

  // 麦克风活动指示器：包装 getUserMedia 统计活动音轨
  installMicActivity();

  // 双向同步：别的界面（系统设置面板、声音 / 显示器模块）改动同一份状态时，
  // 把新值并回内存镜像并重绘。自己触发的写入因为镜像已一致，直接跳过。
  document.addEventListener("settings-changed", (event) => {
    const detail = event?.detail;
    if (!detail) return;
    const path = KEY_TO_PATH.get(detail.key);
    if (!path) return;
    if (readPath(state, path) === detail.value) return;
    setValue(path, detail.value);
  });

  logCC("info", `控制中心就绪：${CONTROL_CENTER_FIELDS.length} 个卡片字段交由设置中枢管理，`
    + `自持定义${defined ? "已登记" : "未登记（设置中枢未加载）"}，菜单栏图标${menuBarIconVisible ? "显示" : "隐藏"}`);
}

init();
