import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bandScale,
  buildGenieModel,
  genieBands,
  genieParams,
  genieSourceAt,
  GENIE_HANDOFF,
  GENIE_HANDOFF_MS,
  GENIE_MS,
  GENIE_STAGE_SPLIT,
  geomProgress,
  materialWeight,
  pinchScale,
} from "../src/javascripts/wm/genie-geometry.js";

const rect = { x: 140, y: 90, w: 480, h: 320 };

function close(actual, expected, epsilon = 1e-7) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
}

assert.equal(pinchScale(0), 0.020000000000000018);
assert.equal(pinchScale(1), 1);

for (const [side, gather] of [
  ["bottom", { x: 700, y: 760 }],
  ["left", { x: 64, y: 500 }],
  ["right", { x: 1200, y: 500 }],
]) {
  const model = buildGenieModel(rect, gather, side);
  assert.ok(model, side);
  const initial = genieBands(model, 0);
  const pinched = genieBands(model, GENIE_STAGE_SPLIT);
  const final = genieBands(model, 1);

  close(initial[0].dx, rect.x);
  close(initial[0].dy, rect.y);
  close(initial[0].dw, side === "bottom" ? rect.w : initial[0].sw);
  close(initial[0].dh, side === "bottom" ? initial[0].sh : rect.h);

  for (const band of [...initial, ...pinched, ...final]) {
    assert.ok(band.sx >= -1e-7 && band.sy >= -1e-7);
    assert.ok(band.sx + band.sw <= rect.w + 0.5 + 1e-7);
    assert.ok(band.sy + band.sh <= rect.h + 0.5 + 1e-7);
    assert.ok(band.dw > 0 && band.dh > 0);
    assert.ok(band.alpha >= 0 && band.alpha <= 1);
  }

  if (side === "bottom") {
    assert.ok(pinched.at(-1).dw < pinched[0].dw);
    close(pinched[0].dw, rect.w);
    close(final[0].dy, gather.y);
    close(final[0].dw, rect.w * pinchScale(0));
    assert.equal(final.at(-1).alpha, 0);
  } else {
    const near = side === "left" ? pinched[0] : pinched.at(-1);
    const far = side === "left" ? pinched.at(-1) : pinched[0];
    assert.ok(near.dh < far.dh);
    assert.ok(far.dh > rect.h * 0.99);
    const finalFar = side === "left" ? final.at(-1) : final[0];
    close(finalFar.dx + finalFar.dw / 2, gather.x, 5);
    assert.ok(finalFar.dh < rect.h * 0.03);
  }
}

for (const [side, gather] of [
  ["bottom", { x: 700, y: 760 }],
  ["left", { x: 64, y: 500 }],
  ["right", { x: 1200, y: 500 }],
]) {
  const model = buildGenieModel(rect, gather, side);
  for (const progress of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const stage = genieParams(model, progress);
    assert.ok(stage.pinch >= 0 && stage.pinch <= 1);
    assert.ok(stage.pour >= 0 && stage.pour <= 1);
    close(stage.translation, model.travel * stage.pour);
    assert.ok(genieBands(model, progress).length >= 12);

    for (const tx of [0.08, 0.5, 0.92]) {
      for (const ty of [0.08, 0.5, 0.92]) {
        const srcX = rect.x + rect.w * tx;
        const srcY = rect.y + rect.h * ty;
        const along = side === "bottom" ? srcY : srcX;
        const f0 = (along - model.dockLine) * model.distSign / model.travel;
        const sc = bandScale(model, f0, stage);
        const dstX = side === "bottom" ? gather.x + (srcX - gather.x) * sc : srcX + stage.translation * model.dir;
        const dstY = side === "bottom" ? srcY + stage.translation * model.dir : gather.y + (srcY - gather.y) * sc;
        const back = genieSourceAt(model, progress, dstX, dstY);
        close(back.x, srcX);
        close(back.y, srcY);
      }
    }
  }
}

assert.equal(buildGenieModel(rect, { x: 100, y: 80 }, "bottom"), null);
assert.equal(buildGenieModel({ ...rect, w: 4 }, { x: 100, y: 700 }, "bottom"), null);

// --- 着色器与 JS 同构性：genie-check 之前只跑 JS 侧，GLSL 漂移不会被任何测试抓到 ---
const rendererSrc = readFileSync(new URL("../src/javascripts/wm/genie-renderer.js", import.meta.url), "utf8");

assert.match(
  rendererSrc,
  /float\s+pinchScale\(float\s+f\)\s*\{\s*return\s+0\.51\s*-\s*0\.49\s*\*\s*cos\(\s*3\.141592653589793\s*\*\s*clamp\(\s*f\s*,\s*0\.0\s*,\s*1\.0\s*\)\s*\)\s*;\s*\}/,
  "GLSL pinchScale 表达式已漂移",
);
assert.match(
  rendererSrc,
  /sc\s*=\s*u_pour\s*>\s*0\.0\s*[\s\S]{0,40}?pinchScale\(\s*rawF\s*-\s*u_pour\s*\)[\s\S]{0,20}?:\s*1\.0\s*\+\s*\(\s*pinchScale\(\s*rawF\s*\)\s*-\s*1\.0\s*\)\s*\*\s*u_pinch\s*;/,
  "GLSL 两阶段分支已漂移（必须与 bandScale 同构）",
);
assert.match(
  rendererSrc,
  /float\s+dist\s*=\s*\(\s*rawF\s*-\s*u_pour\s*\)\s*\*\s*u_travel/,
  "GLSL 衰减距离语义已漂移",
);

// 把 GLSL 的表达式原样抄成 JS 做数值对拍（不是「看起来一样」）。
const shaderPinch = (f) => 0.51 - 0.49 * Math.cos(3.141592653589793 * Math.min(1, Math.max(0, f)));
for (const f of [-0.4, 0, 0.1, 0.25, 0.4, 0.55, 0.75, 1, 1.4]) {
  close(shaderPinch(f), pinchScale(f));
  close(bandScale(buildGenieModel(rect, { x: 700, y: 760 }, "bottom"), f, { pinch: 1, pour: 0, translation: 0 }), shaderPinch(f));
}

// --- 两阶段时间线：p=0 / 0.4 / 1 的具体值 + 0.4 处位置连续 ---
for (const side of ["bottom", "left", "right"]) {
  const model = buildGenieModel(rect, side === "left" ? { x: 64, y: 500 } : side === "right" ? { x: 1200, y: 500 } : { x: 700, y: 760 }, side);
  const p0 = genieParams(model, 0);
  close(p0.pinch, 0);
  close(p0.pour, 0);
  close(p0.translation, 0);

  const split = genieParams(model, GENIE_STAGE_SPLIT);
  close(split.pinch, 1);
  close(split.pour, 0);
  close(split.translation, 0);

  const p1 = genieParams(model, 1);
  close(p1.pinch, 1);
  close(p1.pour, 1);
  assert.equal(p1.translation, model.travel);

  // 阶段交界两侧不能跳位：p=0.4±ε 的首条带目标矩形必须只差像素级的量。
  const before = genieBands(model, GENIE_STAGE_SPLIT - 1e-4);
  const after = genieBands(model, GENIE_STAGE_SPLIT + 1e-4);
  for (let i = 0; i < before.length; i += 1) {
    assert.ok(Math.abs(before[i].dx - after[i].dx) < 0.5, `${side} #${i} dx 在阶段交界跳变`);
    assert.ok(Math.abs(before[i].dy - after[i].dy) < 0.5, `${side} #${i} dy 在阶段交界跳变`);
    assert.ok(Math.abs(before[i].dw - after[i].dw) < 0.5, `${side} #${i} dw 在阶段交界跳变`);
    assert.ok(Math.abs(before[i].dh - after[i].dh) < 0.5, `${side} #${i} dh 在阶段交界跳变`);
  }
}

// --- genieSourceAt 的 inside=false 分支 ---
{
  const model = buildGenieModel(rect, { x: 700, y: 760 }, "bottom");
  for (const progress of [0, GENIE_STAGE_SPLIT, 1]) {
    const outside = genieSourceAt(model, progress, rect.x - 40, rect.y + rect.h / 2);
    assert.equal(outside.inside, false, `p=${progress} 窗口左侧外像素应判为 outside`);
    const fadeOut = genieSourceAt(model, progress, rect.x + rect.w / 2, rect.y + rect.h + 80);
    assert.equal(fadeOut.inside, false, `p=${progress} 窗口下沿外像素应判为 outside`);
  }
  // 越界像素靠着色器的 cover 归零：源码必须保留这条边界裁剪。
  assert.match(rendererSrc, /float\s+cover\s*=\s*clamp\(\s*min\(\s*edge\.x\s*\/\s*deriv\.x\s*,\s*edge\.y\s*\/\s*deriv\.y\s*\)\s*,\s*0\.0\s*,\s*1\.0\s*\)/,
    "着色器丢失边界裁剪，越界像素会采样到快照外沿产生拖影");
}

// --- 材质交接：几何冻结 + 覆盖层不透明度连续爬升 ---
{
  const samples = Array.from({ length: 101 }, (_, i) => i / 100);
  let prev = 0;

  for (const p of samples) {
    const w = materialWeight(p);
    assert.ok(w >= 0 && w <= 1, `p=${p} 权重越界 ${w}`);
    // 必须单调不减：禁止阈值式切换
    assert.ok(w >= prev - 1e-9, `材质权重在 p=${p} 回退`);
    prev = w;
    const g = geomProgress(p);
    close(g, p <= GENIE_HANDOFF ? 0 : (p - GENIE_HANDOFF) / (1 - GENIE_HANDOFF));
  }

  // 交接段两端必须精确落在 0 / 1
  close(materialWeight(0), 0, 1e-9);
  close(materialWeight(GENIE_HANDOFF), 1, 1e-9);
  close(materialWeight(1), 1, 1e-9);
  close(geomProgress(0), 0, 1e-9);
  close(geomProgress(GENIE_HANDOFF), 0, 1e-9);
  close(geomProgress(1), 1, 1e-9);

  // 交接段内几何必须完全冻结：覆盖层与真窗同一像素，材质切换才看不出来
  const model = buildGenieModel(rect, { x: 700, y: 760 }, "bottom");
  const frozen = genieBands(model, 0);
  for (let p = 0; p <= GENIE_HANDOFF; p += 0.01) {
    const now = genieBands(model, geomProgress(p));
    for (let i = 0; i < now.length; i += 1) {
      close(now[i].dx, frozen[i].dx, 1e-9);
      close(now[i].dy, frozen[i].dy, 1e-9);
      close(now[i].dw, frozen[i].dw, 1e-9);
      close(now[i].dh, frozen[i].dh, 1e-9);
    }
  }

  // 真实帧节奏：60fps 一帧前进 16.7/GENIE_MS 个进度点，交接跨 5~6 帧。
  // 理论下限 1/5.6≈0.18（线性），对称 S 曲线中段最陡约 1.6 倍，取 0.45 作上限：
  // 超过它就意味着某一帧吃掉了大半变化，又回到阈值切换。
  const frameStep = 16.7 / GENIE_MS;
  let maxStep = 0;
  let blendedFrames = 0;
  const frameRows = [];
  for (let p = 0; p < GENIE_HANDOFF - 1e-9; p += frameStep) {
    const a = materialWeight(Math.min(p, GENIE_HANDOFF));
    const b = materialWeight(Math.min(p + frameStep, GENIE_HANDOFF));
    maxStep = Math.max(maxStep, b - a);
    if (b > 1e-6 && b < 1 - 1e-6) blendedFrames += 1;
    frameRows.push(`${Math.min(p + frameStep, GENIE_HANDOFF).toFixed(3)}→${b.toFixed(3)}`);
  }
  assert.ok(blendedFrames >= 4, `交接只有 ${blendedFrames} 帧中间态，等同阈值切换`);
  assert.ok(maxStep < 0.45, `交接单帧跳变 ${maxStep}，已接近一帧换完`);

  assert.equal(GENIE_HANDOFF_MS, Math.round(GENIE_MS * GENIE_HANDOFF));
  assert.ok(GENIE_HANDOFF_MS >= 70 && GENIE_HANDOFF_MS <= 130);

  const rows = [0, 0.02, 0.05, 0.09, 0.15, 0.3, 0.5, 0.75, 1].map((p) => {
    return `p=${p.toFixed(2)} 覆盖层不透明度 ${materialWeight(p).toFixed(3)} 几何 ${geomProgress(p).toFixed(3)}`;
  });
  console.log("genie material handoff: " + GENIE_HANDOFF_MS + "ms / " + GENIE_MS + "ms（几何冻结段）");
  for (const row of rows) console.log("  " + row);
  console.log("  handoff @60fps 覆盖层不透明度: " + frameRows.join(" "));
}

console.log("genie-check: three-way geometry, local sampling, inverse mapping, pinch, travel and fade passed");
