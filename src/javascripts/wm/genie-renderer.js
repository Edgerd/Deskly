/**
 * wm/genie-renderer.js — 神奇效果的逐像素渲染层
 *
 * 首选 WebGL2：快照只上传一次纹理，片元着色器按逆映射逐像素采样，
 * 边缘用屏幕空间导数做一像素抗锯齿，不再有 Canvas 2D 条带的阶梯。
 * 没有 WebGL2（或纹理上传被跨域资源污染）时退回 Canvas 2D 细条带。
 *
 * 两种后端都只画在独立覆盖层上，绝不触碰真实窗口的 transform / filter。
 */

import { Z } from "../zindex.js";
import { genieBands, genieParams, GENIE_FADE_PX } from "./genie-geometry.js";

const DPR_MAX = 2;
/** 多窗降级时的覆盖层采样上限：只降像素密度，材质与位移曲线完全不变，观感连续。 */
const DPR_LOW = 1.25;
/**
 * 覆盖层采样上限。窗口超过 5 个时 GPU 与主线程都在抢资源，这里把分辨率降一档；
 * 因为降级只影响清晰度、不影响材质透明度曲线，所以不会出现「突然不模糊」的跳变。
 */
function dprCap() {
  const count = document.querySelectorAll(".window").length;
  return count > 5 ? DPR_LOW : DPR_MAX;
}

const VERT = `#version 300 es
precision highp float;
uniform vec2 u_viewport;
out vec2 v_css;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  v_css = vec2(p.x, 1.0 - p.y) * u_viewport;
}
`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_snap;
uniform vec4 u_rect;
uniform vec2 u_gather;
uniform float u_axis;
uniform float u_dir;
uniform float u_dock_line;
uniform float u_dist_sign;
uniform float u_travel;
uniform float u_translation;
uniform float u_pinch;
uniform float u_pour;
uniform float u_fade;
in vec2 v_css;
out vec4 outColor;

float pinchScale(float f) {
  return 0.51 - 0.49 * cos(3.141592653589793 * clamp(f, 0.0, 1.0));
}

void main() {
  float along;
  float across;
  float rawF;
  float sc;

  if (u_axis < 0.5) {
    along = v_css.y - u_translation;
    rawF = (along - u_dock_line) * u_dist_sign / u_travel;
    sc = u_pour > 0.0
      ? pinchScale(rawF - u_pour)
      : 1.0 + (pinchScale(rawF) - 1.0) * u_pinch;
    across = u_gather.x + (v_css.x - u_gather.x) / sc;
  } else {
    along = v_css.x - u_translation * u_dir;
    rawF = (along - u_dock_line) * u_dist_sign / u_travel;
    sc = u_pour > 0.0
      ? pinchScale(rawF - u_pour)
      : 1.0 + (pinchScale(rawF) - 1.0) * u_pinch;
    across = u_gather.y + (v_css.y - u_gather.y) / sc;
  }

  vec2 src = u_axis < 0.5 ? vec2(across, along) : vec2(along, across);
  vec2 uv = (src - u_rect.xy) / u_rect.zw;
  vec2 edge = min(uv, 1.0 - uv);
  vec2 deriv = max(fwidth(uv), vec2(1e-5));
  float cover = clamp(min(edge.x / deriv.x, edge.y / deriv.y), 0.0, 1.0);

  float dist = (rawF - u_pour) * u_travel;
  float fade = dist < 0.0 ? 1.0 - clamp(-dist / u_fade, 0.0, 1.0) : 1.0;
  float mask = cover * fade;
  vec4 tex = texture(u_snap, clamp(uv, 0.0, 1.0));
  outColor = tex * mask;
}
`;

function overlayCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, dprCap());
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
  canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
  const style = canvas.style;
  style.position = "fixed";
  style.left = "0";
  style.top = "0";
  style.width = "100vw";
  style.height = "100vh";
  style.pointerEvents = "none";
  style.zIndex = String(Z.GENIE);
  // 只改 opacity：compositor 层做，不触发重排/重绘；动画结束由 dispose 立刻撤掉。
  style.opacity = "0";
  style.willChange = "opacity";
  document.body.appendChild(canvas);
  return { canvas, dpr };
}

function shader(gl, type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Genie shader: ${log || "unknown"}`);
  }
  return s;
}

function createWebGL(canvas, model, snap) {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  let program = null;
  let tex = null;
  let vao = null;
  let vs = null;
  let fs = null;
  let contextLost = false;
  const u = {};
  // GPU 重置会让 canvas 静默变黑：立刻标记失效，由 play() 终止动画并走兜底，
  // 而不是把一整段黑帧播给用户。
  const onContextLost = (e) => {
    e.preventDefault();
    contextLost = true;
  };
  canvas.addEventListener("webglcontextlost", onContextLost, false);
  try {
    program = gl.createProgram();
    vs = shader(gl, gl.VERTEX_SHADER, VERT);
    fs = shader(gl, gl.FRAGMENT_SHADER, FRAG);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    vs = null;
    fs = null;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Genie link: ${gl.getProgramInfoLog(program) || "unknown"}`);
    }
    gl.useProgram(program);
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // 圆角/抗锯齿边缘的 RGB 与 alpha 一起预乘，mipmap 滤波才不会渗出黑边。
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension("EXT_texture_filter_anisotropic")
      || gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (aniso) {
      // 窗口只被横向压缩：异向过滤按方向取 mip，不会把没缩放的纵向文字一起糊掉。
      gl.texParameterf(
        gl.TEXTURE_2D,
        aniso.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1),
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }

    for (const name of [
      "u_snap", "u_rect", "u_gather", "u_axis", "u_dir", "u_dock_line",
      "u_dist_sign", "u_travel", "u_translation", "u_pinch", "u_pour",
      "u_fade", "u_viewport",
    ]) {
      u[name] = gl.getUniformLocation(program, name);
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform1i(u.u_snap, 0);
    gl.uniform2f(u.u_viewport, window.innerWidth, window.innerHeight);
    gl.uniform4f(u.u_rect, model.rect.x, model.rect.y, model.rect.w, model.rect.h);
    gl.uniform2f(u.u_gather, model.gather.x, model.gather.y);
    gl.uniform1f(u.u_axis, model.axis === "v" ? 0 : 1);
    gl.uniform1f(u.u_dir, model.dir);
    gl.uniform1f(u.u_dock_line, model.dockLine);
    gl.uniform1f(u.u_dist_sign, model.distSign);
    gl.uniform1f(u.u_travel, model.travel);
    gl.uniform1f(u.u_fade, GENIE_FADE_PX);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
  } catch {
    // 先删已创建的着色器再删程序：VS 编译成功、FS 编译失败时不能漏掉 VS。
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    if (vao) gl.deleteVertexArray(vao);
    if (program) gl.deleteProgram(program);
    if (tex) gl.deleteTexture(tex);
    canvas.removeEventListener("webglcontextlost", onContextLost, false);
    return null;
  }

  return {
    kind: "webgl",
    isLost: () => contextLost,
    draw(progress) {
      if (contextLost) return;
      const stage = genieParams(model, progress);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(u.u_translation, stage.translation);
      gl.uniform1f(u.u_pinch, stage.pinch);
      gl.uniform1f(u.u_pour, stage.pour);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", onContextLost, false);
      gl.deleteVertexArray(vao);
      gl.deleteTexture(tex);
      gl.deleteProgram(program);
    },
  };
}

function createCanvas2D(canvas, model, snap) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(canvas.width / window.innerWidth, 0, 0, canvas.height / window.innerHeight, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const sx = snap.width / model.rect.w;
  const sy = snap.height / model.rect.h;

  return {
    kind: "canvas2d",
    isLost: () => false,
    draw(progress) {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      for (const b of genieBands(model, progress)) {
        if (b.alpha <= 0 || b.dw <= 0.25 || b.dh <= 0.25) continue;
        ctx.globalAlpha = b.alpha;
        ctx.drawImage(
          snap,
          b.sx * sx, b.sy * sy, b.sw * sx, b.sh * sy,
          b.dx, b.dy, b.dw, b.dh,
        );
      }
      ctx.globalAlpha = 1;
    },
    dispose() {},
  };
}

/**
 * 建立一次动画的渲染舞台。
 * @param {object} model buildGenieModel 的产物
 * @param {HTMLCanvasElement} snap 窗口快照
 * @returns {{draw:Function,isLost:Function,dispose:Function,kind:string}}
 */
export function createGenieStage(model, snap) {
  let { canvas } = overlayCanvas();
  let backend = null;
  // 上一次写进样式的覆盖层不透明度：交接结束后它恒为 1，重复写没有意义。
  let lastOpacity = -1;

  const glCanvas = canvas;
  const glBackend = createWebGL(glCanvas, model, snap);
  if (glBackend) {
    backend = glBackend;
  } else {
    glCanvas.remove();
    canvas = overlayCanvas().canvas;
    backend = createCanvas2D(canvas, model, snap);
  }

  if (!backend) {
    canvas.remove();
    throw new Error("Genie renderer unavailable");
  }

  return {
    kind: backend.kind,
    isLost: backend.isLost,
    draw: backend.draw,
    setOpacity(value) {
      const v = Math.max(0, Math.min(1, value));
      // 交接结束后权重恒为 1：值没变就别再回写样式，省掉每帧一次无用的
      // 样式解析/失效（60fps 下这是 600ms 里的一大半帧）。
      if (v === lastOpacity) return;
      lastOpacity = v;
      canvas.style.opacity = String(v);
    },
    dispose() {
      backend.dispose();
      canvas.remove();
      // 显式归零，让 GPU/CPU 侧显存立刻可回收，而不是等 canvas 被 GC。
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}
