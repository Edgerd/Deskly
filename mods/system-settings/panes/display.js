/**
 * panes/display.js — 「系统设置 › 显示器」面板
 *
 * 亮度、夜览、夜览强度、夜览自动四个设置项的权威在 display.js（它定义并 apply），
 * 本面板只读只写设置中枢，因此与控制中心里的亮度滑块改的是同一份值、互相回灌。
 * 压暗遮罩元素本身属于 controlcenter.js，这里不重复造一个覆盖层，只放一块
 * 用同一组数值实时上色的预览。
 */

import { settings } from "../../../src/javascripts/settings.js";
import { display } from "../../../src/javascripts/display.js";
import {
    t, el, group, bind, controlSwitch, controlSlider, statusRow, usePaneStyle,
} from "../ui.js";

export const paneId = "display";

/** 四语言文案。 */
export const messages = {
    "zh-CN": {
        ss: {
            display: {
                brightness: "亮度",
                nightShift: "夜览",
                intensity: "色温强度",
                auto: "自动夜览",
                previewGroup: "当前效果预览",
                preview: "夜览",
                steps: "色温档位",
                off: "关",
            },
        },
    },
    "en": {
        ss: {
            display: {
                brightness: "Brightness",
                nightShift: "Night Shift",
                intensity: "Color temperature",
                auto: "Automatic",
                previewGroup: "Live preview",
                preview: "Night Shift",
                steps: "Color temperature",
                off: "Off",
            },
        },
    },
    "ja-JP": {
        ss: {
            display: {
                brightness: "画面の明るさ",
                nightShift: "Night Shift",
                intensity: "色温度",
                auto: "自動",
                previewGroup: "プレビュー",
                preview: "Night Shift",
                steps: "色温度",
                off: "切",
            },
        },
    },
    cat: {
        ss: {
            display: {
                brightness: "亮度喵",
                nightShift: "夜览",
                intensity: "暖到什么程度",
                auto: "到了晚上自己开",
                previewGroup: "现在长这样喵",
                preview: "夜览喵",
                steps: "暖色阶梯",
                off: "睡着啦",
            },
        },
    },
};

/** 暖色压层与真实界面用同一个色值与混合模式（对齐 display.js 的 WARM_COLOR）。 */
const WARM_COLOR = "rgb(255, 170, 90)";
const STEPS = [0, 0.25, 0.5, 0.75, 1];

const CSS = `
.ss-display .ss-display__preview { display: flex; flex-direction: column; gap: 8px; padding: 4px 0 10px; }
.ss-display .ss-display__screen { position: relative; height: 96px; border-radius: 12px; overflow: hidden;
  background: linear-gradient(150deg,#f4f6fb,#dfe6f2); box-shadow: inset 0 0 0 1px rgba(0,0,0,.12); }
.ss-display .ss-display__screen span { position: absolute; left: 12px; bottom: 10px; font-size: 12px; color: #1d1d1f; }
.ss-display .ss-display__tint { position: absolute; inset: 0; pointer-events: none; background: ${WARM_COLOR}; mix-blend-mode: multiply; }
.ss-display .ss-display__dim { position: absolute; inset: 0; pointer-events: none; background: #000; mix-blend-mode: multiply; }
.ss-display .ss-display__steps { display: flex; gap: 6px; }
.ss-display__swatch { flex: 1 1 0; height: 34px; border-radius: 8px; box-shadow: inset 0 0 0 1px rgba(0,0,0,.14);
  background: ${WARM_COLOR}; }
.ss-display__swatch--on { box-shadow: inset 0 0 0 2px var(--accent, #0a84ff); }
`;

/**
 * 构建显示器面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    usePaneStyle(paneId, CSS);

    const tintLayer = el("div", { class: "ss-display__tint" });
    const dimLayer = el("div", { class: "ss-display__dim" });
    const screen = el("div", { class: "ss-display__screen" },
        el("span", { text: "Deskly" }), tintLayer, dimLayer);
    const stepCells = STEPS.map((ratio) => el("div", { class: "ss-display__swatch", dataset: { ratio: String(ratio) } }));

    const nightStateRow = statusRow({ label: t("ss.display.preview", "夜览"), value: "—" });

    /** 用当前亮度与色温重绘预览：公式与 display.js / controlcenter.js 的压层一致。 */
    const paintPreview = () => {
        const brightness = clamp01(Number(settings.get("display.brightness")));
        const active = typeof display?.isNightShiftActive === "function"
            ? Boolean(display.isNightShiftActive())
            : Boolean(settings.get("display.nightShift"));
        const intensity = clamp01(Number(settings.get("display.nightShiftIntensity")));
        dimLayer.style.opacity = String(Math.round((1 - brightness) * 0.55 * 100) / 100);
        tintLayer.style.opacity = active ? String(Math.round(intensity * 100) / 100) : "0";
        nightStateRow.setValue(active ? `${Math.round(intensity * 100)}%` : t("ss.display.off", "关"));
        const nearest = nearestStep(active ? intensity : 0);
        stepCells.forEach((cell) => {
            const ratio = Number(cell.dataset.ratio);
            cell.style.opacity = String(ratio);
            cell.classList.toggle("ss-display__swatch--on", ratio === nearest);
        });
    };

    bind("display.brightness", paintPreview);
    bind("display.nightShiftIntensity", paintPreview);
    bind("display.nightShiftAuto", paintPreview);

    const intensityRow = controlSlider("display.nightShiftIntensity", {
        label: t("ss.display.intensity", "色温强度"),
        min: 0, max: 1, step: 0.05, format: "percent",
    });

    // 夜览关闭时把强度滑块置灰：仍然允许设置中枢改值（控制中心可能改），只是这里不再接收输入。
    bind("display.nightShift", (value) => {
        const input = intensityRow.querySelector(".ss-slider");
        if (input) input.disabled = !value;
        intensityRow.classList.toggle("ss-row--disabled", !value);
        paintPreview();
    });

    if (typeof display?.apply === "function") {
        try { display.apply(); } catch { /* 首帧生效失败由 settings-changed 补上，不打断面板渲染 */ }
    }

    return el("div", { class: "ss-pane ss-display" },
        group([
            controlSlider("display.brightness", {
                label: t("ss.display.brightness", "亮度"),
                min: 0.05, max: 1, step: 0.01, format: "percent",
            }),
        ]),

        group([
            controlSwitch("display.nightShift", { label: t("ss.display.nightShift", "夜览") }),
            intensityRow,
            controlSwitch("display.nightShiftAuto", { label: t("ss.display.auto", "自动夜览") }),
        ]),

        group([
            nightStateRow,
            el("div", { class: "ss-display__preview" },
                screen,
                el("p", { class: "ss-row__label", text: t("ss.display.steps", "色温档位") }),
                el("div", { class: "ss-display__steps" }, ...stepCells)),
        ], { title: t("ss.display.previewGroup", "当前效果预览") })
    );
}

/**
 * 限制到 0..1，非法值按 1（不压暗）处理。
 * @param {number} value 原始数值
 * @returns {number} 0..1 的数值
 */
function clamp01(value) {
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

/**
 * 找出色温梯度里最接近当前强度的档位。
 * @param {number} intensity 0..1 的强度
 * @returns {number} 档位比例
 */
function nearestStep(intensity) {
    return STEPS.reduce((best, ratio) => (Math.abs(ratio - intensity) < Math.abs(best - intensity) ? ratio : best), STEPS[0]);
}

/** 面板不持有全局资源；预览与控件的订阅都由 ui.js 统一释放。 */
export function destroy() { }
