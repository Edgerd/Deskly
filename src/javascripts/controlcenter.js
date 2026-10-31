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
/** 菜单栏图标显隐的存储槽（= 设置项 controlcenter.showInMenuBar 的推导槽名）。 */
const MENU_BAR_SLOT = "controlcenter-showInMenuBar";
/** 本模块自己登记的两个键：不进 CONTROL_CENTER_FIELDS（它们不是卡片开关）。 */
const MENU_BAR_KEY = "controlcenter.showInMenuBar";
const NOW_PLAYING_KEY = "controlcenter.nowPlaying";

const DEFAULT_STATE = {
  wifi: true,            // Wi-Fi 开启（蓝色）
  bluetooth: true,       // 蓝牙开启（蓝色）
  airdrop: true,         // 隔空投送开启（蓝色，模式 everyone）
  airplane: false,       // 飞行模式（关闭）
  // 专注模式默认关闭：它过去只是卡片配色（橙色/灰色），默认开没有副作用；
  // 现在 ui/notification.js 拿它当真正的勿扰门 —— 默认开等于出厂就静默吞掉每一条通知。
  focus: false,          // 专注模式（勿扰）默认关闭
  focusMode: "work",     // 专注模式名称（工作）
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

// ========== 模块变量 ==========
let state = { ...DEFAULT_STATE };
let panelEl = null;
/** 当前二级详情视图（null = 主视图）；点 Wi-Fi/蓝牙等卡片进入，返回时清空。 */
let detailView = null;
let overlayEl = null;
let iconEl = null;
let finderbarEl = null;
// 菜单栏图标是否占位（由 controlcenter.showInMenuBar 驱动，默认显示）
let menuBarIconVisible = true;

// i18n 简写
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

// ========== 设置字段表（设置中枢注册定义的唯一来源） ==========
/**
 * 控制中心卡片与开关的状态字段，一条一个开关；`path` 是值在
 * webstartos_controlcenter JSON 槽里的路径，`default` 逐项取自 DEFAULT_STATE，
 * 这样「卡片初始态」与「设置项默认值」不可能各写各的。
 * 音量 / 静音 / 显示器亮度不在此列：它们由 `sound.master` / `sound.muted` /
 * `display.brightness` 三个设置项托管（各自的 owner 模块定义），与本槽共用存储。
 * @type {Array<{key: string, path: string, type: string, default: *, label: string, hint?: string, owner: string, values?: Array<string>, valuesLabel?: Array<string>, min?: number, max?: number, step?: number, format?: string}>}
 */
export const CONTROL_CENTER_FIELDS = [
  { key: "controlcenter.wifi", path: "wifi", type: "boolean", default: DEFAULT_STATE.wifi, label: "Wi-Fi", owner: "system", unavailable: true },
  { key: "controlcenter.bluetooth", path: "bluetooth", type: "boolean", default: DEFAULT_STATE.bluetooth, label: "蓝牙", owner: "system", unavailable: true },
  { key: "controlcenter.airdrop", path: "airdrop", type: "boolean", default: DEFAULT_STATE.airdrop, label: "隔空投送", hint: "开启后对「所有人」可见", owner: "system", unavailable: true },
  { key: "controlcenter.airplane", path: "airplane", type: "boolean", default: DEFAULT_STATE.airplane, label: "飞行模式", hint: "同时关闭 Wi-Fi、蓝牙与隔空投送", owner: "system", unavailable: true },
  { key: "controlcenter.focus", path: "focus", type: "boolean", default: DEFAULT_STATE.focus, label: "专注模式", owner: "system" },
  {
    key: "controlcenter.focusMode", path: "focusMode", type: "string", default: DEFAULT_STATE.focusMode,
    values: ["work", "personal", "sleep", "doNotDisturb"],
    valuesLabel: ["工作", "个人", "睡眠", "勿扰"],
    label: "专注模式名称", owner: "system",
  },
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
  wifi: "wifi",
  bluetooth: "bluetooth",
  airdrop: "airdrop",
  airplane: "airplane",
  focus: "focus",
  stage: "stage",
  mirroring: "mirroring",
};

/** 开飞行模式后要一并断掉的无线连接与镜像字段（与 macOS 的联动一致）。 */
const AIRPLANE_LINKED = ["wifi", "bluetooth", "airdrop", "mirroring"];

/** 读点号路径当前值。 */
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

// ========== 存储读写 ==========
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

// ========== 状态广播（供外部监听） ==========
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
 * 飞行模式互锁（真实联动，不只是个图标）：
 * 开飞行 -> 关掉 Wi-Fi / 蓝牙 / 隔空投送 / 屏幕镜像；
 * 手动打开 Wi-Fi 或蓝牙 -> 退出飞行模式。
 * 联动写入同样经设置中枢，于是「系统设置」里看到的也是联动后的结果；
 * 只改「值不同的那几项」，所以重复调用不会互相触发成环。
 * @param {string} path 刚生效的字段路径
 * @param {*} value 刚生效的值
 * @returns {void}
 */
function applyAirplaneInterlock(path, value) {
  if (path === "airplane") {
    if (!value) return;
    AIRPLANE_LINKED
      .filter((linked) => readPath(state, linked) !== false)
      .forEach((linked) => commitToSettings(PATH_TO_KEY.get(linked), linked, false));
    return;
  }
  if (value && (path === "wifi" || path === "bluetooth") && readPath(state, "airplane")) {
    commitToSettings(PATH_TO_KEY.get("airplane"), "airplane", false);
  }
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
  if (detailView) { renderDetailView(); return; }
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
        <span class="cc-privacy-chev">${SVG.chevronRight}</span>
      </div>`;
  }

  // 状态读取走「设置中枢优先」：亮度 / 音量的键（display.brightness、sound.master、
  // sound.muted）由其它内核模块托管，面板显示中枢里的值而不是内存镜像，
  // 避免控制中心与系统设置各显示各的。
  // 真实可得的状态：网络在线/离线来自 navigator.onLine；其余无线开关浏览器不提供。
  // 不再把内存镜像里的布尔当成"已连接"渲染 —— 那只是界面自己骗自己（F-20）。
  const online = navigator.onLine !== false;
  const focusOn = Boolean(currentValueOf("focus"));
  const stageOn = Boolean(currentValueOf("stage"));
  const brightness = Number(currentValueOf("displayBrightness"));
  const volume = Number(currentValueOf("volume"));
  const muted = Boolean(currentValueOf("volumeMuted"));
  const unavailable = t("controlcenter.unavailable", "不可用");

  // 第一行：左连通性组（Wi-Fi 显示真实在线状态；蓝牙/隔空投送/飞行模式标为不可用）+ 右 Focus 大卡
  const connectivityHtml = `
    <div class="cc-grid">
      <div class="cc-card cc-connectivity">
        ${renderConnRow("wifi", SVG.wifi, online, t("controlcenter.wifi", "Wi-Fi"), online ? t("controlcenter.connected", "已连接") : t("controlcenter.notConnected", "未连接"), { available: false })}
        ${renderConnRow("bluetooth", SVG.bluetooth, false, t("controlcenter.bluetooth", "蓝牙"), unavailable, { available: false })}
        ${renderConnRow("airdrop", SVG.airdrop, false, t("controlcenter.airdrop", "隔空投送"), unavailable, { available: false })}
        ${renderConnRow("airplane", SVG.airplane, false, t("controlcenter.airplane", "飞行模式"), unavailable, { available: false })}
      </div>
      <div class="cc-card cc-focus-card" data-action="focus" role="button" tabindex="0"
           aria-label="${escapeText(t("controlcenter.focus", "Focus"))}" aria-pressed="${focusOn ? "true" : "false"}">
        <div class="cc-focus-icon ${focusOn ? "active" : ""}" aria-hidden="true">${SVG.focus}</div>
        <div class="cc-focus-title">${escapeText(t("controlcenter.focus", "Focus"))}</div>
      </div>
    </div>`;

  // 第二行：Stage Manager / Screen Mirroring 小卡
  const stageRow = `
    <div class="cc-grid" style="margin-top:8px">
      <div class="cc-card cc-small-card" data-action="stage" role="button" tabindex="0"
           aria-label="${escapeText(t("controlcenter.stageManager", "台前调度"))}" aria-pressed="${stageOn ? "true" : "false"}">
        <div class="cc-small-icon ${stageOn ? "active" : ""}" aria-hidden="true">${SVG.stage}</div>
        <div class="cc-small-title">${escapeText(t("controlcenter.stageManager", "台前调度"))}</div>
      </div>
      <div class="cc-card cc-small-card cc-small-card--unavailable" data-action="mirroring" role="button" tabindex="0"
           aria-label="${escapeText(t("controlcenter.screenMirroring", "屏幕镜像"))}">
        <div class="cc-small-icon" aria-hidden="true">${SVG.mirroring}</div>
        <div class="cc-small-title">${escapeText(t("controlcenter.screenMirroring", "屏幕镜像"))}</div>
        <div class="cc-small-sub">${escapeText(unavailable)}</div>
      </div>
    </div>`;

  // 第三 / 四行：Display / Sound 横滑块卡
  const sliderRow = `
    ${renderSlider(
      "display",
      t("controlcenter.display", "显示器"),
      SVG.sun,
      brightness,
      false,
      SVG.airplayDisplay
    )}
    ${renderSlider(
      "volume",
      t("controlcenter.sound", "声音"),
      muted ? SVG.volumeMute : SVG.volume,
      volume,
      muted,
      SVG.airpods
    )}
  `;

  // 第五行：正在播放（只显示页面里真实在播的媒体；没有就整卡隐藏，绝不预置假曲目）
  const playingMedia = findPlayingMedia();
  const musicHtml = playingMedia ? renderNowPlaying(playingMedia) : "";

  panelEl.innerHTML = privacyHtml + connectivityHtml + stageRow + sliderRow + musicHtml;

  // 连通性行：没有可切换的真实能力，点按只打开二级说明（不再翻转假布尔）
  panelEl.querySelectorAll(".cc-conn-row").forEach((el) => {
    el.addEventListener("click", () => openDetail(el.getAttribute("data-action")));
  });

  // 隐私条点击
  const privacyBar = panelEl.querySelector(".cc-privacy-bar");
  if (privacyBar) {
    privacyBar.addEventListener("click", () => openSettingsPane("privacy"));
  }

  // Focus 走真实开关；Stage 走真实收纳（F-09 未落地前只切桌面图标，由 applyStageManager 负责）
  panelEl.querySelectorAll(".cc-focus-card").forEach((el) => {
    el.addEventListener("click", () => handleCardAction(el.getAttribute("data-action")));
  });
  panelEl.querySelectorAll(".cc-small-card").forEach((el) => {
    el.addEventListener("click", () => {
      const action = el.getAttribute("data-action");
      if (action === "stage") handleCardAction(action);
      else openDetail(action);
    });
  });

  // 正在播放：只有一个真实按钮（播放/暂停），不再提供没有播放列表支撑的上一首/下一首
  panelEl.querySelectorAll(".cc-np-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMedia(playingMedia);
    });
  });

  bindSliders();
}

// ========== 连通性行（左大蓝圆 + 右标题/副标题） ==========
/**
 * @param {string} action 动作/详情标识
 * @param {string} iconSvg 图标
 * @param {boolean} active 是否处于"开启/在线"态
 * @param {string} title 标题
 * @param {string} sub 副标题
 * @param {{available?: boolean}} [opts] available=false 表示浏览器无法提供该开关，只展示状态
 * @returns {string} 行 HTML
 */
function renderConnRow(action, iconSvg, active, title, sub, opts = {}) {
  const available = opts.available !== false;
  return `
    <div class="cc-conn-row ${available ? "" : "cc-conn-row--unavailable"}" data-action="${action}" role="button" tabindex="0"
         aria-label="${escapeText(title)}" ${available ? `aria-pressed="${active ? "true" : "false"}"` : ''}>
      <div class="cc-conn-icon ${active && available ? "active" : ""}" aria-hidden="true">${iconSvg}</div>
      <div class="cc-conn-text">
        <div class="cc-conn-title">${escapeText(title)}</div>
        <div class="cc-conn-sub">${escapeText(sub)}</div>
      </div>
    </div>`;
}

// ========== 滑块渲染（macOS 15：小标题 + 左大圆 + 轨道 + 右小圆，无 head 标签行） ==========
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
          <div class="cc-slider-fill" style="width:calc(${pct}% - 6px)"></div>
          <div class="cc-slider-thumb" style="left:${pct}%"></div>
        </div>
        <div class="cc-slider-right-btn" data-slider-right="${key}">
          ${rightBtnSvg}
        </div>
      </div>
    </div>`;
}

// ========== 滑块拖拽（模块级单例委托） ==========
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

// ========== 滑块拖拽绑定 ==========
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
        openSettingsPane(key === "display" ? "display" : "sound");
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
    else if (value > 0.01 && state.volumeMuted) state.volumeMuted = false;
    notifyChange(path, value);
    return;
  }
  // 拖动结束时把音量从静音里救出来（与旧的直接改状态行为一致）
  if (key === "volume" && value > 0.01 && state.volumeMuted) {
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
      zIndex: String(Z.BRIGHTNESS),
      mixBlendMode: "multiply",
    });
    overlay.classList.add("os-overlay");
    document.body.appendChild(overlay);
  }
  const b = state.displayBrightness;
  overlay.style.opacity = String(Math.max(0, 1 - b) * 0.55);
}

// ========== 卡片点击处理 ==========
// 所有卡片开关都经设置中枢写入：中枢落盘后回调 setValue() 生效并广播，
// 于是「控制中心」与「系统设置」面板共用一份状态，永远不会各写各的。
function handleCardAction(action) {
  const path = CARD_ACTION[action];
  if (!path) return;
  commitToSettings(PATH_TO_KEY.get(path), path, !readPath(state, path));
}

// ========== 台前调度实现（窗口层级模式切换示意） ==========
function applyStageManager() {
  const desktop = document.getElementById("desktop");
  if (!desktop) return;
  // 只切 class：样式在 assets/stylesheets/main/desktop.css（.desktop.stage-manager-on .item）。
  // 此前这里还写了一个 --stage-enabled 自定义属性，全仓库没有任何消费者，属于只写不读的假状态。
  desktop.classList.toggle("stage-manager-on", !!state.stage);
}

// ========== 正在播放：只认真实在播的页面媒体 ==========
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
      <div class="cc-np-art">${SVG.music}</div>
      <div class="cc-np-info">
        <div class="cc-np-song">${escapeText(mediaTitle(media))}</div>
        <div class="cc-np-artist">${escapeText(t("controlcenter.inPageMedia", "页面内正在播放的媒体"))}</div>
      </div>
      <div class="cc-np-controls">
        <div class="cc-np-btn play" data-np="toggle" role="button" tabindex="0"
             aria-label="${escapeText(paused ? t("controlcenter.play", "播放") : t("controlcenter.pause", "暂停"))}">${paused ? SVG.play : SVG.pause}</div>
      </div>
    </div>`;
}

/** 播放/暂停真实媒体；结束后控制中心会通过 play/pause 监听自行重绘。 */
function toggleMedia(media) {
  if (!media) return;
  if (media.paused) media.play().catch(() => { /* 自动播放被拒：保持暂停态即可 */ });
  else media.pause();
}

// ========== 二级详情（无真实能力的模块给解释，有真实能力的给控件 + 设置入口） ==========
/** 详情页文案：键 + 中文兜底。 */
const DETAIL_TEXT = {
  wifi: ["controlcenter.detail.wifi", "浏览器只提供在线/离线状态，无法列出附近网络或输入密码。"],
  bluetooth: ["controlcenter.detail.bluetooth", "浏览器扩展无法访问系统蓝牙，这里不能切换蓝牙，也不显示设备列表。"],
  airdrop: ["controlcenter.detail.airdrop", "隔空投送需要 macOS 的系统级无线能力，浏览器扩展无法实现。"],
  airplane: ["controlcenter.detail.airplane", "飞行模式需要直接控制无线硬件，浏览器不提供该能力。"],
  mirroring: ["controlcenter.detail.mirroring", "屏幕镜像需要系统级显示输出能力，浏览器扩展无法实现。"],
  display: ["controlcenter.detail.display", "分辨率、刷新率与多显示器排列由系统决定；亮度与夜览可在系统设置中调整。"],
  volume: ["controlcenter.detail.volume", "输出设备由系统决定；这里只能调整音量与静音。"],
};

/** 详情页标题。 */
function detailTitle(kind) {
  const map = {
    wifi: ["controlcenter.wifi", "Wi-Fi"],
    bluetooth: ["controlcenter.bluetooth", "蓝牙"],
    airdrop: ["controlcenter.airdrop", "隔空投送"],
    airplane: ["controlcenter.airplane", "飞行模式"],
    mirroring: ["controlcenter.screenMirroring", "屏幕镜像"],
    display: ["controlcenter.display", "显示器"],
    volume: ["controlcenter.sound", "声音"],
  };
  const [key, fallback] = map[kind] || ["controlcenter.detail", "详情"];
  return t(key, fallback);
}

/**
 * 打开二级详情。
 * @param {string} kind 详情标识（wifi/bluetooth/.../display/volume）
 */
function openDetail(kind) {
  if (!kind) return;
  detailView = kind;
  renderPanel();
}

/**
 * 渲染二级详情：顶部返回 + 标题，中间是真实控件或原因说明。
 * 有真实设置面板的（显示器/声音）给一个直达按钮。
 */
function renderDetailView() {
  const kind = detailView;
  const [noteKey, noteFallback] = DETAIL_TEXT[kind] || ["controlcenter.detail.wifi", ""];
  const note = t(noteKey, noteFallback);
  let body = "";
  let pane = "";
  if (kind === "display") {
    body = renderSlider("display", t("controlcenter.display", "显示器"), SVG.sun,
      Number(currentValueOf("displayBrightness")), false, SVG.airplayDisplay);
    pane = "display";
  } else if (kind === "volume") {
    body = renderSlider("volume", t("controlcenter.sound", "声音"), SVG.volume,
      Number(currentValueOf("volume")), Boolean(currentValueOf("volumeMuted")), SVG.airpods);
    pane = "sound";
  }
  const action = pane
    ? `<button type="button" class="cc-detail-action" data-pane="${pane}">${escapeText(
        pane === "display" ? t("controlcenter.openDisplay", "打开显示器设置") : t("controlcenter.openSound", "打开声音设置"))}</button>`
    : "";
  panelEl.innerHTML = `
    <div class="cc-detail">
      <div class="cc-detail-head">
        <button type="button" class="cc-detail-back" aria-label="${escapeText(t("controlcenter.back", "返回"))}">${SVG.chevronRight}</button>
        <span class="cc-detail-title">${escapeText(detailTitle(kind))}</span>
      </div>
      ${body}
      <div class="cc-detail-note">${escapeText(note)}</div>
      ${action}
    </div>`;
  panelEl.querySelector(".cc-detail-back").addEventListener("click", () => {
    detailView = null;
    renderPanel();
  });
  const actionBtn = panelEl.querySelector(".cc-detail-action");
  if (actionBtn) actionBtn.addEventListener("click", () => openSettingsPane(actionBtn.getAttribute("data-pane")));
  if (body) bindSliders();
}

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

// ========== 显示/隐藏 ==========
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
  // 关闭面板即回到主视图：下次打开不该停在某个二级详情里
  detailView = null;
  overlayEl.classList.remove("visible");
  panelEl.classList.remove("visible");
  iconEl?.classList.remove("active");
}

export function toggle() {
  if (panelEl && panelEl.classList.contains("visible")) hide();
  else show();
}

// ========== 菜单栏图标显隐（设置项 controlcenter.showInMenuBar） ==========
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

// ========== 菜单栏图标注入 ==========
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

  menuBarIconVisible = readMenuBarIconFlag();
  applyMenuBarIconVisibility();
}

// ========== 对外 API：读取状态 ==========
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
  applyAirplaneInterlock(path, next);
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

// ========== 麦克风活动：包装 getUserMedia，统计活动音轨 ==========
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

// ========== 本模块自持的设置定义 ==========
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

// ========== 初始化 ==========
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
