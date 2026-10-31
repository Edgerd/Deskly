/**
 * pointer-shake.js — 晃动指针时临时放大（macOS「晃动以查找指针」）
 *
 * 手册依据：《iMac 入门指南》桌面和菜单栏【提示】——"在触控板上快速来回移动手指或
 * 快速滑动鼠标，可暂时放大鼠标指针"。浏览器拿不到触控板手势，这里用**指针轨迹**
 * 判定等价动作：短窗口内方向反转次数够多、累计位移够大，就认为用户在"找指针"。
 *
 * 判定全部基于 pointermove 采样（只读事件、不写 DOM），命中后调用 cursor.js 的
 * pulseCursor() 放大 1.8 倍并在约 1.2s 后还原；用户设置 cursor.size 不受影响。
 *
 * 关闭方式：系统设置 › 鼠标 ›「晃动指针以查找」开关（mouse.shakeToFind）。
 */

import { settings } from "./settings.js";
import { pulseCursor } from "./cursor.js";

/** 采样窗口（毫秒）：只看最近这段时间内的轨迹。 */
const WINDOW_MS = 320;
/** 窗口内最少采样点数：低于此值不可能构成"来回"。 */
const MIN_SAMPLES = 5;
/** 累计位移阈值（px）：防止手抖或微调触发。 */
const MIN_DISTANCE = 48;
/** 方向反转次数阈值：来回至少要 3 次。 */
const MIN_REVERSALS = 3;
/** 两次放大之间的冷却（毫秒），避免连续晃动把动画抖成频闪。 */
const COOLDOWN_MS = 1500;
/** 单次放大持续时间（毫秒），与 cursor.pulseCursor 的默认值保持一致。 */
const PULSE_MS = 1200;
/** 相邻采样点的最小水平位移（px）：小于它不参与方向判定（噪声）。 */
const NOISE_X = 2;

const ENABLED_KEY = "mouse.shakeToFind";

/** 最近采样点：[{x, y, t}]，只保留一个窗口的长度。 */
let samples = [];
// 初值取 -Infinity：页面刚加载时 performance.now() 还小于冷却期，
// 用 0 会让「第一次晃动」必然被 Cooldown 挡掉（真机实测踩到过）。
let lastPulseAt = -Infinity;
let bound = false;

/**
 * 记录一次指针移动，并在满足条件时触发放大。
 * @param {PointerEvent} event 指针移动事件
 * @returns {void}
 */
function onPointerMove(event) {
    // 触屏没有"指针"概念，晃手指不等于找指针，跳过。
    if (event.pointerType === "touch") return;
    const now = event.timeStamp || performance.now();
    samples.push({ x: event.clientX, y: event.clientY, t: now });
    while (samples.length && now - samples[0].t > WINDOW_MS) samples.shift();
    if (samples.length < MIN_SAMPLES) return;

    let distance = 0;
    let reversals = 0;
    let lastDir = 0;
    for (let i = 1; i < samples.length; i += 1) {
        const dx = samples[i].x - samples[i - 1].x;
        const dy = samples[i].y - samples[i - 1].y;
        distance += Math.abs(dx) + Math.abs(dy);
        if (Math.abs(dx) < NOISE_X) continue;
        const dir = dx > 0 ? 1 : -1;
        if (lastDir && dir !== lastDir) reversals += 1;
        lastDir = dir;
    }
    if (distance < MIN_DISTANCE || reversals < MIN_REVERSALS) return;

    if (now - lastPulseAt < COOLDOWN_MS) return;
    lastPulseAt = now;
    samples = [];
    pulseCursor(PULSE_MS);
}

/** 当前是否启用：设置缺失时按默认开启处理（与 defineMany 的默认值一致）。 */
function isEnabled() {
    return settings.get(ENABLED_KEY, true) !== false;
}

/**
 * 启动模块：绑定一次全局 pointermove（幂等），并订阅设置变化。
 * @returns {void}
 */
export function initPointerShake() {
    if (bound) return;
    bound = true;
    // 供浏览器自检确认模块已就位（不影响运行时行为）
    globalThis.__pointerShakeReady = true;
    window.addEventListener("pointermove", (event) => {
        if (!isEnabled()) return;
        onPointerMove(event);
    }, { passive: true });
    settings.subscribe((detail) => {
        if (detail && detail.key === ENABLED_KEY) samples = [];
    });
}
