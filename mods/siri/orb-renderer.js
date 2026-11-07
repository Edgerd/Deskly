/**
 * orb-renderer.js — Siri 光球的呈现层（Canvas 2D）。
 *
 * 为什么换掉上一版 WebGL 渲染 + 泛光后期链路（四处缺陷都来自那条链路）：
 *   1. 边缘阶梯：场景先渲进非多重采样的离屏目标，MSAA 只作用于默认帧缓冲，
 *      最后一趟全屏合成把球体轮廓按设备像素硬切；调尺寸时又用 CSS 像素覆盖了
 *      按 dpr 建的目标，等于二次放大。
 *   2. 同心环：泛光的有限 mip 链 + 菲涅尔阈值 + 六片加色光带在相近半径处收边，
 *      8 位帧缓冲把连续衰减量化成一圈圈台阶。
 *   3. 核心过曝：6 片加色光带 + 核心球 + 辉光球 + 泛光叠加，亮度轻易超过 1.0 被钳白，
 *      菲涅尔项再乘 1.15~1.9，白团吃掉青紫。
 *   4. 光晕像盖章：泛光最外一圈衰减到阈值就截断；CSS 那层径向压层又带明确停点，
 *      两者叠出一个有边界的圆盘。
 *
 * 本模块的做法（每条都对应上面的根因）：
 *   1. 圆完全由逐像素径向渐变生成，没有任何路径裁切边；canvas 按 dpr 建缓冲、CSS
 *      缩回，1 CSS 像素 = dpr 个设备像素，分辨率够就没有像素阶梯。
 *   2. 大面积渐变一律由密集停点线性插值生成，再叠 ±1.5/255 的确定性随机抖动（dither），
 *      量化台阶被噪声打散，不靠"多叠几层渐变"。
 *   3. 青 / 蓝 / 紫 / 粉四个色相源按极坐标锚在球内不同方位（外加一个低 alpha 紫罗兰补位），
 *      普通透明叠加后各占一片，中心自然混成蓝紫，不再整颗一个紫。
 *   4. 球体底色在 0.80R 之后转近白、0.86R 起 alpha 归零；外圈是 28 停点的近白柔光。
 *      边缘由亮到透明连续化开，过渡带里没有比背景更暗的像素，也没有环状几何。
 *   5. 高光是左上拉长的椭圆柔光（0.42R × 0.12R）+ 更小的热核，不是单点白。
 *
 * 结构：ORB_THEME / buildXxxStops / buildFrameModel / geometryFor 是纯计算，可在 Node
 * 中直接 import 做量化；OrbRenderer 只负责把计算结果画进 canvas。调参只改 ORB_THEME。
 *
 * 性能：每帧只有 1 次底图 drawImage + 5 次精灵 drawImage + 1 次遮罩 + 1 次高光层，
 * 帧率封顶 30fps，面板关闭即停；所有动画都在 canvas 内部，DOM 层只有 opacity 过渡，
 * 不给任何可能带 backdrop-filter 的元素加 transform。
 */

const TAU = Math.PI * 2;

/* ─────────────────────────── 可调参数（唯一事实来源） ─────────────────────────── */

/**
 * 球体底色：中蓝紫底，越靠外越亮；0.80R 之后进入近白过渡，0.86R 起 alpha 化开。
 * 关键：过渡带里的颜色全部 ≥ 面板浅色背景，边缘不再收暗，
 * 也不会出现比背景更暗的深色壳。
 */
const BASE_RAMP = [
  [0.00, [46, 30, 104], 1.00],
  [0.40, [58, 38, 132], 1.00],
  [0.66, [96, 68, 176], 1.00],
  [0.80, [170, 160, 232], 1.00],
  [0.86, [246, 248, 255], 0.78],
  [0.92, [246, 248, 255], 0.40],
  [1.00, [246, 248, 255], 0.00],
];

/** 流体色块自身的 alpha 轮廓：中心实、边缘平滑到 0，避免任何精灵边界。 */
const BLOB_PROFILE = [
  [0.00, 1.00], [0.28, 0.92], [0.48, 0.74],
  [0.64, 0.50], [0.78, 0.28], [0.90, 0.10], [1.00, 0.00],
];

/** 左上柔光与核心高光轮廓。 */
const SHEEN_PROFILE = [
  [0.00, 1.00], [0.35, 0.62], [0.60, 0.28], [0.80, 0.08], [1.00, 0.00],
];
const SPECULAR_PROFILE = [
  [0.00, 1.00], [0.22, 0.88], [0.45, 0.50], [0.68, 0.16], [1.00, 0.00],
];

export const ORB_THEME = Object.freeze({
  /* 几何：全部相对面板边长（0..1）。body 直径 = 0.60 × 面板，120px 面板下为 72px */
  bodyRadius: 0.30,
  bodyFadeStart: 0.86,   // 球体 alpha 从 0.86R 开始化开，过渡带 0.14R
  haloRadius: 0.47,      // 光晕外沿 < 0.5，保证在画布内自然衰减到 0
  backdropRadius: 0.50,
  blobSpriteRadius: 0.55, // 精灵半径 / 球体半径；配合 0.44R 的色相锚点，各占一片

  /* 分辨率与节奏 */
  maxPixelRatio: 3,
  spriteResolution: 256,     // 色块精灵固定分辨率，与面板尺寸解耦，调尺寸不重建
  frameInterval: 1000 / 30,  // 30fps：常驻浮层，够顺滑也够省电
  ditherSeed: 0x51f15e,      // 固定种子：抖动可复现
  ditherLevels: 1.6,         // 每通道 ±1.6/255，刚好打散 8 位台阶

  /* 压层：第三版取消深色压层，避免球后出现比背景更暗的圆盘（alpha 0 时整层不画） */
  backdrop: { alpha: 0.0, falloff: 1.6, stops: 24 },
  /* 外圈光晕：近白青 → 近白紫的柔光，峰值每通道只比纯白低 3~4 级 */
  halo: {
    alpha: 0.16, falloff: 2.4, stops: 28,
    inner: [232, 243, 255], outer: [246, 238, 255],
  },
  /* 流动层边缘淡出：0.70R 内实心，0.86R 完全淡出，露出底色的近白亮边 */
  flowMask: { solid: 0.70, fade: 0.86 },
  /* 高光：左上拉长的椭圆柔光 + 更小的热核（不再是单点白） */
  sheen: {
    dx: -0.30, dy: -0.30, rx: 0.42, ry: 0.12, rotation: -0.60,
    alpha: 0.38, color: [232, 244, 255],
  },
  specular: { dx: -0.20, dy: -0.36, radius: 0.085, alpha: 0.88, color: [255, 255, 255] },

  /**
   * 流体色块：普通透明叠加（不是加色），四个色相源按极坐标锚在球内不同方位，
   * 每个色相在自己一侧占主导，中心再自然混成蓝紫；最后一项紫罗兰补位。
   * angle 是屏幕坐标弧度（y 向下），radius 是圆心偏移 / 球体半径。
   */
  blobs: [
    { color: [186, 96, 255], alpha: 0.28, angle: Math.PI, radius: 0.34, orbit: 0.30, speed: 0.18, phase: 0.60, pulse: 0.90 },
    { color: [30, 205, 255], alpha: 0.62, angle: -2.36, radius: 0.44, orbit: 0.28, speed: 0.30, phase: 0.00, pulse: 1.05 },
    { color: [40, 110, 255], alpha: 0.62, angle: -0.50, radius: 0.45, orbit: 0.30, speed: 0.24, phase: 1.30, pulse: 0.95 },
    { color: [160, 55, 255], alpha: 0.62, angle: 2.30, radius: 0.45, orbit: 0.30, speed: 0.22, phase: 2.50, pulse: 1.00 },
    { color: [255, 62, 150], alpha: 0.62, angle: 0.78, radius: 0.43, orbit: 0.32, speed: 0.28, phase: 3.70, pulse: 1.10 },
  ],
});

/* ─────────────────────────── 纯计算：停点表 / 几何 / 每帧模型 ─────────────────────────── */

function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

function rgba(color, alpha) {
  return `rgba(${Math.round(color[0])}, ${Math.round(color[1])}, ${Math.round(color[2])}, ${alpha.toFixed(4)})`;
}

function mixColor(from, to, k) {
  return [
    from[0] + (to[0] - from[0]) * k,
    from[1] + (to[1] - from[1]) * k,
    from[2] + (to[2] - from[2]) * k,
  ];
}

/**
 * 在 [offset, color, alpha] 折线上按 t 线性取样。
 * @param {Array<[number, number[], number]>} ramp
 * @param {number} t 0..1
 * @returns {[number[], number]} 颜色与 alpha
 */
function sampleRamp(ramp, t) {
  for (let i = 1; i < ramp.length; i++) {
    if (t <= ramp[i][0] || i === ramp.length - 1) {
      const a = ramp[i - 1];
      const b = ramp[i];
      const span = b[0] - a[0] || 1;
      const k = Math.min(1, Math.max(0, (t - a[0]) / span));
      return [mixColor(a[1], b[1], k), a[2] + (b[2] - a[2]) * k];
    }
  }
  return [ramp[ramp.length - 1][1], ramp[ramp.length - 1][2]];
}

/** 在 [offset, alpha] 折线上按 t 线性取样。 */
function sampleProfile(profile, t) {
  for (let i = 1; i < profile.length; i++) {
    if (t <= profile[i][0] || i === profile.length - 1) {
      const a = profile[i - 1];
      const b = profile[i];
      const span = b[0] - a[0] || 1;
      const k = Math.min(1, Math.max(0, (t - a[0]) / span));
      return a[1] + (b[1] - a[1]) * k;
    }
  }
  return 0;
}

/** 球体底色停点（29 个，最大相邻色差可量化）。 */
export function buildBaseStops(steps = 28) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const [color, alpha] = sampleRamp(BASE_RAMP, t);
    out.push({ offset: t, color: rgba(color, alpha) });
  }
  return out;
}

/** 压层停点：中心 0.55，按 falloff 幂函数衰减到 0。 */
export function buildBackdropStops() {
  const { alpha, falloff, stops } = ORB_THEME.backdrop;
  const out = [];
  for (let i = 0; i <= stops; i++) {
    const t = i / stops;
    out.push({ offset: t, color: rgba([6, 4, 16], alpha * Math.pow(1 - t, falloff)) });
  }
  return out;
}

/** 外圈光晕停点：球体半径处最强，向外幂函数衰减；glow=false 时整层 alpha 为 0。 */
export function buildHaloStops(glow = true) {
  const { alpha, falloff, stops, inner, outer } = ORB_THEME.halo;
  const edgeT = ORB_THEME.bodyRadius / ORB_THEME.haloRadius;
  const peak = glow ? alpha : 0;
  const out = [];
  for (let i = 0; i <= stops; i++) {
    const t = i / stops;
    const a = t <= edgeT ? peak : peak * Math.pow(1 - (t - edgeT) / (1 - edgeT), falloff);
    out.push({ offset: t, color: rgba(mixColor(inner, outer, t), a) });
  }
  return out;
}

/** 色块精灵停点：纯色 + alpha 轮廓。 */
export function buildBlobStops(color, steps = 18) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({ offset: t, color: rgba(color, sampleProfile(BLOB_PROFILE, t)) });
  }
  return out;
}

export function buildSheenStops(color = ORB_THEME.sheen.color, steps = 14) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({ offset: t, color: rgba(color, sampleProfile(SHEEN_PROFILE, t) * ORB_THEME.sheen.alpha) });
  }
  return out;
}

export function buildSpecularStops(color = ORB_THEME.specular.color, steps = 12) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({ offset: t, color: rgba(color, sampleProfile(SPECULAR_PROFILE, t) * ORB_THEME.specular.alpha) });
  }
  return out;
}

/**
 * 面板尺寸 / dpr → 设备像素几何。所有绘制都在这套设备像素里完成，CSS 只负责缩回。
 * @param {number} size 面板 CSS 边长
 * @param {number} dpr 设备像素比
 */
export function geometryFor(size, dpr) {
  const deviceSize = Math.max(2, Math.round(size * dpr));
  return Object.freeze({
    size,
    dpr,
    deviceSize,
    cx: deviceSize / 2,
    cy: deviceSize / 2,
    bodyR: deviceSize * ORB_THEME.bodyRadius,
    haloR: deviceSize * ORB_THEME.haloRadius,
    backdropR: deviceSize * ORB_THEME.backdropRadius,
    bodyDiameterCss: size * ORB_THEME.bodyRadius * 2,
    haloDiameterCss: size * ORB_THEME.haloRadius * 2,
    // 边缘过渡带：球体最后 (1 - bodyFadeStart) 段半径 alpha 1→0
    bodyFadeCss: size * ORB_THEME.bodyRadius * (1 - ORB_THEME.bodyFadeStart),
    bodyFadeDevice: deviceSize * ORB_THEME.bodyRadius * (1 - ORB_THEME.bodyFadeStart),
  });
}

/**
 * 每个色块当前的位置 / 尺度 / 透明度。纯数据，方便在 Node 里复现同一帧。
 * 位置用极坐标：色相锚点固定在各自方位，只让角度小幅摆动、半径轻微呼吸，
 * 因此色相分区始终存在，只是缓慢流动。
 * @param {number} timeSeconds 秒
 * @returns {Array<object>}
 */
export function buildFrameModel(timeSeconds) {
  return ORB_THEME.blobs.map((def, index) => {
    const m = timeSeconds * def.speed + def.phase;
    const angle = def.angle + Math.sin(m * 0.9 + 1.1) * def.orbit;
    const radius = def.radius * (1 + Math.sin(m * 0.65 + 2.0) * 0.10);
    return {
      index,
      nx: Math.cos(angle) * radius,
      ny: Math.sin(angle) * radius,
      scale: def.scale || (1 + Math.sin(m * def.pulse + 1.7) * 0.07),
      alpha: def.alpha,
    };
  });
}

/* ─────────────────────────── 绘制 ─────────────────────────── */

function prefersReducedMotion() {
  if (typeof document === "undefined") return false;
  if (document.documentElement && document.documentElement.getAttribute("data-reduce-motion") === "on") return true;
  return !!(typeof window !== "undefined" && window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

function paintRadial(ctx, cx, cy, radius, stops) {
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  stops.forEach((stop) => gradient.addColorStop(stop.offset, stop.color));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.fill();
}

/** 旋转椭圆径向渐变：把单位圆画进 (rx, ry) 的缩放坐标系，得到一个拉长的柔光。 */
function paintEllipseRadial(ctx, cx, cy, rx, ry, rotation, stops) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  ctx.scale(rx, ry);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  stops.forEach((stop) => gradient.addColorStop(stop.offset, stop.color));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, TAU);
  ctx.fill();
  ctx.restore();
}

export class OrbRenderer {
  /**
   * @param {HTMLCanvasElement} canvas 面板里的 canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.size = 120;
    this.dpr = 1;
    this.geo = null;
    this.glow = true;
    this.baseCanvas = null;
    this.overlayCanvas = null;
    this.flowCanvas = null;
    this.blobSprites = [];
    this.raf = null;
    this.t0 = 0;
    this.lastAt = -Infinity;
    this.lastTime = 0;
  }

  /**
   * 按面板边长重建所有与分辨率相关的图层。色块精灵固定 256px，不随尺寸重建。
   * @param {number} size 面板 CSS 边长
   * @param {boolean} [glow] 是否画外圈光晕
   */
  configure(size, glow = this.glow) {
    this.size = Math.max(1, Math.round(Number(size) || 120));
    this.glow = glow !== false;
    this.dpr = Math.min(
      ORB_THEME.maxPixelRatio,
      Math.max(1, (typeof window !== "undefined" && window.devicePixelRatio) || 1)
    );
    this.geo = geometryFor(this.size, this.dpr);

    const device = this.geo.deviceSize;
    this.canvas.width = device;
    this.canvas.height = device;

    this._buildBase();
    this._buildOverlay();
    if (!this.blobSprites.length) this._buildBlobs();
    if (!this.flowCanvas) {
      this.flowCanvas = document.createElement("canvas");
      this.flowCtx = this.flowCanvas.getContext("2d");
    }
    this.flowCanvas.width = device;
    this.flowCanvas.height = device;

    this.render(this.lastTime);
  }

  /** 压层（可选）+ 外圈光晕 + 球体底色，一次烘焙；尺寸或辉光开关变化时才重建。 */
  _buildBase() {
    const { deviceSize, cx, cy, bodyR, haloR, backdropR } = this.geo;
    const canvas = document.createElement("canvas");
    canvas.width = deviceSize;
    canvas.height = deviceSize;
    const ctx = canvas.getContext("2d");

    // 1) 压层：第三版默认不画，避免球后出现比背景更暗的圆盘
    if (ORB_THEME.backdrop.alpha > 0) {
      paintRadial(ctx, cx, cy, backdropR, buildBackdropStops());
    }

    // 2) 外圈光晕：单条大半径近白柔光，辉光关闭时整层不画
    if (this.glow) paintRadial(ctx, cx, cy, haloR, buildHaloStops(true));

    // 3) 球体底色：0.80R 后转近白，0.86R 起 alpha 淡出，与光晕衔接
    paintRadial(ctx, cx, cy, bodyR, buildBaseStops());

    this._dither(ctx, deviceSize, deviceSize);
    this.baseCanvas = canvas;
  }

  /** 左上椭圆柔光 + 更小的白色热核高光。 */
  _buildOverlay() {
    const { deviceSize, cx, cy, bodyR } = this.geo;
    const canvas = document.createElement("canvas");
    canvas.width = deviceSize;
    canvas.height = deviceSize;
    const ctx = canvas.getContext("2d");

    const sheen = ORB_THEME.sheen;
    paintEllipseRadial(
      ctx,
      cx + sheen.dx * bodyR,
      cy + sheen.dy * bodyR,
      bodyR * sheen.rx,
      bodyR * sheen.ry,
      sheen.rotation,
      buildSheenStops()
    );
    const spec = ORB_THEME.specular;
    paintRadial(
      ctx,
      cx + spec.dx * bodyR,
      cy + spec.dy * bodyR,
      bodyR * spec.radius,
      buildSpecularStops()
    );

    this._dither(ctx, deviceSize, deviceSize);
    this.overlayCanvas = canvas;
  }

  /** 一次性烘焙每个色块的软边精灵；固定分辨率，尺寸变化只改绘制大小。 */
  _buildBlobs() {
    const res = ORB_THEME.spriteResolution;
    this.blobSprites = ORB_THEME.blobs.map((def) => {
      const canvas = document.createElement("canvas");
      canvas.width = res;
      canvas.height = res;
      const ctx = canvas.getContext("2d");
      paintRadial(ctx, res / 2, res / 2, res / 2, buildBlobStops(def.color));
      this._dither(ctx, res, res);
      return canvas;
    });
  }

  /**
   * 确定性随机抖动：逐像素给 RGBA 加 ±ditherLevels（8 位），把渐变台阶打散。
   * 只在烘焙时跑，每帧不碰像素；种子固定，同一版本渲染结果可复现。
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} width
   * @param {number} height
   */
  _dither(ctx, width, height) {
    const image = ctx.getImageData(0, 0, width, height);
    const data = image.data;
    const amplitude = ORB_THEME.ditherLevels;
    let seed = ORB_THEME.ditherSeed;
    const nextNoise = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (((seed >>> 8) & 3) - 1.5) * amplitude;
    };
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      data[i] = clampByte(data[i] + nextNoise());
      data[i + 1] = clampByte(data[i + 1] + nextNoise());
      data[i + 2] = clampByte(data[i + 2] + nextNoise());
      data[i + 3] = clampByte(data[i + 3] + nextNoise());
    }
    ctx.putImageData(image, 0, 0);
  }

  /**
   * 画一帧。全部是 drawImage 与一次遮罩，无逐像素读写。
   * @param {number} timeSeconds 动画时间（秒）
   */
  render(timeSeconds) {
    const geo = this.geo;
    if (!geo || !this.baseCanvas || !this.ctx || !this.flowCtx) return;
    this.lastTime = timeSeconds;

    const ctx = this.ctx;
    const device = geo.deviceSize;
    ctx.clearRect(0, 0, device, device);
    ctx.drawImage(this.baseCanvas, 0, 0);

    // 流体层单独画，方便用 destination-in 把边缘淡出，不在主画布上误伤压层
    const flow = this.flowCtx;
    flow.clearRect(0, 0, device, device);
    flow.globalAlpha = 1;
    flow.globalCompositeOperation = "source-over";

    for (const item of buildFrameModel(timeSeconds)) {
      flow.globalAlpha = item.alpha;
      const side = geo.bodyR * 2 * ORB_THEME.blobSpriteRadius * item.scale;
      flow.drawImage(
        this.blobSprites[item.index],
        geo.cx + item.nx * geo.bodyR - side / 2,
        geo.cy + item.ny * geo.bodyR - side / 2,
        side,
        side
      );
    }

    // 边缘淡出：0.70R 内实心，0.86R 归零；球外由 destination-in 一并清掉，
    // 外圈只留底色由近白到透明的过渡，不会出现深色描边
    flow.globalAlpha = 1;
    flow.globalCompositeOperation = "destination-in";
    const mask = flow.createRadialGradient(geo.cx, geo.cy, 0, geo.cx, geo.cy, geo.bodyR);
    const { solid, fade } = ORB_THEME.flowMask;
    mask.addColorStop(0, "rgba(0, 0, 0, 1)");
    mask.addColorStop(solid, "rgba(0, 0, 0, 1)");
    mask.addColorStop((solid + fade) / 2, "rgba(0, 0, 0, 0.55)");
    mask.addColorStop(fade, "rgba(0, 0, 0, 0)");
    flow.fillStyle = mask;
    flow.beginPath();
    flow.arc(geo.cx, geo.cy, geo.bodyR, 0, TAU);
    flow.fill();
    flow.globalCompositeOperation = "source-over";
    flow.globalAlpha = 1;

    ctx.drawImage(this.flowCanvas, 0, 0);
    ctx.drawImage(this.overlayCanvas, 0, 0);
  }

  /**
   * 启动循环：30fps 封顶；系统「减少动态效果」时只画一帧静态画面。
   * 面板关闭由 stop() 立刻停表，没有隐藏状态下的空转。
   */
  start() {
    this.stop();
    this.t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    this.lastAt = -Infinity;
    if (prefersReducedMotion()) {
      this.render(0.6);
      return;
    }
    const tick = (now) => {
      this.raf = requestAnimationFrame(tick);
      if (now - this.lastAt < ORB_THEME.frameInterval) return;
      this.lastAt = now;
      this.render((now - this.t0) / 1000);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** 停表并取消已排队的帧。 */
  stop() {
    if (this.raf != null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  /**
   * 跨显示器拖动后 devicePixelRatio 可能变化：需要时按新 dpr 重建一次。
   * 尺寸不变、dpr 不变时什么都不做，避免每次打开都重新烘焙。
   */
  syncPixelRatio() {
    if (!this.geo) return;
    const dpr = Math.min(
      ORB_THEME.maxPixelRatio,
      Math.max(1, (typeof window !== "undefined" && window.devicePixelRatio) || 1)
    );
    if (dpr !== this.geo.dpr) this.configure(this.size, this.glow);
  }

  /**
   * 辉光开关：只重建底图（光晕是否烘焙），精灵与流动层不动。
   * @param {boolean} on
   */
  setGlow(on) {
    const next = on !== false;
    if (next === this.glow) return;
    this.glow = next;
    if (!this.geo) return;
    this._buildBase();
    this.render(this.lastTime);
  }

  /** 释放画布缓冲与精灵引用；下次打开由 script.js 重新构造。 */
  dispose() {
    this.stop();
    this.blobSprites = [];
    this.baseCanvas = null;
    this.overlayCanvas = null;
    this.flowCanvas = null;
    this.flowCtx = null;
    this.geo = null;
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
    this.canvas = null;
    this.ctx = null;
  }
}
