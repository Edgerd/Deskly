/**
 * editor.js — 照片编辑器（由照片预览工具栏动态 import）
 *
 * 一个纯本地的画布编辑器：旋转 / 翻转 / 居中裁剪（自由、1:1、4:3、16:9）/
 * 亮度对比饱和色温 / 六个滤镜预设 / 基于像素均值的自动增强；撤销栈 30 步、
 * 可恢复原始。导出时按裁剪后的全分辨率重画一遍再 toBlob，预览与导出共用
 * 同一条渲染管线，所见即所得。
 *
 * 保存有两条路，本体写入都由照片主模块完成：
 *   - 存储为副本：onSaved({ mode:"copy", ... })，主模块走 uniqueLibraryPath 落成新条目；
 *   - 存储到原稿：覆盖 putMedia(item.id) 前必须经系统弹窗确认（弹窗不可用时按钮
 *     进入「再点一次确认」的两段式武装态，绝不无确认覆盖）。
 */

import { i18n } from "../../src/javascripts/i18n.js";
import { getMedia } from "./photo-store.js";

/** 撤销栈深度：覆盖任务要求的 20 步（再留一点余量）。 */
const UNDO_LIMIT = 30;
// 缩略图导出边长上限（与照片主模块 THUMB_MAX_EDGE 同口径）
const THUMB_MAX_EDGE = 640;
/** 覆盖确认按钮的武装态超时（毫秒）。 */
const ARM_TIMEOUT_MS = 3000;

/** 取译文：随照片应用注册的语言包走，缺失时中文兜底。 */
function T(key, fallback) {
    return i18n.t(`photos.editor.${key}`, fallback); // i18n-dynamic-ok 键名集合与本文件 T() 调用点一一对应
}

/** 滤镜预设表：key -> CSS filter 片段。 */
const PRESETS = {
    none: "",
    vivid: "saturate(1.25) contrast(1.08)",
    warm: "sepia(0.22) saturate(1.1)",
    cool: "saturate(1.02) hue-rotate(-15deg) brightness(1.03)",
    mono: "grayscale(1)",
    drama: "contrast(1.35) saturate(0.8) brightness(0.95)",
};

/** 裁剪比例表：key -> 宽高比（free 为 null，表示不裁）。 */
const CROP_RATIOS = {
    free: null,
    "1:1": 1,
    "4:3": 4 / 3,
    "16:9": 16 / 9,
};

/** @returns {object} 全新编辑状态（原始态）。 */
function freshEdits() {
    return {
        rotate: 0, // 0 / 90 / 180 / 270
        flipH: false,
        flipV: false,
        crop: "free",
        preset: "none",
        adjust: { brightness: 100, contrast: 100, saturation: 100, temperature: 0 },
    };
}

/** 深拷贝一份编辑状态（撤销栈用）。 */
function cloneEdits(edits) {
    return {
        rotate: edits.rotate,
        flipH: edits.flipH,
        flipV: edits.flipV,
        crop: edits.crop,
        preset: edits.preset,
        adjust: { ...edits.adjust },
    };
}

/** 把调整参数 + 预设合成一条 canvas filter 字符串。 */
function filterString(edits) {
    const a = edits.adjust;
    const parts = [];
    if (a.brightness !== 100) parts.push(`brightness(${a.brightness}%)`);
    if (a.contrast !== 100) parts.push(`contrast(${a.contrast}%)`);
    if (a.saturation !== 100) parts.push(`saturate(${a.saturation}%)`);
    if (a.temperature > 0) parts.push(`sepia(${Math.min(60, a.temperature / 2)}%)`);
    if (a.temperature < 0) parts.push(`hue-rotate(${Math.max(-40, a.temperature / 2.5)}deg)`);
    if (edits.preset !== "none" && PRESETS[edits.preset]) parts.push(PRESETS[edits.preset]);
    return parts.join(" ") || "none";
}

/**
 * 计算居中裁剪矩形：在「旋转后的画布坐标系」里按比例取最大居中区域。
 * @param {number} width 旋转后画布宽
 * @param {number} height 旋转后画布高
 * @param {string} cropKey 裁剪比例键
 * @returns {{x:number,y:number,w:number,h:number}} 裁剪矩形
 */
function cropRectFor(width, height, cropKey) {
    const ratio = CROP_RATIOS[cropKey] || null;
    if (!ratio) return { x: 0, y: 0, w: width, h: height };
    let w = width;
    let h = width / ratio;
    if (h > height) {
        h = height;
        w = height * ratio;
    }
    return {
        x: Math.round((width - w) / 2),
        y: Math.round((height - h) / 2),
        w: Math.round(w),
        h: Math.round(h),
    };
}

/**
 * 打开编辑器。
 * @param {object} item 照片条目（type 必须是 image）
 * @param {object} handlers { onSaved({blob, thumbBlob, width, height, mode}) }
 * @returns {{close:Function}} 编辑器句柄
 */
export function openEditor(item, handlers = {}) {
    const win = document.querySelector(".photos.window");
    if (!win || !item || item.type === "video") return null;

    const overlay = document.createElement("div");
    overlay.className = "photo-editor";
    overlay.innerHTML = `
        <div class="pe-toolbar">
            <div class="pe-side">
                <button type="button" class="pe-btn pe-undo" disabled>${T("undo", "撤销")}</button>
                <button type="button" class="pe-btn pe-reset">${T("reset", "恢复原始")}</button>
            </div>
            <span class="pe-title"></span>
            <div class="pe-side">
                <button type="button" class="pe-btn pe-close">${T("close", "关闭")}</button>
            </div>
        </div>
        <div class="pe-stage"><canvas class="pe-canvas"></canvas><div class="pe-loading"></div></div>
        <div class="pe-panel">
            <div class="pe-row pe-row-crop">
                <span class="pe-label">${T("crop", "裁剪")}</span>
                <div class="pe-chips pe-crops"></div>
            </div>
            <div class="pe-row">
                <span class="pe-label">${T("preset", "滤镜")}</span>
                <div class="pe-chips pe-presets"></div>
            </div>
            <div class="pe-row pe-row-adjust">
                <span class="pe-label">${T("adjust", "调整")}</span>
                <div class="pe-sliders"></div>
            </div>
            <div class="pe-row">
                <button type="button" class="pe-btn pe-auto">${T("auto", "自动增强")}</button>
                <span class="pe-spacer"></span>
                <button type="button" class="pe-btn pe-armed">${T("saveOriginal", "存储到原稿")}</button>
                <button type="button" class="pe-btn pe-accent pe-copy">${T("saveCopy", "存储为副本")}</button>
            </div>
        </div>`;

    // 面板样式一次注入（与 usePaneStyle 同思路：按 id 复用，不随编辑器开关累积）
    ensureStyle();

    const canvas = overlay.querySelector(".pe-canvas");
    const loading = overlay.querySelector(".pe-loading");
    const titleEl = overlay.querySelector(".pe-title");
    const undoBtn = overlay.querySelector(".pe-undo");
    const resetBtn = overlay.querySelector(".pe-reset");
    const closeBtn = overlay.querySelector(".pe-close");
    const autoBtn = overlay.querySelector(".pe-auto");
    const armedBtn = overlay.querySelector(".pe-armed");
    const copyBtn = overlay.querySelector(".pe-copy");
    const cropsBox = overlay.querySelector(".pe-crops");
    const presetsBox = overlay.querySelector(".pe-presets");
    const slidersBox = overlay.querySelector(".pe-sliders");

    titleEl.textContent = item.name || "";
    loading.textContent = T("loading", "正在载入…");

    const edits = freshEdits();
    const undoStack = [];
    let image = null; // 原始 Image
    let busy = false;

    /* ── 渲染管线 ── */

    /** 按 edits 把图重画到给定画布（canvas 即显示画布，也复用为导出画布）。 */
    function renderTo(target) {
        const rot = ((edits.rotate % 360) + 360) % 360;
        const swap = rot === 90 || rot === 270;
        const outW = swap ? image.naturalHeight : image.naturalWidth;
        const outH = swap ? image.naturalWidth : image.naturalHeight;
        const rect = cropRectFor(outW, outH, edits.crop);
        target.width = Math.max(1, rect.w);
        target.height = Math.max(1, rect.h);
        const ctx = target.getContext("2d");
        ctx.clearRect(0, 0, target.width, target.height);
        ctx.filter = filterString(edits);
        ctx.save();
        // 第一步：把裁剪区平移到原点，再绕其中心做旋转/翻转
        ctx.translate(-rect.x, -rect.y);
        ctx.translate(rect.w / 2, rect.h / 2);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.scale(edits.flipH ? -1 : 1, edits.flipV ? -1 : 1);
        ctx.drawImage(image, -outW / 2, -outH / 2, outW, outH);
        ctx.restore();
        ctx.filter = "none";
        return rect;
    }

    function render() {
        if (!image) return;
        renderTo(canvas);
    }

    /** 全分辨率导出。 */
    function renderBlob(type, quality) {
        return new Promise((resolve, reject) => {
            const off = document.createElement("canvas");
            renderTo(off);
            off.toBlob((blob) => {
                if (blob) resolve(blob);
                else reject(new Error("toBlob 失败"));
            }, type, quality);
        });
    }

    /** 生成 640px 内的 JPEG 缩略图（网格与胶片条用）。 */
    async function renderThumbBlob() {
        const off = document.createElement("canvas");
        renderTo(off);
        const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(off.width, off.height, 1));
        const thumb = document.createElement("canvas");
        thumb.width = Math.max(1, Math.round(off.width * scale));
        thumb.height = Math.max(1, Math.round(off.height * scale));
        const ctx = thumb.getContext("2d");
        ctx.drawImage(off, 0, 0, thumb.width, thumb.height);
        return new Promise((resolve) => {
            thumb.toBlob((blob) => resolve(blob), "image/jpeg", 0.8);
        });
    }

    /* ── 撤销栈 ── */

    function pushUndo() {
        undoStack.push(JSON.stringify(edits));
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        undoBtn.disabled = false;
    }

    function applyUndo() {
        const snapshot = undoStack.pop();
        if (!snapshot) {
            undoBtn.disabled = true;
            return;
        }
        try {
            const restored = JSON.parse(snapshot);
            edits.rotate = restored.rotate || 0;
            edits.flipH = !!restored.flipH;
            edits.flipV = !!restored.flipV;
            edits.crop = CROP_RATIOS[restored.crop] ? restored.crop : "free";
            edits.preset = PRESETS[restored.preset] !== undefined ? restored.preset : "none";
            edits.adjust = { ...freshEdits().adjust, ...(restored.adjust || {}) };
        } catch { /* 快照损坏就当没撤销过 */ }
        undoBtn.disabled = undoStack.length === 0;
        syncChips();
        render();
    }

    /** 记录一步变更并重画。 */
    function mutate(patch) {
        pushUndo();
        patch();
        syncChips();
        render();
    }

    /* ── 控件 ── */

    function chip(label, active, onClick) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pe-chip";
        btn.textContent = label;
        btn.setAttribute("aria-pressed", active ? "true" : "false");
        btn.addEventListener("click", onClick);
        return btn;
    }

    function buildCropChips() {
        cropsBox.textContent = "";
        Object.keys(CROP_RATIOS).forEach((key) => {
            const labels = { free: T("cropFree", "自由"), "1:1": "1:1", "4:3": "4:3", "16:9": "16:9" };
            cropsBox.append(chip(labels[key] || key, edits.crop === key, () => {
                if (edits.crop === key) return;
                mutate(() => { edits.crop = key; });
            }));
        });
    }

    function buildPresetChips() {
        presetsBox.textContent = "";
        const labels = {
            none: T("pNone", "原图"), vivid: T("pVivid", "鲜明"), warm: T("pWarm", "暖调"),
            cool: T("pCool", "冷调"), mono: T("pMono", "单色"), drama: T("pDrama", "戏剧"),
        };
        Object.keys(PRESETS).forEach((key) => {
            presetsBox.append(chip(labels[key] || key, edits.preset === key, () => {
                if (edits.preset === key) return;
                mutate(() => { edits.preset = key; });
            }));
        });
    }

    function buildSliders() {
        slidersBox.textContent = "";
        const specs = [
            { key: "brightness", label: T("brightness", "亮度"), min: 50, max: 150 },
            { key: "contrast", label: T("contrast", "对比度"), min: 50, max: 150 },
            { key: "saturation", label: T("saturation", "饱和度"), min: 0, max: 200 },
            { key: "temperature", label: T("temperature", "色温"), min: -100, max: 100 },
        ];
        specs.forEach((spec) => {
            const wrap = document.createElement("div");
            wrap.className = "pe-slider-row";
            const name = document.createElement("span");
            name.className = "pe-slider-label";
            name.textContent = spec.label;
            const value = document.createElement("span");
            value.className = "pe-slider-value";
            value.textContent = String(edits.adjust[spec.key]);
            const input = document.createElement("input");
            input.type = "range";
            input.className = "pe-slider";
            input.min = String(spec.min);
            input.max = String(spec.max);
            input.step = "1";
            input.value = String(edits.adjust[spec.key]);
            input.setAttribute("aria-label", spec.label);
            input.addEventListener("input", () => {
                edits.adjust[spec.key] = Number(input.value);
                value.textContent = input.value;
                render();
            });
            // 松手才进撤销栈：拖动过程是连续调参，一步一格会把栈刷爆
            input.addEventListener("change", () => {
                if (String(edits.adjust[spec.key]) !== input.value) return;
                pushUndoBeforeLastSliderEdit(spec.key, input.value);
            });
            wrap.append(name, input, value);
            slidersBox.append(wrap);
        });
    }

    // 拖动结束后把「拖动前的整段连续调整」合并为一步：实现方式是先弹掉本次
    // change 前已无快照可弹 —— 这里改为在 input 前打快照、change 时把快照
    // 移到栈顶合并，等价于「一次拖动 = 一步撤销」。
    let sliderSnapshot = null;
    function pushUndoBeforeLastSliderEdit(key, value) {
        if (sliderSnapshot) {
            undoStack.push(sliderSnapshot);
            if (undoStack.length > UNDO_LIMIT) undoStack.shift();
            sliderSnapshot = null;
            undoBtn.disabled = false;
        }
    }
    slidersBox.addEventListener("input", () => {
        if (!sliderSnapshot) sliderSnapshot = JSON.stringify({ ...edits, adjust: { ...edits.adjust } });
    }, true);

    function syncChips() {
        buildCropChips();
        buildPresetChips();
        buildSliders();
    }

    /* ── 自动增强：取降采样图的平均亮度做真实测算 ── */

    function autoEnhance() {
        if (!image) return;
        const sample = document.createElement("canvas");
        sample.width = 64;
        sample.height = 64;
        const ctx = sample.getContext("2d");
        ctx.drawImage(image, 0, 0, 64, 64);
        let sum = 0;
        try {
            const data = ctx.getImageData(0, 0, 64, 64).data;
            for (let i = 0; i < data.length; i += 4) {
                sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
            }
        } catch { /* 跨域画布取不到像素时跳过亮度测算 */ }
        const mean = sum / (64 * 64) / 255;
        mutate(() => {
            edits.adjust.brightness = mean > 0.05 ? Math.round(Math.min(135, Math.max(90, 100 * 0.55 / mean))) : 100;
            edits.adjust.contrast = 110;
            edits.adjust.saturation = 115;
        });
    }

    /* ── 保存 ── */

    async function exportResult() {
        const srcType = (item && item.name || "").toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
        const blob = await renderBlob(srcType, 0.92);
        const thumbBlob = await renderThumbBlob();
        return { blob, thumbBlob, width: canvas.width, height: canvas.height };
    }

    async function saveCopy() {
        if (busy || !image) return;
        busy = true;
        copyBtn.disabled = true;
        copyBtn.textContent = T("saving", "正在保存…");
        try {
            const result = await exportResult();
            if (typeof handlers.onSaved === "function") {
                await handlers.onSaved({ mode: "copy", ...result });
            }
            close();
        } catch (err) {
            showError(T("saveFailed", "保存失败"), String((err && err.message) || err));
        } finally {
            busy = false;
            copyBtn.disabled = false;
            copyBtn.textContent = T("saveCopy", "存储为副本");
        }
    }

    async function saveOriginal() {
        if (busy || !image) return;
        if (armedBtn.dataset.armed !== "1") {
            // 先经系统弹窗确认；弹窗不可用时退到两段式武装态按钮，绝不无确认覆盖
            const ask = globalThis.__dialog;
            if (ask && typeof ask.confirm === "function") {
                const ok = await ask.confirm(T("confirmTitle", "覆盖原图"), T("confirmBody", "将用编辑后的图片覆盖原稿，此操作不可撤销。"));
                if (!ok) return;
            } else {
                armedBtn.dataset.armed = "1";
                armedBtn.classList.add("pe-danger");
                armedBtn.textContent = T("armed", "再点一次确认覆盖");
                clearTimeout(saveOriginal._armTimer);
                saveOriginal._armTimer = setTimeout(disarm, ARM_TIMEOUT_MS);
                return;
            }
        }
        disarm();
        busy = true;
        armedBtn.disabled = true;
        armedBtn.textContent = T("saving", "正在保存…");
        try {
            const result = await exportResult();
            if (typeof handlers.onSaved === "function") {
                await handlers.onSaved({ mode: "original", ...result });
            }
            close();
        } catch (err) {
            showError(T("saveFailed", "保存失败"), String((err && err.message) || err));
        } finally {
            busy = false;
            armedBtn.disabled = false;
            armedBtn.textContent = T("saveOriginal", "存储到原稿");
        }
    }

    function disarm() {
        clearTimeout(saveOriginal._armTimer);
        delete armedBtn.dataset.armed;
        armedBtn.classList.remove("pe-danger");
        armedBtn.textContent = T("saveOriginal", "存储到原稿");
    }

    /* ── 开合 ── */

    function onKeyDown(e) {
        if (!overlay.isConnected) { cleanup(); return; }
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation(); // 别让底下的预览层把 Esc 抢走
            close();
        }
    }

    function cleanup() {
        document.removeEventListener("keydown", onKeyDown, true);
        clearTimeout(saveOriginal._armTimer);
    }

    function close() {
        cleanup();
        overlay.remove();
    }

    undoBtn.addEventListener("click", applyUndo);
    resetBtn.addEventListener("click", () => mutate(() => {
        edits.rotate = 0;
        edits.flipH = false;
        edits.flipV = false;
        edits.crop = "free";
        edits.preset = "none";
        edits.adjust = freshEdits().adjust;
    }));
    closeBtn.addEventListener("click", close);
    autoBtn.addEventListener("click", autoEnhance);
    copyBtn.addEventListener("click", saveCopy);
    armedBtn.addEventListener("click", saveOriginal);
    document.addEventListener("keydown", onKeyDown, true);

    win.appendChild(overlay);
    syncChips();

    // 载入原图（本地 IndexedDB 的本体，复制一份会话级地址，画完即还）
    getMedia(item.id).then((blob) => {
        if (!blob) throw new Error(T("loadFailed", "图片载入失败"));
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            image = img;
            loading.hidden = true;
            render();
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            loading.textContent = T("loadFailed", "图片载入失败");
        };
        img.src = url;
    }).catch(() => {
        loading.textContent = T("loadFailed", "图片载入失败");
    });

    return { close };
}

/** 错误弹窗；弹窗接口缺失时退回运行记录。 */
function showError(title, message) {
    if (globalThis.__dialog && typeof globalThis.__dialog.error === "function") {
        globalThis.__dialog.error(title, message);
    } else {
        console.warn(`[photos/editor] ${title}：${message}`);
    }
}

/** 编辑器样式：一次注入，重复打开只复用。 */
function ensureStyle() {
    if (document.getElementById("deskly-photo-editor-style")) return;
    const style = document.createElement("style");
    style.id = "deskly-photo-editor-style";
    style.textContent = `
.photo-editor {
    position: absolute; inset: 0; z-index: 30;
    display: flex; flex-direction: column;
    background: rgba(12, 12, 14, 0.92);
    color: #f5f5f7;
    -webkit-backdrop-filter: blur(var(--surface-blur-3));
    backdrop-filter: blur(var(--surface-blur-3));
    font-size: 12.5px;
}
.photo-editor .pe-toolbar {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 10px 14px;
}
.photo-editor .pe-title {
    font-family: "SFPro-Medium", "PingFangSC-Medium";
    font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.photo-editor .pe-side { display: flex; gap: 8px; flex: 0 0 auto; }
.photo-editor .pe-btn {
    font: inherit; color: inherit; background: rgba(255, 255, 255, 0.12);
    border: none; border-radius: 6px; padding: 4px 12px; cursor: pointer;
}
.photo-editor .pe-btn:hover { background: rgba(255, 255, 255, 0.2); }
.photo-editor .pe-btn:disabled { opacity: 0.4; cursor: default; }
.photo-editor .pe-btn.pe-accent { background: var(--accent, #0a82ff); color: #fff; }
.photo-editor .pe-btn.pe-danger { background: #ff453a; color: #fff; }
.photo-editor .pe-stage {
    flex: 1 1 auto; display: flex; align-items: center; justify-content: center;
    min-height: 0; padding: 0 16px;
}
.photo-editor .pe-canvas {
    max-width: 100%; max-height: 100%;
    object-fit: contain;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
    border-radius: 4px;
}
.photo-editor .pe-loading { position: absolute; opacity: 0.7; }
.photo-editor .pe-loading[hidden] { display: none; }
.photo-editor .pe-panel {
    flex: 0 0 auto; display: flex; flex-direction: column; gap: 8px;
    padding: 12px 16px 14px; background: rgba(255, 255, 255, 0.06);
}
.photo-editor .pe-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.photo-editor .pe-label { flex: 0 0 auto; opacity: 0.7; width: 3.5em; }
.photo-editor .pe-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.photo-editor .pe-chip {
    font: inherit; font-size: 12px; color: inherit;
    background: rgba(255, 255, 255, 0.1); border: 1px solid transparent;
    border-radius: 999px; padding: 2px 12px; cursor: pointer;
}
.photo-editor .pe-chip[aria-pressed="true"] {
    background: var(--accent, #0a82ff); border-color: var(--accent, #0a82ff); color: #fff;
}
.photo-editor .pe-sliders { display: flex; gap: 14px; flex: 1 1 auto; flex-wrap: wrap; }
.photo-editor .pe-slider-row { display: flex; align-items: center; gap: 6px; flex: 1 1 150px; }
.photo-editor .pe-slider-label { flex: 0 0 auto; opacity: 0.7; }
.photo-editor .pe-slider { flex: 1 1 auto; min-width: 70px; accent-color: var(--accent, #0a82ff); }
.photo-editor .pe-slider-value {
    flex: 0 0 2.6em; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.8;
}
.photo-editor .pe-spacer { flex: 1 1 auto; }
`;
    document.head.appendChild(style);
}
