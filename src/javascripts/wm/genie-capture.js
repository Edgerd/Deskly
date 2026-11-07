/**
 * wm/genie-capture.js — 神奇效果的窗口快照提供层
 *
 * 目标是把「点击后才拍图」改成「窗口可见时先备好」：
 *   1) 优先用浏览器已合成的标签页截图，裁出窗口矩形，通常几十毫秒且保真；
 *   2) 没有原生截图权限时退回 snapdom，并在窗口空闲时预热，避免点击时才发现慢；
 *   3) 点击路径最多等一个短预算，拿不到就交给调用方走缩放淡出。
 *
 * 缓存按窗口 WeakMap 保存，快照只代表拍下时的窗口矩形；尺寸变化后不冒用。
 */

const DPR_MAX = 2;
const NATIVE_TIMEOUT_MS = 120;
const FRESH_MS = 800;
const WARM_DELAY_MS = 280;
/** 原生截图被判定不可用后的冷却：到点自动重试，避免慢机器「一次超时 = 永久降级」。 */
const NATIVE_RETRY_MS = 60000;

const cache = new WeakMap();
const warmState = new WeakMap();
const domPending = new WeakMap();

let nativeState = "unknown";
let nativeOffAt = 0;
let nativeJob = null;

/** 原生截图是否还能用；"off" 超过冷静期后自动解禁重试。 */
function nativeUsable() {
  if (nativeState !== "off") return true;
  if (performance.now() - nativeOffAt < NATIVE_RETRY_MS) return false;
  nativeState = "unknown";
  return true;
}

/** 标记原生截图不可用（冷却后自动恢复），供 visibleTab / 调试验收入口共用。 */
function markNativeOff() {
  nativeState = "off";
  nativeOffAt = performance.now();
}

function reduceMotionOn() {
  if (document.documentElement.getAttribute("data-reduce-motion") === "on") return true;
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

function rectOf(el) {
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function sameSize(a, b) {
  return a && b
    && Math.abs(a.w - b.w) < 1.5
    && Math.abs(a.h - b.h) < 1.5;
}

function remember(el, rect, snap) {
  if (!snap || !snap.width || !snap.height) return null;
  const record = { snap, rect: { ...rect }, at: performance.now() };
  cache.set(el, record);
  return record;
}

function cached(el, rect, freshOnly = false) {
  const record = cache.get(el);
  // 快照是窗口内的局部像素：拖动只改 x/y，仍可原样复用；只有尺寸变了才作废。
  if (!record || !sameSize(record.rect, rect)) return null;
  if (freshOnly && performance.now() - record.at > FRESH_MS) return null;
  return record;
}

function topmostAt(el, rect) {
  // 原生截图抓的是合成后的整页：窗口上任何一块被菜单/浮层盖住，
  // 裁出来的图都会把别人的像素一起吸走。四角与中心都没被遮才允许走原生路径。
  for (const fx of [0.04, 0.5, 0.96]) {
    for (const fy of [0.04, 0.5, 0.96]) {
      const x = Math.min(window.innerWidth - 1, Math.max(0, rect.x + rect.w * fx));
      const y = Math.min(window.innerHeight - 1, Math.max(0, rect.y + rect.h * fy));
      const hit = document.elementFromPoint(x, y);
      if (!hit || (hit !== el && !el.contains(hit))) return false;
    }
  }
  return true;
}

function visibleTab() {
  if (!nativeUsable()) return Promise.resolve(null);
  const tabs = globalThis.chrome && globalThis.chrome.tabs;
  if (!tabs || typeof tabs.captureVisibleTab !== "function") {
    markNativeOff();
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      markNativeOff();
      finish(null);
    }, NATIVE_TIMEOUT_MS);
    try {
      tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
        const err = globalThis.chrome.runtime && globalThis.chrome.runtime.lastError;
        if (err || !dataUrl) {
          markNativeOff();
          finish(null);
          return;
        }
        nativeState = "ok";
        finish(dataUrl);
      });
    } catch {
      markNativeOff();
      finish(null);
    }
  });
}

async function bitmapOf(blob) {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode();
  return img;
}

function closeBitmap(bitmap) {
  if (bitmap && typeof bitmap.close === "function") bitmap.close();
}

function maskCorners(canvas, cssW, cssH, radius) {
  const r = Math.min(radius, cssW / 2, cssH / 2);
  if (!(r > 0)) return;
  const a = r * canvas.width / cssW;
  const b = r * canvas.height / cssH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.globalCompositeOperation = "destination-in";
  ctx.beginPath();
  ctx.moveTo(a, 0);
  ctx.lineTo(canvas.width - a, 0);
  ctx.arcTo(canvas.width, 0, canvas.width, b, b);
  ctx.lineTo(canvas.width, canvas.height - b);
  ctx.arcTo(canvas.width, canvas.height, canvas.width - a, canvas.height, a);
  ctx.lineTo(a, canvas.height);
  ctx.arcTo(0, canvas.height, 0, canvas.height - b, b);
  ctx.lineTo(0, b);
  ctx.arcTo(0, 0, a, 0, a);
  ctx.closePath();
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
}

async function cropNative(el, rect, dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await bitmapOf(blob);
  try {
    const scaleX = bitmap.width / Math.max(1, window.innerWidth);
    const scaleY = bitmap.height / Math.max(1, window.innerHeight);
    const sx = Math.max(0, Math.floor(rect.x * scaleX));
    const sy = Math.max(0, Math.floor(rect.y * scaleY));
    const sw = Math.min(bitmap.width - sx, Math.ceil(rect.w * scaleX));
    const sh = Math.min(bitmap.height - sy, Math.ceil(rect.h * scaleY));
    if (sw < 8 || sh < 8) return null;

    const dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rect.w * dpr));
    canvas.height = Math.max(1, Math.round(rect.h * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    maskCorners(canvas, rect.w, rect.h, radius);
    return canvas;
  } finally {
    closeBitmap(bitmap);
  }
}

function sharedVisibleTab() {
  if (nativeJob) return nativeJob;
  const job = visibleTab();
  nativeJob = job;
  job.finally(() => {
    if (nativeJob === job) nativeJob = null;
  });
  return job;
}

async function nativeCapture(el, rect) {
  if (!nativeUsable() || !topmostAt(el, rect)) return null;
  const dataUrl = await sharedVisibleTab();
  if (!dataUrl) return null;
  try {
    return await cropNative(el, rect, dataUrl);
  } catch {
    return null;
  }
}

async function domCapture(el, rect) {
  try {
    const { snapdom } = await import("../../../assets/vendor/snapdom.mjs");
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
    const snap = await snapdom.toCanvas(el, {
      width: rect.w,
      height: rect.h,
      dpr,
      embedFonts: false,
      noShadows: true,
      backgroundColor: null,
    });
    return snap && snap.width > 0 && snap.height > 0 ? snap : null;
  } catch {
    return null;
  }
}

function startDomCapture(el, rect) {
  const pending = domPending.get(el);
  if (pending && sameSize(pending.rect, rect)) return pending.promise;
  const entry = { rect: { ...rect }, promise: null };
  entry.promise = domCapture(el, rect)
    .then((snap) => {
      if (snap && el.isConnected) remember(el, rect, snap);
      return snap;
    })
    .finally(() => {
      if (domPending.get(el) === entry) domPending.delete(el);
    });
  domPending.set(el, entry);
  return entry.promise;
}

/**
 * 取一块可立即用于动画的窗口快照。
 *
 * 点击路径绝不启动 snapdom：它的同步序列化一旦开始，任何超时定时器都要等主线程
 * 让出才会触发，仍会表现为「点完卡住」。这里只吃新鲜缓存 / 原生截图 / 旧缓存，
 * 都没有就立即返回 null 走缩放淡出；DOM 预热只在 idle 路径进行。
 * @param {HTMLElement} el 窗口根元素
 * @param {{x:number,y:number,w:number,h:number}} rect 当前窗口矩形
 * @returns {Promise<HTMLCanvasElement|null>}
 */
export async function snapshotFor(el, rect) {
  const fresh = cached(el, rect, true);
  if (fresh) return fresh.snap;

  const native = await nativeCapture(el, rect);
  if (native) return remember(el, rect, native).snap;

  const stale = cached(el, rect);
  return stale ? stale.snap : null;
}

/** 元素当前是否真的“画得出来”：不可见/透明/零尺寸时任何截图都会得到空白。 */
function renderable(el) {
  if (!el || !el.isConnected) return false;
  if (typeof getComputedStyle === "function") {
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    if (parseFloat(cs.opacity) === 0) return false;
  }
  const r = el.getBoundingClientRect();
  return r.width >= 8 && r.height >= 8;
}

/**
 * 台前调度停靠缩略图专用取图：允许吃旧缓存（缩略图只要求「最后一次可见时的画面」），
 * 没有缓存时当场补拍 —— 原生截图优先，拿不到（无权限或被别的窗盖住）就退回 snapdom
 * 把窗口 DOM 直接画成 canvas，不受层级遮挡影响。
 * 调用时机必须在窗口仍然可见时（wm-shelved 的 visibility:hidden 会拍出空白）。
 * @param {HTMLElement} el 窗口根元素
 * @param {{x:number,y:number,w:number,h:number}} rect 当前窗口矩形
 * @returns {Promise<HTMLCanvasElement|null>}
 */
export async function ensureThumbnail(el, rect) {
  const any = cached(el, rect);
  if (any) return any.snap;
  if (!renderable(el)) return null;
  const native = await nativeCapture(el, rect);
  if (native) return remember(el, rect, native).snap;
  const snap = await startDomCapture(el, rect);
  return snap || null;
}

/** 还原动画只认「最小化时拍下的那一块」，不因缓存年龄而重拍。 */
export function cachedSnapshot(el, rect) {
  const record = cached(el, rect);
  return record ? record.snap : null;
}

/** 窗口尺寸变化：快照作废并重拍，同时取消尚未执行的预热任务。 */
export function geometryChanged(el) {
  if (!el || !el.isConnected) return;
  cache.delete(el);
  cancelWarmWindow(el);
  refreshWindow(el);
}

export function refreshWindow(el) {
  if (!el || !el.isConnected || el._minimized || reduceMotionOn()) return;
  const rect = rectOf(el);
  if (!rect) return;
  const record = cache.get(el);
  if (record && !sameSize(record.rect, rect)) {
    cache.delete(el);
    cancelWarmWindow(el);
  }
  if (!topmostAt(el, rect)) return;
  nativeCapture(el, rect).then((snap) => {
    if (snap && el.isConnected) remember(el, rect, snap);
    else if (!nativeUsable() && !cached(el, rect)) warmWindow(el);
  }).catch(() => {});
}

/** 取消某窗口尚未执行的预热任务（关闭 / 最小化 / 尺寸变化时调用）。 */
export function cancelWarmWindow(el) {
  const state = el && warmState.get(el);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  if (state.idle && typeof cancelIdleCallback === "function") cancelIdleCallback(state.idle);
  warmState.delete(el);
}

/**
 * 窗口真正可见后预热。原生截图通常几十毫秒；没有原生权限时才在空闲期跑 snapdom，
 * 避免每个新窗口都立刻触发一次重序列化。
 * @param {HTMLElement} el 窗口根元素
 */
export function warmWindow(el) {
  if (!el || warmState.has(el) || reduceMotionOn()) return;
  const state = { timer: null, idle: 0 };
  warmState.set(el, state);
  state.timer = setTimeout(() => {
    state.timer = null;
    const run = () => {
      state.idle = 0;
      if (warmState.get(el) !== state) return;
      if (!el.isConnected || el._minimized || el._wmOpenPending) return;
      const rect = rectOf(el);
      if (!rect || cached(el, rect)) return;
      nativeCapture(el, rect).then((snap) => {
        if (snap) {
          remember(el, rect, snap);
          return;
        }
        if (!el.isConnected || el._minimized || nativeUsable()) return;
        startDomCapture(el, rect).catch(() => {});
      }).catch(() => {});
    };
    if (typeof requestIdleCallback === "function") state.idle = requestIdleCallback(run, { timeout: 1400 });
    else run();
  }, WARM_DELAY_MS);
}
