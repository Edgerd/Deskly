/**
 * panes/sound.js — 「系统设置 › 声音」面板
 *
 * sound.master / sound.muted 的定义与生效函数都在 sound.js（owner 才是取值权威），
 * 这里只通过设置中枢读写，所以与控制中心的音量滑块、静音按钮改的是同一份值。
 *
 * 「输出设备」下拉不做：浏览器只有 Web Audio / setSinkId 这类按元素输出的能力，
 * 没有全站输出设备枚举接口，硬做一个下拉就是假控件 —— 改成一行只读状态。
 */

import { sound } from "../../../src/javascripts/sound.js";
import {
    t, el, group, note, controlSwitch, controlSlider, actionRow, statusRow, usePaneStyle,
} from "../ui.js";

export const paneId = "sound";

/** 四语言文案。 */
export const messages = {
    "zh-CN": {
        ss: {
            sound: {
                outputGroup: "输出",
                master: "音量",
                muted: "静音",
                device: "输出设备",
                deviceValue: "跟随浏览器",
                effectsGroup: "提示音音效",
                effects: "提示音音效",
                effectsVolume: "提示音音量",
                silentNote: "倒废纸篓、音量反馈等音色暂未配素材，请求时保持安静；素材到位后自动出声。",
                testGroup: "试听",
                test: "播放测试音",
                testBtn: "播放",
            },
        },
    },
    "en": {
        ss: {
            sound: {
                outputGroup: "Output",
                master: "Volume",
                muted: "Mute",
                device: "Output device",
                deviceValue: "Browser default",
                effectsGroup: "Sound Effects",
                effects: "Alert sounds",
                effectsVolume: "Alert volume",
                silentNote: "Some cues (empty Trash, volume feedback) have no sound files yet and stay silent until assets are added.",
                testGroup: "Test",
                test: "Play test tone",
                testBtn: "Play",
            },
        },
    },
    "ja-JP": {
        ss: {
            sound: {
                outputGroup: "出力",
                master: "音量",
                muted: "ミュート",
                device: "出力デバイス",
                deviceValue: "ブラウザ既定",
                effectsGroup: "効果音",
                effects: "警告音",
                effectsVolume: "警告音の音量",
                silentNote: "ゴミ箱を空にする等の一部の音はまだ素材がなく、追加されるまで鳴りません。",
                testGroup: "試聴",
                test: "テスト音を再生",
                testBtn: "再生",
            },
        },
    },
    cat: {
        ss: {
            sound: {
                outputGroup: "出声的地方喵",
                master: "主音量",
                muted: "静音",
                device: "输出设备",
                deviceValue: "听浏览器的",
                effectsGroup: "提示音喵",
                effects: "提示音开关喵",
                effectsVolume: "提示音大小喵",
                silentNote: "倒废纸篓、音量反馈这些音还没配素材喵，先安安静静的；素材到了自然就响喵。",
                testGroup: "听一下喵",
                test: "播放测试音",
                testBtn: "放来听喵",
            },
        },
    },
};

const CSS = `
.ss-sound .ss-status__value { font-variant-numeric: tabular-nums; }
`;

/**
 * 构建声音面板。
 * @returns {HTMLElement} 面板根元素
 */
export function build() {
    usePaneStyle(paneId, CSS);

    const deviceRow = statusRow({
        label: t("ss.sound.device", "输出设备"),
        value: t("ss.sound.deviceValue", "跟随浏览器"),
    });

    return el("div", { class: "ss-pane ss-sound" },
        group([
            controlSlider("sound.master", {
                label: t("ss.sound.master", "音量"),
                min: 0, max: 1, step: 0.01, format: "percent",
            }),
            controlSwitch("sound.muted", { label: t("ss.sound.muted", "静音") }),
            deviceRow,
        ], { title: t("ss.sound.outputGroup", "输出") }),

        // 提示音门控（F-50）：开关与音量都由 sound.js 的定义落地，playTone 真消费
        group([
            controlSwitch("sound.effects", { label: t("ss.sound.effects", "提示音音效") }),
            controlSlider("sound.effectsVolume", {
                label: t("ss.sound.effectsVolume", "提示音音量"),
                min: 0, max: 1, step: 0.01, format: "percent",
            }),
            note("ss.sound.silentNote", "倒废纸篓、音量反馈等音色暂未配素材，请求时保持安静；素材到位后自动出声。"),
        ], { title: t("ss.sound.effectsGroup", "提示音音效") }),

        group([
            actionRow({
                label: t("ss.sound.test", "播放测试音"),
                buttonText: t("ss.sound.testBtn", "播放"),
                onAction: () => {
                    if (typeof sound?.playTone !== "function") {
                        throw new Error("sound.playTone unavailable");
                    }
                    sound.playTone("alert");
                },
            }),
        ], { title: t("ss.sound.testGroup", "试听") })
    );
}

/** 声音面板没有自持有的资源需要释放。 */
export function destroy() { }
